// #1973 — panel_get_errors on a 77-node live workflow exhausted the panel's
// shared server-call budget, left the sampler / decoder / assembler / SaveVideo
// unchecked, and still led with errored_count: 0 plus "no errors recorded".
//
// The panel's live combo scan is a 4 s STEP inside that budget, so the leftover
// execution path is a property of the REPLY, not of a timeout. These tests drive
// the real panel_get_errors def: a stubbed panel returns the reporter's shape,
// and the assertions read the payload the caller actually gets.

import { describe, expect, it } from "vitest";
import { buildPanelToolDefs, type PanelToolCtx } from "../../orchestrator/panel-tools.js";

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

const BUDGET_REASON = "not checked: get_errors ran out of its shared server-call budget";
const CLEAN_NOTE = "no errors recorded since the last execution start";

const EXECUTION_NODES = [
  { id: 51, type: "KSampler", widget: "sampler_name", value: "euler" },
  { id: 62, type: "VAEDecode", widget: "vae", value: "vae.safetensors" },
  { id: 70, type: "VHS_VideoCombine", widget: "format", value: "video/h264-mp4" },
  { id: 71, type: "SaveVideo", widget: "codec", value: "h264" },
  { id: 73, type: "ImpactSwitch", widget: "select", value: "prompt_a" },
] as const;

function budgetExhaustedReply(opts?: { extraUnchecked?: number }): Record<string, unknown> {
  const extra = opts?.extraUnchecked ?? 35;
  const extras = Array.from({ length: extra }, (_, i) => ({
    id: i + 1,
    type: `Loader${i + 1}`,
    reason: BUDGET_REASON,
  }));
  const execution = EXECUTION_NODES.map((n) => ({
    id: n.id,
    type: n.type,
    reason: BUDGET_REASON,
  }));
  const unchecked = [...extras, ...execution];
  return {
    viewing: { kind: "root", workflow: "wan.json" },
    node_count: 37 + extra,
    errored_count: 0,
    nodes: [],
    unchecked_nodes: unchecked,
    unchecked_nodes_note: `NOT CHECKED: ${unchecked.length} node(s) this scan could not judge.`,
    unchecked_budget_exhausted: true,
    last_execution_error: null,
    node_errors: null,
    note: CLEAN_NOTE,
  };
}

function objectInfoFor(nodes: readonly { type: string; widget: string; value: string }[]): Record<string, unknown> {
  const info: Record<string, unknown> = {};
  for (const n of nodes) {
    const prev = (info[n.type] as { input?: { required?: Record<string, unknown> } } | undefined) ?? {
      input: { required: {} },
      output: [],
      name: n.type,
    };
    const required = { ...(prev.input?.required ?? {}) };
    required[n.widget] = [[n.value, "other"], {}];
    info[n.type] = { ...prev, input: { required } };
  }
  return info;
}

function detailText(
  nodes: readonly { id: number; type: string; widget: string; value: string }[],
): string {
  return nodes
    .map((n) => JSON.stringify({ id: n.id, type: n.type, widgets: { [n.widget]: n.value } }))
    .join("\n");
}

