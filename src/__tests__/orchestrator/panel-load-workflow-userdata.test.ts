// panel_load_workflow — relative names resolve through the connected ComfyUI's
// userdata API when the guessed local disk path misses (#202).
//
// Root cause: comfyWorkflowsDirs() hardcodes COMFYUI_PATH/user/default/workflows
// (and user/workflows), so a ComfyUI launched with a CUSTOM --user-directory
// keeps its workflows somewhere the orchestrator can't guess — a relative
// panel_load_workflow name then fell through to a "no workflow file" error even
// though list_workflows/panel_open_workflow (which read the userdata API) could
// see it. readWorkflowFromPath now falls back to that same userdata API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub ONLY getClient so no real ComfyUI connection is attempted; every other
// client export keeps its real implementation (panel-tools' module graph uses
// several of them at import time).
const fetchApi = vi.fn();
vi.mock("../../comfyui/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/client.js")>();
  return {
    ...actual,
    getClient: () => ({ fetchApi: (...a: unknown[]) => fetchApi(...a) }),
  };
});

const { buildPanelToolDefs } = await import("../../orchestrator/panel-tools.js");
import type { PanelToolCtx } from "../../orchestrator/panel-tools.js";

type Forwarded = Record<string, unknown>;
function makeCtx(): { ctx: PanelToolCtx; calls: Forwarded[] } {
  const calls: Forwarded[] = [];
  const ctx = {
    call: async (cmd: Forwarded) => {
      calls.push(cmd);
      return { content: [{ type: "text", text: "ok" }] };
    },
    confirm: async () => true,
    bridge: { send: async (cmd: Forwarded) => { calls.push(cmd); return {}; } },
    tabId: "test-tab",
  } as unknown as PanelToolCtx;
  return { ctx, calls };
}

function loadWorkflow() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_load_workflow");
  if (!def) throw new Error("panel_load_workflow not found");
  return def;
}

let savedComfyPath: string | undefined;
beforeEach(() => {
  fetchApi.mockReset();
  savedComfyPath = process.env.COMFYUI_PATH;
  // No local COMFYUI_PATH → the guessed workflows dirs are empty, so a relative
  // name misses on disk and MUST fall through to the userdata API.
  delete process.env.COMFYUI_PATH;
});
afterEach(() => {
  if (savedComfyPath === undefined) delete process.env.COMFYUI_PATH;
  else process.env.COMFYUI_PATH = savedComfyPath;
});

describe("panel_load_workflow: userdata fallback for a custom --user-directory (#202)", () => {
  it("resolves a relative name via the userdata API and loads it onto the canvas", async () => {
    const graph = { nodes: [{ id: 1, type: "KSampler" }], links: [] };
    fetchApi.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(graph) });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler(
      { path: "722-gordo-10Eros_10SNodes_I2V_DMD_v1.json" },
      ctx,
    );

    expect(res.isError).toBeUndefined();
    // Fetched from the userdata library under the runtime user-directory.
    expect(fetchApi).toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/722-gordo-10Eros_10SNodes_I2V_DMD_v1.json")}`,
    );
    // And the fetched graph was dropped on the canvas.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cmd: "graph_load" });
    expect(calls[0].graph).toMatchObject(graph);
  });

  it("fails LOUDLY (no graph_load) when the userdata library 404s the name", async () => {
    fetchApi.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "nope-not-here.json" }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const text = JSON.stringify(res);
    expect(text).toMatch(/userdata library/i);
    expect(text).toMatch(/panel_list_workflows/);
  });

  it("surfaces an honest error (no graph_load) when the userdata file is not a UI workflow", async () => {
    // API/prompt format (numeric keys) — not a litegraph UI workflow.
    fetchApi.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ "1": { class_type: "KSampler" } }) });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "api-format.json" }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(res)).toMatch(/not a UI workflow/i);
  });

  it("the RUNTIME userdata file wins over a stale same-named file in the guessed default dir", async () => {
    // Collision: COMFYUI_PATH's default workflows dir has a foo.json (graph A),
    // but the connected ComfyUI runs a CUSTOM --user-directory whose foo.json is
    // graph B. The authoritative userdata API must win — never the stale disk
    // file (#202).
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      const stale = { nodes: [{ id: 99, type: "StaleDefaultDirNode" }], links: [] };
      writeFileSync(join(defaultDir, "foo.json"), JSON.stringify(stale), "utf8");
      process.env.COMFYUI_PATH = root;

      const runtime = { nodes: [{ id: 1, type: "RuntimeUserDirNode" }], links: [] };
      fetchApi.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(runtime) });

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "foo.json" }, ctx);

      expect(res.isError).toBeUndefined();
      expect(fetchApi).toHaveBeenCalled(); // authoritative source was consulted first
      expect(calls).toHaveLength(1);
      expect(calls[0].graph).toMatchObject(runtime); // NOT the stale default-dir file
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT fall back to a colliding local file when the server REFUSES (non-404)", async () => {
    // A reachable server that returns 403/500 must surface honestly — NOT silently
    // load a possibly-stale same-named local file (#202).
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      writeFileSync(
        join(defaultDir, "foo.json"),
        JSON.stringify({ nodes: [{ id: 1, type: "StaleNode" }] }),
        "utf8",
      );
      process.env.COMFYUI_PATH = root;

      fetchApi.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "foo.json" }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0); // never loaded the stale local file
      expect(JSON.stringify(res)).toMatch(/HTTP 500/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces malformed userdata JSON as its own error (not mislabeled unreachable)", async () => {
    // A colliding local file exists, but a malformed 2xx must NOT fall back to it.
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      writeFileSync(
        join(defaultDir, "foo.json"),
        JSON.stringify({ nodes: [{ id: 1, type: "StaleNode" }] }),
        "utf8",
      );
      process.env.COMFYUI_PATH = root;

      // Non-empty body that isn't JSON → malformed (NOT an empty-body absence).
      fetchApi.mockResolvedValue({ ok: true, status: 200, text: async () => "<html>not json</html>" });

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "foo.json" }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0); // did not load the stale local file
      expect(JSON.stringify(res)).toMatch(/not valid JSON/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats an EMPTY 200 body as absence and falls back to the local disk file", async () => {
    // ComfyUI's "200 + empty body = file does not exist" convention (some builds)
    // must be an ABSENCE (local fallback), NOT a malformed error (#202).
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      const staged = { nodes: [{ id: 5, type: "EmptyBodyFallbackNode" }], links: [] };
      writeFileSync(join(defaultDir, "foo.json"), JSON.stringify(staged), "utf8");
      process.env.COMFYUI_PATH = root;

      fetchApi.mockResolvedValue({ ok: true, status: 200, text: async () => "   " });

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "foo.json" }, ctx);

      expect(res.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0].graph).toMatchObject(staged); // local fallback loaded it
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the local disk file when the server doesn't have the name (404)", async () => {
    // A file staged straight to the default workflows dir, absent from the
    // runtime userdata library → the local fallback still opens it.
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      const staged = { nodes: [{ id: 7, type: "StagedNode" }], links: [] };
      writeFileSync(join(defaultDir, "staged.json"), JSON.stringify(staged), "utf8");
      process.env.COMFYUI_PATH = root;

      fetchApi.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "staged.json" }, ctx);

      expect(res.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0].graph).toMatchObject(staged);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
