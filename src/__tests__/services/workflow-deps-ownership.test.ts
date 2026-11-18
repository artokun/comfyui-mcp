import { describe, expect, it, vi } from "vitest";
import {
  extractWorkflowDependencies,
  installWorkflowDependencies,
  installWorkflowDependenciesForAnalysis,
  managerInstallParams,
  type ManagerNodePack,
  type NodeDependency,
  type WorkflowDepsDeps,
} from "../../services/workflow-deps.js";
import type { ComfyUINodeDef, ObjectInfo, WorkflowJSON } from "../../comfyui/types.js";

/**
 * #2765 — extract_deps named DemonGatanjieu/Anomalous_Model_Browser as the owner of
 * `Power Lora Loader (rgthree)`, `Switch latent [Crystools]`, `Krea2EditGroundedEncode`
 * and `Krea2EditModelPatch`: three real packs collapsed onto one unrelated repository.
 *
 * Every catalogue entry below is copied verbatim (trimmed lists only) from
 * Comfy-Org/ComfyUI-Manager `extension-node-map.json`. Two snapshots matter:
 *
 *  - ISSUE-ERA: Anomalous_Model_Browser published `nodename_pattern: ".*"` and listed no
 *    class at all (quoted on the issue), so it matched every name the catalogue did not
 *    list exactly — and first-pattern-wins handed it all four.
 *  - CURRENT (fetched 2026-10-24): the `.*` is gone, but the same repository now EXACTLY
 *    lists `Power Lora Loader (rgthree)` (alongside core `KSampler` and other packs'
 *    nodes), while `lbouaraba/comfyui-krea2edit` lists both Krea2 nodes.
 *
 * Hermetic: no network, no ComfyUI. `/object_info` and the Manager mappings are fixtures.
 */

const ANOMALOUS = "https://github.com/DemonGatanjieu/Anomalous_Model_Browser";
const RGTHREE = "https://github.com/rgthree/rgthree-comfy";
const CRYSTOOLS = "https://github.com/crystian/ComfyUI-Crystools";
const KREA2EDIT = "https://github.com/lbouaraba/comfyui-krea2edit";

type Mappings = Record<string, [string[], Record<string, unknown>]>;

const RGTHREE_ENTRY: [string[], Record<string, unknown>] = [
  ["RgthreeAnySwitch", "RgthreePowerLoraLoader", "RgthreeSeed"],
  {
    author: "rgthree",
    nickname: "rgthree",
    nodename_pattern: " \\(rgthree\\)$",
    title: "Comfy Nodes",
    title_aux: "rgthree's ComfyUI Nodes",
  },
];
const CRYSTOOLS_ENTRY: [string[], Record<string, unknown>] = [
  [],
  {
    author: "Crystian",
    nickname: "Crystools",
    nodename_pattern: " \\[Crystools\\]$",
    title: "Crystools",
    title_aux: "Crystools",
  },
];

/** Key order follows the real file (sorted), which puts the catch-all FIRST. */
const ISSUE_ERA: Mappings = {
  [ANOMALOUS]: [[], { nodename_pattern: ".*", title_aux: "Anomalous Model Browser" }],
  [CRYSTOOLS]: CRYSTOOLS_ENTRY,
  [RGTHREE]: RGTHREE_ENTRY,
};

const CURRENT: Mappings = {
  [ANOMALOUS]: [
    ["AnomalousTTS_CharacterSpeech", "DetailerForEach", "Power Lora Loader (rgthree)", "easy seed"],
    { title_aux: "Anomalous Model Browser" },
  ],
  [CRYSTOOLS]: CRYSTOOLS_ENTRY,
  [KREA2EDIT]: [["Krea2EditGroundedEncode", "Krea2EditModelPatch"], { title_aux: "Krea 2 Identity Edit" }],
  [RGTHREE]: RGTHREE_ENTRY,
};

const REPORTED = [
  "Krea2EditGroundedEncode",
  "Krea2EditModelPatch",
  "Power Lora Loader (rgthree)",
  "Switch latent [Crystools]",
];

function def(name: string, pythonModule?: string): ComfyUINodeDef {
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
  };
}

function wf(...classTypes: string[]): WorkflowJSON {
  return Object.fromEntries(classTypes.map((c, i) => [String(i + 1), { class_type: c, inputs: {} }]));
}

