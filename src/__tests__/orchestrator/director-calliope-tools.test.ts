import { describe, expect, it, vi } from "vitest";
import { buildDirectorToolDefs, DIRECTOR_TOOL_NAMES, probeCalliope } from "../../orchestrator/director-tools.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

// The Calliope tools are a MAPPING: (tool, action, args) -> one bridge frame the pane turns
// into a client call. A wrong namespace, op or argument order is a call that reaches the wrong
// endpoint, so the frames are pinned here, per action, against a fake ctx that records them.

type Frame = Record<string, unknown>;

function fakeCtx(reply: unknown = { ok: true, result: [] }) {
  const frames: Frame[] = [];
  const call = vi.fn(async (cmd: Frame): Promise<ToolResult> => {
    frames.push(cmd);
    return { content: [{ type: "text", text: JSON.stringify(reply) }] };
  });
  return { ctx: { call } as unknown as PanelToolCtx, frames };
}

const tool = (name: string) => {
  const def = buildDirectorToolDefs().find((d) => d.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
};

const run = async (name: string, args: Record<string, unknown>, reply?: unknown) => {
  const { ctx, frames } = fakeCtx(reply);
  const res = await tool(name).handler(args, ctx);
  return { res, frames };
};

/**
 * The same rig for an action that sends MORE THAN ONE frame, where the second frame's arguments
 * are read out of the first frame's reply. One fixed reply cannot express that: the create has to
 * answer with a row id and the patch with the patched row, and a test that fed both the same body
 * would pass even if the handler read the wrong one.
 */
function fakeCtxSeq(replyFor: (cmd: Frame) => unknown) {
  const frames: Frame[] = [];
  const call = vi.fn(async (cmd: Frame): Promise<ToolResult> => {
    frames.push(cmd);
    return { content: [{ type: "text", text: JSON.stringify(replyFor(cmd)) }] };
  });
  return { ctx: { call } as unknown as PanelToolCtx, frames };
}

const runSeq = async (name: string, args: Record<string, unknown>, replyFor: (cmd: Frame) => unknown) => {
  const { ctx, frames } = fakeCtxSeq(replyFor);
  const res = await tool(name).handler(args, ctx);
  const raw = (res.content[0] as { text?: string }).text ?? "";
  // A refusal is prose, not JSON — parse leniently so the refusal cases can use this rig too.
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* not JSON: the caller asserts on res.content instead */
  }
  return { res, frames, body };
};

/** An outline reply in the shape the pane sends it, with `cal-sc-<id>` node ids. */
const outlineWith = (nodes: Array<Record<string, unknown>>) => ({ ok: true, result: { nodes, edges: [] } });

