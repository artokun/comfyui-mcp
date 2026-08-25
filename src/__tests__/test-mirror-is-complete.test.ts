import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// vitest.config.ts includes only `src/__tests__/**`, and tsconfig.json excludes only
// `src/__tests__`. The two are a matched pair, and the pair has a silent failure mode:
// a `*.test.ts` written anywhere else under src/ is invisible to vitest AND compiled
// into dist/. It does not fail — it simply stops being a test, and the suite still
// reports green. This turns that silence into a failure.
const SRC = join(process.cwd(), "src");
const MIRROR = join(SRC, "__tests__");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (full === MIRROR) continue;
      walk(full, out);
    } else if (/\.(test|spec)\.ts$/.test(entry)) {
      out.push(relative(SRC, full).split(sep).join("/"));
    }
  }
  return out;
}

describe("the __tests__ mirror is the only place tests live", () => {
  it("finds no test file outside src/__tests__", () => {
    expect(walk(SRC)).toEqual([]);
  });
});
