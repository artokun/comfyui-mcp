// #2785 — get_image refused a 41.5 MB PNG with VIEW_TOO_LARGE before
// max_preview_dimension could downscale it. The /view byte guard still exists
// (and still has a hard cap); still-image get_image reads may use the 64 MB
// preview-source ceiling, and a local file in that window is recovered so the
// existing inline preview can run.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { ComfyUIError } from "../../utils/errors.js";
import { MAX_PREVIEW_SOURCE_BYTES, MAX_VIEW_RESPONSE_BYTES } from "../../comfyui/bounded-response.js";

const mocks = vi.hoisted(() => ({
  config: {
    comfyuiPath: "",
    comfyuiBasePath: "",
    comfyuiSsl: false,
  },
  fetchImage: vi.fn(),
  getSystemStats: vi.fn(),
  comfyApiFetch: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
  open: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return {
    ...actual,
    config: mocks.config,
    isCloudMode: () => false,
    isRemoteMode: () => false,
  };
});

vi.mock("../../comfyui/client.js", async () => {
  const actual = await vi.importActual<typeof import("../../comfyui/client.js")>("../../comfyui/client.js");
  return {
    ...actual,
    fetchImage: (...args: unknown[]) => mocks.fetchImage(...args),
    getSystemStats: (...args: unknown[]) => mocks.getSystemStats(...args),
    comfyApiFetch: (...args: unknown[]) => mocks.comfyApiFetch(...args),
  };
});

vi.mock("../../services/workspace-env.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/workspace-env.js")>("../../services/workspace-env.js");
  return {
    ...actual,
    getLiveServerSnapshot: async () => {
      try {
        const stats = await mocks.getSystemStats();
        return {
          reachable: true,
          argv: stats?.system?.argv,
          cwd: stats?.system?.cwd,
        };
      } catch {
        return { reachable: false };
      }
    },
    resolveLiveServerRoot: (argv?: string[], cwd?: string) => {
      const fromArgv = actual.liveRootFromArgv(argv, cwd);
      if (fromArgv) return { root: fromArgv, source: "argv" };
      return { source: "unresolved" };
    },
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    realpath: (...args: unknown[]) => mocks.realpath(...args),
    stat: (...args: unknown[]) => mocks.stat(...args),
    open: (...args: unknown[]) => mocks.open(...args),
    mkdir: (...args: unknown[]) => mocks.mkdir(...args),
    writeFile: (...args: unknown[]) => mocks.writeFile(...args),
  };
});

import { registerImageManagementTools } from "../../tools/image-management.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function getHandler(name: string): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (toolName: string, _description: string, _schema: unknown, toolHandler: ToolHandler) => {
      if (toolName === name) handler = toolHandler;
    },
  };
  registerImageManagementTools(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

function fileHandleFor(bytes: Buffer) {
  let position = 0;
  return {
    read: vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      const slice = bytes.subarray(position, position + length);
      slice.copy(buffer, offset);
      position += slice.length;
      return { bytesRead: slice.length, buffer };
    }),
    close: vi.fn(async () => undefined),
  };
}

async function noisyPng(width: number, height: number): Promise<Buffer> {
  const px = Buffer.alloc(width * height * 3);
  let seed = 12345;
  for (let i = 0; i < px.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    px[i] = seed & 0xff;
  }
  return sharp(px, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
}

const filename = "NC04_4X_UPSCALE_00002_.png";

describe("get_image — oversized PNG preview (#2785)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.comfyuiPath = resolve("test-fixtures", "configured-comfyui");
    mocks.getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
    mocks.comfyApiFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    mocks.realpath.mockImplementation(async (path: string) => path);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
  });

  it("downscales a local PNG that /view refused at 32 MB", async () => {
    const png = await noisyPng(200, 200);
    const localPath = join(resolve(mocks.config.comfyuiPath), "output", filename);
    mocks.fetchImage.mockRejectedValue(
      new ComfyUIError(
        `ComfyUI /view response for "${filename}" exceeds the ${MAX_VIEW_RESPONSE_BYTES / 1024 ** 2} MB safety limit.`,
        "VIEW_TOO_LARGE",
        { filename, maxBytes: MAX_VIEW_RESPONSE_BYTES },
      ),
    );
    mocks.stat.mockResolvedValue({ isFile: () => true, size: 40 * 1024 * 1024 });
    mocks.open.mockResolvedValue(fileHandleFor(png));

    const out = await getHandler("get_image")({
      action: "get",
      filename,
      type: "output",
      max_preview_dimension: 64,
      save_dir: resolve("test-fixtures", "saved-images"),
    });

    expect(out.isError).toBeUndefined();
    expect(mocks.fetchImage).toHaveBeenCalledWith(filename, "output", "", {
      maxBytes: MAX_PREVIEW_SOURCE_BYTES,
    });
    expect(mocks.open).toHaveBeenCalledWith(localPath, "r");
    expect(mocks.writeFile).toHaveBeenCalledWith(
      join(resolve("test-fixtures", "saved-images"), filename),
      png,
    );
    const image = out.content.find((block) => block.type === "image");
    expect(image?.mimeType).toBe("image/png");
    expect(image?.data).toBeDefined();
    const meta = await sharp(Buffer.from(image?.data ?? "", "base64")).metadata();
    expect(meta.width).toBeLessThanOrEqual(64);
    expect(meta.height).toBeLessThanOrEqual(64);
    expect(out.content.map((block) => block.text ?? "").join(" ")).toMatch(/PREVIEW ONLY/);
  });

  it("fails closed with a preview-aware size error when the source is over 64 MB", async () => {
    mocks.fetchImage.mockRejectedValue(
      new ComfyUIError(
        `ComfyUI /view response for "${filename}" exceeds the ${MAX_PREVIEW_SOURCE_BYTES / 1024 ** 2} MB safety limit.`,
        "VIEW_TOO_LARGE",
        { filename, maxBytes: MAX_PREVIEW_SOURCE_BYTES },
      ),
    );
    mocks.stat.mockResolvedValue({ isFile: () => true, size: MAX_PREVIEW_SOURCE_BYTES + 1 });

    const out = await getHandler("get_image")({
      action: "get",
      filename,
      type: "output",
      max_preview_dimension: 1500,
    });

    expect(out.isError).toBe(true);
    const text = out.content.map((block) => block.text ?? "").join(" ");
    expect(text).toContain("VIEW_TOO_LARGE");
    expect(text).toMatch(/64 MB safety limit/);
    expect(text).toContain("max_preview_dimension");
    expect(text).toContain("convert");
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
