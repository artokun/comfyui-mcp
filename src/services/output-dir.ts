import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { config, isRemoteMode } from "../config.js";
import { getClient, getSystemStats } from "../comfyui/client.js";
import {
  resolveEffectiveComfyUIBase,
  liveRootFromArgv,
  resolveLiveServerRoot,
  hasComfyUIEntrypoint,
} from "./workspace-env.js";
import { ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Resolve ComfyUI's REAL output directory.
//
// ComfyUI can be launched with --output-directory (or --base-directory) which
// redirects generated images away from the default <COMFYUI_PATH>/output (e.g.
// to a shared drive like ComfyUI-Shared\output). Tools that scan the output
// directory on the local filesystem (get_image (action:"convert"), get_image (action:"list_outputs")) must
// therefore NOT assume <COMFYUI_PATH>/output, or they find nothing after a
// successful render.
//
// The authoritative source is ComfyUI itself: /system_stats reports the launch
// argv (system.argv), from which we parse --output-directory / --base-directory.
// We fall back to <COMFYUI_PATH>/output when ComfyUI is unreachable or did not
// override the directory. Same class of fix as the doubled-COMFYUI_PATH bug.
// ---------------------------------------------------------------------------

/**
 * A single `/system_stats` snapshot: the live server's launch argv and reported cwd,
 * captured ONCE so every derivation (models dir, base dirs, authorized extra roots)
 * reflects the SAME server state — never a mix of two calls that straddled a restart.
 */
export interface LiveServerSnapshot {
  reachable: boolean;
  argv?: string[];
  cwd?: string;
  /** The live server's install root as established by the ONE canonical resolver
   *  (resolveLiveServerRoot) from THIS snapshot — including the OS-observed anchor
   *  that argv alone cannot produce. Consumers that need
   *  `<live root>/extra_model_paths.yaml` must use this rather than re-parsing argv,
   *  or they miss the relative-`main.py` shape entirely (codex gate, round 12).
   *  LOCAL mode only. */
  liveRoot?: string;
}

/**
 * Provenance of a resolved models directory (#369).
 *
 *  - `argv-flag`     — the server's own `--base-directory`/`--models-directory`.
 *  - `live-root`     — the server's own argv `main.py` root (absolute / cwd-resolved).
 *  - `observed-root` — a relative argv `main.py` re-anchored on the interpreter the
 *                      OS reports for the process on our port.
 *  - `base-anchored` — the configured base CORROBORATED by the relative `main.py`
 *                      the live server reported really existing under it.
 *  - `configured-base` — plain COMFYUI_PATH / default workspace. This is the only
 *                      value a REACHABLE server never vouched for, and the one that
 *                      wrote a 4.88 GB model into a stale install in #369.
 *
 * The first three are LIVE-AUTHORITATIVE. `isLiveAuthoritativeModelsDir()` is the
 * single predicate callers use, so nobody re-derives that classification.
 */
export type ModelsDirSource =
  | "argv-flag"
  | "live-root"
  | "observed-root"
  | "base-anchored"
  | "base-inventory-corroborated"
  | "configured-base";

/** True when the models dir was established from the RUNNING server rather than
 *  from local configuration the server never vouched for. */
export function isLiveAuthoritativeModelsDir(source: ModelsDirSource): boolean {
  return source === "argv-flag" || source === "live-root" || source === "observed-root";
}

/** Resolve a possibly-relative dir against a base (or COMFYUI_PATH, or cwd). */
function resolveDir(value: string, base?: string): string {
  if (isAbsolute(value)) return resolve(value);
  const root = base ?? config.comfyuiPath ?? process.cwd();
  return resolve(root, value);
}

/** Read a flag's value supporting both `--flag value` and `--flag=value`. */
function flagValue(argv: string[], index: number, flag: string): string | undefined {
  const token = argv[index];
  if (token === flag) return argv[index + 1];
  if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  return undefined;
}

/**
 * Parse the configured output directory out of ComfyUI's launch argv.
 * --output-directory wins; otherwise --base-directory implies <base>/output.
 * Returns undefined when neither flag is present.
 */
export function parseOutputDirFromArgv(argv: string[] | undefined): string | undefined {
  if (!argv || argv.length === 0) return undefined;

  let outputDir: string | undefined;
  let baseDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    outputDir = flagValue(argv, i, "--output-directory") ?? outputDir;
    baseDir = flagValue(argv, i, "--base-directory") ?? baseDir;
  }

  const resolvedBase = baseDir ? resolveDir(baseDir) : undefined;
  if (outputDir) return resolveDir(outputDir, resolvedBase);
  if (resolvedBase) return join(resolvedBase, "output");
  return undefined;
}

/**
 * Resolve a value from the server's launch flags the way ComfyUI does — via
 * `os.path.abspath(...)`, i.e. relative to the SERVER PROCESS cwd, NOT the MCP
 * process cwd / COMFYUI_PATH. An ABSOLUTE value is used as-is. A RELATIVE value
 * needs the server's reported cwd; WITHOUT it we return undefined (UNRESOLVABLE)
 * rather than guess a wrong MCP-relative path (which would land the download where
 * the server never reads — the very #346 bug). Requires an ABSOLUTE serverCwd.
 */
function resolveServerLaunchPath(value: string, serverCwd?: string): string | undefined {
  if (isAbsolute(value)) return resolve(value);
  if (serverCwd && isAbsolute(serverCwd)) return resolve(serverCwd, value);
  return undefined; // relative value + no authoritative server cwd → unresolvable
}

/** Raw last value of a repeated single-value launch flag (no resolution). */
function rawFlagValue(argv: string[] | undefined, flag: string): string | undefined {
  if (!argv || argv.length === 0) return undefined;
  let v: string | undefined;
  for (let i = 0; i < argv.length; i++) v = flagValue(argv, i, flag) ?? v;
  return v;
}

