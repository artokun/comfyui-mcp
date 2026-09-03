// Issue #361: panel_strip_workflow / get_workflow (action:"strip") returned WRONG dynamic
// widget values and DROPPED Set/Get (and other node-pack "virtual") links —
// silently, so the caller got a graph that looks fine and renders differently.
//
// Two independent defects, both covered here:
//   1. Promoted ("proxy") subgraph widget values were resolved POSITIONALLY via
//      the widget's index among the inputs[] entries that carry a `widget` field.
//      A widget absent from inputs[] resolved to nothing (value dropped), and a
//      subgraph-input promotion (proxy id "-1") never resolved at all — so the
//      stripped graph reported the inner node's STALE stored value.
//   2. Virtual wiring that cannot be resolved (an orphan Get bus, a dead Reroute)
//      was dropped with NO warning, and cg-use-everywhere broadcasts — which are
//      not ordinary graph links at all — were never materialized.
//
// The invariant these tests defend: whatever the stripped graph cannot preserve,
// it must SAY SO.
import { describe, it, expect } from "vitest";
import { convertUiToApi } from "../../services/workflow-converter.js";

const OBJECT_INFO = {
  LoadImage: { input: { required: { image: [["a.png", "b.png"]] } } },
  SaveImage: {
    input: { required: { images: ["IMAGE"], filename_prefix: ["STRING", { default: "x" }] } },
  },
  EmptyLatentImage: {
    input: {
      required: {
        width: ["INT", { default: 512 }],
        height: ["INT", { default: 512 }],
        batch_size: ["INT", { default: 1 }],
      },
    },
  },
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [["installed.safetensors"]] } },
  },
  "Anything Everywhere": { input: { required: {}, optional: { anything: ["*"] } } },
  PrimitiveInt: { input: { required: { value: ["INT", { default: 0 }] } }, output: ["INT"] },
} as never;

const joined = (warnings: string[]) => warnings.join("\n");

// ── 1. Set/Get buses ────────────────────────────────────────────────────────

describe("#361 — Set/Get bus links", () => {
  /** SaveImage(3) fed from GetNode(5) on bus `bus`; SetNode(4) writes `writes`. */
  function busGraph(writes: string | null, bus: string) {
    const nodes: unknown[] = [
      {
        id: 1,
        type: "LoadImage",
        mode: 0,
        inputs: [],
        outputs: [{ name: "IMAGE", type: "IMAGE", links: writes == null ? [] : [11] }],
        widgets_values: ["a.png"],
      },
      {
        id: 5,
        type: "GetNode",
        mode: 0,
        inputs: [],
        outputs: [{ name: "IMAGE", type: "IMAGE", links: [10] }],
        widgets_values: [bus],
      },
      {
        id: 3,
        type: "SaveImage",
        mode: 0,
        inputs: [{ name: "images", type: "IMAGE", link: 10 }],
        outputs: [],
        widgets_values: ["out"],
      },
    ];
    const links: unknown[] = [[10, 5, 0, 3, 0, "IMAGE"]];
    if (writes != null) {
      nodes.push({
        id: 4,
        type: "SetNode",
        mode: 0,
        inputs: [{ name: "value", type: "IMAGE", link: 11 }],
        outputs: [{ name: "*", type: "IMAGE", links: [] }],
        widgets_values: [writes],
      });
      links.push([11, 1, 0, 4, 0, "IMAGE"]);
    }
    return { nodes, links } as never;
  }

  // Guard (not a #361 regression test — the pre-fix converter also resolved this):
  // the new disclosure must not fire on a graph that loses nothing.
  it("a RESOLVABLE bus still becomes a real link, with nothing reported as lost", () => {
    const { workflow, warnings } = convertUiToApi(busGraph("img", "img"), OBJECT_INFO);
    expect(workflow["3"].inputs.images).toEqual(["1", 0]);
    expect(warnings).toEqual([]);
  });

  it("an ORPHAN Get bus names the consumer, the input, the bus, and says the connection is absent", () => {
    const { workflow, warnings } = convertUiToApi(busGraph(null, "missing_bus"), OBJECT_INFO);
    // The connection genuinely cannot be recovered — but it must be REPORTED.
    expect(workflow["3"].inputs.images).toBeUndefined();
    const text = joined(warnings);
    expect(text).toContain("Node 3 (SaveImage)");
    expect(text).toContain('input "images"');
    expect(text).toContain("missing_bus");
    expect(text).toContain("ABSENT from the stripped graph");
  });

  it("a Get bus whose Set node has no incoming connection says so", () => {
    const g = busGraph("img", "img") as unknown as {
      nodes: { id: number; inputs?: { link: number | null }[] }[];
      links: unknown[];
    };
    // Cut the SetNode's feed.
    g.nodes.find((n) => n.id === 4)!.inputs![0].link = null;
    g.links = g.links.filter((l) => (l as number[])[0] !== 11);
    const { warnings } = convertUiToApi(g as never, OBJECT_INFO);
    expect(joined(warnings)).toContain("has no incoming connection");
  });

  it("two Set nodes on one bus is reported as ambiguous (last one wins)", () => {
    const g = busGraph("img", "img") as unknown as { nodes: unknown[]; links: unknown[] };
    g.nodes.push({
      id: 6,
      type: "SetNode",
      mode: 0,
      inputs: [{ name: "value", type: "IMAGE", link: 12 }],
      outputs: [],
      widgets_values: ["img"],
    });
    g.links.push([12, 1, 0, 6, 0, "IMAGE"]);
    const { warnings } = convertUiToApi(g as never, OBJECT_INFO);
    expect(joined(warnings)).toContain('bus "img" is written by more than one Set node');
  });

  it("a Reroute with no incoming connection is reported, not silently dropped", () => {
    const g = {
      nodes: [
        {
          id: 9,
          type: "Reroute",
          mode: 0,
          inputs: [{ name: "", type: "IMAGE", link: null }],
          outputs: [{ name: "", type: "IMAGE", links: [30] }],
          widgets_values: [],
        },
        {
          id: 3,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: 30 }],
          outputs: [],
          widgets_values: ["out"],
        },
      ],
      links: [[30, 9, 0, 3, 0, "IMAGE"]],
    } as never;
    const { warnings } = convertUiToApi(g, OBJECT_INFO);
    expect(joined(warnings)).toContain("Reroute #9 has no incoming connection");
    expect(joined(warnings)).toContain('input "images"');
  });
});

