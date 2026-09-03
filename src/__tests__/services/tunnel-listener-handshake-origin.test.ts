// #2757 / #2752 — the token-gated listener threw the WebSocket upgrade away, so
// every tunnel-fronted panel tab was PERMANENTLY unable to adopt a workflow fence.
//
// `UiBridge` has two listeners. The primary one has always read the handshake:
//
//     wss.on("connection", (sock, req) => {
//       const handshakeOrigin = normalizeHandshakeOrigin(req?.headers?.origin);
//       this.handleConnection(sock, …, handshakeOrigin);
//     });
//
// The second one, opened by `addListener`, took `(sock)` alone and called
// `this.handleConnection(sock)` — no third argument, so `serverOrigin` defaulted
// to `undefined`.
//
// That listener is not a corner of the product. `ensureSecureBridge` puts the
// cloudflared quick-tunnel in front of exactly it
// (`bridge.addListener("0.0.0.0", tunnelPort, tunnelToken)`), which makes it the
// transport for EVERY remote-pod panel tab; the phone-pairing LAN listener is the
// same call. cloudflared forwards the browser's `Origin` header on the upgrade
// untouched — nothing was stripping it, the orchestrator just never looked.
//
// `workflowIdentityParts()` gates on an origin being PRESENT (it never compares
// it against anything), so the whole chain failed closed: no identity, no fence
// adoption, and `panel_set_workflow_target({mode:"current"})` reporting that it
// applied the mode while refusing the rebind — for the life of the session, no
// matter how many times the tab was refreshed.
//
// These tests drive the REAL listener over a REAL WebSocket carrying a REAL
// `Origin` header, because the defect lived entirely in the argument list of the
// connection callback: a test that called `handleConnection` directly, or that
// asserted on a fake socket, would have passed with the bug in place.

import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import WebSocket from "ws";
import { UiBridge } from "../../services/ui-bridge.js";
import { workflowIdentityParts } from "../../orchestrator/session-store.js";

/** An ephemeral port the OS has just released — same helper the sibling suite uses. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const TOKEN = "tunnel-token";
/** What a RunPod pod's ComfyUI tab actually sends: the https proxy origin. */
const POD_ORIGIN = "https://abcd1234-3000.proxy.runpod.net";
/** How the primary listener normalises that: explicit port, lowercased host. */
const POD_ORIGIN_NORMALIZED = "https://abcd1234-3000.proxy.runpod.net:443";
const WF_UUID_OLD = "0ed9e3f1-1111-4222-8333-444455556666";
const WF_UUID_NEW = "c7596084-9999-4888-8777-666655554444";

const bridges: UiBridge[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) {
    try {
      s.close();
    } catch {
      // already gone
    }
  }
  for (const b of bridges.splice(0)) await b.stop();
});

/** Stand up a bridge whose ONLY listener is the token-gated one — the tunnel shape. */
async function tunnelBridge(): Promise<{ bridge: UiBridge; port: number }> {
  const bridge = new UiBridge(await freePort());
  bridges.push(bridge);
  const port = await freePort();
  await bridge.addListener("127.0.0.1", port, TOKEN);
  return { bridge, port };
}

