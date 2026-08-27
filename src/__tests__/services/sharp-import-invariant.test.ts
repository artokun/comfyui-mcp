// #2411 — ONLY sharp-loader.ts MAY NAME "sharp", AND ONLY LAZILY.
//
// This is the pin that actually catches the regression, and it exists because
// the obvious behavioural test could not.
//
// WHAT WAS TRIED FIRST, AND WHY IT IS NOT HERE. The natural test is "mock sharp
// to throw, import the services, assert they survive". Two mechanisms were built
// and both failed as CONTROLS — each reported the fix working while the fix was
// reverted:
//
//   1. `vi.doMock("sharp", () => { throw … })` only intercepts the TEST FILE's
//      own `import("sharp")`. A static `import sharp from "sharp"` inside a
//      transformed source module resolves normally, so restoring the top-level
//      import in all three services left 23/23 green.
//   2. A real Node module-customization hook (`registerHooks`) run under `tsx`
//      never fired at all — tsx's own resolver short-circuits `sharp` before the
//      hook is consulted. Verified by logging inside the hook: zero
//      interceptions, with and without the mutation.
//
// A test whose mutation survives is not a test. So the invariant is enforced
// where it is actually decidable — in the source — which is the same choice
// check-panel-scope / check-tool-vocabulary / check-anti-slop already make.
//
// THE INVARIANT. `sharp` throws while it EVALUATES when its native library
// cannot be loaded, and every service that imported it at module scope is
// reachable statically from `src/tools/index.ts`. So a single top-level import
// anywhere in production takes down every tool and the transport with it —
// measured by moving `libvips-cpp-8.18.3.dll` aside and running
// `node dist/index.js`, which died before registering anything.
//
// Type-only imports are exempt: `import type { Metadata } from "sharp"` is
// erased by the compiler and loads nothing at runtime.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(fileURLToPath(new URL("../../", import.meta.url)));

/** The one module allowed to load sharp, and only through a caught dynamic import. */
const LOADER = join("services", "sharp-loader.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Tests legitimately import sharp directly — inline-preview.test.ts builds
      // real images with it precisely because stubbing the encoder would assert a
      // prediction that fix deliberately does not trust (#1495).
      if (entry === "__tests__") continue;
      walk(full, out);
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** A non-type import of sharp: the thing that evaluates the native library. */
const VALUE_IMPORT = /^[^\S\n]*import[^\S\n]+(?!type[^\S\n])[^;]*?from[^\S\n]*["']sharp["']/m;
/** A bare side-effect import — `import "sharp"` — which also evaluates it. */
const BARE_IMPORT = /^[^\S\n]*import[^\S\n]*["']sharp["']/m;
/** CommonJS, which evaluates it just the same. */
const REQUIRE = /require\([^\S\n]*["']sharp["'][^\S\n]*\)/;
/** Any dynamic import, allowed only inside the loader. */
const DYNAMIC_IMPORT = /(?<!typeof[^\S\n])import\([^\S\n]*["']sharp["'][^\S\n]*\)/;

describe("no production module loads sharp at evaluation time (#2411)", () => {
  const files = walk(SRC).map((f) => ({ path: f, rel: relative(SRC, f), src: readFileSync(f, "utf8") }));

  it("finds the source tree it means to check", () => {
    // Guard the guard: a walk that silently returned nothing would pass every
    // assertion below while checking absolutely nothing.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.rel === join("tools", "index.ts"))).toBe(true);
    expect(files.some((f) => f.rel === LOADER)).toBe(true);
  });

  it("no production file imports sharp as a VALUE", () => {
    const offenders = files
      .filter((f) => VALUE_IMPORT.test(f.src) || BARE_IMPORT.test(f.src) || REQUIRE.test(f.src))
      .map((f) => f.rel.split(sep).join("/"));
    // Every one of these evaluates sharp when its own module is evaluated, and
    // tools/index.ts reaches the services statically — so one offender is a dead
    // orchestrator on any machine whose libvips will not load.
    expect(offenders).toEqual([]);
  });

  it("only sharp-loader.ts may dynamically import sharp", () => {
    const offenders = files
      .filter((f) => f.rel !== LOADER && DYNAMIC_IMPORT.test(f.src))
      .map((f) => f.rel.split(sep).join("/"));
    // Not a style rule: the loader is where the catch, the memo, the env switch
    // and the worded message live. A second `await import("sharp")` elsewhere
    // would reintroduce an uncaught failure with none of them.
    expect(offenders).toEqual([]);
  });

  it("the loader itself imports sharp lazily and catches it", () => {
    const loader = files.find((f) => f.rel === LOADER);
    expect(loader).toBeDefined();
    // The whole point of the file: a dynamic import, inside a try, not at module
    // scope. If this ever became a static import the module would throw on load
    // and take its own callers down — the exact defect it was written to fix.
    expect(VALUE_IMPORT.test(loader!.src)).toBe(false);
    expect(BARE_IMPORT.test(loader!.src)).toBe(false);
    expect(DYNAMIC_IMPORT.test(loader!.src)).toBe(true);
    expect(loader!.src).toMatch(/try\s*\{[\s\S]*?await import\(["']sharp["']\)[\s\S]*?\}\s*catch/);
  });
});
