import { describe, expect, it } from "vitest";

import { tabRouteCarriesPath } from "../../orchestrator/turn-origins.js";

// panel#888 — the spellings a real caller produces, pinned against a route built
// from data captured on the live rig (a genuine tabSessionId and the default
// unsaved workflow, whose name contains a SPACE).
//
// ESCAPE-FREE BY CONSTRUCTION. The backslash is built with fromCharCode(92), not
// written as a literal. When I first checked this by hand the shell ate the
// escape in my probe, the input arrived with no backslash at all, and the result
// looked exactly like a product bug — I nearly "fixed" correct code. The same
// mangling had already corrupted this function's own source once. Any test about
// separators has to be immune to the layer that mangles separators.
const BS = String.fromCharCode(92);
const SESSION = "75e73fe4-d8a1-426a-822e-ad1600ba43d8";
const PATH = "workflows/Unsaved Workflow.json";
const ROUTE = `wf:${SESSION}:${PATH}`;

describe("#888 a route matches its workflow however the caller spells the path", () => {
  it("matches the plain path", () => {
    expect(tabRouteCarriesPath(ROUTE, PATH)).toBe(true);
  });

  it("matches Windows separators — the reporter's platform", () => {
    expect(tabRouteCarriesPath(ROUTE, "workflows" + BS + "Unsaved Workflow.json")).toBe(true);
  });

  it("matches a ./ prefix and case differences", () => {
    expect(tabRouteCarriesPath(ROUTE, "./workflows/Unsaved Workflow.json")).toBe(true);
    expect(tabRouteCarriesPath(ROUTE, "WORKFLOWS/unsaved workflow.json")).toBe(true);
  });

  it("still matches the legacy handle-shaped id older panels send", () => {
    expect(tabRouteCarriesPath(`wf:${PATH}`, PATH)).toBe(true);
  });
});

describe("#888 and does NOT match what it should not", () => {
  it("a different workflow in the same directory", () => {
    expect(tabRouteCarriesPath(ROUTE, "workflows/Anima Wojak Batch.json")).toBe(false);
  });

  it("the route's own session segment is never mistaken for the path", () => {
    // `wf:<tabRouteId>:<path>` — a caller passing the tab route id must not
    // accidentally satisfy a workflow match.
    expect(tabRouteCarriesPath(ROUTE, SESSION)).toBe(false);
  });

  it("a non-route id is refused outright", () => {
    expect(tabRouteCarriesPath("tmp:2522828d", PATH)).toBe(false);
    expect(tabRouteCarriesPath("", PATH)).toBe(false);
  });
});
