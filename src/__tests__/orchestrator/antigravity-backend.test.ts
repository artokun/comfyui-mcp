// Unit tests for the Antigravity ACP backend. Every child process is mocked.
// The fake server exercises request framing, persistent sessions, streaming,
// cancellation, model selection, attachments, and injected MCP config paths.

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
  // ACP: the fake child answers JSON-RPC requests through this router (null = a
  // minimal default server: initialize + session/new + a plain prompt).
  acp: null as null | ((msg: any) => { result?: unknown; error?: unknown; notifications?: any[]; hang?: boolean }),
  acpMessages: [] as any[],
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
    // ACP writes JSON-RPC frames to stdin; the fake routes each one to the
    // per-test router and writes the answers back on stdout.
    const stdin = new PassThrough();
    proc.stdin = stdin;
    let buffer = "";
    stdin.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        hoisted.acpMessages.push(msg);
        const router = hoisted.acp ?? acpDefault();
        const out = router(msg) ?? {};
        for (const n of out.notifications ?? []) {
          stdout.write(JSON.stringify({ jsonrpc: "2.0", ...n }) + "\n");
        }
        if (out.hang) continue;
        if (out.hang) continue;
        if (out.error !== undefined) {
          stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: out.error }) + "\n");
        } else if (msg.id !== undefined) {
          stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: out.result ?? {} }) + "\n");
        }
      }
    });
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
    // hang:true still writes any scripted stdout (a child can stream partial
    // output and then freeze) — it only withholds the exit.
    setTimeout(() => {
      for (const chunk of step.stdout ?? []) stdout.write(chunk);
      if (step.stderr) stderr.write(step.stderr);
      if (!step.hang) {
        setTimeout(() => {
          if (proc.exitCode === null) {
            proc.exitCode = step.exit ?? 0;
            proc.emit("exit", step.exit ?? 0, null);
          }
        }, 5);
      }
    }, 5);
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
  parseGoDurationMs,
  mergeAgyMcpConfig,
  removeAgyMcpServers,
  sanitizeMcpServersForDisk,
  resolveAgyBin,
} from "../../orchestrator/antigravity-backend.js";
import { backendReadiness } from "../../orchestrator/backend-readiness.js";
import { waitFor } from "../helpers/wait-for.js";

const FAKE_BIN = join(tmpdir(), "fake-agy", "agy.exe");

async function* channelOf(turns: NeutralTurn[]): AsyncGenerator<NeutralTurn> {
  for (const t of turns) yield t;
}

