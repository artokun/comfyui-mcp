import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import {
  UiBridge,
  makeUnknownCommandError,
  panelVersionProvesUnsupported,
  isPanelCmdUnsupportedError,
  MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS,
  minPanelVersionForCmd,
  markDispatched,
  dispatchOutcomeOf,
  isCapabilityRefusal,
  defaultBridgeTimeoutMs,
  BRIDGE_DEFAULT_TIMEOUT_MS,
  HEADLESS_RECENCY_MS,
  BRIDGE_READ_DEFAULT_TIMEOUT_MS,
  BRIDGE_READONLY_CMDS,
  isMutatingGraphCommand,
  requiresWorkflowStampEnforcement,
  BRIDGE_CAPABILITY_MIN_PANEL_VERSION,
  unclassifiedGraphCommandsSeen,
  __resetUnclassifiedGraphCommands,
} from "../../services/ui-bridge.js";
import { SHARED_SESSION_SCOPE, normalizeHelloBackend } from "../../services/session-scope.js";
import {
  TurnOriginTracker,
  makeScopeRepinHandler,
  makeScopeTargetResolver,
} from "../../orchestrator/turn-origins.js";
import { buildPanelToolDefs, makePanelToolCtx } from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import {
  __resetPanelBaseCache,
  __setPanelBaseForTests,
  clearPanelDiskObservation,
  recordPanelDiskObservation,
} from "../../services/panel-workspace.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "../helpers/wait-for.js";
import { logger } from "../../utils/logger.js";

/**
 * A real on-disk panel pack under a resolved base. The skew resolver re-reads
 * the pyproject AND requires the pack to sit under the currently-resolved
 * ComfyUI root, so neither a fabricated path nor an unbound one proves anything.
 */
const tempRoots: string[] = [];
function writeTempPanelPack(version: string): string {
  const base = mkdtempSync(join(tmpdir(), "cmcp-bundle-"));
  const dir = join(base, "custom_nodes", "comfyui-agent-panel");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pyproject.toml"),
    `[project]\nname = "comfyui-agent-panel"\nversion = "${version}"\n`,
  );
  tempRoots.push(base);
  __setPanelBaseForTests(base);
  recordPanelDiskObservation(version, dir, base);
  return dir;
}
afterEach(() => {
  clearPanelDiskObservation();
  __resetPanelBaseCache();
  for (const d of tempRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

// #570 P0c — classifier that decides which commands must pass the enforcement+stamp gate.
describe("requiresWorkflowStampEnforcement (#570 P0c)", () => {
  it("gates every graph_* mutator, never a read", () => {
    expect(requiresWorkflowStampEnforcement({ cmd: "graph_add_node" })).toBe(true);
    expect(requiresWorkflowStampEnforcement({ cmd: "graph_set_widget" })).toBe(true);
    expect(requiresWorkflowStampEnforcement({ cmd: "graph_clear" })).toBe(true);
    expect(isMutatingGraphCommand("graph_get_state")).toBe(false);
    expect(requiresWorkflowStampEnforcement({ cmd: "graph_get_state" })).toBe(false);
    expect(requiresWorkflowStampEnforcement({ cmd: "graph_query" })).toBe(false);
  });

  it("gates ALL FOUR workflow mutators UNCONDITIONALLY (the server can't resolve a path selector)", () => {
    // save/save_as ignore path; rename/close resolve a path against OPEN workflows, which the
    // server can't evaluate — and an in-place replacement can make a once-non-active path resolve
    // to the active workflow. So raw path can never prove non-active-ness: gate all four always.
    for (const cmd of ["workflow_save", "workflow_save_as", "workflow_rename", "workflow_close"]) {
      expect(requiresWorkflowStampEnforcement({ cmd })).toBe(true); // absent
      expect(requiresWorkflowStampEnforcement({ cmd, path: "" } as never)).toBe(true); // empty
      expect(requiresWorkflowStampEnforcement({ cmd, path: "   " } as never)).toBe(true); // whitespace
      // Even a non-empty explicit path is gated on the server — the ENFORCING panel resolves the
      // target precisely and exempts a genuinely non-active one client-side.
      expect(requiresWorkflowStampEnforcement({ cmd, path: "workflows/other.json" } as never)).toBe(true);
    }
  });

  it("does NOT gate navigation/creation or unrelated commands", () => {
    expect(requiresWorkflowStampEnforcement({ cmd: "workflow_open", path: "x" })).toBe(false);
    expect(requiresWorkflowStampEnforcement({ cmd: "workflow_new" })).toBe(false);
    expect(requiresWorkflowStampEnforcement({ cmd: "show_media" })).toBe(false);
  });
});

let bridge: UiBridge;
let port: number;

/** Ask the OS for a currently-free ephemeral TCP port on loopback, then release it.
 *  Deterministic across parallel test files in a way `20000 + random(20000)` is NOT:
 *  the OS never hands the same ephemeral port to two concurrently-listening probes,
 *  so this avoids the birthday-paradox collisions that made the shared bridge bind
 *  flake on loaded Windows CI. (A lost fixed-range race left `whenReady()` resolving
 *  false in the `beforeEach`, whose `expect(...).toBe(true)` then failed — and vitest
 *  misattributed that beforeEach failure to whichever test ran next, e.g. the pure
 *  makeUnknownCommandError case, making a platform-independent logic test look
 *  OS-dependent. The bind, not the logic, was the flake.) */
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

/** Start a UiBridge on a guaranteed-free port and await its bound `listening` event.
 *  Retries on the (rare) close→rebind reuse race so a returned bridge is ALWAYS
 *  actually listening — the harness never surfaces a flaky bind as a spurious,
 *  misattributed test failure. Used by the high-frequency `beforeEach`. */
async function startBridgeOnFreePort(
  make: (p: number) => UiBridge = (p) => new UiBridge(p),
): Promise<{ bridge: UiBridge; port: number }> {
  let lastErr = "no attempt made";
  for (let attempt = 0; attempt < 6; attempt++) {
    const p = await freePort();
    const b = make(p);
    b.start();
    if (await b.whenReady()) return { bridge: b, port: p };
    lastErr = `bind to ${p} lost a close→rebind race`;
    await b.stop();
  }
  throw new Error(`could not bind a free bridge port after 6 attempts: ${lastErr}`);
}

function connectPanel(
  tabId?: string,
  title = "workflow-a",
  opts: { tabSessionId?: string } = {},
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    sock.on("open", () => {
      if (tabId) {
        // Current panels advertise both the dispatch and after-await write-boundary
        // workflow-stamp checks, so a mutating graph command is not gated (#570/#718).
        // Tests exercising an old-panel gate omit one of these flags explicitly.
        sock.send(
          JSON.stringify({
            type: "hello",
            tab_id: tabId,
            title,
            enforces_workflow_stamp: true,
            enforces_workflow_stamp_at_write: true,
            // The panel's sessionStorage-backed browser-tab identity: unique per
            // browser tab, stable across a reload (#486/#709).
            ...(opts.tabSessionId ? { tab_session_id: opts.tabSessionId } : {}),
          }),
        );
      }
      resolve(sock);
    });
    sock.on("error", reject);
  });
}

/** Auto-reply to commands with a tag identifying which panel answered. */
function autoReply(sock: WebSocket, tag: string): void {
  sock.on("message", (buf) => {
    const msg = JSON.parse(buf.toString());
    if (msg.rid && msg.cmd) {
      sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { from: tag, cmd: msg.cmd } }));
    }
  });
}

beforeEach(async () => {
  // Bind on an OS-assigned free port (retried past the rare reuse race) so the
  // shared bridge is guaranteed listening before any test connects a client —
  // start() binds asynchronously, and a fixed-range random port could collide with
  // a parallel test file on loaded CI, leaving whenReady() false (the #486/#619
  // Windows bind flake). startBridgeOnFreePort awaits `listening` internally.
  ({ bridge, port } = await startBridgeOnFreePort());
  // #570 P0c — by default a tab has a trusted workflow identity (current panels always send a
  // valid workflow_uuid), so mutating graph/workflow commands carry a stamp and pass the gate.
  // Tests that exercise the NO-stamp / cross-workflow-switch cases override this resolver.
  bridge.setTabWorkflowUuidResolver(() => "11111111-1111-4111-8111-111111111111");
});

afterEach(async () => {
  await bridge.stop();
  vi.restoreAllMocks();
});

describe("UiBridge (token gate — secure/wss mode)", () => {
  it("accepts the correct token and rejects a missing one", async () => {
    const tport = await freePort();
    const tbridge = new UiBridge(tport, "s3cr3t-token");
    tbridge.start();
    expect(await tbridge.whenReady()).toBe(true);

    // No token → the verifyClient 401 makes the client error out without opening.
    await expect(
      new Promise((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${tport}`);
        s.on("open", () => reject(new Error("opened without a token")));
        s.on("error", () => resolve("rejected"));
      }),
    ).resolves.toBe("rejected");

    // Correct token → opens and can register a tab.
    const ok = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${tport}/?token=s3cr3t-token`);
      s.on("open", () => resolve(s));
      s.on("error", reject);
    });
    ok.send(JSON.stringify({ type: "hello", tab_id: "tab-secure-1", title: "wf" }));
    await waitFor(() => expect(tbridge.connected()).toBe(true));
    ok.close();
    await tbridge.stop();
  });

  it("rejects a wrong token", async () => {
    const tport = await freePort();
    const tbridge = new UiBridge(tport, "right-token");
    tbridge.start();
    expect(await tbridge.whenReady()).toBe(true);
    await expect(
      new Promise((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${tport}/?token=wrong`);
        s.on("open", () => reject(new Error("opened with a wrong token")));
        s.on("error", () => resolve("rejected"));
      }),
    ).resolves.toBe("rejected");
    await tbridge.stop();
  });
});

describe("UiBridge (LAN bind — panel #54)", () => {
  it("refuses to construct a non-loopback bridge without a token", () => {
    expect(() => new UiBridge(20123, null, "0.0.0.0")).toThrow(/without a token/);
    expect(() => new UiBridge(20123, null, "192.168.1.10")).toThrow(/without a token/);
  });

  it("loopback hosts stay allowed without a token", async () => {
    const tport = await freePort();
    const lb = new UiBridge(tport, null, "localhost");
    lb.start();
    expect(await lb.whenReady()).toBe(true);
    await lb.stop();
  });

  it("binds 0.0.0.0 with a token, gates the upgrade, and serves a tab", async () => {
    const tport = await freePort();
    const lan = new UiBridge(tport, "lan-token", "0.0.0.0");
    lan.start();
    expect(await lan.whenReady()).toBe(true);

    // no token → rejected even on the LAN bind
    await expect(
      new Promise((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${tport}`);
        s.on("open", () => reject(new Error("opened without a token")));
        s.on("error", () => resolve("rejected"));
      }),
    ).resolves.toBe("rejected");

    // token in the URL (exactly what the panel's Advanced Bridge URL carries) → works
    const ok = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${tport}/?token=lan-token`);
      s.on("open", () => resolve(s));
      s.on("error", reject);
    });
    ok.send(JSON.stringify({ type: "hello", tab_id: "tab-lan-1", title: "wf" }));
    await waitFor(() => expect(lan.connected()).toBe(true));
    ok.close();
    await lan.stop();
  });
});

describe("UiBridge (on-demand pairing listener — addListener)", () => {
  it("adds a token-gated second listener sharing tab routing; primary loopback stays token-less", async () => {
    // The beforeEach bridge is loopback + token-less (the local panel case).
    const pairPort = await freePort();
    await bridge.addListener("127.0.0.1", pairPort, "pair-token");

    // Pairing port WITHOUT a token → rejected.
    await expect(
      new Promise((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${pairPort}`);
        s.on("open", () => reject(new Error("opened pairing port without a token")));
        s.on("error", () => resolve("rejected"));
      }),
    ).resolves.toBe("rejected");

    // Wrong token → rejected.
    await expect(
      new Promise((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${pairPort}/?token=nope`);
        s.on("open", () => reject(new Error("opened pairing port with a wrong token")));
        s.on("error", () => resolve("rejected"));
      }),
    ).resolves.toBe("rejected");

    // Correct token → opens and registers a tab on the SAME bridge.
    const phone = await new Promise<WebSocket>((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${pairPort}/?token=pair-token`);
      s.on("open", () => resolve(s));
      s.on("error", reject);
    });
    phone.send(JSON.stringify({ type: "hello", tab_id: "phone-1", title: "mobile" }));
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "phone-1")).toBe(true));

    // The primary loopback listener is STILL token-less (local panel unaffected).
    const local = await connectPanel("local-1");
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "local-1")).toBe(true));

    phone.close();
    local.close();
  });
});

describe("UiBridge (mailbox — offline render delivery)", () => {
  it("buffers show_media for an offline tab and flushes it on reconnect", async () => {
    // No tab connected. A finished-render delivery to a specific (offline) tab is
    // buffered, not failed.
    const res = await bridge.send(
      { cmd: "show_media", items: [{ filename: "a.png" }] },
      { tabId: "phone-stable-1" },
    );
    expect(res).toMatchObject({ ok: true, mailboxed: true });

    // An INTERACTIVE command to an offline tab still rejects (not mailboxable).
    await expect(
      bridge.send({ cmd: "graph_outline" }, { tabId: "phone-stable-1" }),
    ).rejects.toThrow();

    // The phone reconnects (same stable tab id) → it gets the buffered show_media
    // (flagged mailbox:true) plus a mailbox_flush summary.
    const got: Array<Record<string, unknown>> = [];
    const phone = await connectPanel(); // open socket, no hello yet
    phone.on("message", (buf) => got.push(JSON.parse(buf.toString())));
    phone.send(JSON.stringify({ type: "hello", tab_id: "phone-stable-1", title: "mobile" }));

    await waitFor(() => {
      const media = got.find((m) => m.cmd === "show_media");
      const flush = got.find((m) => m.type === "mailbox_flush");
      expect(media).toMatchObject({ mailbox: true });
      expect(flush).toMatchObject({ count: 1 });
    });
    phone.close();
  });

  it("dropQueuedDeliveries discards buffered frames so a replaced workflow gets nothing (#570 P0)", async () => {
    // A prior workflow buffered a finished render for an offline tab.
    const res = await bridge.send(
      { cmd: "show_media", items: [{ filename: "A-private.png" }] },
      { tabId: "wf:foo.json" },
    );
    expect(res).toMatchObject({ ok: true, mailboxed: true });
    // The workflow at that path was overwritten in place → the orchestrator's identity
    // reset drops the buffered deliveries (they belong to the PRIOR workflow).
    bridge.dropQueuedDeliveries("wf:foo.json");
    // The replacement reconnects under the SAME tab id → it must receive NOTHING buffered.
    const got: Array<Record<string, unknown>> = [];
    const tab = await connectPanel();
    tab.on("message", (buf) => got.push(JSON.parse(buf.toString())));
    tab.send(JSON.stringify({ type: "hello", tab_id: "wf:foo.json", title: "workflow-b" }));
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "wf:foo.json")).toBe(true));
    expect(got.find((m) => m.cmd === "show_media")).toBeUndefined();
    expect(got.find((m) => m.type === "mailbox_flush")).toBeUndefined();
    tab.close();
  });

  it("does not mailbox interactive commands (only show_media)", async () => {
    await expect(
      bridge.send({ cmd: "graph_get_state" }, { tabId: "nobody" }),
    ).rejects.toThrow();
    // Reconnecting that tab flushes nothing.
    const got: Array<Record<string, unknown>> = [];
    const phone = await connectPanel();
    phone.on("message", (buf) => got.push(JSON.parse(buf.toString())));
    phone.send(JSON.stringify({ type: "hello", tab_id: "nobody", title: "x" }));
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "nobody")).toBe(true));
    expect(got.find((m) => m.type === "mailbox_flush")).toBeUndefined();
    phone.close();
  });
});

describe("UiBridge — revokeTabMigration fences a switched-away workflow's route (#570 P0a)", () => {
  it("stops a stale panel_* call to the old id from resolving onto the new workflow", async () => {
    // One socket hellos as workflow A, then re-hellos as a DIFFERENT workflow B (a
    // same-socket switch) — the bridge installs the A→B migration alias.
    const sock = await connectPanel("wf:A", "workflow-a");
    autoReply(sock, "the-live-canvas");
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "wf:A")).toBe(true));
    sock.send(JSON.stringify({ type: "hello", tab_id: "wf:B", title: "workflow-b" }));
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "wf:B")).toBe(true));

    // BEFORE the fence: a stale call addressed to the OLD id resolves THROUGH the alias
    // to the live socket (now showing B) — the exact wrong-canvas mutation path.
    const leaked = await bridge.send({ cmd: "graph_get_state" }, { tabId: "wf:A" });
    expect(leaked).toMatchObject({ from: "the-live-canvas" });

    // Fence it (what the orchestrator does on an unproven same-socket switch).
    bridge.revokeTabMigration("wf:A");

    // AFTER: the same stale call no longer routes to B — it fails to resolve instead of
    // mutating the newly-selected canvas. B's own id still routes fine.
    await expect(bridge.send({ cmd: "graph_get_state" }, { tabId: "wf:A" })).rejects.toThrow();
    const direct = await bridge.send({ cmd: "graph_get_state" }, { tabId: "wf:B" });
    expect(direct).toMatchObject({ from: "the-live-canvas" });
    sock.close();
  });
});

describe("UiBridge (typed dispatch outcome — panel #442 defect 4)", () => {
  // Reply to any command with an executor FAILURE (ok:false). Mirrors a panel-side
  // graph executor rejecting — the bridge turns it into a plain Error with NO typed
  // dispatch flag, so a caller must NOT treat it as a pre-dispatch "nothing applied".
  function replyError(sock: WebSocket, errorText: string): void {
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) sock.send(JSON.stringify({ rid: msg.rid, ok: false, error: errorText }));
    });
  }

  it("a resolveTarget refusal (no connected tab) rejects with dispatched:false", async () => {
    // No panel connected; a non-mailboxable (interactive) command can't be routed.
    let caught: unknown;
    await bridge.send({ cmd: "graph_set_widget" }, { tabId: "ghost-tab" }).catch((e) => (caught = e));
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/no connected tab with id "ghost-tab"/);
    // THE contract the #442 wrapper keys on: this is provably pre-dispatch (nothing sent).
    expect(dispatchOutcomeOf(caught)).toBe(false);
  });

  it("lists the actually-connected tabs (not 'none') when OTHER tabs are live — still dispatched:false", async () => {
    const a = await connectPanel("tab-live-1111", "flux-workflow");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    let caught: unknown;
    await bridge.send({ cmd: "graph_set_widget" }, { tabId: "gone-tab" }).catch((e) => (caught = e));
    // Faithful message: the routing error names the live tab, proving the multi-tab
    // read/edit-channel disagreement (#442) — panel_list_workflows would still answer.
    expect((caught as Error).message).toMatch(/Connected:.*flux-workflow/);
    expect(dispatchOutcomeOf(caught)).toBe(false);
    a.close();
  });

  it("a real executor ok:false failure carries NO typed flag (dispatchOutcomeOf === undefined)", async () => {
    // The tab IS connected and DID receive the command — its executor merely failed, with
    // an error string that even QUOTES the routing phrase. The wrapper must never treat
    // this as "nothing applied": the flag is absent, not false.
    const a = await connectPanel("tab-exec-1111");
    replyError(a, 'graph_set_widget failed: stale ref to "no connected tab" in cache');
    await waitFor(() => expect(bridge.connected()).toBe(true));
    let caught: unknown;
    await bridge.send({ cmd: "graph_set_widget" }, { tabId: "tab-exec-1111" }).catch((e) => (caught = e));
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("stale ref");
    expect(dispatchOutcomeOf(caught)).toBeUndefined(); // NOT false — it WAS dispatched
    a.close();
  });

  it("a mailboxable delivery to an offline tab RESOLVES (never a dispatched:false rejection)", async () => {
    // The offline-render mailbox path returns a resolved value, so it never acquires a
    // dispatch flag — the #442 wrapper only ever sees genuine rejections.
    const res = await bridge.send(
      { cmd: "show_media", items: [{ filename: "a.png" }] },
      { tabId: "offline-phone-1" },
    );
    expect(res).toMatchObject({ ok: true, mailboxed: true });
  });

  it("a successfully-acked command resolves (no dispatch flag involved)", async () => {
    const a = await connectPanel("tab-ok-1111");
    autoReply(a, "A");
    await waitFor(() => expect(bridge.connected()).toBe(true));
    const result = await bridge.send({ cmd: "graph_set_widget" }, { tabId: "tab-ok-1111" });
    expect(result).toMatchObject({ from: "A" });
    a.close();
  });
});

