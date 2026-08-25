/**
 * #2290 — a local-backend render hold must announce itself ONCE, not once per message.
 *
 * The report described the hold as silent. It is not: the hold-time bubble has shipped since
 * #154 (2026-07-08). What was true is the failure mode the report told us to avoid — the
 * bubble fires from the per-MESSAGE send path, so a person who types three lines during one
 * render is told three times, and "a notice per held message would be worse than silence".
 *
 * Two things are pinned here, and they need different instruments:
 *
 *  1. THE SEMANTICS — RenderHoldNotice, driven directly. One claim per recipient per hold
 *     episode; a second tab is a second recipient; reset() starts a new episode.
 *
 *  2. THE CALL SITES — pinned at SOURCE, the same treatment as the other startPanelOrchestrator
 *     boundary wirings (run-completion-fallback-wiring, carried-stamp-wiring): the hold lives
 *     inside a closure that needs a live bridge, agents and a socket to construct, and the
 *     defect being fixed is entirely about WHERE the claim and the resets sit. A perfect
 *     RenderHoldNotice that nobody consults, or that nobody resets, reproduces the bug exactly.
 *
 * The catalog assertions go through the real trFor, not the JSON: an opt-out whose env var was
 * localized would be advice that does nothing, and that is invisible to a key-parity check.
 */
import { describe, expect, it, afterEach } from "vitest";
import { readFileSync } from "node:fs";

import { RenderHoldNotice } from "../../services/local-vram.js";
import { trFor, LOCALES, __resetI18nForTest } from "../../i18n/index.js";

afterEach(() => __resetI18nForTest());

const indexSrc = (): string =>
  readFileSync(new URL("../../orchestrator/index.ts", import.meta.url), "utf8");

