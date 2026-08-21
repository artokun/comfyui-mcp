// #1968 — four panel_* tools rejected an agent's obvious first call.
//
// The premise from the report: if a capable model calls a tool with the obvious
// argument and gets a validation error, that is a naming/schema defect, not a
// caller error. The first guess is drawn from the tool's own name plus the
// conventions of its siblings.
//
// EVERY failure in that report was a ZOD failure, at the protocol boundary,
// before any handler ran. So these tests parse through `strictPanelSchema` — the
// exact validator both transports install (`strictPanelSchema(d.schema)` at the
// Anthropic `tool()` call site and at `server.registerTool`) — and only then call
// the handler with what came out. Calling `d.handler(args, ctx)` directly, as the
// older panel tests do, would exercise a path the reporter never reached and
// would pass just as happily with every alias deleted.

import { beforeEach, describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  strictPanelSchema,
  type PanelToolCtx,
} from "../../orchestrator/panel-tools.js";
import { __resetTodoState, todoFor } from "../../orchestrator/todo-state.js";
import { QUEUE_BUSY_READ_TOOLS } from "../../services/panel-graph-cmd-tools.js";
import { GRAPH_CMD_EFFECT } from "../../services/ui-bridge.js";

type Cmd = Record<string, unknown>;

/** Replies the fake bridge hands back, keyed by command name. */
type Replies = Record<string, unknown | ((cmd: Cmd) => unknown)>;

function harness(replies: Replies = {}) {
  const sent: Cmd[] = [];
  const bridge = {
    send: async (cmd: Cmd) => {
      sent.push(cmd);
      const name = String(cmd.cmd);
      const reply = replies[name];
      if (typeof reply === "function") return (reply as (c: Cmd) => unknown)(cmd);
      return reply ?? { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: "tab-1", title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => "tab-1",
  } as unknown as PanelToolCtx["bridge"];
  return { sent, ctx: makePanelToolCtx(bridge, "tab-1") };
}

const defOf = (name: string) => buildPanelToolDefs().find((d) => d.name === name)!;

/** Parse args the way the MCP boundary does, then run the handler on the parsed
 *  result. Throws on a validation failure — which is the reporter's failure. */
async function callTool(name: string, args: Cmd, ctx: PanelToolCtx) {
  const def = defOf(name);
  const parsed = strictPanelSchema(def.schema).parse(args) as Cmd;
  return def.handler(parsed, ctx);
}

/** Did the strict schema ACCEPT these args at all? */
function accepts(name: string, args: Cmd): boolean {
  return strictPanelSchema(defOf(name).schema).safeParse(args).success;
}

function payloadOf(res: { content: Array<{ type: string; text?: string }> }) {
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// panel_remove_group — `{group: 2}` was rejected with unrecognized_keys
// ---------------------------------------------------------------------------

describe("#1968 panel_remove_group: `group` is the same argument as `group_id`", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  // The exact call from the report. It failed with `unrecognized_keys: ["group"]`
  // AND, separately, `expected number, received undefined` at `group_id` — both
  // halves of the answer in front of the caller, joined by neither.
  it("accepts the reported call and sends group_id on the wire", async () => {
    const res = await callTool("panel_remove_group", { group: 2 }, h.ctx);
    expect(res.isError).toBeFalsy();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ cmd: "graph_remove_group", group_id: 2 });
  });

  it("still accepts the canonical key, unchanged", async () => {
    await callTool("panel_remove_group", { group_id: 7 }, h.ctx);
    expect(h.sent[0]).toMatchObject({ cmd: "graph_remove_group", group_id: 7 });
  });

  // The panel's resolveGroup compares with a strict `===` against group.id and
  // its index fallback is guarded by `typeof groupId === "number"`, so a STRING
  // id on the wire misses a group that exists. The coercion is load-bearing, not
  // cosmetic — assert the wire type, not just the value.
  it("coerces a string id to the number the panel compares against", async () => {
    await callTool("panel_remove_group", { group: "2" }, h.ctx);
    expect(h.sent[0].group_id).toBe(2);
    expect(typeof h.sent[0].group_id).toBe("number");
  });

  it("coerces a string id given under the canonical key too", async () => {
    await callTool("panel_remove_group", { group_id: "11" }, h.ctx);
    expect(h.sent[0].group_id).toBe(11);
  });

  // Picking one would remove a group the caller did not name. A refusal costs a
  // round trip; a wrong removal costs the user their group box.
  it("REFUSES a conflicting pair instead of guessing, and sends nothing", async () => {
    const res = await callTool("panel_remove_group", { group_id: 2, group: 5 }, h.ctx);
    expect(res.isError).toBe(true);
    expect(h.sent).toHaveLength(0);
    const text = res.content.map((c) => c.text).join(" ");
    expect(text).toContain("group_id");
    expect(text).toContain("group");
  });

  // Belt-and-bracing both spellings with the SAME id is not ambiguous.
  it("accepts a matching pair", async () => {
    const res = await callTool("panel_remove_group", { group_id: 3, group: 3 }, h.ctx);
    expect(res.isError).toBeFalsy();
    expect(h.sent[0]).toMatchObject({ group_id: 3 });
  });

  it("refuses when neither is supplied, naming both spellings", async () => {
    const res = await callTool("panel_remove_group", {}, h.ctx);
    expect(res.isError).toBe(true);
    expect(h.sent).toHaveLength(0);
  });

  // A non-numeric group ref is still refused — the alias widens the SPELLING, not
  // the shape. `panel_subgraph_group` resolves a title; graph_remove_group cannot,
  // and admitting a title here would send the panel an id it throws on.
  it("does not admit a title string as a group id", () => {
    expect(accepts("panel_remove_group", { group: "REPLACEMENT MODE" })).toBe(false);
  });
});

