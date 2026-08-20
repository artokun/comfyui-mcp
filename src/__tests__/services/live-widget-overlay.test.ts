// #959 — one bug reported three times: #961 (Eclipse wildcards), #955 (the same
// node with numeric seeds), #361 (five model/LoRA/VAE filenames each replaced by a
// different file on disk). The mechanism is shared: `graph_serialize` stores widget
// values POSITIONALLY in the FRONTEND's order, and the converter names those
// positions from object_info's input order. Custom nodes that add or reorder
// widgets in JS make the two disagree, and every value from the first disagreement
// onward lands on the wrong widget — silently, with a valid-looking graph.
//
// These tests cover both halves of the fix: the overlay decides whether the
// name-keyed capture describes the SAME nodes as the serialized graph (refusing
// when it can't tell), and the converter then maps by name instead of by index.

import { describe, expect, it } from "vitest";
import { applyCapturedWidgetValues } from "../../services/live-widget-overlay.js";
import { convertUiToApi } from "../../services/workflow-converter.js";

// ── the reported node ───────────────────────────────────────────────────────
// object_info orders `seed` BEFORE `wildcards`; the Eclipse frontend serializes
// `wildcards` BEFORE `seed`. That single inversion is the whole bug.
const ECLIPSE = "Wildcard Processor [Eclipse]";
const OBJECT_INFO = {
  [ECLIPSE]: {
    input: {
      required: {
        wildcard_text: ["STRING"],
        populated_text: ["STRING"],
        mode: [["populate", "fixed"]],
        seed: ["INT"],
        wildcards: [["Select a Wildcard", "__smart_prompt/01_subjects/10_face__"]],
      },
    },
  },
} as never;

const WILDCARD = "__smart_prompt/01_subjects/10_face__";

/** The live canvas as `graph_serialize` returns it: frontend widget order. */
const serializedCanvas = () => ({
  nodes: [
    {
      id: 296,
      type: ECLIPSE,
      mode: 0,
      inputs: [],
      outputs: [],
      // frontend order — wildcards BEFORE seed
      widgets_values: ["a cat", "a cat", "populate", WILDCARD, 101],
    },
  ],
  links: [],
});

/** The same canvas as `graph_get_state` returns it: name-keyed, order-free. */
const nameKeyedState = () => ({
  viewing: { scope: "root" },
  node_count: 1,
  truncated: false,
  nodes: [
    {
      id: 296,
      type: ECLIPSE,
      widgets: {
        wildcard_text: "a cat",
        populated_text: "a cat",
        mode: "populate",
        seed: 101,
        wildcards: WILDCARD,
      },
    },
  ],
});

describe("#959: the bug, reproduced", () => {
  // This is the failure the three reports describe. It is asserted deliberately:
  // if this test ever stops failing on its own, the positional path changed and
  // the overlay below is no longer testing what it claims to.
  it("without the capture, the wildcard STRING is emitted as the seed", () => {
    const { workflow } = convertUiToApi(serializedCanvas() as never, OBJECT_INFO);
    expect(workflow["296"].inputs.seed).toBe(WILDCARD);
    expect(workflow["296"].inputs.seed).not.toBe(101);
  });
});

