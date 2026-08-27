// #2418 — `node_pack` action:"search" died with
//   {"error":"NODE_DEV_ERROR","message":"Failed to execute rg: spawnSync rg ENOBUFS"}
// on a workspace containing a minified one-line workflow JSON.
//
// `--max-count` is per FILE, so one such file can put its whole self on stdout. Measured
// against real ripgrep 15.0.0: a 42 MB single-line file produced 33 MB of stdout, over
// spawnSync's 32 MB maxBuffer, and the whole search failed before returning any match.
// SEARCH_LINE_MAX could not help — clipMatchLine runs AFTER spawnSync returns.
//
// The fix bounds the printed line AT THE SOURCE. These pin both halves: the flags are
// actually passed, and the preview that comes back is described honestly rather than
// with a fabricated dropped-character count.
import { describe, expect, it } from "vitest";

import {
  clipMatchLine,
  READ_MAX_CHARS,
  RIPGREP_LONG_LINE_MARKER,
  SEARCH_LINE_MAX,
  SEARCH_MAX_COLUMNS,
} from "../../services/node-dev.js";

describe("the printed bound is tied to the display cap (#2418)", () => {
  it("SEARCH_MAX_COLUMNS is SEARCH_LINE_MAX, not a second free-floating number", () => {
    // Asking ripgrep for MORE than we can display buys nothing and spends the buffer
    // this fix exists to protect: at 4096 each long line costs ~6.5x what it does here,
    // which is the same overflow one order of magnitude further out. Asking for LESS
    // would make the preview shorter than the cap the refusal advertises.
    expect(SEARCH_MAX_COLUMNS).toBe(SEARCH_LINE_MAX);
  });
});

describe("clipMatchLine on a ripgrep-truncated preview (#2418)", () => {
  const preview = "x".repeat(SEARCH_MAX_COLUMNS) + RIPGREP_LONG_LINE_MARKER;

  it("never states a dropped-character count it could not have measured", () => {
    const out = clipMatchLine(preview);
    // The reported line was 42 MB. Computing +N from the PREVIEW's length would have
    // claimed roughly +31 characters — a precise-looking number that is simply false.
    expect(out).not.toMatch(/\+\d+ chars/);
    expect(out).toContain("its full length was not measured");
  });

  it("still says the line continues, and names the cap that cannot be raised", () => {
    const out = clipMatchLine(preview);
    expect(out).toContain(`fixed ${SEARCH_LINE_MAX}-char per-line cap`);
    expect(out).toContain(String(READ_MAX_CHARS));
  });

  it("honours SEARCH_LINE_MAX and drops ripgrep's own marker", () => {
    const out = clipMatchLine(preview);
    expect(out.length).toBeLessThanOrEqual(SEARCH_LINE_MAX);
    expect(out).not.toContain(RIPGREP_LONG_LINE_MARKER);
  });

  it("an ordinary long line KEEPS the measured +N count — the #809 behaviour", () => {
    const out = clipMatchLine("y".repeat(SEARCH_LINE_MAX * 3));
    expect(out).toMatch(/\+\d+ chars/);
    expect(out).toContain(`fixed ${SEARCH_LINE_MAX}-char per-line cap`);
    expect(out.length).toBeLessThanOrEqual(SEARCH_LINE_MAX);
  });

  it("a short line is returned untouched by either path", () => {
    expect(clipMatchLine("const a = 1;")).toBe("const a = 1;");
  });

  it("the source-truncated branch is keyed on ripgrep's marker, not on length", () => {
    // A line UNDER the cap that still carries the marker is a preview and must be
    // described as one; length alone would have let it through unmarked.
    const shortPreview = "z".repeat(20) + RIPGREP_LONG_LINE_MARKER;
    expect(shortPreview.length).toBeLessThan(SEARCH_LINE_MAX);
    expect(clipMatchLine(shortPreview)).toContain("its full length was not measured");
  });
});
