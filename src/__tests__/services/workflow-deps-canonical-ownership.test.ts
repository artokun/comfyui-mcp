import { describe, expect, it, vi } from "vitest";
import {
  extractWorkflowDependencies,
  installWorkflowDependencies,
  type WorkflowDepsDeps,
} from "../../services/workflow-deps.js";
import type { WorkflowJSON, ObjectInfo, ComfyUINodeDef } from "../../comfyui/types.js";

/**
 * #2765 — extract_deps mapped `Power Lora Loader (rgthree)`, `Switch latent
 * [Crystools]`, `Krea2EditGroundedEncode` and `Krea2EditModelPatch` to one
 * unrelated repository (`DemonGatanjieu/Anomalous_Model_Browser`), then reported
 * that repository as the MISSING dependency of an approval-gated preflight.
 *
 * The fixtures below are shaped from the live ComfyUI-Manager catalogue
 * (`extension-node-map.json`, 5,614 packs / 40,656 exactly-owned class names),
 * which was measured while diagnosing this issue:
 *
 *   - `nodename_pattern` is routinely over-broad. `Hunyuan` matches 182 class
 *     names owned by OTHER packs when applied with search semantics, 96 with
 *     Manager's own anchored `re.match`. `PulidFlux` matches 13.
 *   - The same pattern is declared by DIFFERENT packs: `Inspire$` (Inspire Pack
 *     and ComfyUI Connection Helper), `_jru$` (two packs), `- Ostris$` (two).
 *   - 1,833 of 40,656 class names (4.51%) are claimed exactly by 2+ packs.
 *
 * So a pattern hit is a naming convention, not an ownership record, and a
 * catalogue collision is a real conflict rather than a tie to break.
 */

function def(name: string, pythonModule: string | undefined): ComfyUINodeDef {
  return {
    input: {},
    output: [],
    output_is_list: [],
    output_name: [],
    name,
    display_name: name,
    description: "",
    category: "",
    output_node: false,
    ...(pythonModule === undefined ? {} : { python_module: pythonModule }),
  } as ComfyUINodeDef;
}

function makeDeps(
  objectInfo: ObjectInfo,
  mappings: Record<string, unknown>,
  overrides: Partial<WorkflowDepsDeps> = {},
): WorkflowDepsDeps {
  return {
    fetchObjectInfo: vi.fn(async () => objectInfo),
    fetchManagerMappings: vi.fn(async () => mappings as never),
    fetchManagerList: vi.fn(async () => ({ channel: "default", packs: [] })),
    queueInstall: vi.fn(async () => undefined),
    resetQueue: vi.fn(async () => undefined),
    startQueue: vi.fn(async () => undefined),
    queueStatus: vi.fn(async () => ({})),
    ...overrides,
  };
}

const byType = (deps: Awaited<ReturnType<typeof extractWorkflowDependencies>>) =>
  Object.fromEntries(deps.dependencies.map((d) => [d.class_type, d]));

