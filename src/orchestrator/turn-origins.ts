// #884 — TURN ORIGINS: which tab/workflow a shared conversation's CURRENT TURN
// was issued from, and therefore where its tool calls route and what workflow
// uuid its mutations are stamped with.
//
// One agent session spans every tab and workflow (the owner-stated invariant),
// so the tab id is only a ROUTING target — and mid-turn it must be the tab the
// turn was ISSUED from, never "whatever tab is active now" (a queued message
// from another tab moves last-active immediately, which is how a running turn's
// mutations were silently re-aimed — the P0 this machinery exists to prevent).
//
// This module owns the whole per-conversation origin state so the behavior is
// testable at the production seam (confirming gate 3, P2: the previous coverage
// asserted source strings against index.ts and could not fail):
//   - per-mid issue-time origins (recorded at receipt, applied at DEQUEUE);
//   - the dispatch-batch aggregation (one turn may batch several messages; only
//     an AGREEING batch pins/stamps — mixed or unknown fails closed);
//   - the turn-target pin + issue-time stamp + last-established origin;
//   - the explicit-repin recovery and the scope target resolver the UiBridge
//     consults (built here so tests drive the REAL handlers, not test stand-ins).
//
// BACKEND-BOUND ORIGINS (confirming gate 3, P0): every recorded origin carries
// the backend its tab belonged to when the origin was minted, and it is
// re-verified when the origin is APPLIED (dequeue / inheritance / repin). A tab
// that switched provider between mint and apply — tab A moves Claude→Codex
// while a queued Claude event still names A — must fail the turn closed, never
// hand the old conversation a tab that now belongs to another backend's
// conversation (the workflow fence alone cannot catch this: A's workflow uuid
// is unchanged, so the stamp would pass).

import { randomUUID } from "node:crypto";
import { shortTabId } from "../services/session-scope.js";

export interface TurnOriginDeps {
  /** The backend a panel tab is CURRENTLY on (live tabBackends lookup). */
  backendForTab: (tabId: string) => string;
  /** The backend half of a composite agent key (`orchestrator::<backend>`). */
  backendOfKey: (key: string) => string;
  /** The trusted per-tab command workflow uuid (issue-time stamp source). */
  uuidOfTab: (tabId: string) => string | undefined;
  /** The LIVE tab id a (possibly retired/aliased) tab id currently ROUTES to
   *  (UiBridge.liveTabIdFor), or undefined when nothing resolves. The
   *  provider-switch pin invalidation judges a pin by where it routes: the
   *  bridge path-compresses migration chains (A→B then B→C rewrites A→C), so
   *  a pin can name an id no single hello ever reported as migrated_from and
   *  still resolve onto the switched tab (codex gate 4). Optional only for
   *  lightweight test trackers; production always wires it. */
  liveTabOf?: (tabId: string) => string | undefined;
  warn: (msg: string) => void;
}

interface MidOrigin {
  uuid: string | undefined;
  tab: string;
  /** The backend `tab` belonged to when this origin was recorded — verified
   *  again at dequeue (confirming gate 3, P0). */
  backend: string;
}

interface PendingBatch {
  known: Array<string | undefined>;
  /** Origin tab ids AS RECORDED — the pin keeps this identity, and the bridge
   *  resolves it onward through any migration alias. */
  tabs: Set<string>;
  /** The same origins resolved to the tab they ROUTE TO today. Ambiguity is
   *  judged on THIS set, so a save's tmp:→wf: rename does not read as two
   *  workflows (see onSeen). */
  routes: Set<string>;
  unknown: boolean;
}

export class TurnOriginTracker {
  // The issue-time origin RIDES the message and is applied when the agent
  // DEQUEUES it (onSeen — the true start of its turn), not at receipt: a
  // message queued behind a busy turn, or held during a render, must not flip
  // the IN-FLIGHT turn's stamp the moment it arrives (codex round 2, P0).
  // Bounded: entries are consumed at dequeue and dropped on cancel; the cap is
  // a last-resort ceiling sized so it is effectively unreachable by live
  // queued messages (codex r3: evicting a LIVE mapping discards fail-closed
  // state — and even then, an unknown mid at dequeue fails the batch closed
  // rather than inheriting a stale stamp).
  private readonly turnUuidByMid = new Map<string, MidOrigin>();
  private static readonly TURN_UUID_BY_MID_CAP = 5000;

