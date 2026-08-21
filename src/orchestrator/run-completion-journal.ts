// Durable-across-the-turn delivery of a render COMPLETION to the panel agent
// (issue #468).
//
// THE FAILURE. `panel_run` queues a render on the user's canvas and tells the
// agent — in so many words — "end your turn, you WILL be notified when it
// finishes". That promise is kept by exactly one mechanism: the panel's
// `agent_event` frame → PanelAgentManager.injectEvent → PanelAgent.queue. That
// path used to be fire-and-forget in three independent ways:
//
//   1. UNCORRELATED. The completion carried no run identity the orchestrator
//      ever looked at. `panel_run` learns ComfyUI's `prompt_id` (it already
//      hands it to QueueMonitor.markSelfQueued) but nothing downstream used it,
//      so a completion could not be tied to the run that was outstanding — and
//      an outstanding run could never be known to be unanswered.
//   2. SILENTLY DROPPED with no live agent. injectEvent returns false for a
//      missing/stopped agent and the caller only logged on success. Nothing
//      recorded the loss.
//   3. DIED WITH A QUEUED-BUT-UNREAD ITEM. The event is only really delivered
//      when channel() splices it into a turn. Everything before that — a
//      stop()/retire(), a stall-abandoned turn, a takePending() race — discards
//      it.
//
// AUTOMATIC GOAL CONTINUATION is what turns those windows from theoretical into
// routine. An ordinary single run ends the agent's turn and leaves it idle, so
// the completion lands in an empty queue and is drained immediately. A
// continuation keeps the agent BUSY for the whole render: the completion sits in
// `queue` (window 3) for minutes, and the continuation's own turn churn is
// exactly what fires the deferred session restarts (effort/model change,
// comfyui-MCP-env respawn) that applyPendingRestarts defers "until idle" and the
// self-restart loop — each of which tears the listener down (windows 2 and 3)
// underneath the very render whose completion is in flight.
//
// WHOSE RUN IS IT (#704). A ticket is owned by the CONVERSATION that queued it
// (the orchestrator-scoped agent key, #884), not by the panel tab it was queued
// from. The tab is an ADDRESS and it churns: a panel that reconnects re-registers
// under a new id (an unsaved workflow mints a fresh `tmp:<uuid>` every page load)
// and only a SAME-SOCKET re-hello carries the `migrated_from` that moveKey
// follows — so a reconnect used to strand the ticket under a dead id and the
// agent's OWN render came back "does NOT match any run you queued with panel_run
// — its origin is UNDETERMINED", which does not merely mislabel it: it TELLS THE
// AGENT TO DISBELIEVE A CORRECT RESULT. The conversation spans every tab and
// workflow and outlives the address, so it is the fact worth keying on.
//
// THE CONTRACT HERE.
//  • Runs are ticketed by ComfyUI's `prompt_id`, opened by `panel_run`.
//  • Every completion is CORRELATED ONCE, AT ARRIVAL, by EXACT prompt-id
//    equality against an open ticket — never by recency, never re-derived later.
//  • An uncorrelatable completion is still delivered, labelled UNDETERMINED. It
//    is never swallowed and never allowed to answer for a run it can't be proven
//    to belong to.
//  • Undelivered completions are JOURNALED and replayed at the next delivery
//    opportunity (a fresh agent spawn, a later completion for the same tab).
//  • An entry is cleared only on a positive ack — the turn that CARRIED it
//    ended. Handed to an agent that then died, it comes back and is replayed.
//
// LOCAL trust domain: this is accidental-loss bookkeeping, not a defense against
// a hostile panel. Everything is in-memory and process-scoped; an orchestrator
// restart drops the journal along with the agents it was addressing.

import { logger } from "../utils/logger.js";

/** How a completion relates to the runs this session queued. Computed ONCE, at
 *  arrival, and frozen onto the journal entry — a replay never re-correlates,
 *  so a completion can never drift onto a run that started after it landed. */
export type RunCorrelation =
  /** Exact prompt-id match with a run `panel_run` queued from this session. */
  | { status: "matched"; promptId: string }
  /** Carries a prompt id, but no run this session queued has that id. Real, but
   *  NOT ours — it must never satisfy an outstanding `panel_run`. */
  /** `priorHistory` separates the two very different facts this used to fold
   *  (#925). Both are UNDETERMINED and both are refused identically; they are
   *  not the same claim:
   *
   *    false — no run this session queued has ever carried this id. "Not yours"
   *            is a true statement.
   *    true  — this id HAS been ours: its ticket was evicted (the map is capped),
   *            or the completion was already delivered and acked, or the id was
   *            re-queued and now stands for more than one run. We have forgotten
   *            WHICH run it was, not WHETHER it was ours — and telling the agent
   *            it "does NOT match any run you queued" is then a false claim,
   *            about its own correct result. */
  | { status: "foreign"; promptId: string; priorHistory?: boolean }
  /** No prompt id at all. Unattributable in principle; reported as such. */
  | { status: "unidentified" };

/** The completion payload as it arrives from the panel (the `agent_event` frame
 *  minus the routing fields). Kept loose on purpose — the panel is free to add
 *  fields and we forward what we're given. */
export interface CompletionPayload {
  kind?: string;
  images?: Array<{ filename: string; subfolder?: string; type?: string }>;
  error?: string;
  note?: string;
  prompt_id?: string;
  [k: string]: unknown;
}

/** A run `panel_run` queued and is waiting on. */
export interface RunTicket {
  promptId: string;
  /** Panel tab the run was queued from — the run's ORIGIN ADDRESS: where its
   *  completion is expected from, which tab the injected turn pins to, and (for
   *  a caller that names no conversation) the ownership test. A proven tab-id
   *  migration moves it (moveKey) so the tab's own runs still line up. */
  tabId: string;
  /**
   * The CONVERSATION that queued this run — the agent key `orchestrator::<backend>`
   * (#884). THE ownership fact, and the one that survives (#704).
   *
   * The tab id is an ADDRESS, not an identity: a panel that reconnects re-registers
   * under a new id (an unsaved workflow mints a fresh `tmp:<uuid>` on every page
   * load), and only a SAME-SOCKET re-hello carries `migrated_from` for moveKey to
   * follow. So a reconnect stranded the ticket under a dead id and the agent's OWN
   * render came back "does NOT match any run you queued — its origin is
   * UNDETERMINED", telling it to distrust a correct result. The conversation does
   * not churn: it is the orchestrator-scoped session (one agent across every tab
   * and workflow), so "did I queue this?" is answerable across the whole gap.
   *
   * Optional only for callers that have no conversation to name (tests, a legacy
   * binding); ownership then falls back to the tab, i.e. exactly the pre-#704
   * rule. See ownsRun().
   */
  conversation?: string;
  queuedAt: number;
  toNodeId?: number;
  /**
   * Generation of THIS ticket. Bumped whenever the id is opened again (a fresh
   * ticket after the old one was evicted, or a reopen), so a completion can only
   * ever settle the exact ticket generation it was correlated against.
   *
   * Without it, `ack()` resolved the ticket by prompt id alone: run A's late
   * completion would settle whatever ticket that id maps to NOW — i.e. run B's —
   * marking B answered by A's result.
   */
  seq: number;
  /** True once a completion for this exact prompt id was acked as delivered. */
  settled: boolean;
  /**
   * This prompt id was queued MORE THAN ONCE, so it no longer identifies a
   * single run.
   *
   * Nothing on the wire distinguishes generation A's completion from
   * generation B's — the panel sends only the id — so once an id is reused, ANY
   * completion for it is genuinely unattributable. It is therefore correlated as
   * `foreign` (UNDETERMINED) rather than confidently matched, and the
   * already-delivered proofs are disabled for it: a resend may be delivered
   * twice, but B's real completion can never be suppressed as A's duplicate, and
   * A's late resend can never be presented as B's awaited result.
   */
  reused?: boolean;
}

/**
 * Does `ticket` belong to the party a completion is being reported to — the
 * conversation `conversation`, receiving it on panel tab `key`?
 *
 * ONE rule, in priority order:
 *  • BOTH sides name a conversation → the CONVERSATION decides, and the tab is
 *    irrelevant. That is what makes a run survive its tab being re-registered
 *    under a new id (#704), and it is strictly narrower than the tab rule where
 *    the two disagree: a completion landing on a tab whose backend has since
 *    changed reaches a DIFFERENT conversation, which never queued the run and is
 *    now told so instead of being handed "the run YOU queued".
 *  • EITHER side names none (tests, a legacy binding) → the pre-#704 tab rule,
 *    unchanged.
 *
 * It is never "the newest run" and never a cross-conversation match: ownership
 * still requires a ticket THIS party opened, so a render the panel queued on its
 * own (the user pressing Queue Prompt) has no ticket and stays unattributable.
 */
function ownsRun(ticket: RunTicket, key: string, conversation?: string): boolean {
  if (ticket.conversation !== undefined && conversation !== undefined) {
    return ticket.conversation === conversation;
  }
  return ticket.tabId === key;
}

export type EntryState =
  /** Waiting for a delivery attempt. */
  | "pending"
  /** Handed to a live agent; not proven consumed yet. */
  | "handed_off";