function deps(mappings: Mappings, objectInfo: ObjectInfo = {}): WorkflowDepsDeps {
  return {
    fetchObjectInfo: vi.fn(async () => objectInfo),
    fetchManagerMappings: vi.fn(async () => mappings as never),
    fetchManagerList: vi.fn(async () => ({ packs: [], directInstall: true })),
    queueInstall: vi.fn(async () => undefined),
    resetQueue: vi.fn(async () => undefined),
    startQueue: vi.fn(async () => undefined),
    queueStatus: vi.fn(async () => ({})),
  };
}

function byType(deps: NodeDependency[]): Record<string, NodeDependency> {
  return Object.fromEntries(deps.map((d) => [d.class_type, d]));
}

/** The same catalogue with its keys in the opposite order: no answer may depend on order. */
function reversed(m: Mappings): Mappings {
  return Object.fromEntries(Object.entries(m).reverse());
}

describe("#2765 issue-era catalogue: a catch-all pattern owns nothing", () => {
  it("resolves the reported nodes to their naming-convention owners, not the catch-all", async () => {
    const result = await extractWorkflowDependencies(wf(...REPORTED), deps(ISSUE_ERA));
    const d = byType(result.dependencies);

    expect(d["Power Lora Loader (rgthree)"]).toMatchObject({
      pack: "Comfy Nodes",
      installed: false,
      source: "manager_pattern",
    });
    expect(d["Switch latent [Crystools]"]).toMatchObject({
      pack: "Crystools",
      installed: false,
      source: "manager_pattern",
    });
    // No exact claim, no bounded pattern: the catalogue does not know them, and saying
    // so is the honest answer.
    expect(d["Krea2EditGroundedEncode"]).toMatchObject({ pack: null, source: "unresolved" });
    expect(d["Krea2EditModelPatch"]).toMatchObject({ pack: null, source: "unresolved" });

    expect(result.missingPacks).toEqual(["Comfy Nodes", "Crystools"]);
    expect(result.unresolved).toEqual(["Krea2EditGroundedEncode", "Krea2EditModelPatch"]);
    expect(JSON.stringify(result)).not.toContain("Anomalous");
  });

  it("leaves a class matched ONLY by the catch-all unresolved", async () => {
    const result = await extractWorkflowDependencies(wf("ImageCropToMask"), deps(ISSUE_ERA));
    expect(result.dependencies[0]).toMatchObject({ pack: null, source: "unresolved" });
    expect(result.unresolved).toEqual(["ImageCropToMask"]);
    expect(result.requiredPacks).toEqual([]);
  });

  it("control: an exact listing still resolves, labelled as an exact mapping", async () => {
    const result = await extractWorkflowDependencies(wf("RgthreeSeed"), deps(ISSUE_ERA));
    expect(result.dependencies[0]).toMatchObject({
      pack: "Comfy Nodes",
      source: "manager_mappings",
    });
  });

  it("installed nodes are owned by their /object_info python_module, never by a catalogue pattern", async () => {
    const objectInfo: ObjectInfo = {
      "Power Lora Loader (rgthree)": def("Power Lora Loader (rgthree)", "custom_nodes.rgthree-comfy"),
      "Switch latent [Crystools]": def("Switch latent [Crystools]", "custom_nodes.ComfyUI-Crystools.nodes"),
      Krea2EditGroundedEncode: def("Krea2EditGroundedEncode", "custom_nodes.comfyui-krea2edit"),
      Krea2EditModelPatch: def("Krea2EditModelPatch", "custom_nodes.comfyui-krea2edit"),
    };
    const result = await extractWorkflowDependencies(wf(...REPORTED), deps(ISSUE_ERA, objectInfo));
    const d = byType(result.dependencies);

    // The loaded directory, verbatim: /object_info names a directory, not a repository.
    expect(d["Power Lora Loader (rgthree)"]).toMatchObject({ pack: "rgthree-comfy", installed: true, source: "object_info" });
    expect(d["Switch latent [Crystools]"]).toMatchObject({ pack: "ComfyUI-Crystools", installed: true, source: "object_info" });
    expect(d["Krea2EditGroundedEncode"]).toMatchObject({ pack: "comfyui-krea2edit", source: "object_info" });
    for (const dep of result.dependencies) expect(dep.repository).toBeUndefined();
    expect(result.requiredPacks).toEqual(["ComfyUI-Crystools", "comfyui-krea2edit", "rgthree-comfy"]);
    expect(result.missingPacks).toEqual([]);
  });
});