  // Mids already APPLIED at a previous dequeue, WITH the origin they applied.
  // "Applied" deliberately does NOT mean "origin-less" (independent gate on
  // gate 3, P0-2): a re-queued item (interrupt + send-now restores the
  // original queue items, so its mid fires onSeen again) still HAS an origin —
  // the request is still about the workflow it was issued from. It therefore
  // RE-CONTRIBUTES that origin at every dequeue: alone, its re-run pins its
  // own tab again; merged with another tab's message, the batch is genuinely
  // MIXED and fails closed. The previous design ("contributes nothing") let
  // send-now launder a mixed batch — A's re-queued item contributed no origin,
  // so the merged A+B turn was pinned and stamped entirely to B, and A's
  // requested edit landed on B's graph.
  //
  // A `null` origin marks a deliberately ORIGIN-LESS injected turn
  // (mintInheritedOrigin — e.g. a coalesced download_done, which has no
  // originating tab and must INHERIT the conversation's last established
  // origin at batch close). A genuinely unknown mid (evicted, foreign) still
  // fails the batch closed.
  private readonly appliedTurnMids = new Map<string, MidOrigin | null>();
  private static readonly APPLIED_TURN_MIDS_CAP = 500;

  // Per-key aggregation of ONE dispatch batch's issue-time origins (the manager
  // fires onSeen synchronously per item; the microtask closes the batch before
  // any backend I/O can run a tool call).
  private readonly pendingBatchStamp = new Map<string, PendingBatch>();

  // PER CONVERSATION, the trusted workflow uuid of the workflow its CURRENT
  // TURN was issued for. This is what a scope-addressed command is STAMPED
  // with: #570's issue-time rule at conversation level — never re-resolved
  // from whatever tab happens to be active at dispatch (codex round 1, P0).
  private readonly lastTurnUuidByKey = new Map<string, string | undefined>();

  // Each conversation's IN-FLIGHT turn is PINNED to the tab it was issued
  // from, set at batch close and cleared at turn end. Value string = pinned
  // tab; null = ambiguous origin (refuse); absent = no turn in flight
  // (active-tab resolution).
  private readonly turnTargetTabByKey = new Map<string, string | null>();

  // Each conversation's LAST ESTABLISHED origin (the tab+uuid its most recent
  // origin-bearing turn agreed on). Origin-less turns inherit THIS, never the
  // active tab (confirming gate 2, P0) — re-verified against the tab's CURRENT
  // backend at inheritance time (confirming gate 3, P0). Written ONLY at batch
  // close (a MESSAGE origin the turn agreed on) and deleted at conversation
  // boundaries — deliberately NOT by the explicit repin recovery, whose target
  // is a mid-turn re-aim of the CURRENT turn, not a message origin: letting it
  // feed inheritance let a dying pre-rewind turn's late recovery re-establish
  // an inheritance source the rewind boundary had just cleared (codex delta
  // review, P1).
  private readonly lastOriginByKey = new Map<string, { tab: string; uuid: string | undefined }>();

  constructor(private readonly deps: TurnOriginDeps) {}

  /** Record a message's issue-time origin, keyed by its mid, to be applied at
   *  dequeue. Captures the tab's backend NOW so the application can verify the
   *  tab still belongs to the same conversation then. */
  recordForMid(mid: string, uuid: string | undefined, tab: string): void {
    this.turnUuidByMid.set(mid, { uuid, tab, backend: this.deps.backendForTab(tab) });
    while (this.turnUuidByMid.size > TurnOriginTracker.TURN_UUID_BY_MID_CAP) {
      const oldest = this.turnUuidByMid.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.turnUuidByMid.delete(oldest);
    }
  }

  /** Origin for an orchestrator-side INJECTED turn (run errors, completions,
   *  ask answers, panel events): a synthetic mid rides the queue item so the
   *  dequeue fires onSeen and the injected turn pins/stamps like any user turn
   *  (a run error on tab A must pin A — confirming gate 2, P0). */
  mintInjectionOrigin(originTab: string): string {
    const mid = `evt-${randomUUID()}`;
    this.recordForMid(mid, this.deps.uuidOfTab(originTab), originTab);
    return mid;
  }

