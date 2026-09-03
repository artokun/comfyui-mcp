// #812 — panel_new_workflow leaves the session permanently fenced whenever the
// created tab is UNSAVED: there is no real disk path, so the documented recovery
// (panel_open_workflow(<path>)) has nothing to open. The tool's own error text
// acknowledges this — "that case needs the tab refresh, not a reopen" — which
// made panel_new_workflow "effectively unusable whenever this fires."
//
// The reporter found the narrowest fix themselves: panel_open_workflow on the
// tab's OWN tmp:<uuid> routing_key already resolves to the right tab and returns
// opened:true — it just never re-derived the fence from that reply the way a
// saved-path open does.
//
// Root cause: refreshOpenWorkflowUuid's ENTIRE corroboration path is built around
// canonicalRequestedSavedIdentity, which returns null for every unsaved token by
// construction (canonicalSavedWorkflowPath explicitly excludes tmp:/wf: prefixes —
// they are routing tokens, not path syntax). So an unsaved open always took the
// early return, before ever looking at the reply's own workflow_uuid — a field
// that has existed since #716 and is proven the SAME way for saved and unsaved
// targets: "only after a FINAL SYNCHRONOUS check that target is still the active
// workflow… omitting it otherwise, expressly so the MCP keeps its existing fence
// fail-closed."
//
// The fix adds a PARALLEL identity check for the unsaved case: exact string
// equality between the caller's literal tmp:<uuid> token and the panel's own
// routing_key for the tab it just opened. This is not alias resolution (the
// #716 P1 concern for the saved case) — a tmp: token is not a lookup key, it IS
// the per-tab identity, unique by construction. No workflow_list round trip is
// attempted (mirroring the trust level of the EXISTING "could not ask" fallback):
// that read is refused by the exact wedge #812 exists to escape (#1071).

import { beforeEach, describe, expect, it } from "vitest";

import { buildPanelToolDefs, makePanelToolCtx, type PanelToolCtx, type ToolResult } from "../../orchestrator/panel-tools.js";

// RFC-shaped: WORKFLOW_UUID_RE requires a [1-5] version and an [89ab] variant
// nibble. A placeholder that does not match this is silently rejected, which
// would make a positive test pass for the wrong reason (see open-workflow-
// fence-unreadable.test.ts's own warning on this exact trap).
const OPENED_UUID = "11111111-2222-4333-8444-555555555555";
const PRIOR_UUID = "99999999-8888-4777-a666-555555555555";
const TAB_TOKEN = "tmp:12345678-1234-4234-8234-123456789012";
const OTHER_TAB_TOKEN = "tmp:87654321-4321-4321-8321-210987654321";

let fence: string | undefined;
let sent: Array<Record<string, unknown>>;
let stamps: string[];

const textOf = (res: ToolResult): string => (res.content[0] as { text: string }).text;

function openReply(opts: {
  routingKey: string;
  withUuid: boolean;
  /** #2477 — some successful replies nest the key under `opened` only. */
  nestRoutingKey?: boolean;
  /** Synthetic saved-looking path the live panel can publish for an unsaved tab. */
  openedPath?: string | null;
}): Record<string, unknown> {
  const opened: Record<string, unknown> = {
    // An UNSAVED workflow has no real path — the panel's own reply shape, per
    // web/js/comfyui-mcp-panel.js: `opened: { path: target.path, filename }`
    // with `target.path` undefined for a tmp: tab.
    path: opts.openedPath === undefined ? null : opts.openedPath,
    filename: opts.openedPath ? "Unsaved Workflow" : null,
  };
  if (opts.nestRoutingKey) opened.routing_key = opts.routingKey;
  return {
    opened,
    ...(opts.nestRoutingKey ? {} : { routing_key: opts.routingKey }),
    ...(opts.withUuid ? { workflow_uuid: OPENED_UUID } : {}),
    modified: false,
    open_seq: 3,
  };
}

function bridgeFor(reply: Record<string, unknown>, list?: Record<string, unknown>) {
  return {
    send: async (cmd: Record<string, unknown>) => {
      sent.push(cmd);
      if (cmd.cmd === "workflow_open") return reply;
      // #812's own reported sequence: workflow_list is unreadable right after
      // creation. The fix must not depend on this call succeeding, or ever
      // being made at all for the unsaved path — asserted explicitly below.
      if (cmd.cmd === "workflow_list") {
        if (list) return list;
        throw new Error(
          "workflow instance mismatch: this command targets a different workflow than the active canvas",
        );
      }
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: "tab-1", title: "Unsaved Workflow", connected_at: 0 }],
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
  sent = [];
  stamps = [];
  fence = PRIOR_UUID; // the wedge: fenced to the instance we are no longer on
});

describe("#812 opening the tab's OWN tmp: routing_key refreshes the fence", () => {
  it("adopts the reply's proven uuid when the caller's token matches the opened tab exactly", async () => {
    const res = await openWorkflow().handler(
      { path: TAB_TOKEN },
      ctxWith(bridgeFor(openReply({ routingKey: TAB_TOKEN, withUuid: true }))),
    );

    expect(res.isError).toBeFalsy();
    expect(fence).toBe(OPENED_UUID);
    expect(fence).not.toBe(PRIOR_UUID);
  });

  it("never attempts the workflow_list round trip for this path — it is refused by the exact wedge being escaped", async () => {
    await openWorkflow().handler(
      { path: TAB_TOKEN },
      ctxWith(bridgeFor(openReply({ routingKey: TAB_TOKEN, withUuid: true }))),
    );

    expect(sent.map((c) => c.cmd)).not.toContain("workflow_list");
  });

  it("adopts nothing when the reply carries no uuid — fail-closed is preserved", async () => {
    await openWorkflow().handler(
      { path: TAB_TOKEN },
      ctxWith(bridgeFor(openReply({ routingKey: TAB_TOKEN, withUuid: false }))),
    );

    expect(stamps).toEqual([]);
    expect(fence).toBe(PRIOR_UUID);
  });

  it("does not turn a wedged corroboration path into a failed open", async () => {
    const res = await openWorkflow().handler(
      { path: TAB_TOKEN },
      ctxWith(bridgeFor(openReply({ routingKey: TAB_TOKEN, withUuid: true }))),
    );

    expect(res.isError).toBeFalsy();
  });
});

