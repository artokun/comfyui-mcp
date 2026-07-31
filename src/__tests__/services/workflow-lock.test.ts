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

  // Regression for #482: a UI-format saved workflow (nodes[]/links[] with
  // `type` + widgets_values, NOT class_type + inputs) referencing native
  // VAELoader (`vae_name`) + UNETLoader (`unet_name`) locked 0 models because
  // extraction only understood API/prompt format. generateLock must normalize
  // UI format first so both native loader models are captured and hashed.
  it("captures native VAELoader + UNETLoader models from a UI-format workflow (#482)", async () => {
    await mkdir(join(tempDir, "models", "vae"), { recursive: true });
    await mkdir(join(tempDir, "models", "diffusion_models"), { recursive: true });
    await mkdir(join(tempDir, "models", "upscale_models"), { recursive: true });
    await writeFile(
      join(tempDir, "models", "vae", "seedvr2_ema_vae_fp16.safetensors"),
      "vae-bytes",
    );
    await writeFile(
      join(tempDir, "models", "diffusion_models", "seedvr2_3b_fp8_e4m3fn.safetensors"),
      "unet-bytes",
    );
    // A non-.safetensors asset extension (.pt2) must also be recognized.
    await writeFile(join(tempDir, "models", "upscale_models", "4x_realesrgan.pt2"), "up-bytes");

    // /object_info supplies the widget schema the UI→API converter needs to map
    // each node's positional widgets_values to its named inputs.
    getObjectInfo.mockResolvedValue({
      VAELoader: {
        python_module: "nodes",
        input: { required: { vae_name: [["seedvr2_ema_vae_fp16.safetensors"], {}] } },
        input_order: { required: ["vae_name"] },
      },
      UNETLoader: {
        python_module: "nodes",
        input: {
          required: {
            unet_name: [["seedvr2_3b_fp8_e4m3fn.safetensors"], {}],
            weight_dtype: [["default", "fp8_e4m3fn"], { default: "default" }],
          },
        },
        input_order: { required: ["unet_name", "weight_dtype"] },
      },
    });

    // A ComfyUI-UI-saved graph: nodes[] with `type` + widgets_values, links[].
    const uiWorkflow = {
      last_node_id: 2,
      last_link_id: 0,
      nodes: [
        {
          id: 1,
          type: "VAELoader",
          pos: [0, 0],
          widgets_values: ["seedvr2_ema_vae_fp16.safetensors"],
          outputs: [{ name: "VAE", type: "VAE", links: null }],
        },
        {
          id: 2,
          type: "UNETLoader",
          pos: [0, 200],
          widgets_values: ["seedvr2_3b_fp8_e4m3fn.safetensors", "default"],
          outputs: [{ name: "MODEL", type: "MODEL", links: null }],
        },
        {
          id: 3,
          type: "UpscaleModelLoader",
          pos: [0, 400],
          widgets_values: ["4x_realesrgan.pt2"],
          outputs: [{ name: "UPSCALE_MODEL", type: "UPSCALE_MODEL", links: null }],
        },
      ],
      links: [],
    } as never;

    const lock = await generateLock(uiWorkflow);

    expect(lock.models).toHaveLength(3);
    const upscale = lock.models.find((m) => m.name === "4x_realesrgan.pt2");
    expect(upscale).toBeDefined();
    expect(upscale!.type).toBe("upscale_models");
    expect(upscale!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const vae = lock.models.find((m) => m.name === "seedvr2_ema_vae_fp16.safetensors");
    const unet = lock.models.find((m) => m.name === "seedvr2_3b_fp8_e4m3fn.safetensors");
    expect(vae).toBeDefined();
    expect(vae!.type).toBe("vae");
    expect(vae!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(unet).toBeDefined();
    expect(unet!.type).toBe("diffusion_models");
    expect(unet!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  // A UI-saved graph may bypass/mute a loader (mode 2/4) or reference a native
  // loader whose class isn't in /object_info. A whole-graph UI→API conversion
  // would drop such nodes and silently omit their models from the lock; reading
  // UI nodes directly must still capture them (provenance = every referenced
  // model, regardless of mute state — matches the API-format walk).
  it("still captures a bypassed loader's model in a UI-format workflow (#482)", async () => {
    await mkdir(join(tempDir, "models", "vae"), { recursive: true });
    await writeFile(join(tempDir, "models", "vae", "bypassed_vae.safetensors"), "vae-bytes");
    getObjectInfo.mockResolvedValue({}); // loader class absent from /object_info

    const uiWorkflow = {
      nodes: [
        {
          id: 1,
          type: "VAELoader",
          mode: 4, // bypassed
          pos: [0, 0],
          widgets_values: ["bypassed_vae.safetensors"],
        },
      ],
      links: [],
    } as never;

    const lock = await generateLock(uiWorkflow);
    expect(lock.models).toHaveLength(1);
    expect(lock.models[0]).toMatchObject({
      name: "bypassed_vae.safetensors",
      type: "vae",
    });
    expect(lock.models[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  // A loader nested inside a subgraph definition (definitions.subgraphs[].nodes)
  // must also be captured — otherwise a component's model silently vanishes from
  // the lock. The top-level subgraph INSTANCE (type = the def's UUID) is
  // structural and must NOT be treated as a real node.
  it("captures a loader nested inside a UI subgraph definition, and does NOT treat the instance UUID as a real node (#482)", async () => {
    await mkdir(join(tempDir, "models", "vae"), { recursive: true });
    await writeFile(join(tempDir, "models", "vae", "nested_vae.safetensors"), "vae-bytes");

    // Give the subgraph-INSTANCE UUID a (bogus) custom-pack origin. If the walk
    // wrongly treated the structural instance as a real node, this phantom pack
    // would be recorded in node_packs. The skip must keep it out.
    const instanceId = "1111aaaa-2222-bbbb-3333-cccc4444dddd";
    getObjectInfo.mockResolvedValue({
      VAELoader: { python_module: "nodes" },
      [instanceId]: { python_module: "custom_nodes.PhantomPack.foo" },
    });
    await mkdir(join(tempDir, "custom_nodes", "PhantomPack", ".git"), { recursive: true });
    await writeFile(
      join(tempDir, "custom_nodes", "PhantomPack", ".git", "HEAD"),
      "feedface0000000000000000000000000000face\n",
    );

    const uiWorkflow = {
      nodes: [
        // A subgraph instance: its `type` is the definition id (a UUID). Not a
        // real node — must be skipped, not mistaken for a class_type/loader.
        { id: 10, type: instanceId, pos: [0, 0] },
      ],
      links: [],
      definitions: {
        subgraphs: [
          {
            id: instanceId,
            name: "MyComponent",
            nodes: [
              {
                id: 1,
                type: "VAELoader",
                pos: [0, 0],
                widgets_values: ["nested_vae.safetensors"],
              },
            ],
            links: [],
          },
        ],
      },
    } as never;

    const lock = await generateLock(uiWorkflow);
    expect(lock.models).toHaveLength(1);
    expect(lock.models[0]).toMatchObject({ name: "nested_vae.safetensors", type: "vae" });
    expect(lock.models[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    // The structural instance UUID must never surface as a custom pack.
    expect(lock.node_packs.map((p) => p.id)).not.toContain("PhantomPack");
    expect(lock.node_packs).toHaveLength(0);
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
