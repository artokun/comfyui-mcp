import { describe, expect, it, beforeEach, vi } from "vitest";

// Tool-level test for get_image action:"list_assets" (#751), the surviving
// call form of the retired asset-listing tool (0.50.0 slice 15). The REAL
// reconcile path runs; only the ComfyUI client/config boundary is mocked, so a
// panel-dispatched render (never watched by this process) must surface via the
// history reconcile. The list-assets call is intentionally allowed to use the
// real getOutputImage consumer, so its traversal/content/fallback contract is
// covered at the production handler call site; unrelated image actions remain
// mocked below.
const getHistoryMock = vi.fn();
const fetchImageMock = vi.fn();
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
vi.mock("../../comfyui/client.js", () => ({
  MAX_VIEW_RESPONSE_BYTES: 32 * 1024 * 1024,
  getHistory: (...a: unknown[]) => getHistoryMock(...a),
  fetchImage: (...a: unknown[]) => fetchImageMock(...a),
  getClient: vi.fn(),
  ensureConnected: vi.fn(),
}));
vi.mock("../../config.js", () => ({
  isCloudMode: () => false,
  getCloudUrl: () => "",
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
}));
vi.mock("../../services/view-image.js", () => ({
  viewAssetImage: vi.fn(),
}));
vi.mock("../../services/image-convert.js", () => ({ convertImage: vi.fn() }));
vi.mock("../../services/color-analysis.js", () => ({ analyzeColor: vi.fn() }));
vi.mock("../../services/storage-upload.js", () => ({ uploadOutput: vi.fn() }));

import { registerImageManagementTools } from "../../tools/image-management.js";
import { AssetRegistry } from "../../services/asset-registry.js";
import { JobWatcher } from "../../services/job-watcher.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function getHandler(name: string): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => {
      if (n === name) handler = h;
    },
  };
  registerImageManagementTools(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

interface ListResult {
  count: number;
  assets: Array<{
    asset_id: string;
    prompt_id: string;
    node_id: string;
    filename: string;
    subfolder: string;
    type: string;
    url: string;
    source: string;
    created_at: string;
    created_at_source?: string;
  }>;
  note?: string;
}

async function callListAssets(args: Record<string, unknown> = {}): Promise<ListResult> {
  const res = await getHandler("get_image")({ action: "list_assets", ...args });
  expect(res.isError).toBeUndefined();
  return JSON.parse(res.content[0].text) as ListResult;
}

function sampleGraph(): WorkflowJSON {
  return {
    "3": { class_type: "KSampler", inputs: { seed: 42, steps: 20, cfg: 7 } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["8", 0] } },
  };
}

function panelHistoryEntry(queue: number, promptId: string, filename: string, successTs: number) {
  return {
    prompt: [queue, promptId, sampleGraph(), {}, []],
    outputs: { "9": { images: [{ filename, subfolder: "", type: "output" }] } },
    status: {
      status_str: "success",
      completed: true,
      messages: [
        ["execution_start", { prompt_id: promptId, timestamp: successTs - 8000 }],
        ["execution_success", { prompt_id: promptId, timestamp: successTs }],
      ],
    },
  };
}

function registerWatched(promptId: string, filename: string) {
  const [record] = AssetRegistry.register({
    promptId,
    workflow: sampleGraph(),
    outputs: [
      {
        node_id: "9",
        images: [
          {
            filename,
            subfolder: "",
            type: "output",
            url: `http://127.0.0.1:8188/view?filename=${filename}&subfolder=&type=output`,
          },
        ],
      },
    ],
  });
  return record;
}

beforeEach(() => {
  getHistoryMock.mockReset();
  fetchImageMock.mockReset();
  fetchImageMock.mockResolvedValue({ base64: VALID_PNG_BASE64, mimeType: "image/png" });
  AssetRegistry.configure({ ttlMs: 24 * 60 * 60 * 1000, now: Date.now });
  AssetRegistry.clear();
});