describe("#2765 an INSTALLED node is owned by the pack it was imported from", () => {
  /**
   * The reported scenario, reproduced through the mechanism that actually
   * produces it. Manager's own `/customnode/getmappings` handler appends every
   * installed-but-unmapped class name onto the class list of EVERY pack whose
   * `nodename_pattern` matches it (`fetch_customnode_mappings`, glob/manager_server.py),
   * so an over-broad pattern arrives at us already laundered into an
   * apparently-exact mapping. We cannot tell it apart from a real one — which is
   * why /object_info has to win rather than merely be consulted first.
   */
  const OBJECT_INFO: ObjectInfo = {
    "Power Lora Loader (rgthree)": def(
      "Power Lora Loader (rgthree)",
      "custom_nodes.rgthree-comfy.power_lora_loader",
    ),
    "Switch latent [Crystools]": def(
      "Switch latent [Crystools]",
      "custom_nodes.ComfyUI-Crystools.nodes.switch",
    ),
  };

  const LAUNDERED_MAPPINGS = {
    // The unrelated pack, carrying both the broad pattern AND the class names
    // Manager already appended to it on the server side.
    "https://github.com/DemonGatanjieu/Anomalous_Model_Browser": [
      ["Power Lora Loader (rgthree)", "Switch latent [Crystools]"],
      { title: "Anomalous_Model_Browser", nodename_pattern: ".*" },
    ],
  };

  it("names rgthree-comfy and ComfyUI-Crystools, never the unrelated pack", async () => {
    const wf: WorkflowJSON = {
      "1": { class_type: "Power Lora Loader (rgthree)", inputs: {} },
      "2": { class_type: "Switch latent [Crystools]", inputs: {} },
    };
    const result = await extractWorkflowDependencies(
      wf,
      makeDeps(OBJECT_INFO, LAUNDERED_MAPPINGS),
    );
    const deps = byType(result);

    expect(deps["Power Lora Loader (rgthree)"]).toMatchObject({
      pack: "rgthree-comfy",
      installed: true,
      source: "object_info",
    });
    expect(deps["Switch latent [Crystools]"]).toMatchObject({
      pack: "ComfyUI-Crystools",
      installed: true,
      source: "object_info",
    });

    // The exact wrong output from the report: one unrelated repository standing
    // in for several distinct packs, and reported as a missing dependency.
    expect(result.requiredPacks).toEqual(["ComfyUI-Crystools", "rgthree-comfy"]);
    expect(JSON.stringify(result)).not.toContain("Anomalous_Model_Browser");
    expect(result.missingPacks).toEqual([]);
  });

  it("still uses Manager when /object_info carries no python_module", async () => {
    // Some builds omit the field. Manager is then all we have, and a SINGLE
    // unambiguous claimant is still a usable answer.
    const wf: WorkflowJSON = { "1": { class_type: "LonelyNode", inputs: {} } };
    const result = await extractWorkflowDependencies(
      wf,
      makeDeps({ LonelyNode: def("LonelyNode", undefined) }, {
        "https://github.com/someone/lonely-pack": [["LonelyNode"], { title: "Lonely-Pack" }],
      }),
    );
    expect(byType(result)["LonelyNode"]).toMatchObject({
      pack: "Lonely-Pack",
      installed: true,
      source: "manager_mappings",
    });
  });
});

describe("#2765 an ambiguous class_type is refused, not guessed", () => {
  // Two unrelated repositories both claim the class exactly — the shape 4.51%
  // of the live catalogue is in. `Object.entries` order used to decide it.
  const RIVAL_MAPPINGS = {
    "https://github.com/lbouaraba/comfyui-krea2edit": [
      ["Krea2EditGroundedEncode", "Krea2EditModelPatch"],
      { title: "comfyui-krea2edit" },
    ],
    "https://github.com/DemonGatanjieu/Anomalous_Model_Browser": [
      ["Krea2EditGroundedEncode", "Krea2EditModelPatch"],
      { title: "Anomalous_Model_Browser" },
    ],
  };
  const WF: WorkflowJSON = {
    "1": { class_type: "Krea2EditGroundedEncode", inputs: {} },
    "2": { class_type: "Krea2EditModelPatch", inputs: {} },
  };

  it("reports every claimant and names no owner", async () => {
    const result = await extractWorkflowDependencies(WF, makeDeps({}, RIVAL_MAPPINGS));

    expect(byType(result)["Krea2EditGroundedEncode"]).toMatchObject({
      pack: null,
      installed: false,
      source: "ambiguous",
      candidates: ["Anomalous_Model_Browser", "comfyui-krea2edit"],
    });
    expect(result.ambiguous.map((a) => a.class_type)).toEqual([
      "Krea2EditGroundedEncode",
      "Krea2EditModelPatch",
    ]);

    // Not a missing pack, because we refuse to say WHICH pack is missing —
    // that claim is what sent the reporter at unrelated third-party code.
    expect(result.missingPacks).toEqual([]);
    expect(result.requiredPacks).toEqual([]);
    // And NOT folded into `unresolved`, whose rendering says "neither installed
    // nor known to ComfyUI-Manager" — false here; Manager knows them twice over.
    expect(result.unresolved).toEqual([]);
  });

  it("install_deps queues nothing for it", async () => {
    const deps = makeDeps({}, RIVAL_MAPPINGS);
    const result = await installWorkflowDependencies(WF, deps);

    expect(deps.queueInstall).not.toHaveBeenCalled();
    expect(deps.startQueue).not.toHaveBeenCalled();
    expect(result.installed).toEqual([]);
    expect(result.ambiguous.map((a) => a.class_type)).toEqual([
      "Krea2EditGroundedEncode",
      "Krea2EditModelPatch",
    ]);
  });

  it("treats two packs declaring the same nodename_pattern as a conflict", async () => {
    // `Inspire$` really is declared by both "Inspire Pack" and "ComfyUI
    // Connection Helper" in the live catalogue; the latter's pattern reaches
    // 101 class names it does not own.
    const wf: WorkflowJSON = { "1": { class_type: "SomethingInspire", inputs: {} } };
    const result = await extractWorkflowDependencies(
      wf,
      makeDeps({}, {
        "https://github.com/ltdrdata/ComfyUI-Inspire-Pack": [
          [],
          { title: "Inspire Pack", nodename_pattern: "Inspire$" },
        ],
        "https://github.com/other/connection-helper": [
          [],
          { title: "ComfyUI Connection Helper", nodename_pattern: "Inspire$" },
        ],
      }),
    );
    expect(byType(result)["SomethingInspire"]).toMatchObject({
      pack: null,
      source: "ambiguous",
      candidates: ["ComfyUI Connection Helper", "Inspire Pack"],
    });
  });

  it("does not invent a conflict when one entry lists a name twice", async () => {
    const wf: WorkflowJSON = { "1": { class_type: "DupNode", inputs: {} } };
    const result = await extractWorkflowDependencies(
      wf,
      makeDeps({}, {
        "https://github.com/someone/dup-pack": [
          ["DupNode", "DupNode"],
          { title: "Dup-Pack" },
        ],
      }),
    );
    expect(byType(result)["DupNode"]).toMatchObject({
      pack: "Dup-Pack",
      source: "manager_mappings",
    });
    expect(result.ambiguous).toEqual([]);
  });
});