describe("UiBridge (multi-tab)", () => {
  it("routes to the single connected tab without tab_id", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    autoReply(a, "A");
    await waitFor(() => expect(bridge.connected()).toBe(true));
    const result = await bridge.send({ cmd: "graph_get_state" });
    expect(result).toEqual({ from: "A", cmd: "graph_get_state" });
    a.close();
  });

  it("registers multiple tabs and lists them in status()", async () => {
    const a = await connectPanel("tab-aaaa-1111", "flux-workflow");
    const b = await connectPanel("tab-bbbb-2222", "video-workflow");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(2));
    const status = bridge.status();
    expect(status).toContain("2 panel tab(s) connected");
    expect(status).toContain("flux-workflow");
    expect(status).toContain("video-workflow");
    a.close();
    b.close();
  });

  it("routes by explicit tab_id (full id and 8-char prefix)", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    const b = await connectPanel("tab-bbbb-2222");
    autoReply(a, "A");
    autoReply(b, "B");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(2));

    const full = await bridge.send({ cmd: "x" }, { tabId: "tab-bbbb-2222" });
    expect(full).toMatchObject({ from: "B" });
    const prefix = await bridge.send({ cmd: "x" }, { tabId: "tab-aaaa" });
    expect(prefix).toMatchObject({ from: "A" });
    a.close();
    b.close();
  });

  it("errors with the tab list when multiple tabs and no target", async () => {
    const a = await connectPanel("tab-aaaa-1111", "one");
    const b = await connectPanel("tab-bbbb-2222", "two");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(2));
    await expect(bridge.send({ cmd: "x" })).rejects.toThrow(/pass tab_id/);
    a.close();
    b.close();
  });

  it("defaults to the last tab the user typed in", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    const b = await connectPanel("tab-bbbb-2222");
    autoReply(a, "A");
    autoReply(b, "B");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(2));

    // User types in tab B → it becomes the default target.
    b.send(JSON.stringify({ type: "user_message", text: "hi from B" }));
    await waitFor(async () => {
      const result = await bridge.send({ cmd: "x" });
      expect(result).toMatchObject({ from: "B" });
    });
    a.close();
    b.close();
  });

  it("stamps user_message events with tab_id and title", async () => {
    const received: unknown[] = [];
    bridge.onPanelMessage = (e) => {
      if (e.type === "user_message") received.push(e);
    };
    const a = await connectPanel("tab-aaaa-1111", "my-flux-graph");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    a.send(JSON.stringify({ type: "user_message", text: "make it dreamier" }));
    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      text: "make it dreamier",
      tab_id: "tab-aaaa-1111",
      title: "my-flux-graph",
    });
    a.close();
  });

  it("records the tab's ComfyUI origin from hello and preserves it across a re-hello (#509)", async () => {
    const a = await connectPanel("tab-origin-1", "wf");
    a.send(
      JSON.stringify({
        type: "hello",
        tab_id: "tab-origin-1",
        title: "wf",
        comfyui_url: "http://127.0.0.1:8188",
      }),
    );
    await waitFor(() => expect(bridge.tabOrigin("tab-origin-1")).toBe("http://127.0.0.1:8188"));
    // Token-less loopback primary listener → server-trusted local provenance.
    expect(bridge.tabIsLocal("tab-origin-1")).toBe(true);
    // A later re-hello that OMITS comfyui_url must not wipe the stored origin.
    a.send(JSON.stringify({ type: "hello", tab_id: "tab-origin-1", title: "wf" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.tabOrigin("tab-origin-1")).toBe("http://127.0.0.1:8188");
    // Unknown tab → undefined origin / not-local.
    expect(bridge.tabOrigin("nope")).toBeUndefined();
    expect(bridge.tabIsLocal("nope")).toBe(false);
    a.close();
  });

  it("push() broadcasts to all tabs by default and targets with tabId", async () => {
    const got: Record<string, unknown[]> = { A: [], B: [] };
    const a = await connectPanel("tab-aaaa-1111");
    const b = await connectPanel("tab-bbbb-2222");
    a.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type === "say") got.A.push(m);
    });
    b.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type === "say") got.B.push(m);
    });
    await waitFor(() => expect(bridge.tabs()).toHaveLength(2));

    expect(bridge.push({ type: "say", text: "to all" })).toBe(2);
    expect(bridge.push({ type: "say", text: "only B" }, "tab-bbbb")).toBe(1);
    await waitFor(() => {
      expect(got.A).toHaveLength(1);
      expect(got.B).toHaveLength(2);
    });
    a.close();
    b.close();
  });

  it("same tab reconnecting (reload) supersedes its stale socket without touching other tabs", async () => {
    const a1 = await connectPanel("tab-aaaa-1111");
    const b = await connectPanel("tab-bbbb-2222");
    autoReply(b, "B");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(2));

    const a2 = await connectPanel("tab-aaaa-1111"); // reload of tab A
    autoReply(a2, "A2");
    await waitFor(() => expect(a1.readyState).toBe(WebSocket.CLOSED));
    expect(bridge.tabs()).toHaveLength(2);

    const viaA = await bridge.send({ cmd: "x" }, { tabId: "tab-aaaa" });
    expect(viaA).toMatchObject({ from: "A2" });
    const viaB = await bridge.send({ cmd: "x" }, { tabId: "tab-bbbb" });
    expect(viaB).toMatchObject({ from: "B" });
    a2.close();
    b.close();
  });

  it("times out when the target tab never replies", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    await expect(bridge.send({ cmd: "x" }, { timeoutMs: 100 })).rejects.toThrow(/did not reply/);
    a.close();
  });

  it("exposes the exact request id only after a command frame is written", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    let frameRid: string | undefined;
    a.on("message", (buf) => {
      const frame = JSON.parse(buf.toString());
      if (frame.cmd === "x") {
        frameRid = frame.rid;
        a.send(JSON.stringify({ rid: frame.rid, ok: true, result: { ok: true } }));
      }
    });
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    const observed: string[] = [];
    await expect(
      bridge.send({ cmd: "x" }, { onDispatchedRid: (rid) => observed.push(rid) }),
    ).resolves.toMatchObject({ ok: true });
    expect(observed).toEqual([frameRid]);
    a.close();
  });

  it("rejects in-flight commands when the target tab disconnects", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    const promise = bridge.send({ cmd: "x" }, { timeoutMs: 5000 });
    a.close();
    await expect(promise).rejects.toThrow(/disconnected mid-command/);
  });

  it("a MUTATING command dropped mid-command reports OUTCOME UNKNOWN, not a clean failure (#450)", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    // graph_run queues a real render — it was already written to the socket before
    // the drop, so the panel may have applied it. A blind retry = double render.
    const promise = bridge.send({ cmd: "graph_run" }, { timeoutMs: 5000 });
    a.close();
    await expect(promise).rejects.toThrow(/OUTCOME UNKNOWN/);
    await expect(promise).rejects.toThrow(/graph_run/);
  });

  it("an IDEMPOTENT read dropped mid-command RESUMES when the tab reconnects (#450)", async () => {
    const a1 = await connectPanel("tab-aaaa-1111");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    // No autoReply on a1 → the read stays in-flight (un-acked) when we drop it.
    const promise = bridge.send({ cmd: "graph_get_errors" }, { timeoutMs: 5000 });
    // Ensure the command reached the server (is pending) before dropping the socket.
    await new Promise((r) => setTimeout(r, 50));
    a1.close();
    // Same tab reconnects within the grace window and answers the resumed read.
    const a2 = await connectPanel("tab-aaaa-1111");
    autoReply(a2, "A2");
    await expect(promise).resolves.toMatchObject({ from: "A2", cmd: "graph_get_errors" });
    a2.close();
  });

  it("dropQueuedDeliveries CANCELS a parked read so it is NOT re-dispatched onto a replacement (#570 P0)", async () => {
    const a1 = await connectPanel("wf:foo.json");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    // Workflow A has an idempotent read in flight (no autoReply → un-acked).
    const promise = bridge.send({ cmd: "graph_get_errors" }, { tabId: "wf:foo.json", timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    a1.close(); // socket drops mid-command → parked in awaitingReconnect
    await new Promise((r) => setTimeout(r, 20));
    // The workflow at that path is overwritten in place → the orchestrator's identity reset
    // cancels the tab's queued work, incl. the parked read (so it can't run against B).
    bridge.dropQueuedDeliveries("wf:foo.json");
    // The parked read is REJECTED (cancelled), not left to resume.
    await expect(promise).rejects.toThrow(/replaced by a different workflow|cancelled/);
    // The replacement B reconnects under the SAME tab id and answers nothing for A: the
    // resume must NOT re-dispatch A's old read onto B.
    const b = await connectPanel();
    const seen: Array<Record<string, unknown>> = [];
    b.on("message", (buf) => seen.push(JSON.parse(buf.toString())));
    b.send(JSON.stringify({ type: "hello", tab_id: "wf:foo.json", title: "workflow-b" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.find((m) => m.cmd === "graph_get_errors")).toBeUndefined();
    b.close();
  });

  it("dropQueuedDeliveries REJECTS an in-flight command so its late reply can't resolve the prior call (#570 P0)", async () => {
    const a = await connectPanel("wf:foo.json");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    // A command is in flight on the live socket (no autoReply → pending, un-acked).
    const promise = bridge.send({ cmd: "graph_get_state" }, { tabId: "wf:foo.json", timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    // The workflow is replaced in place → the identity reset cancels in-flight work so a late
    // reply can't resolve the PRIOR workflow's tool call.
    bridge.dropQueuedDeliveries("wf:foo.json");
    await expect(promise).rejects.toThrow(/replaced by a different workflow|cancelled/);
    a.close();
  });

  it("resumes a read addressed by tab-id PREFIX after reconnect (canonical key) (#450)", async () => {
    const a1 = await connectPanel("tab-aaaa-1111");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    // Address by prefix — parking must key on the canonical resolved id, not "tab-aaaa".
    const promise = bridge.send({ cmd: "graph_get_errors" }, { tabId: "tab-aaaa", timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    a1.close();
    const a2 = await connectPanel("tab-aaaa-1111");
    autoReply(a2, "A2");
    await expect(promise).resolves.toMatchObject({ from: "A2" });
    a2.close();
  });

  it("does NOT extend the caller's deadline when a read resumes (#450)", async () => {
    const a1 = await connectPanel("tab-aaaa-1111");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    // Short deadline. Drop, reconnect with a tab that NEVER replies → must reject
    // near the original 300ms deadline, not restart a fresh full timeout.
    const started = Date.now();
    const promise = bridge.send({ cmd: "graph_get_errors" }, { timeoutMs: 300 });
    await new Promise((r) => setTimeout(r, 30));
    a1.close();
    const a2 = await connectPanel("tab-aaaa-1111"); // reconnects but never autoReplies
    await expect(promise).rejects.toThrow(/did not reply|genuinely gone/);
    expect(Date.now() - started).toBeLessThan(2000);
    a2.close();
  });

  it("an idempotent read whose tab never returns fails as genuinely gone (#450)", async () => {
    const a = await connectPanel("tab-aaaa-1111");
    // BOUNDED UNDER THIS TEST'S OWN BUDGET (#1325). The helper's 15s default is larger
    // than the 10s below, so a stuck connect would be killed by the runner and reported as
    // vitest's generic "test timed out" instead of naming the wait. This connect is local
    // and takes milliseconds; 3s is slack, not a deadline under test.
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1), { timeout: 3000 });
    const promise = bridge.send({ cmd: "graph_get_errors" }, { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    a.close();
    // No reconnect → after the bounded grace it rejects as genuinely gone.
    await expect(promise).rejects.toThrow(/genuinely gone/);
  }, 10000);

  it("fails fast with guidance when no tab is connected", async () => {
    await expect(bridge.send({ cmd: "x" })).rejects.toThrow(/no panel connected/);
  });

  it("rejects an unknown tab_id with the connected-tab list", async () => {
    const a = await connectPanel("tab-aaaa-1111", "one");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    await expect(bridge.send({ cmd: "x" }, { tabId: "nope" })).rejects.toThrow(/no connected tab/);
    a.close();
  });

  // #436 priority 4: the no-panel guidance must be ACTIONABLE. Before any tab has
  // connected, "install the pack" is right. But once a tab HAS connected and later
  // dropped (the post-restart / tab-reload window), the pack is provably installed —
  // so the guidance must send the user to refresh the ComfyUI browser tab, never to
  // diagnose a nonexistent install problem (the exact wrong path the report hit).
  describe("actionable no-panel guidance after a reconnect drop (#436.4)", () => {
    it("suggests installing the pack ONLY when nothing has ever connected", () => {
      // Fresh bridge (beforeEach) — no tab has ever helloed.
      const msg = bridge.status();
      expect(msg).toMatch(/pack installed/);
      expect(msg).not.toMatch(/refresh/i);
    });

    // #804: the zero-tab-ever state is a BUCKET (no ComfyUI / no pack / pack
    // pointing at another bridge). Naming one of them as the cause is what sent a
    // user who had already installed the pack back to install it again, so the
    // message must say what it observed, say that the observation does not
    // separate the cases, and give the check that does.
    it("never-connected states what was observed and does not assert a cause", () => {
      const msg = bridge.status();
      // The observation, scoped to this bridge AND to the kind of tab the flag
      // behind it actually tracks: everConnectedDesktopTab is canvas-owning tabs
      // only, so a headless client that connected and left must not be erased by
      // a blanket "nothing has ever connected".
      expect(msg).toMatch(/no ComfyUI canvas tab has connected to this bridge/);
      expect(msg).not.toMatch(/nothing has connected/);
      expect(msg).toMatch(/does not distinguish/);
      // ...and the discriminating check, in order, ending at the case the old
      // wording had no room for: present, but reaching a different bridge.
      expect(msg).toMatch(/is ComfyUI open in a browser/);
      expect(msg).toMatch(/has a provider been picked and Connect clicked/);
      // Step 4 must NOT conclude "different bridge": `conns` fills only on a valid
      // hello, so a token-rejected or never-helloed socket on THIS bridge leaves the
      // count at zero identically. Both are offered, with the log as the separator.
      expect(msg).toMatch(/splits two ways this state cannot tell apart/);
      expect(msg).toMatch(/the handshake never completed/);
      expect(msg).toMatch(/orchestrator log separates them/);
      // The mismatch remedy must point at the panel setting that can fix it, not at
      // the bind address printed here — under a 0.0.0.0 bind that is a wildcard no
      // panel can dial, and it carries no token.
      expect(msg).toMatch(/Settings → Advanced → Bridge URL/);
      expect(msg).not.toMatch(/COMFYUI_MCP_BRIDGE_PORT/);
      // install_comfyui(action:'panel') is named with BOTH its conditions: holding the tool is not
      // enough, since it is local-only and refuses in remote/cloud mode.
      expect(msg).toMatch(/local-only and refuses in remote\/cloud mode/);
    });

    // panel-tools.ts classifies a resolve failure as "nothing connected, defer the
    // rebind" vs "ambiguous, make the user choose" by MATCHING THIS TEXT, so
    // rewording the guidance can silently flip a deferrable state into a hard
    // failure. The classifier is an inline literal in a 7000-line file with no
    // exported seam, so this reads the two regexes STRAIGHT OUT OF THAT SOURCE and
    // applies them here. Copying them instead would prove only that the copy still
    // matches: this way a change on either side — the string or the matcher —
    // surfaces as a failure pointing at both.
    it("stays classifiable by the deferred-rebind matcher in panel-tools", () => {
      const src = readFileSync(
        new URL("../../orchestrator/panel-tools.ts", import.meta.url),
        "utf8",
      );
      const found = src.match(
        /noTabsConnected =\s*(\/[^\n]*?\/i)\.test\(msg\) &&\s*!(\/[^\n]*?\/i)\.test\(msg\);/,
      );
      expect(
        found,
        "could not locate the deferred-rebind classifier in panel-tools.ts — if it moved or " +
          "was restructured, re-point this test at it rather than deleting it",
      ).not.toBeNull();
      const [, positiveSrc, negativeSrc] = found!;
      const toRe = (literal: string): RegExp =>
        new RegExp(literal.slice(1, literal.lastIndexOf("/")), literal.slice(literal.lastIndexOf("/") + 1));
      const positive = toRe(positiveSrc);
      const negative = toRe(negativeSrc);
      for (const msg of [bridge.status(), bridge.noPanelGuidance()]) {
        expect(positive.test(msg), `not recognised as a no-tab state: ${msg}`).toBe(true);
        expect(negative.test(msg), `wrongly reads as an ambiguous multi-tab state: ${msg}`).toBe(false);
      }
    });

    it("after a tab connected then dropped, tells the user to refresh the browser tab (not install)", async () => {
      const a = await connectPanel("wf:workflows/x.json", "x");
      await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
      a.close();
      await waitFor(() => expect(bridge.tabs()).toHaveLength(0));
      const msg = bridge.status();
      expect(msg).toMatch(/refresh/i);
      expect(msg).toMatch(/browser tab/i);
      // Must NOT send the agent to diagnose a (nonexistent) install problem.
      expect(msg).not.toMatch(/pack installed and check the Agent sidebar/);
    });

    it("a WRITE to the pre-restart id after the drop fails with the refresh guidance appended, keeping 'Connected: none'", async () => {
      const a = await connectPanel("wf:workflows/x.json", "x");
      await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
      a.close();
      await waitFor(() => expect(bridge.tabs()).toHaveLength(0));
      const err = await bridge
        .send({ cmd: "graph_add_node" }, { tabId: "wf:workflows/x.json" })
        .catch((e) => e as Error);
      expect(err).toBeInstanceOf(Error);
      // Machine-readable phrase preserved (retry/transient classifiers + tests key on it)…
      expect(err.message).toMatch(/no connected tab with id "wf:workflows\/x\.json"\. Connected: none/);
      // …now with the actionable refresh guidance appended.
      expect(err.message).toMatch(/refresh/i);
      // The refusal is BEFORE any socket write — nothing was dispatched (fail-closed).
      expect(dispatchOutcomeOf(err)).toBe(false);
    });

    it("a HEADLESS-only history (phone mirror, no desktop tab) never claims the desktop pack is installed", async () => {
      // A canvas-less mobile/remote pseudo-panel connects then drops. It proves neither
      // that the sidebar pack is installed nor that a browser tab exists to refresh, so
      // the zero-tab guidance must stay the conservative "install the pack" wording.
      const phone = await new Promise<WebSocket>((resolve, reject) => {
        const s = new WebSocket(`ws://127.0.0.1:${port}`);
        s.on("open", () => {
          s.send(JSON.stringify({ type: "hello", tab_id: "phone-1", title: "mirror", headless: true }));
          resolve(s);
        });
        s.on("error", reject);
      });
      await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
      phone.close();
      await waitFor(() => expect(bridge.tabs()).toHaveLength(0));
      const msg = bridge.status();
      expect(msg).toMatch(/pack installed/);
      expect(msg).not.toMatch(/refresh/i);
    });

    it("a still-live OTHER tab keeps the exact tab listing (not the refresh guidance)", async () => {
      const a = await connectPanel("tab-aaaa-1111", "one");
      await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
      const err = await bridge
        .send({ cmd: "graph_add_node" }, { tabId: "wf:workflows/gone.json" })
        .catch((e) => e as Error);
      expect(err.message).toMatch(/Connected: tab-aaaa/);
      expect(err.message).not.toMatch(/refresh/i);
      a.close();
    });
  });

  // #436 priority 1: reads must be HONEST about the binding — a read cannot resolve a
  // tab the write path can't. Both a read (graph_outline) and a write (graph_add_node)
  // routed to the SAME id resolve through the SAME registry, so in the zero-tab window
  // BOTH refuse identically (no read false-positive), and once a tab is live BOTH reach
  // it. This is the registry-consistency guarantee the reconnect race violated.
  describe("read/write resolve against the same tab registry (#436.1)", () => {
    it("in the zero-tab window a read and a write to the same id BOTH refuse (dispatched:false)", async () => {
      const a = await connectPanel("wf:workflows/x.json", "x");
      await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
      a.close();
      await waitFor(() => expect(bridge.tabs()).toHaveLength(0));
      const readErr = await bridge
        .send({ cmd: "graph_outline" }, { tabId: "wf:workflows/x.json", timeoutMs: 500 })
        .catch((e) => e as Error);
      const writeErr = await bridge
        .send({ cmd: "graph_add_node" }, { tabId: "wf:workflows/x.json", timeoutMs: 500 })
        .catch((e) => e as Error);
      expect(readErr).toBeInstanceOf(Error);
      expect(writeErr).toBeInstanceOf(Error);
      // The read did NOT falsely resolve while the write was refused — both dispatched:false.
      expect(dispatchOutcomeOf(readErr)).toBe(false);
      expect(dispatchOutcomeOf(writeErr)).toBe(false);
      expect(readErr.message).toMatch(/no connected tab with id "wf:workflows\/x\.json"/);
    });
  });

  // The trusted workflow-uuid stamp registry (orchestrator's tabCommandWorkflowUuid)
  // is keyed by the CALLER's tab id, while command ROUTING resolves through the
  // bridge's same-socket migration alias. #884 re-bound agent sessions to the
  // SHARED SCOPE (no session is bound to a per-workflow tab id anymore), so the
  // #436 stamp-carry is gone: a SHARED-SCOPE caller mutates via the stamp of the
  // RESOLVED (active) conn, while a caller still naming a retired per-workflow id
  // keeps FAILING CLOSED — a straggler command issued for the old workflow must
  // never mutate the newly-shown one.
  describe("workflow stamps after a same-socket migration (#436.3 → #884)", () => {
    it("a shared-scope caller keeps mutating across the migration; the retired id fails closed", async () => {
      // Wire the stamp registry exactly as the orchestrator does (caller-keyed map).
      const stamps = new Map<string, string>();
      bridge.setTabWorkflowUuidResolver((tabId) => stamps.get(tabId));
      const UUID = "22222222-2222-4222-8222-222222222222";

      const sock = await connectPanel();
      const frames: Array<Record<string, unknown>> = [];
      sock.on("message", (buf) => {
        const m = JSON.parse(buf.toString());
        if (m.rid && m.cmd) {
          frames.push(m);
          sock.send(JSON.stringify({ rid: m.rid, ok: true, result: { ok: true } }));
        }
      });

      // 1) The panel connects on an UNSAVED tab with a trusted identity; the
      //    hello handler records its stamp and an agent session binds to the id.
      sock.send(
        JSON.stringify({
          type: "hello",
          tab_id: "tmp:unsaved",
          title: "Unsaved Workflow",
          enforces_workflow_stamp: true,
          enforces_workflow_stamp_at_write: true,
          workflow_uuid: UUID,
        }),
      );
      await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
      stamps.set("tmp:unsaved", UUID);
      const before = await bridge.send({ cmd: "graph_add_node" }, { tabId: "tmp:unsaved" });
      expect(before).toMatchObject({ ok: true });
      expect(frames.pop()?.workflow_uuid).toBe(UUID);

      // 2) The user saves: the SAME socket re-hellos under the new wf: id — a
      //    PROVEN same-workflow migration (identical uuid). Reads keep routing to
      //    the live tab through the migration alias…
      sock.send(
        JSON.stringify({
          type: "hello",
          tab_id: "wf:saved.json",
          title: "saved",
          enforces_workflow_stamp: true,
          enforces_workflow_stamp_at_write: true,
          workflow_uuid: UUID,
        }),
      );
      await waitFor(() => {
        expect(bridge.tabs()).toHaveLength(1);
        expect(bridge.tabs()[0].tab_id).toBe("wf:saved.json");
      });
      stamps.set("wf:saved.json", UUID); // the hello handler records the new id's stamp
      stamps.delete("tmp:unsaved"); // …and retires the old id's stamp (#884)

      // The retired per-workflow id: reads still ride the migration alias, but a
      // straggler WRITE issued for the old workflow keeps failing closed.
      const read = await bridge.send({ cmd: "graph_outline" }, { tabId: "tmp:unsaved" });
      expect(read).toMatchObject({ ok: true }); // reads ride the alias
      await expect(
        bridge.send({ cmd: "graph_add_node" }, { tabId: "tmp:unsaved" }),
      ).rejects.toThrow(/no trusted identity/);

      // 3) #884: the agent's session is bound to the SHARED SCOPE, not a tab id.
      //    A scope-addressed write resolves to the live (migrated) conn for
      //    ROUTING, but its STAMP comes from the SCOPE's registry entry — the
      //    orchestrator answers a scope caller with the workflow the CURRENT
      //    TURN was issued for. No carry, no browser refresh, and the panel
      //    still fences on the trusted uuid.
      stamps.set(SHARED_SESSION_SCOPE, UUID); // the orchestrator's turn capture
      const after = await bridge.send({ cmd: "graph_add_node" }, { tabId: SHARED_SESSION_SCOPE });
      expect(after).toMatchObject({ ok: true });
      expect(frames.pop()?.workflow_uuid).toBe(UUID);

      // 4) ISSUE-TIME WINS (codex round 1, P0): a turn issued for a DIFFERENT
      //    workflow than the one the active tab now shows must never be re-aimed
      //    at whatever is on screen. Before #1656 the frame shipped carrying the
      //    ISSUE-TIME uuid and the panel (comparing against its active workflow)
      //    DECLINED. That decline depended on the panel's live-identity read having
      //    settled — the window #1656 reports, where it had not and the command ran
      //    on the previous canvas. The stamp still comes from the SCOPE (issue-time),
      //    but the divergence it creates is now refused by the BRIDGE, before any
      //    socket write: the outcome #570 required (never applied to the wrong
      //    workflow) no longer depends on the timing of the panel's read.
      const TURN_UUID = "33333333-3333-4333-8333-333333333333";
      stamps.set(SHARED_SESSION_SCOPE, TURN_UUID);
      frames.length = 0; // step 2's read left a frame; what matters is nothing NEW ships
      const reaimedErr = await bridge
        .send({ cmd: "graph_add_node" }, { tabId: SHARED_SESSION_SCOPE })
        .then(
          () => null,
          (e) => e as Error,
        );
      expect(reaimedErr).not.toBeNull();
      expect(reaimedErr!.message).toMatch(/^workflow instance mismatch:/);
      expect(reaimedErr!.message).toContain(TURN_UUID); // the issue-time stamp is named…
      expect(reaimedErr!.message).toContain(UUID); // …against the tab's advertised identity
      expect(dispatchOutcomeOf(reaimedErr)).toBe(false);
      expect(frames).toEqual([]); // nothing reached the switched-to canvas

      sock.close();
    });
  });

  // #884 — the SHARED SESSION SCOPE separates session identity from routing: one
  // agent serves every tab/workflow, and a command addressed to the scope must
  // reach the workflow the user is actually on. These drive the REAL WS bridge.
  describe("shared-session-scope routing (#884)", () => {
    const SCOPE_KEY = `${SHARED_SESSION_SCOPE}::claude`;
    /** Install the PRODUCTION scope wiring on the live test bridge — the same
     *  TurnOriginTracker + resolver/repin factories index.ts constructs
     *  (confirming gate 3, P2: these tests must drive the real handlers, not
     *  hand-written stand-ins that cannot catch a defect in them). */
    function wireRealScopeRouting() {
      const backendOfKey = (key: string): string =>
        key.includes("::") ? key.slice(key.lastIndexOf("::") + 2) : "claude";
      // Mirrors the orchestrator's live tabBackends map: tabs default to
      // claude; a test flips an entry to simulate a provider switch/revival.
      const tabBackends = new Map<string, string>();
      const backendForTab = (tab: string): string => tabBackends.get(tab) ?? "claude";
      const tracker = new TurnOriginTracker({
        backendForTab,
        backendOfKey,
        uuidOfTab: () => undefined,
        liveTabOf: (tab) => bridge.liveTabIdFor(tab), // the production wiring
        warn: () => {},
      });
      const scopeAgentKeyOf = (scopeId: string): string =>
        scopeId === SHARED_SESSION_SCOPE ? SCOPE_KEY : scopeId;
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
      return { tracker, tabBackends };
    }
    it("a scope-addressed tool call reaches the tab the user LAST TALKED FROM", async () => {
      const a = await connectPanel("wf:workflows/a.json", "a");
      const b = await connectPanel("wf:workflows/b.json", "b");
      autoReply(a, "tab-a");
      autoReply(b, "tab-b");
      await waitFor(() => expect(bridge.tabs()).toHaveLength(2));

      // The user speaks from B → the scope routes there.
      b.send(JSON.stringify({ type: "user_message", text: "hi from b" }));
      await waitFor(async () => {
        const r = await bridge.send({ cmd: "graph_outline" }, { tabId: SHARED_SESSION_SCOPE });
        expect(r).toMatchObject({ from: "tab-b" });
      });

      // …then from A → the SAME scope now routes to A (several workflows open,
      // one session; each call still reaches the right canvas).
      a.send(JSON.stringify({ type: "user_message", text: "hi from a" }));
      await waitFor(async () => {
        const r = await bridge.send({ cmd: "graph_get_state" }, { tabId: SHARED_SESSION_SCOPE });
        expect(r).toMatchObject({ from: "tab-a" });
      });

      a.close();
      b.close();
    });

    it("a backend-QUALIFIED scope address routes exactly like the bare scope", async () => {
      // The panel MCP servers bind `orchestrator::<backend>` (so the workflow
      // stamp resolves per conversation); routing must treat it as the scope.
      const a = await connectPanel("wf:workflows/a.json", "a");
      autoReply(a, "tab-a");
      await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
      const r = await bridge.send({ cmd: "graph_outline" }, { tabId: `${SHARED_SESSION_SCOPE}::claude` });
      expect(r).toMatchObject({ from: "tab-a" });
      a.close();
    });

    it("with no last-active tab, the scope prefers the most recent INTERACTIVE conn over a headless viewer", async () => {
      const a = await connectPanel("wf:workflows/a.json", "a");
      autoReply(a, "tab-a");
      await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
      // A headless (canvas-less) client connects LAST — it must not steal routing.
      const phone = await connectPanel();
      phone.send(
        JSON.stringify({ type: "hello", tab_id: "mobile-1", title: "phone", headless: true }),
      );
      autoReply(phone, "phone");
      await waitFor(() => expect(bridge.tabs()).toHaveLength(2));

      const r = await bridge.send({ cmd: "graph_outline" }, { tabId: SHARED_SESSION_SCOPE });
      expect(r).toMatchObject({ from: "tab-a" });

      a.close();
      phone.close();
    });

    it("an IN-FLIGHT turn's pin outranks the active tab — a queued message from B cannot re-aim A's turn (confirming-gate P0)", async () => {
      const a = await connectPanel("wf:workflows/a.json", "a");
      const b = await connectPanel("wf:workflows/b.json", "b");
      autoReply(a, "tab-a");
      autoReply(b, "tab-b");
      await waitFor(() => expect(bridge.tabs()).toHaveLength(2));
      // The orchestrator pins the running turn to its origin tab A…
      let pin: string | null | undefined = "wf:workflows/a.json";
      bridge.setScopeTargetResolver(() => pin);
      // …then tab B sends a message, which moves lastActiveTabId to B immediately.
      b.send(JSON.stringify({ type: "user_message", text: "queued from b" }));
      await waitFor(async () => {
        // Un-pinned scope resolution now follows B…
        pin = undefined;
        const idle = await bridge.send({ cmd: "graph_outline" }, { tabId: SHARED_SESSION_SCOPE });
        expect(idle).toMatchObject({ from: "tab-b" });
      });
      // …but the PINNED turn keeps routing to A, not to the newly-active B.
      pin = "wf:workflows/a.json";
      const pinned = await bridge.send({ cmd: "workflow_open", path: "c.json" }, { tabId: SHARED_SESSION_SCOPE });
      expect(pinned).toMatchObject({ from: "tab-a" });
      a.close();
      b.close();
    });

    it("the EXPLICIT repin escapes a dead pin — the recovery the refusal advertises actually works (confirming-gate 2, P1)", async () => {
      const a = await connectPanel("wf:workflows/a.json", "a");
      const b = await connectPanel("wf:workflows/b.json", "b");
      autoReply(a, "tab-a");
      autoReply(b, "tab-b");
      await waitFor(() => expect(bridge.tabs()).toHaveLength(2));

      // The REAL production wiring (confirming gate 3, P2: this test used to
      // install a hand-written handler, which could not catch a defect in the
      // real one): the same tracker + resolver/repin factories index.ts wires.
      const { tracker } = wireRealScopeRouting();

      // A turn pinned to a tab that is now GONE: every scope-addressed call
      // refuses, and the refusal names panel_set_workflow_target as the way out.
      tracker.recordForMid("m-dead", undefined, "wf:workflows/gone.json");
      tracker.onSeen(SCOPE_KEY, "m-dead");
      await waitFor(() => expect(tracker.pinOf(SCOPE_KEY)).toBe("wf:workflows/gone.json"));
      await expect(
        bridge.send({ cmd: "graph_outline" }, { tabId: SHARED_SESSION_SCOPE }),
      ).rejects.toThrow(/no connected tab/);

      // The explicit recovery (panel_set_workflow_target mode:"current" calls
      // through this bridge method) escapes the dead pin onto the active tab.
      const repinned = bridge.repinScopeToActive(SHARED_SESSION_SCOPE);
      expect(repinned).toBeDefined();
      expect(tracker.pinOf(SCOPE_KEY)).toBe(repinned);

      // …and the SAME turn can now reach the panel again.
      const after = await bridge.send({ cmd: "graph_outline" }, { tabId: SHARED_SESSION_SCOPE });
      expect(after).toMatchObject({ from: expect.stringMatching(/^tab-/) });
      a.close();
      b.close();
    });

    it("the repin REFUSES to move a HEALTHY pin (confirming-gate 3, P0 — recovery, never a re-target)", async () => {
      const a = await connectPanel("wf:workflows/a.json", "a");
      const b = await connectPanel("wf:workflows/b.json", "b");
      autoReply(a, "tab-a");
      autoReply(b, "tab-b");
      await waitFor(() => expect(bridge.tabs()).toHaveLength(2));
      const { tracker } = wireRealScopeRouting();

      // A turn pinned to LIVE tab A…
      tracker.recordForMid("m-a", undefined, "wf:workflows/a.json");
      tracker.onSeen(SCOPE_KEY, "m-a");
      await waitFor(() => expect(tracker.pinOf(SCOPE_KEY)).toBe("wf:workflows/a.json"));
      // …while tab B becomes last-active (a queued message moves it instantly).
      b.send(JSON.stringify({ type: "user_message", text: "queued from b" }));
      await waitFor(() => {
        expect(bridge.resolveActiveScopeTab()).toBe("wf:workflows/b.json");
      });

      // Even a DIRECT repin call must refuse: the pin reaches a live tab, so
      // there is nothing to recover from — moving it would re-aim the running
      // turn's tool calls at a workflow it was never about.
      // #1077 Finding 2 — the refusal now carries WHY. What matters here is
      // unchanged (no tab id came back, the pin did not move); it now also says
      // the pin is healthy, which is the whole point of distinguishing this
      // correct refusal from the ones a user can act on.
      const declined = bridge.repinScopeToActive(SHARED_SESSION_SCOPE);
      expect(typeof declined).not.toBe("string");
      expect(declined).toMatchObject({ repinned: false });
      expect((declined as { reason: string }).reason).toMatch(/still reaches a live tab/);
      expect(tracker.pinOf(SCOPE_KEY)).toBe("wf:workflows/a.json");
      const still = await bridge.send({ cmd: "graph_outline" }, { tabId: SHARED_SESSION_SCOPE });
      expect(still).toMatchObject({ from: "tab-a" });
      a.close();
      b.close();
    });

    it("panel_reload (the REAL tool) leaves a HEALTHY scope-bound turn on its own tab (confirming-gate 3, P0)", async () => {
      // The exact reported sequence, driven end-to-end through the production
      // seams: turn pinned to A; a queued message makes B last-active; A's
      // agent calls panel_reload. Before this fix the tool's unconditional
      // rebindToActiveTab() repinned the healthy turn onto B — soft_reload
      // (and every later mutation, carrying B's freshly re-derived stamp)
      // went to B with no mode:"current" consent anywhere.
      const a = await connectPanel("wf:workflows/a.json", "a");
      const b = await connectPanel("wf:workflows/b.json", "b");
      autoReply(a, "tab-a");
      autoReply(b, "tab-b");
      await waitFor(() => expect(bridge.tabs()).toHaveLength(2));
      const { tracker } = wireRealScopeRouting();

      tracker.recordForMid("m-a", undefined, "wf:workflows/a.json");
      tracker.onSeen(SCOPE_KEY, "m-a");
      await waitFor(() => expect(tracker.pinOf(SCOPE_KEY)).toBe("wf:workflows/a.json"));
      b.send(JSON.stringify({ type: "user_message", text: "queued from b" }));
      await waitFor(() => expect(bridge.resolveActiveScopeTab()).toBe("wf:workflows/b.json"));

      const ctx = makePanelToolCtx(bridge, SCOPE_KEY, new WorkflowTargetStore());
      const reload = buildPanelToolDefs().find((d) => d.name === "panel_reload")!;
      const res = (await reload.handler({ scope: "frontend" }, ctx)) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
      };
      expect(res.isError).toBeFalsy();
      // The healthy pin stood, and the soft_reload frame reached A — not B.
      expect(tracker.pinOf(SCOPE_KEY)).toBe("wf:workflows/a.json");
      expect(JSON.parse(res.content[0].text!)).toMatchObject({ from: "tab-a", cmd: "soft_reload" });
      // The ctx stays scope-bound (never narrowed to a real tab id).
      expect(ctx.tabId).toBe(SCOPE_KEY);
      a.close();
      b.close();
    });

    it("panel_reload FAILS on a DEAD scope pin naming the recovery, and panel_set_workflow_target({mode:'current'}) then re-pins (confirming-gate 3)", async () => {
      const a = await connectPanel("wf:workflows/a.json", "a");
      const b = await connectPanel("wf:workflows/b.json", "b");
      autoReply(a, "tab-a");
      autoReply(b, "tab-b");
      await waitFor(() => expect(bridge.tabs()).toHaveLength(2));
      const { tracker } = wireRealScopeRouting();

      // A turn pinned to A… whose tab then disconnects: the pin is DEAD.
      tracker.recordForMid("m-a", undefined, "wf:workflows/a.json");
      tracker.onSeen(SCOPE_KEY, "m-a");
      await waitFor(() => expect(tracker.pinOf(SCOPE_KEY)).toBe("wf:workflows/a.json"));
      a.close();
      await waitFor(() => expect(bridge.tabs()).toHaveLength(1));

      // panel_reload is NOT a consent path: it fails, names the recovery, and
      // the pin is NOT silently moved.
      const ctx = makePanelToolCtx(bridge, SCOPE_KEY, new WorkflowTargetStore());
      const defs = buildPanelToolDefs();
      const reload = defs.find((d) => d.name === "panel_reload")!;
      const res = (await reload.handler({ scope: "frontend" }, ctx)) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
      };
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/panel_set_workflow_target\(\{mode:"current"\}\)/);
      expect(tracker.pinOf(SCOPE_KEY)).toBe("wf:workflows/a.json");

      // The advertised recovery — the REAL tool, carrying the explicit
      // consent — escapes the dead pin onto the live tab. (The tool's own
      // result additionally reports the fence outcome, which for this
      // synthetic panel's minimal workflow_list reply is honestly
      // "not recovered"; the fence-adoption path has its own coverage in
      // panel-tools.test.ts. What THIS asserts is the pin recovery itself.)
      const target = defs.find((d) => d.name === "panel_set_workflow_target")!;
      await target.handler({ mode: "current" }, ctx);
      expect(tracker.pinOf(SCOPE_KEY)).toBe("wf:workflows/b.json");
      // …and the same turn's scope calls reach the panel again.
      const after = await bridge.send({ cmd: "graph_outline" }, { tabId: SHARED_SESSION_SCOPE });
      expect(after).toMatchObject({ from: "tab-b" });
      b.close();
    });

    it("a hello that OMITS backend still drains the default conversation's mailbox (confirming-gate 2, P1)", async () => {
      // Offline show_media buffers under the BACKEND-QUALIFIED scope address.
      const qualified = `${SHARED_SESSION_SCOPE}::claude`;
      const res = await bridge.send(
        { cmd: "show_media", items: [{ url: "/view?x=1" }] },
        { tabId: qualified },
      );
      expect(res).toMatchObject({ mailboxed: true });

      // The tab hellos WITHOUT a backend field. The orchestrator maps absent →
      // default ("claude"), so it JOINS that conversation — and must therefore
      // drain its mailbox. Matching the raw string alone stranded it here, and
      // the media silently never arrived. This installs the REAL shared
      // normalizeHelloBackend (the same function the hello handler uses to
      // decide which conversation the tab joins), not a test-local
      // approximation (confirming gate 3, P2).
      bridge.setHelloBackendNormalizer((raw) =>
        normalizeHelloBackend(raw, new Set(["claude", "codex"]), "claude"),
      );
      // Open the socket and start listening BEFORE the hello — the drain happens
      // during hello processing, so a listener attached afterwards misses it.
      const tab = await connectPanel();
      const got: Array<Record<string, unknown>> = [];
      tab.on("message", (buf) => got.push(JSON.parse(buf.toString())));
      tab.send(JSON.stringify({ type: "hello", tab_id: "wf:workflows/a.json", title: "a" }));
      await waitFor(() => {
        expect(got.find((m) => m.cmd === "show_media")).toMatchObject({ mailbox: true });
      });
      tab.close();
    });

    it("liveTabIdFor follows a PATH-COMPRESSED multi-hop migration chain to the live tab (codex gate 4)", async () => {
      // A→B then B→C on the SAME socket: the bridge rewrites every historical
      // alias to the newest id in one step, so a pin naming A must be judged
      // as routing to C — no single hello ever reports A as migrated_from for
      // the second hop. This is the resolution the provider-switch pin
      // invalidation (TurnOriginTracker.tabChangedBackend) consults.
      const sock = await connectPanel("tmp:hop-a", "a");
      autoReply(sock, "surface");
      await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain("tmp:hop-a"));
      sock.send(JSON.stringify({ type: "hello", tab_id: "wf:hop-b", title: "b" }));
      await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain("wf:hop-b"));
      sock.send(JSON.stringify({ type: "hello", tab_id: "wf:hop-c", title: "c" }));
      await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id)).toContain("wf:hop-c"));

      expect(bridge.liveTabIdFor("tmp:hop-a")).toBe("wf:hop-c"); // two hops, compressed
      expect(bridge.liveTabIdFor("wf:hop-b")).toBe("wf:hop-c");
      expect(bridge.liveTabIdFor("wf:hop-c")).toBe("wf:hop-c");
      expect(bridge.liveTabIdFor("wf:never-seen")).toBeUndefined();
      sock.close();
    });

    it("a pin whose id is REVIVED by another backend's tab is refused at resolution (codex gate-4 delta P0)", async () => {
      // wf:<tabRouteId>:<path> ids are deterministic and recur. A Claude turn pins tab A;
      // A disconnects (no switch event will ever fire for it); a NEW socket
      // hellos under the SAME id on Codex. The pin now resolves exact-match
      // onto the revived tab, and a provider switch does not change the
      // workflow uuid — so only a USE-time ownership check refuses it.
      const a = await connectPanel("wf:revive.json", "a");
      autoReply(a, "old-claude-tab");
      await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
      const { tracker, tabBackends } = wireRealScopeRouting();

      tracker.recordForMid("m-a", undefined, "wf:revive.json");
      tracker.onSeen(SCOPE_KEY, "m-a");
      await waitFor(() => expect(tracker.pinOf(SCOPE_KEY)).toBe("wf:revive.json"));

      a.close();
      await waitFor(() => expect(bridge.tabs()).toHaveLength(0));
      // The revival: a different browser tab, same deterministic id, Codex.
      const revived = await connectPanel("wf:revive.json", "a-again");
      autoReply(revived, "new-codex-tab");
      await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
      tabBackends.set("wf:revive.json", "codex");

      // The scope command must be REFUSED — never delivered to the revived
      // Codex tab under the old Claude pin.
      await expect(
        bridge.send({ cmd: "graph_outline" }, { tabId: SHARED_SESSION_SCOPE, timeoutMs: 300 }),
      ).rejects.toThrow(/ambiguous/);
      expect(tracker.pinOf(SCOPE_KEY)).toBeNull(); // invalidated at first use
      revived.close();
    });

    it("a pinned turn FOLLOWS its own tab's same-socket migration, and REFUSES when the tab is gone or ambiguous", async () => {
      const a = await connectPanel("wf:workflows/a.json", "a");
      const b = await connectPanel("wf:workflows/b.json", "b");
      autoReply(a, "tab-a");
      autoReply(b, "tab-b");
      await waitFor(() => expect(bridge.tabs()).toHaveLength(2));
      let pin: string | null | undefined = "wf:workflows/a.json";
      bridge.setScopeTargetResolver(() => pin);

      // The turn's own tab switches workflow (same socket re-hellos) — the pin
      // follows through the migration alias: same browser surface, same turn.
      a.send(JSON.stringify({ type: "hello", tab_id: "wf:workflows/c.json", title: "c" }));
      await waitFor(() => {
        expect(bridge.tabs().map((t) => t.tab_id)).toContain("wf:workflows/c.json");
      });
      const followed = await bridge.send({ cmd: "graph_outline" }, { tabId: SHARED_SESSION_SCOPE });
      expect(followed).toMatchObject({ from: "tab-a" });

      // The pinned tab disconnects entirely: the scope REFUSES with the standard
      // no-connected-tab error — it must NOT silently fall back to tab B.
      a.close();
      await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
      pin = "wf:workflows/c.json";
      const gone = await bridge
        .send({ cmd: "graph_outline" }, { tabId: SHARED_SESSION_SCOPE, timeoutMs: 300 })
        .catch((e) => e as Error);
      expect(gone).toBeInstanceOf(Error);
      expect(dispatchOutcomeOf(gone)).toBe(false);
      expect((gone as Error).message).toMatch(/no connected tab/);

      // An ambiguous-origin turn (mixed batch → pin null) refuses loudly too.
      pin = null;
      const ambiguous = await bridge
        .send({ cmd: "graph_outline" }, { tabId: SHARED_SESSION_SCOPE, timeoutMs: 300 })
        .catch((e) => e as Error);
      expect(ambiguous).toBeInstanceOf(Error);
      expect((ambiguous as Error).message).toMatch(/ambiguous/);
      b.close();
    });

    it("a BACKEND-QUALIFIED scope buffer only drains to a hello on that backend (confirming-gate P1)", async () => {
      // Claude's conversation buffers a frame while nobody is connected…
      expect(
        bridge.push({ type: "say", text: "claude while away" }, `${SHARED_SESSION_SCOPE}::claude`),
      ).toBe(0);
      // …a CODEX tab hellos first: it must NOT receive Claude's output.
      const codexSock = await connectPanel();
      const codexGot: Array<Record<string, unknown>> = [];
      codexSock.on("message", (buf) => codexGot.push(JSON.parse(buf.toString())));
      codexSock.send(
        JSON.stringify({ type: "hello", tab_id: "wf:codex.json", title: "cx", backend: "codex" }),
      );
      await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
      // A CLAUDE tab hellos next: the buffer drains to it.
      const claudeSock = await connectPanel();
      const claudeGot: Array<Record<string, unknown>> = [];
      claudeSock.on("message", (buf) => claudeGot.push(JSON.parse(buf.toString())));
      claudeSock.send(
        JSON.stringify({ type: "hello", tab_id: "wf:claude.json", title: "cl", backend: "claude" }),
      );
      await waitFor(() => {
        expect(claudeGot.some((f) => f.type === "say" && f.text === "claude while away")).toBe(true);
      });
      expect(codexGot.some((f) => f.type === "say" && f.text === "claude while away")).toBe(false);
      codexSock.close();
      claudeSock.close();
    });

    it("scope-addressed frames buffered while NO tab is connected replay to the first hello", async () => {
      // Nobody connected: a background agent's turn output is buffered under the scope…
      expect(bridge.push({ type: "say", text: "finished while you were away" }, SHARED_SESSION_SCOPE)).toBe(0);
      // …and a scope-addressed command refuses with the authoritative dispatched:false.
      const err = await bridge
        .send({ cmd: "graph_outline" }, { tabId: SHARED_SESSION_SCOPE, timeoutMs: 300 })
        .catch((e) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(dispatchOutcomeOf(err)).toBe(false);
      expect((err as Error).message).toMatch(/no connected tab/);

      // The first tab to hello picks the buffered conversation up.
      const sock = await connectPanel();
      const got: Array<Record<string, unknown>> = [];
      sock.on("message", (buf) => got.push(JSON.parse(buf.toString())));
      sock.send(JSON.stringify({ type: "hello", tab_id: "wf:back.json", title: "back" }));
      await waitFor(() => {
        expect(got.some((f) => f.type === "say" && f.text === "finished while you were away")).toBe(
          true,
        );
      });
      sock.close();
    });
  });

  it("resolves via tab-id migration when a socket re-hellos under a new scheme (tmp:→wf:)", async () => {
    // Simulate the bug scenario: a tab first connects with a random-UUID tab id
    // (the old scheme), an agent binds to it, then the SAME socket re-hellos
    // under a deterministic tmp:/wf: scheme (the new scheme). bridge.send() with
    // the OLD id must still resolve to the new connection.
    const sock = await connectPanel(); // open socket, no hello yet
    autoReply(sock, "old-tab");
    await waitFor(() => expect(bridge.connected()).toBe(false));

    // 1) First hello: old-style random-UUID tab id.
    const oldId = "6eccc826-592e-4abb-b280-35434e00ddd1";
    sock.send(JSON.stringify({ type: "hello", tab_id: oldId, title: "image_flux2_fp8" }));
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));

    // Verify the old id works.
    const oldResult = await bridge.send({ cmd: "graph_outline" }, { tabId: oldId });
    expect(oldResult).toMatchObject({ from: "old-tab" });

    // 2) Same socket re-hellos under a new deterministic tab id (the migration).
    const newId = "wf:workf";
    sock.send(JSON.stringify({ type: "hello", tab_id: newId, title: "image_flux2_fp8" }));
    await waitFor(() => {
      expect(bridge.tabs()).toHaveLength(1);
      expect(bridge.tabs()[0].tab_id).toBe(newId);
    });

    // 3) The old agent (still holding the old tabId) sends a command via the
    //    bridge — this MUST resolve via the migration map instead of throwing.
    const migratedResult = await bridge.send({ cmd: "graph_get_state" }, { tabId: oldId });
    expect(migratedResult).toMatchObject({ from: "old-tab", cmd: "graph_get_state" });

    // 4) An UNKNOWN id (no migration, no connection) still fails with the
    //    expected error — plus a prefix mismatch for the old id should work too.
    await expect(
      bridge.send({ cmd: "x" }, { tabId: "completely-unknown" }),
    ).rejects.toThrow(/no connected tab/);

    sock.close();
  });

  it("migrates tab id when socket re-hellos to a different scheme and rejects absent tab_id", async () => {
    // Same scenario but with TWO tabs to ensure the migration is per-socket and
    // doesn't cross-contaminate.
    const sockA = await connectPanel();
    const sockB = await connectPanel();
    autoReply(sockA, "A");
    autoReply(sockB, "B");

    const oldA = "legacy-a-1111";
    const oldB = "legacy-b-2222";
    sockA.send(JSON.stringify({ type: "hello", tab_id: oldA, title: "flux-workflow" }));
    sockB.send(JSON.stringify({ type: "hello", tab_id: oldB, title: "video-workflow" }));
    await waitFor(() => expect(bridge.tabs()).toHaveLength(2));

    // Migrate tab A's socket to a new id, leave tab B unchanged.
    const newA = "wf:flux123";
    sockA.send(JSON.stringify({ type: "hello", tab_id: newA, title: "flux-workflow" }));
    await waitFor(() => {
      expect(bridge.tabs()).toHaveLength(2);
      expect(bridge.tabs().find((t) => t.tab_id === newA)).toBeTruthy();
      expect(bridge.tabs().find((t) => t.tab_id === oldA)).toBeFalsy();
    });

    // Old id A still routes to the migrated tab.
    const fromA = await bridge.send({ cmd: "x" }, { tabId: oldA });
    expect(fromA).toMatchObject({ from: "A" });

    // Old id B (never migrated) still works normally.
    const fromB = await bridge.send({ cmd: "x" }, { tabId: oldB });
    expect(fromB).toMatchObject({ from: "B" });

    // New id works directly too.
    const fromNewA = await bridge.send({ cmd: "x" }, { tabId: newA });
    expect(fromNewA).toMatchObject({ from: "A" });

    sockA.close();
    sockB.close();
  });

  it("SCRUBS a client-forged migrated_from (codex review: rebind hijack)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    bridge.onPanelMessage = (ev) => void seen.push(ev as unknown as Record<string, unknown>);
    const sock = await connectPanel();
    autoReply(sock, "attacker");
    // Fresh socket, FIRST hello — no migration happened, but the client claims one.
    sock.send(JSON.stringify({ type: "hello", tab_id: "attacker-tab", migrated_from: "victim-tab" }));
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    const hello = seen.find((e) => e.type === "hello" && e.tab_id === "attacker-tab");
    expect(hello).toBeTruthy();
    expect(hello!.migrated_from).toBeUndefined();
    bridge.onPanelMessage = null;
    sock.close();
  });

  it("a DEAD socket's migration alias never routes to an unrelated tab reusing the id (deterministic wf: reuse)", async () => {
    // sockA: legacy id → wf:reused (migration created), then DIES.
    const sockA = await connectPanel();
    autoReply(sockA, "A");
    sockA.send(JSON.stringify({ type: "hello", tab_id: "legacy-old-id" }));
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    sockA.send(JSON.stringify({ type: "hello", tab_id: "wf:reused" }));
    await waitFor(() => expect(bridge.tabs()[0]?.tab_id).toBe("wf:reused"));
    sockA.close();
    await waitFor(() => expect(bridge.tabs()).toHaveLength(0));

    // sockB: an UNRELATED tab that happens to get the same deterministic wf: id.
    const sockB = await connectPanel();
    autoReply(sockB, "B");
    sockB.send(JSON.stringify({ type: "hello", tab_id: "wf:reused" }));
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));

    // The old legacy id must NOT resolve to sockB's tab via the stale alias.
    await expect(bridge.send({ cmd: "x" }, { tabId: "legacy-old-id" })).rejects.toThrow(/no connected tab/);
    sockB.close();
  });

  it("canReach + resolveActiveTabId back the orchestrator's explicit self-heal (#322/#331/#332)", async () => {
    // A session was bound to old-tab, which then DIES and a genuinely new socket
    // reconnects under new-tab — NO migration alias (different socket, first hello).
    const sockOld = await connectPanel();
    autoReply(sockOld, "old");
    sockOld.send(JSON.stringify({ type: "hello", tab_id: "old-tab" }));
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    sockOld.close();
    await waitFor(() => expect(bridge.tabs()).toHaveLength(0));

    const sockNew = await connectPanel();
    autoReply(sockNew, "new");
    sockNew.send(JSON.stringify({ type: "hello", tab_id: "new-tab" }));
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));

    // The old id is orphaned (no migration) — canReach is false, and the no-tabId
    // resolution the orchestrator invokes at the explicit rebind lands on the sole
    // live tab. resolveTarget itself is NOT weakened: the old id still throws.
    expect(bridge.canReach("old-tab")).toBe(false);
    expect(bridge.canReach("new-tab")).toBe(true);
    expect(bridge.resolveActiveTabId()).toBe("new-tab");
    await expect(bridge.send({ cmd: "x" }, { tabId: "old-tab" })).rejects.toThrow(/no connected tab/);

    sockNew.close();
  });

  it("resolveActiveTabId throws (no guess) when 2+ tabs are connected with no last-active", async () => {
    const sockA = await connectPanel();
    autoReply(sockA, "A");
    sockA.send(JSON.stringify({ type: "hello", tab_id: "tab-a" }));
    const sockB = await connectPanel();
    autoReply(sockB, "B");
    sockB.send(JSON.stringify({ type: "hello", tab_id: "tab-b" }));
    await waitFor(() => expect(bridge.tabs()).toHaveLength(2));

    expect(() => bridge.resolveActiveTabId()).toThrow(/Multiple panel tabs/);
    sockA.close();
    sockB.close();
  });

  // #568 — the last-active SELECTION is per-tab identity state and must move with a
  // same-socket tab-id migration. Left on the retiring id it names a tab that no longer
  // exists, so with 2+ tabs connected every no-tabId resolution reports "none is last
  // active" and panel_set_workflow_target({mode:"current"}) — the one documented escape
  // hatch for a stale binding — can no longer recover. That is the reported wedge:
  // save-as with two tabs open, then nothing can rebind.
  describe("last-active selection across a tab-id migration (#568)", () => {
    /** Two live tabs; A has the last-active selection. Returns both sockets. */
    async function twoTabsWithAActive(): Promise<{ sockA: WebSocket; sockB: WebSocket }> {
      const sockA = await connectPanel();
      autoReply(sockA, "A");
      sockA.send(JSON.stringify({ type: "hello", tab_id: "wf:aaa" }));
      const sockB = await connectPanel();
      autoReply(sockB, "B");
      sockB.send(JSON.stringify({ type: "hello", tab_id: "wf:bbb" }));
      await waitFor(() => expect(bridge.tabs()).toHaveLength(2));
      // The user typed in A — that is what makes A the last-active tab.
      sockA.send(JSON.stringify({ type: "user_message", text: "hi" }));
      await waitFor(() => expect(bridge.resolveActiveTabId()).toBe("wf:aaa"));
      return { sockA, sockB };
    }

    it("a PROVEN same-socket migration moves it, so the explicit rebind still resolves", async () => {
      const { sockA, sockB } = await twoTabsWithAActive();

      // Save-as: the SAME socket re-hellos under a new wf: id. The retiring id is removed.
      sockA.send(JSON.stringify({ type: "hello", tab_id: "wf:ccc" }));
      await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id).sort()).toEqual(["wf:bbb", "wf:ccc"]));

      // The selection followed the SAME BROWSER TAB onto its new id — not a guess among the
      // live tabs, and emphatically not the unrelated wf:bbb. Without the carry this throws.
      expect(bridge.resolveActiveTabId()).toBe("wf:ccc");
      expect(bridge.status()).toContain("wf:ccc");
      sockA.close();
      sockB.close();
    });

    it("an UNPROVEN switch (revoked migration) REFUSES — it never names the switched-to tab", async () => {
      const { sockA, sockB } = await twoTabsWithAActive();
      sockA.send(JSON.stringify({ type: "hello", tab_id: "wf:ccc" }));
      await waitFor(() => expect(bridge.tabs().map((t) => t.tab_id).sort()).toEqual(["wf:bbb", "wf:ccc"]));

      // The orchestrator classified the re-hello as a switch to a DIFFERENT workflow.
      bridge.revokeTabMigration("wf:aaa");

      // UNKNOWN gets its own answer: refuse. The distinguishing assertion is that the
      // resolution does NOT come back as the switched-to tab — asserting only "throws"
      // would also pass if the selection had been cleared for the wrong reason, and
      // asserting only the tab COUNT passes in both the fixed and broken states.
      let resolved: string | null = null;
      try {
        resolved = bridge.resolveActiveTabId();
      } catch {
        resolved = null;
      }
      expect(resolved).not.toBe("wf:ccc");
      expect(resolved).toBeNull();
      expect(() => bridge.resolveActiveTabId()).toThrow(/none is "last active"/);
      sockA.close();
      sockB.close();
    });

    it("does NOT revert a selection the user made in the destination after the migration", async () => {
      const { sockA, sockB } = await twoTabsWithAActive();
      sockA.send(JSON.stringify({ type: "hello", tab_id: "wf:ccc" }));
      await waitFor(() => expect(bridge.resolveActiveTabId()).toBe("wf:ccc"));

      // The user then typed in the (switched-to) tab: a fresh, genuine selection that
      // happens to hold the SAME value the carry wrote, so only the write SEQUENCE can
      // tell them apart. The revoke must undo the carry, never this.
      sockA.send(JSON.stringify({ type: "user_message", text: "typed after the switch" }));
      await new Promise((r) => setTimeout(r, 30));
      bridge.revokeTabMigration("wf:aaa");

      expect(bridge.resolveActiveTabId()).toBe("wf:ccc");
      sockA.close();
      sockB.close();
    });

    it("follows a migration CHAIN, and a revoke of a superseded hop is inert", async () => {
      const { sockA, sockB } = await twoTabsWithAActive();
      // wf:aaa → tmp:mid → wf:ccc, all on the SAME socket (the reported id-scheme chain).
      sockA.send(JSON.stringify({ type: "hello", tab_id: "tmp:mid" }));
      await waitFor(() => expect(bridge.resolveActiveTabId()).toBe("tmp:mid"));
      sockA.send(JSON.stringify({ type: "hello", tab_id: "wf:ccc" }));
      await waitFor(() => expect(bridge.resolveActiveTabId()).toBe("wf:ccc"));

      // Revoking the FIRST (already superseded) hop must not touch the live selection:
      // the carry it recorded was overwritten by the second hop, and only the write
      // SEQUENCE distinguishes "my carry is still current" from "it was superseded".
      bridge.revokeTabMigration("wf:aaa");
      expect(bridge.resolveActiveTabId()).toBe("wf:ccc");

      // Revoking the hop that actually produced the live selection DOES clear it.
      bridge.revokeTabMigration("tmp:mid");
      expect(() => bridge.resolveActiveTabId()).toThrow(/none is "last active"/);
      sockA.close();
      sockB.close();
    });
  });

  it("follows MIGRATION CHAINS: uuid → tmp: → wf: (the exact #210 field sequence)", async () => {
    // The reported failure re-helloed TWICE: legacy random UUID, then the
    // unsaved-tab tmp:<uuid> id, then the saved wf:<tabRouteId>:<path> id. The ORIGINAL id
    // must still resolve after both hops (single-hop lookup lands on the dead
    // tmp: id) — the map path-compresses so every historical id points at the
    // live tab.
    const sock = await connectPanel();
    autoReply(sock, "chained");
    const uuid = "6eccc826-592e-4abb-b280-35434e00ddd1";
    sock.send(JSON.stringify({ type: "hello", tab_id: uuid, title: "image_flux2_fp8" }));
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));

    sock.send(JSON.stringify({ type: "hello", tab_id: "tmp:7eab1234", title: "image_flux2_fp8" }));
    await waitFor(() => expect(bridge.tabs()[0]?.tab_id).toBe("tmp:7eab1234"));

    sock.send(JSON.stringify({ type: "hello", tab_id: "wf:workf", title: "image_flux2_fp8" }));
    await waitFor(() => expect(bridge.tabs()[0]?.tab_id).toBe("wf:workf"));

    // Every id along the chain resolves to the live tab.
    for (const id of [uuid, "tmp:7eab1234", "wf:workf"]) {
      const r = await bridge.send({ cmd: "ping" }, { tabId: id });
      expect(r).toMatchObject({ from: "chained" });
    }
    sock.close();
  });

  it("retries binding when the port is briefly held, then self-heals", async () => {
    // Simulate a fast /mcp reconnect: a previous session still owns the port
    // when the new bridge starts. It should back off, retry, and bind once the
    // old owner releases the port — without crashing.
    //
    // DETERMINISM: the original version released the port on a 250ms timer,
    // racing the bridge's FINITE retry schedule (5 attempts / ~6.2s total)
    // against the assertion deadline — under heavy machine load the clocks
    // skew and the test flakes. Instead: start the bridge while the port is
    // held (the initial bind reliably EADDRINUSEs), then release the port
    // FULLY (awaited close) before the first retry can fire, so attempt #1
    // deterministically succeeds. Same code path — bind failure → backoff →
    // self-heal — zero timing choreography.
    //
    // #821: the blocker must NOT pick a random port — ~1 in 8 runs that port
    // is already held on the machine, "listening" never fires, and the test
    // hangs to the deadline. Bind on an OS-assigned port (listen(0)) and read
    // back the assigned one. The blocker is the FIXTURE, so its bind must be
    // verifiably complete (and its error a rejected promise, not a silent
    // hang) before the bridge starts: a setup failure must report as a setup
    // failure, not as a timeout in the behaviour under test.
    const blocker = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve, reject) => {
      blocker.on("listening", () => resolve());
      blocker.on("error", reject);
    });
    const blockerAddr = blocker.address();
    if (!blockerAddr || typeof blockerAddr !== "object") {
      throw new Error("fixture setup failed: blocker is listening but reported no address");
    }
    const racePort = blockerAddr.port;

    const reconnecting = new UiBridge(racePort);
    reconnecting.start(); // hits EADDRINUSE, schedules a retry
    // Release the contended port and WAIT for the close to complete — the
    // first retry (≥200ms out) then finds it free no matter how loaded the
    // machine is.
    await new Promise<void>((resolve) => blocker.close(() => resolve()));

    try {
      // Eventually the retried bind succeeds and accepts a panel connection.
      await waitFor(
        () =>
          new Promise<void>((resolve, reject) => {
            const probe = new WebSocket(`ws://127.0.0.1:${racePort}`);
            const done = (err?: Error) => {
              // settle exactly once and drop listeners so a late 'error' from
              // the closing socket can't surface as an unhandled event
              probe.removeAllListeners();
              probe.on("error", () => {});
              probe.close();
              if (err) reject(err);
              else resolve();
            };
            probe.on("open", () => done());
            probe.on("error", (err) => done(err));
          }),
        // generous: must exceed the bridge's full backoff schedule even on a
        // heavily loaded machine (arena runs, docker exports, CI neighbors)
        { timeout: 15000, interval: 150 },
      );
    } finally {
      await reconnecting.stop();
    }
  });
});

