// #2861 — panel_show_media forwarded a ComfyUI /view ref to a browser panel
// whose same-origin /view 404'd, while get_image (the configured MCP client)
// fetched the same filename from the remote target. painted: 0, empty card.
//
// A local canvas still gets a viewRef (same-origin /view works). A remote or
// cloud interactive tab is proxied through the MCP client and inlined under
// the existing 20 MB cap — the bytes come from /view via comfyuiFetch, never
// from a same-named file on the orchestrator disk (#877/#899). Headless
// inlining (#2012) is unchanged. Unroutable stays a viewRef.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const state = vi.hoisted(() => ({
  remote: false,
  cloud: false,
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

vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: (url: string, init?: { method?: string }) => {
    state.urls.push(url);
    if (!state.impl) {
      return Promise.reject(new Error("comfyuiFetch was not stubbed"));
    }
    return state.impl(url, init);
  },
}));

const { buildPanelToolDefs } = await import("../../orchestrator/panel-tools.js");

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

afterEach(() => {
  state.remote = false;
  state.cloud = false;
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

function makeCtx(opts?: {
  isHeadless?: (id: string) => boolean;
}): { ctx: PanelToolCtx; calls: Cmd[] } {
  const calls: Cmd[] = [];
  const ctx = {
    call: async (cmd: Cmd) => {
      calls.push(cmd);
      return { content: [{ type: "text", text: JSON.stringify(cmd) }] } as ToolResult;
    },
    confirm: async () => "yes" as const,
    tabId: "wf:workflows/a.json",
    bridge: {
      isHeadless: opts?.isHeadless ?? (() => false),
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

describe("#2861 remote interactive panel_show_media inlines via the MCP client", () => {
  it("a remote canvas tab gets inlined bytes, not a /view ref the browser 404s", async () => {
    state.remote = true;
    const mp4 = Buffer.alloc(64, 1);
    state.impl = mediaFetch("video/mp4", mp4);
    const { ctx, calls } = makeCtx();
    await showMedia(ctx);
    const items = dispatchedItems(calls);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("video");
    expect(String(items[0].dataUrl)).toMatch(/^data:video\/mp4;base64,/);
    expect(items[0].viewRef).toBeUndefined();
    expect(state.urls.some((u) => u.includes("/view?") && u.includes("filename=clip.mp4"))).toBe(true);
    expect(state.urls.every((u) => !u.includes("C:") && !u.includes("/output/"))).toBe(true);
  });

  it("a local canvas tab still gets a viewRef — same-origin /view works", async () => {
    state.remote = false;
    state.impl = mediaFetch("video/mp4", Buffer.alloc(64, 1));
    const { ctx, calls } = makeCtx();
    await showMedia(ctx);
    expect(dispatchedItems(calls)[0].kind).toBe("viewRef");
    expect(dispatchedItems(calls)[0].dataUrl).toBeUndefined();
  });

  it("a cloud canvas tab is inlined the same way", async () => {
    state.cloud = true;
    state.impl = mediaFetch("image/png", PNG_BYTES);
    const { ctx, calls } = makeCtx();
    await showMedia(ctx, [{ source: { filename: "plate.png", type: "output" } }]);
    expect(dispatchedItems(calls)[0].kind).toBe("image");
    expect(String(dispatchedItems(calls)[0].dataUrl)).toMatch(/^data:image\/png;base64,/);
  });

  it("when the MCP client /view 404s, the ref is still forwarded rather than inventing bytes", async () => {
    state.remote = true;
    state.impl = mediaFetch("video/mp4", Buffer.alloc(0), false, 404);
    const { ctx, calls } = makeCtx();
    await showMedia(ctx);
    expect(dispatchedItems(calls)[0].kind).toBe("viewRef");
    expect(dispatchedItems(calls)[0].viewRef).toEqual({
      filename: "clip.mp4",
      type: "output",
    });
  });

  it("over-cap remote media stays a viewRef — the 20 MB inline ceiling is not raised", async () => {
    state.remote = true;
    const tooBig = Buffer.alloc(20 * 1024 * 1024 + 1, 2);
    state.impl = mediaFetch("video/mp4", tooBig);
    const { ctx, calls } = makeCtx();
    await showMedia(ctx);
    expect(dispatchedItems(calls)[0].kind).toBe("viewRef");
    expect(dispatchedItems(calls)[0].dataUrl).toBeUndefined();
  });

  it("does not read a same-named local file when proxying a remote ref", async () => {
    state.remote = true;
    const remoteBytes = Buffer.from("remote-mp4-bytes");
    state.impl = mediaFetch("video/mp4", remoteBytes);
    const { ctx, calls } = makeCtx();
    await showMedia(ctx);
    const dataUrl = String(dispatchedItems(calls)[0].dataUrl);
    expect(dataUrl).toBe(`data:video/mp4;base64,${remoteBytes.toString("base64")}`);
  });
});
