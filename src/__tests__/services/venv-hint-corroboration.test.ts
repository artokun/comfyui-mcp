// A stale VIRTUAL_ENV must not be allowed to re-file #401.
//
// The 0.52.1 fix recovers the interpreter from the process's OWN environment, which
// is right for `__PYVENV_LAUNCHER__` — CPython writes it during this process's macOS
// framework re-exec, so it describes THIS interpreter. `VIRTUAL_ENV` is different in
// kind: `activate` exports it and every child inherits it whatever interpreter that
// child turns out to be. Measured:
//
//   $ VIRTUAL_ENV=/tmp/ve401 python -c "import sys,os; print(sys.executable)"
//   sys.executable = C:\Users\A\miniconda3\python.exe     <- what it really imports
//   VIRTUAL_ENV    = /tmp/ve401                           <- an unrelated venv
//
// So letting it displace a usable argv[0] would report packages off an interpreter
// the server never loaded — the original bug, newly reachable on a machine that
// never had it. These tests pin the asymmetry.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  interpreterFromVenvHints,
  observeLiveServerProcess,
  venvBaseInterpreters,
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

/** Build a venv on disk whose pyvenv.cfg names `base` as the interpreter it was
 *  created from — the real layout, as measured on a `python -m venv` result. */
async function makeVenv(name: string, base?: string): Promise<string> {
  const root = join(dir, name);
  await mkdir(join(root, BIN), { recursive: true });
  const exe = join(root, BIN, PY);
  await writeFile(exe, "", "utf-8");
  if (base) {
    await writeFile(
      join(root, "pyvenv.cfg"),
      [
        `home = ${base.slice(0, base.lastIndexOf(IS_WIN ? "\\" : "/"))}`,
        "include-system-site-packages = false",
        "version = 3.12.13",
        `executable = ${base}`,
      ].join("\n"),
      "utf-8",
    );
  }
  return root;
}

/** An interpreter in its OWN directory, the way a real base install sits — so a
 *  test can never pass merely because two fixtures share a parent. */
async function makeExe(name: string): Promise<string> {
  const home = join(dir, `${name}-home`);
  await mkdir(home, { recursive: true });
  const p = join(home, name);
  await writeFile(p, "", "utf-8");
  return p;
}

describe("VIRTUAL_ENV may only displace argv[0] when the venv says argv[0] is its base", () => {
  it("REFUSES a venv the running interpreter has nothing to do with", async () => {
    // The activated-shell case: ComfyUI launched by explicit absolute path, while an
    // unrelated venv is active in the environment it inherited.
    const argv0 = await makeExe("real-comfy-python");
    const stale = await makeVenv("some-other-venv", await makeExe("unrelated-base"));

    expect(interpreterFromVenvHints({ virtualEnv: stale }, argv0)).toBeUndefined();
  });

  it("ACCEPTS the venv whose pyvenv.cfg names argv[0] as its base", async () => {
    // The macOS Python.app shape: argv[0] IS the base this venv was built from.
    const base = await makeExe("homebrew-base-python");
    const venv = await makeVenv("comfy-venv", base);

    expect(interpreterFromVenvHints({ virtualEnv: venv }, base)).toBe(join(venv, BIN, PY));
  });

  it("uses the hint when there is no usable argv[0] to contradict it", async () => {
    // A bare `python` argv[0] names no file we can probe, so the hint is the only
    // observation available and is strictly better than nothing.
    const venv = await makeVenv("comfy-venv", await makeExe("some-base"));

    expect(interpreterFromVenvHints({ virtualEnv: venv }, undefined)).toBe(join(venv, BIN, PY));
    expect(interpreterFromVenvHints({ virtualEnv: venv }, "python")).toBe(join(venv, BIN, PY));
  });

  it("leaves __PYVENV_LAUNCHER__ unconditional — CPython wrote it for THIS process", async () => {
    // The framework re-exec case must keep working even though argv[0] (the base)
    // is unrelated to the launcher path by construction.
    const launcher = await makeExe("venv-python");
    const argv0 = await makeExe("framework-base-python");

    expect(interpreterFromVenvHints({ pyvenvLauncher: launcher }, argv0)).toBe(launcher);
  });

  it("REFUSES to displace an argv[0] that is itself a venv interpreter", async () => {
    // On POSIX a venv's bin/python is a SYMLINK to the base it was built from, so
    // resolving argv[0] collapses it onto that base — and a second venv built from
    // the same interpreter then records exactly that path as its `executable`, so
    // the two compare EQUAL and the base check licenses the override. Symlinks are
    // not available on this platform, so the collapsed state is expressed directly:
    // the stale venv names argv[0] itself as its base, which is what the comparison
    // sees after resolution on the platforms where this code runs.
    //
    // The guard answers the question without going through paths at all: argv[0]
    // has its own pyvenv.cfg, so it is already a venv interpreter and there is no
    // base interpreter to recover from.
    const running = await makeVenv("comfy-venv", await makeExe("shared-base-python"));
    const argv0 = join(running, BIN, PY);
    const stale = await makeVenv("other-venv", argv0);

    // Sanity: without the guard this is precisely the corroborated shape.
    expect(venvBaseInterpreters(stale)).toContain(argv0);
    expect(interpreterFromVenvHints({ virtualEnv: stale }, argv0)).toBeUndefined();
  });

  it("reads the base interpreter a real pyvenv.cfg records", async () => {
    const base = await makeExe("base-python");
    const venv = await makeVenv("v", base);
    expect(venvBaseInterpreters(venv)).toContain(base);
    expect(venvBaseInterpreters(join(dir, "not-a-venv"))).toEqual([]);
  });
});

