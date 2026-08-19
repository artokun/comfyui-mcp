import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join, isAbsolute, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { config, isRemoteMode } from "../config.js";
import { normalizeInstallPathEnv } from "../utils/install-path-env.js";
import {
  parseExtraModelPathsConfigsFromArgvRaw,
  type LiveServerSnapshot,
} from "./output-dir.js";
import {
  liveRelDirFromArgv,
  liveRootFromArgv,
  liveScriptFromArgv,
  didLaunchLocalComfyUI,
  getLiveServerSnapshot,
  resolveLiveServerRoot,
  resolveEffectiveComfyUIBase,
} from "./workspace-env.js";
import { ValidationError } from "../utils/errors.js";

export const EXTRA_PATH_TARGETS = ["auto", "standalone", "desktop"] as const;
export type ExtraPathTarget = (typeof EXTRA_PATH_TARGETS)[number];

export interface ExtraPathCategory {
  category: string;
  paths: string[];
}

export interface ExtraPathGroup {
  name: string;
  base_path?: string;
  is_default?: unknown;
  categories: ExtraPathCategory[];
}

export interface ExtraPathsConfigInfo {
  target: Exclude<ExtraPathTarget, "auto">;
  path: string;
  exists: boolean;
  groups: ExtraPathGroup[];
  notes: string[];
}

export interface ExtraPathMutationResult extends ExtraPathsConfigInfo {
  changed: boolean;
  message: string;
}

interface ExtraPathOptions {
  target?: ExtraPathTarget;
  configPath?: string;
}

interface ExtraPathMutationOptions extends ExtraPathOptions {
  group?: string;
  category: string;
  path: string;
  isDefault?: boolean;
}

/** ComfyUI-style `~` expansion (utils/extra_config.py applies expanduser FIRST).
 *  ACCEPTED residuals (rare, user's own config on their own machine — maintainer
 *  ruling, same class as the ntpath `$$`/single-quote edges): POSIX `~otheruser`
 *  expansion and leading/trailing whitespace inside a quoted value are not modeled;
 *  only the current user's `~`/`~/` (the form real configs use) is expanded. */
function expandUser(s: string): string {
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) {
    return join(homedir(), s.slice(1));
  }
  return s;
}

// Bare `$NAME` grammar: posixpath uses `\w+`; Windows ntpath additionally admits `-`
// in the name (so `$FOO-bar` is ONE var → usually undefined → left literal, matching
// ComfyUI, instead of expanding `$FOO`). ACCEPTED deeper residuals (rare, trusted-mode
// only, the user's OWN config on their OWN machine — maintainer ruling): the nt `$$`→`$`
// escape and nt single-quote non-expansion are NOT modeled. `${...}` and simple
// `$NAME`/`%NAME%` (the forms real configs use) are exact.
const BARE_VAR = process.platform === "win32" ? /\$([\w-]+)/g : /\$(\w+)/g;
const BARE_VAR_TEST = process.platform === "win32" ? /\$[\w-]+/ : /\$\w+/;

/**
 * Windows `%VAR%` expansion, as a SINGLE LEFT-TO-RIGHT PASS over the string — the same
 * shape as CPython's `ntpath.expandvars`:
 *   - `%%` is an ESCAPED literal `%` (emit one `%`, consume both);
 *   - `%NAME%` (non-empty NAME with no `%` inside) substitutes `process.env[NAME]`, and
 *     an UNDEFINED variable leaves the WHOLE token literal;
 *   - anything else (including an unterminated trailing `%`) is emitted verbatim.
 *
 * Deliberately placeholder-free. The previous implementation protected `%%` by
 * substituting a sentinel token and restoring it in a later pass; ANY sentinel is a
 * legal path substring, so an input that literally contained it was silently rewritten
 * to `%` — a wrong-destination corruption of the same class as the raw-NUL sentinel
 * removed in 1ab84ce. A single pass never re-reads its own output, so no input can be
 * confused for machinery.
 */
function expandPercentVars(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "%") {
      out += s[i];
      i += 1;
      continue;
    }
    if (s[i + 1] === "%") {
      out += "%"; // escaped literal `%`
      i += 2;
      continue;
    }
    // NAME runs to the next `%`; the escape branch above already excluded an empty NAME.
    const close = s.indexOf("%", i + 1);
    if (close === -1) {
      out += "%"; // unterminated — literal
      i += 1;
      continue;
    }
    const name = s.slice(i + 1, close);
    const value = process.env[name];
    // Undefined → keep the entire `%NAME%` token literal (ComfyUI/ntpath behavior).
    out += value ?? s.slice(i, close + 1);
    i = close + 1;
  }
  return out;
}

/** ComfyUI-style env expansion (os.path.expandvars): `${VAR}`/`$VAR` on all platforms,
 *  `%VAR%` on Windows with `%%` an ESCAPED literal `%`; an UNDEFINED variable is left
 *  literal. Exported for unit tests. */
export function expandVars(s: string): string {
  let r = s.replace(/\$\{([^}]+)\}/g, (m, n) => process.env[n] ?? m);
  r = r.replace(BARE_VAR, (m, n) => process.env[n] ?? m);
  if (platform() === "win32") r = expandPercentVars(r);
  return r;
}

/** True when `s` still contains an env-var token expandVars would substitute. Kept
 *  INCLUSIVE (matches the inner name even in an escaped `%%VAR%%`) so the untrusted
 *  fail-closed drop errs toward refusing rather than authorizing a guess. */
function hasEnvVarToken(s: string): boolean {
  if (/\$\{[^}]+\}/.test(s) || BARE_VAR_TEST.test(s)) return true;
  return platform() === "win32" && /%[^%]+%/.test(s);
}

/**
 * Expand a live config `base_path` EXACTLY as ComfyUI does (utils/extra_config.py):
 * expanduser FIRST, THEN expandvars, applied ONLY to base_path (per-category subpath
 * entries are left LITERAL — ComfyUI never expands them). Mirroring the order + scope
 * is a correctness requirement: authorizing a path ComfyUI would NOT register lets a
 * symlink escape to a dir the server never scans (#633 P1a).
 *
 * P1b (fail-closed env): `$VAR`/`${VAR}`/`%VAR%` is expanded against process.env ONLY
 * when the running server SHARES this process's environment (trustServerEnv — a local
 * server this MCP launched, which inherited our env). Otherwise the server's real
 * value is UNKNOWN, so a base_path that still needs an env var is UNRESOLVABLE and the
 * caller drops the whole group rather than authorize a guessed-wrong destination.
 * Returns undefined = unresolvable.
 */
function expandLiveBasePath(rawBase: string, trustServerEnv: boolean): string | undefined {
  const afterUser = expandUser(rawBase);
  if (hasEnvVarToken(afterUser)) {
    if (!trustServerEnv) return undefined; // server env unknown → fail closed
    return expandVars(afterUser);
  }
  return afterUser;
}

/**
 * Join a category entry to a truthy `base_path` the way ComfyUI does — via
 * `os.path.join(base, entry)`, for EVERY entry (never treating an absolute-LOOKING
 * entry independently). The load-bearing case is Windows: `os.path.join("D:\\base",
 * "\\unet")` is `D:\\unet` — a drive-RELATIVE `\unet` takes its drive from `base`, NOT
 * the MCP process's current drive. Node's `path.join`/`resolve` would instead produce
 * `C:\\unet` (the cwd drive), so a completely normal Windows config would authorize the
 * WRONG DRIVE and the download would land where ComfyUI can't see it (#633). A fully
 * absolute entry (drive+root, or UNC) still wins (matches os.path.join); a relative
 * entry is base+entry.
 */
