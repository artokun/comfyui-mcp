import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// #401 recurrence on 0.49.4 — a ComfyUI Desktop install with a uv-created .venv under
// --base-directory. The process-table probe resolved an interpreter, called it observed,
// and reported BOTH Triton and SageAttention "not installed" — while the server was
// running with --use-sage-attention, a flag ComfyUI cannot start with unless the module
// imports (it calls exit(-1) otherwise). Both packages were importable from the live venv.
//
// The version cross-check that was supposed to catch a wrong-environment probe cannot:
// a venv reports the SAME sys.version as the base interpreter it was created from, by
// construction. So "versions agree" carried no information in exactly the case that
// matters, and was read as corroboration.
//
// The property under test is not "special-case sageattention". It is: evidence that
// CONTRADICTS a probe invalidates the probe as a SOURCE, so every negative it produced is
// void — including the ones nothing happens to contradict. Triton is the package nothing
// contradicts, and Triton is the false negative that made an agent strip a user's working
// acceleration in the original report.

const resolveLiveInterpreterMock = vi.fn();
vi.mock("../../services/live-interpreter.js", () => ({
  resolveLiveInterpreter: (...a: unknown[]) => resolveLiveInterpreterMock(...a),
  // The same observation, uncollapsed (#1374). Stubbed alongside its wrapper so
  // nothing this file loads can reach the real netstat/WMI probe.
  observeLiveServerProcess: (...a: unknown[]) => resolveLiveInterpreterMock(...a),
}));

const comfyuiFetchMock = vi.fn();
vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: (...a: unknown[]) => comfyuiFetchMock(...a),
}));

const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...a: unknown[]) => execFileMock(...a) };
});

import {
  gatherEnvCapabilities,
  packagesProvenByServerArgv,
  contradictedPackage,
} from "../../services/env-capabilities.js";

const OBSERVED = { python: "C:/uv/python/cpython-3.13/python.exe", source: "process-table" as const, pid: 4242 };

/** /system_stats as ComfyUI 0.30 reports it, with the launch argv the reporter had. */
function statsPayload(argv: string[]): unknown {
  return {
    system: {
      os: "nt",
      python_version: "3.13.12 (main, Feb 12 2026, 00:38:53) [MSC v.1944 64 bit (AMD64)]",
      comfyui_version: "0.30.0",
      embedded_python: false,
      argv,
      cwd: "C:/ComfyUI",
    },
    devices: [{ name: "NVIDIA GeForce RTX 5090", type: "cuda", vram_total: 34359738368, vram_free: 1 }],
  };
}

/**
 * Make the import probe answer for the WRONG interpreter: nothing installed, but the
 * same python banner the server reports — the venv/base pair the version check cannot
 * tell apart.
 */
function probeSays(triton: boolean, sage: boolean, torch?: boolean): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (e: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const torchLine =
        torch === undefined
          ? ""
          : `torch ${torch ? "True" : "False"}\ntorch_version ${torch ? "2.4.0" : ""}\n`;
      cb(
        null,
        `python 3.13.12 (main, Feb 12 2026, 00:38:53) [MSC v.1944 64 bit (AMD64)]\n` +
          `triton ${triton ? "True" : "False"}\n` +
          `sageattention ${sage ? "True" : "False"}\n` +
          torchLine,
        "",
      );
      return { on: () => undefined };
    },
  );
}