async function runGetErrors(
  replies: (cmd: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; cmds: string[]; keys: string[] }> {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_get_errors");
  if (!def) throw new Error("panel_get_errors is not registered");
  const cmds: string[] = [];
  const res = (await def.handler(
    {},
    {
      call: async (cmd: Record<string, unknown>) => {
        cmds.push(String(cmd.cmd));
        return { content: [{ type: "text" as const, text: JSON.stringify(replies(cmd), null, 2) }] };
      },
    } as unknown as PanelToolCtx,
  )) as ToolResult;
  const text = res.content.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") throw new Error("panel_get_errors returned no text");
  const payload = JSON.parse(text) as Record<string, unknown>;
  return { payload, cmds, keys: Object.keys(payload) };
}

describe("panel_get_errors leftover call-budget audit (#1973)", () => {
  it("does not lead with a clean errored_count:0 while the execution path is unchecked", async () => {
    const panel = budgetExhaustedReply();
    const { payload, cmds, keys } = await runGetErrors((cmd) => {
      if (cmd.cmd === "graph_get_errors") return panel;
      // Follow-ups fail closed: the incomplete presentation must still fire.
      return { ok: false };
    });

    expect(cmds[0]).toBe("graph_get_errors");
    expect(payload.audit_complete).toBe(false);
    expect(keys[0]).toBe("audit_complete");
    expect(keys.indexOf("audit_complete")).toBeLessThan(keys.indexOf("errored_count"));
    expect(payload.errored_count).toBe(0);
    expect(payload.unchecked_budget_exhausted).toBe(true);
    expect(payload.unchecked_count).toBe(
      new Set((panel.unchecked_nodes as Array<{ id: unknown }>).map((n) => String(n.id))).size,
    );
    expect(payload.checked_count).toBe(
      (panel.node_count as number) - (payload.unchecked_count as number),
    );
    expect(String(payload.note)).toMatch(/AUDIT INCOMPLETE/i);
    expect(String(payload.note)).not.toMatch(/no errors recorded since the last execution/i);
    expect(String(payload.note)).toMatch(/not a clean bill of health/i);
  });

  it("finishes leftover execution nodes from one batched object_info, not another per-class wait", async () => {
    const panel = budgetExhaustedReply({ extraUnchecked: 0 });
    const leftover = EXECUTION_NODES;
    const { payload, cmds } = await runGetErrors((cmd) => {
      if (cmd.cmd === "graph_get_errors") return panel;
      if (cmd.cmd === "graph_query") {
        expect(cmd.fields).toBe("detail");
        const ids = (cmd.ids as unknown[]).map(String);
        for (const n of leftover) expect(ids).toContain(String(n.id));
        return {
          matched: leftover.length,
          shown: leftover.length,
          text: detailText(leftover),
        };
      }
      if (cmd.cmd === "graph_get_object_info") {
        return { ok: true, object_info: objectInfoFor(leftover) };
      }
      return { ok: false };
    });

    expect(cmds.filter((c) => c === "graph_get_object_info")).toHaveLength(1);
    expect(cmds.filter((c) => c === "graph_query")).toHaveLength(1);
    expect(payload.audit_complete).toBe(true);
    expect(payload.unchecked_budget_exhausted).toBeUndefined();
    const leftoverIds = new Set(leftover.map((n) => String(n.id)));
    const still = Array.isArray(payload.unchecked_nodes) ? payload.unchecked_nodes : [];
    for (const n of still as Array<{ id?: unknown }>) {
      expect(leftoverIds.has(String(n.id)), `${n.id} should have been judged`).toBe(false);
    }
    expect(payload.errored_count).toBe(0);
    expect(payload.unavailable_widget_values).toBeUndefined();
  });

  it("reports a combo miss on an execution node the budget skip had hidden", async () => {
    const panel = budgetExhaustedReply({ extraUnchecked: 0 });
    const save = EXECUTION_NODES.find((n) => n.type === "SaveVideo")!;
    const { payload } = await runGetErrors((cmd) => {
      if (cmd.cmd === "graph_get_errors") return panel;
      if (cmd.cmd === "graph_query") {
        return {
          matched: EXECUTION_NODES.length,
          shown: EXECUTION_NODES.length,
          text: detailText(EXECUTION_NODES),
        };
      }
      if (cmd.cmd === "graph_get_object_info") {
        const info = objectInfoFor(EXECUTION_NODES);
        // The live widget names a codec the server does not offer.
        info.SaveVideo = {
          input: { required: { codec: [["prores", "vp9"], {}] } },
          output: [],
          name: "SaveVideo",
        };
        return { ok: true, object_info: info };
      }
      return { ok: false };
    });

    expect(payload.audit_complete).toBe(true);
    const unavailable = payload.unavailable_widget_values as Array<Record<string, unknown>>;
    expect(Array.isArray(unavailable)).toBe(true);
    const hit = unavailable.find((u) => String(u.id) === String(save.id));
    expect(hit, "the SaveVideo codec miss must surface").toBeTruthy();
    expect(hit?.widget).toBe("codec");
    expect(hit?.value).toBe(save.value);
    expect(String(payload.note ?? "")).not.toMatch(/no errors recorded since the last execution/i);
  });

  it("does not spend follow-up calls when the panel already finished the scan", async () => {
    const { payload, cmds } = await runGetErrors((cmd) => {
      if (cmd.cmd === "graph_get_errors") {
        return {
          node_count: 8,
          errored_count: 0,
          nodes: [],
          last_execution_error: null,
          node_errors: null,
          note: CLEAN_NOTE,
        };
      }
      throw new Error(`unexpected follow-up ${cmd.cmd}`);
    });

    expect(cmds).toEqual(["graph_get_errors"]);
    expect(payload.audit_complete).toBe(true);
    expect(payload.errored_count).toBe(0);
    expect(payload.note).toBe(CLEAN_NOTE);
  });
});

// #1973 follow-up — the first cut of this fix judged completeness from the
// `unchecked_budget_exhausted` FLAG and re-judged combos with a scanner that
// diverged from the panel's. Both directions are pinned here: an abstention the
// flag does not cover must still suppress the clean 0, and this pass must never
// invent a verdict the panel's own scanner would have refused to give.
describe("panel_get_errors completeness parity with the panel's scanner (#1973)", () => {
  // live-combo-availability.js abstains for five reasons; only two raise the
  // budget flag. This is the file-probe cap — no flag, same misread.
  const UNENUM = "not checked: this value names a file below the input root";
  function probeCapReply(): Record<string, unknown> {
    return {
      viewing: { kind: "root", workflow: "wan.json" },
      node_count: 77,
      errored_count: 0,
      nodes: [],
      unchecked_nodes: [
        { id: 51, type: "KSampler", reason: "node type could not be looked up (/object_info call failed)" },
        {
          id: 12, type: "LoadImage", widget: "image", value: "lib/a.png",
          reason: `${UNENUM}, and this call's 24-file server-existence probe cap was reached`,
        },
      ],
      unchecked_nodes_note: "NOT CHECKED: 2 node(s) this scan could not judge.",
      unchecked_asset_probe_limit: 24,
      last_execution_error: null,
      node_errors: null,
      note: CLEAN_NOTE,
    };
  }

  it("treats a non-budget abstention as an incomplete audit, without spending a follow-up", async () => {
    const { payload, keys, cmds } = await runGetErrors((cmd) => {
      if (cmd.cmd === "graph_get_errors") return probeCapReply();
      throw new Error(`unexpected follow-up ${cmd.cmd}`);
    });

    // Nothing here is retryable, so the pass must not buy a second round trip.
    expect(cmds).toEqual(["graph_get_errors"]);
    expect(payload.audit_complete).toBe(false);
    expect(keys[0]).toBe("audit_complete");
    expect(payload.unchecked_count).toBe(2);
    expect(payload.checked_count).toBe(75);
    expect(String(payload.note)).toMatch(/AUDIT INCOMPLETE/i);
    expect(String(payload.note)).not.toMatch(/no errors recorded/i);
  });

  // ComfyUI serialises a V3 node's combo as ["COMBO", {…}] (add_to_dict_v1 writes
  // (io_type, as_dict)), and UploadType.model becomes `file_upload`
  // (comfy_api/latest/_io.py:44). A freshly uploaded root-level filename is not
  // guaranteed to be in the /object_info list; an [output]-annotated value also
  // resolves through get_annotated_filepath against a DIFFERENT root. Calling
  // either a missing asset is the exact "looked it up and it is not there"
  // collapse the panel refuses to make.
  it("does not manufacture a missing_asset on an upload input it has no probe for", async () => {
    const panel = {
      ...budgetExhaustedReply({ extraUnchecked: 0 }),
      unchecked_nodes: [{ id: 9, type: "Load3D", reason: BUDGET_REASON }],
    };
    const { payload } = await runGetErrors((cmd) => {
      if (cmd.cmd === "graph_get_errors") return panel;
      if (cmd.cmd === "graph_query") {
        return {
          matched: 1, shown: 1,
          text: JSON.stringify({ id: 9, type: "Load3D", widgets: { model_file: "hero.glb" } }),
        };
      }
      if (cmd.cmd === "graph_get_object_info") {
        return {
          ok: true,
          object_info: {
            Load3D: {
              input: {
                required: {
                  model_file: ["COMBO", { options: ["none", "3d/cube.glb"], file_upload: true }],
                },
              },
            },
          },
        };
      }
      return { ok: false };
    });

    const unavailable = (payload.unavailable_widget_values ?? []) as Array<Record<string, unknown>>;
    expect(
      unavailable.find((u) => String(u.id) === "9"),
      "an unenumerable upload value must not be reported as a missing asset",
    ).toBeUndefined();
    const still = (payload.unchecked_nodes ?? []) as Array<Record<string, unknown>>;
    expect(still.find((u) => String(u.id) === "9")).toBeTruthy();
    expect(payload.audit_complete).toBe(false);
  });

  // The panel's clean note ships through tr(); it is translated in all twelve
  // bundled locales. A predicate that matches its ENGLISH prose passes this file
  // and dies in production for eleven of them (#399/#984 self-contradiction).
  it("drops a TRANSLATED clean note when the completion pass found a real miss", async () => {
    const panel = {
      ...budgetExhaustedReply({ extraUnchecked: 0 }),
      unchecked_nodes: [{ id: 71, type: "SaveVideo", reason: BUDGET_REASON }],
      note: "前回の実行開始以降、エラーは記録されていません",
    };
    const { payload } = await runGetErrors((cmd) => {
      if (cmd.cmd === "graph_get_errors") return panel;
      if (cmd.cmd === "graph_query") {
        return {
          matched: 1, shown: 1,
          text: JSON.stringify({ id: 71, type: "SaveVideo", widgets: { codec: "h264" } }),
        };
      }
      if (cmd.cmd === "graph_get_object_info") {
        return { ok: true, object_info: { SaveVideo: { input: { required: { codec: [["prores", "vp9"], {}] } } } } };
      }
      return { ok: false };
    });

    expect(payload.audit_complete).toBe(true);
    expect((payload.unavailable_widget_values as unknown[]).length).toBe(1);
    expect(
      payload.note,
      "a localized clean note must not ship beside a populated unavailable list",
    ).toBeUndefined();
  });

  it("refreshes the unavailable-count note when the pass appends to the list", async () => {
    const panel = {
      ...budgetExhaustedReply({ extraUnchecked: 0 }),
      unchecked_nodes: [{ id: 71, type: "SaveVideo", reason: BUDGET_REASON }],
      unavailable_widget_values: [
        { id: 4, type: "CheckpointLoaderSimple", widget: "ckpt_name", value: "gone.safetensors", kind: "missing_asset" },
      ],
      unavailable_widget_values_note: "LIVE SCAN: 1 widget value(s) naming a file the server does not have.",
    };
    const { payload } = await runGetErrors((cmd) => {
      if (cmd.cmd === "graph_get_errors") return panel;
      if (cmd.cmd === "graph_query") {
        return {
          matched: 1, shown: 1,
          text: JSON.stringify({ id: 71, type: "SaveVideo", widgets: { codec: "h264" } }),
        };
      }
      if (cmd.cmd === "graph_get_object_info") {
        return { ok: true, object_info: { SaveVideo: { input: { required: { codec: [["prores", "vp9"], {}] } } } } };
      }
      return { ok: false };
    });

    expect((payload.unavailable_widget_values as unknown[]).length).toBe(2);
    const note = String(payload.unavailable_widget_values_note);
    expect(note, "the note must not still claim 1 while the list holds 2").toContain("2 widget value(s)");
    expect(note.startsWith("LIVE SCAN: 1 widget")).toBe(false);
  });

  // A MultiCombo (io_type "COMBO", multiselect: true) stores a SELECTION, so
  // membership in the option list is the wrong question — asking it reports
  // every such widget as invalid.
  it("does not judge a multiselect combo against single-value membership", async () => {
    const panel = {
      ...budgetExhaustedReply({ extraUnchecked: 0 }),
      unchecked_nodes: [{ id: 30, type: "MultiPicker", reason: BUDGET_REASON }],
    };
    const { payload } = await runGetErrors((cmd) => {
      if (cmd.cmd === "graph_get_errors") return panel;
      if (cmd.cmd === "graph_query") {
        return {
          matched: 1, shown: 1,
          text: JSON.stringify({ id: 30, type: "MultiPicker", widgets: { picks: "a,b" } }),
        };
      }
      if (cmd.cmd === "graph_get_object_info") {
        return {
          ok: true,
          object_info: {
            MultiPicker: { input: { required: { picks: ["COMBO", { options: ["a", "b"], multiselect: true }] } } },
          },
        };
      }
      return { ok: false };
    });

    expect(payload.unavailable_widget_values).toBeUndefined();
    expect(payload.audit_complete).toBe(true);
  });
});

// #1973 — `payloadHasDefects()` decides when the panel's own "no errors recorded"
// note may survive a completed audit. It is a HAND-LISTED enumeration, which makes
// it the weakest link in this change: if the panel grows a defect surface and this
// list does not, the note starts contradicting the payload again — the #399/#984
// bug, re-introduced by omission rather than by logic.
//
// So pin the CORRESPONDENCE instead of trusting the list. Every entry below is one
// term of the panel's own `clean` predicate in graph_get_errors:
//
//   const clean = !nodeErrors && !execFailure && !erroredNodes.length &&
//     !missingModels.length && !missingMedia.length && !missingNodeTypes.length &&
//     !missingNodeCount && !stalePlaceholders.length && !liveScan?.unavailable?.length;
//
// If someone adds a tenth term there, this table is where the omission shows up.
describe("the clean note may survive only where the PANEL would have called it clean (#1973)", () => {
  const PANEL_CLEAN_TERMS: Array<{ term: string; field: Record<string, unknown> }> = [
    { term: "nodeErrors", field: { node_errors: { "12": { errors: [{ message: "bad" }] } } } },
    { term: "execFailure", field: { last_execution_error: { node_id: 12, exception_type: "RuntimeError" } } },
    { term: "erroredNodes.length", field: { errored_count: 3 } },
    { term: "missingModels.length", field: { missing_models: [{ name: "sd_xl.safetensors" }] } },
    { term: "missingMedia.length", field: { missing_media: [{ name: "clip.png" }] } },
    { term: "missingNodeTypes.length", field: { missing_node_types: ["SomeMissingPack"] } },
    { term: "missingNodeCount", field: { missing_node_count: 2 } },
    { term: "stalePlaceholders.length", field: { stale_placeholders: [{ id: 7 }] } },
    { term: "liveScan.unavailable", field: { unavailable_widget_values: [{ id: 4, widget: "ckpt_name", value: "gone" }] } },
  ];

  // A payload whose ONLY abstention is retryable, so the completion pass retires it
  // and the audit finishes — the one path where the panel's note can be re-emitted.
  const completable = (extra: Record<string, unknown>) => ({
    viewing: { kind: "root" },
    node_count: 12,
    errored_count: 0,
    nodes: [],
    unchecked_nodes: [{ id: 71, type: "SaveVideo", reason: BUDGET_REASON }],
    unchecked_budget_exhausted: true,
    last_execution_error: null,
    node_errors: null,
    note: CLEAN_NOTE,
    ...extra,
  });

  const runCompleted = (extra: Record<string, unknown>) =>
    runGetErrors((cmd) => {
      if (cmd.cmd === "graph_get_errors") return completable(extra);
      if (cmd.cmd === "graph_query") {
        return {
          matched: 1, shown: 1,
          // A value the server DOES offer, so the pass retires the node cleanly and
          // adds no findings of its own — isolating the field under test.
          text: JSON.stringify({ id: 71, type: "SaveVideo", widgets: { codec: "h264" } }),
        };
      }
      if (cmd.cmd === "graph_get_object_info") {
        return { ok: true, object_info: { SaveVideo: { input: { required: { codec: [["h264", "prores"], {}] } } } } };
      }
      return { ok: false };
    });

  it("re-emits the note when the completed audit really is clean (the control)", async () => {
    const { payload } = await runCompleted({});
    expect(payload.audit_complete, "this control is worthless unless the audit completed").toBe(true);
    expect(payload.note).toBe(CLEAN_NOTE);
  });

  for (const { term, field } of PANEL_CLEAN_TERMS) {
    it(`drops the note when the payload carries ${term}`, async () => {
      const { payload } = await runCompleted(field);
      expect(payload.audit_complete, "must reach the completed path to test the note").toBe(true);
      expect(
        payload.note,
        `the panel's clean note must not ship beside ${term}`,
      ).toBeUndefined();
    });
  }
});

// #1973 — the completion follow-ups are ELECTIVE and run with the panel's reply
// already in hand, so they must NOT get the same 30 s budget as the primary read.
// Handing them the ack timeout makes the handler's worst case 30 s + 30 s and puts
// a reply we already hold behind an optional improvement — which is #589 (an agent
// left with NO error surface) re-introduced from the orchestrator side, on the one
// tool a user staring at red nodes has nothing else to fall back on.
//
// This asserts the CALL SITE, not the helper: `completeGetErrorsAudit` takes the
// budget as a parameter, so a helper-level test passes just as happily when the
// wiring hands it the wrong constant. That is the one thing worth pinning here.
describe("get_errors completion follow-ups run on the elective budget (#1973/#589)", () => {
  async function budgetsFor(): Promise<Map<string, number | undefined>> {
    const def = buildPanelToolDefs().find((d) => d.name === "panel_get_errors");
    if (!def) throw new Error("panel_get_errors is not registered");
    const seen = new Map<string, number | undefined>();
    await def.handler(
      {},
      {
        call: async (cmd: Record<string, unknown>, timeoutMs?: number) => {
          seen.set(String(cmd.cmd), timeoutMs);
          const body =
            cmd.cmd === "graph_get_errors"
              ? budgetExhaustedReply({ extraUnchecked: 0 })
              : { ok: false };
          return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
        },
      } as unknown as PanelToolCtx,
    );
    return seen;
  }

  it("gives the primary read the full ack budget and the follow-ups a strictly smaller one", async () => {
    const seen = await budgetsFor();

    const primary = seen.get("graph_get_errors");
    const query = seen.get("graph_query");
    const objectInfo = seen.get("graph_get_object_info");

    // The harness is worthless unless the follow-ups actually fired.
    expect(query, "graph_query follow-up did not run").toBeTypeOf("number");
    expect(objectInfo, "graph_get_object_info follow-up did not run").toBeTypeOf("number");

    expect(primary, "the primary read keeps the #1493 refresh-ack budget").toBe(30_000);
    expect(
      query!,
      "an elective follow-up must not be able to double the handler's worst case",
    ).toBeLessThan(primary!);
    expect(objectInfo!).toBeLessThan(primary!);

    // Worst case is the primary budget plus ONE follow-up budget: the two
    // follow-ups are issued concurrently, so they overlap rather than sum.
    expect(primary! + Math.max(query!, objectInfo!)).toBeLessThanOrEqual(40_000);
  });
});

// #1973 — two properties of the completion pass that a reader cannot check by
// reading, and that nothing else in this file pins.
describe("what the completion pass is allowed to assert, and under whose name (#1973)", () => {
  const objectInfoWith = (spec: unknown) => ({
    Loader: { input: { required: { asset: spec } } },
  });
  const runWith = (spec: unknown, value: string, panelExtra: Record<string, unknown> = {}) =>
    runGetErrors((cmd) => {
      if (cmd.cmd === "graph_get_errors") {
        return {
          ...budgetExhaustedReply({ extraUnchecked: 0 }),
          unchecked_nodes: [{ id: 5, type: "Loader", reason: BUDGET_REASON }],
          ...panelExtra,
        };
      }
      if (cmd.cmd === "graph_query") {
        return {
          matched: 1, shown: 1,
          text: JSON.stringify({ id: 5, type: "Loader", widgets: { asset: value } }),
        };
      }
      if (cmd.cmd === "graph_get_object_info") return { ok: true, object_info: objectInfoWith(spec) };
      return { ok: false };
    });

  // ATTRIBUTION. Until this change every unavailable_widget_values entry came from
  // the panel's own scanner, so the field name carried an implied provenance. This
  // pass reads a schema form the panel cannot see and has no /view probe, so its
  // verdicts must be distinguishable from the panel's — otherwise a wrong one is
  // untraceable and a reader cannot weigh the answer.
  it("stamps its own verdicts with a source, and does not restamp the panel's", async () => {
    const panelEntry = {
      id: 4, type: "CheckpointLoaderSimple", widget: "ckpt_name",
      value: "gone.safetensors", kind: "missing_asset",
    };
    const { payload } = await runWith([["ok.safetensors"], {}], "absent.safetensors", {
      unavailable_widget_values: [panelEntry],
    });

    const list = payload.unavailable_widget_values as Array<Record<string, unknown>>;
    const mine = list.find((u) => String(u.id) === "5");
    const theirs = list.find((u) => String(u.id) === "4");

    expect(mine, "the completion pass's own finding must be present").toBeTruthy();
    expect(mine?.source).toBe("orchestrator_completion");
    expect(theirs, "the panel's finding must survive the merge").toBeTruthy();
    expect(
      theirs?.source,
      "a panel verdict must not be re-attributed to the orchestrator",
    ).toBeUndefined();
  });

  // DIRECTION. The upload-flag list here is ComfyUI's own `UploadType`, which is
  // WIDER than the panel's (the panel omits `file_upload`). Being wider is only
  // safe if every extra flag can add an ABSTENTION and never a verdict. That is
  // the claim; this is the test of it, one flag at a time.
  const UPLOAD_FLAGS = ["image_upload", "video_upload", "audio_upload", "model_upload", "file_upload"];
  for (const flag of UPLOAD_FLAGS) {
    it(`abstains rather than accusing on an unenumerable value behind ${flag}`, async () => {
      const { payload } = await runWith(
        ["COMBO", { options: ["catalogued.png"], [flag]: true }],
        "nested/dir/real-file.png",
      );

      const list = (payload.unavailable_widget_values ?? []) as Array<Record<string, unknown>>;
      expect(
        list.find((u) => String(u.id) === "5"),
        `${flag} must never produce a hard verdict without a /view probe`,
      ).toBeUndefined();

      const unchecked = (payload.unchecked_nodes ?? []) as Array<Record<string, unknown>>;
      expect(unchecked.find((u) => String(u.id) === "5"), "it must be disclosed as unchecked").toBeTruthy();
      expect(payload.audit_complete).toBe(false);
    });
  }

  // The control that gives the five tests above their meaning: with NO upload flag,
  // the very same value IS judged. Without this, a pass that abstained on
  // everything would satisfy the whole block.
  it("still judges the same value when no upload flag is set (the control)", async () => {
    const { payload } = await runWith(
      ["COMBO", { options: ["catalogued.png"] }],
      "nested/dir/real-file.png",
    );
    const list = (payload.unavailable_widget_values ?? []) as Array<Record<string, unknown>>;
    const hit = list.find((u) => String(u.id) === "5");
    // Deliberately asserts ONLY that a verdict was produced. An earlier draft also
    // checked `source` here, which made this fail whenever the provenance stamp was
    // removed — a control that dies with the thing it controls is not a control.
    // Provenance has its own test above.
    expect(hit, "a non-upload combo is fully enumerable, so non-membership IS evidence").toBeTruthy();
    expect(hit?.kind).toBe("missing_asset");
  });
});

// Codex merge-gate P1s on the #1973 head: prototype lookup treated inherited
// Object methods as node defs, and a completed payload skipped the sanitizer
// that drops a contradictory clean note.
describe("get_errors completion does not invent a found type or skip the sanitizer (#1973)", () => {
  it("does not treat an inherited prototype property as a node definition", async () => {
    const panel = {
      ...budgetExhaustedReply({ extraUnchecked: 0 }),
      unchecked_nodes: [{ id: 1, type: "toString", reason: BUDGET_REASON }],
    };
    const { payload, cmds } = await runGetErrors((cmd) => {
      if (cmd.cmd === "graph_get_errors") return panel;
      if (cmd.cmd === "graph_query") {
        return {
          matched: 1,
          shown: 1,
          text: JSON.stringify({ id: 1, type: "toString", widgets: { sampler_name: "euler" } }),
        };
      }
      if (cmd.cmd === "graph_get_object_info") {
        // Non-empty, and it does not define `toString`. The inherited Function
        // on Object.prototype is exactly what a bracket lookup would accept.
        return { ok: true, object_info: objectInfoFor(EXECUTION_NODES) };
      }
      return { ok: false };
    });

    expect(cmds.filter((c) => c === "graph_get_object_info")).toHaveLength(1);
    expect(payload.audit_complete).toBe(false);
    expect(payload.unchecked_count).toBe(1);
    const still = (payload.unchecked_nodes ?? []) as Array<Record<string, unknown>>;
    const hit = still.find((u) => String(u.id) === "1");
    expect(hit, "a type that is not an own key of /object_info must stay unchecked").toBeTruthy();
    expect(hit?.type).toBe("toString");
    expect(String(hit?.reason ?? "")).toMatch(/not found in \/object_info/i);
  });

  it("routes a completed payload through the consistency sanitizer", async () => {
    const { payload, cmds } = await runGetErrors((cmd) => {
      if (cmd.cmd === "graph_get_errors") {
        return {
          node_count: 8,
          errored_count: 0,
          nodes: [],
          last_execution_error: null,
          node_errors: null,
          unavailable_widget_values: [
            { id: 4, widget: "ckpt_name", value: "gone.safetensors", kind: "missing_asset" },
          ],
          note: "前回の実行開始以降、エラーは記録されていません",
        };
      }
      throw new Error(`unexpected follow-up ${cmd.cmd}`);
    });

    expect(cmds).toEqual(["graph_get_errors"]);
    expect(payload.audit_complete).toBe(true);
    expect((payload.unavailable_widget_values as unknown[]).length).toBe(1);
    expect(
      payload.note,
      "a translated clean note must not survive beside unavailable_widget_values just because nobody was left unchecked",
    ).toBeUndefined();
  });
});
