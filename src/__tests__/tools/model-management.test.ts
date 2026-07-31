import { beforeEach, describe, expect, it, vi } from "vitest";

const downloadModelMock = vi.fn();
const listLocalModelsMock = vi.fn();
vi.mock("../../services/model-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/model-resolver.js")>(
    "../../services/model-resolver.js",
  );
  return {
    ...actual,
    downloadModel: (...a: unknown[]) => downloadModelMock(...a),
    listLocalModels: (...a: unknown[]) => listLocalModelsMock(...a),
    // Deterministic local routing (no live server probe) so startDownloadJob keys
    // the job locally and threads dispatchToManager=false into downloadModel.
    shouldDispatchDownloadToManager: async () => false,
    // startDownloadJob resolves the destination via this before streaming; stub
    // it so the tool tests don't need a live server to compute a targetPath.
    resolveDownloadTarget: async (url: string, sub: string, filename?: string) => {
      const name = filename ?? String(url).split("/").pop() ?? "model.safetensors";
      return { targetDir: `/m/${sub}`, filename: name, targetPath: `/m/${sub}/${name}` };
    },
  };
});

import { registerModelManagementTools } from "../../tools/model-management.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function makeServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  registerModelManagementTools(server as never);
  return {
    downloadModel: handlers.get("download_model")!,
    listLocalModels: handlers.get("list_local_models")!,
  };
}

beforeEach(() => {
  downloadModelMock.mockReset();
  listLocalModelsMock.mockReset();
});

describe("download_model tool", () => {
  it("passes optional auth through to downloadModel", async () => {
    downloadModelMock.mockResolvedValueOnce("/comfy/models/checkpoints/x.safetensors");
    const auth = {
      type: "header",
      header_name: "X-Api-Key",
      header_value: "secret",
    };

    const { downloadModel } = makeServer();
    const res = await downloadModel({
      url: "https://example.com/x.safetensors",
      target_subfolder: "checkpoints",
      filename: "x.safetensors",
      auth,
    });

    expect(downloadModelMock).toHaveBeenCalledWith(
      "https://example.com/x.safetensors",
      "checkpoints",
      "x.safetensors",
      auth,
      false, // routing decision threaded through (local, #420 codex round 1)
      expect.any(Function), // onResume callback — reports the resume decision onto the job (#467)
      expect.any(AbortSignal), // per-download abort signal threaded from the job's controller (#515)
      expect.any(Function), // onTrayId callback — aligns the job trayId with the tray row id (#515)
      expect.any(Function), // onLanded callback — commits done synchronously at the destination rename (#515)
    );
    expect(res.isError).toBeFalsy();
  });
});

describe("list_local_models rendering", () => {
  it("renders sidecar hints: trigger words + base, and the civitai provenance line", async () => {
    listLocalModelsMock.mockResolvedValueOnce([
      {
        name: "detail.safetensors",
        path: "loras/detail.safetensors",
        size: 0,
        modified: "",
        type: "loras",
        triggerWords: ["more detail", "hdr"],
        baseModel: "SDXL 1.0",
        civitaiUrl: "https://civitai.com/models/162967?modelVersionId=183635",
      },
      {
        name: "plain.safetensors",
        path: "loras/plain.safetensors",
        size: 0,
        modified: "",
        type: "loras",
      },
    ]);

    const { listLocalModels } = makeServer();
    const res = await listLocalModels({ model_type: "loras" });
    const text = res.content[0].text;

    expect(res.isError).toBeFalsy();
    expect(text).toContain("## loras (2)");
    expect(text).toContain("- detail.safetensors");
    expect(text).toContain("    trigger words: more detail, hdr  ·  base: SDXL 1.0");
    expect(text).toContain(
      "    civitai: https://civitai.com/models/162967?modelVersionId=183635",
    );
    // The un-enriched entry stays a bare name — no stray metadata lines.
    expect(text).toContain("- plain.safetensors");
    expect(text).not.toContain("plain.safetensors (");
  });
});