// ── Desktop-tab mirror: multi-viewer fanout (mobile remote control) ───────────
function connectHeadless(tabId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    sock.on("open", () => {
      sock.send(JSON.stringify({ type: "hello", tab_id: tabId, title: "phone", headless: true }));
      resolve(sock);
    });
    sock.on("error", reject);
  });
}

function nextFrame(
  sock: WebSocket,
  match: (m: Record<string, unknown>) => boolean,
  timeoutMs = 1500,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      sock.off("message", h);
      reject(new Error("timeout waiting for frame"));
    }, timeoutMs);
    function h(buf: WebSocket.RawData) {
      const m = JSON.parse(buf.toString());
      if (match(m)) {
        clearTimeout(t);
        sock.off("message", h);
        resolve(m);
      }
    }
    sock.on("message", h);
  });
}

/**
 * Let queued bridge work flush before asserting on its effect.
 *
 * #1325 — this was `setTimeout(60)`: a wall-clock guess that 60ms is "enough". It is,
 * on an idle machine. Under a fully parallel suite the event loop is contended and
 * 60ms can elapse with the queued work never scheduled — which is exactly the shape
 * reported, a file that fails under `vitest run` and passes 206/206 in isolation.
 *
 * The wait now SCALES with measured event-loop lag. Note the property that makes this
 * safe to apply to all 31 call sites at once: it is MONOTONE — always at least the old
 * 60ms, more only when the loop is already behind. It therefore cannot change the
 * outcome of a test that passes today; it can only stop a loaded machine from deciding
 * one. (A shorter wait could have masked a real regression; this direction cannot.)
 *
 * WHAT IT DOES AND DOES NOT COVER, measured rather than assumed:
 *
 *   idle                       old 63ms   new 63ms   (no cost added)
 *   in-process loop congestion old 121ms  new 367ms  (adapts — a busy worker)
 *   other PROCESSES burning CPU old 62ms  new 63ms   (does NOT adapt)
 *
 * The last row is the honest limit. Cross-process starvation does not congest THIS
 * loop, so there is nothing local to measure; a wall-clock sleep and the work it waits
 * for are descheduled together. So this is not a proven cure for the reported
 * condition — it removes one real load-sensitivity vector (a busy worker's own queue)
 * without claiming to remove them all.
 */
