// Self-update for the comfyui-mcp npm package.
//
// On MCP server START we check the npm registry; if a newer version is
// published we auto-update the on-disk package, then tell the agent/user to
// RECONNECT — the running Node process cannot hot-swap its own code, so the new
// version only takes effect after the MCP client reconnects (/mcp) or the
// orchestrator restarts.
//
// This mirrors the SAFETY model of the panel on-load ensure
// (src/services/panel-installer.ts):
//   - NEVER mutate a dev install. `npm link` makes the package resolve to the
//     developer's working checkout; updating it would clobber their repo. We
//     detect that (install mode "linked") and refuse, exactly like the panel's
//     dev-junction guard.
//   - opt-out env COMFYUI_MCP_AUTOUPDATE=0/false/no/off disables auto-update.
//   - every probe + the npm spawn is hard-timed-out, captures+swallows errors,
//     and NEVER throws — it can be fired-and-forgotten from startup without ever
//     blocking or crashing the server.
//   - we NEVER kill/restart the running MCP process; we only surface a
//     "reconnect to load vX" note.
//
// WINDOWS (#912): an in-place npm replace of the running install fails every
// time — this process holds its own sharp libvips DLL mapped, and Windows
// refuses to move a mapped file (EBUSY). A failed npm on win32 is therefore
// handed to a DETACHED helper (buildDeferredUpdateScript) that waits for the
// lock to clear and finishes the install after this process has fully
// stopped; the result is honestly reported as "scheduled", never "updated",
// and npm's own error output travels in the note either way (#912/#916-a).

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeUnreachableHost } from "../comfyui/fetch.js";
import { logger } from "../utils/logger.js";

/** npm package name — authoritative for the registry lookup and update command. */
export const PACKAGE_NAME = "comfyui-mcp";

/** Hard caps so nothing here can ever block startup. */
const REGISTRY_TIMEOUT_MS = 5_000;
const NPM_TIMEOUT_MS = 120_000;

export type InstallMode = "linked" | "global" | "npx" | "local" | "unknown";

export interface InstallInfo {
  mode: InstallMode;
  /** Resolved package root (the dir containing package.json). */
  packageDir: string;
  /** Version from the package's own package.json, if readable. */
  currentVersion: string | undefined;
  /** True for an `npm link` / run-from-checkout install — NEVER auto-update. */
  isDevLink: boolean;
  /** For a local project dependency: the project root to run `npm i` in. */
  projectRoot?: string;
}

export type SelfUpdateAction =
  | "updated"
  | "up-to-date"
  | "skipped-dev"
  | "skipped-disabled"
  | "notify"
  | "scheduled"
  | "unavailable";

export interface SelfUpdateResult {
  action: SelfUpdateAction;
  mode: InstallMode;
  from?: string;
  to?: string;
  /**
   * Machine-readable cause for a non-update, when one is known:
   *   - "locked-by-running-process" — npm failed because THIS process holds its
   *     own files open (Windows keeps sharp's libvips DLL mapped, #912).
   *   - "npm-failed" — npm failed for some other reason (see `note` for the tail).
   */
  reason?: "locked-by-running-process" | "npm-failed";
  /** Human-facing note (reconnect instruction, reason, etc.). */
  note?: string;
}

// ---------------------------------------------------------------------------
// Injectable deps (mirrors panel-installer's pattern for clean unit tests)
// ---------------------------------------------------------------------------

export interface SelfUpdateDeps {
  /** Raw package root, derived from import.meta.url (pre-realpath). */
  packageDir: () => string;
  /** Process env (opt-out flag). */
  env: () => NodeJS.ProcessEnv;
  existsSync: (p: string) => boolean;
  /** True when `p` is a symlink/junction. Never throws. */
  isSymlink: (p: string) => boolean;
  /**
   * fs.realpathSync, used to resolve `npm link` symlinks. Returns `undefined`
   * when resolution FAILS — callers must safe-fail to "unknown" rather than
   * trust the raw (unresolved) path for an updatable classification. Never throws.
   */
  realpath: (p: string) => string | undefined;
  /** Read a UTF-8 file. May throw; callers guard. */
  readFile: (p: string) => string;
  /** Fetch the latest published version from the npm registry, or undefined. */
  getLatestVersion: () => Promise<VersionProbe>;
  /**
   * Run an `npm` command (args are fixed constants — no user input).
   * Resolves and NEVER throws. stdout/stderr are captured so a failure can be
   * DIAGNOSED (#912: an EBUSY from our own locked files is indistinguishable
   * from a registry 404 when only `ok` survives).
   */
  runNpm: (
    args: string[],
    cwd?: string,
  ) => Promise<{ ok: boolean; stdout?: string; stderr?: string }>;
  /** Process platform — injectable so the Windows-only deferred path is testable. */
  platform?: () => string;
  /**
   * #912: schedule the DETACHED helper that applies an npm update after this
   * process has released its own files (Windows holds sharp's libvips DLL open
   * while the orchestrator runs, so an in-place `npm i` of this package fails
   * with EBUSY every time). Resolves true only when the helper was actually
   * launched — callers must NOT claim "scheduled" on false. Never throws.
   */
  scheduleDeferredUpdate?: (opts: DeferredUpdateOpts) => Promise<boolean>;
}

