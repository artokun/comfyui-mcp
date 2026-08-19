// `VIRTUAL_ENV` must never displace a usable argv[0] (#401).
//
// The 0.52.1 fix recovers the interpreter from the process's OWN environment. That is
// right for `__PYVENV_LAUNCHER__` — CPython writes it during this process's macOS
// framework re-exec, so it describes THIS interpreter. `VIRTUAL_ENV` is a statement
// about the SHELL: `activate` exports it and every descendant inherits it whatever
// interpreter it runs.
//
// A first attempt licensed it by asking whether the venv's `pyvenv.cfg` named argv[0]
// as its base. That answers "was this venv built FROM argv[0]?", which is NOT "is this
// process running IN that venv?" — and they come apart precisely when argv[0] is the
// system python, because every stock venv records exactly that interpreter as its
// base. Measured on Ubuntu 24.04:
//
//     VIRTUAL_ENV=/tmp/ve402 /usr/bin/python3 main.py
//     sys.executable                = /usr/bin/python3      <- NOT inside ve402
//     readlink -f /usr/bin/python3  = /usr/bin/python3.14
//     /tmp/ve402/pyvenv.cfg         executable = /usr/bin/python3.14   <- "matches"
//
// So the rule is positional: argv[0] wins whenever it is usable, and `VIRTUAL_ENV` is
// consulted only when argv[0] gave us nothing probeable. These tests pin that, and in
// particular pin the base-vs-venv shape that the path comparison let through.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  interpreterFromVenvHints,
  observeLiveServerProcess,
} from "../../services/live-interpreter.js";
import { TRITON_PROBE_SOURCE } from "../../services/env-capabilities.js";

const IS_WIN = process.platform === "win32";
const BIN = IS_WIN ? "Scripts" : "bin";
const PY = IS_WIN ? "python.exe" : "python";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "venv-hint-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A venv on disk, with the `pyvenv.cfg` a real `python -m venv` writes. */
async function makeVenv(name: string, base?: string): Promise<string> {
  const root = join(dir, name);
  await mkdir(join(root, BIN), { recursive: true });
  await writeFile(join(root, BIN, PY), "", "utf-8");
  if (base) {
    const sep = IS_WIN ? "\\" : "/";
    await writeFile(
      join(root, "pyvenv.cfg"),
      [
        `home = ${base.slice(0, base.lastIndexOf(sep))}`,
        "include-system-site-packages = false",
        "version = 3.14.4",
        `executable = ${base}`,
      ].join("\n"),
      "utf-8",
    );
  }
  return root;
}

/** An interpreter in its OWN directory, the way a real base install sits. */
async function makeExe(name: string): Promise<string> {
  const home = join(dir, `${name}-home`);
  await mkdir(home, { recursive: true });
  const p = join(home, name);
  await writeFile(p, "", "utf-8");
  return p;
}

describe("VIRTUAL_ENV never displaces a usable argv[0]", () => {
  it("REFUSES when argv[0] is the SYSTEM PYTHON the venv was built from (gate P0)", async () => {
    // The shape that defeated the pyvenv.cfg comparison: the process really is
    // running the base interpreter, and the inherited venv legitimately records that
    // same interpreter as its base. Nothing about the paths distinguishes this from
    // the case the override was meant for.
    const systemPython = await makeExe("python3");
    const inherited = await makeVenv("some-other-venv", systemPython);

    expect(interpreterFromVenvHints({ virtualEnv: inherited }, systemPython)).toBeUndefined();
  });

  it("REFUSES a venv the running interpreter has nothing to do with", async () => {
    const argv0 = await makeExe("real-comfy-python");
    const stale = await makeVenv("some-other-venv", await makeExe("unrelated-base"));

    expect(interpreterFromVenvHints({ virtualEnv: stale }, argv0)).toBeUndefined();
  });

  it("REFUSES when argv[0] is itself a venv interpreter", async () => {
    const running = await makeVenv("comfy-venv", await makeExe("shared-base"));
    const argv0 = join(running, BIN, PY);
    const stale = await makeVenv("other-venv", argv0);

    expect(interpreterFromVenvHints({ virtualEnv: stale }, argv0)).toBeUndefined();
  });

  it("uses the hint when argv[0] gave us nothing probeable", async () => {
    // A bare `python`, a relative spelling, or a path that no longer exists — the
    // hint displaces nothing here and beats returning undefined.
    const venv = await makeVenv("comfy-venv", await makeExe("some-base"));

    expect(interpreterFromVenvHints({ virtualEnv: venv }, undefined)).toBe(join(venv, BIN, PY));
    expect(interpreterFromVenvHints({ virtualEnv: venv }, "python")).toBe(join(venv, BIN, PY));
    expect(interpreterFromVenvHints({ virtualEnv: venv }, join(dir, "gone"))).toBe(
      join(venv, BIN, PY),
    );
  });

  it("leaves __PYVENV_LAUNCHER__ unconditional — CPython wrote it for THIS process", async () => {
    // The macOS framework re-exec: argv[0] is the base and IS usable, but the
    // launcher is a statement about this interpreter, so it still wins.
    const launcher = await makeExe("venv-python");
    const argv0 = await makeExe("framework-base-python");

    expect(interpreterFromVenvHints({ pyvenvLauncher: launcher }, argv0)).toBe(launcher);
  });
});