describe("#2765 current catalogue: an exact listing that contradicts a naming convention", () => {
  it("refuses to pick between the two claimants and installs neither", async () => {
    const result = await extractWorkflowDependencies(wf(...REPORTED), deps(CURRENT));
    const d = byType(result.dependencies);

    expect(d["Power Lora Loader (rgthree)"]).toMatchObject({
      pack: null,
      installed: false,
      source: "unresolved",
      claimants: [ANOMALOUS, RGTHREE],
    });
    expect(result.ambiguous).toEqual([
      { class_type: "Power Lora Loader (rgthree)", claimants: [ANOMALOUS, RGTHREE] },
    ]);
    expect(result.unresolved).toEqual(["Power Lora Loader (rgthree)"]);
    expect(result.missingPacks).not.toContain("Anomalous Model Browser");
    expect(result.missingPacks).not.toContain(ANOMALOUS);

    // Independent catalogue evidence for Krea2 now exists, as an exact listing.
    expect(d["Krea2EditGroundedEncode"]).toMatchObject({ pack: KREA2EDIT, source: "manager_mappings" });
    expect(d["Krea2EditModelPatch"]).toMatchObject({ pack: KREA2EDIT, source: "manager_mappings" });
    expect(d["Switch latent [Crystools]"]).toMatchObject({ pack: "Crystools", source: "manager_pattern" });
  });

  it("install_deps queues the resolved repositories and carries the ambiguous claim without queuing it", async () => {
    const d = deps(CURRENT);
    // Legacy Manager list: every candidate present, the unrelated one FIRST.
    d.fetchManagerList = vi.fn(async () => ({
      channel: "default",
      packs: [
        { id: "anomalous", title: "Anomalous Model Browser", reference: ANOMALOUS, files: [ANOMALOUS] },
        { id: "comfyui-crystools", title: "Crystools", reference: CRYSTOOLS, files: [CRYSTOOLS] },
        { id: "comfyui-krea2edit", title: "Krea 2 Identity Edit", reference: KREA2EDIT, files: [KREA2EDIT] },
        { id: "rgthree-comfy", title: "Comfy Nodes", reference: RGTHREE, files: [RGTHREE] },
      ],
    }));
    const result = await installWorkflowDependencies(wf(...REPORTED), d);
    const queued = vi.mocked(d.queueInstall).mock.calls.map(([p]) => p.reference);
    expect(queued.sort()).toEqual([CRYSTOOLS, KREA2EDIT]);
    expect(result.unresolved).toEqual(["Power Lora Loader (rgthree)"]);
    expect(result.ambiguous).toEqual([
      { class_type: "Power Lora Loader (rgthree)", claimants: [ANOMALOUS, RGTHREE] },
    ]);
  });

  it("an installed node keeps the loaded directory's owner whatever the catalogue claims", async () => {
    const objectInfo: ObjectInfo = {
      "Power Lora Loader (rgthree)": def("Power Lora Loader (rgthree)", "custom_nodes.rgthree-comfy"),
    };
    const result = await extractWorkflowDependencies(wf("Power Lora Loader (rgthree)"), deps(CURRENT, objectInfo));
    expect(result.dependencies[0]).toMatchObject({ pack: "rgthree-comfy", installed: true, source: "object_info" });
    expect(result.ambiguous).toBeUndefined();
  });

  it("an installed node with an unrelated exact claimant is named by its directory", async () => {
    // The 34-node shape measured on #2765: KJNodes' ColorMatch listed by another pack.
    const mappings: Mappings = {
      "https://github.com/aining2022/ComfyUI_Swwan": [["ColorMatch"], { title_aux: "ComfyUI_Swwan" }],
    };
    const objectInfo: ObjectInfo = { ColorMatch: def("ColorMatch", "custom_nodes.comfyui-kjnodes") };
    const result = await extractWorkflowDependencies(wf("ColorMatch"), deps(mappings, objectInfo));
    expect(result.dependencies[0]).toMatchObject({ pack: "comfyui-kjnodes", source: "object_info" });
  });

  it("an installed def WITHOUT python_module does not collapse an ambiguous claim into an owner", async () => {
    const objectInfo: ObjectInfo = { "Power Lora Loader (rgthree)": def("Power Lora Loader (rgthree)") };
    const result = await extractWorkflowDependencies(wf("Power Lora Loader (rgthree)"), deps(CURRENT, objectInfo));
    expect(result.dependencies[0]).toMatchObject({
      pack: null,
      installed: true,
      claimants: [ANOMALOUS, RGTHREE],
    });
    expect(result.requiredPacks).toEqual([]);
  });
});

