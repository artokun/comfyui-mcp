// #1175 (recurrence) — two spellings of loopback read as two different servers.
//
// The reporter's panel was on `http://127.0.0.1:8188` while the headless target
// was `http://localhost:8188`. Both reach the same ComfyUI — the headless
// restart succeeded and then probed 127.0.0.1:8188 — but the origins were
// compared with `Array.includes`, so the orchestrator reported "a DIFFERENT
// address" and told them to point COMFYUI_URL at the origin it was already
// pointed at.
//
// That is a diagnosis that sends the reader to fix something that is not broken,
// which is worse than no diagnosis: the previous message at least admitted it
// did not know.

import { afterEach, describe, expect, it } from "vitest";

import { canonicalOrigin, sameOrigin } from "../../utils/origin.js";
import { describeTargetDrift, setConnectedPanelOrigins } from "../../comfyui/fetch.js";

afterEach(() => setConnectedPanelOrigins(null));

describe("canonicalOrigin (#1175)", () => {
  it.each([
    ["http://127.0.0.1:8188", "http://localhost:8188"],
    ["http://localhost:8188", "http://localhost:8188"],
    ["http://[::1]:8188", "http://localhost:8188"],
    ["http://LOCALHOST:8188", "http://localhost:8188"],
    // A path, query and trailing slash are not part of an origin.
    ["http://127.0.0.1:8188/comfy/?x=1", "http://localhost:8188"],
    // A default port is dropped, matching what a browser sends as Origin.
    ["http://localhost:80", "http://localhost"],
    ["https://127.0.0.1:443", "https://localhost"],
  ])("collapses %s -> %s", (input, expected) => {
    expect(canonicalOrigin(input)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["not a url", "unparseable"],
    ["file:///c:/x.html", "no authority (origin is the literal 'null')"],
    [undefined, "absent"],
  ])("returns undefined for %s (%s)", (input) => {
    expect(canonicalOrigin(input as string | undefined)).toBeUndefined();
  });

  it("does NOT collapse a non-loopback host that merely looks local", () => {
    // 127.0.0.2 is loopback by RFC, but two servers really can hold
    // 127.0.0.1:8188 and 127.0.0.2:8188 at once — calling those one origin would
    // be a false identity, the same failure mirrored.
    expect(canonicalOrigin("http://127.0.0.2:8188")).toBe("http://127.0.0.2:8188");
    expect(sameOrigin("http://127.0.0.1:8188", "http://127.0.0.2:8188")).toBe(false);
  });

  it("does NOT collapse across schemes or ports", () => {
    expect(sameOrigin("http://localhost:8188", "https://localhost:8188")).toBe(false);
    expect(sameOrigin("http://localhost:8188", "http://localhost:8189")).toBe(false);
  });

  it("two unparseable inputs are NOT 'the same origin'", () => {
    // Callers use this to decide whether to report a mismatch; making junk equal
    // to junk would silently suppress every real one.
    expect(sameOrigin("nonsense", "nonsense")).toBe(false);
    expect(sameOrigin(undefined, undefined)).toBe(false);
  });
});

describe("describeTargetDrift with aliased loopback (#1175)", () => {
  it("does NOT claim a different address for 127.0.0.1 vs localhost", () => {
    setConnectedPanelOrigins(() => ["http://127.0.0.1:8188"]);
    const out = describeTargetDrift("http://localhost:8188/system_stats");

    expect(out, "the reported false diagnosis").not.toMatch(/DIFFERENT address/);
    expect(out, "and the retry it recommended").not.toMatch(/Point COMFYUI_URL/);
    expect(out).toMatch(/same origin/);
  });

  it("names BOTH spellings so 'same origin' does not read as a contradiction", () => {
    // Two visibly different strings next to the words "this same origin" is what
    // sent the reporter looking for a mismatch that did not exist.
    setConnectedPanelOrigins(() => ["http://127.0.0.1:8188"]);
    const out = describeTargetDrift("http://localhost:8188/x");

    expect(out).toContain("http://127.0.0.1:8188");
    expect(out).toContain("http://localhost:8188");
    expect(out).toMatch(/the same host/);
  });

  it("says nothing extra when the spellings are already identical", () => {
    setConnectedPanelOrigins(() => ["http://localhost:8188"]);
    const out = describeTargetDrift("http://localhost:8188/x");

    expect(out).toMatch(/same origin/);
    expect(out, "no alias clause when there is no alias").not.toMatch(/the same host/);
  });

  it("STILL reports a genuinely different address", () => {
    // The half that must not regress: collapsing aliases must not collapse a
    // real mismatch, which is the whole value of this diagnostic.
    setConnectedPanelOrigins(() => ["http://192.168.1.50:8188"]);
    const out = describeTargetDrift("http://localhost:8188/x");

    expect(out).toMatch(/DIFFERENT address/);
    expect(out).toContain("http://192.168.1.50:8188");
  });

  it("matches an aliased origin among SEVERAL connected panels", () => {
    // The match has to be found by comparison, not by luck of ordering.
    setConnectedPanelOrigins(() => ["http://192.168.1.50:8188", "http://127.0.0.1:8188"]);
    expect(describeTargetDrift("http://localhost:8188/x")).toMatch(/same origin/);
  });

  it("stays silent when there is no panel to compare against", () => {
    // An absent comparison is not a negative result.
    setConnectedPanelOrigins(() => []);
    expect(describeTargetDrift("http://localhost:8188/x")).toBe("");
  });
});
