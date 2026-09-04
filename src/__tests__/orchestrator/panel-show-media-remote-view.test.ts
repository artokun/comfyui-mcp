// #2861 — panel_show_media forwarded a ComfyUI /view ref to a browser panel
// whose same-origin /view 404'd, while get_image (fetchImage, the configured
// MCP client) fetched the same filename from the remote target. painted: 0.
//
// A local canvas still gets a viewRef (same-origin /view works). A remote or
// cloud interactive tab is proxied through fetchImage and inlined under the
// existing 20 MB cap. Bytes come from that client, never a same-named file on
// the orchestrator disk (#877/#899). Headless inlining (#2012) is unchanged.
// If the MCP client cannot paint the item, the tool fails closed — it does
// not forward a viewRef the panel will drop.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";
import { ComfyUIError } from "../../utils/errors.js";

const state = vi.hoisted(() => ({
  remote: false,
  cloud: false,
  fetchImage: null as
    | ((
        filename: string,
        type?: string,
        subfolder?: string,
        options?: { maxBytes?: number },
      ) => Promise<{ base64: string; mimeType: string }>)
    | null,
  fetchImageCalls: [] as Array<{
    filename: string;
    type: string | undefined;
    subfolder: string | undefined;
    options: { maxBytes?: number } | undefined;
  }>,
  impl: null as
    | ((url: string, init?: { method?: string }) => Promise<{
        ok: boolean;
        status: number;
        headers: { get: (name: string) => string | null };
        arrayBuffer: () => Promise<ArrayBuffer>;
      }>)
    | null,
  urls: [] as string[],
}));

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    isRemoteMode: () => state.remote,
    isCloudMode: () => state.cloud,
    getComfyUIBaseUrl: () => "https://comfy.example:8188",
  };
});

vi.mock("../../comfyui/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/client.js")>();
  return {
    ...actual,
    fetchImage: async (
      filename: string,
      type?: string,
      subfolder?: string,
      options?: { maxBytes?: number },
    ) => {
      state.fetchImageCalls.push({ filename, type, subfolder, options });
      if (!state.fetchImage) {
        throw new Error("fetchImage was not stubbed");
      }
      return state.fetchImage(filename, type, subfolder, options);
    },
  };
});

vi.mock("../../comfyui/fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/fetch.js")>();
  return {
    ...actual,
    comfyuiFetch: (url: string, init?: { method?: string }) => {
      state.urls.push(url);
      if (!state.impl) {
        return Promise.reject(new Error("comfyuiFetch was not stubbed"));
      }
      return state.impl(url, init);
    },
  };
});

const { buildPanelToolDefs } = await import("../../orchestrator/panel-tools.js");

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

afterEach(() => {
  state.remote = false;
  state.cloud = false;
  state.fetchImage = null;
  state.fetchImageCalls = [];
  state.impl = null;
  state.urls = [];
});

