// panel#887 — `panel_open_workflow` reported the target was active while
// `panel_list_workflows`, called immediately afterwards, named a different one.
// The reporter's concern is the sharp end: a Save-As on that state writes the
// wrong canvas.
//
// WHERE THIS IS NOT. The first attempt (panel PR #896, withdrawn) tried to re-read
// the active pointer inside the panel's own post-load window. That cannot work:
// from `loadGraphData` resolving to the reply being built there is no `await`, so
// the "second" read is the same instant as the first and returns the same answer.
// Both branches it added were unreachable in production, and a green suite with
// killed mutations could not say so — mutations prove the tests match the code,
// never that the code is reachable.
//
// WHERE IT IS. `refreshOpenWorkflowUuid` is the ONLY observation in the whole open
// path taken after a real round trip (`await ctx.call({cmd:"workflow_list"})`), so
// it is the only thing that can see the active pointer having settled elsewhere.
// It already detected the contradiction and correctly declined to adopt the uuid —
// and then returned silently, leaving the tool result a plain success naming the
// path the caller asked for. Detected, handled, and not disclosed.
//
// THE DISTINCTION THAT MAKES THIS SAFE. `activeMatchesOpenRefreshTarget` is a
// UUID-ADOPTION gate: for adoption, "a different workflow is active" and "I cannot
// tell what is active" both correctly mean *do not adopt*, so it answers false to
// both. WARNING on that same false would be a different claim on the same
// evidence — and it returns false whenever the active record has no canonical
// SAVED identity, which includes an ordinary unsaved tab. Every open made while
// "Unsaved Workflow" is active would raise a wrong-canvas alarm. So the warning
// requires a POSITIVE identification of what is active, and an unreadable active
// record stays silent: unproven degrades to unknown, never to the negative.
import { beforeEach, describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  readOpenActiveAgainstTarget,
  describeActiveRecord,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";

const OPENED_UUID = "11111111-2222-4333-8444-555555555555";
const PRIOR_UUID = "99999999-8888-4777-a666-555555555555";
const OTHER_UUID = "22222222-3333-4444-8555-666666666666";

const PATH = "workflows/a.json";
const ROUTING = `wf:${PATH}`;

let fence: string | undefined;
let stamps: string[];

const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text;

/** `active` shapes the panel can actually return after an open. */
type ActiveShape = "target" | "otherSaved" | "unsavedTab" | "empty" | "missing";

const ACTIVE_RECORDS: Record<ActiveShape, unknown> = {
  target: { path: PATH, filename: "a.json", key: ROUTING, routing_key: ROUTING, workflow_uuid: OPENED_UUID },
  otherSaved: {
    path: "workflows/somethingelse.json",
    filename: "somethingelse.json",
    key: "wf:workflows/somethingelse.json",
    routing_key: "wf:workflows/somethingelse.json",
    workflow_uuid: OTHER_UUID,
  },
  // An unsaved tab has no saved path — `tmp:` keys are deliberately rejected as
  // saved identities, which is exactly why the adoption gate cannot be reused.
  unsavedTab: { filename: "Unsaved Workflow", key: "tmp:2522828d", routing_key: "tmp:2522828d" },
  empty: {},
  missing: null,
};

function bridgeFor(shape: ActiveShape) {
  return {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "workflow_open") {
        return {
          opened: { path: PATH, filename: "a.json" },
          routing_key: ROUTING,
          workflow_uuid: OPENED_UUID,
          modified: false,
          open_seq: 7,
        };
      }
      if (cmd.cmd === "workflow_list") {
        return { active: ACTIVE_RECORDS[shape], active_confirmed: true, workflows: [] };
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: "tab-1", title: "A", connected_at: 0 }],
    resolveActiveTabId: () => "tab-1",
    workflowUuidFor: () => ({ known: true, uuid: fence }),
    refreshWorkflowUuid: (_tabId: string, uuid: string) => {
      fence = uuid;
      stamps.push(uuid);
      return true;
    },
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
}

const ctxWith = (b: ReturnType<typeof bridgeFor>): PanelToolCtx => makePanelToolCtx(b, "tab-1");
const openWorkflow = () => buildPanelToolDefs().find((d) => d.name === "panel_open_workflow")!;

beforeEach(() => {
  stamps = [];
  fence = PRIOR_UUID;
});

// ---------------------------------------------------------------------------
// 1. REACHABILITY. The whole point. These drive the real `panel_open_workflow`
//    handler end to end through the real bridge, so a passing test here is
//    evidence that PRODUCTION reaches the new branch — which is precisely what
//    the withdrawn panel-side attempt could not show about its own code.
// ---------------------------------------------------------------------------

