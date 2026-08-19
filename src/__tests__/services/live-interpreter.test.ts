import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  argv0FromCommandLine,
  commandLineMatchesArgv,
  interpreterFromVenvHints,
  recordLaunchedInterpreter,
  clearLaunchedInterpreter,
  getLaunchedInterpreterRecord,
  observeLiveServerProcess,
  resolveLiveInterpreter,
  venvHintsFromEnvironBuffer,
  venvHintsFromProcArgs2,
} from "../../services/live-interpreter.js";

/** ComfyUI Desktop's real shape, as measured on the machine that filed #401. */
const COMFY_ARGV = [
  "ComfyUI\\main.py",
  "--feature-flag",
  "show_signin_button=true",
  "--enable-manager",
  "--extra-model-paths-config",
  "C:\\Users\\A\\AppData\\Roaming\\Comfy Desktop\\shared_model_paths.yaml",
];

let dir: string;
beforeEach(async () => {
  clearLaunchedInterpreter();
  dir = await mkdtemp(join(tmpdir(), "comfyui-live-"));
});
afterEach(async () => {
  clearLaunchedInterpreter();
  await rm(dir, { recursive: true, force: true });
});

async function makeExe(name: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, "", "utf-8");
  return p;
}

describe("argv0FromCommandLine", () => {
  it("takes the first token of an unquoted command line", () => {
    expect(argv0FromCommandLine("/usr/bin/python3 main.py --port 8188")).toBe("/usr/bin/python3");
  });

  it("honors a QUOTED interpreter path containing spaces", () => {
    // The Windows shape that a naive whitespace split would truncate.
    expect(
      argv0FromCommandLine('"C:\\Program Files\\ComfyUI\\.venv\\Scripts\\python.exe" -s main.py'),
    ).toBe("C:\\Program Files\\ComfyUI\\.venv\\Scripts\\python.exe");
  });

  it("returns undefined for empty or unterminated input", () => {
    expect(argv0FromCommandLine("")).toBeUndefined();
    expect(argv0FromCommandLine("   ")).toBeUndefined();
    expect(argv0FromCommandLine('"C:\\unterminated')).toBeUndefined();
  });
});

describe("commandLineMatchesArgv — correlate the process against the server's own argv", () => {
  const comfyCmd =
    'C:\\ComfyUI\\.venv\\Scripts\\python.exe -s ComfyUI\\main.py --feature-flag show_signin_button=true ' +
    '--enable-manager --extra-model-paths-config "C:\\Users\\A\\AppData\\Roaming\\Comfy Desktop\\shared_model_paths.yaml"';

  it("matches the real ComfyUI command line against its reported argv", () => {
    expect(commandLineMatchesArgv(comfyCmd, COMFY_ARGV)).toBe(true);
  });

  it("does NOT match a python reverse PROXY sitting on the same port", () => {
    // The P1 hazard: a proxy on 127.0.0.1:8188 forwarding to the real ComfyUI. Same
    // python family, different program — its argv shares nothing with ComfyUI's.
    const proxyCmd = "C:\\proxies\\.venv\\Scripts\\python.exe -m myproxy --listen 8188 --upstream 8189";
    expect(commandLineMatchesArgv(proxyCmd, COMFY_ARGV)).toBe(false);
  });

  it("does NOT match a DIFFERENT ComfyUI instance launched with other arguments", () => {
    const otherCmd = "C:\\Other\\.venv\\Scripts\\python.exe -s ComfyUI\\main.py --listen 0.0.0.0";
    expect(commandLineMatchesArgv(otherCmd, COMFY_ARGV)).toBe(false);
  });

  it("fails closed when the argv or the command line is missing/empty", () => {
    expect(commandLineMatchesArgv(comfyCmd, undefined)).toBe(false);
    expect(commandLineMatchesArgv(comfyCmd, [])).toBe(false);
    expect(commandLineMatchesArgv(undefined, COMFY_ARGV)).toBe(false);
    expect(commandLineMatchesArgv("", COMFY_ARGV)).toBe(false);
  });

  it("does NOT let an ABSOLUTE argv path anchor to a different instance's absolute path", () => {
    // Two local installs, both with ComfyUI\main.py: an absolute argv[0] is an
    // exact claim and must not suffix-match the other instance's root.
    const argv = ["C:\\ComfyUI\\main.py", "--port", "8188"];
    const otherInstance = "D:\\Other\\ComfyUI\\main.py --port 8188";
    expect(commandLineMatchesArgv(otherInstance, argv)).toBe(false);
  });

  it("tolerates the quoting the OS adds around paths containing spaces", () => {
    const argv = ["main.py", "--config", "/opt/my configs/models.yaml"];
    expect(commandLineMatchesArgv('/usr/bin/python3 main.py --config "/opt/my configs/models.yaml"', argv)).toBe(
      true,
    );
  });
});

