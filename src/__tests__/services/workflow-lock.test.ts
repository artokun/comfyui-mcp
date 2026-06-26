import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  config: { comfyuiPath: undefined as string | undefined },
}));

const getObjectInfo = vi.fn();
const getSystemStats = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: (...args: unknown[]) => getObjectInfo(...args),
  getSystemStats: (...args: unknown[]) => getSystemStats(...args),
}));

const { config } = await import("../../config.js");
const { generateLock, diffLocks, parseWorkflowLock } = await import(
  "../../services/workflow-lock.js"
);

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "workflow-lock-test-"));
  config.comfyuiPath = tempDir;
  getObjectInfo.mockReset();
  getSystemStats.mockReset();
  getSystemStats.mockResolvedValue({
    system: { comfyui_version: "0.3.20" },
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe("generateLock", () => {
  it("throws when COMFYUI_PATH is not configured", async () => {
    config.comfyuiPath = undefined;
    await expect(generateLock({} as never)).rejects.toThrow(/local ComfyUI install/);
  });

  it("captures models with SHA-256 + custom pack git HEAD + ComfyUI version", async () => {
    // Set up models on disk: a checkpoint + a lora.
    await mkdir(join(tempDir, "models", "checkpoints"), { recursive: true });
    await mkdir(join(tempDir, "models", "loras"), { recursive: true });
    await writeFile(
      join(tempDir, "models", "checkpoints", "sd_xl.safetensors"),
      "checkpoint-bytes",
    );
    await writeFile(
      join(tempDir, "models", "loras", "my_lora.safetensors"),
      "lora-bytes",
    );

    // Set up a custom node pack with a git HEAD pointing at a ref.
    await mkdir(join(tempDir, "custom_nodes", "MyPack", ".git", "refs", "heads"), {
      recursive: true,
    });
    await writeFile(
      join(tempDir, "custom_nodes", "MyPack", ".git", "HEAD"),
      "ref: refs/heads/main\n",
    );
    await writeFile(
      join(tempDir, "custom_nodes", "MyPack", ".git", "refs", "heads", "main"),
      "abc123def4567890abc123def4567890abc12345\n",
    );

    // /object_info: declare which python_module each class_type comes from.
    getObjectInfo.mockResolvedValue({
      CheckpointLoaderSimple: { python_module: "comfy_extras.nodes_model_loading" },
      LoraLoader: { python_module: "comfy_extras.nodes_lora" },
      MyCustomNode: { python_module: "custom_nodes.MyPack.nodes" },
    });

    const workflow = {
      "1": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: "sd_xl.safetensors" },
      },
      "2": {
        class_type: "LoraLoader",
        inputs: { lora_name: "my_lora.safetensors", model: ["1", 0], clip: ["1", 1] },
      },
      "3": {
        class_type: "MyCustomNode",
        inputs: { some_param: "value" },
      },
    } as never;

    const lock = await generateLock(workflow);

    expect(lock.comfyui_version).toBe("0.3.20");
    expect(lock.models).toHaveLength(2);
    const checkpoint = lock.models.find((m) => m.name === "sd_xl.safetensors")!;
    expect(checkpoint.type).toBe("checkpoints");
    expect(checkpoint.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(checkpoint.missing).toBeUndefined();

    expect(lock.node_packs).toHaveLength(1);
    expect(lock.node_packs[0]).toEqual({
      id: "MyPack",
      commit_sha: "abc123def4567890abc123def4567890abc12345",
    });
  });

  it("marks missing models with `missing: true` instead of failing", async () => {
    getObjectInfo.mockResolvedValue({
      CheckpointLoaderSimple: { python_module: "nodes" },
    });
    const workflow = {
      "1": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: "does-not-exist.safetensors" },
      },
    } as never;
    const lock = await generateLock(workflow);
    expect(lock.models[0]).toEqual({
      name: "does-not-exist.safetensors",
      type: "checkpoints",
      missing: true,
    });
  });

  it("handles detached HEAD (raw SHA in .git/HEAD)", async () => {
    await mkdir(join(tempDir, "custom_nodes", "DetachedPack", ".git"), {
      recursive: true,
    });
    await writeFile(
      join(tempDir, "custom_nodes", "DetachedPack", ".git", "HEAD"),
      "deadbeef0000000000000000000000000000beef\n",
    );
    getObjectInfo.mockResolvedValue({
      DetachedNode: { python_module: "custom_nodes.DetachedPack.foo" },
    });
    const workflow = {
      "1": { class_type: "DetachedNode", inputs: {} },
    } as never;
    const lock = await generateLock(workflow);
    expect(lock.node_packs[0]).toEqual({
      id: "DetachedPack",
      commit_sha: "deadbeef0000000000000000000000000000beef",
    });
  });
});