describe("Calliope tools — every action maps to one client call through the pane", () => {
  it("all five are mounted with the director group, and the ledger names them", () => {
    for (const name of ["panel_director_project", "panel_director_story", "panel_director_scene", "panel_director_workflow", "panel_director_render"]) {
      expect(tool(name).mountGroup).toBe("director");
      expect(DIRECTOR_TOOL_NAMES).toContain(name);
    }
    expect(tool("panel_module").mountGroup).toBeUndefined();
    expect(DIRECTOR_TOOL_NAMES).toHaveLength(10);
  });

  it("project: create sends the body; open/current/refresh are editor commands, not client calls", async () => {
    expect((await run("panel_director_project", { action: "create", title: "Film", genre: "thriller" })).frames).toEqual([
      { cmd: "director_calliope", ns: "projects", op: "create", args: [{ title: "Film", genre: "thriller" }] },
    ]);
    expect((await run("panel_director_project", { action: "open", project_id: 7 })).frames).toEqual([{ cmd: "director_project_open", project_id: 7 }]);
    expect((await run("panel_director_project", { action: "current" })).frames).toEqual([{ cmd: "director_project_current" }]);
    expect((await run("panel_director_project", { action: "refresh" })).frames).toEqual([{ cmd: "director_project_refresh" }]);
    expect((await run("panel_director_project", { action: "settings_set", settings: { dry_run: true } })).frames).toEqual([
      { cmd: "director_calliope", ns: "settings", op: "set", args: [{ dry_run: true }] },
    ]);
  });

  it("story: entity_verb becomes the nested client op with (project, id, body) in that order", async () => {
    expect((await run("panel_director_story", { action: "character_update", project_id: 1, id: 4, name: "Nadia", role: "lead" })).frames).toEqual([
      { cmd: "director_calliope", ns: "story", op: "character.patch", args: [1, 4, { name: "Nadia", role: "lead" }] },
    ]);
    expect((await run("panel_director_story", { action: "beat_add", project_id: 1, title: "Beat 3", order_index: 2 })).frames).toEqual([
      { cmd: "director_calliope", ns: "story", op: "beat.create", args: [1, { title: "Beat 3", order_index: 2 }] },
    ]);
    expect((await run("panel_director_story", { action: "location_delete", project_id: 1, id: 9 })).frames).toEqual([
      { cmd: "director_calliope", ns: "story", op: "location.delete", args: [1, 9] },
    ]);
    expect((await run("panel_director_story", { action: "read", project_id: 1 })).frames).toEqual([{ cmd: "director_calliope", ns: "story", op: "get", args: [1] }]);
  });

  it("scene: action_text lands as Calliope's `action`; reorder wraps scene_ids; set_prompt is the editor's hashed draft", async () => {
    expect((await run("panel_director_scene", { action: "patch", project_id: 1, scene_id: 2, action_text: "She looks down.", chain_from_prev: true })).frames).toEqual([
      { cmd: "director_calliope", ns: "scenes", op: "patch", args: [1, 2, { chain_from_prev: true, action: "She looks down." }] },
    ]);
    expect((await run("panel_director_scene", { action: "reorder", project_id: 1, scene_ids: [3, 1, 2] })).frames).toEqual([
      { cmd: "director_calliope", ns: "scenes", op: "reorder", args: [1, { scene_ids: [3, 1, 2] }] },
    ]);
    expect((await run("panel_director_scene", { action: "set_prompt", project_id: 1, scene_id: 2, prompt: "Rooftop, night." })).frames).toEqual([
      { cmd: "director_scene_set_prompt", project_id: 1, scene_id: 2, prompt: "Rooftop, night." },
    ]);
  });

  it("render: videos_generate carries explicit prompts — the surest way to keep Calliope's model out of the loop", async () => {
    // Two frames now: the bypass check reads the outline first (nothing bypassed here), then enqueues.
    expect((await run("panel_director_render", { action: "videos_generate", project_id: 1, scene_ids: [1, 2], prompts: { "1": "a", "2": "b" } })).frames).toEqual([
      { cmd: "director_outline" },
      { cmd: "director_calliope", ns: "jobs", op: "generateVideos", args: [1, { scene_ids: [1, 2], prompts: { "1": "a", "2": "b" } }] },
    ]);
    expect((await run("panel_director_render", { action: "export", project_id: 1 })).frames).toEqual([{ cmd: "director_calliope", ns: "jobs", op: "exportFilm", args: [1] }]);
    expect((await run("panel_director_render", { action: "attach", path: "/x.png", project_id: 1, target: "character_sheet", character_id: 3 })).frames).toEqual([
      { cmd: "director_calliope", ns: "playground", op: "attach", args: [{ path: "/x.png", project_id: 1, target: "character_sheet", character_id: 3 }] },
    ]);
  });

  it("render.wait returns as soon as no job is active, reading the list out of the wrapped reply", async () => {
    const { res, frames } = await run("panel_director_render", { action: "wait", project_id: 1, timeout_s: 5 }, { ok: true, result: [{ id: 1, status: "completed" }, { id: 2, status: "failed" }] });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ cmd: "director_calliope", ns: "jobs", op: "list" });
    const body = JSON.parse((res.content[0] as { text: string }).text);
    expect(body.settled).toBe(true);
    expect(body.jobs).toHaveLength(2);
  });

  it("a missing required field is refused before any frame is sent", async () => {
    for (const [name, args] of [
      ["panel_director_project", { action: "open" }],
      ["panel_director_story", { action: "beat_update", project_id: 1 }],
      ["panel_director_scene", { action: "set_prompt", project_id: 1, scene_id: 2 }],
      ["panel_director_workflow", { action: "register", name: "x" }],
      ["panel_director_render", { action: "videos_generate", project_id: 1 }],
    ] as const) {
      const { res, frames } = await run(name, args as Record<string, unknown>);
      expect(res.isError, name).toBe(true);
      expect(frames, name).toHaveLength(0);
    }
  });
});

