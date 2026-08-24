import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PANEL_IMAGE_RELAY_MAX_BYTES,
  PANEL_IMAGE_RELAY_MAX_CONCURRENT,
  PANEL_IMAGE_RELAY_MAX_PENDING_REQUESTS,
  PANEL_IMAGE_RELAY_MAX_PENDING_RESPONSES,
  PANEL_IMAGE_RELAY_MAX_REQUEST_FILE_BYTES,
  PANEL_IMAGE_RELAY_MAX_REQUESTS_PER_TICK,
  PANEL_IMAGE_RELAY_HTTP_PATH,
  PANEL_IMAGE_RELAY_TIMEOUT_MS,
  PANEL_IMAGE_RELAY_REQUEST_PREFIX,
  PANEL_IMAGE_RELAY_RESPONSE_PREFIX,
  PANEL_IMAGE_RELAY_STALE_MS,
  makePanelImageRelayCapability,
  processPanelImageRequests,
  requestPanelImageFromFileChannel,
  requestPanelImage,
  startPanelImageRelayServer,
  verifyPanelImageRelayCapability,
  type PanelImageRelayRequest,
} from "../../services/panel-image-relay.js";

const dirs: string[] = [];
const SECRET = "a".repeat(64);

function tempChannel(): string {
  const dir = mkdtempSync(join(tmpdir(), "comfyui-mcp-image-relay-"));
  dirs.push(dir);
  return dir;
}

function request(id: string, patch: Partial<PanelImageRelayRequest> = {}): PanelImageRelayRequest {
  const createdAt = Date.now();
  const { capability: patchedCapability, ...restPatch } = patch;
  const value = {
    version: 1,
    requestId: id,
    filename: "render.png",
    subfolder: "shots",
    type: "output",
    createdAt,
    deadlineAt: createdAt + 8_000,
    ...restPatch,
  };
  if (!("deadlineAt" in patch)) value.deadlineAt = value.createdAt + 8_000;
  return {
    ...value,
    capability: patchedCapability ?? makePanelImageRelayCapability(SECRET, value),
  };
}

function requestFile(dir: string, id: string): string {
  return join(dir, `${PANEL_IMAGE_RELAY_REQUEST_PREFIX}${id}.json`);
}

function responseFile(dir: string, id: string): string {
  return join(dir, `${PANEL_IMAGE_RELAY_RESPONSE_PREFIX}${id}.json`);
}

function readResponse(dir: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(responseFile(dir, id), "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.COMFYUI_MCP_PROGRESS_DIR;
  delete process.env.COMFYUI_MCP_TAB;
  delete process.env.COMFYUI_MCP_RELAY_SECRET;
  delete process.env.COMFYUI_MCP_RELAY_URL;
  vi.restoreAllMocks();
});