describe("#959: the capture fixes it", () => {
  it("with the name-keyed capture, every widget gets its own value", () => {
    const ui = serializedCanvas();
    const out = applyCapturedWidgetValues(ui, nameKeyedState());
    expect(out.applied).toBe(1);
    expect(out.refused).toBeUndefined();
    // A fully covered graph has nothing left to caveat, so it says nothing.
    expect(out.notes).toEqual([]);

    const { workflow } = convertUiToApi(ui as never, OBJECT_INFO);
    expect(workflow["296"].inputs.seed).toBe(101);
    expect(workflow["296"].inputs.wildcards).toBe(WILDCARD);
    expect(workflow["296"].inputs.mode).toBe("populate");
    expect(workflow["296"].inputs.wildcard_text).toBe("a cat");
  });

  // The shift compounds: `seed` is an INT with control_after_generate, so the
  // positional pass consumes a PHANTOM slot after it. Having already taken the
  // wildcard string as the seed, it then swallows the real seed as that phantom
  // and runs out of values — so `wildcards` is never assigned at all and falls
  // back to the node default. One inverted pair costs BOTH widgets, and nothing
  // in the output says so.
  it("the trailing widget is lost entirely, not merely misassigned", () => {
    const before = convertUiToApi(serializedCanvas() as never, OBJECT_INFO);
    expect(before.workflow["296"].inputs.wildcards).not.toBe(WILDCARD);

    const ui = serializedCanvas();
    applyCapturedWidgetValues(ui, nameKeyedState());
    const after = convertUiToApi(ui as never, OBJECT_INFO);
    expect(after.workflow["296"].inputs.wildcards).toBe(WILDCARD);
  });

  // #361's severity case: the values that shifted were model filenames, so the
  // user rendered with a different checkpoint and nothing reported a problem.
  it("an asset filename is not swapped onto a neighbouring widget", () => {
    const ui = serializedCanvas();
    ui.nodes[0].widgets_values = ["a cat", "a cat", "populate", WILDCARD, 202];
    applyCapturedWidgetValues(ui, {
      ...nameKeyedState(),
      nodes: [
        {
          id: 296,
          type: ECLIPSE,
          widgets: { ...nameKeyedState().nodes[0].widgets, seed: 202 },
        },
      ],
    });
    const { workflow } = convertUiToApi(ui as never, OBJECT_INFO);
    expect(workflow["296"].inputs.seed).toBe(202);
    expect(workflow["296"].inputs.wildcards).toBe(WILDCARD);
  });
});

describe("#959: the overlay refuses what it cannot match", () => {
  // THE catastrophic case. graph_serialize always serializes the ROOT graph, but
  // graph_get_state reports whichever graph the user is INSIDE. Overlaying a
  // subgraph's node 296 onto the root's node 296 would apply an unrelated node's
  // values — a worse bug than the one being fixed.
  it("refuses when the panel is viewing a subgraph, not the root", () => {
    const ui = serializedCanvas();
    const out = applyCapturedWidgetValues(ui, {
      ...nameKeyedState(),
      viewing: { scope: "subgraph", owner_node_id: 12, title: "sampler" },
    });
    expect(out.applied).toBe(0);
    expect(out.refused).toMatch(/subgraph/i);
    expect(ui.nodes[0]).not.toHaveProperty("capturedWidgetValues");
    // and it must SAY the mapping stayed positional rather than staying quiet.
    expect(out.notes.join("\n")).toMatch(/mapped by POSITION/);
  });

  it("refuses when the capture does not say which graph it describes", () => {
    const state = nameKeyedState() as Record<string, unknown>;
    delete state.viewing;
    const out = applyCapturedWidgetValues(serializedCanvas(), state);
    expect(out.applied).toBe(0);
    expect(out.refused).toBeTruthy();
  });

  it("refuses a reply with no nodes at all", () => {
    const out = applyCapturedWidgetValues(serializedCanvas(), null);
    expect(out.applied).toBe(0);
    expect(out.refused).toMatch(/no live widget capture/i);
  });

  // The wording is load-bearing: we did not verify the order, which is NOT the
  // same as having found it wrong. Reporting the stronger claim is the exact
  // defect class this repo keeps hitting.
  it("reports an unverified mapping as unverified, never as wrong", () => {
    const out = applyCapturedWidgetValues(serializedCanvas(), null);
    const text = out.notes.join("\n");
    expect(text).toMatch(/MAY be attributed to the wrong widget/);
    expect(text).toMatch(/unverified, not known wrong/);
    expect(text).not.toMatch(/values are wrong|is incorrect/i);
  });
});

