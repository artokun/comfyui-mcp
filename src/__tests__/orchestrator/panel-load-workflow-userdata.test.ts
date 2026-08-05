// panel_load_workflow — relative names are resolved by the CONNECTED ComfyUI,
// which is the only authority on its own `--user-directory` (panel #202).
//
// Root cause: comfyWorkflowsDirs() RECONSTRUCTS COMFYUI_PATH/user/default/workflows
// (and user/workflows), so a ComfyUI launched with a CUSTOM --user-directory keeps
// its workflows somewhere the orchestrator cannot guess. A relative name either
// failed outright — even though list_workflows/panel_open_workflow could see it —
// or, worse, matched a same-named file under the reconstructed path and loaded a
// DIFFERENT graph for the agent to edit.
//
// The resolver now asks the server first and, when the server answers, defers to
// that answer completely: it refuses instead of falling back to a reconstructed
// path, and refuses instead of picking between several candidates. Only a server
// that gives NO answer at all re-enables the best-effort local read that keeps the
// default layout working — and "no answer" means no HTTP Response object exists,
// not merely a reply we could not decode.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

// Stub ONLY getClient so no real ComfyUI connection is attempted; every other
// client export keeps its real implementation (panel-tools' module graph uses
// several of them at import time).
//
// The resolver builds its request from the client's `apiURL` + `apiHeaders` and
// calls `fetch` directly, rather than the throw-on-non-2xx `fetchApi` wrapper —
// that is what lets it tell a refusal apart from an unreachable server. `apiURL`
// is the identity here so assertions keep naming the plain route, and the mock
// `fetch` records only the URL so single-argument assertions stay readable; the
// init object is captured separately in `fetchInit` for the one test that checks
// the client's headers are still applied.
const fetchApi = vi.fn();
const fetchInit = vi.fn();
vi.mock("../../comfyui/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/client.js")>();
  return {
    ...actual,
    getClient: () => ({
      apiURL: (route: string) => route,
      apiHeaders: () => ({ "Comfy-User": "default", Accept: "*/*" }),
      fetch: (url: string, init?: unknown) => {
        fetchInit(init);
        return fetchApi(url);
      },
    }),
  };
});

const { buildPanelToolDefs } = await import("../../orchestrator/panel-tools.js");
// #810: the listing route is now shared with list_workflows, so pinning the literal
// here would let the two drift apart again — which is how one recursed and one did not.
const { WORKFLOW_LIBRARY_LISTING_ROUTE } = await import("../../services/userdata-library.js");
import type { PanelToolCtx } from "../../orchestrator/panel-tools.js";

