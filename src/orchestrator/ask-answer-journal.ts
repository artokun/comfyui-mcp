// Durable-across-a-tool-timeout delivery of a VALIDATED panel_ask answer
// (issue #486).
//
// THE FAILURE. `panel_ask` renders a choice card and BLOCKS on the user's pick.
// The user's answer has exactly one delivery channel: the return value of the
// enclosing MCP `tools/call`. That call has its own budget (~300s) and its own
// lifetime — a turn that ends, a client that gives up, a session torn down — and
// when it dies the answer dies with it, in three distinct ways:
//
//   1. ANSWERED IN TIME, NOBODY LEFT TO RETURN TO. `bridge.send` resolves with a
//      validated pick, `askUserWithGrace` returns it, and the ToolResult is
//      written to a request the client already abandoned. Nothing recorded it.
//   2. ANSWERED DURING THE GRACE POLL. Same, one layer down: the poll TAKES the
//      answer out of the bridge's late-reply buffer (destroying it there) and
//      returns it into the same dead request.
//   3. ANSWERED AFTER THE GRACE. The handler has already returned "not answered
//      in time". The answer lands in the bridge's late-reply buffer keyed by
//      `ask_id` and NOBODY EVER POLLS IT AGAIN — it is TTL-pruned five minutes
//      later, unread.
//
// In every case the user answered, the answer validated, and the agent either
// asked again or proceeded without it. That is the whole of #486.
//
// THE CONTRACT HERE — deliberately the one #468/PR #786 arrived at for run
// completions (see run-completion-journal.ts), because this is the same problem
// class and the same traps are waiting:
//
//  • Asks are TICKETED by their `ask_id`, opened when the card is dispatched.
//  • Every answer is CORRELATED ONCE, AT ARRIVAL, by EXACT ask-id equality
//    against an open ticket — never by recency, never re-derived later. The
//    ticket's QUESTION FINGERPRINT is frozen onto the entry at that moment.
//  • An answer that cannot be correlated is still journaled and still delivered,
//    labelled UNDETERMINED. It is never swallowed, and it can never be presented
//    as the answer to a question it isn't provably an answer to.
//  • THE JOURNAL NEVER MERGES AND NEVER SUPPRESSES — IT ONLY EVER LABELS. Every
//    "already delivered" proof available here (tickets, entries, the bridge's own
//    5-minute buffer) is BOUNDED, so any rule that SUPPRESSES on one becomes a
//    silent LOSS the moment it expires at the wrong time. #468 removed
//    suppression outright after five successive fixes were each defeated one
//    bound away; nothing here reintroduces it.
//  • Undelivered answers are REPLAYED at the next delivery opportunity, and an
//    entry is cleared only when the turn that CARRIED it ended (or when a
//    matching re-ask provably took it as its result).
//
// THE CROSS-QUESTION GUARD is the one rule this file adds over #468's, and it is
// strictly the more important direction. Losing an answer costs a re-ask;
// MISATTRIBUTING one makes the agent act on a decision the user never made about
// the thing at hand. So a recovered answer may only ever satisfy an ask whose
// QUESTION FINGERPRINT (question text + option labels, in order + multi-select +
// header) is EXACTLY equal to the fingerprint frozen on the entry at arrival, on
// the SAME panel tab. There is deliberately no fuzzy match, no "closest
// question", and no "the only outstanding ask" fallback: an answer that doesn't
// match exactly is reported as an unattributed answer to ITS OWN question —
// quoted with that question, so it cannot be read as an answer to anything else.
//
// WHAT IS DELIBERATELY NOT GUARANTEED. Three residuals survived four rounds of
// adversarial review; each is an ACCEPTED trade with its reasoning, not an
// oversight, and each is stated where it lives as well as here.
//
//  1. A RETURNED ANSWER EVICTED BY THE PER-TAB CEILING IS LOGGED, NOT COUNTED as
//     an undetermined loss (see trimEntries). It reached a caller; what its
//     eviction costs is the ability to RECOVER it. Counting each one would fire
//     after ~48 ordinary successful asks and tell the agent that answers it
//     almost certainly received are unknown — and a warning that is usually
//     false is its own kind of silence.
//  2. A RESTART IS NOT DEFERRED FOR A RETURNED ANSWER (see hasOutstanding vs.
//     allOutstanding). Deferring on one would stall the self-restarter for the
//     whole recovery window after EVERY ask. The fatal-exit disclosure names it
//     instead: saying so on the way out costs nothing.
//  3. A CARD ANSWERED BEYOND THE BRIDGE'S OPEN-CARD CEILING cannot be recognised
//     at all (UiBridge.MAX_ASK_RID_MAPPINGS). Reaching it needs 1024 unanswered
//     cards outstanding at once; it is logged at ERROR, and reporting it as a
//     "dropped answer" would be a lie about questions nobody answered.
//
// LOCAL trust domain: this is accidental-loss bookkeeping, not a defence against
// a hostile panel. Everything is in-memory and process-scoped.

import { createHash } from "node:crypto";
import { logger } from "../utils/logger.js";
import { tabIncarnationSlot } from "../services/ui-bridge.js";

/** How an answer relates to the asks this session dispatched. Computed ONCE, at
 *  arrival, and frozen onto the journal entry — a replay never re-correlates, so
 *  an answer can never drift onto a question that was asked after it landed. */
export type AskCorrelation =
  /** Exact ask-id match with a card THIS session dispatched. The entry also
   *  carries that ticket's frozen question fingerprint. */
  | { status: "matched"; askId: string }
  /** A validated answer whose ask id belongs to no card this session has a
   *  ticket for (its ticket aged out, or it came from somewhere else). Real, but
   *  NOT provably an answer to any question we asked — it must never satisfy
   *  one. */
  | { status: "foreign"; askId: string };

/** A `panel_ask` card that was dispatched and may still be answered. */
export interface AskTicket {
  askId: string;
  /** Panel tab the card was rendered on. Part of every match: an answer given on
   *  one tab is not an answer for another tab's agent. */
  tabId: string;
  /** Exact identity of the QUESTION — see askFingerprint(). */
  fingerprint: string;
  /** The question text, for honest wording when this answer is reported. */
  question: string;
  openedAt: number;
  /**
   * Generation of THIS ticket. Bumped whenever the same ask id is opened again,
   * so an answer can only ever settle the exact generation it was correlated
   * against (ask ids are UUIDs so this is defence in depth, mirroring
   * RunTicket.seq).
   */
  seq: number;
  /**
   * The `panel_ask` handler that opened this ticket is STILL RUNNING and will
   * itself consume the answer if one arrives. False once it has returned — which
   * is what makes an answer arriving afterwards provably ORPHANED (nobody is
   * left to hand it to) and therefore worth pushing to the agent on its own.
   */
  awaiting: boolean;
  /**
   * Which CONVERSATION on this tab asked the question.
   *
   * Bumped on the tab (never on the ticket) by closeAsks(), so a card left on
   * screen across a New chat / a resume of a historical session is recognisable
   * as belonging to the conversation that is gone. An epoch per TAB, rather than
   * a remembered set of ask ids, because the set would be bounded — and a bound
   * that decides whether an answer may be announced to a different conversation
   * is a bound deciding a correctness question.
   */
  epoch: number;
  /**
   * This ask id was opened MORE THAN ONCE, so it no longer identifies a single
   * question.
   *
   * Nothing on the wire distinguishes the first card's reply from the second's —
   * the panel sends only the id — so once an id is reused, ANY answer for it is
   * genuinely unattributable. It is therefore correlated as `foreign`
   * (UNDETERMINED) rather than confidently matched: without this, the first
   * card's late click would be frozen with the SECOND question's fingerprint and
   * could then be recovered as the answer to a question it was never shown for.
   * (`panel_ask` mints a fresh UUID per card, so this is defence in depth — but
   * it is the difference between "unreachable" and "impossible".)
   */
  reused?: boolean;
}

/** Where an entry is in the PUSH pipeline (the durable agent-event delivery used
 *  for answers that were never handed back to any tool result). */
export type AskDeliveryState =
  /** Not queued for a push. Either the handler took it as its own tool result,
   *  or the handler is still running and may yet. */
  | "none"
  /** Orphaned: waiting for a delivery attempt to the tab's agent. */
  | "pending"
  /** Handed to a live agent's queue; NOT proven read. */
  | "handed_off";

