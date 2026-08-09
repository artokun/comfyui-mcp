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
//               interrupted record"). Also wrong, but CONFIG-DEPENDENTLY:
//               `queueManagerTask` polls until the queue DRAINS, so WITHOUT an
//               aria2 sidecar the record is `downloading` for the whole
//               server-side transfer and IS migrated as INTERRUPTED (#1197).
//               WITH one — which this project's own RunPod image exports — the
//               queue drains at handoff, the record goes terminal `done`, and
//               nothing migrates. Neither absolute is true.
//
// THAT SURVIVOR IS NOW FIXED, and both halves shipped together as the note said
// they had to: the stale-heartbeat sentence here, and the record's own runtime
// NOTE in model-management.ts, are both route-aware. For a Manager dispatch there
// is no local .partial and a re-issue is a second server-side dispatch — the
// corrupting move (#1197) — so the note says to check whether the file landed
// instead. Fixing only the description would have contradicted the runtime note,
// which is the failure #1197 spent four rounds undoing.
//
// Claims re-verified against the source when the hash below was last updated:
// the status union is `"downloading" | "done" | "error" | "cancelled"`
// (download-jobs.ts); `viaManager` is set at creation from `dispatchToManager`
// and survives the persist/restore round trip as `via_manager`; and "resolvable
// by `id` or by `url`" is real — the status action calls
// `findDownloadJob({ url })` when no id matches.
//
// And the newest claim, that an older record says its route is UNKNOWN rather
// than guessing: `via_manager` is OPTIONAL in the persisted record, so a
// pre-field record restores as `undefined`, and `downloadRoute()` maps that to
// its own third state instead of falling through to "local". Codex review caught
// the boolean split that sent those records down the local path — telling the
// reader to re-issue, which is the corrupting move for precisely the records
// whose route cannot be confirmed.
//
// So the tests below check two different things, and the second matters more:
// that the true claims are present, AND that no absolute claim about survival
// has crept back in. A test that only requires phrases lets an author append
// their opposite — the round-2 gate demonstrated exactly that.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

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
    // Deliberately does NOT hardcode a label: since #1197 the record uses
    // "INTERRUPTED" for a local stream and "NO LONGER WATCHED" for a Manager
    // dispatch, and a description naming one of them would be wrong half the
    // time — the fold this whole issue is about.
    expect(d).toMatch(/STOPPED WATCHING/);
    expect(d).not.toMatch(/an INTERRUPTED note/);
    expect(d).toMatch(/not that the bytes stopped, which it does not check/i);
  });

  it("warns that re-issuing a Manager dispatch CORRUPTS, rather than exempting it", () => {
    // The attempt-3 version of this test asserted the exemption and so pinned
    // the defect in place. The truth (#1197): a Manager fetch runs on the HOST,
    // a restart here does not touch it, and the migration nonetheless writes
    // "It is NOT running … Re-issue" — following which starts a second write to
    // the same destination and corrupts the model.
    const d = statusParagraph();
    expect(d).toMatch(/ComfyUI-Manager/);
    expect(d).toMatch(/runs on the ComfyUI host/i);
    expect(d).toMatch(/corrupts the model/i);
    expect(d).not.toMatch(/produces no interrupted record/i);
    expect(d).not.toMatch(/committed done the moment the dispatch is ACCEPTED/i);
  });

  it("defers to the RECORD rather than repeating a route-specific verdict", () => {
    // Once #1197 made the record itself say the true thing per route, the
    // description repeating it was both redundant and a liability: this
    // paragraph still carried "re-check list_local_models until the file
    // appears and its size stops changing", which #1197 established is
    // DANGEROUS — an in-progress file is never listed, so that check can only
    // terminate the wrong way. The description now points at the record.
    const d = statusParagraph();
    expect(d).toMatch(/READ THE NOTE ON THAT RECORD/);
    expect(d).not.toMatch(/until the file appears and its size stops changing/i);
  });

  it("does not promise the carried-over record EXISTS", () => {
    const d = statusParagraph();
    expect(d).toMatch(/best-effort/i);
    expect(d).toMatch(/NOT FOUND NEVER MEANS STOPPED/);
  });

  it("no longer claims a carried-over record is id-only — #1197 made that FALSE", () => {
    // This clause was TRUE when written: the migration dropped `trayId`, and
    // `findPersistedDownloadJob` matches url lookups on `rec.trayId`. Then
    // #1197 — my own fix, on the branch this one was waiting for — started
    // carrying `trayId`, which made url lookup work again and this sentence
    // false. Inherited-and-unchecked is the exact failure mode that produced
    // #1148 in the first place, so it is pinned rather than merely deleted.
    expect(statusParagraph()).not.toMatch(/never by `url`/);
  });

  // The guard's FIELD OF VIEW, widened after it missed F1.
  //
  // `statusParagraph()` slices only the tool description, so when the same false
  // claim ("findable by `id` only" for a carried-over record — untrue since
  // #1197 carries `trayId`) also lived in the NOT-FOUND message 700 lines away
  // in the same file, the pin could not see it. The claim was deleted from one
  // site and declared fixed while it stayed live at the other. A scan that stops
  // at the layer you happened to edit reproduces this cluster's whole failure
  // mode, so this one reads the SOURCE FILE.
  it("makes no id-only / never-by-url claim ANYWHERE in the tool source", async () => {
    const src = await readFile(
      new URL("../../tools/model-management.ts", import.meta.url),
      "utf8",
    );
    // Escape-AGNOSTIC on purpose. Inside a template literal the source spells a
    // backtick with a leading backslash, so a pattern written against the
    // RENDERED text matches nothing — which is exactly how this guard was inert
    // on its first attempt, the same failure as the bug it guards. Strip
    // backslashes first, then look for the claim as plain text.
    const plain = src.split("\\").join("");
    expect(plain).not.toContain("never by `url`");
    expect(plain.toLowerCase()).not.toContain("findable by `id` only");
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
    ).toBe("e830e08d28a9dde0");
  });
});