  /** Origin for an injected turn that HAS no originating tab (a coalesced
   *  download_done — its row names the owning conversation, not a tab). The
   *  minted mid contributes nothing to its batch WITHOUT poisoning it, so the
   *  batch closes with zero origins and the turn INHERITS the conversation's
   *  last established origin — or refuses when there is none. Without a mid
   *  the dequeue fires no onSeen at all, no batch ever opens, and the turn
   *  routes to whatever tab is active (confirming gate 3, P1: the inherit
   *  branch was unreachable for the very case it documents). */
  mintInheritedOrigin(): string {
    const mid = `evt-${randomUUID()}`;
    this.noteAppliedTurnMid(mid, null);
    return mid;
  }

  /** A still-queued message was cancelled and REMOVED — its origin dies with it
   *  so the bounded maps only ever hold live queued messages (codex r3/r4). A
   *  RE-QUEUED item can be cancelled too, so the applied record goes with it. */
  cancelMid(mid: string): void {
    this.turnUuidByMid.delete(mid);
    this.appliedTurnMids.delete(mid);
  }

  private noteAppliedTurnMid(mid: string, origin: MidOrigin | null): void {
    this.appliedTurnMids.set(mid, origin);
    while (this.appliedTurnMids.size > TurnOriginTracker.APPLIED_TURN_MIDS_CAP) {
      const oldest = this.appliedTurnMids.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.appliedTurnMids.delete(oldest);
    }
  }

