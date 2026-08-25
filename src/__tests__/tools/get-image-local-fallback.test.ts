import { beforeEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { ComfyUIError } from "../../utils/errors.js";

const mocks = vi.hoisted(() => ({
  config: {
    comfyuiPath: "",
    comfyuiBasePath: "",
    comfyuiSsl: false,
  },
  fetchImage: vi.fn(),
  getSystemStats: vi.fn(),
  comfyApiFetch: vi.fn(),
  liveRoot: vi.fn(),
  readFile: vi.fn(),
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
    resolveLiveComfyUIBase: (...args: unknown[]) => mocks.liveRoot(...args),
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: (...args: unknown[]) => mocks.readFile(...args),
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

const filename = "dreamina-2026-08-12-1653-Locked-off camera, static 16_9 frame.smo....mp4";
const mp4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);

function view400(): ComfyUIError {
  return new ComfyUIError(
    `ComfyUI /view returned 400 for "${filename}" (input).`,
    "VIEW_ERROR",
    { status: 400, filename, type: "input", subfolder: "" },
  );
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.comfyuiPath = resolve("test-fixtures", "configured-comfyui");
  mocks.getSystemStats.mockResolvedValue({ system: { argv: ["python", "main.py"] } });
  mocks.comfyApiFetch.mockResolvedValue(new Response("{}", { status: 200 }));
  mocks.liveRoot.mockResolvedValue(undefined);
  mocks.fetchImage.mockRejectedValue(view400());
  mocks.readFile.mockResolvedValue(mp4);
  mocks.realpath.mockImplementation(async (path: string) => path);
  mocks.stat.mockResolvedValue({ isFile: () => true });
  mocks.open.mockResolvedValue(fileHandleFor(mp4));
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.writeFile.mockResolvedValue(undefined);
});

describe("get_image — canonical local input fallback (#2194)", () => {
  it("resolves a relative --input-directory against the live cwd, not stale config", async () => {
    const serverCwd = resolve("test-fixtures", "connected-comfyui");
    const customInput = join(serverCwd, "custom-input");
    const staleConfigured = resolve(mocks.config.comfyuiPath, "input", filename);
    const localPath = join(customInput, filename);
    mocks.getSystemStats.mockResolvedValue({
      system: {
        argv: ["python", "main.py", "--input-directory", "custom-input"],
        cwd: serverCwd,
      },
    });

    const out = await getHandler("get_image")({
      action: "get",
      filename,
      type: "input",
      save_dir: resolve("test-fixtures", "saved-images"),
    });

    expect(out.isError).toBeUndefined();
    expect(mocks.getSystemStats).toHaveBeenCalled();
    expect(mocks.fetchImage).toHaveBeenCalledWith(filename, "input", "");
    expect(mocks.open).toHaveBeenCalledWith(localPath, "r");
    expect(mocks.open).not.toHaveBeenCalledWith(staleConfigured, "r");
    expect(mocks.writeFile).toHaveBeenCalledWith(
      join(resolve("test-fixtures", "saved-images"), filename),
      mp4,
    );
    expect(out.content.map((block) => block.text ?? "").join(" ")).toContain("Saved to:");
  });

  it("uses the connected live install input directory when no input flag is present", async () => {
    const liveBase = resolve("test-fixtures", "connected-live-comfyui");
    const localPath = join(liveBase, "input", filename);
    mocks.liveRoot.mockResolvedValue(liveBase);

    const out = await getHandler("get_image")({
      action: "get",
      filename,
      type: "input",
      save_dir: resolve("test-fixtures", "saved-images"),
    });

    expect(out.isError).toBeUndefined();
    expect(mocks.liveRoot).toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledWith(localPath, "r");
    expect(mocks.open).not.toHaveBeenCalledWith(
      join(resolve(mocks.config.comfyuiPath), "input", filename),
      "r",
    );
  });

  it("refuses an oversized local fallback before loading or saving it", async () => {
    const localPath = join(resolve(mocks.config.comfyuiPath), "input", filename);
    const grownHandle = {
      read: vi.fn(async (_buffer: Buffer, _offset: number, length: number) => ({
        bytesRead: length,
      })),
      close: vi.fn(async () => undefined),
    };
    mocks.stat.mockResolvedValue({
      isFile: () => true,
      // The file is at the limit when checked, then grows while it is read.
      size: 32 * 1024 * 1024,
    });
    mocks.open.mockResolvedValue(grownHandle);

    const out = await getHandler("get_image")({
      action: "get",
      filename,
      type: "input",
      save_dir: resolve("test-fixtures", "saved-images"),
    });

    expect(out.isError).toBe(true);
    expect(out.content.map((block) => block.text ?? "").join(" ")).toContain("VIEW_ERROR");
    expect(mocks.realpath).toHaveBeenCalled();
    expect(mocks.stat).toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledWith(localPath, "r");
    expect(grownHandle.read).toHaveBeenCalled();
    expect(grownHandle.close).toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("rejects traversal through the actual get_image handler before fallback I/O", async () => {
    const out = await getHandler("get_image")({
      action: "get",
      filename: "../outside.mp4",
      type: "input",
    });

    expect(out.isError).toBe(true);
    expect(out.content.map((block) => block.text ?? "").join(" ")).toContain("VALIDATION_ERROR");
    expect(mocks.fetchImage).not.toHaveBeenCalled();
    expect(mocks.realpath).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