describe("the resolver keeps argv[0] when the environment names another venv", () => {
  const ARGV = ["main.py", "--port", "8188"];

  const observe = (commandLine: string, venvHints: Record<string, string>) =>
    observeLiveServerProcess({
      port: 8188,
      remote: false,
      serverArgv: ARGV,
      findPid: () => 4242,
      readIdentity: () => ({
        commandLine,
        argv: commandLine.split(" "),
        argvFidelity: "exact",
        venvHints,
      }),
    });

  it("does NOT hand back an inherited venv's python (#401 must not recur)", async () => {
    const systemPython = await makeExe("python3");
    const inherited = await makeVenv("inherited-venv", systemPython);

    const res = observe(`${systemPython} main.py --port 8188`, { virtualEnv: inherited });

    // Without the positional rule this returns join(inherited, BIN, PY) — a venv the
    // server never imported from, reported through the trusted process-table tier.
    expect(res?.python).toBe(systemPython);
    expect(res?.source).toBe("process-table");
  });

  it("still recovers the venv when argv[0] is not probeable", async () => {
    const venv = await makeVenv("comfy-venv", await makeExe("base"));

    const res = observe(`python main.py --port 8188`, { virtualEnv: venv });

    expect(res?.python).toBe(join(venv, BIN, PY));
  });
});

describe("the venv hints are actually WIRED to the OS read", () => {
  // The gate's supporting finding: deleting the production line that attaches
  // `venvHints` left 5165/5165 green, because every test injects them through the
  // `readIdentity` seam. A behavioural test cannot reach it here — `venvHintsFromPid`
  // short-circuits on Windows and needs a live foreign process elsewhere — so the
  // call site is asserted on the SOURCE, which is the only thing that can see it.
  const src = readFileSync(
    new URL("../../services/live-interpreter.ts", import.meta.url),
    "utf-8",
  );

  it("routes every readProcessIdentity return through withVenvPython", () => {
    const body = src.slice(
      src.indexOf("export function readProcessIdentity("),
      src.indexOf("export function readProcessArgv0("),
    );
    expect(body).not.toBe("");
    // Windows, Linux and the macOS `ps` paths each build an identity, plus the
    // unparsed-`ps` fallback: all of them must attach the hints.
    const attached = body.match(/withVenvPython\(/g) ?? [];
    expect(attached.length).toBeGreaterThanOrEqual(4);
    // and no return path may construct an identity object directly
    expect(body).not.toMatch(/return\s*\{\s*commandLine/);
  });

  it("resolves the hints where argv[0] is known, not behind the OS read", () => {
    const resolver = src.slice(src.indexOf("export function observeLiveServerProcess("));
    expect(resolver).toContain("interpreterFromVenvHints(identity.venvHints, argv0)");
  });
});

describe("the capability probe never imports torch", () => {
  // A NEGATIVE guarantee, so it is asserted on the source: no behavioural test can
  // notice a future edit that puts the import back, and the cost of that edit is not
  // a slow probe but a SILENT one. `probeTritonSage` runs under a 5s budget and
  // CPython block-buffers stdout when it is a pipe, so a torch import that overruns
  // takes the already-computed triton/sageattention lines down with it and every
  // answer degrades to "unknown".
  //
  // Measured on an RTX box, warm: `import torch` 1.89s (38% of the whole budget)
  // against 0.043s for `importlib.metadata.version('torch')` — and both return the
  // identical string "2.10.0+cu130".
  it("reads the version from dist metadata, not from the module", () => {
    expect(TRITON_PROBE_SOURCE).toContain("importlib.metadata");
    expect(TRITON_PROBE_SOURCE).toContain("md.version('torch')");
    expect(TRITON_PROBE_SOURCE).not.toContain("__import__('torch')");
    expect(TRITON_PROBE_SOURCE).not.toMatch(/^\s*import torch\b/m);
  });

  it("still answers triton and sageattention without consulting torch", () => {
    expect(TRITON_PROBE_SOURCE).toContain("u.find_spec('triton')");
    expect(TRITON_PROBE_SOURCE).toContain("u.find_spec('sageattention')");
    expect(TRITON_PROBE_SOURCE).not.toContain("__import__('triton')");
  });
});
