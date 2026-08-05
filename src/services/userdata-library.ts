// The connected ComfyUI's SAVED workflow library, read through its userdata API.
//
// #810: `list_workflows` asked for `/api/userdata?dir=workflows` — a SHALLOW read —
// and reported the resulting empty array as "No saved workflows found." A user whose
// six workflows all live in `IMAGE/` and `VIDEO/MiniMaxH3/` (the folder tree the
// ComfyUI web UI sidebar shows) was told their library was empty. That is the repo's
// dominant defect class: "could not determine X" rendered as "determined X is not the
// case", and here it is worse than slow — it sends the user to recreate a workflow
// they already have.
//
// One listing read, in one place, so a second caller cannot re-introduce the shallow
// spelling: panel_load_workflow's resolver already used `recurse=true` (it was fixed
// for #202) while list_workflows did not, which is exactly the drift a shared helper
// removes.
import { getClient } from "../comfyui/client.js";

/**
 * The listing route for the workflow library.
 *
 * `recurse=true` is VERIFIED against the installed ComfyUI (app/user_manager.py
 * `listuserdata`): with it the glob is `<dir>/**\/*` and a workflow in a SUBFOLDER
 * comes back as its store-relative path ("VIDEO/MiniMaxH3/x.json"); without it the
 * glob is `<dir>/*` and that file is simply absent. Root entries stay bare either way,
 * so the recursive listing is a strict superset — nothing that used to be listed stops
 * being listed.
 *
 * `split=false` is explicit rather than implied. The endpoint switches shape on
 * `split=true` (each entry becomes `[rel_path, ...segments]`), and its default is
 * "absent means false"; naming it means a build that ever flipped that default cannot
 * silently turn every entry into an array. Unknown/false-valued query args are ignored
 * by builds that do not implement them, so this needs no version gate: the worst case
 * on an ancient build is the flat list it already returned.
 */
export const WORKFLOW_LIBRARY_LISTING_ROUTE =
  "/api/userdata?dir=workflows&recurse=true&split=false";

/**
 * Issue ONE userdata GET and hand back the raw Response.
 *
 * This deliberately bypasses the client's own `fetchApi` (panel #202, codex/gate
 * MAJOR). `fetchApi` throws for every non-2xx AND calls `response.json()` while
 * building that error — so a refusal with a non-JSON body (ComfyUI's own `403 Invalid
 * directory` / `404 Directory not found` are text/plain, as is a proxy's 403 or an
 * HTML 502) rejects with a STATUSLESS SyntaxError. There is then no way to tell "the
 * server refused" from "the server was never reached", and both get reported as
 * whatever the caller's catch-all says.
 *
 * Building the request from the client's own `apiURL` + `apiHeaders` keeps every
 * transport concern identical (host, ssl, base path, clientId, Comfy-User, the
 * injected COMFYUI_AUTH_* fetch) while making the outcome unambiguous:
 *   - a returned Response  = the server ANSWERED; classify by status, decode later
 *   - a thrown error       = no Response exists, so the request never got one
 * Nothing here reads a body, so a body that cannot be decoded can never be mistaken
 * for a transport failure.
 */
export async function userdataFetch(route: string): Promise<Response> {
  const client = getClient();
  return await client.fetch(client.apiURL(route), { headers: client.apiHeaders() });
}

/**
 * The outcome of one library listing, with "the library is empty" kept DISTINCT from
 * "the library could not be read".
 *
 *  - `ok: true`   — the server answered with a list.
 *  - `ok: false`  — no usable list. `kind` says which flavour, so a caller can word a
 *                   missing directory differently from a refusal, instead of collapsing
 *                   both into "no workflows found".
 */
export type WorkflowLibraryListing =
  /** The server answered with a list. `keys` may legitimately be empty — but only when
   *  `unreadable` is 0, because an entry this build could not decode is a workflow that
   *  EXISTS and is missing from `keys`. Reporting `[{}]` as an empty library would be
   *  the same false negative in miniature (codex gate MAJOR). */
  | { ok: true; keys: string[]; unreadable: number }
  | { ok: false; kind: "absent" | "refused" | "unreachable" | "undecodable"; detail: string };

/** Normalize one listing entry to a store-relative key, or null when it is not one. */
function entryKey(entry: unknown): string | null {
  // The default shape on every build we have seen: a bare relative path.
  if (typeof entry === "string") return entry || null;
  // `split=true` shape, in case a build ever returns it despite `split=false`:
  // [rel_path, ...segments] — element 0 is the same key the default shape returns.
  if (Array.isArray(entry)) return typeof entry[0] === "string" && entry[0] ? entry[0] : null;
  // `full_info=true` shape: { path, size, modified }.
  const rec = entry as { path?: unknown; name?: unknown } | null;
  if (rec && typeof rec.path === "string" && rec.path) return rec.path;
  if (rec && typeof rec.name === "string" && rec.name) return rec.name;
  return null;
}

/**
 * The connected ComfyUI's OWN list of saved workflow store keys — asked, never
 * reconstructed, so it reflects the server's runtime `--user-directory`.
 *
 * Keys are store-relative and INCLUDE any subfolder ("VIDEO/MiniMaxH3/x.json"). They
 * are used verbatim: nothing is stripped, case-folded or separator-folded here,
 * because a depth-0 request must only ever match a depth-0 entry (panel #202 gate
 * MAJOR) and because those keys are what `get_workflow`/`analyze_workflow`/
 * `query_workflow` take as `filename`.
 *
 * Never throws.
 */
export async function listWorkflowLibraryKeys(): Promise<WorkflowLibraryListing> {
  let res: Response;
  try {
    res = await userdataFetch(WORKFLOW_LIBRARY_LISTING_ROUTE);
  } catch (err) {
    return {
      ok: false,
      kind: "unreachable",
      detail: `the request never reached the server (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (!res.ok) {
    // 404 is ComfyUI's answer for "that directory does not exist". What it PROVES is
    // that the directory is not there NOW — not the historical claim that nothing was
    // ever saved (codex gate MAJOR), and not that this request even reached the
    // listing handler rather than a proxy or a mismatched base path. So it is kept
    // separate from a refusal, and the caller words it as an observation with its
    // caveat rather than as a verdict on the user's library.
    return res.status === 404
      ? { ok: false, kind: "absent", detail: "the server answered HTTP 404 for its `workflows` directory" }
      : { ok: false, kind: "refused", detail: `the server answered HTTP ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return {
      ok: false,
      kind: "undecodable",
      detail: `the listing body did not parse as JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (!Array.isArray(body)) {
    return { ok: false, kind: "undecodable", detail: "the listing was not a JSON array" };
  }
  const decoded = body.map(entryKey);
  const keys = decoded.filter((k): k is string => k != null);
  // An entry in a shape none of the known ComfyUI response forms produce is a workflow
  // this call cannot name. Silently dropping it is how a listing becomes a lie by
  // omission — and a listing of ONLY such entries would otherwise read as an empty
  // library. Count them so the caller can say the list may be short.
  return { ok: true, keys, unreadable: decoded.length - keys.length };
}