function mediaFetch(mime: string, bytes: Buffer, ok = true, status = 200): typeof state.impl {
  return async (_url, init) => {
    if (init?.method === "HEAD") {
      return {
        ok,
        status,
        headers: { get: () => mime },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const copy = Uint8Array.from(bytes);
    return {
      ok,
      status,
      headers: { get: () => mime },
      arrayBuffer: async () => copy.buffer,
    };
  };
}

type Cmd = Record<string, unknown>;

function makeCtx(): { ctx: PanelToolCtx; calls: Cmd[] } {
  const calls: Cmd[] = [];
  const ctx = {
    call: async (cmd: Cmd) => {
      calls.push(cmd);
      return { content: [{ type: "text", text: JSON.stringify(cmd) }] } as ToolResult;
    },
    confirm: async () => "yes" as const,
    tabId: "wf:workflows/a.json",
    bridge: {
      isHeadless: () => false,
    },
  } as PanelToolCtx;
  return { ctx, calls };
}

async function showMedia(
  ctx: PanelToolCtx,
  items: Array<Record<string, unknown>> = [
    { source: { filename: "clip.mp4", type: "output" } },
  ],
): Promise<ToolResult> {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_show_media");
  if (!def) throw new Error("panel_show_media not found");
  return (await def.handler({ items }, ctx)) as ToolResult;
}

function dispatchedItems(calls: Cmd[]): Array<Record<string, unknown>> {
  const sent = calls.find((c) => c.cmd === "show_media");
  if (!sent) throw new Error("show_media was not dispatched");
  return sent.items as Array<Record<string, unknown>>;
}

const textOf = (res: ToolResult): string =>
  res.content.map((c) => ("text" in c ? c.text : "")).join("\n");

describe("#2861 remote interactive panel_show_media inlines via fetchImage", () => {
  it("a remote canvas tab gets inlined bytes, not a /view ref the browser 404s", async () => {
    state.remote = true;
    const mp4 = Buffer.alloc(64, 1);
    state.fetchImage = async () => ({
      base64: mp4.toString("base64"),
      mimeType: "video/mp4",
    });
    const { ctx, calls } = makeCtx();
    const res = await showMedia(ctx);
    expect(res.isError).toBeFalsy();
    const items = dispatchedItems(calls);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("video");
    expect(String(items[0].dataUrl)).toBe(`data:video/mp4;base64,${mp4.toString("base64")}`);
    expect(items[0].viewRef).toBeUndefined();
    expect(state.fetchImageCalls).toEqual([
      { filename: "clip.mp4", type: "output", subfolder: "", options: { maxBytes: 20 * 1024 * 1024 } },
    ]);
    expect(state.urls).toEqual([]);
  });

  it("a local canvas tab still gets a viewRef — same-origin /view works", async () => {
    state.remote = false;
    state.impl = mediaFetch("video/mp4", Buffer.alloc(64, 1));
    const { ctx, calls } = makeCtx();
    await showMedia(ctx);
    expect(dispatchedItems(calls)[0].kind).toBe("viewRef");
    expect(dispatchedItems(calls)[0].dataUrl).toBeUndefined();
    expect(state.fetchImageCalls).toEqual([]);
  });

  it("a cloud canvas tab is inlined the same way", async () => {
    state.cloud = true;
    state.fetchImage = async () => ({
      base64: PNG_BYTES.toString("base64"),
      mimeType: "image/png",
    });
    const { ctx, calls } = makeCtx();
    await showMedia(ctx, [{ source: { filename: "plate.png", type: "output" } }]);
    expect(dispatchedItems(calls)[0].kind).toBe("image");
    expect(String(dispatchedItems(calls)[0].dataUrl)).toMatch(/^data:image\/png;base64,/);
    expect(state.fetchImageCalls[0]?.filename).toBe("plate.png");
  });

  it("when fetchImage 404s, the tool fails closed instead of forwarding a broken viewRef", async () => {
    state.remote = true;
    state.fetchImage = async () => {
      throw new ComfyUIError(
        'ComfyUI /view returned 404 for "clip.mp4" (output). No such file in the ComfyUI output directory.',
        "IMAGE_NOT_FOUND",
      );
    };
    const { ctx, calls } = makeCtx();
    const res = await showMedia(ctx);
    expect(res.isError).toBe(true);
    expect(calls.find((c) => c.cmd === "show_media")).toBeUndefined();
    const text = textOf(res);
    expect(text).toContain("clip.mp4");
    expect(text).toContain("painted:0");
    expect(text).toContain("get_image");
    expect(text).toContain("returned 404");
    expect(text).toMatch(/did not substitute a same-named local workspace file/i);
  });

  it("over-cap remote media is refused — the 20 MB inline ceiling is not raised", async () => {
    state.remote = true;
    state.fetchImage = async (_f, _t, _s, options) => {
      throw new ComfyUIError(
        `ComfyUI /view response for "clip.mp4" exceeds the ${(options?.maxBytes ?? 0) / 1024 ** 2} MB safety limit.`,
        "VIEW_TOO_LARGE",
      );
    };
    const { ctx, calls } = makeCtx();
    const res = await showMedia(ctx);
    expect(res.isError).toBe(true);
    expect(calls.find((c) => c.cmd === "show_media")).toBeUndefined();
    expect(textOf(res)).toMatch(/20 MB inline cap/i);
  });

  it("does not read a same-named local file when proxying a remote ref", async () => {
    state.remote = true;
    const remoteBytes = Buffer.from("remote-mp4-bytes");
    state.fetchImage = async () => ({
      base64: remoteBytes.toString("base64"),
      mimeType: "video/mp4",
    });
    const { ctx, calls } = makeCtx();
    await showMedia(ctx);
    const dataUrl = String(dispatchedItems(calls)[0].dataUrl);
    expect(dataUrl).toBe(`data:video/mp4;base64,${remoteBytes.toString("base64")}`);
    expect(dataUrl).not.toContain(Buffer.from("LOCAL-STALE-MIRROR").toString("base64"));
  });

  it("passes subfolder and type through to fetchImage the way get_image does", async () => {
    state.remote = true;
    state.fetchImage = async () => ({
      base64: PNG_BYTES.toString("base64"),
      mimeType: "image/png",
    });
    const { ctx, calls } = makeCtx();
    await showMedia(ctx, [
      { source: { filename: "plate.png", type: "temp", subfolder: "shots" } },
    ]);
    expect(state.fetchImageCalls).toEqual([
      { filename: "plate.png", type: "temp", subfolder: "shots", options: { maxBytes: 20 * 1024 * 1024 } },
    ]);
    expect(dispatchedItems(calls)[0].kind).toBe("image");
  });
});

describe("#2861 the call site uses fetchImage, not a local workspace read", () => {
  it("panel_show_media's remote branch calls fetchImage", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../orchestrator/panel-tools.ts"),
      "utf8",
    );
    expect(src).toMatch(/fetchImage\(/);
    expect(src).toMatch(/remoteViewRefInlineFailedNote/);
    expect(src).toMatch(/isRemoteMode\(\) \|\| isCloudMode\(\)/);
  });
});
