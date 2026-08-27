import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { createPanelTemplateRelayWiring } from "../../orchestrator/index.js";
import { requestPanelTemplateIndex, startPanelTemplateRelayServer } from "../../services/panel-template-relay.js";

const SECRET = "c".repeat(64);
const servers: Array<{ close(): Promise<void> }> = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  delete process.env.COMFYUI_MCP_RELAY_SECRET;
  delete process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL;
  for (const server of servers.splice(0)) await server.close();
});

describe("orchestrator panel template relay wiring (#2196)", () => {
  it("uses the production auth, scope-tab, URL, and current-target closures end to end", async () => {
    let target = "";
    let generation = 0;
    let observedOrigin = "";
    let panelRequests = 0;
    const panel = createServer((_req, res) => {
      panelRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ "panel-pack": [{ name: "live-template" }] }));
    });
    const panelOrigin = await listen(panel);
    servers.push({ close: () => closeServer(panel) });
    target = `${panelOrigin}/comfyapi`;
    observedOrigin = panelOrigin;

    const bridge = {
      canReach: () => true,
      resolveFailure: () => undefined,
      resolveSharedTabId: (scopeId: string) => {
        expect(scopeId).toBe("orchestrator::codex");
        return "tab-1";
      },
      tabServerOrigin: (tabId: string) => {
        expect(tabId).toBe("tab-1");
        return observedOrigin;
      },
    };
    const wiring = createPanelTemplateRelayWiring({
      bridge,
      currentTarget: () => target,
      currentTargetGeneration: () => generation,
      secrets: new Map([[SECRET, "orchestrator::codex"]]),
    });
    const relay = await startPanelTemplateRelayServer({ bridge, ...wiring });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    await expect(requestPanelTemplateIndex()).resolves.toEqual({
      "panel-pack": [{ name: "live-template" }],
    });
    expect(panelRequests).toBe(1);
    const resolvedTab = wiring.resolvePanelTab("orchestrator::codex");
    expect(resolvedTab).toBe("tab-1");
    expect(wiring.resolvePanelUrl(resolvedTab!, target)).toBe(
      `${panelOrigin}/comfyapi/api/workflow_templates`,
    );

    // A later target event invalidates the stale observed-origin pairing before
    // another child request can fetch from the old panel target.
    target = "http://127.0.0.1:1/other";
    await expect(requestPanelTemplateIndex()).rejects.toMatchObject({ code: "NO_PANEL_ORIGIN" });
    expect(panelRequests).toBe(1);
  });

  it("rejects forged and non-loopback origins through the production wiring", async () => {
    let target = "http://127.0.0.1:8188/comfyapi";
    let observedOrigin = "https://forged.example";
    const bridge = {
      canReach: () => true,
      resolveFailure: () => undefined,
      resolveSharedTabId: () => "tab-1",
      tabServerOrigin: () => observedOrigin,
    };
    const wiring = createPanelTemplateRelayWiring({
      bridge,
      currentTarget: () => target,
      currentTargetGeneration: () => 0,
      secrets: new Map([[SECRET, "orchestrator::codex"]]),
    });

    expect(wiring.resolveAllowedPanelOrigin("tab-1", target)).toBeUndefined();
    expect(wiring.resolvePanelUrl("tab-1", target)).toBeUndefined();

    observedOrigin = "http://[::1]:8188";
    expect(wiring.resolveAllowedPanelOrigin("tab-1", target)).toBeUndefined();
    expect(wiring.resolvePanelUrl("tab-1", target)).toBeUndefined();
    observedOrigin = "http://localhost:8188";
    expect(wiring.resolveAllowedPanelOrigin("tab-1", target)).toBeUndefined();
    expect(wiring.resolvePanelUrl("tab-1", target)).toBeUndefined();

    for (const origin of ["http://127.0.0.1:8188", "http://[::1]:8188", "http://localhost:8188"]) {
      target = `${origin}/comfyapi`;
      observedOrigin = origin;
      expect(wiring.resolveAllowedPanelOrigin("tab-1", target)).toBe(origin);
      expect(wiring.resolvePanelUrl("tab-1", target)).toBe(`${origin}/comfyapi/api/workflow_templates`);
    }

    target = "https://remote.example/comfyapi";
    observedOrigin = "https://remote.example";
    expect(wiring.resolveAllowedPanelOrigin("tab-1", target)).toBeUndefined();
    expect(wiring.resolvePanelUrl("tab-1", target)).toBeUndefined();

    const relay = await startPanelTemplateRelayServer({ bridge, ...wiring });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;
    await expect(requestPanelTemplateIndex()).rejects.toMatchObject({ code: "NO_PANEL_ORIGIN" });
  });

  // #2382/#2385. Dropping "localhost" from LOOPBACK_HOSTS made this request
  // fail NO_PANEL_ORIGIN, which shipped in 0.52.135 and is still live: #2387
  // documented the fail-closed rule but changed no behaviour here. Authorizing
  // the origin — rather than declining it — is also what keeps the fetch under
  // the relay's own generation fence, instead of handing it to a child that may
  // still hold the pre-retarget target (#1429).
  it("serves a localhost-served panel and still refuses a mixed localhost/127.0.0.1 pair", async () => {
    let panelRequests = 0;
    const panel = createServer((_req, res) => {
      panelRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ "panel-pack": [{ name: "localhost-template" }] }));
    });
    const panelOrigin = await listen(panel);
    servers.push({ close: () => closeServer(panel) });
    const port = new URL(panelOrigin).port;
    let target = `http://localhost:${port}/comfyapi`;
    const observedOrigin = `http://localhost:${port}`;
    const bridge = {
      canReach: () => true,
      resolveFailure: () => undefined,
      resolveSharedTabId: () => "tab-1",
      tabServerOrigin: () => observedOrigin,
    };
    const wiring = createPanelTemplateRelayWiring({
      bridge,
      currentTarget: () => target,
      currentTargetGeneration: () => 0,
      secrets: new Map([[SECRET, "orchestrator::codex"]]),
    });
    expect(wiring.resolveAllowedPanelOrigin("tab-1", target)).toBe(observedOrigin);
    expect(wiring.resolvePanelUrl("tab-1", target)).toBe(`${observedOrigin}/comfyapi/api/workflow_templates`);

    const relay = await startPanelTemplateRelayServer({ bridge, ...wiring });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;
    await expect(requestPanelTemplateIndex()).resolves.toMatchObject({
      "panel-pack": [{ name: "localhost-template" }],
    });
    expect(panelRequests).toBe(1);

    // A MIXED pair is a genuine mismatch, not a name ambiguity, and must stay a
    // hard refusal that never reaches the panel.
    target = `http://127.0.0.1:${port}/comfyapi`;
    expect(wiring.resolveAllowedPanelOrigin("tab-1", target)).toBeUndefined();
    expect(wiring.resolvePanelUrl("tab-1", target)).toBeUndefined();
    await expect(requestPanelTemplateIndex()).rejects.toMatchObject({ code: "NO_PANEL_ORIGIN" });
    expect(panelRequests).toBe(1);
  });

  it("rejects a stale in-flight response after retargeting and still serves the current target", async () => {
    let target = "";
    let generation = 0;
    let observedOrigin = "";
    let panelRequests = 0;
    let firstRequest = true;
    let markPanelRequestStarted!: () => void;
    const panelRequestStarted = new Promise<void>((resolve) => {
      markPanelRequestStarted = resolve;
    });
    let releaseFirstResponse!: () => void;
    const firstResponseReleased = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });
    const panel = createServer((_req, res) => {
      panelRequests += 1;
      if (firstRequest) {
        firstRequest = false;
        markPanelRequestStarted();
        void firstResponseReleased.then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ "old-panel-pack": [{ name: "stale-template" }] }));
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ "current-panel-pack": [{ name: "current-template" }] }));
    });
    const panelOrigin = await listen(panel);
    servers.push({ close: () => closeServer(panel) });
    target = `${panelOrigin}/comfyapi`;
    observedOrigin = panelOrigin;

    const bridge = {
      canReach: () => true,
      resolveFailure: () => undefined,
      resolveSharedTabId: (scopeId: string) => {
        expect(scopeId).toBe("orchestrator::codex");
        return "tab-1";
      },
      tabServerOrigin: (tabId: string) => {
        expect(tabId).toBe("tab-1");
        return observedOrigin;
      },
    };
    const wiring = createPanelTemplateRelayWiring({
      bridge,
      currentTarget: () => target,
      currentTargetGeneration: () => generation,
      secrets: new Map([[SECRET, "orchestrator::codex"]]),
    });
    const relay = await startPanelTemplateRelayServer({ bridge, ...wiring });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    const staleRequest = requestPanelTemplateIndex();
    await panelRequestStarted;
    target = "http://127.0.0.1:1/other";
    generation += 1;
    target = `${panelOrigin}/comfyapi`;
    generation += 1;
    releaseFirstResponse();

    // The target has returned to A, but the generation proves that the response
    // belongs to the earlier A and must not be served as current data.
    await expect(staleRequest).rejects.toMatchObject({ code: "STALE_TARGET" });
    expect(panelRequests).toBe(1);

    await expect(requestPanelTemplateIndex()).resolves.toEqual({
      "current-panel-pack": [{ name: "current-template" }],
    });
    expect(panelRequests).toBe(2);
  });
  // #2382 — the ambiguity is REMOVED, not refused. `localhost` authorizes the
  // origin, but the fetch is pinned to literal addresses, and when more than one
  // loopback address answers they must agree.
  it("pins a localhost fetch to a literal address and refuses two disagreeing listeners", async () => {
    const hits: string[] = [];
    const makeServer = (payload: string) =>
      createServer((req, res) => {
        hits.push(`${req.headers.host ?? "?"}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(payload);
      });
    // Bind the SAME port on both loopback families. Two distinct processes on a
    // dual-stack machine look exactly like this.
    const v4 = makeServer(JSON.stringify({ "v4-pack": [{ name: "from-127" }] }));
    await new Promise<void>((resolve, reject) => {
      v4.once("error", reject);
      v4.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
    });
    const addr = v4.address();
    if (!addr || typeof addr === "string") throw new Error("no bind");
    const port = addr.port;
    servers.push({ close: () => closeServer(v4) });

    const v6 = makeServer(JSON.stringify({ "v6-pack": [{ name: "from-::1" }] }));
    let v6Bound = true;
    await new Promise<void>((resolve) => {
      v6.once("error", () => { v6Bound = false; resolve(); });
      v6.listen({ host: "::1", port, ipv6Only: true }, () => resolve());
    });
    if (v6Bound) servers.push({ close: () => closeServer(v6) });

    const target = `http://localhost:${port}/comfyapi`;
    const observedOrigin = `http://localhost:${port}`;
    const bridge = {
      canReach: () => true,
      resolveFailure: () => undefined,
      resolveSharedTabId: () => "tab-1",
      tabServerOrigin: () => observedOrigin,
    };
    const wiring = createPanelTemplateRelayWiring({
      bridge,
      currentTarget: () => target,
      currentTargetGeneration: () => 0,
      secrets: new Map([[SECRET, "orchestrator::codex"]]),
    });
    // The origin is authorized — that is the half #2385 removed.
    expect(wiring.resolveAllowedPanelOrigin("tab-1", target)).toBe(observedOrigin);

    const relay = await startPanelTemplateRelayServer({ bridge, ...wiring });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    if (v6Bound) {
      // Two listeners, two different indexes: refuse rather than guess.
      await expect(requestPanelTemplateIndex()).rejects.toMatchObject({ code: "AMBIGUOUS_PANEL_LISTENER" });
    } else {
      await expect(requestPanelTemplateIndex()).resolves.toMatchObject({ "v4-pack": [{ name: "from-127" }] });
    }
    // Whatever happened, the NAME was never the destination: every request
    // arrived with a literal-address Host header.
    expect(hits.length).toBeGreaterThan(0);
    for (const host of hits) expect(host).not.toContain("localhost");
  });
  // #2382 — a listener that answers BADLY is still a listener. The pinned fetch
  // must not quietly prefer whichever address happened to return valid JSON:
  // the erroring one could be the real panel, and then we would be serving the
  // other process's index — the exact bug pinning exists to prevent.
  it("refuses when one loopback listener 503s and another returns a valid index", async () => {
    const v4 = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ "v4-pack": [{ name: "from-127" }] }));
    });
    await new Promise<void>((resolve, reject) => {
      v4.once("error", reject);
      v4.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
    });
    const addr = v4.address();
    if (!addr || typeof addr === "string") throw new Error("no bind");
    const port = addr.port;
    servers.push({ close: () => closeServer(v4) });

    const v6 = createServer((_req, res) => {
      res.writeHead(503);
      res.end("unavailable");
    });
    let v6Bound = true;
    await new Promise<void>((resolve) => {
      v6.once("error", () => { v6Bound = false; resolve(); });
      v6.listen({ host: "::1", port, ipv6Only: true }, () => resolve());
    });
    if (!v6Bound) return; // No IPv6 loopback here; nothing to disagree with.
    servers.push({ close: () => closeServer(v6) });

    const target = `http://localhost:${port}/comfyapi`;
    const observedOrigin = `http://localhost:${port}`;
    const bridge = {
      canReach: () => true,
      resolveFailure: () => undefined,
      resolveSharedTabId: () => "tab-1",
      tabServerOrigin: () => observedOrigin,
    };
    const relay = await startPanelTemplateRelayServer({
      bridge,
      ...createPanelTemplateRelayWiring({
        bridge,
        currentTarget: () => target,
        currentTargetGeneration: () => 0,
        secrets: new Map([[SECRET, "orchestrator::codex"]]),
      }),
    });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    // NOT the v4 index, even though v4 answered perfectly well.
    await expect(requestPanelTemplateIndex()).rejects.toMatchObject({ code: "AMBIGUOUS_PANEL_LISTENER" });
  });

  // #2392. The relay may be configured over https, so the question that issue
  // asks is whether an https `localhost` still re-resolves at request time. It
  // does not: the production origin gate declines an ambiguous NAME over TLS,
  // so no destination URL is ever produced and no socket is ever opened.
  //
  // These two drive the REAL orchestrator wiring. The existing https coverage
  // does not: the unit test calls currentPanelTemplateOrigin directly, and the
  // dns-pin test hands the relay a pre-authorized origin, which bypasses the
  // gate being asserted here. Nothing until now proved that PRODUCTION reaches
  // the refusal.
  it("refuses an https localhost origin through the production wiring, without opening a socket (#2392)", async () => {
    // Counting CONNECTIONS, not HTTP requests, is deliberate. A TLS fetch
    // against this plaintext listener would fail the handshake and never become
    // a request, so a request counter would read zero even if the fetch HAD
    // been issued -- it would pin nothing. A connection attempt cannot hide.
    let connections = 0;
    const listener = createSocketServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
    });
    const addr = listener.address();
    if (!addr || typeof addr === "string") throw new Error("no bind");
    const port = addr.port;
    servers.push({ close: () => new Promise<void>((resolve) => { listener.close(() => resolve()); }) });

    const observedOrigin = `https://localhost:${port}`;
    const target = `${observedOrigin}/comfyapi`;
    const bridge = {
      canReach: () => true,
      resolveFailure: () => undefined,
      resolveSharedTabId: () => "tab-1",
      tabServerOrigin: () => observedOrigin,
    };
    const wiring = createPanelTemplateRelayWiring({
      bridge,
      currentTarget: () => target,
      currentTargetGeneration: () => 0,
      secrets: new Map([[SECRET, "orchestrator::codex"]]),
    });
    const relay = await startPanelTemplateRelayServer({ bridge, ...wiring });
    servers.push(relay);
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_TEMPLATE_RELAY_URL = relay.endpointUrl;

    // Ordered so that each assertion below can be the one that fails. Asserting
    // the error code first would mask the socket count: both refusal clauses
    // raise NO_PANEL_ORIGIN, so the code is identical whether the request was
    // declined at the gate or after a second resolution.
    const outcome = await requestPanelTemplateIndex().then(() => undefined, (error: unknown) => error);
    // Load-bearing: nothing was contacted, so there was no second resolution.
    // Fails if BOTH refusal clauses go -- the fetch then reaches this listener.
    expect(connections).toBe(0);
    expect(outcome).toMatchObject({ code: "NO_PANEL_ORIGIN" });
    // Load-bearing: the gate itself, through the production closures. Fails if
    // the origin-gate clause goes, even while the deeper one still refuses.
    expect(wiring.resolveAllowedPanelOrigin("tab-1", target)).toBeUndefined();
    expect(wiring.resolvePanelUrl("tab-1", target)).toBeUndefined();
  });

  it("still authorizes an https LITERAL loopback origin, which has no name to re-resolve (#2392)", async () => {
    // The refusal above is about the ambiguous NAME, not about TLS. A literal
    // host is pinned by construction -- there is no second resolution to
    // disagree with -- so https stays a permitted relay configuration. Without
    // this, the refusal test above would also pass if https were banned
    // outright, which is a different and wrong behaviour.
    const observedOrigin = "https://127.0.0.1:8188";
    const target = `${observedOrigin}/comfyapi`;
    const bridge = {
      canReach: () => true,
      resolveFailure: () => undefined,
      resolveSharedTabId: () => "tab-1",
      tabServerOrigin: () => observedOrigin,
    };
    const wiring = createPanelTemplateRelayWiring({
      bridge,
      currentTarget: () => target,
      currentTargetGeneration: () => 0,
      secrets: new Map([[SECRET, "orchestrator::codex"]]),
    });
    expect(wiring.resolveAllowedPanelOrigin("tab-1", target)).toBe(observedOrigin);
    expect(wiring.resolvePanelUrl("tab-1", target)).toBe(
      `${observedOrigin}/comfyapi/api/workflow_templates`,
    );
  });
});
