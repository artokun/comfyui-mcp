// panel#1529 — "Workflow pin reports success but graph tools stay on previous tab".
//
// WHAT WAS REPORTED. `panel_set_workflow_target({mode:"pinned"})` answered
// «Pinned to X. Graph tools will target that workflow» and, in the same reply,
// «this session's turn routing was NOT re-pinned … the existing pin (tmp:2fb3)
// still reaches a live tab». The very next `panel_graph_outline` came back with
// the OTHER workflow's nodes. Two selectors — the workflow-target store and the
// turn-routing pin — disagreed, and the reply read as a success either way.
//
// WHAT THIS FILE PROVES, and why it is an e2e over a REAL bridge rather than a
// unit test on the helper. The claim lives in the TOOL's reply, the verdict is
// computed in `resolvePinTarget`, and the two are joined by one assignment at the
// call site. A helper-level test survives that assignment being deleted — it was
// deleted here, deliberately, and only the reply-level assertions below went red.
// So every assertion reads the string/field an agent actually receives, produced
// by the real tool def, the real workflow-target store, the real UiBridge and the
// real turn-origin pin, against scripted panel sockets.
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

/** The exact sentence that asserts the graph target moved. */
const GRAPH_TARGET_CLAIM = "Graph tools will target that workflow";

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

/** Same shape as ui-bridge.test.ts's harness: retry past the close/rebind race so
 *  a bind flake is never reported as a feature failure. */
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

/** The workflow the turn was issued from — an UNSAVED tab, as in the report. */
const A: Wf = {
  path: "workflows/wan_video_edit.json",
  filename: "wan_video_edit",
  key: "wan_video_edit.json",
  routing_key: "wf:workflows/wan_video_edit.json",
  uuid: "aaaaaaaa-1111-4111-8111-111111111111",
  outline: '1 Wan2VideoEditApi "edit"',
};
/** The workflow the agent asks to pin. */
const B: Wf = {
  path: "workflows/api_seedance2_5_video_extend.json",
  filename: "api_seedance2_5_video_extend",
  key: "api_seedance2_5_video_extend.json",
  routing_key: "wf:workflows/api_seedance2_5_video_extend.json",
  uuid: "bbbbbbbb-2222-4222-8222-222222222222",
  outline: '1 SeedanceVideoExtendApi "extend"',
};

/** How this panel answers `workflow_list`. */
type ListShape =
  | "full" // current panel: enumerable tabs + a top-level active record
  | "active-only" // no `workflows` array, but the active canvas IS reported
  | "opaque" // neither — nothing about the live canvas can be established
  | "errors"; // the probe itself fails: no evidence of any kind comes back

let bridge: UiBridge;
let port: number;
const sockets: WebSocket[] = [];

/** A scripted panel page. Records every command frame it receives so the test can
 *  assert on what was ROUTED, not only on what the tool said. */
class FakePanel {
  sock!: WebSocket;
  readonly seen: Array<{ cmd: string; workflow_path?: string }> = [];

