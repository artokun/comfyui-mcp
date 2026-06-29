import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  removeBackground,
  REMBG_NODE,
  type RemoveBackgroundDeps,
} from "../../services/remove-background.js";
import { DefaultsManager } from "../../services/defaults-manager.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

function makeDeps(overrides: Partial<RemoveBackgroundDeps> = {}) {
  const enqueued: WorkflowJSON[] = [];
  const deps: RemoveBackgroundDeps = {
    isNodeInstalled: vi.fn(async () => true),
    enqueue: async (wf) => {
      enqueued.push(wf);
      return { prompt_id: "pid-rembg", queue_remaining: 0 };
    },
    ...overrides,
  };
  return { deps, enqueued };
}

function node(wf: WorkflowJSON, type: string) {
  return Object.values(wf).find((n) => n.class_type === type);
}

describe("removeBackground", () => {
  beforeEach(() => {
    DefaultsManager.reset();
    DefaultsManager.configure({ configPath: "/tmp/__never__.json", env: {} });
  });

  it("builds a LoadImage → BiRefNetRMBG → SaveImage graph wired in order", async () => {
    const { deps, enqueued } = makeDeps();
    const res = await removeBackground({ image: "subject.png" }, deps);

    expect(res.prompt_id).toBe("pid-rembg");
    const wf = enqueued[0];
    expect(node(wf, "LoadImage")!.inputs.image).toBe("subject.png");
    const rembg = node(wf, REMBG_NODE)!;
    expect(rembg.inputs.image).toEqual(["1", 0]);
    expect(rembg.inputs.model).toBe("BiRefNet_toonout");
    const save = node(wf, "SaveImage")!;
    expect(save.inputs.images).toEqual(["2", 0]);
  });

  it("applies a model override", async () => {
    const { deps, enqueued } = makeDeps();
    const res = await removeBackground({ image: "s.png", model: "RMBG-2.0" }, deps);
    expect(node(enqueued[0], REMBG_NODE)!.inputs.model).toBe("RMBG-2.0");
    expect(res.model).toBe("RMBG-2.0");
  });

  it("throws an actionable error when the rembg node is not installed", async () => {
    const { deps } = makeDeps({ isNodeInstalled: async () => false });
    await expect(removeBackground({ image: "s.png" }, deps)).rejects.toThrow(
      /ComfyUI-RMBG|comfyui-rmbg|not installed/i,
    );
  });

  it("proceeds when install state is unknown (undefined)", async () => {
    const { deps, enqueued } = makeDeps({ isNodeInstalled: async () => undefined });
    await removeBackground({ image: "s.png" }, deps);
    expect(enqueued).toHaveLength(1);
  });

  it("throws when image is missing", async () => {
    const { deps } = makeDeps();
    await expect(removeBackground({ image: "" }, deps)).rejects.toThrow(/image is required/i);
  });
});
