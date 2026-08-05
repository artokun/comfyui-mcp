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

  it("does not call a pre-capped group list complete when only membership was shed", async () => {
    // The panel caps `groups` at 200 before this code sees it. Saying "every group is
    // still listed" on that reply contradicts the panel's own "showing 200 of 640"
    // sitting two fields away, and claims whole-graph coverage nobody observed
    // (codex gate MAJOR). This is the MEMBERSHIP rung — the index survives, so the
    // temptation to claim completeness is at its strongest here.
    const reply = panelReply({
      groups: 30,
      membersPerGroup: 120,
      extra: { groups_truncated: true, groups_truncation_hint: "Showing 200 of 640 group(s)…" },
    });
    const { payload, text } = await runQueryGraph({ max_chars: 8000 }, reply);
    expect(payload.groups).toHaveLength(30); // the membership rung, not the index rung
    const note = String(payload.groups_membership_omitted);
    expect(note).toMatch(/CARRIED/);
    expect(note).toMatch(/not the graph's total/);
    expect(note).not.toMatch(/Every group is still listed/);
    assertBoundHonoured(payload, text, 8000);

    // …and the unclipped case still says the plain thing, so this is not just prose.
    const plain = await runQueryGraph({ max_chars: 8000 }, panelReply({ groups: 30, membersPerGroup: 120 }));
    expect(String(plain.payload.groups_membership_omitted)).toMatch(/Every group is still listed/);
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
    // …and the panel's own marker is the ONLY place the real figure (640) survives, so
    // dropping it along with the list would destroy the one coverage fact still
    // available (codex gate r6). It rides on every rung below the index.
    expect(payload.groups_truncation_hint).toBe(reply.groups_truncation_hint);
    expect(payload.groups_truncated).toBe(true);
  });

  it("keeps the panel's cap evidence even when the rails go too", async () => {
    const rails: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) rails[`slot_${i}`] = { id: -10 - i, name: "x".repeat(60) };
    const { payload } = await runQueryGraph(
      { max_chars: 500 },
      panelReply({
        groups: 200,
        membersPerGroup: 200,
        extra: {
          rails,
          groups_truncated: true,
          groups_truncation_hint: "Showing 200 of 640 group(s)…",
        },
      }),
    );
    expect(payload.groups).toBeUndefined();
    expect(payload.rails).toBeUndefined();
    expect(payload.groups_truncation_hint).toBe("Showing 200 of 640 group(s)…");
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
    // The way back is judged the same way the groups' is: measured, not asserted.
    expect(payload.rails_omitted).toMatch(/did not fit `max_chars`=500 without them/);
    expect(payload.rails_omitted).toMatch(/`max_chars`|narrow/);
    // At the 500 FLOOR the sentences explaining what was dropped are themselves larger
    // than the budget. They are not cut — a silently missing rider is the defect — so
    // the reply must say plainly that it overran, and why.
    assertBoundHonoured(payload, text, 500);
    // The notes, not the rows, are the overflow here — so the note must NOT send the
    // caller off to narrow a query or lower a budget that cannot shrink them.
    expect(String(payload.budget_overrun)).toMatch(/note\(s\) above saying which context was dropped/);
    expect(String(payload.budget_overrun)).toMatch(/act on the ROWS ONLY/);
    expect(String(payload.budget_overrun)).toMatch(/no parameter shrinks the rest/);
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
    // …and it must NOT say "nothing was discarded" while `groups_omitted` two fields up
    // says the groups were (codex gate r4). A contradiction that plain gets resolved by
    // distrusting both notes.
    expect(payload.groups_omitted).toBeDefined();
    expect(overrun).not.toMatch(/Nothing was discarded/);
    expect(overrun).toMatch(/already has been, and the note\(s\) above record it/);
    // The rows really ARE the bulk here, so the note may say so and may offer the two
    // levers that shrink them.
    const rows_ = Number(/rows answering your query are (\d+) chars/.exec(overrun)?.[1]);
    expect(rows_).toBeGreaterThan(1000);
    expect(overrun).toMatch(/lower `max_chars` \(floor 500\)/);
    // EXACTLY the size of the thing the caller is holding, this note included. A size
    // measured before the note was added would understate the reply by the length of
    // the sentence claiming to have counted everything (codex gate MAJOR), and a round
    // number pulled out of the air would pass a "mentions a number" assertion.
    const claimed = Number(/This reply is (\d+) chars/.exec(overrun)?.[1]);
    expect(Number.isFinite(claimed)).toBe(true);
    expect(claimed).toBe(text.length);
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

  it("keeps a rider-free reply intact, adding only the budget it was fitted to", async () => {
    const reply = { total: 3, matched: 0, shown: 0, truncated: false, text: "0 match(es)" };
    const { payload, text } = await runQueryGraph({ max_chars: 500 }, reply);
    expect(payload).toEqual({ ...reply, max_chars: 500 });
    assertBoundHonoured(payload, text, 500);
  });

  describe("every reply is measured, including the ones with nothing to shed", () => {
    // The shortcut this replaces — "no groups and no rails, so skip the accounting" —
    // let a reply exceed the budget it reports with nothing said, which is the exact
    // defect #807 is about wearing a different hat (codex gate SEVERE).

    it("discloses an over-budget reply that has NO riders at all", async () => {
      const reply = {
        total: 3,
        matched: 1,
        shown: 1,
        truncated: false,
        text: "x".repeat(2000),
      };
      const { payload, text } = await runQueryGraph({ max_chars: 900 }, reply);
      expect(payload.text).toBe(reply.text);
      assertBoundHonoured(payload, text, 900);
      expect(String(payload.budget_overrun)).toMatch(/rows answering your query are \d+ chars/);
      // With no riders there really was nothing to drop, so the plain claim is true —
      // which is what keeps the guarded wording above from being blanket hedging.
      expect(String(payload.budget_overrun)).toMatch(/Nothing was discarded to meet the budget/);
    });

    it("counts a field it has never seen before", async () => {
      // A future panel field is not a rider this code knows how to shed, but it is
      // still part of what the caller receives — so it must at least be COUNTED, and
      // the shortfall admitted, rather than sailing past the bound unremarked.
      const { payload, text } = await runQueryGraph(
        { max_chars: 900 },
        { total: 1, shown: 0, text: "0 match(es)", some_future_index: "z".repeat(2000) },
      );
      expect(payload.some_future_index).toBe("z".repeat(2000));
      assertBoundHonoured(payload, text, 900);
    });

    it("counts an oversized `viewing`, which identifies the graph and is never shed", async () => {
      // Subgraph titles are user-controlled and unbounded. `viewing` says WHICH graph
      // the answer describes, so dropping it would make the whole reply ambiguous — it
      // is kept, counted, and the overrun stated.
      const { payload, text } = await runQueryGraph(
        { max_chars: 900 },
        {
          viewing: { scope: "subgraph", owner_node_id: 12, title: "T".repeat(3000) },
          total: 1,
          shown: 0,
          text: "0 match(es)",
        },
      );
      expect((payload.viewing as { title: string }).title).toHaveLength(3000);
      assertBoundHonoured(payload, text, 900);

      // And the overrun note must not BLAME the rows for it (codex gate r3). The rows
      // here are 11 characters; calling 3000 of subgraph title "the rows that answer
      // your query" and then offering to shrink them names two levers that cannot
      // touch the field responsible — the dead retry this accounting exists to remove.
      const note = String(payload.budget_overrun);
      expect(note).toMatch(/rows answering your query are 1[0-9] chars/);
      expect(note).toMatch(/act on the ROWS ONLY/);
      expect(note).toMatch(/no parameter shrinks the rest/);
      expect(note).not.toMatch(/for a smaller reply lower `max_chars`/);
    });

    it("keeps an EMPTY groups list — a stated zero is an observation, not a rider", async () => {
      // `groups: []` costs about fifteen characters and says "this graph has no
      // groups". Deleting it saved nothing and turned that stated zero into an absent
      // field, and then let the overrun note claim nothing had been discarded when a
      // field had (codex gate r7).
      const { payload, text } = await runQueryGraph(
        { max_chars: 900 },
        {
          viewing: { scope: "subgraph", owner_node_id: 1, title: "T".repeat(3000) },
          groups: [],
          total: 1,
          shown: 0,
          text: "0 match(es)",
        },
      );
      expect(payload.groups).toEqual([]);
      assertBoundHonoured(payload, text, 900);
      expect(String(payload.budget_overrun)).toMatch(/Nothing was discarded to meet the budget/);
    });

    it("discloses an over-budget aggregate (group_by) reply", async () => {
      const { payload, text } = await runQueryGraph(
        { max_chars: 700, group_by: "type" },
        {
          viewing: { scope: "root" },
          total: 900,
          matched: 900,
          shown: 900,
          truncated: true,
          truncated_by: "max_chars",
          text: "900 node(s) across 300 type(s):\n" + "12× SomeNodeType\n".repeat(80),
        },
      );
      assertBoundHonoured(payload, text, 700);
    });

    it("discloses an over-budget seed-not-found reply", async () => {
      // The early returns carry no riders at all, and used to bypass the fitter.
      const { payload, text } = await runQueryGraph(
        { max_chars: 500, upstream_of: 999 },
        {
          total: 690,
          candidates: 0,
          matched: 0,
          shown: 0,
          truncated: false,
          text: `upstream_of node ${"9".repeat(1200)} not found (690 nodes in view).`,
        },
      );
      assertBoundHonoured(payload, text, 500);
    });
  });

  it("reports the budget it ENFORCED, not one the panel happened to mention", async () => {
    // Deferring to a panel-supplied `max_chars` reports a bound nothing checked: a
    // reply fitted to 4000 announcing 3777 looks compliant at 3900 (codex gate SEVERE).
    const { payload, text } = await runQueryGraph(
      { max_chars: 4000 },
      panelReply({ groups: 2, membersPerGroup: 2, extra: { max_chars: 3777 } }),
    );
    expect(payload.max_chars).toBe(4000);
    assertBoundHonoured(payload, text, 4000);
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
      expect(note).toMatch(/no combination of raising it and narrowing/);
      expect(note).not.toMatch(/raise `max_chars` \(up to/);
    });

    it("offers raise-AND-narrow only when narrowing would actually bring it under the ceiling", async () => {
      // The full reply is past the ceiling, but the riders alone are not: with the rows
      // gone they fit, so BOTH levers together are a real remedy and either alone is not.
      const reply = panelReply({ groups: 45, membersPerGroup: 40, text: "r".repeat(30000) });
      expect(JSON.stringify(reply, null, 2).length).toBeGreaterThan(CEILING);
      expect(JSON.stringify({ ...reply, text: "" }, null, 2).length).toBeLessThan(CEILING);
      const { payload } = await runQueryGraph({ max_chars: 4000 }, reply);
      const note = String(payload.groups_omitted ?? payload.groups_membership_omitted);
      expect(note).toMatch(/raise `max_chars` \(up to 60000\) AND narrow the query/);
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