describe("the resolver keeps argv[0] when the environment's venv is stale", () => {
  const ARGV = ["main.py", "--port", "8188"];

  it("does NOT hand back an unrelated venv's python (#401 must not recur)", async () => {
    const argv0 = await makeExe("comfy-python");
    const stale = await makeVenv("stale-venv", await makeExe("unrelated-base"));

    const res = observeLiveServerProcess({
      port: 8188,
      remote: false,
      serverArgv: ARGV,
      findPid: () => 4242,
      readIdentity: () => ({
        commandLine: `${argv0} main.py --port 8188`,
        argv: [argv0, ...ARGV],
        argvFidelity: "exact",
        venvHints: { virtualEnv: stale },
      }),
    });

    // Without the corroboration this returns join(stale, BIN, PY) — a venv the
    // server never imported from, reported as trusted.
    expect(res?.python).toBe(argv0);
  });

  it("still recovers the venv when argv[0] is the base it was built from", async () => {
    const base = await makeExe("homebrew-base");
    const venv = await makeVenv("comfy-venv", base);

    const res = observeLiveServerProcess({
      port: 8188,
      remote: false,
      serverArgv: ARGV,
      findPid: () => 4242,
      readIdentity: () => ({
        commandLine: `${base} main.py --port 8188`,
        argv: [base, ...ARGV],
        argvFidelity: "exact",
        venvHints: { virtualEnv: venv },
      }),
    });

    expect(res?.python).toBe(join(venv, BIN, PY));
    expect(res?.source).toBe("process-table");
  });
});

describe("the capability probe never imports torch", () => {
  // A NEGATIVE guarantee, so it is asserted on the source: no behavioural test can
  // notice a future edit that quietly puts the import back, and the cost of that
  // edit is not a slow probe but a SILENT one. `probeTritonSage` runs under a 5s
  // budget and CPython block-buffers stdout when it is a pipe, so a torch import
  // that overruns takes the already-computed triton/sageattention lines down with
  // it and every answer degrades to "unknown".
  //
  // Measured on an RTX box, warm: `import torch` 1.89s (38% of the whole budget),
  // `importlib.metadata.version('torch')` 0.043s — and both return the identical
  // string "2.10.0+cu130".
  it("reads the version from dist metadata, not from the module", () => {
    expect(TRITON_PROBE_SOURCE).toContain("importlib.metadata");
    expect(TRITON_PROBE_SOURCE).toContain("md.version('torch')");
    expect(TRITON_PROBE_SOURCE).not.toContain("__import__('torch')");
    expect(TRITON_PROBE_SOURCE).not.toMatch(/^\s*import torch\b/m);
  });

  it("still answers triton and sageattention without consulting torch", () => {
    expect(TRITON_PROBE_SOURCE).toContain("u.find_spec('triton')");
    expect(TRITON_PROBE_SOURCE).toContain("u.find_spec('sageattention')");
    // find_spec, not import: locating a module must not execute it.
    expect(TRITON_PROBE_SOURCE).not.toContain("__import__('triton')");
  });
});
