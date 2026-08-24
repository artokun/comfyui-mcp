import { afterEach, describe, expect, it, vi } from "vitest";
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
  PANEL_IMAGE_RELAY_REQUEST_PREFIX,
  PANEL_IMAGE_RELAY_RESPONSE_PREFIX,
  PANEL_IMAGE_RELAY_STALE_MS,
  processPanelImageRequests,
  requestPanelImage,
  type PanelImageRelayRequest,
} from "../../services/panel-image-relay.js";

const dirs: string[] = [];

function tempChannel(): string {
  const dir = mkdtempSync(join(tmpdir(), "comfyui-mcp-image-relay-"));
  dirs.push(dir);
  return dir;
}

function request(id: string, patch: Partial<PanelImageRelayRequest> = {}): PanelImageRelayRequest {
  const createdAt = Date.now();
  const value = {
    version: 1,
    requestId: id,
    requester: "orchestrator::claude",
    filename: "render.png",
    subfolder: "shots",
    type: "output",
    createdAt,
    deadlineAt: createdAt + 8_000,
    ...patch,
  };
  if (!("deadlineAt" in patch)) value.deadlineAt = value.createdAt + 8_000;
  return value;
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
  vi.restoreAllMocks();
});

describe("panel image relay child channel", () => {
  it("writes only a bounded reference and accepts the exact panel result contract", async () => {
    const dir = tempChannel();
    process.env.COMFYUI_MCP_PROGRESS_DIR = dir;
    process.env.COMFYUI_MCP_TAB = "orchestrator::claude";
    const pending = requestPanelImage("render.png", "output", "shots");
    let file = "";
    for (let i = 0; i < 100 && !file; i += 1) {
      file = readdirSync(dir).find((name) => name.startsWith(PANEL_IMAGE_RELAY_REQUEST_PREFIX)) ?? "";
      if (!file) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(file).not.toBe("");
    const requestBody = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    expect(Object.keys(requestBody).sort()).toEqual([
      "createdAt",
      "deadlineAt",
      "filename",
      "requestId",
      "requester",
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
    await expect(requestPanelImage(filename, type as "output", subfolder)).rejects.toMatchObject({ code: "UNSAFE_REFERENCE" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("rejects a malformed response instead of accepting a URL-shaped field", async () => {
    const dir = tempChannel();
    process.env.COMFYUI_MCP_PROGRESS_DIR = dir;
    process.env.COMFYUI_MCP_TAB = "orchestrator::claude";
    const pending = requestPanelImage("render.png", "output", "shots");
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

  it("does not accept a response discovered after the single end-to-end deadline", async () => {
    const dir = tempChannel();
    process.env.COMFYUI_MCP_PROGRESS_DIR = dir;
    process.env.COMFYUI_MCP_TAB = "orchestrator::claude";
    const pending = requestPanelImage("render.png", "output", "shots");
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
    await processPanelImageRequests({ dir, resolvePanelTab: () => "panel-tab", bridge: { canReach: () => true, send } });
    expect(readResponse(dir, staleId)).toMatchObject({ ok: false, error: "TIMEOUT" });
    expect(readResponse(dir, forgedId)).toMatchObject({ ok: false, error: "MALFORMED_REQUEST" });
    expect(send).not.toHaveBeenCalled();
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
    await processPanelImageRequests({ dir, resolvePanelTab: () => "panel-tab", bridge: { canReach: () => true, send } });
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
    await processPanelImageRequests({ dir, resolvePanelTab: () => "panel-tab", bridge: { canReach: () => true, send } });
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
    await processPanelImageRequests({ dir, resolvePanelTab: () => "panel-tab", bridge: { canReach: () => false, send: vi.fn() } });
    expect(readdirSync(dir)).not.toContain(stale.split("\\").at(-1));
    expect(readdirSync(dir)).not.toContain(oversized.split("\\").at(-1));
  });
});