// The report says edit/move already take `group`. They did not — only
// panel_subgraph_group does. The complaint behind the mistake is real either way:
// the group tools disagreed about what "the group" is called. Now they do not.
describe("#1968: every group tool accepts the same two spellings", () => {
  it("panel_edit_group takes `group`", async () => {
    const h = harness();
    const res = await callTool("panel_edit_group", { group: "4", title: "renamed" }, h.ctx);
    expect(res.isError).toBeFalsy();
    expect(h.sent[0]).toMatchObject({ cmd: "graph_edit_group", group_id: 4, title: "renamed" });
  });

  it("panel_move_group takes `group`", async () => {
    const h = harness();
    const res = await callTool("panel_move_group", { group: 4, pos: [10, 20] }, h.ctx);
    expect(res.isError).toBeFalsy();
    expect(h.sent[0]).toMatchObject({ cmd: "graph_move_group", group_id: 4 });
  });

  it("panel_move_group still refuses a conflicting pair", async () => {
    const h = harness();
    const res = await callTool("panel_move_group", { group_id: 1, group: 2, pos: [0, 0] }, h.ctx);
    expect(res.isError).toBe(true);
    expect(h.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// panel_set_todo — `{todos:[{content, status}]}` failed TWICE
// ---------------------------------------------------------------------------

describe("#1968 panel_set_todo: `todos` and `content` land on the first call", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    __resetTodoState();
    h = harness();
  });

  // The reporter's call failed, was corrected on the key the error named, and
  // then failed AGAIN on a second key. One misnamed pair, two round trips.
  it("accepts the exact reported payload — both aliases at once", async () => {
    const res = await callTool(
      "panel_set_todo",
      {
        todos: [
          { content: "read the code", status: "done" },
          { content: "write the fix", status: "in_progress" },
        ],
      },
      h.ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ cmd: "set_todo" });
    expect(h.sent[0].items).toEqual([
      { text: "read the code", status: "done" },
      // #1018's status normalization still runs, on the aliased payload.
      { text: "write the fix", status: "active" },
    ]);
  });

  it("never puts an alias key on the wire", async () => {
    await callTool("panel_set_todo", { todos: [{ content: "a" }] }, h.ctx);
    const wire = JSON.stringify(h.sent[0]);
    expect(wire).not.toContain("content");
    expect(wire).not.toContain("todos");
  });

  // #977's snapshot feeds the completion-directive logic, which reads `text`.
  it("records the canonical shape in the orchestrator's own snapshot", async () => {
    await callTool("panel_set_todo", { todos: [{ content: "a", status: "queued" }] }, h.ctx);
    expect(todoFor("tab-1")?.items).toEqual([{ text: "a", status: "pending" }]);
  });

  it("still accepts the canonical spelling, unchanged", async () => {
    await callTool("panel_set_todo", { items: [{ text: "a", status: "active" }] }, h.ctx);
    expect(h.sent[0].items).toEqual([{ text: "a", status: "active" }]);
  });

  it("accepts the two spellings MIXED across items", async () => {
    await callTool("panel_set_todo", { items: [{ text: "a" }, { content: "b" }] }, h.ctx);
    expect(h.sent[0].items).toEqual([{ text: "a" }, { text: "b" }]);
  });

  it("an empty list still clears the tray", async () => {
    const res = await callTool("panel_set_todo", { todos: [] }, h.ctx);
    expect(res.isError).toBeFalsy();
    expect(h.sent[0].items).toEqual([]);
  });

  // Optional-in-the-schema must not become optional-in-effect. `text` is only
  // optional so `content` can stand in for it; an item with NEITHER is a step
  // with no description and is still refused, by name.
  it("REFUSES an item carrying neither text nor content", async () => {
    const res = await callTool("panel_set_todo", { todos: [{ status: "active" }] }, h.ctx);
    expect(res.isError).toBe(true);
    expect(h.sent).toHaveLength(0);
    expect(res.content.map((c) => c.text).join(" ")).toContain("text");
  });

  it("REFUSES a call with neither items nor todos", async () => {
    const res = await callTool("panel_set_todo", {}, h.ctx);
    expect(res.isError).toBe(true);
    expect(h.sent).toHaveLength(0);
  });

  it("REFUSES two different checklists rather than choosing one", async () => {
    const res = await callTool(
      "panel_set_todo",
      { items: [{ text: "a" }], todos: [{ text: "b" }] },
      h.ctx,
    );
    expect(res.isError).toBe(true);
    expect(h.sent).toHaveLength(0);
  });

  it("accepts two IDENTICAL checklists — that is not ambiguous", async () => {
    const res = await callTool(
      "panel_set_todo",
      { items: [{ text: "a" }], todos: [{ text: "a" }] },
      h.ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(h.sent[0].items).toEqual([{ text: "a" }]);
  });

  it("REFUSES an item that gives text and content different values", async () => {
    const res = await callTool(
      "panel_set_todo",
      { items: [{ text: "a", content: "b" }] },
      h.ctx,
    );
    expect(res.isError).toBe(true);
    expect(h.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// panel_show_media — the tool's OWN prose describes the shape it rejected
// ---------------------------------------------------------------------------

describe("#1968 panel_show_media: the output ref is accepted where the docs put it", () => {
  const REF = { filename: "ComfyUI_00042_.png", subfolder: "", type: "output" };

  // The description says: "pass the output ref {filename, subfolder, type}".
  // That is exactly what the reporter passed. The schema wanted it under `source`.
  it("accepts a FLAT ComfyUI output ref at item level", async () => {
    const h = harness();
    const res = await callTool(
      "panel_show_media",
      { items: [{ ...REF, caption: "the render" }] },
      h.ctx,
    );
    expect(res.isError).toBeFalsy();
    const sent = h.sent.find((c) => c.cmd === "show_media");
    expect(sent).toBeDefined();
    expect((sent!.items as Cmd[])[0]).toMatchObject({ caption: "the render" });
  });

  it("still accepts the canonical nested `source`", async () => {
    const h = harness();
    const res = await callTool("panel_show_media", { items: [{ source: REF }] }, h.ctx);
    expect(res.isError).toBeFalsy();
    expect(h.sent.some((c) => c.cmd === "show_media")).toBe(true);
  });

  // `caption` was ALWAYS the key — the report's `label` row is the one that does
  // not reproduce. Accepted anyway: a caller who guessed it once will guess it
  // again, and zod STRIPS an unknown key from a nested object rather than
  // refusing it, so the media would have rendered captionless with no error.
  it("accepts `label` and puts it on the wire as caption", async () => {
    const h = harness();
    await callTool("panel_show_media", { items: [{ ...REF, label: "a name" }] }, h.ctx);
    const sent = h.sent.find((c) => c.cmd === "show_media")!;
    expect((sent.items as Cmd[])[0]).toMatchObject({ caption: "a name" });
    expect(JSON.stringify(sent)).not.toContain("label");
  });

  it("REFUSES an item naming its media twice", async () => {
    const h = harness();
    const res = await callTool(
      "panel_show_media",
      { items: [{ source: REF, filename: "other.png" }] },
      h.ctx,
    );
    expect(res.isError).toBe(true);
    expect(h.sent.some((c) => c.cmd === "show_media")).toBe(false);
  });

  it("REFUSES an item with caption and label disagreeing", async () => {
    const h = harness();
    const res = await callTool(
      "panel_show_media",
      { items: [{ ...REF, caption: "a", label: "b" }] },
      h.ctx,
    );
    expect(res.isError).toBe(true);
  });

  // An item with no media at all used to reach `"path" in src` on undefined and
  // throw a TypeError — a caller's misnamed key surfacing as a crash.
  it("REFUSES an item with no media, in a sentence rather than a crash", async () => {
    const h = harness();
    const res = await callTool("panel_show_media", { items: [{ caption: "nothing" }] }, h.ctx);
    expect(res.isError).toBe(true);
    const text = res.content.map((c) => c.text).join(" ");
    expect(text).toContain("filename");
  });
});

// ---------------------------------------------------------------------------
// panel_create_subgraph — `title` accepted AND applied
// ---------------------------------------------------------------------------

describe("#1968 panel_create_subgraph: `title` is accepted and actually applied", () => {
  const created = { subgraph: { node_id: 31, name: "New Subgraph", from_nodes: [1, 2] } };

  // The whole point. The panel's graph_create_subgraph destructures only
  // { node_ids }, so a forwarded title would be dropped on arrival — accepted on
  // the wire, done by nobody. It is applied as a second command instead.
  it("issues graph_set_title against the id the conversion returned", async () => {
    const h = harness({ graph_create_subgraph: created });
    const res = await callTool(
      "panel_create_subgraph",
      { node_ids: [1, 2], title: "Upscale stage" },
      h.ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(h.sent.map((c) => c.cmd)).toEqual(["graph_create_subgraph", "graph_set_title"]);
    expect(h.sent[1]).toMatchObject({ node_id: 31, title: "Upscale stage" });
    // …and the caller reads back the name it asked for, not the default.
    expect(payloadOf(res)).toMatchObject({ subgraph: { node_id: 31, title: "Upscale stage" } });
  });

  // A title must never become a second mutation nobody asked for.
  it("sends NO rename when no title was given", async () => {
    const h = harness({ graph_create_subgraph: created });
    await callTool("panel_create_subgraph", { node_ids: [1, 2] }, h.ctx);
    expect(h.sent.map((c) => c.cmd)).toEqual(["graph_create_subgraph"]);
  });

  it("does not forward `title` on the creation command itself", async () => {
    const h = harness({ graph_create_subgraph: created });
    await callTool("panel_create_subgraph", { node_ids: [1], title: "X" }, h.ctx);
    expect(h.sent[0].title).toBeUndefined();
  });

  // Two mutations where the caller wrote one. The subgraph exists whatever
  // happens next, so a failed rename may report neither "created and named" nor
  // "failed" — both would send the caller looking for the wrong thing.
  it("reports the subgraph as CREATED but UNNAMED when the rename fails", async () => {
    const h = harness({
      graph_create_subgraph: created,
      graph_set_title: () => {
        throw new Error("workflow instance mismatch");
      },
    });
    const res = await callTool(
      "panel_create_subgraph",
      { node_ids: [1, 2], title: "Upscale stage" },
      h.ctx,
    );
    // NOT an error: the thing the caller asked to be created is on the canvas.
    expect(res.isError).toBeFalsy();
    const text = res.content.map((c) => c.text).join(" ");
    expect(text).toContain("NOT applied");
    expect(text).toContain("31");
    // The creation payload survives intact — the node id is what the caller needs.
    expect(payloadOf(res)).toMatchObject({ subgraph: { node_id: 31 } });
    // …and it must NOT claim the title landed.
    expect(payloadOf(res).subgraph).not.toMatchObject({ title: "Upscale stage" });
  });

  // Renaming a guessed id would retitle a node the caller never mentioned.
  it("does not rename anything when the reply carries no node_id", async () => {
    const h = harness({ graph_create_subgraph: { subgraph: { name: "New Subgraph" } } });
    const res = await callTool("panel_create_subgraph", { node_ids: [1], title: "X" }, h.ctx);
    expect(h.sent.map((c) => c.cmd)).toEqual(["graph_create_subgraph"]);
    expect(res.content.map((c) => c.text).join(" ")).toContain("NOT applied");
  });

  // Nothing landed — there is no node to name, and the creation's own error is
  // the whole story.
  it("passes a failed creation straight through, with no title note", async () => {
    const h = harness({
      graph_create_subgraph: () => {
        throw new Error("convertToSubgraph unavailable on this frontend");
      },
    });
    const res = await callTool("panel_create_subgraph", { node_ids: [1], title: "X" }, h.ctx);
    expect(res.isError).toBe(true);
    expect(h.sent.map((c) => c.cmd)).toEqual(["graph_create_subgraph"]);
    expect(res.content.map((c) => c.text).join(" ")).not.toContain("NOT applied");
  });
});

// ---------------------------------------------------------------------------
// panel_find_nodes — a search was the most expensive read on the surface
// ---------------------------------------------------------------------------

describe("#1968 panel_find_nodes: `fields` bounds what a lookup costs", () => {
  const MATCH = {
    id: "12",
    type: "KSampler",
    title: "sampler",
    mode: 0,
    is_output: false,
    is_subgraph: false,
    matched_on: ["type:KSampler"],
    widgets: { seed: 12345, steps: 20, cfg: 8, sampler_name: "euler", scheduler: "normal" },
    inputs: [{ name: "model", type: "MODEL", connected_from: "4.MODEL" }],
    outputs: [{ name: "LATENT", type: "LATENT" }],
    description: "Uses the provided model and noise to denoise the latent.",
  };
  const reply = { viewing: "wf", total: 10, count: 1, truncated: false, matches: [MATCH] };

  it("defaults to compact and drops the bulk", async () => {
    const h = harness({ graph_find_nodes: reply });
    const res = await callTool("panel_find_nodes", { query: "sampler" }, h.ctx);
    const out = payloadOf(res);
    const match = (out.matches as Cmd[])[0];
    expect(match).toEqual({
      id: "12",
      type: "KSampler",
      title: "sampler",
      mode: 0,
      is_output: false,
      is_subgraph: false,
      matched_on: ["type:KSampler"],
    });
    // The reply says which projection it applied — a caller must never have to
    // infer from absent keys whether a node has no widgets or they were dropped.
    expect(out.fields).toBe("compact");
    // Everything that is not per-node bulk survives.
    expect(out).toMatchObject({ viewing: "wf", total: 10, count: 1 });
  });

  it("`detail` returns the full row, byte for byte", async () => {
    const h = harness({ graph_find_nodes: reply });
    const res = await callTool("panel_find_nodes", { query: "sampler", fields: "detail" }, h.ctx);
    const out = payloadOf(res);
    expect((out.matches as Cmd[])[0]).toEqual(MATCH);
    // detail is a no-op, so it does not stamp a marker either.
    expect(out.fields).toBeUndefined();
  });

  it("`ids` returns bare ids", async () => {
    const h = harness({ graph_find_nodes: reply });
    const res = await callTool("panel_find_nodes", { query: "sampler", fields: "ids" }, h.ctx);
    const out = payloadOf(res);
    expect(out.matches).toEqual(["12"]);
    expect(out.fields).toBe("ids");
  });

  it("is a real saving, not a rearrangement", async () => {
    const h = harness({ graph_find_nodes: reply });
    const compact = await callTool("panel_find_nodes", { query: "s" }, h.ctx);
    const detail = await callTool("panel_find_nodes", { query: "s", fields: "detail" }, h.ctx);
    const size = (r: { content: Array<{ text?: string }> }) =>
      r.content.map((c) => c.text ?? "").join("").length;
    expect(size(compact)).toBeLessThan(size(detail) / 2);
  });

  // The projection must not eat #809's truncation contract: that hint is computed
  // from the match count, so it has to be decided BEFORE rows are dropped.
  it("keeps the truncation hint, computed against the real match count", async () => {
    const h = harness({
      graph_find_nodes: { ...reply, truncated: true, matches: [MATCH] },
    });
    const res = await callTool("panel_find_nodes", { query: "s", fields: "ids" }, h.ctx);
    const out = payloadOf(res);
    expect(out.truncated).toBe(true);
    expect(String(out.truncation_hint)).toContain("1 match");
  });

  // A panel that answers in a shape this process cannot read must not be told it
  // was projected — that marker is the caller's only evidence, and a false one is
  // worse than none.
  it("does NOT stamp `fields` on a payload it could not project", async () => {
    const h = harness({ graph_find_nodes: { viewing: "wf", note: "old panel" } });
    const res = await callTool("panel_find_nodes", { query: "s" }, h.ctx);
    expect(payloadOf(res).fields).toBeUndefined();
  });

  it("does not send `fields` to a panel that has no such parameter", async () => {
    const h = harness({ graph_find_nodes: reply });
    await callTool("panel_find_nodes", { query: "s", fields: "ids" }, h.ctx);
    expect(h.sent[0].fields).toBeUndefined();
  });

  it("offers exactly the same three names as its sibling panel_query_graph", () => {
    const named = (tool: string) => {
      const shape = defOf(tool).schema as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
      return ["ids", "compact", "detail", "nonsense"].filter((v) => shape.fields.safeParse(v).success);
    };
    expect(named("panel_find_nodes")).toEqual(["ids", "compact", "detail"]);
    expect(named("panel_find_nodes")).toEqual(named("panel_query_graph"));
  });
});

// ---------------------------------------------------------------------------
// The fence advertisement — the half of the report's item 5 that is real
// ---------------------------------------------------------------------------

describe("#1968: the QUEUE BUSY refusal advertises every graph read it lets through", () => {
  // graph_find_nodes has been `inert` since #778, so this fence has ALWAYS let it
  // past — it was simply never named. The report read the short list and drew the
  // documented conclusion: "find_nodes is not among them".
  it("panel_find_nodes is in the advertised set", () => {
    expect(QUEUE_BUSY_READ_TOOLS).toContain("panel_find_nodes");
  });

  it("every advertised tool is one the fence genuinely lets through", () => {
    const cmdFor: Record<string, string> = {
      panel_graph_outline: "graph_outline",
      panel_query_graph: "graph_query",
      panel_get_errors: "graph_get_errors",
      panel_find_nodes: "graph_find_nodes",
    };
    for (const tool of QUEUE_BUSY_READ_TOOLS) {
      const cmd = cmdFor[tool];
      expect(cmd, `${tool} needs a command mapping in this test`).toBeDefined();
      expect(GRAPH_CMD_EFFECT[cmd], tool).toBe("inert");
    }
  });

  // The list is only worth anything if the sentence a fenced caller reads carries
  // it. Asserting on the constant alone would stay green if the message were
  // rewritten with a hand-typed list beside it — the drift #1933 is the record of.
  it("the refusal a fenced write actually reads names it", async () => {
    const { QueueMonitor } = await import("../../services/queue-monitor.js");
    const snapshot = QueueMonitor.snapshot;
    QueueMonitor.snapshot = () => ({ running: 1, pending: 0 }) as ReturnType<typeof snapshot>;
    try {
      const h = harness();
      const res = await callTool("panel_remove_group", { group: 2 }, h.ctx);
      expect(res.isError).toBe(true);
      const text = res.content.map((c) => c.text).join(" ");
      expect(text).toContain("QUEUE BUSY");
      expect(text).toContain("panel_find_nodes");
      // Nothing was sent — the fence is still a fence.
      expect(h.sent).toHaveLength(0);
    } finally {
      QueueMonitor.snapshot = snapshot;
    }
  });
});