/** Open a tab through the token-gated listener with the given `Origin` header. */
async function connectTab(
  port: number,
  origin: string | undefined,
  tabId: string,
): Promise<WebSocket> {
  const sock = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${TOKEN}`,
      origin === undefined ? {} : { headers: { Origin: origin } },
    );
    s.on("open", () => resolve(s));
    s.on("error", reject);
  });
  sockets.push(sock);
  sock.send(JSON.stringify({ type: "hello", tab_id: tabId, title: "wf" }));
  return sock;
}

/** The hello is delivered asynchronously — wait for the bridge to register it. */
async function waitForTab(bridge: UiBridge, tabId: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (bridge.tabs().some((t) => t.tab_id === tabId)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`tab ${tabId} never registered`);
}

describe("the token-gated (tunnel/pairing) listener carries the handshake Origin (#2757)", () => {
  it("reports the browser's Origin for a tunnel-fronted tab", async () => {
    const { bridge, port } = await tunnelBridge();
    await connectTab(port, POD_ORIGIN, "tab-pod-1");
    await waitForTab(bridge, "tab-pod-1");

    expect(bridge.tabServerOrigin("tab-pod-1")).toBe(POD_ORIGIN_NORMALIZED);
  });

  it("lets that tab's workflow identity VALIDATE — the gate the report died on", async () => {
    // The origin is not the goal; adopting a fence is. `workflowIdentityParts` is
    // the exact function the fence-adoption validator calls, and its origin check
    // is a PRESENCE check — so before the fix it returned undefined for every
    // tunnel tab no matter how well-formed the uuid was.
    const { bridge, port } = await tunnelBridge();
    await connectTab(port, POD_ORIGIN, "tab-pod-2");
    await waitForTab(bridge, "tab-pod-2");

    const identity = workflowIdentityParts({
      workflowUuid: WF_UUID_NEW,
      origin: bridge.tabServerOrigin("tab-pod-2"),
    });
    expect(identity).toBeDefined();
    expect(identity?.uuid).toBe(WF_UUID_NEW);
  });

  it("KEEPS the origin when the tab re-registers under a new workflow uuid", async () => {
    // The reported sequence, in full: a live pod tab re-hellos under a new
    // workflow tab id (save-as / open / switch), `panel_graph_outline` refuses on
    // the stale fence, and `mode:"current"` then has to adopt the live identity.
    // The re-hello arrives on the SAME socket with a DIFFERENT tab id, which is
    // the branch that decides whether `serverOrigin` survives the re-registration.
    const { bridge, port } = await tunnelBridge();
    const oldTab = `wf:route-1:${WF_UUID_OLD}`;
    const newTab = `wf:route-1:${WF_UUID_NEW}`;
    const sock = await connectTab(port, POD_ORIGIN, oldTab);
    await waitForTab(bridge, oldTab);
    expect(bridge.tabServerOrigin(oldTab)).toBe(POD_ORIGIN_NORMALIZED);

    sock.send(JSON.stringify({ type: "hello", tab_id: newTab, title: "wf (2)" }));
    await waitForTab(bridge, newTab);

    const origin = bridge.tabServerOrigin(newTab);
    expect(origin).toBe(POD_ORIGIN_NORMALIZED);
    // …and the NEW identity validates, so `mode:"current"` can adopt it.
    expect(workflowIdentityParts({ workflowUuid: WF_UUID_NEW, origin })?.uuid).toBe(WF_UUID_NEW);
  });

  it("does NOT make a tunnel/pairing tab trusted-local", async () => {
    // Reading the origin must not smuggle in transport trust: this listener is
    // token-gated and reachable off the machine, so `local` stays false and
    // nothing keyed on loopback placement changes.
    const { bridge, port } = await tunnelBridge();
    await connectTab(port, POD_ORIGIN, "tab-pod-3");
    await waitForTab(bridge, "tab-pod-3");

    expect(bridge.tabIsLocal("tab-pod-3")).toBe(false);
  });

  it("still reports NO origin for a client that sends no Origin header", async () => {
    // A non-browser client (a script, a CLI) presents no Origin, and the fix must
    // not invent one — the refusal it earns is accurate, and a fabricated origin
    // would scope a fence to an identity no other transport reproduces.
    const { bridge, port } = await tunnelBridge();
    await connectTab(port, undefined, "tab-cli-1");
    await waitForTab(bridge, "tab-cli-1");

    expect(bridge.tabServerOrigin("tab-cli-1")).toBeUndefined();
  });

  it("rejects an Origin that is not a bare, well-formed origin", async () => {
    // The value goes through the same `normalizeHandshakeOrigin` screen the
    // primary listener uses: a path-bearing or otherwise non-canonical spelling is
    // dropped rather than trimmed into something that looks trustworthy.
    const { bridge, port } = await tunnelBridge();
    await connectTab(port, "https://evil.example/path", "tab-bad-1");
    await waitForTab(bridge, "tab-bad-1");

    expect(bridge.tabServerOrigin("tab-bad-1")).toBeUndefined();
  });
});
