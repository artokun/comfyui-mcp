// mcp#1917 — "A live turn-routing pin is never displaced by a workflow target, so
// graph reads and graph MUTATIONS split across two tabs".
//
// WHAT WAS REPORTED (panel#1529 comment 2, split out as #1917): after
// `panel_open_workflow` bound a saved PHOTO copy, `panel_set_workflow_target({mode:
// "current"})` answered as a success, `panel_graph_outline` read that copy, and
// `panel_remove_node({node_id:99})` came back refused against the older Basic_V37
// workflow — "the prior reply explicitly retained the healthy older turn-routing pin".
//
// WHAT WAS MEASURED, and what it changes. Driven over a real UiBridge on a real
// socket with the real turn-origin pin and scope resolver, reads and mutations are
// NOT two selectors: `graph_outline` and `graph_remove_node` are both dispatched by
// `UiBridge.resolveTarget(<scope>)` through the same pin, both carry the same
// `workflow_uuid` from the same `commandStampAddress` resolution, and the panel
// fences them identically (`activeWorkflowFenceApplies` covers every `graph_*`, and
// a missing stamp counts as a mismatch, #718). No state was found in which the two
// route to different tabs — the last test here pins that, by asserting BOTH land on
// the same tab in the very state the report describes.
//
// What IS true, and is the whole of this fix: `mode:"current"` claimed
// «Following the user's current workflow tab.» while a live turn pin was holding
// every graph command on a DIFFERENT tab, and said nothing about it. For a
// scope-bound ctx whose pin still reaches a live tab, `rebindToActiveTab`
// short-circuits (#884 — a live pin is never displaced) and returns
// `{rebound:false}` with no `repinRefusal`, so not one word of the reply mentioned
// the pin. Measured on clean main: pin on the tab showing Basic_V37, active-scope
// resolution naming the tab showing PHOTO, reply «Following the user's current
// workflow tab.» with `graph_binding:"bound"`, and both the following
// `panel_graph_outline` and `panel_remove_node` dispatched to Basic_V37.
//
// The pin is NOT moved to make that sentence true. #884 is a P0 invariant and
// `makeScopeRepinHandler` is untouched by this change; the third test asserts the
// pin is exactly where it was after the call. What changes is the CLAIM.
//
// This is an e2e over a real bridge for the same reason the panel#1529 file is: the
// claim lives in the TOOL's reply and the verdict is joined to it by assignments at
// the call site, which a helper-level test survives. Every assertion below reads the
// string or field an agent actually receives.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import WebSocket from "ws";
import { UiBridge } from "../../services/ui-bridge.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import {
  TurnOriginTracker,
  makeScopeRepinHandler,
  makeScopeTargetResolver,
} from "../../orchestrator/turn-origins.js";
import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import { SHARED_SESSION_SCOPE, isScopeAddress } from "../../services/session-scope.js";

const textOf = (res: ToolResult): string =>
  res.content.map((c) => ("text" in c ? (c as { text: string }).text : "")).join("\n");

