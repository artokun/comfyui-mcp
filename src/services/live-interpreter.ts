// GROUND TRUTH for "which python is the running ComfyUI actually using?" (#401).
//
// Everything else in this codebase INFERS the answer from install layout: look for
// a .venv under a root we believe in, prefer this candidate over that one, then
// cross-check a version. That inference is what produced the bug this module exists
// to end — a confident "Triton: not installed" read off the wrong interpreter, which
// made an agent strip working acceleration from a user's workflow.
//
// Inference cannot be hardened into proof. Two cloned venvs under one root, a conda
// env we don't even enumerate, a server launched with an interpreter from somewhere
// else entirely — no amount of layout heuristics or version/torch "fingerprints"
// distinguishes those, because none of them observe the process. So this module
// only reports an interpreter when something OBSERVED it:
//
//   1. WE LAUNCHED IT — process-control spawned ComfyUI and recorded the exact
//      interpreter it used. Not a guess: we chose that path.
//   2. THE OS TELLS US — the server is a local process listening on our port, and
//      the OS process table reports the command line it was started with. argv[0]
//      of a running python IS its interpreter.
//
// Anything else is `undefined`, and callers must degrade to UNKNOWN rather than
// report a package as absent. NOTE for future maintainers: ComfyUI does NOT expose
// `sys.executable` over HTTP (verified on 0.29.2 — /system_stats reports
// `embedded_python`, a BOOLEAN derived from sys.executable that throws the path
// away). If a future ComfyUI adds it, that becomes the best source of all and
// should be added here as tier 0 — it works for remote servers too.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve as pathResolve } from "node:path";
import { platform } from "node:os";
import { findPidByPort } from "./port-owner.js";
import { logger } from "./../utils/logger.js";

const IS_WIN = platform() === "win32";

/** How we came to know the interpreter — surfaced to users so "we know" reads
 *  differently from "we're guessing". */
export type InterpreterSource = "launched-by-us" | "process-table";

export interface LiveInterpreter {
  /** Absolute path to the interpreter the running server is using. */
  python: string;
  source: InterpreterSource;
  /** PID of the server process this was established for. */
  pid: number;
}

// ---------------------------------------------------------------------------
// Tier 1 — the interpreter WE launched ComfyUI with
// ---------------------------------------------------------------------------

let launchRecord: { pid: number; python: string; startedAt?: string } | undefined;

/**
 * Record the exact interpreter process-control just spawned ComfyUI with, together
 * with the process's CREATION TIME. A PID alone is not a process identity: PIDs are
 * recycled, so if our child dies and an externally launched python is handed the
 * same number before our async cleanup runs, a PID-only check would hand the stale
 * interpreter to the replacement server. PID + start time is the standard identity
 * and closes that (#401 round 4). If the start time cannot be read we store none,
 * and the tier fails closed rather than trusting a bare PID match.
 */
export function recordLaunchedInterpreter(pid: number, python: string): void {
  if (!pid || !python) return;
  const startedAt = readProcessIdentity(pid)?.startedAt;
  launchRecord = { pid, python, startedAt };
  logger.info("Recorded the interpreter ComfyUI was launched with", {
    pid,
    python,
    startedAt: startedAt ?? "(unavailable)",
  });
}

/** Forget the launch record (our child exited, or a stop was requested). */
export function clearLaunchedInterpreter(): void {
  launchRecord = undefined;
}

/** Test seam / introspection. */
export function getLaunchedInterpreterRecord():
  | { pid: number; python: string; startedAt?: string }
  | undefined {
  return launchRecord;
}

// ---------------------------------------------------------------------------
// Tier 2 — the OS process table
// ---------------------------------------------------------------------------

/**
 * Split a command line into argv, honoring double-quoted paths. Windows launchers
 * routinely quote the interpreter ("C:\Program Files\...\python.exe"), and a naive
 * whitespace split would truncate it at the space.
 */
export function argv0FromCommandLine(cmdline: string): string | undefined {
  const s = cmdline.trim();
  if (!s) return undefined;
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end > 1 ? s.slice(1, end) : undefined;
  }
  const m = s.match(/^\S+/);
  return m ? m[0] : undefined;
}