// ── 2. cg-use-everywhere broadcasts ─────────────────────────────────────────

describe("#361 — cg-use-everywhere broadcast links", () => {
  function ueGraph(withUeLinks: boolean) {
    return {
      extra: withUeLinks
        ? {
            ue_links: [
              {
                downstream: 3,
                downstream_slot: 0,
                upstream: 1,
                upstream_slot: 0,
                controller: 7,
                type: "IMAGE",
              },
            ],
          }
        : {},
      nodes: [
        {
          id: 1,
          type: "LoadImage",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [20] }],
          widgets_values: ["a.png"],
        },
        {
          id: 7,
          type: "Anything Everywhere",
          mode: 0,
          inputs: [{ name: "anything", type: "*", link: 20 }],
          outputs: [],
          widgets_values: [],
        },
        {
          id: 3,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: null }],
          outputs: [],
          widgets_values: ["out"],
        },
      ],
      links: [[20, 1, 0, 7, 0, "IMAGE"]],
    } as never;
  }

  it("materializes a broadcast from the pack's own extra.ue_links", () => {
    const { workflow, warnings } = convertUiToApi(ueGraph(true), OBJECT_INFO);
    expect(workflow["3"].inputs.images).toEqual(["1", 0]);
    expect(warnings).toEqual([]);
  });

  it("senders with NO extra.ue_links: refuses to guess, and says the connections are unrecoverable", () => {
    const { workflow, warnings } = convertUiToApi(ueGraph(false), OBJECT_INFO);
    expect(workflow["3"].inputs.images).toBeUndefined(); // never fabricated
    const text = joined(warnings);
    expect(text).toContain("Anything Everywhere #7");
    expect(text).toContain("CANNOT be recovered");
    expect(text).toContain("extra.ue_links");
  });

  it("a broadcast whose producer sits behind a Set/Get bus resolves to the real producer", () => {
    const g = {
      extra: {
        ue_links: [
          {
            downstream: 3,
            downstream_slot: 0,
            upstream: 5,
            upstream_slot: 0,
            controller: 7,
            type: "IMAGE",
          },
        ],
      },
      nodes: [
        {
          id: 1,
          type: "LoadImage",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [21] }],
          widgets_values: ["a.png"],
        },
        {
          id: 4,
          type: "SetNode",
          mode: 0,
          inputs: [{ name: "value", type: "IMAGE", link: 21 }],
          outputs: [],
          widgets_values: ["img"],
        },
        {
          id: 5,
          type: "GetNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [22] }],
          widgets_values: ["img"],
        },
        {
          // The sender is genuinely fed THROUGH the bus, and the pack's record
          // names the bus node as `upstream`. Both sides of the staleness check
          // must be normalized past the virtual wiring or this current record
          // would be misread as rewired and its live connection dropped.
          id: 7,
          type: "Anything Everywhere",
          mode: 0,
          inputs: [{ name: "anything", type: "*", link: 22 }],
          outputs: [],
          widgets_values: [],
        },
        {
          id: 3,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: null }],
          outputs: [],
          widgets_values: ["out"],
        },
      ],
      links: [
        [21, 1, 0, 4, 0, "IMAGE"],
        [22, 5, 0, 7, 0, "IMAGE"],
      ],
    } as never;
    const { workflow, warnings } = convertUiToApi(g, OBJECT_INFO);
    expect(workflow["3"].inputs.images).toEqual(["1", 0]);
    expect(warnings).toEqual([]);
  });

  it("a broadcast into a node that no longer exists is reported", () => {
    const g = ueGraph(true) as unknown as {
      extra: { ue_links: { downstream: number }[] };
    };
    g.extra.ue_links[0].downstream = 999;
    const { warnings } = convertUiToApi(g as never, OBJECT_INFO);
    expect(joined(warnings)).toContain("no longer exists");
  });

  it("a record whose OWN sender was deleted is stale — reported, and no link fabricated", () => {
    // Sender 7 is still there (so the list is still consulted), but this record
    // was produced by a sender that has since been removed.
    const g = ueGraph(true) as unknown as {
      extra: { ue_links: { controller: number }[] };
    };
    g.extra.ue_links[0].controller = 8;
    const { workflow, warnings } = convertUiToApi(g as never, OBJECT_INFO);
    expect(workflow["3"].inputs.images).toBeUndefined();
    expect(joined(warnings)).toContain("the record is stale");
  });

  it("a controller id now belonging to an ORDINARY node is stale, not wired", () => {
    // The id survives, but it is no longer a broadcast node — existence alone is
    // not enough to trust the record.
    const g = ueGraph(true) as unknown as {
      extra: { ue_links: { controller: number }[] };
    };
    g.extra.ue_links[0].controller = 1; // node 1 is a LoadImage, not a sender
    const { workflow, warnings } = convertUiToApi(g as never, OBJECT_INFO);
    expect(workflow["3"].inputs.images).toBeUndefined();
    expect(joined(warnings)).toContain("no longer a broadcast node");
  });

  it("a record whose sender was REWIRED to a different producer fabricates nothing", () => {
    // The most ordinary staleness of all: node 7 is still a live sender, but its
    // input now comes from node 2 while the record still names node 1. Wiring
    // 1 → consumer would put an edge in the stripped graph that does not exist
    // live — a fabricated connection renders as a plausible graph that is
    // silently wrong, which is worse than an obviously missing one.
    const g = ueGraph(true) as unknown as {
      nodes: {
        id: number;
        type: string;
        mode: number;
        inputs?: { name: string; type: string; link: number | null }[];
        outputs?: { name: string; type: string; links: number[] }[];
        widgets_values: unknown[];
      }[];
      links: unknown[];
    };
    g.nodes.push({
      id: 2,
      type: "LoadImage",
      mode: 0,
      inputs: [],
      outputs: [{ name: "IMAGE", type: "IMAGE", links: [30] }],
      widgets_values: ["b.png"],
    });
    g.nodes.find((n) => n.id === 7)!.inputs![0].link = 30; // rewired away from node 1
    g.nodes.find((n) => n.id === 1)!.outputs![0].links = [];
    g.links = [[30, 2, 0, 7, 0, "IMAGE"]];
    const { workflow, warnings } = convertUiToApi(g as never, OBJECT_INFO);
    expect(workflow["3"].inputs.images).toBeUndefined();
    expect(joined(warnings)).toContain("fed by a different producer");
  });

  it("a record whose sender was DISCONNECTED fabricates nothing", () => {
    const g = ueGraph(true) as unknown as {
      nodes: { id: number; inputs?: { link: number | null }[] }[];
      links: unknown[];
    };
    g.nodes.find((n) => n.id === 7)!.inputs![0].link = null;
    g.links = [];
    const { workflow, warnings } = convertUiToApi(g as never, OBJECT_INFO);
    expect(workflow["3"].inputs.images).toBeUndefined();
    expect(joined(warnings)).toContain("no longer has any incoming connection");
  });

  it("a CONTROLLERLESS record is not assumed current — a rewired one fabricates nothing", () => {
    // Older lists omit `controller`, so the record can't be tied to a sender. That
    // is "cannot determine", not "determined current": what is still checkable is
    // whether ANY live broadcast node is fed by the recorded producer.
    const g = ueGraph(true) as unknown as {
      extra: { ue_links: Record<string, unknown>[] };
      nodes: {
        id: number;
        type: string;
        mode: number;
        inputs?: { name: string; type: string; link: number | null }[];
        outputs?: { name: string; type: string; links: number[] }[];
        widgets_values: unknown[];
      }[];
      links: unknown[];
    };
    delete g.extra.ue_links[0].controller;
    g.nodes.push({
      id: 2,
      type: "LoadImage",
      mode: 0,
      inputs: [],
      outputs: [{ name: "IMAGE", type: "IMAGE", links: [30] }],
      widgets_values: ["b.png"],
    });
    g.nodes.find((n) => n.id === 7)!.inputs![0].link = 30; // live UE broadcasts node 2
    g.nodes.find((n) => n.id === 1)!.outputs![0].links = [];
    g.links = [[30, 2, 0, 7, 0, "IMAGE"]];
    const { workflow, warnings } = convertUiToApi(g as never, OBJECT_INFO);
    expect(workflow["3"].inputs.images).toBeUndefined(); // NOT wired from the stale node 1
    expect(joined(warnings)).toContain("names no broadcast node of its own");
  });

  // NOTE: an earlier revision asserted the opposite here — that a controllerless
  // record is materialized as long as SOME live sender is fed by the recorded
  // producer. That expectation was wrong and this test now pins the correct
  // behaviour: an unrelated sender sharing a producer is a coincidence, not
  // evidence about THIS record's target.
  it("an UNRELATED sender sharing the producer does not validate a controllerless record", () => {
    // The record's own sender is gone. A live Prompts Everywhere is also fed by
    // node 1 but broadcasts it somewhere else entirely — wiring 1 → SaveImage#3
    // off the back of that would be a fabricated edge.
    const g = {
      extra: {
        ue_links: [
          { downstream: 3, downstream_slot: 0, upstream: 1, upstream_slot: 0, type: "IMAGE" },
        ],
      },
      nodes: [
        {
          id: 1,
          type: "LoadImage",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [60] }],
          widgets_values: ["a.png"],
        },
        {
          id: 7,
          type: "Prompts Everywhere",
          mode: 0,
          inputs: [{ name: "anything", type: "*", link: 60 }],
          outputs: [],
          widgets_values: [],
        },
        {
          id: 3,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: null }],
          outputs: [],
          widgets_values: ["out"],
        },
      ],
      links: [[60, 1, 0, 7, 0, "IMAGE"]],
    } as never;
    const { workflow, warnings } = convertUiToApi(g, {
      ...(OBJECT_INFO as object),
      "Prompts Everywhere": { input: { required: {}, optional: { anything: ["*"] } } },
    } as never);
    expect(workflow["3"].inputs.images).toBeUndefined();
    expect(joined(warnings)).toContain("cannot be attributed to any sender");
  });

  it("a controllerless record whose producer IS a broadcast node is self-attributing", () => {
    // Seed Everywhere owns its widget, so the record names its own single channel
    // — there is no attribution left to guess, and refusing it would drop a live
    // broadcast for no gain.
    const g = {
      extra: {
        ue_links: [
          { downstream: 3, downstream_slot: 0, upstream: 9, upstream_slot: 0, type: "IMAGE" },
        ],
      },
      nodes: [
        {
          id: 9,
          type: "Seed Everywhere",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
          widgets_values: [42],
        },
        {
          id: 3,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: null }],
          outputs: [],
          widgets_values: ["out"],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(g, {
      ...(OBJECT_INFO as object),
      "Seed Everywhere": {
        input: { required: { seed: ["INT", { default: 0 }] } },
        output: ["IMAGE"],
      },
    } as never);
    expect(workflow["3"].inputs.images).toEqual(["9", 0]);
    expect(warnings).toEqual([]);
  });

  it("'Seed Everywhere?' is recognized as a broadcast node, so its records materialize", () => {
    // The pack registers this class, but the sender predicate compared the
    // "Seed Everywhere" family with equality — so the node was invisible, and
    // with no recognized sender the whole list was dropped with no warning.
    const g = {
      extra: {
        ue_links: [
          {
            downstream: 3,
            downstream_slot: 0,
            upstream: 9,
            upstream_slot: 0,
            controller: 9,
            type: "IMAGE",
          },
        ],
      },
      nodes: [
        {
          id: 9,
          type: "Seed Everywhere?",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
          widgets_values: [42],
        },
        {
          id: 3,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: null }],
          outputs: [],
          widgets_values: ["out"],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(g, {
      ...(OBJECT_INFO as object),
      "Seed Everywhere?": {
        input: { required: { seed: ["INT", { default: 0 }] } },
        output: ["IMAGE"],
      },
    } as never);
    expect(workflow["3"].inputs.images).toEqual(["9", 0]);
    expect(warnings).toEqual([]);
  });

  it("records with NO recognized broadcast node are reported, never dropped in silence", () => {
    // The backstop for any sender class this converter does not know: records
    // present, nothing to attribute them to. Deleted senders and unrecognized
    // senders are indistinguishable here, so it is a could-not-determine.
    const g = ueGraph(true) as unknown as { nodes: { id: number }[] };
    g.nodes = g.nodes.filter((n) => n.id !== 7); // every sender gone
    const { workflow, warnings } = convertUiToApi(g as never, OBJECT_INFO);
    expect(workflow["3"].inputs.images).toBeUndefined();
    expect(joined(warnings)).toContain("no node in it is recognized as a cg-use-everywhere broadcast node");
  });

  it("a sender fed from a subgraph's INPUT boundary broadcasts the outer producer", () => {
    // The producer of a broadcast inside a definition can be the definition's
    // virtual input node — a recoverable connection (the outer component's
    // matching input supplies it), not a missing producer.
    const g = {
      definitions: {
        subgraphs: [
          {
            id: SG_ID,
            name: "Inner",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            inputs: [{ id: "i1", name: "image", type: "IMAGE", linkIds: [11] }],
            outputs: [],
            widgets: [],
            extra: {
              ue_links: [
                {
                  downstream: 3,
                  downstream_slot: 0,
                  upstream: -10,
                  upstream_slot: 0,
                  controller: 7,
                  type: "IMAGE",
                },
              ],
            },
            nodes: [
              {
                id: 7,
                type: "Anything Everywhere",
                mode: 0,
                inputs: [{ name: "anything", type: "*", link: 11 }],
                outputs: [],
                widgets_values: [],
              },
              {
                id: 3,
                type: "SaveImage",
                mode: 0,
                inputs: [{ name: "images", type: "IMAGE", link: null }],
                outputs: [],
                widgets_values: ["out"],
              },
            ],
            links: [
              { id: 11, origin_id: -10, origin_slot: 0, target_id: 7, target_slot: 0, type: "IMAGE" },
            ],
          },
        ],
      },
      nodes: [
        {
          id: 1,
          type: "LoadImage",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [50] }],
          widgets_values: ["a.png"],
        },
        {
          id: 706,
          type: SG_ID,
          mode: 0,
          properties: {},
          inputs: [{ name: "image", type: "IMAGE", link: 50 }],
          outputs: [],
          widgets_values: [],
        },
      ],
      links: [[50, 1, 0, 706, 0, "IMAGE"]],
    } as never;
    const { workflow, warnings } = convertUiToApi(g, OBJECT_INFO);
    const save = Object.values(workflow).find((n) => n.class_type === "SaveImage")!;
    expect(save.inputs.images).toEqual(["1", 0]);
    expect(warnings).toEqual([]);
  });

  it("a sender that IS its own producer (Seed Everywhere shape) is still materialized", () => {
    // The controller owns the widget, so it has no incoming feed to compare —
    // requiring one would drop every Seed Everywhere broadcast.
    const g = {
      extra: {
        ue_links: [
          {
            downstream: 3,
            downstream_slot: 0,
            upstream: 9,
            upstream_slot: 0,
            controller: 9,
            type: "IMAGE",
          },
        ],
      },
      nodes: [
        {
          id: 9,
          type: "Seed Everywhere",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
          widgets_values: [42],
        },
        {
          id: 3,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: null }],
          outputs: [],
          widgets_values: ["out"],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(g, {
      ...(OBJECT_INFO as object),
      "Seed Everywhere": {
        input: { required: { seed: ["INT", { default: 0 }] } },
        output: ["IMAGE"],
      },
    } as never);
    expect(workflow["3"].inputs.images).toEqual(["9", 0]);
    expect(warnings).toEqual([]);
  });

  it("a MULTI-INPUT sender keeps every one of its current records", () => {
    // Prompts Everywhere-style: two records share one controller, each naming a
    // different producer. Checking only the sender's first feed would flag the
    // second record as rewired and drop a live connection.
    const g = {
      extra: {
        ue_links: [
          { downstream: 3, downstream_slot: 0, upstream: 1, upstream_slot: 0, controller: 7, type: "IMAGE" },
          { downstream: 4, downstream_slot: 0, upstream: 2, upstream_slot: 0, controller: 7, type: "IMAGE" },
        ],
      },
      nodes: [
        {
          id: 1,
          type: "LoadImage",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [40] }],
          widgets_values: ["a.png"],
        },
        {
          id: 2,
          type: "LoadImage",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [41] }],
          widgets_values: ["b.png"],
        },
        {
          id: 7,
          type: "Anything Everywhere3",
          mode: 0,
          inputs: [
            { name: "anything", type: "*", link: 40 },
            { name: "anything2", type: "*", link: 41 },
          ],
          outputs: [],
          widgets_values: [],
        },
        {
          id: 3,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: null }],
          outputs: [],
          widgets_values: ["out"],
        },
        {
          id: 4,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: null }],
          outputs: [],
          widgets_values: ["out2"],
        },
      ],
      links: [
        [40, 1, 0, 7, 0, "IMAGE"],
        [41, 2, 0, 7, 1, "IMAGE"],
      ],
    } as never;
    const { workflow, warnings } = convertUiToApi(g, {
      ...(OBJECT_INFO as object),
      "Anything Everywhere3": {
        input: { required: {}, optional: { anything: ["*"], anything2: ["*"] } },
      },
    } as never);
    expect(workflow["3"].inputs.images).toEqual(["1", 0]);
    expect(workflow["4"].inputs.images).toEqual(["2", 0]);
    // Both records are preserved — and the residual is disclosed ONCE for the
    // sender, because a record does not name the input its broadcast came
    // through, so a stale list that swapped the sender's channels would be
    // indistinguishable from this one.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Node 7 (Anything Everywhere3)");
    expect(warnings[0]).toContain("could not be matched to a specific sender input");
  });

  it("a sender with several inputs from ONE producer needs no channel caveat", () => {
    // One producer, so there is no channel to confuse — the caveat must not fire
    // here or it becomes noise on every multi-input graph.
    const g = {
      extra: {
        ue_links: [
          { downstream: 3, downstream_slot: 0, upstream: 1, upstream_slot: 0, controller: 7, type: "IMAGE" },
        ],
      },
      nodes: [
        {
          id: 1,
          type: "LoadImage",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [40, 41] }],
          widgets_values: ["a.png"],
        },
        {
          id: 7,
          type: "Anything Everywhere3",
          mode: 0,
          inputs: [
            { name: "anything", type: "*", link: 40 },
            { name: "anything2", type: "*", link: 41 },
          ],
          outputs: [],
          widgets_values: [],
        },
        {
          id: 3,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: null }],
          outputs: [],
          widgets_values: ["out"],
        },
      ],
      links: [
        [40, 1, 0, 7, 0, "IMAGE"],
        [41, 1, 0, 7, 1, "IMAGE"],
      ],
    } as never;
    const { workflow, warnings } = convertUiToApi(g, {
      ...(OBJECT_INFO as object),
      "Anything Everywhere3": {
        input: { required: {}, optional: { anything: ["*"], anything2: ["*"] } },
      },
    } as never);
    expect(workflow["3"].inputs.images).toEqual(["1", 0]);
    expect(warnings).toEqual([]);
  });

  it("a CHANNEL-SWAPPED stale list is materialized but the uncertainty is disclosed", () => {
    // The record says node 1 feeds SaveImage#3; live, node 1 feeds the sender's
    // SECOND input while node 2 feeds the first. Nothing in a ue_links record
    // names the sender input a broadcast came through, so this is
    // indistinguishable from a current list — it cannot be REFUSED without
    // dropping every legitimate multi-channel graph, but it must not pass in
    // silence either.
    const g = {
      extra: {
        ue_links: [
          { downstream: 3, downstream_slot: 0, upstream: 1, upstream_slot: 0, controller: 7, type: "IMAGE" },
        ],
      },
      nodes: [
        {
          id: 1,
          type: "LoadImage",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [41] }],
          widgets_values: ["a.png"],
        },
        {
          id: 2,
          type: "LoadImage",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [40] }],
          widgets_values: ["b.png"],
        },
        {
          id: 7,
          type: "Prompts Everywhere",
          mode: 0,
          inputs: [
            { name: "anything", type: "*", link: 40 },
            { name: "anything2", type: "*", link: 41 },
          ],
          outputs: [],
          widgets_values: [],
        },
        {
          id: 3,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: null }],
          outputs: [],
          widgets_values: ["out"],
        },
      ],
      links: [
        [40, 2, 0, 7, 0, "IMAGE"],
        [41, 1, 0, 7, 1, "IMAGE"],
      ],
    } as never;
    const { workflow, warnings } = convertUiToApi(g, {
      ...(OBJECT_INFO as object),
      "Prompts Everywhere": {
        input: { required: {}, optional: { anything: ["*"], anything2: ["*"] } },
      },
    } as never);
    expect(workflow["3"].inputs.images).toEqual(["1", 0]); // not dropped
    expect(joined(warnings)).toContain("could not be matched to a specific sender input");
    expect(joined(warnings)).toContain("SWAPPING");
  });

  it("a foreign class sharing a sender name PREFIX fabricates nothing, even when fed", () => {
    // The fabrication direction: node 9 IS fed by node 1, so a feed check alone
    // would confirm this stale record and emit 1 → SaveImage#3. Membership cannot
    // be inferred from a name shape, and no feed check rescues a wrong
    // classification — so the class is not a sender, nothing is wired, and the
    // records are reported by the no-recognized-sender backstop.
    const g = {
      extra: {
        ue_links: [
          { downstream: 3, downstream_slot: 0, upstream: 1, upstream_slot: 0, controller: 9, type: "IMAGE" },
        ],
      },
      nodes: [
        {
          id: 1,
          type: "LoadImage",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [70] }],
          widgets_values: ["a.png"],
        },
        {
          id: 9,
          type: "Seed Everywhere Helper",
          mode: 0,
          inputs: [{ name: "anything", type: "*", link: 70 }],
          outputs: [],
          widgets_values: [1],
        },
        {
          id: 3,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: null }],
          outputs: [],
          widgets_values: ["out"],
        },
      ],
      links: [[70, 1, 0, 9, 0, "IMAGE"]],
    } as never;
    const { workflow, warnings } = convertUiToApi(g, {
      ...(OBJECT_INFO as object),
      "Seed Everywhere Helper": {
        input: { required: {}, optional: { anything: ["*"] } },
      },
    } as never);
    expect(workflow["3"].inputs.images).toBeUndefined();
    expect(joined(warnings)).toContain("no node in it is recognized as a cg-use-everywhere broadcast node");
  });

  it("a live sender that the ue_links list does not mention is reported", () => {
    // A non-empty list is not proof it covers every sender. One that predates a
    // sender simply has no row for it, and that sender's broadcasts then come out
    // unconnected — on a list that looked usable, exactly the silent difference
    // this whole change removes.
    const g = ueGraph(true) as unknown as {
      nodes: {
        id: number;
        type: string;
        mode: number;
        inputs?: unknown[];
        outputs?: unknown[];
        widgets_values: unknown[];
      }[];
    };
    g.nodes.push({
      id: 8,
      type: "Anything Everywhere",
      mode: 0,
      inputs: [{ name: "anything", type: "*", link: null }],
      outputs: [],
      widgets_values: [],
    });
    const { workflow, warnings } = convertUiToApi(g as never, OBJECT_INFO);
    expect(workflow["3"].inputs.images).toEqual(["1", 0]); // listed record still wired
    expect(joined(warnings)).toContain("Anything Everywhere #8");
    expect(joined(warnings)).toContain("no record in extra.ue_links names it");
  });

  it("an EMPTY computed list is an answer, not an unknown — no warning, no invented link", () => {
    // The pack analysed the graph and recorded zero broadcasts. Reporting that as
    // "unrecoverable" would invent a loss that did not happen.
    const g = ueGraph(true) as unknown as { extra: { ue_links: unknown[] } };
    g.extra.ue_links = [];
    const { workflow, warnings } = convertUiToApi(g as never, OBJECT_INFO);
    expect(workflow["3"].inputs.images).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("a record naming an output slot the producer no longer has is stale, not wired", () => {
    const g = ueGraph(true) as unknown as {
      extra: { ue_links: { upstream_slot: number }[] };
    };
    g.extra.ue_links[0].upstream_slot = 5; // LoadImage(1) serializes ONE output
    const { workflow, warnings } = convertUiToApi(g as never, OBJECT_INFO);
    expect(workflow["3"].inputs.images).toBeUndefined();
    expect(joined(warnings)).toContain("which only has 1 output(s)");
  });

  it("senders INSIDE a subgraph definition are not silently ignored", () => {
    const g = {
      definitions: {
        subgraphs: [
          {
            id: SG_ID,
            name: "Inner",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            inputs: [],
            outputs: [],
            widgets: [],
            // No extra.ue_links here: the broadcast is unrecoverable and must be said.
            nodes: [
              {
                id: 80,
                type: "Anything Everywhere",
                mode: 0,
                inputs: [{ name: "anything", type: "*", link: null }],
                outputs: [],
                widgets_values: [],
              },
              {
                id: 81,
                type: "SaveImage",
                mode: 0,
                inputs: [{ name: "images", type: "IMAGE", link: null }],
                outputs: [],
                widgets_values: ["out"],
              },
            ],
            links: [],
          },
        ],
      },
      nodes: [
        {
          id: 706,
          type: SG_ID,
          mode: 0,
          properties: {},
          inputs: [],
          outputs: [],
          widgets_values: [],
        },
      ],
      links: [],
    } as never;
    const { warnings } = convertUiToApi(g, OBJECT_INFO);
    expect(joined(warnings)).toContain('subgraph "Inner"');
    expect(joined(warnings)).toContain("CANNOT be recovered");
  });

  it("an UNUSED subgraph definition's broken wiring is not reported as this graph's loss", () => {
    const g = {
      definitions: {
        subgraphs: [
          {
            id: "never-instantiated",
            name: "Dead",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            inputs: [],
            outputs: [],
            widgets: [],
            nodes: [
              {
                id: 90,
                type: "GetNode",
                mode: 0,
                inputs: [],
                outputs: [{ name: "IMAGE", type: "IMAGE", links: [90] }],
                widgets_values: ["orphan"],
              },
              {
                id: 91,
                type: "SaveImage",
                mode: 0,
                inputs: [{ name: "images", type: "IMAGE", link: 90 }],
                outputs: [],
                widgets_values: ["out"],
              },
            ],
            links: [
              { id: 90, origin_id: 90, origin_slot: 0, target_id: 91, target_slot: 0, type: "IMAGE" },
            ],
          },
        ],
      },
      nodes: [
        {
          id: 1,
          type: "LoadImage",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
          widgets_values: ["a.png"],
        },
      ],
      links: [],
    } as never;
    const { warnings } = convertUiToApi(g, OBJECT_INFO);
    expect(warnings).toEqual([]);
  });
});