describe("#812 safety — a mismatched or malformed token adopts nothing", () => {
  it("adopts nothing when the reply names a DIFFERENT unsaved tab (another tab raced in)", async () => {
    const res = await openWorkflow().handler(
      { path: TAB_TOKEN },
      ctxWith(bridgeFor(openReply({ routingKey: OTHER_TAB_TOKEN, withUuid: true }))),
    );

    expect(res.isError).toBeFalsy(); // the open itself still succeeded and is reported as such
    expect(stamps).toEqual([]);
    expect(fence).toBe(PRIOR_UUID);
  });

  it("rejects a malformed uuid suffix even if it literal-string-matches the reply", async () => {
    const bogus = "tmp:not-a-real-uuid";
    await openWorkflow().handler(
      { path: bogus },
      ctxWith(bridgeFor(openReply({ routingKey: bogus, withUuid: true }))),
    );

    expect(stamps).toEqual([]);
    expect(fence).toBe(PRIOR_UUID);
  });

  it("does not treat a bare 'tmp:' prefix with no suffix as a match", async () => {
    await openWorkflow().handler(
      { path: "tmp:" },
      ctxWith(bridgeFor(openReply({ routingKey: "tmp:", withUuid: true }))),
    );

    expect(stamps).toEqual([]);
  });

  it("still refuses a caller-typed BASENAME or non-canonical string (#716 P1 territory, untouched)", async () => {
    // Not a tmp: token and not a slash-containing saved path — the pre-existing
    // saved-path gate already rejects this; confirms the new branch does not
    // accidentally widen it.
    await openWorkflow().handler(
      { path: "foo.json" },
      ctxWith(bridgeFor(openReply({ routingKey: TAB_TOKEN, withUuid: true }))),
    );

    expect(stamps).toEqual([]);
  });
});

describe("#812 end to end — the reporter's exact sequence", () => {
  it("panel_new_workflow leaves the session wedged, then opening its OWN routing_key recovers it", async () => {
    // Step 1: workflow_new (not exercised here directly — its own #932 refresh
    // path is covered elsewhere) leaves the session fenced to the prior instance,
    // exactly as #812 reports: "still fenced to the previous workflow instance."
    expect(fence).toBe(PRIOR_UUID);

    // Step 2: the reporter's own diagnosed recovery — reopen the tab by its
    // returned routing_key.
    const res = await openWorkflow().handler(
      { path: TAB_TOKEN },
      ctxWith(bridgeFor(openReply({ routingKey: TAB_TOKEN, withUuid: true }))),
    );

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBeTruthy();
    // The fence is now the NEW tab's instance — every subsequent panel_* call
    // this session sends will carry the correct stamp.
    expect(fence).toBe(OPENED_UUID);
  });
});

describe("#2477 nested opened.routing_key is still unsaved-target proof", () => {
  it("adopts the reply uuid when routing_key lives only under opened", async () => {
    const res = await openWorkflow().handler(
      { path: TAB_TOKEN },
      ctxWith(bridgeFor(openReply({ routingKey: TAB_TOKEN, withUuid: true, nestRoutingKey: true }))),
    );

    expect(res.isError).toBeFalsy();
    expect(fence).toBe(OPENED_UUID);
    expect(sent.map((c) => c.cmd)).not.toContain("workflow_list");
  });

  it("does not reject a proven tmp: open as an unresolved filename when opened.path looks saved", async () => {
    // Reporter shape: workflow_open applied, routing_key only under opened, and
    // opened.path is the live synthetic unsaved path. The #1639 filename-alias
    // guard then asked workflow_list, whose unsaved active record has no
    // canonical saved identity, and the tool failed with UNKNOWN canvas.
    const list = {
      active_confirmed: true,
      active: {
        path: null,
        filename: null,
        title: "Unsaved Workflow",
        routing_key: TAB_TOKEN,
        workflow_uuid: OPENED_UUID,
      },
    };
    const res = await openWorkflow().handler(
      { path: TAB_TOKEN },
      ctxWith(
        bridgeFor(
          openReply({
            routingKey: TAB_TOKEN,
            withUuid: true,
            nestRoutingKey: true,
            openedPath: "workflows/Unsaved Workflow.json",
          }),
          list,
        ),
      ),
    );

    expect(res.isError).toBeFalsy();
    expect(textOf(res)).not.toMatch(/unconfirmed active workflow after resolving this filename/i);
    expect(textOf(res)).not.toMatch(/active canvas is UNKNOWN/i);
    expect(fence).toBe(OPENED_UUID);
    expect(sent.map((c) => c.cmd)).not.toContain("workflow_list");
  });

  it("adopts nothing when the nested key names a different unsaved tab", async () => {
    const res = await openWorkflow().handler(
      { path: TAB_TOKEN },
      ctxWith(
        bridgeFor(openReply({ routingKey: OTHER_TAB_TOKEN, withUuid: true, nestRoutingKey: true })),
      ),
    );

    expect(res.isError).toBeFalsy();
    expect(stamps).toEqual([]);
    expect(fence).toBe(PRIOR_UUID);
  });
});
