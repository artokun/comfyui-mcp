import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectClassTypes,
  extractWorkflowDependencies,
  installWorkflowDependencies,
  type WorkflowDepsDeps,
  type ManagerNodePack,
  defaultWorkflowDepsDeps,
  installWorkflowDependenciesForAnalysis,
} from "../../services/workflow-deps.js";
import { resetManagerApiCacheForTests } from "../../services/node-management.js";
import { setPanelVersionPin } from "../../services/panel-settings.js";
import type { WorkflowJSON, ObjectInfo, ComfyUINodeDef } from "../../comfyui/types.js";

afterEach(() => vi.unstubAllGlobals());

/** Build a minimal ObjectInfo node def with a given python_module. */
function def(name: string, pythonModule: string): ComfyUINodeDef {
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
    python_module: pythonModule,
  };
}

/**
 * Sample workflow: two core nodes (KSampler, CLIPTextEncode), one installed
 * custom node (ImpactSomething), and one missing custom node (RemoteOnlyNode).
 */
const sampleWorkflow: WorkflowJSON = {
  "1": { class_type: "KSampler", inputs: {} },
  "2": { class_type: "CLIPTextEncode", inputs: {} },
  "3": { class_type: "ImpactSomething", inputs: {} },
  "4": { class_type: "RemoteOnlyNode", inputs: {} },
  // duplicate class_type to verify dedupe
  "5": { class_type: "KSampler", inputs: {} },
};

function makeDeps(overrides: Partial<WorkflowDepsDeps> = {}): WorkflowDepsDeps {
  const objectInfo: ObjectInfo = {
    KSampler: def("KSampler", "nodes"),
    CLIPTextEncode: def("CLIPTextEncode", "nodes"),
    // installed custom node, lives under custom_nodes/comfyui-impact-pack
    ImpactSomething: def("ImpactSomething", "custom_nodes.comfyui-impact-pack.impact"),
    // RemoteOnlyNode intentionally absent -> not installed
  };

  const mappings = {
    "https://github.com/ltdrdata/ComfyUI-Impact-Pack": [
      ["ImpactSomething", "ImpactOther"],
      { title: "ComfyUI-Impact-Pack" },
    ],
    "https://github.com/someone/remote-only": [
      ["RemoteOnlyNode"],
      { title: "Remote-Only-Pack" },
    ],
  };

  const list: ManagerNodePack[] = [
    {
      id: "Remote-Only-Pack",
      title: "Remote-Only-Pack",
      reference: "https://github.com/someone/remote-only",
      files: ["https://github.com/someone/remote-only"],
      install_type: "git-clone",
      state: "not-installed",
    },
  ];

  return {
    fetchObjectInfo: vi.fn(async () => objectInfo),
    fetchManagerMappings: vi.fn(async () => mappings as never),
    fetchManagerList: vi.fn(async () => ({ channel: "default", packs: list })),
    queueInstall: vi.fn(async () => undefined),
    resetQueue: vi.fn(async () => undefined),
    startQueue: vi.fn(async () => undefined),
    queueStatus: vi.fn(async () => ({
      total_count: 1,
      done_count: 0,
      in_progress_count: 1,
      is_processing: true,
    })),
    ...overrides,
  };
}

describe("default WorkflowDeps Manager dialect routing", () => {
  it("uses the v4-prefixed customnode mapping route", async () => {
    resetManagerApiCacheForTests("v2");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await defaultWorkflowDepsDeps().fetchManagerMappings();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:8188/v2/customnode/getmappings?mode=nickname",
    );
  });
});