  /**
   * The agent dequeued a message — the true start of its turn. One dispatch may
   * batch SEVERAL messages: the batch's origins aggregate over a microtask and
   * pin/stamp only when they AGREE — a mixed or unknown-origin batch fails
   * closed (undefined stamp, null pin) instead of letting the last message
   * re-aim the whole turn's mutations (codex rounds 2–3). A batch with NO
   * origin contribution inherits the conversation's last established origin.
   */
  onSeen(key: string, mid: string): void {
    let batch = this.pendingBatchStamp.get(key);
    const opensBatch = !batch;
    if (!batch) {
      batch = { known: [], tabs: new Set<string>(), routes: new Set<string>(), unknown: false };
      this.pendingBatchStamp.set(key, batch);
    }
    // A mid's origin comes from the LIVE record (first dequeue) or the APPLIED
    // record (a re-queued item — interrupt + send-now restores the original
    // queue items, so the same mid dequeues again). BOTH contribute: a
    // re-queued request is still about the workflow it was issued from, so its
    // re-run alone re-pins its own tab, and a batch merging it with another
    // tab's message is genuinely MIXED and fails closed — the previous
    // contributes-nothing treatment let send-now launder a mixed A+B batch
    // entirely onto B (independent gate on gate 3, P0-2). An applied `null`
    // marks a deliberately origin-less injected turn (contributes nothing;
    // inherits at batch close).
    const rec = this.turnUuidByMid.get(mid) ?? this.appliedTurnMids.get(mid);
    if (rec) {
      // BACKEND-BOUND (confirming gate 3, P0): the origin must still belong to
      // THIS conversation's backend — both as recorded at mint AND as the tab
      // stands now. A tab that switched provider in between (Claude→Codex on A
      // while a queued Claude event still names A) fails the batch closed: the
      // workflow fence cannot catch it (A's uuid is unchanged), and inheriting
      // would hand this conversation a tab that now belongs to another one.
      const backend = this.deps.backendOfKey(key);
      // Judge ownership on the tab the origin ROUTES to today, not on the id it
      // was minted under — the same view resolvedPinOf() uses. A same-socket
      // migration (A→B: a workflow switch, a save, tmp:→wf:) moves the backend
      // mapping to B and deletes A, so asking backendForTab(A) returns the
      // DEFAULT backend and a perfectly healthy Codex turn requeued after such a
      // migration was judged foreign and wedged until explicit recovery
      // (independent gate on gate 4, P1 — a false refusal, not a leak). When the
      // origin resolves nowhere at all we keep the strict reading: unprovable
      // ownership still fails closed.
      const liveOrigin = this.deps.liveTabOf ? (this.deps.liveTabOf(rec.tab) ?? rec.tab) : rec.tab;
      if (rec.backend !== backend || this.deps.backendForTab(liveOrigin) !== backend) {
        // Dropped from BOTH maps: a re-queue of this item must fail closed
        // again (unknown), not silently inherit the last established origin.
        this.turnUuidByMid.delete(mid);
        this.appliedTurnMids.delete(mid);
        batch.unknown = true;
        this.deps.warn(
          `[panel-orchestrator] ${key} dequeued a message whose origin tab ${rec.tab.slice(0, 8)} ` +
            `no longer belongs to this conversation's backend (recorded ${rec.backend}, tab now ` +
            `${this.deps.backendForTab(rec.tab)}) — the turn FAILS CLOSED rather than pinning a ` +
            `tab another backend's conversation owns (#884 confirming gate 3)`,
        );
      } else {
        batch.known.push(rec.uuid);
        // TWO sets, because the pin and the ambiguity test want different things.
        //
        // The PIN keeps the id as RECORDED — the bridge resolves it onward through
        // any migration alias, which is the existing contract (gate 4, P1).
        //
        // AMBIGUITY is judged on where the origins ROUTE, via the same `liveOrigin`
        // the ownership check above already uses, and for the same reason. A
        // same-socket migration (a workflow switch, a save, tmp:→wf:) rewrites the
        // tab's id, so two messages issued from ONE tab either side of a save
        // arrive carrying DIFFERENT ids. Counting those made the set size 2 and
        // declared a single-tab turn a mixed-origin batch — routing and mutations
        // then failed closed with "issued from multiple workflows at once", naming
        // two entries that are the same workflow (observed live on mcp 0.50.14 /
        // panel 0.11.44: one tmp: and one wf: banner, both titled "Untitled
        // 2026-08-07 14-21-08").
        //
        // That is the FALSE REFUSAL the block above fixed for backend ownership and
        // left in place for the tab count, a few lines apart. liveTabIdFor path-
        // compresses every historical alias onto the newest live id, so genuinely
        // distinct tabs still resolve distinctly and a real mixed batch still fails
        // closed — only the aliases of ONE tab collapse.
        batch.tabs.add(rec.tab);
        batch.routes.add(liveOrigin);
        this.turnUuidByMid.delete(mid);
        this.noteAppliedTurnMid(mid, rec); // keeps its origin for a re-queue
      }
    } else if (!this.appliedTurnMids.has(mid)) {
      // Unknown mid (evicted / foreign): its origin workflow cannot be known —
      // the batch must fail closed, never inherit a stale stamp.
      batch.unknown = true;
    }
    // An applied-null mid (a deliberately origin-less injected turn)
    // contributes nothing and inherits at the batch close below.
    if (opensBatch) {
      const closed = batch;
      queueMicrotask(() => {
        this.pendingBatchStamp.delete(key);
        const distinct = new Set(closed.known);
        if (closed.unknown || closed.routes.size > 1) {
          // Mixed/unknown-TAB batch: no single stamp or target is honest for
          // it — fail BOTH closed (the bridge refuses routing; the panel fence
          // refuses mutations) until an explicit target or the next
          // single-origin message.
          this.lastTurnUuidByKey.set(key, undefined);
          this.turnTargetTabByKey.set(key, null);
          this.deps.warn(
            `[panel-orchestrator] ${key} dispatched a mixed/unknown-origin batch — no single workflow stamp/target is honest for it, so scope routing and graph mutations FAIL CLOSED until the agent opens/pins a workflow or the next single-origin message (#884)`,
          );
        } else if (closed.routes.size === 1) {
          // TURN-TARGET PIN (confirming gate P0): this turn's tool calls route
          // to the tab the turn was ISSUED from — never re-resolved mid-turn —
          // and its mutations are fenced to that tab's issue-time workflow.
          // This agreed origin becomes the conversation's LAST ESTABLISHED
          // origin for origin-less turns that follow.
          const tab = closed.tabs.values().next().value as string;
          const uuid = distinct.size === 1 ? distinct.values().next().value : undefined;
          this.lastTurnUuidByKey.set(key, uuid);
          this.turnTargetTabByKey.set(key, tab);
          this.lastOriginByKey.set(key, { tab, uuid });
        } else {
          // NO origin contribution (a deliberately origin-less injected turn
          // such as a coalesced download_done — re-queued items now contribute
          // their own origin, see appliedTurnMids): the turn inherits the
          // conversation's LAST ESTABLISHED origin — NEVER "whatever tab is
          // active" (confirming gate 2, P0). The inherited tab must STILL
          // belong to this conversation's backend (confirming gate 3, P0); no
          // established/valid origin at all → refuse.
          const last = this.lastOriginByKey.get(key);
          if (last && this.deps.backendForTab(last.tab) === this.deps.backendOfKey(key)) {
            this.lastTurnUuidByKey.set(key, last.uuid);
            this.turnTargetTabByKey.set(key, last.tab);
          } else {
            this.lastTurnUuidByKey.set(key, undefined);
            this.turnTargetTabByKey.set(key, null);
            this.deps.warn(
              last
                ? `[panel-orchestrator] ${key} dispatched an origin-less turn whose last established origin tab ${last.tab.slice(0, 8)} now belongs to another backend's conversation — scope routing FAILS CLOSED until an explicit target or an origin-bearing message (#884 confirming gate 3)`
                : `[panel-orchestrator] ${key} dispatched a turn with no origin and no established prior origin — scope routing FAILS CLOSED until an explicit target or an origin-bearing message (#884)`,
            );
          }
        }
      });
    }
  }

