import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { logger } from "../../utils/logger.js";
import {
  AskAnswers,
  askFingerprint,
  ASK_RECOVER_MAX_AGE_MS,
  PANEL_ASK_ID_PREFIX,
  type AskAnswerEvent,
} from "../../orchestrator/ask-answer-journal.js";

// #486 — a VALIDATED panel_ask answer must survive the tool call that asked for
// it, and a recovered answer must never satisfy a different question.
//
// The journal is the durable half of that: it correlates an answer to its
// question ONCE, at arrival, replays what could not be delivered, and NEVER
// suppresses. These tests hold both directions: nothing the user answered is
// lost, and nothing they answered is presented as the answer to something else.

const TAB = "tab-aaaa1111";
const OTHER_TAB = "tab-bbbb2222";

const SAMPLER = {
  question: "Which sampler should I use?",
  options: [{ label: "euler" }, { label: "dpmpp_2m" }],
};
const SCHEDULER = {
  question: "Which scheduler should I use?",
  options: [{ label: "karras" }, { label: "normal" }],
};
const THIRD_Q = {
  question: "Should I upscale the result?",
  options: [{ label: "yes" }, { label: "no" }],
};

function openAndAnswer(
  askId: string,
  ask: { question: string; options: unknown; header?: unknown; multi_select?: unknown },
  answer: string,
  opts: { tabId?: string; awaiting?: boolean } = {},
): void {
  const tabId = opts.tabId ?? TAB;
  AskAnswers.openAsk(askId, { tabId, fingerprint: askFingerprint(ask), question: ask.question });
  // The asking handler has already unwound (the tools/call died) unless the test
  // says otherwise — that is the #486 scenario.
  if (opts.awaiting !== true) AskAnswers.closeAsk(askId);
  AskAnswers.record(askId, answer, { tabId });
}

/**
 * Drive the journal into the state where an eviction's disclosure has NO entry
 * to ride out on, so the debt is parked in the side map: fill the tab's ceiling
 * with orphans, hand them all off, then record one more answer whose own handler
 * is still awaiting (delivery "none") so the eviction it triggers finds nothing
 * pending to stamp.
 */
function strandEvictionDebt(): void {
  for (let i = 0; i < 48; i += 1) {
    openAndAnswer(`pa-fill-${i}`, { question: `F${i}?`, options: [{ label: "a" }, { label: "b" }] }, `F${i}`);
  }
  AskAnswers.deliverPending(TAB, () => true); // every entry handed off, none pending
  AskAnswers.openAsk("pa-live", {
    tabId: TAB,
    fingerprint: askFingerprint(SAMPLER),
    question: SAMPLER.question,
  });
  AskAnswers.record("pa-live", "dpmpp_2m", { tabId: TAB }); // still awaiting -> "none"
}

/** The agent instance the test's turns belong to. The journal refuses an ack
 *  from anything else, so tests have to name who is acking. */
const TURN = "pa-test-turn";

/** The browser tab holding the key in these tests (see AskEntry.incarnation). */
const OCCUPANT = "browser-tab-default";

/** An ordinary successful ask: answered, handed back in a tool result, and the
 *  turn that carried it produced its own result — the ACK. This is the common
 *  path, and the only one allowed to be forgotten quietly. */
function ordinaryAckedAsk(
  askId: string,
  ask: { question: string; options: unknown },
  answer: string,
): void {
  AskAnswers.openAsk(askId, {
    tabId: TAB,
    fingerprint: askFingerprint(ask),
    question: ask.question,
  });
  const token = AskAnswers.record(askId, answer, { tabId: TAB }).token;
  AskAnswers.markReturned(token);
  AskAnswers.closeAsk(askId);
  AskAnswers.ack(token, { carrier: TURN }); // the turn's own result landed
}

beforeEach(() => {
  AskAnswers.reset();
  AskAnswers.setFlusher(() => {});
  AskAnswers.setRevoker(() => false); // nothing queued unless a test says so
  AskAnswers.setTurnAttacher(() => TURN); // a live turn, unless a test says otherwise
  AskAnswers.setIncarnationResolver(() => OCCUPANT); // one browser tab, unless a test says otherwise
});

