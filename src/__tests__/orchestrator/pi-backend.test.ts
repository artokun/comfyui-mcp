// Unit tests for the pi.dev CLI backend (pi-backend.ts, issue #491).
//
// We cannot run the real `pi` here, so `node:child_process` is mocked: spawn()
// returns an in-process fake child whose scripted stdout/stderr/exit behavior is
// set per test. This exercises the real PiBackend end-to-end: executable
// resolution (env override), spawn argv shaping (--mode json / --session /
// --model / --provider / positional prompt), the JSON-lines → delta → assistant →
// result event mapping, session-id capture + resume, the terminal-result
// invariant on failures, interrupt, tool-secret scoping, and `pi --list-models`
// parsing.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { AgentEvent, NeutralTurn } from "../../orchestrator/agent-backend.js";

const hoisted = vi.hoisted(() => ({
  spawns: [] as Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>,
  procs: [] as Array<Record<string, unknown>>,
  killed: [] as number[],
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
        proc.emit("close", 1, "SIGTERM"); // PiBackend settles on 'close', not 'exit'
      }
      return true;
    };
    hoisted.procs.push(proc);
    const step = hoisted.script[Math.min(hoisted.procs.length - 1, hoisted.script.length - 1)] ?? {
      stdout: ['{"type":"agent_end","messages":[]}\n'],
      exit: 0,
    };
    setTimeout(() => {
      for (const chunk of step.stdout ?? []) stdout.write(chunk);
      if (step.stderr) stderr.write(step.stderr);
      if (!step.hang) {
        setTimeout(() => {
          if (proc.exitCode === null) {
            proc.exitCode = step.exit ?? 0;
            proc.emit("exit", step.exit ?? 0, null);
            proc.emit("close", step.exit ?? 0, null); // 'close' = stdio drained
          }
        }, 5);
      }
    }, 5);
    return proc;
  }

  return {
    ...actual,
    spawn: vi.fn(spawnFake),
    spawnSync: vi.fn((cmd: string, args: string[]) => {
      if (/taskkill/i.test(cmd)) {
        const pid = Number(args[1]);
        hoisted.killed.push(pid);
        const proc = hoisted.procs.find((p) => p.pid === pid);
        if (proc && proc.exitCode === null) {
          proc.exitCode = 1;
          const emit = (proc as { emit: (ev: string, ...a: unknown[]) => void }).emit;
          emit.call(proc, "exit", null, "SIGKILL");
          emit.call(proc, "close", null, "SIGKILL");
        }
      }
      return { status: 0, stdout: "", stderr: "" };
    }),
  };
});

import {
  PiBackend,
  parsePiModels,
  parsePiDurationMs,
  resolvePiBin,
} from "../../orchestrator/pi-backend.js";
import { backendReadiness } from "../../orchestrator/backend-readiness.js";
import { PI_ENV_API_KEYS } from "../../orchestrator/pi-credentials.js";
import { waitFor } from "../helpers/wait-for.js";

const FAKE_BIN = join(tmpdir(), "fake-pi", "pi.exe");

async function* channelOf(turns: NeutralTurn[]): AsyncGenerator<NeutralTurn> {
  for (const t of turns) yield t;
}