export interface JournalEntry {
  token: string;
  /** Composite agent key this completion is addressed to. An entry is only ever
   *  replayed to THIS key (moved wholesale by `moveKey` on a tab-id migration) —
   *  it is never broadcast or re-targeted. */
  key: string;
  payload: CompletionPayload;
  correlation: RunCorrelation;
  /** The conversation this completion was correlated FOR, frozen at arrival with
   *  the verdict. `ack()` re-checks ownership long after the fact and must use the
   *  same party the correlation was computed against, not whatever the tab means
   *  by then. Undefined when the caller named none (see ownsRun). */
  conversation?: string;
  arrivedAt: number;
  /** Delivery OFFERS made for this entry — including ones nothing could take.
   *  Drives the `replayed` flag ("this landed late"), which is true of a refused
   *  offer too: the completion really did fail to reach the agent when it
   *  arrived. NOT a record of what an agent was told — see `handoffs`. */
  attempts: number;
  /**
   * Offers an agent actually TOOK onto its queue.
   *
   * Distinct from `attempts`, and the distinction is load-bearing (#1327): the
   * orchestrator flushes the journal the instant a completion arrives, so a
   * render that finishes while its own `panel_run` call is still in flight gets
   * offered to an agent that cannot take it. That offer is REFUSED — it tells
   * nobody anything — yet it still counts an attempt. Anything asking "has an
   * agent been told this?" must read this counter, never `attempts`.
   *
   * Survives a release back to `pending`, which is why the question cannot be
   * answered from `state` either.
   */
  handoffs: number;
  state: EntryState;
  /** Content fingerprint — set only for ID-LESS completions, which have no run
   *  identity to dedupe on. See idlessFingerprint(). */
  fingerprint?: string;
  /** How many turns carried this completion and then ended without a provable
   *  ack. Bounds the replay loop — see release(). */
  carriedReleases?: number;
  /** ID-LESS only: an identical completion was delivered recently, so this may be
   *  the same frame re-sent. Delivered anyway (never swallowed) but FLAGGED, so
   *  the agent doesn't double-count it. */
  possibleRepeat?: boolean;
  /** This entry's prompt id was queued AGAIN while it was still undelivered, so
   *  it belongs to the older run. Still delivered, but it can no longer be merged
   *  into, settle a ticket, or memoize a delivery. */
  superseded?: boolean;
  /**
   * This entry ARRIVED while its prompt id was already known to be reused, so
   * the id cannot tell which run it belongs to.
   *
   * Stamped on the ENTRY, not read from the ticket, because tickets are
   * evictable: 64 later runs drop the `reused` ticket, `idReused` goes false,
   * and a subsequent ambiguous completion would coalesce into this one — the ack
   * of one then removing the only entry and losing the other. The entry outlives
   * the ticket, so the ambiguity does too.
   */
  ambiguousId?: boolean;
  /** Generation of the ticket this entry was MATCHED against, if any. `ack()`
   *  settles only that exact generation — see RunTicket.seq. */
  ticketSeq?: number;
  /** Evicted-completion count this entry is carrying out on the tab's behalf, so
   *  the disclosure rides a real delivery instead of a side map that could be
   *  discarded before it is ever reported. */
  disclose?: number;
}

/** Runs tracked at once. Ample for any real batch; bounded so a long session
 *  can't grow the map without limit. */
const MAX_TICKETS = 64;
/** Undelivered completions held per panel tab. */
const MAX_ENTRIES_PER_KEY = 32;
/** Undelivered completions held across ALL tabs — a global ceiling so a session
 *  that opens and abandons many tabs can't grow the journal without limit. */
const MAX_ENTRIES_TOTAL = 96;
/** (tab, run) pairs remembered as already delivered, to suppress a re-sent frame
 *  after its entry was acked and removed. Comfortably larger than MAX_TICKETS so
 *  it outlives the tickets that feed it; a resend later than THIS is delivered
 *  again, but as `foreign` — flagged UNDETERMINED, never as the awaited run. */
const MAX_DELIVERED_MEMO = 512;
/** Tabs whose evicted-completion counter is retained. */
const MAX_DROPPED_KEYS = 64;
/** Prompt ids whose ticket THIS party opened and which have since been evicted
 *  (#925). Bounded, and keyed by the same owner the ticket was keyed by, because
 *  the claim it supports is "you queued this", not "this id has been seen here"
 *  (codex). Sized to outlive the ticket map several times over. */
const MAX_FORGOTTEN_OWN_RUNS = 512;
/** How many times a completion may be CARRIED BY A TURN THAT THEN ENDED without a
 *  provable ack before the journal settles it anyway.
 *
 *  Counts turns, NOT queue hand-offs. A hand-off only means the event was queued;
 *  an agent torn down before it drained its queue never showed the text to
 *  anyone, so counting those would settle — and lose — a completion that three
 *  ordinary provider/session replacements had merely shuffled around. The only
 *  cycle that needs bounding is "dispatched into a turn → that turn ended → its
 *  result could not be proven to be its own → replay", which a backend that
 *  declares turn markers but never stamps its results would otherwise repeat
 *  forever. Each of THOSE put the completion's text into a turn the agent read,
 *  so settling risks a duplicate, never a loss. */
const MAX_CARRIED_RELEASES = 3;
/**
 * How long an identical ID-LESS completion is still worth FLAGGING as a possible
 * repeat. Content is the only evidence of sameness these have, and it is not
 * proof — ComfyUI reuses temp output names (`ComfyUI_temp_*_00001_`) after a
 * restart, so two genuinely different renders can look identical. Hence the flag
 * is all it drives: nothing here ever merges or suppresses a completion.
 */
const IDLESS_REPEAT_HINT_MS = 10 * 60_000;

/**
 * Memo key for an already-delivered run: (OWNER, prompt id, TICKET GENERATION).
 *
 * The generation is what makes this an identity rather than a guess. A prompt id
 * alone is not one — ComfyUI reuses ids, and a ticket can be evicted and
 * recreated — so a memo keyed on the id would let run A's delivery suppress run
 * B's real completion. `gen` is `RunTicket.seq`, or 0 when the owner has no
 * ticket for the id at all (an unqueued, foreign run).
 *
 * The OWNER is the same party ownership is judged against (ownsRun): the
 * CONVERSATION when one is known, else the tab. It has to be, or the memo stops
 * agreeing with the ownership rule the moment a tab id churns — a delivery
 * recorded under the old tab id would be invisible to `hasHistoryFor`, the
 * re-queued id would look like a clean identity instead of a REUSED one, and the
 * earlier generation's late completion could then be presented as the new run's
 * result (codex gate, P1).
 */
function deliveredKey(owner: string, promptId: string, gen: number): string {
  return `${owner}|${promptId}|${gen}`;
}

/** The party a run's bookkeeping is filed under — the conversation when there is
 *  one, else the panel tab. Mirrors ownsRun(): the two must never disagree. */
function ownerOf(key: string, conversation?: string): string {
  return conversation ?? key;
}

/**
 * Fingerprint for an ID-LESS completion (a panel that forwarded no `prompt_id`).
 * With no run identity, content is all we have to tell "the panel re-sent the
 * same frame" from "a second render finished": kind + note + error + the exact
 * output list. Combined with IDLESS_DEDUPE_WINDOW_MS this collapses a repeat
 * without letting a later, genuinely different render inherit the suppression.
 * Filenames are NOT sorted — the panel emits them in output order, and a
 * different order is a different batch.
 */
function idlessFingerprint(key: string, payload: CompletionPayload): string {
  const files = (payload.images ?? [])
    .map((i) => `${i.subfolder ?? ""}/${i.type ?? ""}/${i.filename}`)
    .join(",");
  return `${key}|~idless~|${payload.kind ?? ""}|${payload.note ?? ""}|${payload.error ?? ""}|${files}`;
}

export class RunCompletionJournalImpl {
  /** prompt id → ticket. Keyed globally: ComfyUI prompt ids are UUIDs, so an
   *  exact match is proof of identity on its own and survives a session's tab
   *  id being rebound between the queue and the completion. */
  private tickets = new Map<string, RunTicket>();
  /** `<owner>|<promptId>` for runs THIS party opened whose ticket was evicted.
   *  Insertion-ordered and bounded; see MAX_FORGOTTEN_OWN_RUNS (#925). */
  private forgottenOwnRuns = new Set<string>();
  /** token → entry (insertion-ordered, which is also delivery order). */
  private entries = new Map<string, JournalEntry>();
  /** (tab, run) pairs whose completion was ACKED — a bounded FIFO memo so a
   *  panel that re-sends the frame after the entry was removed can't produce a
   *  second delivery. */
  private delivered = new Set<string>();
  /** Content fingerprint → delivery time, for ID-LESS completions (which have no
   *  run identity to memoize). Bounded FIFO + a time window, so an identical
   *  re-send is suppressed but a later genuinely-different render is not. */
  private idlessSeen = new Map<string, number>();
  private seq = 0;
  /** Monotonic ticket-generation counter — see RunTicket.seq. */
  private ticketSeq = 0;

  /** The generation this party's ticket for `promptId` is currently on, or 0 when
   *  it has none. THE run identity: every proof and every merge is keyed on it,
   *  so an id reused (or a ticket evicted and recreated) can never let one run's
   *  bookkeeping answer for another's. Ownership is judged exactly as `correlate`
   *  judges it (ownsRun), or a run that correlates as ours would still be given
   *  generation 0 — "no identity" — and lose its dedupe and its ack memo. */
  private generationOf(key: string, promptId: string, conversation?: string): number {
    const ticket = this.tickets.get(promptId);
    return ticket && ownsRun(ticket, key, conversation) ? ticket.seq : 0;
  }
  /** Pull a still-queued completion back off its agent (see setRevoker). */
  private revoke: ((key: string, token: string) => boolean) | null = null;
  /** Re-deliver a tab's pending completions (after a revoke re-arms one). */
  private reflush: ((key: string) => void) | null = null;

