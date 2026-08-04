import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { config, isRemoteMode } from "../config.js";
import { getSystemStats } from "../comfyui/client.js";
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
// directory on the local filesystem (convert_image, list_output_images) must
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
 *      `...\ComfyUI_windows_portable\ComfyUI` — the value `get_environment`,
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

export async function resolveModelsDirWithBases(): Promise<{
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
      throw new ValidationError(
        "The models directory of the CONNECTED ComfyUI could not be determined, so a " +
          "download has no verified destination. What could not be determined:\n" +
          `  - the running server reported its launch script as the RELATIVE path "${join(live.relDir, "main.py")}" and did NOT report a working directory, so its install root is unknown;\n` +
          `  - the OS process table did not identify an interpreter for the ComfyUI listening on ${config.resolvedPort} that sits inside an install tree${live.observedPython ? ` (observed "${live.observedPython}")` : ""};\n` +
          `  - ${
            base
              ? `the configured local base "${base}" corroborates neither reading of that path: it does not contain "${join(live.relDir, "main.py")}" (the ComfyUI Desktop / launcher-root shape), and it is not itself "${live.relDir}" holding "main.py" (the portable shape where COMFYUI_PATH already points at the ComfyUI directory) — so it is a DIFFERENT install than the one that is running`
              : "no COMFYUI_PATH or default workspace is configured"
          }.\n` +
          "Refusing to write to a guessed directory (that is how a model lands in a stale install and is reported as a success). " +
          "Fix by launching ComfyUI with an ABSOLUTE --base-directory, or set COMFYUI_PATH to the install that is actually running.",
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
  if (!config.comfyuiPath) {
    throw new ValidationError(
      "COMFYUI_PATH is not configured. Set the COMFYUI_PATH environment variable.",
    );
  }
  return resolve(config.comfyuiPath, "output");
}

// ---------------------------------------------------------------------------
// Resolve ComfyUI's REAL input directory — the exact mirror of the output-dir
// logic above. ComfyUI can be launched with --input-directory (or
// --base-directory) which redirects the LoadImage / VHS_LoadVideo / LoadAudio
// search path away from the default <COMFYUI_PATH>/input. Filesystem-path tools
// that write or check files in the input directory must therefore NOT assume
// <COMFYUI_PATH>/input, or a server with a custom --input-directory rejects the
// file ("Invalid image file") while the tool reports success. Prefer the server
// API (/upload/image, see stage_output_as_input) when possible; use this only
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
  if (!config.comfyuiPath) {
    throw new ValidationError(
      "COMFYUI_PATH is not configured. Set the COMFYUI_PATH environment variable.",
    );
  }
  return resolve(config.comfyuiPath, "input");
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
