// WHY the fence-adoption validator refused, in words the caller can act on.
//
// Extracted from the validator callback in index.ts so it is reachable by tests:
// while it lived inline, the only way to assert the wording was to build a fake
// bridge and check that it returned what the fake was told to return — a
// tautology that would have passed with the logic deleted.
//
// #1077 — the validator has three gates and all of them used to return a bare
// `false`, so a permanently-wedged session was told only "the adoption was
// REFUSED". Naming the gate is the fix; naming it WRONGLY is worse than not
// naming it, which is what the first version of this did.
//
// `canReach()` and `tabServerOrigin()` both swallow whatever `resolveTarget`
// throws, so a turn issued from SEVERAL workflows at once (routing ambiguity,
// #1001) is indistinguishable at those call sites from a dead tab and from a
// connection carrying no Origin. It therefore inherited the structural
// no-Origin story: "refreshing will not help, stop using the relay backend".
// For an ambiguous turn that is wrong on every count — the tabs are connected,
// the Origin exists, nothing is structural, and it clears on the next
// single-origin message. The cause is typed and was simply being discarded.

/** What `UiBridge.resolveFailure()` reports: why a tab id does not resolve, or
 *  undefined when it does. */
export type ResolveFailure = "ambiguous" | "unresolved" | undefined;

/** The turn's target is ambiguous — say so, and say it is self-clearing. */
function ambiguousTurn(tabId: string, what: string): string {
  return (
    `this turn was issued from SEVERAL workflows at once, so ${what} for "${tabId}" — the tabs ` +
    `are connected and fine. This clears itself: target a workflow explicitly ` +
    `(panel_set_workflow_target with a path, or panel_open_workflow), or let the next ` +
    `single-origin message settle it. Do NOT reconnect or refresh.`
  );
}

/** Gate 1: the routed tab did not resolve at all. */
export function unreachableReason(tabId: string, failure: ResolveFailure): string {
  if (failure === "ambiguous") return ambiguousTurn(tabId, "there is no single target to fence");
  return `the routed tab (${tabId}) is no longer reachable, so there is nothing to fence`;
}

/** Gate 2: it resolved, but not to a live panel tab. */
export function noPanelTabReason(tabId: string): string {
  return `${tabId} does not resolve to a live panel tab (a scope address whose tab has gone away)`;
}

/**
 * Gate 3: the workflow identity did not validate.
 *
 * ORDER MATTERS. An ambiguous turn also yields no origin, so it must be checked
 * BEFORE the structural no-Origin case, or it borrows a remedy that cannot help
 * it and is told its problem is permanent.
 */
export function identityReason(
  tabId: string,
  origin: string | undefined,
  workflowUuid: unknown,
  failure: ResolveFailure,
): string {
  if (!origin && failure === "ambiguous") {
    return ambiguousTurn(tabId, "no single tab's identity could be read");
  }
  if (!origin) {
    // The relay case USED to land here and was told, correctly at the time, that
    // its problem was permanent. It no longer is: the relay path now supplies the
    // origin it already knows from COMFYUI_URL, so a relay session adopts fences
    // like any other. Naming a fixed cause as the "known case" would send a
    // reader to change a backend that is no longer the reason (#1077).
    return (
      `this tab's connection carries no server-observed Origin, and the workflow identity is ` +
      `bound to one — so the fence cannot be adopted for it. Refreshing the tab will not ` +
      `change it. This means the connection reached the orchestrator by a path that neither ` +
      `observed nor was told the panel's origin; if COMFYUI_URL is unset or unparseable for ` +
      `this session, setting it to the URL the panel is served from is what supplies it.`
    );
  }
  return (
    `the workflow identity did not validate (uuid ${String(workflowUuid)} against origin ` +
    `${origin}) — a malformed uuid, or one bound to a different origin.`
  );
}