  /**
   * Wire the "unsend" hook (#468).
   *
   * A completion's WORDING is materialized when it is queued into an agent, so a
   * correlation the journal later has to WEAKEN — a prompt id reused, a
   * conversation replaced — would still reach the agent claiming "this is the run
   * YOU queued". This lets the journal pull the stale copy back (only while it is
   * still unread) and re-deliver the honest, downgraded version. Returns whether
   * the item was actually removed.
   */
  setRevoker(revoke: (key: string, token: string) => boolean, reflush?: (key: string) => void): void {
    this.revoke = revoke;
    this.reflush = reflush ?? null;
  }

  /** Re-arm an entry whose correlation just weakened, if its already-queued copy
   *  can still be pulled back. Once the carrying turn has started the text is in
   *  the model's context and cannot be recalled — nothing to do but leave it.
   *
   *  (#1948 — with one measured exception, an interrupted turn re-queued by
   *  "send now": that copy becomes revocable again. Harmless here, and in the right
   *  direction — this path only ever replaces a claim we can no longer prove with the
   *  weaker honest one, so pulling the requeued copy back stops the agent re-reading
   *  "this is the run YOU queued" about a run we can no longer attribute. See
   *  `stillUnread` for the full reasoning.) */
  private reissueAfterDowngrade(entry: JournalEntry): void {
    if (entry.state !== "handed_off") return;
    if (!this.revoke?.(entry.key, entry.token)) return;
    entry.state = "pending";
    logger.info(
      `[run-completions] pulled a queued completion back after its correlation weakened — re-delivering it as ${describe(entry.correlation)}`,
    );
    // Re-queue it immediately with the honest wording; a revoked entry left
    // merely `pending` would wait for some unrelated later flush.
    this.reflush?.(entry.key);
  }

  /**
   * Re-deliver the entries `stillUnread` pulled back off an agent's queue (#1327).
   *
   * Called only from `openRun`, and only AFTER `bindClaimed` — the entry is not fully
   * this run's until it carries the ticket's generation, and re-queueing it at
   * generation 0 would leave `ack()` unable to prove it, so a later resend of the same
   * frame would arrive looking like a second render.
   *
   * A revoked entry left merely `pending` would sit there until some unrelated later
   * flush, which for a run whose turn is ending right now means the agent simply never
   * sees its own render — strictly worse than the wrong verdict this is correcting.
   */
  private reissueClaimed(keys: Set<string>): void {
    for (const key of keys) this.reflush?.(key);
  }

  /**
   * A NEW run has taken over `promptId`, so every completion already journaled
   * under it belongs to an OLDER run. Retire them: superseded (so they can never
   * be merged into, settle a ticket, or memoize a delivery), downgraded from
   * `matched` to `foreign` (so they stop claiming to be the run now outstanding),
   * and re-issued if their queued copy can still be pulled back and re-worded.
   *
   * Runs on BOTH openRun paths — a reopen AND a fresh ticket after the old one
   * was evicted. Only doing it on the reopen left the eviction ordering able to
   * present an older run's result as the newly queued one's.
   */
  private retireOlderEntriesFor(promptId: string, keep?: Set<JournalEntry>): void {
    for (const entry of this.entries.values()) {
      // #1327 — an entry this very dispatch produced is not an OLDER run's; retiring
      // it would immediately undo the claim above and re-report the agent's own render
      // as undetermined, which is the defect being fixed.
      if (keep?.has(entry)) continue;
      if (
        entry.correlation.status === "unidentified" ||
        entry.correlation.promptId !== promptId ||
        entry.superseded
      ) {
        continue;
      }
      entry.superseded = true;
      if (entry.correlation.status === "matched") {
        entry.correlation = { status: "foreign", promptId: entry.correlation.promptId };
      }
      logger.warn(
        `[run-completions] prompt ${promptId} was queued again while an earlier completion for it was still undelivered — the older entry is superseded (and reported as undetermined) so it can no longer answer for the new run`,
      );
      entry.ambiguousId = true; // the id now stands for more than one run
      this.reissueAfterDowngrade(entry);
    }
  }

  /** Has this party ALREADY seen a completion for this prompt id — delivered (a
   *  memo from any generation) or still journaled? If so the id is not a fresh
   *  identity, however long ago that was and whether or not its ticket survives.
   *  Both stores are bounded, so this is a small scan.
   *
   *  Scanned by tab AND by conversation: a journaled entry whose tab id has since
   *  been re-registered (the #704 gap) is still this conversation's own history,
   *  and missing it would let the re-queued id be treated as a clean identity —
   *  the exact misattribution-plus-loss the `reused` flag exists to prevent. */
  /**
   * #1327 — re-stamp any UNDELIVERED completion that this dispatch itself produced.
   *
   * Returns the entries proven to belong to the run being opened, so the caller can
   * also stop counting them as prior history for the id.
   *
   * Two conditions, both required, and both are proof rather than heuristic:
   *   • the entry ARRIVED at or after this dispatch — the prompt id did not exist
   *     before ComfyUI minted it here, so nothing earlier can legitimately carry it;
   *   • the entry has NOT been handed to an agent yet — nobody has read the wrong
   *     verdict, so correcting it changes no answer already given.
   *
   * The second is what keeps this compatible with the journal's rule that a REPLAY
   * never re-correlates. That rule exists so a delivered verdict cannot be rewritten
   * under a later run; this only ever corrects a verdict still sitting unread, and only
   * toward the run that demonstrably produced it.
   */
  private claimRaced(
    promptId: string,
    meta: { tabId: string; conversation?: string; dispatchedAt?: number },
  ): { claimed: Set<JournalEntry>; reissue: Set<string> } {
    const claimed = new Set<JournalEntry>();
    /** Keys whose queued copy was pulled back and must now be re-delivered. */
    const reissue = new Set<string>();
    // No dispatch time means no proof — do nothing rather than guess.
    if (typeof meta.dispatchedAt !== "number") return { claimed, reissue };
    for (const entry of this.entries.values()) {
      // An ID-LESS completion carries no run identity at all, so nothing can prove it
      // belongs here — it stays unidentified rather than being claimed on timing alone.
      if (entry.correlation.status === "unidentified") continue;
      if (entry.correlation.promptId !== promptId) continue;
      if (entry.arrivedAt < meta.dispatchedAt) continue;
      // Only for the party this dispatch belongs to; another tab's completion for
      // the same id is not ours to claim.
      const sameParty =
        entry.key === meta.tabId ||
        (meta.conversation !== undefined && entry.conversation === meta.conversation);
      if (!sameParty) continue;
      // NOBODY HAS BEEN TOLD YET — see stillUnread. Asked LAST, deliberately: it is
      // the only guard with a side effect (it un-queues the entry), and every check
      // above is a cheap pure refusal. Nothing is ever pulled back off an agent for a
      // claim that is then rejected on other grounds.
      if (!this.stillUnread(entry, reissue)) continue;
      claimed.add(entry);
      if (entry.correlation.status === "matched") continue;
      entry.correlation = { status: "matched", promptId };
      if (meta.conversation !== undefined) entry.conversation = meta.conversation;
      logger.info(
        `[run-completions] prompt ${promptId} completed before its ticket existed (a fast/cached run) — the journaled completion is re-attributed to the run that produced it instead of being reported as foreign`,
      );
    }
    return { claimed, reissue };
  }