  constructor(
    public tabId: string,
    public open: Wf[],
    public activeIdx: number,
    public listShape: ListShape = "full",
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
    this.seen.push({
      cmd,
      workflow_path: typeof msg.workflow_path === "string" ? msg.workflow_path : undefined,
    });
    const reply = (result: unknown): void =>
      this.sock.send(JSON.stringify({ rid, ok: true, result, workflow_uuid: this.active.uuid }));
    const refuse = (error: string): void =>
      this.sock.send(JSON.stringify({ rid, ok: false, error }));

    // The panel's shipped PINNED-TARGET GUARD (#349/#186): a `workflow_path` that
    // is not the active canvas is refused rather than executed. Modelled here so
    // the cost of a wrong pin shows up in the test the way it shows up for a user.
    const pinned = msg.workflow_path;
    const targetless = cmd === "workflow_list" || cmd === "workflow_open" || cmd === "workflow_new";
    if (typeof pinned === "string" && pinned.trim() && !targetless) {
      const forms = [this.active.path, this.active.key, this.active.filename, this.active.routing_key];
      if (!forms.includes(pinned)) {
        refuse(
          `workflow mismatch: your session is pinned to "${pinned}", but that is not the active ` +
            `canvas ("${this.active.path}").`,
        );
        return;
      }
    }

    switch (cmd) {
      case "workflow_list": {
        if (this.listShape === "errors") {
          refuse("workflow_list failed on this tab");
          return;
        }
        if (this.listShape === "opaque") {
          reply({});
          return;
        }
        const activeObj = {
          path: this.active.path,
          filename: this.active.filename,
          title: this.active.filename,
          key: this.active.key,
          routing_key: this.active.routing_key,
          workflow_uuid: this.active.uuid,
        };
        if (this.listShape === "active-only") {
          reply({ active: activeObj });
          return;
        }
        reply({
          active: activeObj,
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
        setTimeout(() => this.hello(`wf:r1:${this.active.path}`), 5);
        return;
      }
      case "graph_outline":
        reply({ outline: this.active.outline, node_count: 1, detail_level: "full" });
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

const pin = (ctx: PanelToolCtx, w: Wf): Promise<ToolResult> =>
  tool("panel_set_workflow_target").handler(
    { mode: "pinned", path: w.path, filename: w.filename },
    ctx,
  );

describe("panel#1529 — a pin may not claim a graph target it did not establish", () => {
  it("REFUSES a pin the panel reports is not the live canvas, even with no enumerable tab list", async () => {
    // The reporter's shape: the turn is routed to the tab showing A, and the panel
    // answers workflow_list WITHOUT an enumerable `workflows` array — which used to
    // discard its perfectly readable top-level `active` record and make the pin
    // "indeterminate", i.e. accepted unverified.
    const page = new FakePanel("tmp:2fb3aaaa-1111-4111-8111-111111111111", [A], 0, "active-only");
    await page.connect();
    tabStamp.set(page.tabId, A.uuid);
    tracker.repinTo(SCOPE, page.tabId);
    const ctx = ctxFor(SCOPE);

    const res = await pin(ctx, B);

    expect(res.isError, `pin should have been refused, got: ${textOf(res)}`).toBe(true);
    // It says what it OBSERVED — the live canvas — and never that the target "is
    // open", which this evidence cannot support.
    expect(textOf(res)).toContain(A.filename);
    expect(textOf(res)).not.toContain(GRAPH_TARGET_CLAIM);
    // And nothing was written: a refused pin must not leave the store aimed at a
    // workflow the next graph command cannot reach.
    expect(workflowTargets.get(SCOPE)).toEqual({ mode: "current" });

    // The consequence the reporter actually felt: with the bad pin written, the
    // next graph read carried it and was refused by the panel's own guard. Now the
    // read carries no pin at all and returns the canvas that is genuinely live.
    await settle();
    const outline = await tool("panel_graph_outline").handler({}, ctx);
    expect(outline.isError).toBeFalsy();
    expect(textOf(outline)).toContain("Wan2VideoEditApi");
    expect(page.seen.filter((f) => f.cmd === "graph_outline")[0]?.workflow_path).toBeUndefined();
  });

  it("does NOT claim the graph target for a pin it could not verify", async () => {
    // A panel that establishes nothing about its live canvas. The pin is still
    // WRITTEN — older/partial panels must keep working, and that leniency is
    // deliberate — but the reply may not turn it into a routing promise.
    const page = new FakePanel("tmp:2fb3aaaa-1111-4111-8111-111111111111", [A], 0, "opaque");
    await page.connect();
    tabStamp.set(page.tabId, A.uuid);
    tracker.repinTo(SCOPE, page.tabId);
    const ctx = ctxFor(SCOPE);

    const res = await pin(ctx, B);

    expect(res.isError).toBeFalsy();
    const body = jsonOf(res);
    expect(body.mode).toBe("pinned");
    // The machine-readable verdict, so a caller never has to parse the prose.
    expect(body.pin_verified_active).toBe(false);
    const note = String(body.note ?? "");
    expect(note).not.toContain(GRAPH_TARGET_CLAIM);
    expect(note).toContain("NOT CONFIRMED");
    // …and it hands back the cheap read that settles it, rather than leaving the
    // caller to believe the routing question was answered.
    expect(note).toContain("panel_graph_outline");
  });

  it("makes no claim when the verifying probe itself FAILED", async () => {
    // The route that reaches a CURRENT panel. `workflows` has been emitted since
    // panel 0.11.20, so a modern build is never the "no enumerable list" shape — but
    // `resolveOpenWorkflow` also returns indeterminate whenever the `workflow_list`
    // probe does not come back at all (a transient reconnect, a busy canvas past the
    // 6 s budget). There is no evidence to refuse on there, and inventing one would
    // fail healthy pins — so the pin is written and the REPORT is what changes.
    const page = new FakePanel("tmp:2fb3aaaa-1111-4111-8111-111111111111", [A], 0, "errors");
    await page.connect();
    tabStamp.set(page.tabId, A.uuid);
    tracker.repinTo(SCOPE, page.tabId);
    const ctx = ctxFor(SCOPE);

    const res = await pin(ctx, B);

    expect(res.isError).toBeFalsy();
    const body = jsonOf(res);
    expect(body.pin_verified_active).toBe(false);
    expect(String(body.note ?? "")).not.toContain(GRAPH_TARGET_CLAIM);
    expect(String(body.note ?? "")).toContain("NOT CONFIRMED");
  });

  it("a BARE KEY token is not refused on this evidence — the boundary, on purpose", async () => {
    // Where the refusal above STOPS, measured rather than assumed. The oracle needs a
    // canonical saved identity on our side, and a bare basename/key is deliberately not
    // one: it is an alias selector that can name two files in different directories.
    // Widening it is not free — a `tmp:` routing token would then read as "different"
    // from any named active tab and start refusing valid pins to unsaved workflows.
    //
    // So on a key-shaped token the pin is still accepted leniently — and the SECOND
    // half of the fix is what protects the caller there: no routing claim is made.
    const page = new FakePanel("tmp:2fb3aaaa-1111-4111-8111-111111111111", [A], 0, "active-only");
    await page.connect();
    tabStamp.set(page.tabId, A.uuid);
    tracker.repinTo(SCOPE, page.tabId);
    const ctx = ctxFor(SCOPE);

    const res = await tool("panel_set_workflow_target").handler(
      { mode: "pinned", path: B.key, filename: B.filename },
      ctx,
    );

    expect(res.isError).toBeFalsy();
    const body = jsonOf(res);
    expect(body.pin_verified_active).toBe(false);
    expect(String(body.note ?? "")).not.toContain(GRAPH_TARGET_CLAIM);
  });

  it("still makes the claim — and delivers it — when the pin IS verified active", async () => {
    // The healthy path this must not over-refuse: the agent opens B, the panel
    // re-helloes under B's route on the same socket, the turn pin follows through
    // the migration alias, and graph commands really do reach B. The turn routing
    // is deliberately NOT re-pinned here (a live pin is never displaced), so this
    // is the same two-selector state as the report — with the selectors agreeing.
    const page = new FakePanel("tmp:2fb3aaaa-1111-4111-8111-111111111111", [A, B], 0, "full");
    await page.connect();
    tabStamp.set(page.tabId, A.uuid);
    tracker.repinTo(SCOPE, page.tabId);
    const ctx = ctxFor(SCOPE);

    const opened = await tool("panel_open_workflow").handler({ path: B.path }, ctx);
    expect(opened.isError).toBeFalsy();
    await settle();

    const res = await pin(ctx, B);
    expect(res.isError, textOf(res)).toBeFalsy();
    const body = jsonOf(res);
    expect(body.pin_verified_active).toBe(true);
    expect(String(body.note ?? "")).toContain(GRAPH_TARGET_CLAIM);

    await settle();
    const outline = await tool("panel_graph_outline").handler({}, ctx);
    expect(outline.isError, textOf(outline)).toBeFalsy();
    expect(textOf(outline)).toContain("SeedanceVideoExtendApi");
  });
});
