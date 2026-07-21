// Unit tests for the Antigravity CLI backend (antigravity-backend.ts, issue #262).
//
// We cannot run the real `agy` here, so `node:child_process` is mocked: spawn()
// returns an in-process fake child whose scripted stdout/stderr/exit behavior is
// set per test. This exercises the real AntigravityBackend end-to-end: executable
// resolution (env override), spawn argv shaping (-p / -c / --model / skip-
// permissions), the stdout→delta→assistant→result event mapping, the terminal-
// result invariant on failures, interrupt, `agy models` parsing, and the
// merge-safe .agents/mcp_config.json writer.

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { AgentEvent, NeutralTurn } from "../../orchestrator/agent-backend.js";

const hoisted = vi.hoisted(() => ({
  spawns: [] as Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>,
  procs: [] as Array<Record<string, unknown>>,
  killed: [] as number[],
  // Scripted behavior for the NEXT spawned child(ren), consumed in order; the
  // last entry repeats.
  script: [] as Array<{ stdout?: string[]; stderr?: string; exit?: number | null; hang?: boolean }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");

  function spawnFake(cmd: string, args: string[], opts: Record<string, unknown>) {
    hoisted.spawns.push({ cmd, args, opts });
    const proc = new EventEmitter() as InstanceType<typeof EventEmitter> & Record<string, unknown>;
    proc.pid = 5000 + hoisted.procs.length;
    proc.exitCode = null;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.stdin = null;
    proc.kill = () => {
      if (proc.exitCode === null) {
        proc.exitCode = 1;
        proc.emit("exit", 1, "SIGTERM");
      }
      return true;
    };
    hoisted.procs.push(proc);
    const step = hoisted.script[Math.min(hoisted.procs.length - 1, hoisted.script.length - 1)] ?? {
      stdout: ["ok"],
      exit: 0,
    };
    if (!step.hang) {
      setTimeout(() => {
        for (const chunk of step.stdout ?? []) stdout.write(chunk);
        if (step.stderr) stderr.write(step.stderr);
        setTimeout(() => {
          if (proc.exitCode === null) {
            proc.exitCode = step.exit ?? 0;
            proc.emit("exit", step.exit ?? 0, null);
          }
        }, 5);
      }, 5);
    }
    return proc;
  }

  return {
    ...actual,
    spawn: vi.fn(spawnFake),
    // taskkill path on Windows — record the kill, and terminate the matching fake.
    spawnSync: vi.fn((cmd: string, args: string[]) => {
      if (/taskkill/i.test(cmd)) {
        const pid = Number(args[1]);
        hoisted.killed.push(pid);
        const proc = hoisted.procs.find((p) => p.pid === pid);
        if (proc && proc.exitCode === null) {
          proc.exitCode = 1;
          (proc as { emit: (ev: string, ...a: unknown[]) => void }).emit("exit", null, "SIGKILL");
        }
      }
      return { status: 0, stdout: "", stderr: "" };
    }),
  };
});

import {
  AntigravityBackend,
  agyMcpConfigPath,
  parseAgyModels,
  mergeAgyMcpConfig,
  resolveAgyBin,
} from "../../orchestrator/antigravity-backend.js";
import { backendReadiness } from "../../orchestrator/backend-readiness.js";

const FAKE_BIN = join(tmpdir(), "fake-agy", "agy.exe");

async function* channelOf(turns: NeutralTurn[]): AsyncGenerator<NeutralTurn> {
  for (const t of turns) yield t;
}

async function collect(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

let workDir: string;

beforeEach(() => {
  hoisted.spawns.length = 0;
  hoisted.procs.length = 0;
  hoisted.killed.length = 0;
  hoisted.script.length = 0;
  // killProcessTree has TWO platform paths: Windows shells out to `taskkill`
  // (mocked via spawnSync above), POSIX signals the process group with
  // process.kill(-pid). Only the Windows path was emulated, so on Linux/macOS
  // the fake child was never terminated and every interrupt test hung to the
  // 5s timeout — green on a Windows dev box, red on CI. Emulate the POSIX path
  // too so these tests assert the same behavior on every platform.
  vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
    const target = Math.abs(Number(pid)); // POSIX group kill passes -pid
    hoisted.killed.push(target);
    const proc = hoisted.procs.find((p) => p.pid === target);
    if (proc && proc.exitCode === null) {
      proc.exitCode = 1;
      (proc as { emit: (ev: string, ...a: unknown[]) => void }).emit("exit", null, "SIGKILL");
    }
    return true;
  }) as unknown as typeof process.kill);
  process.env.COMFYUI_MCP_ANTIGRAVITY_PATH = FAKE_BIN;
  delete process.env.COMFYUI_MCP_ANTIGRAVITY_PRINT_TIMEOUT;
  workDir = mkdtempSync(join(tmpdir(), "agy-test-"));
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_ANTIGRAVITY_PATH;
  rmSync(workDir, { recursive: true, force: true });
  vi.mocked(process.kill).mockRestore?.();
});