describe("collectClassTypes", () => {
  it("returns distinct, sorted class_types", () => {
    expect(collectClassTypes(sampleWorkflow)).toEqual([
      "CLIPTextEncode",
      "ImpactSomething",
      "KSampler",
      "RemoteOnlyNode",
    ]);
  });

  it("ignores malformed nodes without class_type", () => {
    const wf = {
      "1": { class_type: "KSampler", inputs: {} },
      "2": { inputs: {} } as never,
    } as WorkflowJSON;
    expect(collectClassTypes(wf)).toEqual(["KSampler"]);
  });

  it("extracts types from UI-format workflows (nodes[].type)", () => {
    const ui = {
      nodes: [
        { id: 1, type: "KSampler" },
        { id: 2, type: "CLIPTextEncode" },
        { id: 3, type: "KSampler" }, // duplicate
        { id: 4 }, // no type — ignored
      ],
      links: [],
    };
    expect(collectClassTypes(ui)).toEqual(["CLIPTextEncode", "KSampler"]);
  });

  // #2648 — a UI subgraph INSTANCE is structural (type === definition UUID).
  // Reading only workflow.nodes treated that UUID as a class_type and never
  // walked definitions.subgraphs[].nodes, so extract_deps mapped the UUID
  // through an unrelated Manager pattern and omitted inner packs.
  it("walks UI subgraph inner nodes and does not treat the instance UUID as a class_type (#2648)", () => {
    const instanceId = "2d4f2d38-ff62-4ae8-853d-2a359520164b";
    const ui = {
      nodes: [
        { id: 1, type: "LoadImage" },
        { id: 2, type: instanceId },
      ],
      links: [],
      definitions: {
        subgraphs: [
          {
            id: instanceId,
            name: "WanSampler",
            nodes: [
              { id: 10, type: "WanVideoSampler" },
              { id: 11, type: "WanVideoWrapper" },
              { id: 12, type: "SetNode" },
            ],
          },
        ],
      },
    };
    expect(collectClassTypes(ui)).toEqual([
      "LoadImage",
      "SetNode",
      "WanVideoSampler",
      "WanVideoWrapper",
    ]);
    expect(collectClassTypes(ui)).not.toContain(instanceId);
  });
});