describe("#2765 pattern inference is bounded", () => {
  const HUNYUAN3D = "https://github.com/exedesign/Hunyuan-3D-v3";
  const HUNYUAN_WORLD = "https://github.com/A043-studios/ComfyUI_HunyuanWorldnode";
  const HUNYUAN_IMAGE3 = "https://github.com/EricRollei/Comfy_HunyuanImage3";
  const HUNYUAN: Mappings = {
    [HUNYUAN_WORLD]: [["HunyuanWorldImageTo3D", "HunyuanWorldModelLoader"], { title_aux: "HunyuanWorld" }],
    [HUNYUAN_IMAGE3]: [["HunyuanEmptyLatent"], { title_aux: "HunyuanImage3" }],
    [HUNYUAN3D]: [["HunyuanImageTo3D", "HunyuanTextTo3D"], { nodename_pattern: "Hunyuan", title_aux: "ComfyUI-Hunyuan3D-v3" }],
  };

  it("a pattern that matches other repositories' listed classes does not own an unlisted name", async () => {
    const result = await extractWorkflowDependencies(wf("HunyuanVideoSomethingNew"), deps(HUNYUAN));
    expect(result.dependencies[0]).toMatchObject({ pack: null, source: "unresolved" });
  });

  it("the over-broad pattern does not dispute the classes other repositories list", async () => {
    const result = await extractWorkflowDependencies(wf("HunyuanEmptyLatent", "HunyuanTextTo3D"), deps(HUNYUAN));
    const d = byType(result.dependencies);
    expect(d.HunyuanEmptyLatent).toMatchObject({ pack: HUNYUAN_IMAGE3, source: "manager_mappings" });
    expect(d.HunyuanTextTo3D).toMatchObject({ pack: HUNYUAN3D, source: "manager_mappings" });
    expect(result.ambiguous).toBeUndefined();
  });

  const FLEXTOOLS = "https://github.com/ostris/ComfyUI-FlexTools";
  const OSTRIS_NODES = "https://github.com/ostris/ostris_nodes_comfyui";
  const OSTRIS: Mappings = {
    [FLEXTOOLS]: [["Flex2Conditioner", "FlexGuidance"], { nodename_pattern: "- Ostris$", title_aux: "Flex.1 tools" }],
    [OSTRIS_NODES]: [["One Seed - Ostris", "Text Box - Ostris"], { nodename_pattern: "- Ostris$", title_aux: "Ostris Nodes ComfyUI" }],
  };

  it("two packs publishing one pattern: a listing does not erase the other pack's identical pattern", async () => {
    // An identical pattern does not show who copied whom; both are claims on this class.
    for (const m of [OSTRIS, reversed(OSTRIS)]) {
      const result = await extractWorkflowDependencies(wf("One Seed - Ostris"), deps(m));
      expect(result.dependencies[0]).toMatchObject({ pack: null, claimants: [FLEXTOOLS, OSTRIS_NODES] });
    }
  });

  it("two packs publishing one pattern: an unlisted match is ambiguous, not first-wins", async () => {
    const result = await extractWorkflowDependencies(wf("Brand New - Ostris"), deps(OSTRIS));
    expect(result.dependencies[0]).toMatchObject({
      pack: null,
      source: "unresolved",
      claimants: [FLEXTOOLS, OSTRIS_NODES],
    });
    expect(result.unresolved).toEqual(["Brand New - Ostris"]);
  });

  it("a class listed by several repositories is ambiguous, not first-wins", async () => {
    const mappings: Mappings = {
      "https://github.com/MarkoCa1/ComfyUI-Text": [["ReplaceText", "ShowText"], { title_aux: "ComfyUI-Text" }],
      "https://github.com/fairy-root/ComfyUI-Show-Text": [["ShowText"], { title_aux: "ComfyUI-Show-Text" }],
    };
    const result = await extractWorkflowDependencies(wf("ShowText", "ReplaceText"), deps(mappings));
    const d = byType(result.dependencies);
    expect(d.ShowText).toMatchObject({
      pack: null,
      source: "unresolved",
      claimants: ["https://github.com/MarkoCa1/ComfyUI-Text", "https://github.com/fairy-root/ComfyUI-Show-Text"],
    });
    expect(d.ReplaceText).toMatchObject({ pack: "https://github.com/MarkoCa1/ComfyUI-Text" });
  });

  it("a catch-all catalogue with nothing else is reported as carrying no usable entries", async () => {
    const result = await extractWorkflowDependencies(
      wf("Anything"),
      deps({ [ANOMALOUS]: [[], { nodename_pattern: ".*", title_aux: "Anomalous Model Browser" }] }),
    );
    expect(result.unresolved).toEqual(["Anything"]);
    expect(result.mappings_unavailable).toContain("no usable entries");
  });
});