describe("parseAgyModels", () => {
  it("parses a plain list", () => {
    const models = parseAgyModels("gemini-3-pro\ngemini-3-flash\n");
    expect(models.map((m) => m.id)).toEqual(["gemini-3-pro", "gemini-3-flash"]);
  });

  it("parses a table with headers, markers and a default tag, default first", () => {
    const out = [
      "Available models:",
      "──────────────────",
      "  NAME              DESCRIPTION",
      "  gemini-3-flash    Fast",
      "* gemini-3-pro      Most capable (default)",
      "",
    ].join("\n");
    const models = parseAgyModels(out);
    expect(models.map((m) => m.id)).toEqual(["gemini-3-pro", "gemini-3-flash"]);
  });

  it("strips ANSI colors and ignores prose", () => {
    const out = "[32mgemini-3-pro[0m\nUse `agy --model <name>` to select.\n";
    expect(parseAgyModels(out).map((m) => m.id)).toEqual(["gemini-3-pro"]);
  });

  it("returns [] for garbage", () => {
    expect(parseAgyModels("Something went wrong.\nPlease sign in.")).toEqual([]);
  });
});

describe("mergeAgyMcpConfig", () => {
  const servers = {
    comfyui: { transport: "stdio" as const, command: "node", args: ["mcp.js"], env: { A: "1" } },
    panel: { transport: "http" as const, url: "http://127.0.0.1:9181/tab" },
  };

  it("creates a fresh mcpServers wrapper", () => {
    const merged = JSON.parse(mergeAgyMcpConfig(null, servers));
    expect(merged.mcpServers.comfyui).toEqual({ command: "node", args: ["mcp.js"], env: { A: "1" } });
    expect(merged.mcpServers.panel).toEqual({ serverUrl: "http://127.0.0.1:9181/tab" });
  });

  it("preserves the user's existing entries and unknown top-level keys", () => {
    const existing = JSON.stringify({
      mcpServers: { github: { command: "gh-mcp", args: [], env: {} } },
      otherSetting: true,
    });
    const merged = JSON.parse(mergeAgyMcpConfig(existing, servers));
    expect(merged.mcpServers.github).toEqual({ command: "gh-mcp", args: [], env: {} });
    expect(merged.otherSetting).toBe(true);
    expect(merged.mcpServers.comfyui.command).toBe("node");
  });

  it("keeps a bare (wrapper-less) layout when the user's file uses one", () => {
    const existing = JSON.stringify({ github: { command: "gh-mcp" } });
    const merged = JSON.parse(mergeAgyMcpConfig(existing, servers));
    expect(merged.mcpServers).toBeUndefined();
    expect(merged.github).toEqual({ command: "gh-mcp" });
    expect(merged.comfyui.command).toBe("node");
  });
});