describe("extractWorkflowDependencies", () => {
  it("classifies built-in, installed-custom, and missing nodes", async () => {
    const deps = makeDeps();
    const result = await extractWorkflowDependencies(sampleWorkflow, deps);

    const byType = Object.fromEntries(
      result.dependencies.map((d) => [d.class_type, d]),
    );

    // core nodes -> builtin, no pack
    expect(byType.KSampler).toMatchObject({ builtin: true, pack: null, installed: true });
    expect(byType.CLIPTextEncode).toMatchObject({ builtin: true, installed: true });

    // installed custom node -> resolved to Manager title, installed=true
    expect(byType.ImpactSomething).toMatchObject({
      builtin: false,
      installed: true,
      pack: "ComfyUI-Impact-Pack",
    });

    // missing custom node -> resolved via mappings, installed=false
    expect(byType.RemoteOnlyNode).toMatchObject({
      builtin: false,
      installed: false,
      pack: "Remote-Only-Pack",
      source: "manager_mappings",
    });

    expect(result.requiredPacks).toEqual(["ComfyUI-Impact-Pack", "Remote-Only-Pack"]);
    expect(result.missingPacks).toEqual(["Remote-Only-Pack"]);
    expect(result.unresolved).toEqual([]);
  });

  it("falls back to python_module when Manager mappings are unavailable", async () => {
    const deps = makeDeps({
      fetchManagerMappings: vi.fn(async () => {
        throw new Error("manager down");
      }),
    });
    const result = await extractWorkflowDependencies(sampleWorkflow, deps);
    const byType = Object.fromEntries(result.dependencies.map((d) => [d.class_type, d]));

    // installed custom node resolves via python_module directory name
    expect(byType.ImpactSomething).toMatchObject({
      pack: "comfyui-impact-pack",
      source: "object_info",
      installed: true,
    });
    // missing node cannot be resolved without mappings
    expect(byType.RemoteOnlyNode).toMatchObject({
      pack: null,
      installed: false,
      source: "unresolved",
    });
    expect(result.unresolved).toEqual(["RemoteOnlyNode"]);
  });

  it("reports all-builtin workflows as needing no packs", async () => {
    const wf: WorkflowJSON = {
      "1": { class_type: "KSampler", inputs: {} },
      "2": { class_type: "CLIPTextEncode", inputs: {} },
    };
    const result = await extractWorkflowDependencies(wf, makeDeps());
    expect(result.requiredPacks).toEqual([]);
    expect(result.missingPacks).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("matches class_types via nodename_pattern regex", async () => {
    const deps = makeDeps({
      fetchManagerMappings: vi.fn(
        async () =>
          ({
            "https://github.com/x/pattern-pack": [
              [],
              { title: "Pattern-Pack", nodename_pattern: "^Was.*" },
            ],
          }) as never,
      ),
      fetchObjectInfo: vi.fn(async () => ({}) as ObjectInfo),
    });
    const wf: WorkflowJSON = { "1": { class_type: "WasImageThing", inputs: {} } };
    const result = await extractWorkflowDependencies(wf, deps);
    expect(result.dependencies[0]).toMatchObject({
      pack: "Pattern-Pack",
      installed: false,
      // #2765 renamed this source. A regex match and a publisher listing its own
      // class name are different strength of claim, and install_deps acts on the
      // result; the pack itself is unchanged.
      source: "manager_pattern",
    });
  });

  it("does not map a UI subgraph UUID through an unrelated Manager pattern (#2648)", async () => {
    const instanceId = "2d4f2d38-ff62-4ae8-853d-2a359520164b";
    const deps = makeDeps({
      fetchObjectInfo: vi.fn(async () => ({}) as ObjectInfo),
      fetchManagerMappings: vi.fn(
        async () =>
          ({
            "https://github.com/DemonGatanjieu/Anomalous_Model_Browser": [
              [],
              {
                title: "Anomalous_Model_Browser",
                nodename_pattern: "^[0-9a-f]{8}-",
              },
            ],
            "https://github.com/kijai/ComfyUI-WanVideoWrapper": [
              ["WanVideoSampler", "WanVideoWrapper"],
              { title: "WanVideoWrapper" },
            ],
            "https://github.com/kijai/ComfyUI-KJNodes": [
              ["SetNode"],
              { title: "KJNodes" },
            ],
          }) as never,
      ),
    });
    const ui = {
      nodes: [
        { id: 1, type: "LoadImage" },
        { id: 2, type: instanceId },
      ],
      definitions: {
        subgraphs: [
          {
            id: instanceId,
            nodes: [
              { id: 10, type: "WanVideoSampler" },
              { id: 11, type: "WanVideoWrapper" },
              { id: 12, type: "SetNode" },
            ],
          },
        ],
      },
    };
    const result = await extractWorkflowDependencies(ui as never, deps);

    expect(result.classTypes).toEqual([
      "LoadImage",
      "SetNode",
      "WanVideoSampler",
      "WanVideoWrapper",
    ]);
    expect(result.classTypes).not.toContain(instanceId);
    expect(result.requiredPacks).toEqual(["KJNodes", "WanVideoWrapper"]);
    expect(result.requiredPacks).not.toContain("Anomalous_Model_Browser");
    expect(result.missingPacks).not.toContain("Anomalous_Model_Browser");
    expect(result.dependencies.map((d) => d.class_type)).not.toContain(instanceId);
  });
});

describe("installWorkflowDependencies", () => {
  it("refuses before queuing when a workflow dependency selects the pinned panel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmcp-workflow-deps-pin-"));
    process.env.COMFYUI_MCP_PANEL_SETTINGS = join(dir, "panel-settings.json");
    process.env.COMFYUI_MCP_PANEL_LOCK = join(dir, "panel-op.lock");
    try {
      setPanelVersionPin("0.11.3");
      const deps = makeDeps({
        fetchObjectInfo: vi.fn(async () => ({})),
        fetchManagerMappings: vi.fn(async () => ({
          "comfyui-agent-panel": [["PanelOnlyNode"], {}],
        } as never)),
      });
      const panelWorkflow: WorkflowJSON = {
        "1": { class_type: "PanelOnlyNode", inputs: {} },
      };

      await expect(installWorkflowDependencies(panelWorkflow, deps)).rejects.toThrow(/pinned/i);
      // The guard wraps the transaction, so no Manager mutation starts.
      expect(deps.fetchManagerList).not.toHaveBeenCalled();
      expect(deps.resetQueue).not.toHaveBeenCalled();
      expect(deps.queueInstall).not.toHaveBeenCalled();
    } finally {
      delete process.env.COMFYUI_MCP_PANEL_SETTINGS;
      delete process.env.COMFYUI_MCP_PANEL_LOCK;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs via ComfyUI-Manager regardless of any local path (server-side install)", async () => {
    // Installs run through the Manager HTTP queue on the connected instance, so
    // the absence of a local path must NOT block them.
    const deps = makeDeps();
    const result = await installWorkflowDependencies(sampleWorkflow, deps);
    expect(result.installed).toEqual(["Remote-Only-Pack"]);
    expect(deps.queueInstall).toHaveBeenCalledTimes(1);
  });

  it("never queues the panel through the generic direct-install/remote fallback", async () => {
    const deps = makeDeps({
      fetchObjectInfo: vi.fn(async () => ({})),
      fetchManagerMappings: vi.fn(async () => ({
        "comfyui-agent-panel": [["PanelOnlyNode"], {}],
      } as never)),
      fetchManagerList: vi.fn(async () => ({ directInstall: true, packs: [] })),
    });
    const panelWorkflow: WorkflowJSON = {
      "1": { class_type: "PanelOnlyNode", inputs: {} },
    };

    const result = await installWorkflowDependencies(panelWorkflow, deps);

    expect(result.installed).toEqual([]);
    expect(result.unresolved).toEqual(["comfyui-agent-panel"]);
    expect(result.panel_notes?.join(" ")).toMatch(/does not queue or mutate.*install_comfyui\(action:'panel'/i);
    expect(deps.resetQueue).not.toHaveBeenCalled();
    expect(deps.queueInstall).not.toHaveBeenCalled();
    expect(deps.startQueue).not.toHaveBeenCalled();
  });

  it("resets the queue, queues missing packs (with channel), then starts the worker", async () => {
    const deps = makeDeps();
    const order: string[] = [];
    (deps.resetQueue as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("reset");
    });
    (deps.queueInstall as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("queue");
    });
    (deps.startQueue as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("start");
    });

    const result = await installWorkflowDependencies(sampleWorkflow, deps);

    expect(deps.queueInstall).toHaveBeenCalledTimes(1);
    expect(deps.queueInstall).toHaveBeenCalledWith(
      expect.objectContaining({ id: "Remote-Only-Pack" }),
      "default",
    );
    // reset must precede queueing, and start must come last.
    expect(order).toEqual(["reset", "queue", "start"]);

    expect(result.installed).toEqual(["Remote-Only-Pack"]);
    expect(result.alreadyInstalled).toEqual(["ComfyUI-Impact-Pack"]);
    expect(result.queue).toMatchObject({ is_processing: true });
  });

  it("does nothing when no packs are missing", async () => {
    // Only built-ins + an installed custom node.
    const wf: WorkflowJSON = {
      "1": { class_type: "KSampler", inputs: {} },
      "2": { class_type: "ImpactSomething", inputs: {} },
    };
    const deps = makeDeps();
    const result = await installWorkflowDependencies(wf, deps);

    expect(deps.queueInstall).not.toHaveBeenCalled();
    expect(deps.startQueue).not.toHaveBeenCalled();
    expect(result.installed).toEqual([]);
    expect(result.alreadyInstalled).toEqual(["ComfyUI-Impact-Pack"]);
  });

  it("reports packs missing from the Manager list as unresolved (not already-installed)", async () => {
    const deps = makeDeps({ fetchManagerList: vi.fn(async () => ({ packs: [] })) });
    const result = await installWorkflowDependencies(sampleWorkflow, deps);
    expect(result.installed).toEqual([]);
    expect(result.unresolved).toContain("Remote-Only-Pack");
    // A missing pack that could not be resolved must NOT leak into alreadyInstalled.
    expect(result.alreadyInstalled).not.toContain("Remote-Only-Pack");
    expect(result.alreadyInstalled).toEqual(["ComfyUI-Impact-Pack"]);
    expect(deps.queueInstall).not.toHaveBeenCalled();
  });
});