function joinCategoryEntryToBase(base: string, entry: string): string {
  if (process.platform === "win32") {
    const isUNC = /^[\\/]{2}/.test(entry);
    const hasDrive = /^[a-zA-Z]:[\\/]/.test(entry);
    const rootedNoDrive = !isUNC && !hasDrive && /^[\\/]/.test(entry);
    // Extended-length / device-namespace bases (`\\?\…`, `\\.\…`) have an exotic
    // splitdrive we deliberately do NOT model — ACCEPTED residual (maintainer ruling:
    // essentially never a hand-written models base_path). Skip prefix extraction for
    // them so we never mis-capture a wrong share; they fall through to the generic join.
    const isDevicePath = /^[\\/]{2}[?.][\\/]/.test(base);
    if (rootedNoDrive && !isDevicePath) {
      // os.path.splitdrive-style prefix of base — a drive letter (`D:`) OR a UNC
      // share (`\\server\share`). A drive-relative `\unet` takes that prefix, so a
      // UNC base's share is preserved (`\\server\share\unet`), not the MCP drive.
      const prefix =
        /^([a-zA-Z]:)/.exec(base)?.[1] ??
        /^([\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.exec(base)?.[1];
      if (prefix) return resolve(prefix + entry); // prefix from base, path from entry
      // base itself is rooted-but-driveless — os.path.join then yields the entry on the
      // current drive, which the fall-through resolve(entry) already produces.
    }
  }
  // Everything else mirrors os.path.join: an absolute entry wins, else base + entry.
  return isAbsolute(entry) ? resolve(entry) : resolve(base, entry);
}

const RESERVED_KEYS = new Set(["base_path", "is_default"]);
const SAFE_KEY_RE = /^[A-Za-z0-9_.-]+$/;
const CONTROL_RE = /[\x00\r\n]/;

function assertSafeKey(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(`${label} must be a non-empty string.`);
  if (!SAFE_KEY_RE.test(trimmed)) {
    throw new ValidationError(
      `${label} may contain only letters, numbers, dot, dash, and underscore: ${value}`,
    );
  }
  return trimmed;
}

function assertPathValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError("Path must be a non-empty string.");
  if (CONTROL_RE.test(trimmed)) {
    throw new ValidationError("Path must not contain NUL or newline characters.");
  }
  return trimmed;
}

function desktopConfigPath(): string {
  const p = platform();
  if (p === "win32") {
    const root = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(root, "ComfyUI", "extra_models_config.yaml");
  }
  if (p === "darwin") {
    return join(homedir(), "Library", "Application Support", "ComfyUI", "extra_models_config.yaml");
  }
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(root, "ComfyUI", "extra_models_config.yaml");
}

/**
 * The local ComfyUI root whose `extra_model_paths.yaml` a standalone/manual install
 * uses. Delegates to `resolveEffectiveComfyUIBase()` — the SINGLE source of truth every
 * other filesystem-backed tool (download_model, model lookups, node_pack (action:"verify"),
 * install_comfyui (action:"environment")) already uses — so this file can never disagree with them about where
 * ComfyUI lives. That order is:
 *
 *   1. `config.comfyuiPath` — COMFYUI_PATH env or auto-detection (wins), then
 *   2. the SAVED DEFAULT WORKSPACE (workspace action:"set_default"), local mode only.
 *
 * Before #648 this read `config.comfyuiPath` DIRECTLY, so with COMFYUI_PATH unset
 * `list_local_models action:"list_paths"` threw while `workspace`/`install_comfyui (action:"environment")` happily reported the
 * saved default workspace — the same install, two different answers.
 *
 * Throws (never guesses) when neither is available, including when the session is not
 * pointed at a local install: reporting some other root's model dirs as if they were the
 * live server's is a wrong-destination hazard, so an explicit unresolved error is the
 * only safe answer.
 *
 * That last clause is stated as a consequence of what `resolveEffectiveComfyUIBase()`
 * returns, not as a guarantee this function independently enforces — the previous
 * wording asserted the guarantee flatly while the resolver did not implement it (#490),
 * and a confident absolute in a comment is precisely what stops the next reader from
 * re-deriving it. If that resolver ever stops refusing, this text is wrong and the check
 * belongs here.
 *
 * STALE-ROOT GUARD (codex rounds 2-3, P1): an INFERRED root — a saved default workspace
 * persisted once and maybe never revisited, or a startup AUTO-DETECTION that has since
 * gone away — has to prove the directory is still THERE before it can be used. Without
 * that check `list_local_models action:"add_path"` would resolve to `<gone root>/extra_model_paths.yaml`,
 * `writeConfigFile`'s recursive `mkdir` would MATERIALIZE the whole vanished tree, and
 * the tool would report "Added … Restart ComfyUI" for a file no ComfyUI will ever read —
 * a silent wrong-destination write. A missing/non-directory inferred root is therefore
 * an explicit error, for READS too: listing a phantom root as an empty config is exactly
 * the authoritative-looking lie this issue is about.
 *
 * An EXPLICIT `COMFYUI_PATH` env var is deliberately NOT gated: that is the user
 * directly naming a root, and its pre-#648 behavior (report `exists:false`, create the
 * dir on write) is left unchanged. `process.env.COMFYUI_PATH` is the discriminator —
 * the same one `getWorkspace()` uses to report `env` vs `auto-detected`.
 *
 * ACCEPTED residual (codex round 3 P2): `statSync` on a saved workspace that lives on a
 * DISCONNECTED UNC share can block for seconds. Not special-cased, because failing
 * closed on `\\server\share` would refuse a perfectly valid NAS install, and the very
 * next steps (`existsSync`/`readFile` on the config file under that same share, which
 * predate this guard) block identically — the guard adds no new class of exposure.
 */
/** Identity of a directory, when the filesystem reports a usable one. Windows leaves
 *  `ino` 0 for directories on some volumes, so it is optional — absent identity degrades
 *  to a plain existence check rather than refusing everything. */
interface DirIdentity {
  dev: number;
  ino: number;
}

function statDir(p: string): { identity?: DirIdentity } | undefined {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return undefined;
    return Number(st.ino) > 0 && Number(st.dev) > 0
      ? { identity: { dev: Number(st.dev), ino: Number(st.ino) } }
      : {};
  } catch {
    return undefined; // missing, unreadable, or a dangling symlink
  }
}

/**
 * A root whose existence was PROVEN during resolution and must still hold at every
 * point of use. Resolution and I/O are separated by awaits, so a one-time gate is a
 * TOCTOU check — the root can vanish (a read would then report a phantom EMPTY config,
 * the exact authoritative-looking lie this issue is about) or be REPLACED by a different
 * directory at the same pathname (a write would then land in the wrong tree and still
 * report success). `assertRootIntact` is therefore called immediately before every read,
 * again right AFTER it (a no-op add/remove returns the read's data, so a replacement
 * during the read must fail there too, not only when a write follows), and again
 * immediately before every write, and compares dev+ino when the filesystem
 * supplies them so a same-path replacement is caught, not just a deletion.
 *
 * ACCEPTED residual: on a volume that reports no usable inode (some Windows directory
 * cases) a replacement swapped in within the final microseconds before `writeFile` is
 * indistinguishable from the original. Single-user local machine, and the window is now
 * bounded by one syscall instead of the whole tool invocation.
 */
type GuardedRootSource = StandaloneRootSource | "live-root";

interface GuardedRoot {
  path: string;
  identity?: DirIdentity;
  source: GuardedRootSource;
}

function guardedRootOrigin(source: GuardedRootSource): string {
  if (source === "default-workspace") return "the saved default workspace (workspace action:\"set_default\")";
  if (source === "live-root") return "the running ComfyUI's own install root (from its launch argv)";
  return "a ComfyUI root this process INFERRED (auto-detection, or a nested root descended from COMFYUI_PATH)";
}

function assertRootIntact(guard: GuardedRoot | undefined): void {
  if (!guard) return;
  const now = statDir(guard.path);
  const origin = guardedRootOrigin(guard.source);
  if (!now) {
    throw new ValidationError(
      `UNRESOLVED: "${guard.path}" is no longer an existing directory. It came from ${origin} ` +
        "and disappeared while this call was running. Nothing was read or written — an empty " +
        "result here would look like a config with no extra paths, which is not what is true. " +
        "Re-run workspace (action:\"set_default\") with the current path, set COMFYUI_PATH, or pass " +
        "config_path explicitly.",
    );
  }
  if (
    guard.identity &&
    now.identity &&
    (now.identity.dev !== guard.identity.dev || now.identity.ino !== guard.identity.ino)
  ) {
    throw new ValidationError(
      `UNRESOLVED: "${guard.path}" was REPLACED by a different directory while this call was ` +
        `running (it came from ${origin}). Nothing was read or written — continuing would ` +
        "operate on a tree that is not the one this call resolved. Re-run the operation.",
    );
  }
}

type StandaloneRootSource = "comfyui-path-env" | "comfyui-path-inferred" | "default-workspace";

/** Same NORMALIZED LEXICAL path? (`path.resolve` on both, case-folded on win32.) It does
 *  NOT `realpath`, so 8.3 short names, a symlink vs its target, and UNC vs mapped-drive
 *  spellings of one share compare FALSE. That is the safe direction: a false negative
 *  demotes the root from "explicit" to "inferred", which only means it gets the existence
 *  gate and no `mkdir -p` — over-refusal, never an unguarded write to a wrong root. */
function samePath(a: string, b: string): boolean {
  try {
    const na = resolve(a);
    const nb = resolve(b);
    return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
  } catch {
    return false;
  }
}

/**
 * Do these two spellings name the SAME config file? Used only by the #1788 divergence
 * disclosure, where the harmful direction is the opposite of `samePath`'s.
 *
 * `samePath` is deliberately lexical, and its false negatives are safe there: they demote
 * a root from "explicit" to "inferred", i.e. more checking. Here a false negative would
 * declare a file the server DOES read to be inert and tell the user their edit will not
 * apply — a confident wrong answer on a correct action. A junction, an 8.3 short name, or
 * a UNC-vs-mapped-drive spelling of one file is ordinary on the platform this was
 * reported from, so the comparison is collapsed through `realpath` as well.
 *
 * WHICH realpath is load-bearing, and the previous version of this comment was simply
 * WRONG about it: `fs.realpathSync` collapses junctions and symlinks but does NOT expand
 * a Windows 8.3 short name — only `fs.realpathSync.native` asks the OS and gets back the
 * long, real-case path. This repo already learned that (`panel-installer.ts`,
 * `node-dev.ts` both use `.native` for exactly this). With the JS binding, pinning the
 * server's OWN config by its short spelling produced "the running ComfyUI does NOT read
 * `…\AVERYL~1\instance.yaml`" for a file it demonstrably reads (gate round 2, P1) —
 * the disqualifying direction, on the platform this was reported from. `.native` first,
 * with the JS binding as a fallback so an environment where the native call is
 * unavailable still collapses junctions rather than nothing.
 *
 * `realpath` on the FILE is not enough either, and that gap is not academic: it throws
 * on a path that does not exist, and "does not exist yet" is the ordinary state here —
 * the implicit `<root>/extra_model_paths.yaml` a caller is about to CREATE. In that
 * state the file-level collapse silently degrades to the lexical compare it was added to
 * fix, so a junctioned `COMFYUI_PATH` naming the very file the server reads was declared
 * inert (gate round 1, P1, reproduced with a real Windows junction).
 *
 * So resolve the DIRECTORY and rejoin the basename when the file itself does not
 * resolve. The aliasing that matters lives in the parent — a junctioned/symlinked
 * install root, an 8.3 short name, a mapped drive — and the parent of a config a caller
 * can write to normally exists. Only when even the parent does not resolve does this
 * fall back to the lexical form, i.e. to exactly what `samePath` already compared.
 */
function sameConfigFile(a: string, b: string): boolean {
  if (samePath(a, b)) return true;
  /** Canonicalize one path, or `undefined` if it cannot be resolved at all. `.native`
   *  is FIRST and is the only binding that expands a Windows 8.3 short name; the JS
   *  binding is a fallback that still collapses junctions/symlinks. Returning
   *  `undefined` rather than the input keeps "could not resolve" distinguishable from
   *  "resolved to itself", so the caller can try the parent instead of silently
   *  comparing an unresolved path against a resolved one. */
  const canon = (p: string): string | undefined => {
    try {
      return realpathSync.native(p);
    } catch {
      // Native unavailable, or the path is absent/unreadable — try the JS binding.
    }
    try {
      return realpathSync(p);
    } catch {
      return undefined;
    }
  };
  const real = (p: string): string => {
    const direct = canon(p);
    if (direct !== undefined) return direct;
    // Absent/unreadable — and absent is the ORDINARY state, since pinning a config is
    // how a caller creates it. The aliasing lives in the parent, so resolve the
    // directory and rejoin the basename.
    const parent = canon(dirname(p));
    return parent === undefined ? p : join(parent, basename(p));
  };
  return samePath(real(a), real(b));
}

