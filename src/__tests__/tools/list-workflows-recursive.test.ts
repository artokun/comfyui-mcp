// #810 — list_workflows read the library SHALLOWLY and reported the result as empty.
//
// The reporter had six workflows saved, all of them filed under `IMAGE/` and
// `VIDEO/MiniMaxH3/` — the folder tree the ComfyUI web UI sidebar shows — and
// list_workflows answered "No saved workflows found." That is the repo's dominant
// defect class wearing its most expensive hat: "could not determine X" rendered as
// "determined X is not the case", where acting on the wrong answer means recreating a
// workflow that already exists.
//
// The listing is exercised against a REAL directory tree through a stand-in for
// ComfyUI's own `listuserdata` endpoint (app/user_manager.py), reimplemented here with
// its documented semantics: `recurse=true` globs `<dir>/**\/*`, non-files are skipped,
// and each entry is the path relative to `dir` with "/" separators. A fixture list of
// strings would pass whether or not the request ever asked to recurse.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

let userRoot = "";
/** Force the listing endpoint to answer with this status instead of reading the tree. */
let forcedStatus: number | null = null;
/** Force the transport to fail before any Response exists. */
let forcedThrow: string | null = null;
/** Force the listing body to be exactly this array, bypassing the tree walk. */
let forcedEntries: unknown[] | null = null;
/** Every route the tool actually requested, so the shallow spelling cannot creep back. */
const requested: string[] = [];

/** Files under `dir`, mirroring ComfyUI's glob: `**\/*` when recursing, `*` otherwise,
 *  keeping only regular files. Directories — including empty ones — never appear. */
function listFiles(dir: string, recurse: boolean): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) {
        if (recurse) walk(full, depth + 1);
        continue;
      }
      out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir, 0);
  return out;
}