const settle = async (): Promise<void> => {
  // Lag is measured with setImmediate, NOT setTimeout(0): Windows' timer resolution is
  // ~15.6ms, so a setTimeout(0) probe reports that floor as if it were contention and
  // inflates every one of the 31 waits on an idle machine (measured: 63ms -> 140ms).
  // setImmediate has no such floor — 0ms idle, and it still grows when the loop is busy.
  const t0 = Date.now();
  await new Promise((r) => setImmediate(r));
  const lag = Date.now() - t0; // ~0 idle, tens of ms under a loaded suite
  await new Promise((r) => setTimeout(r, 60 + lag * 4));
  // Drain work those timers queued behind them, which a single sleep never sees.
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

describe("UiBridge — desktop-tab mirror (multi-viewer fanout)", () => {
  it("lists desktop tabs (excluding headless viewers), attaches, and fans push out to primary + viewer", async () => {
    const desktop = await connectPanel("desktop-1", "My Graph");
    const phone = await connectHeadless("phone-1");
    await settle();

    phone.send(JSON.stringify({ type: "list_tabs", cid: "c1" }));
    const list = await nextFrame(phone, (m) => m.type === "tab_list" && m.cid === "c1");
    const tabs = list.tabs as Array<{ tab_id: string; title: string }>;
    expect(tabs.map((t) => t.tab_id)).toContain("desktop-1");
    expect(tabs.find((t) => t.tab_id === "desktop-1")?.title).toBe("My Graph");
    expect(tabs.some((t) => t.tab_id === "phone-1")).toBe(false); // headless not listed

    phone.send(JSON.stringify({ type: "attach_tab", cid: "c2", target_tab_id: "desktop-1" }));
    const att = await nextFrame(phone, (m) => m.type === "tab_attached" && m.cid === "c2");
    expect(att.ok).toBe(true);
    expect(bridge.connected()).toBe(true); // attach did NOT evict the primary

    const onDesktop = nextFrame(desktop, (m) => m.type === "say" && m.text === "hello");
    const onPhone = nextFrame(phone, (m) => m.type === "say" && m.text === "hello");
    bridge.push({ type: "say", text: "hello" }, "desktop-1");
    await Promise.all([onDesktop, onPhone]); // both receive, or the test times out
  });

  it("canvas send() targets the primary only, never a mirror viewer", async () => {
    const desktop = await connectPanel("desktop-2", "G");
    autoReply(desktop, "desktop");
    const phone = await connectHeadless("phone-2");
    await settle();
    phone.send(JSON.stringify({ type: "attach_tab", cid: "a", target_tab_id: "desktop-2" }));
    await nextFrame(phone, (m) => m.type === "tab_attached");

    let phoneGotCmd = false;
    phone.on("message", (buf) => {
      if (JSON.parse(buf.toString()).cmd) phoneGotCmd = true;
    });
    const res = (await bridge.send({ cmd: "graph_state" } as { cmd: string }, {
      tabId: "desktop-2",
    })) as { from?: string };
    expect(res.from).toBe("desktop");
    await settle();
    expect(phoneGotCmd).toBe(false);
  });

  it("detach_tab stops the fanout", async () => {
    await connectPanel("desktop-3", "G");
    const phone = await connectHeadless("phone-3");
    await settle();
    phone.send(JSON.stringify({ type: "attach_tab", cid: "a", target_tab_id: "desktop-3" }));
    await nextFrame(phone, (m) => m.type === "tab_attached");
    phone.send(JSON.stringify({ type: "detach_tab" }));
    await settle();

    let phoneGotSay = false;
    phone.on("message", (buf) => {
      if (JSON.parse(buf.toString()).type === "say") phoneGotSay = true;
    });
    bridge.push({ type: "say", text: "after-detach" }, "desktop-3");
    await settle();
    expect(phoneGotSay).toBe(false);
  });

  it("never fans out a correlated reply (cid-bearing) to mirror viewers", async () => {
    await connectPanel("desktop-4", "G");
    const phone = await connectHeadless("phone-4");
    await settle();
    phone.send(JSON.stringify({ type: "attach_tab", cid: "a", target_tab_id: "desktop-4" }));
    await nextFrame(phone, (m) => m.type === "tab_attached");

    let phoneGotResult = false;
    phone.on("message", (buf) => {
      if (JSON.parse(buf.toString()).type === "tool_result") phoneGotResult = true;
    });
    // A tool_result for the desktop tab must NOT leak to the mirror viewer.
    bridge.push(
      { type: "tool_result", cid: "x", tool: "get_workflow", ok: true, result: [] },
      "desktop-4",
    );
    await settle();
    expect(phoneGotResult).toBe(false);
  });

  it("mirrors only allowlisted activity frames — never secret/correlated ones (cid-less too)", async () => {
    await connectPanel("desktop-8", "G");
    const phone = await connectHeadless("phone-8");
    await settle();
    phone.send(JSON.stringify({ type: "attach_tab", cid: "a", target_tab_id: "desktop-8" }));
    await nextFrame(phone, (m) => m.type === "tab_attached");

    const leaked: string[] = [];
    phone.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type && m.type !== "tab_attached" && m.type !== "tab_list") leaked.push(m.type);
    });
    // cid-LESS correlated/secret frames that a denylist-by-cid would have leaked.
    bridge.push({ type: "pair_url", url: "https://pair.example/secret" }, "desktop-8");
    bridge.push({ type: "secret_saved", key: "CIVITAI_API_TOKEN" }, "desktop-8");
    bridge.push({ type: "ack", ok: true, kind: "new_session" }, "desktop-8");
    bridge.push({ type: "backends", backends: [] }, "desktop-8");
    // history_list reply to a NO-cid request → cid:undefined, would slip a cid guard.
    bridge.push({ type: "history_list", cid: undefined, sessions: [] }, "desktop-8");
    await settle();
    expect(leaked).toEqual([]); // nothing off the allowlist reached the viewer

    // …but a genuine activity frame still mirrors.
    const onPhone = nextFrame(phone, (m) => m.type === "say" && m.text === "hi");
    bridge.push({ type: "say", text: "hi" }, "desktop-8");
    await onPhone;
  });

  it("routes an attached viewer's input to the mirrored tab's session (remote control)", async () => {
    await connectPanel("desktop-9", "G");
    const phone = await connectHeadless("phone-9");
    await settle();
    const seen: Array<{ type?: string; tab_id?: string; text?: string }> = [];
    bridge.onPanelMessage = (e) => seen.push(e as { type?: string; tab_id?: string; text?: string });

    phone.send(JSON.stringify({ type: "attach_tab", cid: "a", target_tab_id: "desktop-9" }));
    await nextFrame(phone, (m) => m.type === "tab_attached");

    // The phone sends a chat message (no tab_id — the server stamps it). While
    // attached it must drive desktop-9's session, NOT the phone's own tab.
    phone.send(JSON.stringify({ type: "user_message", text: "drive it", context: {} }));
    await settle();
    const drove = seen.find((e) => e.type === "user_message" && e.text === "drive it");
    expect(drove?.tab_id).toBe("desktop-9");

    // After detach, the phone's input reverts to its own tab.
    phone.send(JSON.stringify({ type: "detach_tab" }));
    await settle();
    phone.send(JSON.stringify({ type: "user_message", text: "my own", context: {} }));
    await settle();
    const own = seen.find((e) => e.type === "user_message" && e.text === "my own");
    expect(own?.tab_id).toBe("phone-9");
  });

  it("rejects attach to a non-existent desktop tab", async () => {
    const phone = await connectHeadless("phone-5");
    await settle();
    phone.send(JSON.stringify({ type: "attach_tab", cid: "a", target_tab_id: "ghost" }));
    const att = await nextFrame(phone, (m) => m.type === "tab_attached");
    expect(att.ok).toBe(false);
  });

  it("keeps mirroring across a same-socket tab-id migration", async () => {
    const desktop = await connectPanel("old-id", "G");
    const phone = await connectHeadless("phone-6");
    await settle();
    phone.send(JSON.stringify({ type: "attach_tab", cid: "a", target_tab_id: "old-id" }));
    await nextFrame(phone, (m) => m.type === "tab_attached");

    // Desktop re-hellos under a NEW id on the SAME socket (the migration path).
    desktop.send(JSON.stringify({ type: "hello", tab_id: "new-id", title: "G" }));
    await settle();

    // The real scenario: the tab's AGENT keeps pushing under the ORIGINAL id
    // ("old-id") after the migration — the fan-out must resolve that through the
    // migration map to the moved subscriber set (keyed under the canonical id).
    // Pushing under the new id would mask the bug (codex review).
    const onPhone = nextFrame(phone, (m) => m.type === "say" && m.text === "post-migrate");
    bridge.push({ type: "say", text: "post-migrate" }, "old-id");
    await onPhone; // resolves, or the test times out (fan-out broke)
  });

  it("DETACHES a mirror viewer on an UNPROVEN same-socket workflow switch (#570 P0)", async () => {
    // A phone mirrors workflow A (old-id). The desktop switches to a DIFFERENT workflow on
    // the SAME socket (new-id) — the hello handler optimistically moves the phone's
    // subscription onto new-id BEFORE continuity is known. When the orchestrator classifies
    // the switch as UNPROVEN it resets the tab via dropQueuedDeliveries (with the retired id
    // AND the surviving id) — the phone must then receive NONE of workflow B's frames and its
    // input must NOT target B: it silently followed A→B without ever attaching to B.
    const desktop = await connectPanel("old-id", "G");
    const phone = await connectHeadless("phone-7");
    await settle();
    const seen: Array<{ type?: string; tab_id?: string; text?: string }> = [];
    bridge.onPanelMessage = (e) => seen.push(e as { type?: string; tab_id?: string; text?: string });
    phone.send(JSON.stringify({ type: "attach_tab", cid: "a", target_tab_id: "old-id" }));
    await nextFrame(phone, (m) => m.type === "tab_attached");

    // Same-socket switch to a DIFFERENT workflow (subscription moves to new-id at hello).
    desktop.send(JSON.stringify({ type: "hello", tab_id: "new-id", title: "B" }));
    await settle();

    // The orchestrator classified the switch as UNPROVEN and revokes the migration. This is
    // the retire branch's SOLE call for the OLD id — it does NOT also sweep new-id (when B
    // owns its own session, provenOwn is true and the destination sweep is skipped). The
    // mirror detach must therefore ride revokeTabMigration itself (#570 P0a), NOT a manual
    // destination sweep.
    bridge.revokeTabMigration("old-id");

    // Workflow B's activity must NOT reach the phone anymore.
    let leaked = false;
    phone.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type === "say" && m.text === "workflow-B-secret") leaked = true;
    });
    bridge.push({ type: "say", text: "workflow-B-secret" }, "new-id");
    bridge.push({ type: "say", text: "workflow-B-secret" }, "old-id"); // via migration alias too
    await settle();
    expect(leaked).toBe(false);

    // The phone's input reverts to its OWN tab — it no longer drives workflow B.
    phone.send(JSON.stringify({ type: "user_message", text: "still mine", context: {} }));
    await settle();
    const drove = seen.find((e) => e.type === "user_message" && e.text === "still mine");
    expect(drove?.tab_id).toBe("phone-7");
  });

  it("STAMPS a dispatched command with the ORIGIN workflow uuid — and after a switch the divergence is REFUSED pre-dispatch (#570 P0, #1656)", async () => {
    // The orchestrator maps each tab to its trusted per-instance workflow uuid.
    const uuidByTab: Record<string, string> = { "tmp:A": "uuid-A", "tmp:B": "uuid-B" };
    bridge.setTabWorkflowUuidResolver((tabId) => uuidByTab[tabId]);

    const desktop = await connectPanel("tmp:A", "A");
    const frames: Array<Record<string, unknown>> = [];
    desktop.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.rid && m.cmd) {
        frames.push(m);
        // Reply so send() resolves.
        desktop.send(JSON.stringify({ rid: m.rid, ok: true, result: {} }));
      }
    });
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tmp:A")).toBe(true));

    // A command issued for workflow A carries A's uuid.
    await bridge.send({ cmd: "graph_add_node", node: "x" } as never, { tabId: "tmp:A" });
    await waitFor(() => expect(frames.find((f) => f.cmd === "graph_add_node")).toBeTruthy());
    expect(frames.find((f) => f.cmd === "graph_add_node")?.workflow_uuid).toBe("uuid-A");

    // Same socket switches to workflow B (migration alias tmp:A → tmp:B).
    desktop.send(JSON.stringify({ type: "hello", tab_id: "tmp:B", title: "B", enforces_workflow_stamp: true, enforces_workflow_stamp_at_write: true }));
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tmp:B")).toBe(true));

    // A late command still ISSUED FOR A (its agent's tab id) must never land on B's
    // canvas. Before #1656 the bridge delivered it stamped uuid-A — even though it
    // resolved onto B's socket — and relied on the panel (showing B) to decline;
    // stamping B's uuid would have let it cross-apply. The guarantee is unchanged
    // (no cross-apply, ever) but the refusal moved EARLIER: the bridge can see that
    // the stamp it would attach (uuid-A) and the identity the routed tab now
    // advertises (uuid-B) disagree, so it refuses BEFORE the socket write — the
    // panel's live-identity read no longer has to have settled for the mutation to
    // be fenced.
    frames.length = 0;
    const err = await bridge
      .send({ cmd: "graph_add_node", node: "y" } as never, { tabId: "tmp:A" })
      .then(
        () => null,
        (e) => e as Error,
      );
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/^workflow instance mismatch:/);
    expect(err!.message).toContain("uuid-A");
    expect(err!.message).toContain("uuid-B");
    expect(dispatchOutcomeOf(err)).toBe(false); // typed: nothing was transmitted
    expect(frames).toEqual([]); // and in fact nothing was — B's canvas never saw it
    desktop.close();
  });

  it("#716 refreshes a later command stamp only through the orchestrator-owned validator", async () => {
    const oldUuid = "11111111-1111-4111-8111-111111111111";
    const liveUuid = "22222222-2222-4222-8222-222222222222";
    const uuidByTab: Record<string, string> = { "wf:reconnected": oldUuid };
    bridge.setTabWorkflowUuidResolver(
      (tabId) => uuidByTab[tabId],
      (tabId, uuid) => {
        if (!/^[0-9a-f]{8}-/i.test(uuid)) return false;
        uuidByTab[tabId] = uuid;
        return true;
      },
    );
    const desktop = await connectPanel("wf:reconnected", "R");
    const frames: Array<Record<string, unknown>> = [];
    desktop.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.rid && m.cmd) {
        frames.push(m);
        desktop.send(JSON.stringify({ rid: m.rid, ok: true, result: {} }));
      }
    });
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "wf:reconnected")).toBe(true));

    await bridge.send({ cmd: "graph_add_node", node: "before-open" } as never, { tabId: "wf:reconnected" });
    expect(frames.at(-1)?.workflow_uuid).toBe(oldUuid);

    // This is what the successful panel_open_workflow / active re-pin path calls.
    expect(bridge.refreshWorkflowUuid("wf:reconnected", liveUuid)).toBe(true);
    await bridge.send({ cmd: "graph_run" } as never, { tabId: "wf:reconnected" });
    expect(frames.at(-1)?.workflow_uuid).toBe(liveUuid);

    // A malformed/late response cannot erase or replace the established stamp.
    expect(bridge.refreshWorkflowUuid("wf:reconnected", "not-a-uuid")).toBe(false);
    await bridge.send({ cmd: "graph_add_node", node: "after-bad-reply" } as never, { tabId: "wf:reconnected" });
    expect(frames.at(-1)?.workflow_uuid).toBe(liveUuid);
    desktop.close();
  });

  it("workflow_uuid is BRIDGE-OWNED: a caller-supplied stamp is OVERRIDDEN by the trusted resolver value (#570 P0c)", async () => {
    // A caller must not be able to forge the stamp to the destination workflow to sail past the
    // panel fence after a switch. dispatch always overwrites workflow_uuid with the resolver value.
    bridge.setTabWorkflowUuidResolver((tabId) => (tabId === "tmp:A" ? "uuid-A" : undefined));
    const desktop = await connectPanel("tmp:A", "A");
    const frames: Array<Record<string, unknown>> = [];
    desktop.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.rid && m.cmd) {
        frames.push(m);
        desktop.send(JSON.stringify({ rid: m.rid, ok: true, result: {} }));
      }
    });
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tmp:A")).toBe(true));
    // Caller tries to smuggle a conflicting workflow_uuid (the would-be destination) in the cmd.
    await bridge.send(
      { cmd: "graph_add_node", node: "x", workflow_uuid: "uuid-FORGED-DESTINATION" } as never,
      { tabId: "tmp:A" },
    );
    await waitFor(() => expect(frames.find((f) => f.cmd === "graph_add_node")).toBeTruthy());
    // The emitted frame carries the TRUSTED origin uuid, not the caller's forged value.
    expect(frames.find((f) => f.cmd === "graph_add_node")?.workflow_uuid).toBe("uuid-A");
    desktop.close();
  });

  it("(d) forwards a caller-supplied retry_of to the wire UNTOUCHED, while rid stays a fresh bridge UUID (#694)", async () => {
    // retry_of is OPAQUE caller data (the caller's explicit retry identity for a
    // mutating command): the bridge must neither stamp over it nor strip it —
    // contrast workflow_uuid above, which is bridge-owned and always overwritten.
    const desktop = await connectPanel("tmp:A", "A");
    const frames: Array<Record<string, unknown>> = [];
    desktop.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.rid && m.cmd) {
        frames.push(m);
        desktop.send(JSON.stringify({ rid: m.rid, ok: true, result: {} }));
      }
    });
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tmp:A")).toBe(true));
    await bridge.send(
      { cmd: "graph_add_node", node: "x", retry_of: "caller-retry-token-1" } as never,
      { tabId: "tmp:A" },
    );
    await waitFor(() => expect(frames.find((f) => f.cmd === "graph_add_node")).toBeTruthy());
    const frame = frames.find((f) => f.cmd === "graph_add_node")!;
    expect(frame.retry_of).toBe("caller-retry-token-1");
    expect(frame.rid).not.toBe("caller-retry-token-1");
    expect(String(frame.rid)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    desktop.close();
  });

  it("(g) never lets a caller-supplied cmd.rid override the bridge-minted rid (#694 hardening)", async () => {
    // `{ rid, ...cmd }` let a caller cmd.rid clobber the minted rid on the wire —
    // silently breaking reply correlation, since `pending` is keyed on the MINTED
    // rid and the panel echoes the WIRE rid back. `{ ...cmd, rid }` makes the
    // bridge-owned rid always win; the send RESOLVING below proves correlation
    // still works (the auto-reply answers the wire rid).
    const desktop = await connectPanel("tmp:A", "A");
    const frames: Array<Record<string, unknown>> = [];
    desktop.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.rid && m.cmd) {
        frames.push(m);
        desktop.send(JSON.stringify({ rid: m.rid, ok: true, result: {} }));
      }
    });
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tmp:A")).toBe(true));
    await expect(
      bridge.send({ cmd: "graph_query", rid: "caller-forged-rid" } as never, {
        tabId: "tmp:A",
        timeoutMs: 5000,
      }),
    ).resolves.toBeTruthy();
    const frame = frames.find((f) => f.cmd === "graph_query")!;
    expect(frame.rid).not.toBe("caller-forged-rid");
    expect(String(frame.rid)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    desktop.close();
  });

  it("REFUSES a mutation when the tab has no trusted workflow identity, even if the panel advertises enforcement (#570 P0c)", async () => {
    // A panel that CLAIMS enforcement but has no resolvable workflow uuid: the frame would ship
    // UNSTAMPED, so the panel's fence has nothing to compare and a stale mutation after a switch
    // would run unfenced. No stamp ⇒ nothing to fence ⇒ refuse the mutation (codex). Reads pass.
    bridge.setTabWorkflowUuidResolver(() => undefined);
    const desktop = await connectPanel("tmp:none", "N"); // connectPanel advertises enforcement
    const frames: Array<Record<string, unknown>> = [];
    desktop.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.rid && m.cmd) {
        frames.push(m);
        desktop.send(JSON.stringify({ rid: m.rid, ok: true, result: {} }));
      }
    });
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tmp:none")).toBe(true));
    await expect(
      bridge.send({ cmd: "graph_add_node", node: "x" } as never, { tabId: "tmp:none" }),
    ).rejects.toThrow(/no trusted identity|cannot be safely targeted/i);
    // A READ still dispatches (unstamped is fine — reads have no side effect).
    await bridge.send({ cmd: "graph_get_state" } as never, { tabId: "tmp:none" });
    await waitFor(() => expect(frames.find((f) => f.cmd === "graph_get_state")).toBeTruthy());
    desktop.close();
  });

  it("REFUSES a mutation on a same-socket switch when the tab has no trusted uuid (no unstamped write to the replacement) (#570 P0c)", async () => {
    // Codex regression: an enforcement-advertising panel with NO valid workflow uuid, then a
    // same-socket workflow switch — a mutating command must NOT be dispatched (it would arrive at
    // the replacement canvas UNSTAMPED, unfenceable).
    bridge.setTabWorkflowUuidResolver(() => undefined);
    const desktop = await connectPanel("tmp:sA", "A");
    desktop.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.rid && m.cmd) desktop.send(JSON.stringify({ rid: m.rid, ok: true, result: {} }));
    });
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tmp:sA")).toBe(true));
    // Same-socket switch to a different workflow.
    desktop.send(JSON.stringify({ type: "hello", tab_id: "tmp:sB", title: "B", enforces_workflow_stamp: true, enforces_workflow_stamp_at_write: true }));
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tmp:sB")).toBe(true));
    // A late command issued for A resolves onto B's socket — with no trusted uuid it is refused,
    // never written unstamped to B.
    await expect(
      bridge.send({ cmd: "graph_add_node", node: "y" } as never, { tabId: "tmp:sA" }),
    ).rejects.toThrow(/no trusted identity|cannot be safely targeted/i);
    desktop.close();
  });

  it("reports graph-mutation capability from the same enforcement and stamp conditions as dispatch (#709)", async () => {
    const desktop = await connectPanel("tmp:capable", "capable");
    await waitFor(() => expect(bridge.tabCanMutateGraph("tmp:capable")).toBe(true));

    // A same-tab re-hello from a stale browser bundle resets capability. It must not
    // inherit the prior modern hello, because dispatch will refuse the unfenced write.
    desktop.send(JSON.stringify({ type: "hello", tab_id: "tmp:capable", title: "stale" }));
    await waitFor(() => expect(bridge.tabCanMutateGraph("tmp:capable")).toBe(false));

    // Enforcement without a trusted stamp is still not graph-mutation-ready.
    bridge.setTabWorkflowUuidResolver(() => undefined);
    desktop.send(
      JSON.stringify({
        type: "hello",
        tab_id: "tmp:capable",
        title: "no-stamp",
        enforces_workflow_stamp: true,
        enforces_workflow_stamp_at_write: true,
      }),
    );
    await waitFor(() => expect(bridge.tabCanMutateGraph("tmp:capable")).toBe(false));
    desktop.close();
  });

  it("does not report graph-mutation capability after the panel socket closes (#709)", async () => {
    const desktop = await connectPanel("tmp:closing", "closing");
    await waitFor(() => expect(bridge.tabCanMutateGraph("tmp:closing")).toBe(true));

    // Wait for the server-side connection to observe the close; neither readiness
    // accessor may retain capability or a generation after its socket is gone.
    desktop.close();
    await waitFor(() => expect(bridge.tabCanMutateGraph("tmp:closing")).toBe(false));
    expect(bridge.tabConnectionGeneration("tmp:closing")).toBeUndefined();
  });

  it("keeps the browser-tab session identity per hello rather than inheriting it across a workflow-id takeover (#709)", async () => {
    const original = await connectPanel("wf:shared.json", "shared");
    original.send(
      JSON.stringify({
        type: "hello",
        tab_id: "wf:shared.json",
        title: "shared",
        enforces_workflow_stamp: true,
        enforces_workflow_stamp_at_write: true,
        tab_session_id: "browser-tab-original",
      }),
    );
    await waitFor(() =>
      expect(bridge.tabConnectionIdentity("wf:shared.json")).toMatchObject({ tabSessionId: "browser-tab-original" }),
    );
    const before = bridge.tabConnectionIdentity("wf:shared.json");

    const replacement = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      replacement.on("open", () => {
        replacement.send(
          JSON.stringify({
            type: "hello",
            tab_id: "wf:shared.json",
            title: "same saved workflow, different browser tab",
            enforces_workflow_stamp: true,
            enforces_workflow_stamp_at_write: true,
            tab_session_id: "browser-tab-other",
          }),
        );
        resolve();
      });
      replacement.on("error", reject);
    });
    await waitFor(() =>
      expect(bridge.tabConnectionIdentity("wf:shared.json")).toMatchObject({ tabSessionId: "browser-tab-other" }),
    );
    const after = bridge.tabConnectionIdentity("wf:shared.json");
    expect(after?.generation).toBeGreaterThan(before?.generation ?? Number.MAX_SAFE_INTEGER);
    replacement.close();
  });

  it("FAILS CLOSED: a MUTATING graph command is refused for an OLD panel that doesn't enforce the stamp; reads still work (#570 P0c)", async () => {
    // An OLD panel hellos WITHOUT enforces_workflow_stamp — it would silently ignore the
    // per-command workflow stamp and could apply a stale write to the wrong canvas.
    const old = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => {
      old.on("open", () => {
        old.send(JSON.stringify({ type: "hello", tab_id: "tmp:old", title: "old" })); // no flag
        res();
      });
      old.on("error", rej);
    });
    // Auto-reply so a NON-gated command could resolve (proving the gate, not a hang).
    old.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.rid && m.cmd) old.send(JSON.stringify({ rid: m.rid, ok: true, result: {} }));
    });
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tmp:old")).toBe(true));

    // A mutating graph command is refused BEFORE dispatch (never written to the socket).
    await expect(
      bridge.send({ cmd: "graph_add_node", node: "x" } as never, { tabId: "tmp:old" }),
    ).rejects.toThrow(/enforce.*workflow targeting|install_comfyui\(action:'panel', panel_action:'update'\)/i);

    // …but a READ-ONLY graph command still works (read-only graph access retained).
    await expect(
      bridge.send({ cmd: "graph_get_state" } as never, { tabId: "tmp:old" }),
    ).resolves.toBeTruthy();

    // A path-less ACTIVE-workflow mutator (workflow_close discards unsaved work) is ALSO
    // refused — the class the graph_-only gate previously missed (#570 P0c, codex cycle 8).
    await expect(
      bridge.send({ cmd: "workflow_close", force: true } as never, { tabId: "tmp:old" }),
    ).rejects.toThrow(/enforce.*workflow targeting|install_comfyui\(action:'panel', panel_action:'update'\)/i);

    // ALL FOUR workflow mutators are refused on a non-enforcing panel — regardless of path,
    // including an EXPLICIT non-empty path. The server can't resolve the selector or prove it
    // stays non-active (an in-place replacement can make a once-non-active path resolve to the
    // active workflow), so it fails closed; an ENFORCING panel resolves the target client-side.
    for (const cmd of [
      { cmd: "workflow_close", path: "", force: true },
      { cmd: "workflow_rename", path: "  ", name: "x" },
      { cmd: "workflow_save" },
      { cmd: "workflow_save_as", name: "y" },
      { cmd: "workflow_close", path: "workflows/other.json", force: true }, // explicit path — still gated
    ]) {
      await expect(bridge.send(cmd as never, { tabId: "tmp:old" })).rejects.toThrow(
        /enforce.*workflow targeting|install_comfyui\(action:'panel', panel_action:'update'\)/i,
      );
    }
    old.close();
  });

  it("names the versioned panel-sync remedy when stamp enforcement is absent (#706)", async () => {
    // The remedy names install_comfyui(action:'panel') ONLY when a local ComfyUI install is
    // resolvable from here. That used to come from the developer's REAL
    // machine state (COMFYUI_PATH in the real ~/.comfyui-mcp/.env), so the
    // test failed on any machine without one — and under the suite-wide home
    // redirect (#879/#866), which hides that ambient config on purpose.
    // Prime the resolution the assertion actually depends on: a resolved
    // local base, no disk observation (cleared by this file's afterEach).
    const base = mkdtempSync(join(tmpdir(), "cmcp-bridge-base-"));
    tempRoots.push(base);
    __setPanelBaseForTests(base);
    const old = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => {
      old.on("open", () => {
        old.send(JSON.stringify({ type: "hello", tab_id: "old-skew", title: "wf", panel_version: "0.11.0" }));
        res();
      });
      old.on("error", rej);
    });
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "old-skew")).toBe(true));
    await expect(
      bridge.send({ cmd: "graph_add_node", node: "x" } as never, { tabId: "old-skew" }),
    ).rejects.toThrow(/reports panel 0\.11\.0.*needs panel 0\.11\.35\+.*install_comfyui\(action:'panel', panel_action:'update'\).*restart ComfyUI.*rebinding cannot/i);
    old.close();
  });

  it("names the stale TAB, not the install, when the pack on disk already clears the floor", async () => {
    // The unfixable-loop shape. The panel's module URLs carry no cache-busting
    // key and the capability is advertised from the single file that also builds
    // `hello`, so a tab holding the pre-0.11.35 copy announces the old
    // capability set while the pack ON DISK is current. Telling that user to run
    // install_comfyui(action:'panel') is what closed the loop: it correctly reports nothing to do.
    // The orchestrator runs the panel sync on this same hello, so the on-disk
    // version is observed alongside the handshake — enough to name it.
    // A REAL pack on disk: the skew resolver re-reads the pyproject at the
    // moment of use rather than trusting the recorded version, so a fabricated
    // path would (correctly) prove nothing.
    writeTempPanelPack("0.11.38");
    try {
      const stale = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((res, rej) => {
        stale.on("open", () => {
          stale.send(
            JSON.stringify({ type: "hello", tab_id: "stale-bundle", title: "wf", panel_version: "0.11.34" }),
          );
          res();
        });
        stale.on("error", rej);
      });
      await waitFor(() =>
        expect(bridge.tabs().some((t) => t.tab_id === "stale-bundle")).toBe(true),
      );
      const err = await bridge
        .send({ cmd: "graph_add_node", node: "x" } as never, { tabId: "stale-bundle" })
        .catch((e: Error) => e);
      expect((err as Error).message).toMatch(/Do NOT update the panel/);
      expect((err as Error).message).toMatch(/HARD-REFRESH/);
      expect((err as Error).message).toMatch(/0\.11\.38/);
      // It must NOT send them back to the tool that will report nothing to do.
      expect((err as Error).message).not.toMatch(/Run install_comfyui\(action:'panel', panel_action:'update'\)/);
      // …and it must not claim the update would report nothing to do: since #806
      // an update CAN pull a newer panel. What it cannot do is replace the JS an
      // open tab is running, which is what this branch is actually about.
      expect((err as Error).message).not.toMatch(/report nothing to do/);
      expect((err as Error).message).toMatch(/no update replaces the JavaScript an open tab/);
      // READ AS A HUMAN WOULD: the recovery is concatenated into a wrapper that
      // appends its own sentence break, and a trailing period here rendered
      // "the install is not the problem.. Reads and view-only commands…"
      // (codex gate). Anchored on a word character so the legitimate "../" in
      // the host-side commands cannot false-positive.
      expect((err as Error).message).not.toMatch(/[A-Za-z)"']\.\./);
      // The gate itself still refused the write — the diagnosis changed, not the gate.
      expect(isCapabilityRefusal(err as Error)).toBe(true);
      stale.close();
    } finally {
      clearPanelDiskObservation();
    }
  });

  // #973 — the third state, and the one the reporter landed in. The skew check
  // proves a stale bundle only when it can READ the pack's on-disk version; when
  // it cannot, it proved nothing — and the fall-through led with
  // "Run install_comfyui(action:'panel', panel_action:'update')" anyway. The reporter followed that, found their
  // pack was already at origin/main HEAD running 0.11.41, and had spent a round
  // trip on an update that could not have helped.
  it("an UNREADABLE disk version leads with the two free checks, not with an update", async () => {
    // No pack on disk at all → verifiedPanelDiskVersion() answers nothing, which
    // is exactly the state that used to be indistinguishable from "behind".
    clearPanelDiskObservation();
    const unknown = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => {
      unknown.on("open", () => {
        unknown.send(JSON.stringify({ type: "hello", tab_id: "disk-unknown", title: "wf" }));
        res();
      });
      unknown.on("error", rej);
    });
    await waitFor(() =>
      expect(bridge.tabs().some((t) => t.tab_id === "disk-unknown")).toBe(true),
    );
    const err = await bridge
      .send({ cmd: "graph_add_node", node: "x" } as never, { tabId: "disk-unknown" })
      .catch((e: Error) => e);
    const msg = (err as Error).message;

    // It must SAY it could not check, rather than implying an answer.
    expect(msg).toMatch(/UNCONFIRMED/);
    expect(msg).toMatch(/could not be read just now/);
    // …and the two costless checks must come before the remedy that has a cost.
    //
    // #1208 — this compared two `search()` indices WITHOUT asserting either term
    // was present, so an absent term (-1) made the comparison meaningless and the
    // test failed intermittently. The remedy has TWO wordings depending on
    // `installPanelUsable`: "install_comfyui(action:'panel', panel_action:'update')"
    // when this surface can drive the update, and "Update the panel ON THE
    // COMFYUI HOST" when it cannot. Only the first contains `panel_action:'update'`,
    // so on the other branch the index was -1 and `694 < -1` failed — an
    // environmental difference, not a regression.
    //
    // Assert presence FIRST, and anchor on a pattern that covers both branches.
    const retryAt = msg.search(/RETRY this command/);
    const remedyAt = msg.search(/panel_action:'update'|Update the panel ON THE COMFYUI HOST/);
    expect(retryAt, "the free RETRY check must be present").toBeGreaterThan(-1);
    expect(remedyAt, "an update remedy must be present in either wording").toBeGreaterThan(-1);
    expect(retryAt).toBeLessThan(remedyAt);
    expect(msg.search(/HARD-REFRESH/)).toBeLessThan(msg.search(/panel_action:'update'/));
    // The update is DEMOTED, not deleted — it is still right when the install
    // really is behind, and this branch cannot rule that out either.
    expect(msg).toMatch(/If it is genuinely behind/);
    expect(msg).toMatch(/panel_action:'update'/);
    // The gate itself is unchanged: the write is still refused.
    expect(isCapabilityRefusal(err as Error)).toBe(true);
    unknown.close();
  });

  it("an install that is genuinely BEHIND still gets the update remedy, never a refresh", async () => {
    // The guard on the branch above: a stale-install user must not be told their
    // install is fine. Only a disk version at or above the floor earns the
    // refresh diagnosis.
    writeTempPanelPack("0.11.20");
    try {
      const behind = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((res, rej) => {
        behind.on("open", () => {
          behind.send(
            JSON.stringify({ type: "hello", tab_id: "really-old", title: "wf", panel_version: "0.11.20" }),
          );
          res();
        });
        behind.on("error", rej);
      });
      await waitFor(() =>
        expect(bridge.tabs().some((t) => t.tab_id === "really-old")).toBe(true),
      );
      const err = await bridge
        .send({ cmd: "graph_add_node", node: "x" } as never, { tabId: "really-old" })
        .catch((e: Error) => e);
      expect((err as Error).message).not.toMatch(/Do NOT update the panel/);
      expect((err as Error).message).toMatch(/install_comfyui\(action:'panel', panel_action:'update'\)|ON THE COMFYUI HOST/);
      behind.close();
    } finally {
      clearPanelDiskObservation();
    }
  });

  it("the stale-bundle proof uses the FENCE's floor, not the aggregate requirement", async () => {
    // codex gate. resolveStaleBundleSkew answers "is the INSTALL sufficient for
    // the write that was just refused?" — a fence question. Answering it with
    // requiredPanelVersion(), the max across every command and capability this
    // build knows, denies the positive proof for an install that IS sufficient
    // the moment anything unrelated raises the aggregate, and sends a user whose
    // only problem is a cached tab off to update.
    const table = BRIDGE_CAPABILITY_MIN_PANEL_VERSION as Record<string, string | undefined>;
    writeTempPanelPack("0.11.35"); // exactly the fence floor, well under the aggregate below
    table.some_unrelated_future_capability = "9.9.9";
    try {
      const stale = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((res, rej) => {
        stale.on("open", () => {
          stale.send(
            JSON.stringify({ type: "hello", tab_id: "fence-floor", title: "wf", panel_version: "0.11.34" }),
          );
          res();
        });
        stale.on("error", rej);
      });
      await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "fence-floor")).toBe(true));
      const err = await bridge
        .send({ cmd: "graph_add_node", node: "x" } as never, { tabId: "fence-floor" })
        .catch((e: Error) => e);
      expect((err as Error).message).toMatch(/Do NOT update the panel/);
      expect((err as Error).message).toMatch(/already 0\.11\.35/);
      stale.close();
    } finally {
      delete table.some_unrelated_future_capability;
      clearPanelDiskObservation();
    }
  });

  it("a CAPABLE disk plus NO advertised version ranks the causes instead of asserting one", async () => {
    // codex gate, and the exact combination the other new tests miss: the pack on
    // disk clears the fence floor AND the hello carried no panel_version. "Your
    // browser tab is running a cached old bundle" is then an inference — a relay
    // or other non-panel client that never implemented the fence looks identical
    // from here, and telling it to hard-refresh a tab it does not have is the
    // dead end this cluster is about.
    writeTempPanelPack("0.11.38");
    try {
      const sock = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((res, rej) => {
        sock.on("open", () => {
          sock.send(JSON.stringify({ type: "hello", tab_id: "no-version-capable", title: "wf" }));
          res();
        });
        sock.on("error", rej);
      });
      await waitFor(() =>
        expect(bridge.tabs().some((t) => t.tab_id === "no-version-capable")).toBe(true),
      );
      const err = await bridge
        .send({ cmd: "graph_add_node", node: "x" } as never, { tabId: "no-version-capable" })
        .catch((e: Error) => e);
      const msg = (err as Error).message;
      // The PROVEN part is still stated plainly, and still spares them the update.
      expect(msg).toMatch(/Updating the panel will not fix this/);
      expect(msg).toMatch(/already 0\.11\.38/);
      expect(msg).not.toMatch(/Run install_comfyui\(action:'panel', panel_action:'update'\)/);
      // The UNPROVEN part is not asserted...
      expect(msg).not.toMatch(/This BROWSER TAB is running an older cached copy/);
      // ...it is ranked, actionable case first, the other named rather than hidden.
      expect(msg).toMatch(/\(1\) It is a ComfyUI browser tab/);
      expect(msg).toMatch(/HARD-REFRESH/);
      expect(msg).toMatch(/\(2\) It is NOT a panel tab/);
      expect(msg).not.toMatch(/[A-Za-z)"']\.\./);
      sock.close();
    } finally {
      clearPanelDiskObservation();
    }
  });

  it("#709: the capability refusal carries the typed marker, the FULL tab id, and the hard-refresh recovery", async () => {
    // The stale-bundle recurrence: on-disk panel current, browser tab still running a
    // cached pre-#570 bundle. The refusal must (a) be typed so the tool layer never
    // appends the futile retry/rebind suffix, (b) name the full routing id — the old
    // slice(0,8) rendering ("wf:workf") was misread as a corrupted identity — and
    // (c) lead with the hard-refresh recovery a bare restart cannot achieve.
    const old = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => {
      old.on("open", () => {
        old.send(
          JSON.stringify({
            type: "hello",
            tab_id: "wf:workflows/portrait.json",
            title: "portrait",
            panel_version: "0.11.20",
          }),
        );
        res();
      });
      old.on("error", rej);
    });
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "wf:workflows/portrait.json")).toBe(true));
    const caught = await bridge
      .send({ cmd: "graph_add_node", node: "x" } as never, { tabId: "wf:workflows/portrait.json" })
      .then(
        () => null,
        (err) => err,
      );
    expect(caught).toBeInstanceOf(Error);
    expect(isCapabilityRefusal(caught)).toBe(true); // typed — the tool layer keys on this
    expect(dispatchOutcomeOf(caught)).toBe(false); // still categorically pre-dispatch
    expect((caught as Error).message).toContain("panel tab wf:workflows/portrait.json"); // full id, not "wf:workf"
    expect((caught as Error).message).toMatch(/hard-refresh the ComfyUI browser tab/);
    expect((caught as Error).message).toMatch(/cached old panel JS/);
    // Non-capability errors are NOT mismarked.
    expect(isCapabilityRefusal(new Error("no connected tab"))).toBe(false);
    expect(isCapabilityRefusal(undefined)).toBe(false);
    old.close();
  });

  it("#709: the NO-IDENTITY refusal is NOT capability-marked — retry/rebind stays the right guidance", async () => {
    // An ENFORCING panel (both stamps advertised) whose workflow identity the
    // orchestrator cannot resolve: a binding/identity problem, NOT a missing panel
    // capability. The refusal must NOT carry the capability marker — marking it
    // would suppress the retry/rebind wrapper, which IS the right recovery here
    // (a rebind re-resolves the identity; nothing needs a panel update).
    const modern = await connectPanel("tmp:enforcing-unresolved", "M");
    await waitFor(() =>
      expect(bridge.tabs().some((t) => t.tab_id === "tmp:enforcing-unresolved")).toBe(true),
    );
    bridge.setTabWorkflowUuidResolver(() => undefined); // no trusted identity to stamp
    const caught = await bridge
      .send({ cmd: "graph_add_node", node: "x" } as never, { tabId: "tmp:enforcing-unresolved" })
      .then(
        () => null,
        (err) => err,
      );
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/no trusted identity/);
    expect(isCapabilityRefusal(caught)).toBe(false); // NOT a capability refusal
    expect(dispatchOutcomeOf(caught)).toBe(false); // still categorically pre-dispatch
    modern.close();
  });

  it("FAILS CLOSED when a panel has only the pre-await stamp fence (#718)", async () => {
    const old = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => {
      old.on("open", () => {
        // 0.11.34 and earlier advertise the original dispatch-time fence, but
        // graph_set_widget can await fresh metadata and write after a user switch.
        old.send(
          JSON.stringify({
            type: "hello",
            tab_id: "tmp:pre-write-fence",
            title: "old widget fence",
            panel_version: "0.11.34",
            enforces_workflow_stamp: true,
          }),
        );
        res();
      });
      old.on("error", rej);
    });
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tmp:pre-write-fence")).toBe(true));
    expect(bridge.tabCanMutateGraph("tmp:pre-write-fence")).toBe(false);
    await expect(
      bridge.send({ cmd: "graph_set_widget", node_id: 7, widget: "steps", value: 30 } as never, {
        tabId: "tmp:pre-write-fence",
      }),
    ).rejects.toThrow(/does not recheck workflow targeting at the graph write boundary.*0\.11\.35.*hard-refresh/i);
    old.close();
  });

  it("ALLOWS active-workflow mutations (graph AND workflow_*) for a panel that DOES enforce the stamp (#570 P0c)", async () => {
    const modern = await connectPanel("tmp:modern", "M"); // connectPanel advertises enforcement + has a resolver stamp
    autoReply(modern, "modern");
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tmp:modern")).toBe(true));
    // A graph mutator AND each workflow mutator all dispatch (enforcement + trusted stamp present).
    for (const cmd of [
      { cmd: "graph_add_node", node: "x" },
      { cmd: "workflow_save" },
      { cmd: "workflow_save_as", name: "y" },
      { cmd: "workflow_close", force: true }, // path-less ⇒ active ⇒ gated, but enforcing panel passes
    ]) {
      await expect(bridge.send(cmd as never, { tabId: "tmp:modern" })).resolves.toMatchObject({
        from: "modern",
      });
    }
    modern.close();
  });

  it("refuses a headless hello takeover of a desktop tab id (no drive-path hijack)", async () => {
    const desktop = await connectPanel("desktop-h", "G");
    autoReply(desktop, "desktop");
    const phone = await connectHeadless("phone-h");
    await settle();

    // Malicious: the phone re-hellos under the DESKTOP's id to seize it without
    // going through attach_tab. This must be refused — the desktop stays primary.
    phone.send(JSON.stringify({ type: "hello", tab_id: "desktop-h", title: "evil", headless: true }));
    await settle();

    const res = (await bridge.send({ cmd: "graph_state" } as { cmd: string }, {
      tabId: "desktop-h",
    })) as { from?: string };
    expect(res.from).toBe("desktop"); // desktop not evicted; the takeover was refused
  });

  it("refuses a hello takeover even when the viewer FORGES headless:false (kind is pinned)", async () => {
    const desktop = await connectPanel("desktop-hf", "G");
    autoReply(desktop, "desktop");
    // The phone's FIRST hello pins it as headless; connectHeadless sends headless:true.
    const phone = await connectHeadless("phone-hf");
    await settle();

    // The bypass: forge headless:false to match the desktop's kind. The pinned
    // socket kind must win, so this is still refused and the desktop stays primary.
    phone.send(JSON.stringify({ type: "hello", tab_id: "desktop-hf", title: "evil", headless: false }));
    await settle();

    const res = (await bridge.send({ cmd: "graph_state" } as { cmd: string }, {
      tabId: "desktop-hf",
    })) as { from?: string };
    expect(res.from).toBe("desktop"); // forged flag ignored — takeover refused
  });

  it("keeps auto-sync eligibility on the current socket's pinned kind (#710 P1)", async () => {
    const phone = await connectHeadless("phone-sync-pinned");
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "phone-sync-pinned")).toBe(true));
    // This is the exact classification the orchestrator must use after each hello.
    expect(bridge.isCurrentHeadless("phone-sync-pinned")).toBe(true);

    // A later hello cannot turn this socket into a desktop install/update target.
    phone.send(JSON.stringify({ type: "hello", tab_id: "phone-sync-pinned", title: "phone" }));
    await settle();
    expect(bridge.isCurrentHeadless("phone-sync-pinned")).toBe(true);
    phone.send(JSON.stringify({ type: "hello", tab_id: "phone-sync-pinned", title: "phone", headless: false }));
    await settle();
    expect(bridge.isCurrentHeadless("phone-sync-pinned")).toBe(true);

    // The old mobile client is gone. A fresh desktop socket may reuse its id;
    // stale headless history must not suppress this desktop's legitimate sync.
    phone.close();
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "phone-sync-pinned")).toBe(false));
    const desktop = await connectPanel("phone-sync-pinned", "G");
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "phone-sync-pinned")).toBe(true));
    expect(bridge.isCurrentHeadless("phone-sync-pinned")).toBe(false);
    expect(bridge.isHeadless("phone-sync-pinned")).toBe(false);

    // A first-hello desktop is likewise a legitimate sync target.
    const separateDesktop = await connectPanel("desktop-sync-eligible", "G");
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "desktop-sync-eligible")).toBe(true));
    expect(bridge.isHeadless("desktop-sync-eligible")).toBe(false);
    desktop.close();
    separateDesktop.close();
  });

  it("re-attaching to another tab stops the first tab's fanout", async () => {
    await connectPanel("desktop-A", "A");
    await connectPanel("desktop-B", "B");
    const phone = await connectHeadless("phone-ab");
    await settle();
    phone.send(JSON.stringify({ type: "attach_tab", cid: "1", target_tab_id: "desktop-A" }));
    await nextFrame(phone, (m) => m.type === "tab_attached" && m.cid === "1");
    phone.send(JSON.stringify({ type: "attach_tab", cid: "2", target_tab_id: "desktop-B" }));
    await nextFrame(phone, (m) => m.type === "tab_attached" && m.cid === "2");

    let gotA = false;
    phone.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.type === "say" && m.text === "from-A") gotA = true;
    });
    bridge.push({ type: "say", text: "from-A" }, "desktop-A"); // old tab — must NOT arrive
    const onB = nextFrame(phone, (m) => m.type === "say" && m.text === "from-B");
    bridge.push({ type: "say", text: "from-B" }, "desktop-B"); // new tab — must arrive
    await onB;
    expect(gotA).toBe(false);
  });

  it("reverts a viewer's drive to its own tab when the mirrored desktop closes", async () => {
    const desktop = await connectPanel("desktop-c", "G");
    const phone = await connectHeadless("phone-c");
    await settle();
    const seen: Array<{ type?: string; tab_id?: string; text?: string }> = [];
    bridge.onPanelMessage = (e) => seen.push(e as { type?: string; tab_id?: string; text?: string });

    phone.send(JSON.stringify({ type: "attach_tab", cid: "a", target_tab_id: "desktop-c" }));
    await nextFrame(phone, (m) => m.type === "tab_attached");

    desktop.close(); // the mirrored desktop goes away
    await settle();

    phone.send(JSON.stringify({ type: "user_message", text: "after-close", context: {} }));
    await settle();
    const msg = seen.find((e) => e.type === "user_message" && e.text === "after-close");
    expect(msg?.tab_id).toBe("phone-c"); // reverted to own tab, not routed into the dead id
  });

  // ---------------------------------------------------------------------------
  // The panel-version-floor cluster (#778 / #819 / #812 / #823).
  //
  // Placed at the END of this describe on purpose: a capability refusal whose
  // on-disk panel version cannot be read kicks off a background primePanelBase()
  // that this file's afterEach cannot await, and a late resolution lands in
  // whichever test is running when it settles. Sitting last, these cannot
  // perturb the stale-bundle tests above, which seed a base synchronously.
  // ---------------------------------------------------------------------------

  it("#778: a non-enforcing panel still gets its READS and view-only commands", async () => {
    // The reported bug and its unreported siblings. Each of these was refused as
    // "a canvas mutation" on any panel below the fence version, purely because it
    // was missing from BRIDGE_READONLY_CMDS — a set about RE-DISPATCH SAFETY, not
    // about what the command does. Assert they are DISPATCHED (the socket saw
    // them), not merely that no error was thrown.
    const old = new WebSocket(`ws://127.0.0.1:${port}`);
    const sawOnSocket: string[] = [];
    await new Promise<void>((res, rej) => {
      old.on("open", () => {
        old.send(JSON.stringify({ type: "hello", tab_id: "tmp:old778", title: "old" })); // no fence flags
        res();
      });
      old.on("error", rej);
    });
    old.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.rid && m.cmd) {
        sawOnSocket.push(m.cmd);
        old.send(JSON.stringify({ rid: m.rid, ok: true, result: {} }));
      }
    });
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tmp:old778")).toBe(true));

    const reads = [
      "graph_find_nodes",
      "graph_list_subgraphs",
      "graph_screenshot",
      "graph_canvas",
      "graph_select_nodes",
      "graph_enter_subgraph",
      "graph_exit_subgraph",
      "graph_copy_nodes",
    ];
    for (const cmd of reads) {
      await expect(bridge.send({ cmd } as never, { tabId: "tmp:old778" })).resolves.toBeTruthy();
    }
    expect(sawOnSocket).toEqual(reads);

    // And the gate is still a gate: the write the same session wanted (#812) is
    // refused, and refused FOR THE STATED REASON — not merely refused.
    await expect(
      bridge.send({ cmd: "graph_set_widget", node_id: 1 } as never, { tabId: "tmp:old778" }),
    ).rejects.toThrow(/does not enforce per-command workflow targeting/i);
    expect(sawOnSocket).toEqual(reads); // nothing extra reached the socket
    old.close();
  });

  it("#819/#823: an unadvertised panel version is reported as unobserved, not as old", async () => {
    const old = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => {
      old.on("open", () => {
        // No panel_version in the hello — exactly #819's "panel version unknown".
        old.send(JSON.stringify({ type: "hello", tab_id: "tmp:noversion", title: "old" }));
        res();
      });
      old.on("error", rej);
    });
    await waitFor(() =>
      expect(bridge.tabs().some((t) => t.tab_id === "tmp:noversion")).toBe(true),
    );
    const err = await bridge
      .send({ cmd: "graph_add_node", node: "x" } as never, { tabId: "tmp:noversion" })
      .then(() => null)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    // The old text read "detected panel version unknown; this MCP requires panel
    // 0.11.35+", which an agent reasonably takes as a verdict that the panel is
    // too old. An absent reading is an absent OBSERVATION: a CURRENT install
    // behind a stale cached browser bundle presents identically.
    expect(msg).not.toMatch(/detected panel version unknown/i);
    expect(msg).toMatch(/advertised NO panel version/);
    expect(msg).toMatch(/age was not observed/);
    expect(msg).toMatch(/equally consistent with an old install/);
    // It still names the version a write needs, and a command that moves them.
    expect(msg).toMatch(/needs panel 0\.11\.35\+/);
    expect(msg).toContain("git clone --depth 1");
    old.close();
  });

  it("#812/#823: the remedy names how to reach install_comfyui(action:'panel') when it is not in the tool list", async () => {
    const old = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => {
      old.on("open", () => {
        old.send(
          JSON.stringify({
            type: "hello",
            tab_id: "tmp:compact",
            title: "w",
            panel_version: "0.11.32",
          }),
        );
        res();
      });
      old.on("error", rej);
    });
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tmp:compact")).toBe(true));
    const err = await bridge
      .send({ cmd: "graph_set_widget", node_id: 1 } as never, { tabId: "tmp:compact" })
      .then(() => null)
      .catch((e: Error) => e);
    const msg = (err as Error).message;
    // #812's reporter searched their tool list for install_comfyui(action:'panel'), found nothing,
    // and concluded the documented recovery was impossible. It was there — behind
    // the compact router, which is the DEFAULT tool mode. Naming the actual call
    // is the difference between a remedy and a dead end.
    expect(msg).toContain(`call_tool {"name": "install_comfyui", "args": {"action": "panel", "panel_action": "update"}}`);
    // The specific version found and the version required, both named.
    expect(msg).toContain("0.11.32");
    expect(msg).toMatch(/needs panel 0\.11\.35\+/);
    old.close();
  });

  it("#819: a version INHERITED across a reconnect is never attributed to this tab", async () => {
    // codex gate. `conn.panelVersion` survives a reconnect whose hello omits the
    // field, so "this tab reports panel 0.11.32" would be a claim about an
    // observation the current handshake never made — the same fabrication the
    // "version unknown" fix removes, arriving by the other door. The earlier
    // reading is still shown (it is real), labelled as earlier and possibly out
    // of date.
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => {
      sock.on("open", () => {
        sock.send(
          JSON.stringify({
            type: "hello",
            tab_id: "tmp:inherit",
            title: "w",
            panel_version: "0.11.32",
          }),
        );
        res();
      });
      sock.on("error", rej);
    });
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tmp:inherit")).toBe(true));

    // Re-hello WITHOUT a panel_version. The connection inherits 0.11.32 for
    // messaging but records panelVersionAdvertised: false.
    sock.send(JSON.stringify({ type: "hello", tab_id: "tmp:inherit", title: "w" }));
    await new Promise((r) => setTimeout(r, 25));

    const err = await bridge
      .send({ cmd: "graph_add_node", node: "x" } as never, { tabId: "tmp:inherit" })
      .then(() => null)
      .catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).not.toContain("this tab reports panel 0.11.32");
    expect(msg).toMatch(/advertised NO panel version in its current handshake/);
    expect(msg).toMatch(/EARLIER connection for this tab reported 0\.11\.32, which may be out of date/);
    expect(msg).toMatch(/age was not observed/);
    sock.close();
  });

  it("a BLANK panel_version is disclosed as unreadable, never rendered as a reported version", async () => {
    // codex gate. `panel_version: "   "` is a non-empty string, so the
    // connection records it as advertised — but it says nothing. Untrimmed, the
    // refusal read "this tab reports panel    " while the skew resolver, which
    // does trim, simultaneously treated the tab as having advertised no version:
    // one message, two readings of one field.
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => {
      sock.on("open", () => {
        sock.send(
          JSON.stringify({ type: "hello", tab_id: "tmp:blankver", title: "w", panel_version: "   " }),
        );
        res();
      });
      sock.on("error", rej);
    });
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tmp:blankver")).toBe(true));
    const err = await bridge
      .send({ cmd: "graph_add_node", node: "x" } as never, { tabId: "tmp:blankver" })
      .then(() => null)
      .catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).not.toMatch(/reports panel\s*[;.)]/); // no empty "reports panel" claim
    expect(msg).not.toMatch(/reports panel {2}/);
    expect(msg).toMatch(/advertised NO panel version/);
    sock.close();
  });

  it.each([
    ["nightly", "a git-installed pack — ComfyUI-Manager's own answer"],
    ["dev", "a local checkout"],
    ["0.11.28.1", "a four-part string that is not SemVer"],
  ])("an UNPARSEABLE panel_version (%s) is shown as evidence, never narrated as a version", async (
    raw,
  ) => {
    // The distinction is PARSEABLE vs NOT, not empty vs non-empty. Trimming
    // caught `"   "`; this catches everything else that is not a version. It is
    // not a corner case — "nightly" is what a git-installed panel reports, so it
    // is the normal reading for anyone running from source.
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => {
      sock.on("open", () => {
        sock.send(
          JSON.stringify({ type: "hello", tab_id: `tmp:unparse-${raw}`, title: "w", panel_version: raw }),
        );
        res();
      });
      sock.on("error", rej);
    });
    await waitFor(() =>
      expect(bridge.tabs().some((t) => t.tab_id === `tmp:unparse-${raw}`)).toBe(true),
    );
    const err = await bridge
      .send({ cmd: "graph_add_node", node: "x" } as never, { tabId: `tmp:unparse-${raw}` })
      .then(() => null)
      .catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).not.toContain(`reports panel ${raw}`); // no version-shaped claim
    expect(msg).toContain(`advertised "${raw}"`); // but the evidence is still shown
    expect(msg).toMatch(/is not a version this MCP can compare/);
    expect(msg).toMatch(/age was not observed/);
    sock.close();
  });

  it("an UNPARSEABLE version with a CAPABLE disk still earns the stale-bundle diagnosis", async () => {
    // The consequence of routing "nightly" to the unreadable path rather than
    // dropping it: a git-install user whose pack on disk already clears the
    // fence floor used to be sent off to update (the skew resolver silently
    // rejected the unparseable value). They now get the honest ranked answer.
    writeTempPanelPack("0.11.38");
    try {
      const sock = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((res, rej) => {
        sock.on("open", () => {
          sock.send(
            JSON.stringify({ type: "hello", tab_id: "nightly-capable", title: "w", panel_version: "nightly" }),
          );
          res();
        });
        sock.on("error", rej);
      });
      await waitFor(() =>
        expect(bridge.tabs().some((t) => t.tab_id === "nightly-capable")).toBe(true),
      );
      const err = await bridge
        .send({ cmd: "graph_add_node", node: "x" } as never, { tabId: "nightly-capable" })
        .catch((e: Error) => e);
      const msg = (err as Error).message;
      expect(msg).toMatch(/Updating the panel will not fix this/);
      expect(msg).toMatch(/already 0\.11\.38/);
      expect(msg).not.toMatch(/Run install_comfyui\(action:'panel', panel_action:'update'\)/);
      // Still no fabricated cause — the causes are ranked, as for no version.
      expect(msg).not.toMatch(/This BROWSER TAB is running an older cached copy/);
      expect(msg).toMatch(/\(1\) It is a ComfyUI browser tab/);
      sock.close();
    } finally {
      clearPanelDiskObservation();
    }
  });

  it("#819: an INHERITED version is not attributed to this tab by the REACTIVE path either", async () => {
    // The provenance screen had been applied to the write-refusal path only. The
    // reactive Unknown-command rewrite built its own view from the same raw
    // field, so a re-hello that omitted panel_version could still produce
    // "detected panel 0.4.5 … too old" about a connection that observed no
    // version at all — the same defect as the fence path, one door over.
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => {
      sock.on("open", () => {
        sock.send(
          JSON.stringify({ type: "hello", tab_id: "tmp:inherit-reactive", title: "w", panel_version: "0.4.5" }),
        );
        res();
      });
      sock.on("error", rej);
    });
    await waitFor(() =>
      expect(bridge.tabs().some((t) => t.tab_id === "tmp:inherit-reactive")).toBe(true),
    );
    // Re-hello WITHOUT a version: 0.4.5 is inherited for messaging only.
    sock.send(JSON.stringify({ type: "hello", tab_id: "tmp:inherit-reactive", title: "w" }));
    await new Promise((r) => setTimeout(r, 25));
    // The panel answers an ALLOWED (inert) command with the dispatcher's own
    // Unknown-command reply — the reactive rewrite path.
    sock.on("message", (buf) => {
      const m = JSON.parse(buf.toString());
      if (m.rid && m.cmd) {
        sock.send(JSON.stringify({ rid: m.rid, ok: false, error: `Unknown command "${m.cmd}"` }));
      }
    });
    const err = await bridge
      .send({ cmd: "graph_outline" } as never, { tabId: "tmp:inherit-reactive" })
      .then(() => null)
      .catch((e: Error) => e);
    const msg = (err as Error).message;
    expect(msg).not.toContain("detected panel 0.4.5");
    expect(msg.toLowerCase()).not.toContain("too old"); // no age verdict from an unobserved version
    expect(msg).toMatch(/does not implement "graph_outline"/);
    expect(msg).toMatch(/this connection advertised no panel version/);
    expect(msg).toMatch(/an earlier connection for this tab reported 0\.4\.5, which may be out of date/);
    sock.close();
  });

  it("an UNCLASSIFIED graph command routed through the bridge is fenced AND recorded", async () => {
    // Layer 3, exercised through the DISPATCH PATH rather than by calling the
    // classifier directly — the gap the independent gate flagged in the earlier
    // evidence. A command with no ledger entry, arriving at the real bridge:
    // it must still fail closed (fenced as a write) AND leave a record, so the
    // fallback is never a silent default however the command got here.
    __resetUnclassifiedGraphCommands();
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => {
      sock.on("open", () => {
        sock.send(JSON.stringify({ type: "hello", tab_id: "tmp:unclassified", title: "w" }));
        res();
      });
      sock.on("error", rej);
    });
    await waitFor(() =>
      expect(bridge.tabs().some((t) => t.tab_id === "tmp:unclassified")).toBe(true),
    );
    const err = await bridge
      .send({ cmd: "graph_brand_new_unclassified" } as never, { tabId: "tmp:unclassified" })
      .then(() => null)
      .catch((e: Error) => e);
    // Fenced, for the stated reason — not merely rejected.
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/does not enforce per-command workflow targeting/i);
    expect(dispatchOutcomeOf(err as Error)).toBe(false); // nothing was written
    // And recorded, so the ledger gap is visible.
    expect([...unclassifiedGraphCommandsSeen()]).toContain("graph_brand_new_unclassified");
    __resetUnclassifiedGraphCommands();
    sock.close();
  });

  it("quotes NO fence version when this build's capability table cannot state one", async () => {
    // codex gate. The refusal is still correct — the panel did not advertise the
    // fence — but the DIAGNOSIS must not invent a number. Falling back to the
    // 0.11.4 bridge baseline would assert "0.11.4, the first build that fences
    // every command", which is false and points at an update that would not
    // clear the gate: #812's loop, rebuilt inside the fix for it.
    const table = BRIDGE_CAPABILITY_MIN_PANEL_VERSION as Record<string, string | undefined>;
    const saved = table.enforces_workflow_stamp_at_write;
    delete table.enforces_workflow_stamp_at_write;
    try {
      const old = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((res, rej) => {
        old.on("open", () => {
          old.send(
            JSON.stringify({ type: "hello", tab_id: "tmp:notable", title: "w", panel_version: "0.11.32" }),
          );
          res();
        });
        old.on("error", rej);
      });
      await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tmp:notable")).toBe(true));
      const err = await bridge
        .send({ cmd: "graph_add_node", node: "x" } as never, { tabId: "tmp:notable" })
        .then(() => null)
        .catch((e: Error) => e);
      const msg = (err as Error).message;
      expect(msg).not.toMatch(/needs panel \d/); // no number, right or wrong
      expect(msg).not.toContain("0.11.4+");
      expect(msg).toMatch(/cannot say which version first shipped it/);
      // Still a refusal, still typed, and still carrying a remedy.
      expect(err).toBeInstanceOf(Error);
      expect(isCapabilityRefusal(err as Error)).toBe(true);
      expect(dispatchOutcomeOf(err as Error)).toBe(false);
      expect(msg).toMatch(/update to the latest panel/);
      old.close();
    } finally {
      table.enforces_workflow_stamp_at_write = saved;
    }
  });
});

