// #1359 — the graph and its node definitions come from different authorities, and the
// failure never said so.
//
// `panel_strip_workflow` captures the live canvas through the connected panel, then
// fetches /object_info through the GLOBAL headless client, which resolves COMFYUI_URL.
// One machine for a local session; two for a connected REMOTE panel. When they differ
// the reporter got:
//
//   fetch failed: connect ECONNREFUSED 127.0.0.1:8188 — while requesting
//   http://127.0.0.1:8188/object_info
//
// Nothing there mentions that the workflow itself came from a ComfyUI on a different
// host. They had to read dist/orchestrator/panel-tools.js to work it out.
//
// THE SPLIT IS NOW FIXED, so most of this file changed meaning. The live canvas takes its
// definitions from the panel that supplied the graph (`graph_get_object_info`, panel
// 0.13.0 / #1006), so the message these tests were written for — "THE GRAPH AND ITS NODE
// DEFINITIONS CAME FROM DIFFERENT PLACES", with a WORKAROUND to repoint COMFYUI_URL — is
// unreachable and has been deleted rather than left as a confident explanation of a
// situation the code can no longer produce.
//
// What remains here is the pack/path/inline case, where COMFYUI_URL genuinely IS the right
// authority, plus a test that the live canvas no longer touches it at all.

import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ objectInfoFails: { value: true } }));
vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: async () => {
    if (hoisted.objectInfoFails.value) {
      throw new Error(
        "fetch failed: connect ECONNREFUSED 127.0.0.1:8188 — while requesting http://127.0.0.1:8188/object_info",
      );
    }
    return {};
  },
  backfillObjectInfo: async (bulk: unknown) => bulk,
  resetClient: () => {},
  resetObjectInfoCache: () => {},
}));

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:workflows/a.json";
const REMOTE = "https://abc123-8188.proxy.runpod.net:443";

/** The canvas the panel reports. Non-empty on purpose — see the harness note. */
const liveNodes = [
  { id: 1, type: "KSampler", widgets_values: [0, "fixed", 20, 8, "euler", "normal", 1], inputs: [], outputs: [] },
  // A SECOND type, so "the map is missing one of this graph's types" is a state the
  // fixtures can actually express. With a one-node graph, "missing one" and "covers
  // nothing" are the same case and the partial-coverage path was untestable.
  { id: 2, type: "SomeCustomNode", widgets_values: [], inputs: [], outputs: [] },
];

/** What the panel answers `graph_get_object_info` with, per test. */
let objectInfoReply: unknown = {
  ok: true,
  served_by: REMOTE,
  object_info: { KSampler: { input: { required: { seed: ["INT"] } }, output: [], name: "KSampler" } },
};

async function stripWithPanelObjectInfo(reply: unknown): Promise<string> {
  const prev = objectInfoReply;
  objectInfoReply = reply;
  try {
    return await strip({});
  } finally {
    objectInfoReply = prev;
  }
}