/** The hold branch itself — everything the send path does when it withholds a message. */
function holdBranch(): string {
  const src = indexSrc();
  const start = src.indexOf("if (pauseLocalDuringGen && tabIsLocalVram && QueueMonitor.isBusy()) {");
  expect(start).toBeGreaterThan(-1);
  // Ends at the un-held path — the send this branch exists to skip.
  const end = src.indexOf("manager.send(agentKeyFor(event.tab_id), outText, sendOpts);", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/**
 * The BODY of `if (heldNotice.claim(...)) { … }`, matched by braces rather than by line order.
 *
 * Order alone is not enough: a spinner clear moved INSIDE this block still comes after the
 * claim, and that mutation is the dangerous one — held messages 2 and 3 would get no bubble
 * AND no "done" frame, so their spinner would run to the 120s safety timeout (issue #257).
 */
function claimBlock(): string {
  const branch = holdBranch();
  const head = "if (heldNotice.claim(event.tab_id)) {";
  const at = branch.indexOf(head);
  expect(at).toBeGreaterThan(-1);
  let depth = 0;
  let i = at + head.length - 1; // sits on the opening brace
  for (; i < branch.length; i++) {
    if (branch[i] === "{") depth++;
    else if (branch[i] === "}" && --depth === 0) break;
  }
  expect(depth, "the claim block never closes — unbalanced braces").toBe(0);
  return branch.slice(at, i + 1);
}

describe("#2290 — RenderHoldNotice: one signal per hold, not per message", () => {
  it("tells a recipient once, however many messages they send into the same hold", () => {
    const notice = new RenderHoldNotice();
    expect(notice.claim("tab-a")).toBe(true);
    expect(notice.claim("tab-a")).toBe(false);
    expect(notice.claim("tab-a")).toBe(false);
  });

  it("scopes the claim to the RECIPIENT — a second tab has been told nothing yet", () => {
    const notice = new RenderHoldNotice();
    expect(notice.claim("tab-a")).toBe(true);
    expect(notice.claim("tab-b")).toBe(true);
    expect(notice.claim("tab-b")).toBe(false);
  });

  it("reset() opens a new hold episode: the next render announces again", () => {
    const notice = new RenderHoldNotice();
    expect(notice.claim("tab-a")).toBe(true);
    notice.reset();
    expect(notice.claim("tab-a")).toBe(true);
  });
});

describe("#2290 — the orchestrator consults it at the hold and resets it at every boundary", () => {
  it("SOURCE: the hold-time bubble is emitted ONLY under a claim", () => {
    const src = indexSrc();
    // Exactly one place says it. A second, unguarded push would restore the noise.
    const pushes = src.match(/say\.message_queued_during_render/g) ?? [];
    expect(pushes).toHaveLength(1);

    const branch = holdBranch();
    const claimAt = branch.indexOf("if (heldNotice.claim(event.tab_id)) {");
    const sayAt = branch.indexOf('"say.message_queued_during_render"');
    expect(claimAt).toBeGreaterThan(-1);
    expect(sayAt).toBeGreaterThan(claimAt);
  });

  it("SOURCE: the opt-out rides the same bubble, so one hold is still one signal", () => {
    const block = claimBlock();
    // One push, carrying both halves — a second bridge.push would be a second bubble.
    expect(block.match(/bridge\.push\(/g) ?? []).toHaveLength(1);
    expect(block).toContain('"say.message_queued_opt_out"');
    // Both halves are rendered for the SAME tab's language — one bubble, one locale.
    expect(block).toContain("const locale = bridge.tabLocale(event.tab_id);");
  });

  it("SOURCE: the spinner clear stays PER MESSAGE — deduping the notice must not strand it", () => {
    const block = claimBlock();
    // The bubble is what the claim gates…
    expect(block).toContain("say.message_queued_during_render");
    // …and the spinner clear is emphatically not: every held message must stop its own.
    expect(block).not.toContain('state: "done"');
    expect(block).not.toContain("manager.isTurnActive(");
    // It is still emitted by the hold branch — just outside the dedupe.
    const branch = holdBranch();
    expect(branch).toContain("if (!manager.isTurnActive(key)) {");
    expect(branch).toContain('bridge.push({ type: "turn", state: "done" }, event.tab_id);');
  });

  it("SOURCE: every hold-episode boundary resets it", () => {
    const src = indexSrc();
    // The render STARTS — a new wait, so whoever was told about the last one is untold.
    const startAt = src.indexOf("      onRunStart: () => {");
    expect(startAt).toBeGreaterThan(-1);
    expect(src.slice(startAt, src.indexOf("      onRunEnd: () => {"))).toContain("heldNotice.reset()");
    // The render ENDS — the flush clears the queue, and the notice with it.
    const endAt = src.indexOf("      onRunEnd: () => {");
    const endBlock = src.slice(endAt, endAt + 1800);
    expect(endBlock).toContain("heldDuringGen.clear();");
    expect(endBlock).toContain("heldNotice.reset();");
    // The start transition was MISSED (the monitor only ever saw "busy"): the hold site
    // arms the flush itself, and must open the episode there too — otherwise a stale mark
    // from the previous render swallows this render's only notice.
    const branch = holdBranch();
    const fallbackAt = branch.indexOf("if (!genPauseActive) {");
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(branch.slice(fallbackAt, branch.indexOf("if (heldNotice.claim("))).toContain(
      "heldNotice.reset();",
    );
  });
});

describe("#2290 — the opt-out survives translation", () => {
  const SENTINEL = "__no catalog contains this__";
  // English is the SOURCE: it is generated FROM the call site's fallback, and trFor("en")
  // returns that fallback rather than reading a catalog. Asking it here would only re-assert
  // the string literal this file already reads out of index.ts.
  const TRANSLATED = LOCALES.filter((l) => l !== "en");

  it("every shipped language has the opt-out sentence", () => {
    for (const locale of TRANSLATED) {
      const text = trFor(locale, "say.message_queued_opt_out", SENTINEL);
      expect(text, `${locale} is missing say.message_queued_opt_out`).not.toBe(SENTINEL);
    }
  });

  it("every language keeps the env var VERBATIM — a localized setting name is dead advice", () => {
    for (const locale of TRANSLATED) {
      const text = trFor(locale, "say.message_queued_opt_out", SENTINEL);
      expect(text, `${locale} lost the setting name`).toContain("COMFYUI_MCP_PAUSE_LOCAL_ON_GEN=0");
    }
  });
});
