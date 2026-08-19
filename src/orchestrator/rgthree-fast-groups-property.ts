/**
 * #1808 — panel_set_property(matchTitle) on Fast Groups Bypasser/Muter stores
 * the property but does not reliably rebuild the toggle list.
 *
 * Verified against rgthree-comfy `src_web/comfyui/fast_groups_muter.ts` and
 * `services/fast_groups_service.ts`, not inferred from the report:
 *
 *   1. Fast Groups nodes do NOT implement onPropertyChanged. The panel invokes
 *      that callback when present; these nodes never define it, so a successful
 *      set is a stored value plus setDirtyCanvas — not a live re-filter.
 *
 *   2. The toggle list is rebuilt by refreshWidgets() on FAST_GROUPS_SERVICE
 *      (8 ms after add, then every ~500 ms). addFastGroupNode schedules that
 *      first tick BEFORE matchTitle is usually written, so a newly added node
 *      paints every group in the workflow.
 *
 *   3. Leftover-row removal is `while (widgets[index]) removeWidget(index++)`.
 *      RgthreeBaseNode.removeWidget accepts a numeric index, so incrementing
 *      after a splice skips the row that just slid into `index`. 22 unfiltered
 *      rows with 4 matches stall at 13 (4 kept + every other leftover).
 *
 *   4. panel_query_graph keys widgets by name. Every Fast Groups toggle is
 *      named RGTHREE_TOGGLE_AND_NAV and distinguished only by label, so a
 *      never-built list is widgets:{} and a built list collapses to one key —
 *      empty does NOT mean "no matching groups".
 *
 * The property write is real. The rebuild is rgthree's, and it is racy. The
 * shipped panel_set_property path therefore stops claiming a live re-filter
 * and tells the caller to re-read and set again rather than delete+re-add.
 */

export const FAST_GROUPS_FILTER_PROPERTIES = [
  "matchTitle",
  "matchColors",
  "sort",
  "customSortAlphabet",
  "toggleRestriction",
  "showNav",
  "showAllGraphs",
] as const;

export type FastGroupsFilterProperty = (typeof FAST_GROUPS_FILTER_PROPERTIES)[number];

export function isFastGroupsFilterProperty(name: unknown): name is FastGroupsFilterProperty {
  return typeof name === "string" && (FAST_GROUPS_FILTER_PROPERTIES as readonly string[]).includes(name);
}

/** Appended after a successful set of a Fast Groups filter property. */
export function fastGroupsFilterPropertyNote(): string {
  return (
    "\n\nIf this is a Fast Groups Bypasser/Muter: the property is stored, but rgthree " +
    "does NOT implement onPropertyChanged — the toggle list rebuilds on its own " +
    "refreshWidgets service tick. That rebuild can leave leftover Enable rows " +
    "(splice-while-removing skips every other leftover) or an empty widgets:{} " +
    "(the list has not been built yet, not \"no matches\"). Re-read the node with " +
    "panel_query_graph {ids:[…], fields:'detail'}. If the canvas still shows groups " +
    "that do not match, set the property again — do not delete and re-add the node."
  );
}