  /**
   * Has this entry's verdict actually REACHED an agent yet? (#1327, second recurrence.)
   *
   * QUEUED IS NOT READ, and conflating the two is what let this defect come back.
   * The guard here used to be `handoffs > 0` — "an agent TOOK this onto its queue" —
   * resting on the stated premise that the arrival flush is REFUSED while the agent
   * sits inside the `panel_run` call that queued the render. MEASURED against the
   * real `PanelAgent`, that premise is false: `injectEvent` has no busy check at all.
   * It refuses only for an agent that is missing, stopped, or handed a payload it
   * cannot compose text for — so for the ordinary via-panel session (an agent that
   * exists and is mid-turn) the flush TAKES the completion and returns true.
   * `handoffs` was therefore already 1 when `openRun` ran, the claim was skipped on
   * precisely the race it exists to repair, and the reporter got their own render
   * back as "does NOT match any run you queued". The previous fix swapped `attempts`
   * for `handoffs`, but on the real path BOTH are 1 at that instant, so the swap
   * changed nothing production reaches — its tests passed by hard-coding a refusal
   * (`deliverPending(TAB, () => false)`) that the live agent does not perform.
   *
   * The honest question was never "was it handed over" but "has the agent READ it",
   * and this journal already owns the only thing that can answer it: the revoker
   * (#468). `revokeEvent` splices the injected item out of the agent's queue and
   * returns false once that item has been dequeued into a running turn — i.e. once
   * the text is in the model's context and can no longer be recalled.
   *
   * EXACTLY WHAT A SUCCESSFUL REVOKE PROVES (#1948), because the previous sentence
   * used to overclaim and that overclaiming is this file's whole failure history. It
   * proves the item is NOT INSIDE A LIVE TURN. That is "nobody has been told" in every
   * case but one, and the exception is measured rather than assumed:
   * `PanelAgent.interrupt({ requeueInFlight: true })` — the panel's "send now", and the
   * run-error burst in `injectRunError` — restores the aborted turn with
   * `queue.unshift(...interrupted.items)`. A `completionOnly` item that HAD been
   * dequeued is therefore back on the queue and revocable again, so `stillUnread` can
   * answer "unread" for text the backend has already been sent.
   *
   * THAT IS DELIBERATELY NOT SPECIAL-CASED, and refusing it would be the worse bug.
   * Measured end to end (run-completion-requeued-in-flight.test.ts):
   *   - refusing a requeued item leaves the entry `foreign`, so the requeued turn
   *     re-reads "does NOT match any run you queued — its origin is UNDETERMINED"
   *     about the agent's OWN render, in full, with no correction. That is precisely
   *     the harm #1327 reports;
   *   - allowing it re-attributes the entry to the run that produced it and re-queues
   *     the corrected wording, and because the re-delivery has `attempts > 0` it is
   *     flagged `replayed` — the agent is handed "(RE-DELIVERED — this completion could
   *     not be handed to you when it arrived.)", i.e. told to read it as a late
   *     re-delivery, not as a second render.
   * So the window costs at most a partially-seen line in a turn that was ABORTED
   * anyway, followed by a disclosed, correctly-attributed re-delivery — the duplicate
   * side of this journal's standing duplicate-over-loss rule. It also cannot widen the
   * claim: `claimRaced` only ever moves an entry foreign → matched, never the reverse,
   * and every ownership and timing proof still has to pass first.
   *
   * The revoke also cannot take a bystander with it. Each queued item carries only its
   * own token — the drain's batched `carriedTokens` are assigned to `inFlight`/
   * `turnEventTokens`, and the requeue restores `interrupted.items`, not one merged
   * item — so splicing the named token's item leaves every sibling completion and every
   * user message on the queue. (Pinned by test, because a future change that DID put a
   * multi-token array on a queue item would turn this splice into a silent loss.)
   *
   * Fail-closed in every direction that matters:
   *   - no revoker installed (a bare journal, a unit test) => a handed-off entry is
   *     left exactly as it is today;
   *   - the carrying turn already started, or the agent is gone => revoke returns
   *     false, and a verdict an agent was actually given is never rewritten under it;
   *   - nothing here widens WHICH completions may be claimed. Every ownership and
   *     timing proof above is untouched, so a completion that is genuinely
   *     unattributable is still reported UNDETERMINED.
   *
   * A revoked entry is off the agent's queue, so its key is recorded for the caller
   * to re-deliver. That re-delivery is deliberately NOT done here: the claim is only
   * half-applied until `bindClaimed` has given the entry the ticket's generation, and
   * re-queueing at generation 0 would resurrect the ack/settle defect that made a
   * later resend look like a second render.
   */
  private stillUnread(entry: JournalEntry, reissue: Set<string>): boolean {
    // Never offered, or offered and refused: no agent ever took the text.
    if (entry.handoffs === 0 && entry.state === "pending") return true;
    // Taken onto a queue. Only the agent can say whether it has since been read.
    if (!this.revoke?.(entry.key, entry.token)) return false;
    entry.state = "pending";
    reissue.add(entry.key);
    logger.info(
      `[run-completions] pulled a queued completion back off its agent before the carrying turn read it — it can be re-delivered as the run that produced it`,
    );
    return true;
  }

  /**
   * Bind claimed entries to the generation of the ticket that now owns them.
   *
   * The claim is otherwise only half-applied. A completion that beat its ticket was
   * journaled with generation 0 — "this tab never ticketed the id" — and `claimRaced`
   * only rewrites the VERDICT. Generation 0 is a bucket rather than an identity, so
   * `ack()` reads the entry as unprovable: it writes no delivered-memo and settles no
   * ticket. MEASURED consequence, not a theoretical one — after the agent had been
   * given the render and its turn had ended, a re-sent frame for the same run was
   * delivered a SECOND time with no `possible_repeat` flag, i.e. as though a second
   * render had happened.
   *
   * Called once the generation exists, which is why it cannot live inside
   * `claimRaced`: on the fresh-ticket path the ticket is minted after the claim.
   *
   * `ambiguousId` is deliberately left as it was. It only blocks a later completion
   * from merging into this entry, which costs an extra delivery at worst and never a
   * loss — the standing trade — so it is not worth widening the merge surface here.
   */
  private bindClaimed(claimed: Set<JournalEntry>, seq: number): void {
    for (const entry of claimed) {
      if (entry.correlation.status === "unidentified") continue;
      entry.ticketSeq = seq;
    }
  }

  private hasHistoryFor(
    key: string,
    promptId: string,
    conversation?: string,
    exclude?: Set<JournalEntry>,
  ): boolean {
    // BOTH owners: the memo may have been written under the tab (no conversation
    // known at the time, or an older entry) or under the conversation.
    const prefixes = [`${key}|${promptId}|`];
    if (conversation !== undefined) prefixes.push(`${conversation}|${promptId}|`);
    for (const memo of this.delivered) {
      if (prefixes.some((p) => memo.startsWith(p))) return true;
    }
    for (const entry of this.entries.values()) {
      if (exclude?.has(entry)) continue; // #1327 — this dispatch's own completion
      if (
        (entry.key === key ||
          (conversation !== undefined && entry.conversation === conversation)) &&
        entry.correlation.status !== "unidentified" &&
        entry.correlation.promptId === promptId
      ) {
        return true;
      }
    }
    return false;
  }

  /** `panel_run` queued a render. Returns false when ComfyUI/the panel gave us
   *  no prompt id — the caller MUST then tell the agent its completion cannot be
   *  correlated rather than promising a notification it may not be able to
   *  attribute. */
  openRun(
    promptId: string | null | undefined,
    meta: { tabId: string; conversation?: string; toNodeId?: number; dispatchedAt?: number },
  ): boolean {
    if (typeof promptId !== "string" || !promptId) return false;
    // #1327 — CLAIM THE COMPLETION THAT BEAT ITS OWN TICKET.
    //
    // A ticket cannot be opened before dispatch, because ComfyUI mints the prompt id
    // when it accepts the run. So a render that finishes faster than the reply travels
    // back — the reporter's was 0.1s, fully cached — lands here BEFORE openRun and
    // correlates against no ticket at all. It was journaled `foreign`, and the agent
    // was told its own render "does NOT match any run you queued", with an instruction
    // to go poll get_history and distrust the result.
    //
    // It also poisoned what came after: an already-journaled entry makes hasHistoryFor
    // true below, so the fresh ticket was born `reused` and EVERY later completion for
    // that id read UNDETERMINED too.
    //
    // The dispatch time settles it without guessing. The id did not exist before this
    // dispatch created it, so a completion carrying it that arrived at/after that
    // moment is necessarily this run's. Entries older than the dispatch are a genuinely
    // reused id and keep the existing ambiguity handling.
    const { claimed, reissue } = this.claimRaced(promptId, meta);
    // NOTE: no memo clearing is needed here. The delivered memo is keyed by
    // ticket GENERATION, and every path below either bumps the generation (a
    // reopen) or mints a fresh one (a new ticket), so a newly queued run's memo
    // key is unused by construction. This used to be a `delete` precisely because
    // the key was generation-blind — the structural fix removed the need.
    const existing = this.tickets.get(promptId);
    if (existing) {
      // Same prompt id queued again (a re-run of an id ComfyUI reused, or a
      // duplicate reply): reopen it rather than stacking a second ticket, so one
      // prompt id always means one run.
      existing.settled = false;
      existing.tabId = meta.tabId;
      // The REOPENING caller owns this generation of the id — including when a
      // different conversation re-queued it. (It is `reused` from here on, so
      // every completion for it reads UNDETERMINED for everyone regardless; this
      // just keeps the record honest about who queued it last.)
      if (meta.conversation !== undefined) existing.conversation = meta.conversation;
      else delete existing.conversation;
      existing.queuedAt = Date.now();
      existing.seq = ++this.ticketSeq; // a NEW generation of this id
      // The id no longer identifies ONE run. Every completion for it from here
      // on is unattributable (see RunTicket.reused) — reported UNDETERMINED, and
      // never suppressed as a duplicate of the other generation.
      existing.reused = true;
      this.bindClaimed(claimed, existing.seq);
      this.retireOlderEntriesFor(promptId, claimed);
      this.reissueClaimed(reissue);
      return true;
    }
    // A FRESH ticket is only a fresh IDENTITY if this tab has no history for the
    // id. If it does — a delivered memo from an earlier generation, or an entry
    // still journaled — then ComfyUI has REUSED the id and the ticket was merely
    // evicted in between. Nothing on the wire separates "run A's late resend"
    // from "run B's completion" in that state, so the new ticket is born
    // ambiguous: had it been treated as a clean identity, A's resend would
    // correlate as B, its ack would settle B, and B's real completion would then
    // be suppressed by B's own settled flag — misattribution AND loss.
    // #1327 — a completion this dispatch just produced is NOT prior history for the
    // id. Counting it made the ticket `reused` and turned every later completion for
    // the same run undetermined; `claimed` is exactly the set proven to be ours.
    const hasHistory =
      this.hasHistoryFor(meta.tabId, promptId, meta.conversation, claimed) || false;
    const seq = ++this.ticketSeq;
    this.tickets.set(promptId, {
      promptId,
      tabId: meta.tabId,
      ...(meta.conversation !== undefined ? { conversation: meta.conversation } : {}),
      seq,
      queuedAt: Date.now(),
      ...(typeof meta.toNodeId === "number" ? { toNodeId: meta.toNodeId } : {}),
      settled: false,
      ...(hasHistory ? { reused: true } : {}),
    });
    if (hasHistory) {
      logger.warn(
        `[run-completions] prompt ${promptId} was queued again for tab ${meta.tabId.slice(0, 8)} after its ticket had been evicted — this tab already has history for that id, so it is treated as REUSED (every completion for it reported as undetermined)`,
      );
    }
    this.bindClaimed(claimed, seq);
    // …and on THIS branch too. A fresh ticket after the old one was evicted is
    // still a NEW run for an id that already has journaled completions: without
    // this, an older `matched` entry survives untouched and goes on telling the
    // agent "this is the run YOU queued" for the id now outstanding.
    this.retireOlderEntriesFor(promptId, claimed);
    this.reissueClaimed(reissue);
    this.trimTickets();
    return true;
  }

