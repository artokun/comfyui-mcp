// #2541 — panel_graph_outline({ detail: "full" }) was rejected at the schema
// boundary before the handler ran.
//
// The outline result names its default rung `detail_level:"full"`, and the
// max_chars parameter description printed that as `(detail_level:"refused")` /
// "detail_level names the rung used". A Codex session read that as an input,
// called `{ detail: "full" }`, and got:
//
//   Unrecognized key 'detail' — accepted keys: 'max_chars'
//
// The call never reached graph_outline. `full` is already the default — the
// outline starts there and sheds rungs only to fit max_chars — so accepting
// the documented name lands the read. A test that calls `def.handler` directly
// would pass with the schema still rejecting the key: the reporter never
// reached the handler. Parse through `strictPanelSchema`, the validator both
// transports install.

import { beforeEach, describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  strictPanelSchema,
  type PanelToolCtx,
} from "../../orchestrator/panel-tools.js";

type Cmd = Record<string, unknown>;

const REPORTED = { detail: "full" } as const;

function defOf(name: string) {
  const def = buildPanelToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`${name} is not registered`);
  return def;
}

function harness() {
  const sent: Cmd[] = [];
  const bridge = {
    send: async (cmd: Cmd) => {
      sent.push(cmd);
      return {
        ok: true,
        outline: "1 KSampler",
        node_count: 1,
        group_count: 0,
        detail_level: "full",
        max_chars: 24000,
      };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: "tab-1", title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => "tab-1",
  } as PanelToolCtx["bridge"];
  return { sent, ctx: makePanelToolCtx(bridge, "tab-1") };
}

/** Parse args the way the MCP boundary does, then run the handler. */
async function callOutline(args: Cmd, ctx: PanelToolCtx) {
  const def = defOf("panel_graph_outline");
  const parsed = strictPanelSchema(def.schema).parse(args) as Cmd;
  return def.handler(parsed, ctx);
}

describe("#2541 panel_graph_outline accepts the documented detail argument", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("the reported call is a schema success, not unrecognized_keys", () => {
    const parsed = strictPanelSchema(defOf("panel_graph_outline").schema).safeParse(REPORTED);
    expect(parsed.success, "unfixed: Unrecognized key 'detail' — accepted keys: 'max_chars'").toBe(
      true,
    );
  });

  it("the reported call reaches graph_outline instead of dying at the boundary", async () => {
    const res = await callOutline({ ...REPORTED }, h.ctx);
    expect(res.isError).toBeFalsy();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ cmd: "graph_outline" });
    // The panel executor only takes max_chars. Forwarding `detail` would be a
    // no-op there and would look like a second lever this tool does not have.
    expect(h.sent[0]).not.toHaveProperty("detail");
  });

  it("still forwards max_chars when both are supplied", async () => {
    await callOutline({ detail: "full", max_chars: 4000 }, h.ctx);
    expect(h.sent[0]).toMatchObject({ cmd: "graph_outline", max_chars: 4000 });
    expect(h.sent[0]).not.toHaveProperty("detail");
  });

  it("the no-argument call still works", async () => {
    const parsed = strictPanelSchema(defOf("panel_graph_outline").schema).safeParse({});
    expect(parsed.success).toBe(true);
    await callOutline({}, h.ctx);
    expect(h.sent[0]).toMatchObject({ cmd: "graph_outline" });
  });

  it("does not treat a non-full rung name as a lever", () => {
    // `groups` is a RESULT rung the outline may degrade to. Accepting it as
    // input would document an unimplemented pin; the call must still name the
    // miss rather than silently return a full outline.
    const parsed = strictPanelSchema(defOf("panel_graph_outline").schema).safeParse({
      detail: "groups",
    });
    expect(parsed.success).toBe(false);
  });
});
