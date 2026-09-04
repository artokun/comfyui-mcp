import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PANEL_COMFYUI_READ_MAX_BYTES,
  PANEL_COMFYUI_READ_OBJECT_INFO_MAX_BYTES,
  PANEL_COMFYUI_READ_OBJECT_INFO_TIMEOUT_MS,
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
  makePanelComfyUIReadRelayCapability,
  processPanelImageRequests,
  requestPanelImageFromFileChannel,
  requestPanelImage,
  requestPanelComfyUIRead,
  startPanelImageRelayServer,
  verifyPanelImageRelayCapability,
  verifyPanelComfyUIReadRelayCapability,
  isPanelComfyUIReadOperation,
  type PanelComfyUIReadRelayRequest,
  type PanelImageRelayRequest,
} from "../../services/panel-image-relay.js";

const dirs: string[] = [];
const SECRET = "a".repeat(64);
const TARGET_URL = "http://127.0.0.1:8188";
const OTHER_TARGET_URL = "http://127.0.0.1:8189";
const TARGET_GENERATION = 7;
const PRODUCTION_OBJECT_INFO_DELAY_MS = 20_841;

/** Model the Panel bridge's command dispatcher at the wire boundary: the MCP
 * relay must send the authenticated command, tab binding, and route-specific
 * deadline through this call before a Panel reply can exist. The delayed
 * producer honors that deadline, so a regression to the generic 8s budget
 * fails this documented 20.841s success case instead of merely recording it. */
function productionShapedPanelDispatcher(
  body: string,
  recordTimeout: (timeoutMs: number) => void,
): (command: { cmd: string; operation: string }, options: { tabId: string; timeoutMs: number }) => Promise<Record<string, unknown>> {
  return async (command, options) => {
    expect(command).toEqual({ cmd: "fetch_comfyui_read", operation: "object_info" });
    expect(options.tabId).toBe("panel-tab");
    recordTimeout(options.timeoutMs);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let deadlineTimer: ReturnType<typeof setTimeout>;
      let producerTimer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        clearTimeout(producerTimer);
        if (error) reject(error);
        else resolve();
      };
      deadlineTimer = setTimeout(
        () => finish(Object.assign(new Error("Panel bridge command timed out"), { code: "TIMEOUT" })),
        options.timeoutMs,
      );
      producerTimer = setTimeout(() => finish(), PRODUCTION_OBJECT_INFO_DELAY_MS);
    });
    return {
      operation: "object_info",
      body,
      contentType: "application/json",
      bytes: Buffer.byteLength(body, "utf8"),
      viewing: {
        scope: "root",
        workflow_uuid: "workflow-live-2283",
        graph_identity: "graph:live-2283",
      },
    };
  };
}

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
    targetUrl: TARGET_URL,
    targetGeneration: TARGET_GENERATION,
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

function readRequest(id: string, operation: PanelComfyUIReadRelayRequest["operation"]): PanelComfyUIReadRelayRequest {
  const createdAt = Date.now();
  const value = {
    version: 1 as const,
    requestId: id,
    targetUrl: TARGET_URL,
    targetGeneration: TARGET_GENERATION,
    operation,
    createdAt,
    deadlineAt: createdAt + 8_000,
  };
  return {
    ...value,
    capability: makePanelComfyUIReadRelayCapability(SECRET, value),
  };
}

function responseFile(dir: string, id: string): string {
  return join(dir, `${PANEL_IMAGE_RELAY_RESPONSE_PREFIX}${id}.json`);
}