/**
 * Split a command line the OS reports as ONE STRING back into argv.
 *
 * Needed because Windows (WMI `CommandLine`) and macOS (`ps -o command=`) hand back
 * a flattened string, and a relaunch needs the pieces. Only double quotes group —
 * that is the rule on Windows, and on macOS `ps` reproduces the argv joined by
 * spaces, where a quote is at worst part of a filename.
 *
 * On WINDOWS the round-trip is faithful: this implements CommandLineToArgvW, the very
 * rule the child's own runtime applies to that same string, so an argument containing
 * a space was necessarily quoted (or the process itself would have seen two).
 *
 * On macOS it is LOSSY BY NATURE — `ps` prints argv joined by spaces and the quoting
 * is gone, so `--output-directory /a/My Outputs` cannot be told from two arguments.
 * That is why the caller records `argvFidelity`, and why a "flattened" argv may be
 * READ but never SPAWNED (codex gate round 6).
 *
 * The result is likewise never used to CORROBORATE an identity against the command
 * line it came from — a string tokenised from itself would trivially agree with
 * itself, which is not evidence of anything. Linux does not use this at all:
 * `/proc/<pid>/cmdline` is already NUL-separated argv.
 */
export function tokenizeCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  let backslashes = 0;

  /** Flush pending backslashes as literal characters. */
  const flushBackslashes = (count: number): void => {
    current += "\\".repeat(count);
    if (count > 0) started = true;
  };

  for (const ch of commandLine) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      // The documented Windows rule (CommandLineToArgvW): 2n backslashes before a
      // quote emit n backslashes and the quote GROUPS; 2n+1 emit n backslashes and
      // the quote is LITERAL. Without this, `--flag "a\\" --next` loses the closing
      // quote and everything after it fuses into one argument — a relaunch command
      // that spawns with mangled arguments while every existence check upstream
      // still passes, because those only validate the executable and the script.
      flushBackslashes(Math.floor(backslashes / 2));
      const literalQuote = backslashes % 2 === 1;
      backslashes = 0;
      if (literalQuote) {
        current += '"';
      } else {
        quoted = !quoted;
      }
      started = true;
      continue;
    }
    flushBackslashes(backslashes);
    backslashes = 0;
    if (!quoted && /\s/.test(ch)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  flushBackslashes(backslashes);
  if (started) tokens.push(current);
  return tokens;
}

/** What the OS can tell us about a running process. */
export interface ProcessIdentity {
  /** Full command line, as the OS reports it. */
  commandLine?: string;
  /**
   * The command line as ARGV — exact on Linux (`/proc/<pid>/cmdline` is already
   * NUL-separated), tokenised from the flattened string elsewhere.
   *
   * Its ONLY purpose is to rebuild a relaunch command for a server that could not
   * report its own `sys.argv` (a wedged or unreachable ComfyUI, #767). It is never
   * evidence of identity: on the platforms where it is tokenised it is derived from
   * `commandLine`, so checking one against the other proves nothing.
   */
  argv?: string[];
  /**
   * Does `argv` reproduce the argument vector the process ACTUALLY received?
   *
   * This is the difference between an argv that can be spawned and one that can only
   * be read (codex gate round 6).
   *
   *   "exact"     — Linux `/proc/<pid>/cmdline`, which is already NUL-separated, and
   *                 Windows `Win32_Process.CommandLine`, which is the literal string
   *                 handed to CreateProcess and is parsed by the child's own runtime
   *                 with exactly the CommandLineToArgvW rule `tokenizeCommandLine`
   *                 implements. An argument containing a space MUST have been quoted
   *                 there, or the process itself would have seen two — so the
   *                 round-trip is faithful.
   *   "flattened" — macOS `ps -o command=`, where the kernel joined argv with spaces
   *                 and the quoting is simply GONE. `--output-directory /a/My Outputs`
   *                 is indistinguishable from two arguments, and relaunching from it
   *                 would spawn a command the user never ran.
   */
  argvFidelity?: "exact" | "flattened";
  /**
   * The OS's OWN record of which binary this process is running — independent of
   * argv[0], which the process itself supplies.
   *
   * argv[0] is a string the launcher chose. `exec -a`, or a hand-built Windows
   * command line, can make any program present itself as any other, so argv[0] is a
   * CLAIM. This field is the kernel's answer (`Win32_Process.ExecutablePath`,
   * `/proc/<pid>/exe`) and cannot be set by the process (codex gate round 3).
   *
   * Used ONLY where the question is "what program is this?" — deciding whether a
   * parent really is the ComfyUI Desktop shell before its supervision is allowed to
   * license a stop. It is deliberately NOT used for the INTERPRETER question this
   * module exists for: for a venv, both sources resolve through the trampoline to the
   * BASE interpreter, while argv[0] is the venv python whose site-packages the server
   * actually imports (#401). Two questions, two fields.
   *
   * `undefined` where the platform or permissions do not expose it — macOS `ps`
   * reports no such column, and an elevated Windows process may withhold it — in
   * which case the caller falls back to argv[0], which is what it had before.
   */
  executablePath?: string;
  /** Process creation time, in whatever stable form the platform provides. Only ever
   *  compared against another reading taken on the SAME platform. */
  startedAt?: string;
  /**
   * The process's PARENT pid. Read in the same OS call as the rest, because
   * process-control uses it to prove that the process serving ComfyUI's port
   * really is the child it spawned (#776) — lineage is the one identity signal
   * that does not depend on WHEN it is read.
   */
  parentPid?: number;
  /**
   * The interpreter implied by the process's OWN environment, when that names a
   * file we can probe. On macOS a venv python is a symlink into the Homebrew
   * framework; Python.app re-execs and `ps` then reports the BASE interpreter as
   * argv[0]. The original venv path survives as `__PYVENV_LAUNCHER__` (CPython's
   * framework hook) or `VIRTUAL_ENV`. Those are observations of the running
   * process, not layout guesses (#401 recurrence, 0.52.1).
   *
   * Only those two keys are read; the rest of the environment is discarded and
   * never logged.
   */
  venvPython?: string;
  /**
   * The RAW venv hints, uninterpreted. Carried separately from `venvPython` because
   * `VIRTUAL_ENV` can only be judged against argv[0], and argv[0] is chosen in
   * `observeLiveServerProcess`, not here. Resolving at the decision point is what
   * keeps the corroboration reachable — behind the OS read it would be invisible to
   * every caller that injects a `readIdentity` seam.
   */
  venvHints?: VenvEnvHints;
}

