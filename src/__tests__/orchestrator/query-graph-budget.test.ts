// #807 — panel_query_graph's `groups[]` membership lists were UNBUDGETED riders.
//
// Reported live by eicosaproton on a 690-node workflow: "the output keeps getting
// truncated by groups before reaching node details." The panel bounded the `text` field
// to `max_chars` and nothing else; `groups` (id, title, box geometry and every member
// node id) and the subgraph `rails` rode alongside it under separate FIXED caps, and
// were serialized BEFORE the rows the caller had asked for. So a reply that announced
// "truncated at 12 of 690 by max_chars=12000" could hand back an order of magnitude
// more than that, and the model reading it concluded the tool could not show it node
// detail rather than retrying with a bigger budget.
//
// The property under test is NOT "something got truncated" — a size assertion alone
// passes via the wrong path. It is that the budget the reply REPORTS describes the reply
// it is attached to, and that what gets shed to achieve that is the CONTEXT, never the
// rows that answer the query.
import { describe, expect, it } from "vitest";
import { buildPanelToolDefs } from "../../orchestrator/panel-tools.js";
import type { PanelToolCtx } from "../../orchestrator/panel-tools.js";

const DEFAULT_MAX_CHARS = 12000;
const CEILING = 60000;

/** Run the REAL panel_query_graph def against a stubbed panel reply, and hand back both
 *  the parsed payload and the exact text a caller would receive. */
async function runQueryGraph(
  args: Record<string, unknown>,
  reply: Record<string, unknown>,
): Promise<{ payload: Record<string, unknown>; text: string }> {
  const d = buildPanelToolDefs().find((t) => t.name === "panel_query_graph");
  expect(d, "panel_query_graph is not a panel tool").toBeTruthy();
  const res = await d!.handler(args, {
    call: async () => ({
      // The same shape the bridge produces: pretty-printed JSON, riders first.
      content: [{ type: "text" as const, text: JSON.stringify(reply, null, 2) }],
    }),
  } as unknown as PanelToolCtx);
  const block = res.content.find((c) => c.type === "text") as { text: string } | undefined;
  expect(block, "panel_query_graph returned no text block").toBeTruthy();
  return { payload: JSON.parse(block!.text) as Record<string, unknown>, text: block!.text };
}

/** A group as the panel actually summarizes one (summarizeGroup in comfyui-mcp-panel.js):
 *  id, title, color, box geometry, the true node_count and the member id list. */
function group(id: number, members: number): Record<string, unknown> {
  return {
    id,
    title: `REGION ${id} — sampling and refinement`,
    color: "#3f789e",
    bounding: [id * 100, id * 40, 1280, 720],
    node_count: members,
    node_ids: Array.from({ length: members }, (_, i) => id * 1000 + i),
  };
}