  /** The turn ended: release its routing pin so idle-time scope resolution
   *  follows the active tab again (the next turn re-pins). */
  turnEnded(key: string): void {
    this.turnTargetTabByKey.delete(key);
  }

  /**
   * A tab changed provider. Any conversation whose IN-FLIGHT turn is pinned to
   * this tab and whose backend no longer matches the tab's fails closed NOW
   * (null pin, undefined stamp — the mixed-batch treatment): the dequeue-time
   * verification closed the pre-dequeue door, and this closes the post-dequeue
   * one (independent gate on gate 3, P0-1) — a pin must be INVALIDATED when
   * its tab's ownership changes, not merely validated when it is set. Without
   * this, a Claude turn running on tab A kept its pin after A joined Codex
   * (nothing re-checks a live pin at resolution, and the workflow uuid is
   * unchanged by a provider switch, so the stamp still passed): a late Claude
   * mutation landed on a tab the Codex conversation now owns. Routing refuses
   * loudly until an explicit target or the next origin-bearing message.
   */
  tabChangedBackend(tab: string): void {
    const backend = this.deps.backendForTab(tab); // the tab's NEW backend
    // Judge each pin by where it ROUTES, not by the id it carries: a pin may
    // name a retired PREDECESSOR id of this browser surface (a same-socket
    // re-hello renames the tab; the bridge PATH-COMPRESSES the alias chain, so
    // after A→B then B→C a pin naming A resolves straight onto C without any
    // single hello ever reporting A as migrated_from — codex gate 4). The
    // bridge's own resolution is the one authority on that routing.
    for (const [key, pin] of this.turnTargetTabByKey) {
      if (typeof pin !== "string") continue;
      const routesTo = this.deps.liveTabOf ? this.deps.liveTabOf(pin) : pin;
      if (routesTo === tab && this.deps.backendOfKey(key) !== backend) {
        this.turnTargetTabByKey.set(key, null);
        this.lastTurnUuidByKey.set(key, undefined);
        this.deps.warn(
          `[panel-orchestrator] ${key}'s in-flight turn was pinned to tab ${pin.slice(0, 8)} ` +
            `(routing to ${tab.slice(0, 8)}), which just switched to the ${backend} ` +
            `conversation — scope routing and graph mutations FAIL CLOSED until an explicit ` +
            `target or the next origin-bearing message (#884 gate-3 confirm, P0)`,
        );
      }
    }
  }

  /** A conversation boundary (New chat / resume switch): the replaced
   *  conversation's issue-time stamp, turn pin AND last established origin die
   *  with it. The origin must go too (codex gate-3 confirm, P1): the inherit
   *  path re-establishes pin+stamp from it, so leaving it behind would let an
   *  origin-less turn (a download completing right after the boundary)
   *  resurrect the very binding the boundary just deleted. */
  forgetConversation(key: string): void {
    this.lastTurnUuidByKey.delete(key);
    this.turnTargetTabByKey.delete(key);
    this.lastOriginByKey.delete(key);
  }