describe("#2765 competing claims are never erased by a claimant's own pattern", () => {
  const A = "https://github.com/a/widget-pack";
  const B = "https://github.com/b/team-nodes";
  const DISTINCT: Mappings = {
    [A]: [["Widget (Team)", "WidgetBase"], { nodename_pattern: "^Widget", title: "Widget Pack" }],
    [B]: [[], { nodename_pattern: " \\(Team\\)$", title: "Team Nodes" }],
  };

  it("A lists the class and matches it; B's DIFFERENT pattern still claims it: ambiguous in either order", async () => {
    for (const m of [DISTINCT, reversed(DISTINCT)]) {
      const d = deps(m);
      const result = await extractWorkflowDependencies(wf("Widget (Team)"), d);
      expect(result.dependencies[0]).toMatchObject({ pack: null, source: "unresolved", claimants: [A, B] });
      expect(result.missingPacks).toEqual([]);
      const install = await installWorkflowDependencies(wf("Widget (Team)"), d);
      expect(install.installed).toEqual([]);
      expect(d.resetQueue).not.toHaveBeenCalled();
      expect(d.queueInstall).not.toHaveBeenCalled();
      expect(d.startQueue).not.toHaveBeenCalled();
    }
  });

  it("controls: a sole listing and a sole pattern still resolve, with their provenance", async () => {
    for (const m of [DISTINCT, reversed(DISTINCT)]) {
      const r = await extractWorkflowDependencies(wf("WidgetBase", "Gadget (Team)"), deps(m));
      const d = byType(r.dependencies);
      expect(d.WidgetBase).toMatchObject({ pack: "Widget Pack", repository: A, source: "manager_mappings" });
      expect(d["Gadget (Team)"]).toMatchObject({ pack: "Team Nodes", repository: B, source: "manager_pattern" });
    }
  });
});

describe("#2765 patterns that constrain nothing are discarded", () => {
  const LONE = "https://github.com/x/lone-pack";
  for (const pattern of ["^[^\\x00]+$", "\\w+", "[\\s\\S]", "Foo|.*", "(?:Foo)?", "^(?<all>.+)$", ".{1,}"]) {
    it(`${JSON.stringify(pattern)} claims nothing, even with no competing listing`, async () => {
      const result = await extractWorkflowDependencies(
        wf("Widget", "Load Image Batch"),
        deps({ [LONE]: [[], { nodename_pattern: pattern, title_aux: "Lone" }] }),
      );
      expect(result.dependencies.every((dep) => dep.pack === null)).toBe(true);
      expect(result.missingPacks).toEqual([]);
    });
  }

  it("controls: real catalogue conventions still match their own names", async () => {
    // Patterns copied verbatim from extension-node-map.json.
    const real: Array<[string, string, string]> = [
      ["https://github.com/rgthree/rgthree-comfy", " \\(rgthree\\)$", "Power Lora Loader (rgthree)"],
      ["https://github.com/crystian/ComfyUI-Crystools", " \\[Crystools\\]$", "Switch latent [Crystools]"],
      ["https://github.com/MrForExample/ComfyUI-3D-Pack", "^\\[Comfy3D\\]", "[Comfy3D] Load 3D Mesh"],
      ["https://github.com/l3ony2k/comfyui-leon-nodes", "^\u{1F916} Leon", "\u{1F916} Leon Gemini"],
      ["https://github.com/EricRollei/Download_Tools", "(Gallery-dl|Yt-dlp|Web.*Scraper)", "Yt-dlp Downloader"],
      ["https://github.com/TinyTerra/ComfyUI_tinyterraNodes", "^ttN ", "ttN pipeLoader"],
    ];
    for (const [repo, pattern, name] of real) {
      const result = await extractWorkflowDependencies(wf(name), deps({ [repo]: [[], { nodename_pattern: pattern }] }));
      expect(result.dependencies[0]).toMatchObject({ repository: repo, source: "manager_pattern" });
    }
  });

  it("a class the pattern's own repository ALSO lists still counts as foreign evidence", async () => {
    const P = "https://github.com/p/foo-everything";
    const X = "https://github.com/x/foo-a";
    const Y = "https://github.com/y/foo-b";
    const m: Mappings = {
      [P]: [["FooA", "FooB"], { nodename_pattern: "^Foo", title_aux: "Foo Everything" }],
      [X]: [["FooA"], { title_aux: "Foo A" }],
      [Y]: [["FooB"], { title_aux: "Foo B" }],
    };
    for (const mm of [m, reversed(m)]) {
      const result = await extractWorkflowDependencies(wf("FooNew"), deps(mm));
      expect(result.dependencies[0]).toMatchObject({ pack: null, source: "unresolved" });
      expect(result.dependencies[0].claimants).toBeUndefined();
    }
  });
});