const jsonOf = (res: ToolResult): Record<string, unknown> => {
  try {
    return JSON.parse(textOf(res)) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** The unconditional sentence this fix stops printing when it is not true. */
const CURRENT_CLAIM = "Following the user's current workflow tab.";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = addr && typeof addr === "object" ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
}

/** Same shape as the other bridge e2e harnesses: retry past the close/rebind race
 *  so a bind flake is never reported as a feature failure. */
async function startBridgeOnFreePort(): Promise<{ bridge: UiBridge; port: number }> {
  let lastErr = "no attempt made";
  for (let attempt = 0; attempt < 6; attempt++) {
    const p = await freePort();
    const b = new UiBridge(p);
    b.start();
    if (await b.whenReady()) return { bridge: b, port: p };
    lastErr = `bind to ${p} lost a close/rebind race`;
    await b.stop();
  }
  throw new Error(`could not bind a free bridge port after 6 attempts: ${lastErr}`);
}

const SCOPE = `${SHARED_SESSION_SCOPE}::claude`;

interface Wf {
  path: string;
  filename: string;
  key: string;
  routing_key: string;
  uuid: string;
  outline: string;
}

/** The workflow the turn was issued from — the report's Basic_V37. */
const BASIC: Wf = {
  path: "workflows/Basic_V37.json",
  filename: "Basic_V37",
  key: "Basic_V37.json",
  routing_key: "wf:workflows/Basic_V37.json",
  uuid: "aaaaaaaa-1111-4111-8111-111111111111",
  outline: '1 BasicNode "basic"',
};
/** The workflow the agent believes it moved to — the report's saved PHOTO copy. */
const PHOTO: Wf = {
  path: "workflows/PHOTO.json",
  filename: "PHOTO",
  key: "PHOTO.json",
  routing_key: "wf:workflows/PHOTO.json",
  uuid: "bbbbbbbb-2222-4222-8222-222222222222",
  outline: '99 PhotoNode "photo"',
};

let bridge: UiBridge;
let port: number;
const sockets: WebSocket[] = [];

/** A scripted panel page. Records every command frame it receives so the tests can
 *  assert on what was ROUTED, not only on what the tool said. */
class FakePanel {
  sock!: WebSocket;
  readonly seen: Array<{ cmd: string; workflow_uuid?: string }> = [];

  constructor(
    public tabId: string,
    /** The per-browser-tab route id (#640) this page re-helloes under on a switch. */
    public route: string,
    public open: Wf[],
    public activeIdx: number,
  ) {}

  get active(): Wf {
    return this.open[this.activeIdx];
  }

  async connect(): Promise<void> {
    this.sock = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}`);
      sockets.push(s);
      s.on("open", () => resolve(s));
      s.on("error", reject);
    });
    this.hello(this.tabId);
    this.sock.on("message", (buf) => this.onMessage(buf.toString()));
    await settle();
  }

  hello(tabId: string): void {
    this.tabId = tabId;
    this.sock.send(
      JSON.stringify({
        type: "hello",
        tab_id: tabId,
        title: this.active.filename,
        backend: "claude",
        workflow_uuid: this.active.uuid,
        enforces_workflow_stamp: true,
        enforces_workflow_stamp_at_write: true,
      }),
    );
  }

  private record(w: Wf, i: number): Record<string, unknown> {
    return {
      path: w.path,
      filename: w.filename,
      title: w.filename,
      key: w.key,
      routing_key: w.routing_key,
      active: i === this.activeIdx,
      modified: false,
      persisted: true,
    };
  }

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    const cmd = msg.cmd as string | undefined;
    const rid = msg.rid as string | undefined;
    if (!cmd || !rid) return;
    const stamp = typeof msg.workflow_uuid === "string" ? msg.workflow_uuid : undefined;
    this.seen.push({ cmd, workflow_uuid: stamp });
    const reply = (result: unknown): void =>
      this.sock.send(JSON.stringify({ rid, ok: true, result, workflow_uuid: this.active.uuid }));
    const refuse = (error: string): void =>
      this.sock.send(JSON.stringify({ rid, ok: false, error }));

    // The panel's shipped WORKFLOW-INSTANCE FENCE (#570/#718), modelled the way the
    // panel actually applies it: `activeWorkflowFenceApplies` covers EVERY `graph_*`
    // command — reads included — and `commandWorkflowMismatch` counts a MISSING stamp
    // as a mismatch. Reads and mutations are deliberately treated alike here, because
    // that is what the panel does; a harness that fenced only writes would manufacture
    // the very read/mutation split these tests exist to measure.
    if (cmd.startsWith("graph_")) {
      if (!stamp) {
        refuse(
          `workflow instance mismatch: this command carries no workflow-instance stamp, and ` +
            `the active canvas reports ${this.active.uuid}. Nothing was applied.`,
        );
        return;
      }
      if (stamp !== this.active.uuid) {
        refuse(
          `workflow instance mismatch: this command was issued for workflow instance ${stamp}, ` +
            `and the active canvas reports ${this.active.uuid}. Nothing was applied.`,
        );
        return;
      }
    }

    switch (cmd) {
      case "workflow_list": {
        reply({
          active: {
            path: this.active.path,
            filename: this.active.filename,
            title: this.active.filename,
            key: this.active.key,
            routing_key: this.active.routing_key,
            workflow_uuid: this.active.uuid,
          },
          open: this.open.map((w, i) => this.record(w, i)),
          workflows: this.open.map((w, i) => this.record(w, i)),
          active_confirmed: true,
          backend_socket: "up",
          mutations_ready: true,
          canvas_binding: "bound",
          graph_binding: "bound",
        });
        return;
      }
      case "workflow_open": {
        const want = String(msg.path ?? "");
        const idx = this.open.findIndex(
          (w) => w.path === want || w.key === want || w.filename === want,
        );
        if (idx < 0) {
          refuse(`not open: ${want}`);
          return;
        }
        this.activeIdx = idx;
        reply({
          ok: true,
          path: this.active.path,
          filename: this.active.filename,
          key: this.active.key,
          routing_key: this.active.routing_key,
          active_routing_key: this.active.routing_key,
          active_matches_target: true,
          workflow_uuid: this.active.uuid,
          active: true,
        });
        // A real panel re-helloes under the NEW workflow's route id on the SAME
        // socket when the active workflow changes (per-workflow routes, #640).
        setTimeout(() => this.hello(`wf:${this.route}:${this.active.path}`), 5);
        return;
      }
      case "graph_outline":
        reply({ outline: this.active.outline, node_count: 1, detail_level: "full" });
        return;
      case "graph_remove_node":
        reply({ ok: true, removed: [msg.node_id], on: this.active.filename });
        return;
      default:
        reply({ ok: true });
    }
  }
}

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 12));
}

let tracker: TurnOriginTracker;
let workflowTargets: WorkflowTargetStore;
const tabStamp = new Map<string, string>();

beforeEach(async () => {
  ({ bridge, port } = await startBridgeOnFreePort());
  tabStamp.clear();
  workflowTargets = new WorkflowTargetStore();
  // EXACTLY what orchestrator/index.ts installs, so the scope address resolves
  // through the production turn-origin pin rather than a test stand-in.
  const scopeAgentKeyOf = (scopeId: string): string =>
    scopeId === SHARED_SESSION_SCOPE ? `${SHARED_SESSION_SCOPE}::claude` : scopeId;
  const backendForTab = (): string => "claude";
  const backendOfKey = (key: string): string => key.split("::")[1] ?? "claude";
  tracker = new TurnOriginTracker({
    backendForTab,
    backendOfKey,
    uuidOfTab: (t) => tabStamp.get(t),
    liveTabOf: (t) => {
      try {
        return bridge.canReach(t) ? t : undefined;
      } catch {
        return undefined;
      }
    },
    warn: () => {},
  });
  bridge.setScopeTargetResolver(makeScopeTargetResolver({ tracker, scopeAgentKeyOf }));
  bridge.setScopeRepinHandler(
    makeScopeRepinHandler({
      bridge,
      tracker,
      scopeAgentKeyOf,
      backendForTab,
      backendOfKey,
      info: () => {},
    }),
  );
  bridge.setHelloBackendNormalizer(() => "claude");
  bridge.setTabWorkflowUuidResolver(
    (tabId) =>
      isScopeAddress(tabId) ? tracker.stampOf(scopeAgentKeyOf(tabId)) : tabStamp.get(tabId),
    (tabId, workflowUuid) => {
      if (typeof workflowUuid !== "string" || !workflowUuid)
        return { ok: false, reason: "no uuid" };
      const real = isScopeAddress(tabId) ? bridge.resolveSharedTabId(tabId) : tabId;
      if (!real) return { ok: false, reason: "no panel tab" };
      tabStamp.set(real, workflowUuid);
      if (isScopeAddress(tabId)) tracker.setStamp(scopeAgentKeyOf(tabId), workflowUuid);
      return true;
    },
  );
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await bridge.stop();
});

const tool = (name: string) => buildPanelToolDefs().find((d) => d.name === name)!;

/** The real ctx, with only the default command deadline shortened. */
function ctxFor(tabId: string): PanelToolCtx {
  const real = makePanelToolCtx(bridge, tabId, workflowTargets);
  const c = Object.create(real) as PanelToolCtx;
  c.call = (cmd, t, onRid) => real.call(cmd, t ?? 800, onRid);
  return c;
}

const setCurrent = (ctx: PanelToolCtx): Promise<ToolResult> =>
  tool("panel_set_workflow_target").handler({ mode: "current" }, ctx);

/** The reported two-tab state: the turn was issued from the tab showing Basic_V37,
 *  and a second browser tab showing the saved PHOTO copy connected after it — so the
 *  active-scope (pin-bypassing) resolution names PHOTO's tab while the in-flight
 *  turn's pin still names Basic_V37's. */
async function twoTabsPinnedElsewhere(): Promise<{
  tabA: FakePanel;
  tabB: FakePanel;
  ctx: PanelToolCtx;
}> {
  const tabA = new FakePanel("wf:rA:workflows/Basic_V37.json", "rA", [BASIC], 0);
  await tabA.connect();
  tabStamp.set(tabA.tabId, BASIC.uuid);
  const tabB = new FakePanel("wf:rB:workflows/PHOTO.json", "rB", [PHOTO], 0);
  await tabB.connect();
  tabStamp.set(tabB.tabId, PHOTO.uuid);
  tracker.repinTo(SCOPE, tabA.tabId);
  await settle();
  // The precondition, asserted rather than assumed: the two selectors really do
  // name different tabs before the tool is called.
  expect(bridge.resolveSharedTabId(SCOPE)).toBe(tabA.tabId);
  expect(bridge.resolveActiveScopeTab()).toBe(tabB.tabId);
  return { tabA, tabB, ctx: ctxFor(SCOPE) };
}

describe("mcp#1917 — mode:'current' may not claim a routing target the turn pin holds elsewhere", () => {
  it("names BOTH tabs instead of claiming it follows the current one", async () => {
    const { tabA, tabB, ctx } = await twoTabsPinnedElsewhere();

    const res = await setCurrent(ctx);

    expect(res.isError, textOf(res)).toBeFalsy();
    const note = String(jsonOf(res).note ?? "");
    // The claim that was made unconditionally, and is false in this state.
    expect(note).not.toContain(CURRENT_CLAIM);
    // Both tabs are NAMED, so the caller can tell which canvas it is actually on.
    expect(note).toContain("Basic_V37");
    expect(note).toContain("PHOTO");
    // And it says the thing the report needed said: this covers MUTATIONS too.
    expect(note).toContain("READS AND MUTATIONS ALIKE");
  });

  it("carries the split MACHINE-READABLY, so no caller has to parse the prose", async () => {
    // The call-site half. A helper that computes the split but is never spread into
    // the reply passes every prose assertion above; this field only exists if the
    // wiring at the `ok(...)` return is present.
    const { tabA, tabB, ctx } = await twoTabsPinnedElsewhere();

    const body = jsonOf(await setCurrent(ctx));

    expect(body.turn_routing).toBe("pinned_elsewhere");
    expect(body.turn_routing_tab).toBe(tabA.tabId);
    expect(body.current_would_route_to).toBe(tabB.tabId);
    // `repinned` and `pinned_elsewhere` are mutually exclusive: this call moved nothing.
    expect(body.turn_routing).not.toBe("repinned");
  });

  it("does NOT displace the live pin to make its own sentence true (#884)", async () => {
    const { tabA, ctx } = await twoTabsPinnedElsewhere();
    const pinBefore = tracker.pinOf(SCOPE);

    await setCurrent(ctx);

    // The P0 invariant this issue must not trade away: a pin that still reaches a
    // live tab of this conversation is never displaced, however explicit the request.
    expect(tracker.pinOf(SCOPE)).toBe(pinBefore);
    expect(tracker.pinOf(SCOPE)).toBe(tabA.tabId);
  });

  it("the disclosure is TRUE: the next read AND the next mutation both land on the pinned tab", async () => {
    // The reported shape, executed. #1917 states that reads follow the workflow
    // target while mutations follow the turn pin; over a real bridge they do not
    // split — `graph_outline` and `graph_remove_node` are resolved by the same
    // `resolveTarget(<scope>)` through the same pin. Asserting BOTH frames arrive at
    // the PINNED tab is what makes the new "READS AND MUTATIONS ALIKE" sentence a
    // measured statement rather than a plausible one.
    const { tabA, tabB, ctx } = await twoTabsPinnedElsewhere();
    await setCurrent(ctx);
    await settle();

    const outline = await tool("panel_graph_outline").handler({}, ctx);
    expect(outline.isError, textOf(outline)).toBeFalsy();
    expect(textOf(outline)).toContain("BasicNode");

    const removed = await tool("panel_remove_node").handler({ node_id: 99 }, ctx);
    expect(removed.isError, textOf(removed)).toBeFalsy();

    // Assert the frames EXIST before asserting where they did not go — an empty
    // array would satisfy a bare "tabB saw nothing" vacuously.
    expect(tabA.seen.map((f) => f.cmd)).toEqual(
      expect.arrayContaining(["graph_outline", "graph_remove_node"]),
    );
    expect(tabB.seen.filter((f) => f.cmd.startsWith("graph_"))).toHaveLength(0);
  });

  it("says nothing when the two selectors AGREE — the boundary, on purpose", async () => {
    // One connected tab: the pin and the active-scope resolution are the same tab, so
    // there is no split to report and the ordinary reply must be unchanged. Over-
    // reporting here would put a scary two-tab warning on every healthy recovery.
    const page = new FakePanel("wf:r1:workflows/PHOTO.json", "r1", [PHOTO], 0);
    await page.connect();
    tabStamp.set(page.tabId, PHOTO.uuid);
    tracker.repinTo(SCOPE, page.tabId);
    const ctx = ctxFor(SCOPE);

    const body = jsonOf(await setCurrent(ctx));

    expect(String(body.note ?? "")).toContain(CURRENT_CLAIM);
    expect(body.turn_routing).toBeUndefined();
    expect(body.turn_routing_tab).toBeUndefined();
  });

  it("a RETIRED route id that still reaches the same socket is not a split", async () => {
    // The comparison is between CANONICAL connection ids, not raw id strings. A
    // per-workflow route id (#640) is retired on every workflow switch, so the pin
    // routinely names an id that is no longer any connection's canonical id while
    // still resolving — through the same-socket migration alias — onto the very tab
    // "current" would pick. Comparing the raw pin string against the active tab id
    // would call that a disagreement and print the warning on a perfectly healthy
    // single-tab session after any `panel_open_workflow`.
    const page = new FakePanel("wf:r1:workflows/Basic_V37.json", "r1", [BASIC, PHOTO], 0);
    await page.connect();
    tabStamp.set(page.tabId, BASIC.uuid);
    tracker.repinTo(SCOPE, page.tabId);
    const retiredPin = page.tabId;
    const ctx = ctxFor(SCOPE);

    const opened = await tool("panel_open_workflow").handler({ path: PHOTO.path }, ctx);
    expect(opened.isError, textOf(opened)).toBeFalsy();
    await settle();

    // The pin still names the RETIRED id, and that id is no longer the canonical one.
    expect(tracker.pinOf(SCOPE)).toBe(retiredPin);
    expect(bridge.resolveSharedTabId(SCOPE)).not.toBe(retiredPin);
    // …but it resolves onto the same live tab the active resolution picks.
    expect(bridge.resolveSharedTabId(SCOPE)).toBe(bridge.resolveActiveScopeTab());

    const body = jsonOf(await setCurrent(ctx));
    expect(String(body.note ?? "")).toContain(CURRENT_CLAIM);
    expect(body.turn_routing).toBeUndefined();
  });
});