function standaloneRoot(): {
  root: string;
  source: StandaloneRootSource;
  guard?: GuardedRoot;
} {
  const root = resolveEffectiveComfyUIBase();
  if (!root) {
    throw new ValidationError(
      "UNRESOLVED: no local ComfyUI path is known, so the standalone " +
        "extra_model_paths.yaml cannot be located" +
        (isRemoteMode()
          ? " (a REMOTE ComfyUI is targeted, and a local workspace is not that server's " +
            "config — reporting one would be wrong). Pass config_path explicitly, or set " +
            "COMFYUI_PATH to the local install you want to inspect."
          : ". Set COMFYUI_PATH, set a default workspace with workspace (action:\"set_default\"), " +
            "or pass config_path explicitly.") +
        " No extra paths are being reported — this is an unresolved lookup, not an empty config.",
    );
  }
  // config.comfyuiPath is what resolveEffectiveComfyUIBase prefers, so its presence (not
  // a re-derivation) separates it from the saved default. Only a root that is LITERALLY
  // what COMFYUI_PATH says is "explicit": config.ts also runs descendToNestedRoot(), so
  // an env var naming a Desktop-installer WRAPPER yields `<wrapper>/ComfyUI` — a path
  // this process INFERRED, which can vanish while the wrapper survives (codex round 4).
  // Anything inferred is gated exactly like the saved default workspace.
  // #1512 — normalized, and NOT optional here. This compares against
  // `config.comfyuiPath`, which is normalized at ingestion; leaving this side raw
  // would make a value with a trailing space fail `samePath` and silently
  // reclassify an explicitly-named root as "comfyui-path-inferred" — a DIFFERENT,
  // gated branch. Before the trim both sides were equally malformed and matched by
  // accident, so normalizing only the other side would have introduced that
  // divergence rather than fixed it.
  const envPath = normalizeInstallPathEnv(process.env.COMFYUI_PATH).path;
  const source: StandaloneRootSource = !config.comfyuiPath
    ? "default-workspace"
    : envPath && samePath(config.comfyuiPath, envPath)
      ? "comfyui-path-env"
      : "comfyui-path-inferred";
  if (source === "comfyui-path-env") return { root, source };

  const seen = statDir(root);
  if (!seen) {
    const origin =
      source === "default-workspace"
        ? "the saved default workspace (workspace action:\"set_default\") — the install was probably moved, renamed or deleted since it was saved"
        : "a ComfyUI root this process INFERRED rather than one you named literally " +
          "(startup auto-detection, or a nested root descended from COMFYUI_PATH) — it has " +
          "since been moved, renamed or deleted";
    throw new ValidationError(
      `UNRESOLVED: "${root}" is not an existing directory, so it cannot be used to locate ` +
        `extra_model_paths.yaml. That path came from ${origin}. Nothing was read or ` +
        "written — refusing to create a config under a root that does not exist, because no " +
        "ComfyUI would ever read it. Re-run workspace (action:\"set_default\") with the current path, set " +
        "COMFYUI_PATH, or pass config_path explicitly.",
    );
  }
  return { root, source, guard: { path: root, identity: seen.identity, source } };
}

/** Whether writing this config may recursively CREATE missing parent directories. False
 *  for an inferred root: it was just verified to exist, so a `mkdir -p` could only ever
 *  fire because the root vanished between the check and the write — and it would then
 *  resurrect the wrong destination instead of failing (codex round 3, P1a TOCTOU). With
 *  it off, that race surfaces as an honest ENOENT. */
interface ResolvedTarget {
  target: Exclude<ExtraPathTarget, "auto">;
  path: string;
  notes: string[];
  createParents: boolean;
  /** Set for an inferred root — re-proved before every read and every write. */
  guard?: GuardedRoot;
  /** Every config file the RUNNING server loads, when this resolution was anchored to
   *  that server. Only a `complete` set can support the #1788 divergence disclosure —
   *  a path's ABSENCE from a partial set is not evidence the server does not read it.
   *
   *  INVARIANT, relied on by `notePinnedDivergence`: this field is set ONLY by a branch
   *  that also reports `serverResolved: true`. Its presence is therefore the proof that
   *  the running server — not a local heuristic, not a #764 display fallback — named
   *  these files. A branch that sets it without that anchoring would turn a guess into a
   *  confident "the running ComfyUI does not read your file". */
  liveLoaded?: LiveLoadedConfigs;
  /** Set ONLY when the caller PINNED a file (`target`/`config_path`) and the running
   *  server was proven to read a DIFFERENT, completely-enumerated set of configs — i.e.
   *  this edit cannot affect the running server. Structured, never re-parsed from the
   *  note: the mutation messages key on this field to stop promising "Restart ComfyUI
   *  to apply it" for a file no ComfyUI will read (#1788). */
  divergesFromLive?: { serverPaths: string[] };
}

/**
 * The config files the RUNNING ComfyUI loads, established from ONE /system_stats
 * snapshot. ComfyUI's set is exactly: every `--extra-model-paths-config` it was launched
 * with, PLUS `<its own main.py root>/extra_model_paths.yaml`.
 *
 * `complete: false` means this process could NOT name them all — a RELATIVE
 * `--extra-model-paths-config` with no reported server cwd resolves only against the
 * SERVER's working directory. In that state a file's absence from `paths` says nothing
 * about whether the server reads it, so no caller may conclude divergence from it. Same
 * rule the rest of this file runs on: "could not determine" is never "determined not".
 */
interface LiveLoadedConfigs {
  paths: string[];
  complete: boolean;
}

function standaloneConfigPath(): Omit<ResolvedTarget, "target"> {
  const { root, source, guard } = standaloneRoot();
  return {
    path: join(root, "extra_model_paths.yaml"),
    createParents: source === "comfyui-path-env",
    guard,
    notes:
      source === "default-workspace"
        ? [
            `Resolved from the saved default workspace (${root}) because COMFYUI_PATH is not set. ` +
              `This was NOT confirmed against the running ComfyUI (its live ` +
              `--extra-model-paths-config was not available), so if you have since switched ` +
              `installs this may not be the file the running server reads — check workspace (action:"get") ` +
              `and re-run workspace (action:"set_default") if it is stale.`,
          ]
        : [],
  };
}

function resolveTargetPath(opts: ExtraPathOptions = {}): ResolvedTarget {
  if (opts.configPath) {
    return {
      target: opts.target === "desktop" ? "desktop" : "standalone",
      path: opts.configPath,
      notes: [],
      createParents: true, // the caller named this exact file
    };
  }

  const target = opts.target ?? "auto";
  if (target === "desktop") {
    return { target, path: desktopConfigPath(), notes: [], createParents: true };
  }
  if (target === "standalone") return { target, ...standaloneConfigPath() };

  const desktop = desktopConfigPath();
  if (existsSync(desktop)) {
    return { target: "desktop", path: desktop, notes: [], createParents: true };
  }
  return { target: "standalone", ...standaloneConfigPath() };
}

function splitPaths(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((line) => line.trim())
      .filter(Boolean);
  }
  return [];
}

function readGroup(raw: unknown, name: string): ExtraPathGroup | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const categories: ExtraPathCategory[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (RESERVED_KEYS.has(key)) continue;
    const paths = splitPaths(value);
    if (paths.length > 0) categories.push({ category: key, paths });
  }
  return {
    name,
    base_path: typeof obj.base_path === "string" ? obj.base_path : undefined,
    is_default: obj.is_default,
    categories,
  };
}

