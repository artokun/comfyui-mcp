// #796 sweep — "is not installed" was said for three different failures.
//
// `requireOptionalDep` catches everything `await import(spec)` can throw and
// answers: "Optional dependency for X is not installed. To enable it, run:
// npm install X."
//
// That command fixes exactly one of the three:
//
//   1. the package really is absent          → correct, and the message was right
//   2. the package is present but one of ITS
//      dependencies is not                   → npm install <pkg> reports nothing to do
//   3. the package is present and THROWS on
//      load (a native binary built for the
//      wrong Node ABI or platform)           → npm install <pkg> changes nothing
//
// In 2 and 3 the user runs the suggested command, is told "already up to date",
// and is exactly where they started — having spent the round trip proving the
// advice wrong. The real cause was already in the error's metadata; only the
// sentence claimed to know something it had not checked.
//
// These are REAL import failures, not mocked ones: a package that does not
// exist, a module whose own import is missing, and a module that throws at load.
// The whole question is what Node actually raises, so faking it would test the
// fixture instead of the classifier.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classifyImportFailure, requireOptionalDep } from "../../utils/optional-dep.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "optdep-"));
  mkdirSync(dir, { recursive: true });
  // (3) present, but throws the moment it is loaded.
  writeFileSync(
    join(dir, "throws-on-load.mjs"),
    'throw new Error("libonnxruntime.so.1: cannot open shared object file");\n',
  );
  // (2) present, but its OWN import is absent.
  writeFileSync(
    join(dir, "broken-tree.mjs"),
    'import "definitely-not-a-real-package-xyz";\nexport const ok = true;\n',
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * The thrown error's message + the DISCRIMINATOR, from a real failed import.
 *
 * Read off `details`, not `err.code`: every ModelError's own `code` is the
 * constant "MODEL_ERROR", so a `err.code ?? details.code` fallback short-circuits
 * on it and never reaches the field under test.
 */
async function failureOf(spec: string): Promise<{ message: string; code: unknown }> {
  try {
    await requireOptionalDep(spec, { feature: "the test feature" });
  } catch (err) {
    const e = err as Error & { details?: { code?: unknown } };
    return { message: e.message, code: e.details?.code };
  }
  throw new Error(`expected ${spec} to fail`);
}

describe("a package that is genuinely ABSENT (#796)", () => {
  it("still says 'not installed' and still tells you to install it", async () => {
    // The case the original message was written for. It must not regress — this
    // is the common one and its advice is correct.
    const { message } = await failureOf("definitely-not-a-real-package-xyz");

    expect(message).toMatch(/is not installed/);
    expect(message).toMatch(/npm install definitely-not-a-real-package-xyz/);
    expect(message, "and must not claim it is present").not.toMatch(/IS installed/);
  });

  it("reports the MISSING code, which programmatic callers branch on", async () => {
    const { code } = await failureOf("definitely-not-a-real-package-xyz");
    expect(code).toBe("OPTIONAL_DEP_MISSING");
  });

  it("a SUBPATH request is still the package, not one of its dependencies", async () => {
    // Driven through the CLASSIFIER with the message real Node produces, not
    // through a live import: under vitest the module runner raises a
    // differently-worded error, so an end-to-end version of this passes without
    // ever reaching the branch — which is exactly how the first draft of this
    // test passed while a mutant survived.
    //
    // The wording below was measured, not guessed:
    //   node -e "import('pkg/sub')" → ERR_MODULE_NOT_FOUND,
    //   "Cannot find package 'pkg' imported from …"
    // It names the bare PACKAGE, not what was requested, so a naive
    // `named === spec` test fails and the package is blamed as its own
    // dependency.
    const err = Object.assign(
      new Error(
        "Cannot find package 'definitely-not-a-real-package-xyz' imported from /tmp/y.mjs",
      ),
      { code: "ERR_MODULE_NOT_FOUND" },
    );

    expect(
      classifyImportFailure("definitely-not-a-real-package-xyz/sub", err),
    ).toEqual({ kind: "missing" });
  });

  it("...while a genuinely DIFFERENT package is still transitive", () => {
    // The other side of that comparison, so the fix cannot be "call everything
    // self".
    const err = Object.assign(
      new Error("Cannot find package 'some-other-dep' imported from /tmp/y.mjs"),
      { code: "ERR_MODULE_NOT_FOUND" },
    );

    expect(classifyImportFailure("the-requested-pkg", err)).toEqual({
      kind: "missing-transitive",
      detail: "some-other-dep",
    });
  });
});

describe("a package that is PRESENT but cannot load (#796)", () => {
  it("says it is installed, and does NOT send you to install it", async () => {
    const spec = pathToFileURL(join(dir, "throws-on-load.mjs")).href;
    const { message } = await failureOf(spec);

    expect(message, "the claim that was false").not.toMatch(/is not installed\./);
    expect(message).toMatch(/IS installed, but it failed to LOAD/);
    // The remedy that cannot work must be named as such, not offered.
    expect(message).toMatch(/will report nothing to do/);
  });

  it("carries the REAL failure, which is the only actionable part", async () => {
    const spec = pathToFileURL(join(dir, "throws-on-load.mjs")).href;
    const { message } = await failureOf(spec);

    expect(message).toMatch(/libonnxruntime/);
  });

  it("names the usual cause without asserting it happened", async () => {
    // "usually a native binary built for a different Node/ABI" is a hint, framed
    // as one — the code did not observe that, and saying it did would be this
    // same defect pointed at a different claim.
    const spec = pathToFileURL(join(dir, "throws-on-load.mjs")).href;
    const { message } = await failureOf(spec);

    expect(message).toMatch(/usually/);
  });

  it("does not report the MISSING code for a package that is present", async () => {
    // Programmatic callers branch on this, so it must mean what it says.
    const spec = pathToFileURL(join(dir, "throws-on-load.mjs")).href;
    const { code } = await failureOf(spec);

    expect(code).toBe("OPTIONAL_DEP_UNLOADABLE");
  });
});

describe("a package whose OWN dependency is missing (#796)", () => {
  it("blames the dependency, not the package", async () => {
    const spec = pathToFileURL(join(dir, "broken-tree.mjs")).href;
    const { message } = await failureOf(spec);

    expect(message).toMatch(/IS installed/);
    expect(message, "the actual missing thing").toMatch(/definitely-not-a-real-package-xyz/);
    expect(message).toMatch(/one of its own dependencies/);
  });

  it("offers a remedy that can actually work", async () => {
    const spec = pathToFileURL(join(dir, "broken-tree.mjs")).href;
    const { message } = await failureOf(spec);

    expect(message).toMatch(/--force|install .* directly/);
  });
});
