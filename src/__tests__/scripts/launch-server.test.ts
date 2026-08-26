// #1447 — the plugin's .mcp.json ran `npx -y comfyui-mcp --full` directly, so a
// cold npx cache downloaded the whole dependency tree inside the client's MCP
// handshake timeout; the kill discarded the partial install and every retry
// paid full price again. The fix is a launcher (plugin/scripts/launch-server.mjs)
// that prefers a globally installed comfyui-mcp (warm, sub-second) and falls
// back to the original npx invocation when there isn't one.
//
// The decisions are exercised against the REAL exports — the launcher is
// import-safe by design, so importing it here is also the proof that importing
// it spawns nothing. The import is inside beforeAll, not at collection: a
// top-level `await import` of a CRLF shebang is a SyntaxError during
// transform, which vitest reports as "1 failed / Tests no tests" (#1857).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";

const LAUNCHER_REL = "plugin/scripts/launch-server.mjs";
const LAUNCHER_URL = new URL("../../../plugin/scripts/launch-server.mjs", import.meta.url);

type Frame = Record<string, unknown>;
type Decision = { action: "forward" | "drop" } | { action: "reply"; message: Frame };

type Launcher = {
  globalEntry: (stdout: unknown, opts?: { exists?: (p: string) => boolean }) => string | null;
  serverSpec: (
    entry: string | null,
    extraArgs: string[],
    opts?: { platform?: string; node?: string },
  ) => { command: string; args: string[]; shell: boolean };
  coldStartDeadlineMs: (
    env?: Record<string, string | undefined>,
    opts?: { cachedInstall?: boolean },
  ) => number;
  cachedNpxInstallExists: (
    stdout: unknown,
    opts?: { readdir?: (p: string) => string[]; exists?: (p: string) => boolean },
  ) => boolean;
  rescueInitializeResult: (params: unknown) => Frame;
  installingDecision: (msg: unknown) => Decision;
  npmProbeTimeoutMs: (env?: Record<string, string | undefined>) => number;
  attachColdStartProxy: (opts: {
    clientIn: NodeJS.ReadableStream;
    clientOut: NodeJS.WritableStream;
    childIn: NodeJS.WritableStream;
    childOut: NodeJS.ReadableStream;
    deadlineMs: number;
    onRescue?: () => void;
    onHandoverFailed?: (error: unknown) => void;
  }) => { phase: () => string; forceRescue: () => void };
  INSTALLING_VERSION: string;
  RESCUE_MIN_MS: number;
  RESCUE_MAX_MS: number;
  DEFAULT_CLIENT_BUDGET_MS: number;
  RESCUE_BUDGET_FRACTION: number;
};

let globalEntry!: Launcher["globalEntry"];
let serverSpec!: Launcher["serverSpec"];
let launcher!: Launcher;

async function loadLauncher(): Promise<void> {
  launcher = (await import("../../../plugin/scripts/launch-server.mjs")) as Launcher;
  globalEntry = launcher.globalEntry;
  serverSpec = launcher.serverSpec;
}

const mcpJson = (): { comfyui: { command: string; args: string[] } } =>
  JSON.parse(readFileSync(new URL("../../../plugin/.mcp.json", import.meta.url), "utf8"));

describe("launch-server shebang checkout (#1857)", () => {
  it("the shebang has no CR — vitest's transform treats `#!...\\r` as a syntax error", () => {
    const bytes = readFileSync(LAUNCHER_URL);
    const nl = bytes.indexOf(0x0a);
    expect(nl).toBeGreaterThan(0);
    expect(bytes[nl - 1], "CR before LF on the shebang").not.toBe(0x0d);
    expect(bytes.subarray(0, nl).toString("utf8")).toBe("#!/usr/bin/env node");
  });

  it("gitattributes pins the launcher to LF so a Windows clone cannot reintroduce the CR", () => {
    // git check-attr is the real matcher — reading .gitattributes and guessing
    // which pattern applies would reimplement the thing under test.
    const out = execFileSync("git", ["check-attr", "eol", "--", LAUNCHER_REL], {
      encoding: "utf8",
    });
    expect(out.trim()).toMatch(/eol: lf$/);
  });
});

describe("launch-server global resolution (#1447)", () => {
  beforeAll(loadLauncher);

  it("resolves the global entry point when the install is present", () => {
    const entry = globalEntry("/usr/local/lib/node_modules\n", { exists: () => true });
    expect(entry).toMatch(/node_modules[\\/]comfyui-mcp[\\/]dist[\\/]index\.js$/);
  });

  it("returns null — the npx path — when npm output is unusable", () => {
    for (const bad of [null, undefined, "", "  \n", 42]) {
      expect(globalEntry(bad, { exists: () => true })).toBeNull();
    }
  });

  it("returns null when the global install is absent or lacks dist/index.js", () => {
    expect(globalEntry("/usr/local/lib/node_modules", { exists: () => false })).toBeNull();
  });

  it("checks for the entry under the probed root, not a hardcoded prefix", () => {
    let checked = "";
    globalEntry("C:\\Users\\u\\AppData\\Roaming\\npm", {
      exists: (p: string) => {
        checked = p;
        return false;
      },
    });
    expect(checked).toMatch(/^C:[\\/]Users[\\/]u[\\/]AppData[\\/]Roaming[\\/]npm[\\/]/);
  });
});