function parseConfig(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const parsed = parseYaml(text, { maxAliasCount: 50 });
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("Extra paths config must be a YAML object.");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Is there a readable config FILE at this path — and if not, do we actually know that?
 *
 * `existsSync` answers false for every failure alike: ENOENT, an EACCES on a parent
 * directory, a Windows sharing violation, a stalled network mount. Downstream that single
 * false became "this config does not exist" and then "this config is empty", which is the
 * defect this whole change is about. A directory at the path is a third thing again.
 */
type LocalFile =
  | { kind: "file" }
  | { kind: "absent" }
  | { kind: "not-a-file" }
  | { kind: "indeterminate"; detail: string };

function probeLocalFile(path: string): LocalFile {
  try {
    return statSync(path).isFile() ? { kind: "file" } : { kind: "not-a-file" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "indeterminate", detail: code ?? String(err) };
  }
}

async function readConfigFile(
  path: string,
): Promise<{ raw: Record<string, unknown>; exists: boolean }> {
  const found = probeLocalFile(path);
  // genuinely not there → genuinely no entries
  if (found.kind === "absent") return { raw: {}, exists: false };
  if (found.kind !== "file") {
    // A config we could not LOOK AT must never be summarised as an empty one: "no extra
    // paths are configured" is a claim, and we have not earned it. Nothing was read or
    // written, so refusing is correct here — there is no partial result to disclose.
    throw new ValidationError(
      found.kind === "not-a-file"
        ? `UNRESOLVED: "${path}" exists but is not a file (it is a directory or a special ` +
          "file), so no extra-path configuration could be read from it. Nothing was read or " +
          "written, and NO claim is being made about what paths are configured. Pass " +
          "config_path with the real YAML file."
        : `UNRESOLVED: "${path}" could not be inspected (${found.detail}), so this process ` +
          "cannot tell whether a config is there. This is NOT a report that the file is " +
          "missing or that no extra paths are configured — an empty result would be a claim " +
          "we have not earned. Nothing was read or written. Check the permissions on that " +
          "path (or the mount it lives on), or pass config_path with a file you can read.",
    );
  }
  return { raw: parseConfig(await readFile(path, "utf-8")), exists: true };
}

function summarize(
  target: Exclude<ExtraPathTarget, "auto">,
  path: string,
  raw: Record<string, unknown>,
  extraNotes: string[] = [],
  serverResolved = false,
  /**
   * The read-time observation, threaded in rather than re-derived. Re-statting here
   * would put a SECOND lookup between the successful read and the answer, and any
   * failure of that second lookup (a transient sharing violation, a mount hiccup) would
   * be reported as `exists: false` about a file we had just finished reading.
   */
  exists = false,
  /**
   * Set when this file was PINNED and the running server provably reads elsewhere
   * (#1788). The headline `message` is not the only place that promised an effect: the
   * generic "Restart ComfyUI after editing this file" note below is appended to EVERY
   * summary, and it is the same promise in different words — different enough that the
   * `message`-level assertions did not see it (gate round 1, P1). An agent reads `notes`
   * and acts on it, so the promise is withdrawn HERE too, keyed on the same structured
   * observation `inertEditSuffix` uses rather than on re-read prose. Nothing is lost:
   * the divergence warning already in `extraNotes` states what a restart will and will
   * not do, so the two can never disagree.
   */
  divergesFromLive?: { serverPaths: string[] },
): ExtraPathsConfigInfo {
  const groups: ExtraPathGroup[] = [];
  for (const [name, value] of Object.entries(raw)) {
    const group = readGroup(value, name);
    if (group) groups.push(group);
  }
  const notes = [
    ...extraNotes,
    // The generic "which file" hint only applies to the static-heuristic path; a
    // server-resolved config already states the real file, so skip it to avoid
    // contradicting that. (Keyed on serverResolved, NOT on "any extra note": the
    // static path can now also carry a note — the #648 default-workspace source.)
    ...(serverResolved
      ? []
      : [
          target === "desktop"
            ? "Desktop uses extra_models_config.yaml in the OS ComfyUI app-data directory."
            : "Standalone/manual installs use extra_model_paths.yaml in the ComfyUI root.",
        ]),
    "Categories are generic ComfyUI search-path keys, so model folders and custom_nodes can both be represented when supported by the running ComfyUI build.",
    ...(divergesFromLive
      ? []
      : ["Restart ComfyUI after editing this file so startup path registration is rebuilt."]),
  ];
  return { target, path, exists, groups, notes };
}

/**
 * Detect the ComfyUI-Desktop auto-generated shared config, which carries a
 * "do not edit manually" header and is regenerated by the Desktop app.
 */
function isDesktopGeneratedConfig(path: string): boolean {
  return /Comfy Desktop[\\/].*shared_model_paths\.ya?ml$/i.test(path);
}

/** Which `target` label a server-named config file should be reported under. */
function looksLikeDesktopConfig(path: string): boolean {
  return (
    isDesktopGeneratedConfig(path) ||
    /Comfy Desktop[\\/]|[\\/]ComfyUI[\\/]extra_models_config\.ya?ml$/i.test(path)
  );
}

/**
 * ComfyUI locates its implicit `extra_model_paths.yaml` next to `os.path.realpath(__file__)`
 * — the SYMLINK TARGET of its `main.py`, not the spelling in argv. `liveRootFromArgv` is
 * lexical (it is shared with the #633 authorization path and must not change), so this
 * resolves the real directory here: a launcher that keeps `/launcher/main.py` symlinked to
 * `/installs/B/main.py` makes ComfyUI read `/installs/B/extra_model_paths.yaml`, and
 * writing `/launcher/…` instead would be a silent no-op (codex round 6, P1a).
 *
 * It is the EXACT argv script that is resolved — not a sibling `main.py` picked by name —
 * so a server running `main.pyw` next to an unrelated symlinked `main.py` still resolves
 * to its own root (codex round 7). Requiring the file to RESOLVE also proves the live
 * root is reachable on THIS filesystem: a server in a container/WSL/another machine
 * reports a root we cannot see, and returning undefined there makes the caller refuse
 * explicitly instead of creating a lookalike tree locally and reporting success.
 */
/**
 * Why the live root could not be established, when it could not.
 *
 * "absent" — the path genuinely does not exist here (ENOENT), or resolves to something
 * that is not a file. That IS evidence the server's filesystem is not ours.
 *
 * "indeterminate" — the lookup itself failed for a reason that says nothing about
 * whether the file is there: EACCES/EPERM on a parent directory, ELOOP, EIO, a Windows
 * sharing violation, a stalled network mount. Collapsing that into "absent" turns "we
 * could not look" into "we looked and it is not there", and then narrates it as
 * "the server is running in a container, WSL, or on another host" — a cause the code
 * never observed. Kept separate so the message can only assert what actually happened.
 */
type LiveRootResult =
  | { root: string }
  | { root?: undefined; why: "absent" | "indeterminate"; detail?: string };

function realLiveRoot(scriptPath: string): LiveRootResult {
  let real: string;
  try {
    real = realpathSync(scriptPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { why: "absent" };
    return { why: "indeterminate", detail: code ?? String(err) };
  }
  try {
    // A DIRECTORY named main.py would realpath fine and prove nothing (codex round 7).
    if (!statSync(real).isFile()) return { why: "absent" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { why: "absent" };
    return { why: "indeterminate", detail: code ?? String(err) };
  }
  return { root: dirname(real) };
}

/**
 * The `<live root>/extra_model_paths.yaml` a reachable server implicitly reads when it
 * was launched with no `--extra-model-paths-config`. The root is proven (its `main.py`
 * must resolve here) and then GUARDED and `createParents:false` like any other root this
 * process derived rather than the user naming: a reported root can be stale (the server
 * restarted elsewhere) or simply not ours to write to. Throws UNRESOLVED rather than
 * falling back to a static guess — falling back is precisely the wrong-tree write this
 * whole branch exists to stop.
 */
function implicitLiveTarget(
  liveRoot: string,
  opts: ExtraPathOptions,
  unresolvableFlag?: string,
): ResolvedTarget & { serverResolved: boolean } {
  // `liveRoot` is the ALREADY-PROVEN realpath'd root the caller resolved once. It is
  // deliberately not re-resolved here: two realpath() calls could disagree if the script
  // symlink were retargeted between them, and the second answer would then be guarded and
  // written while the first was the one reported/disclosed (codex round 11).
  const seen = statDir(liveRoot);
  if (!seen) {
    throw new ValidationError(
      `UNRESOLVED: the running ComfyUI's install root "${liveRoot}" is no longer an existing ` +
        "directory — it moved or was removed while this call was running. The " +
        "extra_model_paths.yaml it reads sits in that directory, so nothing was read or " +
        "written; creating a lookalike config locally would be a silent no-op. Pass config_path " +
        'explicitly to target a file you can reach, or target: "standalone"/"desktop" to use ' +
        "the local heuristic deliberately.",
    );
  }
  const path = join(liveRoot, "extra_model_paths.yaml");
  const notes = unresolvableFlag
    ? [
        `Resolved to the RUNNING ComfyUI's own extra_model_paths.yaml (${path}). ComfyUI loads this file from its install root whenever it exists, in addition to any --extra-model-paths-config — so edits here (including creating the file) take effect on the next restart.`,
        `NOTE: this server was also launched with a RELATIVE --extra-model-paths-config ("${unresolvableFlag}") and does not report its working directory, so THAT file cannot be located from this process and its entries are not listed here. Pass config_path with its absolute path to view or edit it.`,
      ]
    : [
        `Resolved from the RUNNING ComfyUI's own install root (${liveRoot}): it was launched with no --extra-model-paths-config, so this is the extra_model_paths.yaml it loads from that root (creating the file makes the next restart load it).`,
      ];
  // Divergence diagnostic only — a failing static guess (no COMFYUI_PATH, a vanished
  // saved workspace) must never break the real, live-anchored resolution.
  try {
    const staticGuess = resolveTargetPath(opts);
    if (resolve(staticGuess.path) !== resolve(path)) {
      notes.push(
        `NOTE: this differs from the path the static heuristic would have used (${staticGuess.path}) — e.g. a saved default workspace or COMFYUI_PATH pointing at a DIFFERENT install than the one running. Editing that other file would be a silent no-op: the running server does not read it. Pass config_path explicitly to target it anyway.`,
      );
    }
  } catch {
    // No static guess available — the live-resolved path stands on its own.
  }
  return {
    target: "standalone",
    path,
    notes,
    serverResolved: true,
    createParents: false, // the root is proven; only the YAML itself may be missing
    guard: { path: liveRoot, identity: seen.identity, source: "live-root" },
    // With no flag at all this IS the server's whole set. With an UNRESOLVABLE relative
    // flag there is a second file we cannot name, so the set is incomplete and a pinned
    // path's absence from it concludes nothing.
    liveLoaded: { paths: [path], complete: unresolvableFlag === undefined },
  };
}

/**
 * Resolve the target config path, PREFERRING the file the running server was
 * actually launched with (`--extra-model-paths-config`, read from /system_stats
 * argv) when the caller didn't pin an explicit target/config_path. On ComfyUI
 * Desktop the live file is `…\Comfy Desktop\shared_model_paths.yaml`, NOT the
 * app-data `ComfyUI\extra_models_config.yaml` the static heuristic guesses — so
 * without this, list_local_models action:"list_paths" reports fiction and list_local_models action:"add_path" is a silent
 * no-op against a file the server never reads (issue #345). Returns the resolved
 * target plus any warning notes to surface. Best-effort: falls back to the
 * static resolveTargetPath when the server is unreachable.
 *
 * A server launched WITHOUT that flag still reads one: ComfyUI auto-loads
 * `<its own main.py root>/extra_model_paths.yaml`. So when the flag is absent but the
 * live root IS derivable from argv, that implicit file is used — it is what the running
 * server reads, and a reachable server is authoritative about that. Without this step a
 * saved default workspace `A` that merely EXISTS would take a successful write while the
 * live server runs from `B` and reads `B/extra_model_paths.yaml`: the user is told
 * "Added … Restart ComfyUI" and the path is simply not there afterwards. The stale-root
 * existence gate cannot catch that — `A` is real, just not the one in use — so the fix
 * has to be resolving from the live server rather than warning about a divergence.
 * Skipped in remote mode (the live root is a path on the remote host).
 *
 * When argv names its script RELATIVELY and the server reports no cwd — `cd <root> &&
 * python main.py`, and ComfyUI Desktop / the Windows portable bundle's `ComfyUI\main.py`
 * — the argv derivation yields nothing absolute, and every branch below used to refuse a
 * local install that was sitting right there (#1621). That shape is resolved through
 * `resolveLiveServerRoot`'s observed-process tier instead: the same canonical live root
 * (#369) the DOWNLOAD DESTINATION is written into. See the call site for why that tier can
 * only ever add a resolution, never move one.
 *
 * Everything the live server contributes comes from ONE `/system_stats` snapshot, so the
 * launch flags and the install root can never be read from two different server states.
 * And when the server IS reachable but tells us nothing usable — a relative
 * `--extra-model-paths-config` with no reported cwd, or an argv with no `main.py` — the
 * answer is normally an explicit UNRESOLVED, never a quiet fall-through to the local
 * heuristic: a mutation would otherwise report success for a file the running server may
 * not read. `list_local_models action:"list_paths"` is deliberately narrower: when the connected target is
 * already classified LOCAL but its argv simply omits main.py, it may show the known local
 * auto target with an explicit non-authoritative note (#764). Mutations keep refusing that
 * state, so the fallback cannot fabricate a successful edit. `target`/`config_path` remain
 * the deliberate escape hatch, and both short-circuit above this.
 */
async function resolveTargetPathPreferServer(
  opts: ExtraPathOptions = {},
  allowUnprovenLocalListFallback = false,
): Promise<ResolvedTarget & { serverResolved: boolean }> {
  // Explicit config_path or an explicit non-auto target: honor the caller — and then
  // say so honestly when the running server reads somewhere else (#1788). The write
  // target is UNCHANGED by that check; only the reporting is.
  if (opts.configPath || (opts.target && opts.target !== "auto")) {
    return await notePinnedDivergence({ ...resolveTargetPath(opts), serverResolved: false });
  }

  const snapshot = await getLiveServerSnapshot(); // remote/unreachable → reachable:false
  if (!snapshot.reachable) {
    return { ...resolveTargetPath(opts), serverResolved: false };
  }

  // LOCALITY PROOF (codex round 9, P2b): when argv names a main.py that does NOT resolve
  // to a real file here, the server's filesystem is not ours (a container/WSL/remote host
  // behind a loopback port). Nothing derived from its argv — including an ABSOLUTE
  // --extra-model-paths-config, which could name a same-spelled path on OUR disk — may be
  // written to in that state. Proven once, for every argv-derived branch below: a main.py
  // present-but-unresolvable throws here; NO main.py at all leaves liveRoot undefined, and
  // every branch below refuses on that before touching an argv-derived path.
  const argvScript = liveScriptFromArgv(snapshot.argv, snapshot.cwd);
  // #1621: `cd <root> && python main.py` reports argv[0] as the RELATIVE string "main.py"
  // and current ComfyUI reports no cwd, so the server's own argv names NOTHING absolute —
  // the ordinary manual Linux/macOS launch, and (as `ComfyUI\main.py`) the shape ComfyUI
  // Desktop and the Windows portable bundle report too. The argv derivation above then
  // yields no script, every branch below refuses, and a LOCAL server sitting right there
  // was answered with UNRESOLVED — including for getExtraModelRoots(), which left model
  // discovery with no filesystem roots at all.
  //
  // `resolveLiveServerRoot` is the ONE canonical notion of the live install root (#369),
  // and its observed-process tier answers exactly this shape: the OS names the process
  // listening on our port (correlated against this same argv, so a proxy cannot
  // impersonate it) and the relative main.py dir is re-anchored on the install its
  // interpreter lives in. That resolver already decides where a DOWNLOADED MODEL is
  // written, so resolving the yaml that sits BESIDE those models through anything else is
  // how the two come to disagree about which install is "the live one".
  //
  // It can only ever ADD a resolution: `liveRootFromArgv` and `liveScriptFromArgv` share
  // scriptTokenFromArgv, so a script-less argv is a root-less one — the argv tier inside
  // `resolveLiveServerRoot` has already failed wherever this runs, and no path that
  // resolves today can be redirected by it. `remote:false` is settled, not assumed:
  // `getLiveServerSnapshot` only reports reachable in local mode.
  const observed = argvScript
    ? undefined
    : resolveLiveServerRoot(snapshot.argv, snapshot.cwd, { remote: false });
  // `anchorDir` is the working directory the server MUST have had for its relative
  // main.py to name that install, so feeding it back through the same parser yields the
  // absolute SCRIPT — which is what `realLiveRoot` needs to follow a symlinked main.py
  // the way ComfyUI's own os.path.realpath(__file__) does. No second parser is
  // introduced, and the root still has to prove itself on this filesystem below.
  const script =
    argvScript ??
    (observed?.source === "observed-process" && observed.anchorDir
      ? liveScriptFromArgv(snapshot.argv, observed.anchorDir)
      : undefined);
  // The REAL (symlink-resolved) install root, kept for every downstream use — notably the
  // "other configs" disclosure, which must name the file ComfyUI actually loads
  // (realpath(__file__) dir), not the launcher spelling (codex round 10).
  const rootResult: LiveRootResult = script ? realLiveRoot(script) : { why: "absent" };
  const liveRoot = rootResult.root;

  /** The relative `main.py` dir the server reported, when its argv named one relatively.
   *  Present exactly when "argv revealed no main.py" would be a FALSE account of why the
   *  script could not be resolved. */
  const relDir = liveRelDirFromArgv(snapshot.argv);

  /** Why locality is unproven, stated as what was OBSERVED. Reused by the refusals and
   *  by the read-only disclosures, so the two can never drift apart. */
  const localityGap = !script || rootResult.root !== undefined
    ? relDir === undefined
      ? "its /system_stats launch argv does not reveal a main.py at all"
      : `its /system_stats launch argv names its launch script RELATIVELY (${
          relDir === "." ? "a bare main.py" : `under "${relDir}"`
        }) and the server reports no working directory, so its argv names no absolute ` +
        "path, and the process listening on its port could not be anchored to an install " +
        "holding that script on this filesystem either"
    : rootResult.why === "indeterminate"
      ? `this process could not determine whether its launch script "${script}" is a file on ` +
        `this filesystem (the lookup failed with ${rootResult.detail ?? "an unknown error"}); ` +
        "that is NOT a finding that the path is absent — a permission or mount problem on an " +
        "intermediate directory looks exactly the same from here"
      : `its launch script "${script}" does not resolve to a file on this filesystem (it may ` +
        "never have been ours — a container, WSL, or another host behind a loopback port " +
        "spells its paths the same way — or it may have been moved or deleted since the " +
        "server started)";

  if (script && rootResult.root === undefined && !allowUnprovenLocalListFallback) {
    // A MUTATION still fails closed here: a config path derived from an unverified tree
    // could name a different file, and the edit would be a silent no-op or a write into a
    // stranger's config. A READ falls through instead, so the branches below can disclose
    // an unproven file rather than reject a reachable server outright (#764).
    //
    // The message states the observation and offers the topologies as possibilities. The
    // old wording asserted "the server is running in a container, WSL, or on another
    // host" from a bare ENOENT — one bucket, several causes, and it named one.
    throw new ValidationError(
      `UNRESOLVED: ${localityGap}, so the server's file tree is not proven to be this ` +
        "machine's. Its config paths would then name files on ITS disk, and a same-spelled " +
        "path here would be a different file, so the edit would be a silent no-op. Nothing " +
        "was read or written — pass config_path explicitly with a file you can reach, or " +
        'target: "standalone"/"desktop" to use the local heuristic deliberately.',
    );
  }

  // Show the caller's already-known LOCAL target, loudly marked as unproven. Read-only
  // callers get this instead of a refusal; mutations never reach it.
  const unprovenListFallback = (
    note: string,
  ): ResolvedTarget & { serverResolved: boolean } => {
    const fallback = resolveTargetPath(opts);
    return { ...fallback, notes: [...fallback.notes, note], serverResolved: false };
  };

  const rawFlags = parseExtraModelPathsConfigsFromArgvRaw(snapshot.argv);
  if (rawFlags.length === 0) {
    // No flag — ComfyUI loads the yaml next to its own main.py when that file exists.
    if (script && liveRoot) return implicitLiveTarget(liveRoot, opts);
    // getLiveServerSnapshot only returns reachable:true in local mode. Some supported
    // launchers use `python -m comfyui` (or otherwise omit main.py from sys.argv), so
    // there is no live-root proof even though the active API target is local and usable.
    // Listing the caller's already-known local target is useful and truthful as long as
    // the response plainly says it is NOT a claim about the running server. Do not share
    // this fallback with add/remove: an edit here could be a silent no-op (#764).
    if (allowUnprovenLocalListFallback) {
      return unprovenListFallback(
        // Built from `localityGap`, never from a hardcoded "argv does not reveal
        // main.py". Argv often DOES reveal one and the lookup failed (EACCES, a stalled
        // mount, or a script deleted since startup) — stating the missing-argv cause
        // there is a false cause in the caption, the same defect one level out.
        `NOTE: the connected ComfyUI is local and reachable, but ${localityGap}, so the config the running server reads cannot be proven. Showing the local auto-selected config instead; this is a fallback, not confirmation that the live server reads it. Pass config_path or target: "standalone"/"desktop" to choose a file explicitly.`,
      );
    }
    throw new ValidationError(
      "UNRESOLVED: the running ComfyUI was not launched with --extra-model-paths-config and " +
        // Built from `localityGap` for the same reason the read-only caption above is:
        // this arm is reached whenever the script could not be resolved, and hardcoding
        // "argv does not reveal a main.py" states a cause that is false for every
        // relative-argv launch (#1621) and for a lookup that merely failed.
        `${localityGap}, so the extra_model_paths.yaml it reads ` +
        "cannot be located. Nothing was read or written — the local heuristic would just be a " +
        'guess at a file this server may not read. Pass config_path explicitly, or target: ' +
        '"standalone"/"desktop" to use the local heuristic deliberately.',
    );
  }

  // ComfyUI resolves a launch flag with os.path.abspath, i.e. against the SERVER's cwd.
  // A relative value with no reported server cwd is UNRESOLVABLE from here: anchoring it
  // to this process's cwd/COMFYUI_PATH would target a same-named file in the wrong tree
  // (the same rule #346 applies to --output-directory and #633 to authorization).
  const resolveFlagPath = (raw: string): string | undefined =>
    isAbsolute(raw)
      ? resolve(raw)
      : snapshot.cwd && isAbsolute(snapshot.cwd)
        ? resolve(snapshot.cwd, raw)
        : undefined;

  const rawFlag = rawFlags[0];
  const serverConfig = resolveFlagPath(rawFlag);
  if (!serverConfig) {
    // The flagged file cannot be located — but ComfyUI ALSO loads
    // <its own root>/extra_model_paths.yaml whenever that file exists, IN ADDITION to
    // every --extra-model-paths-config, and creating it makes the next restart load it.
    // So that file is a destination this server provably reads. Target it (and say what
    // is missing) instead of refusing: `/system_stats` does not report cwd on current
    // ComfyUI, so a refusal here would break the ordinary
    // `cd /opt/ComfyUI && python main.py --extra-model-paths-config extra.yaml` launch
    // outright (codex round 8, P1). Only when NEITHER file can be located do we refuse.
    if (script && liveRoot) return implicitLiveTarget(liveRoot, opts, rawFlag);
    if (allowUnprovenLocalListFallback) {
      return unprovenListFallback(
        `NOTE: the connected ComfyUI is local and reachable, but it was launched with a RELATIVE --extra-model-paths-config ("${rawFlag}") and does not report its working directory, and ${localityGap} — so the file it actually reads cannot be located from this process. Showing the local auto-selected config instead; this is a fallback, not confirmation that the live server reads it. Pass config_path with the flag's absolute path to see the real one.`,
      );
    }
    throw new ValidationError(
      `UNRESOLVED: the running ComfyUI was launched with a RELATIVE --extra-model-paths-config ` +
        `("${rawFlag}") and reports neither its working directory nor a main.py, so no file it ` +
        "reads can be located from this process. Resolving the flag here would point at a " +
        "same-named file under this MCP's own directory and the edit would be a silent no-op. " +
        "Nothing was read or written — pass config_path explicitly with the absolute path the " +
        "server uses.",
    );
  }

  // FAIL CLOSED on unproven locality: `serverConfig` is a path on the SERVER's filesystem,
  // and only the locality proof above (its main.py resolving to a real file on THIS disk)
  // shows that filesystem is ours. Reachable but main.py-less argv — a container, WSL, or
  // remote host behind a loopback port spells paths on ITS disk the same way — leaves the
  // flag's ABSOLUTE value pointing at a same-spelled file here that is a DIFFERENT tree;
  // writing it would fabricate success and could corrupt that tree. Refuse instead.
  if (!liveRoot) {
    // #764 recurrence (0.49.4/0.49.5, macOS ComfyUI Desktop 2): the server NAMES an
    // absolute config that exists right here, and the tool refused to show it because a
    // DIFFERENT fact — the locality of its main.py — could not be established. "We could
    // not prove this file is the server's" was reported as "this file is not the
    // server's", and a reachable instance was rejected outright.
    //
    // The refusal is still exactly right for a WRITE: an unproven tree turns an edit
    // into a silent no-op or, worse, a write into a stranger's config. It is wrong for a
    // READ, which changes nothing and whose only failure mode is a caption. So the
    // read-only caller gets the file, plus an unmissable statement of what was not
    // proven; mutations fall through to the refusal below, unchanged.
    if (allowUnprovenLocalListFallback) {
      // Three distinct answers to "is the file the server named here?", kept distinct.
      // `existsSync` collapsed them: an EACCES on a parent directory came back false and
      // would have been narrated as "no such file exists on this machine — the server is
      // very likely elsewhere", which is a conclusion drawn from a failed look.
      const local = probeLocalFile(serverConfig);
      if (local.kind === "file") {
        return {
          target: looksLikeDesktopConfig(serverConfig) ? "desktop" : "standalone",
          path: serverConfig,
          // The note deliberately does NOT restate "and this file exists" or "its
          // entries were read". Selecting this path required one stat, and the read
          // takes another; between them the file can be deleted, and a note that had
          // asserted existence would then sit next to `exists: false` and an empty
          // group list, contradicting the very response it is part of. `exists` is the
          // field that answers that, from the read's own observation — the prose says
          // only what selecting the path established, which is where it came from.
          notes: [
            `Showing "${serverConfig}" — the --extra-model-paths-config the running ComfyUI reports in its own launch argv. See "exists" for whether a file is there now, and the groups below for what was read from it.`,
            `NOTE: NOT CONFIRMED to be the same file: ${localityGap}, so this process could not prove the server's file tree is this machine's. If the server is in a container, WSL, or on another host behind a loopback port, it spells its paths the same way and this would be a DIFFERENT file with the same name. Editing is refused in this state — pass config_path explicitly to edit deliberately.`,
          ],
          serverResolved: false,
          // Not proven ours: never create a tree here on the strength of a path the
          // server named.
          createParents: false,
        };
      }
      if (local.kind === "absent") {
        // Absent HERE, now. That is consistent with a container/WSL/other-host server,
        // and equally with a local server whose flagged YAML was deleted or renamed
        // after it started (ComfyUI read it at launch and would go on loading its
        // implicit <root>/extra_model_paths.yaml regardless). Naming one of those as the
        // cause would be the same fold this change exists to remove.
        return unprovenListFallback(
          `NOTE: the running ComfyUI reports --extra-model-paths-config "${serverConfig}", but no file exists at that path on this machine right now, and ${localityGap}. That is consistent with the server running on a different filesystem (a container, WSL, or another host behind a loopback port) AND with a local server whose config was moved or deleted after it started — this process cannot tell which. Showing the local auto-selected config instead; it is a fallback and is NOT confirmed to be a file the live server reads. Pass config_path explicitly to inspect a file you can reach.`,
        );
      }
      return unprovenListFallback(
        local.kind === "not-a-file"
          ? `NOTE: the running ComfyUI reports --extra-model-paths-config "${serverConfig}", and something exists at that path on this machine but it is not a file, so nothing was read from it. Showing the local auto-selected config instead; this is a fallback, and it is NOT confirmation of what the live server reads. Pass config_path explicitly to inspect a file you can reach.`
          : `NOTE: the running ComfyUI reports --extra-model-paths-config "${serverConfig}", and this process could not determine whether a file is there (the lookup failed with ${local.detail}) — that is NOT a report that it is missing. Showing the local auto-selected config instead; this is a fallback, and it is NOT the file the live server reads. Check the permissions on that path, or pass config_path explicitly with a file you can read.`,
      );
    }
    throw new ValidationError(
      `UNRESOLVED: the running ComfyUI reports --extra-model-paths-config "${serverConfig}" ` +
        `but ${localityGap}, so the server's file tree is not proven local — the path may ` +
        "name a file on ITS disk, and a same-spelled path here would be a different file. " +
        "Nothing was read or written — pass config_path explicitly with a file you can " +
        'reach, or target: "standalone"/"desktop" to use the local heuristic deliberately.',
    );
  }

  const notes = [
    `Resolved from the running ComfyUI's --extra-model-paths-config launch flag (the file the live server actually reads): ${serverConfig}`,
  ];
  // This tool reports ONE file, but ComfyUI aggregates every --extra-model-paths-config
  // it was given PLUS <its root>/extra_model_paths.yaml when that exists. Naming the
  // others keeps the result from reading as "all the server's extra paths" when it is one
  // of several (codex round 9, P2a). Every name here is RESOLVED the same way the primary
  // one is — the realpath'd install root, and remaining flags run through the server-cwd
  // rule — because the note tells the user to pass these to config_path, so a wrong name
  // would itself become a wrong-destination write (codex round 10, P1).
  const alsoLoaded: string[] = [];
  const unlocatable: string[] = [];
  for (const raw of rawFlags.slice(1)) {
    const resolved = resolveFlagPath(raw);
    if (resolved) alsoLoaded.push(resolved);
    else unlocatable.push(raw);
  }
  const implicitConfig = liveRoot ? join(liveRoot, "extra_model_paths.yaml") : undefined;
  if (implicitConfig && implicitConfig !== serverConfig && existsSync(implicitConfig)) {
    alsoLoaded.push(implicitConfig);
  }
  if (alsoLoaded.length > 0) {
    notes.push(
      `NOTE: this is ONE of several configs the running ComfyUI loads — it also reads ${alsoLoaded.join(", ")}. Those entries are not listed here; pass config_path to view or edit each one.`,
    );
  }
  if (unlocatable.length > 0) {
    notes.push(
      `NOTE: this server was also launched with RELATIVE --extra-model-paths-config value(s) (${unlocatable.map((v) => `"${v}"`).join(", ")}) and does not report its working directory, so those files resolve against the SERVER's own working directory and cannot be located from this process. They are not listed, and the raw values above are not usable as config_path — supply their absolute paths instead.`,
    );
  }
  // The static guess is only for a divergence diagnostic — never let it (e.g. a
  // missing COMFYUI_PATH for the standalone fallback) break the real resolution.
  try {
    const staticGuess = resolveTargetPath(opts);
    if (resolve(staticGuess.path) !== resolve(serverConfig)) {
      notes.push(
        `NOTE: this differs from the path the static heuristic would have used (${staticGuess.path}). Editing that other file would be a silent no-op — the running server does not read it.`,
      );
    }
  } catch {
    // No static guess available — the server-resolved path stands on its own.
  }
  // The COMPARISON set for the #1788 divergence disclosure — deliberately NOT the
  // `alsoLoaded` display list. Two differences, both load-bearing:
  //   • the implicit `<root>/extra_model_paths.yaml` is included even when it does not
  //     exist yet. Pinning it is how a user CREATES it, and the next restart then loads
  //     it — calling that edit inert would be exactly backwards.
  //   • `unlocatable` relative flags make the set INCOMPLETE, so a pinned path's absence
  //     proves nothing and no divergence may be claimed.
  const liveLoadedPaths = [serverConfig, ...alsoLoaded];
  if (implicitConfig && !liveLoadedPaths.some((p) => sameConfigFile(p, implicitConfig))) {
    liveLoadedPaths.push(implicitConfig);
  }
  const isDesktop = looksLikeDesktopConfig(serverConfig);
  if (isDesktopGeneratedConfig(serverConfig)) {
    notes.push(
      "WARNING: this file is auto-generated by ComfyUI Desktop ('do not edit manually') and will be overwritten by the Desktop app. For a durable model path, place or symlink the models under the server's --base-directory models dir instead of editing this YAML.",
    );
  }
  return {
    target: isDesktop ? "desktop" : "standalone",
    path: serverConfig,
    notes,
    serverResolved: true,
    // The live server told us this file, so its directory exists by construction.
    createParents: true,
    liveLoaded: { paths: liveLoadedPaths, complete: unlocatable.length === 0 },
  };
}

/**
 * #1788 — a PINNED target (`target: "desktop"` / `"standalone"` / an explicit
 * `config_path`) deliberately bypasses the live resolution above: it is the documented
 * escape hatch, and it must keep writing exactly where the caller said.
 *
 * What it must NOT keep doing is reporting that edit as though the running server will
 * pick it up. The reporter called `list_local_models action:"add_path" target:"desktop"`
 * on ComfyUI Desktop; the static heuristic wrote
 * `%APPDATA%/ComfyUI/extra_models_config.yaml` and answered "Added … Restart ComfyUI to
 * apply it", while the very same tool's `action:"list_paths"` had already reported the
 * DIFFERENT file the running server was launched with. Two code paths, one question,
 * two answers — and only the one that was right said so. Every live-anchored branch
 * above pushes a divergence note when the STATIC guess would have differed; the pinned
 * branch, which is the direction that actually loses data, pushed none.
 *
 * So: still write where the caller pinned, but ASK the same canonical resolver what the
 * running server reads and disclose the divergence. Deliberately conservative — it can
 * only ever ADD a note:
 *   • the resolver is re-entered with NO pin, so this is the ONE canonical live
 *     resolution, not a second copy of it that could drift (one level of recursion only:
 *     `{}` cannot re-enter this branch);
 *   • anything short of `serverResolved` proof — unreachable, remote, an unproven tree,
 *     the #764 display fallbacks — yields NO note. Silence is the honest answer to "we
 *     could not establish what the server reads";
 *   • an INCOMPLETE loaded set yields no note either (see LiveLoadedConfigs);
 *   • a pinned path that IS one of the server's configs yields no note — a caller
 *     pinning the second `--extra-model-paths-config` file is editing a live one.
 */
async function notePinnedDivergence(
  pinned: ResolvedTarget & { serverResolved: boolean },
): Promise<ResolvedTarget & { serverResolved: boolean }> {
  // Reachability is checked FIRST, before any resolution work. Without a reachable
  // local server no note is possible, and the full resolution is not free: it stats the
  // caller's own guarded root, and that root's TOCTOU revalidation counts every stat it
  // takes (#648). Burning one there to learn nothing would turn a stable root into a
  // spurious "REPLACED while this call was running" refusal.
  //
  // This is a second /system_stats read, and it is deliberately only a GATE — the inner
  // resolution takes its own authoritative snapshot. A server that stops or starts
  // between the two can therefore only ever SUPPRESS the note (gate says unreachable, or
  // the inner call finds nothing proven); it can never manufacture one from a state the
  // resolver did not itself observe.
  if (!(await getLiveServerSnapshot()).reachable) return pinned;
  let live: (ResolvedTarget & { serverResolved: boolean }) | undefined;
  try {
    live = await resolveTargetPathPreferServer({});
  } catch {
    return pinned; // the server established nothing — the pin is all there is
  }
  // `liveLoaded` IS the proof of anchoring: only the two server-anchored branches
  // produce it (see its declaration), and it is the predicate this decision actually
  // needs — the complete set of files the running server reads. An additional
  // `serverResolved` check beside it was redundant by construction: a mutation deleting
  // it killed zero tests, because no input can make the two disagree. An untestable
  // guard is not defence in depth, it is an unpinned claim, so the invariant lives on
  // the field's contract where a future branch has to read it.
  const loaded = live.liveLoaded;
  if (!loaded?.complete) return pinned;
  if (loaded.paths.some((p) => sameConfigFile(p, pinned.path))) return pinned;
  return {
    ...pinned,
    notes: [
      ...pinned.notes,
      `WARNING: the RUNNING ComfyUI does not read this file. You pinned it explicitly ` +
        `(target/config_path), so it was selected by the local heuristic, not from the ` +
        `server; the connected server reports it loads ${loaded.paths.join(", ")}. An ` +
        `edit here does NOT reach the running server — restarting will not apply it. ` +
        `Omit target/config_path to act on the config the running server actually reads, ` +
        `or pass config_path with one of the paths above.`,
    ],
    divergesFromLive: { serverPaths: loaded.paths },
  };
}

/** Read one config for presentation or model discovery. `allowUnprovenLocalListFallback`
 * must stay false for every caller that uses roots to resolve, delete, or otherwise act
 * on a model: the #764 fallback is useful display only, not evidence that ComfyUI loads
 * those directories. */
async function readExtraPathsConfig(
  opts: ExtraPathOptions = {},
  allowUnprovenLocalListFallback = false,
): Promise<ExtraPathsConfigInfo> {
  const resolved = await resolveTargetPathPreferServer(opts, allowUnprovenLocalListFallback);
  // Point of use: an inferred root that vanished between resolution and this read must
  // surface as UNRESOLVED, NOT as a normal empty config (readConfigFile maps a missing
  // file to {}, which would look authoritative — the exact failure #648 is about).
  assertRootIntact(resolved.guard);
  const { raw, exists } = await readConfigFile(resolved.path);
  assertRootIntact(resolved.guard);
  return summarize(
    resolved.target,
    resolved.path,
    raw,
    resolved.notes,
    resolved.serverResolved,
    exists,
    resolved.divergesFromLive,
  );
}

export async function listExtraPaths(
  opts: ExtraPathOptions = {},
): Promise<ExtraPathsConfigInfo> {
  // #764: a display-only read may fall back when a reachable LOCAL server omits main.py
  // from argv. Model discovery and mutations use the normal fail-closed resolver.
  return readExtraPathsConfig(opts, true);
}

/** One model search directory contributed by extra_model_paths configuration. */
export interface ExtraModelRoot {
  /** The ComfyUI category key (e.g. "checkpoints", "loras") the dir serves. */
  category: string;
  /** Absolute directory on disk that ComfyUI loads this category's models from. */
  dir: string;
  /** The owning config group name (for diagnostics). */
  group: string;
}

/**
 * Enumerate every model directory declared in the active extra_model_paths /
 * extra_models_config file — i.e. the same extra roots (often on other drives
 * like E:\) that ComfyUI itself loads models from. Each entry pairs a category
 * key with the absolute directory that serves it (paths are resolved against the
 * group's base_path when relative). Returns [] when no config exists or no local
 * ComfyUI path is known. Best-effort: never throws (a malformed/unreadable
 * config yields []), so callers can treat extra roots as an additive search set.
 */
export async function getExtraModelRoots(
  opts: ExtraPathOptions = {},
): Promise<ExtraModelRoot[]> {
  let info: ExtraPathsConfigInfo;
  try {
    // Do NOT use listExtraPaths here: its #764 local fallback is deliberately
    // non-authoritative and these roots feed model lookup/removal. An unproven config
    // must contribute no roots rather than allowing a stale path to resolve a model.
    info = await readExtraPathsConfig(opts);
  } catch {
    return [];
  }
  const roots: ExtraModelRoot[] = [];
  for (const group of info.groups) {
    const base = group.base_path?.trim();
    for (const category of group.categories) {
      for (const p of category.paths) {
        const dir = isAbsolute(p)
          ? resolve(p)
          : base
            ? resolve(base, p)
            : resolve(p);
        roots.push({ category: category.category, dir, group: group.name });
      }
    }
  }
  return roots;
}

/**
 * The extra model roots the LIVE, running ComfyUI ACTUALLY registers — for the ONE
 * purpose of AUTHORIZING a write into a symlinked download destination that escapes
 * the primary models dir (#633). Authorization must be fail-closed and anchored to
 * the running server, NEVER a stale/static local config the server does not load
 * (codex P0d): a config the server no longer reads must not authorize an escaping
 * symlink, and an unreachable server must authorize nothing.
 *
 * Takes the SINGLE live `/system_stats` snapshot the caller already used to resolve
 * the models/base dirs — NOT its own stats call — so authorization roots can never
 * come from a different server state than the code-root veto (codex inter-snapshot
 * race). Trusted sources, all from that snapshot, so a stale local COMFYUI_PATH /
 * default-workspace config can never authorize an escape:
 *   - every ABSOLUTE `--extra-model-paths-config` file the server was LAUNCHED with
 *     (raw argv values; a RELATIVE flag value is SKIPPED — it can't be resolved to
 *     the live server's file from the MCP process, so trusting it would let a stale
 *     local same-named config authorize; fail closed); and
 *   - `<live main.py root>/extra_model_paths.yaml` — ComfyUI's auto-loaded default,
 *     anchored to the server's OWN install root (its main.py dir from argv), NOT an
 *     arbitrary base dir or the local workspace.
 *
 * Relative `base_path` / category paths are resolved against the CONFIG FILE's own
 * directory, exactly as ComfyUI resolves them — never against the MCP process CWD —
 * so a same-named/relative config in a stale workspace cannot misattribute a root.
 *
 * Returns `authoritative: false` (and no roots) whenever the server was unreachable,
 * so the caller REFUSES every escaping symlink rather than authorize from a guess.
 *
 * `authoritative` says the roots LISTED can be trusted — it does NOT say they are all
 * the roots this server has. Several paths deliberately drop roots and still return
 * authoritative: a relative `--extra-model-paths-config` we cannot locate, a config
 * that is unreadable or was deleted after the server loaded it, and a group whose
 * `base_path` needs an env var belonging to a separately-launched server. So a caller
 * must NEVER reason from a root's ABSENCE here ("the server registers nothing that
 * could hold these models") — doing that refused a legitimate external-drive install
 * outright (#369). Absence of a root is not evidence; if a future caller genuinely
 * needs that inference it has to be built and TESTED alongside its consumer.
 * Never throws.
 */
export async function getLiveExtraModelRoots(
  snapshot: LiveServerSnapshot,
): Promise<{ authoritative: boolean; roots: ExtraModelRoot[] }> {
  if (!snapshot?.reachable) return { authoritative: false, roots: [] };
  const argv = snapshot.argv;
  const configPaths = new Set<string>();
  // Launched flag files — ABSOLUTE values only (relative → fail closed, see docblock).
  for (const raw of parseExtraModelPathsConfigsFromArgvRaw(argv)) {
    if (isAbsolute(raw)) configPaths.add(resolve(raw));
  }
  // Auto-loaded default in the LIVE install root (its main.py dir). Skip in remote
  // mode: the live root is a path on the remote host.
  if (!isRemoteMode()) {
    // Prefer the root the caller already established through the ONE canonical
    // resolver (OS-observed when argv is a relative `main.py` with no cwd). That is
    // strictly stronger provenance than re-deriving it from argv here, and without
    // it a portable/Desktop install's auto-loaded config is never found at all —
    // which made a legitimate external model root look like "no extra roots"
    // (codex gate, round 12). Falls back to the argv derivation.
    const liveRoot = snapshot.liveRoot ?? liveRootFromArgv(argv, snapshot.cwd);
    if (liveRoot) configPaths.add(resolve(liveRoot, "extra_model_paths.yaml"));
  }

  // Whether it is safe to expand a config `$VAR`/`%VAR%` against process.env: ONLY a
  // LOCAL server THIS MCP launched (which inherited our env) shares our environment;
  // a separately-launched/remote server may have a different env, so its config vars
  // must NOT be resolved against ours (#633 P1b).
  const trustServerEnv = !isRemoteMode() && didLaunchLocalComfyUI();

  const roots: ExtraModelRoot[] = [];
  for (const cfg of configPaths) {
    // A config that is gone (never existed, or deleted since the server loaded it)
    // contributes no roots here — but the RUNNING process may still hold the roots it
    // gave at startup. That is why no caller may treat this result as the complete
    // set; see the docblock.
    if (!existsSync(cfg)) continue;
    let raw: Record<string, unknown>;
    try {
      // ACCEPTED (intentional, not a defect — maintainer ruling): this reads the config's
      // CURRENT contents at download time, which may include a root the USER added AFTER
      // ComfyUI started but before restarting it. Authorizing a download to a root the
      // user just configured on their OWN machine is the desired behavior ("downloads go
      // where the user wants"); it becomes visible to ComfyUI on its next restart.
      raw = parseConfig(await readFile(cfg, "utf-8"));
    } catch {
      continue; // unreadable/malformed — skip; never authorize from a bad file
    }
    // Match ComfyUI: relative entries resolve against the YAML file's OWN directory.
    const cfgDir = dirname(resolve(cfg));
    for (const [name, value] of Object.entries(raw)) {
      const group = readGroup(value, name);
      if (!group) continue;
      // ComfyUI expands `~`/env vars in base_path (expanduser THEN expandvars) BEFORE
      // classifying absolute vs relative (utils/extra_config.py), so `base_path: ~/models`
      // registers the real $HOME root (and a legit symlink into it is authorized). A
      // base_path needing an env var we can't resolve against the server's env is
      // UNRESOLVABLE → drop the whole group (fail-closed). Category subpath entries are
      // left LITERAL, exactly as ComfyUI leaves them (#633 P1a/P1b).
      let base: string | undefined;
      if (group.base_path) {
        const expanded = expandLiveBasePath(group.base_path.trim(), trustServerEnv);
        if (expanded === undefined) continue; // unresolvable base_path → skip this group
        base = isAbsolute(expanded) ? resolve(expanded) : resolve(cfgDir, expanded);
      }
      for (const category of group.categories) {
        for (const p of category.paths) {
          // With a base_path, EVERY entry is os.path.join'd to it (incl. the Windows
          // drive-relative case) — never treated independently just because it looks
          // absolute. Only with NO base_path is an absolute entry used on its own.
          const dir = base
            ? joinCategoryEntryToBase(base, p)
            : isAbsolute(p)
              ? resolve(p)
              : resolve(cfgDir, p);
          roots.push({ category: category.category, dir, group: name });
        }
      }
    }
  }
  return { authoritative: true, roots };
}

function ensureGroup(raw: Record<string, unknown>, name: string): Record<string, unknown> {
  const existing = raw[name];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const group: Record<string, unknown> = {};
  raw[name] = group;
  return group;
}

async function writeConfigFile(
  path: string,
  raw: Record<string, unknown>,
  createParents: boolean,
  guard?: GuardedRoot,
): Promise<void> {
  // Last check before the bytes land: the guarded root must still be the SAME existing
  // directory this call resolved (deleted → UNRESOLVED; replaced → UNRESOLVED).
  assertRootIntact(guard);
  // With createParents=false the root was already verified to exist, so skipping the
  // `mkdir -p` costs nothing in the normal case and turns the check→write race into an
  // honest ENOENT instead of silently RESURRECTING a vanished install and writing there.
  if (createParents) await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyYaml(raw, { lineWidth: 0 }), "utf-8");
}

/**
 * What a mutation's headline `message` must say when the file was PINNED and the running
 * server provably reads elsewhere (#1788). Built from the STRUCTURED `divergesFromLive`
 * field, never from re-reading a note: "Restart ComfyUI to apply it" is a promise about
 * an effect, and it was being made for a file no running ComfyUI reads.
 */
function inertEditSuffix(resolved: ResolvedTarget): string {
  const d = resolved.divergesFromLive;
  if (!d) return "";
  return (
    ` WARNING: the running ComfyUI does NOT read ${resolved.path} — it loads ` +
    `${d.serverPaths.join(", ")}. Restarting will NOT apply this change; you pinned this ` +
    `file with target/config_path. Omit those to edit the config the running server reads.`
  );
}

export async function addExtraPath(
  opts: ExtraPathMutationOptions,
): Promise<ExtraPathMutationResult> {
  const resolved = await resolveTargetPathPreferServer(opts);
  const groupName = assertSafeKey(opts.group ?? "comfyui_mcp", "Group");
  const category = assertSafeKey(opts.category, "Category");
  const nextPath = assertPathValue(opts.path);
  if (RESERVED_KEYS.has(category)) {
    throw new ValidationError(`"${category}" is a reserved config key, not a path category.`);
  }

  assertRootIntact(resolved.guard);
  const { raw, exists: existedBefore } = await readConfigFile(resolved.path);
  // The no-op path ("already present") returns data from THIS read, so a root REPLACED
  // during it must fail here too — not only when a write follows (#648 review).
  assertRootIntact(resolved.guard);
  const group = ensureGroup(raw, groupName);
  if (opts.isDefault !== undefined && group.is_default === undefined) {
    group.is_default = opts.isDefault;
  }

  const paths = splitPaths(group[category]);
  const changed = !paths.includes(nextPath);
  if (changed) {
    paths.push(nextPath);
    group[category] = paths.join("\n");
    await writeConfigFile(resolved.path, raw, resolved.createParents, resolved.guard);
  }
  // A completed write is itself the observation that the file is there now.
  const info = summarize(
    resolved.target,
    resolved.path,
    raw,
    resolved.notes,
    resolved.serverResolved,
    existedBefore || changed,
    resolved.divergesFromLive,
  );
  const inert = inertEditSuffix(resolved);
  return {
    ...info,
    changed,
    message:
      (changed
        ? inert
          ? `Added ${nextPath} to ${groupName}.${category}.`
          : `Added ${nextPath} to ${groupName}.${category}. Restart ComfyUI to apply it.`
        : `${nextPath} is already present in ${groupName}.${category}.`) + inert,
  };
}

export async function removeExtraPath(
  opts: ExtraPathMutationOptions,
): Promise<ExtraPathMutationResult> {
  const resolved = await resolveTargetPathPreferServer(opts);
  const groupName = assertSafeKey(opts.group ?? "comfyui_mcp", "Group");
  const category = assertSafeKey(opts.category, "Category");
  const removePath = assertPathValue(opts.path);

  assertRootIntact(resolved.guard);
  const { raw, exists: existedBefore } = await readConfigFile(resolved.path);
  // Same post-read gate as add: a no-op "was not present" built from a root REPLACED
  // during the read would report the PRIOR tree's data as current (#648 review).
  assertRootIntact(resolved.guard);
  const group = raw[groupName];
  let changed = false;
  if (group && typeof group === "object" && !Array.isArray(group)) {
    const obj = group as Record<string, unknown>;
    const remaining = splitPaths(obj[category]).filter((p) => p !== removePath);
    changed = remaining.length !== splitPaths(obj[category]).length;
    if (changed) {
      if (remaining.length > 0) obj[category] = remaining.join("\n");
      else delete obj[category];
      await writeConfigFile(resolved.path, raw, resolved.createParents, resolved.guard);
    }
  }
  const info = summarize(
    resolved.target,
    resolved.path,
    raw,
    resolved.notes,
    resolved.serverResolved,
    existedBefore || changed,
    resolved.divergesFromLive,
  );
  const inert = inertEditSuffix(resolved);
  return {
    ...info,
    changed,
    message:
      (changed
        ? inert
          ? `Removed ${removePath} from ${groupName}.${category}.`
          : `Removed ${removePath} from ${groupName}.${category}. Restart ComfyUI to apply it.`
        : `${removePath} was not present in ${groupName}.${category}.`) + inert,
  };
}
