// Issue #250 — a backend whose prepare() rejects at agent start (e.g. an
// OpenAI-dialect provider 401ing on an invalid API key) must degrade THAT TAB
// ONLY. Before the fix, the manager routed every start failure to onAgentFatal,
// which the orchestrator wires to a process-wide self-exit ("closing the bridge
// so a fresh orchestrator can take over") — killing every OTHER tab too,
// including healthy sessions on different providers.
//
// Contract under test:
//  (a) a start failure must NOT fire onAgentFatal (no self-exit) and must not
//      disturb another tab's live agent;
//  (b) it produces the per-tab degraded notification (onStartFailure when
//      wired, else the onSay fallback);
//  (c) the tab's slot stays RECOVERABLE: after the user fixes the key, a new
//      send on the SAME tab spawns a fresh agent that works;
//  (d) the genuinely process-level path is preserved: the bounded self-restart
//      give-up ("session keeps ending immediately") still fires onAgentFatal.

import { describe, expect, it, beforeAll } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;

beforeAll(async () => {
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
});

/** A backend whose prepare() rejects — the #250 repro: OllamaBackend.prepare()
 *  throwing `endpoint ... rejected the key (http 401)` on an invalid key. */
class Rejecting401Backend implements AgentBackend {
  readonly id = "moonshot" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  prepareCalls = 0;

  async prepare(): Promise<void> {
    this.prepareCalls += 1;
    throw new Error("endpoint https://api.moonshot.ai/v1 rejected the key (http 401)");
  }

  // eslint-disable-next-line require-yield
  async *run(): AsyncGenerator<AgentEvent> {
    throw new Error("run() must never be reached when prepare() rejects");
  }

  async interrupt(): Promise<void> {}
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

/** A healthy backend that records turns and completes them immediately. */
class HealthyBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  runCount = 0;
  turnTexts: string[] = [];

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    this.runCount += 1;
    yield { type: "session", sessionId: `sess-${this.runCount}` };
    for await (const turn of opts.channel) {
      this.turnTexts.push(turn.text);
      yield { type: "result", ok: true, subtype: "success" };
    }
  }

  async interrupt(): Promise<void> {}
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

/** A backend whose session ends IMMEDIATELY every time — drives the bounded
 *  self-restart loop to its give-up threshold (the genuinely fatal path). */
class InstantlyDroppingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  runCount = 0;

  // eslint-disable-next-line require-yield
  async *run(): AsyncGenerator<AgentEvent> {
    this.runCount += 1;
    // Return immediately: "session ended" with zero events.
  }

  async interrupt(): Promise<void> {}
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

interface Recorded {
  says: Array<{ tab: string; text: string }>;
  startFailures: Array<{ tab: string; message: string }>;
  fatals: Array<{ tab: string; reason: string }>;
}