describe("packagesProvenByServerArgv (pure)", () => {
  it("reads --use-sage-attention out of the server's own argv", () => {
    expect([...packagesProvenByServerArgv(["python", "main.py", "--use-sage-attention"])]).toEqual([
      "sageattention",
    ]);
  });

  it("requires the EXACT flag token and survives non-string argv entries", () => {
    // `--use-sage-attention` is an argparse store_true flag, so `=value` is not a
    // spelling it can have. Accepting one bought nothing and only widened what could be
    // mistaken for it — and this function's job is to assert a POSITIVE, where a
    // fabricated one tells an agent the acceleration is present when it is not.
    expect(
      packagesProvenByServerArgv(["main.py", "--use-sage-attention=auto", 7 as never]).size,
    ).toBe(0);
    expect(
      packagesProvenByServerArgv(["main.py", "--use-sage-attention", 7 as never]).has(
        "sageattention",
      ),
    ).toBe(true);
  });

  it("does not read a flag NAME appearing as another flag's VALUE as the flag itself", () => {
    // `--base-directory` takes a string. A directory literally spelled
    // `--use-sage-attention` is absurd, but it is the shape that turns a value into a
    // capability claim, and the claim is what an agent acts on.
    expect(
      packagesProvenByServerArgv([
        "main.py",
        "--base-directory=--use-sage-attention",
      ]).size,
    ).toBe(0);
  });

  it("does not normalise argv: a padded or case-variant token is not the flag", () => {
    // sys.argv is what argparse ITSELF parsed. `" --use-sage-attention "` and
    // `"--USE-SAGE-ATTENTION"` are tokens ComfyUI did not recognise, so the backend was
    // never enabled and nothing was proven — trimming or lower-casing here would
    // manufacture the positive out of a token that had no effect.
    expect(packagesProvenByServerArgv(["main.py", " --use-sage-attention "]).size).toBe(0);
    expect(packagesProvenByServerArgv(["main.py", "--USE-SAGE-ATTENTION"]).size).toBe(0);
    expect(packagesProvenByServerArgv(["main.py", "--Use-Sage-Attention"]).size).toBe(0);
  });

  it("claims nothing when the flag is absent, and never from a lookalike token", () => {
    expect(packagesProvenByServerArgv(["python", "main.py"]).size).toBe(0);
    expect(packagesProvenByServerArgv(["--no-use-sage-attention"]).size).toBe(0);
    expect(packagesProvenByServerArgv(undefined).size).toBe(0);
  });
});

describe("contradictedPackage (pure)", () => {
  const proven = new Set<"triton" | "sageattention">(["sageattention"]);

  it("flags a probe that calls a proven package absent", () => {
    expect(
      contradictedPackage({ triton: "not-installed", sageattention: "not-installed" }, proven),
    ).toBe("sageattention");
  });

  it("does not flag an agreeing probe, nor an honest 'unknown'", () => {
    expect(contradictedPackage({ triton: "not-installed", sageattention: "installed" }, proven)).toBeUndefined();
    expect(contradictedPackage({ triton: "installed", sageattention: "unknown" }, proven)).toBeUndefined();
    expect(contradictedPackage(undefined, proven)).toBeUndefined();
  });

  it("flags a probe that finds no torch while /system_stats reports pytorch", () => {
    expect(
      contradictedPackage(
        { triton: "not-installed", sageattention: "not-installed", torch: "not-installed" },
        new Set(),
        "2.12.1",
      ),
    ).toBe("torch");
  });

  it("does not flag an honest unknown torch, even when the server reports pytorch", () => {
    expect(
      contradictedPackage(
        { triton: "not-installed", sageattention: "not-installed", torch: "unknown" },
        new Set(),
        "2.12.1",
      ),
    ).toBeUndefined();
  });
});