describe("launch-server spawn spec (#1447)", () => {
  beforeAll(loadLauncher);

  it("warm path: spawns node on the resolved entry, no shell", () => {
    const spec = serverSpec("/global/node_modules/comfyui-mcp/dist/index.js", ["--full"], {
      platform: "linux",
      node: "/usr/bin/node",
    });
    expect(spec).toEqual({
      command: "/usr/bin/node",
      args: ["/global/node_modules/comfyui-mcp/dist/index.js", "--full"],
      shell: false,
    });
  });

  it("fallback is exactly the pre-fix invocation, with the plugin's args preserved", () => {
    const spec = serverSpec(null, ["--full"], { platform: "linux" });
    expect(spec.command).toBe("npx");
    expect(spec.args).toEqual(["-y", "comfyui-mcp", "--full"]);
    expect(spec.shell).toBe(false);
  });

  it("fallback on Windows is one validated command string — no DEP0190, no unsafe tokens", () => {
    // Node refuses to spawn npx.cmd without a shell since the 18.20.2/20.12.2
    // bat-file fix, and shell + an args array warns DEP0190 on every launch
    // (args are concatenated unescaped). So the Windows spec concatenates
    // itself, after validating every token.
    const spec = serverSpec(null, ["--full"], { platform: "win32" });
    expect(spec).toEqual({ command: "npx -y comfyui-mcp --full", args: [], shell: true });
    // …and it refuses loudly rather than letting a shell metacharacter through.
    expect(() => serverSpec(null, ["--full; rm -rf /"], { platform: "win32" })).toThrow(
      /unsafe shell token/,
    );
    expect(() => serverSpec(null, ['--name "x"'], { platform: "win32" })).toThrow(
      /unsafe shell token/,
    );
    // POSIX keeps the args array and no shell at all.
    expect(serverSpec(null, [], { platform: "darwin" })).toEqual({
      command: "npx",
      args: ["-y", "comfyui-mcp"],
      shell: false,
    });
  });
});