/** A minimal ACP server: initialize + session/new + one streamed reply. */
const ACP_SESSION = "11111111-2222-4333-8444-555555555555";
function acpDefault(opts: { reply?: string; sessionId?: string } = {}) {
  const sessionId = opts.sessionId ?? ACP_SESSION;
  const reply = opts.reply ?? "ok";
  return (msg: any): { result?: unknown; error?: unknown; notifications?: any[]; hang?: boolean } => {
    switch (msg.method) {
      case "initialize":
        return {
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: true, audio: false, embeddedContext: true },
            },
            agentInfo: { name: "Antigravity ACP Server", version: "test" },
          },
        };
      case "session/new":
        return { result: { sessionId, models: { currentModelId: "gemini-3.8-flash-medium" } } };
      case "session/load":
        return { result: {} };
      case "session/prompt":
        return {
          notifications: [
            {
              method: "session/update",
              params: {
                sessionId,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } },
              },
            },
          ],
          result: { stopReason: "end_turn" },
        };
      default:
        return { result: {} };
    }
  };
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
  hoisted.acp = null;
  hoisted.acpMessages.length = 0;
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
    panel: { transport: "http" as const, url: "http://127.0.0.1:9198/tab" },
  };

  it("creates a fresh mcpServers wrapper", () => {
    const merged = JSON.parse(mergeAgyMcpConfig(null, servers));
    expect(merged.mcpServers.comfyui).toEqual({ command: "node", args: ["mcp.js"], env: { A: "1" } });
    expect(merged.mcpServers.panel).toEqual({ serverUrl: "http://127.0.0.1:9198/tab" });
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

describe("mcp_config hardening (#271)", () => {
  it("parseGoDurationMs handles agy duration forms", () => {
    expect(parseGoDurationMs("45m")).toBe(45 * 60_000);
    expect(parseGoDurationMs("5m0s")).toBe(5 * 60_000);
    expect(parseGoDurationMs("1h30m")).toBe(90 * 60_000);
    expect(parseGoDurationMs("banana")).toBeNull();
  });

  it("sanitizeMcpServersForDisk keeps ONLY allowlisted operational keys", () => {
    const { servers, withheld } = sanitizeMcpServersForDisk({
      comfyui: {
        transport: "stdio",
        command: "node",
        args: [],
        env: {
          COMFYUI_URL: "http://127.0.0.1:8188",
          COMFYUI_MCP_BLIND: "1",
          CIVITAI_API_TOKEN: "secret1",
          HF_TOKEN: "secret2",
          OPENROUTER_API_KEY: "secret3",
          // Allowlist means secret-SHAPED names never matter — but also that
          // arbitrary non-secret-looking vars stay off disk too.
          PRIVATE_KEY: "secret4",
          AUTHORIZATION: "secret5",
          DB_PASS: "secret6",
          RANDOM_VAR: "not-secret-but-not-ours",
          COMFYUI_AUTH_TOKEN: "secret7", // our namespace but credential-shaped
        },
      },
      panel: { transport: "http", url: "http://x/" },
    });
    const env = (servers.comfyui as { env: Record<string, string> }).env;
    expect(Object.keys(env).sort()).toEqual(["COMFYUI_MCP_BLIND", "COMFYUI_URL"]);
    expect(withheld).toHaveLength(8);
  });

  it("removeAgyMcpServers deletes only entries whose content WE wrote", () => {
    const ours = { command: "x", args: [], env: {} };
    const existing = JSON.stringify({
      mcpServers: {
        comfyui: ours, // untouched since we wrote it → removed
        panel: { serverUrl: "OVERWRITTEN-BY-TAB-B" }, // changed → kept
        github: { command: "z" }, // never ours → kept
      },
      other: 1,
    });
    const written = {
      comfyui: JSON.stringify(ours),
      panel: JSON.stringify({ serverUrl: "http://ours/" }),
    };
    const cleaned = JSON.parse(removeAgyMcpServers(existing, written)!);
    expect(cleaned.mcpServers).toEqual({
      panel: { serverUrl: "OVERWRITTEN-BY-TAB-B" },
      github: { command: "z" },
    });
    expect(cleaned.other).toBe(1);
    expect(removeAgyMcpServers(existing, { nope: "{}" })).toBeNull();
    expect(removeAgyMcpServers("{ not json", written)).toBeNull();
    expect(removeAgyMcpServers(JSON.stringify([1, 2]), written)).toBeNull();
  });

  it("mergeAgyMcpConfig treats a non-object file as empty instead of corrupting it", () => {
    const merged = JSON.parse(
      mergeAgyMcpConfig(JSON.stringify(["oops"]), {
        comfyui: { transport: "stdio", command: "node", args: [], env: {} },
      }),
    );
    expect(merged.mcpServers.comfyui.command).toBe("node");
  });

  it("close() removes our entries from the config it wrote (no secrets, atomic)", async () => {
    hoisted.script.push({ stdout: ["ok"], exit: 0 });
    const cfg = join(workDir, "gemini-config", "mcp_config.json");
    mkdirSync(dirname(cfg), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ mcpServers: { github: { command: "gh" } } }), "utf8");
    const backend = new AntigravityBackend({
      cwd: workDir,
      mcpConfigPath: cfg,
      mcpServers: {
        comfyui: {
          transport: "stdio",
          command: "node",
          args: [],
          env: { COMFYUI_URL: "http://x", HF_TOKEN: "supersecret" },
        },
      },
    });
    await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    const written = readFileSync(cfg, "utf8");
    expect(written).not.toContain("supersecret"); // secrets never at rest
    expect(JSON.parse(written).mcpServers.comfyui.env).toEqual({ COMFYUI_URL: "http://x" });
    await backend.close();
    const after = JSON.parse(readFileSync(cfg, "utf8"));
    expect(after.mcpServers.comfyui).toBeUndefined(); // cleaned up on dispose
    expect(after.mcpServers.github).toEqual({ command: "gh" }); // user entry preserved
  });

  it("refuses to touch a valid-JSON-but-non-object config file", async () => {
    hoisted.script.push({ stdout: ["ok"], exit: 0 });
    const cfg = join(workDir, "gemini-config", "mcp_config.json");
    mkdirSync(dirname(cfg), { recursive: true });
    writeFileSync(cfg, "[1,2,3]", "utf8");
    const backend = new AntigravityBackend({
      cwd: workDir,
      mcpConfigPath: cfg,
      mcpServers: { panel: { transport: "http", url: "http://x/" } },
    });
    await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    expect(readFileSync(cfg, "utf8")).toBe("[1,2,3]");
  });
});

