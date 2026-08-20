// #1905 — upload_image (action:"video") on a healthy ComfyUI answered HTTP 413
// with aiohttp's plain-text size-limit sentence, and the tool classified it as
// NON_JSON_RESPONSE then recommended checking the base URL. Drive the SHIPPED
// tool through the real upload helper; mocking the service would let the
// misdiagnosis survive.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  config: { comfyuiSsl: false, comfyuiPath: "", comfyuiBasePath: "" },
  getComfyUIApiHost: () => "remote.example:8188",
  getComfyUIBasePath: () => "",
  getComfyUIBaseUrl: () => "http://remote.example:8188",
  getComfyUIAuthHeaders: () => ({}),
  isCloudMode: () => false,
  isRemoteMode: () => true,
}));

import { resetClient } from "../../comfyui/client.js";
import { resetComfyApiRootValidated } from "../../comfyui/json-guard.js";
import { registerImageManagementTools } from "../../tools/image-management.js";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

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

const COMFY_SIZE_LIMIT_BODY =
  "Maximum request body size 104857600 exceeded, actual body size 104923136";

function serve413(): void {
  global.fetch = vi.fn(async () => {
    return new Response(COMFY_SIZE_LIMIT_BODY, {
      status: 413,
      statusText: "Content Too Large",
      headers: { "content-type": "text/plain" },
    });
  }) as unknown as typeof fetch;
}

let scratch: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  resetClient();
  resetComfyApiRootValidated();
  scratch = undefined;
});

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe('upload_image action:"video" names HTTP 413 as UPLOAD_TOO_LARGE (#1905)', () => {
  it("does not recommend a wrong ComfyUI base URL when the body is the size-limit sentence", async () => {
    serve413();
    scratch = await mkdtemp(join(tmpdir(), "upload-413-"));
    const sourcePath = join(scratch, "clip.mp4");
    await writeFile(sourcePath, Buffer.from("not-a-real-mp4-but-the-server-never-sees-it"));

    const out = await getHandler("upload_image")({
      action: "video",
      source_path: sourcePath,
    });

    expect(out.isError).toBe(true);
    const text = out.content[0]?.text ?? "";
    const parsed = JSON.parse(text) as { error?: string; message?: string; details?: { limitBytes?: number; actualBytes?: number } };
    expect(parsed.error).toBe("UPLOAD_TOO_LARGE");
    expect(parsed.message).toContain("/upload/image");
    expect(parsed.message).toContain("104857600");
    expect(parsed.message).toContain("104923136");
    expect(parsed.message).toMatch(/trim or compress/i);
    expect(parsed.message).not.toContain("Confirm the configured ComfyUI base URL");
    expect(parsed.message).not.toContain("really is a ComfyUI API root");
    expect(parsed.message).not.toContain("NON_JSON_RESPONSE");
    expect(parsed.details).toMatchObject({
      limitBytes: 104857600,
      actualBytes: 104923136,
    });
  });
});
