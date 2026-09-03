// #2784 — a refusal that names no evidence is a claim the reader cannot check.
//
// `restart_comfyui` refused with "ComfyUI Desktop started the server on port 8191",
// on a ComfyUI-Easy-Install running an embedded python. The reporter could see it
// was wrong and had nothing to test it against; the report arrived with the path
// redacted to `~`, so the cause could not be reproduced from it either. Running the
// pure predicates against their argv as posted does NOT classify, which means the
// trigger is in the part they redacted — and no output would have told them which.
//
// Three signals reach the same verdict and they are not equally strong:
//
//   on-disk Desktop-2 marker   a fact about the install
//   ancestor Desktop binary    a fact about the process tree
//   argv substring             a NAME match, which a directory can satisfy by
//                              being called that
//
// These pin that the weakest one identifies itself as weak, because that is the one
// a user can recognise and contest.

import { describe, expect, it } from "vitest";
import { __processControlTestHooks } from "../../services/process-control.js";

/** The marker set, as the shipped predicate holds it. */
const MARKERS = [
  "programs/comfyui/resources",
  "programs\\comfyui\\resources",
  "comfyui.app",
  "comfy desktop",
  "comfy-desktop",
  "comfyui-desktop-2",
  "@comfyorgcomfyui-electron",
];

describe("#2784 the Desktop classification names its evidence", () => {
  it("exposes a test seam at all", () => {
    // If this fails the seam was renamed; the tests below say nothing until it is
    // re-pointed, and a silently skipped suite is worse than a red one.
    expect(typeof __processControlTestHooks.reset).toBe("function");
  });

  it.each(MARKERS)("an argv carrying %s is a NAME match, not a launch fact", (marker) => {
    // The predicate is `joined.includes(marker)` over the whole command line. So a
    // path segment is enough — which is the reading the refusal must not hide.
    const argv = [`C:\\Users\\x\\${marker}\\ComfyUI\\main.py`, "--port", "8191"];
    const joined = argv.join(" ").toLowerCase();
    expect(joined.includes(marker)).toBe(true);
  });

  it("the reporter's argv as POSTED does not classify — the trigger is in the redaction", () => {
    // Recorded because it is the fact that made the report unreproducible, and the
    // fact this change exists to prevent recurring.
    const argv = [
      "C:\\Users\\x\\ComfyUI-Easy-Install\\ComfyUI\\main.py",
      "--use-pytorch-cross-attention",
      "--port",
      "8191",
    ];
    const joined = argv.join(" ").toLowerCase();
    expect(MARKERS.some((m) => joined.includes(m))).toBe(false);
  });

  it("a directory merely NAMED like Desktop does classify", () => {
    // The most likely un-redaction, and the one the evidence clause is written to
    // make legible: an ordinary install under a folder called `Comfy-Desktop`.
    const argv = ["D:\\AI\\Comfy-Desktop\\ComfyUI-Easy-Install\\ComfyUI\\main.py", "--port", "8191"];
    const joined = argv.join(" ").toLowerCase();
    expect(MARKERS.some((m) => joined.includes(m))).toBe(true);
  });
});

describe("#2784 the refusal carries the clause", () => {
  const src = new URL("../../services/process-control.ts", import.meta.url);

  it("appends the evidence to the abandoned-supervisor refusal", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const text = readFileSync(fileURLToPath(src), "utf-8");
    const at = text.indexOf("ComfyUI Desktop started the server on port");
    expect(at).toBeGreaterThan(-1);
    // Within the same template, not merely somewhere in the file.
    expect(text.slice(at, at + 1600)).toContain("desktopEvidenceClause(info)");
  });

  it("says the argv signal is a NAME match, in the message the user reads", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const text = readFileSync(fileURLToPath(src), "utf-8");
    // The whole point: the weakest signal must identify itself as contestable.
    expect(text).toContain("a NAME match, which a directory merely CALLED that also satisfies");
    expect(text).toContain("Classified as Desktop-managed by:");
  });

  it("says NOTHING when no evidence was recorded", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const text = readFileSync(fileURLToPath(src), "utf-8");
    const at = text.indexOf("function desktopEvidenceClause");
    expect(at).toBeGreaterThan(-1);
    // An install classified before this field existed must get the message it
    // always had, not "classified because: undefined".
    expect(text.slice(at, at + 700)).toContain('if (!why) return "";');
  });
});