  /** A rewind dropped the branch that established this conversation's stamp
   *  AND its last origin; the edited message that follows re-establishes both
   *  at its own dequeue (codex r2). Until then an origin-less turn REFUSES
   *  (null pin) rather than inheriting the dropped branch's origin — the
   *  rewind's whole point is that the dropped branch's bindings must not
   *  outlive it (codex gate-3 confirm, P1: the agent stays LIVE across a
   *  rewind, so a download_done landing before the edited message would have
   *  re-pinned the dropped branch's tab and resurrected its deleted stamp). */
  dropBranch(key: string): void {
    this.lastTurnUuidByKey.delete(key);
    this.lastOriginByKey.delete(key);
  }

  /** The in-flight turn's routing pin: string = pinned tab; null = ambiguous
   *  origin (refuse loudly); undefined = no turn in flight (active-tab
   *  resolution applies). Raw state — ROUTING must go through
   *  {@link resolvedPinOf}, which additionally verifies ownership at the
   *  moment of use. */
  pinOf(key: string): string | null | undefined {
    return this.turnTargetTabByKey.has(key) ? this.turnTargetTabByKey.get(key)! : undefined;
  }

  /**
   * The pin as ROUTING must use it: ownership is verified AT RESOLUTION, not
   * only at the switch event (codex gate-4 delta, P0). Event-driven
   * invalidation ({@link tabChangedBackend}) fires when a switch is
   * OBSERVABLE, but a pin can land on a foreign-backend tab with no event at
   * all: wf:<hash> ids are deterministic and recur, so after the pinned
   * surface migrates away (deleting its backend record) and disconnects
   * (pruning its alias), a NEW socket can hello under the pin's exact id on
   * another backend — `prev` is gone, no switch is seen, and the stale pin
   * resolves straight onto the revived tab (same workflow uuid → the stamp
   * passes too). Checking at use closes every arrival order.
   *
   * A pin whose routed tab no longer belongs to this conversation fails
   * closed PERSISTENTLY (null pin, undefined stamp — first use invalidates,
   * with a warn) so the stamp cannot outlive the refusal and the explicit
   * recovery sees the recoverable state. An UNROUTABLE pin is returned as-is:
   * the bridge's own resolution fails loudly for it (parked/retried), which
   * is the documented dead-pin behavior.
   */
  resolvedPinOf(key: string): string | null | undefined {
    const pin = this.pinOf(key);
    if (typeof pin !== "string") return pin;
    const live = this.deps.liveTabOf ? this.deps.liveTabOf(pin) : pin;
    if (live === undefined) return pin; // unroutable — fails loudly downstream
    const backend = this.deps.backendOfKey(key);
    if (this.deps.backendForTab(live) !== backend) {
      this.turnTargetTabByKey.set(key, null);
      this.lastTurnUuidByKey.set(key, undefined);
      this.deps.warn(
        `[panel-orchestrator] ${key}'s in-flight turn is pinned to tab ${pin.slice(0, 8)}, ` +
          `which now routes to a tab owned by the ${this.deps.backendForTab(live)} ` +
          `conversation — scope routing and graph mutations FAIL CLOSED until an explicit ` +
          `target or the next origin-bearing message (#884 gate-4 confirm, P0: ownership ` +
          `is verified at resolution, not only at the switch event)`,
      );
      return null;
    }
    return pin;
  }

  /** The conversation's issue-time workflow stamp (what scope-addressed
   *  mutations carry). */
  stampOf(key: string): string | undefined {
    return this.lastTurnUuidByKey.get(key);
  }

  /** #716/#884 — an explicit, VALIDATED open/re-pin from the shared agent is
   *  the agent deliberately moving its turn to another workflow: refresh the
   *  conversation's issue-time stamp. */
  setStamp(key: string, uuid: string | undefined): void {
    this.lastTurnUuidByKey.set(key, uuid);
  }