async function collect(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

/** One text delta event line. */
const delta = (s: string) =>
  `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: s } })}\n`;
const header = (id: string) => `${JSON.stringify({ type: "session", version: 3, id })}\n`;
const END = '{"type":"agent_end","messages":[]}\n';

let workDir: string;

beforeEach(() => {
  hoisted.spawns.length = 0;
  hoisted.procs.length = 0;
  hoisted.killed.length = 0;
  hoisted.script.length = 0;
  // Emulate the POSIX process-group kill path too (Windows uses taskkill via the
  // spawnSync mock) so interrupt tests behave identically on every platform.
  vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
    const target = Math.abs(Number(pid));
    hoisted.killed.push(target);
    const proc = hoisted.procs.find((p) => p.pid === target);
    if (proc && proc.exitCode === null) {
      proc.exitCode = 1;
      const emit = (proc as { emit: (ev: string, ...a: unknown[]) => void }).emit;
      emit.call(proc, "exit", null, "SIGKILL");
      emit.call(proc, "close", null, "SIGKILL");
    }
    return true;
  }) as unknown as typeof process.kill);
  process.env.COMFYUI_MCP_PI_PATH = FAKE_BIN;
  delete process.env.COMFYUI_MCP_PI_PRINT_TIMEOUT;
  workDir = mkdtempSync(join(tmpdir(), "pi-test-"));
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_PI_PATH;
  rmSync(workDir, { recursive: true, force: true });
  vi.mocked(process.kill).mockRestore?.();
});

