/**
 * The ENVIRONMENT a restart must relaunch ComfyUI into (#776).
 *
 * `restart_comfyui` reconstructs the launch COMMAND (interpreter + argv) from the
 * running server's `/system_stats`, but until this module existed it never
 * reconstructed the launch ENVIRONMENT: `spawn()` with no `env` option inherits
 * the ORCHESTRATOR's `process.env`, which is a DIFFERENT environment from the one
 * a third-party launcher gave the server.
 *
 * That is exactly what broke #776. Stability Matrix does not put its bundled
 * tools on the system PATH — it injects them into the child it launches:
 *   • `<Data>/PortableGit/cmd`      → GitPython finds `git` (ComfyUI-Manager
 *                                     aborts with "Bad git executable" without it)
 *   • `<Data>/Assets/ffmpeg[/bin]`  → nodes that shell out to ffmpeg/ffprobe
 * Relaunching the same venv + argv WITHOUT those PATH entries produced an import
 * failure at startup, ComfyUI never answered `/system_stats`, and the restart left
 * the user's server DOWN.
 *
 * The rules here, hardest evidence first:
 *   1. LIVE PROCESS — on Linux we can read the running server's real environment
 *      (`/proc/<pid>/environ`) while it is still alive. That is the launch
 *      environment, verbatim, whatever launcher produced it. Use it.
 *   2. STABILITY MATRIX — a Stability Matrix-managed install is recognizable from
 *      its on-disk shape (`<Data>/Packages/<pkg>/…` beside `<Data>/PortableGit`
 *      and `<Data>/Assets`). Its injected environment is small, documented and
 *      VERIFIABLE on disk, so we reconstruct exactly those two PATH entries plus
 *      GIT_PYTHON_GIT_EXECUTABLE — the same recovery launch the #776 reporter
 *      verified by hand — and say so in the tool result.
 *   3. AN OPAQUE LAUNCHER — a launcher we can recognize but whose environment we
 *      canNOT reproduce (Pinokio builds it from a per-app script). We do NOT
 *      guess: the caller REFUSES *before stopping anything*, because a refusal is
 *      always better than a stop we cannot undo.
 *   4. PLAIN INSTALL — no launcher marker at all (a terminal / .bat / venv
 *      launch). Inheriting our environment is the long-standing behavior and the
 *      one these installs were already restarted with successfully; nothing is
 *      known to be missing, so nothing is reconstructed.
 *
 * Everything here is filesystem-evidence based: no shape is ever ASSUMED, and a
 * marker that cannot be corroborated on disk downgrades to a refusal, never to a
 * guess.
 */

import { readFileSync, statSync } from "node:fs";
// NOTE: readFileSync is used both for `/proc/<pid>/environ` and for the launcher's
// own config file (launcherConfigMentions).
import { delimiter } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where the relaunch environment came from — reported to the caller. */
export type LaunchEnvSource =
  /** Read from the LIVE process while it was still running (Linux /proc). */
  | "live-process"
  /** Reconstructed from a Stability Matrix install detected on disk. */
  | "stability-matrix"
  /** No launcher marker — the child inherits this process's environment. */
  | "inherited";

/** The launch-environment facts surfaced in the start/restart tool result. */
export interface LaunchEnvInfo {
  source: LaunchEnvSource;
  /** One-line human summary, safe to append to a tool message. */
  note: string;
  /**
   * FALSE when the server's real launch environment is known to be
   * launcher-owned and could NOT be rebuilt — the relaunch would be degraded.
   * The pre-stop preflight turns this into a refusal; a server that is ALREADY
   * down only gets a warning (see `reason`/`advice`).
   */
  reproducible: boolean;
  /** Directories prepended to PATH (empty/absent when nothing was injected). */
  path_additions?: string[];
  /**
   * Launcher components this install provably does NOT have, so nothing was
   * injected for them. Named so a later "ffmpeg not found" from a node is
   * traceable to a missing asset rather than to the restart.
   */
  not_installed?: string[];
  /** The recognized launcher, when one was recognized. */
  launcher?: string;
}