function makeManager(
  makeBackend: (key: string) => AgentBackend | undefined,
  opts: { wireStartFailure?: boolean } = {},
): { manager: InstanceType<typeof PanelAgentManager>; rec: Recorded } {
  const rec: Recorded = { says: [], startFailures: [], fatals: [] };
  const manager = new PanelAgentManager({
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: (tab: string, text: string) => rec.says.push({ tab, text }),
    onTurn: () => {},
    makeBackend,
    ...(opts.wireStartFailure === false
      ? {}
      : {
          onStartFailure: (tab: string, message: string) =>
            rec.startFailures.push({ tab, message }),
        }),
    onAgentFatal: (tab: string, reason: string) => rec.fatals.push({ tab, reason }),
  } as never);
  return { manager, rec };
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("per-tab start failure (issue #250)", () => {
  it("a 401 in prepare() degrades ONLY that tab: onStartFailure fires, onAgentFatal does NOT, and another tab keeps working", async () => {
    const bad = new Rejecting401Backend();
    const good = new HealthyBackend();
    const badTab = "tab-moonshot::moonshot";
    const goodTab = "tab-claude::claude";
    const { manager, rec } = makeManager((key) => (key === badTab ? bad : good));

    // Healthy tab first — it must survive the other tab's start failure.
    manager.send(goodTab, "hello healthy");
    await waitFor(() => good.turnTexts.length >= 1);

    // Bad-key tab: prepare() rejects with the 401.
    manager.send(badTab, "hello moonshot");
    await waitFor(() => rec.startFailures.length >= 1);

    // (b) the per-tab degraded notification carries the honest error…
    expect(rec.startFailures[0]!.tab).toBe(badTab);
    expect(rec.startFailures[0]!.message).toMatch(/rejected the key \(http 401\)/);
    // …and (a) NOTHING escalated to the process-fatal path (the old behavior
    // called onAgentFatal("agent failed to start") → orchestrator self-exit).
    expect(rec.fatals).toHaveLength(0);
    // The dead agent was dropped — the slot is empty, not wedged.
    expect(manager.hasLiveAgent(badTab)).toBe(false);

    // The HEALTHY tab is untouched: still live, still processes turns.
    expect(manager.hasLiveAgent(goodTab)).toBe(true);
    manager.send(goodTab, "still alive?");
    await waitFor(() => good.turnTexts.length >= 2);
    expect(good.turnTexts).toContain("still alive?");
    expect(rec.fatals).toHaveLength(0);

    await manager.stopAll();
  });

  it("without onStartFailure wired, falls back to a per-tab onSay — still no onAgentFatal", async () => {
    const bad = new Rejecting401Backend();
    const { manager, rec } = makeManager(() => bad, { wireStartFailure: false });
    const tab = "tab-glm::glm";

    manager.send(tab, "hi");
    await waitFor(() => rec.says.some((s) => s.text.includes("could not start")));

    const say = rec.says.find((s) => s.text.includes("could not start"))!;
    expect(say.tab).toBe(tab);
    expect(say.text).toMatch(/^⚠️/);
    expect(say.text).toMatch(/http 401/);
    expect(rec.fatals).toHaveLength(0);

    await manager.stopAll();
  });

  it("the tab is RECOVERABLE: after the key is fixed, a new send on the SAME tab starts a working agent", async () => {
    const bad = new Rejecting401Backend();
    const good = new HealthyBackend();
    let keyFixed = false;
    const { manager, rec } = makeManager(() => (keyFixed ? good : bad));
    const tab = "tab-moonshot::moonshot";

    // First attempt: bad key → per-tab failure, slot cleared.
    manager.send(tab, "first try");
    await waitFor(() => rec.startFailures.length >= 1);
    expect(manager.hasLiveAgent(tab)).toBe(false);

    // User fixes the key (factory now builds a healthy backend) and retries.
    keyFixed = true;
    manager.send(tab, "second try");
    await waitFor(() => good.turnTexts.length >= 1);
    expect(good.turnTexts).toContain("second try");
    expect(manager.hasLiveAgent(tab)).toBe(true);
    // Still no fatal escalation anywhere in the sequence.
    expect(rec.fatals).toHaveLength(0);

    await manager.stopAll();
  });

  it("PRESERVED: the bounded self-restart give-up still routes to onAgentFatal (process-level)", async () => {
    const dropping = new InstantlyDroppingBackend();
    const { manager, rec } = makeManager(() => dropping);
    const tab = "tab-drop::claude";

    manager.send(tab, "hello");
    // 4 immediate session drops (~250ms apart) trip the give-up threshold.
    await waitFor(() => rec.fatals.length >= 1, 10_000);

    expect(rec.fatals[0]!.tab).toBe(tab);
    expect(rec.fatals[0]!.reason).toMatch(/self-restart gave up/);
    // The give-up is NOT a start failure — the per-tab path must not have fired.
    expect(rec.startFailures).toHaveLength(0);

    await manager.stopAll();
  }, 15_000);
});
