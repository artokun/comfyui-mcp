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

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("RENDERS the evidence it was given", async () => {
    // A real call, not a grep of the source. The previous version of these three
    // asserted that process-control.ts CONTAINED certain substrings, which cannot
    // fail if the clause renders empty, if the field is never populated, or after
    // a rename -- it pins the text, not the behaviour.
    const { desktopEvidenceClause } = await import("../../services/process-control.js");
    const out = desktopEvidenceClause("a ComfyUI Desktop binary among this process's ancestors");
    expect(out).toContain("Classified as Desktop-managed by:");
    expect(out).toContain("a ComfyUI Desktop binary among this process's ancestors");
    expect(out).toContain("this refusal is wrong with it");
  });

  it("says NOTHING when no evidence was recorded", async () => {
    // An install classified before this field existed must get the message it
    // always had, not "classified because: undefined".
    const { desktopEvidenceClause } = await import("../../services/process-control.js");
    expect(desktopEvidenceClause(undefined)).toBe("");
    expect(desktopEvidenceClause("")).toBe("");
  });

  it("marks the argv signal as a NAME match wherever it is produced", async () => {
    // The weakest of the three signals must identify itself as contestable. This
    // one stays a source check on purpose: the string is built inside
    // detectDesktopLaunch, which needs a live process tree to reach.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const text = readFileSync(fileURLToPath(src), "utf-8");
    expect(text).toContain("a NAME match, which a directory merely CALLED that also satisfies");
  });

  it("appends the clause to the abandoned-supervisor refusal", async () => {
    // Structural pin, and labelled as one: it proves the call site is still in the
    // same template as the message, not that the message renders with evidence.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const text = readFileSync(fileURLToPath(src), "utf-8");
    const at = text.indexOf("ComfyUI Desktop started the server on port");
    expect(at).toBeGreaterThan(-1);
    expect(text.slice(at, at + 1600)).toContain("desktopEvidenceClause(info.desktopEvidence)");
  });

  // ---------------------------------------------------------------------------
  // #2784 — the SELECTION, now reachable.
  //
  // The two tests above pin the sentence; neither pins WHICH signal produced it.
  // Verified by mutation: making the marker branch or the ancestor branch
  // unreachable left all fourteen green, so the refusal could have named the
  // weakest signal in place of the strongest and nothing would have said so —
  // and pointing the reader at an argv NAME match that did not decide is the same
  // misdirection the unfalsifiable claim was.
  describe("#2784 which signal is named", () => {
    const { detectDesktopLaunch, reset, setParentPidResolver, setProcessIdentityResolver } =
      __processControlTestHooks;

    afterEach(() => reset());

    it("names the argv substring when that is all there was, and quotes the marker it hit", () => {
      // No Desktop-2-shaped path, so the ancestor walk is deliberately never run.
      const r = detectDesktopLaunch(4242, ["C:/Apps/Comfy Desktop/python.exe", "main.py"]);
      expect(r.isDesktopApp).toBe(true);
      expect(r.desktopEvidence).toContain('the substring "comfy desktop"');
      expect(r.desktopEvidence).toContain("NAME match");
    });

    it("names the ANCESTOR binary instead, once the process tree can answer", () => {
      // Same install, plus a real Desktop supervisor overhead. The stronger fact
      // must displace the contestable one — that ordering is the whole point of
      // saying which signal decided.
      setParentPidResolver((pid) => (pid === 4242 ? 99 : null));
      setProcessIdentityResolver((pid) =>
        pid === 99
          ? { pid: 99, executablePath: "C:/Programs/ComfyUI/Comfy Desktop/Comfy Desktop.exe" }
          : undefined,
      );
      const r = detectDesktopLaunch(4242, ["C:/Users/x/comfyui-installs/python.exe", "main.py"]);
      expect(r.isDesktopApp).toBe(true);
      expect(r.desktopEvidence).toContain("ancestors");
      expect(r.desktopEvidence).not.toContain("NAME match");
    });

    it("an on-disk Desktop-2 marker OUTRANKS both, and it is the strongest claim made", () => {
      // The remaining arm, reached with a REAL directory rather than a stubbed
      // existsSync: several process-control suites stub that true, which would
      // reclassify every ordinary python install in this file. A marker on disk is
      // a fact about the install, so it must beat both the process tree and the
      // name match -- including when an ancestor Desktop binary is also present.
      const root = mkdtempSync(join(tmpdir(), "cmcp-d2-"));
      const install = join(root, "comfyui-installs", "MyInstall");
      mkdirSync(install, { recursive: true });
      writeFileSync(join(install, ".comfyui-desktop-2"), "");
      try {
        setParentPidResolver((pid) => (pid === 4242 ? 99 : null));
        setProcessIdentityResolver((pid) =>
          pid === 99
            ? { pid: 99, executablePath: "C:/Programs/ComfyUI/Comfy Desktop/Comfy Desktop.exe" }
            : undefined,
        );
        const r = detectDesktopLaunch(4242, [join(install, "python.exe"), "main.py"]);
        expect(r.isDesktopApp).toBe(true);
        expect(r.desktopEvidence).toContain("Desktop-2 install marker");
        expect(r.desktopEvidence).not.toContain("ancestors");
        expect(r.desktopEvidence).not.toContain("NAME match");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("says nothing at all when no signal fires", () => {
      // The one path with no evidence to give, and the clause renders "" for it.
      const r = detectDesktopLaunch(4242, ["C:/Python/python.exe", "main.py"]);
      expect(r.isDesktopApp).toBe(false);
      expect(r.desktopEvidence).toBeUndefined();
    });
  });
});