/**
 * True when the server's launch argv carries a RELATIVE `--base-directory` or
 * `--models-directory` that we CANNOT resolve because it did not report an absolute
 * cwd. Callers must then NOT guess a local destination (they'd write to the wrong
 * place); route through the server / report live resolution unavailable instead.
 */
export function hasUnresolvableRelativeModelDirFlag(
  argv: string[] | undefined,
  serverCwd?: string,
): boolean {
  if (serverCwd && isAbsolute(serverCwd)) return false; // all relatives resolvable
  const base = rawFlagValue(argv, "--base-directory");
  const models = rawFlagValue(argv, "--models-directory");
  return (
    (models !== undefined && !isAbsolute(models)) ||
    (base !== undefined && !isAbsolute(base))
  );
}

/**
 * Parse the running server's base directory (`--base-directory`) out of its
 * launch argv, resolved against the SERVER cwd (ComfyUI uses os.path.abspath).
 * This is the authoritative root ComfyUI derives models/, input/, output/, and
 * user/ from — on a Desktop install it commonly points at a drive entirely
 * different from COMFYUI_PATH. Returns undefined when the flag is absent OR when a
 * relative value can't be resolved without the server cwd (UNRESOLVABLE).
 */
export function parseBaseDirFromArgv(
  argv: string[] | undefined,
  serverCwd?: string,
): string | undefined {
  const baseDir = rawFlagValue(argv, "--base-directory");
  return baseDir !== undefined ? resolveServerLaunchPath(baseDir, serverCwd) : undefined;
}

/**
 * Parse the models directory the running server actually reads from. ComfyUI's
 * `--models-directory` overrides `<base>/models` and is resolved INDEPENDENTLY via
 * os.path.abspath (relative to the SERVER cwd) — NOT relative to `--base-directory`
 * (folder_paths.py). Otherwise the models root is `<base>/models`. Returns
 * undefined when neither flag is present, or when a relative flag is unresolvable
 * without the server cwd.
 */
export function parseModelsDirFromArgv(
  argv: string[] | undefined,
  serverCwd?: string,
): string | undefined {
  const modelsDir = rawFlagValue(argv, "--models-directory");
  // --models-directory resolves on its OWN against the server cwd, not against base.
  if (modelsDir !== undefined) return resolveServerLaunchPath(modelsDir, serverCwd);
  const base = parseBaseDirFromArgv(argv, serverCwd);
  return base ? join(base, "models") : undefined;
}

/**
 * Collect all values that follow `flag` at position `index`, supporting both
 * `--flag a b` (argparse nargs='+') and `--flag=a`. Consumes consecutive tokens
 * until the next `--option`. Returns [] when the token at `index` isn't `flag`.
 */
function multiFlagValues(argv: string[], index: number, flag: string): string[] {
  const token = argv[index];
  if (token.startsWith(`${flag}=`)) return [token.slice(flag.length + 1)];
  if (token !== flag) return [];
  const values: string[] = [];
  for (let j = index + 1; j < argv.length; j++) {
    if (argv[j].startsWith("--")) break;
    values.push(argv[j]);
  }
  return values;
}

/**
 * Parse every `--extra-model-paths-config` value out of the launch argv. ComfyUI
 * declares this flag as `nargs='+', action='append'`, so it can carry multiple
 * files per occurrence AND be repeated — both forms are collected here. This is
 * the config file(s) the running server actually loads extra model search paths
 * from — on ComfyUI Desktop it is an auto-generated
 * `…\Comfy Desktop\shared_model_paths.yaml`, NOT the app-data
 * `ComfyUI\extra_models_config.yaml` the tools historically guessed. Returns []
 * when the flag is absent.
 */
export function parseExtraModelPathsConfigsFromArgv(argv: string[] | undefined): string[] {
  if (!argv || argv.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    for (const v of multiFlagValues(argv, i, "--extra-model-paths-config")) {
      out.push(resolveDir(v));
    }
  }
  return out;
}

/**
 * Like parseExtraModelPathsConfigsFromArgv but returns the RAW flag values WITHOUT
 * resolving relatives. Security-critical for AUTHORIZATION (getLiveExtraModelRoots,
 * #633): a RELATIVE `--extra-model-paths-config` value cannot be safely resolved to
 * the live server's file from the MCP process — resolveDir() would anchor it to the
 * local COMFYUI_PATH / MCP cwd, so a stale local same-named config could authorize
 * an escape the running server never loads (codex P0d). The authorizing caller keeps
 * only ABSOLUTE values and fails closed on relative ones.
 */
export function parseExtraModelPathsConfigsFromArgvRaw(argv: string[] | undefined): string[] {
  if (!argv || argv.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    for (const v of multiFlagValues(argv, i, "--extra-model-paths-config")) out.push(v);
  }
  return out;
}

/**
 * Resolve the models directory the CONNECTED server actually reads from AND, from
 * the SAME `/system_stats` call, the candidate ComfyUI *base install* directories
 * (used by the download destination guard to locate `custom_nodes` code roots).
 *
 * Deriving both from ONE call is a security invariant, not just an optimization:
 * a SECOND, separate stats call could fail AFTER the models dir was already
 * resolved from a divergent `--models-directory`, leaving the guard without the
 * real `--base-directory` code root and letting a relabeled extra-path alias of
 * `custom_nodes` slip through (fail-open). One call means the models dir and the
 * base dirs are always consistent — if the call fails, BOTH fall back together to
 * the configured local base (no partial-information window).
 *
 * modelsDir: the running ComfyUI's models root (`--base-directory`/`--models-directory`
 * → the live server's main.py root → `<COMFYUI_PATH>`/default workspace), issues
 * #346/#369/#490/#463. baseDirs: the local install roots ComfyUI derives
 * `custom_nodes` from — the argv `--base-directory`, the live main.py root, and the
 * configured local base — collected only in LOCAL mode (the guard runs only
 * locally; a remote server's argv paths are on the remote host).
 */