describe("#2765 a nodename_pattern that discriminates nothing owns nothing", () => {
  /**
   * The catch-all is the shape that produces the reported output on its own:
   * with no rival to make it ambiguous, ONE entry silently owns every class_type
   * the catalogue does not name.
   *
   * Measured against the live catalogue: this rejects `.*`, `.+`, `^`, `(?:)`,
   * `a|.*` and `.` while rejecting NONE of the 39 real `nodename_pattern`
   * entries, so it costs no genuine resolution.
   */
  // Every form a catch-all can take. One entry shaped like any of these used to
  // own every class_type the catalogue does not name, unopposed.
  it.each([".*", ".+", ".", "^", "(?:)", "a|.*", "\\w*", "[\\s\\S]*"])(
    "refuses to own a class_type it matched with %j",
    async (nodename_pattern) => {
      const wf: WorkflowJSON = { "1": { class_type: "Krea2EditGroundedEncode", inputs: {} } };
      const result = await extractWorkflowDependencies(
        wf,
        makeDeps({}, {
          "https://github.com/DemonGatanjieu/Anomalous_Model_Browser": [
            [],
            { title: "Anomalous_Model_Browser", nodename_pattern },
          ],
        }),
      );
      expect(byType(result)["Krea2EditGroundedEncode"]).toMatchObject({
        pack: null,
        source: "unresolved",
      });
      expect(result.missingPacks).toEqual([]);
    },
  );

  /**
   * codex gate P1 — the probe only catches patterns that match arbitrary junk.
   * A pattern shaped like a plausible class name slips past it and still sweeps
   * up the whole ecosystem, which is the same defect wearing a disguise.
   *
   * The veto: a pattern that captures class names EXACTLY owned by 2+ other
   * packs is describing a topic, not an owner.
   */
  it("refuses a pattern that looks like a class name but claims the ecosystem", async () => {
    const wf: WorkflowJSON = { "1": { class_type: "KSamplerCustom", inputs: {} } };
    const result = await extractWorkflowDependencies(
      wf,
      makeDeps({}, {
        "https://github.com/DemonGatanjieu/Anomalous_Model_Browser": [
          [],
          {
            title: "Anomalous_Model_Browser",
            nodename_pattern: "^[A-Z][A-Za-z0-9_()]*$",
          },
        ],
        // Two INDEPENDENT packs whose exactly-owned names the pattern captures.
        "https://github.com/a/pack-a": [["AlphaNode"], { title: "Pack-A" }],
        "https://github.com/b/pack-b": [["BetaNode"], { title: "Pack-B" }],
      }),
    );
    expect(byType(result)["KSamplerCustom"]).toMatchObject({
      pack: null,
      source: "unresolved",
    });
    expect(result.missingPacks).toEqual([]);
  });

  /**
   * codex gate round 2, P1 — the foreign-owner veto is evidence FROM the
   * catalogue, so against a catalogue with no exact names it has nothing to
   * compare with and returns "not broad". That read absence of evidence as
   * evidence of narrowness, and a broad pattern owned the graph unopposed.
   *
   * The gate's own reproduction, verbatim: one entry, no exact names, empty
   * /object_info, `^[A-Z]` against class_type "U". It resolved to "A" and
   * install_deps queued it.
   */
  it("still refuses a broad pattern when the catalogue is too thin to judge it", async () => {
    const wf: WorkflowJSON = { "1": { class_type: "U", inputs: {} } };
    const mappings = {
      "https://github.com/x/a": [[], { title: "A", nodename_pattern: "^[A-Z]" }],
    };
    const result = await extractWorkflowDependencies(wf, makeDeps({}, mappings));
    expect(byType(result)["U"]).toMatchObject({ pack: null, source: "unresolved" });
    expect(result.missingPacks).toEqual([]);

    // …and the install path, which is where the harm actually lands.
    const deps = makeDeps({}, mappings);
    const install = await installWorkflowDependencies(wf, deps);
    expect(deps.queueInstall).not.toHaveBeenCalled();
    expect(install.installed).toEqual([]);
  });

  it("tolerates ONE colliding owner, which is a fork of the same project", async () => {
    // `_jru$`, `- Ostris$` and ` \(rgthree\)$` each collide with exactly one
    // other catalogue entry — a sibling repo by the same author. Vetoing at one
    // collision would disable them; the ecosystem-wide claim starts at two.
    const wf: WorkflowJSON = { "1": { class_type: "Text2Image_jru", inputs: {} } };
    const result = await extractWorkflowDependencies(
      wf,
      makeDeps({}, {
        "https://github.com/jtrue/ComfyUI-JaRue": [
          [],
          { title: "ComfyUI-JaRue", nodename_pattern: "_jru$" },
        ],
        "https://github.com/jtrue/ComfyUI-WordEmbedding": [
          ["YouTube2Prompt_jru"],
          { title: "ComfyUI-WordEmbedding" },
        ],
      }),
    );
    expect(byType(result)["Text2Image_jru"]).toMatchObject({
      pack: "ComfyUI-JaRue",
      source: "manager_mappings",
    });
  });

  it("counts pattern claimants by REPOSITORY, not by display title", async () => {
    // codex gate P1 — two distinct repositories sharing a `title` collapsed into
    // one "unambiguous" owner, and install then picked the first catalogue entry
    // matching that name.
    const wf: WorkflowJSON = { "1": { class_type: "ThingNode (shared)", inputs: {} } };
    const result = await extractWorkflowDependencies(
      wf,
      makeDeps({}, {
        "https://github.com/first/shared-title": [
          [],
          { title: "Shared Title", nodename_pattern: " \\(shared\\)$" },
        ],
        "https://github.com/second/shared-title": [
          [],
          { title: "Shared Title", nodename_pattern: " \\(shared\\)$" },
        ],
      }),
    );
    expect(byType(result)["ThingNode (shared)"]).toMatchObject({
      pack: null,
      source: "ambiguous",
    });
    expect(result.missingPacks).toEqual([]);
  });

  it("keeps the well-formed SUFFIX-TAG patterns working", async () => {
    // The two real catalogue suffix-tag entries are catalogue entries and are
    // the issue's own expected owners. They must still resolve when the node is
    // NOT installed and /object_info therefore cannot answer.
    const wf: WorkflowJSON = {
      "1": { class_type: "Power Lora Loader (rgthree)", inputs: {} },
      "2": { class_type: "Switch latent [Crystools]", inputs: {} },
    };
    const result = await extractWorkflowDependencies(
      wf,
      makeDeps({}, {
        "https://github.com/rgthree/rgthree-comfy": [
          [],
          { title: "rgthree-comfy", nodename_pattern: " \\(rgthree\\)$" },
        ],
        "https://github.com/crystian/ComfyUI-Crystools": [
          [],
          { title: "ComfyUI-Crystools", nodename_pattern: " \\[Crystools\\]$" },
        ],
      }),
    );
    expect(byType(result)["Power Lora Loader (rgthree)"]).toMatchObject({
      pack: "rgthree-comfy",
      source: "manager_mappings",
    });
    expect(byType(result)["Switch latent [Crystools]"]).toMatchObject({
      pack: "ComfyUI-Crystools",
      source: "manager_mappings",
    });
  });
});