describe("#887 the contradiction the orchestrator already saw is now disclosed", () => {
  it("REACHABILITY: the real open handler FAILS when the post-open read names another workflow", async () => {
    const res = await openWorkflow().handler({ path: PATH }, ctxWith(bridgeFor("otherSaved")));

    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain(PATH); // what was asked for
    expect(text).toContain("somethingelse.json"); // what is ACTUALLY active
    expect(text).toMatch(/Do NOT save/i);
  });

  it("the session's fence is left alone — the active tab keeps its own protection", async () => {
    await openWorkflow().handler({ path: PATH }, ctxWith(bridgeFor("otherSaved")));

    // Unchanged from the pre-fix behaviour, and the reason this is safe to fail:
    // nothing was adopted, so the workflow that IS active is still fenced as its own.
    expect(stamps).toEqual([]);
    expect(fence).toBe(PRIOR_UUID);
  });

  it("an UNSAVED tab winning the slot is drift too — it cannot be the saved target", async () => {
    // The case the adoption gate cannot distinguish, and the reason the warning
    // needed its own predicate rather than reusing that gate's boolean.
    const res = await openWorkflow().handler({ path: PATH }, ctxWith(bridgeFor("unsavedTab")));

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Unsaved Workflow");
  });
});

// ---------------------------------------------------------------------------
// 2. NO FALSE ALARMS. The other half of failing closed.
// ---------------------------------------------------------------------------

describe("#887 an open that landed is untouched", () => {
  it("a confirming read still succeeds and still adopts the fresher uuid", async () => {
    const res = await openWorkflow().handler({ path: PATH }, ctxWith(bridgeFor("target")));

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain(PATH);
    expect(fence).toBe(OPENED_UUID);
  });

  for (const shape of ["empty", "missing"] as const) {
    it(`an UNREADABLE active record (${shape}) claims nothing in either direction`, async () => {
      const res = await openWorkflow().handler({ path: PATH }, ctxWith(bridgeFor(shape)));

      // Not a failure: nothing was observed about what is active, so inventing a
      // wrong-canvas warning here would be the same defect pointing the other way.
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).not.toMatch(/Do NOT save/i);
      // ...and still no adoption, exactly as before.
      expect(stamps).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. The reading itself.
// ---------------------------------------------------------------------------

describe("#887 readOpenActiveAgainstTarget separates cannot-tell from proven-different", () => {
  it("the target itself reads SAME", () => {
    expect(readOpenActiveAgainstTarget(ACTIVE_RECORDS.target, PATH)).toBe("same");
  });

  it("a positively identified other workflow reads DIFFERENT", () => {
    expect(readOpenActiveAgainstTarget(ACTIVE_RECORDS.otherSaved, PATH)).toBe("different");
    expect(readOpenActiveAgainstTarget(ACTIVE_RECORDS.unsavedTab, PATH)).toBe("different");
  });

  it("an active record carrying NO identifying field reads INDETERMINATE", () => {
    // The alarm-on-every-open case if this collapsed into `different`.
    for (const v of [null, undefined, {}, { title: "Untitled" }, 42, "a.json"]) {
      expect(readOpenActiveAgainstTarget(v, PATH)).toBe("indeterminate");
    }
  });

  it("an unreadable TARGET is indeterminate too — our own side can fail to canonicalize", () => {
    for (const p of ["", "tmp:2522828d", "wf:workflows/a.json"]) {
      expect(readOpenActiveAgainstTarget(ACTIVE_RECORDS.otherSaved, p)).toBe("indeterminate");
    }
  });

  it("an empty-string identifier does not count as an identification", () => {
    expect(readOpenActiveAgainstTarget({ path: "", filename: "", key: "" }, PATH)).toBe("indeterminate");
  });
});

describe("#887 describeActiveRecord names something a human can act on", () => {
  it("prefers the filename, then the path, then the routing key", () => {
    expect(describeActiveRecord({ filename: "b.json", path: "workflows/b.json" })).toBe("b.json");
    expect(describeActiveRecord({ path: "workflows/b.json" })).toBe("workflows/b.json");
    expect(describeActiveRecord({ key: "tmp:abc" })).toBe("tmp:abc");
  });

  it("falls back to a neutral phrase rather than printing undefined at the user", () => {
    for (const v of [null, undefined, {}, 7]) {
      expect(describeActiveRecord(v)).toBe("another workflow");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The false alarm the existing #716 P1 suite caught, pinned here directly.
// ---------------------------------------------------------------------------

describe("#887 a same-workflow record whose IDENTITY merely failed to canonicalize is not drift", () => {
  // The strict adoption gate refuses a record with an absent/replayed/malformed
  // routing_key even when its PATH is the workflow we opened. Declining to adopt a
  // uuid there is correct; announcing a different canvas is not. Three existing
  // #716 P1 tests failed on exactly this before the looser positive check was
  // added — the suite caught a real false alarm, which is what it is for.
  for (const routing_key of [undefined, "wf:workflows/replayed.json", "not-a-routing-key"]) {
    it(`routing_key=${String(routing_key)} reads INDETERMINATE, never different`, () => {
      const active = { path: PATH, routing_key, workflow_uuid: OPENED_UUID };
      expect(readOpenActiveAgainstTarget(active, PATH)).toBe("indeterminate");
    });
  }

  it("a same-BASENAME workflow in another directory is still real drift", () => {
    // The boundary: loosening must not swallow the case the guard exists for.
    // workflows/b/foo.json cannot satisfy a request for workflows/a/foo.json.
    expect(
      readOpenActiveAgainstTarget(
        { path: "workflows/b/foo.json", routing_key: "wf:workflows/b/foo.json" },
        "workflows/a/foo.json",
      ),
    ).toBe("different");
  });
});