  /**
   * Classify a completion that arrived on panel tab `key`, for conversation
   * `conversation`, against the open runs.
   *
   * TWO conditions, both required: EXACT prompt-id equality AND the ticket must
   * be OWNED by the party being reported to (ownsRun — the conversation that
   * queued it, else the tab). There is deliberately no "the newest outstanding
   * run" fallback and no cross-CONVERSATION match, because attributing a
   * completion to the wrong run — or to a conversation that never queued it — is
   * worse than not attributing it at all. Anything unowned reads as `foreign`,
   * i.e. UNDETERMINED, which is the honest answer.
   */
  correlate(key: string, payload: CompletionPayload, conversation?: string): RunCorrelation {
    const pid = typeof payload.prompt_id === "string" ? payload.prompt_id.trim() : "";
    if (!pid) return { status: "unidentified" };
    const ticket = this.tickets.get(pid);
    // A REUSED id proves nothing: the panel sends only the id, so a completion
    // for it could belong to either generation. Report it as foreign — real, but
    // UNDETERMINED — rather than claiming it is the run now outstanding.
    if (ticket && ownsRun(ticket, key, conversation) && !ticket.reused) {
      return { status: "matched", promptId: pid };
    }
    // #925 — SAY WHICH KIND OF UNDETERMINED THIS IS. The refusal is unchanged;
    // only the claim attached to it. `hasHistoryFor` answers "has this party ever
    // seen this id" from stores that deliberately outlive the ticket map (the
    // delivered-memo holds MAX_DELIVERED_MEMO pairs against MAX_TICKETS tickets),
    // which is exactly the evidence separating "never yours" from "yours, and we
    // no longer hold the ticket".
    // OWNERSHIP EVIDENCE ONLY (codex). `hasHistoryFor` answers "has this party
    // ever SEEN this id" — which is also true of a foreign completion delivered
    // here once, and of another conversation's reused ticket. Neither means "you
    // queued it", and the sentence this drives says exactly that. So the evidence
    // is narrowed to two facts that are about OUR OWN runs:
    //   • a ticket we opened and later evicted (recorded at the eviction), or
    //   • a live ticket WE own whose id was re-queued, so it now stands for more
    //     than one of our runs.
    const priorHistory =
      this.forgotOwnRun(pid, key, conversation) ||
      Boolean(ticket?.reused && ownsRun(ticket, key, conversation));
    return priorHistory
      ? { status: "foreign", promptId: pid, priorHistory: true }
      : { status: "foreign", promptId: pid };
  }

  /**
   * Journal a completion addressed to `key`. Correlation is computed here, once.
   *
   * DEDUPE, in both directions:
   *  • IDENTIFIED (matched or foreign) — collapses onto any existing undelivered
   *    entry for the same key + prompt id, and is suppressed outright once that
   *    (tab, run) has been acked. One run can never produce two deliveries,
   *    however many times the panel re-sends it.
   *  • ID-LESS — there is no run identity, so it dedupes on a CONTENT
   *    fingerprint within IDLESS_DEDUPE_WINDOW_MS. That is enough to stop a
   *    re-sent frame producing two turns (the agent double-reporting, or acting
   *    twice on one output), while a later genuinely different render — or the
   *    same content long afterwards — is still delivered.
   * NEVER returns null: a completion is always journaled and always delivered.
   * The most this does is COLLAPSE onto a twin that nobody has seen yet, or FLAG
   * one as a possible repeat. Suppression was the source of every loss this file
   * kept re-growing, because each proof it rested on is bounded and any expiry at
   * the wrong moment turned a new run's result into a discarded "duplicate".
   */
  record(
    key: string,
    payload: CompletionPayload,
    opts: { conversation?: string } = {},
  ): JournalEntry {
    const conversation = opts.conversation;
    const correlation = this.correlate(key, payload, conversation);
    let idlessRepeat = false;
    /** This id already stands for more than one run (see RunTicket.reused). */
    let idReused = false;
    /** No provable identity for this completion — see the `unprovable` note in
     *  the identified branch. Never merged into, never suppressed. */
    let idUnprovable = false;
    /** Ticket generation this completion belongs to — the run identity (0 = no
     *  ticket, i.e. a run this tab never queued). */
    let gen = 0;
    /** A completion for this run was already delivered. A LABEL, not a veto. */
    let alreadyDelivered = false;
    if (correlation.status !== "unidentified") {
      // Already DELIVERED once (its carrying turn ended, so the entry is gone).
      // A panel that re-sends the frame must not produce a second delivery — the
      // dedupe below can't see an entry that no longer exists.
      // Two independent records of "already delivered": the bounded memo, and the
      // run TICKET's own `settled` flag. The memo is FIFO-capped, so a busy tab
      // can age it out and then re-deliver a very late resend; the ticket outlives
      // it for any run this session actually queued. Either one is proof.
      const settledTicket = this.tickets.get(correlation.promptId);
      // Both proofs are DISABLED for a reused id: neither can tell which
      // generation a completion belongs to, so suppressing on them could swallow
      // the newer run's real result. A duplicate delivery (labelled UNDETERMINED)
      // is the correct trade here.
      idReused = settledTicket?.reused === true && ownsRun(settledTicket, key, conversation);
      // The memo is keyed by GENERATION, so an older run's delivery can never
      // suppress a newer one that merely reuses the id (or that got a fresh
      // ticket after the old one was evicted): different generation, different
      // key, no match.
      gen = this.generationOf(key, correlation.promptId, conversation);
      // UNPROVABLE identity — no dedupe of any kind is safe:
      //  • `reused`: the id stands for more than one run (see RunTicket.reused).
      //  • gen 0: this tab never ticketed the id, so there is NO generation to
      //    tell one such completion from another. Every foreign completion would
      //    share the key `(tab, id, 0)`, which is a bucket, not an identity —
      //    two genuinely different external renders that reuse a prompt id (a
      //    ComfyUI restart does exactly that) would merge, and the second would
      //    be suppressed outright after the first was acked.
      // Both cases fall back to the standing rule: duplicate over loss, each
      // delivered on its own and labelled UNDETERMINED.
      idUnprovable = idReused || gen === 0;
      // ALREADY-DELIVERED IS A LABEL, NEVER A VETO.
      //
      // This used to `return null` — suppressing the completion outright — and
      // that single decision produced defect after defect, because every proof it
      // rested on (the memo, the ticket's `settled` flag, the ticket's very
      // existence) is BOUNDED. Whenever one expired at the wrong moment, a
      // genuinely new run's completion was mistaken for an old one's resend and
      // swallowed: exactly the failure this whole file exists to prevent, and the
      // one the project's rules call worse than a duplicate.
      //
      // So the journal now NEVER suppresses an identified completion. It delivers
      // it FLAGGED as a possible repeat and lets the agent — which can read the
      // prompt id, see the outputs, and call get_history — decide. No expiry can
      // turn that into a loss, and the honest failure mode is a second turn
      // saying "this may be the same render", not silence.
      if (
        !idUnprovable &&
        (this.delivered.has(deliveredKey(ownerOf(key, conversation), correlation.promptId, gen)) ||
          (settledTicket?.settled === true && ownsRun(settledTicket, key, conversation)))
      ) {
        logger.info(
          `[run-completions] a completion for ${describe(correlation)} was already delivered to tab ${key.slice(0, 8)} — forwarding this one FLAGGED as a possible repeat (never suppressed)`,
        );
        alreadyDelivered = true;
      }
      // COALESCE ONLY ONTO A `pending` ENTRY. This is the correctness rule, and
      // it is deliberately a property of the TARGET'S OWN CURRENT STATE — not of
      // any history that could be evicted out from under it.
      //
      // Once an entry is `handed_off` its text is committed to a turn that will
      // ack and DELETE it. Merging a newer completion into it means the newer one
      // is never delivered: the queued turn still holds the older text, and its
      // ack removes the single shared entry. That is a loss, and it is reachable
      // by several orderings of prompt-id reuse vs. ticket eviction — chasing
      // those one at a time is how this defect kept coming back, because reuse
      // DETECTION needs the old ticket, and the ticket is evictable.
      //
      // The same predicate already governs the id-less collapse, for the same
      // reason. The `reused`/`ambiguousId` checks below are now an OPTIMISATION
      // for better wording (an ambiguous run should read as UNDETERMINED rather
      // than merge at all), never the thing correctness rests on.
      //
      // The target must ALSO be the same GENERATION. A `pending` entry from an
      // older run of the same id (its ticket evicted, the id then re-queued) is
      // still a DIFFERENT run: overwriting its payload would drop that run's
      // result and leave the survivor stamped with the wrong generation, so its
      // ack could settle neither. Same-state AND same-identity.
      for (const entry of idUnprovable ? [] : this.entries.values()) {
        if (
          entry.key === key &&
          entry.state === "pending" && // never merge into text already committed to a turn
          (entry.ticketSeq ?? 0) === gen && // …nor across run generations
          !entry.superseded && // a re-queued run never merges into the old one's entry
          !entry.ambiguousId && // nor into one that arrived under a reused id
          entry.correlation.status !== "unidentified" &&
          entry.correlation.promptId === correlation.promptId
        ) {
          // Safe by the predicate above: this entry is still `pending`, so
          // nothing of it has been committed to a turn. Freshening its payload
          // replaces a copy nobody has seen — one delivery instead of two, with
          // no possibility that an older text acks and deletes the newer news.
          entry.payload = payload;
          return entry;
        }
      }
    } else {
      const print = idlessFingerprint(key, payload);
      const now = Date.now();
      // NEVER COLLAPSE AN ID-LESS COMPLETION.
      //
      // The collapse was the last surviving suppression, and it fails for the
      // same reason all the others did — its premise is not establishable. For an
      // identified run, "a twin nobody has seen yet" is a fact: same prompt id,
      // same ticket generation. For an ID-LESS one there is no id, and ComfyUI
      // reuses temp output names (this file says exactly that a few hundred lines
      // up), so "same tab, same content, both pending, within 30s" is PRECISELY
      // the state two genuinely different renders present. Merging there deletes
      // one of them, silently.
      //
      // So every id-less completion gets its own entry. When an identical one is
      // already journaled — in ANY state — or was delivered recently, the new one
      // is FLAGGED `possible_repeat` and the agent decides. That is the same trade
      // already accepted everywhere else: a duplicate turn beats a lost render,
      // and a wording optimisation must never be load-bearing for correctness.
      const twinJournaled = [...this.entries.values()].some(
        (e) =>
          e.key === key && e.correlation.status === "unidentified" && e.fingerprint === print,
      );
      const seenAt = this.idlessSeen.get(print);
      const repeatHint = seenAt !== undefined && now - seenAt < IDLESS_REPEAT_HINT_MS;
      if (seenAt !== undefined && !repeatHint) this.idlessSeen.delete(print); // stale
      idlessRepeat = repeatHint || twinJournaled;
      if (idlessRepeat) {
        logger.info(
          `[run-completions] tab ${key.slice(0, 8)}: an id-less completion with identical content is already known — forwarding this one FLAGGED as a possible repeat (never merged, never suppressed: content is not identity)`,
        );
      }
    }
    const entry: JournalEntry = {
      token: `rc${++this.seq}`,
      key,
      payload,
      correlation,
      // Frozen WITH the verdict: ack() re-checks ownership later and must ask
      // about the same party this was correlated for.
      ...(conversation !== undefined ? { conversation } : {}),
      arrivedAt: Date.now(),
      attempts: 0,
      handoffs: 0,
      state: "pending",
      ...(correlation.status === "unidentified"
        ? { fingerprint: idlessFingerprint(key, payload) }
        : {}),
      // One flag, both paths: an identified run whose completion was already
      // delivered, or an id-less one whose content matches a recent delivery.
      ...(idlessRepeat || alreadyDelivered ? { possibleRepeat: true } : {}),
      // Freeze the ambiguity onto the entry — see JournalEntry.ambiguousId.
      ...(idUnprovable ? { ambiguousId: true } : {}),
      // …and the GENERATION this completion belongs to, for EVERY identified
      // entry (not just matched ones): it is what keeps its ack, its memo and any
      // future merge bound to this run rather than to whatever the id means later.
      ...(correlation.status !== "unidentified" ? { ticketSeq: gen } : {}),
    };
    this.entries.set(entry.token, entry);
    this.trimEntries(key);
    return entry;
  }