describe("effort + abandonment (#271)", () => {
  it("maps effort onto ACP's thought_level option", async () => {
    hoisted.acp = acpDefault();
    const backend = new AntigravityBackend({ cwd: workDir, mcpConfigPath: join(workDir, "mcp.json") });
    await collect(backend.run({ channel: channelOf([{ text: "hi" }]), effort: "high" }));
    const cfg = hoisted.acpMessages.find(
      (m) => m.method === "session/set_config_option" && m.params?.configId === "thought_level",
    );
    expect(cfg?.params?.value).toBe("high");
    await backend.close();
  });

  it("closes the ACP child when abandoned before the first prompt", async () => {
    // A prompt that never resolves: the turn stays in flight.
    hoisted.acp = (msg) => (msg.method === "session/prompt" ? { hang: true } : acpDefault()(msg));
    const backend = new AntigravityBackend({ cwd: workDir, mcpConfigPath: join(workDir, "mcp.json") });
    const gen = backend.run({ channel: channelOf([{ text: "hi" }]) });
    const seen: AgentEvent[] = [];
    for await (const ev of gen) {
      seen.push(ev);
      if (ev.type === "session") break; // abandon before the first prompt
    }
    expect(seen.some((e) => e.type === "session")).toBe(true);
    expect(hoisted.spawns[0].args).toContain("acp");
    expect(hoisted.procs[0].exitCode).not.toBeNull();
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

describe("AntigravityBackend turns (ACP)", () => {
  it("spawns `agy acp` with skip-permissions and WITHOUT any tool-only secrets", async () => {
    process.env.RUNPOD_API_KEY = "rpa_secret";
    process.env.CIVITAI_API_TOKEN = "civ_secret";
    process.env.GEMINI_API_KEY = "gm_secret";
    hoisted.acp = acpDefault();
    const backend = new AntigravityBackend({ cwd: workDir, mcpConfigPath: join(workDir, "mcp.json") });
    await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    const spawn = hoisted.spawns[0];
    expect(spawn.args).toContain("acp");
    expect(spawn.args).toContain("--dangerously-skip-permissions");
    expect(spawn.args).not.toContain("-p");
    const env = spawn.opts.env as NodeJS.ProcessEnv;
    expect(env.RUNPOD_API_KEY).toBeUndefined();
    expect(env.CIVITAI_API_TOKEN).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    delete process.env.RUNPOD_API_KEY;
    delete process.env.CIVITAI_API_TOKEN;
    delete process.env.GEMINI_API_KEY;
    await backend.close();
  });

  it("prepends the panel persona on the first turn only, streams deltas, commits one assistant + one result", async () => {
    hoisted.acp = acpDefault({ reply: "hello there" });
    const backend = new AntigravityBackend({
      cwd: workDir,
      mcpConfigPath: join(workDir, "mcp.json"),
      systemAppend: "PANEL PERSONA",
    });
    const events = await collect(backend.run({ channel: channelOf([{ text: "first" }, { text: "second" }]) }));
    const prompts = hoisted.acpMessages.filter((m) => m.method === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[0].params.prompt[0].text).toContain("PANEL PERSONA");
    expect(prompts[1].params.prompt[0].text).not.toContain("PANEL PERSONA");
    // deltas -> one committed assistant message -> result
    expect(events.filter((e) => e.type === "assistant_delta").length).toBeGreaterThan(0);
    const assistant = events.filter((e) => e.type === "assistant");
    expect(assistant).toHaveLength(2);
    expect(assistant[0].type === "assistant" && assistant[0].text).toBe("hello there");
    const results = events.filter((e) => e.type === "result");
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.type === "result" && r.ok)).toBe(true);
    await backend.close();
  });

  it("attaches an attached image as an inline base64 ACP image block (vision, #3010)", async () => {
    hoisted.acp = acpDefault();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const backend = new AntigravityBackend({
      cwd: workDir,
      mcpConfigPath: join(workDir, "mcp.json"),
      comfyuiUrl: "http://127.0.0.1:8188",
    });
    await collect(
      backend.run({ channel: channelOf([{ text: "what is this?", images: [{ filename: "shot.png", type: "input" }] }]) }),
    );
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/view?filename=shot.png");
    const prompt = hoisted.acpMessages.find((m) => m.method === "session/prompt")!.params.prompt;
    expect(prompt[0].type).toBe("text");
    expect(prompt[1]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: Buffer.from([1, 2, 3, 4]).toString("base64"),
    });
    vi.unstubAllGlobals();
    await backend.close();
  });

  it("tells the model which images did NOT arrive instead of dropping them silently", async () => {
    hoisted.acp = acpDefault();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, headers: { get: () => null } })),
    );
    const backend = new AntigravityBackend({
      cwd: workDir,
      mcpConfigPath: join(workDir, "mcp.json"),
      comfyuiUrl: "http://127.0.0.1:8188",
    });
    await collect(
      backend.run({ channel: channelOf([{ text: "look", images: [{ filename: "gone.png", type: "input" }] }]) }),
    );
    const prompt = hoisted.acpMessages.find((m) => m.method === "session/prompt")!.params.prompt;
    expect(prompt).toHaveLength(1); // no image block
    expect(prompt[0].text).toContain("could not be delivered");
    vi.unstubAllGlobals();
    await backend.close();
  });

  it("surfaces a failed session/prompt as error + failed result (terminal-result invariant)", async () => {
    hoisted.acp = (msg) =>
      msg.method === "session/prompt"
        ? { error: { code: -32000, message: "model overloaded" } }
        : acpDefault()(msg);
    const backend = new AntigravityBackend({ cwd: workDir, mcpConfigPath: join(workDir, "mcp.json") });
    const events = await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    const err = events.find((e) => e.type === "error");
    expect(err && err.type === "error" ? err.message : "").toContain("model overloaded");
    const res = events.find((e) => e.type === "result");
    expect(res && res.type === "result" ? res.ok : true).toBe(false);
    await backend.close();
  });

  it("interrupt sends session/cancel and kills the tree when the agent never settles", async () => {
    hoisted.script.push({ hang: true }); // the ACP child stays alive and silent
    hoisted.acp = (msg) => (msg.method === "session/prompt" ? { hang: true } : acpDefault()(msg));
    const backend = new AntigravityBackend({ cwd: workDir, mcpConfigPath: join(workDir, "mcp.json") });
    const gen = backend.run({ channel: channelOf([{ text: "hi" }]) });
    const events: AgentEvent[] = [];
    void (async () => {
      for await (const ev of gen) events.push(ev);
    })();
    await waitFor(() => {
      expect(hoisted.acpMessages.some((m) => m.method === "session/prompt")).toBe(true);
    });
    await backend.interrupt();
    // vi.waitFor retries only while the callback THROWS — a falsy return is a
    // success, so the condition must be an assertion.
    await waitFor(() => {
      expect(hoisted.acpMessages.some((m) => m.method === "session/cancel")).toBe(true);
    });
    // the 5s session/cancel failsafe: the hung agent must still lose its process tree
    await waitFor(() => {
      expect(hoisted.killed.length).toBeGreaterThan(0);
    }, { timeout: 8000 });
  });

  it("resumes a real ACP session id with session/load and skips the persona", async () => {
    hoisted.acp = acpDefault();
    const backend = new AntigravityBackend({
      cwd: workDir,
      mcpConfigPath: join(workDir, "mcp.json"),
      systemAppend: "PANEL PERSONA",
    });
    const uuid = "b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    await collect(backend.run({ channel: channelOf([{ text: "again" }]), resume: uuid }));
    const load = hoisted.acpMessages.find((m) => m.method === "session/load");
    expect(load?.params?.sessionId).toBe(uuid);
    const prompt = hoisted.acpMessages.find((m) => m.method === "session/prompt")!.params.prompt;
    expect(prompt[0].text).not.toContain("PANEL PERSONA");
    await backend.close();
  });

  it("drops a Claude id absent from the catalog but honors a catalog Claude model", async () => {
    hoisted.acp = acpDefault();
    hoisted.script.push({ stdout: ["claude-opus-5-5-medium\n"], exit: 0 }); // `agy models`
    const backend = new AntigravityBackend({ cwd: workDir, mcpConfigPath: join(workDir, "mcp.json") });
    await collect(backend.run({ channel: channelOf([{ text: "hi" }]), model: "claude-opus-5" }));
    expect(hoisted.acpMessages.some((m) => m.method === "session/set_model" && m.params.modelId === "claude-opus-5")).toBe(
      false,
    );
    await backend.close();
  });

  it("applies the selected model to the live session with session/set_model", async () => {
    hoisted.acp = acpDefault();
    const backend = new AntigravityBackend({ cwd: workDir, mcpConfigPath: join(workDir, "mcp.json") });
    await collect(backend.run({ channel: channelOf([{ text: "hi" }]), model: "gemini-3.8-flash-medium" }));
    const set = hoisted.acpMessages.find((m) => m.method === "session/set_model");
    expect(set?.params?.modelId).toBe("gemini-3.8-flash-medium");
    await backend.close();
  });

  it("prepare() fails fast with install guidance when agy is missing", async () => {
    process.env.COMFYUI_MCP_ANTIGRAVITY_PATH = "";
    const backend = new AntigravityBackend({ cwd: workDir, mcpConfigPath: join(workDir, "mcp.json") });
    // resolveAgyBin falls back to %LOCALAPPDATA%\agy\bin — hide both so this
    // asserts the missing-binary path even on a machine that HAS agy installed.
    const original = process.env.PATH;
    const originalLocal = process.env.LOCALAPPDATA;
    process.env.PATH = "";
    process.env.LOCALAPPDATA = workDir;
    await expect(backend.prepare()).rejects.toThrow(/agy.*not found|Install it from/i);
    process.env.PATH = original;
    process.env.LOCALAPPDATA = originalLocal;
    process.env.COMFYUI_MCP_ANTIGRAVITY_PATH = FAKE_BIN;
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
        panel: { transport: "http", url: "http://127.0.0.1:9198/t1" },
      },
    });
    await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    const written = JSON.parse(readFileSync(cfg, "utf8"));
    expect(written.mcpServers.comfyui.command).toBe("node");
    expect(written.mcpServers.panel.serverUrl).toBe("http://127.0.0.1:9198/t1");
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