// ── 3. Promoted ("proxy") subgraph widget values ────────────────────────────

const SG_ID = "sg-uuid";

/**
 * One subgraph instance (706) wrapping EmptyLatentImage(50).
 *  - `proxy` is the properties.proxyWidgets list,
 *  - `values` is the instance's widgets_values (parallel to proxy),
 *  - `linkWidth` wires a real producer into the instance's `width` slot.
 */
function subgraphGraph(opts: {
  proxy: [string, string][];
  values: unknown[];
  captured?: Record<string, unknown>;
  innerInputs?: unknown[];
  linkWidth?: boolean;
}) {
  const innerInputs = opts.innerInputs ?? [
    { name: "width", type: "INT", widget: { name: "width" }, link: 101 },
  ];
  return {
    definitions: {
      subgraphs: [
        {
          id: SG_ID,
          name: "Latent",
          inputNode: { id: -10 },
          outputNode: { id: -20 },
          inputs: [{ id: "i1", name: "width", type: "INT", linkIds: [101] }],
          outputs: [{ id: "o1", name: "LATENT", type: "LATENT", linkIds: [102] }],
          widgets: [],
          nodes: [
            {
              id: 50,
              type: "EmptyLatentImage",
              mode: 0,
              inputs: innerInputs,
              outputs: [{ name: "LATENT", type: "LATENT", links: [102] }],
              widgets_values: [512, 512, 1],
            },
          ],
          links: [
            { id: 101, origin_id: -10, origin_slot: 0, target_id: 50, target_slot: 0, type: "INT" },
            { id: 102, origin_id: 50, origin_slot: 0, target_id: -20, target_slot: 0, type: "LATENT" },
          ],
        },
      ],
    },
    nodes: [
      ...(opts.linkWidth
        ? [
            {
              id: 60,
              type: "PrimitiveInt",
              mode: 0,
              inputs: [],
              outputs: [{ name: "INT", type: "INT", links: [200] }],
              widgets_values: [64],
            },
          ]
        : []),
      {
        id: 706,
        type: SG_ID,
        mode: 0,
        properties: { proxyWidgets: opts.proxy },
        inputs: [
          {
            name: "width",
            type: "INT",
            widget: { name: "width" },
            link: opts.linkWidth ? 200 : null,
          },
        ],
        outputs: [{ name: "LATENT", type: "LATENT", links: [] }],
        widgets_values: opts.values,
        ...(opts.captured ? { capturedWidgetValues: opts.captured } : {}),
      },
    ],
    links: opts.linkWidth ? [[200, 60, 0, 706, 0, "INT"]] : [],
  } as never;
}