describe("ask-answer journal — an answer survives its tool call (#486)", () => {
  it("journals an answer that arrives with NO handler waiting, and arms it for delivery", () => {
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    const entries = AskAnswers.entriesFor(TAB);
    expect(entries).toHaveLength(1);
    expect(entries[0].answer).toBe("dpmpp_2m");
    expect(entries[0].correlation.status).toBe("matched");
    // Nobody received it, so it is an ORPHAN queued for the durable push.
    expect(entries[0].delivery).toBe("pending");
    expect(AskAnswers.hasOutstanding()).toBe(true);
  });

  it("recovers it for a re-ask of the IDENTICAL question", () => {
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    const rec = AskAnswers.recover(TAB, askFingerprint(SAMPLER));
    expect(rec.status).toBe("recovered");
    if (rec.status !== "recovered") return;
    expect(rec.entry.answer).toBe("dpmpp_2m");
    expect(rec.entry.question).toBe(SAMPLER.question);
  });

  // A recovery is a HAND-OFF, not a receipt: the ToolResult carrying it can be
  // abandoned exactly like the one that lost it in the first place. So the
  // journal keeps its copy and a further re-ask gets it again, FLAGGED.
  it("a recovered answer is kept and can be surfaced again, flagged", () => {
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    const first = AskAnswers.recover(TAB, askFingerprint(SAMPLER));
    expect(first.status).toBe("recovered");
    if (first.status !== "recovered") return;
    expect(first.entry.replayHint).toBeUndefined();
    AskAnswers.markSurfaced(first.entry.token);
    const again = AskAnswers.recover(TAB, askFingerprint(SAMPLER));
    expect(again.status).toBe("recovered");
    if (again.status !== "recovered") return;
    expect(again.entry.answer).toBe("dpmpp_2m");
    expect(again.entry.replayHint).toBe(true);
    // …and it stops being announced as an unclaimed orphan.
    expect(AskAnswers.orphansFor(TAB)).toHaveLength(0);
  });

  it("an answer handed to a tool result is NOT pushed, but is still recoverable", () => {
    // The ordinary success path: the handler got the answer and returned it. It
    // may have gone into a dead request (unobservable), so it stays journaled —
    // but it must not ALSO be announced to the agent, or every ask would double.
    AskAnswers.openAsk("pa-ask-1", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.markReturned(AskAnswers.record("pa-ask-1", "euler", { tabId: TAB }).token);
    AskAnswers.closeAsk("pa-ask-1");
    expect(AskAnswers.hasOutstanding()).toBe(false);
    expect(AskAnswers.orphansFor(TAB)).toHaveLength(0);
    expect(AskAnswers.recover(TAB, askFingerprint(SAMPLER)).status).toBe("recovered");
  });
});

describe("ask-answer journal — cross-question misattribution guard (#486)", () => {
  it("a journaled answer NEVER satisfies a different question", () => {
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    const rec = AskAnswers.recover(TAB, askFingerprint(SCHEDULER));
    // Not "recovered", and not silently "none" either: the answer exists and is
    // handed back for DISCLOSURE, quoted with its own question.
    expect(rec.status).toBe("unattributed");
    if (rec.status !== "unattributed") return;
    expect(rec.others).toHaveLength(1);
    expect(rec.others[0].question).toBe(SAMPLER.question);
  });

  it("matches on the whole question identity — text, option set, order, and mode", () => {
    const base = askFingerprint(SAMPLER);
    expect(askFingerprint({ ...SAMPLER, question: "Which sampler should I use ?" })).not.toBe(base);
    expect(
      askFingerprint({ ...SAMPLER, options: [{ label: "dpmpp_2m" }, { label: "euler" }] }),
    ).not.toBe(base); // reordered options are a different card
    expect(askFingerprint({ ...SAMPLER, options: [{ label: "euler" }] })).not.toBe(base);
    expect(askFingerprint({ ...SAMPLER, multi_select: true })).not.toBe(base);
    expect(askFingerprint({ ...SAMPLER, header: "Sampler" })).not.toBe(base);
    // The option DESCRIPTIONS are part of the question: they are the one-line
    // explanations the user reads to decide, so the same labels with different
    // explanations are a different decision and must not recover each other.
    expect(
      askFingerprint({
        ...SAMPLER,
        options: [{ label: "euler", description: "fast, lower quality" }, { label: "dpmpp_2m" }],
      }),
    ).not.toBe(base);
    expect(
      askFingerprint({
        ...SAMPLER,
        options: [{ label: "euler", description: "now the recommended default" }, { label: "dpmpp_2m" }],
      }),
    ).not.toBe(
      askFingerprint({
        ...SAMPLER,
        options: [{ label: "euler", description: "fast, lower quality" }, { label: "dpmpp_2m" }],
      }),
    );
    // …but whitespace/wrapping is not a decision, and a re-ask often re-emits the
    // same prompt wrapped differently.
    expect(
      askFingerprint({
        ...SAMPLER,
        question: "  Which sampler   should I use?\n",
        options: [{ label: " euler " }, { label: "dpmpp_2m\n" }],
      }),
    ).toBe(base);
  });

  it("a label cannot be smuggled to collide with a different question", () => {
    // The fingerprint escapes its own inputs, so no separator can be forged.
    const a = askFingerprint({ question: "Pick", options: [{ label: 'x","y' }] });
    const b = askFingerprint({ question: "Pick", options: [{ label: "x" }, { label: "y" }] });
    expect(a).not.toBe(b);
  });

  it("an answer given on ANOTHER tab never satisfies this tab's question", () => {
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m", { tabId: OTHER_TAB });
    expect(AskAnswers.recover(TAB, askFingerprint(SAMPLER)).status).toBe("none");
  });

  it("an answer too old to be presented as fresh is disclosed, never returned", () => {
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    const entry = AskAnswers.entriesFor(TAB)[0];
    entry.answeredAt = Date.now() - ASK_RECOVER_MAX_AGE_MS - 1000;
    const rec = AskAnswers.recover(TAB, askFingerprint(SAMPLER));
    expect(rec.status).toBe("unattributed");
    if (rec.status !== "unattributed") return;
    expect(rec.others[0].answer).toBe("dpmpp_2m");
  });

  it("a replaced conversation revokes the licence to satisfy a re-ask, but keeps the answer", () => {
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    AskAnswers.closeAsks(TAB); // New chat / resume of a historical session
    const rec = AskAnswers.recover(TAB, askFingerprint(SAMPLER));
    expect(rec.status).toBe("unattributed");
    if (rec.status !== "unattributed") return;
    // WITHHELD, not shown: its content belongs to a conversation/tab that is no
    // longer here, and rendering the chosen option into this conversation's
    // result is the leak the boundary exists to stop. The COUNT is the
    // disclosure; the text stays journaled and in the durable log.
    expect(rec.withheld).toBeGreaterThan(0);
    expect(rec.others.some((e) => e.answer === "dpmpp_2m")).toBe(false);
    expect(AskAnswers.entriesFor(TAB).some((e) => e.answer === "dpmpp_2m")).toBe(true);
    expect(AskAnswers.entriesFor(TAB)[0].question).toBe(SAMPLER.question);
    expect(AskAnswers.entriesFor(TAB)[0].correlation.status).toBe("foreign");
  });

  it("an answer whose ask id this session never opened is UNATTRIBUTED, never matched", () => {
    AskAnswers.record("pa-never-opened", "dpmpp_2m", { tabId: TAB });
    const entry = AskAnswers.entriesFor(TAB)[0];
    expect(entry.correlation.status).toBe("foreign");
    expect(entry.fingerprint).toBeNull();
    expect(entry.question).toBeNull();
    // NOT announced: with no ticket there is no conversation generation, so we
    // cannot tell whether the card belongs to the conversation on this tab now or
    // to a retired one — and announcing it anyway would fold "could not
    // determine" into "determined not retired". Journaled, logged, and reported
    // by a later ask instead; it can satisfy nothing either way.
    expect(entry.delivery).toBe("none");
    expect(AskAnswers.recover(TAB, askFingerprint(SAMPLER)).status).toBe("unattributed");
    expect(AskAnswers.orphansFor(TAB).some((e) => e.answer === "dpmpp_2m")).toBe(true);
  });

  // codex round 13, P1: the journal's ticket bound and the bridge's mapping bound
  // are separate, so a retired card could lose its ticket (and with it the
  // conversation generation) while the bridge still recognised its answer — which
  // was then announced to whatever conversation held the tab.
  it("a retired card whose ticket was evicted is still never announced", () => {
    AskAnswers.openAsk("pa-retired3", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-retired3");
    AskAnswers.closeAsks(TAB); // conversation replaced
    AskAnswers.dropTicketForTest("pa-retired3"); // …and the ticket bound bites
    const entry = AskAnswers.record("pa-retired3", "dpmpp_2m", { tabId: TAB });
    expect(entry.delivery).toBe("none");
    expect(AskAnswers.hasOutstanding()).toBe(false);
    expect(AskAnswers.orphansFor(TAB).some((e) => e.answer === "dpmpp_2m")).toBe(true);
  });
});

describe("ask-answer journal — durable delivery (#486, mirroring #468)", () => {
  function drain(key: string): AskAnswerEvent[] {
    const seen: AskAnswerEvent[] = [];
    AskAnswers.deliverPending(key, (payload) => {
      seen.push(payload);
      return true;
    });
    return seen;
  }

  it("delivers the answer WITH the question that it answers", () => {
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    const [ev] = drain(TAB);
    expect(ev.ask_answer).toBe("dpmpp_2m");
    expect(ev.ask_question).toBe(SAMPLER.question);
    expect(ev.ask_correlation).toBe("matched");
  });

  it("an answer handed to an agent that then DIES comes back and is replayed", () => {
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    const token = AskAnswers.entriesFor(TAB)[0].token;
    drain(TAB);
    expect(AskAnswers.pending(TAB)).toHaveLength(0);
    // The agent was torn down before its turn ran — nobody read it.
    AskAnswers.release(token, { carried: false });
    expect(AskAnswers.pending(TAB)).toHaveLength(1);
    const [again] = drain(TAB);
    expect(again.ask_answer).toBe("dpmpp_2m");
    expect(again.replayed).toBe(true);
  });

  it("teardown handbacks are UNBOUNDED; only turns that carried it are counted", () => {
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    const token = AskAnswers.entriesFor(TAB)[0].token;
    for (let i = 0; i < 10; i += 1) {
      drain(TAB);
      AskAnswers.release(token, { carried: false });
    }
    expect(AskAnswers.pending(TAB)).toHaveLength(1); // never settled by shuffling
    for (let i = 0; i < 3; i += 1) {
      drain(TAB);
      AskAnswers.release(token, { carried: true });
    }
    // Three turns each put the text in front of the agent — settle rather than
    // loop forever (a duplicate at worst, never an endless replay).
    expect(AskAnswers.pending(TAB)).toHaveLength(0);
  });

  it("the turn that carried it ending clears the push but keeps it recoverable", () => {
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    const token = AskAnswers.entriesFor(TAB)[0].token;
    drain(TAB);
    AskAnswers.ack(token);
    expect(AskAnswers.hasOutstanding()).toBe(false);
    // …the user's decision is still on file for a re-ask of the same question.
    expect(AskAnswers.recover(TAB, askFingerprint(SAMPLER)).status).toBe("recovered");
  });

  it("a tab that goes away drops its answers and its tickets", () => {
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    AskAnswers.forget(TAB);
    expect(AskAnswers.entriesFor(TAB)).toHaveLength(0);
    expect(AskAnswers.hasOutstanding()).toBe(false);
  });

  it("a tab-id migration re-addresses the answer instead of stranding it", () => {
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    AskAnswers.moveKey(TAB, OTHER_TAB);
    expect(AskAnswers.entriesFor(TAB)).toHaveLength(0);
    expect(AskAnswers.pending(OTHER_TAB)).toHaveLength(1);
    expect(AskAnswers.recover(OTHER_TAB, askFingerprint(SAMPLER)).status).toBe("recovered");
  });

  it("an orphan transition drives the flush itself", () => {
    const flushed: string[] = [];
    AskAnswers.setFlusher((k) => flushed.push(k));
    // Landed with no handler waiting → pushed immediately.
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    expect(flushed).toContain(TAB);
    flushed.length = 0;
    // …and an answer that lands WHILE the handler is running is that handler's to
    // return, so it is not announced until the handler unwinds without it.
    AskAnswers.openAsk("pa-ask-2", {
      tabId: TAB,
      fingerprint: askFingerprint(SCHEDULER),
      question: SCHEDULER.question,
    });
    AskAnswers.record("pa-ask-2", "karras", { tabId: TAB });
    expect(flushed).toHaveLength(0);
    AskAnswers.closeAsk("pa-ask-2");
    expect(flushed).toContain(TAB);
  });
});

describe("ask-answer journal — bounds may LABEL, never silently lose (#486)", () => {
  it("an evicted ORPHAN is counted and disclosed on the next delivery", () => {
    // 16 answers fit per tab; the 17th evicts one. Every one of these reached
    // nobody, so the eviction is a real loss and must be reported.
    for (let i = 0; i < 60; i += 1) {
      openAndAnswer(`pa-ask-${i}`, { question: `Q${i}?`, options: [{ label: "a" }, { label: "b" }] }, `A${i}`);
    }
    expect(AskAnswers.droppedFor(TAB)).toBeGreaterThan(0);
    const seen: AskAnswerEvent[] = [];
    AskAnswers.deliverPending(TAB, (payload) => {
      seen.push(payload);
      return true;
    });
    expect(seen[0].dropped_answers).toBeGreaterThan(0);
  });

  it("an eviction disclosure is NOT spent by a hand-off that is later given back", () => {
    for (let i = 0; i < 60; i += 1) {
      openAndAnswer(`pa-ask-${i}`, { question: `Q${i}?`, options: [{ label: "a" }, { label: "b" }] }, `A${i}`);
    }
    const carrier = AskAnswers.pending(TAB)[0];
    AskAnswers.deliverPending(TAB, () => true);
    AskAnswers.release(carrier.token, { carried: false });
    const seen: AskAnswerEvent[] = [];
    AskAnswers.deliverPending(TAB, (payload) => {
      seen.push(payload);
      return true;
    });
    expect(seen[0].dropped_answers).toBeGreaterThan(0);
  });

  it("an ACKED answer is evicted before an orphan, and silently", () => {
    // Ordinary successful asks must not manufacture "answers were dropped"
    // warnings — the agent provably read them. Only the orphan is a loss.
    openAndAnswer("pa-orphan", SAMPLER, "dpmpp_2m");
    for (let i = 0; i < 70; i += 1) {
      ordinaryAckedAsk(`pa-ret-${i}`, { question: `Q${i}?`, options: [{ label: "a" }, { label: "b" }] }, `A${i}`);
    }
    expect(AskAnswers.droppedFor(TAB)).toBe(0);
    // The orphan is still there — it was never a candidate for a quiet eviction.
    expect(AskAnswers.orphansFor(TAB).map((e) => e.answer)).toContain("dpmpp_2m");
  });

  it("acked answers are evicted BEFORE a returned-but-unacked one", () => {
    // The ORDER is what keeps the common path quiet. If an unacked answer were
    // picked while acked ones were available, every busy tab would start
    // reporting undetermined losses for answers that were merely returned.
    AskAnswers.openAsk("pa-unconfirmed", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.markReturnedForTest("pa-unconfirmed", "dpmpp_2m", TAB);
    AskAnswers.closeAsk("pa-unconfirmed");
    for (let i = 0; i < 70; i += 1) {
      ordinaryAckedAsk(`pa-ok-${i}`, { question: `Q${i}?`, options: [{ label: "a" }, { label: "b" }] }, `A${i}`);
    }
    // Every eviction took an ACKED answer, so nothing was disclosed…
    expect(AskAnswers.droppedFor(TAB)).toBe(0);
    // …and the one answer whose receipt was never confirmed is still on file.
    expect(AskAnswers.entriesFor(TAB).some((e) => e.answer === "dpmpp_2m")).toBe(true);
  });

  // THE SPLIT (coordinator ruling on Trade A). "returned" says only that the
  // answer was written to a transport that may already have been abandoned —
  // which IS #486 — so it can never be the licence to forget. Only a turn that
  // produced its own result proves the model read it.
  it("a RETURNED-but-UNACKED answer evicted is counted and disclosed", () => {
    // 60 answers handed back to tool calls whose turns never completed.
    for (let i = 0; i < 60; i += 1) {
      const ask = { question: `U${i}?`, options: [{ label: "a" }, { label: "b" }] };
      AskAnswers.openAsk(`pa-unacked-${i}`, {
        tabId: TAB,
        fingerprint: askFingerprint(ask),
        question: ask.question,
      });
      AskAnswers.markReturned(AskAnswers.record(`pa-unacked-${i}`, `U${i}`, { tabId: TAB }).token);
      AskAnswers.closeAsk(`pa-unacked-${i}`);
    }
    // The ceiling bit, and every eviction was a #486 failure, not an ordinary ask.
    expect(AskAnswers.droppedFor(TAB)).toBeGreaterThan(0);
    expect(AskAnswers.hasOutstanding()).toBe(true);
  });

  it("an ACKED answer never blocks a restart and is not named on the way out", () => {
    ordinaryAckedAsk("pa-acked", SAMPLER, "dpmpp_2m");
    const entry = AskAnswers.entriesFor(TAB)[0];
    expect(entry.acked).toBe(true);
    expect(AskAnswers.hasOutstanding()).toBe(false);
    expect(AskAnswers.allOutstanding()).toHaveLength(0);
  });

  it("a returned answer whose turn never completed IS named on the way out", () => {
    AskAnswers.openAsk("pa-unconfirmed", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    const token = AskAnswers.markReturnedForTest("pa-unconfirmed", "dpmpp_2m", TAB);
    AskAnswers.closeAsk("pa-unconfirmed");
    // The turn ended without proving it was read — #468's release path.
    AskAnswers.release(token, { carried: true });
    expect(AskAnswers.entriesFor(TAB)[0].acked).toBeUndefined();
    expect(AskAnswers.allOutstanding().map((e) => e.answer)).toContain("dpmpp_2m");
  });

  it("a released tool-result answer is never re-armed for a push, nor settled by a bound", () => {
    AskAnswers.openAsk("pa-tr", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    const token = AskAnswers.markReturnedForTest("pa-tr", "dpmpp_2m", TAB);
    AskAnswers.closeAsk("pa-tr");
    for (let i = 0; i < 10; i += 1) AskAnswers.release(token, { carried: true });
    // Nothing re-sends a tool-result answer, so there is no loop to bound — and
    // settling it on one would forge the proof the split exists to withhold.
    expect(AskAnswers.pending(TAB)).toHaveLength(0);
    expect(AskAnswers.entriesFor(TAB)[0].acked).toBeUndefined();
    expect(AskAnswers.entriesFor(TAB)[0].delivery).toBe("none");
  });

  it("the turn attacher is asked to carry every returned answer", () => {
    const carried: string[] = [];
    AskAnswers.setTurnAttacher((_key, token) => {
      carried.push(token);
      return TURN;
    });
    AskAnswers.openAsk("pa-attach", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    const token = AskAnswers.markReturnedForTest("pa-attach", "dpmpp_2m", TAB);
    expect(carried).toEqual([token]);
    expect(AskAnswers.entriesFor(TAB)[0].carrier).toBe(TURN);
  });

  it("a trimmed TICKET can only weaken a correlation, never drop the answer", () => {
    // `tracks()` is what the bridge sink filters on. If it were answered from the
    // (bounded) ticket map, an eviction would make a validated answer vanish —
    // a bounded store protecting against a bounded store.
    AskAnswers.openAsk("pa-ask-old", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-ask-old"); // its tool call died; the ticket is evictable
    for (let i = 0; i < 1200; i += 1) {
      const ask = { question: `Q${i}?`, options: [{ label: "a" }, { label: "b" }] };
      AskAnswers.openAsk(`pa-ask-${i}`, {
        tabId: TAB,
        fingerprint: askFingerprint(ask),
        question: ask.question,
      });
      AskAnswers.closeAsk(`pa-ask-${i}`);
    }
    expect(AskAnswers.ticketFor("pa-ask-old")).toBeUndefined(); // ticket trimmed away
    expect(AskAnswers.tracks("pa-ask-old")).toBe(true); // …but still one of ours
    AskAnswers.record("pa-ask-old", "dpmpp_2m", { tabId: TAB });
    const entry = AskAnswers.entriesFor(TAB).find((e) => e.askId === "pa-ask-old");
    expect(entry?.answer).toBe("dpmpp_2m");
    expect(entry?.correlation.status).toBe("foreign"); // weakened, not lost
  });

  it("the same answer observed twice collapses to one entry (identity, not suppression)", () => {
    // The grace poll and the bridge sink can both see one card's reply.
    AskAnswers.openAsk("pa-ask-1", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    const a = AskAnswers.record("pa-ask-1", "dpmpp_2m", { tabId: TAB });
    const b = AskAnswers.record("pa-ask-1", "dpmpp_2m", { tabId: TAB });
    expect(b.token).toBe(a.token);
    expect(AskAnswers.entriesFor(TAB)).toHaveLength(1);
  });

  it("two DIFFERENT answers are never merged, however alike", () => {
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    openAndAnswer("pa-ask-2", SAMPLER, "dpmpp_2m");
    expect(AskAnswers.entriesFor(TAB)).toHaveLength(2);
  });

  // codex rounds 1+3, P0: an eviction disclosure is stamped onto a surviving
  // entry, and a recovery used to DELETE that carrier — so an eviction the
  // journal had promised to report vanished because an unrelated answer was
  // recovered. A recovery no longer deletes anything, so the debt rides on.
  it("a recovery leaves the disclosure's carrier (and its debt) in place", () => {
    for (let i = 0; i < 60; i += 1) {
      openAndAnswer(`pa-ask-${i}`, { question: `Q${i}?`, options: [{ label: "a" }, { label: "b" }] }, `A${i}`);
    }
    const owed = AskAnswers.droppedFor(TAB);
    expect(owed).toBeGreaterThan(0);
    const carrier = AskAnswers.entriesFor(TAB).find((e) => (e.disclose ?? 0) > 0);
    expect(carrier).toBeDefined();
    AskAnswers.markSurfaced(carrier!.token);
    expect(AskAnswers.droppedFor(TAB)).toBe(owed);
    expect(AskAnswers.entriesFor(TAB).some((e) => e.token === carrier!.token)).toBe(true);
  });

  // codex round 1, P0: a RETURNED answer used to be deleted once it aged past the
  // recovery window. "It went into a ToolResult" is exactly the thing that is not
  // provable here — that IS #486 — so nothing may be dropped on that basis.
  it("nothing is ever expired by age — only recovery, eviction or a gone tab remove an answer", () => {
    AskAnswers.openAsk("pa-ask-1", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.markReturned(AskAnswers.record("pa-ask-1", "dpmpp_2m", { tabId: TAB }).token);
    AskAnswers.closeAsk("pa-ask-1");
    const entry = AskAnswers.entriesFor(TAB)[0];
    entry.answeredAt = Date.now() - ASK_RECOVER_MAX_AGE_MS * 10;
    // Any number of later journal operations must not sweep it away.
    openAndAnswer("pa-ask-2", SCHEDULER, "karras");
    AskAnswers.recover(TAB, askFingerprint(SCHEDULER));
    expect(AskAnswers.entriesFor(TAB).some((e) => e.askId === "pa-ask-1")).toBe(true);
    // Too old to be presented as a fresh decision, but still REPORTABLE.
    const rec = AskAnswers.recover(TAB, askFingerprint(SAMPLER));
    expect(rec.status).toBe("unattributed");
    if (rec.status !== "unattributed") return;
    // This one is NOT retired and NOT another tab's — it is this conversation's
    // own earlier answer, merely too old to present as a fresh decision. So it IS
    // shown, with its own question attached; nothing is withheld.
    expect(rec.withheld).toBe(0);
    expect(rec.others.some((e) => e.answer === "dpmpp_2m")).toBe(true);
  });

  // codex round 1, P0: `closeAsks` dropped the ticket but the card was still on
  // screen, so a click minutes later was journaled as `foreign`, addressed to the
  // same tab, and PUSHED into the replacement conversation — an unsolicited turn
  // about a decision that conversation never asked for.
  it("an answer to a card whose conversation was replaced is never announced to the new one", () => {
    AskAnswers.openAsk("pa-ask-1", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-ask-1");
    AskAnswers.closeAsks(TAB); // New chat / resume of a historical session
    // The user clicks the still-rendered old card.
    const entry = AskAnswers.record("pa-ask-1", "dpmpp_2m", { tabId: TAB });
    expect(entry.delivery).toBe("none");
    expect(AskAnswers.pending(TAB)).toHaveLength(0);
    expect(AskAnswers.hasOutstanding()).toBe(false);
    // …not swallowed either: it is still on file for disclosure, and it can never
    // satisfy a question.
    const rec = AskAnswers.recover(TAB, askFingerprint(SAMPLER));
    expect(rec.status).toBe("unattributed");
    if (rec.status !== "unattributed") return;
    // WITHHELD, not shown: its content belongs to a conversation/tab that is no
    // longer here, and rendering the chosen option into this conversation's
    // result is the leak the boundary exists to stop. The COUNT is the
    // disclosure; the text stays journaled and in the durable log.
    expect(rec.withheld).toBeGreaterThan(0);
    expect(rec.others.some((e) => e.answer === "dpmpp_2m")).toBe(false);
    expect(AskAnswers.entriesFor(TAB).some((e) => e.answer === "dpmpp_2m")).toBe(true);
  });

  it("an already-journaled answer stops being pushed when its conversation is replaced", () => {
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    expect(AskAnswers.pending(TAB)).toHaveLength(1);
    AskAnswers.closeAsks(TAB);
    expect(AskAnswers.pending(TAB)).toHaveLength(0);
    expect(AskAnswers.entriesFor(TAB)).toHaveLength(1); // kept for disclosure
  });

  it("a late answer for a tab that is GONE is never armed for a doomed push", () => {
    AskAnswers.openAsk("pa-ask-1", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-ask-1");
    AskAnswers.forget(TAB); // workflow switched away / tab closed
    const entry = AskAnswers.record("pa-ask-1", "dpmpp_2m", { tabId: TAB });
    expect(entry.delivery).toBe("none");
    expect(AskAnswers.hasOutstanding()).toBe(false);
  });

  // codex round 4, P0: the ask path used to TAKE the debt, i.e. spend it on the
  // first tool result — which is a hand-off, not a receipt, so an abandoned call
  // carried the "N answers were lost" disclosure away with it. It is now spent by
  // a COUNT of reports (the same trade MAX_CARRIED_RELEASES makes for a push):
  // repeated at worst, never swallowed, and it cannot repeat forever.
  // Coordinator gate, round 2: the debt was retired after three REPORTS — but a
  // report is a ToolResult hand-off, so three abandoned calls carried the only
  // disclosure away with them and the evicted answers' payloads were already
  // gone. It now rides the same ack as everything else.
  it("an eviction debt is retired only by the ack of the turn that carried it", () => {
    strandEvictionDebt();
    const owed = AskAnswers.droppedFor(TAB);
    expect(owed).toBeGreaterThan(0);

    // No live turn to ride: nothing is retired, however many results carry it.
    AskAnswers.setTurnAttacher(() => null);
    for (let i = 0; i < 10; i += 1) expect(AskAnswers.reportDropped(TAB)).toBe(owed);
    expect(AskAnswers.hasOutstanding()).toBe(true);

    // A turn DOES carry it, but ends without proving it was read — still owed.
    const tokens: string[] = [];
    AskAnswers.setTurnAttacher((_key, token) => {
      tokens.push(token);
      return TURN;
    });
    expect(AskAnswers.reportDropped(TAB)).toBe(owed);
    AskAnswers.release(tokens[0], { carried: true });
    // …and a turn that HANDED THE WARNING BACK can never settle it afterwards:
    // its token is spent, so a late ack for it must be a no-op rather than a
    // retroactive claim that the tab was told.
    AskAnswers.ack(tokens[0], { carrier: TURN });
    expect(AskAnswers.droppedFor(TAB)).toBe(owed);
    expect(AskAnswers.reportDropped(TAB)).toBe(owed);
    expect(AskAnswers.droppedFor(TAB)).toBe(owed);

    // …and only that turn's own result settles it.
    AskAnswers.ack(tokens[tokens.length - 1], { carrier: TURN });
    expect(AskAnswers.droppedFor(TAB)).toBe(0);
    expect(AskAnswers.reportDropped(TAB)).toBe(0);
    expect(AskAnswers.outstandingDebt().some((x) => x.key === TAB)).toBe(false);
  });

  // codex round 4, P0: `record` collapsed onto ANY existing entry for the ask id,
  // so a genuinely different validated answer under a reused id was silently
  // discarded. Only an IDENTICAL observation may collapse.
  it("a DIFFERENT answer under the same ask id is kept, and both become undetermined", () => {
    AskAnswers.openAsk("pa-two", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-two");
    const a = AskAnswers.record("pa-two", "euler", { tabId: TAB });
    // The same observation seen twice is ONE answer.
    expect(AskAnswers.record("pa-two", "euler", { tabId: TAB }).token).toBe(a.token);
    // A different pick is a different answer and must not vanish.
    const b = AskAnswers.record("pa-two", "dpmpp_2m", { tabId: TAB });
    expect(b.token).not.toBe(a.token);
    expect(AskAnswers.entriesFor(TAB).map((e) => e.answer).sort()).toEqual(["dpmpp_2m", "euler"]);
    // Neither may satisfy a question — nothing says which card either came from.
    expect(a.recoverable).toBe(false);
    expect(b.recoverable).toBe(false);
    expect(AskAnswers.recover(TAB, askFingerprint(SAMPLER)).status).toBe("unattributed");
  });

  // codex round 2, P0: ownership of an ask id used to be answered from a BOUNDED
  // set of remembered ids, so an eviction made the bridge's sink ignore — and
  // therefore silently drop — a validated answer. It is now syntactic: a
  // property of the id itself, which cannot expire, evict, or be raced.
  it("ownership of an ask id is syntactic, so no bound can make an answer vanish", () => {
    expect(AskAnswers.tracks(`${PANEL_ASK_ID_PREFIX}anything-at-all`)).toBe(true);
    // Never opened, never remembered, journal completely empty — still ours.
    AskAnswers.reset();
    expect(AskAnswers.tracks(`${PANEL_ASK_ID_PREFIX}${"x".repeat(40)}`)).toBe(true);
    // A confirm / 18+ consent / secret card's plain id is NOT ours: those cards
    // have deliberately non-recoverable paths (a recovered "Yes, go ahead" must
    // never authorise a different destructive operation).
    expect(AskAnswers.tracks("b6f0a2c8-0000-4000-8000-000000000000")).toBe(false);
  });

  // codex round 2, P0: reopening an ask id overwrote the ticket's question and
  // fingerprint, so the FIRST card's late click would be frozen with the SECOND
  // question's identity and could be recovered as its answer.
  it("a REUSED ask id can never satisfy a question — either question", () => {
    AskAnswers.openAsk("pa-dup", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-dup");
    // The same id opened again, now for a DIFFERENT question.
    AskAnswers.openAsk("pa-dup", {
      tabId: TAB,
      fingerprint: askFingerprint(SCHEDULER),
      question: SCHEDULER.question,
    });
    AskAnswers.closeAsk("pa-dup");
    // The first card is clicked. Nothing on the wire says which card it was.
    const entry = AskAnswers.record("pa-dup", "dpmpp_2m", { tabId: TAB });
    expect(entry.correlation.status).toBe("foreign");
    expect(entry.fingerprint).toBeNull();
    // codex round 14, P2: the ticket now holds the LATER card's question, so
    // carrying it would print that question beside the EARLIER card's answer —
    // a false association stated inside the honest-fallback disclosure itself.
    expect(entry.question).toBeNull();
    expect(AskAnswers.recover(TAB, askFingerprint(SCHEDULER)).status).toBe("unattributed");
    expect(AskAnswers.recover(TAB, askFingerprint(SAMPLER)).status).toBe("unattributed");
    // …but it is still delivered, labelled UNDETERMINED.
    expect(entry.delivery).toBe("pending");
  });

  // codex round 2, P0: the eviction DEBT is destroyed by a teardown exactly as an
  // entry is, so a restart while one is owed turns a disclosed loss back into a
  // silent one. It must hold the restart gate and appear in the exit disclosure.
  it("an owed eviction disclosure keeps the journal 'outstanding' and is named on exit", () => {
    strandEvictionDebt();
    // Nothing is left pending or handed off that carries it — only a counter.
    expect(AskAnswers.droppedFor(TAB)).toBeGreaterThan(0);
    expect(AskAnswers.hasOutstanding()).toBe(true); // the debt holds the restart gate
    const debt = AskAnswers.outstandingDebt();
    expect(debt.some((x) => x.key === TAB && x.count > 0)).toBe(true);
  });

  it("a debt that a turn actually CARRIED is spent, and stops holding the gate", () => {
    for (let i = 0; i < 60; i += 1) {
      openAndAnswer(`pa-ask-${i}`, { question: `Q${i}?`, options: [{ label: "a" }, { label: "b" }] }, `A${i}`);
    }
    expect(AskAnswers.droppedFor(TAB)).toBeGreaterThan(0);
    AskAnswers.deliverPending(TAB, () => true);
    for (const e of AskAnswers.entriesFor(TAB)) AskAnswers.ack(e.token);
    expect(AskAnswers.hasOutstanding()).toBe(false);
    expect(AskAnswers.outstandingDebt()).toHaveLength(0);
  });

  // codex round 2, P0: a RETURNED answer inside the recovery window is still the
  // only copy of a decision that may never have reached the model, so a fatal
  // exit must name it even though a restart does not wait for it.
  it("a recently-returned answer is named by the exit disclosure, but does not block a restart", () => {
    AskAnswers.openAsk("pa-ask-1", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.markReturned(AskAnswers.record("pa-ask-1", "dpmpp_2m", { tabId: TAB }).token);
    AskAnswers.closeAsk("pa-ask-1");
    expect(AskAnswers.hasOutstanding()).toBe(false); // restarts are not stalled
    expect(AskAnswers.allOutstanding().map((e) => e.answer)).toContain("dpmpp_2m");
    // Coordinator gate P0-1: it stays reported NO MATTER HOW OLD it is. An
    // earlier draft dropped it out of the exit disclosure once the recovery
    // window lapsed, which quietly undid the whole returned/acked split — past
    // ten minutes the answer was neither pending nor debt-bearing, so a fatal
    // exit said nothing at all. Unacked means unproven, and time does not turn
    // unproven into delivered.
    AskAnswers.entriesFor(TAB)[0].answeredAt = Date.now() - ASK_RECOVER_MAX_AGE_MS * 100;
    expect(AskAnswers.allOutstanding().map((e) => e.answer)).toContain("dpmpp_2m");
    // …and the moment it IS proven read, it stops being news.
    AskAnswers.ack(AskAnswers.entriesFor(TAB)[0].token, { carrier: TURN });
    expect(AskAnswers.allOutstanding()).toHaveLength(0);
  });

  // codex round 3, P0: the reused-id guard used to live only on the surviving
  // TICKET, so evicting that ticket restored a "fresh" identity to an id a
  // still-rendered card can answer — and the old card's click would then be
  // frozen with the NEW question's fingerprint and could satisfy it.
  it("reuse is proven by an answer on file, not only by a surviving ticket", () => {
    AskAnswers.openAsk("pa-dup2", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-dup2");
    AskAnswers.record("pa-dup2", "dpmpp_2m", { tabId: TAB });
    // The ticket disappears (an eviction, a purge — anything bounded)…
    AskAnswers.dropTicketForTest("pa-dup2");
    expect(AskAnswers.ticketFor("pa-dup2")).toBeUndefined();
    // …and the id is opened again for a DIFFERENT question.
    AskAnswers.openAsk("pa-dup2", {
      tabId: TAB,
      fingerprint: askFingerprint(SCHEDULER),
      question: SCHEDULER.question,
    });
    expect(AskAnswers.ticketFor("pa-dup2")?.reused).toBe(true);
    expect(AskAnswers.recover(TAB, askFingerprint(SCHEDULER)).status).toBe("unattributed");
  });

  // codex round 3, P0: the "this card's conversation is gone" mark used to be a
  // BOUNDED set of ask ids, so past its ceiling a late click on a retired card
  // was announced to the replacement conversation. It is now a per-tab
  // generation, which nothing can overflow.
  it("the replaced-conversation mark is a per-tab generation, not a bounded set", () => {
    AskAnswers.openAsk("pa-old", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-old");
    AskAnswers.closeAsks(TAB);
    // Hundreds of unrelated asks later, the old card is finally clicked. The old
    // mark was a FIFO set of ask ids, so this is exactly what used to age it out
    // and let the answer be announced to the replacement conversation; the epoch
    // lives on the ticket and is untouched by other cards.
    for (let i = 0; i < 900; i += 1) {
      AskAnswers.openAsk(`pa-noise-${i}`, {
        tabId: OTHER_TAB,
        fingerprint: askFingerprint({ question: `N${i}?`, options: [{ label: "a" }] }),
        question: `N${i}?`,
      });
      AskAnswers.closeAsk(`pa-noise-${i}`);
    }
    const entry = AskAnswers.record("pa-old", "dpmpp_2m", { tabId: TAB });
    expect(entry.delivery).toBe("none"); // never announced to the new conversation
    expect(entry.recoverable).toBe(false);
    // …and still reported, with the question it answers intact.
    expect(entry.question).toBe(SAMPLER.question);
  });

  // codex round 3, P0: revoking recoverability by NULLING the fingerprint also
  // erased the journal's ability to notice "this is about the very question
  // being re-asked", so the answer stopped being DISCLOSED as well.
  // The card is still on screen and its question is still on file, so the answer
  // correlates cleanly — but the conversation that asked is gone, so it may be
  // REPORTED and never RETURNED. Recoverability is revoked independently of the
  // fingerprint precisely so this entry can be recognised without being usable.
  it("a late answer to a retired card can never satisfy the re-ask it matches", () => {
    AskAnswers.openAsk("pa-retired2", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-retired2");
    AskAnswers.closeAsks(TAB);
    const entry = AskAnswers.record("pa-retired2", "dpmpp_2m", { tabId: TAB });
    expect(entry.fingerprint).toBe(askFingerprint(SAMPLER)); // recognisable…
    expect(entry.recoverable).toBe(false); // …but not usable
    const rec = AskAnswers.recover(TAB, askFingerprint(SAMPLER));
    expect(rec.status).toBe("unattributed");
    if (rec.status !== "unattributed") return;
    // WITHHELD, not shown: its content belongs to a conversation/tab that is no
    // longer here, and rendering the chosen option into this conversation's
    // result is the leak the boundary exists to stop. The COUNT is the
    // disclosure; the text stays journaled and in the durable log.
    expect(rec.withheld).toBeGreaterThan(0);
    expect(rec.others.some((e) => e.answer === "dpmpp_2m")).toBe(false);
    expect(AskAnswers.entriesFor(TAB).some((e) => e.answer === "dpmpp_2m")).toBe(true);
  });

  it("a revoked answer keeps the fingerprint that makes it disclosable", () => {
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    AskAnswers.closeAsks(TAB);
    const entry = AskAnswers.entriesFor(TAB)[0];
    expect(entry.recoverable).toBe(false);
    expect(entry.fingerprint).toBe(askFingerprint(SAMPLER)); // still recognisable
    expect(AskAnswers.recover(TAB, askFingerprint(SAMPLER)).status).toBe("unattributed");
  });

  it("a tab-id migration carries the conversation generation with the tickets", () => {
    AskAnswers.openAsk("pa-live", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-live");
    AskAnswers.moveKey(TAB, OTHER_TAB);
    // The agent moved with the tab id, so its still-live card is still live.
    const entry = AskAnswers.record("pa-live", "dpmpp_2m", { tabId: OTHER_TAB });
    expect(entry.key).toBe(OTHER_TAB);
    expect(entry.delivery).toBe("pending");
    expect(AskAnswers.recover(OTHER_TAB, askFingerprint(SAMPLER)).status).toBe("recovered");
  });

  it("a migration does NOT resurrect a card whose conversation was already retired", () => {
    AskAnswers.openAsk("pa-retired", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-retired");
    AskAnswers.closeAsks(TAB); // New chat BEFORE the migration
    AskAnswers.moveKey(TAB, OTHER_TAB);
    const entry = AskAnswers.record("pa-retired", "dpmpp_2m", { tabId: OTHER_TAB });
    expect(entry.delivery).toBe("none");
    expect(entry.recoverable).toBe(false);
  });

  // codex round 5, P0: a REWIND discards everything after its anchor, so a
  // question card the dropped branch put up was never asked by the conversation
  // that now exists — but the handler only reset the agent, leaving the ask
  // journal's epoch untouched. A late click on that card was then announced as
  // "a question card YOU put up", and an identical re-ask in the fork recovered
  // it. Every conversation boundary must retire this tab's asks.
  //
  // Asserted structurally: driving index.ts's panel-event dispatcher needs a
  // booted orchestrator, and the property at stake is the WIRING — that each
  // boundary handler calls closeAsks — not behaviour the journal's own tests
  // don't already cover.
  it("every conversation-boundary handler retires the tab's asks", () => {
    const src = readFileSync(
      new URL("../../orchestrator/index.ts", import.meta.url),
      "utf8",
    );
    // A rewind is a boundary with no run-journal counterpart, so it is named.
    const start = src.indexOf('event.type === "rewind"');
    expect(start, "rewind handler not found").toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("\n      return;", start));
    expect(block, "rewind must retire ask state").toContain("AskAnswers.closeAsks(");

    // A PROVIDER SWITCH is a boundary for questions even though #468 deliberately
    // re-addresses renders across it: a finished render is useful to whoever is
    // on the tab now, an answer to a card the new conversation never put up is
    // not. Both switch paths must retire the asks.
    // …and it must be GATED on an actual change of provider. A routine
    // same-provider re-hello or a no-op set_backend retiring live cards is the
    // over-refusal direction of the same fold: a still-live conversation treated
    // as replaced, so the user's answer to a card it really did put up comes back
    // "unattributed".
    for (const guard of [
      "if (providerSwitched) flushRunCompletions(panelTab);",
      "if (prev !== reqBackend) flushRunCompletions(panelTab);",
    ]) {
      const at = src.indexOf(guard);
      expect(at, `provider-switch site not found: ${guard}`).toBeGreaterThan(-1);
      const cond = guard.slice(0, guard.indexOf(")") + 1); // "if (providerSwitched)"
      expect(
        src.slice(at, at + 900),
        `${guard} must retire ask state, under the same guard`,
      ).toContain(`${cond} AskAnswers.closeAsks(panelTab)`);
    }
    // The unconditional form must not appear at either switch site.
    for (const guard of [
      "if (providerSwitched) flushRunCompletions(panelTab);",
      "if (prev !== reqBackend) flushRunCompletions(panelTab);",
    ]) {
      const at = src.indexOf(guard);
      const window = src.slice(at, at + 900);
      const unguarded = window.match(/\n\s*AskAnswers\.closeAsks\(panelTab\)/);
      expect(unguarded, `${guard}: closeAsks must not run when the provider is unchanged`).toBeNull();
    }

    // The FATAL-EXIT notice is an outlet like any other: it renders answer text
    // and pushes it to whoever holds the tab, so a retired conversation's pick
    // must be counted there, not quoted. The durable LOG still gets everything —
    // two audiences, two buckets.
    // Anchor inside the EXIT-DISCLOSURE function: #884's boundary sweep and
    // journal-flush helpers also call allOutstanding() earlier in the file.
    const exitFnAt = src.indexOf("function reportLostCompletionsOnExit");
    expect(exitFnAt, "exit-disclosure function not found").toBeGreaterThan(-1);
    const exitAt2 = src.indexOf("AskAnswers.allOutstanding()", exitFnAt);
    expect(exitAt2, "exit disclosure not found").toBeGreaterThan(-1);
    const exitBlock = src.slice(exitAt2, exitAt2 + 900);
    expect(exitBlock, "the notice must gate content on the boundary").toContain(
      "AskAnswers.mayDisclose(entry)",
    );
    expect(exitBlock, "…and count what it withholds").toMatch(/withheld \+= 1/);

    // The unsend hook must actually be wired, or closeAsks silently degrades to
    // "leave the stale copy queued"; and the turn attacher must be wired, or the
    // journal has no proof of receipt for the ordinary path and every eviction
    // becomes a disclosed loss.
    expect(src).toContain("AskAnswers.setRevoker(");
    expect(src).toContain("AskAnswers.setFlusher(");
    expect(src).toContain("AskAnswers.setTurnAttacher(");
    expect(src).toContain("manager.attachTurnToken(");
    // …and the debt's lifecycle end must be wired, or removing its ceiling just
    // trades a silent loss for unbounded growth.
    expect(src).toContain("bridge.setTabGoneListener(");
    expect(src).toContain("AskAnswers.retireDebt(");
    // A different browser tab taking over a recurring key is a conversation
    // boundary too — the ENTRIES are tab-keyed, so the newcomer must be shut out
    // of them at the hello, not merely kept from the debt.
    // Asserted on the listener's BODY, not on a one-expression shape. panel#1554 gave
    // this same boundary a second retirement (an abandoned confirmation card must not
    // be claimable by the newcomer either) and the listener became a block. The
    // guarantee under test is "the takeover retires ask state", and a regex that only
    // matches one statement would fail the moment anything legitimately joins it —
    // pressure to install a SECOND setTabTakenOverListener instead, which (it is a
    // setter, not an adder) would silently replace this one and un-ship #486.
    const takeoverAt = src.indexOf("bridge.setTabTakenOverListener(");
    expect(takeoverAt, "takeover listener not found").toBeGreaterThan(-1);
    expect(src.slice(takeoverAt, takeoverAt + 300)).toContain("AskAnswers.closeAsks(tabId)");
    // …and exactly one is installed, which is what makes the body the whole story.
    expect(src.split("bridge.setTabTakenOverListener(").length - 1).toBe(1);
    expect(src).toContain("AskAnswers.setIncarnationResolver(");
    // The ack must carry WHO is acking, or a switched provider can certify the
    // previous conversation's answer.
    expect(src).toMatch(/AskAnswers\.ack\(token, from\)/);

    // The fatal-exit disclosure must keep RENDERS and ANSWERS apart. A lost
    // answer is not a ComfyUI run and will NEVER be in history, so pointing the
    // user at `get_history` for one is a remedy naming a lever that cannot work —
    // in the one moment they are already dealing with a failure.
    const exitAt = src.indexOf("The agent backend is being restarted");
    expect(exitAt, "exit notice not found").toBeGreaterThan(-1);
    const notice = src.slice(exitAt, exitAt + 1600);
    expect(notice, "the answer branch must not send the user to get_history").toMatch(
      /answer\(s\) you gave[\s\S]*there is NO history to look it up in/,
    );
    expect(notice, "the answer branch must ask for the answer again").toMatch(
      /tell it your choice again/,
    );

    // …and every OTHER boundary is defined by where the run journal draws one.
    // Pairing the two journals structurally is what stops the next boundary from
    // being added to one and forgotten in the other — which is exactly how a late
    // answer reached a conversation that never asked the question, twice.
    const pairs: Array<[RegExp, string, boolean]> = [
      // The run journal also closes by CONVERSATION (#704 — a ticket whose tab id
      // churned on a reconnect is in no member-tab sweep), so the site carries an
      // optional second argument. The PAIRING is still on the tab: that is the
      // argument both journals share.
      [/RunCompletions\.closeRuns\((\w+)(?:, \w+)?\)/g, "AskAnswers.closeAsks($1)", true],
      // #884 removed every forget() site: an unproven workflow transition no
      // longer purges the journals, because the conversation is orchestrator-
      // scoped and deliberately CONTINUES across a workflow switch (pending
      // deliveries follow the socket via moveKey instead). The pairing rule
      // still stands for any future forget() site — it just may be absent.
      [/RunCompletions\.forget\((\w+)\)/g, "AskAnswers.forget($1)", false],
    ];
    for (const [re, template, required] of pairs) {
      const found = [...src.matchAll(re)];
      if (required) {
        expect(found.length, `no ${re.source} call sites found`).toBeGreaterThan(0);
      }
      for (const m of found) {
        const arg = m[1];
        const want = template.replace("$1", arg);
        const near = src.slice(m.index!, m.index! + 900);
        expect(near, `${m[0]} is not paired with ${want}`).toContain(want);
      }
    }
    // …and the #884 boundary-follows-the-socket rule has the same two-journal
    // pairing obligation: a moveKey in one journal must move the other too.
    const moved = [...src.matchAll(/RunCompletions\.moveKey\((\w+), (\w+)\)/g)];
    expect(moved.length, "no RunCompletions.moveKey call sites found").toBeGreaterThan(0);
    for (const m of moved) {
      const want = `AskAnswers.moveKey(${m[1]}, ${m[2]})`;
      expect(
        src.slice(m.index!, m.index! + 900),
        `${m[0]} is not paired with ${want}`,
      ).toContain(want);
    }
  });

  // codex round 7, P1: an answer already QUEUED into an agent carries wording
  // that claims the reader put the card up. If the conversation is replaced
  // before that item is read, the sentence is false of the fork — so the queued
  // copy has to be pulled back, exactly as #468 does for a downgraded completion.
  it("a replaced conversation unsends an answer that is still queued and unread", () => {
    const revoked: string[] = [];
    AskAnswers.setRevoker((_key, token) => {
      revoked.push(token);
      return true;
    });
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    AskAnswers.deliverPending(TAB, () => true);
    const token = AskAnswers.entriesFor(TAB)[0].token;
    expect(AskAnswers.entriesFor(TAB)[0].delivery).toBe("handed_off");
    AskAnswers.closeAsks(TAB);
    expect(revoked).toEqual([token]);
    expect(AskAnswers.entriesFor(TAB)[0].delivery).toBe("none");
    AskAnswers.setRevoker(() => false);
  });

  it("an answer already being READ cannot be recalled, and is not pretended otherwise", () => {
    AskAnswers.setRevoker(() => false); // the carrying turn already started
    openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m");
    AskAnswers.deliverPending(TAB, () => true);
    AskAnswers.closeAsks(TAB);
    // Still marked handed_off — the text is in the model's context; claiming we
    // pulled it back would be a lie.
    expect(AskAnswers.entriesFor(TAB)[0].delivery).toBe("handed_off");
  });

  // codex round 7, P1: the ticket map used to keep a ticket for every ask ever
  // made, so a long session's ordinary successful asks filled it and evicted a
  // genuinely OUTSTANDING card's ticket — taking its retired-conversation marker
  // with it, after which a late click landed in the replacement conversation.
  it("an ANSWERED card releases its ticket, so the ceiling only counts cards on screen", () => {
    AskAnswers.openAsk("pa-outstanding", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-outstanding"); // timed out; card still on screen
    // …and now 2000 ordinary, ANSWERED asks go by.
    for (let i = 0; i < 2000; i += 1) {
      const ask = { question: `Q${i}?`, options: [{ label: "a" }, { label: "b" }] };
      AskAnswers.openAsk(`pa-done-${i}`, {
        tabId: TAB,
        fingerprint: askFingerprint(ask),
        question: ask.question,
      });
      AskAnswers.markReturned(AskAnswers.record(`pa-done-${i}`, "a", { tabId: TAB }).token);
      AskAnswers.closeAsk(`pa-done-${i}`);
      expect(AskAnswers.ticketFor(`pa-done-${i}`)).toBeUndefined(); // released
    }
    // The outstanding card's ticket — and with it the conversation generation
    // that protects the replacement conversation — is still there.
    expect(AskAnswers.ticketFor("pa-outstanding")).toBeDefined();
    AskAnswers.closeAsks(TAB);
    const entry = AskAnswers.record("pa-outstanding", "dpmpp_2m", { tabId: TAB });
    expect(entry.delivery).toBe("none");
    expect(entry.recoverable).toBe(false);
  });

  // codex round 8, P1: "same id, same text" is only evidence of ONE observation
  // while the id means one card. Once two cards share it, two picks that happen
  // to read the same are two validated answers to two questions — merging them
  // left the second question unanswered with no record at all.
  it("two reused cards answered IDENTICALLY are both kept", () => {
    AskAnswers.openAsk("pa-same", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-same");
    const a = AskAnswers.record("pa-same", "euler", { tabId: TAB });
    // A second card accidentally reuses the id, for a different question.
    AskAnswers.openAsk("pa-same", {
      tabId: TAB,
      fingerprint: askFingerprint(SCHEDULER),
      question: SCHEDULER.question,
    });
    AskAnswers.closeAsk("pa-same");
    expect(AskAnswers.ticketFor("pa-same")?.reused).toBe(true);
    // The user picks the SAME text on the second card.
    const b = AskAnswers.record("pa-same", "euler", { tabId: TAB });
    expect(b.token).not.toBe(a.token);
    expect(AskAnswers.entriesFor(TAB)).toHaveLength(2);
    expect(b.delivery).toBe("pending"); // still reported, labelled undetermined
    expect(b.recoverable).toBe(false);
  });

  // Coordinator gate: the collapse guard read `ticket?.reused`, which is an
  // EVICTABLE store — once the reused ticket was trimmed the guard silently
  // switched back on and the second card's validated answer was discarded before
  // it ever had an entry. The ambiguity now lives on the ENTRY, which outlives
  // the ticket.
  it("a trimmed reused TICKET does not re-enable the identical-answer collapse", () => {
    AskAnswers.openAsk("pa-evicted", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-evicted");
    const a = AskAnswers.record("pa-evicted", "euler", { tabId: TAB });
    // A second card reuses the id, for a different question…
    AskAnswers.openAsk("pa-evicted", {
      tabId: TAB,
      fingerprint: askFingerprint(SCHEDULER),
      question: SCHEDULER.question,
    });
    expect(a.ambiguousId).toBe(true); // frozen on the entry at reopen
    // …and then the ticket ceiling bites.
    AskAnswers.dropTicketForTest("pa-evicted");
    expect(AskAnswers.ticketFor("pa-evicted")).toBeUndefined();
    // The user answers the SECOND card with the same text.
    const b = AskAnswers.record("pa-evicted", "euler", { tabId: TAB });
    expect(b.token).not.toBe(a.token); // kept, not collapsed away
    expect(AskAnswers.entriesFor(TAB)).toHaveLength(2);
    expect(b.recoverable).toBe(false);
    expect(a.recoverable).toBe(false);
  });

  it("…but one observation seen twice is still ONE answer", () => {
    // The grace poll and the bridge sink can both see a single card's reply. The
    // id is not reused there, so the collapse is identity, not suppression.
    AskAnswers.openAsk("pa-once", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-once");
    const a = AskAnswers.record("pa-once", "euler", { tabId: TAB });
    expect(AskAnswers.record("pa-once", "euler", { tabId: TAB }).token).toBe(a.token);
    expect(AskAnswers.entriesFor(TAB)).toHaveLength(1);
  });

  // codex round 11, P1: an eviction stamps its undetermined-loss count onto a
  // surviving entry; a recovery then marks that carrier `returned`, which makes
  // it the PREFERRED eviction victim — and the returned-victim path dropped it
  // without re-homing the count. The accepted residual permits losing that
  // entry's recoverability, not the debt owed for OTHER answers that reached
  // nobody.
  it("evicting a RETURNED carrier re-homes the debt it was carrying", () => {
    for (let i = 0; i < 60; i += 1) {
      openAndAnswer(`pa-ask-${i}`, { question: `Q${i}?`, options: [{ label: "a" }, { label: "b" }] }, `A${i}`);
    }
    const owed = AskAnswers.droppedFor(TAB);
    expect(owed).toBeGreaterThan(0);
    const carrier = AskAnswers.entriesFor(TAB).find((e) => (e.disclose ?? 0) > 0);
    expect(carrier).toBeDefined();
    AskAnswers.markSurfaced(carrier!.token); // a recovery handed it over
    AskAnswers.ack(carrier!.token, { carrier: TURN }); // …and that turn completed
    expect(carrier!.acked).toBe(true); // now the preferred eviction victim
    // More answers arrive, all of them ACKED, so every eviction they cause takes
    // the quiet path and creates NO new debt — leaving the carrier's count as the
    // only debt in play.
    for (let i = 60; i < 80; i += 1) {
      ordinaryAckedAsk(`pa-ret-${i}`, { question: `R${i}?`, options: [{ label: "a" }, { label: "b" }] }, `R${i}`);
    }
    expect(AskAnswers.entriesFor(TAB).some((e) => e.token === carrier!.token)).toBe(false);
    // EXACTLY the same debt — it moved, it did not evaporate with its carrier.
    expect(AskAnswers.droppedFor(TAB)).toBe(owed);
  });

  // codex round 12, P0: the ticket map is global, so a REUSED id can name a
  // ticket opened by a DIFFERENT tab. Taking that ticket's tab re-addressed the
  // answer to a conversation that never rendered the card — labelled `foreign`
  // so it could satisfy nothing, but still delivered to the wrong place.
  it("an unattributable answer is addressed to the tab that PROVABLY sent it", () => {
    AskAnswers.openAsk("pa-shared", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-shared");
    // The other tab accidentally dispatches a card with the same id.
    AskAnswers.openAsk("pa-shared", {
      tabId: OTHER_TAB,
      fingerprint: askFingerprint(SCHEDULER),
      question: SCHEDULER.question,
    });
    AskAnswers.closeAsk("pa-shared");
    expect(AskAnswers.ticketFor("pa-shared")?.tabId).toBe(OTHER_TAB);
    // The reply comes back from the FIRST tab — the bridge routed it, so that is
    // proven, unlike anything the shared id can say.
    const entry = AskAnswers.record("pa-shared", "dpmpp_2m", { tabId: TAB });
    expect(entry.key).toBe(TAB);
    expect(entry.correlation.status).toBe("foreign");
    expect(AskAnswers.entriesFor(OTHER_TAB)).toHaveLength(0);
  });

  // Gate P0-2: the disclosure DEBT used to be evictable on the same terms as
  // payload (64 tabs), so the 65th tab with stranded debt deleted the oldest
  // tab's only record — after which its later ask, the restart gate and the
  // fatal-exit report all had nothing, and the log line said outright that the
  // tab "will not be told". A bounded store must never decide whether a warning
  // is owed.
  it("debt for the FIRST tab survives far past any tab ceiling", () => {
    const FIRST = "tab-first-0001";
    const strandFor = (tab: string): void => {
      // Fill the tab's ceiling with orphans, hand them all off, then land one
      // more answer whose handler is still awaiting — so the eviction it triggers
      // has no pending entry to stamp and the debt goes to the side map.
      for (let i = 0; i < 48; i += 1) {
        const ask = { question: `${tab}-Q${i}?`, options: [{ label: "a" }, { label: "b" }] };
        AskAnswers.openAsk(`pa-${tab}-${i}`, {
          tabId: tab,
          fingerprint: askFingerprint(ask),
          question: ask.question,
        });
        AskAnswers.closeAsk(`pa-${tab}-${i}`);
        AskAnswers.record(`pa-${tab}-${i}`, `A${i}`, { tabId: tab });
      }
      AskAnswers.deliverPending(tab, () => true);
      AskAnswers.openAsk(`pa-${tab}-live`, {
        tabId: tab,
        fingerprint: askFingerprint(SAMPLER),
        question: SAMPLER.question,
      });
      AskAnswers.record(`pa-${tab}-live`, "dpmpp_2m", { tabId: tab });
    };
    strandFor(FIRST);
    const owed = AskAnswers.droppedFor(FIRST);
    expect(owed).toBeGreaterThan(0);
    // 200 further tabs each strand their own debt — three times the old ceiling.
    for (let t = 1; t <= 200; t += 1) strandFor(`tab-other-${String(t).padStart(4, "0")}`);
    // The FIRST tab is still owed (never less — the global ceiling may have cost
    // it more answers since), still holds the restart gate, and is still named by
    // the fatal-exit report.
    const still = AskAnswers.droppedFor(FIRST);
    expect(still).toBeGreaterThanOrEqual(owed);
    expect(AskAnswers.reportDropped(FIRST)).toBe(still);
    expect(AskAnswers.hasOutstanding()).toBe(true);
    expect(AskAnswers.outstandingDebt().some((x) => x.key === FIRST && x.count > 0)).toBe(true);
  });

  // Coordinator gate P1-2: removing the ceiling was right, but a debt then needs
  // a LIFECYCLE end or it accumulates for every temporary tab that never
  // reconnects. It must end because it was SURFACED or its tab went away — never
  // because a counter filled up and picked a victim.
  it("a tab leaving the bridge surfaces and retires its debt, keeping its answers", () => {
    strandEvictionDebt();
    expect(AskAnswers.droppedFor(TAB)).toBeGreaterThan(0);
    const answersBefore = AskAnswers.entriesFor(TAB).length;
    expect(answersBefore).toBeGreaterThan(0);

    AskAnswers.retireDebt(TAB, OCCUPANT); // what the bridge's tab-gone listener calls

    expect(AskAnswers.droppedFor(TAB)).toBe(0);
    expect(AskAnswers.outstandingDebt().some((x) => x.key === TAB)).toBe(false);
    // A disconnect is usually a reload — the ANSWERS are still deliverable.
    expect(AskAnswers.entriesFor(TAB)).toHaveLength(answersBefore);
  });

  it("debt does not accumulate across many short-lived tabs", () => {
    // Each short-lived tab strands a debt and then goes away. ONLY the tab-gone
    // wire may clear it — no `forget`, no ceiling — so if the wire is missing the
    // map grows without limit, which is the cost of removing the ceiling.
    for (let t = 0; t < 300; t += 1) {
      const tab = `tab-ephemeral-${t}`;
      AskAnswers.noteDroppedForTest(tab, 1);
      AskAnswers.retireDebt(tab, OCCUPANT);
    }
    expect(AskAnswers.outstandingDebt()).toHaveLength(0);
    expect(AskAnswers.droppedFor("tab-ephemeral-0")).toBe(0);
    expect(AskAnswers.droppedFor("tab-ephemeral-299")).toBe(0);
  });

  // Coordinator gate P1: the debt's COUNT is tab-keyed and its outstanding
  // disclosure TOKENS carry that same key, but the ack that settles one is bound
  // to the agent instance — which deliberately survives a tab-id migration. A
  // token left pointing at the old key is acked by a perfectly valid result and
  // clears a debt nobody owes, while the real one sits under the new key forever:
  // false outstanding debt that blocks the restart gate and later warns for
  // nothing.
  it("a tab-id migration moves the debt COUNT and its tokens together", () => {
    AskAnswers.noteDroppedForTest(TAB, 4);
    const tokens: string[] = [];
    AskAnswers.setTurnAttacher((_key, token) => {
      tokens.push(token);
      return TURN;
    });
    expect(AskAnswers.reportDropped(TAB)).toBe(4); // a warning is riding a turn

    // The tab id migrates while that warning is still in flight.
    AskAnswers.moveKey(TAB, OTHER_TAB);
    expect(AskAnswers.droppedFor(OTHER_TAB)).toBe(4);
    expect(AskAnswers.droppedFor(TAB)).toBe(0);

    // The carrying turn's result lands — the ack must settle the debt where it
    // actually lives now, not under the id it was minted against.
    AskAnswers.ack(tokens[0], { carrier: TURN });
    expect(AskAnswers.droppedFor(OTHER_TAB)).toBe(0);
    expect(AskAnswers.outstandingDebt()).toHaveLength(0);
  });

  // The journal half of the same seam: even if a stranger reaches the debt, its
  // result must not settle it. The disclosure token is bound to the AGENT
  // INSTANCE that carried it, so a different conversation on the same tab key
  // cannot certify a warning it never showed.
  it("a different agent instance cannot ack the departed tab's disclosure", () => {
    AskAnswers.noteDroppedForTest(TAB, 3);
    const tokens: string[] = [];
    AskAnswers.setTurnAttacher((_key, token) => {
      tokens.push(token);
      return "pa-instance-A";
    });
    expect(AskAnswers.reportDropped(TAB)).toBe(3);

    // A second browser tab takes over the same key; its agent is a NEW instance.
    AskAnswers.ack(tokens[0], { carrier: "pa-instance-B" });
    expect(AskAnswers.droppedFor(TAB)).toBe(3); // still owed
    AskAnswers.ack(tokens[0]); // …and an unidentified ack proves nothing either
    expect(AskAnswers.droppedFor(TAB)).toBe(3);

    // Only the instance that actually carried the warning retires it.
    AskAnswers.ack(tokens[0], { carrier: "pa-instance-A" });
    expect(AskAnswers.droppedFor(TAB)).toBe(0);
  });

  // Coordinator gate: a warning names a NUMBER, and only that number is settled
  // when its turn ends. The token used to record only the tab, so an eviction
  // that landed AFTER the warning was rendered — while its turn was still
  // running — was wiped by an ack that never mentioned it.
  it("an ack settles only what its warning showed, not evictions that landed after", () => {
    AskAnswers.noteDroppedForTest(TAB, 2);
    const tokens: string[] = [];
    AskAnswers.setTurnAttacher((_key, token) => {
      tokens.push(token);
      return TURN;
    });
    expect(AskAnswers.reportDropped(TAB)).toBe(2); // the warning says "2"

    // While that turn is still running, two MORE answers are evicted.
    AskAnswers.noteDroppedForTest(TAB, 3);

    // The turn completes. It showed 2, so it settles 2 — never the 3 it never saw.
    AskAnswers.ack(tokens[0], { carrier: TURN });
    expect(AskAnswers.droppedFor(TAB)).toBe(3);
    expect(AskAnswers.hasOutstanding()).toBe(true);
    expect(AskAnswers.outstandingDebt().some((x) => x.key === TAB && x.count === 3)).toBe(true);

    // The next result reports the remainder, and settling THAT clears the tab.
    expect(AskAnswers.reportDropped(TAB)).toBe(3);
    AskAnswers.ack(tokens[1], { carrier: TURN });
    expect(AskAnswers.droppedFor(TAB)).toBe(0);
    expect(AskAnswers.outstandingDebt()).toHaveLength(0);
  });

  it("two results reporting the SAME debt settle it once, not twice", () => {
    AskAnswers.noteDroppedForTest(TAB, 2);
    const tokens: string[] = [];
    AskAnswers.setTurnAttacher((_key, token) => {
      tokens.push(token);
      return TURN;
    });
    // Two separate results each carry the same warning ("2 answers dropped").
    expect(AskAnswers.reportDropped(TAB)).toBe(2);
    expect(AskAnswers.reportDropped(TAB)).toBe(2);
    // Three more answers are evicted before either turn finishes.
    AskAnswers.noteDroppedForTest(TAB, 3);

    // Both turns complete. Between them they showed 2 — not 4 — so 3 remain
    // owed. A count that added instead of watermarking would swallow two of them.
    AskAnswers.ack(tokens[0], { carrier: TURN });
    AskAnswers.ack(tokens[1], { carrier: TURN });
    expect(AskAnswers.droppedFor(TAB)).toBe(3);
    expect(AskAnswers.hasOutstanding()).toBe(true);
  });

  // Coordinator gate P0: the CLOCK was incarnation-scoped but the DEBT was not.
  // After A disconnects owing a disclosure, B opens the same recurring key and
  // calls panel_ask — and A's debt was reported into B's result and settled by
  // B's ack, so A's own gone-callback later found nothing to disclose. Cross-tab
  // delivery AND acknowledgement, one layer below where the keying was fixed.
  it("a NEW tab on the same key neither reads nor settles the departed tab's debt", () => {
    let holder: string | undefined = "browser-tab-A";
    AskAnswers.setIncarnationResolver(() => holder);
    const tokens: string[] = [];
    AskAnswers.setTurnAttacher((_key, token) => {
      tokens.push(token);
      return TURN;
    });

    // A strands a debt on the shared key.
    AskAnswers.noteDroppedForTest(TAB, 3);
    expect(AskAnswers.reportDropped(TAB)).toBe(3);
    AskAnswers.ack(tokens[0], { carrier: TURN }); // A was told, and settles it
    expect(AskAnswers.droppedFor(TAB)).toBe(0);

    // A strands a SECOND debt and then leaves without being told.
    AskAnswers.noteDroppedForTest(TAB, 2);
    expect(AskAnswers.droppedFor(TAB)).toBe(2);

    // A different browser tab takes the key over and asks a question.
    holder = "browser-tab-B";
    expect(AskAnswers.reportDropped(TAB)).toBe(0); // B is owed nothing
    // …and even a well-formed ack from B settles nothing of A's.
    AskAnswers.noteDroppedForTest(TAB, 1); // B's own, later loss
    expect(AskAnswers.reportDropped(TAB)).toBe(1);
    AskAnswers.ack(tokens[tokens.length - 1], { carrier: TURN });

    // A's 2 are still owed and still surface when A is finally declared gone.
    holder = "browser-tab-A";
    expect(AskAnswers.reportDropped(TAB)).toBe(2);
    expect(AskAnswers.hasOutstanding()).toBe(true);
    AskAnswers.setIncarnationResolver(() => OCCUPANT);
  });

  // Gate: the immediate-takeover boundary only fires while the old connection is
  // still in the map. If A DISCONNECTS FIRST and B arrives afterwards under the
  // same recurring key, there is no `existing` to compare — so the boundary never
  // fires and A's entries stayed matched and recoverable under the shared key.
  // The occupant is therefore carried on the ENTRY and checked at the point of
  // use, which needs no memory of who left.
  it("a new occupant cannot recover the previous one's answer, even with no takeover event", () => {
    let holder: string | undefined = "browser-tab-A";
    AskAnswers.setIncarnationResolver(() => holder);

    // A asks, times out, and its answer lands with nobody to receive it.
    AskAnswers.openAsk("pa-a", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-a");
    const entry = AskAnswers.record("pa-a", "dpmpp_2m", { tabId: TAB });
    expect(entry.incarnation).toBe("browser-tab-A");
    expect(AskAnswers.recover(TAB, askFingerprint(SAMPLER)).status).toBe("recovered");

    // A disconnects; LATER a different browser tab opens the same workflow. No
    // takeover event fires — there was no live connection to supersede.
    holder = "browser-tab-B";
    const rec = AskAnswers.recover(TAB, askFingerprint(SAMPLER));
    expect(rec.status).toBe("unattributed"); // …and B gets nothing of A's
    if (rec.status !== "unattributed") return;
    // Still reported, quoted with its own question — held, never swallowed.
    // WITHHELD, not shown: its content belongs to a conversation/tab that is no
    // longer here, and rendering the chosen option into this conversation's
    // result is the leak the boundary exists to stop. The COUNT is the
    // disclosure; the text stays journaled and in the durable log.
    expect(rec.withheld).toBeGreaterThan(0);
    expect(rec.others.some((e) => e.answer === "dpmpp_2m")).toBe(false);
    expect(AskAnswers.entriesFor(TAB).some((e) => e.answer === "dpmpp_2m")).toBe(true);
    // …and never announced into B's conversation either.
    expect(AskAnswers.pending(TAB)).toHaveLength(0);

    // A comes back: its own answer is its own again.
    holder = "browser-tab-A";
    expect(AskAnswers.recover(TAB, askFingerprint(SAMPLER)).status).toBe("recovered");
    expect(AskAnswers.pending(TAB)).toHaveLength(1);
    AskAnswers.setIncarnationResolver(() => OCCUPANT);
  });

  it("an answer of UNKNOWN provenance never satisfies a known occupant", () => {
    // Nothing could say who was holding the tab when this landed. "We could not
    // tell whose this is" must not resolve to "it is yours" — the honest reading
    // is unattributed, reported, and never handed over.
    let holder: string | undefined = undefined;
    AskAnswers.setIncarnationResolver(() => holder);
    AskAnswers.openAsk("pa-unknown", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-unknown");
    const entry = AskAnswers.record("pa-unknown", "dpmpp_2m", { tabId: TAB });
    expect(entry.incarnation).toBeUndefined();

    holder = "browser-tab-C";
    const rec = AskAnswers.recover(TAB, askFingerprint(SAMPLER));
    expect(rec.status).toBe("unattributed");
    if (rec.status !== "unattributed") return;
    // WITHHELD, not shown: its content belongs to a conversation/tab that is no
    // longer here, and rendering the chosen option into this conversation's
    // result is the leak the boundary exists to stop. The COUNT is the
    // disclosure; the text stays journaled and in the durable log.
    expect(rec.withheld).toBeGreaterThan(0);
    expect(rec.others.some((e) => e.answer === "dpmpp_2m")).toBe(false);
    expect(AskAnswers.entriesFor(TAB).some((e) => e.answer === "dpmpp_2m")).toBe(true);
    expect(AskAnswers.pending(TAB)).toHaveLength(0);
    AskAnswers.setIncarnationResolver(() => OCCUPANT);
  });

  // Coordinator gate P0: the debt BUCKET was keyed by incarnation but the code
  // WRITING into it still derived an owner from the tab key. So an eviction of
  // A's entry after B took the key filed A's loss under B — B was pushed
  // `dropped_answers`, B's ack cleared it, and A's own lifecycle callback (which
  // retires A's bucket) found nothing left to disclose.
  // Coordinator gate P0: the debt BUCKET was keyed by incarnation but the code
  // WRITING into it still derived an owner from the tab key. So an eviction of
  // A's entry after B took the key filed A's loss under B — B was pushed
  // `dropped_answers`, B's ack cleared it, and A's own lifecycle callback (which
  // retires A's bucket) found nothing left to disclose.
  // Coordinator gate P0: the debt BUCKET was keyed by incarnation but the code
  // WRITING into it still derived an owner from the tab key — so an eviction of
  // A's entry after B took the key filed A's loss under B. B was pushed
  // `dropped_answers`, B's ack cleared it, and A's own lifecycle callback (which
  // retires A's bucket) found nothing left to disclose.
  //
  // The arrangement matters: A's surviving entries are all HANDED OFF, so the
  // only `pending` entry on the key is B's. That is what makes a writer that
  // picks "any pending entry on this key" reach for B's, and a writer that files
  // into "whoever holds the key now" reach for B's bucket.
  it("A's eviction after B takes the key lands on A, not on the newcomer", () => {
    let holder: string | undefined = "browser-tab-A";
    AskAnswers.setIncarnationResolver(() => holder);

    // A fills its tab to the ceiling, then everything of A's is handed off.
    for (let i = 0; i < 48; i += 1) {
      openAndAnswer(`pa-a-${i}`, { question: `A${i}?`, options: [{ label: "x" }, { label: "y" }] }, `A${i}`);
    }
    AskAnswers.deliverPending(TAB, () => true);
    expect(AskAnswers.pending(TAB)).toHaveLength(0);
    expect(AskAnswers.droppedFor(TAB)).toBe(0); // nothing evicted yet

    // A different browser tab takes the recurring key over and asks. Its answer
    // is the ONLY pending entry — and recording it pushes the tab over the
    // ceiling, evicting one of A's.
    holder = "browser-tab-B";
    openAndAnswer("pa-b-1", SCHEDULER, "karras");
    const bEntry = AskAnswers.entriesFor(TAB).find((e) => e.incarnation === "browser-tab-B");
    expect(bEntry).toBeDefined();

    // A's loss was NOT stamped onto B's entry…
    expect(bEntry!.disclose ?? 0).toBe(0);
    // …and B's delivery does not carry it.
    const toB: AskAnswerEvent[] = [];
    AskAnswers.deliverPending(TAB, (payload) => {
      toB.push(payload);
      return true;
    });
    expect(toB).toHaveLength(1);
    expect(toB[0].ask_answer).toBe("karras");
    expect(toB[0].dropped_answers).toBeUndefined();
    // …nor is B owed anything it could report or settle.
    expect(AskAnswers.reportDropped(TAB)).toBe(0);

    // A is owed it, and only A.
    holder = "browser-tab-A";
    expect(AskAnswers.reportDropped(TAB)).toBeGreaterThan(0);
    expect(AskAnswers.hasOutstanding()).toBe(true);
    AskAnswers.setIncarnationResolver(() => OCCUPANT);
  });

  // …and the lifecycle half: a bare counter owed to A survives B entirely, and
  // only A's own departure retires it.
  it("a bare counter owed to A is invisible to B and retired by A's own callback", () => {
    let holder: string | undefined = "browser-tab-A";
    AskAnswers.setIncarnationResolver(() => holder);
    const tokens: string[] = [];
    AskAnswers.setTurnAttacher((_key, token) => {
      tokens.push(token);
      return TURN;
    });

    // The loss is A's, but it is RECORDED WHILE B HOLDS THE KEY — which is the
    // real shape (an eviction of A's entry after the takeover). A writer that
    // files into "whoever holds the key now" would put it in B's bucket here.
    holder = "browser-tab-B";
    AskAnswers.noteDroppedForTest(TAB, 4, "browser-tab-A");
    expect(AskAnswers.droppedFor(TAB)).toBe(4); // the TAB is owed it, either way

    // …but B is owed nothing and can settle nothing.
    expect(AskAnswers.reportDropped(TAB)).toBe(0);
    expect(tokens).toHaveLength(0); // no warning minted, so nothing for B to ack

    // A is still owed it, is told, and only A's own retirement clears it.
    holder = "browser-tab-A";
    expect(AskAnswers.reportDropped(TAB)).toBe(4);
    expect(AskAnswers.hasOutstanding()).toBe(true);
    AskAnswers.retireDebt(TAB, "browser-tab-B"); // B's departure settles nothing of A's
    expect(AskAnswers.reportDropped(TAB)).toBe(4);
    AskAnswers.retireDebt(TAB, "browser-tab-A");
    expect(AskAnswers.droppedFor(TAB)).toBe(0);
    AskAnswers.setIncarnationResolver(() => OCCUPANT);
  });

  it("retiring one incarnation's debt leaves the other's alone", () => {
    let holder: string | undefined = "browser-tab-A";
    AskAnswers.setIncarnationResolver(() => holder);
    AskAnswers.noteDroppedForTest(TAB, 2);
    holder = "browser-tab-B";
    AskAnswers.noteDroppedForTest(TAB, 5);
    expect(AskAnswers.droppedFor(TAB)).toBe(7); // the tab is owed both

    AskAnswers.retireDebt(TAB, "browser-tab-A"); // A's departure is disclosed
    expect(AskAnswers.droppedFor(TAB)).toBe(5); // B's survives, untouched
    expect(AskAnswers.reportDropped(TAB)).toBe(5);
    AskAnswers.setIncarnationResolver(() => OCCUPANT);
  });

  // ── The SECOND boundary: cross-CONVERSATION on the SAME tab ───────────────
  //
  // New chat, rewind and a provider switch all keep the same tab id AND the same
  // browser-tab incarnation, so `(tabId, incarnation)` cannot fence them at all.
  // Every path that can hand an answer or a disclosure to a live turn has to
  // consult the boundary mark instead — recovery, replay, push, and the debt
  // report. Gating them one at a time is how three separate bypasses arrived.

  // P0-1: a turn was already carrying the answer when the boundary happened. Its
  // release re-armed the entry to `pending`, and the push path never consulted
  // the mark — so the OLD conversation's answer was pushed into the replacement,
  // which could then ack it (pushed entries carry no carrier binding).
  it("a boundary-retired answer is never re-armed for the replacement conversation", () => {
    openAndAnswer("pa-carry", SAMPLER, "dpmpp_2m");
    const token = AskAnswers.entriesFor(TAB)[0].token;
    AskAnswers.deliverPending(TAB, () => true); // a turn is carrying it
    expect(AskAnswers.entriesFor(TAB)[0].delivery).toBe("handed_off");

    AskAnswers.closeAsks(TAB); // New chat / rewind / provider switch
    // The carrying turn ends without proving it was read — the ordinary release.
    AskAnswers.release(token, { carried: false });

    expect(AskAnswers.entriesFor(TAB)[0].delivery).toBe("none");
    expect(AskAnswers.pending(TAB)).toHaveLength(0);
    expect(AskAnswers.hasOutstanding()).toBe(false);
    // Nothing was swallowed — but nothing is SHOWN to the replacement either.
    // The count is the disclosure; the text stays journaled and in the log.
    const rec = AskAnswers.recover(TAB, askFingerprint(SAMPLER));
    expect(rec.status).toBe("unattributed");
    if (rec.status !== "unattributed") return;
    expect(rec.withheld).toBeGreaterThan(0);
    expect(rec.others.some((e) => e.answer === "dpmpp_2m")).toBe(false);
    expect(AskAnswers.entriesFor(TAB).some((e) => e.answer === "dpmpp_2m")).toBe(true);
    expect(AskAnswers.allOutstanding().map((e) => e.answer)).toContain("dpmpp_2m");
  });

  it("a retired answer cannot be delivered even if something re-arms it directly", () => {
    openAndAnswer("pa-force", SAMPLER, "dpmpp_2m");
    AskAnswers.closeAsks(TAB);
    // Belt and braces: the push path itself refuses, not merely the re-arm.
    AskAnswers.entriesFor(TAB)[0].delivery = "pending";
    expect(AskAnswers.pending(TAB)).toHaveLength(0);
    const seen: AskAnswerEvent[] = [];
    AskAnswers.deliverPending(TAB, (payload) => {
      seen.push(payload);
      return true;
    });
    expect(seen).toEqual([]);
  });

  // P0-2: the eviction DEBT survived a conversation boundary untouched, so the
  // replacement conversation's next ask reported the old conversation's warning
  // as its own and settled it with its own ack.
  it("a conversation boundary retires the debt — reported, then cleared", () => {
    const tokens: string[] = [];
    AskAnswers.setTurnAttacher((_key, token) => {
      tokens.push(token);
      return TURN;
    });
    AskAnswers.noteDroppedForTest(TAB, 5);
    expect(AskAnswers.droppedFor(TAB)).toBe(5);

    AskAnswers.closeAsks(TAB); // New chat on the SAME tab, SAME incarnation

    // The replacement conversation is owed nothing and can settle nothing.
    expect(AskAnswers.reportDropped(TAB)).toBe(0);
    expect(tokens).toHaveLength(0);
    expect(AskAnswers.droppedFor(TAB)).toBe(0);
    expect(AskAnswers.outstandingDebt()).toHaveLength(0);
    expect(AskAnswers.hasOutstanding()).toBe(false);
  });

  it("a boundary also clears debt riding on an entry, so it is not stranded", () => {
    // Fill past the ceiling so an eviction stamps its loss onto a surviving entry.
    for (let i = 0; i < 60; i += 1) {
      openAndAnswer(`pa-e-${i}`, { question: `E${i}?`, options: [{ label: "x" }, { label: "y" }] }, `E${i}`);
    }
    const owed = AskAnswers.droppedFor(TAB);
    expect(owed).toBeGreaterThan(0);
    const carrier = AskAnswers.entriesFor(TAB).find((e) => (e.disclose ?? 0) > 0);
    expect(carrier).toBeDefined();
    const carried = carrier!.disclose!;

    const errors: string[] = [];
    const spy = vi.spyOn(logger, "error").mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
    AskAnswers.closeAsks(TAB);
    spy.mockRestore();

    // Those entries are no longer pushed, so a disclosure left riding one would
    // be stranded on text nobody will read. It is SURFACED with the rest — a
    // retirement that merely cleared it would trade a misattribution for a
    // silent loss — and only then cleared.
    const surfaced = errors.find((m) => m.includes("its conversation was replaced"));
    expect(surfaced, "the retirement must report what was owed").toBeDefined();
    expect(surfaced).toContain(`${owed} validated answer(s)`);
    expect(carried).toBeGreaterThan(0);
    expect(carrier!.disclose ?? 0).toBe(0);
    expect(AskAnswers.droppedFor(TAB)).toBe(0);
    expect(AskAnswers.reportDropped(TAB)).toBe(0);
  });

  // Gate P0-4: the retirement must REPORT before it CLEARS. An earlier draft
  // cleared each carrier as it totalled them, so a logger that throws took the
  // only consolidated copy of the debt with it — fixing a misattribution by
  // creating a silent loss, which is the trade this PR refuses everywhere.
  it("a retirement whose report THROWS keeps the debt whole", () => {
    for (let i = 0; i < 60; i += 1) {
      openAndAnswer(`pa-t-${i}`, { question: `T${i}?`, options: [{ label: "x" }, { label: "y" }] }, `T${i}`);
    }
    const owed = AskAnswers.droppedFor(TAB);
    expect(owed).toBeGreaterThan(0);

    const boom = vi.spyOn(logger, "error").mockImplementation(() => {
      throw new Error("log sink is down");
    });
    expect(() => AskAnswers.closeAsks(TAB)).toThrow(/log sink is down/);
    boom.mockRestore();

    // NOTHING after the report ran, so the debt is still whole and still owed.
    expect(AskAnswers.droppedFor(TAB)).toBe(owed);

    // …and a later retirement, with a working sink, surfaces all of it.
    const errors: string[] = [];
    const spy = vi.spyOn(logger, "error").mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
    AskAnswers.closeAsks(TAB);
    spy.mockRestore();
    expect(errors.some((m) => m.includes(`${owed} validated answer(s)`))).toBe(true);
    expect(AskAnswers.droppedFor(TAB)).toBe(0);
  });

  // P1: the two flags disagreed. The hand-back permits an AMBIGUOUS answer
  // (checking only `retired`), while the carrier attach refused one (checking
  // `recoverable`) — so a delivered answer could never be acked and surfaced
  // later as an unconfirmed loss that had not happened.
  it("an AMBIGUOUS answer is still ackable by the turn that carried it", () => {
    AskAnswers.openAsk("pa-amb", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-amb");
    const first = AskAnswers.record("pa-amb", "euler", { tabId: TAB });
    // A second, different answer under the same id makes both ambiguous.
    const second = AskAnswers.record("pa-amb", "dpmpp_2m", { tabId: TAB });
    expect(second.recoverable).toBe(false);
    expect(second.retired).toBeUndefined();

    AskAnswers.markReturned(second.token);
    // Ambiguity is about WHICH QUESTION, not which conversation — so the turn
    // that carried it can still prove receipt.
    expect(second.carrier).toBe(TURN);
    AskAnswers.ack(second.token, { carrier: TURN });
    expect(second.acked).toBe(true);
    // …and it stops being reported as an unconfirmed loss.
    expect(AskAnswers.allOutstanding().some((e) => e.token === second.token)).toBe(false);
    void first;
  });

  // A RETIRED answer, by contrast, gets no carrier at all: no live turn may
  // receive it, so nothing may certify it either.
  it("a RETIRED answer gets no carrier and can never be acked", () => {
    AskAnswers.openAsk("pa-ret", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    AskAnswers.closeAsk("pa-ret");
    const entry = AskAnswers.record("pa-ret", "dpmpp_2m", { tabId: TAB });
    AskAnswers.closeAsks(TAB);
    AskAnswers.markReturned(entry.token);
    expect(entry.carrier).toBeNull();
    AskAnswers.ack(entry.token, { carrier: TURN });
    expect(entry.acked).toBeUndefined();
  });

  it("a retired answer may be counted but never quoted to the tab's current holder", () => {
    openAndAnswer("pa-exit", SAMPLER, "dpmpp_2m");
    const entry = AskAnswers.entriesFor(TAB)[0];
    expect(AskAnswers.mayDisclose(entry)).toBe(true); // its own conversation may see it

    AskAnswers.closeAsks(TAB);
    // Still named by the exit path (it IS a loss) but no longer showable to
    // whoever holds the tab now — the count crosses the boundary, the text does
    // not, and the durable log keeps the text.
    expect(AskAnswers.allOutstanding().some((e) => e.answer === "dpmpp_2m")).toBe(true);
    expect(AskAnswers.mayDisclose(entry)).toBe(false);
  });

  // Gate P0: the ordering fix in surfaceAndClearDebt (count -> report -> clear)
  // put a FALLIBLE step ahead of the PROTECTIVE one in its caller. A logger that
  // throws aborted closeAsks with the fence half-built — and the caller has
  // ALREADY reset the old agent by then, so it does not stop; the replacement
  // agent's ready-flush pushes the still-unretired answer.
  //
  // The test models the CONTINUATION, not a retry: throw, swallow it exactly as
  // a caller mid-teardown would, and then do what the caller does next.
  it("a throwing report cannot leave the boundary half-built", () => {
    openAndAnswer("pa-halfbuilt", SAMPLER, "dpmpp_2m");
    // Give the tab an eviction debt too, so the report has something to say and
    // therefore something to throw on.
    AskAnswers.noteDroppedForTest(TAB, 2);
    expect(AskAnswers.pending(TAB)).toHaveLength(1);

    const boom = vi.spyOn(logger, "error").mockImplementation(() => {
      throw new Error("log sink is down");
    });
    // The boundary happens; its report fails.
    expect(() => AskAnswers.closeAsks(TAB)).toThrow(/log sink is down/);
    boom.mockRestore();

    // THE CALLER CONTINUES — the old agent is already gone and a replacement
    // spawns, which flushes on ready. Nothing of the old conversation may go out.
    const pushed: AskAnswerEvent[] = [];
    AskAnswers.deliverPending(TAB, (payload) => {
      pushed.push(payload);
      return true;
    });
    expect(pushed).toEqual([]);
    expect(AskAnswers.pending(TAB)).toHaveLength(0);

    // …and an identical re-ask cannot recover it either.
    const rec = AskAnswers.recover(TAB, askFingerprint(SAMPLER));
    expect(rec.status).toBe("unattributed");
    if (rec.status !== "unattributed") return;
    expect(rec.others.some((e) => e.answer === "dpmpp_2m")).toBe(false);
    expect(rec.withheld).toBeGreaterThan(0);

    // The fence is complete; only the DEBT report is still owed, because the step
    // that destroys it never ran.
    expect(AskAnswers.entriesFor(TAB)[0].retired).toBe(true);
    expect(AskAnswers.droppedFor(TAB)).toBe(2);
  });

  // Gate P0: A CATCH BLOCK THAT CAN THROW IS NOT A GUARD.
  //
  // Pass 2 wraps `revoke()` so a throwing revoker cannot abort the boundary — but
  // the logger.warn that REPORTS that failure was itself unguarded, so a throwing
  // revoker plus a throwing warn sink handed the abort straight back: closeAsks
  // exited inside the first entry's catch, skipping every remaining recall AND
  // pass 3 (surfaceAndClearDebt). Both halves of the debt then survived on a
  // retired conversation —
  //   • the side-map half for a SAME-INCARNATION replacement (New chat does not
  //     change the incarnation) to read via reportDropped() and settle with its
  //     own ack, i.e. the departed conversation's warning misattributed and then
  //     silenced;
  //   • the entry-carried half stamped on an entry that is now retired and
  //     therefore permanently undeliverable, which hasOutstanding() still counts
  //     as owed — a self-restart gate stuck shut forever.
  //
  // So this drives BOTH throwing sinks at once and asserts the pass actually ran:
  // both queued tokens reached the revoker, and the destroy-step after it did too.
  it("a throwing recall — even with a throwing warn sink — cannot leave the boundary half-built", () => {
    openAndAnswer("pa-recall", SAMPLER, "dpmpp_2m");
    openAndAnswer("pa-recall-2", SCHEDULER, "karras");
    // Captured BEFORE the hand-off: these two are exactly what pass 2 must pull
    // back, and naming them is what makes deleting the recall loop fail.
    const queuedTokens = AskAnswers.entriesFor(TAB).map((e) => e.token);
    expect(queuedTokens).toHaveLength(2);
    AskAnswers.deliverPending(TAB, () => true); // both queued into a turn

    // Debt in BOTH places, so pass 3 has both halves to destroy: the side map
    // (no pending entry to stamp right now) …
    AskAnswers.noteDroppedForTest(TAB, 2);
    // … and stamped onto a surviving PENDING entry (the half that jams the gate).
    openAndAnswer("pa-recall-3", THIRD_Q, "yes");
    AskAnswers.noteDroppedForTest(TAB, 3);
    expect(AskAnswers.droppedFor(TAB)).toBe(5);

    const recalls: Array<[string, string]> = [];
    AskAnswers.setRevoker((key, token) => {
      recalls.push([key, token]);
      throw new Error("agent is gone");
    });
    // The failure REPORT is fallible too — that is the whole finding.
    const deadWarn = vi.spyOn(logger, "warn").mockImplementation(() => {
      throw new Error("log sink is down");
    });
    const surfaced: string[] = [];
    const surfacer = vi.spyOn(logger, "error").mockImplementation((msg: string) => {
      surfaced.push(msg);
    });

    // Everything after the fence is fallible, and none of it may escape.
    //
    // Restored in a `finally`, NOT after the assertion: the mutant this test
    // exists to catch (unguarding the catch-block warn) is exactly the case
    // where closeAsks throws — so restoring afterwards would leave a logger that
    // throws installed for every later test in the file, and the mutation run
    // would report a cascade instead of this one honest failure.
    let threw = false;
    let escaped: unknown;
    try {
      AskAnswers.closeAsks(TAB);
    } catch (err) {
      threw = true;
      escaped = err;
    } finally {
      deadWarn.mockRestore();
      surfacer.mockRestore();
    }
    // `threw` is what DECIDES — a thrown `undefined` is still a throw, and
    // testing the captured value alone would call that an escape-free run.
    // `escaped` rides along only so a failure prints what got out.
    expect({ threw, escaped }).toEqual({ threw: false, escaped: undefined });

    // PASS 2 RAN TO THE END: both queued copies were actually offered back, not
    // just the first. A throw out of entry 1's catch would leave entry 2 queued on
    // an agent whose conversation is gone.
    expect(recalls).toEqual([
      [TAB, queuedTokens[0]],
      [TAB, queuedTokens[1]],
    ]);

    // PASS 3 RAN AT ALL, and said WHY and HOW MUCH before destroying it — the
    // reason, not just the state.
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]).toMatch(/its conversation was replaced/);
    expect(surfaced[0]).toMatch(/5 validated answer/);
    expect(AskAnswers.droppedFor(TAB)).toBe(0);
    // …so the replacement conversation cannot be handed the departed one's
    // warning as its own…
    expect(AskAnswers.reportDropped(TAB)).toBe(0);
    // …and no retired, undeliverable entry is left holding the restart gate.
    expect(AskAnswers.hasOutstanding()).toBe(false);

    // PASS 1's fence is intact throughout.
    expect(AskAnswers.entriesFor(TAB).every((e) => e.retired === true)).toBe(true);
    expect(AskAnswers.pending(TAB)).toHaveLength(0);
    expect(AskAnswers.recover(TAB, askFingerprint(SAMPLER)).status).toBe("unattributed");
    AskAnswers.setRevoker(() => false);
  });

  // Gate P1: `closeAsk` (the ask handler's own unwind) re-armed a RETIRED entry
  // to `pending`. `pending()` rightly refused to deliver it, but
  // `hasOutstanding()` counted it as owed — so the self-restart gate stayed shut
  // forever, cleared only by an unrelated boundary or eviction.
  it("a retired answer never becomes a permanent blocker on the restart gate", () => {
    AskAnswers.openAsk("pa-block", {
      tabId: TAB,
      fingerprint: askFingerprint(SAMPLER),
      question: SAMPLER.question,
    });
    // The boundary lands while the ask is still waiting…
    AskAnswers.closeAsks(TAB);
    // …the old card is then answered…
    AskAnswers.record("pa-block", "dpmpp_2m", { tabId: TAB });
    // …and the handler's `finally` unwinds.
    AskAnswers.closeAsk("pa-block");

    // The unwind must not ARM it in the first place…
    expect(AskAnswers.entriesFor(TAB)[0].delivery).toBe("none");
    expect(AskAnswers.pending(TAB)).toHaveLength(0);
    expect(AskAnswers.hasOutstanding()).toBe(false);

    // …and INDEPENDENTLY, an entry that somehow is armed must still not count as
    // owed. Two separate guards, because they answer different questions: one
    // stops the arming, the other stops an undeliverable entry holding the gate.
    AskAnswers.entriesFor(TAB)[0].delivery = "pending";
    expect(AskAnswers.pending(TAB)).toHaveLength(0);
    expect(AskAnswers.hasOutstanding()).toBe(false);
    // Still journaled and still named on the way out — fenced, not swallowed.
    expect(AskAnswers.entriesFor(TAB).some((e) => e.answer === "dpmpp_2m")).toBe(true);
    expect(AskAnswers.allOutstanding().some((e) => e.answer === "dpmpp_2m")).toBe(true);
  });

  it("a temporarily undeliverable answer DOES still hold the gate", () => {
    // A different browser tab holding the key is TEMPORARY — the answer becomes
    // deliverable again when its own tab returns — so tearing down while one is
    // waiting would be a real loss. Only retirement is permanent.
    let holder: string | undefined = "browser-tab-A";
    AskAnswers.setIncarnationResolver(() => holder);
    openAndAnswer("pa-wait", SAMPLER, "dpmpp_2m");
    holder = "browser-tab-B";
    expect(AskAnswers.pending(TAB)).toHaveLength(0); // not deliverable to B…
    expect(AskAnswers.hasOutstanding()).toBe(true); // …but still owed to A
    AskAnswers.setIncarnationResolver(() => OCCUPANT);
  });

  it("never throws when the flusher does", () => {
    AskAnswers.setFlusher(() => {
      throw new Error("no agent");
    });
    expect(() => openAndAnswer("pa-ask-1", SAMPLER, "dpmpp_2m")).toThrow();
    // The entry is journaled regardless — the throw happens after the record.
    expect(AskAnswers.entriesFor(TAB)).toHaveLength(1);
    vi.restoreAllMocks();
  });
});