/**
 * Read a running process's command line AND creation time from the OS.
 *
 * Windows: WMI's `CommandLine` is what answers the INTERPRETER question, NOT
 * `ExecutablePath`. This distinction is the whole
 * point — for a venv, Windows reports ExecutablePath as the BASE interpreter the
 * venv trampoline loads (e.g. …\standalone-env\python.exe) while CommandLine's
 * argv[0] is the venv python (…\ComfyUI\.venv\Scripts\python.exe), which is what
 * `sys.executable` reports and whose site-packages the server actually imports.
 * Verified against a live ComfyUI Desktop instance while fixing #401.
 * `ExecutablePath` IS read, into its own field, for the separate "what program is
 * this?" question — see `executablePath`.
 *
 * Linux: /proc/PID/cmdline ("\u0000"-separated argv) plus field 22 of /proc/PID/stat
 * (starttime, in clock ticks since boot). /proc/PID/exe likewise goes to
 * `executablePath` ONLY, never to the interpreter answer, because it resolves
 * through the venv symlink to the base interpreter.
 * macOS: `ps -o lstart=,command=` — which exposes no authenticated executable
 * column, so `executablePath` is undefined there.
 */
function parsePid(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  try {
    if (IS_WIN) {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          // #1005 — PowerShell encodes REDIRECTED stdout with the console's
          // legacy OEM codepage, not UTF-8, and this output is decoded as UTF-8.
          // Any character the codepage cannot represent arrives as `?` or U+FFFD,
          // so a ComfyUI under a non-ASCII path (a Cyrillic Windows profile, an
          // accented folder, CJK) reports a MANGLED command line.
          //
          // That is not cosmetic here: commandLineMatchesArgv compares this
          // against /system_stats argv to corroborate ownership before a restart.
          // A mangled path never matches, so restart_comfyui refuses to control
          // the very process it just identified — reporting "is not running the
          // ComfyUI that answered /system_stats" about the one that is.
          //
          // Verified on Windows 11: without this line `Пример-café-日本` comes back
          // as `??????-caf?-??`; with it, intact.
          `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ` +
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; ` +
            `if ($p) { "START=" + $p.CreationDate.ToFileTimeUtc(); "PPID=" + $p.ParentProcessId; "EXE=" + $p.ExecutablePath; "CMD=" + $p.CommandLine }`,
        ],
        { encoding: "utf-8", timeout: 8000, windowsHide: true },
      );
      const startedAt = out.match(/^START=(.+)$/m)?.[1]?.trim();
      // PPID before CMD in the output so a multi-line command line (captured with
      // [\s\S]) cannot swallow it.
      const parentPid = parsePid(out.match(/^PPID=(.+)$/m)?.[1]);
      // EXE before CMD for the same reason PPID is: a multi-line command line
      // (captured with [\s\S]) must not swallow the fields after it.
      const executablePath = out.match(/^EXE=(.*)$/m)?.[1]?.trim();
      const commandLine = out.match(/^CMD=([\s\S]*)$/m)?.[1]?.trim();
      if (!startedAt && !commandLine) return undefined;
      return withVenvPython(pid, {
        commandLine: commandLine || undefined,
        argv: commandLine ? tokenizeCommandLine(commandLine) : undefined,
        argvFidelity: "exact",
        executablePath: executablePath || undefined,
        startedAt: startedAt || undefined,
        parentPid,
      });
    }
    if (platform() === "linux") {
      // argv entries are "\u0000"-separated; rejoin them as a command line.
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      // EXACT argv — the kernel already separated it, so nothing is guessed here.
      const argv = raw.split("\u0000").filter(Boolean);
      const commandLine = argv.join(" ").trim();
      let startedAt: string | undefined;
      let parentPid: number | undefined;
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
        // Field 2 (comm) can contain spaces and parens — parse after the LAST ')'.
        const after = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
        // After comm, fields run state(3)… so starttime (field 22) is index 19 here.
        startedAt = after[19];
        // ppid is field 4, i.e. index 1 in this same post-comm numbering.
        parentPid = parsePid(after[1]);
      } catch {
        /* start time unavailable → the launched-by-us tier fails closed */
      }
      // The kernel's own record of the binary, which argv[0] cannot forge. Absent
      // (EACCES) for another user's process, which is exactly the case where the
      // caller must fall back rather than conclude anything.
      let executablePath: string | undefined;
      try {
        executablePath = readlinkSync(`/proc/${pid}/exe`);
      } catch {
        /* not ours to read → undefined, and the caller falls back to argv[0] */
      }
      if (!commandLine && !startedAt) return undefined;
      return withVenvPython(pid, {
        commandLine: commandLine || undefined,
        argv: argv.length > 0 ? argv : undefined,
        argvFidelity: "exact",
        executablePath: executablePath || undefined,
        startedAt,
        parentPid,
      });
    }
    const out = execFileSync(
      "ps",
      ["-p", String(pid), "-o", "ppid=,lstart=,command="],
      { encoding: "utf-8", timeout: 8000 },
    ).trim();
    if (!out) return undefined;
    // `ppid` first, then `lstart` (a ctime-style stamp: "Fri Aug  1 12:00:00 2026").
    const m = out.match(
      /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([\s\S]*)$/,
    );
    if (!m) {
      return withVenvPython(pid, {
        commandLine: out,
        argv: tokenizeCommandLine(out),
        argvFidelity: "flattened",
      });
    }
    return withVenvPython(pid, {
      parentPid: parsePid(m[1]),
      startedAt: m[2].replace(/\s+/g, " "),
      commandLine: m[3].trim(),
      argv: tokenizeCommandLine(m[3].trim()),
      argvFidelity: "flattened",
    });
  } catch {
    return undefined;
  }
}

/** Back-compat helper: just argv[0] of a running process. */
export function readProcessArgv0(pid: number): string | undefined {
  const cmd = readProcessIdentity(pid)?.commandLine;
  return cmd ? argv0FromCommandLine(cmd) : undefined;
}

/**
 * The two process-env keys that name the venv the process is actually importing
 * from. Everything else in the environment is discarded here — we never want a
 * capability probe to carry secrets just to recover an interpreter.
 */
export interface VenvEnvHints {
  pyvenvLauncher?: string;
  virtualEnv?: string;
}

/** Pull only `__PYVENV_LAUNCHER__` and `VIRTUAL_ENV` out of `KEY=VALUE` entries. */
export function venvHintsFromEnvEntries(entries: Iterable<string>): VenvEnvHints {
  const out: VenvEnvHints = {};
  for (const raw of entries) {
    if (raw.startsWith("__PYVENV_LAUNCHER__=")) {
      const v = raw.slice("__PYVENV_LAUNCHER__=".length).trim();
      if (v) out.pyvenvLauncher = v;
    } else if (raw.startsWith("VIRTUAL_ENV=")) {
      const v = raw.slice("VIRTUAL_ENV=".length).trim();
      if (v) out.virtualEnv = v;
    }
    if (out.pyvenvLauncher && out.virtualEnv) break;
  }
  return out;
}

/** Linux `/proc/<pid>/environ` is NUL-separated `KEY=VALUE`. */
export function venvHintsFromEnvironBuffer(buf: Buffer): VenvEnvHints {
  return venvHintsFromEnvEntries(buf.toString("utf8").split("\0"));
}

/**
 * macOS `kern.procargs2.<pid>`: int32 argc, exec path, argv[argc], then envp.
 * Padding NULs sit between the exec path and argv, and between argv and envp.
 * We only need the env keys; argv is already read from `ps`.
 */
export function venvHintsFromProcArgs2(buf: Buffer): VenvEnvHints {
  if (buf.length < 8) return {};
  const argc = buf.readInt32LE(0);
  if (argc < 0 || argc > 4096) return {};
  let i = 4;
  const nextNul = (from: number): number => {
    const at = buf.indexOf(0, from);
    return at < 0 ? buf.length : at;
  };
  // Skip the exec path and the padding that follows it.
  i = nextNul(i) + 1;
  while (i < buf.length && buf[i] === 0) i++;
  const strings: string[] = [];
  while (i < buf.length) {
    const end = nextNul(i);
    if (end === i) {
      i++;
      continue;
    }
    strings.push(buf.toString("utf8", i, end));
    i = end + 1;
  }
  return venvHintsFromEnvEntries(strings.slice(Math.max(0, argc)));
}

/** Fold case and separators so two spellings of one path compare equal. */
function literal(p: string): string {
  const out = pathResolve(p).replace(/\\/g, "/");
  return IS_WIN ? out.toLowerCase() : out;
}

/** `literal`, plus symlink resolution where the filesystem allows it. Both forms
 *  are compared, because either one alone gives a wrong answer: unresolved misses a
 *  base install reached through a symlinked prefix, and resolved collapses a venv's
 *  `bin/python` onto the base it links to. */
function canonical(p: string): string {
  try {
    return literal(realpathSync(p));
  } catch {
    return literal(p);
  }
}

/**
 * The BASE interpreter a venv was built from, as the venv itself records it.
 *
 * `pyvenv.cfg` is written at creation time and names the interpreter that created
 * it — `executable` (the full path, CPython 3.11+) and `home` (its directory).
 * Measured on a real venv:
 *
 *     home = C:\Users\A\miniconda3
 *     executable = C:\Users\A\miniconda3\python.exe
 *
 * This is what lets us tell a venv that argv[0] is the base OF from a venv that
 * merely happens to be named in the environment.
 */
export function venvBaseInterpreters(venvRoot: string): string[] {
  try {
    const cfg = readFileSync(join(venvRoot, "pyvenv.cfg"), "utf-8");
    const out: string[] = [];
    const exe = cfg.match(/^\s*executable\s*=\s*(.+)$/m)?.[1]?.trim();
    if (exe) out.push(exe);
    const home = cfg.match(/^\s*home\s*=\s*(.+)$/m)?.[1]?.trim();
    if (home) out.push(home);
    return out;
  } catch {
    return [];
  }
}

/**
 * Reconstruct the venv interpreter the PROCESS recorded. `__PYVENV_LAUNCHER__`
 * is the original argv[0] CPython saved before the macOS framework re-exec;
 * `VIRTUAL_ENV` is the activate-script / uv equivalent.
 *
 * The two are NOT equally trustworthy, and treating them as if they were is its own
 * #401. `__PYVENV_LAUNCHER__` is set by CPython itself, during this process's own
 * re-exec, so it describes THIS interpreter. `VIRTUAL_ENV` is set by `activate` and
 * then INHERITED by every child regardless of which interpreter that child is —
 * measured:
 *
 *     $ VIRTUAL_ENV=/tmp/ve401 python -c "import sys,os; print(sys.executable)"
 *     sys.executable = C:\Users\A\miniconda3\python.exe     <- what it really imports
 *     VIRTUAL_ENV    = /tmp/ve401                           <- an unrelated venv
 *
 * So a server launched by explicit absolute path from a shell with some other venv
 * active would be probed against that other venv — reporting `Triton: not installed`
 * off an interpreter the server never loaded, which is the original bug verbatim.
 *
 * `VIRTUAL_ENV` may therefore only OVERRIDE a usable argv[0] when the venv's own
 * `pyvenv.cfg` names argv[0] as the base it was built from. That is exactly the
 * macOS Python.app re-exec case (argv[0] IS the framework base of this venv), and
 * exactly not the stale-inheritance case. When there is no usable argv[0] to
 * contradict, the hint is better than nothing and is used as before.
 */
export function interpreterFromVenvHints(
  hints: VenvEnvHints,
  /** argv[0] of the process, when it is an absolute path that exists. Supplied only
   *  to corroborate `VIRTUAL_ENV`; it never affects `__PYVENV_LAUNCHER__`. */
  argv0?: string,
): string | undefined {
  const launcher = hints.pyvenvLauncher;
  if (launcher && isAbsolute(launcher) && existsSync(launcher)) return pathResolve(launcher);
  const venv = hints.virtualEnv;
  if (!venv || !isAbsolute(venv)) return undefined;
  const candidates = IS_WIN
    ? [join(venv, "Scripts", "python.exe"), join(venv, "python.exe")]
    : [join(venv, "bin", "python"), join(venv, "bin", "python3")];
  const found = candidates.find((c) => existsSync(c));
  if (!found) return undefined;
  // Nothing usable to contradict → the hint is the only observation we have.
  if (!argv0 || !isAbsolute(argv0) || !existsSync(argv0)) return pathResolve(found);

  // argv[0] is ALREADY a venv interpreter → there is nothing to recover, so the
  // environment gets no say. This override exists for one situation only: argv[0]
  // came back as a BASE interpreter (the macOS framework re-exec) and the venv it
  // belongs to survives just in the environment. When argv[0] names a venv python,
  // that story cannot apply, and any VIRTUAL_ENV pointing elsewhere is inherited.
  //
  // This is also what closes a hole the base comparison below cannot: on POSIX a
  // venv's `bin/python` is a SYMLINK to its base, so resolving argv[0] collapses it
  // onto that base — and two venvs built from one interpreter would then corroborate
  // each other. Checking for argv[0]'s own `pyvenv.cfg` asks the question directly
  // instead of inferring it from paths.
  if (existsSync(join(argv0, "..", "..", "pyvenv.cfg"))) {
    logger.info("Ignoring VIRTUAL_ENV: argv[0] is itself a venv interpreter", {
      virtualEnv: venv,
      argv0,
    });
    return undefined;
  }

  // Otherwise let the venv displace argv[0] only if the venv says argv[0] is its
  // base. `executable` is the base interpreter itself, so an exact match settles it.
  // `home` is the DIRECTORY that interpreter lives in, so argv[0] must sit directly
  // in it — a prefix test would accept anything anywhere beneath a shared bin dir
  // (`/usr/bin`), which is far too weak to license overriding argv[0].
  //
  // Compared BOTH as written and as resolved: a base install reached through a
  // symlinked prefix (`/opt/homebrew/opt/python@3.12` → `../Cellar/...`) would
  // otherwise fail to match the spelling `pyvenv.cfg` recorded.
  const targets = new Set([canonical(argv0), literal(argv0)]);
  const dirsOf = (p: string): string => p.slice(0, p.lastIndexOf("/"));
  for (const t of [...targets]) targets.add(dirsOf(t));
  const corroborated = venvBaseInterpreters(venv)
    .flatMap((b) => [canonical(b), literal(b)])
    .some((b) => targets.has(b));
  if (corroborated) return pathResolve(found);
  logger.info("Ignoring VIRTUAL_ENV: it is not the venv argv[0] is the base of", {
    virtualEnv: venv,
    argv0,
  });
  return undefined;
}

function venvHintsFromPid(pid: number): VenvEnvHints | undefined {
  try {
    if (IS_WIN) return undefined;
    if (platform() === "linux") {
      return venvHintsFromEnvironBuffer(readFileSync(`/proc/${pid}/environ`));
    }
    const buf = execFileSync("sysctl", ["-b", `kern.procargs2.${pid}`], {
      timeout: 8000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (!Buffer.isBuffer(buf) || buf.length === 0) return undefined;
    return venvHintsFromProcArgs2(buf);
  } catch {
    return undefined;
  }
}

/** Attach the raw venv hints. Deliberately does NOT resolve them: `VIRTUAL_ENV` is
 *  only meaningful next to argv[0], which the resolver picks. */
function withVenvPython(pid: number, identity: ProcessIdentity): ProcessIdentity {
  const hints = venvHintsFromPid(pid);
  if (hints && (hints.pyvenvLauncher || hints.virtualEnv)) identity.venvHints = hints;
  return identity;
}

/**
 * Is the process we found on the port the one the SERVER told us about?
 *
 * `/system_stats.argv` is the running server's own `sys.argv` — an observation made
 * inside the process that answered OUR request. Requiring the command line of the
 * process holding the port to contain every one of those tokens correlates two
 * independent observations, instead of trusting whatever happens to hold the port.
 *
 * This defeats the concrete hazard: a python reverse proxy on 127.0.0.1:8188
 * forwarding to the real ComfyUI elsewhere is a different program with a different
 * command line, so it cannot match ComfyUI's argv — and its venv (which may well
 * lack Triton) is never mistaken for the server's. The same applies to a
 * tunnel/container-side forwarder, and to a second instance whose argv differs.
 *
 * Substring matching would absorb the quoting the OS adds around paths containing
 * spaces, but it also lets `main.py` match `proxy-main.py` and `8188` match
 * `81880` — a wrapper or neighbouring server could then pass its own venv off as
 * ComfyUI's. So matching is TOKEN-aware: the command line is split on whitespace,
 * surrounding quotes stripped, and each argv token must either equal a command-line
 * token exactly or match its final path segment (relative `main.py` vs absolute
 * `C:/ComfyUI/main.py`). Multi-word argv values (paths with spaces) fall back to a
 * full substring check, since they cannot be tokenised. Windows comparison is
 * case- and separator-insensitive.
 *
 * Residual, by design: a RELATIVE argv[0] (`ComfyUI\main.py`) can anchor to any
 * instance whose command line ends the same way, so two local installs are
 * indistinguishable here once one dies and the other grabs the port. Closing
 * that needs the process's cwd, which the restart path already correlates —
 * this correlation stays argument-only.
 */
export function commandLineMatchesArgv(
  commandLine: string | undefined,
  argv: string[] | undefined,
): boolean {
  if (!commandLine || !Array.isArray(argv) || argv.length === 0) return false;
  const norm = (s: string): string => (IS_WIN ? s.toLowerCase().replace(/\\/g, "/") : s);
  const stripQuotes = (s: string): string => s.replace(/^["']+|["']+$/g, "");
  const hay = norm(commandLine);
  const hayTokens = commandLine.split(/\s+/).map((t) => norm(stripQuotes(t)));
  const tokens = argv.filter((t): t is string => typeof t === "string" && t.trim() !== "");
  if (tokens.length === 0) return false;
  return tokens.every((t) => {
    const n = norm(stripQuotes(t.trim()));
    if (n === "") return true;
    if (n.includes(" ")) return hay.includes(n);
    // An ABSOLUTE argv path is an exact claim: it must equal a command-line
    // token, or `C:\ComfyUI\main.py` would "match" a different instance at
    // `D:\Other\ComfyUI\main.py`. Only a RELATIVE token (`main.py`) may anchor
    // to a token's final path segment.
    const absolute = n.startsWith("/") || /^[a-z]:\//.test(n);
    if (absolute) return hayTokens.some((h) => h === n);
    return hayTokens.some((h) => h === n || h.endsWith("/" + n));
  });
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /** The port the connected ComfyUI listens on. */
  port: number;
  /** The HOST we talk to. Binds the lookup to the right listener when several
   *  instances share a port across different loopback/bind addresses. */
  host?: string;
  /** True when the server is REMOTE — no local process is it, so there is no
   *  ground truth to be had and we must report nothing. */
  remote: boolean;
  /** `/system_stats.argv` — the running server's OWN sys.argv. Tier 2 requires the
   *  process holding the port to have a command line consistent with this, so a
   *  proxy or forwarder on the same port can never be mistaken for ComfyUI. Without
   *  it there is nothing to correlate against and tier 2 fails closed. */
  serverArgv?: string[];
  /** Test seams. */
  findPid?: (port: number, host?: string) => number | null;
  readIdentity?: (pid: number) => ProcessIdentity | undefined;
}

/** What the OS could establish about the ComfyUI holding our port. TWO readings,
 *  because they answer two different questions and one is routinely available when
 *  the other is not — see `image`. */
export interface LiveServerProcess {
  /** PID of the identified server process. */
  pid: number;
  /** The INTERPRETER answer (#401): argv[0] of the running process, when that is an
   *  absolute path that exists. Absent when argv[0] is relative or bare. */
  python?: string;
  /** How `python` was established. Absent exactly when `python` is. */
  source?: InterpreterSource;
  /**
   * The OS's OWN record of the running image (`Win32_Process.ExecutablePath`,
   * `/proc/<pid>/exe`), absolute and normalized — usable when argv[0] is NOT (#1374).
   *
   * A Windows launcher routinely spells the interpreter RELATIVELY: the stock
   * portable bundle runs `.\python_embeded\python.exe -s ComfyUI\main.py`, and a
   * shell with an activated venv runs a bare `python`. The command line the OS
   * records is that literal string, so argv[0] names no file we can probe and the
   * interpreter answer fails closed — correctly, because this field is NOT a
   * substitute for it: for a venv Windows reports the BASE interpreter the
   * trampoline loads (measured live: `…\standalone-env\python.exe` while argv[0] is
   * `…\ComfyUI\.venv\Scripts\python.exe`), whose site-packages are not the ones the
   * server imports.
   *
   * It IS an answer to the weaker question "where does this process live?", which is
   * all an install-root ANCHOR needs. Callers must use it only that way, and only
   * behind a containment test — a base interpreter that sits outside the install
   * simply fails it, so this reading can add a resolution but never redirect one.
   */
  image?: string;
}

/**
 * The interpreter the running ComfyUI is ACTUALLY using, or `undefined` when we
 * cannot observe it. Never infers from install layout.
 *
 * Both tiers demand a real process IDENTITY, not just a PID:
 *  - tier 1 requires the port owner to be the process we launched — same PID AND
 *    same creation time, because PIDs get recycled and an externally launched
 *    python could otherwise inherit our record;
 *  - tier 2 requires the port owner's command line to match the argv the SERVER
 *    itself reported, so a python reverse proxy sitting on the port cannot pass its
 *    own venv off as ComfyUI's.
 * Any missing signal fails closed to `undefined` — unknown is always acceptable, a
 * confidently wrong package list is the entire bug (#401).
 */
export function resolveLiveInterpreter(opts: ResolveOptions): LiveInterpreter | undefined {
  const observed = observeLiveServerProcess(opts);
  if (!observed?.python || !observed.source) return undefined;
  return { python: observed.python, source: observed.source, pid: observed.pid };
}

/**
 * The same single observation `resolveLiveInterpreter` makes, reported WITHOUT
 * collapsing it to the interpreter answer — so a caller that only needs to anchor an
 * install root still gets something when argv[0] cannot supply it (#1374).
 *
 * Identity is established exactly as before (the two tiers above); all that differs
 * is what is handed back. In particular the OS image is returned only AFTER the argv
 * correlation has passed, so a proxy on the port can no more contribute an anchor
 * than it can contribute an interpreter.
 */
export function observeLiveServerProcess(opts: ResolveOptions): LiveServerProcess | undefined {
  if (opts.remote) return undefined;
  const findPid = opts.findPid ?? findPidByPort;
  const readIdentity = opts.readIdentity ?? readProcessIdentity;

  let pid: number | null = null;
  try {
    pid = findPid(opts.port, opts.host);
  } catch {
    pid = null;
  }
  if (!pid) return undefined;

  let identity: ProcessIdentity | undefined;
  try {
    identity = readIdentity(pid);
  } catch {
    identity = undefined;
  }

  // The OS's own record of the image, normalized: Windows reports it verbatim from
  // the launch, so a relative spelling comes back as an absolute path that still
  // contains the `..` it was written with (measured: `…\ComfyUI\..\python_embeded\
  // python.exe`).
  const rawImage = identity?.executablePath;
  const image =
    rawImage && isAbsolute(rawImage) && existsSync(rawImage)
      ? pathResolve(rawImage)
      : undefined;

  // Tier 1 — the process we launched, confirmed by PID *and* start time.
  // The recorded interpreter must be ABSOLUTE: a bare `python` would be
  // re-resolved against OUR cwd/PATH at probe time, not necessarily the
  // interpreter the child actually spawned with — so a relative record fails
  // closed to tier 2.
  if (
    launchRecord &&
    launchRecord.pid === pid &&
    isAbsolute(launchRecord.python) &&
    existsSync(launchRecord.python)
  ) {
    // macOS `ps lstart` is SECOND-resolution: a PID recycled within the same
    // second compares equal. On that platform the timestamp alone is not an
    // identity, so the observed command line must also corroborate the recorded
    // interpreter; anywhere the stamp is sub-second (Linux ticks, Windows
    // FileTime) equality already is proof.
    const coarseStamp = platform() === "darwin";
    const corroborated =
      !coarseStamp ||
      commandLineMatchesArgv(identity?.commandLine, [launchRecord.python]);
    if (
      launchRecord.startedAt &&
      identity?.startedAt &&
      launchRecord.startedAt === identity.startedAt &&
      corroborated
    ) {
      return { python: launchRecord.python, source: "launched-by-us", pid, image };
    }
    // Same PID, different (or unreadable) start time → this is NOT our process, or
    // we cannot prove it is. Fall through to tier 2 rather than trust the record.
    logger.info("Ignoring the launch record: process identity could not be confirmed", {
      pid,
      recorded: launchRecord.startedAt ?? "(unavailable)",
      observed: identity?.startedAt ?? "(unavailable)",
    });
  }

  // Tier 2 — the OS process table, correlated against the server's own argv.
  if (!commandLineMatchesArgv(identity?.commandLine, opts.serverArgv)) return undefined;

  // A relative or bare argv[0] ("python", "./python") does not identify a file we
  // can probe — the process's cwd is not ours. Only an absolute path that exists
  // is usable; anything else is honestly unknown as an INTERPRETER. The OS image
  // still travels with the result for the weaker anchor question (#1374).
  const rawArgv0 = argv0FromCommandLine(identity?.commandLine ?? "");
  const argv0 =
    rawArgv0 && isAbsolute(rawArgv0) && existsSync(rawArgv0) ? rawArgv0 : undefined;

  // Prefer the venv the process itself recorded. After a macOS Python.app re-exec,
  // argv[0] is the Homebrew/framework BASE interpreter — it exists, versions match
  // the venv by construction, and probing it reports torch/Triton missing while
  // /system_stats shows they are there (#401 recurrence, 0.52.1).
  //
  // Resolved HERE, with argv[0] in hand, because `VIRTUAL_ENV` is only meaningful
  // beside it: inherited from an activating shell, it names a venv this process may
  // have nothing to do with, and letting that displace a good argv[0] would re-file
  // #401 on machines that never had it. `venvPython` remains honoured when a caller
  // supplied one directly.
  const fromEnv = identity?.venvHints
    ? interpreterFromVenvHints(identity.venvHints, argv0)
    : identity?.venvPython;
  if (fromEnv && isAbsolute(fromEnv) && existsSync(fromEnv)) {
    return { python: fromEnv, source: "process-table", pid, image };
  }

  if (argv0) {
    return { python: argv0, source: "process-table", pid, image };
  }
  return { pid, image };
}
