// #1483 — check_runtime called a paid fal.ai node "local … no paid credits".
//
// THE FIXTURES ARE THE REPORT'S OWN NODE, and that is the point of this file. The
// appealing structural fix — "flag anything that takes an api_key input" — was measured
// against the actual pack (`gokayfem/ComfyUI-fal-API`, nodes/image_node.py) and its
// NanoBanana classes take NO credential input: `prompt`, `aspect_ratio`, `num_images`,
// `seed`, and the FAL key comes from the environment. A suite built around a convenient
// fixture would have gone green while the reporter's graph stayed "free".
//
// The other shapes here are the measured population of a real 4304-node /object_info:
// 3464 custom-node classes, 0 of them carrying api_node:true, 220 core partner nodes,
// and 49 classes exposing a credential input.
import { describe, expect, it } from "vitest";
import { checkWorkflowRuntime, isApiNode, isExternalServiceNode } from "../../services/api-nodes.js";
import type { ComfyUINodeDef, ObjectInfo } from "../../comfyui/types.js";

const def = (over: Partial<ComfyUINodeDef>): ComfyUINodeDef =>
  ({
    input: { required: {} },
    output: [],
    name: "n",
    display_name: "n",
    description: "",
    category: "",
    python_module: "nodes",
    ...over,
  }) as ComfyUINodeDef;

/** The reported node, as /object_info actually describes it. No credential input. */
const NANO_BANANA_PRO_FAL = def({
  name: "NanoBananaPro_fal",
  display_name: "Nano Banana Pro (fal)",
  category: "FAL/Image",
  python_module: "custom_nodes.ComfyUI-fal-API",
  input: {
    required: { prompt: ["STRING", {}], aspect_ratio: [["1:1", "16:9"], {}] },
    optional: { num_images: ["INT", {}], seed: ["INT", {}] },
  },
});

/** A local helper shipped INSIDE the same paid pack — flagging it costs a false prompt. */
const FAL_LOCAL_HELPER = def({
  name: "ImageResize_fal",
  category: "FAL/Utils",
  python_module: "custom_nodes.ComfyUI-fal-API",
  input: { required: { image: ["IMAGE", {}] } },
});

/** A paid third-party node from a pack nobody enumerated — caught by the credential input. */
const NOVITA = def({
  name: "NovitaVideoRequestNode",
  category: "utils/video",
  python_module: "custom_nodes.comfyui-utils-nodes",
  input: { required: { prompt: ["STRING", {}] }, optional: { api_key: ["STRING", {}] } },
});

/** An ordinary local third-party node — the 3464-class population that must stay free. */
const IMPACT = def({
  name: "ImpactMakeImageBatch",
  category: "ImpactPack/Util",
  python_module: "custom_nodes.ComfyUI-Impact-Pack",
  input: { required: { image1: ["IMAGE", {}] } },
});

/** #1855 — PoYo's official pack. Note what is NOT here: no api_key input (the pack keeps
 *  the credential out of the workflow) and api_node is absent/false. Every generic signal
 *  this module has says "free"; only the named entry knows better. */
const POYO_GENERATE = def({
  name: "PoYo_GenerateImage",
  category: "PoYo AI/Generate",
  python_module: "custom_nodes.poyo-comfyui",
  input: { required: { prompt: ["STRING", {}] } },
});

const CORE_SAMPLER = def({ name: "KSampler", category: "sampling", python_module: "nodes" });
const CORE_PREVIEW = def({ name: "PreviewImage", category: "image", python_module: "nodes" });
const CORE_LOAD = def({ name: "LoadImage", category: "image", python_module: "nodes" });
/** A genuine Comfy partner node — must stay in `apiNodes`, not the new list. */
const PARTNER = def({ name: "ClaudeNode", category: "api node/text", api_node: true } as never);

const objectInfo = (entries: Record<string, ComfyUINodeDef>): ObjectInfo =>
  entries as unknown as ObjectInfo;

const runtimeOf = (classTypes: string[], oi: Record<string, ComfyUINodeDef>) =>
  checkWorkflowRuntime(
    Object.fromEntries(classTypes.map((ct, i) => [String(i + 1), { class_type: ct, inputs: {} }])),
    { getObjectInfo: async () => objectInfo(oi), enqueue: async () => ({ prompt_id: "x" }) },
  );