describe("panel image relay child channel", () => {
  it("writes only a bounded reference and accepts the exact panel result contract", async () => {
    const dir = tempChannel();
    process.env.COMFYUI_MCP_PROGRESS_DIR = dir;
    process.env.COMFYUI_MCP_TAB = "orchestrator::claude";
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    const pending = requestPanelImageFromFileChannel("render.png", "output", "shots");
    let file = "";
    for (let i = 0; i < 100 && !file; i += 1) {
      file = readdirSync(dir).find((name) => name.startsWith(PANEL_IMAGE_RELAY_REQUEST_PREFIX)) ?? "";
      if (!file) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(file).not.toBe("");
    const requestBody = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    expect(Object.keys(requestBody).sort()).toEqual([
      "capability",
      "createdAt",
      "deadlineAt",
      "filename",
      "requestId",
      "subfolder",
      "type",
      "version",
    ]);
    expect(requestBody).not.toHaveProperty("url");
    const id = String(requestBody.requestId);
    writeFileSync(responseFile(dir, id), JSON.stringify({
      version: 1,
      requestId: id,
      ok: true,
      base64: "AQID",
      mimeType: "image/png",
      bytes: 3,
      updated: Date.now(),
    }));
    await expect(pending).resolves.toEqual({ base64: "AQID", mimeType: "image/png", bytes: 3 });
  });

  it.each([
    ["../escape.png", "", "output"],
    ["render.png", "shots\\nested", "output"],
    ["render.png", "shots/../nested", "output"],
    ["render.png", "shots", "other"],
  ])("rejects unsafe reference %s / %s / %s before writing", async (filename, subfolder, type) => {
    const dir = tempChannel();
    process.env.COMFYUI_MCP_PROGRESS_DIR = dir;
    process.env.COMFYUI_MCP_TAB = "orchestrator::claude";
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    await expect(requestPanelImageFromFileChannel(filename, type as "output", subfolder)).rejects.toMatchObject({ code: "UNSAFE_REFERENCE" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("does not authorize the relay from COMFYUI_MCP_TAB alone", async () => {
    const dir = tempChannel();
    process.env.COMFYUI_MCP_PROGRESS_DIR = dir;
    process.env.COMFYUI_MCP_TAB = "orchestrator::victim";
    delete process.env.COMFYUI_MCP_RELAY_SECRET;
    await expect(requestPanelImageFromFileChannel("render.png", "output", "shots")).resolves.toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("rejects a malformed response instead of accepting a URL-shaped field", async () => {
    const dir = tempChannel();
    process.env.COMFYUI_MCP_PROGRESS_DIR = dir;
    process.env.COMFYUI_MCP_TAB = "orchestrator::claude";
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    const pending = requestPanelImageFromFileChannel("render.png", "output", "shots");
    let file = "";
    for (let i = 0; i < 100 && !file; i += 1) {
      file = readdirSync(dir).find((name) => name.startsWith(PANEL_IMAGE_RELAY_REQUEST_PREFIX)) ?? "";
      if (!file) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const id = file.slice(PANEL_IMAGE_RELAY_REQUEST_PREFIX.length, -5);
    writeFileSync(responseFile(dir, id), JSON.stringify({
      version: 1,
      requestId: id,
      ok: true,
      url: "http://127.0.0.1:9/secret",
      base64: "AQID",
      mimeType: "image/png",
      bytes: 3,
      updated: Date.now(),
    }));
    await expect(pending).rejects.toMatchObject({ code: "MALFORMED_REPLY" });
  });

  it("moves a symlinked response into private staging without opening its target", async () => {
    const dir = tempChannel();
    process.env.COMFYUI_MCP_PROGRESS_DIR = dir;
    process.env.COMFYUI_MCP_TAB = "orchestrator::claude";
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    const pending = requestPanelImageFromFileChannel("render.png", "output", "shots");
    let file = "";
    for (let i = 0; i < 100 && !file; i += 1) {
      file = readdirSync(dir).find((name) => name.startsWith(PANEL_IMAGE_RELAY_REQUEST_PREFIX)) ?? "";
      if (!file) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const body = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    const id = String(body.requestId);
    const target = join(dir, "response-target.json");
    writeFileSync(target, JSON.stringify({
      version: 1,
      requestId: id,
      ok: true,
      base64: "AQID",
      mimeType: "image/png",
      bytes: 3,
      updated: Date.now(),
    }));
    let symlinkSupported = true;
    try {
      symlinkSync(target, responseFile(dir, id), "file");
    } catch {
      symlinkSupported = false;
      writeFileSync(responseFile(dir, id), readFileSync(target));
    }
    if (symlinkSupported) {
      await expect(pending).rejects.toMatchObject({ code: "MALFORMED_REPLY" });
      expect(readFileSync(target, "utf8")).toContain('"ok":true');
    } else {
      await expect(pending).resolves.toMatchObject({ base64: "AQID" });
    }
  });

  it("does not accept a response discovered after the single end-to-end deadline", async () => {
    const dir = tempChannel();
    process.env.COMFYUI_MCP_PROGRESS_DIR = dir;
    process.env.COMFYUI_MCP_TAB = "orchestrator::claude";
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    const pending = requestPanelImageFromFileChannel("render.png", "output", "shots");
    let file = "";
    for (let i = 0; i < 100 && !file; i += 1) {
      file = readdirSync(dir).find((name) => name.startsWith(PANEL_IMAGE_RELAY_REQUEST_PREFIX)) ?? "";
      if (!file) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const body = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    const id = String(body.requestId);
    writeFileSync(responseFile(dir, id), JSON.stringify({
      version: 1,
      requestId: id,
      ok: true,
      base64: "AQID",
      mimeType: "image/png",
      bytes: 3,
      updated: Number(body.deadlineAt) + 1,
    }));
    await expect(pending).rejects.toMatchObject({ code: "STALE_REPLY" });
  });

  it("validates failure freshness before preserving the panel failure code", async () => {
    const dir = tempChannel();
    process.env.COMFYUI_MCP_PROGRESS_DIR = dir;
    process.env.COMFYUI_MCP_TAB = "orchestrator::claude";
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    const pending = requestPanelImageFromFileChannel("render.png", "output", "shots");
    let file = "";
    for (let i = 0; i < 100 && !file; i += 1) {
      file = readdirSync(dir).find((name) => name.startsWith(PANEL_IMAGE_RELAY_REQUEST_PREFIX)) ?? "";
      if (!file) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const body = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    const id = String(body.requestId);
    writeFileSync(responseFile(dir, id), JSON.stringify({
      version: 1,
      requestId: id,
      ok: false,
      error: "HTTP_404",
      updated: Number(body.deadlineAt) + 1,
    }));
    await expect(pending).rejects.toMatchObject({ code: "STALE_REPLY" });
  });
});

describe("panel image relay orchestrator poll", () => {
  it("resolves a shared agent key to its pinned live panel and sends only the reference command", async () => {
    const dir = tempChannel();
    const id = "request-1234567890";
    writeFileSync(requestFile(dir, id), JSON.stringify(request(id)));
    const send = vi.fn(async (command: unknown, options: unknown) => {
      expect(command).toEqual({ cmd: "fetch_image", filename: "render.png", subfolder: "shots", type: "output" });
      expect(command).not.toHaveProperty("url");
      expect(options).toMatchObject({ tabId: "pinned-live-panel" });
      expect((options as { timeoutMs: number }).timeoutMs).toBeGreaterThan(0);
      expect((options as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(8_000);
      return { ok: true, base64: "AQID", mimeType: "image/png", bytes: 3 };
    });
    await processPanelImageRequests({
      dir,
      resolvePanelAgentKey: (value) => {
        expect(value.capability).toBe(makePanelImageRelayCapability(SECRET, value));
        return "orchestrator::claude";
      },
      resolvePanelTab: (agentKey) => {
        expect(agentKey).toBe("orchestrator::claude");
        // This is the production scopeToRealTab result for the shared key:
        // bridge.resolveSharedTabId("orchestrator::claude").
        return "pinned-live-panel";
      },
      bridge: { canReach: () => true, send },
    });
    expect(send).toHaveBeenCalledOnce();
    expect(readResponse(dir, id)).toMatchObject({ ok: true, base64: "AQID", mimeType: "image/png", bytes: 3 });
    expect(readdirSync(dir).some((name) => name === requestFile(dir, id))).toBe(false);
  });

  it("fails closed for missing or ambiguous live panel routing", async () => {
    for (const failure of ["NO_LIVE_PANEL", "AMBIGUOUS_REQUESTER"] as const) {
      const dir = tempChannel();
      const id = `request-${failure.toLowerCase()}-123456`;
      writeFileSync(requestFile(dir, id), JSON.stringify(request(id)));
      const send = vi.fn();
      await processPanelImageRequests({
        dir,
        resolvePanelAgentKey: () => "orchestrator::claude",
        resolvePanelTab: () => failure === "NO_LIVE_PANEL" ? undefined : "panel-tab",
        bridge: {
          canReach: () => false,
          resolveFailure: () => (failure === "AMBIGUOUS_REQUESTER" ? "ambiguous" : "unresolved"),
          send,
        },
      });
      expect(send).not.toHaveBeenCalled();
      expect(readResponse(dir, id)).toMatchObject({ ok: false, error: failure });
      rmSync(dir, { recursive: true, force: true });
      dirs.splice(dirs.indexOf(dir), 1);
    }
  });

  it("rejects malformed, oversized, and HTTP-error panel replies", async () => {
    const cases = [
      { reply: { ok: true, base64: "not-base64", mimeType: "image/png", bytes: 3 }, error: "MALFORMED_REPLY" },
      { reply: { ok: true, base64: "AQID", mimeType: "image/png", bytes: PANEL_IMAGE_RELAY_MAX_BYTES + 1 }, error: "MALFORMED_REPLY" },
      { reply: { ok: false, error: "HTTP_404" }, error: "PANEL_FETCH_FAILED" },
    ];
    for (const [index, testCase] of cases.entries()) {
      const dir = tempChannel();
      const id = `reply-case-${index}-123456789`;
      writeFileSync(requestFile(dir, id), JSON.stringify(request(id)));
      await processPanelImageRequests({
        dir,
        resolvePanelAgentKey: () => "orchestrator::claude",
        resolvePanelTab: () => "panel-tab",
        bridge: { canReach: () => true, send: async () => testCase.reply },
      });
      expect(readResponse(dir, id), `case ${index}`).toMatchObject({ ok: false, error: testCase.error });
      rmSync(dir, { recursive: true, force: true });
      dirs.splice(dirs.indexOf(dir), 1);
    }
  });

  it("rejects stale requests and requests containing a URL", async () => {
    const dir = tempChannel();
    const staleId = "stale-request-123456";
    writeFileSync(requestFile(dir, staleId), JSON.stringify(request(staleId, { createdAt: Date.now() - PANEL_IMAGE_RELAY_STALE_MS - 1 })));
    const forgedId = "forged-url-1234567";
    writeFileSync(requestFile(dir, forgedId), JSON.stringify({ ...request(forgedId), url: "http://127.0.0.1:9/secret" }));
    const send = vi.fn();
    await processPanelImageRequests({ dir, resolvePanelAgentKey: () => "orchestrator::claude", resolvePanelTab: () => "panel-tab", bridge: { canReach: () => true, send } });
    expect(readResponse(dir, staleId)).toMatchObject({ ok: false, error: "TIMEOUT" });
    expect(readResponse(dir, forgedId)).toMatchObject({ ok: false, error: "MALFORMED_REQUEST" });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not accept a file-supplied requester or an unknown capability", async () => {
    const dir = tempChannel();
    const forgedId = "forged-requester-123456";
    writeFileSync(requestFile(dir, forgedId), JSON.stringify({ ...request(forgedId), requester: "orchestrator::victim" }));
    const unknownId = "unknown-capability-123456";
    writeFileSync(requestFile(dir, unknownId), JSON.stringify(request(unknownId, { capability: "b".repeat(64) })));
    const send = vi.fn();
    await processPanelImageRequests({
      dir,
      resolvePanelAgentKey: (value) => value.capability === makePanelImageRelayCapability(SECRET, value) ? "orchestrator::claude" : undefined,
      resolvePanelTab: () => "victim-panel",
      bridge: { canReach: () => true, send },
    });
    expect(send).not.toHaveBeenCalled();
    expect(readResponse(dir, forgedId)).toMatchObject({ ok: false, error: "MALFORMED_REQUEST" });
    expect(readResponse(dir, unknownId)).toMatchObject({ ok: false, error: "NO_LIVE_PANEL" });
  });

  it("carries one deadline through the bridge and refuses a late panel result", async () => {
    const dir = tempChannel();
    const id = "deadline-race-123456";
    const createdAt = Date.now();
    writeFileSync(requestFile(dir, id), JSON.stringify(request(id, {
      createdAt,
      deadlineAt: createdAt + 50,
    })));
    let timeoutMs = 0;
    await processPanelImageRequests({
      dir,
      resolvePanelAgentKey: () => "orchestrator::claude",
      resolvePanelTab: () => "panel-tab",
      bridge: {
        canReach: () => true,
        send: async (_command, options) => {
          timeoutMs = options.timeoutMs;
          await new Promise((resolve) => setTimeout(resolve, 75));
          return { ok: true, base64: "AQID", mimeType: "image/png", bytes: 3 };
        },
      },
    });
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(50);
    expect(readResponse(dir, id)).toMatchObject({ ok: false, error: "TIMEOUT" });
  });

  it("bounds per-tick concurrency and fails closed when the request backlog is full", async () => {
    const dir = tempChannel();
    const ids = Array.from({ length: PANEL_IMAGE_RELAY_MAX_PENDING_REQUESTS + 8 }, (_, index) =>
      `flood-${index}-1234567890`,
    );
    for (const id of ids) writeFileSync(requestFile(dir, id), JSON.stringify(request(id)));
    let active = 0;
    let maxActive = 0;
    let sends = 0;
    await processPanelImageRequests({
      dir,
      resolvePanelAgentKey: () => "orchestrator::claude",
      resolvePanelTab: () => "panel-tab",
      bridge: {
        canReach: () => true,
        send: async () => {
          active += 1;
          sends += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
          return { ok: true, base64: "AQID", mimeType: "image/png", bytes: 3 };
        },
      },
    });
    expect(maxActive).toBeLessThanOrEqual(PANEL_IMAGE_RELAY_MAX_CONCURRENT);
    expect(sends).toBe(PANEL_IMAGE_RELAY_MAX_REQUESTS_PER_TICK);
    const remainingRequests = readdirSync(dir).filter((name) => name.startsWith(PANEL_IMAGE_RELAY_REQUEST_PREFIX));
    expect(remainingRequests.length).toBe(PANEL_IMAGE_RELAY_MAX_PENDING_REQUESTS - PANEL_IMAGE_RELAY_MAX_REQUESTS_PER_TICK);
    const backlogFailures = ids.filter((id) => {
      try { return readResponse(dir, id).error === "BACKLOG_FULL"; } catch { return false; }
    });
    expect(backlogFailures.length).toBe(ids.length - PANEL_IMAGE_RELAY_MAX_PENDING_REQUESTS);
  });

  it("does not dispatch more panel fetches while bounded response slots are occupied", async () => {
    const dir = tempChannel();
    for (let index = 0; index < PANEL_IMAGE_RELAY_MAX_PENDING_RESPONSES; index += 1) {
      const id = `held-response-${index}-123456`;
      writeFileSync(responseFile(dir, id), JSON.stringify({ version: 1, requestId: id, ok: false, error: "PANEL_FETCH_FAILED", updated: Date.now() }));
    }
    const id = "response-cap-request-123456";
    writeFileSync(requestFile(dir, id), JSON.stringify(request(id)));
    const send = vi.fn();
    await processPanelImageRequests({ dir, resolvePanelAgentKey: () => "orchestrator::claude", resolvePanelTab: () => "panel-tab", bridge: { canReach: () => true, send } });
    expect(send).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toContain(`control-image-request-${id}.json`);
  });

  it("rejects oversized and symlinked request files before bridge dispatch", async () => {
    const dir = tempChannel();
    const oversizedId = "oversized-request-123456";
    const oversizedPath = requestFile(dir, oversizedId);
    writeFileSync(oversizedPath, "{}");
    truncateSync(oversizedPath, PANEL_IMAGE_RELAY_MAX_REQUEST_FILE_BYTES + 1);

    const targetPath = join(dir, "ordinary-target.json");
    writeFileSync(targetPath, JSON.stringify(request("symlink-request-123456")));
    const symlinkId = "symlink-request-123456";
    const symlinkPath = requestFile(dir, symlinkId);
    let symlinksSupported = true;
    try {
      symlinkSync(targetPath, symlinkPath, "file");
    } catch {
      symlinksSupported = false;
    }

    const send = vi.fn();
    await processPanelImageRequests({ dir, resolvePanelAgentKey: () => "orchestrator::claude", resolvePanelTab: () => "panel-tab", bridge: { canReach: () => true, send } });
    expect(send).not.toHaveBeenCalled();
    expect(readResponse(dir, oversizedId)).toMatchObject({ ok: false, error: "MALFORMED_REQUEST" });
    if (symlinksSupported) expect(readdirSync(dir)).not.toContain(`control-image-response-${symlinkId}.json`);
  });

  it("reaps stale and oversized response files without reading them", async () => {
    const dir = tempChannel();
    const stale = join(dir, `${PANEL_IMAGE_RELAY_RESPONSE_PREFIX}stale-response-123456.json`);
    const oversized = join(dir, `${PANEL_IMAGE_RELAY_RESPONSE_PREFIX}oversized-response-123456.json`);
    writeFileSync(stale, "{}");
    writeFileSync(oversized, "");
    const old = (Date.now() - PANEL_IMAGE_RELAY_STALE_MS - 1) / 1000;
    utimesSync(stale, old, old);
    truncateSync(oversized, 48 * 1024 * 1024 + 1);
    await processPanelImageRequests({ dir, resolvePanelAgentKey: () => "orchestrator::claude", resolvePanelTab: () => "panel-tab", bridge: { canReach: () => false, send: vi.fn() } });
    expect(readdirSync(dir)).not.toContain(stale.split("\\").at(-1));
    expect(readdirSync(dir)).not.toContain(oversized.split("\\").at(-1));
  });
});

describe("authenticated loopback panel image relay", () => {
  it("uses only the explicit IPv4 loopback endpoint and reaches the pinned shared panel", async () => {
    const send = vi.fn(async (command: unknown, options: unknown) => {
      expect(command).toEqual({ cmd: "fetch_image", filename: "render.png", subfolder: "shots", type: "output" });
      expect(options).toMatchObject({ tabId: "pinned-live-panel" });
      return { ok: true, base64: "AQID", mimeType: "image/png", bytes: 3 };
    });
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: (value) => verifyPanelImageRelayCapability(SECRET, value) ? { agentKey: "orchestrator::claude", secret: SECRET } : undefined,
      resolvePanelTab: (agentKey) => agentKey === "orchestrator::claude" ? "pinned-live-panel" : undefined,
      bridge: { canReach: () => true, send },
    });
    try {
      expect(new URL(server.endpointUrl).hostname).toBe("127.0.0.1");
      expect(new URL(server.endpointUrl).pathname).toBe(PANEL_IMAGE_RELAY_HTTP_PATH);
      process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
      process.env.COMFYUI_MCP_RELAY_URL = server.endpointUrl;
      process.env.COMFYUI_MCP_PROGRESS_DIR = join(tmpdir(), "this-file-channel-must-not-be-read");
      await expect(requestPanelImage("render.png", "output", "shots")).resolves.toEqual({
        base64: "AQID",
        mimeType: "image/png",
        bytes: 3,
      });
      expect(send).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("rejects forged HMACs before resolving or dispatching a panel tab", async () => {
    const send = vi.fn();
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: (value) => verifyPanelImageRelayCapability(SECRET, value) ? { agentKey: "orchestrator::claude", secret: SECRET } : undefined,
      resolvePanelTab: () => "victim-panel",
      bridge: { canReach: () => true, send },
    });
    try {
      const forged = request("forged-hmac-123456789", { capability: "b".repeat(64) });
      const response = await fetch(server.endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(forged),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ ok: false, error: "UNAUTHORIZED" });
      expect(send).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("binds the child result to the request id and response MAC", async () => {
    const fake = createServer((_req, res) => {
      const body = JSON.stringify({
        version: 1,
        requestId: "different-request-123456",
        ok: true,
        base64: "AQID",
        mimeType: "image/png",
        bytes: 3,
        updated: Date.now(),
        responseMac: "a".repeat(64),
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
      res.end(body);
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const address = fake.address();
    if (!address || typeof address === "string") throw new Error("fake relay did not bind");
    try {
      process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
      process.env.COMFYUI_MCP_RELAY_URL = `http://127.0.0.1:${address.port}${PANEL_IMAGE_RELAY_HTTP_PATH}`;
      await expect(requestPanelImage("render.png", "output", "shots")).rejects.toMatchObject({ code: "MALFORMED_REPLY" });
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });

  it("rejects a response with the right request id but a forged response MAC", async () => {
    const fake = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { requestId: string };
        const body = JSON.stringify({
          version: 1,
          requestId: input.requestId,
          ok: true,
          base64: "AQID",
          mimeType: "image/png",
          bytes: 3,
          updated: Date.now(),
          responseMac: "b".repeat(64),
        });
        res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const address = fake.address();
    if (!address || typeof address === "string") throw new Error("fake relay did not bind");
    try {
      process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
      process.env.COMFYUI_MCP_RELAY_URL = `http://127.0.0.1:${address.port}${PANEL_IMAGE_RELAY_HTTP_PATH}`;
      await expect(requestPanelImage("render.png", "output", "shots")).rejects.toMatchObject({ code: "MALFORMED_REPLY" });
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });

  it("classifies an authenticated server TIMEOUT before deadline freshness", async () => {
    const fake = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { requestId: string };
        const updated = Date.now() + PANEL_IMAGE_RELAY_TIMEOUT_MS * 2;
        const unsigned = {
          version: 1,
          requestId: input.requestId,
          ok: false,
          error: "TIMEOUT",
          updated,
        } as const;
        const responseMac = createHmac("sha256", SECRET)
          .update(JSON.stringify([unsigned.version, unsigned.requestId, false, unsigned.error, unsigned.updated]))
          .digest("hex");
        const body = JSON.stringify({ ...unsigned, responseMac });
        res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const address = fake.address();
    if (!address || typeof address === "string") throw new Error("fake relay did not bind");
    try {
      process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
      process.env.COMFYUI_MCP_RELAY_URL = `http://127.0.0.1:${address.port}${PANEL_IMAGE_RELAY_HTTP_PATH}`;
      await expect(requestPanelImage("render.png", "output", "shots")).rejects.toMatchObject({ code: "TIMEOUT" });
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });

  it("enforces the single request deadline around bridge.send", async () => {
    let timeoutMs = 0;
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: (value) => verifyPanelImageRelayCapability(SECRET, value) ? { agentKey: "orchestrator::claude", secret: SECRET } : undefined,
      resolvePanelTab: () => "panel-tab",
      bridge: {
        canReach: () => true,
        send: async (_command, options) => {
          timeoutMs = options.timeoutMs;
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { ok: true, base64: "AQID", mimeType: "image/png", bytes: 3 };
        },
      },
    });
    try {
      const createdAt = Date.now();
      const short = request("short-deadline-123456", { createdAt, deadlineAt: createdAt + 30 });
      const response = await fetch(server.endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(short),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: false, error: "TIMEOUT", requestId: short.requestId });
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(30);
    } finally {
      await server.close();
    }
  });

  it("rejects oversized HTTP requests and overloads without unbounded work", async () => {
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: () => ({ agentKey: "orchestrator::claude", secret: SECRET }),
      resolvePanelTab: () => "panel-tab",
      bridge: { canReach: () => true, send: vi.fn() },
    });
    try {
      const oversized = await fetch(server.endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(20 * 1024) },
        body: "x".repeat(20 * 1024),
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toMatchObject({ error: "REQUEST_TOO_LARGE" });
    } finally {
      await server.close();
    }
  });
});