describe("markDispatched / dispatchOutcomeOf (typed dispatch outcome — #509 P1)", () => {
  it("carries a TYPED boolean that survives message-text and is undefined otherwise", () => {
    const preWrite = markDispatched(new Error("failed — NOT dispatched (OUTCOME UNKNOWN)"), false);
    const postWrite = markDispatched(new Error("disconnected mid-command — OUTCOME UNKNOWN"), true);
    expect(dispatchOutcomeOf(preWrite)).toBe(false); // categorically NOT-dispatched
    expect(dispatchOutcomeOf(postWrite)).toBe(true); // authoritative accepted drop
    // Plain errors / non-errors carry no signal.
    expect(dispatchOutcomeOf(new Error("disconnected mid-command"))).toBeUndefined();
    expect(dispatchOutcomeOf(undefined)).toBeUndefined();
    expect(dispatchOutcomeOf("OUTCOME UNKNOWN")).toBeUndefined();
    // The flag is non-enumerable (doesn't pollute JSON / spreads).
    expect(Object.keys(preWrite)).not.toContain("dispatched");
  });
});

describe("tabServerOrigin (server-observed handshake Origin — #509 spoof gate)", () => {
  const connectWithOrigin = (tabId: string, origin?: string, comfyuiUrl?: string): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : undefined);
      sock.on("open", () => {
        sock.send(
          JSON.stringify({ type: "hello", tab_id: tabId, title: "wf", comfyui_url: comfyuiUrl }),
        );
        resolve(sock);
      });
      sock.on("error", reject);
    });

  it("reflects the browser handshake Origin, NOT the client-supplied comfyui_url", async () => {
    // The hello CLAIMS a different comfyui_url than the real handshake Origin. The trusted
    // server-observed value must be the handshake Origin; the claim only shows in tabOrigin.
    const s = await connectWithOrigin("tab-origin-1", "http://127.0.0.1:8188", "http://evil.example:1");
    await waitFor(() => expect(bridge.canReach("tab-origin-1")).toBe(true));
    expect(bridge.tabServerOrigin("tab-origin-1")).toBe("http://127.0.0.1:8188");
    expect(bridge.tabOrigin("tab-origin-1")).toBe("http://evil.example:1"); // spoofable claim
    s.close();
  });

  it("is undefined when the handshake carried no Origin (non-browser client)", async () => {
    const s = await connectWithOrigin("tab-origin-2", undefined, "http://127.0.0.1:8188");
    await waitFor(() => expect(bridge.canReach("tab-origin-2")).toBe(true));
    expect(bridge.tabServerOrigin("tab-origin-2")).toBeUndefined();
    expect(bridge.tabServerOrigin("nope")).toBeUndefined();
    s.close();
  });

  it("normalizes to scheme://host:port — any path is stripped (Origin carries none)", async () => {
    // Even if a client sends a path-bearing value, the stored origin is authority-only, so
    // a path-mounted boot base is fail-closed (never falsely matched) downstream.
    const s = await connectWithOrigin("tab-origin-3", "http://127.0.0.1:8188/comfy");
    await waitFor(() => expect(bridge.canReach("tab-origin-3")).toBe(true));
    expect(bridge.tabServerOrigin("tab-origin-3")).toBe("http://127.0.0.1:8188");
    s.close();
  });
});

