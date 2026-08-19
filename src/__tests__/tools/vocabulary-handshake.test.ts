// The cross-repo seam that #683 exposed, and the handshake that closes it.
//
// The panel calls tool names as bare string literals and vendors a generated copy
// of the vocabulary to validate them. Nothing compared that copy against the
// server it was actually talking to: `vocab:export --check` proves the artefact
// matches THIS repo's ledger, and the panel's gate proves its vendored file
// matches its own contents. Both are self-consistency; neither sees across the
// boundary. The skew then surfaces at CALL time as "unknown tool".

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeVocabularyHash,
  describeVocabularySkew,
  DEAD_NAMES,
  TOOL_NAMES,
} from "../../tools/vocabulary.js";

const HASH = "a2ed326429161c9ea2f609da1e11dba9c85fa6c8b3c2c2325050a94a3ca028fe";

describe("computeVocabularyHash", () => {
  it("is stable for the same names regardless of the array identity", () => {
    const a = computeVocabularyHash({ core: ["x", "y"], panel: ["p"], dead: ["d"] });
    const b = computeVocabularyHash({ core: [...["x", "y"]], panel: ["p"], dead: ["d"] });
    expect(a).toBe(b);
  });

  it("changes when ANY of the three lists changes", () => {
    const base = computeVocabularyHash({ core: ["x"], panel: ["p"], dead: ["d"] });
    expect(computeVocabularyHash({ core: ["x", "z"], panel: ["p"], dead: ["d"] })).not.toBe(base);
    expect(computeVocabularyHash({ core: ["x"], panel: ["p", "q"], dead: ["d"] })).not.toBe(base);
    expect(computeVocabularyHash({ core: ["x"], panel: ["p"], dead: ["d", "e"] })).not.toBe(base);
  });

  it("distinguishes order, because registration order is part of the core surface", () => {
    expect(computeVocabularyHash({ core: ["a", "b"], panel: [], dead: [] })).not.toBe(
      computeVocabularyHash({ core: ["b", "a"], panel: [], dead: [] }),
    );
  });

  // The whole handshake is worthless if this function and the export script
  // disagree: a drifted hash reports a mismatch that is not real, which is worse
  // than no check. This pins that they are the same rule over the same inputs.
  it("reproduces the committed artefact's hash from the live ledger", async () => {
    const { buildPanelToolDefs } = await import("../../orchestrator/panel-tools.js");
    const live = computeVocabularyHash({
      core: [...TOOL_NAMES],
      panel: buildPanelToolDefs()
        .map((d) => d.name)
        .sort(),
      dead: DEAD_NAMES.map((d) => d.name),
    });
    expect(live).toBe(HASH);
  });
});

describe("describeVocabularySkew", () => {
  it("reports a match when the two agree", () => {
    expect(describeVocabularySkew(HASH, HASH).status).toBe("match");
  });

  // THE load-bearing case. An older panel advertises nothing, and silence must
  // never be read as disagreement — that is the exact defect class this handshake
  // exists to catch, and committing it here would be self-refuting.
  it("treats a MISSING panel hash as unknown, never as a mismatch", () => {
    const r = describeVocabularySkew(HASH, undefined);
    expect(r.status).toBe("unknown");
    expect(r.status === "unknown" && r.reason).toMatch(/UNVERIFIED/);
  });

  it("treats an empty-string hash as unknown too, not as a differing value", () => {
    expect(describeVocabularySkew(HASH, "").status).toBe("unknown");
  });

  it("reports a mismatch when the two genuinely differ", () => {
    const r = describeVocabularySkew(HASH, "ffffffff".repeat(8));
    expect(r.status).toBe("mismatch");
  });

  it("does NOT claim which side is stale — it cannot know, and a guess sends half of users the wrong way", () => {
    const r = describeVocabularySkew(HASH, "ffffffff".repeat(8), "0.11.42");
    expect(r.status).toBe("mismatch");
    const msg = r.status === "mismatch" ? r.message : "";
    // It must name BOTH digests and prescribe updating both...
    // Derived from HASH rather than written as a literal: a literal is a second place the
    // digest has to be updated whenever the surface changes, and the one that gets missed
    // — this test failed on a new panel tool for no reason connected to what it checks.
    expect(msg).toContain(HASH.slice(0, 8));
    expect(msg).toContain("ffffffff");
    expect(msg).toMatch(/update BOTH/i);
    // ...and must not assert a direction it has no basis for.
    expect(msg).not.toMatch(/panel is (out of date|stale|older)/i);
    expect(msg).not.toMatch(/server is (out of date|stale|older)/i);
  });

  it("names the panel version when it has one, so the report is actionable", () => {
    const r = describeVocabularySkew(HASH, "ab".repeat(32), "0.11.40");
    expect(r.status === "mismatch" && r.message).toContain("panel 0.11.40");
  });

  it("explains that a resulting 'unknown tool' is the skew, not a broken panel", () => {
    const r = describeVocabularySkew(HASH, "ab".repeat(32));
    expect(r.status === "mismatch" && r.message).toMatch(/unknown tool/i);
  });
});