  /** EXPLICIT repin recovery (see makeScopeRepinHandler, which gates this):
   *  re-pin the conversation's in-flight turn onto `tab` and re-derive the
   *  fence from it — a repin that left the OLD workflow's stamp in force would
   *  hand back a session whose very next mutation fails closed. Pin and stamp
   *  move together or neither does.
   *
   *  Deliberately does NOT write the LAST ESTABLISHED origin (codex delta
   *  review, P1): the recovery re-aims the CURRENT turn only. Inheritance for
   *  FUTURE origin-less turns derives solely from batch-close message origins,
   *  so a dying pre-rewind turn's late mode:"current" recovery — racing the
   *  rewind's dropBranch() — cannot re-establish an inheritance source the
   *  boundary just cleared; a post-boundary download turn refuses until the
   *  edited message establishes a real origin. */
  repinTo(key: string, tab: string): void {
    const uuid = this.deps.uuidOfTab(tab);
    this.turnTargetTabByKey.set(key, tab);
    this.lastTurnUuidByKey.set(key, uuid);
  }
}

/** The scope target resolver the UiBridge consults while resolving a
 *  scope-addressed command: the in-flight turn's pin (string), an ambiguous
 *  or ownership-refused origin (`null` → refuse loudly), or no turn in flight
 *  (undefined → active-tab resolution). Goes through resolvedPinOf so the
 *  pin's OWNERSHIP is verified at every use (codex gate-4 delta, P0). Built
 *  here so tests drive the REAL resolver. */
export function makeScopeTargetResolver(opts: {
  tracker: TurnOriginTracker;
  scopeAgentKeyOf: (scopeId: string) => string;
}): (scopeId: string) => string | null | undefined {
  return (scopeId) => opts.tracker.resolvedPinOf(opts.scopeAgentKeyOf(scopeId));
}

/** The slice of UiBridge the repin recovery consults. */
export interface ScopeRepinBridge {
  canReach(tabId: string): boolean;
  resolveActiveScopeTab(): string | undefined;
  isHeadless?(tabId: string): boolean;
  tabs(): Array<{ tab_id: string }>;
}

/**
 * EXPLICIT recovery from a DEAD or AMBIGUOUS pin — the only path that rewrites
 * an in-flight turn's pin, reached solely through the agent's explicit
 * panel_set_workflow_target({mode:"current"}) consent (panel_reload is NOT a
 * consent path — confirming gate 3, P0: it silently repinned a healthy turn).
 *
 * Fails closed (returns undefined, repinning nothing) unless ALL of:
 *  - the existing pin does NOT reach a live tab (a healthy binding is never
 *    displaced — recovery only; the consent caller re-checks this too, and
 *    this handler enforces it again so no other caller can hijack a live pin);
 *  - a target tab can be picked that is CANVAS-OWNING (a headless viewer can
 *    never host a graph session) and belongs to THIS conversation's backend
 *    (adopting another backend's tab would route this conversation's tool
 *    calls at a tab whose user is talking to a different provider — the same
 *    class as the backend-bound origin rule). The active tab is preferred;
 *    otherwise the backend's SOLE interactive tab; 2+ candidates without a
 *    clear active one refuse rather than guess.
 */
/**
 * What an explicit `mode:"current"` repin did — or, when it did nothing, WHY
 * (#1077 Finding 2).
 *
 * A bare `undefined` was indistinguishable across four different refusals, and
 * the caller collapsed it to `rebound: false`. A session wedged on any of them
 * saw only "the adoption was REFUSED" and had no way to tell a healthy pin it
 * should leave alone from an ambiguity it could resolve by naming a workflow.
 */
export type ScopeRepinOutcome = string | { repinned: false; reason: string } | undefined;