  /** Completions this tab lost to an eviction and has not yet been told about.
   *  Surfaced on the next delivery so a dropped completion is never silent. */
  private dropped = new Map<string, number>();

  /** Count a lost completion for a tab, bounding the map so a churn of one-off
   *  tabs can't grow it forever (the oldest unreported count is discarded — it
   *  was already logged at ERROR when it happened). */
  /**
   * Record that a completion for `key` was destroyed by an eviction, so the next
   * delivery to that tab can report it as UNDETERMINED.
   *
   * The count is stamped onto a SURVIVING entry for the same tab whenever one
   * exists — it then rides out on a real delivery and cannot be discarded. The
   * side map is only for a tab with nothing left to carry it, i.e. a tab whose
   * next delivery is hypothetical anyway; that is the only thing the bound can
   * ever discard, and it is logged.
   */
  private noteDropped(key: string, count = 1): void {
    if (count <= 0) return;
    // The carrier must be an entry `deliverPending` will actually READ — i.e. a
    // PENDING one. A handed-off entry's payload was already built and queued, so
    // stamping the count on it would attach a warning to text nobody will ever
    // see again, and `ack()` would then spend it: the eviction would be neither
    // replayed nor disclosed. With no pending entry the count goes to the side
    // map, where the next pending delivery for this tab picks it up.
    const carrier = [...this.entries.values()].find((e) => e.key === key && e.state === "pending");
    if (carrier) {
      carrier.disclose = (carrier.disclose ?? 0) + count;
      return;
    }
    this.dropped.set(key, (this.dropped.get(key) ?? 0) + count);
    while (this.dropped.size > MAX_DROPPED_KEYS) {
      const victim = this.dropped.keys().next().value;
      if (victim === undefined) break;
      const lost = this.dropped.get(victim) ?? 0;
      this.dropped.delete(victim);
      logger.error(
        `[run-completions] discarding the undelivered-completion count (${lost}) for tab ${victim.slice(0, 8)} — over ${MAX_DROPPED_KEYS} agentless tabs are tracking one; that tab will not be told`,
      );
    }
  }