describe("defaultBridgeTimeoutMs — tolerant read timeout (#357)", () => {
  it("gives READ (idempotent) ops the tolerant default, mutating ops the tight one", () => {
    // Every readonly command gets the tolerant bound…
    for (const readCmd of BRIDGE_READONLY_CMDS) {
      expect(defaultBridgeTimeoutMs(readCmd)).toBe(BRIDGE_READ_DEFAULT_TIMEOUT_MS);
    }
    // …and anything else (a render/edit) keeps the tight default.
    for (const mutateCmd of ["graph_run", "graph_add_node", "graph_move_node", "workflow_save"]) {
      expect(defaultBridgeTimeoutMs(mutateCmd)).toBe(BRIDGE_DEFAULT_TIMEOUT_MS);
    }
  });

  it("covers the OTHER main-thread graph reads that share the FBX-busy hazard (#357)", () => {
    // These run on the same busy panel main thread as graph_query and are
    // dispatched with no explicit timeout — they must be tolerant too.
    for (const readCmd of [
      "graph_view_selected",
      "graph_view_nodes_in_viewport",
      "graph_get_state",
      "graph_get_subgraph",
      "graph_outline",
    ]) {
      expect(BRIDGE_READONLY_CMDS.has(readCmd)).toBe(true);
      expect(defaultBridgeTimeoutMs(readCmd)).toBe(BRIDGE_READ_DEFAULT_TIMEOUT_MS);
    }
  });

  it("classifies refresh_nodes as a READ so it is parked/resumed on reconnect and gets the tolerant default (#608)", () => {
    // refresh_nodes only re-registers node defs + rebuilds combos (idempotent, no
    // graph mutation). It MUST be a read so a mid-command socket drop parks and
    // resumes it (not OUTCOME-UNKNOWN, which the orchestrator won't retry) and so a
    // slow /object_info fetch on a large install isn't cut off at the tight 6s.
    expect(BRIDGE_READONLY_CMDS.has("refresh_nodes")).toBe(true);
    expect(defaultBridgeTimeoutMs("refresh_nodes")).toBe(BRIDGE_READ_DEFAULT_TIMEOUT_MS);
  });

  it("graph_query is tolerant and STRICTLY longer than the old flat 6s default (#357)", () => {
    // The regression: graph_query used the flat 6000ms default and timed out while
    // Preview3D loaded a large FBX on a busy-but-alive main thread.
    expect(defaultBridgeTimeoutMs("graph_query")).toBe(20_000);
    expect(defaultBridgeTimeoutMs("graph_query")).toBeGreaterThan(6000);
  });

  it("a WRITE is never abandoned sooner than a read (#694)", () => {
    // This inverts what #574 left in place, and the inversion is the point.
    //
    // A read abandoned too early costs a retry. A write abandoned too early is
    // unrecoverable ambiguity: it was already delivered so it may have applied,
    // the bridge refuses to auto-retry it (#334), and the caller must go verify by
    // hand. The cheap failure had the patience and the expensive one had the hair
    // trigger — a reporter's panel_set_node_mode timed out at 6s on a live tab
    // that had already applied it.
    //
    // Asserted as an INVARIANT rather than a number so re-tightening writes fails
    // here no matter which constant someone edits.
    for (const write of ["graph_run", "graph_add_node", "graph_set_node_mode", "workflow_save"]) {
      expect(BRIDGE_READONLY_CMDS.has(write)).toBe(false);
      expect(defaultBridgeTimeoutMs(write)).toBeGreaterThanOrEqual(
        defaultBridgeTimeoutMs("graph_query"),
      );
      // And still past the old flat cutoff that produced the false unknowns.
      expect(defaultBridgeTimeoutMs(write)).toBeGreaterThan(6000);
    }
  });

  it("a no-timeout READ stays alive PAST the old 6s cutoff (end-to-end) (#357)", async () => {
    const a = await connectPanel("tab-aaaa-1111"); // never auto-replies
    // Bounded under this test's 12s budget, for the reason given at the #450 test above.
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1), { timeout: 3000 });
    // #1325 — this test used to record only a BOOLEAN and discard the reason, so a
    // failure read `expected true to be false` and named nothing. It was reported as
    // load-sensitive, and the arithmetic says a slow machine alone cannot be the whole
    // story: the read default is 20s and this test's budget is 12s, so the deadline
    // UNDER TEST cannot be reached inside it. If this read settles, something else
    // rejected it, and that reason is the only thing worth having.
    let outcome: "resolved" | "rejected" | null = null;
    let reason: unknown;
    // No explicit timeout → send() applies the tolerant read default (20s). Swallow
    // the eventual late rejection so it never surfaces as an unhandled rejection
    // (the bridge is torn down in afterEach; the pending read settles then).
    void bridge.send({ cmd: "graph_query" }).then(
      () => { outcome = "resolved"; },
      (err) => { outcome = "rejected"; reason = err; },
    );
    // Wait comfortably past the OLD 6000ms default: before the fix this would have
    // already rejected; after it, the read is still in-flight.
    const SLEEP_MS = 6500;
    const startedAt = Date.now();
    await new Promise((r) => setTimeout(r, SLEEP_MS));
    const elapsed = Date.now() - startedAt;

    // Report the two confounds instead of asserting through them. A stall past the
    // real deadline means this run measured the MACHINE, not the code — and that is
    // the one thing a bare `toBe(false)` could never say.
    //
    // `deadline >= SLEEP_MS` is what separates the two. If the deadline is BELOW this
    // sleep, reaching it is the regression this test exists to catch, not a stall —
    // without that clause a genuine regression would be reported as a slow machine,
    // which is precisely the misdiagnosis #1325 is about. (Verified by lowering the
    // constant to 6s: it must read as a regression, not as scheduling.)
    const deadline = BRIDGE_READ_DEFAULT_TIMEOUT_MS;
    const stalled = elapsed >= deadline && deadline >= SLEEP_MS;
    const detail =
      outcome === null
        ? "still in flight"
        : `${outcome} after ${elapsed}ms` +
          (stalled ? ` — THE MACHINE STALLED past the ${deadline}ms read deadline, so this run cannot tell a regression from scheduling` : "") +
          (outcome === "rejected" ? `: ${reason instanceof Error ? reason.message : String(reason)}` : "");
    expect(detail).toBe("still in flight");
    a.close();
  }, 12000);

  it("an explicit timeout always overrides the read default", async () => {
    const a = await connectPanel("tab-aaaa-1111"); // never replies
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    await expect(bridge.send({ cmd: "graph_query" }, { timeoutMs: 120 })).rejects.toThrow(
      /did not reply to "graph_query" within 120 ms/,
    );
    a.close();
  });

  // #803 — the no-reply timeout named `conn.tabId.slice(0, 8)`. Routing ids are
  // `wf:<path>`, so EVERY workflow tab rendered as the identical, alarming
  // `wf:workf`: two tabs timing out were indistinguishable in a transcript and
  // the id read like a corrupted routing key (it sent one diagnosis down a wrong
  // path outright). Evidence must not be destroyed before it can be reported.
  it("names the FULL routing tab id in a no-reply timeout, not an 8-char slice (#803)", async () => {
    const tabId = "wf:workflows/Untitled 2026-08-04 06-15-58.json";
    const a = await connectPanel(tabId); // never replies
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));
    await expect(bridge.send({ cmd: "graph_query" }, { timeoutMs: 120 })).rejects.toThrow(
      `Panel tab ${tabId} did not reply to "graph_query" within 120 ms`,
    );
    // And specifically NOT the old collapsed form that made every workflow tab look alike.
    await expect(bridge.send({ cmd: "graph_query" }, { timeoutMs: 120 })).rejects.not.toThrow(
      /Panel tab wf:workf did not reply/,
    );
    a.close();
  });

  // #770/#803 — the same fold as workflowUuidFor, one method over.
  // tabCanMutateGraph fails CLOSED, which is right for gating and wrong for prose:
  // rendered, it told users their panel "does not advertise" a capability when we
  // had merely failed to look. Driven against a LIVE tab so resolveTarget succeeds
  // and the stamp resolver is actually reached — probing a nonexistent tab exits
  // before that and would pass with the collapse still in place.
  it("tabGraphMutationCapability separates an UNREADABLE probe from an observed 'cannot' (#770)", async () => {
    const tabId = "wf:workflows/cap.json";
    const a = await connectPanel(tabId); // advertises both write fences
    await waitFor(() => expect(bridge.tabs()).toHaveLength(1));

    // A stamp is present and both fences are advertised → observed CAN.
    bridge.setTabWorkflowUuidResolver(() => "11111111-1111-4111-8111-111111111111");
    expect(bridge.tabGraphMutationCapability(tabId)).toEqual({ known: true, canMutate: true });
    expect(bridge.tabCanMutateGraph(tabId)).toBe(true);

    // The resolver ANSWERS with no stamp → an observed CANNOT (nothing to fence).
    bridge.setTabWorkflowUuidResolver(() => undefined);
    // A modern panel that advertises both fences but has NO trusted stamp is a
    // BINDING problem, not an old-pack one: reads work and a rebind fixes it.
    // Labelling it "capability" sent it to the one remedy that cannot help —
    // update the pack, hard-refresh — for a pack that was already correct
    // (codex gate). `canMutate` is a conjunction of four unrelated conditions and
    // each has to answer for itself.
    expect(bridge.tabGraphMutationCapability(tabId)).toEqual({
      known: true,
      canMutate: false,
      because: "no_identity",
    });
    expect(bridge.tabCanMutateGraph(tabId)).toBe(false);

    // The resolver THROWS → the inputs could not be READ. That is UNKNOWN, and
    // must never be rendered as "this panel lacks the write fence".
    bridge.setTabWorkflowUuidResolver(() => {
      throw new Error("resolver exploded");
    });
    const unknown = bridge.tabGraphMutationCapability(tabId);
    expect(unknown.known).toBe(false);
    expect(unknown).toMatchObject({ reason: expect.stringContaining("resolver exploded") });
    // …while the fail-closed convenience keeps its contract for the readiness
    // callers that GATE on it rather than describe it.
    expect(bridge.tabCanMutateGraph(tabId)).toBe(false);

    // An unroutable tab is `known`: routing nowhere IS an observation about
    // mutability, not a failure to look. But it is a DIFFERENT observation from
    // a panel that lacks the write fence, and the two used to share one value —
    // so the recovery told users to update their panel pack and hard-refresh
    // when the tab was simply gone and their READS were failing too (codex gate
    // P1). Same boolean, opposite remedy: the cause is what separates them.
    // A socket that is CLOSING is reachable but cannot carry a write. That is a
    // transport state, not an old panel — folding it into "capability" told the
    // user to update a pack that was already correct (codex gate).
    bridge.setTabWorkflowUuidResolver(() => "11111111-1111-4111-8111-111111111111");
    const sock = (bridge as unknown as { conns: Map<string, { sock: { readyState: number } }> });
    const conn = sock.conns?.get(tabId);
    if (conn) {
      Object.defineProperty(conn.sock, "readyState", {
        value: 2 /* CLOSING */,
        configurable: true,
      });
      expect(bridge.tabGraphMutationCapability(tabId)).toEqual({
        known: true,
        canMutate: false,
        because: "disconnected",
      });
      Object.defineProperty(conn.sock, "readyState", { value: 1, configurable: true });
    } else {
      throw new Error("test setup: expected a live connection for " + tabId);
    }

    const unroutable = bridge.tabGraphMutationCapability("no-such-tab");
    expect(unroutable).toEqual({ known: true, canMutate: false, because: "unroutable" });
    // The load-bearing assertion is that these two do NOT compare equal.
    expect(unroutable).not.toEqual({ known: true, canMutate: false, because: "capability" });
    a.close();
  });
});

// #770/#803 — the fence READ the rebind needs to tell "repaired a stale fence"
// apart from "there was never a fence" apart from "I could not look". Three
// answers, three remedies; this is the only window onto the stamp, so a
// distinction lost here is lost for good.
describe("UiBridge.workflowUuidFor (#770 fence read)", () => {
  it("distinguishes a present fence, a definitively absent one, and an unreadable one", () => {
    const b = new UiBridge(0);
    // No resolver at all → NOT KNOWN. Reporting this as "no fence" would assert
    // an absence from a mechanism that was never wired up.
    expect(b.workflowUuidFor("t")).toMatchObject({ known: false });

    b.setTabWorkflowUuidResolver((tabId) => (tabId === "t" ? "u-1" : undefined));
    expect(b.workflowUuidFor("t")).toEqual({ known: true, uuid: "u-1" });
    // A resolver that ANSWERS with nothing is a real, observed absence.
    expect(b.workflowUuidFor("other")).toEqual({ known: true, uuid: undefined });

    // An empty string is not an identity — but it is still an answer.
    b.setTabWorkflowUuidResolver(() => "");
    expect(b.workflowUuidFor("t")).toEqual({ known: true, uuid: undefined });

    // A guard that can throw is not a guard: a faulting resolver must neither take
    // down the recovery that reads it NOR be reported as "there is no fence".
    b.setTabWorkflowUuidResolver(() => {
      throw new Error("resolver exploded");
    });
    expect(() => b.workflowUuidFor("t")).not.toThrow();
    const read = b.workflowUuidFor("t");
    expect(read.known).toBe(false);
    expect(read).toMatchObject({ reason: expect.stringContaining("resolver exploded") });
  });

});

describe("makeUnknownCommandError (old-panel version gate)", () => {
  it("rewrites an Unknown command reply into an actionable update message", () => {
    // ui_render is not in the per-command map, so there is NO known real minimum to
    // quote — the message must name the observed fact (this panel build does not
    // implement it) and the always-sufficient remedy (update to the latest release),
    // never fabricate a version number (#619).
    const e = makeUnknownCommandError('Unknown command "ui_render"');
    expect(e).not.toBeNull();
    expect(e?.message).toContain("ui_render");
    expect(e?.message.toLowerCase()).toContain("does not implement");
    expect(e?.message.toLowerCase()).toContain("update");
    expect(e?.message.toLowerCase()).toContain("latest release");
    expect(e?.message.toLowerCase()).toContain("reconnect");
    // The 0.11.4 fallback baseline is a floor, not this command's minimum — quoting
    // it would fabricate a requirement (#619).
    expect(e?.message).not.toContain(MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS);
    expect(e?.message.toLowerCase()).not.toContain("too old");
    // The opaque raw internal error must not leak through.
    expect(e?.message).not.toBe('Unknown command "ui_render"');
  });

  // #352 — the quoted minimum is COMMAND-SPECIFIC, not a blanket 0.11.4. The old
  // code told users to update to ≥0.11.4 for graph_outline even though it has
  // shipped since panel 0.4.6 — an inflated, wrong requirement.
  it("quotes the command's OWN minimum panel version, not the blanket baseline", () => {
    expect(minPanelVersionForCmd("graph_outline")).toBe("0.4.6");
    const e = makeUnknownCommandError('Unknown command "graph_outline"');
    expect(e?.message).toContain("0.4.6");
    expect(e?.message).not.toContain(MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS);
  });

  it("includes the detected panel version when known", () => {
    const e = makeUnknownCommandError('Unknown command "ui_render"', "0.6.8");
    expect(e?.message).toContain("0.6.8");
  });

  // #422 — the error must name BOTH sides of the skew: the detected PANEL build
  // AND the detecting MCP server build ("return the detected MCP + panel versions
  // in the error"), so a "stale panel version" report shows which orchestrator
  // build (and thus which minimum table) produced the verdict.
  it("includes the detected MCP server version alongside the panel version (#422)", () => {
    const e = makeUnknownCommandError('Unknown command "graph_query"', "0.6.8", "0.48.27");
    expect(e?.message).toContain("detected panel 0.6.8");
    expect(e?.message).toContain("mcp 0.48.27");
  });

  // …and when the caller does not supply it, the running server's own version is
  // resolved (from this package's package.json) — never silently dropped.
  it("self-resolves the running MCP server version when not supplied (#422)", () => {
    const e = makeUnknownCommandError('Unknown command "graph_query"', "0.6.8");
    expect(e?.message).toContain("detected panel 0.6.8");
    expect(e?.message).toMatch(/, mcp \d+\.\d+\.\d+/);
  });

  // #352 FALSE-NEGATIVE boundary: a panel that ADVERTISES a version at/above the
  // command's real minimum must NEVER be told it is "too old". An Unknown-command
  // reply from a provably-new-enough panel is not an age problem, so it is NOT
  // rewritten (returns null → the raw error surfaces, the #236 gate is not poisoned).
  it("does NOT declare a new-enough panel too old (advertised version meets the minimum)", () => {
    // graph_outline needs 0.4.6; a 0.11.21 panel is well past it.
    expect(makeUnknownCommandError('Unknown command "graph_outline"', "0.11.21")).toBeNull();
    // Exactly-at-the-boundary is new enough (>=), so also not rewritten.
    expect(makeUnknownCommandError('Unknown command "graph_outline"', "0.4.6")).toBeNull();
  });

  // An UNPARSEABLE advertised version must NOT be mistaken for new-enough
  // (compareSemver returns 0 both for "equal" and "unparseable"). Without the
  // parse screen, `panel_version: "dev"` would compare as 0 (>= 0 → "supported")
  // and wrongly leak the raw error / skip the #236 learning path.
  it("treats an unparseable advertised version as NOT proven new enough (still rewritten)", () => {
    for (const bad of ["dev", "unknown", "latest", ""]) {
      const e = makeUnknownCommandError('Unknown command "graph_outline"', bad);
      // The point of this test is that the rewrite still FIRES — an unparseable
      // version must never be mistaken for new-enough.
      expect(e).not.toBeNull();
      expect(e?.message.toLowerCase()).toContain('does not implement "graph_outline"');
      expect(e?.message).toContain("0.4.6"); // the true minimum is still quoted
      // But it must not claim an AGE it never observed. "too old" is a verdict
      // that needs a version that parsed and compared below the minimum; the one
      // observed fact here is the panel's own "Unknown command" reply.
      expect(e?.message.toLowerCase()).not.toContain("too old");
    }
    // And the unparseable text is shown as EVIDENCE, quoted, never as a version.
    const nightly = makeUnknownCommandError('Unknown command "graph_outline"', "nightly");
    expect(nightly?.message).toContain('this panel reports "nightly"');
    expect(nightly?.message).toContain("not a comparable version");
    expect(nightly?.message).not.toContain("detected panel nightly");
  });

  // A MALFORMED version that merely PREFIXES a valid semver (e.g. `0.11.28.1`,
  // `0.11.28abc`) must not be prefix-matched as `0.11.28` and mistaken for new
  // enough — the SEMVER_RE screen is END-ANCHORED, so it fails and falls through to
  // the conservative too-old rewrite rather than leaking the raw error (codex P2).
  it("treats a malformed prefix-only version as NOT proven new enough (strict end-anchored screen)", () => {
    // Includes empty prerelease/build identifiers (`0.11.28-`, `0.11.28+.`,
    // `0.11.28-.`) which a lax `[0-9A-Za-z.-]+` class would have let slip through.
    for (const bad of [
      "0.11.28.1",
      "0.11.28abc",
      "0.4.6.0",
      "0.4.6-",
      "1.2",
      "0.11.28+.",
      "0.11.28-.",
      "0.11.28+",
      "01.11.28", // leading zero in the numeric core (SemVer 2.0.0 forbids)
      "0.011.28", // leading zero in minor
    ]) {
      const e = makeUnknownCommandError('Unknown command "graph_outline"', bad);
      expect(e).not.toBeNull();
      // Rewritten (not mistaken for new-enough), and — as above — no age verdict
      // from a string that failed the screen.
      expect(e?.message.toLowerCase()).toContain('does not implement "graph_outline"');
      expect(e?.message.toLowerCase()).not.toContain("too old");
      expect(e?.message).toContain(`this panel reports "${bad}"`);
    }
    // And it is symmetric on the proactive gate: a malformed version can't PROVE
    // unsupported either, so it is never proactively blocked (fail-open to reactive).
    for (const bad of ["0.11.28.1", "0.11.28+.", "0.11.28-."]) {
      expect(panelVersionProvesUnsupported("refresh_nodes", bad)).toBe(false);
    }
    expect(panelVersionProvesUnsupported("graph_query", "0.6.8abc")).toBe(false);
    // A well-formed version WITH build/prerelease metadata is still accepted.
    expect(makeUnknownCommandError('Unknown command "graph_outline"', "0.11.28+build.5")).toBeNull();
    expect(makeUnknownCommandError('Unknown command "graph_outline"', "0.11.28-rc.1")).toBeNull();
  });

  it("still declares a genuinely-too-old panel too old (advertised version below the minimum)", () => {
    // One patch below graph_outline's 0.4.6 minimum → genuinely too old.
    const e = makeUnknownCommandError('Unknown command "graph_outline"', "0.4.5");
    expect(e).not.toBeNull();
    expect(e?.message.toLowerCase()).toContain("too old");
    expect(e?.message).toContain("0.4.5"); // detected version surfaced
    expect(e?.message).toContain("0.4.6"); // correct minimum quoted
  });

  it("passes through a genuine command error (returns null)", () => {
    expect(makeUnknownCommandError("node 5 not found")).toBeNull();
    expect(makeUnknownCommandError("panel reported an error")).toBeNull();
  });

  it("does NOT rewrite an error that merely quotes the phrase mid-message (anchored)", () => {
    // A genuine command failure whose text happens to embed the phrase must pass
    // through untouched — only the panel dispatcher's own leading reply matches.
    expect(
      makeUnknownCommandError('graph_run failed: node emitted Unknown command "foo" to stdout'),
    ).toBeNull();
  });

  it("tolerates smart quotes and varied casing", () => {
    expect(makeUnknownCommandError("unknown command “graph_serialize”")?.message).toContain(
      "graph_serialize",
    );
  });

  // #619 — refresh_nodes (panel #608) shipped in panel 0.11.28. The reporter's
  // 0.11.20 panel lacks it and replies `Unknown command "refresh_nodes"`. Because
  // the command now carries its OWN authoritative minimum (0.11.28), a 0.11.20 panel
  // is correctly declared too old with the right remedy version — not passed through
  // raw, and not told the (wrong) 0.11.4 baseline.
  it("rewrites refresh_nodes on a <0.11.28 panel into an actionable update-to-0.11.28 message (#619)", () => {
    expect(minPanelVersionForCmd("refresh_nodes")).toBe("0.11.28");
    const e = makeUnknownCommandError('Unknown command "refresh_nodes"', "0.11.20");
    expect(e).not.toBeNull();
    expect(e?.message).toContain("refresh_nodes");
    expect(e?.message).toContain("0.11.20"); // connected/detected panel version
    expect(e?.message).toContain("0.11.28"); // required minimum
    expect(e?.message.toLowerCase()).toContain("too old");
    expect(e?.message.toLowerCase()).toContain("update");
    // The opaque raw internal error must not leak through.
    expect(e?.message).not.toBe('Unknown command "refresh_nodes"');
  });

  it("does NOT rewrite refresh_nodes once the panel is at/above 0.11.28 (#619 boundary)", () => {
    expect(makeUnknownCommandError('Unknown command "refresh_nodes"', "0.11.28")).toBeNull();
    expect(makeUnknownCommandError('Unknown command "refresh_nodes"', "0.12.0")).toBeNull();
  });

  // #619 CLASS-WIDE FIX: a command with NO authoritative minimum in the table has no
  // KNOWN real minimum, so the inflated 0.11.4 fallback baseline can never PROVE a
  // panel "new enough". An Unknown-command reply from such a command is authoritative
  // evidence the panel lacks it, so it maps to an actionable "update your panel"
  // message rather than a bare passthrough — even when the connected panel version
  // parseably exceeds the fallback baseline. The message must NOT quote the baseline
  // as if it were the command's minimum: that produced the recurrence's
  // self-contradictory `too old for "graph_resize_node" (detected 0.11.21) — update …
  // to ≥0.11.4`.
  it("still rewrites an UNTABLED command to actionable even when the panel exceeds the fallback baseline (#619)", () => {
    // ui_render is not in BRIDGE_CMD_MIN_PANEL_VERSION; 0.11.21 > the 0.11.4 baseline.
    const e = makeUnknownCommandError('Unknown command "ui_render"', "0.11.21");
    expect(e).not.toBeNull();
    expect(e?.message).toContain("ui_render");
    expect(e?.message).toContain("0.11.21"); // connected version surfaced
    expect(e?.message.toLowerCase()).toContain("does not implement");
    expect(e?.message.toLowerCase()).toContain("update");
    expect(e?.message.toLowerCase()).toContain("latest release");
    // Never the self-contradictory shape: a satisfied "minimum" is no requirement.
    expect(e?.message.toLowerCase()).not.toContain("too old");
    expect(e?.message).not.toContain(MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS);
    expect(e?.message).not.toBe('Unknown command "ui_render"'); // never the bare passthrough
  });

  it("rewrites graph_resize_node on a <0.11.25 panel with the correct minimum (#619 recurrence)", () => {
    expect(minPanelVersionForCmd("graph_resize_node")).toBe("0.11.25");
    const e = makeUnknownCommandError('Unknown command "graph_resize_node"', "0.11.21");
    expect(e).not.toBeNull();
    expect(e?.message).toContain("graph_resize_node");
    expect(e?.message).toContain("0.11.21");
    expect(e?.message).toContain("0.11.25");
    expect(e?.message).not.toContain(MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS);
    expect(e?.message.toLowerCase()).toContain("too old");
    expect(e?.message.toLowerCase()).toContain("update");
  });

  it("does not rewrite graph_resize_node once the panel is at or above 0.11.25 (#619 boundary)", () => {
    expect(makeUnknownCommandError('Unknown command "graph_resize_node"', "0.11.25")).toBeNull();
    expect(makeUnknownCommandError('Unknown command "graph_resize_node"', "0.11.32")).toBeNull();
  });

});