describe("resolveAgyBin / readiness", () => {
  it("honors the COMFYUI_MCP_ANTIGRAVITY_PATH override", () => {
    expect(resolveAgyBin()).toBe(FAKE_BIN);
    const r = backendReadiness("antigravity");
    expect(r).toEqual({ backend: "antigravity", cli: true, auth: null, ready: true });
  });

  it("reports not-ready when the CLI is absent", () => {
    delete process.env.COMFYUI_MCP_ANTIGRAVITY_PATH;
    const savedPath = process.env.PATH;
    const savedLad = process.env.LOCALAPPDATA;
    process.env.PATH = workDir; // empty dir — no agy anywhere
    process.env.LOCALAPPDATA = workDir;
    try {
      const r = backendReadiness("antigravity", { home: workDir });
      expect(r.ready).toBe(false);
      expect(r.cli).toBe(false);
      expect(r.auth).toBe(false);
    } finally {
      process.env.PATH = savedPath;
      if (savedLad === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = savedLad;
    }
  });
});

describe("AntigravityBackend turns", () => {
  it("streams stdout as deltas, commits the text, and continues with -c on turn 2", async () => {
    hoisted.script.push(
      { stdout: ["Hello ", "world"], exit: 0 },
      { stdout: ["Second answer"], exit: 0 },
    );
    const backend = new AntigravityBackend({ cwd: workDir, model: "gemini-3-pro", systemAppend: "PERSONA" });
    const events = await collect(
      backend.run({ channel: channelOf([{ text: "hi" }, { text: "again" }]) }),
    );

    // Session first, then per-turn stream events + assistant commit + ok result.
    expect(events[0]).toMatchObject({ type: "session", sessionId: "antigravity-latest", model: "gemini-3-pro" });
    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("stream_start");
    expect(events.filter((e) => e.type === "assistant").map((e) => (e as { text: string }).text)).toEqual([
      "Hello world",
      "Second answer",
    ]);
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: true, subtype: "end_turn" },
      { type: "result", ok: true, subtype: "end_turn" },
    ]);

    // Turn 1: fresh (-p, no -c), persona prepended, model + skip-permissions set.
    const t1 = hoisted.spawns[0]!;
    expect(t1.cmd).toBe(FAKE_BIN);
    expect(t1.args).not.toContain("-c");
    expect(t1.args).toContain("-p");
    expect(t1.args[t1.args.indexOf("-p") + 1]).toContain("PERSONA");
    expect(t1.args[t1.args.indexOf("-p") + 1]).toContain("hi");
    expect(t1.args).toContain("--dangerously-skip-permissions");
    expect(t1.args[t1.args.indexOf("--model") + 1]).toBe("gemini-3-pro");
    // Turn 2: continues the latest conversation, no persona.
    const t2 = hoisted.spawns[1]!;
    expect(t2.args).toContain("-c");
    expect(t2.args[t2.args.indexOf("-p") + 1]).toBe("again");
  });

  it("uses -c from the first turn when resuming, and skips the persona", async () => {
    hoisted.script.push({ stdout: ["resumed"], exit: 0 });
    const backend = new AntigravityBackend({ cwd: workDir, systemAppend: "PERSONA" });
    await collect(
      backend.run({ resume: "antigravity-latest", channel: channelOf([{ text: "back" }]) }),
    );
    const t1 = hoisted.spawns[0]!;
    expect(t1.args).toContain("-c");
    expect(t1.args[t1.args.indexOf("-p") + 1]).toBe("back");
  });

  it("drops a Claude id absent from the catalog but honors a catalog Claude model", async () => {
    // A claude-shaped opts.model triggers ONE `agy models` catalog probe; the
    // live agy catalog really does include claude-* entries (verified 2026-07-21),
    // so only ids missing from the catalog (the panel's Anthropic-side default)
    // are dropped.
    hoisted.script.push(
      { stdout: ["gemini-3.6-flash-medium\nclaude-sonnet-4-6\n"], exit: 0 }, // agy models
      { stdout: ["x"], exit: 0 }, // turn 1
      { stdout: ["y"], exit: 0 }, // turn 2
    );
    const backend = new AntigravityBackend({ cwd: workDir });
    await collect(
      backend.run({ model: "claude-opus-4-8", channel: channelOf([{ text: "q" }]) }),
    );
    expect(hoisted.spawns[0]!.args).toEqual(["models"]);
    expect(hoisted.spawns[1]!.args).not.toContain("--model"); // panel default dropped
    await backend.setModel("claude-sonnet-4-6"); // IN catalog → honored
    await collect(backend.run({ resume: "antigravity-latest", channel: channelOf([{ text: "q2" }]) }));
    const t2 = hoisted.spawns[2]!;
    expect(t2.args[t2.args.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
  });

  it("honors a non-claude model without probing the catalog", async () => {
    hoisted.script.push({ stdout: ["x"], exit: 0 });
    const backend = new AntigravityBackend({ cwd: workDir });
    await collect(backend.run({ model: "gemini-3.6-flash-low", channel: channelOf([{ text: "q" }]) }));
    const t1 = hoisted.spawns[0]!;
    expect(t1.args).not.toContain("models");
    expect(t1.args[t1.args.indexOf("--model") + 1]).toBe("gemini-3.6-flash-low");
  });

  it("surfaces a failed exit as error + failed result (terminal-result invariant)", async () => {
    hoisted.script.push({ stdout: [], stderr: "boom: quota exceeded", exit: 7 });
    const backend = new AntigravityBackend({ cwd: workDir });
    const events = await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    const err = events.find((e) => e.type === "error") as { message: string };
    expect(err.message).toContain("code 7");
    expect(err.message).toContain("quota exceeded");
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: false, subtype: "error" },
    ]);
  });

  it("maps an auth-looking failure to sign-in guidance", async () => {
    hoisted.script.push({ stdout: [], stderr: "You are not signed in. Run agy to authenticate.", exit: 1 });
    const backend = new AntigravityBackend({ cwd: workDir });
    const events = await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    const err = events.find((e) => e.type === "error") as { message: string };
    expect(err.message).toMatch(/sign-?in/i);
    expect(err.message).toContain("agy");
  });

  it("interrupt kills the in-flight child tree and yields a cancelled result", async () => {
    hoisted.script.push({ hang: true });
    const backend = new AntigravityBackend({ cwd: workDir });
    const gen = backend.run({ channel: channelOf([{ text: "long job" }]) });
    const events: AgentEvent[] = [];
    const drain = (async () => {
      for await (const ev of gen) events.push(ev);
    })();
    await vi.waitFor(() => expect(hoisted.spawns.length).toBe(1));
    await backend.interrupt();
    await drain;
    expect(hoisted.killed).toContain(hoisted.procs[0]!.pid);
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: false, subtype: "cancelled" },
    ]);
  });

  it("honors an interrupt that lands BEFORE the child is assigned (spawn window)", async () => {
    // The regression: interrupt() used to bail on `if (!this.child) return`
    // WITHOUT setting `interrupted`. `this.child` is assigned only after
    // spawn() returns, so a Stop pressed in that window was silently dropped
    // and the turn ran forever (CI saw this as a 5s timeout in the interrupt
    // test; a user sees the stop button do nothing).
    hoisted.script.push({ hang: true });
    const backend = new AntigravityBackend({ cwd: workDir });
    const gen = backend.run({ channel: channelOf([{ text: "long job" }]) });
    const events: AgentEvent[] = [];
    const drain = (async () => {
      for await (const ev of gen) events.push(ev);
    })();

    // Interrupt IMMEDIATELY — deliberately without waiting for the spawn, so
    // this lands in (or before) the spawn window.
    await backend.interrupt();

    // Must still terminate. Pre-fix this hung until the test timeout.
    await drain;

    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: false, subtype: "cancelled" },
    ]);
    // and the child must not be left running
    if (hoisted.procs[0]) expect(hoisted.killed).toContain(hoisted.procs[0]!.pid);
  });

  it("an idle interrupt expires and does not cancel the next turn (stale-flag regression)", async () => {
    hoisted.script.push({ stdout: ["fine"], exit: 0 });
    const backend = new AntigravityBackend({ cwd: workDir });
    await backend.interrupt(); // stray Stop while idle — arms with a 500ms expiry
    await new Promise((r) => setTimeout(r, 650)); // let it expire (no turn started)
    const events = await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: true, subtype: "end_turn" },
    ]);
    expect(hoisted.killed).toEqual([]);
  });

  it("rejects an over-32K prompt on Windows with a legible error instead of a cryptic spawn failure", async () => {
    if (process.platform !== "win32") return; // preflight is win32-only
    const backend = new AntigravityBackend({ cwd: workDir });
    const events = await collect(
      backend.run({ channel: channelOf([{ text: "x".repeat(31_000) }]) }),
    );
    expect(hoisted.spawns).toHaveLength(0); // never spawned
    const err = events.find((e) => e.type === "error") as { message: string };
    expect(err.message).toMatch(/too large/i);
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: false, subtype: "error" },
    ]);
  });

  it("prepare() fails fast with install guidance when agy is missing", async () => {
    delete process.env.COMFYUI_MCP_ANTIGRAVITY_PATH;
    const savedPath = process.env.PATH;
    const savedLad = process.env.LOCALAPPDATA;
    process.env.PATH = workDir;
    process.env.LOCALAPPDATA = workDir;
    try {
      const backend = new AntigravityBackend({ cwd: workDir });
      await expect(backend.prepare()).rejects.toThrow(/antigravity\.google/);
    } finally {
      process.env.PATH = savedPath;
      if (savedLad === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = savedLad;
    }
  });
});