describe("gatherEnvCapabilities — a contradicted probe cannot state ANY negative (#401)", () => {
  beforeEach(() => {
    resolveLiveInterpreterMock.mockReturnValue(OBSERVED);
    // /internal/logs (global fetch) supplies no positive marker — exactly what the
    // reporter observed on ComfyUI 0.30, so the log fallback cannot rescue this.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ entries: [] }) })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function serveStats(argv: string[]): void {
    comfyuiFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/system_stats")) {
        return { ok: true, json: async () => statsPayload(argv) };
      }
      return { ok: false, json: async () => ({}) };
    });
  }

  it("voids the UNCONTRADICTED negative too — Triton must not read as absent", async () => {
    serveStats(["python", "main.py", "--base-directory", "D:/comfy", "--use-sage-attention"]);
    probeSays(false, false);

    const caps = await gatherEnvCapabilities({
      comfyuiUrl: "http://127.0.0.1:8188",
      statsTimeoutMs: 50,
      tritonTimeoutMs: 50,
    });

    // The whole point: nothing contradicts triton, and triton is still voided, because
    // the SOURCE is discredited — not the individual datum.
    expect(caps.triton).toBe("unknown");
    expect(caps.triton).not.toBe("not-installed");
    // And the flag is a stronger observation than the probe, so it stands as a positive.
    expect(caps.sageattention).toBe("installed");
  });

  it("voids a contradicted probe's POSITIVES too, not only its negatives", async () => {
    // The wrong venv happens to have Triton. Passing that positive through would tell an
    // agent to enable triton kernels on a server that may not have them — the same false
    // capability report as #401 with the sign flipped. A witness caught being wrong is
    // not half-believed.
    serveStats(["python", "main.py", "--use-sage-attention"]);
    probeSays(true, false); // triton present in the probed env, sage absent (the lie)

    const caps = await gatherEnvCapabilities({
      comfyuiUrl: "http://127.0.0.1:8188",
      statsTimeoutMs: 50,
      tritonTimeoutMs: 50,
    });

    expect(caps.triton).toBe("unknown");
    expect(caps.triton).not.toBe("installed");
    // The genuinely observed positive survives — it comes from the server's own argv,
    // not from the discredited interpreter.
    expect(caps.sageattention).toBe("installed");
  });

  it("still lets an OBSERVED, uncontradicted probe state a negative", async () => {
    // The guard must not swallow every negative — an over-strict version of this fix
    // would make the capability line permanently useless.
    serveStats(["python", "main.py"]);
    probeSays(false, false);

    const caps = await gatherEnvCapabilities({
      comfyuiUrl: "http://127.0.0.1:8188",
      statsTimeoutMs: 50,
      tritonTimeoutMs: 50,
    });

    expect(caps.triton).toBe("not-installed");
    expect(caps.sageattention).toBe("not-installed");
  });

  it("reports the flag-proven package as installed even when the probe agrees it is there", async () => {
    serveStats(["python", "main.py", "--use-sage-attention"]);
    probeSays(true, true);

    const caps = await gatherEnvCapabilities({
      comfyuiUrl: "http://127.0.0.1:8188",
      statsTimeoutMs: 50,
      tritonTimeoutMs: 50,
    });

    expect(caps.sageattention).toBe("installed");
    expect(caps.triton).toBe("installed");
  });

  it("does not upgrade a package to installed from a flag the server was not given", async () => {
    // Guards the other direction: the positive must come from the server's OWN argv,
    // never from our own defaults or a lookalike.
    serveStats(["python", "main.py", "--use-flash-attention"]);
    probeSays(false, false);

    const caps = await gatherEnvCapabilities({
      comfyuiUrl: "http://127.0.0.1:8188",
      statsTimeoutMs: 50,
      tritonTimeoutMs: 50,
    });

    expect(caps.sageattention).toBe("not-installed");
  });

  it("voids Triton when the probe has no torch but /system_stats reports pytorch (#401)", async () => {
    // 0.52.1: Homebrew base, versions agree, no --use-sage-attention to contradict
    // anything, and the ENVIRONMENT banner said Triton is not installed. The
    // server's own pytorch_version is the observation that discredits the source.
    comfyuiFetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/system_stats")) {
        return {
          ok: true,
          json: async () => ({
            system: {
              os: "darwin",
              python_version: "3.12.13 (main, Feb 12 2026) [Clang 17.0.0]",
              comfyui_version: "0.27.0",
              pytorch_version: "2.12.1",
              embedded_python: false,
              argv: ["python", "main.py"],
            },
            devices: [{ name: "Apple M4 Max", type: "mps" }],
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });
    probeSays(false, false, false);

    const caps = await gatherEnvCapabilities({
      comfyuiUrl: "http://127.0.0.1:8188",
      statsTimeoutMs: 50,
      tritonTimeoutMs: 50,
    });

    expect(caps.torch).toBe("2.12.1");
    expect(caps.triton).toBe("unknown");
    expect(caps.triton).not.toBe("not-installed");
    expect(caps.sageattention).toBe("unknown");
    expect(caps.sageattention).not.toBe("not-installed");
  });
});