describe("panelVersionProvesUnsupported (#392 proactive version gate)", () => {
  it("is TRUE only for a listed command whose verified minimum the parseable version undercuts", () => {
    // graph_query shipped at panel 0.7.0 (changelog-verified).
    expect(panelVersionProvesUnsupported("graph_query", "0.6.8")).toBe(true);
    expect(panelVersionProvesUnsupported("graph_query", "0.6.99")).toBe(true);
    // At or above the minimum → supported → not proven-unsupported.
    expect(panelVersionProvesUnsupported("graph_query", "0.7.0")).toBe(false);
    expect(panelVersionProvesUnsupported("graph_query", "0.11.21")).toBe(false);
  });

  it("NEVER gates an unlisted command (would otherwise inherit the inflated 0.11.4 baseline and false-gate an early-but-capable panel)", () => {
    // graph_get_errors / graph_set_widget / ui_render shipped long before 0.11.4 but
    // are NOT in BRIDGE_CMD_MIN_PANEL_VERSION — proactively gating them off the
    // fallback baseline would wrongly block a 0.4.6–0.11.3 panel that supports them.
    expect(panelVersionProvesUnsupported("graph_get_errors", "0.6.8")).toBe(false);
    expect(panelVersionProvesUnsupported("graph_set_widget", "0.9.0")).toBe(false);
    expect(panelVersionProvesUnsupported("ui_render", "0.6.8")).toBe(false);
  });

  it("returns FALSE for a missing or unparseable version (can't prove it — fall through to the reactive path)", () => {
    expect(panelVersionProvesUnsupported("graph_query", undefined)).toBe(false);
    expect(panelVersionProvesUnsupported("graph_query", "")).toBe(false);
    expect(panelVersionProvesUnsupported("graph_query", "dev")).toBe(false);
    expect(panelVersionProvesUnsupported("graph_query", "nightly-2026")).toBe(false);
  });

  it("gates graph_serialize (0.8.2) and leaves graph_outline (0.4.6) effectively ungated for any modern panel", () => {
    expect(panelVersionProvesUnsupported("graph_serialize", "0.8.1")).toBe(true);
    expect(panelVersionProvesUnsupported("graph_serialize", "0.8.2")).toBe(false);
    expect(panelVersionProvesUnsupported("graph_outline", "0.4.5")).toBe(true);
    expect(panelVersionProvesUnsupported("graph_outline", "0.4.6")).toBe(false);
    expect(panelVersionProvesUnsupported("graph_outline", "0.11.7")).toBe(false);
  });

  // #619 — refresh_nodes is now tabled (min 0.11.28), so the proactive #392 gate
  // rejects the first call on a <0.11.28 panel BEFORE dispatch (capability gating
  // derived from the advertised version), and never gates a 0.11.28+ panel.
  it("proactively gates refresh_nodes below 0.11.28 and clears it at/above (#619)", () => {
    expect(panelVersionProvesUnsupported("refresh_nodes", "0.11.20")).toBe(true);
    expect(panelVersionProvesUnsupported("refresh_nodes", "0.11.27")).toBe(true);
    expect(panelVersionProvesUnsupported("refresh_nodes", "0.11.28")).toBe(false);
    expect(panelVersionProvesUnsupported("refresh_nodes", "0.12.0")).toBe(false);
  });

  it("proactively gates graph_resize_node below 0.11.25 and clears it at or above (#619 recurrence)", () => {
    expect(panelVersionProvesUnsupported("graph_resize_node", "0.11.21")).toBe(true);
    expect(panelVersionProvesUnsupported("graph_resize_node", "0.11.24")).toBe(true);
    expect(panelVersionProvesUnsupported("graph_resize_node", "0.11.25")).toBe(false);
    expect(panelVersionProvesUnsupported("graph_resize_node", "0.11.32")).toBe(false);
  });

});

// #413 — the bridge REWRITES a panel's raw "Unknown command graph_serialize" into
// a "too old for graph_serialize" message (and throws the same, tagged, from the
// #236 proactive gate). A caller with a back-compat fallback (panel_strip_workflow
// → graph_get_state) needs to detect that condition WITHOUT string-matching the
// literal "unknown command" text that was rewritten away. isPanelCmdUnsupportedError
// reads the STRUCTURED tag buildPanelTooOldError attaches, with a message-regex
// fallback for errors that never passed through the rewrite.
describe("isPanelCmdUnsupportedError (#413 structured unsupported-command detection)", () => {
  it("detects the STRUCTURED tag on a rewritten 'too old' error (the reactive path)", () => {
    // makeUnknownCommandError funnels through buildPanelTooOldError, which tags
    // the error with panelCmdUnsupported — even though the message no longer says
    // "unknown command".
    const e = makeUnknownCommandError('Unknown command "graph_serialize"');
    expect(e).not.toBeNull();
    expect(e?.message.toLowerCase()).not.toContain("unknown command");
    expect(isPanelCmdUnsupportedError(e)).toBe(true);
    expect(isPanelCmdUnsupportedError(e, "graph_serialize")).toBe(true);
    // A tag for a DIFFERENT command must not match a specific query.
    expect(isPanelCmdUnsupportedError(e, "graph_outline")).toBe(false);
  });

  it("matches the raw panel 'Unknown command' text (untagged fallback)", () => {
    expect(isPanelCmdUnsupportedError(new Error('Unknown command "graph_serialize"'))).toBe(true);
    expect(
      isPanelCmdUnsupportedError(new Error('Unknown command "graph_serialize"'), "graph_serialize"),
    ).toBe(true);
    expect(
      isPanelCmdUnsupportedError(new Error('Unknown command "graph_serialize"'), "graph_outline"),
    ).toBe(false);
  });

  it("matches the rewritten 'too old for' text even without the tag", () => {
    const raw = new Error('This ComfyUI-MCP panel is too old for "graph_serialize" — update…');
    expect(isPanelCmdUnsupportedError(raw)).toBe(true);
    expect(isPanelCmdUnsupportedError(raw, "graph_serialize")).toBe(true);
  });

  // #619 — the untabled-command rewrite says "does not implement" instead of
  // "too old for"; the tagless fallback must recognize that phrasing too.
  it("matches the rewritten 'does not implement' text even without the tag (#619)", () => {
    const raw = new Error(
      'This ComfyUI-MCP panel does not implement "ui_render" (detected 0.11.21) — update…',
    );
    expect(isPanelCmdUnsupportedError(raw)).toBe(true);
    expect(isPanelCmdUnsupportedError(raw, "ui_render")).toBe(true);
    expect(isPanelCmdUnsupportedError(raw, "graph_serialize")).toBe(false);
  });

  it("does NOT match a genuine transport/timeout error (fallback must not fire)", () => {
    expect(isPanelCmdUnsupportedError(new Error("bridge ack timed out after 30000ms"))).toBe(false);
    expect(isPanelCmdUnsupportedError(new Error("panel not reachable"))).toBe(false);
    expect(isPanelCmdUnsupportedError(undefined)).toBe(false);
    expect(isPanelCmdUnsupportedError(null)).toBe(false);
  });
});

describe("UiBridge.send (graceful gate end-to-end)", () => {
  it("surfaces an actionable message (with panel version) when an old panel rejects a bridge command", async () => {
    const sock = await connectPanel(undefined);
    // Old panel: advertises its version, then rejects unknown bridge commands.
    sock.send(JSON.stringify({ type: "hello", tab_id: "old-tab", title: "wf", panel_version: "0.6.8" }));
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        sock.send(
          JSON.stringify({ rid: msg.rid, ok: false, error: `Unknown command "${msg.cmd}"` }),
        );
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    await expect(bridge.send({ cmd: "graph_query" }, { tabId: "old-tab" })).rejects.toThrow(
      /too old for "graph_query".*0\.6\.8.*update/is,
    );
  });

  // #236 — for a command with NO changelog-verified per-command minimum (so the
  // advertised version can't PROVE it unsupported in advance — see the #392 proactive
  // gate below), the FIRST call still round-trips to discover it's unsupported, and
  // every LATER call in the same session is gated proactively: rejected with the same
  // actionable message WITHOUT ever reaching the panel again. FAIL-before: the old
  // code always re-dispatched and re-parsed the panel's raw "Unknown command" string
  // on every single call. ui_render is used precisely because it is NOT in
  // BRIDGE_CMD_MIN_PANEL_VERSION, so only the REACTIVE (#236) path can gate it.
  it("gates a REPEAT call to an already-proven-unsupported command without re-dispatching to the panel", async () => {
    const sock = await connectPanel(undefined);
    let dispatchCount = 0;
    sock.send(JSON.stringify({ type: "hello", tab_id: "old-tab-2", title: "wf", panel_version: "0.6.8" }));
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        dispatchCount += 1;
        sock.send(JSON.stringify({ rid: msg.rid, ok: false, error: `Unknown command "${msg.cmd}"` }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    // First call: genuinely round-trips (no per-command minimum to prove it unsupported).
    // ui_render is UNTABLED, so the rewrite names the observed fact ("does not
    // implement") and the latest-release remedy rather than quoting a fabricated
    // minimum (#619).
    await expect(bridge.send({ cmd: "ui_render" }, { tabId: "old-tab-2" })).rejects.toThrow(
      /does not implement "ui_render"/i,
    );
    expect(dispatchCount).toBe(1);

    // Second call: gated proactively (learned) — same actionable message, but the panel
    // must NEVER see a second dispatch of this command.
    await expect(bridge.send({ cmd: "ui_render" }, { tabId: "old-tab-2" })).rejects.toThrow(
      /does not implement "ui_render".*0\.6\.8.*update/is,
    );
    expect(dispatchCount).toBe(1);
  });

  // #392 — a command WITH a changelog-verified minimum (graph_query → 0.7.0), on a
  // panel whose ADVERTISED version parseably undercuts it (0.6.8), is gated PROACTIVELY
  // on the VERY FIRST call: the panel must never see a dispatch at all, and the honest,
  // correctly-versioned (≥0.7.0, NOT the inflated 0.11.4 baseline) verdict is returned
  // immediately. FAIL-before (#392): the tool was exposed/dispatched, the panel rejected
  // it at runtime, and only THEN was a verdict synthesized from the round-trip reply.
  it("PROACTIVELY gates a listed command the advertised version proves too old — no dispatch on the first call (#392)", async () => {
    const sock = await connectPanel(undefined);
    let dispatchCount = 0;
    sock.send(JSON.stringify({ type: "hello", tab_id: "old-tab-2b", title: "wf", panel_version: "0.6.8" }));
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        dispatchCount += 1;
        sock.send(JSON.stringify({ rid: msg.rid, ok: false, error: `Unknown command "${msg.cmd}"` }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    await expect(bridge.send({ cmd: "graph_query" }, { tabId: "old-tab-2b" })).rejects.toThrow(
      /too old for "graph_query".*0\.7\.0.*update/is,
    );
    // The FIRST call is gated before dispatch — the panel is never asked.
    expect(dispatchCount).toBe(0);
  });

  // #422 — the gate's verdict names BOTH detected versions: the panel build that
  // undercuts the minimum AND the running MCP server build making the verdict, so
  // a "stale panel version" report is actionable without guessing which side is old.
  it("proactive-gate verdict quotes the detected panel AND mcp versions (#422)", async () => {
    const sock = await connectPanel(undefined);
    sock.send(JSON.stringify({ type: "hello", tab_id: "skew-tab", title: "wf", panel_version: "0.6.8" }));
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    await expect(bridge.send({ cmd: "graph_query" }, { tabId: "skew-tab" })).rejects.toThrow(
      /too old for "graph_query" \(detected panel 0\.6\.8, mcp \d+\.\d+\.\d+\)/i,
    );
  });

  // #422 — a reconnect/hello at a NEWER version must update the REPORTED version:
  // the detected-version the gate quotes is re-read from every hello, so after the
  // refresh nothing ever quotes the stale pre-reconnect build. FAIL-before (the
  // original report): a later verdict quoted a version state the tab had long since
  // re-helloed past.
  it("quotes the REFRESHED panel version after a reconnect at a newer build — never the stale one (#422)", async () => {
    const sock1 = await connectPanel(undefined);
    sock1.send(JSON.stringify({ type: "hello", tab_id: "refresh-tab", title: "wf", panel_version: "0.6.8" }));
    await new Promise((r) => setTimeout(r, 50));
    // 0.6.8 undercuts graph_query's 0.7.0 minimum → gated, quoting 0.6.8.
    await expect(bridge.send({ cmd: "graph_query" }, { tabId: "refresh-tab" })).rejects.toThrow(
      /detected panel 0\.6\.8/i,
    );

    // The tab reloads at a NEWER build (0.7.0) under the same tab id. graph_query
    // now meets its minimum and must dispatch; a command with a HIGHER minimum
    // (refresh_nodes → 0.11.28) is still gated — but quotes the NEW 0.7.0, not the
    // stale 0.6.8 the first connection advertised.
    const sock2 = await connectPanel(undefined);
    const dispatched: string[] = [];
    sock2.send(JSON.stringify({ type: "hello", tab_id: "refresh-tab", title: "wf", panel_version: "0.7.0" }));
    sock2.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        dispatched.push(msg.cmd);
        sock2.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(await bridge.send({ cmd: "graph_query" }, { tabId: "refresh-tab" })).toEqual({
      cmd: "graph_query",
    });
    expect(dispatched).toContain("graph_query");
    const gated = await bridge
      .send({ cmd: "refresh_nodes" }, { tabId: "refresh-tab" })
      .then(
        () => {
          throw new Error("refresh_nodes should have been gated, not dispatched");
        },
        (e: Error) => e,
      );
    expect(gated.message).toMatch(
      /too old for "refresh_nodes" \(detected panel 0\.7\.0, mcp \d+\.\d+\.\d+\).*≥0\.11\.28/is,
    );
    expect(gated.message).not.toContain("0.6.8");
  });

  // A command that has NEVER been tried on this connection must never be
  // pre-emptively blocked by another command's failure (no blanket gate — only
  // the SPECIFIC cmd that was empirically proven unsupported is gated).
  it("does NOT gate a different, never-tried command after another command was proven unsupported", async () => {
    const sock = await connectPanel(undefined);
    // Old VERSION (for the #236 too-old graph_query check) but a stamp-enforcing build, so the
    // orthogonal P0c mutating-graph gate doesn't mask what this test asserts.
    sock.send(
      JSON.stringify({
        type: "hello",
        tab_id: "old-tab-3",
        title: "wf",
        panel_version: "0.6.8",
        enforces_workflow_stamp: true,
        enforces_workflow_stamp_at_write: true,
      }),
    );
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (!msg.rid || !msg.cmd) return;
      if (msg.cmd === "graph_query") {
        sock.send(JSON.stringify({ rid: msg.rid, ok: false, error: `Unknown command "${msg.cmd}"` }));
      } else {
        // Every other command this (otherwise old) panel actually DOES support.
        sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    await expect(bridge.send({ cmd: "graph_query" }, { tabId: "old-tab-3" })).rejects.toThrow(
      /too old for "graph_query"/i,
    );
    // graph_add_node must still be dispatched normally and succeed.
    const res = await bridge.send({ cmd: "graph_add_node" }, { tabId: "old-tab-3" });
    expect(res).toEqual({ cmd: "graph_add_node" });
  });

  // A reconnect (fresh hello) may be an updated panel build — a previously
  // learned "unsupported" verdict must never carry over and permanently block a
  // command the NEW connection could actually support.
  it("clears the learned-unsupported set on a fresh hello (reconnect may be an updated panel)", async () => {
    const sock1 = await connectPanel(undefined);
    sock1.send(JSON.stringify({ type: "hello", tab_id: "old-tab-4", title: "wf", panel_version: "0.6.8" }));
    sock1.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        sock1.send(JSON.stringify({ rid: msg.rid, ok: false, error: `Unknown command "${msg.cmd}"` }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));
    await expect(bridge.send({ cmd: "graph_query" }, { tabId: "old-tab-4" })).rejects.toThrow(
      /too old for "graph_query"/i,
    );

    // Reconnect under the same tab id with a NEWER panel that now supports it.
    const sock2 = await connectPanel(undefined);
    sock2.send(JSON.stringify({ type: "hello", tab_id: "old-tab-4", title: "wf", panel_version: "0.11.4" }));
    sock2.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        sock2.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    const res = await bridge.send({ cmd: "graph_query" }, { tabId: "old-tab-4" });
    expect(res).toEqual({ cmd: "graph_query" });
  });

  // #392 regression (codex WS review): panelVersion is INHERITED across a reconnect
  // that OMITS panel_version (so the reactive message can still quote a detected
  // version). That inherited, possibly-STALE version must NOT drive the proactive gate
  // — a reconnect may be a freshly UPGRADED panel. An old 0.6.8 connection followed by
  // a capable panel reconnecting under the same tab id WITHOUT re-advertising its
  // version must have its FIRST graph_query DISPATCHED (and succeed), never gated
  // unprobed. FAIL-before (had the gate keyed only on panelVersion): the inherited
  // 0.6.8 would proactively reject graph_query forever until yet another reconnect.
  it("does NOT proactively gate a reconnect that omits panel_version (inherited stale version must not block an upgraded panel) (#392)", async () => {
    const sock1 = await connectPanel(undefined);
    sock1.send(JSON.stringify({ type: "hello", tab_id: "reconn-tab", title: "wf", panel_version: "0.6.8" }));
    await new Promise((r) => setTimeout(r, 50));
    // First connection: advertised 0.6.8 → graph_query is proactively gated.
    await expect(bridge.send({ cmd: "graph_query" }, { tabId: "reconn-tab" })).rejects.toThrow(
      /too old for "graph_query"/i,
    );

    // Reconnect under the SAME tab id, this time WITHOUT panel_version, on a panel that
    // DOES support graph_query. The version is inherited (0.6.8) for messaging only.
    let dispatched = false;
    const sock2 = await connectPanel(undefined);
    sock2.send(JSON.stringify({ type: "hello", tab_id: "reconn-tab", title: "wf" }));
    sock2.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        dispatched = true;
        sock2.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    const res = await bridge.send({ cmd: "graph_query" }, { tabId: "reconn-tab" });
    expect(res).toEqual({ cmd: "graph_query" });
    // Proof it was actually PROBED, not answered from a stale proactive gate.
    expect(dispatched).toBe(true);
  });

  // #422 — DEMONSTRATED capability VETOES the proactive version gate. A panel that
  // has ALREADY served graph_query in this connection must never be re-gated as
  // "too old" just because a LATER re-hello (triggered by live graph edits) advertises
  // a version that parseably undercuts the declared minimum. FAIL-before: the #392 gate
  // read only the advertised version, so the second, undercutting hello flipped the gate
  // closed and graph_query — which had just succeeded twice — started returning "too old".
  it("does NOT re-gate a command the connection ALREADY served after an undercutting re-hello (#422)", async () => {
    let dispatchCount = 0;
    // First hello OMITS panel_version (browser-cached panel that predates advertising) —
    // so the proactive gate is skipped and graph_query round-trips and SUCCEEDS.
    const sock1 = await connectPanel(undefined);
    sock1.send(JSON.stringify({ type: "hello", tab_id: "served-tab", title: "wf" }));
    sock1.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        dispatchCount += 1;
        sock1.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    // Two successful graph_query calls — the panel demonstrably supports it.
    expect(await bridge.send({ cmd: "graph_query" }, { tabId: "served-tab" })).toEqual({
      cmd: "graph_query",
    });
    expect(await bridge.send({ cmd: "graph_query" }, { tabId: "served-tab" })).toEqual({
      cmd: "graph_query",
    });

    // Graph edits trigger a re-hello under the SAME tab id, this time ADVERTISING a
    // version (0.6.8) that parseably undercuts graph_query's 0.7.0 minimum. The panel
    // code did not change — capability was proven — so the gate must NOT fire.
    const sock2 = await connectPanel(undefined);
    sock2.send(
      JSON.stringify({ type: "hello", tab_id: "served-tab", title: "wf", panel_version: "0.6.8" }),
    );
    let redispatched = false;
    sock2.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        redispatched = true;
        sock2.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    const after = await bridge.send({ cmd: "graph_query" }, { tabId: "served-tab" });
    expect(after).toEqual({ cmd: "graph_query" });
    // Proof the veto worked by DISPATCHING, not by a stale gate rejecting it.
    expect(redispatched).toBe(true);
  });

  // #422 — the proven veto must SURVIVE a same-socket tab-id MIGRATION (tmp:<uuid> →
  // wf:<tabRouteId>:<path>), which is exactly what a workflow-tab switch / graph edit triggers. A
  // command served under the pre-migration id, then an undercutting-version hello under
  // the migrated id, must NOT be re-gated. FAIL-before: the migration deletes the old
  // conn, so the new conn started with an empty proven set and the gate fired.
  it("carries the proven veto across a same-socket tab-id migration (#422)", async () => {
    const sock = await connectPanel(undefined);
    // First hello under a tmp id, omitting panel_version → graph_query round-trips + succeeds.
    sock.send(JSON.stringify({ type: "hello", tab_id: "tmp:mig-uuid", title: "wf" }));
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await bridge.send({ cmd: "graph_query" }, { tabId: "tmp:mig-uuid" })).toEqual({
      cmd: "graph_query",
    });

    // SAME socket re-hellos under the migrated wf id, now advertising an undercutting
    // version. The migration carries the proven veto, so graph_query still dispatches.
    sock.send(
      JSON.stringify({ type: "hello", tab_id: "wf:mig-hash", title: "wf", panel_version: "0.6.8" }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(await bridge.send({ cmd: "graph_query" }, { tabId: "wf:mig-hash" })).toEqual({
      cmd: "graph_query",
    });
  });

  // #422 safety — the veto must NOT mask a genuine DOWNGRADE. If a reconnect reintroduces
  // a build that truly lacks the command, its own "Unknown command" reply clears the
  // proven-supported entry, and the reactive (#236) gate then blocks later calls.
  it("still gates after a genuine downgrade replies Unknown command, clearing the proven veto (#422)", async () => {
    const sock1 = await connectPanel(undefined);
    sock1.send(JSON.stringify({ type: "hello", tab_id: "downgrade-tab", title: "wf" }));
    sock1.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        sock1.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await bridge.send({ cmd: "graph_query" }, { tabId: "downgrade-tab" })).toEqual({
      cmd: "graph_query",
    });

    // Reconnect: an OLDER build under the same tab id that rejects graph_query.
    const sock2 = await connectPanel(undefined);
    sock2.send(
      JSON.stringify({ type: "hello", tab_id: "downgrade-tab", title: "wf", panel_version: "0.6.8" }),
    );
    sock2.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd) {
        sock2.send(JSON.stringify({ rid: msg.rid, ok: false, error: `Unknown command "${msg.cmd}"` }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    // The real rejection surfaces and clears the veto, so the connection now knows it's
    // unsupported — a later call is gated (reactively learned).
    await expect(bridge.send({ cmd: "graph_query" }, { tabId: "downgrade-tab" })).rejects.toThrow(
      /too old for "graph_query"/i,
    );
    await expect(bridge.send({ cmd: "graph_query" }, { tabId: "downgrade-tab" })).rejects.toThrow(
      /too old for "graph_query"/i,
    );
  });

  // #352 FALSE NEGATIVE end-to-end: a NEW-ENOUGH panel (advertises 0.11.21, well
  // past graph_outline's 0.4.6 minimum) that nonetheless replies "Unknown command
  // graph_outline" must NOT be told it's too old, and — critically — must NOT be
  // poisoned into the #236 proactive gate, so a later call still reaches the panel.
  it("does NOT rewrite/gate an Unknown-command reply from a panel that ADVERTISES a new-enough version (#352)", async () => {
    const sock = await connectPanel(undefined);
    let dispatchCount = 0;
    let replyUnknown = true;
    sock.send(
      JSON.stringify({ type: "hello", tab_id: "new-tab", title: "wf", panel_version: "0.11.21" }),
    );
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (!msg.rid || !msg.cmd) return;
      dispatchCount += 1;
      if (replyUnknown) {
        sock.send(JSON.stringify({ rid: msg.rid, ok: false, error: `Unknown command "${msg.cmd}"` }));
      } else {
        sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { cmd: msg.cmd } }));
      }
    });
    await new Promise((r) => setTimeout(r, 50));

    // First call: the raw error surfaces (NOT a "too old — update your panel" verdict).
    await expect(bridge.send({ cmd: "graph_outline" }, { tabId: "new-tab" })).rejects.toThrow(
      /unknown command/i,
    );
    await expect(
      bridge.send({ cmd: "graph_outline" }, { tabId: "new-tab" }),
    ).rejects.not.toThrow(/too old/i);
    expect(dispatchCount).toBe(2); // NOT gated — the panel was re-reached, not poisoned.

    // Prove the gate was never poisoned: once the panel answers normally, it works.
    replyUnknown = false;
    const res = await bridge.send({ cmd: "graph_outline" }, { tabId: "new-tab" });
    expect(res).toEqual({ cmd: "graph_outline" });
  });

  it("tags a POST-write reply-timeout as dispatched:true (frozen tab may still apply it — #509)", async () => {
    // A connected tab that NEVER replies: sock.send() succeeds, then the reply timer fires.
    // The command WAS written, so the rejection must carry the typed dispatched:true flag.
    const sock = await connectPanel("frozen-tab", "wf");
    await waitFor(() => expect(bridge.canReach("frozen-tab")).toBe(true));
    let caught: unknown;
    try {
      await bridge.send({ cmd: "comfy_reboot" }, { tabId: "frozen-tab", timeoutMs: 40 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/did not reply.*backgrounded or frozen/i);
    expect(dispatchOutcomeOf(caught)).toBe(true); // POST-write → accepted-but-unacked
    sock.close();
  });
});

// ── #486: a validated ask_user answer that lands AFTER the reply timeout must be
// buffered (keyed by ask_id) so the caller can still retrieve it, not discarded.
describe("UiBridge (late ask_user answer buffer — #486)", () => {
  it("buffers a valid ask_user reply that arrives after the reply timeout", async () => {
    const sock = await connectPanel("tab-ask", "wf");
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tab-ask")).toBe(true));
    // The panel validates a pick only AFTER the send's short reply timeout fires.
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd === "ask_user") {
        setTimeout(() => {
          sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: "Late Pick" }));
        }, 80);
      }
    });

    await expect(
      bridge.send(
        { cmd: "ask_user", ask_id: "ask-xyz", question: "?", options: [] },
        { tabId: "tab-ask", timeoutMs: 30 },
      ),
    ).rejects.toThrow(/did not reply/i);

    // The late-but-valid answer must be recoverable via the buffer, then drained.
    await waitFor(() => expect(bridge.takeLateAskReply("ask-xyz")).toBe("Late Pick"));
    expect(bridge.takeLateAskReply("ask-xyz")).toBeUndefined(); // drained once
  });

  // #1352 — the same recovery for a CREDENTIAL, minus the one property that makes it
  // durable. A secret card's late answer must be claimable in memory, because a user who
  // finishes typing a moment late should still have their token applied — and it must
  // NEVER reach the journal, because `panel_request_secret` exists so the value lands
  // nowhere it can be read back.
  it("buffers a late request_secret answer but NEVER hands it to the durable sink", async () => {
    const sock = await connectPanel("tab-secret", "wf");
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tab-secret")).toBe(true), {
      timeout: 3000,
    });
    const journaled: unknown[] = [];
    bridge.setLateAskReplySink((askId, result) => journaled.push({ askId, result }));
    // Capture every log level for the duration — verified against the real bridge with a
    // canary token, which is how this assertion earned its place.
    const logged: unknown[] = [];
    const levels = ["debug", "info", "warn", "error"] as const;
    const originals = levels.map((l) => [l, logger[l]] as const);
    for (const l of levels) {
      (logger as unknown as Record<string, unknown>)[l] = (...args: unknown[]) => {
        logged.push(args);
      };
    }
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd === "request_secret") {
        setTimeout(() => {
          sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: "sk-live-TOKEN" }));
        }, 80);
      }
    });

    await expect(
      bridge.send(
        { cmd: "request_secret", ask_id: "secret-1", label: "token" },
        { tabId: "tab-secret", timeoutMs: 30 },
      ),
    ).rejects.toThrow(/did not reply/i);

    // Recoverable in memory: this is what lets a late token still be applied.
    await waitFor(() => expect(bridge.takeLateAskReply("secret-1")).toBe("sk-live-TOKEN"), {
      timeout: 3000,
    });
    // …and drained on claim, so it does not linger.
    expect(bridge.takeLateAskReply("secret-1")).toBeUndefined();
    // THE POINT: the durable journal never saw it. Asserted on the whole payload, not just
    // the id — a sink that recorded the value under a different key would still be a leak.
    expect(journaled).toEqual([]);
    expect(JSON.stringify(journaled)).not.toContain("sk-live-TOKEN");
    // …and it reached no LOG LINE either, at any level. A journal is the obvious place a
    // credential must not land; a debug line is the easy one to add later without noticing.
    expect(JSON.stringify(logged)).not.toContain("sk-live-TOKEN");
    for (const [l, fn] of originals) (logger as unknown as Record<string, unknown>)[l] = fn;
    bridge.setLateAskReplySink(() => {});
  });

  // The buffer only helps a caller that is still alive to poll it, and #486 is
  // exactly the case where there is none — the tools/call that asked has been
  // abandoned. The SINK is what makes the answer durable: it fires at arrival,
  // with the tab it was rendered on, whether or not anyone is listening.
  it("hands a late ask_user answer to the durable sink at arrival, with its tab", async () => {
    const seen: Array<{ askId: string; result: unknown; tabId: string }> = [];
    bridge.setLateAskReplySink((askId, result, tabId) => seen.push({ askId, result, tabId }));
    const sock = await connectPanel("tab-sink", "wf");
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tab-sink")).toBe(true));
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd === "ask_user") {
        setTimeout(() => {
          sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: "Sunk Pick" }));
        }, 80);
      }
    });
    await expect(
      bridge.send(
        { cmd: "ask_user", ask_id: "ask-sink", question: "?", options: [] },
        { tabId: "tab-sink", timeoutMs: 30 },
      ),
    ).rejects.toThrow(/did not reply/i);
    // NOBODY polls takeLateAskReply here — that is the point.
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ askId: "ask-sink", result: "Sunk Pick", tabId: "tab-sink" });
    bridge.setLateAskReplySink(() => {});
  });

  // codex round 2, P0: the rid→ask_id MAPPING is what makes a late reply
  // recognisable as a card answer at all, so it gates the durable sink. It used
  // to share the 5-minute TTL of the reply BUFFER — but a question card sits on
  // screen until the user deals with it, which can be far longer than any tool
  // call, so an answer given at T+6min was discarded with no record.
  it("the ask-id mapping outlives the reply buffer, so a much-later answer is still recognised", async () => {
    const seen: string[] = [];
    bridge.setLateAskReplySink((askId) => seen.push(askId));
    const sock = await connectPanel("tab-longwait", "wf");
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tab-longwait")).toBe(true));
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd === "ask_user") {
        // A user who takes their time: the reply comes long after the card's own
        // reply timer, and after the prune below has run.
        setTimeout(() => {
          sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: "Much Later" }));
        }, 300);
      }
    });
    await expect(
      bridge.send(
        { cmd: "ask_user", ask_id: "pa-slow", question: "?", options: [] },
        { tabId: "tab-longwait", timeoutMs: 30 },
      ),
    ).rejects.toThrow(/did not reply/i);
    // Age the mapping past the BUFFER's TTL (5 min) but well inside the
    // mapping's own (60 min)…
    const map = (bridge as unknown as { askRidToId: Map<string, { ts: number }> }).askRidToId;
    for (const e of map.values()) e.ts = Date.now() - 20 * 60_000;
    // …and force a prune pass (any take runs one) BEFORE the reply lands, so the
    // mapping has to survive its own TTL rule rather than merely not be swept.
    expect(bridge.takeLateAskReply("nothing-here")).toBeUndefined();
    expect(map.size).toBe(1);
    await waitFor(() => expect(seen).toEqual(["pa-slow"]), { timeout: 3000 });
    bridge.setLateAskReplySink(() => {});
  });

  // Preferring loss over misattribution past the open-card ceiling is a sound
  // call, but a server log is not a disclosure to the person holding the mouse:
  // without a notice, the next thing that happens is someone clicking a button on
  // a card that is still on screen and having it do NOTHING. Say it on their
  // screen, at the moment we know.
  it("tells the USER when an open card can no longer accept an answer", async () => {
    const sock = await connectPanel("tab-overflow", "wf");
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tab-overflow")).toBe(true));
    const said: string[] = [];
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.type === "say" && typeof msg.text === "string") said.push(msg.text);
    });
    // Fill the mapping past its ceiling without waiting on 1024 real sends.
    const map = (bridge as unknown as {
      askRidToId: Map<string, { askId: string; ts: number; tabId: string }>;
    }).askRidToId;
    for (let i = 0; i < 1100; i += 1) {
      map.set(`rid-${i}`, { askId: `pa-${i}`, ts: Date.now(), tabId: "tab-overflow" });
    }
    // Any take runs a prune pass, which is where the ceiling bites.
    expect(bridge.takeLateAskReply("nothing-here")).toBeUndefined();
    expect(map.size).toBeLessThanOrEqual(1024);
    await waitFor(() =>
      expect(said.some((t) => /can no longer accept an answer/i.test(t))).toBe(true),
    );
    expect(said.find((t) => /can no longer accept an answer/i.test(t))).toMatch(
      /type your choice in the chat/i,
    );
  });

  // Coordinator gate P0: a socket close is NOT evidence a tab is gone — an
  // ordinary F5 produces exactly that. Firing the tab-gone listener on the close
  // retired live per-tab bookkeeping (the eviction-disclosure debt) during every
  // reload, so the reconnected conversation kept the answer and lost the warning
  // that an answer had been dropped — the worst possible split.
  // THE GONE-CLOCK TESTS CONTROL TIME RATHER THAN RACING IT.
  //
  // These are the one behaviour here defined by elapsed time, and a raced grace
  // fails both ways: too short and it fails on a CORRECT implementation, too long
  // and a timer that fires before the successor's hello lands makes a broken
  // cancel look caught — a false pass, which is worse, because a mutation
  // "verified" through it was never verified at all. So every test below sets a
  // grace no run can reach, waits for the state it cares about to be PROVABLY
  // reached, and only then runs the clocks.
  const NEVER = 600_000;
  /** The bridge has finished registering `incarnation` on `tabId`. */
  const occupied = (tabId: string, incarnation: string) =>
    waitFor(() => expect(bridge.tabIncarnation(tabId)).toBe(incarnation));
  const vacant = (tabId: string) =>
    waitFor(() => expect(bridge.tabIncarnation(tabId)).toBeUndefined());

  it("an ordinary reload does NOT declare the tab gone", async () => {
    const gone: string[] = [];
    bridge.setTabGoneListener((tabId) => gone.push(tabId), { graceMs: NEVER });
    const sock = await connectPanel("tab-reload", "wf", { tabSessionId: "browser-tab-A" });
    await occupied("tab-reload", "browser-tab-A");

    // F5: the socket closes and the SAME browser tab re-hellos. Its
    // `tab_session_id` is sessionStorage-backed, so it comes back unchanged.
    sock.close();
    await vacant("tab-reload");
    const back = await connectPanel("tab-reload", "wf", { tabSessionId: "browser-tab-A" });
    // The reconnect is COMPLETE before the clock is allowed to run — otherwise a
    // pass would prove only that the timer won a race.
    await occupied("tab-reload", "browser-tab-A");

    bridge.__runTabGoneClocksForTest();
    expect(gone).toEqual([]);
    back.close();
    bridge.setTabGoneListener(() => {});
  });

  it("a tab that stays away IS declared gone", async () => {
    const gone: string[] = [];
    bridge.setTabGoneListener((tabId) => gone.push(tabId), { graceMs: NEVER });
    const sock = await connectPanel("tab-really-gone", "wf", { tabSessionId: "browser-tab-Z" });
    await occupied("tab-really-gone", "browser-tab-Z");
    sock.close();
    await vacant("tab-really-gone");
    expect(gone).toEqual([]); // nothing at the moment of the close

    bridge.__runTabGoneClocksForTest();
    expect(gone).toEqual(["tab-really-gone"]);
    bridge.setTabGoneListener(() => {});
  });

  // Coordinator gate: SAME KEY IS NOT THE SAME TAB. A `wf:` route id names a
  // saved workflow, so a different browser tab opening that workflow takes the
  // key over. Keyed on the id alone, that stranger's hello cancelled the
  // departed tab's clock (and satisfied the timer's re-check), so the departed
  // tab was never declarable gone — and a later result from the stranger could
  // report and settle the departed tab's lost-answer disclosure as its own.
  it("a DIFFERENT browser tab taking over the same key does not cancel the departed tab's clock", async () => {
    const gone: string[] = [];
    bridge.setTabGoneListener((tabId) => gone.push(tabId), { graceMs: NEVER });
    const tabA = await connectPanel("wf:shared", "wf", { tabSessionId: "browser-tab-A" });
    await occupied("wf:shared", "browser-tab-A");
    tabA.close();
    await vacant("wf:shared");

    // A DIFFERENT browser tab opens the same saved workflow, taking over the
    // recurring key. Its hello is PROVABLY complete before the clock runs, so a
    // pass means the cancel really did decline — not that it lost a race.
    const tabB = await connectPanel("wf:shared", "wf", { tabSessionId: "browser-tab-B" });
    await occupied("wf:shared", "browser-tab-B");

    bridge.__runTabGoneClocksForTest();
    expect(gone).toEqual(["wf:shared"]);
    tabB.close();
    bridge.setTabGoneListener(() => {});
  });

  // …and the clocks must be independent. Keyed by tab id alone, the SECOND tab's
  // departure re-arms over the first tab's pending clock and the first tab is
  // never declared gone at all — its disclosure stranded for good.
  it("two incarnations of one key get independent clocks", async () => {
    const gone: string[] = [];
    bridge.setTabGoneListener((tabId) => gone.push(tabId), { graceMs: NEVER });
    const tabA = await connectPanel("wf:two", "wf", { tabSessionId: "browser-tab-A" });
    await occupied("wf:two", "browser-tab-A");
    tabA.close();
    await vacant("wf:two");

    // B takes the key over, then leaves too. A's clock is still armed throughout
    // — the grace cannot elapse — so this cannot pass by A firing early.
    const tabB = await connectPanel("wf:two", "wf", { tabSessionId: "browser-tab-B" });
    await occupied("wf:two", "browser-tab-B");
    tabB.close();
    await vacant("wf:two");
    expect(gone).toEqual([]);

    bridge.__runTabGoneClocksForTest();
    expect(gone.filter((t) => t === "wf:two")).toHaveLength(2);
    bridge.setTabGoneListener(() => {});
  });

  // Coordinator gate P1: two tabs open at once on one key. B's hello SUPERSEDES
  // A's socket, so by the time A's close handler runs the map already points at
  // B — and a "was I the primary?" guard answers no for a tab that very much did
  // just leave, so A was never armed at all and could never be declared gone.
  it("a tab superseded by a second tab on the same key is still declared gone", async () => {
    const gone: string[] = [];
    bridge.setTabGoneListener((tabId) => gone.push(tabId), { graceMs: NEVER });
    const tabA = await connectPanel("wf:takeover", "wf", { tabSessionId: "browser-tab-A" });
    await occupied("wf:takeover", "browser-tab-A");

    // B opens the SAME saved workflow while A is still connected; the bridge
    // supersedes A's socket rather than refusing B.
    const tabB = await connectPanel("wf:takeover", "wf", { tabSessionId: "browser-tab-B" });
    await occupied("wf:takeover", "browser-tab-B");
    // A's close is asynchronous — wait until it has actually armed something.
    await waitFor(() => {
      bridge.__runTabGoneClocksForTest();
      expect(gone).toEqual(["wf:takeover"]);
    });
    tabB.close();
    void tabA;
    bridge.setTabGoneListener(() => {});
  });

  // The ENTRIES are keyed by tab id, not incarnation — so a takeover has to be a
  // CONVERSATION BOUNDARY, announced at the hello rather than after a grace: the
  // newcomer must not be able to reach the departed tab's answers at all.
  it("a takeover by a different browser tab is announced immediately", async () => {
    const takenOver: Array<[string, string]> = [];
    bridge.setTabTakenOverListener((tabId, departed) => takenOver.push([tabId, departed]));
    const tabA = await connectPanel("wf:boundary", "wf", { tabSessionId: "browser-tab-A" });
    await occupied("wf:boundary", "browser-tab-A");
    expect(takenOver).toEqual([]);

    const tabB = await connectPanel("wf:boundary", "wf", { tabSessionId: "browser-tab-B" });
    await waitFor(() => expect(takenOver).toHaveLength(1));
    expect(takenOver[0]).toEqual(["wf:boundary", "browser-tab-A"]);
    tabA.close();
    tabB.close();
    bridge.setTabTakenOverListener(() => {});
  });

  // The incarnation COMPARISON (rather than merely "was someone here?") is what
  // this guards: a panel re-hellos on its own live socket — a title change, a
  // re-registration — with the old connection still in the map. Same occupant,
  // so its conversation continues and nothing may be retired. This is also why
  // the anonymous id must be per CONNECTION: minted per hello, a re-hello would
  // look like a stranger to itself.
  it("a re-hello from the SAME tab on a live socket is not a takeover", async () => {
    const takenOver: string[] = [];
    bridge.setTabTakenOverListener((tabId) => takenOver.push(tabId));
    for (const identity of [{ tabSessionId: "browser-tab-A" }, {}]) {
      const key = identity.tabSessionId ? "wf:rehello" : "wf:rehello-anon";
      const sock = await connectPanel(key, "wf", identity);
      await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === key)).toBe(true));
      const before = bridge.tabIncarnation(key);

      // Re-register on the SAME socket, with no disconnect in between.
      sock.send(
        JSON.stringify({
          type: "hello",
          tab_id: key,
          title: "renamed",
          enforces_workflow_stamp: true,
          enforces_workflow_stamp_at_write: true,
          ...(identity.tabSessionId ? { tab_session_id: identity.tabSessionId } : {}),
        }),
      );
      await waitFor(() =>
        expect(bridge.tabs().some((t) => t.tab_id === key && t.title === "renamed")).toBe(true),
      );
      // Same connection, same incarnation — and therefore not a takeover.
      expect(bridge.tabIncarnation(key)).toBe(before);
      expect(takenOver).toEqual([]);
      sock.close();
      await vacant(key);
    }
    bridge.setTabTakenOverListener(() => {});
  });

  // …and P1-2: anonymous panels must NOT share one slot. The panel omits its
  // identity precisely when its Web Locks lease could not be acquired — i.e.
  // when a duplicate tab copied the sessionStorage id — so the anonymous path IS
  // the two-tabs-one-key case, not an exotic edge.
  it("two anonymous departures on one key are both declarable", async () => {
    const gone: string[] = [];
    bridge.setTabGoneListener((tabId) => gone.push(tabId), { graceMs: NEVER });
    const anonA = await connectPanel("wf:anon", "wf"); // no tab_session_id
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "wf:anon")).toBe(true));
    anonA.close();
    await vacant("wf:anon");

    const anonB = await connectPanel("wf:anon", "wf"); // also anonymous
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "wf:anon")).toBe(true));
    anonB.close();
    await vacant("wf:anon");
    expect(gone).toEqual([]);

    // Two unproven departures, two owed warnings — the second must not overwrite
    // or clear the first.
    bridge.__runTabGoneClocksForTest();
    expect(gone.filter((t) => t === "wf:anon")).toHaveLength(2);
    bridge.setTabGoneListener(() => {});
  });

  it("an unidentified panel cannot prove it came back, so the clock still fires", async () => {
    const gone: string[] = [];
    bridge.setTabGoneListener((tabId) => gone.push(tabId), { graceMs: NEVER });
    // No tab_session_id: the panel could not take its Web Locks lease. Nothing
    // can prove which tab returned, and unknown-return must let the disclosure
    // surface.
    const sock = await connectPanel("tab-anonymous", "wf");
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tab-anonymous")).toBe(true));
    sock.close();
    await vacant("tab-anonymous");
    const back = await connectPanel("tab-anonymous", "wf");
    // The "reconnect" is COMPLETE before the clock runs, so a pass proves the
    // cancel declined rather than that the timer got there first.
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tab-anonymous")).toBe(true));

    bridge.__runTabGoneClocksForTest();
    expect(gone).toEqual(["tab-anonymous"]);
    back.close();
    bridge.setTabGoneListener(() => {});
  });

  it("a throwing sink never breaks the message loop or loses the buffered answer", async () => {
    bridge.setLateAskReplySink(() => {
      throw new Error("journal exploded");
    });
    const sock = await connectPanel("tab-sink-bad", "wf");
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tab-sink-bad")).toBe(true));
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd === "ask_user") {
        setTimeout(() => {
          sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: "Still Here" }));
        }, 80);
      }
    });
    await expect(
      bridge.send(
        { cmd: "ask_user", ask_id: "ask-bad", question: "?", options: [] },
        { tabId: "tab-sink-bad", timeoutMs: 30 },
      ),
    ).rejects.toThrow(/did not reply/i);
    await waitFor(() => expect(bridge.takeLateAskReply("ask-bad")).toBe("Still Here"));
    bridge.setLateAskReplySink(() => {});
  });

  it("does not buffer a non-ask command's late reply (no ask_id → dropped)", async () => {
    const sock = await connectPanel("tab-plain", "wf");
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tab-plain")).toBe(true));
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd === "graph_outline") {
        setTimeout(() => {
          sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { late: true } }));
        }, 80);
      }
    });
    await expect(
      bridge.send({ cmd: "graph_outline" }, { tabId: "tab-plain", timeoutMs: 30 }),
    ).rejects.toThrow(/did not reply|disconnected|gone/i);
    // Give the late reply time to land; it must NOT be buffered under any ask id.
    await new Promise((r) => setTimeout(r, 120));
    expect(bridge.takeLateAskReply("tab-plain")).toBeUndefined();
  });
});