describe("AntigravityBackend MCP config", () => {
  it("merges into the (injected) global mcp_config.json before the first turn", async () => {
    hoisted.script.push({ stdout: ["ok"], exit: 0 });
    const cfg = join(workDir, "gemini-config", "mcp_config.json");
    const backend = new AntigravityBackend({
      cwd: workDir,
      mcpConfigPath: cfg,
      mcpServers: {
        comfyui: { transport: "stdio", command: "node", args: ["dist/index.js"], env: {} },
        panel: { transport: "http", url: "http://127.0.0.1:9181/t1" },
      },
    });
    await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    const written = JSON.parse(readFileSync(cfg, "utf8"));
    expect(written.mcpServers.comfyui.command).toBe("node");
    expect(written.mcpServers.panel.serverUrl).toBe("http://127.0.0.1:9181/t1");
  });

  it("defaults to ~/.gemini/config/mcp_config.json (the only path agy honors)", () => {
    expect(agyMcpConfigPath("/home/u")).toBe(join("/home/u", ".gemini", "config", "mcp_config.json"));
  });

  it("leaves an unparseable user config untouched", async () => {
    hoisted.script.push({ stdout: ["ok"], exit: 0 });
    const cfg = join(workDir, "gemini-config", "mcp_config.json");
    mkdirSync(dirname(cfg), { recursive: true });
    writeFileSync(cfg, "{ not json", "utf8");
    const backend = new AntigravityBackend({
      cwd: workDir,
      mcpConfigPath: cfg,
      mcpServers: { panel: { transport: "http", url: "http://x/" } },
    });
    await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    expect(readFileSync(cfg, "utf8")).toBe("{ not json");
  });
});

describe("AntigravityBackend.listModels", () => {
  it("runs `agy models` and parses the catalog", async () => {
    hoisted.script.push({ stdout: ["gemini-3-pro (default)\ngemini-3-flash\n"], exit: 0 });
    const backend = new AntigravityBackend({ cwd: workDir });
    const models = await backend.listModels();
    expect(hoisted.spawns[0]!.args).toEqual(["models"]);
    expect(models.map((m) => m.id)).toEqual(["gemini-3-pro", "gemini-3-flash"]);
  });

  it("rejects with sign-in guidance on a non-zero exit", async () => {
    hoisted.script.push({ stdout: [], stderr: "not authenticated", exit: 2 });
    const backend = new AntigravityBackend({ cwd: workDir });
    await expect(backend.listModels()).rejects.toThrow(/Sign-In/i);
  });
});