// #1136 — an EMPTY Manager catalogue must not read as "these packs do not exist".
//
// This is the reported user's actual path. They were told to search ComfyUI
// Manager, the registry was unreachable FROM THE COMFYUI HOST, and Manager
// returned a healthy 200 with an empty cache. Every pack then fell to
// `unresolved` and rendered as "neither installed nor known to ComfyUI-Manager".
// We cannot see their DNS failure -- it happened in another process -- but an
// empty legacy catalogue is a strong local signal, because a healthy one
// carries thousands of entries.
describe("empty Manager catalogue is flagged, not read as absence (#1136)", () => {
  const base = {
    analysis: {
      requiredPacks: [],
      missingPacks: ["some-pack"],
      unresolved: ["SomeNodeType"],
      dependencies: [],
    },
  };

  it("sets catalogue_unavailable when a non-local channel returns zero packs", async () => {
    const res = await installWorkflowDependenciesForAnalysis(base.analysis as never, {
      fetchManagerList: async () => ({ channel: "default", packs: [] }),
      queueInstall: async () => "legacy",
      resetQueue: async () => undefined,
      startQueue: async () => undefined,
      queueStatus: async () => undefined,
    } as never);
    expect(res.catalogue_unavailable).toBeTruthy();
    expect(res.catalogue_unavailable).toMatch(/NOT evidence that these\s+packs do not exist|NOT evidence/i);
    expect(res.unresolved).toContain("SomeNodeType");
  });

  it("does NOT flag a local channel — an empty local list is a real answer", async () => {
    const res = await installWorkflowDependenciesForAnalysis(base.analysis as never, {
      fetchManagerList: async () => ({ channel: "local", packs: [] }),
      queueInstall: async () => "legacy",
      resetQueue: async () => undefined,
      startQueue: async () => undefined,
      queueStatus: async () => undefined,
    } as never);
    expect(res.catalogue_unavailable).toBeUndefined();
  });

  it("does NOT flag a Manager v4 host — directInstall is the ONLY production over-fire", async () => {
    // S1 from the re-review. fetchManagerList returns {packs: [], directInstall:
    // true} for EVERY v4 host (workflow-deps.ts:188), so `!directInstall` is the
    // only clause standing between v4 users and this note on every install. My
    // two original negatives (a `local` channel, a populated catalogue) covered
    // neither -- dropping `!directInstall` killed zero tests, while the commit
    // claimed they "keep an over-firing version honest".
    const res = await installWorkflowDependenciesForAnalysis(base.analysis as never, {
      fetchManagerList: async () => ({ channel: "default", packs: [], directInstall: true }),
      queueInstall: async () => "v4",
      resetQueue: async () => undefined,
      startQueue: async () => undefined,
      queueStatus: async () => undefined,
    } as never);
    expect(res.catalogue_unavailable).toBeUndefined();
  });

  it("does not set catalogue_unavailable when nothing is unresolved", async () => {
    // Round 3: a comment claimed this gate existed; it did not.
    const res = await installWorkflowDependenciesForAnalysis(
      { requiredPacks: [], missingPacks: [], unresolved: [], dependencies: [] } as never,
      {
        fetchManagerList: async () => ({ channel: "default", packs: [] }),
        queueInstall: async () => "legacy",
        resetQueue: async () => undefined,
        startQueue: async () => undefined,
        queueStatus: async () => undefined,
      } as never,
    );
    expect(res.catalogue_unavailable).toBeUndefined();
  });

  it("does NOT flag a catalogue that actually returned entries", async () => {
    const res = await installWorkflowDependenciesForAnalysis(base.analysis as never, {
      fetchManagerList: async () => ({
        channel: "default",
        packs: [{ id: "other-pack", title: "Other" }],
      }),
      queueInstall: async () => "legacy",
      resetQueue: async () => undefined,
      startQueue: async () => undefined,
      queueStatus: async () => undefined,
    } as never);
    expect(res.catalogue_unavailable).toBeUndefined();
  });
});