describe("resolveLiveInterpreter — ground truth only (#401)", () => {
  it("returns the interpreter WE launched, when PID and start time both match", async () => {
    const exe = await makeExe("launched.exe");
    recordLaunchedInterpreter(4242, exe);
    const startedAt = getLaunchedInterpreterRecord()?.startedAt;

    const res = resolveLiveInterpreter({
      port: 8188,
      remote: false,
      findPid: () => 4242,
      readIdentity: () => ({ commandLine: `${exe} main.py`, startedAt }),
    });
    // On a platform where the start time is unreadable the tier fails closed, which
    // is the correct behavior — assert the identity-confirmed path only when we
    // actually captured a start time.
    if (startedAt) {
      expect(res).toEqual({ python: exe, source: "launched-by-us", pid: 4242 });
    } else {
      expect(res?.source).not.toBe("launched-by-us");
    }
  });

  it("REJECTS the launch record when the PID was REUSED by another process", async () => {
    const ours = await makeExe("ours.exe");
    recordLaunchedInterpreter(4242, ours);

    // Our child died; the OS handed 4242 to an unrelated python that grabbed the
    // port before cleanup ran. Same PID, DIFFERENT creation time → the stale
    // interpreter must not be served for the replacement server.
    const res = resolveLiveInterpreter({
      port: 8188,
      remote: false,
      serverArgv: COMFY_ARGV,
      findPid: () => 4242,
      readIdentity: () => ({
        commandLine: "/usr/bin/python3 -m someone_else",
        startedAt: "an-utterly-different-start-time",
      }),
    });
    expect(res).toBeUndefined();
  });

  it("fails closed when the launch record has NO start time to compare", async () => {
    const ours = await makeExe("ours2.exe");
    recordLaunchedInterpreter(4242, ours);
    // Simulate a platform that could not read a creation time at record OR read time.
    const res = resolveLiveInterpreter({
      port: 8188,
      remote: false,
      findPid: () => 4242,
      readIdentity: () => ({ commandLine: `${ours} main.py` }), // no startedAt
    });
    expect(res?.source).not.toBe("launched-by-us");
  });

  it("reads the interpreter from the OS when its command line matches the server's argv", async () => {
    const exe = await makeExe("desktop-venv.exe");
    const res = resolveLiveInterpreter({
      port: 8188,
      remote: false,
      serverArgv: COMFY_ARGV,
      findPid: () => 777,
      readIdentity: () => ({
        commandLine: `${exe} -s ${COMFY_ARGV.join(" ")}`,
        startedAt: "t1",
      }),
    });
    expect(res).toEqual({ python: exe, source: "process-table", pid: 777 });
  });

  it("returns UNKNOWN for a PROXY on the port whose command line does not match argv", async () => {
    // P1: the proxy's venv may lack Triton entirely. Reporting its packages as the
    // server's is exactly the false capability report #401 is about.
    const proxyExe = await makeExe("proxy-venv.exe");
    const res = resolveLiveInterpreter({
      port: 8188,
      remote: false,
      serverArgv: COMFY_ARGV,
      findPid: () => 999,
      readIdentity: () => ({
        commandLine: `${proxyExe} -m myproxy --listen 8188 --upstream 8189`,
        startedAt: "t1",
      }),
    });
    expect(res).toBeUndefined();
  });

  it("fails closed when the server reported NO argv to correlate against", async () => {
    const exe = await makeExe("some-python.exe");
    for (const serverArgv of [undefined, [] as string[]]) {
      expect(
        resolveLiveInterpreter({
          port: 8188,
          remote: false,
          serverArgv,
          findPid: () => 777,
          readIdentity: () => ({ commandLine: `${exe} -s ComfyUI/main.py`, startedAt: "t1" }),
        }),
      ).toBeUndefined();
    }
  });

  it("passes the HOST through to the port lookup", () => {
    let sawHost: string | undefined = "unset";
    resolveLiveInterpreter({
      port: 8188,
      host: "127.0.0.1",
      remote: false,
      serverArgv: COMFY_ARGV,
      findPid: (_p, host) => {
        sawHost = host;
        return null;
      },
      readIdentity: () => undefined,
    });
    expect(sawHost).toBe("127.0.0.1");
  });

  it("returns UNDEFINED when nothing is listening on the port", () => {
    expect(
      resolveLiveInterpreter({
        port: 8188,
        remote: false,
        serverArgv: COMFY_ARGV,
        findPid: () => null,
        readIdentity: () => ({ commandLine: "/usr/bin/python3 ComfyUI/main.py" }),
      }),
    ).toBeUndefined();
  });

  it("returns UNDEFINED for a REMOTE server (no local process is it)", async () => {
    const exe = await makeExe("local.exe");
    recordLaunchedInterpreter(1, exe);
    expect(
      resolveLiveInterpreter({
        port: 8188,
        remote: true,
        serverArgv: COMFY_ARGV,
        findPid: () => 1,
        readIdentity: () => ({ commandLine: `${exe} main.py`, startedAt: "t1" }),
      }),
    ).toBeUndefined();
  });

  it("returns UNDEFINED for a RELATIVE or bare argv[0] (it names no file we can probe)", () => {
    for (const exe of ["python", "./python"]) {
      expect(
        resolveLiveInterpreter({
          port: 8188,
          remote: false,
          serverArgv: ["main.py"],
          findPid: () => 5,
          readIdentity: () => ({ commandLine: `${exe} main.py`, startedAt: "t1" }),
        }),
      ).toBeUndefined();
    }
  });

  it("returns UNDEFINED when argv[0] is absolute but does not exist on disk", () => {
    const gone = join(dir, "gone.exe");
    expect(
      resolveLiveInterpreter({
        port: 8188,
        remote: false,
        serverArgv: ["main.py"],
        findPid: () => 5,
        readIdentity: () => ({ commandLine: `${gone} main.py`, startedAt: "t1" }),
      }),
    ).toBeUndefined();
  });

  it("never throws when the port lookup or the process read fails", () => {
    expect(
      resolveLiveInterpreter({
        port: 8188,
        remote: false,
        serverArgv: COMFY_ARGV,
        findPid: () => {
          throw new Error("netstat exploded");
        },
        readIdentity: () => undefined,
      }),
    ).toBeUndefined();

    expect(
      resolveLiveInterpreter({
        port: 8188,
        remote: false,
        serverArgv: COMFY_ARGV,
        findPid: () => 5,
        readIdentity: () => {
          throw new Error("wmi exploded");
        },
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #1374 — THE OS KNOWS WHERE THE PROCESS LIVES EVEN WHEN argv[0] DOES NOT SAY.
//
// A LOCAL Windows install could not download anything: every attempt was routed to
// ComfyUI-Manager and died on "Manager's queue API is not reachable". The route is
// chosen when no local models directory can be resolved, and the tier built for the
// relative-`main.py` shape re-anchors that path on the interpreter the OS reports —
// but it fails closed on a RELATIVE argv[0], which is exactly how the stock Windows
// portable bundle launches (`.\python_embeded\python.exe -s ComfyUI\main.py`) and
// how an activated venv launches (a bare `python`). Measured on Windows 11: the
// command line the OS records is the literal launch string, so argv[0] comes back
// relative, while `Win32_Process.ExecutablePath` is absolute for the same process.
//
// Failing closed is RIGHT for the interpreter question (#401) and wrong for the
// anchor question, so the two answers are now reported separately rather than one
// being widened.
// ---------------------------------------------------------------------------
describe("observeLiveServerProcess — the OS image survives a relative argv[0] (#1374)", () => {
  it("reports NO interpreter but DOES report the image for a relative argv[0]", async () => {
    const exe = await makeExe("python.exe");
    const opts = {
      port: 8188,
      remote: false,
      serverArgv: ["main.py"],
      findPid: () => 5,
      // The portable shape: a relative interpreter on the command line, and the OS's
      // own absolute record of the same binary.
      readIdentity: () => ({
        commandLine: ".\\python_embeded\\python.exe main.py",
        executablePath: exe,
        startedAt: "t1",
      }),
    };
    // The #401 line holds: nothing that could be mistaken for the interpreter.
    expect(resolveLiveInterpreter(opts)).toBeUndefined();
    expect(observeLiveServerProcess(opts)).toEqual({ pid: 5, image: exe });
  });

  it("NORMALIZES the image — Windows records it exactly as the launcher wrote it", async () => {
    // Measured: a process launched as `..\python_embeded\python.exe` reports
    // `…\ComfyUI\..\python_embeded\python.exe` — absolute, but not yet a path an
    // install-root ascent can walk.
    const exe = await makeExe("python.exe");
    // Assembled with `sep`, NOT join(): join() collapses the `..` itself, so the
    // fixture would already be normalized and the assertion would pass with the
    // normalization deleted (it did — caught by mutating pathResolve away).
    await mkdir(join(dir, "sub"), { recursive: true }); // POSIX stat() walks it for real
    const detoured = `${dir}${sep}sub${sep}..${sep}python.exe`;
    const res = observeLiveServerProcess({
      port: 8188,
      remote: false,
      serverArgv: ["main.py"],
      findPid: () => 5,
      readIdentity: () => ({
        commandLine: "python main.py",
        executablePath: detoured,
        startedAt: "t1",
      }),
    });
    expect(res).toEqual({ pid: 5, image: exe });
  });

  it("still carries the image alongside an interpreter it COULD read", async () => {
    const exe = await makeExe("venv-python.exe");
    const base = await makeExe("base-python.exe");
    const res = observeLiveServerProcess({
      port: 8188,
      remote: false,
      serverArgv: ["main.py"],
      findPid: () => 5,
      readIdentity: () => ({
        commandLine: `${exe} main.py`,
        executablePath: base,
        startedAt: "t1",
      }),
    });
    // The interpreter still wins for the #401 question; the image is the weaker
    // reading a caller may fall back to, never a replacement.
    expect(res).toEqual({ pid: 5, python: exe, source: "process-table", image: base });
  });

  it("reports NO image for a PROXY on the port — the correlation still gates it", async () => {
    const proxy = await makeExe("proxy-python.exe");
    expect(
      observeLiveServerProcess({
        port: 8188,
        remote: false,
        serverArgv: COMFY_ARGV,
        findPid: () => 999,
        readIdentity: () => ({
          commandLine: "python -m myproxy --listen 8188",
          executablePath: proxy,
          startedAt: "t1",
        }),
      }),
    ).toBeUndefined();
  });

  it("reports NO image when the OS gave none, or one that is relative / absent", () => {
    for (const executablePath of [undefined, ".\\python.exe", join(dir, "gone.exe")]) {
      expect(
        observeLiveServerProcess({
          port: 8188,
          remote: false,
          serverArgv: ["main.py"],
          findPid: () => 5,
          readIdentity: () => ({
            commandLine: "python main.py",
            executablePath,
            startedAt: "t1",
          }),
        }),
      ).toEqual({ pid: 5 });
    }
  });

  it("reports nothing at all for a REMOTE server", async () => {
    const exe = await makeExe("remote-python.exe");
    expect(
      observeLiveServerProcess({
        port: 8188,
        remote: true,
        serverArgv: ["main.py"],
        findPid: () => 5,
        readIdentity: () => ({ commandLine: "python main.py", executablePath: exe }),
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #401 recurrence 0.52.1 — macOS Homebrew / Python.app re-exec.
//
// argv[0] is the BASE interpreter (it exists; versions match the venv by
// construction). The venv path survives only in the process environment.
// Probing argv[0] reports torch/Triton missing while /system_stats shows them.
// ---------------------------------------------------------------------------
describe("venv env hints recover the interpreter Python.app hid (#401)", () => {
  it("reads only the two venv keys out of a Linux environ buffer", () => {
    const buf = Buffer.from(
      ["PATH=/usr/bin", "VIRTUAL_ENV=/opt/comfy/.venv", "SECRET=do-not-keep", "__PYVENV_LAUNCHER__=/opt/comfy/.venv/bin/python", ""].join(
        "\0",
      ),
    );
    expect(venvHintsFromEnvironBuffer(buf)).toEqual({
      pyvenvLauncher: "/opt/comfy/.venv/bin/python",
      virtualEnv: "/opt/comfy/.venv",
    });
  });

  it("parses kern.procargs2 envp after argc/argv padding", () => {
    const argv = ["/opt/homebrew/Cellar/python@3.12/Python.app/Contents/MacOS/Python", "main.py"];
    const env = [
      "HOME=/Users/a",
      "__PYVENV_LAUNCHER__=/Users/a/ComfyUI/.venv/bin/python",
      "VIRTUAL_ENV=/Users/a/ComfyUI/.venv",
    ];
    const argc = Buffer.alloc(4);
    argc.writeInt32LE(argv.length);
    const parts = [
      argc,
      Buffer.from("/opt/homebrew/bin/python3\0"),
      Buffer.from("\0"),
      ...argv.map((a) => Buffer.from(a + "\0")),
      Buffer.from("\0"),
      ...env.map((e) => Buffer.from(e + "\0")),
      Buffer.from("\0"),
    ];
    expect(venvHintsFromProcArgs2(Buffer.concat(parts))).toEqual({
      pyvenvLauncher: "/Users/a/ComfyUI/.venv/bin/python",
      virtualEnv: "/Users/a/ComfyUI/.venv",
    });
  });

  it("prefers an existing __PYVENV_LAUNCHER__ over VIRTUAL_ENV", async () => {
    const launcher = await makeExe("venv-python");
    const venvRoot = join(dir, "other-venv");
    expect(
      interpreterFromVenvHints({
        pyvenvLauncher: launcher,
        virtualEnv: venvRoot,
      }),
    ).toBe(launcher);
  });

  it("reconstructs python from VIRTUAL_ENV when the launcher path is gone", async () => {
    const bin = join(dir, ".venv", process.platform === "win32" ? "Scripts" : "bin");
    await mkdir(bin, { recursive: true });
    const exe = join(bin, process.platform === "win32" ? "python.exe" : "python");
    await writeFile(exe, "", "utf-8");
    expect(interpreterFromVenvHints({ virtualEnv: join(dir, ".venv") })).toBe(exe);
  });

  it("probes the venv python even when argv[0] is a real Homebrew base", async () => {
    const homebrew = await makeExe("homebrew-python");
    const venvPy = await makeExe("venv-python");
    const res = resolveLiveInterpreter({
      port: 8188,
      remote: false,
      serverArgv: ["main.py"],
      findPid: () => 77,
      readIdentity: () => ({
        commandLine: `${homebrew} main.py`,
        venvPython: venvPy,
        startedAt: "t1",
      }),
    });
    expect(res).toEqual({ python: venvPy, source: "process-table", pid: 77 });
    expect(res?.python).not.toBe(homebrew);
  });

  it("falls back to argv[0] when the venv hint names nothing on disk", async () => {
    const homebrew = await makeExe("homebrew-python");
    const res = resolveLiveInterpreter({
      port: 8188,
      remote: false,
      serverArgv: ["main.py"],
      findPid: () => 77,
      readIdentity: () => ({
        commandLine: `${homebrew} main.py`,
        venvPython: join(dir, "gone-venv-python"),
        startedAt: "t1",
      }),
    });
    expect(res).toEqual({ python: homebrew, source: "process-table", pid: 77 });
  });
});