function defaultPackageDir(): string {
  // dist/services/self-update.js → packageDir = dist/.. (the package root).
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..");
}

/**
 * The outcome of one registry probe (#1136).
 *
 * Three states, because the previous `string | undefined` had four conditions
 * collapsing into the same `undefined` and the CONSUMER then asserted the most
 * specific of them: a 500, a 429, a missing `version` field and a JSON parse
 * failure were all reported as "npm registry unreachable". That is a verdict we
 * did not earn -- it sends a user with a rate-limited registry off to debug
 * their network.
 *
 * `unreachable` is claimed ONLY when the transport proves it (see
 * describeUnreachableHost, which returns null for every non-reachability code).
 * Everything else is `undetermined`, which is the honest answer.
 */
export type VersionProbe =
  | { version: string }
  | { unreachable: string }
  | { undetermined: string };

async function defaultGetLatestVersion(): Promise<VersionProbe> {
  const url = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (err) {
    const unreachable = describeUnreachableHost(err, url);
    return unreachable
      ? { unreachable }
      : { undetermined: `the version check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    // The registry ANSWERED. Whatever went wrong, the host was reachable, so
    // saying otherwise would point the user at their network.
    return {
      undetermined: `registry.npmjs.org answered HTTP ${res.status} for the version check (the host IS reachable)`,
    };
  }
  try {
    const json = (await res.json()) as { version?: unknown };
    if (typeof json.version !== "string" || json.version.trim() === "") {
      // The trim matters. `if (!latest)` on the old string|undefined shape caught
      // an empty string; `"version" in probe` does not, so without this a body of
      // {"version":""} reaches the consumer and renders as up-to-date with to:"".
      // That is a non-answer read as a reassuring answer -- the exact failure the
      // undetermined branch exists to prevent, reintroduced by its own type.
      return { undetermined: "the registry response carried no usable version field" };
    }
    return { version: json.version };
  } catch {
    return { undetermined: "the registry response was not valid JSON" };
  }
}

// ---------------------------------------------------------------------------
// #912 — the deferred (post-exit) updater for Windows
// ---------------------------------------------------------------------------

/** What the detached helper needs to finish an update this process cannot. */
export interface DeferredUpdateOpts {
  mode: "global" | "local";
  /** Local installs: the project root `npm i` must run in. */
  projectRoot?: string;
  /** Resolved package root — the helper probes THIS tree's sharp DLL lock. */
  packageDir: string;
  /** Version the helper should land (for the log line; it installs @latest). */
  to: string;
}

/** Where the helper writes its log (named in user-facing notes). */
const HELPER_LOG_NAME = "comfyui-mcp-self-update.log";
/**
 * Helper scripts are named UNIQUELY per launch (`…-<pid>-<ms>.ps1`): a shared
 * fixed name let two orchestrators stat-miss the same path and each spawn a
 * helper running the OTHER caller's freshly-overwritten script — for a local
 * install that is `npm i` in the wrong project (codex gate r1).
 */
const HELPER_SCRIPT_RE = /^comfyui-mcp-self-update-.+\.ps1$/;

/** Once per process: the auto-update tick must not pile up helpers. */
let helperScheduledThisProcess = false;

/**
 * Per-wait budget inside the helper, and the staleness window for the dedupe
 * below (a script younger than this is a helper still waiting/working — or one
 * that died mid-wait, whose log says so — so a second helper is not stacked).
 */
const HELPER_WAIT_CAP_MINUTES = 120;
const HELPER_ATTEMPTS = 3;
const HELPER_STALE_MS = (HELPER_WAIT_CAP_MINUTES * HELPER_ATTEMPTS + 60) * 60_000;

/** PowerShell single-quoted literal. */
function psLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * The helper script text (exported for tests — its PowerShell syntax is
 * validated against a real powershell.exe in the test suite on Windows).
 *
 * The helper must outlive THIS process and only run npm once the files npm
 * replaces are no longer locked — on Windows that is sharp's libvips-42.dll,
 * mapped by every running orchestrator. So each attempt first waits (bounded)
 * for the DLL to open with NO sharing; a quick respawn that re-locks it
 * mid-install just sends the next attempt back to the wait. Every outcome is
 * logged, and the script deletes itself on the way out (a helper killed by a
 * shutdown leaves the script behind; the staleness window above is what lets a
 * later run schedule a fresh one).
 *
 * All interpolated values are psLiteral-quoted constants of ours (paths, the
 * package name) — nothing user-controlled reaches the script.
 */
export function buildDeferredUpdateScript(opts: DeferredUpdateOpts, logPath: string): string {
  const dll = join(
    opts.packageDir,
    "node_modules",
    "@img",
    "sharp-win32-x64",
    "lib",
    "libvips-42.dll",
  );
  const npmArgs =
    opts.mode === "global"
      ? `i -g ${PACKAGE_NAME}@latest --no-audit --no-fund`
      : `i ${PACKAGE_NAME}@latest --no-audit --no-fund`;
  // Local installs run npm IN the project root — re-validated immediately before
  // EVERY attempt: the helper can wait hours, and a project moved meanwhile must
  // abort the helper, never let npm run in whatever directory it inherited
  // (codex gate r1). Empty for global installs (npm -g has no cwd dependence).
  const cwd = opts.mode === "local" && opts.projectRoot ? opts.projectRoot : "";
  return [
    `# comfyui-mcp deferred self-update helper (#912). Log: ${logPath}`,
    `$ErrorActionPreference = 'Continue'`,
    `$log = ${psLiteral(logPath)}`,
    `$dll = ${psLiteral(dll)}`,
    `$cwd = ${psLiteral(cwd)}`,
    `function Wait-LockFree {`,
    `  $deadline = (Get-Date).AddMinutes(${HELPER_WAIT_CAP_MINUTES})`,
    `  while ((Get-Date) -lt $deadline) {`,
    `    if (-not (Test-Path -LiteralPath $dll)) { return $true } # unexpected layout — let npm's own error say so`,
    `    try {`,
    `      $fs = [System.IO.File]::Open($dll, 'Open', 'ReadWrite', 'None')`,
    `      $fs.Close()`,
    `      return $true`,
    `    } catch { Start-Sleep -Seconds 5 }`,
    `  }`,
    `  return $false`,
    `}`,
    `"$(Get-Date -Format o) helper started (mode=${opts.mode}, target=${opts.to})" | Out-File -Append -LiteralPath $log`,
    `$ok = $false`,
    `$aborted = ''`,
    `for ($i = 0; $i -lt ${HELPER_ATTEMPTS} -and -not $ok -and -not $aborted; $i++) {`,
    `  if (-not (Wait-LockFree)) {`,
    `    $aborted = 'the sharp DLL stayed locked'`,
    `  } elseif ($cwd -and -not (Test-Path -LiteralPath $cwd -PathType Container)) {`,
    `    $aborted = "the project root $cwd no longer exists"`,
    `  } elseif ($cwd) {`,
    `    try { Set-Location -LiteralPath $cwd -ErrorAction Stop } catch {`,
    `      $aborted = "could not enter the project root $cwd ($($_.Exception.Message))"`,
    `    }`,
    `  }`,
    `  if ($aborted) { break }`,
    `  & npm.cmd ${npmArgs} *>> $log`,
    `  if ($LASTEXITCODE -eq 0) { $ok = $true } else { Start-Sleep -Seconds 10 }`,
    `}`,
    `if ($aborted) {`,
    `  "$(Get-Date -Format o) ABORTED without running npm: $aborted" | Out-File -Append -LiteralPath $log`,
    `} else {`,
    `  "$(Get-Date -Format o) npm update $(if ($ok) { 'SUCCEEDED' } else { 'FAILED' })" | Out-File -Append -LiteralPath $log`,
    `}`,
    `Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue`,
    ``,
  ]
    .filter((l) => l !== "")
    .join("\r\n");
}

/**
 * Launch the detached helper. Resolves true only when the script was written
 * AND powershell actually spawned — a false here must surface as "not
 * scheduled", never as a claimed scheduled update. Never throws.
 *
 * Dedupe: once per process (the auto-update tick), and cross-process by
 * helper-script freshness — a script younger than the staleness window is a
 * helper still waiting/working (or one that died mid-wait; its log says
 * which), so a second is not stacked. Stale leftovers from killed helpers are
 * our own artifacts and are cleaned up as they are found.
 */
async function defaultScheduleDeferredUpdate(opts: DeferredUpdateOpts): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const dir = tmpdir();
    const logPath = join(dir, HELPER_LOG_NAME);
    if (helperScheduledThisProcess) return true;
    for (const name of readdirSync(dir)) {
      if (!HELPER_SCRIPT_RE.test(name)) continue;
      try {
        const st = statSync(join(dir, name));
        if (Date.now() - st.mtimeMs < HELPER_STALE_MS) return true; // already scheduled
        unlinkSync(join(dir, name)); // stale leftover from a killed helper
      } catch {
        /* vanished between listing and stat — fine */
      }
    }
    const scriptPath = join(dir, `comfyui-mcp-self-update-${process.pid}-${Date.now()}.ps1`);
    writeFileSync(scriptPath, buildDeferredUpdateScript(opts, logPath), "utf-8");
    const spawned = await new Promise<boolean>((resolveP) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      child.once("error", () => resolveP(false));
      child.once("spawn", () => {
        child.unref();
        resolveP(true);
      });
    });
    // A spawn failure leaves the script behind; remove it so the dedupe scan
    // does not read it as a pending helper.
    if (!spawned) {
      try {
        unlinkSync(scriptPath);
      } catch {
        /* best effort */
      }
      return false;
    }
    helperScheduledThisProcess = true;
    return true;
  } catch {
    return false;
  }
}