// P0-1 from the re-review: extract_deps is the READ action the tool description
// tells callers to use FIRST, and its `unresolved` comes from the MAPPINGS
// endpoint — whose failure was caught, logged at warn, and discarded, after
// which we asserted "not known to ComfyUI-Manager". Stronger evidence thrown
// away than the getlist case: there we infer from an empty list; here we were
// holding the exception.
describe("extract_deps flags an unanswered mappings lookup (#1136)", () => {
  const wf = { nodes: [{ type: "SomeMissingNodeType" }] };
  const objectInfo = {};

  const mk = (fetchManagerMappings: () => Promise<unknown>) =>
    ({
      fetchObjectInfo: async () => objectInfo,
      fetchManagerMappings,
      fetchInstalledPacks: async () => [],
    }) as never;

  it("sets mappings_unavailable when the lookup THROWS", async () => {
    const err = new TypeError("fetch failed");
    (err as unknown as { cause: unknown }).cause = Object.assign(new Error("ENOTFOUND"), {
      code: "ENOTFOUND",
    });
    const res = await extractWorkflowDependencies(wf as never, mk(async () => {
      throw err;
    }));
    expect(res.unresolved.length).toBeGreaterThan(0);
    expect(res.mappings_unavailable).toBeTruthy();
    expect(res.mappings_unavailable).toMatch(/NOT evidence/i);
  });

  it("sets it for an EMPTY mappings response too — a 200 carrying nothing", async () => {
    const res = await extractWorkflowDependencies(wf as never, mk(async () => ({})));
    expect(res.mappings_unavailable).toBeTruthy();
  });

  it("says 'no usable entries', NOT 'came back EMPTY', for an unparseable shape", async () => {
    // buildMappingIndex skips non-Array values, so a v4 shape difference yields
    // an empty index from a NON-empty body. Claiming the response was empty
    // asserts something we never checked -- the defect class this issue is
    // about, one endpoint over.
    const res = await extractWorkflowDependencies(
      wf as never,
      mk(async () => ({ "some-pack": { nodes: ["SomeMissingNodeType"] } })),
    );
    expect(res.mappings_unavailable).toBeTruthy();
    expect(res.mappings_unavailable).not.toMatch(/came back EMPTY/);
    expect(res.mappings_unavailable).toMatch(/no usable entries/i);
  });

  it("does not set the note when there is nothing unresolved to mislead about", async () => {
    // H3 — the producer gate I described in review and had not pinned.
    const res = await extractWorkflowDependencies({ nodes: [] } as never, mk(async () => ({})));
    expect(res.unresolved).toEqual([]);
    expect(res.mappings_unavailable).toBeUndefined();
  });

  it("stays quiet when the mappings lookup actually answered", async () => {
    const res = await extractWorkflowDependencies(
      wf as never,
      mk(async () => ({ "some-pack": [["SomeMissingNodeType"], { title_aux: "Some Pack" }] })),
    );
    expect(res.mappings_unavailable).toBeUndefined();
  });
});