/** The single expanded inner node (its id is remapped during expansion). */
const onlyInner = (workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>) =>
  Object.values(workflow).find((n) => n.class_type === "EmptyLatentImage" && "batch_size" in n.inputs)!;

describe("#361 — promoted subgraph widget values", () => {
  it("a subgraph-input promotion (proxy id '-1') reaches the inner node instead of its stale stored value", () => {
    const { workflow, warnings } = convertUiToApi(
      subgraphGraph({ proxy: [["-1", "width"]], values: [1920] }),
      OBJECT_INFO,
    );
    // Before the fix this was 512 — the inner node's stored value — with NO warning.
    expect(onlyInner(workflow as never).inputs.width).toBe(1920);
    expect(warnings).toEqual([]);
  });

  it("a REAL incoming link on the promoted slot still wins over the promoted widget value", () => {
    const { workflow } = convertUiToApi(
      subgraphGraph({ proxy: [["-1", "width"]], values: [1920], linkWidth: true }),
      OBJECT_INFO,
    );
    expect(onlyInner(workflow as never).inputs.width).toEqual(["60", 0]);
  });

  it("an inner-node promotion applies BY NAME even when the widget is absent from inputs[]", () => {
    // `height` has no inputs[] entry at all: the old index-counting resolver
    // returned null here and dropped the value outright.
    const { workflow, warnings } = convertUiToApi(
      subgraphGraph({ proxy: [["50", "height"]], values: [1088] }),
      OBJECT_INFO,
    );
    expect(onlyInner(workflow as never).inputs.height).toBe(1088);
    expect(warnings).toEqual([]);
  });

  it("an inner-node promotion lands on the NAMED widget, not on a mis-counted position", () => {
    // `width` occupies an inputs[] slot but carries no `widget` marker, so the old
    // index-counting resolver made `batch_size` the FIRST widget-input (index 0)
    // and wrote the promoted 4 over widgets_values[0] — which is `width`.
    const { workflow } = convertUiToApi(
      subgraphGraph({
        proxy: [["50", "batch_size"]],
        values: [4],
        innerInputs: [
          { name: "width", type: "INT", link: 101 },
          { name: "batch_size", type: "INT", widget: { name: "batch_size" }, link: null },
        ],
      }),
      OBJECT_INFO,
    );
    const inner = onlyInner(workflow as never);
    expect(inner.inputs.batch_size).toBe(4);
    expect(inner.inputs.width).toBe(512); // NOT clobbered by the promotion
  });

  it("a promoted widget the server's node definition does not declare is reported, not dropped in silence", () => {
    const { warnings } = convertUiToApi(
      subgraphGraph({ proxy: [["50", "not_a_widget"]], values: [7] }),
      OBJECT_INFO,
    );
    expect(joined(warnings)).toContain('"not_a_widget"');
    expect(joined(warnings)).toContain("could not be applied");
  });

  it("a live capturedWidgetValues map wins over stale positional widgets_values (#2522)", () => {
    // graph_get_state stores the user's current name-keyed values on
    // capturedWidgetValues and leaves widgets_values as the serialized snapshot.
    // The expander used to read only the array, so a live 1920 became the inner
    // node's stale 512 with no warning.
    const { workflow, warnings } = convertUiToApi(
      subgraphGraph({
        proxy: [["-1", "width"]],
        values: [512],
        captured: { width: 1920 },
      }),
      OBJECT_INFO,
    );
    expect(onlyInner(workflow as never).inputs.width).toBe(1920);
    expect(warnings).toEqual([]);
  });

  it("a NAME-KEYED widgets_values on the subgraph node is read by promoted-widget name", () => {
    const g = subgraphGraph({ proxy: [["-1", "width"]], values: [] }) as unknown as {
      nodes: { id: number; widgets_values: unknown }[];
    };
    g.nodes.find((n) => n.id === 706)!.widgets_values = { width: 1920 };
    const { workflow, warnings } = convertUiToApi(g as never, OBJECT_INFO);
    expect(onlyInner(workflow as never).inputs.width).toBe(1920);
    expect(warnings).toEqual([]);
  });

  it("a name-keyed capture with two promotions of the SAME name refuses both and says why", () => {
    const g = subgraphGraph({
      proxy: [["-1", "width"], ["50", "width"]],
      values: [],
    }) as unknown as { nodes: { id: number; widgets_values: unknown }[] };
    g.nodes.find((n) => n.id === 706)!.widgets_values = { width: 1920 };
    const { workflow, warnings } = convertUiToApi(g as never, OBJECT_INFO);
    expect(onlyInner(workflow as never).inputs.width).toBe(512); // inner's own value
    expect(joined(warnings)).toContain("more than one promotion claims that name");
  });

  it("a NESTED instance's name-keyed values survive an outer promotion into it", () => {
    // Outer(700) wraps Inner(60), which wraps EmptyLatentImage(50). Inner carries
    // its OWN name-keyed { height: 1088 }; Outer promotes Inner's `width` = 1920.
    // Overwriting Inner's map with a positional array would drop `height`, and
    // Inner's own expansion pass would then leave it at the stale 512 — silently.
    const OUTER = "sg-outer";
    const INNER = "sg-inner";
    const g = {
      definitions: {
        subgraphs: [
          {
            id: INNER,
            name: "Inner",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            inputs: [],
            outputs: [{ id: "o1", name: "LATENT", type: "LATENT", linkIds: [] }],
            widgets: [],
            nodes: [
              {
                id: 50,
                type: "EmptyLatentImage",
                mode: 0,
                inputs: [],
                outputs: [{ name: "LATENT", type: "LATENT", links: [] }],
                widgets_values: [512, 512, 1],
              },
            ],
            links: [],
          },
          {
            id: OUTER,
            name: "Outer",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            inputs: [],
            outputs: [{ id: "o1", name: "LATENT", type: "LATENT", linkIds: [] }],
            widgets: [],
            nodes: [
              {
                id: 60,
                type: INNER,
                mode: 0,
                properties: { proxyWidgets: [["50", "width"], ["50", "height"]] },
                inputs: [],
                outputs: [{ name: "LATENT", type: "LATENT", links: [] }],
                widgets_values: { height: 1088 },
              },
            ],
            links: [],
          },
        ],
      },
      nodes: [
        {
          id: 700,
          type: OUTER,
          mode: 0,
          properties: { proxyWidgets: [["60", "width"]] },
          inputs: [],
          outputs: [],
          widgets_values: [1920],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(g, OBJECT_INFO);
    const inner = onlyInner(workflow as never);
    expect(inner.inputs.width).toBe(1920); // outer promotion
    expect(inner.inputs.height).toBe(1088); // nested instance's own value, kept
    expect(warnings).toEqual([]);
  });

  it("a promoted widget with NO serialized value keeps the inner node's own value, silently", () => {
    // Not a loss: the subgraph node's widget is a proxy VIEW of the inner widget,
    // so no serialized override means the inner value is what was displayed.
    // Warning here would fire on nearly every subgraph workflow and bury the
    // genuine losses.
    const { workflow, warnings } = convertUiToApi(
      subgraphGraph({ proxy: [["-1", "width"], ["50", "height"]], values: [1920] }),
      OBJECT_INFO,
    );
    const inner = onlyInner(workflow as never);
    expect(inner.inputs.width).toBe(1920); // promoted
    expect(inner.inputs.height).toBe(512); // no override → inner's own value
    expect(warnings).toEqual([]);
  });

  it("a promoted value goes through the same combo validation as any other widget", () => {
    // A promoted asset value the server does not have must be PRESERVED + warned
    // (#407/#504), never silently swapped for the first installed option.
    const g = {
      definitions: {
        subgraphs: [
          {
            id: SG_ID,
            name: "Loader",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            inputs: [],
            outputs: [{ id: "o1", name: "MODEL", type: "MODEL", linkIds: [] }],
            widgets: [],
            nodes: [
              {
                id: 51,
                type: "CheckpointLoaderSimple",
                mode: 0,
                inputs: [],
                outputs: [{ name: "MODEL", type: "MODEL", links: [] }],
                widgets_values: ["installed.safetensors"],
              },
            ],
            links: [],
          },
        ],
      },
      nodes: [
        {
          id: 707,
          type: SG_ID,
          mode: 0,
          properties: { proxyWidgets: [["51", "ckpt_name"]] },
          inputs: [],
          outputs: [],
          widgets_values: ["not_installed.safetensors"],
        },
      ],
      links: [],
    } as never;
    const { workflow, warnings } = convertUiToApi(g, OBJECT_INFO);
    const loader = Object.values(workflow).find((n) => n.class_type === "CheckpointLoaderSimple")!;
    expect(loader.inputs.ckpt_name).toBe("not_installed.safetensors");
    expect(joined(warnings)).toContain("not installed on the connected server");
  });
});

// ── 3b. Virtual wiring across a subgraph boundary (codex gate) ──────────────

describe("#361 — a subgraph output routed through a Set/Get bus", () => {
  it("survives expansion instead of being pruned as an anonymous dangling reference", () => {
    // Component(706) → SetNode(4) "img" → GetNode(5) → SaveImage(3). Rewriting
    // the link tuple alone was not enough: the expander rewires consumers from
    // the component's own outputs[].links, so the re-homed edge has to land there
    // too or the component expands away and the consumer's input vanishes.
    const g = {
      definitions: {
        subgraphs: [
          {
            id: SG_ID,
            name: "Src",
            inputNode: { id: -10 },
            outputNode: { id: -20 },
            inputs: [],
            outputs: [{ id: "o1", name: "IMAGE", type: "IMAGE", linkIds: [102] }],
            widgets: [],
            nodes: [
              {
                id: 50,
                type: "LoadImage",
                mode: 0,
                inputs: [],
                outputs: [{ name: "IMAGE", type: "IMAGE", links: [102] }],
                widgets_values: ["a.png"],
              },
            ],
            links: [
              { id: 102, origin_id: 50, origin_slot: 0, target_id: -20, target_slot: 0, type: "IMAGE" },
            ],
          },
        ],
      },
      nodes: [
        {
          id: 706,
          type: SG_ID,
          mode: 0,
          properties: {},
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [11] }],
          widgets_values: [],
        },
        {
          id: 4,
          type: "SetNode",
          mode: 0,
          inputs: [{ name: "value", type: "IMAGE", link: 11 }],
          outputs: [],
          widgets_values: ["img"],
        },
        {
          id: 5,
          type: "GetNode",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [10] }],
          widgets_values: ["img"],
        },
        {
          id: 3,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: 10 }],
          outputs: [],
          widgets_values: ["out"],
        },
      ],
      links: [
        [11, 706, 0, 4, 0, "IMAGE"],
        [10, 5, 0, 3, 0, "IMAGE"],
      ],
    } as never;
    const { workflow, warnings } = convertUiToApi(g, OBJECT_INFO);
    const inner = Object.entries(workflow).find(([, n]) => n.class_type === "LoadImage")!;
    expect(workflow["3"].inputs.images).toEqual([inner[0], 0]);
    expect(warnings).toEqual([]);
  });

  it("a subgraph input claiming a link that does not exist is reported, not silently cleared", () => {
    const g = subgraphGraph({
      proxy: [],
      values: [],
      linkWidth: true,
    }) as unknown as { links: unknown[] };
    g.links = []; // component input still claims link 200, which is now absent
    const { workflow, warnings } = convertUiToApi(g as never, OBJECT_INFO);
    expect(onlyInner(workflow as never).inputs.width).toBe(512); // fell back
    expect(joined(warnings)).toContain('input "width" claims link 200');
    expect(joined(warnings)).toContain("falls back to its own stored value");
  });

  it("a connection dropped because its producer left the graph names the node and input", () => {
    // A consumer wired to a node that is not in the prompt used to be reported
    // only as a bare "pruned N dangling reference(s)" count.
    const g = {
      nodes: [
        {
          id: 3,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: 10 }],
          outputs: [],
          widgets_values: ["out"],
        },
      ],
      links: [[10, 42, 0, 3, 0, "IMAGE"]],
    } as never;
    const { warnings } = convertUiToApi(g, OBJECT_INFO);
    expect(joined(warnings)).toContain("Node 3 (SaveImage)");
    expect(joined(warnings)).toContain('input "images"');
    expect(joined(warnings)).toContain("pointed at node 42");
  });
});