describe("#2765 installed ownership is the loaded directory, not a basename coincidence", () => {
  it("does not adopt an unrelated repository's title because its basename equals the directory", async () => {
    const result = await extractWorkflowDependencies(
      wf("Widget"),
      deps(
        { "https://github.com/unrelated/common-pack": [["Widget"], { title: "Unrelated Tools" }] },
        { Widget: def("Widget", "custom_nodes.common-pack") },
      ),
    );
    expect(result.dependencies[0]).toMatchObject({ pack: "common-pack", installed: true, source: "object_info" });
    expect(result.dependencies[0].repository).toBeUndefined();
    expect(result.requiredPacks).toEqual(["common-pack"]);
  });
});

describe("#2765 install_deps enqueues exactly the resolved repository", () => {
  const A = "https://github.com/a/shared-tools";
  const B = "https://github.com/b/shared-tools";
  const SHARED: Mappings = {
    [A]: [["NodeA"], { title: "Shared" }],
    [B]: [["NodeB"], { title: "Shared" }],
  };
  const LIST_A: ManagerNodePack = { id: "a-shared", title: "Shared", reference: A, files: [A], version: "1.0.0" };
  const LIST_B: ManagerNodePack = { id: "b-shared", title: "Shared", reference: B, files: [B], version: "2.0.0" };

  function legacy(m: Mappings, packs: ManagerNodePack[]): WorkflowDepsDeps {
    const d = deps(m);
    d.fetchManagerList = vi.fn(async () => ({ channel: "default", packs }));
    return d;
  }

  it("two repositories sharing a title are never merged under it", async () => {
    const result = await extractWorkflowDependencies(wf("NodeA", "NodeB"), deps(SHARED));
    const d = byType(result.dependencies);
    expect(d.NodeA).toMatchObject({ pack: A, repository: A });
    expect(d.NodeB).toMatchObject({ pack: B, repository: B });
    expect(result.missingPacks).toEqual([A, B]);
  });

  it("duplicate title: queues B's own list entry whatever the catalogue or list order", async () => {
    for (const m of [SHARED, reversed(SHARED)]) {
      for (const packs of [[LIST_A, LIST_B], [LIST_B, LIST_A]]) {
        const d = legacy(m, packs);
        const result = await installWorkflowDependencies(wf("NodeB"), d);
        expect(vi.mocked(d.queueInstall).mock.calls).toEqual([[LIST_B, "default"]]);
        expect(result.installed).toEqual([B]);
      }
    }
  });

  it("title-vs-id collision: another entry whose ID equals the resolved title is not queued", async () => {
    const m: Mappings = { [A]: [["Widget"], { title: "Shared Tools" }] };
    const impostor: ManagerNodePack = { id: "Shared Tools", title: "Impostor", reference: B, files: [B] };
    const real: ManagerNodePack = { id: "a-shared", listKey: "shared-tools", title: "Shared Tools", reference: A, files: [A] };
    for (const packs of [[impostor, real], [real, impostor]]) {
      const d = legacy(m, packs);
      const result = await installWorkflowDependencies(wf("Widget"), d);
      expect(vi.mocked(d.queueInstall).mock.calls).toEqual([[real, "default"]]);
      expect(result.installed).toEqual(["Shared Tools"]);
    }
  });

  it("an identity matching two list entries is refused with no reset, enqueue or start", async () => {
    const m: Mappings = { [A]: [["Widget"], { title: "Shared Tools" }] };
    const d = legacy(m, [
      { id: "one", reference: A, files: [A] },
      { id: "two", reference: "https://example.invalid/mirror", files: [A] },
    ]);
    const result = await installWorkflowDependencies(wf("Widget"), d);
    expect(result.installed).toEqual([]);
    expect(result.unresolved).toEqual(["Shared Tools"]);
    expect(result.target_refusals).toEqual([
      { pack: "Shared Tools", reason: `${A} matches 2 Manager list entries, so none was queued` },
    ]);
    expect(d.resetQueue).not.toHaveBeenCalled();
    expect(d.queueInstall).not.toHaveBeenCalled();
    expect(d.startQueue).not.toHaveBeenCalled();
  });

  it("legacy: an identity absent from the list is unresolved, never matched by title", async () => {
    const m: Mappings = { [A]: [["Widget"], { title: "Shared Tools" }] };
    const d = legacy(m, [{ id: "other", title: "Shared Tools", reference: B, files: [B] }]);
    const result = await installWorkflowDependencies(wf("Widget"), d);
    expect(result.unresolved).toEqual(["Shared Tools"]);
    expect(result.target_refusals).toEqual([{ pack: "Shared Tools", reason: `no Manager install descriptor names ${A}, so it was not queued` }]);
    expect(d.queueInstall).not.toHaveBeenCalled();
  });

  it("v4: queues the registry id the catalogue resolved, not its display title", async () => {
    const d = deps({ "comfyui-crystools": CRYSTOOLS_ENTRY });
    const result = await installWorkflowDependencies(wf("Switch latent [Crystools]"), d);
    expect(vi.mocked(d.queueInstall).mock.calls).toEqual([[{ id: "comfyui-crystools", version: "latest" }, "default"]]);
    expect(result.installed).toEqual(["Crystools"]);
  });

  it("v4: a URL-keyed pack is refused rather than sent as an id v4 cannot resolve", async () => {
    const d = deps({ [KREA2EDIT]: CURRENT[KREA2EDIT] });
    const result = await installWorkflowDependencies(wf("Krea2EditGroundedEncode"), d);
    expect(result.installed).toEqual([]);
    expect(result.unresolved).toEqual([KREA2EDIT]);
    expect(result.target_refusals?.[0]).toMatchObject({ pack: KREA2EDIT });
    expect(d.resetQueue).not.toHaveBeenCalled();
    expect(d.queueInstall).not.toHaveBeenCalled();
    expect(d.startQueue).not.toHaveBeenCalled();
  });

  it("an externally supplied analysis without resolved identity installs nothing", async () => {
    const d = deps({});
    d.fetchManagerList = vi.fn(async () => ({ channel: "default", packs: [{ id: "Shared", title: "Shared", reference: A }] }));
    const result = await installWorkflowDependenciesForAnalysis(
      { classTypes: [], dependencies: [], requiredPacks: ["Shared"], missingPacks: ["Shared"], unresolved: [] },
      d,
    );
    expect(result.installed).toEqual([]);
    expect(result.target_refusals).toEqual([{ pack: "Shared", reason: "no resolved repository identity, so it was not queued" }]);
    expect(d.queueInstall).not.toHaveBeenCalled();
  });
});