export interface AskEntry {
  token: string;
  askId: string;
  /** Panel tab this answer belongs to; also the agent-delivery address. */
  key: string;
  /** The question identity frozen at ARRIVAL (null when unattributable). The
   *  ONLY thing a recovery is allowed to match on. */
  fingerprint: string | null;
  /** The question text as asked (null when unattributable). */
  question: string | null;
  /** The user's answer, verbatim. */
  answer: string;
  answeredAt: number;
  correlation: AskCorrelation;
  /** Generation of the ticket this entry was matched against (0 = none). */
  ticketSeq: number;
  /**
   * The ask handler put this answer into a ToolResult. A HAND-OFF, NOT A PROOF:
   * the enclosing `tools/call` may already have been abandoned, which is exactly
   * the bug. It only means we must not ALSO push it to the agent as an orphan
   * (that would double-report every ordinary ask); the entry stays journaled so
   * a re-ask of the identical question can still recover it.
   */
  returned: boolean;
  /**
   * PROVEN read by the agent — the turn that carried this answer produced its
   * own marked result (#468's ack-on-carry, ridden by a tool-result answer via
   * PanelAgent.attachTurnToken).
   *
   * `returned` and `acked` are deliberately two fields, because they answer two
   * different questions and conflating them is the bug this whole file exists to
   * kill. `returned` says only that the answer was written to a transport that
   * MAY have been abandoned — the premise of #486. `acked` says the model ran to
   * completion after receiving it. Only the second may license forgetting an
   * answer quietly.
   */
  acked?: boolean;
  /**
   * WHICH agent's turn is carrying this answer, captured at the instant it was
   * handed back and never re-resolved. `null` when there was no live turn to
   * ride (so nothing can ever ack it).
   *
   * The identity has to be frozen because the tab→agent mapping MOVES: a
   * provider switch retires the old agent and re-points the tab at a new one. An
   * ack that asked "who owns this tab now?" would let the new provider's turn
   * settle an answer that belonged to the old conversation — an answer the new
   * conversation never saw, marked proven-read and therefore silently evictable.
   */
  carrier?: string | null;
  delivery: AskDeliveryState;
  attempts: number;
  /** How many turns carried this answer and then ended without a provable ack. */
  carriedReleases?: number;
  /** Evicted-answer count this entry is carrying out on the tab's behalf, so the
   *  disclosure rides a real delivery instead of a side map that could be
   *  discarded before it is ever reported. */
  disclose?: number;
  /** This answer was already handed to the agent once (as a tool result or a
   *  push) and is being surfaced again. A LABEL, never a veto. */
  replayHint?: boolean;
  /**
   * This answer may be REPORTED but may never be RETURNED as the answer to a
   * question — the conversation that asked it is gone, or its ask id stopped
   * identifying one question.
   *
   * Separate from the fingerprint on purpose. An earlier draft revoked
   * recoverability by NULLING the fingerprint, which also erased the journal's
   * ability to notice "this is about the very question being re-asked" — so the
   * answer stopped being disclosed as well as stopping being returned, i.e.
   * revoking a permission silently revoked a promise.
   */
  recoverable?: boolean;
  /**
   * The CONVERSATION that asked this question is gone — New chat, a rewind, a
   * provider switch, an in-place workflow replacement, or another browser tab
   * taking the key over.
   *
   * Deliberately separate from `recoverable`, which also covers AMBIGUITY (an ask
   * id that stopped identifying one card). The two axes are independent and want
   * opposite treatment: an ambiguous answer is still PUSHED, labelled
   * UNDETERMINED, because nobody else can claim it; a retired one must not reach
   * a live turn at all, because the turn belongs to a conversation that never
   * asked. Folding them into one flag would either start swallowing ambiguous
   * answers or keep leaking retired ones.
   *
   * There are TWO orthogonal boundaries in this file and this is the second:
   * `(tabId, incarnation)` fences a different BROWSER TAB, and cannot fence this
   * one — New chat happens on the same tab, with the same incarnation.
   */
  retired?: boolean;
  /**
   * Which browser-tab INCARNATION this answer belongs to, captured at arrival.
   *
   * Entries are keyed by panel tab id, and that id recurs — `wf:` route names a
   * saved workflow, so a second browser tab can hold it. Re-keying every entry by
   * incarnation would break the thing tab-keying is FOR (a reload keeps its
   * answers), so the incarnation is carried alongside and checked at the point of
   * use instead: only the occupant this answer was given by may recover it or be
   * pushed it. Everyone else may still be TOLD about it — a disclosure quotes its
   * own question and cannot be misattributed.
   *
   * `undefined` when nothing could say who was holding the tab (no resolver
   * wired, or the tab was not connected). Unknown provenance never satisfies a
   * known occupant.
   */
  incarnation?: string;
  /**
   * This entry's ask id stands for MORE THAN ONE card.
   *
   * Stamped on the ENTRY, not read from the ticket, because tickets are
   * EVICTABLE: once the reused ticket is trimmed, `ticket?.reused !== true` goes
   * true again and the identical-answer collapse switches back on — silently
   * discarding the second card's validated answer before it ever has an entry.
   * The entry outlives the ticket, so the ambiguity must too. (Exactly the
   * reasoning behind JournalEntry.ambiguousId in #468's run journal.)
   */
  ambiguousId?: boolean;
}

/**
 * Cards tracked at once. A ticket is a handful of small fields, and it is what
 * makes an answer ATTRIBUTABLE, so this is sized for a whole session's asks
 * rather than for the two that are usually open. There is deliberately no age
 * limit: a question card sits on screen until the user deals with it, and any
 * clock here would be a bound quietly deciding that an answer no longer counts.
 * Overflowing is logged at ERROR and only ever WEAKENS a correlation to
 * UNDETERMINED — it never drops an answer.
 */
const MAX_TICKETS = 1024;
/**
 * Prefix every `panel_ask` card's ask id carries.
 *
 * The bridge's late-answer sink is fed by EVERY `ask_user` card — the confirm
 * gate, the 18+ consent card, the secret prompt — and only `panel_ask` answers
 * belong in this journal. Ownership therefore has to be decidable from the id
 * ITSELF: an earlier draft answered it from a bounded set of remembered ids,
 * which meant an eviction turned a validated answer into nothing. A bounded
 * store must never be what protects against loss, so the test is syntactic and
 * cannot expire, evict, or be raced.
 */
export const PANEL_ASK_ID_PREFIX = "pa-";
/** Undelivered/unconsumed answers held per panel tab. */
const MAX_ENTRIES_PER_KEY = 48;
/** …and across all tabs. */
const MAX_ENTRIES_TOTAL = 192;
/**
 * How long a journaled answer may still be RECOVERED as the result of a re-ask
 * of the identical question.
 *
 * This bound is a LABEL boundary, not a suppression: past it the answer is not
 * returned as "the user's answer to the question you just asked" (it is stale
 * enough that the user plausibly meant it for the earlier moment), but it is
 * still DISCLOSED, quoted with its own question, so it is never silently
 * discarded.
 */
const RECOVER_MAX_AGE_MS = 10 * 60_000;
/** Turns that may carry a pushed answer and end without a provable ack before we
 *  settle it anyway. Same rationale as MAX_CARRIED_RELEASES in #468: each of
 *  those put the text into a turn the agent read, so settling risks a duplicate,
 *  never a loss. */
const MAX_CARRIED_RELEASES = 3;

/**
 * EXACT identity of a question, and the whole of the cross-question guard.
 *
 * EVERYTHING THE USER READS ON THE CARD GOES IN, in order: the question text,
 * the header chip, the multi-select flag, and every option's LABEL **and
 * DESCRIPTION**. Two asks are "the same question" only when a user looking at
 * both cards would see the same thing.
 *
 * The descriptions are not decoration: they are the one-line explanations the
 * user reads to decide, so "euler / fast, lower quality" and "euler / now the
 * recommended default" are different decisions wearing the same label. Leaving
 * them out would let a re-worded card recover an answer the user gave to
 * different information. The guard errs strict in every direction: a stricter
 * fingerprint costs at most a re-ask, a looser one lets an answer satisfy a
 * question it was not given for.
 *
 * Deliberately NOT included: the tab id (an entry carries its tab separately, so
 * a tab-id migration re-keys it without invalidating every fingerprint) and any
 * timestamp.
 *
 * Whitespace is trimmed and internal runs collapsed on the text fields only,
 * because a re-ask is often the model re-emitting the same prompt with different
 * wrapping. Nothing else is normalized: case, punctuation and ordering are all
 * significant, so "Delete the file?" never matches "delete the file".
 */