// ── #694: the unsolved half. A MUTATION that times out and then applies is
// invisible — the panel does reply, just after the deadline, and the bridge
// drops it ("Everything else drops", ui-bridge.ts:2230).
//
// This is NOT the #486 shape and must not be built like it. #486 buffers for a
// caller that is STILL ALIVE polling within a grace window; a mutation caller
// has already been handed an outcome-unknown rejection and moved on. There is
// no poller, so the outcome has to be retained for a LATER interaction to find.
//
// The reporter's case verbatim (0.50.36 / panel 0.11.44): graph_set_node_mode
// timed out at 6000 ms, and panel_query_graph immediately after showed the node
// already switched. The write landed. Nothing ever told the caller.
describe("UiBridge (late MUTATION outcome — #694)", () => {
  // Retention is FAIL-CLOSED: with no filter the bridge keeps nothing, because
  // nothing could drain it either. Production installs this from
  // RETRY_TOKEN_CMDS (orchestrator/index.ts); the suite states the same shape
  // explicitly rather than importing it, so a change to that set shows up here
  // as a deliberate decision instead of silently re-scoping these tests.
  const RETAINED = new Set(["graph_set_node_mode", "graph_add_node"]);
  beforeEach(() => bridge.setLateMutationFilter((c) => RETAINED.has(c)));
  afterEach(() => bridge.setLateMutationFilter(null));

  it("retains nothing when no filter is installed (fail closed)", async () => {
    bridge.setLateMutationFilter(null);
    const sock = await connectPanel("tab-nofilter", "wf");
    await waitFor(() =>
      expect(bridge.tabs().some((t) => t.tab_id === "tab-nofilter")).toBe(true),
    );
    let rid = "";
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd === "graph_set_node_mode") {
        rid = msg.rid;
        setTimeout(() => sock.send(JSON.stringify({ rid: msg.rid, ok: true })), 80);
      }
    });
    await expect(
      bridge.send(
        { cmd: "graph_set_node_mode", node_id: 1, mode: "active" },
        { tabId: "tab-nofilter", timeoutMs: 30 },
      ),
    ).rejects.toThrow(/did not reply/i);
    await new Promise((r) => setTimeout(r, 140));
    expect(bridge.takeLateMutation(rid)).toBeUndefined();
    sock.close();
  });

  it("asks the FILTER, not the mutating flag — the #778 commands stay out", async () => {
    // ctx.mutating is !BRIDGE_READONLY_CMDS.has(cmd), which this file documents
    // as misclassifying graph_screenshot &c. The first cut of #694 gated on it
    // and retained seven reads under a comment claiming reads were excluded.
    // graph_screenshot is mutating:true AND not retainable — the exact pair that
    // tells the two discriminators apart.
    const sock = await connectPanel("tab-778", "wf");
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "tab-778")).toBe(true));
    let rid = "";
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd === "graph_screenshot") {
        rid = msg.rid;
        setTimeout(() => sock.send(JSON.stringify({ rid: msg.rid, ok: true })), 80);
      }
    });
    await expect(
      bridge.send({ cmd: "graph_screenshot" }, { tabId: "tab-778", timeoutMs: 30 }),
    ).rejects.toThrow(/did not reply/i);
    await new Promise((r) => setTimeout(r, 140));
    expect(rid, "graph_screenshot should have been dispatched").toBeTruthy();
    expect(bridge.takeLateMutation(rid)).toBeUndefined();
    sock.close();
  });

  /** Reply to `cmd` only after `delayMs`, and hand back the rid the bridge minted. */
  function replyLate(sock: WebSocket, cmd: string, delayMs: number): Promise<string> {
    return new Promise((resolve) => {
      sock.on("message", (buf) => {
        const msg = JSON.parse(buf.toString());
        if (msg.rid && msg.cmd === cmd) {
          resolve(msg.rid);
          setTimeout(() => {
            sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { mode: "active" } }));
          }, delayMs);
        }
      });
    });
  }

  it("retains a successful late mutation reply so a later call can report it applied", async () => {
    const sock = await connectPanel("tab-late-mut", "wf");
    await waitFor(() =>
      expect(bridge.tabs().some((t) => t.tab_id === "tab-late-mut")).toBe(true),
    );
    const ridP = replyLate(sock, "graph_set_node_mode", 80);

    await expect(
      bridge.send(
        { cmd: "graph_set_node_mode", node_id: 126, mode: "active" },
        { tabId: "tab-late-mut", timeoutMs: 30 },
      ),
    ).rejects.toThrow(/did not reply/i);
    const rid = await ridP;

    // The write DID land. Today this assertion fails because the reply is
    // dropped on the floor and the bridge keeps no record that it ever arrived.
    const late = await waitFor(() => {
      const got = bridge.takeLateMutation(rid);
      expect(got, "late mutation outcome should be retained").toBeTruthy();
      return got;
    });
    expect(late?.ok).toBe(true);
    expect(late?.cmd).toBe("graph_set_node_mode");
    expect(late?.tabId).toBe("tab-late-mut");
    sock.close();
  });

  it("drains once — a second reader must not be told the same thing twice", async () => {
    const sock = await connectPanel("tab-late-drain", "wf");
    await waitFor(() =>
      expect(bridge.tabs().some((t) => t.tab_id === "tab-late-drain")).toBe(true),
    );
    const ridP = replyLate(sock, "graph_set_node_mode", 80);
    await expect(
      bridge.send(
        { cmd: "graph_set_node_mode", node_id: 1, mode: "mute" },
        { tabId: "tab-late-drain", timeoutMs: 30 },
      ),
    ).rejects.toThrow(/did not reply/i);
    const rid = await ridP;

    await waitFor(() => expect(bridge.takeLateMutation(rid)).toBeTruthy());
    expect(bridge.takeLateMutation(rid)).toBeUndefined();
    sock.close();
  });

  it("does NOT retain a mutation that replied IN TIME (nothing to report)", async () => {
    // Guards the obvious over-fire: a normal successful mutation resolves its
    // caller directly, so a retained record would make every write look like a
    // recovered timeout.
    const sock = await connectPanel("tab-on-time", "wf");
    await waitFor(() =>
      expect(bridge.tabs().some((t) => t.tab_id === "tab-on-time")).toBe(true),
    );
    let seen = "";
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd === "graph_set_node_mode") {
        seen = msg.rid;
        sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { mode: "active" } }));
      }
    });
    await bridge.send(
      { cmd: "graph_set_node_mode", node_id: 7, mode: "active" },
      { tabId: "tab-on-time", timeoutMs: 2000 },
    );
    expect(seen).toBeTruthy();
    expect(bridge.takeLateMutation(seen)).toBeUndefined();
    sock.close();
  });

  it("does NOT retain a late FAILURE — only a write that demonstrably applied", async () => {
    // A late ok:false says the mutation was refused, which is not news the
    // caller needs: they were already told it did not complete. Retaining it
    // would turn "we never found out" into "it failed", the #796 fold in the
    // opposite direction.
    const sock = await connectPanel("tab-late-fail", "wf");
    await waitFor(() =>
      expect(bridge.tabs().some((t) => t.tab_id === "tab-late-fail")).toBe(true),
    );
    let rid = "";
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd === "graph_set_node_mode") {
        rid = msg.rid;
        setTimeout(() => {
          sock.send(JSON.stringify({ rid: msg.rid, ok: false, error: "no such node" }));
        }, 80);
      }
    });
    await expect(
      bridge.send(
        { cmd: "graph_set_node_mode", node_id: 999, mode: "active" },
        { tabId: "tab-late-fail", timeoutMs: 30 },
      ),
    ).rejects.toThrow(/did not reply/i);
    await new Promise((r) => setTimeout(r, 140));
    expect(rid).toBeTruthy();
    expect(bridge.takeLateMutation(rid)).toBeUndefined();
    sock.close();
  });

  it("does NOT retain a late READ reply — a read is retryable, so nothing is ambiguous", async () => {
    // The asymmetry #1154 spells out: an abandoned read costs nothing because
    // you just retry it. Retaining reads would make this buffer unbounded noise.
    const sock = await connectPanel("tab-late-read", "wf");
    await waitFor(() =>
      expect(bridge.tabs().some((t) => t.tab_id === "tab-late-read")).toBe(true),
    );
    let rid = "";
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd === "graph_outline") {
        rid = msg.rid;
        setTimeout(() => {
          sock.send(JSON.stringify({ rid: msg.rid, ok: true, result: { late: true } }));
        }, 80);
      }
    });
    await expect(
      bridge.send({ cmd: "graph_outline" }, { tabId: "tab-late-read", timeoutMs: 30 }),
    ).rejects.toThrow(/did not reply|disconnected|gone/i);
    await new Promise((r) => setTimeout(r, 140));
    expect(rid).toBeTruthy();
    expect(bridge.takeLateMutation(rid)).toBeUndefined();
    sock.close();
  });

  it("retains a mutation that completed after a mid-command disconnect (panel#1524)", async () => {
    // The timeout path already retains. A disconnect used to reject immediately
    // WITHOUT stashing the rid, so the panel's lost-reply replay of a write that
    // already applied (graph_run that queued) was an unknown rid and was dropped.
    const sock = await connectPanel("tab-disco-mut", "wf");
    await waitFor(() =>
      expect(bridge.tabs().some((t) => t.tab_id === "tab-disco-mut")).toBe(true),
    );
    let rid = "";
    sock.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.rid && msg.cmd === "graph_set_node_mode") {
        rid = msg.rid;
        sock.close();
      }
    });
    await expect(
      bridge.send(
        { cmd: "graph_set_node_mode", node_id: 1, mode: "active" },
        { tabId: "tab-disco-mut", timeoutMs: 5000 },
      ),
    ).rejects.toThrow(/disconnected mid-command/);
    expect(rid, "the command must have been written before the drop").toBeTruthy();

    const sock2 = await connectPanel("tab-disco-mut", "wf");
    await waitFor(() =>
      expect(bridge.tabs().some((t) => t.tab_id === "tab-disco-mut")).toBe(true),
    );
    sock2.send(JSON.stringify({ rid, ok: true, result: { mode: "active" } }));
    const late = await waitFor(() => {
      const got = bridge.peekLateMutation(rid);
      expect(got, "disconnect must retain the late receipt, not drop it").toBeTruthy();
      return got;
    });
    expect(late?.ok).toBe(true);
    expect(late?.cmd).toBe("graph_set_node_mode");
    expect(late?.result).toEqual({ mode: "active" });
    sock2.close();
  });
});

// #952 — the headless tools failed with `fetch failed` while every panel tool
// worked, and nothing in the error connected the two. They are separate targets
// by design (the panel talks to whichever ComfyUI its browser tab is on; the
// headless calls go to COMFYUI_URL), so the failure has to be able to say
// whether the two actually differ. comfyui/fetch.ts asks the bridge, via a
// callback the orchestrator installs, and this is what it asks for.
describe("UiBridge.connectedServerOrigins (#952)", () => {
  /** A panel socket carrying a SERVER-OBSERVED handshake Origin, like a browser. */
  function connectWithOrigin(tabId: string, origin?: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
      sock.on("open", () => {
        sock.send(JSON.stringify({ type: "hello", tab_id: tabId, title: tabId }));
        resolve(sock);
      });
      sock.on("error", reject);
    });
  }

  it("reports the origins connected tabs actually front", async () => {
    const a = await connectWithOrigin("o-1", "http://192.168.1.50:8188");
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "o-1")).toBe(true));
    expect(bridge.connectedServerOrigins()).toEqual(["http://192.168.1.50:8188"]);
    a.close();
  });

  it("de-duplicates two tabs on the SAME ComfyUI", async () => {
    const a = await connectWithOrigin("o-1", "http://192.168.1.50:8188");
    const b = await connectWithOrigin("o-2", "http://192.168.1.50:8188");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(2));
    expect(bridge.connectedServerOrigins()).toEqual(["http://192.168.1.50:8188"]);
    a.close();
    b.close();
  });

  it("reports BOTH when tabs front different ComfyUIs", async () => {
    const a = await connectWithOrigin("o-1", "http://192.168.1.50:8188");
    const b = await connectWithOrigin("o-2", "http://10.0.0.9:8188");
    await waitFor(() => expect(bridge.tabs()).toHaveLength(2));
    expect(bridge.connectedServerOrigins().sort()).toEqual(
      ["http://10.0.0.9:8188", "http://192.168.1.50:8188"].sort(),
    );
    a.close();
    b.close();
  });

  // A relay/non-browser client sends no Origin. Omitting it is required: an
  // invented origin would be compared against COMFYUI_URL and could report drift
  // that does not exist, or rule out drift that does.
  it("omits a tab that supplied no handshake Origin rather than guessing", async () => {
    const a = await connectWithOrigin("o-1"); // no Origin header
    await waitFor(() => expect(bridge.tabs().some((t) => t.tab_id === "o-1")).toBe(true));
    expect(bridge.connectedServerOrigins()).toEqual([]);
    a.close();
  });

  it("is empty with nothing connected, and never throws", () => {
    expect(bridge.connectedServerOrigins()).toEqual([]);
  });
});

// #875 — the liveness signal the self-restarter's tunnel gate depends on.
//
// isHeadless() is STICKY on purpose (a tab that ever connected headless stays so
// while offline, so a render finishing during a disconnect is byte-inlined for
// the mailbox). That is right for rendering and WRONG for liveness: using it
// would report a phone that paired once and left as still connected, and the
// restarter would defer updates forever instead of until the next disconnect.
describe("#875: hasLiveHeadlessClient reports the LIVE set, not the sticky one", () => {
  it("is false with no connections at all", async () => {
    const { bridge: b } = await startBridgeOnFreePort();
    expect(b.hasLiveHeadlessClient()).toBe(false);
    await b.stop();
  });

  // The POSITIVE case, and the one that makes this suite non-vacuous: without it
  // every assertion here would pass with the accessor hardcoded to false — a
  // mutation to the STICKY isHeadless() killed nothing until this existed.
  it("is TRUE while a headless client is connected, and false once it leaves", async () => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res, rej) => {
      sock.on("open", () => res());
      sock.on("error", rej);
    });
    sock.send(JSON.stringify({ type: "hello", tab_id: "phone-live", title: "phone", headless: true }));
    await new Promise((r) => setTimeout(r, 80));

    expect(bridge.hasLiveHeadlessClient()).toBe(true);

    sock.close();
    await new Promise((r) => setTimeout(r, 150));
    // #1176 — 150ms after the socket closed is NOT "the phone is gone". It is
    // exactly the backgrounded case: the mobile OS suspends the socket within
    // seconds of the screen going off. This assertion used to demand `false`
    // here, and that is the bug — a reporter's restart rotated the cloudflared
    // hostname during a pocket interval and their phone came back to a dead URL.
    expect(bridge.hasLiveHeadlessClient()).toBe(true);

    // The property that killed the sticky isHeadless() is still intact: a phone
    // that has genuinely been gone longer than the window stops deferring, on
    // its own, with no unpairing step and no user action.
    bridge.markHeadlessDisconnectForTests(performance.now() - HEADLESS_RECENCY_MS - 1);
    expect(bridge.hasLiveHeadlessClient()).toBe(false);
  });

  it("is false for a connected NON-headless (canvas) tab", async () => {
    const sock = await connectPanel("tab-desktop");
    await new Promise((r) => setTimeout(r, 60));

    expect(bridge.hasLiveHeadlessClient()).toBe(false);

    sock.close();
  });
});