describe("ACP lifecycle regressions", () => {
  const methods = (name: string) => hoisted.acpMessages.filter((m) => m.method === name);
  const reply = (method: string, result: unknown, procIndex = 0) => {
    const request = methods(method).at(-1);
    (hoisted.procs[procIndex].stdout as { write: (s: string) => void }).write(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
    );
  };
  const backendForTest = () => new AntigravityBackend({
    cwd: workDir, mcpConfigPath: join(workDir, "mcp.json"),
    comfyuiUrl: "http://127.0.0.1:8188", systemAppend: "PERSONA",
  });

  beforeEach(() => { hoisted.script.push({ hang: true }); });

  it("closes a child whose initialize request rejects", async () => {
    hoisted.acp = () => ({ error: { code: -32000, message: "initialize rejected" } });
    const backend = backendForTest();
    try {
      await expect(backend.prepare()).rejects.toThrow("initialize rejected");
      expect(hoisted.procs[0].exitCode).not.toBeNull();
    } finally { await backend.close(); (hoisted.procs[0].kill as () => void)(); }
  });

  it("shares one concurrent prepare and replaces an exited child", async () => {
    hoisted.acp = (msg) => msg.method === "initialize" ? { hang: true } : acpDefault()(msg);
    const backend = backendForTest();
    try {
      const first = backend.prepare();
      const second = backend.prepare();
      for (let i = 0; i < hoisted.procs.length; i++) reply("initialize", acpDefault()({ method: "initialize" }).result, i);
      await Promise.all([first, second]);
      expect(hoisted.spawns).toHaveLength(1);
      (hoisted.procs[0].kill as () => void)();
      await Promise.resolve();
      hoisted.acp = acpDefault();
      await backend.prepare();
      expect(hoisted.spawns).toHaveLength(2);
    } finally {
      for (const proc of hoisted.procs) (proc.kill as () => void)();
      await backend.close();
    }
  });

  it.each([false, true])("keeps Stop armed through a slow initialize handshake (early Stop: %s)", async (earlyStop) => {
    hoisted.acp = (msg) => msg.method === "initialize" ? { hang: true } : acpDefault()(msg);
    const backend = backendForTest();
    if (earlyStop) await backend.interrupt();
    const collecting = collect(backend.run({ channel: channelOf([{ text: "cancel me" }]) }));
    try {
      await waitFor(() => expect(methods("initialize")).toHaveLength(1));
      if (!earlyStop) await backend.interrupt();
      await new Promise((r) => setTimeout(r, 650));
      reply("initialize", acpDefault()({ method: "initialize" }).result);
      const events = await collecting;
      expect(methods("session/prompt")).toHaveLength(0);
      expect(events.filter((e) => e.type === "result")).toEqual([
        expect.objectContaining({ ok: false, subtype: "cancelled" }),
      ]);
    } finally { await backend.close(); }
  });

  it("cancels a slow image fetch without submitting a prompt or losing the persona", async () => {
    let finishFetch!: (value: unknown) => void;
    const fetchMock = vi.fn(() => new Promise((resolve) => { finishFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const backend = backendForTest();
    let cancelled: AgentEvent[] = [];
    async function* turns() {
      yield { text: "cancel image", images: [{ filename: "shot.png", type: "input" as const }] };
      cancelled = events.filter((e) => e.type === "result");
      yield { text: "next" };
    }
    const events: AgentEvent[] = [];
    const collecting = (async () => { for await (const ev of backend.run({ channel: turns() })) events.push(ev); })();
    try {
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await backend.interrupt();
      await new Promise((r) => setTimeout(r, 650));
      finishFetch({ ok: false });
      await collecting;
      expect(cancelled).toEqual([expect.objectContaining({ ok: false, subtype: "cancelled" })]);
      expect(methods("session/prompt")).toHaveLength(1);
      expect(methods("session/prompt")[0].params.prompt[0].text).toContain("PERSONA");
    } finally { vi.unstubAllGlobals(); await backend.close(); }
  });

  it("does not let a settled turn's cancellation timer kill the following turn", async () => {
    hoisted.acp = (msg) => msg.method === "session/prompt" ? { hang: true } : acpDefault()(msg);
    const backend = backendForTest();
    const collecting = collect(backend.run({ channel: channelOf([{ text: "first" }, { text: "second" }]) }));
    try {
      await waitFor(() => expect(methods("session/prompt")).toHaveLength(1));
      await backend.interrupt();
      reply("session/prompt", { stopReason: "cancelled" });
      await waitFor(() => expect(methods("session/prompt")).toHaveLength(2));
      await new Promise((r) => setTimeout(r, 5200));
      expect(hoisted.killed).toHaveLength(0);
      reply("session/prompt", { stopReason: "end_turn" });
      await collecting;
    } finally { await backend.close(); await collecting; }
  });

  it("releases the process when abandoned at the initial session event", async () => {
    const backend = backendForTest();
    try {
      for await (const ev of backend.run({ channel: channelOf([{ text: "unused" }]) })) {
        if (ev.type === "session") break;
      }
      expect(hoisted.procs[0].exitCode).not.toBeNull();
      expect(methods("session/prompt")).toHaveLength(0);
    } finally { await backend.close(); }
  });

  it("releases an abandoned streaming prompt and suppresses its late events", async () => {
    hoisted.acp = (msg) => msg.method === "session/prompt"
      ? { ...acpDefault()(msg), hang: true }
      : acpDefault()(msg);
    // Send a delta, but hold the prompt's response after the fake router writes it.
    const backend = backendForTest();
    try {
      for await (const ev of backend.run({ channel: channelOf([{ text: "hi" }]) })) {
        if (ev.type === "assistant_delta") break;
      }
      expect(hoisted.procs[0].exitCode).not.toBeNull();
    } finally { await backend.close(); }
  });

  it("applies a model change before the next prompt on the same run", async () => {
    const backend = backendForTest();
    async function* turns() {
      yield { text: "first" };
      await backend.setModel("gemini-next");
      yield { text: "second" };
    }
    try {
      await collect(backend.run({ channel: turns(), model: "gemini-first" }));
      const relevant = hoisted.acpMessages.filter((m) => ["session/set_model", "session/prompt"].includes(m.method));
      expect(relevant.map((m) => m.method === "session/set_model" ? m.params.modelId : m.params.prompt[0].text)).toEqual([
        "gemini-first", expect.stringContaining("first"), "gemini-next", "second",
      ]);
    } finally { await backend.close(); }
  });

  it("does not claim a model or send a prompt when both model-selection methods fail", async () => {
    hoisted.acp = (msg) => ["session/set_model", "session/set_config_option"].includes(msg.method)
      ? { error: { code: -32601, message: "unsupported model selection" } }
      : acpDefault()(msg);
    const backend = backendForTest();
    try {
      await expect(collect(backend.run({ channel: channelOf([{ text: "hi" }]), model: "gemini-requested" })))
        .rejects.toThrow(/model/i);
      expect(methods("session/prompt")).toHaveLength(0);
    } finally { await backend.close(); }
  });
});

describe("ACP session and attachment boundaries", () => {
  beforeEach(() => { hoisted.script.push({ hang: true }); });

  it("resumes after a clean child exit instead of reusing its dead stdin", async () => {
    const backend = new AntigravityBackend({ cwd: workDir });
    await backend.prepare();
    const first = hoisted.procs[0];
    first.exitCode = 0;
    (first.emit as (name: string, ...args: unknown[]) => void)("exit", 0, null);
    await Promise.resolve();
    try {
      const events = await collect(backend.run({ channel: channelOf([{ text: "again" }]), resume: ACP_SESSION }));
      expect(hoisted.spawns).toHaveLength(2);
      expect(hoisted.acpMessages.find((m) => m.method === "session/load")?.params.sessionId).toBe(ACP_SESSION);
      expect(events.filter((e) => e.type === "result")).toEqual([expect.objectContaining({ ok: true })]);
    } finally { await backend.close(); }
  });

  it("does not send a prompt if the ACP process exits during image preparation", async () => {
    let finish!: (value: unknown) => void;
    const fetchMock = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const backend = new AntigravityBackend({ cwd: workDir, comfyuiUrl: "http://127.0.0.1:8188" });
    const collecting = collect(backend.run({ channel: channelOf([{ text: "look", images: [{ filename: "x.png" }] }]) }));
    try {
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      (hoisted.procs[0].kill as () => void)();
      await Promise.resolve();
      finish({ ok: false });
      const events = await collecting;
      expect(hoisted.acpMessages.filter((m) => m.method === "session/prompt")).toHaveLength(0);
      expect(events.filter((e) => e.type === "result")).toEqual([expect.objectContaining({ ok: false })]);
    } finally { vi.unstubAllGlobals(); await backend.close(); }
  });

  it("uses model config fallback only after set_model rejects", async () => {
    hoisted.acp = (msg) => msg.method === "session/set_model"
      ? { error: { code: -32601, message: "method unavailable" } }
      : acpDefault()(msg);
    const backend = new AntigravityBackend({ cwd: workDir });
    try {
      const events = await collect(backend.run({ channel: channelOf([{ text: "hi" }]), model: "gemini-requested" }));
      expect(hoisted.acpMessages.find((m) => m.method === "session/set_config_option")?.params)
        .toMatchObject({ configId: "model", value: "gemini-requested" });
      expect(events[0]).toMatchObject({ type: "session", model: "gemini-requested" });
    } finally { await backend.close(); }
  });

  it("fails only the affected turn when a live model change is rejected", async () => {
    hoisted.acp = (msg) => (msg.method === "session/set_model" && msg.params.modelId === "gemini-bad")
      || (msg.method === "session/set_config_option" && msg.params.value === "gemini-bad")
      ? { error: { code: -32000, message: "model unavailable" } }
      : acpDefault()(msg);
    const backend = new AntigravityBackend({ cwd: workDir });
    async function* turns() {
      yield { text: "first" };
      await backend.setModel("gemini-bad");
      yield { text: "blocked" };
      await backend.setModel("gemini-good");
      yield { text: "third" };
    }
    try {
      const events = await collect(backend.run({ channel: turns(), model: "gemini-good" }));
      expect(events.filter((e) => e.type === "result").map((e) => e.type === "result" && e.ok)).toEqual([true, false, true]);
      expect(hoisted.acpMessages.filter((m) => m.method === "session/prompt")).toHaveLength(2);
    } finally { await backend.close(); }
  });

  it("does not fetch images when the provider explicitly disables vision", async () => {
    hoisted.acp = (msg) => msg.method === "initialize"
      ? { result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } } } }
      : acpDefault()(msg);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const backend = new AntigravityBackend({ cwd: workDir, comfyuiUrl: "http://127.0.0.1:8188" });
    try {
      await collect(backend.run({ channel: channelOf([{ text: "look", images: [{ filename: "x.png" }] }]) }));
      expect(fetchMock).not.toHaveBeenCalled();
      const prompt = hoisted.acpMessages.find((m) => m.method === "session/prompt").params.prompt;
      expect(prompt).toHaveLength(1);
      expect(prompt[0].text).toContain("could not be delivered");
    } finally { vi.unstubAllGlobals(); await backend.close(); }
  });

  it("starts a fresh session with its persona when session/load rejects", async () => {
    hoisted.acp = (msg) => msg.method === "session/load"
      ? { error: { code: -32000, message: "session missing" } }
      : acpDefault()(msg);
    const backend = new AntigravityBackend({ cwd: workDir, systemAppend: "PERSONA" });
    try {
      await collect(backend.run({ channel: channelOf([{ text: "hi" }]), resume: ACP_SESSION }));
      expect(hoisted.acpMessages.filter((m) => m.method === "session/new")).toHaveLength(1);
      expect(hoisted.acpMessages.find((m) => m.method === "session/prompt").params.prompt[0].text).toContain("PERSONA");
    } finally { await backend.close(); }
  });

  it("pairs tool completion with its original name and ignores another session's updates", async () => {
    hoisted.acp = (msg) => msg.method === "session/prompt" ? {
      notifications: [
        { method: "session/update", params: { sessionId: "other", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LEAK" } } } },
        { method: "session/update", params: { sessionId: ACP_SESSION, update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "panel_run" } } },
        { method: "session/update", params: { sessionId: ACP_SESSION, update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "failed" } } },
      ],
      result: { stopReason: "end_turn" },
    } : acpDefault()(msg);
    const backend = new AntigravityBackend({ cwd: workDir });
    try {
      const events = await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
      expect(events.filter((e) => e.type === "tool_call")).toEqual([
        expect.objectContaining({ name: "panel_run", phase: "start" }),
        expect.objectContaining({ name: "panel_run", phase: "end", detail: expect.objectContaining({ status: "failed" }) }),
      ]);
      expect(JSON.stringify(events)).not.toContain("LEAK");
    } finally { await backend.close(); }
  });
});