// U20 — the editor's drive vocabulary reaches the agent as ACTIONS, never as new tool names.
// The arg NAMES are frozen in ComfyUI_BenjiDirector/docs/drive-commands.md: a rename on either
// side is a command the editor does not recognise, and the panel answers "unknown cmd" rather
// than failing loudly at the call site. So every one is pinned frame-for-frame here.
describe("Director drive commands — one editor frame per action, with the frozen arg names", () => {
  it("graph: node chrome, clipboard, selection, notes, reroute and the inspector", async () => {
    const cases: Array<[Record<string, unknown>, Frame]> = [
      [{ action: "set_bypassed", id: "sc-01", bypassed: true }, { cmd: "director_set_bypassed", id: "sc-01", bypassed: true }],
      [{ action: "set_node_color", id: "sc-01", color: "#34d399" }, { cmd: "director_set_node_color", id: "sc-01", color: "#34d399" }],
      // null is a VALUE here (clear the tint), so it must survive `need` and reach the editor.
      [{ action: "set_node_color", id: "sc-01", color: null }, { cmd: "director_set_node_color", id: "sc-01", color: null }],
      [{ action: "set_node_collapsed", id: "sc-01", collapsed: true }, { cmd: "director_set_node_collapsed", id: "sc-01", collapsed: true }],
      [{ action: "duplicate", ids: ["sc-01", "sc-02"] }, { cmd: "director_duplicate", ids: ["sc-01", "sc-02"] }],
      // An EMPTY selection is the documented way to clear it, not a missing argument.
      [{ action: "select", ids: [] }, { cmd: "director_select", ids: [] }],
      [{ action: "fit_view" }, { cmd: "director_fit_view" }],
      [{ action: "fit_view", ids: ["sc-01"] }, { cmd: "director_fit_view", ids: ["sc-01"] }],
      [{ action: "add_note", x: 10, y: 20, text: "beat sheet" }, { cmd: "director_add_note", x: 10, y: 20, text: "beat sheet" }],
      [{ action: "set_note", id: "note-1", text: "rewrite" }, { cmd: "director_set_note", id: "note-1", text: "rewrite" }],
      [{ action: "reroute", edge_id: "e-7", x: 5, y: 6 }, { cmd: "director_reroute", edge_id: "e-7", x: 5, y: 6 }],
      [{ action: "inspect", id: "sc-01" }, { cmd: "director_inspect", id: "sc-01" }],
    ];
    for (const [args, frame] of cases) {
      expect((await run("panel_director_graph", args)).frames, String(args.action)).toEqual([frame]);
    }
  });

  it("graph: whole-graph persistence — export/import, named saves, clear and reset", async () => {
    const cases: Array<[Record<string, unknown>, Frame]> = [
      [{ action: "export_graph" }, { cmd: "director_export_graph" }],
      [{ action: "import_graph", json: '{"nodes":[]}' }, { cmd: "director_import_graph", json: '{"nodes":[]}' }],
      [{ action: "save_named", name: "take-1" }, { cmd: "director_save_named", name: "take-1" }],
      [{ action: "load_named", name: "take-1" }, { cmd: "director_load_named", name: "take-1" }],
      [{ action: "list_saves" }, { cmd: "director_list_saves" }],
      [{ action: "delete_save", name: "take-1" }, { cmd: "director_delete_save", name: "take-1" }],
      [{ action: "clear" }, { cmd: "director_clear" }],
      [{ action: "reset_demo" }, { cmd: "director_reset_demo" }],
    ];
    for (const [args, frame] of cases) {
      expect((await run("panel_director_graph", args)).frames, String(args.action)).toEqual([frame]);
    }
  });

  it("subgraph: container deletion carries its mode, and a blueprint can be updated or dropped", async () => {
    const cases: Array<[Record<string, unknown>, Frame]> = [
      [{ action: "delete_container", id: "beat-1", mode: "all" }, { cmd: "director_delete_container", id: "beat-1", mode: "all" }],
      [{ action: "delete_container", id: "beat-1", mode: "shell" }, { cmd: "director_delete_container", id: "beat-1", mode: "shell" }],
      [{ action: "update_blueprint", blueprint_id: "bp-1", id: "beat-1" }, { cmd: "director_update_blueprint", blueprint_id: "bp-1", id: "beat-1" }],
      [{ action: "update_blueprint", blueprint_id: "bp-1" }, { cmd: "director_update_blueprint", blueprint_id: "bp-1" }],
      [{ action: "delete_blueprint", blueprint_id: "bp-1" }, { cmd: "director_delete_blueprint", blueprint_id: "bp-1" }],
    ];
    for (const [args, frame] of cases) {
      expect((await run("panel_director_subgraph", args)).frames, String(args.action)).toEqual([frame]);
    }
  });

  it("render: the playground's own jobs, and the composer on one scene", async () => {
    // `playground.jobs(limit = 50)` takes a POSITIONAL scalar: an omitted limit must be an
    // ABSENT argument, not `undefined` or a query object, or the client's default never applies.
    expect((await run("panel_director_render", { action: "playground_jobs" })).frames).toEqual([{ cmd: "director_calliope", ns: "playground", op: "jobs", args: [] }]);
    expect((await run("panel_director_render", { action: "playground_jobs", limit: 5 })).frames).toEqual([{ cmd: "director_calliope", ns: "playground", op: "jobs", args: [5] }]);
    expect((await run("panel_director_render", { action: "playground_delete", job_id: 12 })).frames).toEqual([{ cmd: "director_calliope", ns: "playground", op: "deleteJob", args: [12] }]);
    // render_scene is an EDITOR command (it opens the composer), not a client call.
    expect((await run("panel_director_render", { action: "render_scene", scene_id: 4 })).frames).toEqual([{ cmd: "director_render_scene", scene_id: 4 }]);
  });

  it("render: attach without project_id is refused before any frame — the endpoint requires it", async () => {
    const { res, frames } = await run("panel_director_render", { action: "attach", path: "/x.png", target: "scene", scene_id: 2 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("project_id");
    expect(frames).toHaveLength(0);
  });

  it("project: set_cover clears with an EXPLICIT null, and never by omission", async () => {
    expect((await run("panel_director_project", { action: "set_cover", project_id: 3, cover_path: "/out/poster.png" })).frames).toEqual([
      { cmd: "director_calliope", ns: "projects", op: "patch", args: [3, { cover_path: "/out/poster.png" }] },
    ]);
    expect((await run("panel_director_project", { action: "set_cover", project_id: 3, cover_path: null })).frames).toEqual([
      { cmd: "director_calliope", ns: "projects", op: "patch", args: [3, { cover_path: null }] },
    ]);
    // Omitting cover_path is refused rather than treated as "clear it".
    const { res, frames } = await run("panel_director_project", { action: "set_cover", project_id: 3 });
    expect(res.isError).toBe(true);
    expect(frames).toHaveLength(0);
  });

  it("scene add: chain_from_prev is a SECOND frame — SceneCreate has no such field", async () => {
    const { frames, body } = await runSeq(
      "panel_director_scene",
      { action: "add", project_id: 1, heading: "SC-03 · Rooftop", duration_sec: 6, chain_from_prev: true },
      (cmd) => (cmd.op === "create" ? { id: 42, heading: "SC-03 · Rooftop" } : { id: 42, chain_from_prev: true }),
    );
    expect(frames).toEqual([
      // The create body must NOT carry chain_from_prev: the endpoint drops it silently, so a
      // one-frame version would report the flag set while Calliope stored nothing.
      { cmd: "director_calliope", ns: "scenes", op: "create", args: [1, { heading: "SC-03 · Rooftop", duration_sec: 6 }] },
      { cmd: "director_calliope", ns: "scenes", op: "patch", args: [1, 42, { chain_from_prev: true }] },
    ]);
    expect(body.scene_id).toBe(42);
    expect(body.chain_from_prev).toBe(true);
  });

  it("scene add: without chain_from_prev it stays ONE frame, and an id-less reply says the flag did not land", async () => {
    expect((await run("panel_director_scene", { action: "add", project_id: 1, heading: "SC-04" })).frames).toEqual([
      { cmd: "director_calliope", ns: "scenes", op: "create", args: [1, { heading: "SC-04" }] },
    ]);
    // A create reply the tool cannot read an id out of must SAY so — the alternative is a
    // scene that quietly is not chained and an agent that believes it is.
    const { res, frames } = await run("panel_director_scene", { action: "add", project_id: 1, heading: "SC-05", chain_from_prev: true }, { ok: true });
    expect(frames).toHaveLength(1);
    expect(res.content.map((c) => (c.type === "text" ? c.text : "")).join(" ")).toContain("chain_from_prev was NOT applied");
  });

  it("scene patch still sends chain_from_prev inline — only CREATE lacks the field", async () => {
    expect((await run("panel_director_scene", { action: "patch", project_id: 1, scene_id: 2, chain_from_prev: false })).frames).toEqual([
      { cmd: "director_calliope", ns: "scenes", op: "patch", args: [1, 2, { chain_from_prev: false }] },
    ]);
  });

  it("videos_generate drops the scenes whose node is bypassed, and names them in the reply", async () => {
    const { frames, body } = await runSeq(
      "panel_director_render",
      { action: "videos_generate", project_id: 1, scene_ids: [1, 2, 3] },
      (cmd) =>
        cmd.cmd === "director_outline"
          ? outlineWith([
              { id: "cal-sc-1", kind: "scene", bypassed: false },
              { id: "cal-sc-2", kind: "scene", bypassed: true },
              { id: "cal-sc-3", kind: "scene" },
              { id: "cal-beat-1", kind: "beat" },
            ])
          : { ok: true, jobs: [{ id: 9 }] },
    );
    expect(frames).toEqual([
      { cmd: "director_outline" },
      { cmd: "director_calliope", ns: "jobs", op: "generateVideos", args: [1, { scene_ids: [1, 3] }] },
    ]);
    expect(body.skipped_bypassed).toEqual([2]);
    expect(body.scene_ids).toEqual([1, 3]);
    // The queue's own answer survives the annotation.
    expect(body.result).toMatchObject({ ok: true });
  });

  it("skip_bypassed false renders exactly what was asked and never reads the outline", async () => {
    expect((await run("panel_director_render", { action: "videos_generate", project_id: 1, scene_ids: [1, 2], skip_bypassed: false })).frames).toEqual([
      { cmd: "director_calliope", ns: "jobs", op: "generateVideos", args: [1, { scene_ids: [1, 2] }] },
    ]);
  });

  it("every scene bypassed is a REFUSAL, not an empty enqueue", async () => {
    const { res, frames } = await runSeq("panel_director_render", { action: "videos_generate", project_id: 1, scene_ids: [2] }, () =>
      outlineWith([{ id: "cal-sc-2", kind: "scene", bypassed: true }]),
    );
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("bypassed");
    // Only the outline read went out: nothing was queued.
    expect(frames).toEqual([{ cmd: "director_outline" }]);
  });

  it("an unreadable outline still renders, and says the bypass check did not run", async () => {
    const frames: Frame[] = [];
    const call = vi.fn(async (cmd: Frame): Promise<ToolResult> => {
      frames.push(cmd);
      return cmd.cmd === "director_outline"
        ? { content: [{ type: "text", text: "no connected tab" }], isError: true }
        : { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    });
    const res = await tool("panel_director_render").handler({ action: "videos_generate", project_id: 1, scene_ids: [1, 2] }, { call } as unknown as PanelToolCtx);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ cmd: "director_calliope", ns: "jobs", op: "generateVideos", args: [1, { scene_ids: [1, 2] }] });
    expect((res.content[0] as { text: string }).text).toContain("bypass_check");
  });

  it("a missing required field on a NEW action is refused before any frame is sent", async () => {
    for (const [name, args] of [
      ["panel_director_graph", { action: "set_bypassed", id: "sc-01" }],
      ["panel_director_graph", { action: "set_node_color", id: "sc-01" }],
      ["panel_director_graph", { action: "duplicate" }],
      ["panel_director_graph", { action: "select" }],
      ["panel_director_graph", { action: "add_note", x: 1, y: 2 }],
      ["panel_director_graph", { action: "set_note", id: "note-1" }],
      ["panel_director_graph", { action: "reroute", edge_id: "e-1", x: 1 }],
      ["panel_director_graph", { action: "inspect" }],
      ["panel_director_graph", { action: "import_graph" }],
      ["panel_director_graph", { action: "save_named" }],
      ["panel_director_subgraph", { action: "delete_container", id: "beat-1" }],
      ["panel_director_subgraph", { action: "update_blueprint", id: "beat-1" }],
      ["panel_director_subgraph", { action: "delete_blueprint" }],
      ["panel_director_render", { action: "render_scene" }],
      ["panel_director_render", { action: "playground_delete" }],
    ] as const) {
      const { res, frames } = await run(name, args as Record<string, unknown>);
      expect(res.isError, `${name} ${String((args as Record<string, unknown>).action)}`).toBe(true);
      expect(frames, `${name} ${String((args as Record<string, unknown>).action)}`).toHaveLength(0);
    }
  });

  it("adds ACTIONS only — the tool vocabulary is still the same ten names", () => {
    expect(DIRECTOR_TOOL_NAMES).toHaveLength(10);
    expect(buildDirectorToolDefs().map((d) => d.name).sort()).toEqual([...DIRECTOR_TOOL_NAMES].sort());
  });
});

describe("probeCalliope — the status probe is bounded and never throws", () => {
  it("reports version and dry_run from /api/health", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("http://127.0.0.1:8247/api/health");
      return new Response(JSON.stringify({ status: "ok", version: "1.2.1", dry_run: false }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await probeCalliope("http://127.0.0.1:8247/", fetchImpl)).toEqual({ reachable: true, base_url: "http://127.0.0.1:8247", version: "1.2.1", dry_run: false });
  });

  it("a refused connection or a non-2xx is 'not reachable', with the reason", async () => {
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await probeCalliope("http://127.0.0.1:1", down)).toMatchObject({ reachable: false, error: "ECONNREFUSED" });
    const sad = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    expect(await probeCalliope("http://127.0.0.1:1", sad)).toMatchObject({ reachable: false, error: "HTTP 503" });
  });

  it("a backend that hangs reads as unreachable within the budget", async () => {
    const hang = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    const started = Date.now();
    const out = await probeCalliope("http://127.0.0.1:1", hang, 50);
    expect(out.reachable).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