describe("parseWorkflowLock (graceful no-lock)", () => {
  it("returns null for an empty body instead of throwing (the 'Unexpected end of JSON input' bug)", () => {
    expect(parseWorkflowLock("")).toBeNull();
    expect(parseWorkflowLock("   \n  ")).toBeNull();
  });

  it("returns null for null/undefined (e.g. missing file)", () => {
    expect(parseWorkflowLock(null)).toBeNull();
    expect(parseWorkflowLock(undefined)).toBeNull();
  });

  it("parses a valid lock body", () => {
    const lock = {
      generated_at: "2026-06-01T00:00:00Z",
      comfyui_version: "0.3.20",
      models: [],
      node_packs: [],
    };
    expect(parseWorkflowLock(JSON.stringify(lock))).toEqual(lock);
  });

  it("throws a clear ValidationError on genuinely malformed JSON", () => {
    expect(() => parseWorkflowLock("{ not json")).toThrow(/not valid JSON/i);
  });

  it("returns null for non-object JSON (e.g. a bare number or array)", () => {
    expect(parseWorkflowLock("42")).toBeNull();
    expect(parseWorkflowLock("[]")).toBeNull();
  });
});

describe("diffLocks", () => {
  const baseLock = {
    generated_at: "2026-06-01T00:00:00Z",
    comfyui_version: "0.3.20",
    models: [
      { name: "sd_xl.safetensors", type: "checkpoints", sha256: "a".repeat(64) },
    ],
    node_packs: [{ id: "MyPack", commit_sha: "a".repeat(40) }],
  };

  it("reports zero drift when current matches lock", () => {
    const drift = diffLocks(baseLock, baseLock);
    expect(drift.models).toEqual([]);
    expect(drift.node_packs).toEqual([]);
    expect(drift.comfyui_version).toBeUndefined();
  });

  it("flags changed model SHA-256", () => {
    const current = {
      ...baseLock,
      models: [{ name: "sd_xl.safetensors", type: "checkpoints", sha256: "b".repeat(64) }],
    };
    const drift = diffLocks(baseLock, current);
    expect(drift.models).toHaveLength(1);
    expect(drift.models[0]).toMatchObject({
      name: "sd_xl.safetensors",
      status: "changed",
      lock_sha256: "a".repeat(64),
      current_sha256: "b".repeat(64),
    });
  });

  it("flags changed pack commit", () => {
    const current = { ...baseLock, node_packs: [{ id: "MyPack", commit_sha: "b".repeat(40) }] };
    const drift = diffLocks(baseLock, current);
    expect(drift.node_packs).toHaveLength(1);
    expect(drift.node_packs[0]).toMatchObject({ id: "MyPack", status: "changed" });
  });

  it("flags ComfyUI version drift", () => {
    const current = { ...baseLock, comfyui_version: "0.4.0" };
    const drift = diffLocks(baseLock, current);
    expect(drift.comfyui_version).toEqual({ lock: "0.3.20", current: "0.4.0" });
  });

  it("flags missing models (in lock but not currently referenced)", () => {
    const drift = diffLocks(baseLock, { ...baseLock, models: [] });
    expect(drift.models[0]).toMatchObject({ name: "sd_xl.safetensors", status: "missing" });
  });

  it("flags added models (currently referenced but not in lock)", () => {
    const drift = diffLocks(
      { ...baseLock, models: [] },
      baseLock,
    );
    expect(drift.models[0]).toMatchObject({ name: "sd_xl.safetensors", status: "added" });
  });
});