/** ComfyUI's userdata endpoints, over a real directory tree. */
function handle(rawUrl: string): Response {
  if (forcedThrow) throw new Error(forcedThrow);
  const url = new URL(rawUrl, "http://comfy.local");
  requested.push(url.pathname + url.search);

  if (url.pathname === "/api/userdata") {
    if (forcedStatus != null) {
      return new Response("nope", { status: forcedStatus, headers: { "content-type": "text/plain" } });
    }
    const dir = url.searchParams.get("dir") ?? "";
    if (!dir) return new Response("Directory not provided", { status: 400 });
    const path = join(userRoot, dir);
    // The endpoint 404s a directory that does not exist — it does not invent an empty list.
    if (!existsSync(path)) {
      return new Response("Directory not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    const recurse = (url.searchParams.get("recurse") ?? "").toLowerCase() === "true";
    const split = (url.searchParams.get("split") ?? "").toLowerCase() === "true";
    if (forcedEntries) return Response.json(forcedEntries);
    const files = listFiles(path, recurse);
    return Response.json(split ? files.map((f) => [f, ...f.split("/")]) : files);
  }

  const file = url.pathname.startsWith("/api/userdata/")
    ? decodeURIComponent(url.pathname.slice("/api/userdata/".length))
    : null;
  if (file != null) {
    const path = join(userRoot, file);
    if (!existsSync(path) || statSync(path).isDirectory()) {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    return new Response(readFileSync(path, "utf8"), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("unhandled", { status: 500 });
}

vi.mock("../../comfyui/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/client.js")>();
  return {
    ...actual,
    getClient: () => ({
      apiURL: (route: string) => `http://comfy.local${route}`,
      apiHeaders: () => ({ "Comfy-User": "default" }),
      fetch: async (url: string) => handle(url),
      // The library client's real contract: throw for any non-2xx, decoding the body as
      // JSON while building the error — which is why the listing does NOT use it.
      fetchApi: async (route: string) => {
        const res = handle(`http://comfy.local${route}`);
        if (!res.ok) throw new Error(`Endpoint Bad Request (${res.status}): ${route}`);
        return res;
      },
    }),
  };
});

const { registerWorkflowLibraryTools } = await import("../../tools/workflow-library.js");

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function tools(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  registerWorkflowLibraryTools({
    tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => handlers.set(name, handler),
  } as never);
  return handlers;
}

const listWorkflows = async (): Promise<string> =>
  (await tools().get("list_workflows")!({})).content[0].text;

// A name with characters that must survive URL encoding on the way back to the server:
// spaces, an ampersand, a hash, a plus and non-ASCII.
const AWKWARD_DIR = "Weird & Nested #1/ünïcode + space";
const AWKWARD_FILE = `${AWKWARD_DIR}/my workflow (v2).json`;

beforeEach(() => {
  userRoot = mkdtempSync(join(tmpdir(), "comfyui-userdata-"));
  forcedStatus = null;
  forcedThrow = null;
  forcedEntries = null;
  requested.length = 0;
  const wf = join(userRoot, "workflows");
  mkdirSync(join(wf, "IMAGE"), { recursive: true });
  mkdirSync(join(wf, "VIDEO", "MiniMaxH3"), { recursive: true });
  // An EMPTY subfolder: a directory entry the walk must skip, not report or trip on.
  mkdirSync(join(wf, "Empty Folder"), { recursive: true });
  mkdirSync(join(wf, AWKWARD_DIR), { recursive: true });
  const graph = JSON.stringify({ nodes: [], links: [] });
  writeFileSync(join(wf, "IMAGE", "portrait.json"), graph);
  writeFileSync(join(wf, "VIDEO", "MiniMaxH3", "video_minimax_h3_t2v.json"), graph);
  writeFileSync(join(wf, AWKWARD_FILE), JSON.stringify({ nodes: [{ id: 7 }], links: [] }));
});

afterEach(() => {
  rmSync(userRoot, { recursive: true, force: true });
});

describe("#810 — list_workflows sees the whole library, subfolders included", () => {
  it("lists workflows that exist only in subfolders instead of reporting none", async () => {
    // The reported repro exactly: nothing at the top level, everything in folders.
    const text = await listWorkflows();
    expect(text).not.toMatch(/No saved workflows found/);
    expect(text).toContain("IMAGE/portrait.json");
    expect(text).toContain("VIDEO/MiniMaxH3/video_minimax_h3_t2v.json");
    expect(text).toContain(AWKWARD_FILE);
    expect(text).toMatch(/Found 3 workflow\(s\)/);
  });

  it("claims subfolder coverage only where the listing itself proves it", async () => {
    // Asking for `recurse=true` proves what was REQUESTED, not what answered (codex
    // gate r10). A name carrying a folder is the listing proving it recursed, so there
    // the claim is observed; with every name at the root there is no such proof, and
    // an accidental wrong URL/port returning a shallow list is the nonempty form of
    // this very issue — so that reply says which reading to trust and how to tell.
    const nested = await listWorkflows();
    expect(nested).toMatch(/Subfolders ARE included/);
    expect(nested).toMatch(/proving it recursed/);

    forcedEntries = ["a.json", "b.json"];
    const flat = await listWorkflows();
    expect(flat).toMatch(/Found 2 workflow\(s\)/);
    expect(flat).not.toMatch(/Subfolders ARE included/);
    expect(flat).toMatch(/Every name here sits at the library root/);
    // Root-only names are NOT proof that no subfolders exist — they are also what a
    // read that never recursed looks like. Both readings are offered; neither is
    // asserted (codex gate r11).
    expect(flat).toMatch(/cannot tell apart from a subfolder read that did not happen/);
    expect(flat).toMatch(/the usual reading is/);
    expect(flat).toMatch(/check the URL\/port/);
    expect(flat).not.toMatch(/that means it has no workflow subfolders/);
  });

  it("an EMPTY subfolder contributes nothing and breaks nothing", async () => {
    const text = await listWorkflows();
    expect(text).not.toContain("Empty Folder");
    expect(text).toMatch(/Found 3 workflow\(s\)/);
  });

  it("still lists root-level workflows — the recursive listing is a superset", async () => {
    // A fix that traded root entries for nested ones would swap one wrong "not found"
    // for another.
    writeFileSync(join(userRoot, "workflows", "top_level.json"), "{}");
    const text = await listWorkflows();
    expect(text).toContain("top_level.json");
    expect(text).toContain("IMAGE/portrait.json");
    expect(text).toMatch(/Found 4 workflow\(s\)/);
  });

  it("reports names that get_workflow can load back verbatim, escaping and all", async () => {
    // The listing is only useful if its output is accepted where it is meant to be used.
    // A name with spaces, `&`, `#`, `+` and non-ASCII has to survive the round trip
    // through encodeURIComponent to reach the same file on disk.
    const text = await listWorkflows();
    const name = text
      .split("\n")
      .map((l) => l.replace(/^\d+\.\s*/, ""))
      .find((l) => l.endsWith("my workflow (v2).json"));
    expect(name).toBe(AWKWARD_FILE);

    const loaded = await tools().get("get_workflow")!({ filename: name!, format: "ui" });
    expect(loaded.isError).toBeFalsy();
    expect(JSON.parse(loaded.content[0].text)).toEqual({ nodes: [{ id: 7 }], links: [] });
  });

  it("asks the server to recurse — and only ever asks once", async () => {
    await listWorkflows();
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain("recurse=true");
    expect(requested[0]).toContain("dir=workflows");
  });
});

describe("#810 — an unread library is never reported as an empty one", () => {
  it("does not call an empty listing an empty library — an empty answer proves nothing about its own coverage", async () => {
    rmSync(join(userRoot, "workflows"), { recursive: true, force: true });
    mkdirSync(join(userRoot, "workflows"));
    const text = await listWorkflows();
    // An EMPTY list is the one answer with no evidence about its own coverage: asking
    // for `recurse=true` says what was REQUESTED, and a responder that ignored it
    // returns exactly this for a library whose workflows are all in folders — #810
    // itself, moved one layer out (independent gate P0). So the verdict headline is
    // withheld and the open question is stated, with the check that settles it.
    expect(text).toMatch(/Could NOT confirm the workflow library is empty/);
    expect(text).not.toMatch(/No saved workflows found/);
    expect(text).toMatch(/empty list/);
    expect(text).toMatch(/carries no name to tell those apart/);
    expect(text).toMatch(/CHECK THE COMFYUI SIDEBAR/);
    expect(text).toMatch(/do not\s+recreate them/);
    // …and it still tells a user with a genuinely empty library what to do next.
    expect(text).toMatch(/save one from the/);
  });

  it("distinguishes a library directory that does not exist yet", async () => {
    // ComfyUI 404s a directory it does not have. For the workflow library that IS a
    // determined negative — nothing has ever been saved — and it is worded as one,
    // with the reason attached rather than left as a bare "none".
    rmSync(join(userRoot, "workflows"), { recursive: true, force: true });
    const text = await listWorkflows();
    expect(text).toMatch(/No workflows to list/);
    expect(text).toMatch(/HTTP 404/);
    // The STATUS is the observation; "the directory is not there" is an inference from
    // it, and a proxy 404 or a mismatched base path makes that inference false. The two
    // must stay apart (codex gate r8).
    expect(text).toMatch(/the answer it gives for a directory it does not have/);
    expect(text).toMatch(/all this call observed, not a verdict on your library/);
    // …but a 404 proves the directory is missing NOW, not that nothing was ever saved,
    // and not that this call even reached the userdata API. Reporting it as a verdict
    // on the library is what would send someone to recreate a workflow they still have.
    expect(text).toMatch(/do NOT recreate/);
    expect(text).toMatch(/different --user-directory/);
  });

  it("does not call a listing of UNRECOGNISED entries an empty library", async () => {
    // `[{}]` decodes to zero names but is not zero workflows: each undecodable entry is
    // a file that EXISTS and cannot be named here.
    forcedEntries = [{}, { size: 12 }];
    const text = await listWorkflows();
    expect(text).toMatch(/Could NOT read the workflow library/);
    expect(text).toMatch(/2 entry\(ies\)/);
    expect(text).not.toMatch(/No saved workflows found/);
    expect(text).toMatch(/do not create or overwrite/);
  });

  it("says the list may be short when SOME entries could not be named", async () => {
    forcedEntries = ["IMAGE/portrait.json", {}, 42];
    const text = await listWorkflows();
    expect(text).toMatch(/Found 1 workflow\(s\)/);
    expect(text).toContain("IMAGE/portrait.json");
    expect(text).toMatch(/2 further entry\(ies\)/);
    expect(text).toMatch(/this list may be short/);
  });

  it("refuses to call a REFUSED listing empty", async () => {
    // A proxy 403, an auth failure, a 500: none of them are evidence about what is
    // saved. Reporting them as "no workflows" is what sends a user to recreate a
    // workflow they already have — and, worse, to overwrite it.
    for (const status of [401, 403, 500, 502]) {
      forcedStatus = status;
      const text = await listWorkflows();
      expect(text, `HTTP ${status}`).toMatch(/Could NOT read the workflow library/);
      expect(text, `HTTP ${status}`).toContain(`HTTP ${status}`);
      expect(text, `HTTP ${status}`).not.toMatch(/No saved workflows found/);
      expect(text, `HTTP ${status}`).toMatch(/do not create or overwrite one/);
    }
  });

  it("refuses to call an UNREACHABLE server empty", async () => {
    // No Response object ever exists — the server was never reached. That is the one
    // outcome that says nothing at all about the library, so it must not be dressed as
    // an answer about it.
    forcedThrow = "socket hang up";
    const text = await listWorkflows();
    expect(text).toMatch(/Could NOT read the workflow library/);
    // Not "the request never arrived" — a reply lost after ComfyUI had already listed
    // the directory looks identical from here. What was observed is the absence of a
    // response (codex gate r8).
    expect(text).toMatch(/no response came back/);
    expect(text).toMatch(/learned nothing about the library either way/);
    expect(text).not.toMatch(/No saved workflows found/);
  });
});