// ===========================================================================
// #236 — IS THE HANDSHAKE ACTUALLY PERFORMED?
//
// Everything above this line passed for months while the check did not exist.
// `describeVocabularySkew` was called by nothing but these tests; the bridge
// stored the panel's advertised hash on every hello under a comment promising
// the comparison, and no code ever read the field. Green tests proved the
// function WORKED. They could not, and did not, prove it RAN.
//
// So these assert reachability, which is the property that was actually missing.
// ===========================================================================
const HERE = dirname(fileURLToPath(import.meta.url));

describe("#236 the handshake is wired, not just implemented", () => {
  const ORCH = readFileSync(join(HERE, "../../orchestrator/index.ts"), "utf8");

  it("the orchestrator's hello handler CALLS describeVocabularySkew", () => {
    // A source assertion because the call sits inside the hello handler of a large
    // side-effectful module — there is no seam to import and no return value to
    // observe. Deleting the call is the mutation this exists to kill; behavioural
    // tests of the describer cannot see it, which is exactly how it went missing.
    expect(ORCH).toMatch(/import \{ assembleVocabularyHash, describeVocabularySkew \}/);
    // Asserted as a PROPERTY — the call exists and is fed THIS server's hash — not
    // as an exact expression. A control mutation that only reworded the argument
    // (`serverVocabularyHash() + ""`) killed the strict form, which is a test that
    // punishes rewording rather than protecting behaviour.
    expect(ORCH).toMatch(/describeVocabularySkew\([\s\S]{0,160}serverVocabularyHash\(\)/);
    // It must read the hash off THIS hello, not from anywhere it could go stale.
    expect(ORCH).toMatch(/\(event as \{ vocabulary_hash\?: unknown \}\)\.vocabulary_hash/);
  });

  it("the check runs on the hello path, not lazily at first tool call", () => {
    // "Detected at connection time" is the entire ask in #236. A comparison that
    // happened on first USE would be the call-time surfacing the issue reported.
    const hello = ORCH.slice(ORCH.indexOf("const helloPanelVer"));
    const idx = hello.indexOf("describeVocabularySkew(");
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(4000); // same handler, not elsewhere in the file
  });

  it("only a MISMATCH warns — unknown and match stay silent", () => {
    // The three-state discipline at the CALL SITE, not just in the describer:
    // warning on `unknown` would fire at every user on a panel predating the
    // handshake, whose vocabulary is very likely fine.
    const start = ORCH.indexOf("// #236 — THE VOCABULARY HANDSHAKE");
    expect(start).toBeGreaterThan(-1);
    const block = ORCH.slice(start, start + 2400);
    // Matched as a PROPERTY: the gate tests for "mismatch" exactly. Pinning the whole
    // `if (...)` broke when a dedup clause was added to the same condition — a real
    // refactor, not a behaviour change.
    expect(block).toMatch(/skew\.status === "mismatch"/);
    expect(block).not.toMatch(/status !== "match"/);
  });

  it("the bridge no longer stores a hash nobody reads", () => {
    const BRIDGE = readFileSync(join(HERE, "../../services/ui-bridge.ts"), "utf8");
    // The dead field is gone WITH the comment that claimed it was compared. A false
    // comment outlives the code it describes and costs the next reader the same
    // investigation it cost this one.
    expect(BRIDGE).not.toMatch(/panelVocabularyHash/);
    expect(BRIDGE).not.toMatch(/detected at the handshake instead of at call time/);
  });
});

describe("#236 the runtime hash agrees with the artefact the panel vendors", () => {
  it("assembleVocabularyHash over the LIVE panel defs equals the exported hash", async () => {
    // The decisive anti-drift check, and the reason the assembly moved into
    // vocabulary.ts. If the runtime assembled its own copy of "core + panel sorted
    // + dead", it would agree with the artefact right until one side changed — and
    // then report a mismatch that is not real, which the module doc calls worse than
    // having no check at all. This compares the two for real.
    const { assembleVocabularyHash } = await import("../../tools/vocabulary.js");
    const { buildPanelToolDefs } = await import("../../orchestrator/panel-tools.js");
    const artefact = JSON.parse(
      readFileSync(join(HERE, "../../../docs/design/tool-vocabulary.json"), "utf8"),
    ) as { vocabularyHash: string };
    expect(assembleVocabularyHash(buildPanelToolDefs().map((d) => d.name))).toBe(
      artefact.vocabularyHash,
    );
  });
});

describe("#236 the report is deduped by VOCABULARY, not by tab", () => {
  const ORCH = readFileSync(join(HERE, "../../orchestrator/index.ts"), "utf8");

  it("keys on the hash so a reused wf: id cannot suppress a real mismatch", () => {
    // Codex round 2, P2: with a per-tab key, a tab that warned and then closed left an
    // entry that silenced the NEXT tab opening the same workflow — wf: ids are reused.
    expect(ORCH).toMatch(/const loggedVocabularySkew = new Set<string>\(\);/);
    expect(ORCH).toMatch(/loggedVocabularySkew\.has\(advertised!\)/);
    // No tab id may be involved in the dedup decision at all.
    expect(ORCH).not.toMatch(/loggedVocabularySkew\.(get|set)\(panelTab/);
    expect(ORCH).not.toMatch(/loggedVocabularySkew\.delete\(panelTab\)/);
  });

  it("is bounded, and eviction can only DUPLICATE a report, never suppress one", () => {
    expect(ORCH).toMatch(/MAX_LOGGED_VOCABULARY_SKEW = \d+/);
    const at = ORCH.indexOf("loggedVocabularySkew.add(advertised!)");
    expect(at).toBeGreaterThan(-1);
    const before = ORCH.slice(Math.max(0, at - 600), at);
    expect(before).toMatch(/loggedVocabularySkew\.size >= MAX_LOGGED_VOCABULARY_SKEW/);

    // The safety argument, executed rather than asserted about, so it cannot be
    // quietly inverted into an eviction that drops mismatches instead of entries.
    const seen = new Set<string>();
    const CAP = 3;
    const reported: string[] = [];
    const hello = (hash: string) => {
      if (seen.has(hash)) return;
      while (seen.size >= CAP) {
        const oldest = seen.values().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
      seen.add(hash);
      reported.push(hash);
    };
    hello("h1");
    hello("h1"); // same build, same news
    expect(reported).toEqual(["h1"]);
    hello("h2");
    hello("h3");
    hello("h4"); // evicts h1
    hello("h1"); // reported AGAIN — a duplicate, which is the safe direction
    expect(reported).toEqual(["h1", "h2", "h3", "h4", "h1"]);
    expect(seen.size).toBeLessThanOrEqual(CAP);
  });

  it("two tabs sharing a reused workflow id both get the truth", () => {
    // The concrete round-2 scenario, as behaviour: tab A (wf:123) warns and closes;
    // tab B opens the same workflow with the same disagreeing build. Under the old
    // per-tab key B was silenced by A's leftover entry. Keyed by hash, the question
    // "have we said this yet" no longer depends on which tab is asking.
    const seen = new Set<string>();
    const report = (_tab: string, hash: string) => {
      if (seen.has(hash)) return false;
      seen.add(hash);
      return true;
    };
    expect(report("wf:123", "H")).toBe(true); // tab A
    expect(report("wf:123", "H")).toBe(false); // tab B — same build, already said
    expect(report("wf:123", "H2")).toBe(true); // B updated to a DIFFERENT bad build
  });
});