  /** Entries awaiting a delivery attempt for this key, in arrival order. */
  pending(key: string): JournalEntry[] {
    const out: JournalEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.key === key && entry.state === "pending") out.push(entry);
    }
    return out;
  }

  /**
   * Deliver every pending entry for `key`, in ARRIVAL order, stopping at the
   * first refusal so a newer completion can never overtake an older one that is
   * still stuck.
   *
   * `inject` returns whether the agent TOOK the payload onto its queue — not
   * that it was read. The entry stays journaled either way; only `ack` (the turn
   * that carried it ended) removes it. That is the whole durability property:
   * hand it to an agent that then dies and it comes back here.
   *
   * NOTHING is re-correlated: the payload is stamped with the verdict frozen at
   * arrival, so a replay can never be re-attributed to a run that started later.
   */
  deliverPending(
    key: string,
    inject: (payload: CompletionPayload, token: string) => boolean,
  ): { delivered: number; blockedOn: JournalEntry | null } {
    let delivered = 0;
    for (const entry of this.pending(key)) {
      // Any completion this tab lost to an eviction rides out on the next one
      // that DOES get through, so an evicted completion is reported rather than
      // silently forgotten.
      // The tab's evicted-completion count: whatever this entry is carrying, plus
      // anything stranded in the side map from a period when the tab had no entry
      // to carry it.
      const lost = (entry.disclose ?? 0) + (this.dropped.get(key) ?? 0);
      const payload: CompletionPayload = {
        ...entry.payload,
        run_correlation: entry.correlation.status,
        // #925 — carried ALONGSIDE the status rather than as a fourth status, so
        // every existing consumer of `run_correlation` keeps working and only the
        // wording gains a case.
        ...(entry.correlation.status === "foreign" && entry.correlation.priorHistory
          ? { run_correlation_prior: true }
          : {}),
        ...(entry.correlation.status === "unidentified"
          ? {}
          : { prompt_id: entry.correlation.promptId }),
        // Second and later attempts ARE re-deliveries — say so, so the agent
        // reads a replay as "this landed late", not as another render.
        ...(entry.attempts > 0 ? { replayed: true } : {}),
        ...(lost > 0 ? { dropped_completions: lost } : {}),
        ...(entry.possibleRepeat ? { possible_repeat: true } : {}),
      };
      const handedOff = inject(payload, entry.token);
      this.noteAttempt(entry.token, handedOff);
      if (!handedOff) return { delivered, blockedOn: entry };
      if (lost > 0) {
        // CONSOLIDATE onto the entry; do NOT consider the disclosure spent yet.
        // A hand-off is not consumption: if this agent is stopped before its turn
        // runs, the entry is released and replayed, and the warning must go with
        // it. Only `ack()` — the turn that carried it having ended — clears it.
        entry.disclose = lost;
        this.dropped.delete(key);
      }
      delivered += 1;
    }
    return { delivered, blockedOn: null };
  }

  /** All still-unacked entries for a key (pending OR handed off) — diagnostics. */
  outstanding(key: string): JournalEntry[] {
    return [...this.entries.values()].filter((e) => e.key === key);
  }

  /**
   * #1789 — is this run STILL owed the completion `panel_run` promised it?
   *
   * `openRun` succeeding only proves we could RECOGNISE a completion if one
   * arrived; it never proved one WOULD. The panel's `agent_event` frame is the
   * sole producer, so every way that frame can be lost (a missed
   * `execution_success` the panel's own reconcile also missed, a muted/blinded
   * feed, a send the socket accepted and the bridge dropped, a panel unmounted
   * mid-render) ends with an open ticket that nothing will ever answer — and
   * NOTHING in this process could tell that state apart from "still rendering".
   * This predicate is what makes it nameable, so the orchestrator's own
   * /history observation can fill in (see run-completion-watchdog.ts).
   *
   * Deliberately conservative — it answers "no completion for this run has been
   * seen AT ALL", never "delivery is late":
   *  • no ticket, or a ticket whose ack already settled it ⇒ not owed;
   *  • ANY journaled entry naming this prompt id (pending OR handed off) ⇒ not
   *    owed: a completion did arrive and the journal's own replay owns it from
   *    there;
   *  • an already-acked (tab, run, generation) memo ⇒ not owed, which covers the
   *    window where the entry has been deleted but the ticket outlives it.
   * A `reused` id is NOT owed either: it stands for more than one run, so a
   * synthesised completion for it could not honestly name which one finished.
   */
  awaitingCompletion(promptId: string): RunTicket | undefined {
    const ticket = this.tickets.get(promptId);
    if (!ticket || ticket.settled || ticket.reused) return undefined;
    for (const entry of this.entries.values()) {
      if (entry.correlation.status !== "unidentified" && entry.correlation.promptId === promptId) {
        return undefined;
      }
    }
    if (this.delivered.has(deliveredKey(this.ownerOf(ticket), promptId, ticket.seq))) {
      return undefined;
    }
    return ticket;
  }

  /** Is ANY completion still undelivered anywhere? The orchestrator's
   *  self-restart gate reads this: the journal is in-memory, so restarting while
   *  an entry is outstanding would silently drop a render result the agent was
   *  promised. */
  hasOutstanding(): boolean {
    return this.entries.size > 0;
  }

  /** Every still-unacked entry, across all tabs — for the last-ditch disclosure
   *  the orchestrator makes when a fatal self-exit is about to destroy them. */
  allOutstanding(): JournalEntry[] {
    return [...this.entries.values()];
  }

  /** Record the outcome of a delivery attempt. `handedOff` true = an agent took
   *  it onto its queue (not yet proof it was read). */
  noteAttempt(token: string, handedOff: boolean): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    entry.attempts += 1;
    // …and count separately whether the offer was actually TAKEN. A refused one
    // reached no agent, so it must not answer "has this verdict been read?" — see
    // JournalEntry.handoffs (#1327).
    if (handedOff) entry.handoffs += 1;
    entry.state = handedOff ? "handed_off" : "pending";
  }

  /** The turn that CARRIED this completion ended — it genuinely reached the
   *  agent. Drop the entry and settle its run. */
  ack(token: string): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.entries.delete(token);
    // The turn that carried it ended, so any eviction disclosure it was carrying
    // has now actually reached the agent — only here is it spent. (An entry
    // evicted while still holding one passes it on; see trimEntries.)
    delete entry.disclose;
    // A SUPERSEDED entry belongs to a run whose prompt id was queued again. It
    // was still delivered (its text reached the agent), but it must not settle
    // the REOPENED ticket — that would present the old result as the new run's —
    // and must not memoize the id as delivered, which would then suppress the new
    // run's real completion.
    if (entry.superseded) return;
    if (entry.correlation.status !== "unidentified") {
      // …and do not memoize a REUSED id either. DEFENSE IN DEPTH, not a live
      // defect: `openRun` already clears the memo on every path, so no reachable
      // sequence can let a stale one suppress a later legitimate completion (and
      // therefore no test can fail on this line). It is here because writing a
      // "we already reported this run" proof about an id that stands for MORE
      // THAN ONE run is meaningless on its face, and a future caller that opens a
      // ticket without going through openRun would inherit the trap.
      const ticket = this.tickets.get(entry.correlation.promptId);
      // Only a REAL generation is a proof. Generation 0 means this tab never
      // ticketed the id, so `(tab, id, 0)` is a bucket shared by every foreign
      // completion for it — memoizing there would let one external render's
      // delivery suppress a different one that happens to reuse the id.
      const provable = (entry.ticketSeq ?? 0) > 0;
      if (provable && !(ticket?.reused === true && ownsRun(ticket, entry.key, entry.conversation))) {
        // Memoize against THIS entry's own generation, never the id's current
        // meaning: an older run's ack must not write a proof that then suppresses
        // the newer run which reused the id (or got a fresh ticket after the old
        // one was evicted).
        this.memoDelivered(
          ownerOf(entry.key, entry.conversation),
          entry.correlation.promptId,
          entry.ticketSeq ?? 0,
        );
      }
    } else if (entry.fingerprint) {
      // ID-LESS: memoize the CONTENT so a re-sent identical frame after the ack
      // doesn't produce a second turn. Windowed in record(), bounded here.
      this.idlessSeen.set(entry.fingerprint, Date.now());
      while (this.idlessSeen.size > MAX_DELIVERED_MEMO) {
        const oldest = this.idlessSeen.keys().next().value;
        if (oldest === undefined) break;
        this.idlessSeen.delete(oldest);
      }
    }
    if (entry.correlation.status === "matched") {
      const ticket = this.tickets.get(entry.correlation.promptId);
      // ONLY the exact ticket generation this entry was matched against. Looking
      // the ticket up by prompt id alone let a late completion for run A settle
      // whatever ticket that id maps to NOW — run B's — marking B answered by A's
      // result. See RunTicket.seq.
      if (ticket && ticket.seq === entry.ticketSeq) ticket.settled = true;
    }
  }

  /**
   * An agent gave a hand-off back undelivered. Re-arm it for replay.
   *
   * `carried` distinguishes the two causes, and ONLY the first is bounded:
   *  • carried: true  — a turn actually DISPATCHED with this completion in it and
   *    then ended, but its result could not be proven to be that turn's own. The
   *    agent read the text. A backend that declares turn markers yet never stamps
   *    its results would bounce the entry here on every single turn, so after
   *    MAX_CARRIED_RELEASES we settle rather than loop: a duplicate at worst.
   *  • carried: false — a teardown handed it back (agent stopped, held mail
   *    discarded, session died). NOBODY read it. These must never count toward
   *    the bound, or three ordinary provider/session replacements would settle —
   *    and lose — a completion that was only ever shuffled between queues.
   */
  release(token: string, opts: { carried?: boolean } = {}): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    if (opts.carried) {
      entry.carriedReleases = (entry.carriedReleases ?? 0) + 1;
      if (entry.carriedReleases >= MAX_CARRIED_RELEASES) {
        logger.warn(
          `[run-completions] ${describe(entry.correlation)} was carried by ${entry.carriedReleases} turns that ended without a provable ack — settling it instead of replaying again`,
        );
        this.ack(token);
        return;
      }
    }
    entry.state = "pending";
  }

  /** Move every entry AND every open run ticket from `from` onto `to` — a panel
   *  tab-id migration re-keys the agent, and both must move WITH it or a later
   *  completion for a run queued under the old id reads as foreign. This
   *  re-addresses, it never broadens: other tabs' state is untouched. */
  moveKey(from: string, to: string): void {
    if (from === to) return;
    for (const entry of this.entries.values()) {
      if (entry.key === from) entry.key = to;
    }
    for (const ticket of this.tickets.values()) {
      if (ticket.tabId === from) ticket.tabId = to;
    }
    // ALL per-tab state moves, not just the visible two. Leaving the delivered
    // memo behind would let a post-migration re-send be delivered a SECOND time
    // (its settled ticket moved, so it still correlates as matched); leaving the
    // eviction counter behind would silently swallow the "these runs are
    // undetermined" disclosure it exists to carry.
    for (const memo of [...this.delivered]) {
      if (!memo.startsWith(`${from}|`)) continue;
      this.delivered.delete(memo);
      this.delivered.add(`${to}|${memo.slice(from.length + 1)}`);
    }
    const lost = this.dropped.get(from);
    if (lost !== undefined) {
      this.dropped.delete(from);
      this.dropped.set(to, (this.dropped.get(to) ?? 0) + lost);
    }
    // The id-less content memo and every entry's fingerprint embed the tab key,
    // so they must be re-keyed too or a post-migration re-send is delivered
    // twice — the same defect as the delivered memo above.
    const fromPrefix = `${from}|~idless~|`;
    for (const [print, at] of [...this.idlessSeen]) {
      if (!print.startsWith(fromPrefix)) continue;
      this.idlessSeen.delete(print);
      this.idlessSeen.set(`${to}|~idless~|${print.slice(fromPrefix.length)}`, at);
    }
    for (const entry of this.entries.values()) {
      if (entry.fingerprint?.startsWith(fromPrefix)) {
        entry.fingerprint = `${to}|~idless~|${entry.fingerprint.slice(fromPrefix.length)}`;
      }
    }
  }

  /**
   * Drop everything belonging to a tab that will never come back — a closed tab,
   * or the workflow being switched AWAY from.
   *
   * Tickets go too, not just entries: a run queued under the old workflow that
   * finishes AFTER the switch would otherwise still `correlate` as matched (the
   * ticket map is global) and be delivered to the NEW workflow's agent as "the
   * run YOU queued". Forgetting the ticket makes that completion read as
   * foreign — i.e. UNDETERMINED — which is the honest answer.
   *
   * Logs every completion that dies unacked; a loss must never be silent.
   */
  forget(key: string): void {
    for (const [token, entry] of [...this.entries]) {
      if (entry.key !== key) continue;
      this.entries.delete(token);
      logger.warn(
        `[run-completions] dropping an undelivered completion for ${describe(entry.correlation)} — its tab (${key.slice(0, 8)}) is gone`,
      );
    }
    for (const [pid, ticket] of [...this.tickets]) {
      if (ticket.tabId === key) this.tickets.delete(pid);
    }
    // An eviction disclosure this tab was still owed dies with it — the tab is
    // gone, so there is no delivery left to carry it. Say so at ERROR rather than
    // dropping it silently: the eviction path PROMISES the loss will be reported,
    // and this is the one place that promise cannot be kept.
    const owed = this.dropped.get(key) ?? 0;
    if (owed > 0) {
      logger.error(
        `[run-completions] tab ${key.slice(0, 8)} is gone still owed a disclosure for ${owed} evicted completion(s) — it will never be told; treat those runs as UNDETERMINED`,
      );
    }
    this.dropped.delete(key);
    for (const memo of [...this.delivered]) {
      if (memo.startsWith(`${key}|`)) this.delivered.delete(memo);
    }
    for (const print of [...this.idlessSeen.keys()]) {
      if (print.startsWith(`${key}|~idless~|`)) this.idlessSeen.delete(print);
    }
  }

  /**
   * The CONVERSATION that queued this tab's outstanding runs is gone — New chat,
   * a switch to a historical session, or a workflow replaced in place.
   *
   * Drop the tab's run TICKETS but keep its journal entries. A render queued by
   * the old conversation is still real and its completion is still delivered;
   * it just can no longer be introduced to the replacement agent as "the run YOU
   * queued" — it correlates as foreign, i.e. UNDETERMINED. Entries that already
   * arrived keep the verdict frozen at THEIR arrival, so a completion the old
   * conversation was owed is still reported to it correctly if it is still
   * deliverable.
   *
   * A TICKET is closed when the ending party OWNS it — the same predicate that
   * decides a match (ownsRun), which is the whole rule: whatever this party could
   * be told is "the run YOU queued" it can also end, and nothing else.
   *  • It reaches a ticket whose tab was re-registered under a new id on a
   *    reconnect (#704) and is therefore in NO member-tab sweep. That matters
   *    because the replacement conversation reuses the same key string
   *    (`orchestrator::<backend>`), so only DELETING the ticket ends ownership.
   *  • It does NOT delete another conversation's ticket that merely shares this
   *    tab. Closing by tab as well looked like the safe direction, but it is the
   *    #704 failure in miniature: claude queues on tab T, T switches to codex, a
   *    codex New chat runs — and claude's own render would come back UNDETERMINED
   *    (adversarial gate, round 2).
   *
   * ENTRIES are different and keep the tab arm: an entry is ADDRESSED to a tab
   * and will be handed to whichever conversation serves that tab at flush time,
   * so one addressed to a swept tab must lose its "YOUR run" claim regardless of
   * who queued it.
   */
  closeRuns(key: string, conversation?: string): void {
    for (const [pid, ticket] of [...this.tickets]) {
      if (ownsRun(ticket, key, conversation)) this.tickets.delete(pid);
    }
    // Entries still undelivered were addressed to the conversation that just
    // went away, so their `matched` verdict no longer holds for whoever receives
    // them next: DOWNGRADE to foreign. This does not violate "correlated once at
    // arrival" — a correlation may only ever get WEAKER (matched → foreign),
    // never stronger, and only in response to an explicit "that conversation is
    // gone" event. Without it a completion journaled before New chat would be
    // replayed to the replacement agent as "the run YOU queued".
    for (const entry of this.entries.values()) {
      const mine =
        entry.key === key ||
        (conversation !== undefined && entry.conversation === conversation);
      if (mine && entry.correlation.status === "matched") {
        entry.correlation = { status: "foreign", promptId: entry.correlation.promptId };
        // Same as the reused-id downgrade: the queued copy still claims to be the
        // run this (now-replaced) conversation queued. Recall it if we still can.
        this.reissueAfterDowngrade(entry);
      }
    }
  }

  /** Remember (tab, run) as already reported, so a later re-send of the same
   *  frame is suppressed rather than delivered a second time. Bounded FIFO; the
   *  run TICKET's `settled` flag is the other record, and an evicted settled
   *  ticket feeds this one so neither expires before the other. */
  private memoDelivered(key: string, promptId: string, gen: number): void {
    this.delivered.add(deliveredKey(key, promptId, gen));
    while (this.delivered.size > MAX_DELIVERED_MEMO) {
      const oldest = this.delivered.values().next().value;
      if (oldest === undefined) break;
      this.delivered.delete(oldest);
    }
  }

  /** Test/diagnostic helpers. */
  ticketFor(promptId: string): RunTicket | undefined {
    return this.tickets.get(promptId);
  }
  reset(): void {
    this.tickets.clear();
    this.entries.clear();
    this.dropped.clear();
    this.delivered.clear();
    this.idlessSeen.clear();
    this.forgottenOwnRuns.clear();
    this.seq = 0;
  }
  /** Evicted completions this tab has not been told about yet — wherever the
   *  count currently lives (riding an entry, or the agentless side map). */
  droppedFor(key: string): number {
    const carried = [...this.entries.values()]
      .filter((e) => e.key === key)
      .reduce((n, e) => n + (e.disclose ?? 0), 0);
    return carried + (this.dropped.get(key) ?? 0);
  }

  /** The owner a ticket is keyed by, mirroring ownsRun(): the conversation when
   *  there is one, else the tab. */
  private ownerOf(ticket: RunTicket): string {
    return ticket.conversation !== undefined ? ticket.conversation : ticket.tabId;
  }

  /** #925 — remember that a run WE opened has been forgotten, so a later
   *  completion for it can be told apart from one this session never queued. */
  private noteForgottenOwnRun(ticket: RunTicket): void {
    this.forgottenOwnRuns.add(`${this.ownerOf(ticket)}|${ticket.promptId}`);
    while (this.forgottenOwnRuns.size > MAX_FORGOTTEN_OWN_RUNS) {
      const oldest = this.forgottenOwnRuns.values().next().value;
      if (oldest === undefined) break;
      this.forgottenOwnRuns.delete(oldest);
    }
  }

  /** Did this party open a ticket for `pid` that has since been evicted? */
  private forgotOwnRun(pid: string, key: string, conversation?: string): boolean {
    if (conversation !== undefined && this.forgottenOwnRuns.has(`${conversation}|${pid}`)) {
      return true;
    }
    return this.forgottenOwnRuns.has(`${key}|${pid}`);
  }

  private trimTickets(): void {
    while (this.tickets.size > MAX_TICKETS) {
      // Prefer evicting a settled ticket; otherwise the oldest. An evicted OPEN
      // ticket means a later completion for it correlates as "foreign" — i.e.
      // UNDETERMINED, which is the honest reading once we've forgotten the run.
      let victim: string | null = null;
      for (const [pid, t] of this.tickets) {
        if (t.settled) {
          victim = pid;
          break;
        }
      }
      if (!victim) victim = this.tickets.keys().next().value ?? null;
      if (!victim) return;
      // Evicting a SETTLED ticket does not lose the "already reported" proof:
      // ack() writes it to the delivered memo at the same moment it sets
      // `settled`, and MAX_DELIVERED_MEMO is deliberately far larger than
      // MAX_TICKETS so the memo always outlives the ticket that mirrors it.
      // #925 — RECORD THAT IT WAS OURS ON THE WAY OUT. This is the last moment
      // the ownership is still known: once the ticket is gone, a later completion
      // for the id is indistinguishable from a run this session never queued, and
      // reporting it as such is the false claim this fixes.
      const evicted = this.tickets.get(victim);
      if (evicted) this.noteForgottenOwnRun(evicted);
      this.tickets.delete(victim);
    }
  }

  /**
   * Enforce the per-tab and global ceilings.
   *
   * EVICTION ORDER matters: an entry already HANDED OFF is sitting in a live
   * agent's queue and will most likely be read, so it is the cheapest thing to
   * forget; a still-PENDING entry has reached nobody, so evicting one is a real
   * loss. Pending entries are therefore evicted last, logged at ERROR, and
   * COUNTED — the count rides out on the next completion that does get through
   * (`dropped_completions`), so the agent is told those runs are undetermined
   * instead of the loss being silent.
   */
  private trimEntries(key: string): void {
    const evict = (scope: (e: JournalEntry) => boolean, limit: number, label: string): void => {
      let mine = [...this.entries.values()].filter(scope);
      while (mine.length > limit) {
        // Prefer an already-handed-off entry: it is at least sitting in a live
        // agent's queue, so it is the likeliest to land anyway. But a hand-off is
        // explicitly NOT proof of consumption, so an evicted hand-off is counted
        // and reported exactly like an evicted pending one — evicting it removes
        // our ability to replay it if that agent dies first.
        const victim = mine.find((e) => e.state === "handed_off") ?? mine[0];
        this.entries.delete(victim.token);
        mine = mine.filter((e) => e !== victim);
        // …and PULL ITS QUEUED COPY with it. The journal's cap bounds the
        // journal; the agent's queue owns the actual payload, so evicting the
        // record alone left the text queued forever. A panel resending in a tight
        // loop would then grow that queue without limit while the journal stayed
        // at 32 — and the whole backlog drains into ONE turn, which is how the
        // genuine completion gets starved. Revoking keeps the two bounded
        // together. (No-op while the carrying turn is live; that copy is already
        // committed and is bounded by the turn instead. It stops being a no-op if
        // that turn is interrupted and re-queued — #1948 — which is the direction
        // this cap wants anyway: the copy is back on the queue it exists to bound,
        // and the drop is already counted and disclosed via `dropped_completions`.)
        this.revoke?.(victim.key, victim.token);
        // Its own loss PLUS any disclosure it was carrying for the tab — moved to
        // whatever survives, so an eviction can never drop the disclosure itself.
        this.noteDropped(victim.key, 1 + (victim.disclose ?? 0));
        logger.error(
          `[run-completions] ${label} — dropped a ${victim.state === "pending" ? "still-undelivered" : "handed-off-but-unconfirmed"} completion for ${describe(victim.correlation)}; the next delivery will report it as undetermined`,
        );
      }
    };
    evict(
      (e) => e.key === key,
      MAX_ENTRIES_PER_KEY,
      `journal for tab ${key.slice(0, 8)} exceeded ${MAX_ENTRIES_PER_KEY} undelivered completions`,
    );
    evict(() => true, MAX_ENTRIES_TOTAL, `journal exceeded ${MAX_ENTRIES_TOTAL} undelivered completions overall`);
  }
}

/** Short human label for a correlation, for logs. */
export function describe(correlation: RunCorrelation): string {
  return correlation.status === "unidentified"
    ? "an unidentified run"
    : `${correlation.status === "matched" ? "run" : "foreign run"} ${correlation.promptId}`;
}

/** Process-wide journal (mirrors the QueueMonitor singleton): `panel_run` opens
 *  tickets from the tool layer while the orchestrator's panel-event handler
 *  records and replays completions, with no ctx plumbing between them. */
export const RunCompletions = new RunCompletionJournalImpl();
