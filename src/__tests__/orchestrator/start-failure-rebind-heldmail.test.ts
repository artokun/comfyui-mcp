// Issues #255 + #256 — follow-ups to the per-tab start-failure work (#250/#253).
//
// #255: settle() used a KEY-based guard (`agents.get(tabId) !== agent`), so when
// rebindAgent() moved a still-starting agent to a new key (panel tab-id
// migration) and prepare() then rejected, settle early-returned — the dead
// agent stayed mapped under the NEW key forever: hasLiveAgent true, queue never
// drained, no onStartFailure, tab wedged until reset. settle must locate the
// agent by IDENTITY and clean up / report under the CURRENT key.
//
// #256: messages queued into a doomed agent between spawn and prepare()-reject
// died silently with it (no seen ack, no failure ack). settle(err) now captures
// the agent's still-queued mail into the manager's held-mail map, and the next
// spawn on the same key re-delivers it — NO silent drop.

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

/** A backend whose prepare() BLOCKS until the test releases it — so the test
 *  can rebind / queue messages inside the spawn → prepare()-settle window,
 *  then reject (or resolve) deterministically. */
class GatedPrepareBackend implements AgentBackend {
  readonly id = "moonshot" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  prepareCalls = 0;
  private release!: (err?: Error) => void;
  private gate = new Promise<void>((resolve, reject) => {
    this.release = (err?: Error) => (err ? reject(err) : resolve());
  });

  async prepare(): Promise<void> {
    this.prepareCalls += 1;
    await this.gate;
  }

  /** Reject the pending prepare() (the 401-during-start repro). */
  failPrepare(message = "endpoint rejected the key (http 401)"): void {
    this.release(new Error(message));
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

/** A backend whose turn stays IN FLIGHT until the test releases it — for
 *  pinning isTurnActive() (the predicate the orchestrator's held-during-gen
 *  branch checks before pushing a spinner-clearing turn:"done"). */
class HoldingTurnBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turnStarted = false;
  private released = false;
  private releaseTurn: (() => void) | null = null;

  /** Open the gate PERMANENTLY: the held turn completes, and any turns queued
   *  behind it complete immediately too (so the tab can settle to idle). */
  release(): void {
    this.released = true;
    this.releaseTurn?.();
    this.releaseTurn = null;
  }

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-hold" };
    for await (const _turn of opts.channel) {
      this.turnStarted = true;
      if (!this.released) {
        await new Promise<void>((resolve) => {
          this.releaseTurn = resolve;
        });
      }
      yield { type: "result", ok: true, subtype: "success" };
    }
  }

