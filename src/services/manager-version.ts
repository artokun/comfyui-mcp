/**
 * The Manager MAJOR-version parse, shared by every caller that needs to know
 * which ComfyUI-Manager generation it is talking to.
 *
 * Extracted from node-management.ts (#2320) because a SECOND caller — the
 * remote reboot path in process-control.ts — was drawing the same conclusion
 * ("this is a legacy Manager 3.x") from probe-shape instead, and got it wrong
 * against a V4.2.2 server. The probe TRANSPORT differs between the two callers
 * (node-management goes through `managerFetch`, which adds auth diagnostics and
 * throws on hard failures; the reboot path uses a bare soft `comfyuiFetch`), so
 * only the part that actually decides the answer lives here.
 */

/**
 * Authoritative Manager MAJOR-version parse (issue #555). The two Manager
 * generations expose their version string on DISJOINT paths and nowhere else:
 *   • v4 (pip comfyui-manager) → GET /v2/manager/version   → text "V4.2.2"
 *   • released 3.x             → GET /manager/version      → text "V3.41"
 * (v4 registers NO bare /manager/version; 3.x registers NO /v2/* — verified
 * against both upstream sources.) Both return a BARE version string, so this is
 * an authoritative version signal that a 405/route-shape is NOT: a 405 means
 * "wrong method for THIS endpoint", never "old Manager". Returns the major int,
 * or undefined when neither answers with a plausible version string.
 *
 * The parse is deliberately strict (short, `V?<digits>.<digits>…`) so ComfyUI's
 * SPA catchall — which 200s unknown GETs with a page of HTML — can never be
 * mistaken for a version string. That strictness is the whole point of sharing
 * this: it is the one guard standing between a catchall 200 and a false version
 * claim, and a second hand-rolled copy is how the two drift apart.
 */
export function parseManagerMajor(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (t.length === 0 || t.length > 16) return undefined; // reject HTML/SPA bodies
  const m = t.match(/^v?(\d+)(?:\.\d+)*$/i);
  return m ? Number(m[1]) : undefined;
}

/**
 * Version routes in the order they should be tried: v4's `/v2/manager/version`
 * is the strongest signal (3.x registers no `/v2/*` at all), so a parse there
 * settles it without consulting the legacy path.
 */
export const MANAGER_VERSION_ROUTES: readonly string[] = [
  "/v2/manager/version",
  "/manager/version",
];