export function askFingerprint(ask: {
  question: string;
  options?: unknown;
  header?: unknown;
  multi_select?: unknown;
}): string {
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
  const labels = Array.isArray(ask.options)
    ? ask.options.map((o) => {
        const opt = o as { label?: unknown; description?: unknown } | null;
        if (typeof opt?.label !== "string") return JSON.stringify(o ?? null);
        // Label AND description — an option is the whole thing the user reads.
        return JSON.stringify([
          norm(opt.label),
          typeof opt.description === "string" ? norm(opt.description) : "",
        ]);
      })
    : [];
  // JSON.stringify is the delimiter: it escapes the payload itself, so no
  // separator character can ever be smuggled in by a question or an option label
  // to make two DIFFERENT questions hash the same. (And it keeps this file pure
  // ASCII — no control bytes, no exotic separators.)
  const parts = [
    norm(ask.question ?? ""),
    typeof ask.header === "string" ? norm(ask.header) : "",
    ask.multi_select === true ? "multi" : "single",
    ...labels,
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

/** Coerce a bridge reply into the answer text the user actually gave. Panel
 *  ask cards reply with a string; anything else is preserved verbatim as JSON so
 *  nothing the user chose is ever silently reshaped away. */
export function answerText(reply: unknown): string {
  if (typeof reply === "string") return reply;
  try {
    return JSON.stringify(reply);
  } catch {
    return String(reply);
  }
}

/** Why a recovery attempt produced no answer. NEVER collapsed into a single
 *  falsy value: "this tab has no answer to this question" and "an answer existed
 *  but could not be attributed / had been evicted" are different facts and the
 *  caller reports them differently (#796). */
export type AskRecovery =
  /** An answer to the IDENTICAL question, on this tab, within the window. */
  | { status: "recovered"; entry: AskEntry }
  /** Nothing journaled for this tab at all — a plain unanswered card. */
  | { status: "none" }
  /**
   * Answers exist for this tab but NONE of them is provably an answer to THIS
   * question (a different question, or too old to present as fresh).
   *
   * `others` are the ones this conversation MAY be shown — same occupant, not
   * retired — quoted with their own question so they cannot be misread as an
   * answer to anything else.
   *
   * `withheld` counts the ones it may NOT: they belong to a different browser tab
   * on this recurring key, or to a conversation that has been replaced. Their
   * CONTENT is deliberately not returned — rendering a departed tab's chosen
   * option into this conversation's result is the disclosure leaking the very
   * thing the boundary exists to contain. The count still says something was
   * answered, which is what keeps this a disclosure rather than a silence; the
   * text itself is in the durable log.
   */
  | { status: "unattributed"; others: AskEntry[]; withheld: number };

export class AskAnswerJournalImpl {
  /** ask id → ticket. Ask ids are UUIDs, so exact equality is proof of identity. */
  private tickets = new Map<string, AskTicket>();
  /**
   * Ask ids this journal has EVER opened, kept long after their ticket is gone.
   *
   * This is what `tracks()` answers on, and it exists because the ticket map is
   * bounded: if "is this one of ours?" were answered from the tickets alone, an
   * eviction would make the bridge's late-answer sink DROP a validated answer
   * outright — a bounded store silently protecting against a bounded store,
   * which is the exact shape of every defect #468 kept re-growing. Losing a
   * ticket may only ever WEAKEN a correlation (matched → foreign, i.e.
   * UNDETERMINED); it must never turn an answer into nothing.
   */
  /** Panel tab -> the generation of the conversation currently attached to it.
   *  Bumped by closeAsks(); a ticket minted under an older generation belongs to
   *  a conversation that is gone. See AskTicket.epoch. */
  private tabEpoch = new Map<string, number>();
  /** token → entry (insertion-ordered, which is also delivery order). */
  private entries = new Map<string, AskEntry>();
  /** Answers this tab lost to an eviction and has not yet been told about. */
  private dropped = new Map<string, number>();
  /** How many tool results have already carried each tab's eviction debt. The
   *  debt is spent by a COUNT of reports, never by a single hand-off — see
   *  reportDropped(). */
  /** Outstanding eviction-disclosure tokens: token -> panel tab. Retired only
   *  by the ack of the turn that carried the warning (see reportDropped). */
  private debtTokens = new Map<string, { key: string; carrier: string | null; upTo: number }>();
  /**
   * Per tab: the eviction total that has already been SURFACED and confirmed.
   *
   * A warning names a number, and only that number is settled when the turn
   * carrying it ends. Without this the ack cleared the tab's whole current debt,
   * so an eviction that happened AFTER the warning was rendered — while its turn
   * was still running — was wiped by an ack that never mentioned it. A watermark
   * also makes the ack idempotent: two results reporting the same total settle
   * the same total, and a later one settles more.
   */
  private disclosedUpTo = new Map<string, number>();
  private seq = 0;
  private ticketSeq = 0;
  /**
   * Which browser-tab INCARNATION currently holds a panel tab (#486).
   *
   * A `wf:` route tab id names a saved workflow, so it recurs: a second browser
   * tab opening that workflow takes the key over. Anything that holds or settles
   * per-tab state must therefore be scoped to (tab, incarnation) — otherwise the
   * newcomer reads, reports and ACKS the departed tab's bookkeeping, and the
   * departed tab's own disclosure is silently marked told. Undefined when the tab
   * is not currently connected.
   */
  private incarnationOf: ((key: string) => string | undefined) | null = null;

  /** Deliver a tab's newly-orphaned answers (see setFlusher). */
  private flush: ((key: string) => void) | null = null;
  /** Pull a still-queued answer event back off its agent (see setRevoker). */
  private revoke: ((key: string, token: string) => boolean) | null = null;
  /** Ride a token on the tab's in-flight turn, returning the CARRIER IDENTITY it
   *  attached to (null when there was no live turn). See setTurnAttacher. */
  private attachTurn: ((key: string, token: string) => string | null) | null = null;

  /**
   * Wire the push channel (#486).
   *
   * An answer becomes an ORPHAN at moments the tool layer cannot act on — the
   * bridge's late-answer sink, or an ask handler unwinding on an error without
   * having returned one. Whoever owns the agents registers here so those
   * transitions deliver immediately instead of waiting for some unrelated later
   * trigger (which is how "journaled" quietly becomes "never delivered").
   */
  setFlusher(flush: (key: string) => void): void {
    this.flush = flush;
  }

  /**
   * Wire the "unsend" hook, mirroring #468's.
   *
   * An answer's WORDING is materialised when it is queued into an agent, and it
   * says "a question card YOU put up". If the conversation is replaced before
   * that item is read, the sentence becomes false — the fork never put that card
   * up. This pulls the stale copy back while it is still unread. Nothing is
   * re-delivered afterwards: the addressee is gone, which is the whole point.
   */
  setRevoker(revoke: (key: string, token: string) => boolean): void {
    this.revoke = revoke;
  }

  /**
   * Wire the TOOL-RESULT ack (#486).
   *
   * An answer PUSHED as an event is acked when the turn carrying it ends. An
   * answer handed back as a TOOL RESULT had no such proof — and treating the
   * hand-off itself as proof is exactly the assumption #486 exists to demolish.
   * This rides the token on the turn the tool call is running inside, so the
   * SAME ack-on-carry machinery settles it: either that turn's own marked result
   * lands (the model ran to completion after receiving the answer), or it never
   * does and the answer stays accounted for.
   */
  setTurnAttacher(attach: (key: string, token: string) => string | null): void {
    this.attachTurn = attach;
  }

  /** Wire the per-tab incarnation lookup — see `incarnationOf`. */
  setIncarnationResolver(resolve: (key: string) => string | undefined): void {
    this.incarnationOf = resolve;
  }

  /**
   * May the tab's CURRENT occupant act on this answer — recover it, or be pushed
   * it?
   *
   * Only the occupant it was given by. A different browser tab holding the same
   * recurring key never asked the question and must not be handed its answer;
   * unknown provenance on either side is not a match either, because "we could
   * not tell who this belongs to" must never resolve to "it belongs to you".
   * When NOTHING can resolve incarnations at all (no resolver wired) the check is
   * inert and tab-keying alone governs, exactly as before.
   */
  /**
   * May this answer be handed to a LIVE TURN — recovered, replayed, or pushed?
   *
   * The single gate for the whole set. Both boundaries are checked here, because
   * they are independent and each alone is insufficient:
   *  • RETIRED — its conversation is gone (New chat, rewind, provider switch,
   *    workflow replacement, takeover). Same tab, same incarnation, so no amount
   *    of incarnation keying can see it.
   *  • a DIFFERENT OCCUPANT — another browser tab holds this recurring key. Same
   *    conversation identity as far as the tab is concerned, so no amount of
   *    epoch bumping can see it.
   *
   * Gating the paths one at a time is how the rid bypass, the re-arm bypass and
   * the debt-reporting bypass each arrived separately; making it a property of
   * the SET is the fix.
   */
  private mayReachLiveTurn(entry: AskEntry): boolean {
    return entry.retired !== true && this.sameOccupant(entry);
  }

  private sameOccupant(entry: AskEntry): boolean {
    if (this.incarnationOf === null) return true; // nothing to distinguish
    const now = this.incarnationOf(entry.key);
    if (entry.incarnation === undefined || now === undefined) return false;
    return entry.incarnation === now;
  }

  /** The debt bucket for a tab's CURRENT occupant. */
  private debtSlot(key: string): string {
    return tabIncarnationSlot(key, this.incarnationOf?.(key));
  }

  /**
   * A `panel_ask` card is being dispatched. Opens the ticket that makes any
   * answer for `askId` attributable to THIS question.
   *
   * Must be called BEFORE the card is sent: the answer can come back on the
   * bridge's late-reply sink at any moment after that, and an answer that
   * arrives with no ticket is (correctly, but uselessly) foreign.
   */
  openAsk(askId: string, meta: { tabId: string; fingerprint: string; question: string }): void {
    const epoch = this.tabEpoch.get(meta.tabId) ?? 0;
    const existing = this.tickets.get(askId);
    // REUSE is also proven by an ANSWER already on file for this id, not only by
    // a surviving ticket. The ticket map is bounded, so keying the guard on it
    // alone would let an eviction restore a "fresh" identity to an id that a
    // still-rendered card can answer — the old card's click would then be frozen
    // with the NEW question's fingerprint and could satisfy it.
    const answered = [...this.entries.values()].some((e) => e.askId === askId);
    if (existing || answered) {
      // The same ask id dispatched AGAIN. Reopen rather than stack a second
      // ticket (one ask id always means one ticket) — but the id now stands for
      // MORE THAN ONE question, and the panel's reply carries only the id, so
      // nothing can ever say which card an answer for it came from. Mark it
      // reused: every answer for it is reported UNDETERMINED from here on, and
      // in particular the older card's late click can no longer be frozen with
      // the newer question's fingerprint and recovered as its answer.
      this.tickets.set(askId, {
        ...(existing ?? {}),
        askId,
        tabId: meta.tabId,
        fingerprint: meta.fingerprint,
        question: meta.question,
        openedAt: Date.now(),
        epoch,
        seq: ++this.ticketSeq,
        awaiting: true,
        reused: true,
      });
      logger.warn(
        `[ask-answers] ask id ${askId.slice(0, 12)} was opened again — it no longer identifies one question, so every answer for it is reported as UNDETERMINED`,
      );
      // FREEZE THE AMBIGUITY ONTO THE ENTRIES THAT ALREADY EXIST for this id.
      // The ticket is evictable and this fact is not: once it is trimmed away,
      // anything keyed on `ticket.reused` silently reverts to treating the id as
      // a clean identity. Each such entry keeps its OWN question text — that is
      // still honest and is what makes its disclosure useful — but loses the
      // licence to answer anything.
      for (const entry of this.entries.values()) {
        if (entry.askId !== askId) continue;
        entry.ambiguousId = true;
        entry.recoverable = false;
        entry.fingerprint = null;
        if (entry.correlation.status === "matched") {
          entry.correlation = { status: "foreign", askId };
        }
      }
      this.trimTickets();
      return;
    }
    this.tickets.set(askId, {
      askId,
      tabId: meta.tabId,
      fingerprint: meta.fingerprint,
      question: meta.question,
      openedAt: Date.now(),
      epoch,
      seq: ++this.ticketSeq,
      awaiting: true,
    });
    this.trimTickets();
  }

  /**
   * Is the conversation that opened this ask STILL the one on the tab?
   *
   * The debt footnote rides whatever result is going back, and `reportDropped`
   * attaches its token to the turn that is live NOW. So a result belonging to a
   * conversation that has since been replaced must not carry it: the live turn's
   * ack would settle a warning that conversation never saw. Unknown ticket → true,
   * because a caller with no ticket has nothing to have been replaced.
   */
  askBelongsToLiveConversation(askId: string): boolean {
    const ticket = this.tickets.get(askId);
    if (!ticket) return true;
    return ticket.epoch === (this.tabEpoch.get(ticket.tabId) ?? 0);
  }

  /**
   * May this answer's CONTENT be shown to whoever holds its tab right now?
   *
   * The public face of the boundary gate, for outlets that live outside this
   * class. The fatal-exit notice is one: it renders answer text and pushes it to
   * the tab, so it is a delivery like any other and a retired conversation's pick
   * must not appear in it. Counts may always cross; content may not.
   */
  mayDisclose(entry: AskEntry): boolean {
    return this.mayReachLiveTurn(entry);
  }

  /** Does this journal know the ask id — i.e. is a late answer for it one of
   *  OURS? The bridge's late-answer sink is fed by every `ask_user` card
   *  (confirm/consent/secret gates included) and only `panel_ask` answers belong
   *  here; those other cards have their own, deliberately non-recoverable paths
   *  (a recovered "Yes, go ahead" must never authorise a different destructive
   *  operation). */
  tracks(askId: string): boolean {
    return askId.startsWith(PANEL_ASK_ID_PREFIX);
  }

  /**
   * The `panel_ask` handler that opened `askId` has RETURNED. Anything that
   * arrives from here on has nobody to be handed to, so it is orphaned on
   * arrival and pushed to the agent on its own.
   *
   * If an answer is already journaled and the handler never claimed it
   * (`markReturned` was not called), arm it for the push now.
   */
  closeAsk(askId: string): AskEntry | null {
    const ticket = this.tickets.get(askId);
    if (ticket) ticket.awaiting = false;
    let armed: AskEntry | null = null;
    let answered = false;
    for (const entry of this.entries.values()) {
      if (entry.askId !== askId) continue;
      answered = true;
      // A RETIRED answer is never armed. Arming it produces an entry that
      // `pending()` correctly refuses to deliver and `hasOutstanding()` counted
      // as owed — a permanent blocker on the self-restart gate, cleared only by
      // some unrelated later boundary or eviction.
      if (!entry.returned && entry.delivery === "none" && entry.retired !== true) {
        entry.delivery = "pending";
        armed = entry;
      }
    }
    // The card has been ANSWERED and its handler has finished, so this ticket can
    // never be needed again — the panel removes an answered card, and everything
    // the ticket carried (tab, question, fingerprint, conversation generation) is
    // frozen onto the entry. Releasing it keeps the ticket map to CARDS STILL ON
    // SCREEN, which is what makes its ceiling unreachable in practice: otherwise
    // a long session's ordinary successful asks fill it and evict a genuinely
    // outstanding card's ticket, taking its retired-conversation marker with it.
    // …EXCEPT under a reused id, where "an entry exists for this ask id" no
    // longer means "this card was answered" — it may be the OTHER card's answer,
    // and this one is still on screen. Keeping the ticket keeps its reused flag,
    // which is what stops either answer satisfying either question.
    if (answered && ticket?.reused !== true) this.tickets.delete(askId);
    // It is an orphan NOW — deliver it now. Leaving it merely `pending` would
    // make it wait for an unrelated later flush, and this transition happens on
    // the ask handler's unwind, where there may never be one.
    if (armed) this.flush?.(armed.key);
    return armed;
  }

  /**
   * Journal a validated answer. Correlation is computed HERE, once, by exact ask
   * id.
   *
   * Idempotent per ask id: the same card can be observed twice (the handler's
   * grace poll takes it out of the bridge buffer while the bridge's sink has
   * already forwarded it), and both observations are the SAME answer to the SAME
   * question. Collapsing them is identity, not suppression — nothing is ever
   * dropped because it "looks like" something already seen.
   */
  record(askId: string, reply: unknown, meta: { tabId: string }): AskEntry {
    const text = answerText(reply);
    const existing = [...this.entries.values()].find((e) => e.askId === askId);
    const ticket = this.tickets.get(askId);
    // Collapse ONLY an identical observation. The same card's reply can be seen
    // twice (the handler's grace poll takes it out of the bridge buffer while the
    // sink has already forwarded it) and that is one answer, not two — identity,
    // not suppression.
    //
    // A DIFFERENT answer under the same id is a different validated answer (two
    // cards, one reused id). Returning the old entry there would silently
    // discard what the user just chose, so it gets its own entry, and BOTH are
    // demoted to unattributable: nothing on the wire says which card either came
    // from, so neither may satisfy a question.
    //
    // …and the collapse is OFF ENTIRELY for a REUSED id. "Same id, same text" is
    // only evidence of one observation while the id means one card; once two
    // cards share it, two users' picks that happen to read the same ("euler" on
    // both) are two validated answers to two questions, and merging them leaves
    // the second question unanswered with no record at all.
    if (existing) {
      // The ENTRY's own ambiguity flag is the load-bearing half — see
      // AskEntry.ambiguousId. `ticket?.reused` is kept alongside it as the
      // earliest signal, but it may have been evicted, and a bound must never be
      // what decides whether an answer is allowed to disappear.
      if (existing.answer === text && existing.ambiguousId !== true && ticket?.reused !== true) {
        return existing;
      }
      logger.warn(
        `[ask-answers] a SECOND answer arrived under ask id ${askId.slice(0, 12)} ("${text}"${existing.answer === text ? " — same text, but the id is REUSED so this is a different card" : ` vs "${existing.answer}"`}) — both are kept and both are reported as UNDETERMINED; neither can satisfy a question`,
      );
      existing.correlation = { status: "foreign", askId };
      existing.recoverable = false;
      // …and the ambiguity is frozen here too, so it survives the ticket.
      existing.ambiguousId = true;
    }
    // A REUSED id proves nothing: the panel sends only the id, so an answer for
    // it could belong to either card. Report it as foreign — real, but
    // UNDETERMINED — rather than claiming it answers the question now open.
    // The conversation that opened this ticket has been replaced (New chat, or a
    // resume of a historical session) while its card stayed on screen.
    const conversationGone =
      ticket !== undefined && ticket.epoch !== (this.tabEpoch.get(ticket.tabId) ?? 0);
    const attributable = ticket !== undefined && ticket.reused !== true && existing === undefined;
    const correlation: AskCorrelation = attributable
      ? { status: "matched", askId }
      : { status: "foreign", askId };
    const entry: AskEntry = {
      token: `aa${++this.seq}`,
      askId,
      // The TICKET's tab is authoritative only while the ticket is ATTRIBUTABLE.
      // A REUSED id can name a ticket opened by a DIFFERENT tab, and taking its
      // tab would re-address the answer to a conversation that never rendered the
      // card — labelled `foreign`, so it could not satisfy anything, but still
      // delivered to the wrong place. The bridge-supplied tab is the PROVEN
      // source of this reply (it comes from the routed send, not from the id), so
      // it wins whenever the ticket cannot be trusted.
      key: attributable ? ticket.tabId : meta.tabId,
      // The fingerprint is the LICENCE to satisfy a re-ask, so a reused id gets
      // none — its answer may only ever be reported, never returned as an answer.
      fingerprint: attributable ? ticket.fingerprint : null,
      // …and NOR is the question text, for a REUSED id. The ticket then holds the
      // LATER card's question, and printing that beside the EARLIER card's answer
      // states a false association — the very mistake this file exists to
      // prevent, committed in the disclosure meant to be the honest fallback. A
      // ticket that is merely RETIRED (its conversation replaced) is different:
      // its question is still that card's own, and keeping it is what lets the
      // report name what was actually asked.
      question:
        ticket === undefined || ticket.reused === true ? null : ticket.question,
      answer: text,
      answeredAt: Date.now(),
      correlation,
      ticketSeq: ticket?.seq ?? 0,
      // WHO was holding the tab when this answer arrived — see AskEntry.incarnation.
      ...(this.incarnationOf?.(ticket?.tabId ?? meta.tabId) !== undefined
        ? { incarnation: this.incarnationOf(ticket?.tabId ?? meta.tabId) }
        : {}),
      returned: false,
      // An answer that lands while its own handler is still running is that
      // handler's to return; one that lands afterwards has nobody left and is
      // armed for the push immediately.
      //
      // TWO cases are never pushed, and are journaled for disclosure only:
      //  • its CONVERSATION was replaced — see closeAsks();
      //  • THERE IS NO TICKET AT ALL. Without one we cannot tell whether the card
      //    belongs to the conversation now on this tab or to a retired one (the
      //    ticket carried that generation), and announcing it anyway would fold
      //    "could not determine" into "determined not retired". It is also the
      //    one delivery with nothing to offer: the wording for an unattributable
      //    answer already says its meaning is UNDETERMINED and that nothing may
      //    be inferred from it, so pushing it into a conversation that may not be
      //    the one that asked buys nothing and risks exactly the
      //    wrong-conversation delivery the epoch guard exists to prevent. The
      //    answer is still logged with its text and still reported by a later ask
      //    on this tab — it is not swallowed, it is just not announced.
      delivery:
        ticket === undefined || ticket.awaiting === true || conversationGone
          ? "none"
          : "pending",
      // A question the CURRENT conversation never asked may be reported, never
      // returned as its answer.
      ...(conversationGone || existing !== undefined ? { recoverable: false } : {}),
      // The BOUNDARY axis only — `existing !== undefined` is ambiguity, which is
      // still deliverable (labelled), so it must not set this.
      ...(conversationGone ? { retired: true } : {}),
      // A SECOND answer under one ask id: the id is ambiguous for this entry too,
      // and that must outlive the ticket that proved it.
      ...(existing !== undefined || ticket?.reused === true ? { ambiguousId: true } : {}),
      attempts: 0,
    };
    this.entries.set(entry.token, entry);
    if (conversationGone) {
      logger.warn(
        `[ask-answers] an answer arrived for a card whose conversation was replaced (ask ${askId.slice(0, 8)}, tab ${entry.key.slice(0, 8)}): "${entry.answer}" — journaled for disclosure, NOT announced to the replacement conversation`,
      );
    } else if (!attributable) {
      logger.warn(
        `[ask-answers] a validated answer arrived for ask ${askId.slice(0, 8)} with ${ticket ? "a REUSED (ambiguous) ticket" : "no open ticket"} — journaled as UNATTRIBUTED; it can never satisfy a question, only be reported`,
      );
    }
    // Same release as closeAsk (and the same reused-id exception).
    if (ticket && !ticket.awaiting && ticket.reused !== true) this.tickets.delete(askId);
    this.trimEntries(entry.key);
    // Born orphaned (no handler is waiting on this ask) — push it straight away.
    if (entry.delivery === "pending") this.flush?.(entry.key);
    return entry;
  }

  /** The ask handler put this answer into its ToolResult. A hand-off, not proof
   *  of consumption — see AskEntry.returned. */
  markReturned(token: string, opts: { replay?: boolean } = {}): void {
    // BY TOKEN, not by ask id: under a reused id one ask id can own two entries,
    // and marking the sibling returned would quietly retire an answer nobody has
    // been given.
    const entry = this.entries.get(token);
    if (entry) {
      entry.returned = true;
      if (opts.replay) entry.replayHint = true;
      // Ride the turn this tool call is running inside, so that turn's result —
      // and nothing less — acks the answer. No live turn to ride means no proof,
      // so the answer simply stays unacked, which is the conservative reading.
      //
      // THE CARRIER IS CAPTURED HERE, at the instant of return, and frozen onto
      // the entry. Resolving it later from "whoever owns this tab now" is how a
      // switched provider's turn could ack an answer it never saw: a stale
      // pre-switch ask handler resumes, attaches to the NEW provider's turn, and
      // that turn's result settles an answer the new conversation was never
      // shown. `ack` compares against this, so only the turn that actually
      // carried the answer can settle it.
      //
      // …and an answer whose CONVERSATION is gone never attaches at all. Capturing
      // the carrier is not enough on its own here: a stale pre-switch ask handler
      // that resumes when its card is clicked would attach to whatever turn is
      // running NOW, and that turn's result would then certify — accurately, and
      // uselessly — an answer the current conversation was never shown. The
      // conversation boundary already marked this entry unrecoverable; it makes it
      // unackable too, so the answer stays honestly unproven.
      // Gated on the BOUNDARY axis only. An AMBIGUOUS answer (an ask id that
      // stopped identifying one card) is still handed to a caller, so it must
      // still be ackable by the turn that carried it — refusing the carrier there
      // left a delivered answer permanently unconfirmed, i.e. surfacing later as
      // a loss that did not happen. Only a RETIRED answer, which no live turn may
      // receive at all, gets no carrier.
      entry.carrier =
        entry.retired === true ? null : (this.attachTurn?.(entry.key, token) ?? null);
      // It reached A caller. Do not ALSO push it as an orphan; a re-ask can
      // still recover it if that caller was already dead.
      //
      // DEFENCE IN DEPTH, not a live path: an ask handler only marks an answer
      // returned while its own ticket is still `awaiting`, and `record` never
      // arms one in that state — so nothing reachable enters this branch and no
      // test can fail on it. It is here because "a caller took this" and
      // "announce it to the agent as unclaimed" are contradictory states, and a
      // future caller marking an answer returned from outside the ask handler
      // would otherwise double-report it.
      if (entry.delivery === "pending") entry.delivery = "none";
    }
  }

  /**
   * Find the answer the user already gave to THIS EXACT question on THIS tab.
   *
   * The match is exact fingerprint equality and nothing else — see the
   * cross-question guard at the top of this file. When several qualify the
   * NEWEST wins: it is the user's most recent statement of intent about that
   * question.
   *
   * Returns a discriminated result: "no answer at all" and "answers exist but
   * none is provably for this question" are DIFFERENT facts and must not be
   * folded into one falsy value (#796).
   *
   * The CURRENT ask's own id is deliberately NOT excluded: an answer that landed
   * for the very card we just gave up on is the most direct answer there is, and
   * excluding it would re-open the race the grace poll cannot close (the sink
   * journals an answer microseconds after the last poll).
   */
  recover(key: string, fingerprint: string): AskRecovery {
    const now = Date.now();
    const mine = [...this.entries.values()].filter((e) => e.key === key);
    if (mine.length === 0) return { status: "none" };
    const eligible = mine
      .filter(
        (e) =>
          e.correlation.status === "matched" &&
          e.recoverable !== false &&
          this.mayReachLiveTurn(e) &&
          e.fingerprint !== null &&
          e.fingerprint === fingerprint &&
          now - e.answeredAt <= RECOVER_MAX_AGE_MS,
      )
      .sort((a, b) => b.answeredAt - a.answeredAt);
    if (eligible.length > 0) return { status: "recovered", entry: eligible[0] };
    // SPLIT by what this conversation is allowed to see. `others` goes through
    // exactly the same gate as every other outlet — nothing about a disclosure
    // makes it exempt just because it is not a hand-off.
    const others = mine.filter((e) => this.mayReachLiveTurn(e));
    return { status: "unattributed", others, withheld: mine.length - others.length };
  }

  /**
   * A recovery (or a push the agent provably consumed) took this answer. Drop
   * it so the same answer can never be handed over twice.
   *
   * Deleting an entry that was already pushed and is sitting unread in an
   * agent's queue is deliberate: the tool result the caller is about to return
   * carries the SAME answer with the SAME question attached, so the worst case
   * is the agent reading it twice — never acting on an answer it wasn't given.
   *
   * Any eviction disclosure the entry was CARRYING is handed back to the tab
   * first. The disclosure is a debt owed to the tab, not a property of whichever
   * entry happens to be carrying it: consuming the carrier without re-homing it
   * would let an eviction that the journal promised to report disappear because
   * an unrelated answer was recovered.
   */
  markSurfaced(token: string): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    // NOT DELETED. An earlier draft consumed a recovered answer outright, on the
    // reasoning that it had now been handed over — which is the same mistake as
    // every suppression #468 removed, one level up: the ToolResult carrying it
    // can itself be abandoned (that IS #486), so deleting the entry destroys the
    // only durable copy at exactly the moment it is most likely to be needed
    // again. It is marked handed-over and flagged, so a further re-ask of the
    // same question gets it again, labelled "you have seen this".
    //
    // IT GOES THROUGH markReturned, and must: a recovery hands the answer to a
    // live turn exactly as a fresh answer does, so it has to attach a token and
    // capture its carrier BY CONSTRUCTION. An earlier draft set the flags here
    // by hand and forgot to attach — so a recovery that completed perfectly
    // stayed unacked forever, aged into apparent loss, and eventually raised
    // eviction debt and warnings despite the agent having read it. That is the
    // routine-false-warning failure the ack split exists to prevent, arriving
    // through a different door.
    this.markReturned(token, { replay: true });
  }

  /** Every unconsumed ORPHAN answer for a tab — those that were never handed
   *  back to any tool result. These are what a failing ask discloses, so a
   *  validated answer is never silently dropped. */
  orphansFor(key: string): AskEntry[] {
    return [...this.entries.values()].filter((e) => e.key === key && !e.returned);
  }

  /**
   * Take the eviction debt that has NO other carrier — the count parked in the
   * side map because this tab had no pending entry to stamp it onto, i.e. no
   * push is coming to disclose it. The ask path reports it instead.
   *
   * Debt riding on an ENTRY is deliberately left alone: that copy goes out with
   * a real delivery and is cleared only when the turn carrying it ends, so
   * taking it here could drop a disclosure that push still owes.
   *
   * Reporting into a ToolResult is a hand-off, not a proof, so this can still be
   * lost with an abandoned call — but the eviction itself was already logged at
   * ERROR, and repeating the warning on every subsequent ask forever is worse
   * than reporting it once at the first opportunity.
   */
  reportDropped(key: string): number {
    // THIS occupant's bucket only. A different browser tab that inherited the
    // key has its own, so it can neither read nor settle the departed tab's.
    const slot = this.debtSlot(key);
    const total = this.dropped.get(slot) ?? 0;
    const owed = total - (this.disclosedUpTo.get(slot) ?? 0);
    if (owed <= 0) return 0;
    // The debt is NOT spent by being written into a tool result. A ToolResult is
    // a hand-off, not a receipt — that IS #486 — so counting reports (an earlier
    // draft retired the debt after three) lets three abandoned calls carry the
    // only disclosure away with them, and the answer's payload is already gone.
    //
    // It rides the SAME ack as everything else instead: a token attached to the
    // turn this tool call is running inside, retired only when that turn produces
    // its own result. No live turn to ride means no proof and no retirement — the
    // debt simply stands and the next result reports it again.
    const token = `aad${++this.seq}`;
    const carrier = this.attachTurn?.(key, token) ?? null;
    // Bound to the turn that carried it, for the same reason an answer is: a
    // switched provider must not be able to certify a warning it never showed.
    // The token remembers the TOTAL it is showing, so its ack settles exactly
    // that and nothing that arrives afterwards.
    if (carrier !== null) this.debtTokens.set(token, { key: slot, carrier, upTo: total });
    return owed;
  }

  /**
   * The tab's connection is gone. SURFACE any disclosure it is still owed, then
   * retire it.
   *
   * This is the lifecycle wire that keeps the debt map from growing forever now
   * that it has no ceiling — and the distinction matters: a debt must end because
   * it was SAID or because its tab genuinely went away, never because a counter
   * filled up and picked a victim. The durable ERROR log is the disclosure here;
   * there is no live tab left to tell in-band, which is precisely why keeping the
   * counter any longer would be bookkeeping for nobody.
   *
   * JOURNAL ENTRIES ARE NOT TOUCHED. A disconnect is often a reload, and the
   * answers themselves are still deliverable to the tab when it comes back; only
   * the count of answers whose TEXT is already gone is retired.
   */
  retireDebt(key: string, incarnation: string): void {
    this.surfaceAndClearDebt(key, incarnation, "disconnected");
  }

  /**
   * SURFACE a debt that can no longer be delivered, then clear it.
   *
   * Used for both endings a debt can have: the tab went away, or the
   * conversation it was owed to was replaced. Both are "there is no longer
   * anywhere to deliver this", and both must REPORT before clearing — retiring a
   * warning to stop it being misattributed, without saying it anywhere, would
   * trade a misattribution for a silent loss, which is the one trade this file
   * refuses everywhere else.
   *
   * Clears the entry-carried disclosures too: those ride out on a push, and a
   * retired conversation's entries are no longer pushed, so leaving them there
   * would strand the warning on text nobody will read.
   */
  private surfaceAndClearDebt(
    key: string,
    incarnation: string | undefined,
    why: "disconnected" | "its conversation was replaced",
  ): void {
    const slot = tabIncarnationSlot(key, incarnation);
    // COUNT FIRST, WITHOUT MUTATING. An earlier draft cleared each carrier as it
    // totalled them, so the only consolidated copy of the debt was gone BEFORE
    // the report — and a logger that throws would take the whole disclosure with
    // it, leaving nothing for a later ack to re-home. Clear-then-report is not
    // report-then-clear, and this helper exists precisely so that fixing a
    // misattribution cannot create a silent loss.
    const carriers = [...this.entries.values()].filter(
      (e) => e.key === key && e.incarnation === incarnation && (e.disclose ?? 0) > 0,
    );
    const owed = this.undisclosedDrop(slot) + carriers.reduce((n, e) => n + e.disclose!, 0);
    if (owed > 0) {
      // If this throws, NOTHING below has run: the debt is still whole and still
      // owed, and the next retirement (or the next report) will surface it.
      logger.error(
        `[ask-answers] tab ${key.slice(0, 8)} ${why} still owed a disclosure for ${owed} validated answer(s) whose content was already dropped — recording it here, as there is no longer anywhere to deliver it; treat those answers as UNDETERMINED`,
      );
    }
    for (const entry of carriers) delete entry.disclose;
    this.dropped.delete(slot);
    this.disclosedUpTo.delete(slot);
    for (const [t, x] of [...this.debtTokens]) if (x.key === slot) this.debtTokens.delete(t);
  }

  /** The part of a tab's eviction total that has NOT yet been surfaced and
   *  confirmed. See disclosedUpTo. */
  private undisclosedDrop(slot: string): number {
    return Math.max(0, (this.dropped.get(slot) ?? 0) - (this.disclosedUpTo.get(slot) ?? 0));
  }

  /** Every debt bucket belonging to a panel tab, across all its incarnations. */
  private debtSlotsFor(key: string): string[] {
    // A slot is `["<tabId>",<incarnation>]`, so the tab's slots are exactly those
    // starting `["<tabId>",` — JSON-escaped, so no tab id can spoof another's.
    const prefix = `[${JSON.stringify(key)},`;
    return [...new Set([...this.dropped.keys(), ...this.disclosedUpTo.keys()])].filter((s) =>
      s.startsWith(prefix),
    );
  }

  /** Answers this tab lost to an eviction and has not yet been told about. */
  droppedFor(key: string): number {
    const carried = [...this.entries.values()]
      .filter((e) => e.key === key)
      .reduce((n, e) => n + (e.disclose ?? 0), 0);
    // Every incarnation's bucket: a diagnostic view of what this TAB is owed,
    // whoever is holding it now.
    return (
      carried + this.debtSlotsFor(key).reduce((n, slot) => n + this.undisclosedDrop(slot), 0)
    );
  }

  /** Entries awaiting a push attempt for this key, in arrival order. */
  pending(key: string): AskEntry[] {
    const out: AskEntry[] = [];
    for (const entry of this.entries.values()) {
      // A different browser tab now holds this key: its conversation never put
      // the card up, so the answer waits (for its own tab to come back) rather
      // than being announced to a stranger. It is still disclosed by a failing
      // ask, and still named on the way out — held, never swallowed.
      if (entry.key === key && entry.delivery === "pending" && this.mayReachLiveTurn(entry)) {
        out.push(entry);
      }
    }
    return out;
  }

  /**
   * Push every orphaned answer for `key` to the tab's agent, in ARRIVAL order,
   * stopping at the first refusal so a newer answer never overtakes an older one
   * that is still stuck.
   *
   * `inject` returns whether the agent TOOK the payload onto its queue — not
   * that it was read. The entry stays journaled either way; only `ack` (the turn
   * that carried it ended) removes it. That is the durability property: hand it
   * to an agent that then dies and it comes back here.
   *
   * NOTHING is re-correlated. The verdict and the question were frozen at
   * arrival, so a replay can never be re-attributed to a question asked later.
   */
  deliverPending(
    key: string,
    inject: (payload: AskAnswerEvent, token: string) => boolean,
  ): { delivered: number; blockedOn: AskEntry | null } {
    let delivered = 0;
    for (const entry of this.pending(key)) {
      const lost = (entry.disclose ?? 0) + this.undisclosedDrop(this.debtSlot(key));
      const payload: AskAnswerEvent = {
        kind: "ask_answer",
        ask_question: entry.question,
        ask_answer: entry.answer,
        ask_correlation: entry.correlation.status,
        ask_answered_at: entry.answeredAt,
        ...(entry.attempts > 0 ? { replayed: true } : {}),
        ...(entry.replayHint ? { possible_repeat: true } : {}),
        ...(lost > 0 ? { dropped_answers: lost } : {}),
      };
      const handedOff = inject(payload, entry.token);
      entry.attempts += 1;
      entry.delivery = handedOff ? "handed_off" : "pending";
      if (!handedOff) return { delivered, blockedOn: entry };
      if (lost > 0) {
        // CONSOLIDATE onto the entry; the disclosure is NOT spent by a hand-off.
        // If this agent dies before its turn runs, the entry is released and
        // replayed, and the warning must go with it. Only ack() clears it.
        entry.disclose = lost;
        const slot = this.debtSlot(key);
        this.dropped.delete(slot);
        this.disclosedUpTo.delete(slot);
      }
      delivered += 1;
    }
    return { delivered, blockedOn: null };
  }

  /** The turn that CARRIED this answer ended — it genuinely reached the agent. */
  ack(token: string, from?: { carrier?: string }): void {
    // An eviction-DISCLOSURE token (see reportDropped): the turn that carried the
    // warning produced its result, so the tab has genuinely been told.
    const debt = this.debtTokens.get(token);
    if (debt !== undefined) {
      if (!this.carriedBy(debt.carrier, from)) return;
      this.debtTokens.delete(token);
      // Settle ONLY what this warning actually showed. An eviction that landed
      // after it was rendered is not covered by it, and must still be reported.
      const seen = Math.max(this.disclosedUpTo.get(debt.key) ?? 0, debt.upTo);
      const total = this.dropped.get(debt.key) ?? 0;
      if (seen >= total) {
        // Fully told — nothing outstanding, so drop both halves.
        this.dropped.delete(debt.key);
        this.disclosedUpTo.delete(debt.key);
        for (const [t, x] of [...this.debtTokens]) if (x.key === debt.key) this.debtTokens.delete(t);
      } else {
        this.disclosedUpTo.set(debt.key, seen);
      }
      return;
    }
    const entry = this.entries.get(token);
    if (!entry) return;
    // ONLY THE TURN THAT ACTUALLY CARRIED IT may settle it. The carrier was
    // frozen at hand-off (see AskEntry.carrier); a result arriving from anything
    // else — most concretely, the NEW provider's turn after a switch moved the
    // tab's agent mapping — proves nothing about this answer, so it is refused
    // and the answer stays honestly unacked.
    if (!this.carriedBy(entry.carrier, from)) {
      logger.warn(
        `[ask-answers] refusing an ack for the user's answer to "${preview(entry.question)}" from ${from?.carrier ?? "an unidentified turn"} — it was handed to ${entry.carrier ?? "no turn at all"}; the answer stays unconfirmed`,
      );
      return;
    }
    // The push is done, but the ANSWER stays journaled while it is still within
    // the recovery window: a re-ask of the identical question must still be able
    // to return it as its result rather than making the user answer twice. It is
    // flagged so any later surfacing reads as "you have seen this".
    //
    // The eviction DISCLOSURE it carries is only SPENT when a real delivery
    // actually rendered it — `deliverPending` stamps the count onto the entry and
    // puts `dropped_answers` in that payload, and `attempts > 0` is the record of
    // it. An entry acked without ever having been pushed (a TOOL-RESULT answer
    // riding its turn) never showed anyone that count, so deleting it here would
    // spend a warning nobody was given: re-home it instead.
    if (entry.disclose) {
      const owed = entry.disclose;
      delete entry.disclose;
      if (entry.attempts === 0) this.noteDropped(entry.key, owed, entry.incarnation);
    }
    entry.delivery = "none";
    entry.returned = true;
    // THE proof. Everything that may forget an answer QUIETLY keys on this and
    // never on `returned`.
    entry.acked = true;
    entry.replayHint = true;
  }

  /**
   * An agent gave a push back undelivered. Re-arm it for replay.
   *
   * `carried` distinguishes the two causes, and ONLY the first is bounded:
   *  • carried: true  — a turn actually DISPATCHED with this answer in it and
   *    then ended, but its result could not be proven to be that turn's own. The
   *    agent read the text; after MAX_CARRIED_RELEASES we settle rather than
   *    loop (a duplicate at worst).
   *  • carried: false — a teardown handed it back (agent stopped, session died).
   *    NOBODY read it. These must never count toward the bound.
   */
  release(token: string, opts: { carried?: boolean } = {}): void {
    // A disclosure token handed back: that turn never proved it was read, so the
    // debt STANDS and the next result reports it again. Only the token mapping
    // goes; there is deliberately no bound on how often a warning may be repeated
    // when nothing has confirmed it.
    if (this.debtTokens.delete(token)) return;
    const entry = this.entries.get(token);
    if (!entry) return;
    // A TOOL-RESULT answer riding a turn (see setTurnAttacher) is not in a
    // delivery loop: nothing re-sends it, so there is no cycle to bound and
    // nothing to re-arm. Its turn ended without proving it was read, so the only
    // correct outcome is that it stays UNACKED — which is what keeps it
    // recoverable and makes its eviction a disclosed loss rather than a silent
    // one. Settling it here on a bound would forge the very proof this split
    // exists to withhold.
    if (entry.returned && entry.delivery === "none") return;
    // A boundary happened while a turn was carrying this. Re-arming it would
    // hand the OLD conversation's answer to the replacement one — the same bypass
    // as the rid path, through the release/push door. It stays journaled and
    // disclosable; it just stops being deliverable.
    if (entry.retired === true) {
      entry.delivery = "none";
      return;
    }
    if (opts.carried) {
      entry.carriedReleases = (entry.carriedReleases ?? 0) + 1;
      if (entry.carriedReleases >= MAX_CARRIED_RELEASES) {
        logger.warn(
          `[ask-answers] an answer was carried by ${entry.carriedReleases} turns that ended without a provable ack — settling it instead of replaying again`,
        );
        this.ack(token);
        return;
      }
    }
    entry.delivery = "pending";
  }

  /** Is ANY orphaned answer still awaiting a push? The orchestrator's
   *  self-restart gate reads this: the journal is in-memory, so restarting while
   *  one is outstanding silently drops an answer the user actually gave. */
  hasOutstanding(): boolean {
    // The eviction DEBT counts too. It is a promise to tell the agent that an
    // answer was lost, and it is destroyed by a teardown exactly as an entry is —
    // tearing down while one is owed turns a disclosed loss back into a silent
    // one, which is the whole thing this journal exists to prevent.
    for (const slot of this.dropped.keys()) if (this.undisclosedDrop(slot) > 0) return true;
    // …but a RETIRED answer is not owed to anyone. It can never be delivered —
    // the conversation it belongs to is gone — so it is finished, whatever its
    // `delivery` flag says, and holding the restart gate open for it would wait
    // forever. Two predicates disagreeing about what `pending` means is what made
    // this a deadlock: `pending()` reads it as "deliverable", this reads it as
    // "owed", and only a retirement makes those differ permanently.
    //
    // NOT extended to a different-occupant mismatch, which is TEMPORARY: that
    // answer becomes deliverable again the moment its own browser tab returns, so
    // tearing down while one is waiting would be a real loss.
    return [...this.entries.values()].some(
      (e) => (e.delivery !== "none" && e.retired !== true) || (e.disclose ?? 0) > 0,
    );
  }

  /**
   * Everything the last-ditch, we-are-about-to-die disclosure must name.
   *
   * Broader than `hasOutstanding` on purpose. A restart is a CHOICE we can defer,
   * so it waits only on what is still deliverable; a fatal exit is not, so it
   * reports everything a validated answer might still have been needed for:
   *  • answers awaiting a push (nobody has them);
   *  • answers that went into a ToolResult RECENTLY — "returned" is a hand-off,
   *    not a receipt (that IS #486), and inside the recovery window a re-ask was
   *    still able to produce it. Deferring restarts on these would stall the
   *    self-restarter after every single ask; SAYING so on the way out costs
   *    nothing and keeps the loss from being silent.
   */
  allOutstanding(): AskEntry[] {
    return [...this.entries.values()].filter(
      (e) =>
        e.delivery !== "none" ||
        (e.disclose ?? 0) > 0 ||
        // UNACKED, with NO TIME BOUND. An answer the agent provably read is not
        // news on the way out; one whose receipt was never confirmed is, and it
        // stays news for as long as it exists.
        //
        // An earlier draft also required it to be inside the recovery window,
        // which quietly undid the whole `returned`/`acked` split: past ten
        // minutes an unacked answer was neither pending nor debt-bearing, so the
        // fatal-exit path was handed nothing and a validated choice vanished in
        // silence. UNACKED MEANS UNPROVEN, and time does not turn unproven into
        // delivered — the window governs whether an answer may be RECOVERED, and
        // has no business governing whether a loss is reported.
        e.acked !== true,
    );
  }

  /** Tabs still owed an eviction disclosure, with the count — so a fatal exit can
   *  name a loss whose carrier is only a counter. */
  outstandingDebt(): Array<{ key: string; count: number }> {
    const byTab = new Map<string, number>();
    for (const slot of this.dropped.keys()) {
      const owed = this.undisclosedDrop(slot);
      if (owed <= 0) continue;
      // The exit disclosure names TABS, not incarnations — every incarnation's
      // loss belongs to the tab the user is looking at.
      const key = JSON.parse(slot)[0] as string;
      byTab.set(key, (byTab.get(key) ?? 0) + owed);
    }
    for (const e of this.entries.values()) {
      if ((e.disclose ?? 0) > 0) byTab.set(e.key, (byTab.get(e.key) ?? 0) + e.disclose!);
    }
    return [...byTab].map(([key, count]) => ({ key, count }));
  }

  /** Move every entry AND every open ticket from `from` onto `to` — a panel
   *  tab-id migration re-keys the agent and both must move with it, or an answer
   *  for a card dispatched under the old id becomes unattributable. */
  moveKey(from: string, to: string): void {
    if (from === to) return;
    for (const entry of this.entries.values()) {
      if (entry.key === from) entry.key = to;
    }
    // The conversation GENERATION moves with the tickets, or they would all read
    // as belonging to a replaced conversation at the destination (or, worse, a
    // retired one would read as live there). A ticket whose conversation was
    // still current at the source is current at the destination — the agent moved
    // with it; one already retired stays retired.
    const fromEpoch = this.tabEpoch.get(from) ?? 0;
    const toEpoch = this.tabEpoch.get(to) ?? 0;
    for (const ticket of this.tickets.values()) {
      if (ticket.tabId !== from) continue;
      ticket.tabId = to;
      ticket.epoch = ticket.epoch === fromEpoch ? toEpoch : toEpoch - 1;
    }
    this.tabEpoch.delete(from);
    // BOTH HALVES OF THE DEBT MOVE TOGETHER. The count is tab-keyed and the
    // outstanding disclosure TOKENS carry that same key, but the ack that
    // settles one is bound to the AGENT INSTANCE (see AskEntry.carrier) — which
    // deliberately survives a tab-id migration. So a token left pointing at the
    // old key is acked by a perfectly valid result and clears a debt nobody
    // owes, while the real one sits under the new key forever: false outstanding
    // debt that blocks the restart gate and later emits a spurious warning. That
    // is the cry-wolf failure the acked/unacked split exists to prevent,
    // arriving through migration.
    for (const debt of this.debtTokens.values()) {
      if (debt.key === from) debt.key = to;
    }
    // Every incarnation's bucket moves with the tab id, keeping its own
    // incarnation: the id changed, the browser tabs did not.
    for (const slot of this.debtSlotsFor(from)) {
      const [, incarnation] = JSON.parse(slot) as [string, string | null];
      // Carry the UNDISCLOSED remainder only — what was already told is told,
      // and re-importing it would warn the destination twice.
      const lost = this.undisclosedDrop(slot);
      this.dropped.delete(slot);
      this.disclosedUpTo.delete(slot);
      if (lost <= 0) continue;
      const moved = tabIncarnationSlot(to, incarnation ?? undefined);
      this.dropped.set(moved, (this.dropped.get(moved) ?? 0) + lost);
    }
    for (const debt of this.debtTokens.values()) {
      const [tab, incarnation] = JSON.parse(debt.key) as [string, string | null];
      if (tab === from) debt.key = tabIncarnationSlot(to, incarnation ?? undefined);
    }
  }

  /** Drop everything belonging to a tab that will never come back. Logs every
   *  answer that dies unconsumed; a loss must never be silent. */
  forget(key: string): void {
    for (const [token, entry] of [...this.entries]) {
      if (entry.key !== key) continue;
      this.entries.delete(token);
      // …and its queued copy goes with it: the journal's record and the agent's
      // queue must be dropped together, or the text outlives the entry that was
      // supposed to bound it.
      if (entry.delivery === "handed_off") this.revoke?.(entry.key, entry.token);
      // EVERY answer is logged, returned ones included: "it went into a
      // ToolResult" is not proof it was received, so a returned answer inside
      // the recovery window is still the only copy of a decision that may never
      // have reached the model.
      logger.warn(
        `[ask-answers] dropping a validated answer ("${entry.answer}") to "${preview(entry.question)}" — its tab (${key.slice(0, 8)}) is gone${entry.returned ? " (it had been handed to a tool result, which is not proof it was received)" : ""}`,
      );
    }
    // The TAB is gone, so every conversation it hosted is gone too: bump the
    // epoch rather than deleting the tickets. A card left on screen can still be
    // clicked, and the surviving ticket is what names the question that answer
    // belongs to — while the newer epoch keeps it from being armed for a push at
    // a tab id no agent answers to, exactly as for a replaced conversation.
    this.tabEpoch.set(key, (this.tabEpoch.get(key) ?? 0) + 1);
    const slots = this.debtSlotsFor(key);
    const owed = slots.reduce((n, slot) => n + this.undisclosedDrop(slot), 0);
    if (owed > 0) {
      logger.error(
        `[ask-answers] tab ${key.slice(0, 8)} is gone still owed a disclosure for ${owed} evicted answer(s) — it will never be told`,
      );
    }
    for (const slot of slots) {
      this.dropped.delete(slot);
      this.disclosedUpTo.delete(slot);
    }
    // Both halves together — see moveKey. A token left behind here would let a
    // later ack clear a debt for a tab that no longer exists.
    for (const [t, x] of [...this.debtTokens]) {
      if ((JSON.parse(x.key) as [string, string | null])[0] === key) this.debtTokens.delete(t);
    }
  }

  /**
   * The CONVERSATION that asked this tab's questions is gone — New chat, or a
   * switch to a historical session.
   *
   * Drop the tab's TICKETS and DOWNGRADE its journaled answers to `foreign`, so
   * an answer given to the old conversation's question can never be returned to
   * the replacement agent as "the answer to the question YOU just asked". The
   * answers themselves are kept and still delivered — labelled UNDETERMINED,
   * quoted with their own question. A correlation may only ever get WEAKER.
   */
  closeAsks(key: string): void {
    // ORDER IS THE WHOLE POINT HERE. The rule this and surfaceAndClearDebt share:
    //
    //   FENCE BEFORE YOU REPORT. REPORT BEFORE YOU DESTROY.
    //
    // Nothing that can throw may stand between a decision and the state change
    // that makes it safe. In surfaceAndClearDebt the irreversible act is the
    // clear, so the report goes first. HERE the protective act is the retire, so
    // it goes first — an earlier draft reported the debt (through a logger, which
    // can fail) before marking anything retired, and a logger failure left the
    // fence half-built. The caller has already reset the old agent by then, so
    // the replacement's ready-flush would push the still-unretired answer and an
    // identical re-ask could recover it.
    //
    // PASS 1 is pure state: no logging, no callbacks, nothing that can throw. By
    // the end of it every answer on this tab is fenced.
    this.tabEpoch.set(key, (this.tabEpoch.get(key) ?? 0) + 1);
    const queued: AskEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.key !== key) continue;
      if (entry.correlation.status === "matched") {
        entry.correlation = { status: "foreign", askId: entry.correlation.askId };
      }
      // Revoke the LICENCE to satisfy a re-ask, but keep the fingerprint: it is
      // also how a later ask of the SAME question notices this answer exists and
      // reports it. See AskEntry.recoverable.
      entry.recoverable = false;
      // …and mark it RETIRED, which is what every path that can reach a live turn
      // consults (see AskEntry.retired). Setting `delivery` alone is not enough:
      // a turn that was already carrying this answer releases it back to
      // `pending` afterwards, and the re-arm has no idea a boundary happened.
      entry.retired = true;
      // …and STOP PUSHING it. Its addressee is gone.
      //
      // This is where an ask answer parts company with a run completion (#468),
      // which is still delivered to the replacement conversation downgraded. A
      // completion's payload is independently useful — the images are on the
      // user's canvas either way. An answer to a question the replacement
      // conversation never asked is useful to nobody.
      //
      // NOT a silent discard: the entry stays journaled (so a later ask on this
      // tab that times out still reports its EXISTENCE) and the loss of the push
      // is logged in pass 2.
      if (entry.delivery === "pending") entry.delivery = "none";
      else if (entry.delivery === "handed_off") queued.push(entry);
    }
    // PASS 2 is fallible: pulling a queued copy back off an agent, and saying what
    // happened. Each is isolated, so one failure cannot skip the rest — and none
    // of it can undo pass 1, which has already made every answer here unusable.
    for (const entry of queued) {
      let recalled = false;
      try {
        // HANDED_OFF has already been materialised into the agent's queue with
        // wording that claims the reader put the card up, so it must be pulled
        // back; only once the carrying turn has STARTED is the text beyond
        // recall.
        recalled = this.revoke?.(entry.key, entry.token) === true;
      } catch (err) {
        // A CATCH BLOCK THAT CAN THROW IS NOT A GUARD. The try above exists so a
        // throwing revoker cannot abort the pass — but the report of that failure
        // is itself fallible, and an unguarded one hands the abort straight back:
        // a throwing revoker AND a throwing warn sink together would exit
        // closeAsks here, skipping the remaining recalls and, worse, pass 3. The
        // debt would then stay on the tab for a same-incarnation replacement to
        // read and settle as its own, and any entry-carried `disclose` would sit
        // on a retired, undeliverable entry holding hasOutstanding() — and so the
        // self-restart gate — open forever.
        //
        // Every step of this pass therefore has a TERMINAL error path: the report
        // of a failure must never become a new failure that skips the rest.
        try {
          logger.warn(
            `[ask-answers] could not recall a queued answer on tab ${key.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        } catch {
          // The fence is already up; a log sink that is down cannot undo it, and
          // must not stop the debt from being surfaced.
        }
      }
      if (recalled) entry.delivery = "none";
      try {
        logger.warn(
          recalled
            ? `[ask-answers] the conversation that asked "${preview(entry.question)}" on tab ${key.slice(0, 8)} was replaced — the user's answer ("${entry.answer}") will NOT be announced to the replacement conversation; it is kept only for disclosure`
            : `[ask-answers] tab ${key.slice(0, 8)}: the user's answer to "${preview(entry.question)}" was already being read when the conversation was replaced — it could not be recalled`,
        );
      } catch {
        // The fence is already up; a log sink that is down cannot undo it.
      }
    }
    // PASS 3, last because it is the one that DESTROYS. The eviction debt is owed
    // to the conversation being replaced, and scoping it by (tab, incarnation)
    // cannot fence this axis — New chat happens on the same tab, same
    // incarnation. Left alone, the replacement conversation's next ask would
    // report the old conversation's warning as its own and settle it with its own
    // ack. Surfaced and retired, exactly as a tab-gone does.
    this.surfaceAndClearDebt(key, this.incarnationOf?.(key), "its conversation was replaced");
  }

  /** Test/diagnostic helpers. */
  ticketFor(askId: string): AskTicket | undefined {
    return this.tickets.get(askId);
  }
  /**
   * Is an ack from `from` allowed to settle something handed to `carrier`?
   *
   * A PUSHED entry has no carrier binding (its token was queued, not attached to
   * a running turn) and #468's own machinery already gates it — those pass. A
   * hand-off that never found a live turn (`carrier === null`) can never be
   * settled by anyone. Everything else must match EXACTLY.
   *
   * An ack that arrives with no identity at all is UNVERIFIABLE, and is refused
   * for a bound answer: "we could not tell who this came from" must never
   * collapse into "it came from the right place".
   */
  private carriedBy(carrier: string | null | undefined, from?: { carrier?: string }): boolean {
    if (carrier === undefined) return true; // never bound to a turn (a push)
    if (carrier === null) return false; // handed back with no live turn to ride
    return from?.carrier === carrier;
  }

  /** Simulate the ticket map's bound biting, without running 1024 asks. */
  dropTicketForTest(askId: string): void {
    this.tickets.delete(askId);
  }
  /** Strand an eviction debt on a tab without staging 48 evictions. */
  noteDroppedForTest(key: string, count: number, incarnation?: string): void {
    this.noteDropped(key, count, incarnation ?? this.incarnationOf?.(key));
  }
  /** Record + hand back in one step, returning the token. */
  markReturnedForTest(askId: string, reply: unknown, tabId: string): string {
    const token = this.record(askId, reply, { tabId }).token;
    this.markReturned(token);
    return token;
  }
  entriesFor(key: string): AskEntry[] {
    return [...this.entries.values()].filter((e) => e.key === key);
  }
  reset(): void {
    // NOTE: the flusher is deliberately NOT cleared — it belongs to the process's
    // orchestrator, not to any one test's fixture.
    this.tickets.clear();
    this.tabEpoch.clear();
    this.entries.clear();
    this.dropped.clear();
    this.disclosedUpTo.clear();
    this.debtTokens.clear();
    this.seq = 0;
    this.ticketSeq = 0;
  }


  private trimTickets(): void {
    while (this.tickets.size > MAX_TICKETS) {
      // Prefer a ticket no handler is waiting on; otherwise the oldest. Losing a
      // ticket does not lose an answer — it makes a later answer for it read as
      // UNATTRIBUTED, which is the honest verdict once we have forgotten the
      // question — but say so, because it is a real degradation.
      let victim: string | null = null;
      for (const [id, t] of this.tickets) {
        if (!t.awaiting) {
          victim = id;
          break;
        }
      }
      if (!victim) victim = this.tickets.keys().next().value ?? null;
      if (!victim) return;
      logger.error(
        `[ask-answers] over ${MAX_TICKETS} question cards have been tracked — forgetting ask ${victim.slice(0, 12)}; a late answer for it will be reported as UNATTRIBUTED (its question can no longer be named)`,
      );
      this.tickets.delete(victim);
    }
  }


  /**
   * Record that an answer for `key` was destroyed by an eviction, so the next
   * delivery to that tab can report it as UNDETERMINED. Stamped onto a surviving
   * PENDING entry when there is one — it then rides out on a real delivery and
   * cannot be discarded.
   */
  private noteDropped(key: string, count: number, incarnation: string | undefined): void {
    if (count <= 0) return;
    // THE LOSS BELONGS TO THE OCCUPANT IT HAPPENED TO, and that is carried in,
    // never re-derived from the key at write time. The bucket is keyed by
    // incarnation, so deriving an owner here would file A's loss under whoever
    // holds the key NOW — B is then pushed A's `dropped_answers`, B's ack clears
    // it, and A's own lifecycle callback (which retires A's bucket) finds
    // nothing left to disclose. Keying the bucket and then guessing the key is
    // the same halfway pattern as scoping the clock but not the debt.
    const carrier = [...this.entries.values()].find(
      (e) => e.key === key && e.delivery === "pending" && e.incarnation === incarnation,
    );
    if (carrier) {
      carrier.disclose = (carrier.disclose ?? 0) + count;
      return;
    }
    const slot = tabIncarnationSlot(key, incarnation);
    this.dropped.set(slot, (this.dropped.get(slot) ?? 0) + count);
    // NO CEILING HERE, deliberately.
    //
    // This map is not payload — it is the PROMISE that a loss will be reported,
    // and it is the last record of answers whose text is already gone. Evicting
    // it on the same terms as data (as an earlier draft did, at 64 tabs) turns a
    // disclosed loss straight back into a silent one: the tab's next ask, the
    // restart gate and the fatal-exit report all lose their only trace, and the
    // log line that announced it said outright that the tab would never be told.
    // A bounded store must never be what decides whether a warning is owed.
    //
    // It cannot grow without limit anyway: one integer per PANEL TAB that has
    // stranded debt, removed by forget() when the tab goes away (which logs at
    // ERROR, the one place the promise genuinely cannot be kept) and merged by
    // moveKey() across a tab-id migration.
  }

  /**
   * Enforce the per-tab and global ceilings.
   *
   * EVICTION ORDER matters and is the same judgement #468 makes: an answer that
   * was already RETURNED to a tool result has reached a caller, so forgetting it
   * costs at most a re-ask; an ORPHANED one has reached nobody, so evicting it
   * is a real loss — those go last, are logged at ERROR, and are COUNTED so the
   * next delivery tells the agent those answers are UNDETERMINED.
   */
  private trimEntries(key: string): void {
    const evict = (scope: (e: AskEntry) => boolean, limit: number, label: string): void => {
      let mine = [...this.entries.values()].filter(scope);
      while (mine.length > limit) {
        // EVICTION ORDER, and the one decision that may forget an answer
        // QUIETLY. It keys on ACKED — the turn that carried the answer produced
        // its own marked result — never on `returned`, which says only that the
        // answer was written to a transport that may already have been
        // abandoned. That is the premise of #486, so it cannot also be the
        // licence to forget.
        //
        // Ordinary asks ARE acked (the model reads the tool result and finishes
        // its turn), so the common path stays silent and no warning cries wolf.
        // An answer whose turn never completed is precisely the #486 failure, so
        // it is counted and disclosed exactly like one that reached nobody.
        const victim =
          mine.find((e) => e.acked === true) ??
          mine.find((e) => e.returned) ??
          mine[0];
        this.entries.delete(victim.token);
        mine = mine.filter((e) => e !== victim);
        if (victim.acked === true) {
          // ANY DISCLOSURE IT WAS CARRYING is re-homed, not dropped with it: this
          // answer's own recoverability is what may be forgotten, never the debt
          // owed for EARLIER answers that reached nobody and merely happened to
          // be stamped on this entry.
          if (victim.disclose) this.noteDropped(victim.key, victim.disclose, victim.incarnation);
          logger.debug(
            `[ask-answers] ${label} — forgetting an answer to "${preview(victim.question)}" that the agent provably read`,
          );
          continue;
        }
        this.noteDropped(victim.key, 1 + (victim.disclose ?? 0), victim.incarnation);
        logger.error(
          `[ask-answers] ${label} — dropped a VALIDATED answer to "${preview(victim.question)}"${victim.returned ? " that went into a tool call whose receipt was never confirmed" : " that had reached nobody"}; the next delivery will report it as undetermined`,
        );
      }
    };
    if (key) {
      evict(
        (e) => e.key === key,
        MAX_ENTRIES_PER_KEY,
        `journal for tab ${key.slice(0, 8)} exceeded ${MAX_ENTRIES_PER_KEY} answers`,
      );
    }
    evict(() => true, MAX_ENTRIES_TOTAL, `journal exceeded ${MAX_ENTRIES_TOTAL} answers overall`);
  }
}

/** The agent-event payload a pushed (orphaned) answer becomes. */
export interface AskAnswerEvent {
  kind: "ask_answer";
  ask_question: string | null;
  ask_answer: string;
  ask_correlation: "matched" | "foreign";
  ask_answered_at: number;
  replayed?: boolean;
  possible_repeat?: boolean;
  dropped_answers?: number;
}

/** Short, log-safe rendering of a question. */
export function preview(question: string | null): string {
  if (!question) return "(an unattributed question)";
  const one = question.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 57)}…` : one;
}

/** How long a recovered answer may be presented as the result of a re-ask. */
export const ASK_RECOVER_MAX_AGE_MS = RECOVER_MAX_AGE_MS;

/** Process-wide journal (mirrors the RunCompletions singleton): the panel_ask
 *  tool opens tickets and consumes recoveries from the tool layer, while the
 *  orchestrator's bridge sink records late answers and pushes the orphans, with
 *  no ctx plumbing between them. */
export const AskAnswers = new AskAnswerJournalImpl();
