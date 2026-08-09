// #1148 — `download_model action:"status"` promised more than the code delivers.
//
// The original text said "Survives a sidebar/tool-session reconnect … so you can
// confirm it's still running instead of starting a duplicate", folding events
// with opposite answers into one word.
//
// THREE successive attempts to fix it each introduced a NEW false claim, which is
// why this file is shaped the way it is:
//
//   attempt 1 — asserted the carried-over record EXISTS (it is best-effort), and
//               repeated the inherited "by `id` (or by `url`)" for a record that
//               has no url lookup key.
//   attempt 2 — asserted an orchestrator restart kills the transfer and
//               "re-issuing IS the correct move", which is false for a
//               ComfyUI-Manager dispatch running on the HOST.
//   attempt 3 — asserted the opposite Manager exemption absolutely ("committed
//               done the moment the dispatch is ACCEPTED … produces no
//               interrupted record"). Also false: `queueManagerTask` polls until
//               the queue DRAINS, so the record is `downloading` for the whole
//               server-side transfer and IS migrated as INTERRUPTED (#1197).
//
// So the tests below check two different things, and the second matters more:
// that the true claims are present, AND that no absolute claim about survival
// has crept back in. A test that only requires phrases lets an author append
// their opposite — the round-2 gate demonstrated exactly that.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { registerModelManagementTools } from "../../tools/model-management.js";

/** Capture each tool's registered description without a live MCP server. */
function registeredDescriptions(): Map<string, string> {
  const out = new Map<string, string>();
  const server = {
    tool: (name: string, description: string) => {
      out.set(name, description);
    },
  };
  registerModelManagementTools(server as never);
  return out;
}

/** Just the `action:"status"` paragraph — the scans below must not fire on a
 *  sibling action's legitimate use of a word like "always". */
function statusParagraph(): string {
  const d = registeredDescriptions().get("download_model");
  expect(d, "download_model should be registered").toBeTruthy();
  const from = (d as string).indexOf('- action:"status"');
  expect(from, 'the status action should be described').toBeGreaterThan(-1);
  const rest = (d as string).slice(from + 1);
  const to = rest.indexOf('\n- action:"');
  return to === -1 ? rest : rest.slice(0, to);
}

describe("download_model action:\"status\" claims only what the code delivers (#1148)", () => {
  it("does not claim a bare 'survives a reconnect'", () => {
    expect(statusParagraph()).not.toMatch(/Survives a sidebar\/tool-session reconnect/i);
  });

  it("keeps the true half: a local stream survives an AGENT reconnect", () => {
    // #529's adoption contract is real, and a caller who stops trusting it
    // starts duplicating live transfers.
    const d = statusParagraph();
    expect(d).toMatch(/AGENT\/sidebar session reconnect/);
    expect(d).toMatch(/keeps running/);
    expect(d).toMatch(/normally resolvable by `id` or by `url`/);
  });

  it("says an INTERRUPTED note means WE stopped watching, not that the bytes stopped", () => {
    // The verdict is written with no evidence: every persisted record carries
    // the writer's pid and `writerProcessGone()` exists to answer this, and the
    // migration reads neither. The cancel path REFUSES to close a stale record
    // until that probe returns ESRCH (#761/#858) — this must not claim more.
    const d = statusParagraph();
    expect(d).toMatch(/INTERRUPTED/);
    expect(d).toMatch(/stopped watching/i);
    expect(d).toMatch(/without checking whether the writer is still alive/i);
  });

  it("warns that re-issuing a Manager dispatch CORRUPTS, rather than exempting it", () => {
    // The attempt-3 version of this test asserted the exemption and so pinned
    // the defect in place. The truth (#1197): a Manager fetch runs on the HOST,
    // a restart here does not touch it, and the migration nonetheless writes
    // "It is NOT running … Re-issue" — following which starts a second write to
    // the same destination and corrupts the model.
    const d = statusParagraph();
    expect(d).toMatch(/ComfyUI-Manager/);
    expect(d).toMatch(/runs on the ComfyUI HOST|on the ComfyUI HOST/);
    expect(d).toMatch(/corrupts the model/i);
    expect(d).not.toMatch(/produces no interrupted record/i);
    expect(d).not.toMatch(/committed done the moment the dispatch is ACCEPTED/i);
  });

  it("gives a confirmation that works DURING the transfer", () => {
    // "confirm with list_local_models" alone routes the caller into the harm:
    // an in-progress file is not listed, and Manager may stage it under its own
    // type dir, so the only answer available mid-flight is the misleading one.
    const d = statusParagraph();
    expect(d).toMatch(/until the file appears and its size stops changing/i);
    expect(d).toMatch(/empty folder mid-download is normal/i);
  });

  it("does not promise the carried-over record EXISTS, or a url lookup for it", () => {
    const d = statusParagraph();
    expect(d).toMatch(/best-effort/i);
    expect(d).toMatch(/NOT FOUND NEVER MEANS STOPPED/);
    expect(d).toMatch(/findable by `id` ONLY, never by `url`/);
  });

  // ---------------------------------------------------------------------------
  // A CONTENT PIN, not a keyword scan.
  //
  // Three successive keyword gates were each declared fixed and each bypassed:
  // a proximity scan (fired on the legitimate denial), a verb-keyed scan
  // ("discoverable by `url`" walked through), and a noun+negation-aware scan —
  // which the final gate broke twelve different ways, including by using ANY
  // negation in the sentence to disarm the check, and by reversing the core
  // claim in wording that matched no keyword at all.
  //
  // The lesson is that a keyword scan cannot police prose: the synonym space is
  // unbounded, so each patch only closes the last hole. This pins the paragraph
  // by CONTENT instead. It cannot be argued past — any edit fails it, and the
  // author has to re-read the claims and update the hash deliberately. The
  // positive assertions above stay as the readable statement of intent.
  // ---------------------------------------------------------------------------
  it("has not changed without re-reading the claims above", () => {
    const hash = createHash("sha256").update(statusParagraph(), "utf8").digest("hex").slice(0, 16);
    expect(
      hash,
      "The action:\"status\" description changed. That is fine — but every claim in it " +
        "has been wrong at least once (see the header). Re-verify each against " +
        "download-jobs.ts / download-progress.ts / node-management.ts, then update this hash.",
    ).toBe("d598d963ae422c5a");
  });
});
