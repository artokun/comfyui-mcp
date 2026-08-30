// #2532 — queue(action:"status") can return done:true from the client's cached
// prompt status while get_history(action:"list") and the run-completion journal
// fail with ECONNREFUSED against COMFYUI_URL. The live panel still holds the
// completed run. The panel fetch_comfyui_read command is global /history only,
// so a prompt-scoped lookup must use that body and keep only the requested id.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const panelRead = vi.hoisted(() => vi.fn());
const fetchApi = vi.hoisted(() => vi.fn());
const promptStatus = vi.hoisted(() =>
  vi.fn(async () => ({ running: false, pending: false, done: true })),
);

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return {
    ...actual,
    config: { ...actual.config, comfyuiBasePath: "/comfyapi", comfyuiPath: "" },
    getComfyUIApiHost: () => "127.0.0.1:8000",
    getComfyUIBasePath: () => "/comfyapi",
    getComfyUIBaseUrl: () => "http://127.0.0.1:8000/comfyapi",
    getComfyUIAuthHeaders: () => ({ Authorization: "Bearer headless-token" }),
    isCloudMode: () => false,
    isRemoteMode: () => true,
  };
});

vi.mock("@stable-canvas/comfyui-client", () => ({
  Client: class {
    apiURL(path: string): string {
      return path;
    }

    apiHeaders(init?: { headers?: HeadersInit }) {
      return init?.headers ?? {};
    }

    async fetch(url: string, init?: RequestInit) {
      return await fetchApi(url, init);
    }

    fetchApi = fetchApi;
    getPromptStatus = promptStatus;
    close() {}
  },
}));

vi.mock("../../services/panel-image-relay.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/panel-image-relay.js")>(
    "../../services/panel-image-relay.js",
  );
  return { ...actual, requestPanelComfyUIRead: panelRead };
});

import { getHistory, resetClient } from "../../comfyui/client.js";
import { resolveHistoryCompletion } from "../../orchestrator/run-completion-watchdog.js";
import { getJobStatus } from "../../services/queue-manager.js";
import { PanelComfyUIReadRelayError } from "../../services/panel-image-relay.js";

const PROMPT = "e7f0b7a0-completed-run";
const OTHER = "other-prompt-must-not-leak";

function transportFailure(): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8000"), { code: "ECONNREFUSED" }),
  });
}

function historyEntry(promptId: string, filename: string): Record<string, unknown> {
  return {
    prompt: {},
    outputs: {
      "9": { images: [{ filename, subfolder: "", type: "output" }] },
    },
    status: {
      status_str: "success",
      completed: true,
      messages: [["execution_success", { prompt_id: promptId, timestamp: 1_705_505_423 }]],
    },
  };
}

function panelHistoryBody(payload: Record<string, unknown>): {
  operation: "history";
  body: string;
  contentType: string;
  bytes: number;
} {
  const body = JSON.stringify(payload);
  return {
    operation: "history",
    body,
    contentType: "application/json",
    bytes: Buffer.byteLength(body, "utf8"),
  };
}

beforeEach(() => {
  fetchApi.mockReset();
  panelRead.mockReset();
  promptStatus.mockReset();
  promptStatus.mockResolvedValue({ running: false, pending: false, done: true });
  resetClient();
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw transportFailure();
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prompt-scoped history uses the panel fallback (#2532)", () => {
  it("selects the requested prompt from the global panel /history body", async () => {
    fetchApi.mockRejectedValue(transportFailure());
    panelRead.mockResolvedValue(
      panelHistoryBody({
        [PROMPT]: historyEntry(PROMPT, "ComfyUI_00042_.png"),
        [OTHER]: historyEntry(OTHER, "must-not-leak.png"),
      }),
    );

    await expect(getHistory(PROMPT)).resolves.toEqual({
      [PROMPT]: historyEntry(PROMPT, "ComfyUI_00042_.png"),
    });
    expect(panelRead).toHaveBeenCalledWith("history");
    expect(panelRead).toHaveBeenCalledTimes(1);
  });

  it("returns {} when the panel history does not contain the requested prompt", async () => {
    fetchApi.mockRejectedValue(transportFailure());
    panelRead.mockResolvedValue(
      panelHistoryBody({
        [OTHER]: historyEntry(OTHER, "must-not-leak.png"),
      }),
    );

    await expect(getHistory(PROMPT)).resolves.toEqual({});
    expect(panelRead).toHaveBeenCalledWith("history");
  });

  it("exposes the completed run's output ref to the completion journal", async () => {
    fetchApi.mockRejectedValue(transportFailure());
    panelRead.mockResolvedValue(
      panelHistoryBody({
        [PROMPT]: historyEntry(PROMPT, "ComfyUI_00042_.png"),
        [OTHER]: historyEntry(OTHER, "must-not-leak.png"),
      }),
    );

    const resolved = await resolveHistoryCompletion(PROMPT);
    expect(resolved?.images).toEqual([{ filename: "ComfyUI_00042_.png", type: "output" }]);
    expect(resolved?.status).toBe("success");
  });

  it("enriches queue.status from the panel history instead of a silent cached done", async () => {
    fetchApi.mockRejectedValue(transportFailure());
    panelRead.mockResolvedValue(
      panelHistoryBody({
        [PROMPT]: historyEntry(PROMPT, "ComfyUI_00042_.png"),
      }),
    );

    const status = await getJobStatus(PROMPT);
    expect(status).toMatchObject({
      running: false,
      pending: false,
      done: true,
      status_str: "success",
    });
    expect(status.done_from).toBeUndefined();
    expect(status.note).toBeUndefined();
    expect(panelRead).toHaveBeenCalledWith("history");
  });

  it("discloses that done came from local cache when history is unreachable even via the panel", async () => {
    fetchApi.mockRejectedValue(transportFailure());
    panelRead.mockRejectedValue(new PanelComfyUIReadRelayError("panel timed out", "TIMEOUT"));

    const status = await getJobStatus(PROMPT);
    expect(status).toMatchObject({
      running: false,
      pending: false,
      done: true,
      done_from: "local_cache",
    });
    expect(status.note).toMatch(/cached prompt status/i);
    expect(status.note).toMatch(/unreachable/i);
    expect(status.note).toMatch(/get_history/);
  });

  it("does not use the panel for a configured-route HTTP error on prompt-scoped history", async () => {
    fetchApi.mockResolvedValue(new Response("gateway down", { status: 503 }));
    await expect(getHistory(PROMPT)).rejects.toThrow();
    expect(panelRead).not.toHaveBeenCalled();
  });
});