describe("plugin/.mcp.json (#1447)", () => {
  it("launches the wrapper via the plugin root, not npx", () => {
    const cfg = mcpJson().comfyui;
    expect(cfg.command).toBe("node");
    expect(cfg.args[0]).toBe("${CLAUDE_PLUGIN_ROOT}/scripts/launch-server.mjs");
  });

  it("still starts the server in --full mode", () => {
    expect(mcpJson().comfyui.args).toContain("--full");
  });

  it("the wrapper is import-safe — side effects sit behind the main guard", () => {
    // loadLauncher() is the behavioural half: had main() run, the test process
    // would have spawned an npx install. This pins the source shape that makes
    // the import safe.
    const src = readFileSync(LAUNCHER_URL, "utf8");
    expect(src).toMatch(/import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
    expect(src).toMatch(/if \(isMain\) \{/);
  });

  it("the wrapper never PRINTS to stdout — stdio is the MCP transport", () => {
    const src = readFileSync(LAUNCHER_URL, "utf8");
    // console.log would put a non-JSON line into the transport and desynchronise
    // the client. The cold path DOES write to stdout now, but only complete
    // JSON-RPC frames — which is asserted behaviourally below, by parsing every
    // line the launcher emits, rather than by grepping for a write call.
    expect(src).not.toMatch(/console\.log\(/);
    // The warm path still hands the real server the client's stdio untouched.
    expect(src).toMatch(/stdio: "inherit"/);
  });
});

// ---------------------------------------------------------------------------
// #1447 reopened as a first-run BLOCKER — the npx fallback is what an actual
// first-run user gets (no global install), and on a cold npm cache the install
// runs INSIDE the client's handshake budget. Measured 2026-08-25 on Windows
// against an empty npm cache and an empty global prefix: 21.6 s to the
// `initialize` response (15.2 s of it npm, 818 MB / 170 packages), and
// `claude mcp list` reporting `✘ Failed to connect — … timed out after 10000ms`
// where the identical launcher with a warm cache reported `✔ Connected`.
//
// The fix makes the wrapper answer the handshake when the server cannot, so a
// cold cache costs latency instead of a dead connection.
// ---------------------------------------------------------------------------

function collectLines(stream: NodeJS.ReadableStream): string[] {
  const lines: string[] = [];
  let buf = "";
  stream.on("data", (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) lines.push(line);
      nl = buf.indexOf("\n");
    }
  });
  return lines;
}

/** Every frame the launcher emits must be complete JSON — the transport has no other framing. */
function parseAll(lines: string[]): Frame[] {
  return lines.map((line) => {
    try {
      return JSON.parse(line) as Frame;
    } catch {
      throw new Error(`launcher wrote a non-JSON line to stdout: ${line}`);
    }
  });
}

async function waitFor<T>(probe: () => T | undefined, budgetMs = 8000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - started > budgetMs) throw new Error("timed out waiting for a frame");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("rescue deadline tracks the CLIENT's budget (#1447)", () => {
  beforeAll(loadLauncher);

  it("with a cached tree it waits, tracking MCP_TIMEOUT, which the client really does hand us", () => {
    // Verified by measurement, not by reading: a server launched by
    // `MCP_TIMEOUT=17000 claude -p …` observed process.env.MCP_TIMEOUT === "17000".
    const { coldStartDeadlineMs, RESCUE_BUDGET_FRACTION, DEFAULT_CLIENT_BUDGET_MS, RESCUE_MIN_MS, RESCUE_MAX_MS } =
      launcher;
    const cached = (env: Record<string, string | undefined>) => coldStartDeadlineMs(env, { cachedInstall: true });
    expect(cached({ MCP_TIMEOUT: "5000" })).toBe(5000 * RESCUE_BUDGET_FRACTION);
    // …and it must leave the client real margin, never spend the whole budget.
    expect(cached({ MCP_TIMEOUT: "5000" })).toBeLessThan(5000);
    expect(cached({ MCP_TIMEOUT: "10000" })).toBe(RESCUE_MAX_MS);
    // A tightened budget rescues SOONER — the direction that matters.
    expect(cached({ MCP_TIMEOUT: "5000" })).toBeLessThan(cached({ MCP_TIMEOUT: "20000" }));
    // No budget stated → the cap, never the assumed default's full share. Two
    // gate rounds pushed on the same thing from opposite sides: a deadline
    // derived from a budget we only ASSUME can outlive the budget we got. The
    // cap is what makes the assumption cheap.
    expect(cached({})).toBe(RESCUE_MAX_MS);
    expect(cached({})).toBeLessThan(DEFAULT_CLIENT_BUDGET_MS * RESCUE_BUDGET_FRACTION);
    // Junk is not a budget.
    for (const bad of ["", "soon", "-1", "0", "NaN", undefined]) {
      expect(cached({ MCP_TIMEOUT: bad })).toBe(RESCUE_MAX_MS);
    }
    expect(cached({ MCP_TIMEOUT: "600000" })).toBe(RESCUE_MAX_MS);
    // With MCP_TIMEOUT unset, the deadline must still fit inside any client
    // budget worth calling one — including budgets far below what we assume.
    for (const realBudget of [10000, 15000, 30000]) {
      expect(cached({}) + launcher.npmProbeTimeoutMs({})).toBeLessThan(realBudget);
    }
    // Round-2 gate: a floor that can OUTLIVE the budget is not a floor, it is
    // a way to miss the deadline. At MCP_TIMEOUT=1000 a 1500 ms floor would
    // have scheduled the rescue after the client had already given up.
    expect(cached({ MCP_TIMEOUT: "1000" })).toBeLessThan(1000);
    expect(cached({ MCP_TIMEOUT: "1000" })).toBe(400);
    for (const budget of [200, 1000, 3000, 10000, 30000]) {
      expect(cached({ MCP_TIMEOUT: String(budget) })).toBeLessThan(budget);
    }
    expect(cached({ MCP_TIMEOUT: "100" })).toBeLessThan(RESCUE_MIN_MS);
    // The measured warm-npx handshake is ~1.2 s. The cached deadline must stay
    // well clear of that or it would swap a healthy server's real serverInfo
    // for the stand-in on every launch — the reason this branch exists at all.
    expect(cached({})).toBeGreaterThan(1200 * 2.5);
  });

  it("with NOTHING cached it rescues at the floor — independent of the budget we assume", () => {
    // The gate's P1 on round 1: a client that waits less than DEFAULT_CLIENT_BUDGET_MS
    // and does not export MCP_TIMEOUT would be killed before a budget-derived
    // deadline fired. On a first run there is no server process to wait for at
    // all (npm has 818MB to fetch first), so waiting cannot pay — and this
    // branch must not read the assumed default.
    const { coldStartDeadlineMs, RESCUE_MIN_MS, DEFAULT_CLIENT_BUDGET_MS, RESCUE_BUDGET_FRACTION } = launcher;
    const cold = (env: Record<string, string | undefined>) => coldStartDeadlineMs(env, { cachedInstall: false });
    expect(cold({})).toBe(RESCUE_MIN_MS);
    // …and it is under every client budget in the reproduction, including the
    // 10 s one that actually produced "Failed to connect" on this machine.
    for (const budget of [5000, 10000, 30000]) {
      expect(cold({})).toBeLessThan(budget);
      expect(cold({ MCP_TIMEOUT: String(budget) })).toBeLessThan(budget);
    }
    // A budget smaller than the floor still shortens it.
    expect(cold({ MCP_TIMEOUT: "2000" })).toBe(2000 * RESCUE_BUDGET_FRACTION);
    // Raising the assumed default must NOT be able to move this branch.
    expect(cold({})).toBeLessThan(DEFAULT_CLIENT_BUDGET_MS * RESCUE_BUDGET_FRACTION);
  });

  it("bounds the npm probes by the same budget — they run BEFORE the deadline arms", () => {
    // Round-2 gate: two sequential 5 s probes could eat a 10 s budget whole and
    // the rescue would never arm. They now run concurrently AND are capped by a
    // slice of the budget, so probing plus the deadline stays inside it.
    const { npmProbeTimeoutMs, coldStartDeadlineMs } = launcher;
    expect(npmProbeTimeoutMs({})).toBe(5000);
    expect(npmProbeTimeoutMs({ MCP_TIMEOUT: "10000" })).toBe(2000);
    expect(npmProbeTimeoutMs({ MCP_TIMEOUT: "3000" })).toBe(600);
    expect(npmProbeTimeoutMs({ MCP_TIMEOUT: "100" })).toBe(300);
    for (const budget of [3000, 5000, 10000, 30000]) {
      const env = { MCP_TIMEOUT: String(budget) };
      const worst = npmProbeTimeoutMs(env) + coldStartDeadlineMs(env, { cachedInstall: false });
      expect(worst, `probe + cold deadline must fit inside ${budget}ms`).toBeLessThan(budget);
      const warm = npmProbeTimeoutMs(env) + coldStartDeadlineMs(env, { cachedInstall: true });
      expect(warm, `probe + cached deadline must fit inside ${budget}ms`).toBeLessThan(budget);
    }
  });

  it("launches both npm probes concurrently, not one after the other", () => {
    // The arithmetic above only holds if the two probes overlap; sequential
    // probes would each be allowed the full timeout. Promise.all is the shape
    // that guarantees it, and the timeout is passed in rather than defaulted.
    const src = readFileSync(LAUNCHER_URL, "utf8");
    expect(src).toMatch(/await Promise\.all\(\[\s*probeNpm\(\["root", "-g"\], probeTimeout\),/);
    expect(src).toMatch(/probeNpm\(\["config", "get", "cache"\], probeTimeout\),/);
  });

  it("reads `npm config get cache` to tell a first run from a warm one", () => {
    const { cachedNpxInstallExists } = launcher;
    const seen: string[] = [];
    const present = cachedNpxInstallExists("  C:/cache  \n", {
      readdir: () => ["8af3af54f44861ce", "other"],
      exists: (p: string) => {
        seen.push(p);
        return p.includes("8af3af54f44861ce");
      },
    });
    expect(present).toBe(true);
    // It looks under the cache npm named, in _npx, for a real manifest.
    expect(seen[0].split("\\").join("/")).toBe(
      "C:/cache/_npx/8af3af54f44861ce/node_modules/comfyui-mcp/package.json",
    );

    // A comfyui-mcp directory with no manifest is the half-deleted state a
    // failed Windows uninstall leaves behind; it is not a runnable install.
    expect(cachedNpxInstallExists("/cache", { readdir: () => ["a"], exists: () => false })).toBe(false);
    // No _npx directory at all — a genuinely first run.
    expect(
      cachedNpxInstallExists("/cache", {
        readdir: () => {
          throw new Error("ENOENT");
        },
        exists: () => true,
      }),
    ).toBe(false);
    // Every unusable answer means "assume nothing is cached", which rescues
    // sooner. Being early costs one session's serverInfo; being late costs the
    // connection.
    for (const bad of [null, undefined, "", "   ", "undefined", "null", 42]) {
      expect(cachedNpxInstallExists(bad, { readdir: () => ["a"], exists: () => true })).toBe(false);
    }
  });

  it("the stand-in handshake is honest about being a stand-in", () => {
    const result = launcher.rescueInitializeResult({ protocolVersion: "2025-03-26" }) as {
      protocolVersion: string;
      capabilities: { tools: { listChanged: boolean } };
      serverInfo: { name: string; version: string };
      instructions: string;
    };
    // Echoing the client's protocol version is what keeps it from failing the
    // handshake over a version it did not ask for.
    expect(result.protocolVersion).toBe("2025-03-26");
    // listChanged is load-bearing: it is how the REAL tools arrive at handover.
    expect(result.capabilities.tools.listChanged).toBe(true);
    // #1503: never a plausible-looking version. A stand-in must be identifiable.
    expect(result.serverInfo.version).toBe(launcher.INSTALLING_VERSION);
    expect(result.serverInfo.version).toMatch(/installing/);
    // The reopened report's actual damage was the model improvising while the
    // server was absent; the instructions have to head that off.
    expect(result.instructions).toMatch(/still installing/i);
    expect(result.instructions).toMatch(/notifications\/tools\/list_changed/);
  });

  it("routes each message that arrives mid-install", () => {
    const { installingDecision } = launcher;
    // The server's SDK serves nothing until it sees this, and the pipe preserves order.
    expect(installingDecision({ jsonrpc: "2.0", method: "notifications/initialized" })).toEqual({
      action: "forward",
    });
    // Answered HERE, never forwarded — forwarding would park the client on the
    // install, which is the timeout this fix removes, moved one method along.
    expect(installingDecision({ jsonrpc: "2.0", id: 3, method: "tools/list" })).toEqual({
      action: "reply",
      message: { jsonrpc: "2.0", id: 3, result: { tools: [] } },
    });
    expect(installingDecision({ jsonrpc: "2.0", id: 4, method: "ping" })).toEqual({
      action: "reply",
      message: { jsonrpc: "2.0", id: 4, result: {} },
    });
    expect(installingDecision({ jsonrpc: "2.0", id: 5, method: "prompts/list" })).toEqual({
      action: "reply",
      message: { jsonrpc: "2.0", id: 5, result: { prompts: [] } },
    });
    expect(installingDecision({ jsonrpc: "2.0", id: 6, method: "resources/list" })).toEqual({
      action: "reply",
      message: { jsonrpc: "2.0", id: 6, result: { resources: [] } },
    });
    // An unknown REQUEST is answered — an unanswered one is exactly the hang.
    const unknown = installingDecision({ jsonrpc: "2.0", id: 7, method: "completion/complete" });
    expect(unknown.action).toBe("reply");
    expect((unknown as { message: { error: { message: string } } }).message.error.message).toMatch(
      /still installing/i,
    );
    // A notification can only refer to something answered here; dropping it is right.
    expect(installingDecision({ jsonrpc: "2.0", method: "notifications/cancelled" })).toEqual({
      action: "drop",
    });
    // A frame with an id and no method is a RESPONSE and belongs to whoever asked.
    expect(installingDecision({ jsonrpc: "2.0", id: 8, result: {} })).toEqual({ action: "forward" });
  });

  it("routes a JSON-RPC BATCH member by member instead of parking it on the install", () => {
    // Round-3 gate: an array frame fell through to "forward", so every request
    // inside it waited for npm — the same timeout this fix removes, wearing a
    // different hat. MCP dropped batching in 2025-06-18; 2025-03-26 allows it.
    const { installingDecision } = launcher;
    const decision = installingDecision([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 8, method: "tools/list" },
      { jsonrpc: "2.0", id: 9, method: "ping" },
    ]) as { action: string; replies: Frame[]; forward: Frame[] };
    expect(decision.action).toBe("batch");
    // One array back, which is the response shape a batching client waits for.
    expect(decision.replies).toEqual([
      { jsonrpc: "2.0", id: 8, result: { tools: [] } },
      { jsonrpc: "2.0", id: 9, result: {} },
    ]);
    // …and the notification still reaches the server, or it never initializes.
    expect(decision.forward).toEqual([{ jsonrpc: "2.0", method: "notifications/initialized" }]);

    // A batch with nothing to answer is forwarded exactly as it arrived.
    expect(installingDecision([{ jsonrpc: "2.0", method: "notifications/initialized" }])).toEqual({
      action: "forward",
    });
    expect(installingDecision([])).toEqual({ action: "forward" });
  });
});

describe("cold-start proxy state machine (#1447)", () => {
  beforeAll(loadLauncher);

  function rig(deadlineMs: number) {
    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const childIn = new PassThrough();
    const childOut = new PassThrough();
    const toClient = collectLines(clientOut);
    const toChild = collectLines(childIn);
    const handoverFailures: unknown[] = [];
    const proxy = launcher.attachColdStartProxy({
      clientIn,
      clientOut,
      childIn,
      childOut,
      deadlineMs,
      onHandoverFailed: (error) => handoverFailures.push(error),
    });
    return {
      proxy,
      toClient,
      toChild,
      handoverFailures,
      writeClient: (raw: string) => clientIn.write(`${raw}\n`),
      fromClient: (m: Frame) => clientIn.write(`${JSON.stringify(m)}\n`),
      fromChild: (m: Frame) => childOut.write(`${JSON.stringify(m)}\n`),
    };
  }

  const INIT: Frame = {
    jsonrpc: "2.0",
    id: 7,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  };

  it("a server that answers in time keeps its OWN handshake — no stand-in, nothing rewritten", async () => {
    const r = rig(400);
    r.fromClient(INIT);
    await waitFor(() => (r.toChild.length ? true : undefined));
    r.fromChild({
      jsonrpc: "2.0",
      id: 7,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "comfyui-mcp", version: "0.52.117" },
        instructions: "the real instructions",
      },
    });
    const answer = (await waitFor(() => parseAll(r.toClient)[0])) as {
      result: { serverInfo: { version: string }; instructions: string };
    };
    expect(answer.result.serverInfo.version).toBe("0.52.117");
    expect(answer.result.instructions).toBe("the real instructions");
    expect(r.proxy.phase()).toBe("transparent");
    // …and the armed deadline must not fire behind it and send a second answer.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(r.toClient).toHaveLength(1);
  });

  it("a server that is still installing gets its handshake answered, then hands over", async () => {
    const r = rig(40);
    r.fromClient(INIT);

    // The initialize request still reaches the server: the wrapper is a proxy,
    // not a replacement, and the server has to complete its own handshake.
    await waitFor(() => (r.toChild.length >= 1 ? true : undefined));
    expect((parseAll(r.toChild)[0] as { method: string }).method).toBe("initialize");

    const stand = (await waitFor(() => parseAll(r.toClient)[0])) as {
      id: number;
      result: { serverInfo: { version: string }; protocolVersion: string };
    };
    expect(stand.id).toBe(7);
    expect(stand.result.serverInfo.version).toBe(launcher.INSTALLING_VERSION);
    expect(stand.result.protocolVersion).toBe("2025-03-26");
    expect(r.proxy.phase()).toBe("installing");

    r.fromClient({ jsonrpc: "2.0", method: "notifications/initialized" });
    await waitFor(() => (r.toChild.length >= 2 ? true : undefined));
    expect((parseAll(r.toChild)[1] as { method: string }).method).toBe("notifications/initialized");

    r.fromClient({ jsonrpc: "2.0", id: 8, method: "tools/list" });
    const empty = (await waitFor(() => parseAll(r.toClient)[1])) as { result: { tools: unknown[] } };
    expect(empty.result.tools).toEqual([]);
    // …and it was NOT also forwarded, which would leave a duplicate response
    // for id 8 arriving from the server a minute later.
    expect(r.toChild).toHaveLength(2);

    // The server finally answers the initialize we forwarded. The client already
    // has a result for id 7, so a second one would be a protocol violation.
    r.fromChild({
      jsonrpc: "2.0",
      id: 7,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "comfyui-mcp", version: "0.52.117" },
      },
    });
    const notice = (await waitFor(() => parseAll(r.toClient)[2])) as Frame;
    expect(notice).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    expect(parseAll(r.toClient).filter((f) => f.id === 7)).toHaveLength(1);
    expect(r.proxy.phase()).toBe("live");

    // From here it is a wire again, in both directions.
    r.fromClient({ jsonrpc: "2.0", id: 9, method: "tools/list" });
    await waitFor(() => (r.toChild.length >= 3 ? true : undefined));
    r.fromChild({ jsonrpc: "2.0", id: 9, result: { tools: [{ name: "generate_image" }] } });
    const real = (await waitFor(() => parseAll(r.toClient)[3])) as {
      result: { tools: { name: string }[] };
    };
    expect(real.result.tools[0].name).toBe("generate_image");
    expect(r.handoverFailures).toEqual([]);
  });

  it("arms on an `initialize` whose method name is JSON-ESCAPED", async () => {
    // Round-2 gate: the arming test used to be a substring match on the text
    // `"initialize"`. JSON may escape any character in a string, so an escaped
    // method is the same request to a parser and invisible to that test — and
    // the rescue would simply never fire for such a client.
    const r = rig(40);
    r.writeClient(
      '{"jsonrpc":"2.0","id":7,"method":"\\u0069nitialize","params":{"protocolVersion":"2025-03-26"}}',
    );
    const stand = (await waitFor(() => parseAll(r.toClient)[0])) as {
      id: number;
      result: { serverInfo: { version: string }; protocolVersion: string };
    };
    expect(stand.id).toBe(7);
    expect(stand.result.serverInfo.version).toBe(launcher.INSTALLING_VERSION);
    expect(stand.result.protocolVersion).toBe("2025-03-26");
  });

  it("a server that ERRORS its handshake after a rescue is not announced as connected", async () => {
    // Round-2 gate: this path swallowed the error and sent tools/list_changed,
    // leaving the client holding a success the launcher invented for a server
    // that had just refused to start. There is no way to retract the handshake,
    // so the only honest move is to stop.
    const r = rig(40);
    r.fromClient(INIT);
    await waitFor(() => parseAll(r.toClient)[0]);
    expect(r.proxy.phase()).toBe("installing");

    r.fromChild({ jsonrpc: "2.0", id: 7, error: { code: -32602, message: "unsupported protocol version" } });
    const failure = (await waitFor(() => r.handoverFailures[0])) as { message: string };
    expect(failure.message).toMatch(/unsupported protocol version/);
    expect(r.proxy.phase()).toBe("failed");

    // …and specifically NOT a tools announcement, nor a second answer for id 7.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(parseAll(r.toClient).some((f) => f.method === "notifications/tools/list_changed")).toBe(false);
    expect(parseAll(r.toClient).filter((f) => f.id === 7)).toHaveLength(1);
  });

  it("arms on a BATCHED initialize, and swallows a batched handshake response", async () => {
    // Round-6 gate. MCP 2025-03-26 forbids batching `initialize` and 2025-06-18
    // has no batching at all, so this is a client bug — but the entire rescue
    // hangs off finding that request, and "we did not arm because the client
    // was slightly wrong" is a cold start that still times out. Every other
    // frame shape here already handles batches; these two now match.
    const r = rig(40);
    r.fromClient([
      { jsonrpc: "2.0", id: 7, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    ] as unknown as Frame);
    const stand = (await waitFor(() => parseAll(r.toClient)[0])) as {
      id: number;
      result: { serverInfo: { version: string } };
    };
    expect(stand.id).toBe(7);
    expect(stand.result.serverInfo.version).toBe(launcher.INSTALLING_VERSION);

    r.fromClient({ jsonrpc: "2.0", method: "notifications/initialized" });
    // The server answers inside a batch. Its handshake response must be
    // swallowed; whatever shared the batch is still the client's.
    r.fromChild([
      { jsonrpc: "2.0", id: 7, result: { protocolVersion: "2025-03-26", capabilities: {} } },
      { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hello" } },
    ] as unknown as Frame);

    const passedThrough = (await waitFor(() => parseAll(r.toClient)[1])) as unknown as Frame[];
    expect(passedThrough).toEqual([
      { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hello" } },
    ]);
    await waitFor(() => parseAll(r.toClient).find((f) => f.method === "notifications/tools/list_changed"));
    // …and never a second answer for id 7.
    expect(parseAll(r.toClient).filter((f) => f.id === 7)).toHaveLength(1);
    expect(r.proxy.phase()).toBe("live");
  });

  it("holds the re-list announcement until the client says it is initialized", async () => {
    // Round-4 gate: the announcement was sent the instant the server's
    // handshake landed, which can be BEFORE the client has finished its own —
    // and a notification sent ahead of `notifications/initialized` is one the
    // client is entitled to ignore. Losing it costs the whole session: the tool
    // list stays empty, silently, which is the failure this issue is about.
    const r = rig(40);
    r.fromClient(INIT);
    await waitFor(() => parseAll(r.toClient)[0]);
    expect(r.proxy.phase()).toBe("installing");

    // Handover arrives first, with no `initialized` from the client yet.
    r.fromChild({
      jsonrpc: "2.0",
      id: 7,
      result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } } },
    });
    await waitFor(() => (r.proxy.phase() === "live" ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(parseAll(r.toClient).some((f) => f.method === "notifications/tools/list_changed")).toBe(false);

    // …and it fires as soon as the client is ready, even though `live` is
    // otherwise a pure wire that does not inspect frames.
    r.fromClient({ jsonrpc: "2.0", method: "notifications/initialized" });
    await waitFor(() => parseAll(r.toClient).find((f) => f.method === "notifications/tools/list_changed"));
  });

  it("repeats the announcement — one lost notification must not cost the session", async () => {
    const r = rig(40);
    r.fromClient(INIT);
    await waitFor(() => parseAll(r.toClient)[0]);
    r.fromClient({ jsonrpc: "2.0", method: "notifications/initialized" });
    r.fromChild({
      jsonrpc: "2.0",
      id: 7,
      result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } } },
    });
    const announcements = () =>
      parseAll(r.toClient).filter((f) => f.method === "notifications/tools/list_changed").length;
    await waitFor(() => (announcements() >= 1 ? true : undefined));
    // Re-listing is idempotent, so a second one costs a round-trip; a missed
    // first one costs everything.
    await waitFor(() => (announcements() >= 2 ? true : undefined), 5000);
  }, 15000);

  it("answers a batched tools/list mid-install instead of forwarding it into the wait", async () => {
    const r = rig(40);
    r.fromClient(INIT);
    await waitFor(() => parseAll(r.toClient)[0]);
    expect(r.proxy.phase()).toBe("installing");
    const forwardedSoFar = r.toChild.length;

    r.fromClient([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 8, method: "tools/list" },
    ] as unknown as Frame);

    const answer = (await waitFor(() => parseAll(r.toClient)[1])) as unknown as Frame[];
    expect(Array.isArray(answer)).toBe(true);
    expect(answer).toEqual([{ jsonrpc: "2.0", id: 8, result: { tools: [] } }]);
    // The notification went through; the request did NOT — forwarding it would
    // have left the client waiting on npm and produced a duplicate answer later.
    await waitFor(() => (r.toChild.length > forwardedSoFar ? true : undefined));
    expect(parseAll(r.toChild).slice(forwardedSoFar)).toEqual([
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ]);
  });

  it("an error the server sends in TIME is the client's to see, untouched", async () => {
    // The control for the case above: without a rescue the wrapper has no
    // opinion — the server's own error is its own answer.
    const r = rig(2000);
    r.fromClient(INIT);
    await waitFor(() => (r.toChild.length ? true : undefined));
    r.fromChild({ jsonrpc: "2.0", id: 7, error: { code: -32602, message: "unsupported protocol version" } });
    const forwarded = (await waitFor(() => parseAll(r.toClient)[0])) as { error: { message: string } };
    expect(forwarded.error.message).toBe("unsupported protocol version");
    expect(r.proxy.phase()).toBe("transparent");
    expect(r.handoverFailures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reachability. Everything above proves the mechanism works; none of it proves
// PRODUCTION REACHES IT. `main()` is the only caller, it lives behind the
// isMain guard, and a green mechanism nobody calls is this project's most
// repeated failure. So this block runs the SHIPPED launcher as a subprocess,
// exactly as .mcp.json does (`node launch-server.mjs --full`), with `npm` and
// `npx` stubbed on PATH: `npm root -g` answers a prefix with no comfyui-mcp in
// it, so the launcher takes the npx fallback, and `npx` is a stand-in server
// that cannot answer for FAKE_DELAY_MS — which is what a cold install looks
// like from the wrapper's side.
//
// Delete `runProxied` from the isMain block and the first test here fails.
// ---------------------------------------------------------------------------
const FAKE_SERVER_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  'const delay = Number(process.env.FAKE_DELAY_MS || 0);',
  'const log = process.env.FAKE_LOG;',
  'const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'const queued = [];',
  'let open = delay === 0;',
  'let buf = "";',
  'process.stdin.on("data", (c) => {',
  '  buf += c.toString("utf8");',
  '  let nl;',
  '  while ((nl = buf.indexOf("\\n")) !== -1) {',
  '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
  '    let m; try { m = JSON.parse(line); } catch { continue; }',
  '    if (log) appendFileSync(log, (m.method ?? "response") + "\\n");',
  '    if (open) handle(m); else queued.push(m);',
  '  }',
  '});',
  'function handle(m) {',
  '  if (m.method === "initialize") {',
  '    send({ jsonrpc: "2.0", id: m.id, result: {',
  '      protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18",',
  '      capabilities: { tools: { listChanged: true } },',
  '      serverInfo: { name: "fake-comfyui-mcp", version: "9.9.9" },',
  '      instructions: "REAL_SERVER_INSTRUCTIONS",',
  '    }});',
  '  } else if (m.method === "tools/list") {',
  '    send({ jsonrpc: "2.0", id: m.id, result: { tools: [',
  '      { name: "fake_generate", description: "d", inputSchema: { type: "object", properties: {} } },',
  '    ]}});',
  '  } else if (m.id !== undefined && m.id !== null) {',
  '    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unhandled" } });',
  '  }',
  '}',
  'if (!open) setTimeout(() => { open = true; for (const m of queued.splice(0)) handle(m); }, delay);',
].join("\n");

describe("the shipped launcher rescues a real cold start (#1447)", () => {
  let stubDir = "";
  let coldCache = "";
  let warmCache = "";
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeAll(async () => {
    await loadLauncher();
    stubDir = mkdtempSync(join(tmpdir(), "launch-1447-"));
    const emptyGlobal = join(stubDir, "empty-global-root");
    const fakeServer = join(stubDir, "fake-server.mjs");
    writeFileSync(fakeServer, FAKE_SERVER_SOURCE, "utf8");
    // Two npm cache roots: one a first run (no _npx at all), one with a tree
    // already unpacked, so BOTH deadline branches run through production.
    coldCache = join(stubDir, "cold-cache");
    warmCache = join(stubDir, "warm-cache");
    mkdirSync(join(warmCache, "_npx", "deadbeef", "node_modules", "comfyui-mcp"), { recursive: true });
    writeFileSync(
      join(warmCache, "_npx", "deadbeef", "node_modules", "comfyui-mcp", "package.json"),
      JSON.stringify({ name: "comfyui-mcp", version: "9.9.9" }),
      "utf8",
    );
    // `npm root -g` and `npm config get cache` are different questions, so the
    // stub answers them differently — otherwise the cache branch would be handed
    // the global root and prove nothing.
    // POSIX forms (npm/npx are spawned without a shell there) …
    writeFileSync(
      join(stubDir, "npm"),
      `#!/bin/sh\nif [ "$1" = "config" ]; then echo "$NPM_STUB_CACHE"; else echo "${emptyGlobal}"; fi\n`,
      "utf8",
    );
    writeFileSync(join(stubDir, "npx"), `#!/bin/sh\nexec "${process.execPath}" "${fakeServer}"\n`, "utf8");
    chmodSync(join(stubDir, "npm"), 0o755);
    chmodSync(join(stubDir, "npx"), 0o755);
    // … and the .cmd forms, because the Windows spec goes through cmd.exe.
    writeFileSync(
      join(stubDir, "npm.cmd"),
      `@echo off\r\nif "%1"=="config" (echo %NPM_STUB_CACHE%) else (echo ${emptyGlobal})\r\n`,
      "utf8",
    );
    writeFileSync(join(stubDir, "npx.cmd"), `@"${process.execPath}" "${fakeServer}"\r\n`, "utf8");
  });

  afterAll(() => {
    for (const child of children) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    if (stubDir) rmSync(stubDir, { recursive: true, force: true });
  });

  function launch(env: Record<string, string>): {
    stdout: string[];
    send: (m: Frame) => void;
    stderr: () => string;
  } {
    const child = spawn(process.execPath, [fileURLToPath(LAUNCHER_URL), "--full"], {
      env: { ...process.env, ...env, PATH: `${stubDir}${delimiter}${process.env.PATH ?? ""}` },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    children.push(child);
    let err = "";
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    return {
      stdout: collectLines(child.stdout),
      send: (m: Frame) => child.stdin.write(`${JSON.stringify(m)}\n`),
      stderr: () => err,
    };
  }

  const INIT: Frame = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  };

  it(
    "answers the handshake while the install is still running, then serves the real tools",
    async () => {
      const log = join(stubDir, "rescue-log.txt");
      // A first run: `npm config get cache` names a cache with no _npx.
      //
      // The budget here is a GENEROUS 30 s on purpose. If the launcher ignored
      // the cache answer and used the cached branch, the deadline would be
      // 12 s, the stand-in server would answer first at 4 s, and the handshake
      // below would carry version 9.9.9 instead of the sentinel — so this test
      // fails if the cache probe is ever left dead in production.
      const started = Date.now();
      const client = launch({
        MCP_TIMEOUT: "30000",
        NPM_STUB_CACHE: coldCache,
        FAKE_DELAY_MS: "4000",
        FAKE_LOG: log,
      });
      client.send(INIT);

      const handshake = (await waitFor(() => parseAll(client.stdout).find((f) => f.id === 1), 12000)) as {
        result: { serverInfo: { version: string }; capabilities: { tools: { listChanged: boolean } } };
      };
      // …and it beat the server rather than merely differing from it.
      expect(Date.now() - started).toBeLessThan(3500);
      expect(handshake.result.serverInfo.version).toBe(launcher.INSTALLING_VERSION);
      expect(handshake.result.capabilities.tools.listChanged).toBe(true);

      client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const empty = (await waitFor(() => parseAll(client.stdout).find((f) => f.id === 2), 8000)) as {
        result: { tools: unknown[] };
      };
      expect(empty.result.tools).toEqual([]);

      // The server comes up; the client is told to re-list rather than handed a
      // second answer for id 1.
      await waitFor(
        () => parseAll(client.stdout).find((f) => f.method === "notifications/tools/list_changed"),
        15000,
      );
      expect(parseAll(client.stdout).filter((f) => f.id === 1)).toHaveLength(1);

      client.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
      const real = (await waitFor(() => parseAll(client.stdout).find((f) => f.id === 3), 8000)) as {
        result: { tools: { name: string }[] };
      };
      expect(real.result.tools.map((t) => t.name)).toEqual(["fake_generate"]);

      // The server really did receive its own handshake — the wrapper proxied
      // it rather than standing in for the server forever.
      const received = readFileSync(log, "utf8");
      expect(received).toMatch(/^initialize$/m);
      expect(received).toMatch(/^notifications\/initialized$/m);
      // The rescue is announced on stderr, never on the transport.
      expect(client.stderr()).toMatch(/answered the MCP handshake on its behalf/);
    },
    25000,
  );

  it(
    "control: a server that starts promptly keeps its own serverInfo and instructions",
    async () => {
      const client = launch({ MCP_TIMEOUT: "30000", NPM_STUB_CACHE: warmCache, FAKE_DELAY_MS: "0" });
      client.send(INIT);
      const handshake = (await waitFor(() => parseAll(client.stdout).find((f) => f.id === 1), 12000)) as {
        result: { serverInfo: { name: string; version: string }; instructions: string };
      };
      // If the wrapper hijacked every launch, THIS is what would regress: the
      // real version (#1503) and the server's own instructions.
      expect(handshake.result.serverInfo).toEqual({ name: "fake-comfyui-mcp", version: "9.9.9" });
      expect(handshake.result.instructions).toBe("REAL_SERVER_INSTRUCTIONS");
      expect(client.stderr()).not.toMatch(/answered the MCP handshake on its behalf/);
    },
    25000,
  );

  it(
    "a CACHED tree is still rescued when the client budget is tight",
    async () => {
      // The cached branch waits longer on purpose, but it is still bounded by
      // the client's budget: MCP_TIMEOUT 4000 → a 1600 ms deadline, so a server
      // that takes 4 s (npx updating to a newer release, say) is rescued rather
      // than left to time out.
      const client = launch({ MCP_TIMEOUT: "4000", NPM_STUB_CACHE: warmCache, FAKE_DELAY_MS: "4000" });
      client.send(INIT);
      const handshake = (await waitFor(() => parseAll(client.stdout).find((f) => f.id === 1), 12000)) as {
        result: { serverInfo: { version: string } };
      };
      expect(handshake.result.serverInfo.version).toBe(launcher.INSTALLING_VERSION);
      // A real client completes its own handshake here, and the launcher will
      // not announce a re-list before it does.
      client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await waitFor(
        () => parseAll(client.stdout).find((f) => f.method === "notifications/tools/list_changed"),
        15000,
      );
    },
    25000,
  );
});
