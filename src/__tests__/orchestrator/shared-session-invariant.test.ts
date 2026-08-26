// #884 — THE INVARIANT (owner-stated, absolute): agents are SESSION-bound, with
// knowledge of all open workflows. One session spans every panel, every browser
// tab and every workflow; it is keyed and persisted by the orchestrator (on disk,
// in ~/.comfyui-mcp/sessions), never scoped to a workflow. These are the
// regression tests for the per-workflow keying that violated it: they FAIL on
// the pre-#884 code (agent key = `tabId::backend`, per-workflow teardown in the
// hello handler) and pass now.
//
// The hello handler lives inline in the orchestrator start function, so — as
// with the other index.ts boundary guards (see ask-answer-journal.test.ts) — the
// wiring is pinned at source level, while the behavior underneath (one key ⇒ one
// agent ⇒ one history; the shared key resolves resume from the store on the REAL
// spawn path) is driven through the real PanelAgentManager + SessionStore.

import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  ModelChoice,
} from "../../orchestrator/agent-backend.js";
import { CLAUDE_CAPABILITIES } from "../../orchestrator/agent-backend.js";
import { SessionStore } from "../../orchestrator/session-store.js";
import { sharedAgentKey } from "../../services/session-scope.js";
import { TurnOriginTracker } from "../../orchestrator/turn-origins.js";

let PanelAgentManager: typeof import("../../orchestrator/panel-agent.js").PanelAgentManager;
beforeAll(async () => {
  ({ PanelAgentManager } = await import("../../orchestrator/panel-agent.js"));
});