export interface LaunchEnvResolution {
  /** Mirrors `info.reproducible` — the single gate the callers branch on. */
  reproducible: boolean;
  /**
   * The environment to hand to `spawn()`. `undefined` means "pass no `env`
   * option" — i.e. inherit this process's environment verbatim, unchanged from
   * the behavior that predates #776. Always `undefined` when
   * `reproducible` is false: we never fabricate a launcher environment.
   */
  env?: NodeJS.ProcessEnv;
  info: LaunchEnvInfo;
  /** Set only when NOT reproducible: why the environment cannot be rebuilt. */
  reason?: string;
  /** Set only when NOT reproducible: what the user should do instead. */
  advice?: string;
}

export interface StabilityMatrixLayout {
  /** The Stability Matrix `Data` root (parent of `Packages`). */
  dataRoot: string;
  /** `<Data>/PortableGit/cmd` (or `/bin`) — absent when not on disk. */
  gitDir?: string;
  /** The git binary inside `gitDir` — absent when not on disk. */
  gitExe?: string;
  /** `<Data>/Assets/ffmpeg[/bin]` — absent when not on disk. */
  ffmpegDir?: string;
  /**
   * Per-component evidence, which decides REFUSE vs PROCEED-WITHOUT (see
   * `componentVerdict`). "resolved" = we can inject it; "ambiguous" = something
   * says this install has it but we cannot point at it; "not-installed" = no
   * trace of it anywhere, so the launcher cannot be injecting it either.
   */
  git: ComponentEvidence;
  ffmpeg: ComponentEvidence;
}

export type ComponentEvidence = "resolved" | "ambiguous" | "not-installed";

// ---------------------------------------------------------------------------
// Separator-agnostic path helpers
//
// The paths we inspect come from the running ComfyUI's sys.argv, which is
// WINDOWS-flavored whenever ComfyUI runs on Windows — regardless of the host this
// orchestrator process runs on. node:path would mangle `C:\…` on POSIX, so parse
// with an explicit both-separators split and re-join with the separator the input
// itself used (the same approach resolveLaunchCommand already takes).
// ---------------------------------------------------------------------------

