// #1259 — a relaunch that exits 1 said nothing about WHY.
//
// A Stability Matrix ComfyUI was stopped, its managed relaunch exited code 1,
// and the whole report was:
//
//   ComfyUI process was launched, but no readiness probe got a healthy response
//   in 59626ms. The process this call launched EXITED (exit code 1).
//
// The user was left offline with an exit code and nothing else — and the process
// had already printed the reason, into `stdio: "ignore"`. An exit code alone is
// the least actionable thing a failed launch can report.
//
// A FILE, not a pipe. The child is `detached` and expected to outlive us, so
// piping means either draining forever or closing a descriptor the server may
// still write to — and a closed pipe is an EPIPE that would kill a server which
// was starting fine. A file descriptor stays valid whatever happens to this
// process, which is what `"ignore"` was buying and what this had to keep.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HF = "hf_aBcD3fGh1jKlMnOpQrStUvWxYz";

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return {
    ...actual,
    getComfyUIAuthHeaders: () => ({}),
    config: { ...actual.config, huggingfaceToken: HF },
  };
});

const { describeLaunchLog, openLaunchLog } = await import("../../services/process-control.js");

let dataDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "launchlog-"));
  savedDataDir = process.env.COMFYUI_MCP_DATA_DIR;
  process.env.COMFYUI_MCP_DATA_DIR = dataDir;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.COMFYUI_MCP_DATA_DIR;
  else process.env.COMFYUI_MCP_DATA_DIR = savedDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

/** Write a log the way the child would have, and describe it. */
function described(lines: string[]): string {
  const path = join(dataDir, "fake.log");
  writeFileSync(path, lines.join("\n"));
  return describeLaunchLog(path);
}

describe("describeLaunchLog (#1259)", () => {
  it("reports what the child printed, which is the whole point", () => {
    const out = described([
      "Traceback (most recent call last):",
      '  File "main.py", line 12, in <module>',
      "ModuleNotFoundError: No module named 'torch'",
    ]);

    expect(out).toContain("ModuleNotFoundError");
    expect(out, "and where the rest of it is").toContain("Full log:");
  });

  it("distinguishes an EMPTY log from a missing one — they mean different things", () => {
    // Nothing printed means it died before ComfyUI's own startup produced output,
    // which points at the command or its environment rather than at ComfyUI. That
    // is a real finding, not an absence of one.
    const out = described([]);

    expect(out).toMatch(/printed NOTHING/);
    expect(out).toMatch(/points at the command or its environment/);
  });

  it("says so plainly when the log cannot be read at all", () => {
    const out = describeLaunchLog(join(dataDir, "does-not-exist.log"));
    expect(out).toMatch(/could not be read back/);
    // It must NOT claim the child printed nothing — that is the other case.
    expect(out).not.toMatch(/printed NOTHING/);
  });

  it("stays silent when there is no log path at all", () => {
    // Opening the log is best-effort; its absence must not add noise to a failure
    // that is already being reported.
    expect(describeLaunchLog(undefined)).toBe("");
  });

  it("BOUNDS the tail so a chatty startup cannot flood a tool result", () => {
    const out = described(Array.from({ length: 500 }, (_, i) => `line ${i}`));

    expect(out).toContain("line 499"); // the end, which is where the error is
    expect(out).not.toContain("line 0"); // not the beginning
    expect(out, "and it says what it left out").toMatch(/last \d+ of 500 lines/);
  });

  it("SCRUBS the output — a launcher line can carry a credential", () => {
    // This text goes into a tool result, so it goes through the same redactor as
    // every other log this project surfaces (#1206/#1223).
    const out = described([`fetching https://hf.co/m.safetensors?token=${HF}`]);
    expect(out).not.toContain(HF);
  });
});

describe("openLaunchLog (#1259)", () => {
  const cmd = { exe: "C:/py/python.exe", args: ["main.py", "--port", "8188"], cwd: "C:/comfy" };

  it("records the command FIRST, so an exec failure still leaves evidence", () => {
    // A command that cannot exec prints nothing at all. Without this header the
    // log would be empty and the report would have no more than before.
    const opened = openLaunchLog(cmd);
    expect(opened).toBeTruthy();

    const out = describeLaunchLog(opened!.path);
    expect(out).toContain("python.exe");
    expect(out).toContain("--port");
    expect(out, "the cwd matters when a relative argv[0] fails").toContain("C:/comfy");
  });

  it("names an inherited cwd rather than leaving the field blank", () => {
    const opened = openLaunchLog({ exe: "python", args: [] });
    expect(describeLaunchLog(opened!.path)).toContain("(inherited)");
  });

  it("gives consecutive launches DIFFERENT files", () => {
    // A failed launch's log must not be overwritten by the retry that follows it,
    // which is the log someone actually wants to read.
    const a = openLaunchLog(cmd);
    vi.setSystemTime(new Date(Date.now() + 1500));
    const b = openLaunchLog(cmd);
    expect(a?.path).not.toBe(b?.path);
    vi.useRealTimers();
  });

  it("returns undefined rather than throwing when the directory is unusable", () => {
    // A diagnostic must never be the reason a server does not come back up.
    //
    // The data dir points at a path whose PARENT is a regular file, so the mkdir
    // fails with ENOTDIR. The first version of this used "\0not-a-path", which
    // Node silently truncates to "" on assignment — the env var then read as
    // unset, fell back to a perfectly good home, and the test passed for the
    // wrong reason. That truncation is written down in this repo's own test-home
    // isolation notes, and it still caught me.
    const blocker = join(dataDir, "i-am-a-file");
    writeFileSync(blocker, "not a directory");
    process.env.COMFYUI_MCP_DATA_DIR = join(blocker, "nested");

    expect(openLaunchLog(cmd)).toBeUndefined();
  });

  it("PRUNES old logs so the directory does not grow forever", () => {
    // Written on every relaunch, and nothing else ever deletes them.
    const dir = join(dataDir, "launch-logs");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(dir, `comfyui-launch-2026-01-01T00-00-${String(i).padStart(2, "0")}.log`), "x");
    }
    openLaunchLog(cmd);

    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const left = readdirSync(dir).filter((f) => f.startsWith("comfyui-launch-"));
    expect(left.length).toBeLessThanOrEqual(11);
  });
});

// THE WIRING. Every test above passes with the spawn still using `stdio:"ignore"`
// and the failure message never mentioning the log — which IS the bug. Reaching
// the real spawn needs a launchable ComfyUI, so the two connections are asserted
// at the source, the way this repo pins other call-site-blind wiring.
describe("the launch actually uses the log (#1259)", () => {
  it("the spawn redirects stdout/stderr into it, and falls back to ignore", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../services/process-control.ts", import.meta.url),
      "utf-8",
    );

    const stdio = src.split("\n").find((l) => l.includes("stdio: launchLog"));
    expect(stdio, "the spawn must point at the log").toBeTruthy();
    expect(stdio).toMatch(/launchLog\.fd/);
    // A log that cannot be opened must not stop the launch.
    expect(stdio, "and degrade to the old behaviour").toMatch(/: "ignore"/);
  });

  it("the failure message includes it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../services/process-control.ts", import.meta.url),
      "utf-8",
    );
    expect(
      src.includes("describeLaunchLog(launched.launchLogPath)"),
      "a captured log nobody reports is the same as no log",
    ).toBe(true);
  });
});