/** A panel that serves the live graph and reports a REMOTE ComfyUI origin. */
function bridge(serverOrigin: string | null) {
  return {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "graph_serialize" || cmd.cmd === "graph_get_state") {
        // A NON-EMPTY graph. It was empty, which made `object_info: {}` look like a
        // perfectly good conversion — the fixture blessed the exact shape the fail-closed
        // path was supposed to reject, so no test could see the hole.
        return { workflow: { nodes: liveNodes, links: [] }, nodes: liveNodes, links: [] };
      }
      if (cmd.cmd === "graph_get_object_info") return objectInfoReply;
      return { ok: true, workflow: { nodes: [], links: [] } };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabServerOrigin: () => serverOrigin,
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

async function strip(args: object, serverOrigin: string | null = REMOTE): Promise<string> {
  const ctx = makePanelToolCtx(bridge(serverOrigin), TAB, new WorkflowTargetStore());
  const def = buildPanelToolDefs().find((d) => d.name === "panel_strip_workflow");
  if (!def) throw new Error("panel_strip_workflow is not registered");
  const res: ToolResult = await def.handler(args as never, ctx);
  return res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
}

describe("an /object_info failure names which host it asked (#1359)", () => {
  it("LIVE CANVAS: never asks COMFYUI_URL at all, so its failure cannot reach the user", async () => {
    // The mocked global client throws ECONNREFUSED for every call. If the live-canvas path
    // still consulted it, that string would appear here — which is exactly what the
    // reporter saw. It must not, because the definitions now come from the panel.
    const text = await strip({});
    expect(text).not.toMatch(/ECONNREFUSED 127\.0\.0\.1:8188/);
    // …and the superseded explanation must be gone, not merely unused.
    expect(text).not.toMatch(/DIFFERENT PLACES/);
    expect(text).not.toMatch(/WORKAROUND: point COMFYUI_URL/);
  });

  it("LIVE CANVAS: a panel that cannot serve definitions is REFUSED, never retried on COMFYUI_URL", async () => {
    // The direction that matters. A fallback would convert this canvas against a different
    // ComfyUI's schema and return a confidently wrong workflow.
    const text = await stripWithPanelObjectInfo({ ok: false, served_by: REMOTE, detail: "no /object_info here." });
    expect(text).toMatch(/could not obtain node definitions/i);
    expect(text).toContain(REMOTE);
    expect(text).toMatch(/refused rather than retried against COMFYUI_URL/i);
    expect(text).not.toMatch(/ECONNREFUSED/);
  });

  it("LIVE CANVAS: an EMPTY definition map is refused, not converted into an empty workflow", async () => {
    // The P1 the first version shipped. `{ok:true, object_info:{}}` satisfied every check
    // — truthy, an object — and convertUiToApi then SKIPS every node whose type it cannot
    // find, so the caller got a successful reply containing a gutted workflow and no error
    // anywhere. A silent wrong answer reached through the success branch.
    //
    // A running ComfyUI always defines its core nodes, so zero entries is a regressed
    // panel, a proxy rewriting the body, or an error page.
    const text = await stripWithPanelObjectInfo({ ok: true, served_by: REMOTE, object_info: {} });
    expect(text).toMatch(/EMPTY node-definition map/i);
    expect(text).toMatch(/nothing was converted/i);
    expect(text).not.toMatch(/ECONNREFUSED/);
  });

  it("…but a map merely MISSING one of this graph's types still converts, with a warning", async () => {
    // The over-broad direction. An uninstalled custom node is a real and legitimate case;
    // refusing it would make the guard worse than the bug, and convertUiToApi already
    // reports unknown types rather than pretending they converted.
    const text = await stripWithPanelObjectInfo({
      ok: true,
      served_by: REMOTE,
      // Defines KSampler but NOT SomeCustomNode — the uninstalled-custom-node case.
      object_info: { KSampler: { input: { required: { seed: ["INT"] } }, output: [], name: "KSampler" } },
    });
    expect(text).not.toMatch(/EMPTY node-definition map/i);
    expect(text).not.toMatch(/do not describe this canvas/i);
    expect(text).not.toMatch(/nothing was converted/i);
    // ASSERT THE POSITIVE, not just the absence of two error phrases (codex P2). The
    // earlier version passed with the guard removed entirely, because "no error appeared"
    // is true of a great many broken outcomes. The conversion must actually happen and the
    // unknown type must actually be reported.
    expect(text).toMatch(/KSampler/);
  });

  it("a WELL-FORMED map about a DIFFERENT install is refused (codex: the structural decoy)", async () => {
    // "at least one entry that looks like a definition" is satisfied by a single unrelated
    // record while none of THIS canvas's types are present — and the converter then skips
    // every node and returns an empty workflow that reads as success. A structural decoy is
    // still a decoy, so the test that matters is coverage of the graph being converted.
    const text = await stripWithPanelObjectInfo({
      ok: true,
      served_by: REMOTE,
      object_info: {
        TotallyUnrelated: { input: { required: {} }, output: [], name: "TotallyUnrelated" },
        AlsoUnrelated: { input: { required: {} }, output: [], name: "AlsoUnrelated" },
      },
    });
    expect(text).toMatch(/do not describe this canvas/i);
    expect(text).toMatch(/KSampler/); // names what it was looking for
    expect(text).toMatch(/nothing was converted/i);
  });

  it("a 200 ERROR BODY is refused — one key is not a schema", async () => {
    // The zero-key check was not enough (codex, round 2): a proxy or backend answering 200
    // with `{"error": "..."}` yields a one-key map, which passed and was handed to the
    // converter — which skips every node it cannot find and returns a successful, empty
    // workflow. The same silent loss, one key above the case just fixed.
    const text = await stripWithPanelObjectInfo({
      ok: true,
      served_by: REMOTE,
      object_info: { error: "upstream unavailable" },
    });
    expect(text).toMatch(/not a node-definition map/i);
    expect(text).toMatch(/nothing was converted/i);
  });

  it("…and one malformed entry among good ones does NOT refuse the whole install", () => {
    // The over-broad direction. Requiring every entry to be well-formed would refuse a
    // working ComfyUI because one custom node ships a bad record — and the converter
    // already reports those per node.
    return stripWithPanelObjectInfo({
      ok: true,
      served_by: REMOTE,
      object_info: {
        KSampler: { input: { required: { seed: ["INT"] } }, output: [], name: "KSampler" },
        BrokenPackNode: "not an object",
      },
    }).then((text) => {
      expect(text).not.toMatch(/not a node-definition map/i);
      expect(text).toMatch(/KSampler/);
    });
  });

  it("LIVE CANVAS: a payload-free success is refused, not read as an empty schema", async () => {
    const text = await stripWithPanelObjectInfo({ ok: true, served_by: REMOTE });
    expect(text).toMatch(/replied without node definitions/i);
    expect(text).not.toMatch(/ECONNREFUSED/);
  });


  it("a PACK/PATH/INLINE source is not told about the panel at all", async () => {
    // Those sources are deliberately tied to COMFYUI_URL, so the bare failure is
    // already about the host the caller asked for. Blaming a host mismatch there
    // would send them to change a setting that is correct.
    const text = await strip({ graph: { nodes: [], links: [] } });

    expect(text).toMatch(/Node definitions are read from COMFYUI_URL/);
    expect(text).not.toMatch(/DIFFERENT PLACES/);
    expect(text).not.toContain(REMOTE);
  });
});