function separatorOf(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

function segmentsOf(p: string): string[] {
  return p.split(/[\\/]/);
}

function basenameOf(p: string): string {
  const segs = segmentsOf(p).filter((s) => s !== "");
  return segs.length > 0 ? segs[segs.length - 1] : p;
}

/**
 * Ancestor directories of `p`, NEAREST first. The filesystem root itself is
 * skipped (nothing useful is ever detected there).
 */
function ancestorsOf(p: string): string[] {
  const sep = separatorOf(p);
  const segs = segmentsOf(p);
  const out: string[] = [];
  for (let i = segs.length - 1; i >= 1; i--) {
    const joined = segs.slice(0, i).join(sep);
    if (joined === "") continue; // POSIX root — nothing to detect there
    out.push(joined);
  }
  return out;
}

function joinPath(base: string, ...parts: string[]): string {
  const sep = separatorOf(base);
  return [base.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

/**
 * Does this path exist? THREE answers, because `existsSync` only has two and
 * spends the wrong one: it returns FALSE for a path it cannot access, so an
 * ACL-unreadable `Data/PortableGit` looked exactly like "this install has no
 * PortableGit". Detection then fell through to the plain-install plan and the
 * relaunch dropped the launcher environment — the #776 failure itself, reached
 * through the fix for it (codex gate P1-e).
 */
type DirProbe = "present" | "absent" | "inaccessible";

function probePath(p: string): DirProbe {
  try {
    statSync(p);
    return "present";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Only these mean "there is nothing here". EACCES/EPERM/ELOOP/EIO and an
    // unset code all mean "we could not look".
    if (code === "ENOENT" || code === "ENOTDIR") return "absent";
    return "inaccessible";
  }
}

/** Convenience for the places where only "definitely there" matters. */
function pathExists(p: string): boolean {
  return probePath(p) === "present";
}

function firstExisting(candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (pathExists(c)) return c;
  }
  return undefined;
}

/** The directory holding `p` (its nearest ancestor). */
function dirOf(p: string): string | undefined {
  return ancestorsOf(p)[0];
}

// ---------------------------------------------------------------------------
// Stability Matrix detection
// ---------------------------------------------------------------------------

/**
 * Recognize a Stability Matrix-managed install from the paths involved in the
 * relaunch (script, interpreter, cwd, raw argv[0]).
 *
 * Stability Matrix keeps every package under `<Data>/Packages/<PackageName>` and
 * its shared tooling as siblings of `Packages` (`<Data>/PortableGit`,
 * `<Data>/Assets`). So: find an ancestor literally named `Packages` whose parent
 * ACTUALLY HOLDS one of those tooling directories on disk.
 *
 * The tooling directory is REQUIRED corroboration, never inferred from a name: a
 * perfectly ordinary install that happens to live under some `…/Data/Packages/…`
 * path must NOT be mistaken for a Stability Matrix one, because that
 * misclassification would refuse a restart that works today.
 */
/**
 * Does the launcher's OWN configuration mention this component?
 *
 * The tie-breaker for "the component's directory is not on disk". That can mean
 * the user never installed it — in which case the launcher injects nothing and we
 * lose nothing by proceeding — or that it lives somewhere we do not know to look,
 * in which case proceeding drops it. Stability Matrix records what it manages in
 * `<Data>/settings.json`, so a mention there turns "absent" into "absent but
 * expected", which is the ambiguous case that must refuse. Unreadable/missing
 * config reads as "not mentioned": we never manufacture ambiguity.
 */
function launcherConfigMentions(
  dataRoot: string,
  needle: string,
): "mentions" | "absent" | "unreadable" {
  let sawUnreadable = false;
  for (const name of ["settings.json", "settings.jsonc"]) {
    const path = joinPath(dataRoot, name);
    // MISSING and UNREADABLE are NOT the same answer. Folding them together is how
    // a momentarily unreadable config would let a component be declared
    // "not installed", the restart proceed without it, and ComfyUI-Manager abort at
    // import — the original down-server bug, reached through the very rule meant to
    // stop over-refusing.
    //
    // Which is why there is NO `existsSync` pre-screen here: `existsSync` answers
    // FALSE for a path it cannot access, collapsing the two states before they can
    // be told apart. Attempt the read and classify from the FAILURE MODE instead —
    // only ENOENT/ENOTDIR mean "not there"; everything else means "could not look"
    // (codex gate).
    try {
      const raw = readFileSync(path, "utf-8");
      // Config files here are a few KB; cap the scan so a pathological file
      // cannot cost anything meaningful.
      if (raw.slice(0, 512 * 1024).toLowerCase().includes(needle)) return "mentions";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      // EACCES, EPERM, EISDIR, EBUSY, an unset code — all "we cannot look".
      sawUnreadable = true;
    }
  }
  return sawUnreadable ? "unreadable" : "absent";
}

function componentEvidence(
  resolved: boolean,
  rootProbe: DirProbe,
  dataRoot: string,
  configNeedle: string,
): ComponentEvidence {
  if (resolved) return "resolved";
  // PRESENT: it is there but we could not point at the binary. INACCESSIBLE: we
  // could not look at all. Both mean "this component may well be injected and we
  // would silently drop it" — the ambiguous case.
  if (rootProbe !== "absent") return "ambiguous";
  // "not-installed" requires BOTH halves of the evidence: the directory absent AND
  // the launcher's own config silent about it. An unreadable config is neither, so
  // it stays ambiguous.
  return launcherConfigMentions(dataRoot, configNeedle) === "absent"
    ? "not-installed"
    : "ambiguous";
}

export function detectStabilityMatrix(
  paths: ReadonlyArray<string | undefined>,
): StabilityMatrixLayout | null {
  for (const p of paths) {
    if (!p) continue;
    for (const ancestor of ancestorsOf(p)) {
      if (basenameOf(ancestor).toLowerCase() !== "packages") continue;
      const dataRoot = dirOf(ancestor);
      if (!dataRoot) continue;
      const gitRoot = joinPath(dataRoot, "PortableGit");
      const assetsRoot = joinPath(dataRoot, "Assets");
      const ffmpegRoot = joinPath(assetsRoot, "ffmpeg");
      const gitRootProbe = probePath(gitRoot);
      const assetsRootProbe = probePath(assetsRoot);
      const ffmpegRootProbe = probePath(ffmpegRoot);
      const hasGitRoot = gitRootProbe === "present";
      const hasFfmpegRoot = ffmpegRootProbe === "present";
      // Corroboration must be POSITIVE: at least one piece of Stability Matrix
      // tooling actually PRESENT beside `Packages`. `PortableGit` OR the `Assets`
      // STORE — not `Assets/ffmpeg` specifically, since a real layout can have the
      // store without that subdirectory.
      //
      // An INACCESSIBLE sibling is deliberately not corroboration. Treating it as
      // such made a plain install at `C:\Work\Data\Packages\ComfyUI` refuse to
      // restart at all merely because an unrelated `C:\Work\Data\Assets` was
      // ACL-denied — unreadable evidence proving the OTHER shape, which is the same
      // fold in the opposite direction. Where the layout IS corroborated, an
      // unreadable component is still ambiguous and still refuses (below); where it
      // is not, we proceed unverified like any other plain install.
      if (!hasGitRoot && assetsRootProbe !== "present") continue;

      const gitExe = firstExisting([
        joinPath(gitRoot, "cmd", "git.exe"),
        joinPath(gitRoot, "cmd", "git"),
        joinPath(gitRoot, "bin", "git.exe"),
        joinPath(gitRoot, "bin", "git"),
      ]);
      const ffmpegExe = firstExisting([
        joinPath(ffmpegRoot, "bin", "ffmpeg.exe"),
        joinPath(ffmpegRoot, "bin", "ffmpeg"),
        joinPath(ffmpegRoot, "ffmpeg.exe"),
        joinPath(ffmpegRoot, "ffmpeg"),
      ]);
      return {
        dataRoot,
        gitExe,
        gitDir: gitExe ? dirOf(gitExe) : undefined,
        ffmpegDir: ffmpegExe ? dirOf(ffmpegExe) : undefined,
        git: componentEvidence(!!gitExe, gitRootProbe, dataRoot, "portablegit"),
        ffmpeg: componentEvidence(!!ffmpegExe, ffmpegRootProbe, dataRoot, "ffmpeg"),
      };
    }
  }
  return null;
}

/**
 * Is `p` Stability Matrix's unused Assets CPython (#1704)?
 *
 * SM stores the *base* interpreter it created the package venv FROM under
 * `<Data>/Assets/Python/cpython-…/python.exe`. That tree has no ComfyUI
 * site-packages (`import sqlalchemy` fails immediately). Windows also reports
 * this path as `Win32_Process.ExecutablePath` for a venv trampoline, so a
 * relaunch that treats the OS image as the interpreter picks it by accident.
 *
 * Requires the same on-disk corroboration as `detectStabilityMatrix` so a
 * random `…/Assets/Python/…` tree is never classified as SM.
 */
export function isStabilityMatrixAssetsPython(p: string | undefined): boolean {
  if (!p) return false;
  const segs = segmentsOf(p);
  const lower = segs.map((s) => s.toLowerCase());
  const assets = lower.lastIndexOf("assets");
  if (assets < 0 || lower[assets + 1] !== "python") return false;
  // Parent of `Assets` is the Data root. The Assets path itself never walks
  // through `Packages`, so `detectStabilityMatrix` cannot corroborate it —
  // require the Packages sibling on disk instead.
  const dataRoot = segs.slice(0, assets).join(separatorOf(p));
  if (!dataRoot) return false;
  return pathExists(joinPath(dataRoot, "Packages"));
}

/** A PATH name, not a file we can verify — `python`, `python.exe`, `python3`. */
function isBarePythonName(p: string): boolean {
  if (/[\\/]/.test(p) || /^[a-zA-Z]:/.test(p)) return false;
  const base = p.toLowerCase();
  return (
    base === "python" ||
    base === "python.exe" ||
    base === "python3" ||
    base === "python3.exe"
  );
}

function samePath(a: string, b: string): boolean {
  const norm = (s: string): string =>
    s.replace(/[\\/]+$/, "").replace(/[\\/]/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The Stability Matrix *package* interpreter (`<Packages>/<name>/venv`, then
 * `.venv`) for the install named by `paths`.
 *
 * SM's official env is `venv` (not `.venv`, not the Assets CPython). Used as
 * the relaunch fallback when the OS did not name a usable interpreter, and as
 * the replacement when the chosen exe is the unused Assets CPython (#1704).
 */
export function resolveStabilityMatrixPackagePython(
  paths: ReadonlyArray<string | undefined>,
): string | undefined {
  const sm = detectStabilityMatrix(paths);
  if (!sm) return undefined;
  const packagesRoot = joinPath(sm.dataRoot, "Packages");
  for (const p of paths) {
    if (!p) continue;
    for (const ancestor of [p, ...ancestorsOf(p)]) {
      const parent = dirOf(ancestor);
      if (!parent || !samePath(parent, packagesRoot)) continue;
      if (
        !pathExists(joinPath(ancestor, "main.py")) &&
        !pathExists(joinPath(ancestor, "main.pyw"))
      ) {
        continue;
      }
      const py = firstExisting([
        joinPath(ancestor, "venv", "Scripts", "python.exe"),
        joinPath(ancestor, "venv", "bin", "python"),
        joinPath(ancestor, "venv", "bin", "python3"),
        joinPath(ancestor, ".venv", "Scripts", "python.exe"),
        joinPath(ancestor, ".venv", "bin", "python"),
        joinPath(ancestor, ".venv", "bin", "python3"),
      ]);
      if (py) return py;
    }
  }
  return undefined;
}

/**
 * Replace an Assets CPython (or a bare PATH `python`) with the package venv
 * when this is a Stability Matrix install. Any other observed interpreter is
 * left alone (#1654 — the process we saw still wins).
 */
export function preferStabilityMatrixPackagePython(
  chosen: string | undefined,
  paths: ReadonlyArray<string | undefined>,
): string | undefined {
  const packagePy = resolveStabilityMatrixPackagePython(paths);
  if (!packagePy) return chosen;
  if (!chosen || isBarePythonName(chosen) || isStabilityMatrixAssetsPython(chosen)) {
    return packagePy;
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Opaque launchers — recognized, but NOT reproducible
// ---------------------------------------------------------------------------

/**
 * Launchers that own the server's environment in a way we cannot rebuild from
 * disk. Pinokio composes each app's environment in a per-app JS install script
 * (its own conda/git/ffmpeg shims, per-app venvs, arbitrary exports); nothing on
 * disk tells us what the running process actually got. Relaunching such a server
 * with OUR environment is precisely the #776 failure mode, so these refuse.
 */
const OPAQUE_LAUNCHER_DIRS: ReadonlyArray<{
  dir: string;
  name: string;
  /** ALL of these must exist under the root — name alone is never proof. */
  requireDirs: string[];
  /** The install must live under this subdirectory of the root. */
  requireInstallUnder: string;
}> = [
  // A Pinokio home holds BOTH `api/` (the installed apps) and `bin/` (its shims),
  // and every app it manages lives under `<root>/api/…`.
  {
    dir: "pinokio",
    name: "Pinokio",
    requireDirs: ["api", "bin"],
    requireInstallUnder: "api",
  },
];

/** Is `child` inside `parent`? Separator- and (Windows-)case-insensitive. */
function isUnder(child: string, parent: string): boolean {
  const norm = (s: string): string[] =>
    segmentsOf(s)
      .filter((seg) => seg !== "")
      .map((seg) => seg.toLowerCase());
  const c = norm(child);
  const p = norm(parent);
  if (p.length === 0 || c.length <= p.length) return false;
  return p.every((seg, i) => c[i] === seg);
}

/**
 * A recognized launcher whose environment we cannot rebuild.
 *
 * A refusal here BLOCKS a restart, so the evidence bar is deliberately higher than
 * for Stability Matrix (whose detection only unlocks a reconstruction): a
 * false positive costs the user a restart that would have worked. A directory
 * merely NAMED `pinokio`, or one that merely happens to contain a `bin`, is not
 * enough (coordinator gate). We require three independent signals: the named root,
 * ALL of the launcher's own top-level directories, and the install actually
 * sitting inside the subtree the launcher keeps its apps in.
 */
export function detectOpaqueLauncher(
  paths: ReadonlyArray<string | undefined>,
): { name: string; root: string } | null {
  for (const p of paths) {
    if (!p) continue;
    for (const ancestor of ancestorsOf(p)) {
      const base = basenameOf(ancestor).toLowerCase();
      const hit = OPAQUE_LAUNCHER_DIRS.find((l) => l.dir === base);
      if (!hit) continue;
      if (!hit.requireDirs.every((d) => pathExists(joinPath(ancestor, d)))) continue;
      if (!isUnder(p, joinPath(ancestor, hit.requireInstallUnder))) continue;
      return { name: hit.name, root: ancestor };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Live process environment (Linux)
// ---------------------------------------------------------------------------

/**
 * The RUNNING server's own environment, read from `/proc/<pid>/environ`.
 *
 * This is the launch environment verbatim — whatever launcher produced it — so it
 * is the best possible answer when it is available. It MUST be read while the
 * process is still alive (the whole `/proc/<pid>` tree vanishes the instant the
 * stop kills the pid), which is why the caller captures it at gather-time next to
 * the live cwd (#535). Linux only; every other platform has no supported way to
 * read another process's environment block, and we do not guess.
 */
export function readLiveProcessEnv(pid: number): NodeJS.ProcessEnv | undefined {
  if (!pid || pid <= 0 || process.platform !== "linux") return undefined;
  try {
    // /proc/<pid>/environ is a NUL-separated KEY=VALUE list. Build the separator
    // from a char code rather than writing a raw control byte into this file.
    const NUL = String.fromCharCode(0);
    const raw = readFileSync(`/proc/${pid}/environ`, "utf-8");
    const env: NodeJS.ProcessEnv = {};
    let count = 0;
    for (const entry of raw.split(NUL)) {
      if (entry === "") continue;
      const eq = entry.indexOf("=");
      if (eq <= 0) continue;
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
      count++;
    }
    // An empty read tells us nothing (permission-trimmed / raced) — treat it as
    // "unknown" rather than relaunching into a blank environment.
    return count > 0 ? env : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Environment construction
// ---------------------------------------------------------------------------

/**
 * Find an env key case-insensitively. Windows environment blocks are
 * case-insensitive and Node's `process.env` emulates that, but a plain object
 * copy does NOT — writing a fresh "PATH" next to an inherited "Path" would hand
 * the child two competing PATHs.
 */
function findEnvKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) return key;
  }
  return undefined;
}

function pathAlreadyContains(current: string, dir: string): boolean {
  const target = dir.replace(/[\\/]+$/, "").toLowerCase();
  return current
    .split(delimiter)
    .some((part) => part.trim().replace(/[\\/]+$/, "").toLowerCase() === target);
}

/**
 * Copy `base` and PREPEND `additions` to its PATH (creating PATH if absent),
 * skipping entries already present. Prepending — not appending — is what the
 * launcher itself does, and it is what makes the bundled git/ffmpeg win over any
 * different copy the orchestrator happens to have.
 */
function withPathAdditions(
  base: NodeJS.ProcessEnv,
  additions: string[],
): { env: NodeJS.ProcessEnv; added: string[] } {
  const env: NodeJS.ProcessEnv = { ...base };
  const pathKey = findEnvKey(env, "PATH") ?? "PATH";
  const current = env[pathKey] ?? "";
  const added: string[] = [];
  for (const dir of additions) {
    if (!dir || pathAlreadyContains(current, dir) || added.includes(dir)) continue;
    added.push(dir);
  }
  if (added.length > 0) {
    env[pathKey] = current
      ? [...added, current].join(delimiter)
      : added.join(delimiter);
  }
  return { env, added };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface LaunchEnvInput {
  /** Paths involved in the relaunch: script, interpreter, cwd, raw argv[0]. */
  paths: ReadonlyArray<string | undefined>;
  /** The live process's own environment, if it could be captured. */
  liveEnv?: NodeJS.ProcessEnv;
  /** Injectable base environment (defaults to this process's). */
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Decide what environment a relaunch should use, and whether that environment is
 * actually REPRODUCIBLE.
 *
 * `reproducible:false` is a hard STOP for a caller that is about to KILL a healthy
 * server: it must refuse BEFORE the server is touched, never after (#776 cardinal
 * rule — a refusal costs a restart, a bad relaunch costs the server). A caller
 * whose server is ALREADY down must NOT refuse: keeping it down is the one
 * outcome worse than a possibly-degraded launch, so it launches with the best
 * environment available and warns.
 */
export function resolveLaunchEnvironment(
  input: LaunchEnvInput,
): LaunchEnvResolution {
  const baseEnv = input.baseEnv ?? process.env;

  // 1. The live process's REAL environment beats every inference.
  if (input.liveEnv && Object.keys(input.liveEnv).length > 0) {
    return {
      reproducible: true,
      env: { ...input.liveEnv },
      info: {
        source: "live-process",
        reproducible: true,
        note:
          "relaunched with the environment captured from the running ComfyUI " +
          "process itself (read live before the stop)",
      },
    };
  }

  // 2. Stability Matrix — reconstruct exactly what it injects, from disk.
  const sm = detectStabilityMatrix(input.paths);
  if (sm) {
    // PARTIAL reconstruction is NOT reconstruction — but "partial" has to mean
    // something we would actually DROP, not merely something that isn't there.
    // Each component is therefore classified by EVIDENCE:
    //
    //   ambiguous     — the component's own directory exists (or the launcher's
    //                   config names it) but we cannot point at its binary. Then it
    //                   plausibly IS injected and we would silently drop it, which
    //                   is the #776 failure. REFUSE.
    //   not-installed — no directory, no mention anywhere. The launcher has nothing
    //                   to inject either, so relaunching without it is exactly what
    //                   the launcher itself would do. PROCEED — and say which
    //                   component was not injected, because a permanent inability to
    //                   restart is not a safer resting place than a launch that
    //                   works (coordinator gate P2(4)).
    const ambiguous: string[] = [];
    if (sm.git === "ambiguous") {
      ambiguous.push(
        `its bundled Git (looked under "${joinPath(sm.dataRoot, "PortableGit")}") — ` +
          "without it ComfyUI-Manager aborts at import with \"Bad git executable\"",
      );
    }
    if (sm.ffmpeg === "ambiguous") {
      ambiguous.push(
        `its bundled FFmpeg (looked under "${joinPath(sm.dataRoot, "Assets", "ffmpeg")}")`,
      );
    }
    if (ambiguous.length > 0) {
      const missing = ambiguous;
      return {
        reproducible: false,
        info: {
          source: "inherited",
          reproducible: false,
          launcher: "Stability Matrix",
          note:
            "Stability Matrix install detected, but part of the tooling it injects could " +
            "not be located on disk — the launcher environment could NOT be reproduced",
        },
        reason:
          `This ComfyUI is managed by Stability Matrix (${sm.dataRoot}), which launches it ` +
          `with its own bundled tooling on PATH, but this could not be located: ${missing.join("; ")}. ` +
          "That environment cannot be reproduced here.",
        advice:
          "Restart ComfyUI from Stability Matrix itself so it comes back with the " +
          "environment its packages expect.",
      };
    }
    // Everything still unresolved here is provably NOT INSTALLED, so there is
    // nothing to drop. Inject what exists.
    const additions = [sm.gitDir, sm.ffmpegDir].filter(
      (d): d is string => typeof d === "string" && d.length > 0,
    );
    const { env, added } = withPathAdditions(baseEnv, additions);
    if (sm.gitExe) {
      // GitPython (ComfyUI-Manager) resolves `git` through this variable first;
      // Stability Matrix sets it, and without it Manager aborts at import with
      // "Bad git executable" even when PATH is right (#776).
      const gitKey =
        findEnvKey(env, "GIT_PYTHON_GIT_EXECUTABLE") ?? "GIT_PYTHON_GIT_EXECUTABLE";
      env[gitKey] = sm.gitExe;
    }
    const injected: string[] = [];
    if (sm.gitDir) injected.push("PortableGit");
    if (sm.ffmpegDir) injected.push("FFmpeg");
    // Name what this install simply does not have, so a later "ffmpeg not found"
    // from a node is immediately traceable rather than mysterious.
    const notInstalled: string[] = [];
    if (sm.git === "not-installed") notInstalled.push("PortableGit");
    if (sm.ffmpeg === "not-installed") notInstalled.push("FFmpeg");
    return {
      reproducible: true,
      env,
      info: {
        source: "stability-matrix",
        reproducible: true,
        launcher: "Stability Matrix",
        path_additions: added,
        not_installed: notInstalled.length > 0 ? notInstalled : undefined,
        note:
          `Stability Matrix install detected (${sm.dataRoot}) — relaunched with its ` +
          (injected.length > 0
            ? `${injected.join(" + ")} on PATH${sm.gitExe ? " and GIT_PYTHON_GIT_EXECUTABLE set" : ""}`
            : "environment") +
          (notInstalled.length > 0
            ? `; this install has no bundled ${notInstalled.join(" or ")} anywhere under its Data folder, so none was injected (nodes that need ${notInstalled.join("/")} may not work — install it from Stability Matrix if you need it)`
            : ", so ComfyUI-Manager and ffmpeg-dependent nodes keep working"),
      },
    };
  }

  // 3. A launcher we recognize but cannot reproduce — refuse before stopping.
  const opaque = detectOpaqueLauncher(input.paths);
  if (opaque) {
    return {
      reproducible: false,
      info: {
        source: "inherited",
        reproducible: false,
        launcher: opaque.name,
        note:
          `${opaque.name} builds this server's environment at launch time — it could ` +
          "NOT be reproduced here",
      },
      reason:
        `This ComfyUI is launched by ${opaque.name} (${opaque.root}), which builds the ` +
        "server's environment (its own git/ffmpeg/python shims and exports) at launch " +
        "time. That environment cannot be read from a process we did not start, so a " +
        "relaunch from here would come back missing it.",
      advice:
        `Restart ComfyUI from ${opaque.name} itself so it comes back with the ` +
        "environment it was launched with.",
    };
  }

  // 4. Plain install — inherit, exactly as before #776.
  return {
    reproducible: true,
    info: {
      source: "inherited",
      reproducible: true,
      note: "relaunched with this process's environment (no launcher-owned environment detected)",
    },
  };
}

/**
 * Force UTF-8 on a relaunched Python whose stdio WE own (#2693).
 *
 * When this process relaunches ComfyUI it points the child's stdout and stderr at
 * a LOG FILE (#1259), not at the user's console. Python chooses its stdout
 * encoding from the locale when it is not writing to a terminal, so on a Windows
 * install whose ANSI codepage is not UTF-8 the child comes up encoding to that
 * legacy codepage — and the first custom node that prints an emoji kills startup:
 *
 *     UnicodeEncodeError: 'cp949' codec can't encode character '\U0001f389'
 *
 * (rgthree-comfy's banner, on a Korean Windows install. It is not an unusual
 * node, and a party popper is not an unusual thing to print.)
 *
 * This is OUR bug, not the node's and not the user's: their own console launch of
 * the same command works. We changed where the bytes go, so the encoding on that
 * destination is ours to choose, and a legacy codepage is the wrong choice for a
 * file we then read back as text.
 *
 * SCOPE, deliberately narrow:
 *  - Windows only. That is where the report is, and where a non-UTF-8 ANSI
 *    codepage is the default rather than an opt-in. The same reasoning covers a
 *    POSIX box running under `LANG=C`, but nothing has reported one and widening
 *    this without a case to check against is how a fix acquires a second bug.
 *  - An EXPLICIT value always wins. A user who set PYTHONIOENCODING to something
 *    else means it, and overriding their choice to fix an encoding problem would
 *    be its own encoding problem.
 *  - Returns the input UNCHANGED when there is nothing to add, so a launch that
 *    was already fine keeps its exact previous behaviour — including inheriting
 *    (undefined) rather than being handed a materialised copy.
 */
export function withUtf8StdioEnv(
  env: NodeJS.ProcessEnv | undefined,
  opts: { platform?: NodeJS.Platform; baseEnv?: NodeJS.ProcessEnv } = {},
): NodeJS.ProcessEnv | undefined {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return env;
  // `env: undefined` means "inherit this process's environment", so the values
  // already in force are the base ones — that is what the child would have got.
  const effective = env ?? opts.baseEnv ?? process.env;
  const set = (name: string) => {
    const v = effective[name];
    return typeof v === "string" && v.trim() !== "";
  };
  if (set("PYTHONUTF8") && set("PYTHONIOENCODING")) return env;
  const out: NodeJS.ProcessEnv = { ...effective };
  if (!set("PYTHONUTF8")) out.PYTHONUTF8 = "1";
  if (!set("PYTHONIOENCODING")) out.PYTHONIOENCODING = "utf-8";
  return out;
}
