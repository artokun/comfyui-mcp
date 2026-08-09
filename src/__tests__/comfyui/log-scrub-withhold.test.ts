// #1206 — the FAIL-CLOSED half of the log scrub, in its own file because it
// needs a different configured credential than the redaction tests.
//
// `scrubSecretShapedText` returns null when it cannot substitute a configured
// credential without mangling unrelated text — documented trigger: a credential
// shorter than 8 characters. That must REPLACE the line with a marker, never
// delete it: a shorter log with no explanation is a worse diagnostic than one
// that says what it withheld, and a caller counting lines would be misled.

import { describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  // Deliberately SHORT — this is the documented "too short to replace safely"
  // case, and it is the only reliable way to reach the null branch.
  getComfyUIAuthHeaders: () => ({ Authorization: "abc" }),
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  config: {},
}));

const { scrubLogLines } = await import("../../comfyui/json-guard.js");

describe("a line that cannot be scrubbed is withheld VISIBLY (#1206)", () => {
  it("replaces the line with a marker rather than emptying it", () => {
    const out = scrubLogLines(["[INFO] header was abc"]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/withheld/);
    // An empty string would satisfy "no credential" while silently deleting the
    // entry — the failure mode this wording exists to prevent.
    expect(out[0].length).toBeGreaterThan(0);
    expect(out[0]).not.toContain("header was abc");
  });

  it("withholds only the affected line, never the whole log", () => {
    const out = scrubLogLines(["fine one", "[INFO] header was abc", "fine two"]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("fine one");
    expect(out[2]).toBe("fine two");
    expect(out[1]).toMatch(/withheld/);
  });
});