describe("#959: partial coverage is disclosed, not hidden", () => {
  const twoNodes = () => {
    const ui = serializedCanvas();
    ui.nodes.push({
      id: 297,
      type: ECLIPSE,
      mode: 0,
      inputs: [],
      outputs: [],
      widgets_values: ["a dog", "a dog", "populate", WILDCARD, 202],
    });
    return ui;
  };

  it("covers the nodes it can and names the ones it could not", () => {
    const ui = twoNodes();
    const out = applyCapturedWidgetValues(ui, nameKeyedState());
    expect(out.applied).toBe(1);
    expect(out.uncovered).toBe(1);
    expect(out.notes.join("\n")).toMatch(/1 of 2 node\(s\)/);
    // The covered node is still fixed — partial coverage beats none.
    const { workflow } = convertUiToApi(ui as never, OBJECT_INFO);
    expect(workflow["296"].inputs.seed).toBe(101);
  });

  it("names the per-read node cap when that is why coverage was partial", () => {
    const out = applyCapturedWidgetValues(twoNodes(), {
      ...nameKeyedState(),
      node_count: 2,
      truncated: true,
    });
    expect(out.notes.join("\n")).toMatch(/at most 1 nodes per read/);
  });

  // Two entries claiming one id can't be attributed to either, so neither wins.
  it("drops a duplicated node id instead of picking one", () => {
    const state = nameKeyedState();
    state.nodes.push({ ...state.nodes[0], widgets: { ...state.nodes[0].widgets, seed: 999 } });
    const ui = serializedCanvas();
    const out = applyCapturedWidgetValues(ui, state);
    expect(out.applied).toBe(0);
    expect(out.notes.join("\n")).toMatch(/more than once/);
    expect(ui.nodes[0]).not.toHaveProperty("capturedWidgetValues");
  });
});

describe("#959: the overlay does not disturb index-read widget values", () => {
  // Several call sites read widgets_values BY INDEX — a subgraph node's
  // proxyWidgets, a PrimitiveNode's literal at [0], a Set/Get node's bus name.
  // Writing an object into that array would silently drop all three, which is
  // why the capture lives in its own field.
  it("leaves widgets_values an array", () => {
    const ui = serializedCanvas();
    applyCapturedWidgetValues(ui, nameKeyedState());
    expect(Array.isArray(ui.nodes[0].widgets_values)).toBe(true);
    expect(ui.nodes[0].widgets_values).toEqual(["a cat", "a cat", "populate", WILDCARD, 101]);
  });

  it("a PrimitiveNode's literal still reaches its consumer", () => {
    const objectInfo = {
      KSampler: { input: { required: { seed: ["INT"], steps: ["INT"] } } },
    } as never;
    const ui = {
      nodes: [
        {
          id: 1,
          type: "PrimitiveNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "INT", type: "INT", links: [1] }],
          widgets_values: [42, "fixed"],
        },
        {
          id: 2,
          type: "KSampler",
          mode: 0,
          inputs: [{ name: "seed", type: "INT", link: 1, widget: { name: "seed" } }],
          outputs: [],
          widgets_values: [0, 20],
        },
      ],
      links: [[1, 1, 0, 2, 0, "INT"]],
    };
    applyCapturedWidgetValues(ui, {
      viewing: { scope: "root" },
      nodes: [
        { id: 1, type: "PrimitiveNode", widgets: { value: 42, control_after_generate: "fixed" } },
        { id: 2, type: "KSampler", widgets: { seed: 0, steps: 20 } },
      ],
    });
    const { workflow } = convertUiToApi(ui as never, objectInfo);
    // The literal is read from widgets_values[0]; the capture must not have
    // replaced that array with an object, or 42 would vanish and seed keep 0.
    expect(workflow["2"].inputs.seed).toBe(42);
    expect(workflow["2"].inputs.steps).toBe(20);
  });
});