type Forwarded = Record<string, unknown>;
function makeCtx(): { ctx: PanelToolCtx; calls: Forwarded[] } {
  const calls: Forwarded[] = [];
  const ctx = {
    call: async (cmd: Forwarded) => {
      calls.push(cmd);
      return { content: [{ type: "text", text: "ok" }] };
    },
    confirm: async () => "yes" as const,
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
  fetchInit.mockReset();
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
    expect(text).toMatch(/workflow library/i);
    expect(text).toMatch(/list_workflows/);
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

  it("treats an EMPTY 200 body as an AUTHORITATIVE absence and refuses (never the local file)", async () => {
    // ComfyUI's "200 + empty body = file does not exist" convention (some builds)
    // is an ABSENCE, not a malformed error — and an absence reported by the server
    // is AUTHORITATIVE: it resolved the name under its own --user-directory. Any
    // file still findable under the orchestrator's RECONSTRUCTED default-layout
    // path is therefore a DIFFERENT file, so loading it is the wrong-graph hazard
    // (#202). Refuse instead.
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      const other = { nodes: [{ id: 5, type: "DifferentFileNode" }], links: [] };
      writeFileSync(join(defaultDir, "foo.json"), JSON.stringify(other), "utf8");
      process.env.COMFYUI_PATH = root;

      fetchApi.mockImplementation(async (route: string) =>
        route.startsWith("/api/userdata?")
          ? { ok: true, status: 200, json: async () => [] }
          : { ok: true, status: 200, text: async () => "   " },
      );

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "foo.json" }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0); // the DIFFERENT local foo.json was never loaded
      expect(JSON.stringify(res)).toMatch(/user directory|--user-directory/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("REFUSES rather than loading a same-named local file when the server 404s the name (#202)", async () => {
    // The core hazard: ComfyUI runs a custom --user-directory, so the guessed
    // COMFYUI_PATH/user/default/workflows is the WRONG directory. A same-named
    // file there is a different graph; loading it would hand the agent the wrong
    // workflow to edit. The refusal must name what was tried.
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      const wrong = { nodes: [{ id: 7, type: "WrongDirNode" }], links: [] };
      writeFileSync(join(defaultDir, "staged.json"), JSON.stringify(wrong), "utf8");
      process.env.COMFYUI_PATH = root;

      fetchApi.mockImplementation(async (route: string) =>
        route.startsWith("/api/userdata?")
          ? { ok: true, status: 200, json: async () => ["other.json"] }
          : { ok: false, status: 404, json: async () => ({}) },
      );

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "staged.json" }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0);
      const text = JSON.stringify(res);
      expect(text).toMatch(/staged\.json/); // names what it tried
      expect(text).toMatch(/list_workflows/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// #202 (gate MAJOR) — the client's own `fetchApi` throws for every non-2xx AND
// calls `response.json()` while building that error, so a refusal with a NON-JSON
// body (a `403 text/plain` from a proxy, an HTML 502) rejected with a STATUSLESS
// SyntaxError. Classifying that as "unreachable" re-opened the guessed-local-dir
// fallback for a server that had explicitly REFUSED, and loaded a different graph.
//
// The resolver now issues the request itself and keeps the raw Response, so the
// split is categorical: a Response means the server answered (classify by status,
// whatever the body turns out to be), and a throw means no Response exists at all.
describe("readWorkflowFromPath: a refusal is never mistaken for an unreachable server (#202)", () => {
  /** A workflows dir holding a DIFFERENT graph of the same name — the file that
   *  must never be substituted when the server refuses. */
  const withCollidingLocalFile = async (
    run: (path: string) => Promise<void>,
  ): Promise<void> => {
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      writeFileSync(
        join(defaultDir, "foo.json"),
        JSON.stringify({ nodes: [{ id: 1, type: "CollidingLocalNode" }], links: [] }),
        "utf8",
      );
      process.env.COMFYUI_PATH = root;
      await run("foo.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("a 403 whose body is NOT JSON refuses — the resolver never parses the error body", async () => {
    // The exact reported shape: a plain-text 403. Both decoders throw, proving the
    // classification never depends on reading the body of a refusal.
    await withCollidingLocalFile(async (path) => {
      fetchApi.mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => {
          throw new SyntaxError("Unexpected token 'F', \"Forbidden\" is not valid JSON");
        },
        text: async () => {
          throw new SyntaxError("body already consumed");
        },
      });

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0); // the colliding local file was NOT loaded
      expect(JSON.stringify(res)).toMatch(/HTTP 403/);
      // Classified as a refusal, NOT as an unreachable server.
      expect(JSON.stringify(res)).not.toMatch(/could not be reached/i);
    });
  });

  it("a 500 with an HTML body refuses rather than substituting the local file", async () => {
    await withCollidingLocalFile(async (path) => {
      fetchApi.mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError("Unexpected token '<'");
        },
      });

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0);
      expect(JSON.stringify(res)).toMatch(/HTTP 502/);
    });
  });

  it("a 404 Response is an authoritative absence — refused, not silently substituted", async () => {
    await withCollidingLocalFile(async (path) => {
      fetchApi.mockImplementation(async (route: string) =>
        route.startsWith("/api/userdata?")
          ? { ok: true, status: 200, json: async () => [] }
          : { ok: false, status: 404, json: async () => ({}) },
      );

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0);
      expect(JSON.stringify(res)).toMatch(/404/);
    });
  });

  it("passes the client's own apiHeaders() to the client's own fetch", async () => {
    // Bypassing fetchApi must not drop what it used to assemble. What this asserts
    // is exactly that: the headers the CLIENT produced reach the fetch the CLIENT
    // was configured with. COMFYUI_AUTH_* injection is not exercised here — it
    // lives inside that configured fetch (comfyuiFetch), so calling the client's
    // own `fetch` is what preserves it, and that is what is checked.
    fetchApi.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ nodes: [], links: [] }),
    });

    const { ctx } = makeCtx();
    await loadWorkflow().handler({ path: "headers.json" }, ctx);

    expect(fetchInit).toHaveBeenCalledWith(
      expect.objectContaining({ headers: expect.objectContaining({ "Comfy-User": "default" }) }),
    );
  });

  it("the local fallback will not load a file whose on-disk name is spelled differently", async () => {
    // resolve() answers in the filesystem's terms: on a case-insensitive volume
    // "foo.json" opens an on-disk "Foo.json", which is exactly the substitution the
    // server path refuses. With ComfyUI unreachable there is no authority to say
    // the two names are the same file, so the local branch must apply the same
    // rule (codex MAJOR) — every segment has to appear verbatim in its directory.
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      writeFileSync(
        join(defaultDir, "Foo.json"),
        JSON.stringify({ nodes: [{ id: 81, type: "DifferentlyCasedNode" }], links: [] }),
        "utf8",
      );
      process.env.COMFYUI_PATH = root;

      fetchApi.mockRejectedValue(new Error("ECONNREFUSED"));

      // Only a case-INSENSITIVE volume can even offer the wrong file here; on a
      // case-sensitive one there is simply no candidate. Both must refuse, but only
      // the former can name the near miss.
      const caseInsensitiveVolume = existsSync(join(defaultDir, "foo.json"));

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "foo.json" }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0);
      if (caseInsensitiveVolume) {
        // The differently-cased file is NAMED so the caller can retype it.
        expect(JSON.stringify(res)).toMatch(/not how you spelled it/i);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the local fallback does not let resolve() collapse a repeated separator", async () => {
    // "recipes//foo.json" is a distinct key everywhere else in this resolver, but
    // resolve() collapses the run and would open recipes/foo.json.
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const nested = join(root, "user", "default", "workflows", "recipes");
      mkdirSync(nested, { recursive: true });
      writeFileSync(
        join(nested, "foo.json"),
        JSON.stringify({ nodes: [{ id: 82, type: "CollapsedSeparatorNode" }], links: [] }),
        "utf8",
      );
      process.env.COMFYUI_PATH = root;

      fetchApi.mockRejectedValue(new Error("ECONNREFUSED"));

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "recipes//foo.json" }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads a backslash name the way the LOCAL platform would, or not at all", async () => {
    // With no server there is no authority to disprove the literal reading, so the
    // local branch may only apply the platform's own semantics (codex MAJOR):
    //   - Windows: a file named "recipes\foo.json" cannot exist, so the folder
    //     reading is the ONLY reading and resolve() is right to take it.
    //   - POSIX: the backslash is an ordinary filename character, so resolve()
    //     produces the LITERAL path; the folder reading was never authorised and
    //     must not be substituted.
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const nested = join(root, "user", "default", "workflows", "recipes");
      mkdirSync(nested, { recursive: true });
      const staged = { nodes: [{ id: 84, type: "PlatformSeparatorNode" }], links: [] };
      writeFileSync(join(nested, "foo.json"), JSON.stringify(staged), "utf8");
      process.env.COMFYUI_PATH = root;

      fetchApi.mockRejectedValue(new Error("ECONNREFUSED"));

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "recipes\\foo.json" }, ctx);

      if (sep === "\\") {
        expect(res.isError).toBeUndefined();
        expect(calls[0].graph).toMatchObject(staged);
      } else {
        expect(res.isError).toBe(true);
        expect(calls).toHaveLength(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a nested EXACT name still loads from the reconstructed dir when unreachable", async () => {
    // The strictness must not break the ordinary nested case it is guarding.
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const nested = join(root, "user", "default", "workflows", "recipes");
      mkdirSync(nested, { recursive: true });
      const staged = { nodes: [{ id: 83, type: "ExactNestedNode" }], links: [] };
      writeFileSync(join(nested, "foo.json"), JSON.stringify(staged), "utf8");
      process.env.COMFYUI_PATH = root;

      fetchApi.mockRejectedValue(new Error("ECONNREFUSED"));

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "recipes/foo.json" }, ctx);

      expect(res.isError).toBeUndefined();
      expect(calls[0].graph).toMatchObject(staged);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a statusless transport error still allows the reconstructed local dir (default layout)", async () => {
    // No HTTP status at all → no authority to defer to → the pre-existing
    // best-effort local read is preserved so the DEFAULT layout keeps working.
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      const staged = { nodes: [{ id: 7, type: "StagedNode" }], links: [] };
      writeFileSync(join(defaultDir, "staged.json"), JSON.stringify(staged), "utf8");
      process.env.COMFYUI_PATH = root;

      fetchApi.mockRejectedValue(new Error("ECONNREFUSED"));

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "staged.json" }, ctx);

      expect(res.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0].graph).toMatchObject(staged);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT consult a local file when a backslash name is absent under BOTH spellings", async () => {
    // A backslash name is asked for literally first (the server's key space is
    // "/"-separated, and on POSIX a backslash is a legal filename character), then
    // as the Windows-style folder path. Once the server has answered "no" to both,
    // it has spoken — the colliding local file is never consulted, and the refusal
    // names both keys it tried.
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const nested = join(root, "user", "default", "workflows", "recipes");
      mkdirSync(nested, { recursive: true });
      writeFileSync(
        join(nested, "foo.json"),
        JSON.stringify({ nodes: [{ id: 1, type: "LocalRecipeNode" }], links: [] }),
        "utf8",
      );
      process.env.COMFYUI_PATH = root;

      fetchApi.mockImplementation(async (route: string) =>
        route.startsWith("/api/userdata?")
          ? { ok: true, status: 200, json: async () => [] }
          : { ok: false, status: 404, json: async () => ({}) },
      );

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "recipes\\foo.json" }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0); // the local recipes/foo.json was NOT loaded
      const text = JSON.stringify(res);
      expect(text).toMatch(/recipes\\\\foo\.json/); // the literal spelling
      expect(text).toMatch(/recipes\/foo\.json/); // and the normalized one
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


  it("refuses when an unreachable server leaves TWO different local candidates", async () => {
    // Both reconstructed layouts (user/default/workflows and user/workflows) hold a
    // DIFFERENT file of the same name. With no server to arbitrate, picking the
    // first is a coin flip over which graph the agent edits — refuse instead.
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const a = join(root, "user", "default", "workflows");
      const b = join(root, "user", "workflows");
      mkdirSync(a, { recursive: true });
      mkdirSync(b, { recursive: true });
      writeFileSync(join(a, "dup.json"), JSON.stringify({ nodes: [{ id: 1, type: "A" }] }), "utf8");
      writeFileSync(join(b, "dup.json"), JSON.stringify({ nodes: [{ id: 2, type: "B" }] }), "utf8");
      process.env.COMFYUI_PATH = root;

      fetchApi.mockRejectedValue(new Error("ECONNREFUSED"));

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "dup.json" }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0);
      expect(JSON.stringify(res)).toMatch(/ambiguous/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// #202 — a name that IS in the connected ComfyUI's library but whose bytes differ
// by Unicode normalization used to 404 and die, even though panel_list_workflows
// plainly showed it. The resolver asks the SERVER for its own listing and retries
// the SERVER's exact key — it never reconstructs a path — and refuses outright
// when more than one listed key normalizes to the requested name.
//
// Normalization is the ONLY accepted equivalence: NFC/NFD are two spellings of the
// same character sequence. Letter case is NOT — on a case-sensitive filesystem
// "Foo.json" and "foo.json" are different files, so a case-only near miss is named
// in the refusal and never substituted.
describe("readWorkflowFromPath: near-miss names resolve via the server's OWN listing (#202)", () => {
  const routeMock = (listing: unknown[], files: Record<string, unknown>) =>
    fetchApi.mockImplementation(async (route: string) => {
      if (route.startsWith("/api/userdata?")) {
        return { ok: true, status: 200, json: async () => listing };
      }
      const key = decodeURIComponent(route.replace("/api/userdata/", ""));
      const hit = files[key];
      if (hit === undefined) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, text: async () => JSON.stringify(hit) };
    });

  it("resolves an NFD-typed name to the library's NFC key and loads THAT file", async () => {
    // "cafe.json" with an acute accent: the library key is COMPOSED (NFC, U+00E9),
    // the caller typed the DECOMPOSED form (NFD, "e" + U+0301). Byte-different,
    // same file name. Written as escapes so no editor/formatter can re-normalize
    // the literals and quietly void the test.
    const nfc = "caf\u00e9.json";
    const nfd = "cafe\u0301.json";
    const graph = { nodes: [{ id: 1, type: "KSampler" }], links: [] };
    routeMock([nfc], { [`workflows/${nfc}`]: graph });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: nfd }, ctx);

    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].graph).toMatchObject(graph);
    // It fetched the SERVER's key, not a locally reconstructed path.
    expect(fetchApi).toHaveBeenCalledWith(`/api/userdata/${encodeURIComponent(`workflows/${nfc}`)}`);
  });

  it("resolves the REVERSE direction too — an NFC name against a DECOMPOSED library key", async () => {
    // The mirror of the test above, and the one that catches a retry which
    // re-derives the key instead of echoing the server's bytes (codex MAJOR): if
    // the retry NFC-normalized the listed key it would re-send the caller's own
    // spelling — the key that just 404'd — and refuse a uniquely listed workflow.
    const nfc = "caf\u00e9.json";
    const nfd = "cafe\u0301.json";
    const graph = { nodes: [{ id: 9, type: "DecomposedLibraryNode" }], links: [] };
    routeMock([nfd], { [`workflows/${nfd}`]: graph });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: nfc }, ctx);

    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].graph).toMatchObject(graph);
    expect(fetchApi).toHaveBeenCalledWith(`/api/userdata/${encodeURIComponent(`workflows/${nfd}`)}`);
  });

  it("a nested folder named `workflows` can NOT satisfy a request for a ROOT file", async () => {
    // The recursive listing reports the file workflows/workflows/name.json as the
    // entry "workflows/name.json" — textually identical to what a root entry would
    // look like if entries carried the library prefix. Stripping that prefix from
    // an entry made the nested file collide with the ROOT file of the same name, so
    // a bare request matched the nested entry and then fetched the DIFFERENT root
    // file (gate MAJOR). Entries are store-relative and are compared verbatim, so
    // depth is preserved and this must refuse.
    const nfc = "caf\u00e9.json";
    const nfd = "cafe\u0301.json";
    routeMock([`workflows/${nfc}`], {
      // The ROOT file exists and is servable — it is exactly what must not be sent.
      [`workflows/${nfc}`]: { nodes: [{ id: 61, type: "RootFileNode" }], links: [] },
    });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: nfd }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    // The root file's key was requested ONCE (the caller's own NFD spelling missed);
    // the nested entry must never have been turned into a request for it.
    expect(fetchApi).not.toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent(`workflows/${nfc}`)}`,
    );
  });

  it("resolves an EXPLICIT request for a file inside a nested `workflows` folder", async () => {
    // The flip side: asking for it by its real depth works, and the store key nests
    // the folder rather than collapsing it.
    const nfc = "caf\u00e9.json";
    const nfd = "cafe\u0301.json";
    const graph = { nodes: [{ id: 62, type: "NestedWorkflowsFolderNode" }], links: [] };
    routeMock([`workflows/${nfc}`], { [`workflows/workflows/${nfc}`]: graph });

    const { ctx, calls } = makeCtx();
    // One "workflows/" is the library prefix a caller may paste (#414); the second
    // is the real subfolder.
    const res = await loadWorkflow().handler({ path: `workflows/workflows/${nfd}` }, ctx);

    expect(res.isError).toBeUndefined();
    expect(calls[0].graph).toMatchObject(graph);
    expect(fetchApi).toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent(`workflows/workflows/${nfc}`)}`,
    );
  });


  it("does NOT treat a backslash as a path separator when matching (POSIX aliasing)", async () => {
    // On POSIX a file literally named "dir\\foo.json" is a DIFFERENT file from
    // "dir/foo.json". Folding separators in the match would substitute one for the
    // other (codex MAJOR). It must refuse and never fetch the backslash key.
    const backslashKey = "dir\\foo.json";
    routeMock([backslashKey], {
      [`workflows/${backslashKey}`]: { nodes: [{ id: 1, type: "WrongSeparatorNode" }], links: [] },
    });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "dir/foo.json" }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(fetchApi).not.toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent(`workflows/${backslashKey}`)}`,
    );
    // But it IS named as a near miss so the user can retype it.
    expect(JSON.stringify(res)).toMatch(/path separator/i);
  });

  it("resolves a normalization near-miss for a workflow in a SUBFOLDER", async () => {
    // The listing is requested with recurse=true, which is VERIFIED against the
    // installed ComfyUI (0.29.2): a nested workflow is absent from the plain
    // listing and present as "sub/name.json" under recurse. Without it a nested
    // NFD/NFC near-miss had no listing entry to match and was refused.
    const nfc = "caf\u00e9.json";
    const nfd = "cafe\u0301.json";
    const graph = { nodes: [{ id: 51, type: "NestedRecipeNode" }], links: [] };
    routeMock([`recipes/${nfc}`], { [`workflows/recipes/${nfc}`]: graph });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: `recipes/${nfd}` }, ctx);

    expect(res.isError).toBeUndefined();
    expect(calls[0].graph).toMatchObject(graph);
    expect(fetchApi).toHaveBeenCalledWith(WORKFLOW_LIBRARY_LISTING_ROUTE);
    expect(fetchApi).toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent(`workflows/recipes/${nfc}`)}`,
    );
  });

  it("does NOT collapse a repeated slash after the workflows/ prefix", async () => {
    // "workflows//foo.json" is the key "/foo.json" under the library, which is a
    // different key from "foo.json". Collapsing the run of slashes would alias one
    // onto the other (codex MAJOR).
    routeMock(["foo.json"], {
      "workflows/foo.json": { nodes: [{ id: 41, type: "BareNameNode" }], links: [] },
    });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "workflows//foo.json" }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    // The bare-name key exists and would have loaded had the slashes collapsed.
    expect(fetchApi).not.toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/foo.json")}`,
    );
  });

  it("does NOT fold a LEADING-SLASH listing entry onto the bare name", async () => {
    // "/name.json" and "name.json" are different store keys. Folding them in the
    // match let a match on the listed "/name.json" be RETRIED as
    // "workflows/name.json" — a key the server never listed (codex MAJOR).
    const nfc = "caf\u00e9.json";
    const nfd = "cafe\u0301.json";
    routeMock([`/${nfc}`], {
      [`workflows/${nfc}`]: { nodes: [{ id: 31, type: "UnlistedNode" }], links: [] },
    });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: nfd }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    // The unlisted key exists and would have loaded had the slash been folded.
    expect(fetchApi).not.toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent(`workflows/${nfc}`)}`,
    );
  });

  it("does NOT treat a DIFFERENTLY-CASED workflows/ as the library prefix", async () => {
    // "WORKFLOWS" can be a real subfolder inside the library on a case-sensitive
    // host. Stripping it would turn "WORKFLOWS/foo.json" into a request for the
    // root "foo.json" — a different file (codex MAJOR).
    const nested = { nodes: [{ id: 21, type: "NestedNode" }], links: [] };
    routeMock(["WORKFLOWS/foo.json"], {
      "workflows/WORKFLOWS/foo.json": nested,
      "workflows/foo.json": { nodes: [{ id: 22, type: "RootNode" }], links: [] },
    });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "WORKFLOWS/foo.json" }, ctx);

    expect(res.isError).toBeUndefined();
    expect(calls[0].graph).toMatchObject(nested); // the NESTED file, not the root one
    expect(fetchApi).not.toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/foo.json")}`,
    );
  });

  it("asks for a backslash name LITERALLY first, then as a folder path", async () => {
    // On POSIX "recipes\name.json" is a legal single filename, so the literal key
    // must be asked for before the Windows-style reading — the server is the
    // authority on which of the two exists. Only after it disproves the literal one
    // is the folder path tried, so nothing is substituted while the literally-named
    // file might still exist (gate MEDIUM).
    const graph = { nodes: [{ id: 71, type: "WindowsPathNode" }], links: [] };
    routeMock(["recipes/foo.json"], { "workflows/recipes/foo.json": graph });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "recipes\\foo.json" }, ctx);

    expect(res.isError).toBeUndefined();
    expect(calls[0].graph).toMatchObject(graph);
    const keys = fetchApi.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((u: string) => u.startsWith("/api/userdata/"))
      .map((u: string) => decodeURIComponent(u.replace("/api/userdata/", "")));
    expect(keys[0]).toBe("workflows/recipes\\foo.json"); // literal first
    expect(keys[1]).toBe("workflows/recipes/foo.json"); // folder path second
  });

  it("prefers a LITERAL backslash filename over the folder-path reading", async () => {
    // Both exist on the server. The literally-named one is what was asked for, so
    // it wins and the folder path is never requested.
    const literal = { nodes: [{ id: 72, type: "LiteralBackslashNode" }], links: [] };
    routeMock(["recipes\\foo.json", "recipes/foo.json"], {
      "workflows/recipes\\foo.json": literal,
      "workflows/recipes/foo.json": { nodes: [{ id: 73, type: "FolderPathNode" }], links: [] },
    });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "recipes\\foo.json" }, ctx);

    expect(res.isError).toBeUndefined();
    expect(calls[0].graph).toMatchObject(literal);
    expect(fetchApi).not.toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/recipes/foo.json")}`,
    );
  });


  it("a retry that cannot be completed REFUSES — it does not reopen the local fallback", async () => {
    // The server already answered (404 + a readable listing). A transport failure
    // on the follow-up read must not be reclassified as "unreachable", which would
    // hand the reconstructed local dir back its veto (codex MAJOR).
    const nfc = "caf\u00e9.json";
    const nfd = "cafe\u0301.json";
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      writeFileSync(
        join(defaultDir, nfd),
        JSON.stringify({ nodes: [{ id: 1, type: "StaleLocalNode" }], links: [] }),
        "utf8",
      );
      process.env.COMFYUI_PATH = root;

      fetchApi.mockImplementation(async (route: string) => {
        if (route.startsWith("/api/userdata?")) return { ok: true, status: 200, json: async () => [nfc] };
        if (route === `/api/userdata/${encodeURIComponent(`workflows/${nfc}`)}`) {
          throw new Error("ECONNRESET"); // statusless failure on the retry
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: nfd }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0); // the stale local file was NOT loaded
      expect(JSON.stringify(res)).toMatch(/re-reading it failed/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("holds the invariant that no request key ever carries a traversal segment", async () => {
    // This asserts the INVARIANT, not one mechanism, and it cannot attribute a
    // pass to either the caller-side traversal guard or the listing filter — under
    // NFC-only matching a "../" entry can never match a clean requested name, so
    // the listing filter is unreachable today and is forward defense. The test is
    // here to fail if a future change lets a server-supplied string reach the
    // request key.
    routeMock(["../../secret.json", "..\\secret.json"], {});

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "secret.json" }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    for (const call of fetchApi.mock.calls) {
      expect(String(call[0])).not.toMatch(/%2E%2E|\.\./i);
    }
  });

  it("REFUSES when two listed keys NORMALIZE to the requested name (ambiguous, no guess)", async () => {
    // Two library keys, one NFC and one NFD, both spelling the same name. A
    // case-sensitive store can hold both; picking either would be a coin flip over
    // which graph the agent edits.
    const nfc = "caf\u00e9.json";
    const nfd = "cafe\u0301.json";
    routeMock([nfc, nfd], {});

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: nfd }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(res)).toMatch(/ambiguous/i);
  });

  it("NEVER substitutes a case-only near miss — it names it and refuses", async () => {
    // "FOO.json" is not in the library; "Foo.json" is a DIFFERENT file on a
    // case-sensitive filesystem. Loading it would be the wrong graph.
    routeMock(["Foo.json"], { "workflows/Foo.json": { nodes: [{ id: 1, type: "WrongCaseNode" }] } });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "FOO.json" }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const text = JSON.stringify(res);
    expect(text).toMatch(/letter case/i);
    expect(text).toMatch(/Foo\.json/);
    // The differently-cased key was never fetched.
    expect(fetchApi).not.toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/Foo.json")}`,
    );
  });

  it("an NFC-exact match still wins when a case-variant sibling exists", async () => {
    // The caller's name matches "café.json" character-for-character once
    // normalized; "CAFÉ.json" differs in case and is a different name. The exact
    // match is not a guess, so it resolves — and the case sibling is not fetched.
    const nfc = "caf\u00e9.json";
    const nfd = "cafe\u0301.json";
    const upper = "CAF\u00c9.json";
    const graph = { nodes: [{ id: 4, type: "ExactMatchNode" }], links: [] };
    routeMock([upper, nfc], { [`workflows/${nfc}`]: graph });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: nfd }, ctx);

    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].graph).toMatchObject(graph);
    expect(fetchApi).not.toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent(`workflows/${upper}`)}`,
    );
  });

  it("says so when the library LISTS the name but will not serve it", async () => {
    routeMock(["ghost.json"], {}); // listed, but every GET 404s

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "ghost.json" }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(res)).toMatch(/DOES list/i);
  });

  it("an unreadable listing does not invent a match — it still refuses honestly", async () => {
    fetchApi.mockImplementation(async (route: string) =>
      route.startsWith("/api/userdata?")
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: false, status: 404, json: async () => ({}) },
    );

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "whatever.json" }, ctx);

    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    // The listing WAS consulted (and its 500 swallowed) — otherwise this test would
    // pass even if the near-miss lookup had been dropped entirely.
    expect(fetchApi).toHaveBeenCalledWith(WORKFLOW_LIBRARY_LISTING_ROUTE);
    expect(JSON.stringify(res)).toMatch(/list_workflows/);
    // And the refusal admits the listing was unreadable rather than implying the
    // library was fully checked.
    expect(JSON.stringify(res)).toMatch(/listing could not be read/i);
  });
});

// #202 (codex MAJOR) — a 2xx whose BODY read aborts is still an answer from the
// server. Letting that fall out as a statusless error classified it "unreachable"
// and re-opened the reconstructed-local-dir fallback, so a mid-body network drop
// could load a colliding local file.
describe("readWorkflowFromPath: a 2xx with an unreadable body is a refusal, not a fallback (#202)", () => {
  it("does not load a colliding local file when the response body fails mid-read", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      writeFileSync(
        join(defaultDir, "foo.json"),
        JSON.stringify({ nodes: [{ id: 1, type: "CollidingLocalNode" }], links: [] }),
        "utf8",
      );
      process.env.COMFYUI_PATH = root;

      fetchApi.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => {
          throw new Error("terminated");
        },
      });

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "foo.json" }, ctx);

      expect(res.isError).toBe(true);
      expect(calls).toHaveLength(0); // the colliding local file was NOT loaded
      expect(JSON.stringify(res)).toMatch(/body could not be read/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// #414 — panel_list_workflows reports each workflow's userdata STORE KEY, which
// already carries the "workflows/" prefix (e.g. "workflows/Daily Anime.json").
// Feeding that exact value back to a path-taking tool (panel_strip_workflow /
// panel_load_workflow share readWorkflowFromPath) double-prefixed the userdata
// key → 404 → local miss → "No workflow file at …". The resolver must normalize
// a leading "workflows/" so the list key resolves to the SAME single-prefixed key.
describe("readWorkflowFromPath: a list-style 'workflows/…' path is not double-prefixed (#414)", () => {
  it("resolves the userdata key WITHOUT nesting a second workflows/ segment", async () => {
    const graph = { nodes: [{ id: 1, type: "KSampler" }], links: [] };
    fetchApi.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(graph) });

    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler(
      { path: "workflows/Daily Anime Portrait - Fast Preview.json" },
      ctx,
    );

    expect(res.isError).toBeUndefined();
    expect(fetchApi).toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/Daily Anime Portrait - Fast Preview.json")}`,
    );
    // The pre-fix DOUBLED key must NEVER be requested.
    expect(fetchApi).not.toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/workflows/Daily Anime Portrait - Fast Preview.json")}`,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].graph).toMatchObject(graph);
  });

  it("a bare name (no prefix) still resolves to the same single-prefixed key", async () => {
    const graph = { nodes: [{ id: 2, type: "VAEDecode" }], links: [] };
    fetchApi.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(graph) });

    const { ctx } = makeCtx();
    await loadWorkflow().handler({ path: "Daily Anime Portrait - Fast Preview.json" }, ctx);
    expect(fetchApi).toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/Daily Anime Portrait - Fast Preview.json")}`,
    );
  });

  it("a 'workflows/'-prefixed path falls back to local disk WITHOUT nesting workflows/", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      const staged = { nodes: [{ id: 7, type: "PrefixedLocalNode" }], links: [] };
      writeFileSync(join(defaultDir, "Foo.json"), JSON.stringify(staged), "utf8");
      process.env.COMFYUI_PATH = root;

      // Server unreachable (statusless transport error) → the local fallback is
      // the only branch that still reads disk. rel ("Foo.json") must join the
      // workflows dir directly, not as workflows/workflows/Foo.json.
      fetchApi.mockRejectedValue(new Error("ECONNREFUSED"));

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "workflows/Foo.json" }, ctx);

      expect(res.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0].graph).toMatchObject(staged);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// #414 hardening (codex) — normalizing the "workflows/" prefix must not let a