describe("parsePiModels", () => {
  it("parses a padded table with a header, id = provider/model", () => {
    const out = [
      "provider   model            context   max-out   thinking   images",
      "anthropic  claude-sonnet-4  200K      64K       yes        yes",
      "openai     gpt-4o           128K      16K       no         yes",
      "",
    ].join("\n");
    const models = parsePiModels(out);
    expect(models.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-4", "openai/gpt-4o"]);
    expect(models[0]!.label).toBe("claude-sonnet-4");
  });

  it("strips real ANSI escapes and skips separator rules", () => {
    // Real ANSI escapes include the ESC (\x1b) byte — the parser must strip the
    // whole CSI sequence, not just the "[32m" tail (else the token keeps \x1b).
    const out = "\x1b[32manthropic\x1b[0m  claude-3-5-sonnet  200K\n────────  ──────  ──────\n";
    expect(parsePiModels(out).map((m) => m.id)).toEqual(["anthropic/claude-3-5-sonnet"]);
  });

  it("returns [] for garbage / prose", () => {
    expect(parsePiModels("Something went wrong.\nPlease configure a provider.")).toEqual([]);
  });

  it("parsePiDurationMs handles duration forms", () => {
    expect(parsePiDurationMs("45m")).toBe(45 * 60_000);
    expect(parsePiDurationMs("1h30m")).toBe(90 * 60_000);
    expect(parsePiDurationMs("banana")).toBeNull();
  });
});

// Provider env keys pi's readiness treats as a verifiable credential — must be
// cleared for deterministic "no credential" assertions (the dev machine may have
// one set).
// Derived from pi's own env map so a newly-covered provider key can never leak
// the developer's real environment into these assertions, plus the Google Vertex
// ADC trio (a file path + project + location, not API keys).
const PI_ENV_KEYS = [
  ...PI_ENV_API_KEYS,
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  // Scrubbed too so a developer's real roaming profile can never be consulted by
  // a probe here (belt-and-braces: the ADC check already needs project+location).
  "APPDATA",
  // …and so a developer who relocated their own pi config can't leak it in.
  "PI_CODING_AGENT_DIR",
];
function withNoPiEnvKeys<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of PI_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of PI_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

describe("resolvePiBin / readiness", () => {
  it("honors the COMFYUI_MCP_PI_PATH override", () => {
    expect(resolvePiBin()).toBe(FAKE_BIN);
  });

  it("REFUSES a .cmd/.bat override (Node can't shell-lessly spawn it) — P1c", () => {
    const saved = process.env.COMFYUI_MCP_PI_PATH;
    try {
      process.env.COMFYUI_MCP_PI_PATH = "C:/tools/pi.cmd";
      expect(resolvePiBin(workDir)).toBeNull();
      process.env.COMFYUI_MCP_PI_PATH = "/usr/local/bin/pi.bat";
      expect(resolvePiBin(workDir)).toBeNull();
    } finally {
      process.env.COMFYUI_MCP_PI_PATH = saved;
    }
  });

  it("reads ready ONLY when a credential is verifiable — not on CLI presence alone (P1a)", () => {
    withNoPiEnvKeys(() => {
      // CLI present but NO credential source → NOT ready (list-models isn't an
      // auth probe).
      const r0 = backendReadiness("pi", { home: workDir });
      expect(r0.cli).toBe(true);
      expect(r0.auth).toBeNull(); // unknown, don't nag
      expect(r0.ready).toBe(false);

      // An EMPTY / structurally-useless auth.json must NOT count (never green on
      // mere file existence — P1a-a).
      mkdirSync(join(workDir, ".pi", "agent"), { recursive: true });
      writeFileSync(join(workDir, ".pi", "agent", "auth.json"), "{}");
      expect(backendReadiness("pi", { home: workDir }).ready).toBe(false);
      writeFileSync(join(workDir, ".pi", "agent", "auth.json"), '{"anthropic":{}}');
      expect(backendReadiness("pi", { home: workDir }).ready).toBe(false);
      writeFileSync(join(workDir, ".pi", "agent", "auth.json"), "{ not json");
      expect(backendReadiness("pi", { home: workDir }).ready).toBe(false);

      // A VALID auth.json entry → ready.
      writeFileSync(
        join(workDir, ".pi", "agent", "auth.json"),
        '{"anthropic":{"type":"api_key","key":"sk-ant-x"}}',
      );
      const r1 = backendReadiness("pi", { home: workDir });
      expect(r1.auth).toBe(true);
      expect(r1.ready).toBe(true);
    });
  });

  // The per-source rules are exercised exhaustively in pi-credentials.test.ts;
  // these assert that backendReadiness("pi") is actually wired to them.
  it("detects the broadened credential sources: env key, Vertex ADC, models.json (P1a-b)", () => {
    withNoPiEnvKeys(() => {
      // (1) a non-stripped provider env key — including ones pi accepts that we
      // used to miss entirely (cerebras/fireworks/together/anthropic-oauth).
      for (const key of ["OPENAI_API_KEY", "CEREBRAS_API_KEY", "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]) {
        process.env[key] = "sk-x";
        expect(backendReadiness("pi", { home: workDir }).ready, key).toBe(true);
        delete process.env[key];
      }
      // (2) Google Vertex ADC — pi's ADC path needs an EXISTING credentials file
      // plus project + location. A dangling path is not a credential.
      const adc = join(workDir, "adc.json");
      process.env.GOOGLE_CLOUD_PROJECT = "proj";
      process.env.GOOGLE_CLOUD_LOCATION = "us-central1";
      process.env.GOOGLE_APPLICATION_CREDENTIALS = join(workDir, "missing.json");
      expect(backendReadiness("pi", { home: workDir }).ready).toBe(false);
      writeFileSync(adc, "{}");
      process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
      expect(backendReadiness("pi", { home: workDir }).ready).toBe(true);
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      delete process.env.GOOGLE_CLOUD_PROJECT;
      delete process.env.GOOGLE_CLOUD_LOCATION;
      // (3) models.json: only a provider carrying its OWN credential counts —
      // an endpoint with no key is loaded by pi but its models stay unavailable.
      mkdirSync(join(workDir, ".pi", "agent"), { recursive: true });
      const modelsJson = join(workDir, ".pi", "agent", "models.json");
      writeFileSync(modelsJson, '{"providers":{"my-vllm":{"baseUrl":"http://x/v1"}}}');
      expect(backendReadiness("pi", { home: workDir }).ready).toBe(false);
      // …and JSONC is valid here, because pi strips comments before parsing it.
      writeFileSync(modelsJson, '{\n  // local\n  "providers": { "my-vllm": { "apiKey": "sk-local", },\n  },\n}');
      expect(backendReadiness("pi", { home: workDir }).ready).toBe(true);
    });
  });

  it("reports not-ready when the CLI is absent", () => {
    delete process.env.COMFYUI_MCP_PI_PATH;
    const savedPath = process.env.PATH;
    const savedLad = process.env.LOCALAPPDATA;
    process.env.PATH = workDir;
    process.env.LOCALAPPDATA = workDir;
    try {
      const r = backendReadiness("pi", { home: workDir });
      expect(r.ready).toBe(false);
      expect(r.cli).toBe(false);
    } finally {
      process.env.PATH = savedPath;
      if (savedLad === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = savedLad;
    }
  });
});

describe("PiBackend turns", () => {
  it("streams JSON deltas, captures + re-emits the session id, and resumes with --session on turn 2", async () => {
    hoisted.script.push(
      { stdout: [header("sess-abc"), delta("Hello "), delta("world"), END], exit: 0 },
      { stdout: [header("sess-abc"), delta("Second"), END], exit: 0 },
    );
    const backend = new PiBackend({ cwd: workDir, model: "openai/gpt-4o", systemAppend: "PERSONA" });
    const events = await collect(
      backend.run({ channel: channelOf([{ text: "hi" }, { text: "again" }]) }),
    );

    // No provisional/sentinel session is ever emitted (P1b) — the FIRST session
    // event carries the REAL id parsed from pi's JSON header.
    expect(events.some((e) => e.type === "session" && (e as { sessionId: string }).sessionId === "pi-pending")).toBe(false);
    const firstSession = events.find((e) => e.type === "session") as { sessionId: string; model?: string };
    expect(firstSession).toMatchObject({ sessionId: "sess-abc", model: "openai/gpt-4o" });
    expect(events.filter((e) => e.type === "assistant").map((e) => (e as { text: string }).text)).toEqual([
      "Hello world",
      "Second",
    ]);
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: true, subtype: "end_turn", turn: 1 },
      { type: "result", ok: true, subtype: "end_turn", turn: 2 },
    ]);

    // Turn 1: fresh (no --session), --mode json, persona prepended, model set.
    const t1 = hoisted.spawns[0]!;
    expect(t1.cmd).toBe(FAKE_BIN);
    expect(t1.args).not.toContain("--session");
    expect(t1.args).toContain("--mode");
    expect(t1.args[t1.args.indexOf("--mode") + 1]).toBe("json");
    expect(t1.args[t1.args.indexOf("--model") + 1]).toBe("openai/gpt-4o");
    expect(t1.args[t1.args.length - 1]).toContain("PERSONA");
    expect(t1.args[t1.args.length - 1]).toContain("hi");
    // Turn 2: resumes the captured session id, no persona.
    const t2 = hoisted.spawns[1]!;
    expect(t2.args[t2.args.indexOf("--session") + 1]).toBe("sess-abc");
    expect(t2.args[t2.args.length - 1]).toBe("again");
  });

  it("emits per-tool events from tool_execution_* lines", async () => {
    hoisted.script.push({
      stdout: [
        header("s1"),
        '{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{"command":"ls"}}\n',
        '{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{},"isError":false}\n',
        delta("done"),
        END,
      ],
      exit: 0,
    });
    const backend = new PiBackend({ cwd: workDir });
    const events = await collect(backend.run({ channel: channelOf([{ text: "run ls" }]) }));
    const tools = events.filter((e) => e.type === "tool_call") as Array<{ name: string; phase: string }>;
    expect(tools.map((t) => `${t.name}:${t.phase}`)).toEqual(["bash:start", "bash:end"]);
  });

  it("uses --session from opts.resume and skips the persona", async () => {
    hoisted.script.push({ stdout: [header("sess-r"), delta("resumed"), END], exit: 0 });
    const backend = new PiBackend({ cwd: workDir, systemAppend: "PERSONA" });
    await collect(backend.run({ resume: "sess-existing", channel: channelOf([{ text: "back" }]) }));
    const t1 = hoisted.spawns[0]!;
    expect(t1.args[t1.args.indexOf("--session") + 1]).toBe("sess-existing");
    expect(t1.args[t1.args.length - 1]).toBe("back"); // no persona preamble
  });

  it("re-asserts the capabilityNote on EVERY turn — fresh AND resume (P0a-resume)", async () => {
    // The heavy systemAppend preamble is first-turn-only, but the capability note
    // (pi has no ComfyUI tools) must reach resumed/long-running sessions too.
    const NOTE = "PI-HAS-NO-COMFYUI-TOOLS";
    // Fresh session, two turns: both must carry the note; the persona only turn 1.
    hoisted.script.push(
      { stdout: [header("s1"), delta("a"), END], exit: 0 },
      { stdout: [header("s1"), delta("b"), END], exit: 0 },
    );
    const fresh = new PiBackend({ cwd: workDir, systemAppend: "PERSONA", capabilityNote: NOTE });
    await collect(fresh.run({ channel: channelOf([{ text: "one" }, { text: "two" }]) }));
    const f1 = hoisted.spawns[0]!.args.at(-1)!;
    const f2 = hoisted.spawns[1]!.args.at(-1)!;
    expect(f1).toContain("PERSONA");
    expect(f1).toContain(NOTE);
    expect(f2).not.toContain("PERSONA"); // heavy preamble suppressed after turn 1
    expect(f2).toContain(NOTE); // but the note persists

    // RESUMED session: no persona, but the note is still asserted.
    hoisted.script.push({ stdout: [header("s2"), delta("c"), END], exit: 0 });
    const resumed = new PiBackend({ cwd: workDir, systemAppend: "PERSONA", capabilityNote: NOTE });
    await collect(resumed.run({ resume: "s-old", channel: channelOf([{ text: "back" }]) }));
    const r1 = hoisted.spawns[2]!.args.at(-1)!;
    expect(r1).not.toContain("PERSONA");
    expect(r1).toContain(NOTE);
  });

  it("drops a bare claude id (no --model) but honors a provider-prefixed id", async () => {
    hoisted.script.push({ stdout: [header("s"), delta("x"), END], exit: 0 });
    const backend = new PiBackend({ cwd: workDir });
    await collect(backend.run({ model: "claude-opus-4-8", channel: channelOf([{ text: "q" }]) }));
    expect(hoisted.spawns[0]!.args).not.toContain("--model");
    await backend.setModel("anthropic/claude-sonnet-4");
    hoisted.script.push({ stdout: [header("s"), delta("y"), END], exit: 0 });
    await collect(backend.run({ resume: "s", channel: channelOf([{ text: "q2" }]) }));
    const t2 = hoisted.spawns[1]!;
    expect(t2.args[t2.args.indexOf("--model") + 1]).toBe("anthropic/claude-sonnet-4");
  });

  it("passes --provider when configured", async () => {
    hoisted.script.push({ stdout: [header("s"), delta("ok"), END], exit: 0 });
    const backend = new PiBackend({ cwd: workDir, provider: "openai" });
    await collect(backend.run({ channel: channelOf([{ text: "q" }]) }));
    const t1 = hoisted.spawns[0]!;
    expect(t1.args[t1.args.indexOf("--provider") + 1]).toBe("openai");
  });

  it("still drops a bare claude id EVEN when a provider is configured (no --model leak)", async () => {
    // Regression: a set --provider must not whitelist the panel's bare claude
    // default — `pi --provider openai --model claude-opus-5` would fail every turn.
    hoisted.script.push({ stdout: [header("s"), delta("ok"), END], exit: 0 });
    const backend = new PiBackend({ cwd: workDir, provider: "openai" });
    await collect(backend.run({ model: "claude-opus-5", channel: channelOf([{ text: "q" }]) }));
    const t1 = hoisted.spawns[0]!;
    expect(t1.args).not.toContain("--model");
    expect(t1.args[t1.args.indexOf("--provider") + 1]).toBe("openai");
  });

  it("spawns pi WITHOUT ComfyUI tool-only secrets but keeps its own provider keys", async () => {
    const saved = {
      RUNPOD_API_KEY: process.env.RUNPOD_API_KEY,
      CIVITAI_API_TOKEN: process.env.CIVITAI_API_TOKEN,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    process.env.RUNPOD_API_KEY = "rp-tool-secret";
    process.env.CIVITAI_API_TOKEN = "civ-tool-secret";
    process.env.ANTHROPIC_API_KEY = "sk-ant-pi-key";
    try {
      hoisted.script.push({ stdout: [header("s"), delta("ok"), END], exit: 0 });
      const backend = new PiBackend({ cwd: workDir });
      await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
      const env = hoisted.spawns[0]!.opts.env as Record<string, string | undefined>;
      expect(env.RUNPOD_API_KEY).toBeUndefined(); // tool secret — stripped
      expect(env.CIVITAI_API_TOKEN).toBeUndefined(); // tool secret — stripped
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-pi-key"); // pi's own provider key — kept
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("surfaces a failed exit as error + failed result (terminal-result invariant)", async () => {
    hoisted.script.push({ stdout: [header("s")], stderr: "boom: quota exceeded", exit: 7 });
    const backend = new PiBackend({ cwd: workDir });
    const events = await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    const err = events.find((e) => e.type === "error") as { message: string };
    expect(err.message).toContain("code 7");
    expect(err.message).toContain("quota exceeded");
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: false, subtype: "error", turn: 1 },
    ]);
  });

  it("emits NO session event when a fresh turn fails before the JSON header (P1b)", async () => {
    // A pre-header failure (spawn error, over-long prompt, early exit) must not
    // persist a bogus session id — run() no longer emits a sentinel up front.
    hoisted.script.push({ stdout: [], stderr: "boom", exit: 1 });
    const backend = new PiBackend({ cwd: workDir });
    const events = await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    expect(events.some((e) => e.type === "session")).toBe(false);
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: false, subtype: "error", turn: 1 },
    ]);
  });

  it("emits the resume session id up front (real id, so surfacing it is fine)", async () => {
    hoisted.script.push({ stdout: [header("sess-r"), delta("ok"), END], exit: 0 });
    const backend = new PiBackend({ cwd: workDir });
    const events = await collect(backend.run({ resume: "sess-existing", channel: channelOf([{ text: "hi" }]) }));
    expect(events[0]).toMatchObject({ type: "session", sessionId: "sess-existing" });
  });

  // #1235 — a resumed turn whose session pi no longer has ("No session found
  // matching '<id>'": pruned store, different cwd/home, or a foreign id armed
  // from the panel's hello.resume hint) must drop the dead id and re-run the
  // turn ONCE as a fresh session — the pre-fix behavior failed every turn until
  // the user typed /new.
  it("self-heals a resume-miss: drops the dead id and retries the turn fresh (#1235)", async () => {
    hoisted.script.push(
      { stdout: [], stderr: "Error: No session found matching 'dead-id'", exit: 1 },
      { stdout: [header("fresh-id"), delta("Recovered"), END], exit: 0 },
    );
    const backend = new PiBackend({ cwd: workDir, systemAppend: "PERSONA" });
    const events = await collect(backend.run({ resume: "dead-id", channel: channelOf([{ text: "hi" }]) }));

    // The miss produced NO error/failed result — the retry's success is the
    // turn's single terminal outcome.
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: true, subtype: "end_turn", turn: 1 },
    ]);
    // The retry ran FRESH (no --session), re-armed the suppressed preamble, and
    // re-sent the user's message.
    expect(hoisted.spawns.length).toBe(2);
    expect(hoisted.spawns[0]!.args[hoisted.spawns[0]!.args.indexOf("--session") + 1]).toBe("dead-id");
    expect(hoisted.spawns[1]!.args).not.toContain("--session");
    expect(hoisted.spawns[1]!.args.at(-1)).toContain("PERSONA");
    expect(hoisted.spawns[1]!.args.at(-1)).toContain("hi");
    // The fresh session's id replaced the dead one, so the NEXT turn resumes it.
    expect(events.some((e) => e.type === "session" && (e as { sessionId: string }).sessionId === "fresh-id")).toBe(true);
  });

  it("a resume-miss whose FRESH retry also fails surfaces the retry's error once (#1235)", async () => {
    hoisted.script.push(
      { stdout: [], stderr: "Error: No session found matching 'dead-id'", exit: 1 },
      { stdout: [], stderr: "boom: quota exceeded", exit: 7 },
    );
    const backend = new PiBackend({ cwd: workDir });
    const events = await collect(backend.run({ resume: "dead-id", channel: channelOf([{ text: "hi" }]) }));
    // Exactly one retry (no loop), and the surfaced failure is the FRESH
    // attempt's — the more accurate cause.
    expect(hoisted.spawns.length).toBe(2);
    const err = events.find((e) => e.type === "error") as { message: string };
    expect(err.message).toContain("code 7");
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: false, subtype: "error", turn: 1 },
    ]);
  });

  it("a FRESH turn failing with the miss text is NOT retried (nothing was resumed)", async () => {
    hoisted.script.push({ stdout: [], stderr: "Error: No session found matching 'x'", exit: 1 });
    const backend = new PiBackend({ cwd: workDir });
    const events = await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    expect(hoisted.spawns.length).toBe(1);
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: false, subtype: "error", turn: 1 },
    ]);
  });

  it("maps a credential-looking failure to provider-setup guidance", async () => {
    hoisted.script.push({ stdout: [], stderr: "no provider configured: set an API key", exit: 1 });
    const backend = new PiBackend({ cwd: workDir });
    const events = await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    const err = events.find((e) => e.type === "error") as { message: string };
    expect(err.message).toMatch(/provider credentials|API key|login/i);
  });

  // #948 — a user saw pi's own "Not logged in, please run /login" in the PANEL
  // CHAT and reported that /login "doesn't exist as a command". They were right:
  // it is typed at pi's prompt, and in a chat box a leading `/` reads as "type
  // this here". The remedy was accurate and unusable at the same time.
  //
  // The helper's rules are pinned in cli-remedy.test.ts; this covers the WIRING,
  // because the bare string reached chat through THIS passthrough.
  it("#948: pi's own '/login' never reaches chat as a bare command", async () => {
    hoisted.script.push({ stdout: [], stderr: "Not logged in, please run /login", exit: 1 });
    const backend = new PiBackend({ cwd: workDir });
    const events = await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    const err = events.find((e) => e.type === "error") as { message: string };

    // The exact string the user was told to type into the panel.
    expect(err.message).not.toMatch(/please run \/login/);
    // Replaced by one that says where its prompt is…
    expect(err.message).toMatch(/at its prompt|at the `pi` prompt/);
    expect(err.message).toMatch(/TERMINAL/);
    // …and pi's own detail is kept, since it carries the real reason.
    expect(err.message).toMatch(/Not logged in/);
  });

  // A NON-auth failure can name a slash command too, so the qualification is not
  // limited to the credentials branch.
  it("#948: qualifies a slash command on a plain non-zero exit as well", async () => {
    hoisted.script.push({ stdout: [], stderr: "unknown flag; try /help", exit: 2 });
    const backend = new PiBackend({ cwd: workDir });
    const events = await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    const err = events.find((e) => e.type === "error") as { message: string };
    expect(err.message).toMatch(/exited with code 2/);
    expect(err.message).not.toMatch(/try \/help/);
    expect(err.message).toMatch(/`\/help`/);
  });

  it("interrupt kills the in-flight child tree and yields a cancelled result", async () => {
    hoisted.script.push({ hang: true });
    const backend = new PiBackend({ cwd: workDir });
    const gen = backend.run({ channel: channelOf([{ text: "long job" }]) });
    const events: AgentEvent[] = [];
    const drain = (async () => {
      for await (const ev of gen) events.push(ev);
    })();
    await waitFor(() => expect(hoisted.spawns.length).toBe(1));
    await backend.interrupt();
    await drain;
    expect(hoisted.killed).toContain(hoisted.procs[0]!.pid);
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: false, subtype: "cancelled", turn: 1 },
    ]);
  });

  it("honors an interrupt that lands BEFORE the child is assigned (spawn window)", async () => {
    hoisted.script.push({ hang: true });
    const backend = new PiBackend({ cwd: workDir });
    const gen = backend.run({ channel: channelOf([{ text: "long job" }]) });
    const events: AgentEvent[] = [];
    const drain = (async () => {
      for await (const ev of gen) events.push(ev);
    })();
    await backend.interrupt();
    await drain;
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: false, subtype: "cancelled", turn: 1 },
    ]);
    if (hoisted.procs[0]) expect(hoisted.killed).toContain(hoisted.procs[0]!.pid);
  });

  it("an idle interrupt expires and does not cancel the next turn (stale-flag regression)", async () => {
    hoisted.script.push({ stdout: [header("s"), delta("fine"), END], exit: 0 });
    const backend = new PiBackend({ cwd: workDir });
    await backend.interrupt();
    await new Promise((r) => setTimeout(r, 650));
    const events = await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: true, subtype: "end_turn", turn: 1 },
    ]);
    expect(hoisted.killed).toEqual([]);
  });

  it("kills the child when the generator is abandoned mid-turn without close()", async () => {
    hoisted.script.push({ stdout: [header("s"), delta("partial ")], hang: true });
    const backend = new PiBackend({ cwd: workDir });
    const gen = backend.run({ channel: channelOf([{ text: "long" }]) });
    let ev = await gen.next();
    while (!ev.done && (ev.value as { type: string }).type !== "stream_start") {
      ev = await gen.next();
    }
    await gen.return(undefined);
    expect(hoisted.killed).toContain(hoisted.procs[0]!.pid);
  });

  it("rejects an over-32K prompt on Windows with a legible error", async () => {
    if (process.platform !== "win32") return;
    const backend = new PiBackend({ cwd: workDir });
    const events = await collect(backend.run({ channel: channelOf([{ text: "x".repeat(31_000) }]) }));
    expect(hoisted.spawns).toHaveLength(0);
    const err = events.find((e) => e.type === "error") as { message: string };
    expect(err.message).toMatch(/too large/i);
  });

  it("prepare() fails fast with install guidance when pi is missing", async () => {
    delete process.env.COMFYUI_MCP_PI_PATH;
    const savedPath = process.env.PATH;
    const savedLad = process.env.LOCALAPPDATA;
    process.env.PATH = workDir;
    process.env.LOCALAPPDATA = workDir;
    try {
      const backend = new PiBackend({ cwd: workDir });
      await expect(backend.prepare()).rejects.toThrow(/pi\.dev/);
    } finally {
      process.env.PATH = savedPath;
      if (savedLad === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = savedLad;
    }
  });
});

describe("PiBackend.listModels", () => {
  it("runs `pi --list-models` and parses the table", async () => {
    hoisted.script.push({
      stdout: ["provider   model     context\nopenai     gpt-4o    128K\n"],
      exit: 0,
    });
    const backend = new PiBackend({ cwd: workDir });
    const models = await backend.listModels();
    expect(hoisted.spawns[0]!.args).toEqual(["--list-models"]);
    expect(models.map((m) => m.id)).toEqual(["openai/gpt-4o"]);
  });

  it("rejects with setup guidance on a non-zero exit", async () => {
    hoisted.script.push({ stdout: [], stderr: "boom", exit: 2 });
    const backend = new PiBackend({ cwd: workDir });
    await expect(backend.listModels()).rejects.toThrow(/pi is installed|configured/i);
  });
});
