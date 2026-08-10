// #1285 — a tab id is a bridge ROUTE, and `shortTabId` was written for a path.
//
// The panel's own bridge-route.js (#640) defines two shapes and says they are
// not interchangeable — confirmed here against the LIVE served panel, not just
// repo source:
//
//   savedWorkflowHandle(path)            -> wf:<path>               names a WORKFLOW
//   savedWorkflowRoute(tabRouteId, path) -> wf:<tabRouteId>:<path>  names a TAB
//
// The handle is path-only PRECISELY BECAUSE two browser tabs can show the same
// file, so it cannot address one of them. `bridge.tabs()` returns routes.
//
// `shortTabId` sliced the `wf:` prefix and treated the whole remainder as a
// path, so a route rendered down to just its basename — throwing away the one
// component that distinguishes two tabs showing the SAME file. That is #934's
// failure returning by another door: two different tabs rendering identically,
// inside the messages written to tell them apart.
//
// THE SEPARATOR IS THE FIRST COLON, because `savedWorkflowRoute` refuses a
// tabRouteId containing one. A path may contain colons (`C:\…`), so a head that
// is a single character, or that holds a path separator, is not a route id.

import { describe, expect, it } from "vitest";

import { shortTabId } from "../../services/session-scope.js";

describe("shortTabId renders a ROUTE as a tab, not a path (#1285)", () => {
  it("keeps the tab route id, which is what distinguishes two tabs", () => {
    const a = shortTabId("wf:tabAAAA:workflows/portrait.json");
    const b = shortTabId("wf:tabBBBB:workflows/portrait.json");

    expect(a).not.toBe(b);
    expect(a).toContain("portrait.json");
    expect(b).toContain("portrait.json");
  });

  it("SAME FILE, TWO TABS must not render identically — the #934 failure", () => {
    // Exactly the shape that produced "Rebound this session from tab wf:workf
    // onto the active tab wf:workf" for a rebind between two different tabs.
    const rendered = new Set([
      shortTabId("wf:aaa111:workflows/video_minimax.json"),
      shortTabId("wf:bbb222:workflows/video_minimax.json"),
    ]);
    expect(rendered.size).toBe(2);
  });

  it("still keeps the filename, which is what a reader recognises", () => {
    expect(shortTabId("wf:tab123:workflows/nested/deep/flux_dev.json")).toContain(
      "flux_dev.json",
    );
  });

  it("bounds a very long filename rather than dumping it", () => {
    const long = `wf:tab123:workflows/${"x".repeat(200)}.json`;
    expect(shortTabId(long).length).toBeLessThan(60);
  });
});

describe("shortTabId still handles the shapes that are NOT routes (#1285)", () => {
  it("a HANDLE (wf:<path>, no tab id) keeps its old rendering", () => {
    // bridge-route.js marks this "NOT a bridge route", but it exists and may
    // reach here; treating its path as a route id would mangle it.
    expect(shortTabId("wf:workflows/portrait.json")).toBe("wf:portrait.json");
  });

  it("a WINDOWS path in a handle is not mistaken for a route id", () => {
    // `C:` would be the first colon. A one-character head is not a tab route id,
    // and the path must survive intact.
    expect(shortTabId("wf:C:/Users/me/workflows/portrait.json")).toBe("wf:portrait.json");
    expect(shortTabId("wf:C:\\Users\\me\\workflows\\portrait.json")).toBe("wf:portrait.json");
  });

  it("a head containing a path separator is not a route id", () => {
    // `workflows/a:b.json` has a colon inside the path, after a separator.
    expect(shortTabId("wf:workflows/odd:name.json")).toContain("odd:name.json");
  });

  it("a non-wf id keeps the 8-char slice", () => {
    expect(shortTabId("tmp:0123456789abcdef")).toBe("tmp:0123");
    expect(shortTabId("orchestrator::claude")).toBe("orchestr"); // 8 chars
  });

  it.each([undefined, null, ""])("survives %o without throwing", (id) => {
    expect(() => shortTabId(id as string | undefined | null)).not.toThrow();
  });
});