  async interrupt(): Promise<void> {}
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

/** A healthy backend that records the turns it receives and completes them. */
class HealthyBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turnTexts: string[] = [];

  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    yield { type: "session", sessionId: "sess-healthy" };
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

interface Recorded {
  says: Array<{ tab: string; text: string }>;
  startFailures: Array<{ tab: string; message: string }>;
  fatals: Array<{ tab: string; reason: string }>;
  seen: Array<{ tab: string; mid: string }>;
}

function makeManager(makeBackend: (key: string) => AgentBackend | undefined): {
  manager: InstanceType<typeof PanelAgentManager>;
  rec: Recorded;
} {
  const rec: Recorded = { says: [], startFailures: [], fatals: [], seen: [] };
  const manager = new PanelAgentManager({
    mcpServers: {},
    systemAppend: "",
    model: "claude-test",
    onSay: (tab: string, text: string) => rec.says.push({ tab, text }),
    onTurn: () => {},
    onSeen: (tab: string, mid: string) => rec.seen.push({ tab, mid }),
    makeBackend,
    onStartFailure: (tab: string, message: string) => rec.startFailures.push({ tab, message }),
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

describe("rebind during a failing start (issue #255)", () => {
  it("settle finds the rebound agent by IDENTITY: slot cleaned under the NEW key, onStartFailure fires for the NEW key", async () => {
    const bad = new GatedPrepareBackend();
    const good = new HealthyBackend();
    let keyFixed = false;
    const { manager, rec } = makeManager(() => (keyFixed ? good : bad));
    const oldKey = "tmp:old-tab::moonshot";
    const newKey = "wf:new-tab::moonshot";

    // Spawn: prepare() is now pending (gated), the agent is mapped under oldKey.
    manager.send(oldKey, "hello while starting");
    await waitFor(() => bad.prepareCalls === 1);
    expect(manager.hasLiveAgent(oldKey)).toBe(true);

    // Panel tab-id migration lands while the agent is STILL starting.
    expect(manager.rebindAgent(oldKey, newKey)).toBe(true);
    expect(manager.hasLiveAgent(newKey)).toBe(true);
    expect(manager.hasLiveAgent(oldKey)).toBe(false);

    // Now the start fails (401). The old key-based guard early-returned here,
    // stranding the dead agent under newKey with no warning.
    bad.failPrepare();
    await waitFor(() => rec.startFailures.length >= 1);

    // The failure is reported under the CURRENT (new) key…
    expect(rec.startFailures[0]!.tab).toBe(newKey);
    expect(rec.startFailures[0]!.message).toMatch(/http 401/);
    // …the slot is CLEANED under both keys (not wedged, hasLiveAgent honest)…
    expect(manager.hasLiveAgent(newKey)).toBe(false);
    expect(manager.hasLiveAgent(oldKey)).toBe(false);
    // …and nothing escalated to the process-fatal path.
    expect(rec.fatals).toHaveLength(0);

    // The tab stays RECOVERABLE under its new key: fix the key, resend, works —
    // and the message queued into the doomed start is re-delivered first (#256).
    keyFixed = true;
    manager.send(newKey, "after fix");
    await waitFor(() => good.turnTexts.length >= 1);
    expect(good.turnTexts.join("\n\n")).toContain("hello while starting");
    expect(good.turnTexts.join("\n\n")).toContain("after fix");

    await manager.stopAll();
  });
});

describe("held mail across a failed start (issue #256)", () => {
  it("messages queued between spawn and prepare()-reject are re-delivered, in order, after a successful retry", async () => {
    const bad = new GatedPrepareBackend();
    const good = new HealthyBackend();
    let keyFixed = false;
    const { manager, rec } = makeManager(() => (keyFixed ? good : bad));
    const key = "tab-held::moonshot";

    // First message triggers the spawn; the second lands in the doomed agent's
    // queue while prepare() is still pending.
    manager.send(key, "first (triggered the spawn)", { mid: "mid-1" });
    await waitFor(() => bad.prepareCalls === 1);
    manager.send(key, "second (queued into the doomed window)", { mid: "mid-2" });

    // The start fails — before the fix, both messages died silently here.
    bad.failPrepare();
    await waitFor(() => rec.startFailures.length >= 1);
    expect(manager.hasLiveAgent(key)).toBe(false);
    // NOT silently seen: neither message was consumed by the dead agent.
    expect(rec.seen).toHaveLength(0);

    // User fixes the key and retries — the retry message spawns a fresh agent,
    // which must re-deliver the held mail FIRST (chronological order).
    keyFixed = true;
    manager.send(key, "third (the retry)", { mid: "mid-3" });
    await waitFor(() => good.turnTexts.length >= 1);

    const delivered = good.turnTexts.join("\n\n");
    expect(delivered).toContain("first (triggered the spawn)");
    expect(delivered).toContain("second (queued into the doomed window)");
    expect(delivered).toContain("third (the retry)");
    expect(delivered.indexOf("first")).toBeLessThan(delivered.indexOf("second"));
    expect(delivered.indexOf("second")).toBeLessThan(delivered.indexOf("third"));

    // The re-delivery is VISIBLE: each original mid gets its seen ack when the
    // fresh agent dequeues it, so the panel bubbles flip from queued to read.
    await waitFor(() => rec.seen.length >= 3);
    expect(rec.seen.map((s) => s.mid)).toEqual(["mid-1", "mid-2", "mid-3"]);

    await manager.stopAll();
  });

  it("held mail BLOCKS the self-restart gate: hasHeldMail()/allIdle() refuse until re-delivery lands (#260 review, finding 1)", async () => {
    const bad = new GatedPrepareBackend();
    const good = new HealthyBackend();
    let keyFixed = false;
    const { manager, rec } = makeManager(() => (keyFixed ? good : bad));
    const key = "tab-gate::moonshot";

    // Nothing held yet — the gate is open.
    expect(manager.hasHeldMail()).toBe(false);

    manager.send(key, "parked by the failed start");
    await waitFor(() => bad.prepareCalls === 1);
    bad.failPrepare();
    await waitFor(() => rec.startFailures.length >= 1);

    // Mail is parked and there is NO live agent — the old agent-only allIdle()
    // returned true here, letting an auto-restart tear down (stopAll erases the
    // held-mail map) and silently drop the parked message.
    expect(manager.hasHeldMail()).toBe(true);
    expect(manager.allIdle()).toBe(false);

    // Successful retry re-delivers; once the turn completes the gate reopens.
    keyFixed = true;
    manager.send(key, "retry");
    await waitFor(() => good.turnTexts.length >= 1);
    expect(good.turnTexts.join("\n\n")).toContain("parked by the failed start");
    expect(manager.hasHeldMail()).toBe(false);
    await waitFor(() => manager.allIdle());

    await manager.stopAll();
  });

  it("cancel-by-mid reaches HELD mail: a deleted prompt is NOT re-delivered on the retry (#260 review, finding 2)", async () => {
    const bad = new GatedPrepareBackend();
    const good = new HealthyBackend();
    let keyFixed = false;
    const { manager, rec } = makeManager(() => (keyFixed ? good : bad));
    const key = "tab-cancel::moonshot";

    manager.send(key, "keep me", { mid: "mid-keep" });
    await waitFor(() => bad.prepareCalls === 1);
    manager.send(key, "delete me", { mid: "mid-del" });
    bad.failPrepare();
    await waitFor(() => rec.startFailures.length >= 1);
    expect(manager.hasLiveAgent(key)).toBe(false);

    // With no live agent, cancel must reach the held-mail map by mid.
    expect(manager.cancelQueued(key, "mid-del")).toBe(true);
    expect(manager.cancelQueued(key, "mid-unknown")).toBe(false);

    keyFixed = true;
    manager.send(key, "the retry", { mid: "mid-retry" });
    await waitFor(() => good.turnTexts.length >= 1);
    const delivered = good.turnTexts.join("\n\n");
    expect(delivered).toContain("keep me");
    expect(delivered).toContain("the retry");
    expect(delivered).not.toContain("delete me");
    // The cancelled message is never dequeued, so it gets no seen ack.
    await waitFor(() => rec.seen.length >= 2);
    expect(rec.seen.map((s) => s.mid)).toEqual(["mid-keep", "mid-retry"]);

    await manager.stopAll();
  });

  it("reorder-by-mid reaches HELD mail: the retry re-delivers in the panel's new order", async () => {
    const bad = new GatedPrepareBackend();
    const good = new HealthyBackend();
    let keyFixed = false;
    const { manager, rec } = makeManager(() => (keyFixed ? good : bad));
    const key = "tab-reorder::moonshot";

    manager.send(key, "alpha", { mid: "mid-a" });
    await waitFor(() => bad.prepareCalls === 1);
    manager.send(key, "beta", { mid: "mid-b" });
    bad.failPrepare();
    await waitFor(() => rec.startFailures.length >= 1);

    // No live agent — the reorder must land on the held-mail entries.
    expect(manager.reorderQueue(key, ["mid-b", "mid-a"])).toBe(true);

    keyFixed = true;
    manager.send(key, "gamma", { mid: "mid-c" });
    await waitFor(() => good.turnTexts.length >= 1);
    const delivered = good.turnTexts.join("\n\n");
    expect(delivered.indexOf("beta")).toBeLessThan(delivered.indexOf("alpha"));
    expect(delivered.indexOf("alpha")).toBeLessThan(delivered.indexOf("gamma"));

    await manager.stopAll();
  });

  it("held mail follows a rebind: a failed-start message re-delivers under the tab's NEW key", async () => {
    const bad = new GatedPrepareBackend();
    const good = new HealthyBackend();
    let keyFixed = false;
    const { manager, rec } = makeManager(() => (keyFixed ? good : bad));
    const oldKey = "tmp:before::moonshot";
    const newKey = "wf:after::moonshot";

    manager.send(oldKey, "message into the doomed start");
    await waitFor(() => bad.prepareCalls === 1);
    bad.failPrepare();
    await waitFor(() => rec.startFailures.length >= 1);
    expect(manager.hasLiveAgent(oldKey)).toBe(false);

    // Tab-id migration AFTER the failure — no live agent, but the held mail is
    // durable state and must move with the tab.
    manager.rebindAgent(oldKey, newKey);

    keyFixed = true;
    manager.send(newKey, "retry on the new key");
    await waitFor(() => good.turnTexts.length >= 1);
    const delivered = good.turnTexts.join("\n\n");
    expect(delivered).toContain("message into the doomed start");
    expect(delivered).toContain("retry on the new key");

    await manager.stopAll();
  });
});

describe("isTurnActive — the held-during-gen spinner-clear guard (#260 review, finding 3)", () => {
  // The orchestrator's VRAM-hold branch (index.ts) pushes turn:"done" to clear
  // the optimistic working spinner ONLY when !manager.isTurnActive(key): a
  // tab-wide "done" during an ACTIVE earlier turn would hide that turn's
  // spinner and disarm its resume nudge. This pins the predicate the branch
  // gates on: active while a turn is in flight (or queued behind one), inactive
  // when the tab is idle or has no agent at all.
  it("is true while a turn is in flight (and while messages queue behind it), false when idle or absent", async () => {
    const holding = new HoldingTurnBackend();
    const { manager } = makeManager(() => holding);
    const key = "tab-active::claude";

    // No agent at all → inactive (the held branch MAY clear the spinner).
    expect(manager.isTurnActive(key)).toBe(false);

    // A turn in flight → ACTIVE (the held branch must NOT push turn:"done").
    manager.send(key, "long turn");
    await waitFor(() => holding.turnStarted);
    expect(manager.isTurnActive(key)).toBe(true);

    // Still active while a follow-up waits behind the live turn — that queued
    // message will drive its own working→done cycle.
    manager.send(key, "queued behind the live turn");
    expect(manager.isTurnActive(key)).toBe(true);

    // Release both turns → the tab settles back to inactive.
    holding.release();
    await waitFor(() => !manager.isTurnActive(key), 5000);

    await manager.stopAll();
  });
});