describe('get_image action:"list_assets" (#751)', () => {
  it("lists a panel-dispatched render that this session never watched", async () => {
    // The bug: panel_run queues via the browser's app.queuePrompt, so no
    // JobWatcher/AssetRegistry.register ever ran for this prompt — yet
    // get_history has the output. action:"list_assets" must surface it via reconcile.
    const successTs = Date.now() - 4000;
    getHistoryMock.mockResolvedValue({
      "6afad7e0-59f1-422c-9298-e2dcb34058e0": panelHistoryEntry(
        12,
        "6afad7e0-59f1-422c-9298-e2dcb34058e0",
        "修月人_08B_Krea2_ID01A_HEAD_C05主_C04补_B01T_take3-final2_00001_.png",
        successTs,
      ),
    });

    const out = await callListAssets({ limit: 20 });

    expect(out.count).toBe(1);
    expect(out.note).toBeUndefined();
    const asset = out.assets[0];
    expect(asset).toMatchObject({
      prompt_id: "6afad7e0-59f1-422c-9298-e2dcb34058e0",
      node_id: "9",
      filename: "修月人_08B_Krea2_ID01A_HEAD_C05主_C04补_B01T_take3-final2_00001_.png",
      subfolder: "",
      type: "output",
      source: "history-reconcile",
      created_at: new Date(successTs).toISOString(),
      created_at_source: "history",
    });
    expect(asset.asset_id).toMatch(/^a_[0-9a-f]{8}$/);
    expect(asset.url).toContain("type=output");
    // The reconciled asset is genuinely registered — get_image (action:"view")
    // and generate_image (action:"regenerate") can resolve it by id afterwards.
    expect(AssetRegistry.get(asset.asset_id)).toBeDefined();
  });

  it("does not advertise a freshly reconciled history image when /view returns 404 (#2476)", async () => {
    const successTs = Date.now() - 4000;
    const filename = "ComfyUI_00002_.png";
    getHistoryMock.mockResolvedValue({
      "fresh-missing-output": panelHistoryEntry(13, "fresh-missing-output", filename, successTs),
    });
    fetchImageMock.mockRejectedValue(new Error(`IMAGE_NOT_FOUND: /view returned 404 for "${filename}"`));

    const out = await callListAssets({ limit: 20 });

    expect(fetchImageMock).toHaveBeenCalledWith(
      filename,
      "output",
      "",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(out.count).toBe(0);
    expect(out.assets).toEqual([]);
    expect(out.note).toContain("not listed");
    expect(out.note).toContain("/view");
  });

  it.each([
    ["an empty 2xx body", "", "image/png"],
    ["an HTML error body", Buffer.from("<html>login</html>").toString("base64"), "text/html"],
    ["a JSON error body", Buffer.from('{"error":"not found"}').toString("base64"), "application/json"],
    [
      "malformed HTML mislabeled as image/png",
      Buffer.from("<!DOCTYPE html><html><body>login").toString("base64"),
      "image/png",
    ],
    [
      "truncated JSON mislabeled as image/jpeg",
      Buffer.from('{"error":').toString("base64"),
      "image/jpeg",
    ],
    ["arbitrary bytes labeled image/webp", Buffer.from("not an image").toString("base64"), "image/webp"],
  ])("does not advertise history output when /view returns %s", async (_label, base64, mimeType) => {
    const filename = "false-success.png";
    getHistoryMock.mockResolvedValue({
      "false-success": panelHistoryEntry(13, "false-success", filename, Date.now() - 4000),
    });
    fetchImageMock.mockResolvedValue({ base64, mimeType });

    const out = await callListAssets({ limit: 20 });

    expect(fetchImageMock).toHaveBeenCalledWith(
      filename,
      "output",
      "",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(out.count).toBe(0);
    expect(out.assets).toEqual([]);
    expect(out.note).toContain("not listed");
  });

  it("keeps searching after a failed probe when the requested output limit is small", async () => {
    const failedTs = Date.now() - 3000;
    const validTs = Date.now() - 4000;
    getHistoryMock.mockResolvedValue({
      newerMissing: panelHistoryEntry(14, "newerMissing", "missing.png", failedTs),
      olderValid: panelHistoryEntry(13, "olderValid", "valid.png", validTs),
    });
    fetchImageMock
      .mockRejectedValueOnce(new Error('IMAGE_NOT_FOUND: /view returned 404 for "missing.png"'))
      .mockResolvedValue({ base64: VALID_PNG_BASE64, mimeType: "image/png" });

    const out = await callListAssets({ limit: 1 });

    expect(fetchImageMock).toHaveBeenCalledTimes(2);
    expect(out.count).toBe(1);
    expect(out.assets[0]).toMatchObject({ filename: "valid.png", prompt_id: "olderValid" });
    expect(out.note).toContain("1 history image output(s) were not listed");
  });

  it("times out a stalled newest ref and retains a later valid asset", async () => {
    const stalledTs = Date.now() - 3000;
    const validTs = Date.now() - 4000;
    getHistoryMock.mockResolvedValue({
      stalled: panelHistoryEntry(14, "stalled", "stalled.png", stalledTs),
      laterValid: panelHistoryEntry(13, "laterValid", "later-valid.png", validTs),
    });
    fetchImageMock.mockImplementation(
      (
        filename: string,
        _type: string,
        _subfolder: string,
        options: { signal?: AbortSignal } | undefined,
      ) => {
        if (filename !== "stalled.png") {
          return Promise.resolve({ base64: VALID_PNG_BASE64, mimeType: "image/png" });
        }
        return new Promise((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason ?? new Error("probe timed out")),
            { once: true },
          );
        });
      },
    );

    const out = await callListAssets({ limit: 1 });

    expect(fetchImageMock).toHaveBeenCalledTimes(2);
    expect(out.count).toBe(1);
    expect(out.assets[0]).toMatchObject({ filename: "later-valid.png", prompt_id: "laterValid" });
    expect(out.note).toContain("1 history image output(s) were not listed");
  });

  it("rejects a corrupted image whose header still reports valid dimensions", async () => {
    const corrupted = Buffer.from(VALID_PNG_BASE64, "base64");
    corrupted[corrupted.length - 20] ^= 0xff;
    getHistoryMock.mockResolvedValue({
      corrupted: panelHistoryEntry(13, "corrupted", "corrupted.png", Date.now() - 4000),
    });
    fetchImageMock.mockResolvedValue({
      base64: corrupted.toString("base64"),
      mimeType: "image/png",
    });

    const out = await callListAssets({ limit: 20 });

    expect(out.count).toBe(0);
    expect(out.assets).toEqual([]);
    expect(out.note).toContain("not listed");
  });

  it.each(["png", "jpeg", "webp", "avif"] as const)(
    "accepts valid %s bytes through the production history probe",
    async (format) => {
      const sharp = (await import("sharp")).default;
      const source = sharp({
        create: { width: 2, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } },
      });
      const bytes =
        format === "png"
          ? await source.clone().png().toBuffer()
          : format === "jpeg"
            ? await source.clone().jpeg().toBuffer()
            : format === "webp"
              ? await source.clone().webp().toBuffer()
              : await source.clone().avif().toBuffer();
      const mimeType = format === "jpeg" ? "image/jpeg" : `image/${format}`;
      const filename = `valid.${format}`;
      getHistoryMock.mockResolvedValue({
        valid: panelHistoryEntry(13, "valid", filename, Date.now() - 4000),
      });
      fetchImageMock.mockResolvedValue({ base64: bytes.toString("base64"), mimeType });

      const out = await callListAssets({ limit: 20 });

      expect(out.count).toBe(1);
      expect(out.assets[0]).toMatchObject({ filename, type: "output" });
    },
  );

  it.each([
    ["a filename traversal", "../outside.png", ""],
    ["a subfolder traversal", "safe.png", "../outside"],
  ])("does not forward %s from /history to /view", async (_label, filename, subfolder) => {
    const entry = panelHistoryEntry(13, "unsafe-ref", filename, Date.now() - 4000);
    entry.outputs["9"].images[0].subfolder = subfolder;
    getHistoryMock.mockResolvedValue({ "unsafe-ref": entry });

    const out = await callListAssets({ limit: 20 });

    expect(fetchImageMock).not.toHaveBeenCalled();
    expect(out.count).toBe(0);
    expect(out.assets).toEqual([]);
    expect(out.note).toContain("not listed");
  });

  it("normalizes a history type before probing and publishing the asset ref", async () => {
    const filename = "normalized.png";
    const entry = panelHistoryEntry(13, "normalized", filename, Date.now() - 4000);
    entry.outputs["9"].images[0].type = "unknown-type";
    getHistoryMock.mockResolvedValue({ normalized: entry });

    const out = await callListAssets({ limit: 20 });

    expect(fetchImageMock).toHaveBeenCalledWith(
      filename,
      "output",
      "",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(out.assets[0]).toMatchObject({ filename, type: "output" });
    expect(out.assets[0].url).toContain("type=output");
  });

  it("bounds production list-assets probes by the requested page and hard ceiling", async () => {
    const entry = panelHistoryEntry(13, "many", "many_0.png", Date.now() - 4000);
    entry.outputs["9"].images = Array.from({ length: 101 }, (_, i) => ({
      filename: `many_${i}.png`,
      subfolder: "",
      type: "output",
    }));
    getHistoryMock.mockResolvedValue({ many: entry });

    const out = await callListAssets({ limit: 2 });

    expect(fetchImageMock).toHaveBeenCalledTimes(8);
    expect(out.count).toBe(2);
    expect(out.note).toContain("bounded");
  });

  it("keeps watched registrations truthful and does not duplicate them", async () => {
    const watched = registerWatched("watched-prompt", "watched_00001_.png");
    const successTs = Date.now() - 4000;
    getHistoryMock.mockResolvedValue({
      // Same run this session already watched — must stay source "watched".
      "watched-prompt": panelHistoryEntry(9, "watched-prompt", "watched_00001_.png", successTs),
      // Plus one the session never saw — must appear as history-reconcile.
      "panel-prompt": panelHistoryEntry(10, "panel-prompt", "panel_00002_.png", successTs),
    });

    const out = await callListAssets();

    expect(out.count).toBe(2);
    const byFilename = new Map(out.assets.map((a) => [a.filename, a]));
    expect(byFilename.get("watched_00001_.png")).toMatchObject({
      asset_id: watched.assetId,
      source: "watched",
    });
    expect(byFilename.get("panel_00002_.png")).toMatchObject({
      prompt_id: "panel-prompt",
      source: "history-reconcile",
    });
  });

  it("preserves a concurrent watcher and collapses raw/normalized type identity", async () => {
    const promptId = "concurrent-watched";
    const filename = "concurrent-watched.png";
    const entry = panelHistoryEntry(13, promptId, filename, Date.now() - 4000);
    entry.outputs["9"].images[0].type = "legacy-output-tag";
    getHistoryMock.mockResolvedValue({ [promptId]: entry });

    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    let releaseProbe!: () => void;
    const probeRelease = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    fetchImageMock.mockImplementationOnce(async () => {
      probeStarted();
      await probeRelease;
      return { base64: VALID_PNG_BASE64, mimeType: "image/png" };
    });

    const listing = callListAssets();
    await started;

    process.env.COMFYUI_JOB_POLL_INTERVAL_S = "0.01";
    JobWatcher.watch(promptId, sampleGraph());
    try {
      await vi.waitFor(() => {
        expect(AssetRegistry.find(promptId, {
          filename,
          subfolder: "",
          type: "legacy-output-tag",
        })?.source).toBe("watched");
      }, { timeout: 3000, interval: 10 });
      releaseProbe();

      const out = await listing;

      expect(out.count).toBe(1);
      expect(out.assets[0]).toMatchObject({
        asset_id: AssetRegistry.find(promptId, { filename, subfolder: "", type: "output" })?.assetId,
        filename,
        type: "output",
        source: "watched",
      });
      expect(out.assets[0].url).toContain("type=output");
    } finally {
      JobWatcher.unwatch(promptId);
      delete process.env.COMFYUI_JOB_POLL_INTERVAL_S;
      releaseProbe();
    }
  });

  it("says so honestly when nothing is watched and history has no completed outputs", async () => {
    getHistoryMock.mockResolvedValue({});

    const out = await callListAssets();

    expect(out.count).toBe(0);
    expect(out.assets).toEqual([]);
    expect(out.note).toContain("no recent successfully completed outputs in ComfyUI history");
    expect(out.note).toContain("get_history");
    expect(out.note).toContain("get_image");
  });

  it("degrades truthfully when the history fetch fails: keeps all records, flags staleness", async () => {
    registerWatched("watched-prompt", "watched_00001_.png");
    // A record reconciled from history on an earlier, successful call.
    AssetRegistry.register({
      promptId: "reconciled-prompt",
      workflow: sampleGraph(),
      source: "history-reconcile",
      outputs: [
        {
          node_id: "9",
          images: [
            {
              filename: "reconciled_00001_.png",
              subfolder: "",
              type: "output",
              url: "http://127.0.0.1:8188/view?filename=reconciled_00001_.png&subfolder=&type=output",
            },
          ],
        },
      ],
    });
    getHistoryMock.mockRejectedValue(new Error("connection refused"));

    const out = await callListAssets();

    // Both records stay listed — but the note must SAY the result includes
    // previously reconciled assets and may be stale, never "watched-only".
    expect(out.count).toBe(2);
    const sources = new Map(out.assets.map((a) => [a.filename, a.source]));
    expect(sources.get("watched_00001_.png")).toBe("watched");
    expect(sources.get("reconciled_00001_.png")).toBe("history-reconcile");
    expect(out.note).toContain("Could not refresh from ComfyUI history");
    expect(out.note).toContain("may be stale");
    expect(out.note).not.toContain("watched-session assets only");
  });

  it("excludes error-status history entries even when their messages are missing (codex P1)", async () => {
    // completed:true + status_str:"error" + image outputs + NO messages: the
    // completion-notification builder would default this to "success", so
    // eligibility must come from the history entry's own status fields.
    getHistoryMock.mockResolvedValue({
      "errored-prompt": {
        prompt: [7, "errored-prompt", sampleGraph(), {}, []],
        outputs: { "9": { images: [{ filename: "err_00001_.png", subfolder: "", type: "output" }] } },
        status: { status_str: "error", completed: true, messages: [] },
      },
    });

    const out = await callListAssets();

    expect(out.count).toBe(0);
    expect(out.assets).toEqual([]);
    expect(out.note).toContain("no recent successfully completed outputs in ComfyUI history");
  });

  it("respects the limit argument across reconciled assets", async () => {
    const ts = Date.now() - 4000;
    getHistoryMock.mockResolvedValue({
      p1: panelHistoryEntry(1, "p1", "p1_00001_.png", ts),
      p2: panelHistoryEntry(2, "p2", "p2_00001_.png", ts + 1000),
    });

    const out = await callListAssets({ limit: 1 });

    expect(out.count).toBe(1);
    expect(out.assets[0].filename).toBe("p2_00001_.png");
  });
});