/** The panel's own reply shape for a graph query: riders FIRST, answer last. */
function panelReply(opts: {
  groups?: number;
  membersPerGroup?: number;
  rails?: boolean;
  text?: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const { groups = 0, membersPerGroup = 200, rails = false, text = "1 match(es)\n#42 KSampler" } = opts;
  return {
    viewing: { kind: "root", workflow: "big.json" },
    ...(groups ? { groups: Array.from({ length: groups }, (_, i) => group(i + 1, membersPerGroup)) } : {}),
    ...(rails
      ? { rails: { input: { id: -10, slots: ["model", "positive"] }, output: { id: -20, slots: ["IMAGE"] } } }
      : {}),
    ...opts.extra,
    total: 690,
    candidates: 690,
    matched: 1,
    shown: 1,
    truncated: false,
    truncated_by: null,
    text,
  };
}

/** Every key the payload carries, in serialization order. */
const keyOrder = (payload: Record<string, unknown>): string[] => Object.keys(payload);

/**
 * THE invariant, in one place: the reply either FITS the budget it reports, or SAYS it
 * does not, naming that same budget. A silent overrun is the fabricated observation this
 * issue is about; a silent under-report of the budget would be the same defect inverted.
 */
function assertBoundHonoured(
  payload: Record<string, unknown>,
  text: string,
  budget: number,
): void {
  expect(payload.max_chars, "the reply must report the budget it was fitted to").toBe(budget);
  if (payload.budget_overrun === undefined) {
    expect(text.length, "no overrun was declared, so the reply must fit").toBeLessThanOrEqual(budget);
  } else {
    expect(String(payload.budget_overrun)).toContain(`\`max_chars\`=${budget}`);
    expect(text.length, "an overrun was declared on a reply that actually fits").toBeGreaterThan(budget);
  }
}

describe("#807 — panel_query_graph's budget covers the WHOLE reply", () => {
  it("the reported budget describes the actual payload, not just the rows", async () => {
    // The exact reported failure: a 690-node graph with many groups. Before the fix the
    // riders alone rendered to ~100k characters next to a `max_chars` of 12000.
    const reply = panelReply({ groups: 40, membersPerGroup: 200 });
    const unbudgeted = JSON.stringify(reply, null, 2).length;
    expect(unbudgeted, "fixture is too small to exercise the defect").toBeGreaterThan(
      DEFAULT_MAX_CHARS * 5,
    );

    const { payload, text } = await runQueryGraph({}, reply);

    // The two halves of the claim, asserted together — either alone passes via the
    // wrong path. `max_chars` is what the reply SAYS its bound is; text.length is what
    // the caller actually receives.
    expect(payload.max_chars).toBe(DEFAULT_MAX_CHARS);
    expect(text.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
  });

  it("honours an explicit max_chars, clamped exactly as the panel clamps it", async () => {
    const reply = panelReply({ groups: 40 });
    for (const [asked, expected] of [
      [20000, 20000],
      [1, 500], // below the floor
      [999999, CEILING], // above the ceiling
    ] as const) {
      const { payload, text } = await runQueryGraph({ max_chars: asked }, reply);
      assertBoundHonoured(payload, text, expected);
    }
  });

  it("spends the budget on the ROWS first — the answer is never cut to fit the riders", async () => {
    // The rows are the answer to the question that was asked. A budget that trades them
    // for contextual extras answers a different question than the caller put.
    const rows = "1 match(es) of 690 in scope\n" + JSON.stringify({ id: 42, type: "KSampler" });
    const { payload } = await runQueryGraph({ max_chars: 2000 }, panelReply({ groups: 40, text: rows }));
    expect(payload.text).toBe(rows);
    expect(payload.shown).toBe(1);
    expect(payload.matched).toBe(1);
  });

  it("serializes the riders AFTER the answer, never before it", async () => {
    // "…truncated by groups before reaching node details" was literal: the panel emits
    // the riders first, so an agent reading top-down met the rosters before its answer.
    const { payload } = await runQueryGraph({ max_chars: CEILING }, panelReply({ groups: 2, membersPerGroup: 3, rails: true }));
    const order = keyOrder(payload);
    expect(order.indexOf("text")).toBeLessThan(order.indexOf("groups"));
    expect(order.indexOf("text")).toBeLessThan(order.indexOf("rails"));
    expect(order.indexOf("shown")).toBeLessThan(order.indexOf("groups"));
  });

  it("sheds RESOLUTION before COVERAGE: every group stays listed, membership goes first", async () => {
    // Half a group list reads as "this graph has that many groups". A complete index
    // without member ids does not, and it still answers "which groups exist".
    const reply = panelReply({ groups: 30, membersPerGroup: 120 });
    const { payload, text } = await runQueryGraph({ max_chars: 8000 }, reply);

    const groups = payload.groups as Array<Record<string, unknown>>;
    expect(Array.isArray(groups)).toBe(true);
    expect(groups).toHaveLength(30); // coverage intact
    for (const g of groups) {
      expect(g.node_ids).toBeUndefined(); // resolution shed
      expect(g.bounding).toBeUndefined();
      expect(g.node_count).toBe(120); // …and the true size still stated
      expect(typeof g.id).toBe("number");
    }
    expect(payload.groups_membership_omitted).toMatch(/all 30 group\(s\)/);
    expect(payload.groups_membership_omitted).toMatch(/never dropped to make room/);
    expect(text.length).toBeLessThanOrEqual(8000);
  });

  it("drops the group index only when the index itself will not fit, and says how many", async () => {
    const reply = panelReply({ groups: 200, membersPerGroup: 200 });
    const { payload, text } = await runQueryGraph({ max_chars: 1500 }, reply);

    expect(payload.groups).toBeUndefined();
    expect(payload.groups_omitted).toMatch(/all 200 group\(s\)/);
    expect(text.length).toBeLessThanOrEqual(1500);
  });

  it("does not pass off the panel's own capped group list as the graph's total", async () => {
    // The panel caps `groups` at 200 before the orchestrator ever sees it. Saying "all
    // 200 groups" there would report a number nobody observed.
    const reply = panelReply({
      groups: 200,
      membersPerGroup: 200,
      extra: { groups_truncated: true, groups_truncation_hint: "Showing 200 of 640 group(s)…" },
    });
    const { payload } = await runQueryGraph({ max_chars: 1500 }, reply);
    expect(payload.groups_omitted).toMatch(/not the graph's total/);
    expect(payload.groups_omitted).not.toMatch(/all 200 group\(s\)/);
  });

  it("keeps the subgraph rails until last — groups go before boundary wiring", async () => {
    const reply = panelReply({ groups: 30, membersPerGroup: 200, rails: true });
    const { payload } = await runQueryGraph({ max_chars: 2000 }, reply);
    expect(payload.groups).toBeUndefined();
    expect(payload.rails).toBeDefined();
    expect(payload.rails_omitted).toBeUndefined();
  });

  it("drops the rails too rather than break the bound, and says how to get them back", async () => {
    const rails: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) rails[`slot_${i}`] = { id: -10 - i, name: "x".repeat(60) };
    const { payload, text } = await runQueryGraph(
      { max_chars: 500 },
      panelReply({ groups: 5, rails: false, extra: { rails }, text: "0 match(es)" }),
    );
    expect(payload.rails).toBeUndefined();
    expect(payload.rails_omitted).toMatch(/panel_query_graph/);
    // At the 500 FLOOR the sentences explaining what was dropped are themselves larger
    // than the budget. They are not cut — a silently missing rider is the defect — so
    // the reply must say plainly that it overran, and why.
    assertBoundHonoured(payload, text, 500);
    // The notes, not the rows, are the overflow here — so the note must NOT send the
    // caller off to narrow a query or lower a budget that cannot shrink them.
    expect(String(payload.budget_overrun)).toMatch(/the rest is the note\(s\) above/);
    expect(String(payload.budget_overrun)).toMatch(/no parameter shrinks them/);
    expect(String(payload.budget_overrun)).not.toMatch(/narrow the query/);
  });

  it("reports the TRUE size when the rows alone overrun, instead of standing on a bound that did not hold", async () => {
    // The panel fits `text` to `max_chars`; JSON framing and escaping sit on top of it.
    // With every rider already gone there is nothing left to shed but the answer, and
    // discarding that would be answering a different question — so the overrun is
    // DISCLOSED with the real number rather than papered over.
    const rows = "row\n".repeat(400); // ~1600 chars against a 1000-char budget
    const { payload, text } = await runQueryGraph(
      { max_chars: 1000 },
      panelReply({ groups: 4, text: rows }),
    );
    expect(payload.text).toBe(rows); // the answer survives intact
    expect(payload.groups).toBeUndefined();
    const overrun = payload.budget_overrun as string;
    expect(typeof overrun).toBe("string");
    expect(overrun).toMatch(/over `max_chars`=1000/);
    expect(overrun).toMatch(/never discarded to meet a budget/);
    // The stated size must be the size of the thing the caller is holding, within the
    // handful of characters the note's own digits move it by. A round number pulled out
    // of the air would pass a "mentions a number" assertion and fail this one.
    const claimed = Number(/This reply is ~(\d+) chars/.exec(overrun)?.[1]);
    expect(Number.isFinite(claimed)).toBe(true);
    expect(Math.abs(text.length - claimed)).toBeLessThan(600);
  });

  it("leaves a reply that already fits completely alone — no shedding, no notes", async () => {
    // A FALSE truncation costs the same round trip as a silent one and teaches distrust
    // of a complete result (#809). Nothing here is over budget, so nothing may be cut.
    const reply = panelReply({ groups: 2, membersPerGroup: 3, rails: true });
    const { payload, text } = await runQueryGraph({ max_chars: CEILING }, reply);
    expect(text.length).toBeLessThanOrEqual(CEILING);
    expect((payload.groups as unknown[]).length).toBe(2);
    expect((payload.groups as Array<Record<string, unknown>>)[0].node_ids).toEqual([1000, 1001, 1002]);
    expect(payload.rails).toEqual(reply.rails);
    expect(payload.groups_membership_omitted).toBeUndefined();
    expect(payload.groups_omitted).toBeUndefined();
    expect(payload.rails_omitted).toBeUndefined();
    expect(payload.budget_overrun).toBeUndefined();
  });

  it("passes a rider-free reply straight through, untouched", async () => {
    // Nothing rides alongside the answer, so there is no accounting to apply and no
    // reason to rewrite the panel's reply at all.
    const reply = { total: 3, matched: 0, shown: 0, truncated: false, text: "0 match(es)" };
    const { payload } = await runQueryGraph({ max_chars: 500 }, reply);
    expect(payload).toEqual(reply);
    expect(payload.max_chars).toBeUndefined();
  });

  it("never overwrites a max_chars the panel reported itself", async () => {
    // A newer panel that does its own whole-reply accounting knows better than this
    // rider what budget it actually worked to.
    const { payload } = await runQueryGraph(
      { max_chars: 4000 },
      panelReply({ groups: 2, membersPerGroup: 2, extra: { max_chars: 3777 } }),
    );
    expect(payload.max_chars).toBe(3777);
  });

  it("leaves an error reply alone", async () => {
    const d = buildPanelToolDefs().find((t) => t.name === "panel_query_graph")!;
    const res = await d.handler({ max_chars: 500 }, {
      call: async () => ({ content: [{ type: "text" as const, text: "Error: no connected tab" }], isError: true }),
    } as unknown as PanelToolCtx);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toBe("Error: no connected tab");
  });

  describe("the remedy is actionable from where the caller actually is", () => {
    it("names a raise with its real ceiling when a raise would in fact help", async () => {
      const reply = panelReply({ groups: 20, membersPerGroup: 60 });
      const needed = JSON.stringify(reply, null, 2).length;
      expect(needed).toBeLessThan(CEILING); // a raise CAN hold it
      const { payload } = await runQueryGraph({ max_chars: 4000 }, reply);
      const note = String(payload.groups_membership_omitted ?? payload.groups_omitted);
      expect(note).toMatch(/raise `max_chars` \(up to 60000\)/);
    });

    it("does NOT offer a raise the ceiling could never satisfy", async () => {
      // 200 groups × 200 member ids renders to far past 60000. "Raise max_chars up to
      // 60000" there is a guaranteed second failure — a dead retry inside the message
      // explaining the first one.
      const reply = panelReply({ groups: 200, membersPerGroup: 200 });
      expect(JSON.stringify(reply, null, 2).length).toBeGreaterThan(CEILING);
      const { payload } = await runQueryGraph({ max_chars: 4000 }, reply);
      const note = String(payload.groups_omitted ?? payload.groups_membership_omitted);
      expect(note).toMatch(/past `max_chars`'s ceiling of 60000/);
      expect(note).toMatch(/will NOT bring them back/);
      expect(note).not.toMatch(/raise `max_chars` \(up to/);
    });

    it("says the budget is maxed instead of telling a caller at the ceiling to raise it", async () => {
      const { payload } = await runQueryGraph(
        { max_chars: CEILING },
        panelReply({ groups: 200, membersPerGroup: 200 }),
      );
      const note = String(payload.groups_omitted ?? payload.groups_membership_omitted);
      expect(note).toMatch(/already at its ceiling of 60000/);
      expect(note).not.toMatch(/raise `max_chars`/);
    });

    it("only suggests narrowing the query when narrowing could actually free the room", async () => {
      // Rows of 4000 chars against a deficit of ~2000: cutting rows can close it.
      const canHelp = await runQueryGraph(
        { max_chars: 8000 },
        panelReply({ groups: 8, membersPerGroup: 40, text: "r".repeat(4000) }),
      );
      expect(String(canHelp.payload.groups_membership_omitted ?? canHelp.payload.groups_omitted)).toMatch(
        /Narrowing this query/,
      );

      // Groups alone dwarf the budget: with two rows to give back, "ask for less" is a
      // dead retry however aggressively the caller narrows.
      const cannotHelp = await runQueryGraph(
        { max_chars: 1000 },
        panelReply({ groups: 200, membersPerGroup: 200, text: "#42 KSampler" }),
      );
      expect(String(cannotHelp.payload.groups_omitted)).not.toMatch(/Narrowing this query/);
    });
  });
});
