// A stray control byte is invisible, keeps the file valid UTF-8, keeps git calling it
// TEXT, and survives review — so nothing in this repo noticed one for as long as it was
// there. #2308: `/\bRe-issue the download\b/` in download-progress.test.ts had both
// boundaries stored as literal 0x08 BACKSPACE instead of the two characters `\\b`. The
// pattern could then match nothing, so its `not.toMatch` was satisfied unconditionally —
// a guard that passed whether the behaviour was right or wrong, while still reading as
// coverage in the file and counting in the pass total.
//
// The escape-mangling that produces this happens in tooling, not in an editor, so it can
// recur in any file. This scans the tracked tree instead of that one site.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SCANNED = /[.](ts|mts|cts|js|mjs|cjs|json|md|yml|yaml)$/;

// TAB, LF, CR are ordinary text. Everything else below 0x20 is not.
const isStray = (byte: number): boolean => byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13;

// ANSI escapes are the one legitimate use: this fixture feeds coloured CLI output to a
// parser, and rewriting it to build the escape at runtime would stop it testing the bytes
// the CLI actually emits. Listed by path so a NEW file cannot inherit the exemption.
const ALLOWED = new Set(["src/__tests__/orchestrator/antigravity-backend.test.ts"]);

describe("no stray control bytes in tracked text files", () => {
  it("finds none outside the documented ANSI fixture", () => {
    const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .filter((f) => f && SCANNED.test(f));

    // A scan that walked nothing would report a clean tree, which is the same shape as
    // the bug it looks for. Refuse to pass on an empty file list.
    expect(tracked.length).toBeGreaterThan(500);

    const offenders: string[] = [];
    for (const file of tracked) {
      if (ALLOWED.has(file)) continue;
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(ROOT, file));
      } catch {
        continue; // listed in the index but absent from the worktree
      }
      const found = new Set<string>();
      for (const b of bytes) if (isStray(b)) found.add("0x" + b.toString(16).padStart(2, "0"));
      if (found.size) offenders.push(file + " -> " + [...found].sort().join(", "));
    }

    expect(offenders).toEqual([]);
  });

  it("the scanner actually sees a backspace (it is not a check that cannot fail)", () => {
    // The defect this guards against was itself a check that could not fail, so the
    // detector gets its own positive control.
    expect(isStray(0x08)).toBe(true);
    expect(isStray(0x1b)).toBe(true);
    expect([9, 10, 13, 0x20, 0x41].some(isStray)).toBe(false);
  });
});