const PORT = 59321;
const DIR = mkdtempSync(join(tmpdir(), "cmcp-sessions-"));
afterEach(() => {
  for (const f of [
    join(DIR, `panel-sessions-${PORT}.json`),
    join(tmpdir(), `comfyui-mcp-panel-sessions-${PORT}.json`),
  ]) {
    try {
      rmSync(f);
    } catch {
      /* already gone */
    }
  }
});
afterAll(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

class RecordingBackend implements AgentBackend {
  readonly id = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;
  turnTexts: string[] = [];
  resumes: Array<string | undefined> = [];
  /** Each run() is one SDK session standing up — and with it every MCP child
   *  (comfyui + the user's inherited servers). close() is that session (and its
   *  children) being torn down. #902's "every MCP server disconnected" is one
   *  close+run cycle of this. */
  closes = 0;
  sessionId = "sess-shared";
  async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
    this.resumes.push(opts.resume);
    for await (const turn of opts.channel) {
      yield { type: "session", sessionId: this.sessionId };
      this.turnTexts.push(turn.text);
      yield { type: "result", ok: true, subtype: "success" } as AgentEvent;
    }
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    this.closes += 1;
  }
  async listModels(): Promise<ModelChoice[]> {
    return [];
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const indexSrc = (): string =>
  readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf8");

describe("sessions are orchestrator-scoped, never workflow-scoped (#884)", () => {
  it("SOURCE: the agent key is the shared scope + backend — the panel tab id is NOT part of it", () => {
    const src = indexSrc();
    // The exact composition the orchestrator uses. On the pre-#884 code this was
    // `panelTabId + AGENT_KEY_SEP + backendForTab(panelTabId)` — the regression.
    expect(src).toContain("SHARED_SESSION_SCOPE + AGENT_KEY_SEP + backendForTab(panelTabId)");
    expect(src).not.toContain("panelTabId + AGENT_KEY_SEP + backendForTab");
    // And no composite key is ever built from a live panel tab id anymore.
    expect(src).not.toMatch(/panelTab \+ AGENT_KEY_SEP/);
    expect(src).not.toMatch(/tab_id \+ AGENT_KEY_SEP/);
  });

  it("SOURCE: a same-socket re-hello (workflow switch / save / rename / Workflow→New) never touches the agent", () => {
    const src = indexSrc();
    const start = src.indexOf("if (migratedFrom && migratedFrom !== panelTab) {");
    expect(start, "migration block not found").toBeGreaterThan(-1);
    // The block ends at the stamp-recording comment that follows it.
    const end = src.indexOf("Record this tab's trusted per-workflow COMMAND STAMP", start);
    expect(end, "post-migration anchor not found").toBeGreaterThan(start);
    const block = src.slice(start, end);
    // No agent lifecycle calls: the conversation deliberately CONTINUES. This is
    // also the #902 fix: retiring the CALLING agent here tore down its SDK
    // session mid-panel_open_workflow — and with it every MCP child (comfyui +
    // the user's inherited servers), the reported "89 deferred tools are no
    // longer available" disconnect.
    expect(block).not.toContain("manager.retire(");
    expect(block).not.toContain("manager.reset(");
    expect(block).not.toContain("manager.rebindAgent(");
    // …and no bridge-route revocation: the in-flight open's verify probes must
    // keep routing (the other half of #902's failed rebind guard).
    expect(block).not.toContain("revokeTabMigration");
    // Pending deliveries FOLLOW the socket instead of being dropped.
    expect(block).toContain("RunCompletions.moveKey(migratedFrom, panelTab)");
    expect(block).toContain("AskAnswers.moveKey(migratedFrom, panelTab)");
  });

  it("SOURCE: a provider switch retires the shared agent only when NO other tab still uses it", () => {
    const src = indexSrc();
    const sites = [...src.matchAll(/manager\.retire\(/g)];
    // Exactly the two provider-switch sites (hello + set_backend) — nothing else
    // retires an agent, and both are guarded by the shared-usage check.
    expect(sites.length).toBe(2);
    for (const m of sites) {
      const before = src.slice(Math.max(0, m.index! - 600), m.index!);
      expect(before, "retire must be guarded by shouldRetireSharedAgent").toContain(
        "shouldRetireSharedAgent(",
      );
    }
  });

  it("SOURCE: scope mutations are stamped with the TURN's issue-time workflow, never re-resolved (codex r1 P0 / r2)", () => {
    // The stamp/pin/inheritance MACHINERY lives in turn-origins.ts and is
    // driven behaviorally by turn-origins.test.ts (confirming gate 3, P2: the
    // old source-string coverage here asserted behavior the code could not
    // reach). What THIS test pins is the index.ts WIRING into that seam —
    // every entry point that can start, end, or re-target a turn goes through
    // the tracker, and nothing bypasses it.
    const src = indexSrc();
    // EVERY user message rides an origin mid — a panel mid records its origin,
    // and a mid-less (non-panel/legacy) message gets a SYNTHETIC one, so both
    // pin/stamp through the same dequeue path (gate 3: the old
    // apply-at-receipt-while-idle shortcut left a mid-less message queued
    // behind a busy turn with no origin at all). The synthetic mid is marked
    // `userMessage: true` (#1001): the REQUEST is still the user's, so a mixed
    // batch containing it fails closed rather than inheriting.
    expect(src).toContain("userMid ?? turnOrigins.mintInjectionOrigin(event.tab_id, { userMessage: true });");
    expect(src).toContain(
      "turnOrigins.recordForMid(userMid, tabCommandWorkflowUuid.get(event.tab_id), event.tab_id);",
    );
    expect(src).toContain("mid: dispatchMid,");
    // The stamp lands when the turn DEQUEUES its batch (onSeen)…
    expect(src).toContain("turnOrigins.onSeen(key, mid);");
    // …the pin is released at turn end (idle-time scope resolution follows the
    // active tab again)…
    expect(src).toContain('if (state === "done") turnOrigins.turnEnded(key);');
    // …the injection paths mint a REAL origin (a run error on tab A pins A)…
    expect(src).toContain("mid: turnOrigins.mintInjectionOrigin(event.tab_id),");
    // …and the tab-less download completion rides an INHERITED origin so its
    // turn inherits the conversation's last established origin at dequeue
    // instead of opening no batch at all (gate 3, P1).
    expect(src).toContain("mid: turnOrigins.mintInheritedOrigin(),");
    // The bridge consults the REAL resolver/repin factories (the same seams
    // the tests drive), never an inline reimplementation.
    expect(src).toContain(
      "bridge.setScopeTargetResolver(makeScopeTargetResolver({ tracker: turnOrigins, scopeAgentKeyOf }));",
    );
    expect(src).toContain("makeScopeRepinHandler({");
    // Scope-addressed callers are stamped from the tracker…
    expect(src).toContain(
      "if (isScopeAddress(tabId)) return turnOrigins.stampOf(scopeAgentKeyOf(tabId));",
    );
    // …refreshed only by #716's validated explicit-open path…
    expect(src).toContain(
      "if (isScopeAddress(tabId)) turnOrigins.setStamp(scopeAgentKeyOf(tabId), identity.uuid);",
    );
    // …and cleared at every conversation boundary (new chat / resume / rewind).
    expect((src.match(/turnOrigins\.forgetConversation\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(src).toContain("turnOrigins.dropBranch(agentKeyFor(tabId));");
    // A provider switch INVALIDATES any cross-backend in-flight pin ROUTING to
    // the switching tab — at BOTH switch sites (hello re-hello + set_backend),
    // so a Claude turn can't keep routing onto a tab Codex now owns (gate-3
    // confirm, P0-1: the pin was validated only when set). Pins are judged by
    // the BRIDGE's resolution (liveTabIdFor), so a pin naming any retired
    // predecessor id of the surface — path-compressed migration aliases
    // included (codex gate 4: A→B then B→C rewrites A→C, and no single hello
    // ever names A) — is caught too.
    expect((src.match(/turnOrigins\.tabChangedBackend\(panelTab\);/g) ?? []).length).toBe(2);
    expect(src).toContain("liveTabOf: (tab) => bridge.liveTabIdFor(tab),");
    // A cancelled queued message's origin dies with it.
    expect(src).toContain("turnOrigins.cancelMid(mid);");
    // The panel MCP servers bind the backend-QUALIFIED scope address so the
    // per-conversation stamp is recoverable from the caller id. Keep these
    // assertions structural: the production calls are intentionally multiline,
    // and the callback is the join that promotes a fast completion arm when
    // panel_run opens its journal ticket (#2021).
    expect(src).toMatch(
      /createPanelMcpServer\(\s*bridge,\s*key,\s*workflowTargets,\s*\(promptIds\)\s*=>\s*runCompletionWatchdog\?\.markTicketed\(promptIds\),\s*\)/s,
    );
    expect(src).toMatch(
      /startPanelMcpHttpServer\(\s*bridge,\s*panelMcpPort,\s*"127\.0\.0\.1",\s*workflowTargets,\s*\(promptIds\)\s*=>\s*runCompletionWatchdog\?\.markTicketed\(promptIds\),\s*\)/s,
    );
    expect(src.match(/runCompletionWatchdog\?\.markTicketed\(promptIds\)/g) ?? []).toHaveLength(2);

    const panelHttpSrc = readFileSync(
      new URL("../../orchestrator/panel-mcp-http.ts", import.meta.url),
      "utf8",
    );
    // The trailing lane options (#2311's `inheritsUserMcpServers: false`) are
    // matched loosely on purpose: what this pin exists to hold is the first four
    // arguments — the tab-bound ctx built from the backend-QUALIFIED address with
    // the run-ticket callback. A lane fact appended after them is a different
    // question, and it has its own pin in inherited-mcp-not-in-session.test.ts.
    expect(panelHttpSrc).toMatch(
      /registerPanelTools\(\s*server,\s*makePanelToolCtx\(\s*bridge,\s*tabId,\s*workflowTargets,\s*onRunTicketOpened\s*(?:,[\s\S]*?)?\)\s*,?\s*\)/s,
    );

    const panelToolsSrc = readFileSync(
      new URL("../../orchestrator/panel-tools.ts", import.meta.url),
      "utf8",
    );
    expect(panelToolsSrc).toMatch(
      /const ctx = makePanelToolCtx\(bridge, tabId, workflowTargets, onRunTicketOpened(?:,[\s\S]*?)?\);/s,
    );
    expect(panelToolsSrc).toMatch(
      /if \(ticketedPromptIds\.length\) ctx\.onRunTicketOpened\?\.\(ticketedPromptIds\);/s,
    );
    expect(src).toContain("makeHttpBackendMcpServers(key)");
  });

  it("SOURCE: download rows are stamped with the OWNING agent key, and resolved as such (codex r1/r2 P1)", () => {
    const src = indexSrc();
    // Both spawn lanes stamp the owning conversation (r2: the HTTP lane never did).
    expect(src).toContain("COMFYUI_MCP_TAB: agentKey");
    expect(src).toContain("COMFYUI_MCP_TAB: tabId");
    // A known owner is delivered-to or dropped — never re-routed to whichever
    // sole agent happens to be live (r2: cross-conversation misattribution).
    expect(src).toContain("if (tab.startsWith(SHARED_SESSION_SCOPE + AGENT_KEY_SEP)) {");
    expect(src).toContain("not waking another conversation (#884)");
  });

  it("SOURCE: journal tickets are keyed by the REAL routed tab, never the scope address (codex r3 P1)", () => {
    const tools = readFileSync(
      new URL("../../orchestrator/panel-tools.ts", import.meta.url),
      "utf8",
    );
    // A scope-keyed ticket can never correlate: the panel reports completions
    // and answers under the REAL tab id, so the agent's own render would come
    // back "foreign" and boundary sweeps could never close the ticket.
    expect(tools).toContain("function journalTabFor(ctx: PanelToolCtx): string {");
    // panel_run's #468 ticket — the tab is captured at DISPATCH time…
    expect(tools).toContain("const runTicketTab = journalTabFor(ctx);");
    expect(tools).toContain("tabId: runTicketTab,");
    // …and panel_ask's #486 ticket (opened before dispatch already).
    expect(tools).toContain("const tabId = journalTabFor(ctx);");
  });

  it("SOURCE: a run ticket also records the CONVERSATION that queued it (#704)", () => {
    // The routed tab is the run's ADDRESS and it churns — a reconnecting panel
    // re-registers under a new id, and only a same-socket re-hello leaves a
    // migration alias to follow — so a by-tab-only ticket made the agent's own
    // render come back "does NOT match any run you queued … its origin is
    // UNDETERMINED". The conversation is orchestrator-scoped and does not churn,
    // so both ends of the journal must speak it: the queue side stamps it, the
    // arrival side asks with it, and the conversation boundary closes by it.
    const tools = readFileSync(
      new URL("../../orchestrator/panel-tools.ts", import.meta.url),
      "utf8",
    );
    expect(tools).toContain("const runTicketConversation = journalConversationFor(ctx);");
    expect(tools).toContain("conversation: runTicketConversation");
    const src = indexSrc();
    expect(src).toContain("conversation: agentKeyFor(event.tab_id),");
    // Both conversation boundaries (New chat, resume switch) close by conversation
    // as well as by member tab — a ticket whose tab id churned is in no tab sweep.
    expect([...src.matchAll(/RunCompletions\.closeRuns\(t, key\)/g)]).toHaveLength(2);
    expect(src).not.toMatch(/RunCompletions\.closeRuns\(t\)/);
  });

  it("SOURCE: hello.resume is a last-resort hint — the orchestrator's disk store wins", () => {
    const src = indexSrc();
    const at = src.indexOf("manager.setResume(key, resumeHint)");
    expect(at, "resume-hint arming not found").toBeGreaterThan(-1);
    const guard = src.slice(Math.max(0, at - 400), at);
    expect(guard).toContain("sessionStore.get(key) === undefined");
    expect(guard).toContain("!manager.hasAnyState(key)");
  });

  it("ONE key ⇒ ONE agent ⇒ ONE history: messages from different workflows share the conversation", async () => {
    const backend = new RecordingBackend();
    const store = new SessionStore(PORT, { dir: DIR });
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      onSession: () => {},
      sessionStore: store,
      makeBackend: () => backend,
    } as never);

    // Two different workflows (previously two DIFFERENT keys → two agents with
    // zero shared memory) both resolve to the one shared key now.
    const key = sharedAgentKey("claude");
    manager.send(key, "from workflow A"); // e.g. tab wf:a.json
    await waitFor(() => backend.turnTexts.length === 1);
    manager.send(key, "from workflow B (after Workflow → New)"); // e.g. tab tmp:<new-uuid>
    await waitFor(() => backend.turnTexts.length === 2);

    // Same backend instance saw BOTH turns in order — one conversation.
    expect(backend.turnTexts).toEqual(["from workflow A", "from workflow B (after Workflow → New)"]);
    // Only one spawn ever happened (no fresh agent on the workflow change)…
    expect(backend.resumes).toHaveLength(1);
    // …and the session was NEVER torn down across the workflow change (#902):
    // one run(), zero close() — the SDK session and every MCP child connection
    // riding it (comfyui + the user's inherited servers) survive a workflow
    // switch intact, instead of the retire→respawn cycle that dropped and
    // reconnected all of them ("89 deferred tools are no longer available").
    expect(backend.closes).toBe(0);
    expect(manager.hasLiveAgent(key)).toBe(true);
    // …and the session persisted under the SHARED key on disk (the orchestrator
    // owns it; the browser holds at most a hint).
    expect(store.get(key)).toBe("sess-shared");
    expect(new SessionStore(PORT, { dir: DIR }).get(key)).toBe("sess-shared");

    await manager.stopAll();
  });

  it("TWO backends ⇒ TWO agents with SEPARATE histories — cross-backend never merges, neither churns", async () => {
    const backends = new Map<string, RecordingBackend>();
    const store = new SessionStore(PORT, { dir: DIR });
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      onSession: () => {},
      sessionStore: store,
      makeBackend: (key: string) => {
        const b = backends.get(key) ?? new RecordingBackend();
        backends.set(key, b);
        return b;
      },
    } as never);

    manager.send(sharedAgentKey("claude"), "claude turn");
    manager.send(sharedAgentKey("codex"), "codex turn");
    await waitFor(
      () =>
        (backends.get(sharedAgentKey("claude"))?.turnTexts.length ?? 0) === 1 &&
        (backends.get(sharedAgentKey("codex"))?.turnTexts.length ?? 0) === 1,
    );
    expect(backends.get(sharedAgentKey("claude"))!.turnTexts).toEqual(["claude turn"]);
    expect(backends.get(sharedAgentKey("codex"))!.turnTexts).toEqual(["codex turn"]);
    // Each conversation stood up exactly once; neither's session/MCP children
    // were churned by the other's activity.
    expect(backends.get(sharedAgentKey("claude"))!.closes).toBe(0);
    expect(backends.get(sharedAgentKey("codex"))!.closes).toBe(0);

    await manager.stopAll();
  });

  it("a download_done injection rides an inherited-origin mid through the REAL queue and pins the last established origin (gate 3, P1)", async () => {
    // Confirming gate 3, P2: the old coverage asserted source strings while a
    // mid-LESS download injection never fired onSeen at all — no batch, no pin,
    // and the turn routed to whatever tab was active. This drives the real
    // PanelAgentManager dequeue: the injected item's minted mid MUST reach
    // onSeen (the seam panel-agent.ts only fires for items carrying a mid), and
    // the tracker must then inherit the conversation's last established origin.
    //
    // The backend HOLDS each turn open until released: the pin exists only
    // while its turn is in flight (turn end releases it), so the assertion has
    // to observe it MID-turn — exactly when the turn's tool calls would route.
    class HoldingBackend extends RecordingBackend {
      release: (() => void) | null = null;
      async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
        for await (const turn of opts.channel) {
          yield { type: "session", sessionId: this.sessionId };
          this.turnTexts.push(turn.text);
          await new Promise<void>((r) => {
            this.release = r;
          });
          yield { type: "result", ok: true, subtype: "success" } as AgentEvent;
        }
      }
    }
    const backend = new HoldingBackend();
    const store = new SessionStore(PORT, { dir: DIR });
    const tracker = new TurnOriginTracker({
      backendForTab: () => "claude",
      backendOfKey: (k) => k.slice(k.lastIndexOf("::") + 2),
      uuidOfTab: () => "issue-uuid-a",
      warn: () => {},
    });
    const key = sharedAgentKey("claude");
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      // Mirror the index.ts wiring exactly: dequeue applies origins, turn end
      // releases the pin.
      onSeen: (k: string, mid: string) => tracker.onSeen(k, mid),
      onTurn: (k: string, state: string) => {
        if (state === "done") tracker.turnEnded(k);
      },
      onSession: () => {},
      sessionStore: store,
      makeBackend: () => backend,
    } as never);

    // A user turn from tab wf:a.json establishes the conversation's origin —
    // observable mid-turn as the routing pin, and durably as the stamp.
    tracker.recordForMid("m-user", "issue-uuid-a", "wf:a.json");
    manager.send(key, "render this", { mid: "m-user" });
    await waitFor(() => backend.turnTexts.length === 1);
    await waitFor(() => tracker.pinOf(key) === "wf:a.json");
    expect(tracker.stampOf(key)).toBe("issue-uuid-a");
    backend.release!();
    // The turn ends → the pin is released (idle scope routing follows the
    // active tab between turns).
    await waitFor(() => tracker.pinOf(key) === undefined);

    // A coalesced download completion is injected — with NO originating tab of
    // its own, only the minted inherited-origin mid.
    expect(manager.hasLiveAgent(key)).toBe(true);
    const delivered = manager.injectEvent(
      key,
      { kind: "download_done", downloads: [{ name: "model.safetensors", status: "done" }] },
      { mid: tracker.mintInheritedOrigin() },
    );
    expect(delivered).toBe(true);
    await waitFor(() => backend.turnTexts.length === 2);
    // Its IN-FLIGHT turn INHERITED the last established origin — never the
    // active tab. (Without the mid, onSeen never fires, no batch opens, and
    // this pin simply never exists — the pre-fix behavior.)
    await waitFor(() => tracker.pinOf(key) === "wf:a.json");
    expect(tracker.stampOf(key)).toBe("issue-uuid-a");
    backend.release!();

    await manager.stopAll();
  });

  it("send-now across tabs drives the REAL requeue path and fails the MERGED batch closed (gate-3 confirm P0-2)", async () => {
    // The laundering sequence, through the real PanelAgentManager: message A
    // (tab A) is mid-turn; interrupt-with-requeue restores A's ORIGINAL queue
    // item; a new message from tab B lands behind it; the next turn drains
    // BOTH into one merged batch. Before this fix, A's already-applied mid
    // contributed no origin, so the merged A+B turn was pinned and stamped
    // entirely to B — and A's requested edit ran against B's graph.
    class HoldingBackend extends RecordingBackend {
      release: (() => void) | null = null;
      async *run(opts: BackendStartOptions): AsyncGenerator<AgentEvent> {
        for await (const turn of opts.channel) {
          yield { type: "session", sessionId: this.sessionId };
          this.turnTexts.push(turn.text);
          await new Promise<void>((r) => {
            this.release = r;
          });
          yield { type: "result", ok: true, subtype: "success" } as AgentEvent;
        }
      }
    }
    const backend = new HoldingBackend();
    const store = new SessionStore(PORT, { dir: DIR });
    const uuids = new Map<string, string>([
      ["wf:a.json", "uuid-a"],
      ["wf:b.json", "uuid-b"],
    ]);
    const tracker = new TurnOriginTracker({
      backendForTab: () => "claude",
      backendOfKey: (k) => k.slice(k.lastIndexOf("::") + 2),
      uuidOfTab: (t) => uuids.get(t),
      warn: () => {},
    });
    const key = sharedAgentKey("claude");
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onSeen: (k: string, mid: string) => tracker.onSeen(k, mid),
      onTurn: (k: string, state: string) => {
        if (state === "done") tracker.turnEnded(k);
      },
      onSession: () => {},
      sessionStore: store,
      makeBackend: () => backend,
    } as never);

    // Turn 1: message A from tab wf:a.json, held mid-turn, pinned to A.
    tracker.recordForMid("m-a", "uuid-a", "wf:a.json");
    manager.send(key, "edit the sampler on MY workflow", { mid: "m-a" });
    await waitFor(() => backend.turnTexts.length === 1);
    await waitFor(() => tracker.pinOf(key) === "wf:a.json");

    // Interrupt with requeue (the "send now" flow): A's original item goes
    // back on the queue…
    void manager.interrupt(key, { requeueInFlight: true });
    // …the new message from tab B lands behind it BEFORE the aborted turn
    // settles…
    tracker.recordForMid("m-b", "uuid-b", "wf:b.json");
    manager.send(key, "also do this over here", { mid: "m-b" });
    // …then the aborted turn's result releases the gate and the next turn
    // drains BOTH as one batch.
    backend.release!();
    await waitFor(() => backend.turnTexts.length === 2);
    // The merged prompt really carries both messages (the laundering shape)…
    expect(backend.turnTexts[1]).toContain("edit the sampler on MY workflow");
    expect(backend.turnTexts[1]).toContain("also do this over here");
    // …and the batch is recognized as MIXED: routing and mutations fail
    // closed instead of pinning/stamping everything to B.
    await waitFor(() => tracker.pinOf(key) === null);
    expect(tracker.stampOf(key)).toBeUndefined();
    backend.release!();

    await manager.stopAll();
  });

  it("UPGRADE: the newest pre-#884 per-workflow session is adopted — the REAL spawn resumes it", async () => {
    // A store written by the per-workflow era: two workflows conversed on claude.
    const seed = new SessionStore(PORT, { dir: DIR });
    seed.set("wf:old.json::claude", "sess-old-workflow");
    await new Promise((r) => setTimeout(r, 5));
    seed.set("wf:current.json::claude", "sess-current-workflow");

    const backend = new RecordingBackend();
    const store = new SessionStore(PORT, { dir: DIR }); // a fresh (upgraded) orchestrator
    const manager = new PanelAgentManager({
      mcpServers: {},
      systemAppend: "",
      model: "claude-test",
      onSay: () => {},
      onTurn: () => {},
      onSession: () => {},
      sessionStore: store,
      makeBackend: () => backend,
    } as never);

    // The first message after the upgrade spawns the shared agent — through the
    // manager's REAL resume path — and it resumes the newest legacy conversation.
    manager.send(sharedAgentKey("claude"), "hello again");
    await waitFor(() => backend.turnTexts.length === 1);
    expect(backend.resumes).toEqual(["sess-current-workflow"]);

    await manager.stopAll();
  });
});