// ".." segment escape the workflows root (e.g. "workflows/../secret.json" would
// otherwise strip to "../secret.json"). Such a path is refused outright.
describe("readWorkflowFromPath: refuses a '..' traversal segment (#414 hardening)", () => {
  it("rejects a workflows/.. path without fetching or loading anything", async () => {
    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "workflows/../secret.json" }, ctx);
    expect(res.isError).toBe(true);
    expect(fetchApi).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(res)).toMatch(/not a valid workflow name|\.\.|traversal/i);
  });

  it("still accepts a colon in a workflow NAME (legal POSIX filename, not a drive letter)", async () => {
    // Regression guard: the drive-relative check must not reject a normal colon in
    // a listed name like "workflows/style:anime.json".
    const graph = { nodes: [{ id: 3, type: "SaveImage" }], links: [] };
    fetchApi.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(graph) });
    const { ctx } = makeCtx();
    const res = await loadWorkflow().handler({ path: "workflows/style:anime.json" }, ctx);
    expect(res.isError).toBeUndefined();
    expect(fetchApi).toHaveBeenCalledWith(
      `/api/userdata/${encodeURIComponent("workflows/style:anime.json")}`,
    );
  });

  it("rejects a Windows drive-relative traversal after the prefix is stripped", async () => {
    // "workflows/C:../secret.json" strips to "C:../secret.json" — no exact ".."
    // segment, but resolve() would canonicalize the embedded ".." and escape. The
    // ":" (drive-letter) guard blocks it before any fetch/local read.
    const { ctx, calls } = makeCtx();
    const res = await loadWorkflow().handler({ path: "workflows/C:../secret.json" }, ctx);
    expect(res.isError).toBe(true);
    expect(fetchApi).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(res)).toMatch(/not a valid workflow name/i);
  });

  it("does NOT read a file via a symlink under the workflows dir that escapes the root", async (t) => {
    // A lexically-clean name ("linked/secret.json") where `linked` is a symlink to
    // an EXTERNAL dir would, without realpath containment, be read on the local
    // fallback. The realpath check rejects it. (Skipped where the OS denies
    // unprivileged symlink creation, e.g. stock Windows.)
    const { symlinkSync } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "cmcp-userdir-"));
    const external = mkdtempSync(join(tmpdir(), "cmcp-external-"));
    try {
      const defaultDir = join(root, "user", "default", "workflows");
      mkdirSync(defaultDir, { recursive: true });
      writeFileSync(
        join(external, "secret.json"),
        JSON.stringify({ nodes: [{ id: 1, type: "SecretNode" }], links: [] }),
        "utf8",
      );
      try {
        symlinkSync(external, join(defaultDir, "linked"), "junction");
      } catch {
        // Unprivileged symlink creation (stock Windows). Mark the test SKIPPED
        // rather than returning — a bare return reports a green test that never
        // ran its assertion (codex).
        t.skip();
        return;
      }
      process.env.COMFYUI_PATH = root;
      // Unreachable server → the local fallback is reached, so the realpath
      // containment check is the thing actually under test here.
      fetchApi.mockRejectedValue(new Error("ECONNREFUSED"));

      const { ctx, calls } = makeCtx();
      const res = await loadWorkflow().handler({ path: "linked/secret.json" }, ctx);

      // The escaping file must NOT be loaded — surfaces the honest not-found error.
      expect(calls).toHaveLength(0);
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res)).toMatch(/No workflow file at/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });
});