export function makeScopeRepinHandler(opts: {
  bridge: ScopeRepinBridge;
  tracker: TurnOriginTracker;
  scopeAgentKeyOf: (scopeId: string) => string;
  backendForTab: (tabId: string) => string;
  backendOfKey: (key: string) => string;
  info: (msg: string) => void;
}): (scopeId: string, preferredTab?: string) => ScopeRepinOutcome {
  return (scopeId, preferredTab) => {
    const key = opts.scopeAgentKeyOf(scopeId);
    // RECOVERY ONLY: a pin that still reaches a live tab OF THIS conversation
    // is healthy — never displace it (null = ambiguous/ownership-refused and
    // absent = no pin are both recoverable). resolvedPinOf, not raw pinOf: a
    // pin whose tab was revived by another backend "reaches" but is NOT
    // healthy — treating it as healthy would deadlock the advertised recovery
    // against the resolution-time refusal (codex gate-4 delta).
    const existing = opts.tracker.resolvedPinOf(key);
    if (typeof existing === "string" && opts.bridge.canReach(existing)) {
      return {
        repinned: false,
        reason:
          `the existing pin (${shortTabId(existing)}) still reaches a live tab of this ` +
          `conversation, so it is healthy and was left alone — this recovery only displaces a ` +
          `pin that is dead or ambiguous`,
      };
    }
    const backend = opts.backendOfKey(key);
    const eligible = opts.bridge
      .tabs()
      .map((t) => t.tab_id)
      .filter((t) => opts.bridge.isHeadless?.(t) !== true && opts.backendForTab(t) === backend);
    // #888 — a NAMED workflow decides which tab, where "current" cannot.
    //
    // The refusal below already tells the agent to do exactly this ("Name the
    // workflow instead — panel_set_workflow_target with a path ... and the pin
    // follows it"), and until now nothing made the pin follow: `mode:"pinned"`
    // wrote the workflow-target store and never reached this handler at all, so
    // a successful pin left the ambiguous turn pin in place and every following
    // scope-addressed command hit the same ambiguity refusal.
    //
    // Eligibility is the SAME as for the active tab — this conversation's
    // backend, not headless — so naming a workflow cannot reach a tab that
    // "current" would have been refused for. The healthy-pin gate above still
    // runs first and is untouched: a live pin is never displaced, however
    // explicit the request.
    //
    // A named tab that is NOT eligible REFUSES rather than falling back to the
    // active tab. Silently re-aiming an explicit request at a different
    // workflow is the precise hazard this fence exists for (#884 gate 3, P0).
    const named = preferredTab && eligible.includes(preferredTab) ? preferredTab : undefined;
    if (preferredTab && !named) {
      return {
        repinned: false,
        reason:
          `the named workflow resolves to ${shortTabId(preferredTab)}, which is not a tab of ` +
          `this conversation's backend (${backend}) — or is headless, or is not connected. The ` +
          `pin was NOT moved to it, and was not silently redirected to another tab either. ` +
          `Check panel_list_workflows for which workflows this session can reach`,
      };
    }
    const active = opts.bridge.resolveActiveScopeTab();
    const tab =
      named ??
      (active && eligible.includes(active)
        ? active
        : eligible.length === 1
          ? eligible[0]
          : undefined);
    // #1077 Finding 2 — SAY WHY. Every refusal above and below returned a bare
    // `undefined`, which the caller collapsed to `rebound: false`, so a session
    // stuck here was told only that the adoption was refused. The reporter could
    // not tell which branch fired and had no orchestrator log to read; they
    // refreshed, closed and reopened the tab, and finally traced it to source.
    //
    // The state worth naming is the last one: `active` exists but belongs to a
    // DIFFERENT backend's conversation while this one has two or more tabs.
    //
    // NOT permanent, and saying so would overstate it — the active tab moves on
    // the next user_message, so a message sent from one of this conversation's
    // own tabs clears it. What IS true is that RETRYING THE TOOL never clears
    // it: the inputs are identical every time, which is what the reporter
    // experienced before refreshing and reopening the tab. Nothing in the old
    // reply hinted at either way out.
    if (!tab) {
      if (eligible.length === 0) {
        return {
          repinned: false,
          reason:
            `no connected tab belongs to this conversation's backend (${backend}) — ` +
            `every eligible tab is either headless or bound to another backend`,
        };
      }
      return {
        repinned: false,
        reason:
          `this conversation has ${eligible.length} eligible tabs and the active one ` +
          `(${active ? shortTabId(active) : "none"}) is not among them, so "current" does not ` +
          `identify which to bind. Name the workflow instead — panel_set_workflow_target with a ` +
          `path, or panel_open_workflow — and the pin follows it`,
      };
    }
    opts.tracker.repinTo(key, tab);
    opts.info(
      `[panel-orchestrator] ${key} re-pinned onto ${tab.slice(0, 8)} by explicit target request (#884 recovery)`,
    );
    return tab;
  };
}