describe("ACP startup cancellation deadline", () => {
  it.each(["initialize", "session/new", "session/load", "session/set_model", "session/set_config_option"])("kills a %s request that never settles after Stop", async (method) => {
    hoisted.script.push({ hang: true });
    hoisted.acp = (msg) => msg.method === method ? { hang: true } : acpDefault()(msg);
    const backend = new AntigravityBackend({ cwd: workDir });
    const stoppedBeforeRun = method === "session/new";
    if (stoppedBeforeRun) { await backend.prepare(); await backend.interrupt(); }
    const collecting = collect(backend.run({
      channel: channelOf([{ text: "cancel" }]),
      ...(method === "session/load" ? { resume: ACP_SESSION } : {}),
      ...(method === "session/set_model" ? { model: "gemini-test" } : {}),
      ...(method === "session/set_config_option" ? { effort: "high" as const } : {}),
    }))
      .then(() => null, (err: unknown) => err);
    try {
      await waitFor(() => expect(hoisted.acpMessages.some((m) => m.method === method)).toBe(true));
      if (!stoppedBeforeRun) await backend.interrupt();
      await waitFor(() => expect(hoisted.killed).toHaveLength(1), { timeout: 8000 });
      expect(await collecting).toBeInstanceOf(Error);
      expect(hoisted.acpMessages.some((m) => m.method === "session/prompt")).toBe(false);
      hoisted.acp = acpDefault();
      const recovered = await collect(backend.run({ channel: channelOf([{ text: "retry" }]) }));
      expect(recovered.filter((e) => e.type === "result")).toEqual([expect.objectContaining({ ok: true })]);
      expect(hoisted.spawns).toHaveLength(2);
    } finally { await backend.close(); }
  });
});