describe("a paid external-service node is never reported as local/free (#1483)", () => {
  it("THE REPORTED GRAPH: NanoBananaPro_fal is no longer local/free", async () => {
    // The exact class_types from the report, and the exact verdict it produced.
    const out = await runtimeOf(
      ["PreviewImage", "NanoBananaPro_fal", "ImpactMakeImageBatch", "LoadImage"],
      {
        PreviewImage: CORE_PREVIEW,
        NanoBananaPro_fal: NANO_BANANA_PRO_FAL,
        ImpactMakeImageBatch: IMPACT,
        LoadImage: CORE_LOAD,
      },
    );

    expect(out.runtime).toBe("mixed");
    expect(out.usesApiNodes).toBe(true);
    expect(out.externalApiNodes).toEqual(["NanoBananaPro_fal"]);
    // The provider is NAMED, so the reader knows whose balance to check (codex).
    expect(out.externalProviders).toEqual(["fal.ai"]);
    // It is NOT a Comfy partner node and must not be described as one.
    expect(out.apiNodes).toEqual([]);
    // The report's `unknownNodes: []` was correct and stays correct — the node IS
    // installed. Being known is exactly what made it confidently misclassified before.
    expect(out.unknownNodes).toEqual([]);
  });

  it("the credential-input catch covers a pack nobody enumerated", async () => {
    const out = await runtimeOf(["NovitaVideoRequestNode", "PreviewImage"], {
      NovitaVideoRequestNode: NOVITA,
      PreviewImage: CORE_PREVIEW,
    });
    expect(out.usesApiNodes).toBe(true);
    expect(out.externalApiNodes).toEqual(["NovitaVideoRequestNode"]);
  });

  it("ORDINARY local third-party nodes stay free — the direction that must not regress", async () => {
    // 3464 of 4304 measured classes are custom-node-registered. If this drifts to
    // "possibly paid", every real workflow warns and the warning stops meaning anything.
    const out = await runtimeOf(["KSampler", "ImpactMakeImageBatch", "LoadImage"], {
      KSampler: CORE_SAMPLER,
      ImpactMakeImageBatch: IMPACT,
      LoadImage: CORE_LOAD,
    });
    expect(out.runtime).toBe("local");
    expect(out.usesApiNodes).toBe(false);
    expect(out.externalApiNodes).toEqual([]);
  });

  it("a paid pack's OWN local helper is not flagged", async () => {
    // FAL/Utils resizes an image before upload and spends nothing. Being shipped next to
    // paid nodes is not evidence about this node.
    expect(isExternalServiceNode(FAL_LOCAL_HELPER)).toBe(false);
    const out = await runtimeOf(["ImageResize_fal", "KSampler"], {
      ImageResize_fal: FAL_LOCAL_HELPER,
      KSampler: CORE_SAMPLER,
    });
    expect(out.runtime).toBe("local");
  });

  it("a Comfy PARTNER node stays in apiNodes and out of the new list", async () => {
    // The two are not merged: `isApiNode` also drives listApiNodes and the 3D picker,
    // which hand out schemas on the assumption of Comfy's own auth model.
    expect(isApiNode(PARTNER)).toBe(true);
    expect(isExternalServiceNode(PARTNER)).toBe(false);
    const out = await runtimeOf(["ClaudeNode"], { ClaudeNode: PARTNER });
    expect(out.apiNodes).toEqual(["ClaudeNode"]);
    expect(out.externalApiNodes).toEqual([]);
    expect(out.runtime).toBe("api");
  });

  it("an all-external graph reads `api`, not `mixed`", async () => {
    const out = await runtimeOf(["NanoBananaPro_fal"], { NanoBananaPro_fal: NANO_BANANA_PRO_FAL });
    expect(out.runtime).toBe("api");
    expect(out.usesApiNodes).toBe(true);
  });

  // ── codex review: the three false-NEGATIVE holes, each a way to keep spending money ──

  it("a RENAMED install directory is still caught (codex P1)", async () => {
    // `python_module` is just the folder the user cloned into. Cloning ComfyUI-fal-API as
    // `my_fal_install` changes it and nothing else, and a module-only registry answered
    // "free". The pack's CATEGORY is baked into its source, so it survives the rename.
    const renamed = def({
      ...NANO_BANANA_PRO_FAL,
      python_module: "custom_nodes.my_fal_install",
    } as Partial<ComfyUINodeDef>);
    expect(isExternalServiceNode(renamed)).toBe(true);
    const out = await runtimeOf(["NanoBananaPro_fal"], { NanoBananaPro_fal: renamed });
    expect(out.runtime).toBe("api");
    expect(out.externalProviders).toEqual(["fal.ai"]);
  });

  it("other credential spellings are caught — api_token, camelCase, client_secret (codex P1)", async () => {
    // `/i` folds case but not word shape, so `apiToken` slipped through an `api_?key`-only
    // pattern; the name is normalised to snake_case before matching now.
    for (const inputName of ["api_token", "apiToken", "client_secret", "accessToken", "bearer_token"]) {
      const node = def({
        name: `Paid_${inputName}`,
        category: "misc",
        python_module: "custom_nodes.some-unlisted-pack",
        input: { required: { prompt: ["STRING", {}] }, optional: { [inputName]: ["STRING", {}] } },
      });
      expect(isExternalServiceNode(node), `${inputName} must be treated as a credential`).toBe(true);
    }
  });

  it("a more specific pack entry is not defeated by a broader one's exemption (codex P1)", async () => {
    // `custom_nodes.ComfyUI-fal-API-Flux` also contains the substring `comfyui-fal-api`.
    // Returning on the FIRST match let it inherit that entry's FAL/Utils exemption, so a
    // paid Flux node in that category answered "free" while the stricter entry written for
    // this very pack was never reached. Every match is considered and PAID wins.
    const fluxInUtils = def({
      name: "FluxPro_fal",
      category: "FAL/Utils",
      python_module: "custom_nodes.ComfyUI-fal-API-Flux",
      input: { required: { prompt: ["STRING", {}] } },
    });
    expect(isExternalServiceNode(fluxInUtils)).toBe(true);
  });

  it("a local crypto node taking `secret_key` is NOT called paid (codex P2)", async () => {
    // The false-positive direction. Authentication is not proof of a paid service — this
    // hashes locally and spends nothing, and reporting it as `api` would teach the reader
    // that the warning is noise.
    const hasher = def({
      name: "HMACSign",
      category: "utils/crypto",
      python_module: "custom_nodes.comfyui-logicutils",
      input: { required: { text: ["STRING", {}], secret_key: ["STRING", {}] } },
    });
    expect(isExternalServiceNode(hasher)).toBe(false);
    const out = await runtimeOf(["HMACSign", "KSampler"], { HMACSign: hasher, KSampler: CORE_SAMPLER });
    expect(out.runtime).toBe("local");
  });

  it("#1855 THE REPORTED GRAPH: PoYo_GenerateImage is no longer local/free", async () => {
    // The exact verdict from the report: {"runtime":"local","usesApiNodes":false}.
    const out = await runtimeOf(["PoYo_GenerateImage"], { PoYo_GenerateImage: POYO_GENERATE });

    expect(out.runtime).toBe("api");
    expect(out.usesApiNodes).toBe(true);
    expect(out.externalApiNodes).toEqual(["PoYo_GenerateImage"]);
    // NAMED, so a reader knows whose balance to check.
    expect(out.externalProviders).toEqual(["PoYo"]);
    // Not a Comfy partner node, and must not be described as one.
    expect(out.apiNodes).toEqual([]);
    // It IS installed — being known is what made it confidently misclassified.
    expect(out.unknownNodes).toEqual([]);
  });

  it("#1855: the category prefix matches even when the pack directory is renamed", async () => {
    // A user who clones the pack elsewhere changes python_module and nothing else; the
    // category is baked into the pack's own source. Same reasoning as the fal entries.
    const renamed = def({
      name: "PoYo_GenerateImage",
      category: "PoYo AI/Generate",
      python_module: "custom_nodes.my-poyo-fork",
      input: { required: { prompt: ["STRING", {}] } },
    });
    const out = await runtimeOf(["PoYo_GenerateImage"], { PoYo_GenerateImage: renamed });
    expect(out.externalProviders).toEqual(["PoYo"]);
  });

  it("#1855: a REGISTRY install is caught too, where the module string alone would miss", async () => {
    // The Comfy Registry id is `poyo-nodes` (pyproject name), not the GitHub repo name
    // `poyo-comfyui`, so a registry install reports python_module
    // "custom_nodes.poyo-nodes" — which does not contain the module substring at all.
    // The category prefix is the only thing that catches that path.
    const registryInstalled = def({
      name: "PoYo_GenerateImage",
      category: "PoYo AI/Generate",
      python_module: "custom_nodes.poyo-nodes",
      input: { required: { prompt: ["STRING", {}] } },
    });
    const out = await runtimeOf(["PoYo_GenerateImage"], {
      PoYo_GenerateImage: registryInstalled,
    });
    expect(out.usesApiNodes).toBe(true);
    expect(out.externalProviders).toEqual(["PoYo"]);
  });

  it("#1855: a merely SIMILAR category is not swept in", async () => {
    // "poyo ai" must not match a different pack that happens to start with the same
    // letters — the prefix rule is exact-or-followed-by-slash, and this asserts it.
    // "PoYoAlpha/Mask" would NOT have tested this: it diverges from "poyo ai" at the
    // space, so even a naive startsWith(prefix) passes it. "PoYo AI Extras/Mask" shares
    // the whole prefix and differs only after it, which is the boundary the rule is.
    const other = def({
      name: "PoyoExtrasMasker",
      category: "PoYo AI Extras/Mask",
      python_module: "custom_nodes.poyo-ai-extras",
      input: { required: { image: ["IMAGE", {}] } },
    });
    const out = await runtimeOf(["PoyoExtrasMasker"], { PoyoExtrasMasker: other });
    expect(out.runtime).toBe("local");
    expect(out.usesApiNodes).toBe(false);
    // The field is OMITTED when there is nothing to name, not emitted empty — asserting
    // [] here passed nothing and only proved I had guessed the shape.
    expect(out.externalProviders).toBeUndefined();
  });
});