// ── 4. Other unresolvable connections ───────────────────────────────────────

describe("#361 — unresolved ordinary links", () => {
  it("an input wired to a link id that does not exist is reported", () => {
    const g = {
      nodes: [
        {
          id: 3,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: 77 }],
          outputs: [],
          widgets_values: ["out"],
        },
        {
          id: 1,
          type: "LoadImage",
          mode: 0,
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [] }],
          widgets_values: ["a.png"],
        },
      ],
      links: [],
    } as never;
    const { warnings } = convertUiToApi(g, OBJECT_INFO);
    expect(joined(warnings)).toContain("dangling reference");
    expect(joined(warnings)).toContain('input "images"');
  });

  it("mute/bypass drops are summarized once rather than reported per edge", () => {
    const g = {
      nodes: [
        {
          id: 1,
          type: "LoadImage",
          mode: 2, // muted
          inputs: [],
          outputs: [{ name: "IMAGE", type: "IMAGE", links: [1, 2] }],
          widgets_values: ["a.png"],
        },
        {
          id: 3,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: 1 }],
          outputs: [],
          widgets_values: ["out"],
        },
        {
          id: 4,
          type: "SaveImage",
          mode: 0,
          inputs: [{ name: "images", type: "IMAGE", link: 2 }],
          outputs: [],
          widgets_values: ["out2"],
        },
      ],
      links: [
        [1, 1, 0, 3, 0, "IMAGE"],
        [2, 1, 0, 4, 0, "IMAGE"],
      ],
    } as never;
    const { warnings } = convertUiToApi(g, OBJECT_INFO);
    const toggleWarnings = warnings.filter((w) => w.includes("muted, or bypassed"));
    expect(toggleWarnings).toHaveLength(1);
    expect(toggleWarnings[0]).toContain("2 input connection(s)");
  });
});