function readResponse(dir: string, id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(responseFile(dir, id), "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  process.env.COMFYUI_URL = TARGET_URL;
  process.env.COMFYUI_MCP_TARGET_GENERATION = String(TARGET_GENERATION);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.COMFYUI_MCP_PROGRESS_DIR;
  delete process.env.COMFYUI_MCP_TAB;
  delete process.env.COMFYUI_MCP_RELAY_SECRET;
  delete process.env.COMFYUI_MCP_RELAY_URL;
  delete process.env.COMFYUI_URL;
  delete process.env.COMFYUI_MCP_TARGET_GENERATION;
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
      "targetGeneration",
      "targetUrl",
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
      resolveCurrentTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      resolvePanelTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
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

  it("rejects a previous target before resolving or dispatching the live panel", async () => {
    const resolvePanelTab = vi.fn(() => "victim-panel");
    const send = vi.fn();
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: (value) => verifyPanelImageRelayCapability(SECRET, value) ? { agentKey: "orchestrator::claude", secret: SECRET } : undefined,
      resolvePanelTab,
      resolveCurrentTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      resolvePanelTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      bridge: { canReach: () => true, send },
    });
    try {
      const stale = request("stale-target-123456", {
        targetUrl: TARGET_URL,
        targetGeneration: TARGET_GENERATION - 1,
      });
      const response = await fetch(server.endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(stale),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: false, error: "STALE_TARGET", requestId: stale.requestId });
      expect(resolvePanelTab).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("refuses a valid target-B capability when the selected panel tab proves target A", async () => {
    const send = vi.fn();
    const resolvePanelTarget = vi.fn(() => ({ url: OTHER_TARGET_URL, generation: TARGET_GENERATION }));
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: (value) => verifyPanelImageRelayCapability(SECRET, value) ? { agentKey: "orchestrator::claude", secret: SECRET } : undefined,
      resolvePanelTab: () => "panel-A",
      resolveCurrentTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      resolvePanelTarget,
      bridge: { canReach: () => true, send },
    });
    try {
      const targetB = request("cross-target-123456", { targetUrl: TARGET_URL, targetGeneration: TARGET_GENERATION });
      const response = await fetch(server.endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(targetB),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: false, error: "STALE_TARGET", requestId: targetB.requestId });
      expect(resolvePanelTarget).toHaveBeenCalledWith("panel-A");
      expect(send).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("refuses missing or ambiguous per-tab target proof before dispatch", async () => {
    for (const resolvePanelTarget of [
      () => undefined,
      () => { throw new Error("panel target identity is ambiguous"); },
    ]) {
      const send = vi.fn();
      const server = await startPanelImageRelayServer({
        resolvePanelAgent: (value) => verifyPanelImageRelayCapability(SECRET, value) ? { agentKey: "orchestrator::claude", secret: SECRET } : undefined,
        resolvePanelTab: () => "panel-tab",
        resolveCurrentTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
        resolvePanelTarget,
        bridge: { canReach: () => true, send },
      });
      try {
        const response = await fetch(server.endpointUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request("missing-panel-target-123456")),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ ok: false, error: "STALE_TARGET" });
        expect(send).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    }
  });

  it("drops a bridge result when the panel retargets during the in-flight request", async () => {
    let currentTarget = { url: TARGET_URL, generation: TARGET_GENERATION };
    let release: (() => void) | undefined;
    const bridgeReply = new Promise<Record<string, unknown>>((resolve) => {
      release = () => resolve({ ok: true, base64: "AQID", mimeType: "image/png", bytes: 3 });
    });
    const send = vi.fn(() => bridgeReply);
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: (value) => verifyPanelImageRelayCapability(SECRET, value) ? { agentKey: "orchestrator::claude", secret: SECRET } : undefined,
      resolvePanelTab: () => "panel-tab",
      resolveCurrentTarget: () => currentTarget,
      resolvePanelTarget: () => currentTarget,
      bridge: { canReach: () => true, send },
    });
    try {
      process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
      process.env.COMFYUI_MCP_RELAY_URL = server.endpointUrl;
      const pending = requestPanelImage("render.png", "output", "shots");
      for (let i = 0; i < 100 && !send.mock.calls.length; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(send).toHaveBeenCalledOnce();
      currentTarget = { url: "http://127.0.0.1:8189", generation: TARGET_GENERATION + 1 };
      release?.();
      await expect(pending).rejects.toMatchObject({ code: "STALE_TARGET" });
    } finally {
      release?.();
      await server.close();
    }
  });

  it("refuses dispatch when the selected tab retargets before the final send fence", async () => {
    let panelTarget = { url: TARGET_URL, generation: TARGET_GENERATION };
    let reads = 0;
    const send = vi.fn();
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: (value) => verifyPanelImageRelayCapability(SECRET, value) ? { agentKey: "orchestrator::claude", secret: SECRET } : undefined,
      resolvePanelTab: () => "panel-tab",
      resolveCurrentTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      resolvePanelTarget: () => {
        reads += 1;
        if (reads === 2) panelTarget = { url: OTHER_TARGET_URL, generation: TARGET_GENERATION };
        return panelTarget;
      },
      bridge: { canReach: () => true, send },
    });
    try {
      const response = await fetch(server.endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request("pre-retarget-123456")),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: false, error: "STALE_TARGET" });
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("drops a bridge result when the selected tab retargets in flight", async () => {
    let panelTarget = { url: TARGET_URL, generation: TARGET_GENERATION };
    let release: (() => void) | undefined;
    const bridgeReply = new Promise<Record<string, unknown>>((resolve) => {
      release = () => resolve({ ok: true, base64: "AQID", mimeType: "image/png", bytes: 3 });
    });
    const send = vi.fn(() => bridgeReply);
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: (value) => verifyPanelImageRelayCapability(SECRET, value) ? { agentKey: "orchestrator::claude", secret: SECRET } : undefined,
      resolvePanelTab: () => "panel-tab",
      resolveCurrentTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      resolvePanelTarget: () => panelTarget,
      bridge: { canReach: () => true, send },
    });
    try {
      process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
      process.env.COMFYUI_MCP_RELAY_URL = server.endpointUrl;
      const pending = requestPanelImage("render.png", "output", "shots");
      for (let i = 0; i < 100 && !send.mock.calls.length; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(send).toHaveBeenCalledOnce();
      panelTarget = { url: OTHER_TARGET_URL, generation: TARGET_GENERATION };
      release?.();
      await expect(pending).rejects.toMatchObject({ code: "STALE_TARGET" });
    } finally {
      release?.();
      await server.close();
    }
  });

  it("fails closed when the live target identity is unavailable", async () => {
    const resolvePanelTab = vi.fn(() => "panel-tab");
    const send = vi.fn();
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: (value) => verifyPanelImageRelayCapability(SECRET, value) ? { agentKey: "orchestrator::claude", secret: SECRET } : undefined,
      resolvePanelTab,
      resolveCurrentTarget: () => { throw new Error("target identity unavailable"); },
      resolvePanelTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      bridge: { canReach: () => true, send },
    });
    try {
      const response = await fetch(server.endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request("ambiguous-target-123456")),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: false, error: "STALE_TARGET", requestId: "ambiguous-target-123456" });
      expect(resolvePanelTab).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("does not contact the relay when the child target identity is missing", async () => {
    process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
    process.env.COMFYUI_MCP_RELAY_URL = "http://127.0.0.1:9";
    delete process.env.COMFYUI_URL;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(requestPanelImage("render.png", "output", "shots")).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects forged HMACs before resolving or dispatching a panel tab", async () => {
    const send = vi.fn();
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: (value) => verifyPanelImageRelayCapability(SECRET, value) ? { agentKey: "orchestrator::claude", secret: SECRET } : undefined,
      resolvePanelTab: () => "victim-panel",
      resolveCurrentTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      resolvePanelTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
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
      resolveCurrentTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      resolvePanelTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
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

  it.each(["history", "system_stats", "logs", "object_info"] as const)(
    "relays the fixed %s ComfyUI read and authenticates/parses its reply",
    async (operation) => {
      const seen: Array<{ cmd: string; operation?: string }> = [];
      const body = operation === "logs"
        ? "ERROR: render failed\n"
        : operation === "object_info"
          ? JSON.stringify({
              KSampler: {
                input: { required: {} },
                output: ["MODEL"],
                output_is_list: [false],
                output_name: ["model"],
                name: "KSampler",
                display_name: "KSampler",
                description: "",
                category: "sampling",
                output_node: false,
              },
            })
          : JSON.stringify({ operation });
      const server = await startPanelImageRelayServer({
        resolvePanelAgent: (value) =>
          "operation" in value && verifyPanelComfyUIReadRelayCapability(SECRET, value)
            ? { agentKey: "orchestrator::claude", secret: SECRET }
            : undefined,
        resolvePanelTab: () => "panel-tab",
        resolveCurrentTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
        resolvePanelTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
        bridge: {
          canReach: () => true,
          send: async (command) => {
            seen.push(command);
            return {
              operation,
              body,
              contentType: operation === "logs" ? "text/plain" : "application/json",
              bytes: Buffer.byteLength(body, "utf8"),
              ...(operation === "object_info"
                ? {
                    // This is the exact metadata shape added by the Panel's
                    // withViewingWitness dispatcher wrapper.
                    viewing: {
                      scope: "root",
                      workflow_uuid: "workflow-live-2283",
                      graph_identity: "graph:live-2283",
                    },
                  }
                : {}),
            };
          },
        },
      });
      try {
        process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
        process.env.COMFYUI_MCP_RELAY_URL = server.endpointUrl;
        await expect(requestPanelComfyUIRead(operation)).resolves.toEqual({
          operation,
          body,
          contentType: operation === "logs" ? "text/plain" : "application/json",
          bytes: Buffer.byteLength(body, "utf8"),
        });
        expect(seen).toEqual([{ cmd: "fetch_comfyui_read", operation }]);
        expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(PANEL_COMFYUI_READ_MAX_BYTES);
      } finally {
        await server.close();
      }
    },
  );

  it("relays models/checkpoints without widening the object_info contract", async () => {
    expect(isPanelComfyUIReadOperation("models")).toBe(true);
    expect(isPanelComfyUIReadOperation("models/checkpoints")).toBe(true);
    expect(isPanelComfyUIReadOperation("models/../object_info")).toBe(false);
    expect(isPanelComfyUIReadOperation("object_info")).toBe(true);
    expect(isPanelComfyUIReadOperation("workflow_templates")).toBe(true);
    const seen: Array<{ cmd: string; operation?: string }> = [];
    const body = JSON.stringify(["remote-ckpt.safetensors"]);
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: (value) =>
        "operation" in value && verifyPanelComfyUIReadRelayCapability(SECRET, value)
          ? { agentKey: "orchestrator::claude", secret: SECRET }
          : undefined,
      resolvePanelTab: () => "panel-tab",
      resolveCurrentTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      resolvePanelTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      bridge: {
        canReach: () => true,
        send: async (command) => {
          seen.push(command);
          return {
            operation: "models/checkpoints",
            body,
            contentType: "application/json",
            bytes: Buffer.byteLength(body, "utf8"),
          };
        },
      },
    });
    try {
      process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
      process.env.COMFYUI_MCP_RELAY_URL = server.endpointUrl;
      await expect(requestPanelComfyUIRead("models/checkpoints")).resolves.toEqual({
        operation: "models/checkpoints",
        body,
        contentType: "application/json",
        bytes: Buffer.byteLength(body, "utf8"),
      });
      expect(seen).toEqual([{ cmd: "fetch_comfyui_read", operation: "models/checkpoints" }]);
    } finally {
      await server.close();
    }
  });

  it("rejects an invalid viewing witness instead of widening the read contract", async () => {
    const body = JSON.stringify({ KSampler: { input: { required: {} } } });
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: (value) =>
        "operation" in value && verifyPanelComfyUIReadRelayCapability(SECRET, value)
          ? { agentKey: "orchestrator::claude", secret: SECRET }
          : undefined,
      resolvePanelTab: () => "panel-tab",
      resolveCurrentTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      resolvePanelTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      bridge: {
        canReach: () => true,
        send: async () => ({
          operation: "object_info",
          body,
          contentType: "application/json",
          bytes: Buffer.byteLength(body, "utf8"),
          viewing: { scope: "root", graph_identity: 17 },
        }),
      },
    });
    try {
      process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
      process.env.COMFYUI_MCP_RELAY_URL = server.endpointUrl;
      await expect(requestPanelComfyUIRead("object_info")).rejects.toMatchObject({ code: "MALFORMED_REPLY" });
    } finally {
      await server.close();
    }
  });

  it("allows a documented large and slow object_info registry without widening other reads", async () => {
    expect(PANEL_COMFYUI_READ_OBJECT_INFO_MAX_BYTES).toBeGreaterThan(25_104_088);
    expect(PANEL_COMFYUI_READ_OBJECT_INFO_TIMEOUT_MS).toBeGreaterThan(20_840);
    const body = JSON.stringify({
      KSampler: {
        input: { required: {} },
        output: ["MODEL"],
        output_is_list: [false],
        output_name: ["model"],
        name: "KSampler",
        display_name: "KSampler",
        description: "x".repeat(25_104_088),
        category: "sampling",
        output_node: false,
      },
    });
    let bridgeTimeoutMs = 0;
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: (value) =>
        "operation" in value && verifyPanelComfyUIReadRelayCapability(SECRET, value)
          ? { agentKey: "orchestrator::claude", secret: SECRET }
          : undefined,
      resolvePanelTab: () => "panel-tab",
      resolveCurrentTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      resolvePanelTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      bridge: {
        canReach: () => true,
        send: productionShapedPanelDispatcher(body, (timeoutMs) => { bridgeTimeoutMs = timeoutMs; }),
      },
    });
    try {
      process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
      process.env.COMFYUI_MCP_RELAY_URL = server.endpointUrl;
      await expect(requestPanelComfyUIRead("object_info")).resolves.toMatchObject({
        operation: "object_info",
        bytes: body.length,
      });
      expect(bridgeTimeoutMs).toBeGreaterThan(PANEL_IMAGE_RELAY_TIMEOUT_MS);
      expect(bridgeTimeoutMs).toBeLessThanOrEqual(PANEL_COMFYUI_READ_OBJECT_INFO_TIMEOUT_MS);
    } finally {
      await server.close();
    }
  }, 45_000);

  it("fails closed for an object_info body over its route-specific cap", async () => {
    const body = "x".repeat(PANEL_COMFYUI_READ_OBJECT_INFO_MAX_BYTES + 1);
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: (value) =>
        "operation" in value && verifyPanelComfyUIReadRelayCapability(SECRET, value)
          ? { agentKey: "orchestrator::claude", secret: SECRET }
          : undefined,
      resolvePanelTab: () => "panel-tab",
      resolveCurrentTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      resolvePanelTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      bridge: {
        canReach: () => true,
        send: async () => ({ operation: "object_info", body, contentType: "application/json", bytes: body.length }),
      },
    });
    try {
      process.env.COMFYUI_MCP_RELAY_SECRET = SECRET;
      process.env.COMFYUI_MCP_RELAY_URL = server.endpointUrl;
      await expect(requestPanelComfyUIRead("object_info")).rejects.toMatchObject({ code: "MALFORMED_REPLY" });
    } finally {
      await server.close();
    }
  }, 45_000);

  it("applies the read relay deadline to the authenticated bridge command", async () => {
    let timeoutMs = 0;
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: (value) =>
        "operation" in value && verifyPanelComfyUIReadRelayCapability(SECRET, value)
          ? { agentKey: "orchestrator::claude", secret: SECRET }
          : undefined,
      resolvePanelTab: () => "panel-tab",
      resolveCurrentTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      resolvePanelTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      bridge: {
        canReach: () => true,
        send: async (_command, options) => {
          timeoutMs = options.timeoutMs;
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { operation: "history", body: "{}", contentType: "application/json", bytes: 2 };
        },
      },
    });
    try {
      const createdAt = Date.now();
      const short = readRequest("short-read-deadline-123", "history");
      short.createdAt = createdAt;
      short.deadlineAt = createdAt + 30;
      short.capability = makePanelComfyUIReadRelayCapability(SECRET, short);
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

  it("fails closed when a slow object_info read reaches its caller deadline", async () => {
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: (value) =>
        "operation" in value && verifyPanelComfyUIReadRelayCapability(SECRET, value)
          ? { agentKey: "orchestrator::claude", secret: SECRET }
          : undefined,
      resolvePanelTab: () => "panel-tab",
      resolveCurrentTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      resolvePanelTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      bridge: {
        canReach: () => true,
        send: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { operation: "object_info", body: "{}", contentType: "application/json", bytes: 2 };
        },
      },
    });
    try {
      const short = readRequest("short-object-info-deadline", "object_info");
      short.deadlineAt = short.createdAt + 30;
      short.capability = makePanelComfyUIReadRelayCapability(SECRET, short);
      const response = await fetch(server.endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(short),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: false, error: "TIMEOUT", requestId: short.requestId });
    } finally {
      await server.close();
    }
  });

  it("rejects oversized HTTP requests and overloads without unbounded work", async () => {
    const server = await startPanelImageRelayServer({
      resolvePanelAgent: () => ({ agentKey: "orchestrator::claude", secret: SECRET }),
      resolvePanelTab: () => "panel-tab",
      resolveCurrentTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
      resolvePanelTarget: () => ({ url: TARGET_URL, generation: TARGET_GENERATION }),
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
