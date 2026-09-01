import { describe, expect, it, vi } from "vitest";
import { buildDirectorToolDefs, DIRECTOR_TOOL_NAMES } from "../../orchestrator/director-tools.js";
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
    expect((await run("panel_director_render", { action: "videos_generate", project_id: 1, scene_ids: [1, 2], prompts: { "1": "a", "2": "b" } })).frames).toEqual([
      { cmd: "director_calliope", ns: "jobs", op: "generateVideos", args: [1, { scene_ids: [1, 2], prompts: { "1": "a", "2": "b" } }] },
    ]);
    expect((await run("panel_director_render", { action: "export", project_id: 1 })).frames).toEqual([{ cmd: "director_calliope", ns: "jobs", op: "exportFilm", args: [1] }]);
    expect((await run("panel_director_render", { action: "attach", path: "/x.png", target: "character", character_id: 3 })).frames).toEqual([
      { cmd: "director_calliope", ns: "playground", op: "attach", args: [{ path: "/x.png", target: "character", character_id: 3 }] },
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