// #2765 — extract_deps returned an unrelated repository as the owner of four
// distinct nodes, and the readiness result then reported THAT pack missing. The
// reporter's own summary of the cost: it "could make the user install unrelated
// third-party code". The owner's ruling: anything pointing at a non-canonical
// pack is hack territory.
//
// Two claims were being consulted as equals. A catalogue entry's class-name list
// is a publisher naming its own classes; its `nodename_pattern` is a regex anyone
// may publish about anyone. Measured against the live ComfyUI-Manager catalogue
// (40,656 known class names, 39 patterns), the difference is not theoretical:
// one entry's `Hunyuan` pattern matches 188 names of which 182 belong to other
// packs, and one entry's `Inspire$` takes all 101 of Inspire Pack's nodes.
describe("#2765 pack ownership prefers evidence over a catalogue guess", () => {
  const api = (classTypes: string[]) =>
    Object.fromEntries(classTypes.map((t, i) => [String(i + 1), { class_type: t }]));

  /** Installed, with the loaded module that says which pack the code came from. */
  const installed = (classType: string, packDir: string) => ({
    [classType]: { python_module: `custom_nodes.${packDir}` },
  });

  it("does NOT let a pattern rename an installed node's real pack", async () => {
    // The reported shape: rgthree's node is installed from rgthree-comfy, and a
    // third party's pattern captures it.
    const deps = makeDeps({
      fetchObjectInfo: vi.fn(async () => installed("Power Lora Loader (rgthree)", "rgthree-comfy")),
      fetchManagerMappings: vi.fn(
        async () =>
          ({
            "https://github.com/DemonGatanjieu/Anomalous_Model_Browser": [
              [],
              { title: "Anomalous_Model_Browser", nodename_pattern: "Loader" },
            ],
          }) as never,
      ),
    });
    const res = await extractWorkflowDependencies(api(["Power Lora Loader (rgthree)"]), deps);
    expect(res.dependencies[0].pack).toBe("rgthree-comfy");
    expect(res.dependencies[0].source).toBe("object_info");
    expect(res.requiredPacks).not.toContain("Anomalous_Model_Browser");
  });

  it("still takes the friendly name from an EXACT catalogue entry", async () => {
    // The publisher naming its own class is a statement, not a guess, so it may
    // still improve on a directory name. Only the regex path is distrusted.
    const deps = makeDeps({
      fetchObjectInfo: vi.fn(async () => installed("ImpactSomething", "ComfyUI-Impact-Pack-dir")),
    });
    const res = await extractWorkflowDependencies(api(["ImpactSomething"]), deps);
    expect(res.dependencies[0].pack).toBe("ComfyUI-Impact-Pack");
    expect(res.dependencies[0].source).toBe("manager_mappings");
  });

  it("refuses to pick when two packs' patterns both match", async () => {
    const deps = makeDeps({
      fetchObjectInfo: vi.fn(async () => ({})),
      fetchManagerMappings: vi.fn(
        async () =>
          ({
            "https://github.com/a/one": [[], { title: "PackOne", nodename_pattern: "^Krea2Edit" }],
            "https://github.com/b/two": [[], { title: "PackTwo", nodename_pattern: "Encode$" }],
          }) as never,
      ),
    });
    const res = await extractWorkflowDependencies(api(["Krea2EditGroundedEncode"]), deps);
    expect(res.dependencies[0].pack).toBeNull();
    expect(res.dependencies[0].source).toBe("unresolved");
    expect(res.unresolved).toEqual(["Krea2EditGroundedEncode"]);
  });

  it("ignores a regex two different packs publish", async () => {
    // Live catalogue: `_jru$`, `Inspire$` and `- Ostris$` are each published twice.
    // Same unanimity rule as above rather than a rule of its own — an earlier draft
    // had a dedicated `contested` flag, and mutating it away killed no test because
    // it could not: where BOTH claimants survive, unanimity already refuses, and
    // where one is disqualified as over-broad the survivor is the right answer, so
    // refusing there threw a correct mapping away. Against the live catalogue that
    // is the difference between `SomethingInspire` resolving to Inspire Pack and
    // resolving to nothing.
    const deps = makeDeps({
      fetchObjectInfo: vi.fn(async () => ({})),
      fetchManagerMappings: vi.fn(
        async () =>
          ({
            "https://github.com/a/one": [[], { title: "PackOne", nodename_pattern: "Inspire$" }],
            "https://github.com/b/two": [[], { title: "PackTwo", nodename_pattern: "Inspire$" }],
          }) as never,
      ),
    });
    const res = await extractWorkflowDependencies(api(["SomethingInspire"]), deps);
    expect(res.dependencies[0].pack).toBeNull();
  });

  it("ignores a pattern that mostly captures other packs' listed nodes", async () => {
    // Six names, five of them explicitly listed by a different pack. That is a
    // capture, not a namespace.
    const deps = makeDeps({
      fetchObjectInfo: vi.fn(async () => ({})),
      fetchManagerMappings: vi.fn(
        async () =>
          ({
            "https://github.com/real/owner": [
              ["HunyuanA", "HunyuanB", "HunyuanC", "HunyuanD", "HunyuanE"],
              { title: "RealOwner" },
            ],
            "https://github.com/greedy/pack": [
              ["HunyuanMine"],
              { title: "GreedyPack", nodename_pattern: "Hunyuan" },
            ],
          }) as never,
      ),
    });
    const res = await extractWorkflowDependencies(api(["HunyuanUnknownNode"]), deps);
    expect(res.dependencies[0].pack).toBeNull();
    expect(res.dependencies[0].source).toBe("unresolved");
  });

  it("does NOT refuse a narrow pattern on thin evidence", async () => {
    // The over-refusal direction, which would quietly break every legitimate
    // per-pack pattern. rgthree's ` \(rgthree\)$` matches exactly one known name
    // in the live catalogue, and that name lost the first-writer race to another
    // entry — judging it on a majority of one would refuse a good pattern.
    const deps = makeDeps({
      fetchObjectInfo: vi.fn(async () => ({})),
      fetchManagerMappings: vi.fn(
        async () =>
          ({
            "https://github.com/other/pack": [["Power Lora Loader (rgthree)"], { title: "Other" }],
            "https://github.com/rgthree/rgthree-comfy": [
              [],
              { title: "rgthree-comfy", nodename_pattern: " \\(rgthree\\)$" },
            ],
          }) as never,
      ),
    });
    const res = await extractWorkflowDependencies(api(["Seed (rgthree)"]), deps);
    expect(res.dependencies[0].pack).toBe("rgthree-comfy");
  });

  it("names a pattern-derived owner as the weaker claim it is", async () => {
    // install_deps acts on this result, so "a regex matched" must not read the
    // same as "the publisher listed this class".
    const deps = makeDeps({
      fetchObjectInfo: vi.fn(async () => ({})),
      fetchManagerMappings: vi.fn(
        async () =>
          ({
            "https://github.com/c/three": [
              [],
              { title: "Crystools", nodename_pattern: " \\[Crystools\\]$" },
            ],
          }) as never,
      ),
    });
    const res = await extractWorkflowDependencies(api(["Switch latent [Crystools]"]), deps);
    expect(res.dependencies[0].pack).toBe("Crystools");
    expect(res.dependencies[0].source).toBe("manager_pattern");
    expect(res.missingPacks).toEqual(["Crystools"]);
  });
});