describe("#2765 legacy install: the descriptor's effective target must be the resolved repository", () => {
  const A = "https://github.com/a/widget-pack";
  const B = "https://github.com/b/other-pack";
  const BY_URL: Mappings = { [A]: [["Widget"], { title: "Widget Pack" }] };
  const BY_ID: Mappings = { "comfyui-widget": [["Widget"], { title: "Widget Pack" }] };

  function legacy(m: Mappings, packs: ManagerNodePack[]): WorkflowDepsDeps {
    const d = deps(m);
    d.fetchManagerList = vi.fn(async () => ({ channel: "default", packs }));
    return d;
  }

  async function expectRefused(m: Mappings, packs: ManagerNodePack[], reason: RegExp): Promise<void> {
    const d = legacy(m, packs);
    const result = await installWorkflowDependencies(wf("Widget"), d);
    expect(result.installed).toEqual([]);
    expect(result.unresolved).toEqual(["Widget Pack"]);
    expect(result.target_refusals).toHaveLength(1);
    expect(result.target_refusals?.[0]).toMatchObject({ pack: "Widget Pack" });
    expect(result.target_refusals?.[0].reason).toMatch(reason);
    expect(d.resetQueue).not.toHaveBeenCalled();
    expect(d.queueInstall).not.toHaveBeenCalled();
    expect(d.startQueue).not.toHaveBeenCalled();
  }

  it("refuses a sole descriptor whose reference names A but whose git clone target is B", async () => {
    // Astra's reproduction: selected through `reference === A`, would clone files[0] = B.
    await expectRefused(BY_URL, [{ id: "other-pack", reference: A, files: [B], version: "unknown" }], /would clone .*other-pack, not .*widget-pack/);
  });

  it("refuses a compound descriptor rather than expanding one identity into several repositories", async () => {
    await expectRefused(BY_URL, [{ listKey: "widget-pack", id: "widget-pack", reference: A, files: [A, B], version: "unknown" }], /names 2 repositories/);
    await expectRefused(BY_ID, [{ id: "comfyui-widget", files: [A, B], version: "1.2.0" }], /names 2 repositories/);
  });

  it("refuses a git install whose name Manager would resolve to a different descriptor", async () => {
    // basename(A) = "widget-pack" is another entry's key, so Manager would clone ITS files[0].
    await expectRefused(
      BY_URL,
      [
        { listKey: "widget-pack-mirror", id: "widget-pack-mirror", reference: A, files: [A], version: "unknown" },
        { listKey: "widget-pack", id: "widget-pack", reference: B, files: [B], version: "unknown" },
      ],
      /resolves this git install by the name "widget-pack"/,
    );
  });

  it("refuses a git descriptor whose reference contradicts its clone target", async () => {
    await expectRefused(BY_URL, [{ listKey: "widget-pack", id: "widget-pack", reference: B, files: [A], version: "unknown" }], /names both/);
  });

  it("refuses a registry descriptor whose id is not bound to the resolved repository", async () => {
    await expectRefused(BY_URL, [{ id: "comfyui-widget", reference: A, files: [B], version: "1.2.0" }], /registry id comfyui-widget, which is not bound/);
  });

  it("a repository with no matching install descriptor is a target refusal, not 'not found'", async () => {
    await expectRefused(BY_URL, [{ listKey: "other-pack", id: "other-pack", reference: B, files: [B], version: "unknown" }], /no Manager install descriptor names/);
  });

  it("control: git install of the resolved repository, exact payload", async () => {
    const entry: ManagerNodePack = { listKey: "widget-pack", id: "widget-pack", reference: A, files: [A], version: "unknown" };
    const d = legacy(BY_URL, [{ listKey: "other-pack", id: "other-pack", reference: B, files: [B], version: "unknown" }, entry]);
    const result = await installWorkflowDependencies(wf("Widget"), d);
    expect(vi.mocked(d.queueInstall).mock.calls).toEqual([[entry, "default"]]);
    expect(result.installed).toEqual(["Widget Pack"]);
    expect(result.target_refusals).toBeUndefined();
    expect(managerInstallParams(entry, "default")).toEqual({
      id: "widget-pack",
      version: "unknown",
      selected_version: undefined,
      repository: A,
      files: [A],
      channel: "default",
      mode: "cache",
      ui_id: "widget-pack",
    });
  });

  it("control: registered install bound by registry id, exact payload (the id is not a URL)", async () => {
    const entry: ManagerNodePack = {
      id: "comfyui-widget",
      reference: "https://registry.comfy.org/nodes/comfyui-widget",
      files: [A],
      version: "1.2.0",
    };
    const d = legacy(BY_ID, [entry]);
    const result = await installWorkflowDependencies(wf("Widget"), d);
    expect(vi.mocked(d.queueInstall).mock.calls).toEqual([[entry, "default"]]);
    expect(result.installed).toEqual(["Widget Pack"]);
    expect(managerInstallParams(entry, "default")).toMatchObject({ id: "comfyui-widget", version: "1.2.0", selected_version: "1.2.0" });
  });

  it("control: registered install of a URL-keyed repository bound through its single files URL", async () => {
    const entry: ManagerNodePack = { id: "comfyui-widget", reference: A, files: [A], version: "1.2.0" };
    const d = legacy(BY_URL, [entry]);
    const result = await installWorkflowDependencies(wf("Widget"), d);
    expect(vi.mocked(d.queueInstall).mock.calls).toEqual([[entry, "default"]]);
    expect(result.installed).toEqual(["Widget Pack"]);
  });
});