/** The log path the helper writes to — named in user-facing notes. */
export function deferredUpdateLogPath(): string {
  return join(tmpdir(), HELPER_LOG_NAME);
}

function defaultRunNpm(
  args: string[],
  cwd?: string,
): Promise<{ ok: boolean; stdout?: string; stderr?: string }> {
  return new Promise((resolveP) => {
    // `npm` is a .cmd shim on Windows; execFile needs shell:true to run it.
    // SAFE: every arg is a hard-coded constant (no interpolation of user input),
    // so there is no shell-injection surface.
    const isWin = process.platform === "win32";
    const cmd = isWin ? "npm.cmd" : "npm";
    try {
      const child = execFile(
        cmd,
        args,
        { cwd, timeout: NPM_TIMEOUT_MS, windowsHide: true, shell: isWin },
        (err, stdout, stderr) =>
          resolveP({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
      );
      child.on("error", () => resolveP({ ok: false }));
    } catch {
      resolveP({ ok: false });
    }
  });
}

export const defaultDeps: SelfUpdateDeps = {
  packageDir: defaultPackageDir,
  env: () => process.env,
  existsSync,
  isSymlink: (p) => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  },
  realpath: (p) => {
    try {
      return realpathSync(p);
    } catch {
      return undefined;
    }
  },
  readFile: (p) => readFileSync(p, "utf-8"),
  getLatestVersion: defaultGetLatestVersion,
  runNpm: defaultRunNpm,
  platform: () => process.platform,
  scheduleDeferredUpdate: defaultScheduleDeferredUpdate,
};

// ---------------------------------------------------------------------------
// semver compare (major.minor.patch with a basic prerelease ordering)
// ---------------------------------------------------------------------------

/** Compare two semver strings. Returns 1 if a>b, -1 if a<b, 0 if equal/unparseable. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    if (!m) return undefined;
    return {
      nums: [Number(m[1]), Number(m[2]), Number(m[3])] as const,
      pre: m[4] ?? "",
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] > pb.nums[i]) return 1;
    if (pa.nums[i] < pb.nums[i]) return -1;
  }
  // Equal core. A version WITHOUT a prerelease tag outranks one WITH it.
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

/** True when `latest` is strictly newer than `current`. */
export function isNewer(latest: string, current: string): boolean {
  return compareSemver(latest, current) > 0;
}

// ---------------------------------------------------------------------------
// Install-mode detection
// ---------------------------------------------------------------------------

function readVersion(deps: SelfUpdateDeps, dir: string): string | undefined {
  try {
    const pkg = JSON.parse(deps.readFile(join(dir, "package.json"))) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Split a path into segments, tolerant of mixed separators / Windows drives.
 * Empty segments are KEPT so a leading "/" (POSIX absolute root) survives
 * reconstruction (segs[0] === "" → rejoin yields "/home/...").
 */
function segmentsOf(p: string): string[] {
  return p.replace(/\\/g, "/").split("/");
}

/**
 * Classify how this package is installed by inspecting the resolved package dir:
 *   - linked  → `npm link` / run-from-checkout (NOT under node_modules, or the
 *     dir is itself a symlink). DEV install — never auto-update.
 *   - npx     → resolved inside an `_npx` cache dir (npx -y comfyui-mcp).
 *   - local   → under a project's node_modules; the OUTERMOST host dir with a
 *     package.json is the project root (correctly handles pnpm/yarn nested
 *     `node_modules/.pnpm/<pkg>/node_modules/<pkg>` virtual-store layouts).
 *   - global  → the canonical single-`node_modules` global layout (package sits
 *     directly inside node_modules, no project package.json above it).
 *   - unknown → couldn't classify confidently → caller MUST NOT auto-update.
 *
 * SAFE-FAIL: any uncertainty (realpath resolution failed, nested/ambiguous
 * virtual-store layout with no identifiable project root) returns "unknown"
 * (notify only) — NEVER "global". The dangerous wrong-direction failure is
 * classifying a local install as global and running `npm i -g` against it, so
 * the classifier only ever errs toward "unknown".
 *
 * Uses realpath to follow an `npm link` symlink to the developer's checkout, and
 * lstat to catch the --preserve-symlinks case where the dir is the symlink.
 */
export function detectInstallMode(deps: SelfUpdateDeps = defaultDeps): InstallInfo {
  let rawDir: string;
  try {
    rawDir = deps.packageDir();
  } catch {
    return { mode: "unknown", packageDir: "", currentVersion: undefined, isDevLink: false };
  }

  // --preserve-symlinks: the dir we run from is itself the link → dev link.
  const dirIsSymlink = deps.isSymlink(rawDir);
  // Default Node resolves symlinks for import.meta.url, so a linked package's
  // dir already points at the real checkout; realpath is a harmless no-op there.
  // `undefined` means resolution FAILED — we must not trust the raw path for an
  // updatable classification (safe-fail to "unknown" below).
  const resolved = deps.realpath(rawDir);
  const realpathFailed = resolved === undefined;
  const real = resolved ?? rawDir;
  const currentVersion = readVersion(deps, real) ?? readVersion(deps, rawDir);

  const segs = segmentsOf(real);
  const lower = segs.map((s) => s.toLowerCase());

  // npx cache (npm's `_npx` directory) — always notify-only, so realpath
  // uncertainty is harmless here.
  if (lower.includes("_npx")) {
    return { mode: "npx", packageDir: real, currentVersion, isDevLink: false };
  }

  // All `node_modules` segment indices (outermost → innermost).
  const nmIndices: number[] = [];
  for (let i = 0; i < lower.length; i++) {
    if (lower[i] === "node_modules") nmIndices.push(i);
  }

  if (dirIsSymlink || nmIndices.length === 0) {
    // Not under node_modules (or it's a raw symlink): a working checkout, i.e.
    // `npm link` / `npm run dev` / a git clone. DEV — never auto-update.
    return { mode: "linked", packageDir: real, currentVersion, isDevLink: true };
  }

  // Under node_modules but realpath FAILED → we can't trust the on-disk
  // location → safe-fail to unknown (notify only, never an update).
  if (realpathFailed) {
    return { mode: "unknown", packageDir: real, currentVersion, isDevLink: false };
  }

  // LOCAL: walk OUTWARD — the outermost node_modules whose containing dir has a
  // package.json is the real project root. This makes a pnpm/yarn nested path
  //   <proj>/node_modules/.pnpm/<pkg>@x/node_modules/<pkg>
  // resolve to <proj> (local), instead of the virtual-store folder (which has no
  // package.json and would otherwise be misread as a global prefix).
  for (const i of nmIndices) {
    const host = segs.slice(0, i).join("/") || "/";
    if (deps.existsSync(join(host, "package.json"))) {
      return { mode: "local", packageDir: real, currentVersion, isDevLink: false, projectRoot: host };
    }
  }

  // GLOBAL: only the canonical layout — a SINGLE node_modules with the package
  // sitting directly inside it (`<prefix>/.../node_modules/comfyui-mcp`) and no
  // project package.json above it (the npm prefix has none).
  const lastNm = nmIndices[nmIndices.length - 1];
  const packageIsDirectChild = lastNm === segs.length - 2;
  if (nmIndices.length === 1 && packageIsDirectChild) {
    return { mode: "global", packageDir: real, currentVersion, isDevLink: false };
  }

  // Ambiguous (nested/virtual-store layout with no identifiable project root)
  // → safe-fail to unknown. NEVER "global".
  return { mode: "unknown", packageDir: real, currentVersion, isDevLink: false };
}

/** Public, error-swallowing wrapper around the npm-registry probe. */
export async function getLatestPublishedVersion(
  deps: SelfUpdateDeps = defaultDeps,
): Promise<string | undefined> {
  try {
    const probe = await deps.getLatestVersion();
    return "version" in probe ? probe.version : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Policy engine
// ---------------------------------------------------------------------------

/** Truthy env values for the DISABLE-style flag. */
function isTruthy(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Master auto-update kill switch. Default ON. Two spellings:
 *   - COMFYUI_MCP_AUTO_UPDATE_DISABLE=1 — the documented opt-out (default 0).
 *   - COMFYUI_MCP_AUTOUPDATE=0          — the original opt-out, kept for
 *     back-compat with existing setups.
 * Disabling auto-update also disables the orchestrator's periodic check +
 * self-restart (self-restart.ts consults this same switch).
 */
export function isAutoUpdateDisabled(env: NodeJS.ProcessEnv): boolean {
  if (isTruthy(env.COMFYUI_MCP_AUTO_UPDATE_DISABLE)) return true;
  const v = (env.COMFYUI_MCP_AUTOUPDATE ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

const RECONNECT_NOTE =
  "The running MCP server is still on the OLD code — RECONNECT (/mcp) or restart " +
  "the orchestrator to load the new version.";

/**
 * Build the `npm install` argv for a self-update. Every token is a CONSTANT —
 * no user/dynamic value is ever interpolated into the command (the Windows path
 * runs npm.cmd via shell:true, so injection-safety relies on this). `--no-audit
 * --no-fund` keep it non-interactive and cut extra network/output.
 */
function npmInstallArgs(mode: "global" | "local"): string[] {
  const base =
    mode === "global"
      ? ["i", "-g", `${PACKAGE_NAME}@latest`]
      : ["i", `${PACKAGE_NAME}@latest`];
  return [...base, "--no-audit", "--no-fund"];
}

/**
 * The last few lines of npm's output, trimmed and capped so a tool result stays
 * readable. stderr is preferred (npm writes its `npm error code …` block there);
 * stdout is the fallback for a failure that logged nothing to stderr.
 * DISPLAY ONLY — classification reads the FULL output (a lock error older than
 * the last 8 lines must still classify, codex gate).
 */
function npmOutputTail(res: { stdout?: string; stderr?: string }): string {
  const raw = String(res.stderr ?? "").trim() || String(res.stdout ?? "").trim();
  if (!raw) return "";
  const tail = raw.split(/\r?\n/).slice(-8).join("\n");
  return tail.length > 1200 ? `…${tail.slice(-1200)}` : tail;
}

/** The manual-update command a remedy can name for this install mode. */
function manualUpdateCommand(info: InstallInfo): string {
  return info.mode === "local" ? `npm i ${PACKAGE_NAME}@latest` : `npm i -g ${PACKAGE_NAME}@latest`;
}

/** Where the command runs — only meaningful for a local project install. */
function manualUpdateLocation(info: InstallInfo): string {
  return info.mode === "local" && info.projectRoot ? ` in ${info.projectRoot}` : "";
}

/** npm's signature for "a file it must replace is held open by a process". */
const NPM_LOCK_RE = /EBUSY|EPERM|resource busy or locked/i;

/**
 * Apply the npm update for a global/local install and classify the result
 * (#912 / #916-a). A failure MUST carry why: npm's output tail goes into the
 * note, and on Windows the deterministic EBUSY — this process holds its own
 * sharp libvips DLL mapped, so npm cannot replace the package it is running
 * from — is named as such and routed to the deferred post-exit helper. The
 * helper is only offered as "scheduled" when it actually launched.
 */
async function applyNpmUpdate(
  deps: SelfUpdateDeps,
  info: InstallInfo & { mode: "global" | "local" },
  latest: string,
): Promise<SelfUpdateResult> {
  const args = npmInstallArgs(info.mode);
  const res = await deps.runNpm(args, info.mode === "local" ? info.projectRoot : undefined);
  if (res.ok) {
    return {
      action: "updated",
      mode: info.mode,
      from: info.currentVersion,
      to: latest,
      note: `Updated ${PACKAGE_NAME} ${info.currentVersion} → ${latest}. ${RECONNECT_NOTE}`,
    };
  }

  const tail = npmOutputTail(res);
  // Classify on the FULL capture, not the display tail: the lock error can sit
  // anywhere in npm's output (the tail is only the last few lines of stderr).
  const locked = NPM_LOCK_RE.test(`${res.stderr ?? ""}\n${res.stdout ?? ""}`);
  const isWin = (deps.platform?.() ?? process.platform) === "win32";
  if (locked && isWin) {
    // The lock is held by THIS process, so no in-process retry can succeed.
    // The helper applies the update once the orchestrator has fully stopped;
    // claim "scheduled" only when it genuinely launched.
    const scheduled = deps.scheduleDeferredUpdate
      ? await deps.scheduleDeferredUpdate({
          mode: info.mode,
          projectRoot: info.projectRoot,
          packageDir: info.packageDir,
          to: latest,
        })
      : false;
    if (scheduled) {
      return {
        action: "scheduled",
        mode: info.mode,
        from: info.currentVersion,
        to: latest,
        reason: "locked-by-running-process",
        note:
          `npm could not install ${latest} in place: Windows keeps this running ` +
          `orchestrator's own sharp libvips DLL locked, so the package cannot be ` +
          `replaced while it runs. A detached helper was scheduled — it waits for ` +
          `the lock to clear, then runs \`${manualUpdateCommand(info)}\`` +
          `${manualUpdateLocation(info)} (log: ` +
          `${deferredUpdateLogPath()}). The update lands once this orchestrator has ` +
          `fully STOPPED — quit the MCP client or end the process; a /mcp reconnect ` +
          `or auto-restart keeps an orchestrator holding the lock and the helper keeps ` +
          `waiting — and takes effect at the next start. Staying on ` +
          `${info.currentVersion} until then; verify with ` +
          `install_comfyui (action:"self_update") using self_update_action:'status' after the next start.`,
      };
    }
    return {
      action: "unavailable",
      mode: info.mode,
      from: info.currentVersion,
      to: latest,
      reason: "locked-by-running-process",
      note:
        `npm update to ${latest} failed: files of the RUNNING orchestrator are locked ` +
        `(Windows holds this process's own sharp libvips DLL open), and the deferred ` +
        `update helper could not be started. Staying on ${info.currentVersion}. Quit ` +
        `the orchestrator fully (a /mcp reconnect or auto-restart keeps a process ` +
        `holding the lock), then run: ${manualUpdateCommand(info)}${manualUpdateLocation(info)}` +
        (tail ? `\nnpm said:\n${tail}` : ""),
    };
  }

  return {
    action: "unavailable",
    mode: info.mode,
    from: info.currentVersion,
    to: latest,
    reason: locked ? "locked-by-running-process" : "npm-failed",
    note:
      `npm update to ${latest} failed; staying on ${info.currentVersion}.` +
      (tail ? `\nnpm said:\n${tail}` : ""),
  };
}

export interface SelfUpdateOptions {
  deps?: SelfUpdateDeps;
}

async function checkInner(deps: SelfUpdateDeps): Promise<SelfUpdateResult> {
  const info = detectInstallMode(deps);

  // 1) DEV LINK — highest-priority safety guard. Never mutate a dev checkout,
  //    even if the user did not set the opt-out env.
  if (info.isDevLink || info.mode === "linked") {
    return {
      action: "skipped-dev",
      mode: info.mode,
      from: info.currentVersion,
      note: "Dev install (npm link / checkout) — self-update is disabled; update via git.",
    };
  }

  // 2) Opt-out.
  if (isAutoUpdateDisabled(deps.env())) {
    return {
      action: "skipped-disabled",
      mode: info.mode,
      from: info.currentVersion,
      note: "Self-update disabled via COMFYUI_MCP_AUTOUPDATE.",
    };
  }

  // 3) Registry probe.
  const probe = await deps.getLatestVersion();
  if (!("version" in probe)) {
    // #1136 — say which of the two it was. "unreachable" is a claim about the
    // user's network and must not be made on the strength of a 500 or a
    // malformed body; those get "could not determine", which is what we know.
    return {
      action: "unavailable",
      mode: info.mode,
      from: info.currentVersion,
      note:
        "unreachable" in probe
          ? probe.unreachable
          : `Could not determine the latest published version — ${probe.undetermined}. This is NOT evidence that you are up to date.`,
    };
  }
  const latest = probe.version;

  // 4) Up to date (also covers an unreadable current version → don't churn).
  if (!info.currentVersion || !isNewer(latest, info.currentVersion)) {
    return {
      action: "up-to-date",
      mode: info.mode,
      from: info.currentVersion,
      to: latest,
    };
  }

  // 5) Newer available. Only global/local can be safely self-replaced on disk.
  if (info.mode === "global" || info.mode === "local") {
    return applyNpmUpdate(deps, { ...info, mode: info.mode }, latest);
  }

  // 6) npx / unknown — can't safely self-replace; notify only.
  const how =
    info.mode === "npx"
      ? "npx already fetches the latest on next run — restart to pick it up."
      : "Could not classify the install; update manually.";
  return {
    action: "notify",
    mode: info.mode,
    from: info.currentVersion,
    to: latest,
    note: `${PACKAGE_NAME} ${latest} is available (current ${info.currentVersion}). ${how}`,
  };
}

/**
 * The on-load policy engine. Detects install mode, checks the registry, and (for
 * global/local) self-updates on disk — then asks the user to RECONNECT. Swallows
 * every error and NEVER throws, so it can be fired-and-forgotten from startup.
 */
export async function checkAndSelfUpdate(
  opts: SelfUpdateOptions = {},
): Promise<SelfUpdateResult> {
  const deps = opts.deps ?? defaultDeps;
  try {
    return await checkInner(deps);
  } catch (err) {
    logger.debug("self-update: check failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    let mode: InstallMode = "unknown";
    try {
      mode = detectInstallMode(deps).mode;
    } catch {
      /* ignore */
    }
    return {
      action: "unavailable",
      mode,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Tool-facing status (never throws)
// ---------------------------------------------------------------------------

export interface SelfUpdateStatus {
  mode: InstallMode;
  packageDir: string;
  currentVersion: string | undefined;
  latestVersion: string | undefined;
  updateAvailable: boolean;
  isDevLink: boolean;
  autoUpdateDisabled: boolean;
  note: string;
}

/** status action — never throws. Reports mode + current vs latest + notes. */
export async function selfUpdateStatus(
  deps: SelfUpdateDeps = defaultDeps,
): Promise<SelfUpdateStatus> {
  let info: InstallInfo;
  try {
    info = detectInstallMode(deps);
  } catch {
    info = { mode: "unknown", packageDir: "", currentVersion: undefined, isDevLink: false };
  }
  // #1136 — ask the PROBE. getLatestPublishedVersion flattens the three states
  // back to string|undefined, which is the fold this change removes; reading it
  // here made `action:"status"` report a 429 as "npm registry unreachable" AND
  // discard the composed message on a genuine outage, losing the host name --
  // the one thing #1136 asks for. `status` is the read-only action an agent
  // reaches for while diagnosing exactly that situation.
  const probe = await deps.getLatestVersion().catch(
    (err: unknown): VersionProbe => ({
      undetermined: `the version check threw: ${err instanceof Error ? err.message : String(err)}`,
    }),
  );
  const latest = "version" in probe ? probe.version : undefined;
  const autoUpdateDisabled = isAutoUpdateDisabled(deps.env());
  const updateAvailable =
    !!latest && !!info.currentVersion && isNewer(latest, info.currentVersion);

  let note: string;
  if (info.isDevLink || info.mode === "linked") {
    note = "Dev install (npm link / checkout) — self-update is disabled; update via git.";
  } else if (!latest) {
    note =
      "unreachable" in probe
        ? probe.unreachable
        : `Could not determine the latest published version — ${"undetermined" in probe ? probe.undetermined : "the registry did not answer usably"}. This is NOT evidence that you are up to date.`;
  } else if (!updateAvailable) {
    note = `Up to date (${info.currentVersion}).`;
  } else if (info.mode === "npx") {
    note = `${latest} available — npx fetches the latest on next run; restart to pick it up.`;
  } else if (info.mode === "unknown") {
    note = `${latest} available — could not classify install; update manually.`;
  } else {
    note =
      `${latest} available (current ${info.currentVersion}). ` +
      `Run install_comfyui (action:"self_update") with self_update_action:'update'${autoUpdateDisabled ? "" : " (or it auto-updates on start)"}. ${RECONNECT_NOTE}`;
    // #912: on Windows the running orchestrator holds its own sharp DLL open, so
    // an in-place npm replace fails (EBUSY) — the update is applied by the
    // deferred helper AFTER this process stops, not on a mere reconnect. Say so
    // up front so nobody promises an in-place update this platform can't do.
    if ((deps.platform?.() ?? process.platform) === "win32") {
      note +=
        " On Windows the running orchestrator keeps its own files locked, so the " +
        "update is applied by a deferred helper once this orchestrator has fully " +
        "stopped, and loads at the next start.";
    }
  }

  return {
    mode: info.mode,
    packageDir: info.packageDir,
    currentVersion: info.currentVersion,
    latestVersion: latest,
    updateAvailable,
    isDevLink: info.isDevLink || info.mode === "linked",
    autoUpdateDisabled,
    note,
  };
}

export class SelfUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfUpdateError";
  }
}

/**
 * Explicit `update` action. Refuses on a dev link. Returns the same result shape
 * as the on-load check. Unlike the on-load path this IGNORES the opt-out env
 * (the user explicitly asked), but still never updates a dev link, npx, or
 * unknown install.
 */
export async function runSelfUpdate(
  deps: SelfUpdateDeps = defaultDeps,
): Promise<SelfUpdateResult> {
  const info = detectInstallMode(deps);
  if (info.isDevLink || info.mode === "linked") {
    throw new SelfUpdateError(
      "Refusing to self-update a dev install (npm link / checkout). Update via git instead.",
    );
  }

  // #1136 — ask the PROBE, not the flattening wrapper. getLatestPublishedVersion
  // collapses the three states back into string|undefined, which is precisely
  // the fold this change removes: it would report a 500 or an unparseable body
  // as a network problem the user is expected to act on.
  const probe = await deps.getLatestVersion().catch(
    (err: unknown): VersionProbe => ({
      undetermined: `the version check threw: ${err instanceof Error ? err.message : String(err)}`,
    }),
  );
  if (!("version" in probe)) {
    return {
      action: "unavailable",
      mode: info.mode,
      from: info.currentVersion,
      note:
        "unreachable" in probe
          ? probe.unreachable
          : `Could not determine the latest published version — ${probe.undetermined}. This is NOT evidence that you are up to date.`,
    };
  }
  const latest = probe.version;
  if (!info.currentVersion || !isNewer(latest, info.currentVersion)) {
    return { action: "up-to-date", mode: info.mode, from: info.currentVersion, to: latest };
  }
  if (info.mode === "global" || info.mode === "local") {
    return applyNpmUpdate(deps, { ...info, mode: info.mode }, latest);
  }
  // npx / unknown
  return {
    action: "notify",
    mode: info.mode,
    from: info.currentVersion,
    to: latest,
    note:
      info.mode === "npx"
        ? `${latest} available — npx fetches the latest on next run; restart to pick it up.`
        : `${latest} available — could not classify install; update manually.`,
  };
}