/** Do two absolute paths name the same directory?
 *
 *  Case is folded on WINDOWS ONLY. Windows filesystems are case-insensitive
 *  everywhere, so a server reporting `comfyui\main.py` against a base of
 *  `...\ComfyUI` genuinely names the same directory. macOS is deliberately NOT
 *  folded even though HFS+/APFS are case-insensitive by DEFAULT: APFS can be
 *  formatted case-SENSITIVE, and on such a volume `/x/ComfyUI` and `/x/comfyui`
 *  are two different installs. This comparison decides whether a download may be
 *  written to a base, so a wrong "same" is the #369 harm (a model landing in an
 *  install the running server never reads, reported as a success). Being strict
 *  costs a case-differing macOS user a refusal they can fix; being lax could cost
 *  them a silently misplaced multi-gigabyte file. */
function samePath(a: string, b: string): boolean {
  const norm = (s: string): string => {
    const slashed = resolve(s).replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  return norm(a) === norm(b);
}

/**
 * Corroborate a configured local `base` against the RELATIVE `main.py` path the
 * running server reported, and return the install root when — and only when —
 * they agree. Returns undefined when they do not, so the caller refuses rather
 * than guesses (#369's doctrine: an honest "I don't know where this would land"
 * beats a fabricated success).
 *
 * TWO base conventions coexist in this codebase and BOTH are legitimate (#813):
 *
 *   A. `base` is the OUTER launcher root, the server one level down at
 *      `<base>/<relDir>/main.py`. This is ComfyUI Desktop, whose `<base>` holds
 *      the launcher's `standalone-env` python rather than the server.
 *
 *   B. `base` IS the ComfyUI directory (it holds `main.py` directly), and the
 *      server's relative `relDir/main.py` is written from base's PARENT. This is
 *      the classic Windows portable bundle with `COMFYUI_PATH` set to
 *      `...\ComfyUI_windows_portable\ComfyUI` — the value `install_comfyui (action:"environment")`,
 *      `list_local_models` and `resolveEffectiveComfyUIBase` all already treat as
 *      correct. Only this resolver rejected it, so every download refused (#813).
 *
 * Order follows the rule `serverRootsUnder` (workspace-env.ts) already
 * established for exactly this ambiguity, rather than inventing a second
 * convention: a base that DIRECTLY holds `main.py` IS the server root and wins;
 * a nested checkout never outranks it (#401).
 *
 * Convention B is accepted ONLY on the same evidence convention A demands —
 * that the server's reported relative path, anchored one level up, names THIS
 * directory (so `relDir` must match base's own name) AND that `main.py` is
 * really there. A base whose name does not match `relDir` is NOT corroborated
 * and is still refused: the server said its script lives at `<something>/ComfyUI/
 * main.py`, and a base named `ComfyUI-master` is not that, whatever it contains.
 */
function anchorRelativeEntrypointOnBase(base: string, relDir: string): string | undefined {
  // B — base is itself the directory the server named. The evidence is that
  // `base` ENDS WITH `relDir`'s segments: climb that many levels up from base and
  // re-anchor; if we land back on base, then some working directory (the one the
  // server did not report) makes `relDir/main.py` resolve to exactly this install.
  // Handles multi-segment relDir ("sub/ComfyUI") as well as the reported single
  // "ComfyUI"; a base whose tail does NOT match relDir lands elsewhere and is
  // rejected, which is the whole point of corroborating.
  const segments = relDir.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  const impliedCwd = resolve(base, ...segments.map(() => ".."));
  const baseIsTheInstall =
    samePath(resolve(impliedCwd, relDir), base) && hasComfyUIEntrypoint(base);
  // A — base is the outer launcher root; the server is nested under it. (This
  // also covers relDir "." — `resolve(base, ".")` is base — which is how a server
  // launched as plain `python main.py` from inside the install already resolved.)
  const nested = resolve(base, relDir);
  const nestedIsTheInstall = !samePath(nested, base) && hasComfyUIEntrypoint(nested);

  // BOTH readings fit. `<base>/main.py` and `<base>/<relDir>/main.py` both exist,
  // and the server's relative path is consistent with either — so the evidence
  // does not say WHICH install is running, and picking one would be a guess about
  // a destination for multi-gigabyte files. That is exactly the #369 harm (a model
  // landing in a stale install and being reported a success), so refuse and let
  // the caller resolve it. Returning undefined routes into the existing refusal,
  // which names both interpretations.
  if (baseIsTheInstall && nestedIsTheInstall) return undefined;
  if (baseIsTheInstall) return resolve(base);
  if (nestedIsTheInstall) return nested;
  // relDir "." (or empty): nested IS base, so only the base reading can apply.
  return hasComfyUIEntrypoint(nested) ? nested : undefined;
}

/**
 * Corroborate a configured base by asking the SERVER what models it can SEE (#851).
 *
 * `anchorRelativeEntrypointOnBase` corroborates using ComfyUI's CODE layout — it needs a
 * `main.py` at or under the base. That is an assumption about what an install LOOKS
 * like, and every deployment shape that does not match produces another false refusal:
 * #813 was the Windows portable shape, #851 is the Docker/data-dir shape, where
 * `COMFYUI_PATH` is a bind-mounted host directory holding `models/ input/ output/
 * custom_nodes/` and the code lives inside the container at a path that does not exist
 * on the host at all. No amount of layout-matching reaches that, because the evidence it
 * looks for is genuinely not there — and "I could not determine which install this is"
 * was being reported as "I determined it is a DIFFERENT install".
 *
 * But the question is "where does this server read MODELS from?", and for that there IS
 * decisive evidence the running server volunteers: `/models/<category>` is ComfyUI
 * listing the model files it can actually see. If everything it reports for a category
 * is present under `<base>/models/<category>`, then that directory is (or is mounted as)
 * the models root the server reads — established by the server, not by us recognising a
 * layout. That is the same principle #813 used, applied to the evidence that exists in
 * this deployment rather than the evidence that does not.
 *
 * Deliberately conservative, because this decides where multi-gigabyte files land:
 *  - it runs ONLY where the alternative is today's hard refusal, so it can convert a
 *    refusal into a corroborated destination but can never redirect a download that
 *    already resolved;
 *  - it requires a NON-EMPTY category that the base explains COMPLETELY. One reported
 *    file missing from disk means the server is reading from somewhere else too, and the
 *    match is not proof;
 *  - anything unreadable, empty, or ambiguous returns a reason and the caller refuses.
 *
 * Residual, stated rather than hidden: a stale second install holding an identical copy
 * of the same model files would also match. The source is reported as
 * `base-inventory-corroborated` (NOT live-authoritative) precisely so downstream keeps
 * treating the destination as local configuration that was corroborated, not as a path
 * the server named.
 */
/** Is `candidate` strictly inside `root`? The server's listing supplies both the category
 *  and the file names, and a `..` segment in either (a stray path, a symlinked category)
 *  would let `join` walk out of `<base>/models` and "find" a file that proves nothing
 *  about this base. The root itself is not an entry, so equality is not containment. */
function containedUnder(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  if (c === r) return false;
  const rel = relative(r, c);
  if (rel === "" || isAbsolute(rel)) return false;
  // `..` only counts as escaping when it is a whole PATH SEGMENT. A bare
  // `startsWith("..")` also rejects `..model.safetensors` — a perfectly ordinary
  // filename that stays inside the directory — and that false refusal would block the
  // very Docker download this corroboration exists to allow. Over-strict is the same
  // defect as over-permissive, pointed the other way.
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../");
}

/** What is at this path — keeping "could not look" out of "is not there", and out of
 *  "is a regular file". A DIRECTORY named like a model would satisfy `existsSync` and
 *  corroborate a base that holds none of the actual files. */
function probeEntry(p: string): { kind: "file" | "absent" | "not-a-file" | "indeterminate"; detail?: string } {
  try {
    return statSync(p).isFile() ? { kind: "file" } : { kind: "not-a-file" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "indeterminate", detail: code ?? String(err) };
  }
}

async function corroborateBaseByModelInventory(
  base: string,
  targetCategory: string,
): Promise<
  | {
      ok: true;
      modelsDir: string;
      category: string;
      matched: number;
      /** How many the server listed, so a PARTIAL match can be reported as one. */
      listed: number;
    }
  | { ok: false; reason: string }
> {
  // The corroboration must be about the category this download is FOR. A complete match
  // on some OTHER category proves only that THAT folder is under this base — and a server
  // can legitimately read `diffusion_models` from here via an extra_model_paths entry
  // while reading `loras` from somewhere else entirely. Authorising the whole models root
  // on a sibling's evidence would then write the loras file where the server never looks,
  // and the downstream live-disagreement guard cannot catch it: an EMPTY local `loras/`
  // has nothing to contradict, which is exactly the first-download case.
  if (!targetCategory) {
    return {
      ok: false,
      reason:
        "this call did not name the model category it is downloading into, and corroboration " +
        "has to be about that category — a match on a different one would not establish that " +
        "the server reads THIS folder",
    };
  }
  const modelsDir = resolve(base, "models");
  let modelsDirIsDir: boolean;
  try {
    modelsDirIsDir = statSync(modelsDir).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      ok: false,
      reason:
        code === "ENOENT" || code === "ENOTDIR"
          ? `it has no "models" directory`
          : `its "models" directory could not be inspected (${code ?? "unknown error"}), so nothing was established either way`,
    };
  }
  if (!modelsDirIsDir) return { ok: false, reason: `its "models" entry is not a directory` };

  // ONLY the target category — one question, one request. Scoping to it also removed the
  // /models enumeration and its per-category request budget, which existed solely because
  // this used to sweep for any category that happened to match.
  let unreadableCategories = 0;
  let lastReason: string | undefined;
  for (const category of [targetCategory]) {
    let files: string[];
    try {
      const client = getClient();
      const res = await client.fetchApi(`/models/${encodeURIComponent(category)}`);
      if (!res.ok) {
        unreadableCategories += 1;
        continue;
      }
      const json = (await res.json()) as unknown;
      if (!Array.isArray(json)) {
        unreadableCategories += 1;
        continue;
      }
      // A malformed ENTRY makes the whole listing inconclusive. Dropping it and matching
      // "the rest" would approve a destination while quietly not accounting for
      // everything the server said it sees — a complete match that is not complete.
      const malformed = json.filter((n) => typeof n !== "string" || n.trim() === "");
      if (malformed.length > 0) {
        unreadableCategories += 1;
        lastReason =
          `the server's listing for "${category}" contained ${malformed.length} entr(y/ies) that ` +
          "are not usable filenames, so what it sees there could not be established — and a " +
          "match on only the readable remainder would not be the complete match this check requires";
        continue;
      }
      files = json as string[];
    } catch {
      unreadableCategories += 1;
      continue;
    }
    if (files.length === 0) continue;
    const categoryDir = join(modelsDir, category);
    // The CATEGORY name comes from the server too, so it gets the same containment
    // check as the files under it.
    if (!containedUnder(modelsDir, categoryDir)) {
      lastReason = `the server's category name "${category}" does not name a directory inside "${modelsDir}", so nothing under it could corroborate this base`;
      continue;
    }
    const missing: string[] = [];
    const unreadable: string[] = [];
    const notFiles: string[] = [];
    const escaping: string[] = [];
    // Containment has to be PHYSICAL. Sharing model files between installs by symlinking
    // them is ordinary practice, and a stale base whose `<category>/known.safetensors` is
    // a link to the file the server really reads would satisfy a lexical check while
    // proving the opposite: the evidence lives elsewhere, and a NEW download written here
    // would never appear to the server. `statSync` follows links, so nothing else notices.
    //
    // The canonical category must ALSO stay inside the canonical models root. A category
    // directory that is itself a link out of the tree is a real topology — writes through
    // it do land in the server's dir — but the download authorizer downstream refuses a
    // destination whose canonical path escapes the models root, so corroborating it here
    // would hand the caller an approval the next layer rejects: a contradiction between
    // two guards, which is worse than either answer. This check is deliberately the
    // NARROWER of the two so the layers agree; that topology keeps today's refusal.
    let realModelsDir: string;
    let realCategoryDir: string;
    try {
      realModelsDir = realpathSync(modelsDir);
      realCategoryDir = realpathSync(categoryDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      lastReason =
        code === "ENOENT" || code === "ENOTDIR"
          ? `"${categoryDir}" does not exist, so this base holds none of what the server lists under "${category}"`
          : `"${categoryDir}" could not be canonicalized (${code ?? "unknown error"}), so nothing was established either way`;
      continue;
    }
    if (!containedUnder(realModelsDir, realCategoryDir)) {
      lastReason =
        `"${categoryDir}" resolves to "${realCategoryDir}", outside "${realModelsDir}" — a ` +
        "category directory linked out of the models tree. Writes through it would reach the " +
        "server, but the download authorizer refuses a destination whose canonical path leaves " +
        "the models root, so corroborating it here would only be overruled a step later. Point " +
        "COMFYUI_PATH at the directory that physically holds the models instead";
      continue;
    }
    for (const name of files) {
      const full = join(categoryDir, name);
      if (!containedUnder(categoryDir, full)) {
        escaping.push(name);
        continue;
      }
      const found = probeEntry(full);
      if (found.kind === "absent") {
        missing.push(name);
        continue;
      }
      if (found.kind === "not-a-file") {
        notFiles.push(name);
        continue;
      }
      if (found.kind === "indeterminate") {
        unreadable.push(`${name} (${found.detail ?? "unknown error"})`);
        continue;
      }
      let realEntry: string;
      try {
        realEntry = realpathSync(full);
      } catch (err) {
        unreadable.push(`${name} (${(err as NodeJS.ErrnoException)?.code ?? "unresolvable link"})`);
        continue;
      }
      if (!containedUnder(realCategoryDir, realEntry)) escaping.push(name);
    }
    // A PARTIAL match does NOT corroborate — and my first attempt at this had it
    // backwards (codex gate, twice).
    //
    // The original complaint was real: requiring EVERY listed file to be here
    // assumes one root per category, and `extra_model_paths.yaml` lets ComfyUI
    // scan this directory AND others for the same one, so a file owned by an extra
    // root is legitimately absent. I relaxed the rule to accept any overlap.
    //
    // That was worse than the bug. The listing is FILENAMES ONLY, so a stale clone
    // holding `shared.safetensors` is indistinguishable from a genuine second root
    // holding `shared.safetensors` — and under the relaxed rule a single common
    // name authorized a multi-gigabyte download into an install the running server
    // never reads. A false refusal here is recoverable and tells the user exactly
    // what to set; a wrong destination reported as success is #369, which is the
    // harm this whole path exists to prevent. Between an unrecoverable wrong answer
    // and a recoverable refusal, an inconclusive rescue refuses.
    //
    // So the verdict returns to a full match. What actually needed fixing was the
    // REASON: the old message said the base "does not explain what the server sees",
    // which reads as "this base is wrong" when a multi-root layout is the likelier
    // explanation. It now names that possibility and what to do about it.
    if (missing.length === 0 && unreadable.length === 0 && notFiles.length === 0 && escaping.length === 0) {
      return { ok: true, modelsDir, category, matched: files.length, listed: files.length };
    }
    // Each failure mode says what it actually was. "Could not read it" is not "it is not
    // there", and neither is "something is there but it is not a file" — three different
    // fixes, and the old single "are not under" phrasing named only one of them.
    if (unreadable.length > 0) {
      // ORDERED BEFORE `missing` (codex gate): a mixed result would otherwise be
      // narrated purely as absence, and an entry we could not inspect is not an
      // entry we found to be gone. The inconclusive half decides the wording,
      // because it is the half that is not a finding.
      lastReason =
        `the server lists ${files.length} file(s) under "${category}", and ${unreadable.length} of them ` +
        `could not be inspected under "${categoryDir}" (e.g. "${unreadable[0]}") — that is NOT a finding ` +
        `that they are missing, so nothing was established either way` +
        (missing.length > 0
          ? ` (${missing.length} other(s) were not found there, but with the above unreadable that ` +
            `does not settle it)`
          : "");
    } else if (missing.length > 0) {
      const present = files.length - missing.length;
      lastReason =
        present === 0
          ? `the server lists ${files.length} file(s) under "${category}" and NONE of them are under ` +
            `"${categoryDir}" (e.g. "${missing[0]}"), so this base is not a directory the server ` +
            `reads that category from`
          : // The multi-root case, named rather than mislabelled as a wrong base.
            `the server lists ${files.length} file(s) under "${category}" and ${present} of them are ` +
            `under "${categoryDir}", but ${missing.length} are not (e.g. "${missing[0]}"). That is ` +
            `consistent with an extra_model_paths layout where this is ONE of several roots for ` +
            `"${category}" — but it is also what a stale copy sharing some filenames looks like, and ` +
            `a filename listing cannot tell those apart. Rather than guess a destination, set ` +
            `COMFYUI_PATH to the root that actually holds "${category}", or launch ComfyUI with an ` +
            `absolute --base-directory`;
    } else if (notFiles.length > 0) {
      lastReason =
        `the server lists ${files.length} file(s) under "${category}", and ${notFiles.length} of the ` +
        `matching entries under "${categoryDir}" are not regular files (e.g. "${notFiles[0]}")`;
    } else {
      lastReason =
        `the server lists ${escaping.length} entr(y/ies) under "${category}" whose path escapes ` +
        `"${categoryDir}" (e.g. "${escaping[0]}"), so they cannot corroborate this base`;
    }
  }
  if (lastReason) return { ok: false, reason: lastReason };
  // Nothing was COMPARED. Say which of the two reasons that was: the listing could not be
  // read, or it was empty. Reporting the first as the second would be the same fold this
  // whole change is about — and an EMPTY target category genuinely cannot corroborate
  // anything, which is the honest cost of scoping this to the category being written to.
  return {
    ok: false,
    reason:
      unreadableCategories > 0
        ? `the server's "${targetCategory}" listing could not be read, so there was nothing to compare against`
        : `the server lists no files under "${targetCategory}", so there is nothing there to show that this base is the directory it reads that category from`,
  };
}

export async function resolveModelsDirWithBases(opts?: {
  /** The model category this call is downloading INTO (`loras`, `diffusion_models`, …).
   *  Required for the #851 inventory corroboration, which must be about the folder
   *  actually being written to — a match on a sibling category proves nothing about it. */
  targetCategory?: string;
}): Promise<{
  modelsDir: string;
  baseDirs: string[];
  /** The SAME /system_stats snapshot the models/base dirs were derived from — so a
   *  downstream authorizer (getLiveExtraModelRoots, #633) uses ONE consistent
   *  snapshot and can never mix roots from a server that changed between two calls
   *  (codex inter-snapshot race). `reachable` is false when the server was down. */
  snapshot: LiveServerSnapshot;
  /** WHERE the models dir came from. The three live-* values are anchored on the
   *  running server; `base-anchored` and `configured-base` are local config, which
   *  a reachable server may silently disagree with (#369) — callers that WRITE use
   *  this to decide whether the destination still needs corroborating. */
  source: ModelsDirSource;
}> {
  const baseDirs = new Set<string>();
  let modelsDir: string | undefined;
  let source: ModelsDirSource = "configured-base";
  const snapshot: LiveServerSnapshot = { reachable: false };
  /** The live server's install root, resolved through the ONE canonical resolver. */
  let live: ReturnType<typeof resolveLiveServerRoot> | undefined;
  try {
    const stats = await getSystemStats();
    const argv = stats.system?.argv;
    const cwd = (stats.system as { cwd?: string })?.cwd;
    snapshot.reachable = true;
    snapshot.argv = argv;
    snapshot.cwd = cwd;
    // THE live install root (#369): argv when it resolves, else the OS-observed
    // process anchor for the relative-`main.py`-with-no-cwd shape that ComfyUI
    // Desktop and the Windows portable bundle both report. Computed ONCE here and
    // used for BOTH the code-root bases and the models dir, so the two can never
    // be derived from different notions of "live".
    live = resolveLiveServerRoot(argv, cwd, { remote: isRemoteMode() });
    // Collect base-install dirs (LOCAL only) from the SAME call, regardless of how
    // the models dir resolves, so the code-root veto always has the real
    // --base-directory / live-root even when --models-directory diverges.
    if (!isRemoteMode()) {
      const baseDir = parseBaseDirFromArgv(argv, cwd);
      if (baseDir) baseDirs.add(resolve(baseDir));
      if (live.root) {
        baseDirs.add(resolve(live.root));
        // Publish it on the snapshot so downstream consumers (the extra-model-root
        // authorizer) use the SAME established root instead of re-deriving a weaker
        // one from argv.
        snapshot.liveRoot = resolve(live.root);
      }
    }
    const fromArgv = parseModelsDirFromArgv(argv, cwd);
    if (fromArgv) {
      logger.debug("Resolved ComfyUI models directory from launch argv", {
        modelsDir: fromArgv,
      });
      modelsDir = fromArgv;
      source = "argv-flag";
    } else if (!isRemoteMode()) {
      // No explicit --base-directory/--models-directory flag: derive the models
      // root from the LIVE connected server's OWN install root. Only adopt it when
      // it EXISTS locally (a Docker/forwarded server reports a container-side path
      // that is not the host's) — else fall through to the corroborated/refusing
      // logic below (#490/#463).
      if (live.root && existsSync(live.root)) {
        modelsDir = join(live.root, "models");
        source = live.source === "argv" ? "live-root" : "observed-root";
        logger.debug(
          "Resolved ComfyUI models directory from the live server's install root",
          { modelsDir, source },
        );
      }
    }
  } catch (err) {
    logger.debug(
      "Could not resolve models dir from /system_stats; using COMFYUI_PATH/models",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
  // The running server specified a RELATIVE --base-directory/--models-directory but
  // did not report its cwd, so its real models dir is UNKNOWN. Do NOT fall back to a
  // guessed local path (COMFYUI_PATH/models is the wrong place the server never
  // reads — #346). Fail loudly (outside the try so it propagates) so the caller
  // routes through the server / surfaces the problem rather than writing wrong.
  if (
    !modelsDir &&
    snapshot.reachable &&
    !isRemoteMode() &&
    hasUnresolvableRelativeModelDirFlag(snapshot.argv, snapshot.cwd)
  ) {
    throw new ValidationError(
      "The connected ComfyUI was launched with a RELATIVE --base-directory/--models-directory " +
        "and did not report its working directory, so its models directory cannot be resolved " +
        "locally. A download can't be placed safely here — connect with an absolute --base-directory, " +
        "or set COMFYUI_PATH to the server's install so the destination is unambiguous.",
    );
  }
  // Effective LOCAL base: COMFYUI_PATH, else the saved default workspace when NOT
  // remote (#415/#416). Always a code-root base candidate too.
  const base = resolveEffectiveComfyUIBase();
  if (base) baseDirs.add(resolve(base));
  if (!modelsDir) {
    // The live server NAMED a relative `main.py` we could not pin to an install
    // (no cwd reported, and the OS process table could not identify the process or
    // its interpreter is not inside an install tree). COMFYUI_PATH is then NOT
    // evidence of anything: on the reporter's machine it was a SECOND, stale
    // install and 4.88 GB landed there while the running server never saw it
    // (#369). Accept it ONLY when it CORROBORATES what the server reported — the
    // very same relative `main.py` really exists under it. Otherwise refuse: an
    // honest "I don't know where this would land" beats a fabricated success.
    const anchored =
      base && live?.relDir !== undefined && live.source === "unresolved"
        ? anchorRelativeEntrypointOnBase(base, live.relDir)
        : undefined;
    if (anchored) {
      modelsDir = join(anchored, "models");
      source = "base-anchored";
      baseDirs.add(anchored);
      logger.debug(
        "Anchored the live server's relative main.py on the configured base",
        { modelsDir, relDir: live?.relDir, anchored },
      );
    } else if (snapshot.reachable && !isRemoteMode() && live?.source === "unresolved" && live.relDir !== undefined) {
      // Before refusing: the code-layout corroboration above needed a `main.py` at or
      // under the base, and a Docker/data-dir deployment genuinely has none — the code
      // lives inside the container (#851). Ask the SERVER what models it can see and
      // accept the base only if it explains that completely. Runs only here, so it can
      // rescue a refusal but never redirect a download that already resolved.
      const inventory = base
        ? await corroborateBaseByModelInventory(base, (opts?.targetCategory ?? "").trim())
        : { ok: false as const, reason: "no COMFYUI_PATH or default workspace is configured" };
      if (inventory.ok) {
        modelsDir = inventory.modelsDir;
        source = "base-inventory-corroborated";
        baseDirs.add(resolve(base as string));
        // CORROBORATION, NOT PROOF (codex gate P1). The server's listing is
        // filenames only, so a stale local clone holding files with the same names
        // satisfies this check without being mounted into the running server at
        // all. There is no stronger local evidence available — the listing carries
        // no sizes or hashes to distinguish them — so this stays the last-resort
        // rescue it was built as, and the log says what it actually established
        // rather than implying the directory was proven live.
        //
        // Refusing on that doubt would be worse: it would reject the ordinary
        // Docker/data-dir layout this rescue exists to serve. What it must not do
        // is let a later reader take "corroborated" for "verified".
        logger.info(
          "Corroborated the configured base against the running server's model inventory " +
            "(filename match — evidence that this base is one of the roots the server reads, " +
            "not proof that it is)",
          {
            modelsDir,
            category: inventory.category,
            matched: inventory.matched,
            listed: inventory.listed,
            partial: inventory.matched < inventory.listed,
            basis: "filename-inventory",
          },
        );
        return { modelsDir, baseDirs: [...baseDirs], snapshot, source };
      }
      throw new ValidationError(
        "The models directory of the CONNECTED ComfyUI could not be determined, so a " +
          "download has no verified destination. What could not be determined:\n" +
          `  - the running server reported its launch script as the RELATIVE path "${join(live.relDir, "main.py")}" and did NOT report a working directory, so its install root is unknown;\n` +
          `  - the OS process table did not identify an interpreter for the ComfyUI listening on ${config.resolvedPort} that sits inside an install tree${live.observedPython ? ` (observed "${live.observedPython}")` : ""};\n` +
          `  - ${
            base
              ? `the configured local base "${base}" corroborates neither reading of that path: it does not contain "${join(live.relDir, "main.py")}" (the ComfyUI Desktop / launcher-root shape), and it is not itself "${live.relDir}" holding "main.py" (the portable shape where COMFYUI_PATH already points at the ComfyUI directory) — so that check did NOT corroborate it, which is not the same as establishing it is a different install (a Docker/data-dir base legitimately has no main.py at all, #851)`
              : "no COMFYUI_PATH or default workspace is configured"
          }.\n` +
          `  - asking the running server what models it can SEE did not corroborate it either: ${inventory.reason} (this is the check that covers a Docker/data-dir COMFYUI_PATH, which holds models/ but no main.py).\n` +
          "Refusing to write to a guessed directory (that is how a model lands in a stale install and is reported as a success). " +
          "Fix by launching ComfyUI with an ABSOLUTE --base-directory, or set COMFYUI_PATH to the directory whose models/ the server actually reads.",
      );
    } else if (base) {
      modelsDir = resolve(base, "models");
      source = "configured-base";
    } else {
      throw new ValidationError(
        "No local ComfyUI models directory could be resolved. Set the COMFYUI_PATH " +
          "environment variable, save a default workspace with workspace (action:\"set_default\"), " +
          "or connect to a running ComfyUI so its models directory can be detected.",
      );
    }
  }
  return { modelsDir, baseDirs: [...baseDirs], snapshot, source };
}

/**
 * Resolve the models directory the CONNECTED server actually reads from. Asks
 * the running ComfyUI (/system_stats argv → `--base-directory`) first; falls
 * back to `<COMFYUI_PATH>/models`. This is the source of truth for
 * download_model's destination so files land where the live server sees them
 * (issues #346/#369) rather than in a stale COMFYUI_PATH install. Delegates to
 * resolveModelsDirWithBases so the two can never drift.
 */
export async function resolveModelsDir(): Promise<string> {
  return (await resolveModelsDirWithBases()).modelsDir;
}

/**
 * Best-effort: the running server's `--extra-model-paths-config` file, or
 * undefined when unreachable / not launched with the flag. Never throws.
 */
export async function resolveServerExtraModelConfig(): Promise<string | undefined> {
  try {
    const stats = await getSystemStats();
    const configs = parseExtraModelPathsConfigsFromArgv(stats.system?.argv);
    return configs[0];
  } catch {
    return undefined;
  }
}

/** <COMFYUI_PATH>/output fallback. Throws if COMFYUI_PATH is unset. */
export function localOutputDirFallback(): string {
  // THE SAVED DEFAULT WORKSPACE COUNTS (#877). Reading `config.comfyuiPath`
  // alone asks whether ONE ENVIRONMENT VARIABLE is set, and that is not the
  // question — a local portable install is located perfectly well by the saved
  // default workspace, which `install_comfyui (action:"environment")` reports and every other resolver
  // in this codebase already consults. Keying off the env var made a perfectly
  // locatable install look pathless, and the caller upstream then fell through
  // to a data source that cannot see the disk and reported no outputs at all.
  //
  // `resolveEffectiveComfyUIBase` is that shared resolver: COMFYUI_PATH, then
  // the saved default workspace, and nothing in remote mode (where a local path
  // would name the wrong machine).
  const base = resolveEffectiveComfyUIBase();
  if (!base) {
    throw new ValidationError(
      "No local ComfyUI install path could be established: COMFYUI_PATH is not set and no " +
        "default workspace is saved. Set COMFYUI_PATH, or save one with the workspace tool " +
        "(action 'set_default').",
    );
  }
  return resolve(base, "output");
}

// ---------------------------------------------------------------------------
// Resolve ComfyUI's REAL input directory — the exact mirror of the output-dir
// logic above. ComfyUI can be launched with --input-directory (or
// --base-directory) which redirects the LoadImage / VHS_LoadVideo / LoadAudio
// search path away from the default <COMFYUI_PATH>/input. Filesystem-path tools
// that write or check files in the input directory must therefore NOT assume
// <COMFYUI_PATH>/input, or a server with a custom --input-directory rejects the
// file ("Invalid image file") while the tool reports success. Prefer the server
// API (/upload/image, see upload_image (action:"stage")) when possible; use this only
// for genuine local filesystem operations.
// ---------------------------------------------------------------------------

/**
 * Parse the configured input directory out of ComfyUI's launch argv.
 * --input-directory wins; otherwise --base-directory implies <base>/input.
 * Returns undefined when neither flag is present.
 */
export function parseInputDirFromArgv(argv: string[] | undefined): string | undefined {
  if (!argv || argv.length === 0) return undefined;

  let inputDir: string | undefined;
  let baseDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    inputDir = flagValue(argv, i, "--input-directory") ?? inputDir;
    baseDir = flagValue(argv, i, "--base-directory") ?? baseDir;
  }

  const resolvedBase = baseDir ? resolveDir(baseDir) : undefined;
  if (inputDir) return resolveDir(inputDir, resolvedBase);
  if (resolvedBase) return join(resolvedBase, "input");
  return undefined;
}

/** <COMFYUI_PATH>/input fallback. Throws if COMFYUI_PATH is unset. */
export function localInputDirFallback(): string {
  // The exact mirror of the output fallback above, and the same #877 reasoning:
  // these two must agree about where the install is, or an upload and the listing
  // of what was uploaded would disagree.
  const base = resolveEffectiveComfyUIBase();
  if (!base) {
    throw new ValidationError(
      "No local ComfyUI install path could be established: COMFYUI_PATH is not set and no " +
        "default workspace is saved. Set COMFYUI_PATH, or save one with the workspace tool " +
        "(action 'set_default').",
    );
  }
  return resolve(base, "input");
}

/**
 * Resolve the directory ComfyUI actually reads inputs from. Asks the running
 * ComfyUI (/system_stats argv) first; falls back to <COMFYUI_PATH>/input.
 */
export async function resolveInputDir(): Promise<string> {
  try {
    const stats = await getSystemStats();
    const fromArgv = parseInputDirFromArgv(stats.system?.argv);
    if (fromArgv) {
      logger.debug("Resolved ComfyUI input directory from launch argv", {
        inputDir: fromArgv,
      });
      return fromArgv;
    }
  } catch (err) {
    logger.debug(
      "Could not resolve input dir from /system_stats; using COMFYUI_PATH/input",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
  return localInputDirFallback();
}

/**
 * Resolve the directory ComfyUI actually writes outputs to. Asks the running
 * ComfyUI (/system_stats argv) first; falls back to <COMFYUI_PATH>/output.
 */
export async function resolveOutputDir(): Promise<string> {
  try {
    const stats = await getSystemStats();
    const fromArgv = parseOutputDirFromArgv(stats.system?.argv);
    if (fromArgv) {
      logger.debug("Resolved ComfyUI output directory from launch argv", {
        outputDir: fromArgv,
      });
      return fromArgv;
    }
  } catch (err) {
    logger.debug(
      "Could not resolve output dir from /system_stats; using COMFYUI_PATH/output",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
  return localOutputDirFallback();
}
