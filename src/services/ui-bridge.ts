// UI bridge: a loopback WebSocket server the comfyui-mcp-panel pack connects
// to. The panel orchestrator calls `send(cmd)` and awaits the panel's
// rid-correlated reply — a background Claude agent drives the live ComfyUI
// graph over this bridge, with zero LLM API keys.
//
// MULTI-TAB: each ComfyUI browser tab holds its own connection, identified by
// a per-tab session id the panel sends in its `hello` frame (plus the open
// workflow's title, so the agent can tell tabs apart). Commands route by:
// explicit tab_id → the only connected tab → the tab the user most recently
// typed in → error listing connected tabs. Workflows are per-tab in ComfyUI,
// so there is no cross-tab state sync — just per-tab routing.
//
// Wire design ported from node-lab's mcp/bridge.ts (same author): every
// request is `{ rid, cmd, ...args }`; the panel replies `{ rid, ok, result }`
// or `{ rid, ok: false, error }`. Frames WITHOUT a rid are panel-initiated
// events (`hello`, `user_message`) and flow to `onPanelMessage`.

import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { resolveLocale, trFor, type Locale } from "../i18n/index.js";
import { logger } from "../utils/logger.js";
import { attachPanelAnswered, inheritPanelAnswered } from "./panel-answered.js";
import { attachPanelRefusal, hasOwnField, readPanelRefusal } from "./panel-refusal.js";
import {
  attachWorkflowListReadiness,
  inheritWorkflowListReadiness,
  readWorkflowListReadiness,
} from "./panel-workflow-readiness.js";
import { midCommandDisconnectMessage } from "./mid-command-remedy.js";
import {
  describePanelUpdateRecovery,
  type PanelBundleSkew,
} from "./panel-recovery.js";
import { primePanelBase, verifiedPanelDiskVersion } from "./panel-workspace.js";
import { compareSemver, detectInstallMode } from "./self-update.js";
import { SHARED_SESSION_SCOPE, isScopeAddress } from "./session-scope.js";
import type { ScopeRepinOutcome, ScopeRepinRequest } from "../orchestrator/turn-origins.js";
import {
  QUEUE_BUSY_READ_TOOLS,
  panelToolForGraphCmd,
} from "./panel-graph-cmd-tools.js";

export const DEFAULT_BRIDGE_PORT = 9101;

/**
 * How long a BUFFERED late `ask_user` answer stays claimable via
 * takeLateAskReply(). An answer given after its command's reply timer fired has
 * nowhere else to go, so it is held here until something drains it or this
 * elapses.
 *
 * EXPORTED because it is the real bound on how long a late answer can be
 * recovered, and panel#1554 added a second reader that has to respect exactly
 * that window (see confirmAnswerRecoveryWindowMs in panel-tools.ts). A private
 * copy of "5 minutes" over there would be a bound deciding a correctness
 * question in two places, free to drift apart.
 */
export const LATE_ASK_TTL_MS = 5 * 60 * 1000;

/**
 * The subset of the `ws` WebSocket surface `handleConnection` actually needs.
 * A real `ws.WebSocket` satisfies this structurally. It also lets a non-network
 * pseudo-socket plug in — the relay client (see relay-client.ts) wraps each
 * relay-multiplexed panel connection in an object satisfying this interface so
 * it can be handed to `attachRelayConnection` and treated identically to a
 * directly-connected loopback socket by all of this class's routing/reply logic.
 */
export interface BridgeSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  terminate(): void;
  ping(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export interface PanelEvent {
  type: string;
  text?: string;
  tab_id?: string;
  title?: string;
  /** Stamped by the panel on user_message: where the user is looking. */
  context?: { workflow?: string; subgraph?: string };
  [key: string]: unknown;
}

export interface PanelTab {
  tab_id: string;
  title: string;
  connected_at: string;
}

/** Shared per-send context that survives a re-dispatch (idempotent read retried
 *  onto a fresh socket after a mid-command reconnect). Carries the caller's
 *  resolve/reject, the original command, an absolute deadline, and a finite
 *  reconnect retry budget. */
type SendCtx = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  command: BridgeCommand;
  timeoutMs: number;
  tabId: string;
  /** True for anything that could have a side effect on the panel/ComfyUI (e.g.
   *  graph_run queues a real render). Mutating commands are NEVER auto-retried on
   *  reconnect — the request was already written to the dead socket and may have
   *  been applied, so a retry risks double execution. */
  mutating: boolean;
  /** Absolute ms after which even an idempotent read stops waiting for reconnect. */
  deadline: number;
  /** Remaining bridge-owned reconnect re-dispatches for this send. */
  reconnectRetriesRemaining: number;
  /**
   * #2761 — the PROVEN browser-tab identity of the connection this command was
   * issued to, captured at dispatch. Present only when that hello carried a
   * `tab_session_id`; absent when the panel could not prove one.
   *
   * Exists so a park-and-resume can tell "the same tab came back" from "a
   * different tab took this recurring `wf:` route key over". `Conn.incarnationId`
   * is deliberately NOT what is stored here: it is always populated, falling back
   * to a per-CONNECTION `anon:<n>`, so a panel whose Web Locks lease is refused or
   * unreadable (#2104) presents a fresh incarnation on every genuine reconnect.
   * `tabSessionId` is the field whose contract is "a proof, absent when unproven"
   * (#709), which is exactly the question the resume has to ask.
   */
  issuedToTabSessionId?: string;
  /** #570 — the trusted per-instance workflow uuid this command was ISSUED FOR (the
   *  caller's intended tab), stamped onto the outgoing frame so the panel can refuse to
   *  EXECUTE it against a DIFFERENT workflow it has since switched to. Undefined for a tab
   *  with no established workflow identity (old panel / relay) → no client-side fence. */
  workflowUuid?: string;
  onDispatchedRid?: (rid: string) => void;
  /**
   * #2069 — command name of a sibling on the same tab that answered WHILE this
   * one was still waiting. A timeout that observed that must not claim the tab
   * may be backgrounded or frozen: the reporter's concurrent query/outline/
   * screenshot replies proved the tab was alive, and only graph_get_errors
   * missed its correlation slot.
   */
  siblingReply?: string;
};

/** An idempotent read parked by handleMidCommandDisconnect, waiting a bounded
 *  grace for its tab to come back so it can be re-dispatched. */
type AwaitingReconnectEntry = {
  ctx: SendCtx;
  graceTimer: ReturnType<typeof setTimeout>;
  /** #2761 — set when a hello for this route key was declined as a resume target
   *  because it could not prove it is the tab that issued the read. Only changes
   *  the message the grace timer eventually rejects with: "gone" is a lie when
   *  the operator can see a live tab sitting on the key. */
  refusedUnprovenReturn?: boolean;
};

/**
 * #2761 — may a read parked by `ctx` be resumed onto `conn`? ONLY when `conn`
 * PROVES it is the browser tab that issued it: both carry a `tab_session_id`
 * and they match.
 *
 * This is a POSITIVE proof, not "refuse when they provably differ", and the
 * difference is the whole decision. A `wf:` route key RECURS (#486) — another
 * browser tab opening the same saved workflow takes it over — so holding the key
 * is not evidence of anything. An UNPROVEN connection is therefore not neutral:
 * it is a connection that cannot rule out being a stranger, and resuming onto it
 * answers the departed caller with a canvas that may not be theirs.
 *
 * The cost is real and falls on one population: a panel that never advertises
 * `tab_session_id` can never prove a return, so park-and-resume does nothing for
 * it and a mid-command drop fails instead of recovering. That is deliberate, and
 * it is the side this codebase already takes at every adjacent site:
 *
 *   - `tabConnectionIdentity` returns undefined for exactly these panels rather
 *     than "fabricating graph-tool readiness" for the restart gate.
 *   - the hello handler (#486) counts a differing anonymous incarnation as a
 *     TAKEOVER and retires the departed tab's asks.
 *   - the panel's own `bridge-route.js`, on this same trade: "Losing a resume is
 *     recoverable; delivering a command to the wrong canvas is not."
 *
 * #2761 proposed sparing the unproven case, on the premise that a panel which
 * cannot prove uniqueness omits the field. THE PANEL SOURCE SAYS OTHERWISE, and
 * that is why this does not follow the suggestion: `createTabRouteIdentity` has
 * three outcomes, and two of them send an id — an exclusive Web Locks lease, or,
 * where `navigator.locks` does not exist (plain http:// on a LAN), a
 * never-persisted per-page-load id. The third, a lease actively refused by
 * another tab, makes the panel REFUSE TO ROUTE AT ALL rather than hello
 * anonymously. So a current panel that is talking to us has always proved
 * something; the anonymous population is old builds, and old builds are exactly
 * who `tabConnectionIdentity` already fails closed on.
 *
 * Note this also makes a page-instance RELOAD (new id each load) a non-return,
 * which is correct and already true elsewhere: the hello handler fires
 * `onTabTakenOver` for it, and the panel documents the cost as "route stability,
 * not uniqueness".
 */
function isProvenSameTab(ctx: SendCtx, conn: Conn): boolean {
  return (
    ctx.issuedToTabSessionId !== undefined &&
    ctx.issuedToTabSessionId === conn.tabSessionId
  );
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sock?: BridgeSocket;
  /** Command name of the in-flight request (for actionable disconnect errors). */
  cmd: string;
  ctx: SendCtx;
};

interface Conn {
  sock: BridgeSocket;
  tabId: string;
  title: string;
  connectedAt: string;
  /** Monotonic bridge-local hello generation. Every hello gets a new value, even
   * on the same socket/tab id, so restart readiness can require a post-dispatch
   * panel registration rather than mistaking the pre-restart socket for a reconnect. */
  helloGeneration: number;
  /** Browser-tab-scoped session identity supplied by current panel builds.
   * Unlike `tabId` — a bridge ROUTE, `wf:<tabRouteId>:<path>`, whose shape is
   * defined by the panel's own bridge-route.js (#640) and which can recur when a
   * tab route id is reused — this stays with one browser tab across a ComfyUI
   * restart.
   *
   * #1285 — this used to say a tabId is "commonly derived from a saved workflow
   * path". That is the HANDLE (`wf:<path>`), which bridge-route.js explicitly
   * marks as NOT a route because two browser tabs can show the same file. A
   * reader believed this sentence, derived `wf:<path>`, compared it against
   * `bridge.tabs()`, and shipped a fix that never matched anything. It is used only as an accidental-routing
   * correctness proof for restart readiness; absence fails that proof closed. */
  tabSessionId?: string;
  /**
   * ALWAYS-PRESENT incarnation identity for this connection (#486).
   *
   * `tabSessionId` when the panel proved one, otherwise a bridge-minted
   * `anon:<n>` unique to THIS connection. Never absent, and never shared: the
   * panel returns no identity precisely when its Web Locks lease could not be
   * acquired — i.e. when a duplicated browser tab copied the sessionStorage id —
   * which is exactly the two-tabs-one-key case, so collapsing all such
   * connections into one "anonymous" bucket would lose the very distinction that
   * matters most. Distinct by construction instead.
   *
   * Kept SEPARATE from `tabSessionId` on purpose: that field is a proof used by
   * the restart-readiness gate (#570/#709) and must stay absent when unproven. A
   * synthetic id is fine for "which connection is this?" and would be a lie for
   * "did the same browser tab come back?".
   */
  incarnationId: string;
  /** Canvas-less client (mobile/remote pseudo-panel) — advertised in `hello`.
   *  Lets tools resolve media to inline bytes instead of a browser /view ref. */
  headless: boolean;
  /** The sidebar panel's advertised version (`panel_version` in its `hello`), if
   *  sent. Used to make an "Unknown command" reply from an OLD panel actionable
   *  (see makeUnknownCommandError) — the panel gained these bridge commands in
   *  0.11.4, so older builds reject graph_* / ui_* with a raw dispatch error. */
  panelVersion?: string;
  /** True only when THIS hello actually CARRIED a `panel_version` (not inherited from
   *  a prior connection under the same tab id). `panelVersion` is deliberately
   *  inherited across a reconnect that omits the field (line ~849) so the reactive
   *  "update your panel" message can still quote a detected version — but that stale,
   *  inherited value must NOT drive the PROACTIVE gate (#392): a reconnect may be a
   *  freshly UPGRADED panel, so proactively blocking it on the old version — without
   *  ever probing it — would strand a now-capable panel until yet another reconnect
   *  (codex WS review). So proactive gating fires ONLY when the current connection
   *  advertised its own version; an omitted-version reconnect falls through to normal
   *  dispatch + the reactive #236 path (which learns from a REAL rejection). Mirrors
   *  the unsupportedCmds "reset on every hello" philosophy for the version dimension. */
  panelVersionAdvertised: boolean;
  /** #570 P0c — THIS panel build advertised (in its hello) that it enforces the per-command
   *  workflow-instance stamp: it refuses to run ANY active-workflow op whose stamped
   *  workflow_uuid does not match the active canvas — every graph_* command AND the four
   *  active-workflow mutators (workflow_save / workflow_save_as / workflow_rename /
   *  workflow_close). The panel fence sits in the command handler (activeWorkflowFenceApplies),
   *  before every executor, so the guarantee spans all of them, not just graph commands. When
   *  false (an OLD panel that would silently ignore the stamp), the send() preflight FAILS CLOSED
   *  for those active-workflow mutations (see requiresWorkflowStampEnforcement) so a stale write
   *  can't hit the wrong workflow — reads and path-targeted ops stay allowed. Re-read from every
   *  hello (a reconnect may be a freshly updated build), never inherited.
   *
   *  SCOPE (deliberate): this is ACCIDENTAL version-skew protection — an HONEST old panel gets
   *  read-only graph access until it updates, so a stale in-flight edit can't silently corrupt
   *  the wrong workflow after a switch. It is NOT a security boundary: the flag is client-
   *  asserted and the uuid is client-supplied, so a user who MODIFIES their own local panel can
   *  trivially spoof both. That is a self-attack (their own workflow A leaking into their own
   *  workflow B) crossing no privacy boundary, so attestation would buy nothing — #570's real
   *  threat is ACCIDENTAL cross-workflow confusion for an honest user, which this closes. */
  enforcesWorkflowStamp: boolean;
  /** True only when THIS hello advertises that the workflow stamp is checked at
   * the actual mutation boundary after an async graph executor resumes (#718).
   * The original dispatch-time fence alone is insufficient for graph_set_widget:
   * its required fresh-backend query yields to the browser, allowing a workflow
   * switch before it writes. Re-read per hello and fail closed if absent. */
  enforcesWorkflowStampAtWrite: boolean;
  /** True only when THIS hello advertises that the panel validates an optional
   * expected_node_type at the synchronous graph_set_widget write boundary.
   * Re-read per hello and fail closed when absent: an older panel would silently
   * ignore the field and leave the node-replacement fence unenforced. */
  enforcesExpectedNodeTypeAtWrite: boolean;
  /** True only when THIS hello advertises that the panel validates an optional
   * opaque expected_node_identity at the synchronous graph_set_widget write
   * boundary. A same-type, same-id replacement must not satisfy a stale
   * promoted-write preflight. */
  enforcesExpectedNodeIdentityAtWrite: boolean;
  /** True only when THIS hello advertises that the panel validates an optional
   * expected_scope (promoted owner/workflow witness) at the synchronous
   * graph_set_widget write boundary. Re-read per hello and fail closed when
   * absent: an older panel would silently ignore receiver identity and could
   * write a same-id node after navigation. */
  enforcesExpectedScopeAtWrite: boolean;
  /** True only when THIS hello advertises that expected_scope also carries and
   * validates the stable live graph identity. Owner and wrapper ids are local
   * to a graph, so the older owner/workflow-only fence is insufficient for a
   * same-id cross-graph navigation. */
  enforcesExpectedScopeGraphIdentityAtWrite: boolean;
  /** True only when THIS hello advertises that graph_get_subgraph publishes
   * the complete renamed-promotion alias -> terminal witness consumed by the
   * orchestrator before a promoted write. */
  publishesPromotedTerminalWitnesses: boolean;
  /** True only when THIS hello advertises that graph_set_widget re-resolves the
   * promoted parent rail through the live owner/input relation at mutation time. */
  enforcesPromotedParentRailAtWrite: boolean;
  /** True when THIS hello advertises that the panel understands `agent_note` — a frame
   *  delivered to the AGENT ONLY and never rendered as a chat bubble.
   *
   *  Capability-gated on purpose. An older panel silently DROPS an unknown frame type, so
   *  switching unconditionally would make these notices vanish for anyone who has not
   *  updated — a wall of text traded for nothing at all, which is the worse failure. When
   *  this is false the caller falls back to a visible `say`. */
  acceptsAgentNotes: boolean;
  /**
   * Painter kinds THIS hello advertised the panel can render (`show_media_kinds`
   * array). Re-read per hello, never inherited — a reconnect may be a different
   * build. Undefined when the hello omitted the field (every panel today) or
   * sent a malformed value; callers then fall back to the version floor in
   * {@link SHOW_MEDIA_KIND_MIN_PANEL_VERSION} (#2017).
   */
  showMediaKinds?: readonly string[];
  /** Commands THIS connection has already proven it doesn't support, via a real
   *  "Unknown command" reply earlier in the session (#236). Once a cmd lands
   *  here, every later call is gated proactively — rejected before it ever
   *  reaches the panel, with the same actionable message — instead of paying a
   *  full round trip (and re-parsing the panel's raw error) every single time.
   *  Never pre-populated from panelVersion alone: some graph_ and ui_ commands
   *  predate 0.11.4 and DO work on older panels, so only an EMPIRICALLY observed
   *  rejection from this exact connection can prove a command unsupported —
   *  guaranteeing this never blocks a call that would otherwise have succeeded.
   *  Reset to empty on every hello (a reconnect may be a freshly updated panel
   *  build, so a stale unsupported-verdict must never carry over). */
  unsupportedCmds: Set<string>;
  /** Commands THIS connection has already EXECUTED SUCCESSFULLY (a real, non-error
   *  panel reply came back). Demonstrated capability is authoritative: it VETOES the
   *  proactive #392 version gate, so a command the panel has actually served is never
   *  later rejected as "too old" just because a subsequent re-hello advertised a
   *  version that parseably undercuts the changelog-declared minimum (#422 — the panel
   *  is unchanged; only the advertised-version state flipped). Unlike unsupportedCmds,
   *  this is INHERITED across a reconnect under the same tab id (the panel code did not
   *  get older) — and it is the SAFE polarity to inherit: if a genuine DOWNGRADE ever
   *  reintroduces a command the new build lacks, that build's own "Unknown command"
   *  reply re-populates unsupportedCmds (and clears this entry), and the unsupportedCmds
   *  gate — checked BEFORE the version gate — wins. So a wrongly-inherited entry costs at
   *  most one honest round-trip, never a fabricated success. */
  provenSupportedCmds: Set<string>;
  /** The ComfyUI origin this tab claims in `hello` (`comfyui_url`), if sent.
   *  This is page/client-controlled metadata and is never an authorization signal. */
  originUrl?: string;
  /** SERVER-OBSERVED, syntactically validated metadata from THIS socket's WebSocket
   *  upgrade (scheme://host:port). It is distinct from `originUrl`, but HTTP headers
   *  are forgeable by a non-browser client on a tokenless listener, so this is not
   *  authentication and must not authorize outbound requests. */
  serverOrigin?: string;
  /** The socket arrived on the token-less loopback primary listener. This is a
   *  transport/bind fact, not browser provenance; a local non-browser client can
   *  still connect and forge request headers. */
  local: boolean;
  /** The panel language THIS tab resolved for itself (`locale` in its `hello`), already
   *  narrowed to a locale we ship. Undefined when the panel sent none (an older build) or
   *  sent one we do not ship — both mean UNKNOWN, and unknown renders English.
   *
   *  Why per TAB and not per process: a `say` frame is a chat bubble inside one specific
   *  panel tab, and those strings NAME PANEL CONTROLS ("Settings → OpenRouter → 'Set API
   *  key…'"). Rendered in the process locale — the language of whoever launched the server —
   *  the instruction would point at a label that user cannot find on their own screen. So the
   *  language must come from the destination tab. See {@link tabLocale}. */
  locale?: Locale;
}

/** Panel build that first implements the full graph_* / ui_* bridge command set.
 *  Used as the DEFAULT minimum for any bridge command not listed in
 *  BRIDGE_CMD_MIN_PANEL_VERSION below. Individual commands shipped EARLIER than
 *  this (see the map) and must quote their own, lower minimum. */
export const MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS = "0.11.4";

/** The panel version each bridge command was ACTUALLY introduced in (from the
 *  comfyui-mcp-panel CHANGELOG). The old code quoted a single blanket 0.11.4 for
 *  EVERY command, which is wrong for commands that shipped much earlier —
 *  graph_outline has existed since panel 0.4.6, so a "too old — update to ≥0.11.4"
 *  verdict for it is a false, inflated requirement (#352). Anything not listed
 *  falls back to MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS (the full-set baseline). */
export const BRIDGE_CMD_MIN_PANEL_VERSION: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    graph_outline: "0.4.6",
    graph_find_nodes: "0.4.6",
    graph_query: "0.7.0",
    graph_serialize: "0.8.2",
    // #1006 — the panel serving its OWN /object_info first shipped in panel 0.13.0. An
    // AUTHORITATIVE entry, because without one the command falls back to the bridge
    // baseline and an older panel answers the raw dispatch error `Unknown command
    // "graph_get_object_info"`, which reads like a broken ComfyUI rather than an old panel.
    //
    // Established from the release commit, not from tags: this repo does not tag its
    // releases (`git tag --contains` finds nothing), so ancestry would have pointed at the
    // first tag that happens to exist and named a version four releases too late.
    graph_get_object_info: "0.13.0",
    // #608 forced-refresh executor shipped in panel 0.11.28. Older panels (e.g. the
    // 0.11.20 in #619) register no `refresh_nodes` handler and reply with the raw
    // dispatch error `Unknown command "refresh_nodes"`. Without this AUTHORITATIVE
    // entry the command falls back to the 0.11.4 baseline, which a 0.11.20 panel
    // already exceeds — so makeUnknownCommandError's false-negative guard mistook it
    // for "new enough" and leaked the opaque raw error instead of an actionable
    // "update your panel to ≥0.11.28" verdict. Listing it here also lets the #392
    // PROACTIVE gate reject the very first call on a <0.11.28 panel before dispatch.
    refresh_nodes: "0.11.28",
    // #619 recurrence — panel_resize_node's bridge executor shipped in panel 0.11.25
    // (panel CHANGELOG: "panel_resize_node resizes a node on the live canvas", #530).
    // The reporter's 0.11.21 panel predates it, but untabled the command inherited the
    // 0.11.4 baseline, producing the self-contradictory verdict `too old for
    // "graph_resize_node" (detected 0.11.21) — update … to ≥0.11.4`. Tabled, it quotes
    // the true minimum and the #392 proactive gate rejects the first call pre-dispatch.
    graph_resize_node: "0.11.25",
    // #1400 — the panel serving its frontend's VIRTUAL-type registry ships in the
    // panel release carrying the `graph_get_virtual_types` executor. The entry is
    // deliberately on the LOW side of whatever that release turns out to be: the
    // only caller (the orchestrator's hello-time pull) degrades silently on an
    // unknown-command reply, so a too-low floor can never produce a wrong verdict —
    // it just lets an old panel answer "Unknown command", which the pull swallows.
    graph_get_virtual_types: "0.15.11",
  }),
);

/**
 * The panel version each non-command bridge capability was ACTUALLY introduced
 * in.  These belong beside the command minimums because the orchestrator uses
 * their combined maximum for proactive sync advice.  Otherwise a capability
 * gate can correctly refuse an old panel while install_comfyui(action:'panel') incorrectly calls
 * that same panel current (#708).
 */
export const BRIDGE_CAPABILITY_MIN_PANEL_VERSION: Readonly<Record<string, string>> = {
  // #570 P0c — `enforces_workflow_stamp` first shipped in panel 0.11.30. #718
  // added the required after-await write-boundary recheck in 0.11.35: a panel
  // that only fences before graph_set_widget's fresh /object_info await can
  // still mutate a workflow the user switched to during that await. Both are
  // handshake capabilities, not commands, hence this table.
  enforces_workflow_stamp: "0.11.30",
  enforces_workflow_stamp_at_write: "0.11.35",
  // #2107 — graph_set_widget's optional expected_node_type fence shipped with
  // the panel-side write-boundary check.
  //
  // panel#1859: read off the published tags rather than the merge commit. The
  // key is absent from v0.15.58:web/js/lib/session-rebind.js and first present
  // in v0.15.59 — the fix merged after the 0.15.58 release cut, so a 0.15.58
  // floor authorized a published build that does not advertise it.
  enforces_expected_node_type_at_write: "0.15.59",
  // #2314 — promoted inner writes carry an expected owner/workflow witness that
  // the panel validates immediately before mutating the current graph.
  //
  // panel#1859: these three said 0.15.97, which the panel NEVER RELEASED (its
  // tags go 0.15.96 → 0.15.98). All three keys are absent from every tag up to
  // and including v0.15.100 and first appear in v0.15.101 — the same release
  // that added the `subgraph_of.graph_identity` the fence reads. The old number
  // called 0.15.98/0.15.99/0.15.100 new enough for a promoted write when none
  // of them can perform one, so `install_comfyui(action:'panel')` reported those
  // installs current while every promoted write kept being refused — #708 in a
  // second costume, and the reason panel#1859's remedy had no exit.
  enforces_expected_scope_at_write: "0.15.101",
  // #2314 P1 — the promoted fence additionally validates the object-keyed live
  // graph identity, which is distinct from graph-local owner/node ids.
  enforces_expected_scope_graph_identity_at_write: "0.15.101",
  // #2314 final-rail race — the promoted inner write re-resolves its live
  // authoritative parent rail at the synchronous mutation boundary.
  enforces_promoted_parent_rail_at_write: "0.15.101",
};

/**
 * The panel version ONE handshake capability first shipped in — the only number
 * a refusal about THAT capability is entitled to quote.
 *
 * `undefined` when the table has no parseable entry, so a message degrades to
 * naming the capability rather than fabricating a floor. Callers must not fall
 * back to {@link requiredPanelVersion}: that is the aggregate sync answer and
 * quoting it as one capability's requirement is the #352/#619 defect.
 *
 * panel#1859 added this because the four fence refusals below each hard-coded
 * their number by hand, and three of them had copied a version that was never
 * released. A hand-copied floor drifts silently from the table the gate
 * actually reads; a derived one cannot.
 */
export function panelVersionForCapability(capability: string): string | undefined {
  const min = BRIDGE_CAPABILITY_MIN_PANEL_VERSION[capability];
  return typeof min === "string" && SEMVER_RE.test(min.trim()) ? min.trim() : undefined;
}

/**
 * The panel version each `show_media` *painter kind* was actually introduced in.
 *
 * Separate from {@link BRIDGE_CAPABILITY_MIN_PANEL_VERSION} on purpose: that
 * table feeds the aggregate sync floor, and a media-kind floor must not move
 * "is the install current?" just because we learned a new painter. `show_media`
 * itself predates every entry here — old panels accept the command; they just
 * paint an unknown kind as `<img>` and report success (#2017 / panel #710).
 *
 * Fallback only. A hello that carries `show_media_kinds` is the authority and
 * does not consult this table (a capability list does not need a version
 * lookup). Image and video have no entry: every panel that answers show_media
 * has always painted those.
 */
export const SHOW_MEDIA_KIND_MIN_PANEL_VERSION: Readonly<Record<string, string>> = {
  // panel #710 — `paintAudio` + `unrenderable` accounting. Merged AFTER the
  // 0.11.42 release commit (panel `b81b10dd`) and first shipped in 0.11.43
  // (panel `a1ac583f`). A 0.11.42 floor would allow the published 0.11.42
  // build, which does not have the painter.
  audio: "0.11.43",
};

/** The minimum panel version that supports `cmd`. For a command WITH an
 *  authoritative BRIDGE_CMD_MIN_PANEL_VERSION entry this is its true introduction
 *  version; for anything else it is the 0.11.4 full-set baseline FLOOR — a lower
 *  bound for the bridge command set as a whole, NOT proof of when (or whether)
 *  this specific command shipped, so it must never be quoted to a user as the
 *  command's requirement (see buildPanelTooOldError, #619). */
export function minPanelVersionForCmd(cmd: string): string {
  return BRIDGE_CMD_MIN_PANEL_VERSION[cmd] ?? MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS;
}

/** A version string compareSemver can actually parse. compareSemver returns 0
 *  BOTH for "equal" and for "unparseable", so callers that must distinguish an
 *  unparseable input from a genuine tie (like panelSupportsCmd's `>= 0`) have to
 *  screen the input first — otherwise `panel_version: "dev"` would compare as 0
 *  and be mistaken for a match. This is the CANONICAL SemVer 2.0.0 grammar from
 *  semver.org (with an optional `v` prefix), END-ANCHORED ($) so the WHOLE trimmed
 *  string must be a strict, spec-valid version: numeric core with NO leading zeros,
 *  NON-EMPTY dot-separated prerelease/build identifiers, no numeric-prerelease leading
 *  zeros. Every malformed value that used to prefix-match as a valid version and get
 *  mistaken for new-enough — `0.11.28.1`, `0.11.28abc`, `0.11.28-` (empty prerelease),
 *  `0.11.28+.` / `0.11.28-.` (empty dot identifier), `01.11.28` (leading zero) — fails
 *  the screen and falls through to the conservative fail-closed path (reactive rewrite;
 *  never proactively gated), keeping panelSupportsCmd and panelVersionProvesUnsupported
 *  symmetric on garbage input (codex). */
export const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Fold a list of candidate minimums into the highest PARSEABLE one, seeded with
 *  the full-set baseline. Unparseable entries are skipped rather than allowed to
 *  win — a table typo must not fabricate a requirement. */
function highestRequirement(candidates: readonly (string | undefined)[]): string {
  let best = MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS;
  for (const min of candidates) {
    // A missing table key must degrade to "skip", never to a throw: this runs
    // inside error-message construction, where a throw would replace an
    // actionable refusal with an opaque crash.
    if (typeof min !== "string") continue;
    if (!SEMVER_RE.test(min.trim())) continue;
    if (!SEMVER_RE.test(best.trim()) || compareSemver(min, best) > 0) best = min;
  }
  return best;
}

/**
 * A panel version AS OBSERVED, with the parsed form separated from the text.
 *
 * The handshake's `panel_version` is an arbitrary string. Screening it wherever
 * it happens to be rendered does not hold: the screen was added at the write
 * refusal, and the reactive unknown-command path — which builds its own view
 * from the same raw field — went on rendering "detected panel nightly" and
 * calling the panel too old. One value, two consumers, one of them screened.
 *
 * So the screen moves into the TYPE. A consumer that wants a version reads
 * `.version`, which exists only when the text is strict SemVer; a consumer that
 * wants to show what was actually said reads `.raw`. The unparseable value is
 * still available — it is real evidence, and hiding it would be its own kind of
 * lying — but it is no longer reachable through a field named like a version, so
 * the next consumer added cannot accidentally treat it as one.
 *
 * `nightly` is the case that matters in practice: it is what ComfyUI-Manager
 * reports for a git-installed pack, so it is the normal reading for anyone
 * running the panel from source rather than the Registry.
 */
export interface PanelVersionReading {
  /** Verbatim (trimmed) text THIS handshake carried. EVIDENCE, never a version. */
  raw?: string;
  /** Set ONLY when `raw` is a strict SemVer — the sole form that may be compared,
   *  or quoted to a user as this panel's version. */
  version?: string;
  /**
   * A PREVIOUS connection's text, when THIS handshake carried none.
   *
   * `Conn.panelVersion` is inherited across a reconnect that omits the field, so
   * a raw read of it silently attributes an old observation to the current
   * connection. Provenance therefore travels with the reading, exactly as
   * parseability does — and for the same reason: the screen has to live
   * somewhere a consumer cannot forget it. It is never a `.version`: it was not
   * observed here, so it may not be compared or stated as this panel's version.
   * It is still disclosed, because it is a real earlier reading and discarding
   * it would be its own way of losing evidence.
   */
  inherited?: string;
}

/** Screen a handshake `panel_version` into a reading. Blank and unparseable both
 *  yield no `.version`; blank additionally yields no `.raw`, because whitespace
 *  is not evidence of anything. Never throws. */
export function readPanelVersion(raw: string | undefined): PanelVersionReading {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return {};
  return SEMVER_RE.test(trimmed) ? { raw: trimmed, version: trimmed } : { raw: trimmed };
}

/**
 * What THIS connection observed about the panel's version — the single answer
 * every consumer must use.
 *
 * There were three consumers reading `conn.panelVersion` and they disagreed:
 * the workflow fence checked `panelVersionAdvertised`, the proactive gate
 * checked it, and the reactive unknown-command rewrite did not — so a re-hello
 * that omitted the field could still produce "detected panel 0.4.5 … too old"
 * about a connection that observed no version at all. Routing all of them
 * through here makes provenance a property of the reading rather than something
 * each call site has to remember.
 */
export function connPanelVersionReading(conn: {
  panelVersion?: string;
  panelVersionAdvertised?: boolean;
}): PanelVersionReading {
  if (conn.panelVersionAdvertised) return readPanelVersion(conn.panelVersion);
  const carried = typeof conn.panelVersion === "string" ? conn.panelVersion.trim() : "";
  return carried ? { inherited: carried } : {};
}

/**
 * Screen a hello `show_media_kinds` value into a list of painter kinds.
 *
 * Absent, non-array, empty, or any non-string/blank element → `undefined`
 * (treat as omitted). A garbage field must not look like a claim that the
 * panel can paint nothing, which would refuse image/video on a typo.
 */
export function readHelloShowMediaKinds(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const kinds: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") return undefined;
    const kind = item.trim();
    if (!kind) return undefined;
    if (!seen.has(kind)) {
      seen.add(kind);
      kinds.push(kind);
    }
  }
  return kinds.length > 0 ? kinds : undefined;
}

/** Why a panel cannot paint a `show_media` kind, when we can prove it. */
export type ShowMediaKindUnsupportedReason = "too_old" | "not_in_hello";

export type ShowMediaKindSupport =
  | { supported: true }
  | {
      supported: false;
      kind: string;
      reason: ShowMediaKindUnsupportedReason;
      version?: string;
      needed?: string;
    };

/**
 * The kind the panel will pick a painter for — the field `classifyShowMediaItem`
 * on the panel (panel #710) consults, in the same order:
 *
 *   1. an explicit orchestrator `kind` of image/video/audio
 *   2. a /view ref's filename extension (the path audio takes on origin/main)
 *   3. a data URL's declared MIME
 *
 * Image and video are universal (every show_media panel paints them). Audio is
 * the kind a pre-#710 panel paints as `<img>` and counts as success (#2017).
 * Anything else is returned as-is so a future kind can grow a floor without
 * this function having to learn it.
 */
export function paintedShowMediaKind(item: Record<string, unknown>): string {
  const kind = typeof item.kind === "string" ? item.kind : "";
  if (kind === "image" || kind === "video" || kind === "audio") return kind;

  let name = "";
  if (kind === "viewRef" && item.viewRef && typeof item.viewRef === "object") {
    const filename = (item.viewRef as { filename?: unknown }).filename;
    if (typeof filename === "string") name = filename;
  }
  if (!name && typeof item.filename === "string") name = item.filename;
  const ext = showMediaFilenameExt(name);
  if (SHOW_MEDIA_AUDIO_PAINT_EXTS.has(ext)) return "audio";
  if (SHOW_MEDIA_VIDEO_PAINT_EXTS.has(ext)) return "video";
  if (SHOW_MEDIA_IMAGE_PAINT_EXTS.has(ext)) return "image";

  if (typeof item.dataUrl === "string") {
    const m = /^data:(image|video|audio)\//i.exec(item.dataUrl);
    if (m) return m[1]!.toLowerCase();
  }
  return kind || "unknown";
}

/** Panel `AUDIO_EXTENSIONS` (`web/js/lib/media-preview.js`) — what `<audio>` paints. */
const SHOW_MEDIA_AUDIO_PAINT_EXTS = new Set([
  ".wav",
  ".mp3",
  ".flac",
  ".ogg",
  ".oga",
  ".opus",
  ".m4a",
  ".aac",
]);
const SHOW_MEDIA_VIDEO_PAINT_EXTS = new Set([".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi"]);
const SHOW_MEDIA_IMAGE_PAINT_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".apng", ".webp"]);

function showMediaFilenameExt(filename: string): string {
  const stem = filename.split("#")[0]!.split("?")[0]!;
  const m = /\.([A-Za-z0-9]+)$/.exec(stem);
  return m ? `.${m[1]!.toLowerCase()}` : "";
}

function showMediaItemFilename(item: Record<string, unknown>): string {
  if (typeof item.filename === "string" && item.filename.trim()) return item.filename;
  if (item.viewRef && typeof item.viewRef === "object") {
    const filename = (item.viewRef as { filename?: unknown }).filename;
    if (typeof filename === "string" && filename.trim()) return filename;
  }
  return "(unnamed)";
}

/**
 * Can this panel paint `kind`?
 *
 * Fail-OPEN when we cannot prove it cannot: missing/unparseable/inherited
 * version, and no hello list, are not evidence of an old panel — telling
 * someone to update a current one is the wrong remedy (same tri-state as
 * {@link panelVersionProvesUnsupported}).
 *
 * Image and video are always supported. An advertised `show_media_kinds` list
 * is the authority for every other kind (a capability does not need a version
 * table). Without a list, only a parseable advertised version below a tabled
 * floor is proof.
 */
export function panelSupportsShowMediaKind(
  kind: string,
  opts: {
    reading: PanelVersionReading;
    advertisedKinds?: readonly string[];
  },
): ShowMediaKindSupport {
  if (kind === "image" || kind === "video") return { supported: true };
  // A source kind / unclassified item is not a painter the old panel lacks.
  if (kind === "viewRef" || kind === "unknown" || kind === "") return { supported: true };

  const advertised = opts.advertisedKinds;
  if (advertised && advertised.length > 0) {
    if (advertised.includes(kind)) return { supported: true };
    return {
      supported: false,
      kind,
      reason: "not_in_hello",
      version: opts.reading.version,
      needed: SHOW_MEDIA_KIND_MIN_PANEL_VERSION[kind],
    };
  }

  const needed = SHOW_MEDIA_KIND_MIN_PANEL_VERSION[kind];
  if (!needed) return { supported: true };
  const version = opts.reading.version;
  if (!version || !SEMVER_RE.test(version.trim())) return { supported: true };
  if (compareSemver(version, needed) < 0) {
    return { supported: false, kind, reason: "too_old", version, needed };
  }
  return { supported: true };
}

export type UnsupportedShowMediaItem = {
  filename: string;
  kind: string;
  reason: ShowMediaKindUnsupportedReason;
  version?: string;
  needed?: string;
};

/**
 * Items of a `show_media` batch this panel is proven unable to paint.
 *
 * Empty for the common case (current panel, image/video only, or unproven
 * version) — the hot path is a kind scan and no version compare.
 */
export function showMediaItemsPanelCannotPaint(
  items: readonly Record<string, unknown>[],
  opts: {
    reading: PanelVersionReading;
    advertisedKinds?: readonly string[];
  },
): UnsupportedShowMediaItem[] {
  const blocked: UnsupportedShowMediaItem[] = [];
  for (const item of items) {
    const kind = paintedShowMediaKind(item);
    const verdict = panelSupportsShowMediaKind(kind, opts);
    if (verdict.supported) continue;
    blocked.push({
      filename: showMediaItemFilename(item),
      kind: verdict.kind,
      reason: verdict.reason,
      version: verdict.version,
      needed: verdict.needed,
    });
  }
  return blocked;
}

/**
 * The highest panel version this MCP build needs across its bridge commands and
 * handshake capabilities. Keep this beside both capability tables so proactive
 * panel sync and a bridge refusal report the same derived requirement.
 *
 * This is the SYNC/INSTALL question — "how new must the panel be for this
 * orchestrator to have everything it might want?" It is an aggregate across
 * every command and capability, so it is NOT the answer to "what does the write
 * I just refused actually need"; quoting it there is the #619 self-contradiction
 * in another costume (see requiredPanelVersionForWorkflowFence).
 */
export function requiredPanelVersion(): string {
  return highestRequirement([
    ...Object.values(BRIDGE_CMD_MIN_PANEL_VERSION),
    ...Object.values(BRIDGE_CAPABILITY_MIN_PANEL_VERSION),
  ]);
}

/**
 * The minimum panel version that can fence a graph WRITE to its workflow — the
 * only version a fenced-write refusal is entitled to quote. `undefined` when
 * this build cannot state it.
 *
 * A write needs BOTH handshake capabilities (the dispatch-time stamp check and
 * the after-await write-boundary recheck), so it is their maximum, not the
 * global one. Today the two happen to be equal, which is precisely why this
 * needs to be separate NOW: the moment some unrelated command declares a higher
 * minimum, `requiredPanelVersion()` rises and the refusal starts telling users
 * their write needs a version it does not need — a number they cannot verify,
 * attached to a remedy they will run for the wrong reason. Same defect as #352 /
 * #619 (a blanket floor quoted as one command's requirement), one level up.
 *
 * BOTH entries must be present and parseable, and an incomplete table yields
 * `undefined` rather than a number (codex gate). Two wrong answers were
 * available here and both are the fold this cluster exists to remove:
 *
 *  - falling back to `MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS` would quote 0.11.4
 *    as "the first build that fences every command", which is simply false — the
 *    fence shipped in 0.11.30/0.11.35. An unreadable table is an unreadable
 *    OBSERVATION, not evidence of a low requirement.
 *  - taking the max of whichever entry survived would UNDERSTATE it: a user told
 *    0.11.30 suffices would update, still be refused, and be back in the loop
 *    #812 reported.
 *
 * So when the table cannot answer, nothing is quoted. The gate still refuses —
 * the refusal is not what is uncertain — and the message says which part it
 * could not determine.
 */
export function requiredPanelVersionForWorkflowFence(): string | undefined {
  const raw = [
    BRIDGE_CAPABILITY_MIN_PANEL_VERSION.enforces_workflow_stamp,
    BRIDGE_CAPABILITY_MIN_PANEL_VERSION.enforces_workflow_stamp_at_write,
  ];
  // Every entry must be a parseable version. `typeof` first so a table with a
  // deleted or non-string key degrades instead of throwing inside .trim() —
  // this runs while composing an error message.
  if (!raw.every((v) => typeof v === "string" && SEMVER_RE.test(v.trim()))) return undefined;
  // Folded WITHOUT highestRequirement's baseline seed: this answer is the
  // capabilities' own maximum and must not inherit an unrelated floor, in either
  // direction. Trimmed because the value is rendered into a user-facing
  // sentence. (Every entry is already screened, so compareSemver's
  // equal-vs-unparseable ambiguity cannot bite here.)
  const parsed = raw.map((v) => (v as string).trim());
  return parsed.reduce((best, v) => (compareSemver(v, best) > 0 ? v : best));
}

/**
 * Is the INSTALL even the problem?
 *
 * A stale browser bundle and a stale install produce the SAME refusal — the tab
 * advertises an old capability set either way — but they have opposite remedies,
 * and telling a user to update an install that is already current is what makes
 * the loop feel unfixable. Distinguishing them needs two facts observed at the
 * same moment, and both already exist: the tab's advertised version arrives in
 * its `hello`, and the orchestrator runs the panel sync on that SAME hello,
 * which reads the installed version off disk (panelStatus records it).
 *
 * Returns a skew ONLY on positive proof, because the cost of a wrong answer is
 * asymmetric: claiming "your install is fine, just refresh" to someone whose
 * install is genuinely behind sends them straight back round the loop. So all of
 * these must hold, and any unknown resolves to "no skew" (fall through to the
 * ordinary update guidance):
 *
 *   - `verifiedPanelDiskVersion()` returns a version, which means the pack is
 *     STILL the panel and STILL there: it re-reads the pyproject NOW, from the
 *     directory the last scan found, for the ComfyUI we are CURRENTLY targeting.
 *     A recorded version is never trusted on its own — the pack may have been
 *     removed, downgraded, or replaced since, and the target may have changed
 *     out from under the observation (the orchestrator kicks off the panel sync
 *     and retargets in the same hello handler);
 *   - that version PARSES and is >= the required floor — the install is
 *     provably not the problem;
 *   - the tab advertised NO version, or one that parses and is BELOW the floor.
 *     A tab claiming the same current version yet missing the capability is some
 *     other fault, not this one, and must not be given this diagnosis.
 */
/** @param panelVersion the version THIS connection ADVERTISED in its own hello —
 *  never `conn.panelVersion` raw, which is inherited across an omitted-version
 *  reconnect. Reasoning about an inherited value here would let a previous
 *  connection's reading decide whether the CURRENT tab is the stale part. */
function resolveStaleBundleSkew(
  panelVersion?: string,
): PanelBundleSkew | { diskVersionUnconfirmed: true } | undefined {
  const disk = verifiedPanelDiskVersion()?.trim();
  if (!disk) {
    // Could not confirm — most often because the live-base resolution has gone
    // stale and this refusal is the first thing to ask in a while. Refresh it in
    // the background (never awaited; building an error message must not block on
    // I/O) so a retry, which agents reliably make, can answer properly.
    void primePanelBase().catch(() => {});
    // #973 — but say so. Returning a bare `undefined` here is indistinguishable
    // from "checked, and the install really is behind", and the recovery text
    // then leads with an update this branch never established was needed. The
    // reporter followed exactly that and found their pack already current.
    return { diskVersionUnconfirmed: true };
  }
  // THE FENCE's floor, not the aggregate requiredPanelVersion() (codex gate).
  // This function answers one question — "is the install sufficient for the
  // WRITE that was just refused?" — and the aggregate answers a different one
  // ("is it sufficient for everything this build might want?"). Using the
  // aggregate is wrong in both directions:
  //   - too strict: an unrelated command declaring a higher minimum would deny
  //     the positive proof for a disk panel that IS sufficient for this write,
  //     and send a user whose only problem is a cached tab off to update;
  //   - self-contradictory: with an incomplete fence table the aggregate still
  //     returns a number, so the same refusal could say "Do NOT update — your
  //     0.11.35 meets the 0.11.30+ required" while its other half says it cannot
  //     state the fence version at all.
  // And when the fence's own floor is unknowable, nothing is proven: no skew.
  const required = requiredPanelVersionForWorkflowFence();
  if (!required) return undefined;
  if (!SEMVER_RE.test(disk) || !SEMVER_RE.test(required.trim())) return undefined;
  if (compareSemver(disk, required) < 0) return undefined; // install really IS behind

  const advertised = panelVersion?.trim();
  if (advertised) {
    // Defence in depth. The caller now screens the handshake value against
    // SEMVER_RE and passes `undefined` for anything unparseable, so a value that
    // reaches here is already a version — but this must not become the ONLY
    // screen: returning undefined for an unparseable string would silently drop
    // the diagnosis for the "nightly" case (a git-installed pack), which is
    // precisely the population that ends up in this refusal. An unparseable
    // reading is an ABSENT reading, and the caller resolves it as one.
    if (!SEMVER_RE.test(advertised)) return undefined;
    if (compareSemver(advertised, required) >= 0) return undefined;
  }
  return {
    diskVersion: disk,
    handshakeVersion: advertised || undefined,
    requiredVersion: required,
  };
}

/** True when the panel ADVERTISED a PARSEABLE version (in its `hello`) that already
 *  meets `cmd`'s AUTHORITATIVE, command-specific minimum — i.e. this panel is provably
 *  new enough to support the command, so an "Unknown command" reply is NOT an age
 *  problem and must never be rewritten into a "too old — update your panel" verdict
 *  (#352 false negative).
 *
 *  Only an EXPLICIT BRIDGE_CMD_MIN_PANEL_VERSION entry counts as proof. A command with
 *  NO entry has no known real minimum — the inflated full-set fallback baseline (0.11.4)
 *  is a GUESS, not proof — so we can never certify a panel "new enough" for it. Trusting
 *  that guess is exactly what leaked #619: refresh_nodes (real min 0.11.28) was unlisted,
 *  the 0.11.4 fallback said a 0.11.20 panel was "new enough", and the panel's genuine
 *  "Unknown command" reply passed through raw instead of being rewritten. So an unlisted
 *  command returns false here → makeUnknownCommandError produces an actionable "update
 *  your panel" message (never a bare passthrough of the opaque internal command name).
 *  Mirrors panelVersionProvesUnsupported, which likewise trusts only tabled minimums.
 *
 *  Missing OR unparseable panelVersion → we can't PROVE it's new enough, so treat as
 *  not-proven (fall through to the honest too-old path, which quotes the correct
 *  minimum, and keep the #236 learning path intact). */
function panelSupportsCmd(cmd: string, panelVersion?: string): boolean {
  const min = BRIDGE_CMD_MIN_PANEL_VERSION[cmd];
  if (!min) return false;
  if (!panelVersion || !SEMVER_RE.test(panelVersion.trim())) return false;
  return compareSemver(panelVersion, min) >= 0;
}

/** True when the panel's ADVERTISED version PARSEABLY PROVES it is too old to
 *  support `cmd` — the mirror image of panelSupportsCmd, used to PROACTIVELY gate a
 *  call BEFORE dispatch (#392) so the honest "update your panel" verdict fires on
 *  the FIRST call, with no wasted round-trip to collect an "Unknown command" reply
 *  (and even when a frozen old panel wouldn't cleanly reply at all).
 *
 *  Deliberately gates ONLY commands with an EXPLICIT, changelog-verified entry in
 *  BRIDGE_CMD_MIN_PANEL_VERSION. A command NOT listed there falls back to the
 *  inflated full-set baseline (0.11.4) which is WRONG as a proactive minimum for the
 *  many bridge commands that shipped much earlier — using it here would FALSE-GATE a
 *  capable 0.4.6–0.11.3 panel out of e.g. graph_get_errors. So an unlisted command is
 *  NEVER proactively gated; it still learns unsupported reactively from a real
 *  rejection (#236). Missing/unparseable version also returns false (can't prove it —
 *  fall through to the reactive path, preserving fail-open). */
export function panelVersionProvesUnsupported(cmd: string, panelVersion?: string): boolean {
  const min = BRIDGE_CMD_MIN_PANEL_VERSION[cmd];
  if (!min) return false;
  if (!panelVersion || !SEMVER_RE.test(panelVersion.trim())) return false;
  return compareSemver(panelVersion, min) < 0;
}

/** The actionable "update your panel" message for a command a connected panel has
 *  been discovered NOT to support. Shared by the reactive path (the panel's own
 *  "Unknown command" reply, mapped by makeUnknownCommandError) and the proactive
 *  gate (#236 — a command already known-unsupported for THIS connection, from an
 *  earlier call in the same session) so both produce the identical message.
 *
 *  A command WITH an authoritative table entry gets a "too old … update to ≥X"
 *  verdict quoting its COMMAND-SPECIFIC minimum (#352) — not a blanket 0.11.4.
 *  A command with NO table entry has no KNOWN real minimum: the 0.11.4 fallback
 *  baseline is a floor for the full bridge set, NOT this command's introduction
 *  version, so quoting it fabricates a requirement the connected panel may already
 *  satisfy — #619's recurrence was exactly that self-contradiction (`too old for
 *  "graph_resize_node" (detected 0.11.21) — update … to ≥0.11.4`). Every call that
 *  reaches here for an untabled command carries a REAL "Unknown command" rejection
 *  from THIS connection (reactive path or the #236 learned gate — the #392 version
 *  gate only ever fires for tabled commands), so "this panel build does not
 *  implement it" is an observed fact, and "update to the latest release" is the
 *  only remedy guaranteed sufficient — never a fabricated, possibly-already-met
 *  version number.
 *
 *  The "(detected …)" parenthetical names BOTH sides of the skew (#422): the
 *  detected PANEL build (when known) AND the detecting MCP server build. A
 *  "stale panel version" report is only actionable when the reader can see which
 *  MCP build made the verdict — an outdated orchestrator can hold an outdated
 *  minimum table, so both versions belong in the error. The MCP version is
 *  resolved once per process (it cannot change without a restart); callers may
 *  pass `mcpVersion` explicitly (tests). */
// The resolution result is cached BOTH ways — an unavailable version (or a
// throwing detectInstallMode) resolves to null ONCE, never re-probed per error
// (codex gate: undefined would conflate 'not yet resolved' with 'unavailable'
// and re-run detectInstallMode on every error on those installs).
let cachedMcpVersion: string | null | undefined;
function mcpServerVersion(): string | undefined {
  if (cachedMcpVersion === undefined) {
    try {
      cachedMcpVersion = detectInstallMode().currentVersion ?? null;
    } catch {
      cachedMcpVersion = null;
    }
  }
  return cachedMcpVersion ?? undefined;
}

function buildPanelTooOldError(
  cmd: string,
  reading: PanelVersionReading,
  mcpVersion: string | undefined = mcpServerVersion(),
): Error {
  const mcpTail = mcpVersion ? `, mcp ${mcpVersion}` : "";
  const detected = reading.version
    ? ` (detected panel ${reading.version}${mcpTail})`
    : reading.raw
      ? // The value is EVIDENCE, quoted so it reads as a string rather than as a
        // version. "nightly" is the common one — ComfyUI-Manager's answer for a
        // git-installed pack — and it used to render as "detected panel nightly",
        // a version-shaped claim about something never parsed.
        ` (this panel reports "${reading.raw}", which is not a comparable version${mcpTail})`
      : reading.inherited
        ? // Observed by an EARLIER connection, not this one. Disclosed, because
          // it is real, and labelled, because attributing it to this handshake
          // would be a claim nothing here supports.
          ` (this connection advertised no panel version; an earlier connection for this tab ` +
          `reported ${reading.inherited}, which may be out of date${mcpTail})`
        // No advertised version at all (legacy/cached sidebar that predates
        // `panel_version` in hello — #619 recurrence). Still name the connected
        // panel as unknown so the skew message is complete; do not omit the
        // parenthetical and skip the upgrade remedy.
        : ` (detected panel unknown${mcpTail})`;
  const min = BRIDGE_CMD_MIN_PANEL_VERSION[cmd];
  // "TOO OLD" IS AN AGE VERDICT, and it may only be reached from an age
  // OBSERVATION: a version that parsed AND compares below the command's known
  // minimum. Everything else — no version, an unparseable one — has exactly one
  // observed fact behind it, the panel's own "Unknown command" reply, and that
  // fact is "does not implement", not "is old". The remedy is unchanged either
  // way, and the command's true minimum is still quoted when it is known, so
  // nothing actionable is lost by declining to guess the cause.
  const provenOld =
    !!min && !!reading.version && SEMVER_RE.test(min.trim()) && compareSemver(reading.version, min) < 0;
  const remedy = min
    ? `update the ComfyUI-MCP panel to ≥${min} (ComfyUI Manager → update comfyui-mcp panel), then reconnect.`
    : `update the ComfyUI-MCP panel to the latest release (ComfyUI Manager → update comfyui-mcp panel), then reconnect.`;
  const e = new Error(
    provenOld
      ? `This ComfyUI-MCP panel is too old for "${cmd}"${detected} — ${remedy}`
      : `This ComfyUI-MCP panel does not implement "${cmd}"${detected} — ${remedy}`,
  );
  // STRUCTURED discriminator (#413): both the reactive rewrite and the #236
  // proactive gate funnel through here, so tagging the error object lets callers
  // detect an unsupported-command rejection WITHOUT string-matching a message
  // that was already rewritten away from the panel's raw "Unknown command" text.
  // panel_strip_workflow relies on this to still take its graph_get_state
  // back-compat fallback (which was skipped when the message no longer contained
  // "unknown command").
  (e as PanelCmdUnsupportedError).panelCmdUnsupported = cmd;
  return e;
}

/** An Error carrying the bridge command a connected panel was proven NOT to
 *  support (too old / unknown command). Produced by buildPanelTooOldError. */
export interface PanelCmdUnsupportedError extends Error {
  panelCmdUnsupported: string;
}

/** True when `err` is (or plausibly is) an unsupported-command rejection for
 *  `cmd` — either the STRUCTURED tag set by buildPanelTooOldError (authoritative),
 *  or, as a belt-and-suspenders fallback for errors that never passed through the
 *  rewrite (or lost the tag crossing an MCP boundary), the raw panel "Unknown
 *  command" text or either rewritten phrasing ("too old for" for a tabled command,
 *  "does not implement" for an untabled one — #619). Callers that carry a graceful
 *  fallback (e.g. panel_strip_workflow's graph_get_state reconstruction,
 *  #384/#413) use this to decide whether to try it. When `cmd` is given, a
 *  structured tag must match it. */
export function isPanelCmdUnsupportedError(err: unknown, cmd?: string): boolean {
  const tag = (err as Partial<PanelCmdUnsupportedError> | null | undefined)
    ?.panelCmdUnsupported;
  if (typeof tag === "string") return cmd == null || tag === cmd;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const parsed = parseUnknownCommandReply(msg);
  if (parsed) return cmd == null || parsed === cmd;
  const cmdPat = cmd ? cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "[\\w.-]+";
  return (
    new RegExp(`too old for\\s*["“']?${cmdPat}`, "i").test(msg) ||
    new RegExp(`does not implement\\s*["“']?${cmdPat}`, "i").test(msg)
  );
}

/**
 * A panel replies `{ ok: false, error: 'Unknown command "<cmd>"' }` when the
 * orchestrator dispatches a bridge command the (older) panel doesn't register —
 * graph_query, ui_render, graph_serialize, graph_view_nodes_in_viewport, etc. are
 * registered only from the panel version each was introduced in (see
 * BRIDGE_CMD_MIN_PANEL_VERSION — NOT a blanket 0.11.4; graph_query shipped at 0.7.0,
 * graph_outline at 0.4.6). Detect that raw dispatch error and rewrite it
 * into an actionable "update your panel" message instead of surfacing the opaque
 * internal command name to the agent/user. Returns null when `error` is anything
 * else (a genuine command failure), so the happy/normal-error path is untouched.
 *
 * Also matches the legacy/cached spelling `unknown <cmd>` (no "command" word,
 * no quotes) that a sidebar tab predating the current dispatcher used — the
 * #619 recurrence on 0.52.147 leaked `Error: unknown graph_outline` because
 * only the `Unknown command "…"` shape was recognized.
 */
/** Current dispatcher: `Unknown command "graph_query"` (quotes optional). */
const UNKNOWN_COMMAND_RE = /^unknown command\s*["“']?([\w.-]+)["”']?/i;
/** Legacy/cached dispatcher: the entire message is `unknown graph_outline`. */
const UNKNOWN_BARE_CMD_RE = /^unknown\s+["“']?([\w.-]+)["”']?\s*$/i;

/** True when `token` is a bridge command name, not English (`unknown node`). */
function looksLikeBridgeCommand(cmd: string): boolean {
  if (BRIDGE_CMD_MIN_PANEL_VERSION[cmd]) return true;
  return /^(?:graph|ui|workflow|refresh|nodes)_[\w.-]+$/.test(cmd);
}

/** Extract the command from either dispatcher spelling. Shared so the rewrite,
 *  the #422 veto-revocation, and the tagless unsupported detector agree. */
function parseUnknownCommandReply(error: string): string | null {
  const text = String(error ?? "")
    .trim()
    .replace(/^error:\s+/i, "")
    .trim();
  const withCommand = UNKNOWN_COMMAND_RE.exec(text);
  if (withCommand) return withCommand[1];
  const bare = UNKNOWN_BARE_CMD_RE.exec(text);
  if (!bare) return null;
  return looksLikeBridgeCommand(bare[1]) ? bare[1] : null;
}

/** True when `error` is the panel's own "Unknown command" dispatch reply — proof this
 *  build does NOT implement the command, INDEPENDENT of any advertised-version guard
 *  (#422). Used to revoke a stale proven-supported veto even when the version is new
 *  enough to suppress the "too old" rewrite, so a genuine downgrade always re-gates. */
export function isUnknownCommandReply(error: string): boolean {
  return parseUnknownCommandReply(error) != null;
}

export function makeUnknownCommandError(
  error: string,
  /** A raw handshake string (callers with nothing else) or, preferably, an
   *  already-screened reading carrying parseability AND provenance. */
  panelVersion?: string | PanelVersionReading,
  mcpVersion?: string,
): Error | null {
  // Current shape: `Unknown command "graph_query"`. Recurrence shape: `unknown
  // graph_outline` (and the MCP-prefixed `Error: unknown graph_outline`). Start-
  // anchored so an error that merely quotes the phrase mid-message is not rewritten.
  const cmd = parseUnknownCommandReply(error);
  if (!cmd) return null;
  // #352 FALSE-NEGATIVE GUARD: if the panel advertised a version that already
  // meets this command's real minimum, the panel is NOT too old — an "Unknown
  // command" reply here means something else (a genuinely retired/renamed command,
  // or a transient), so do NOT rewrite it into a bogus "update your panel" verdict
  // (which would also POISON the #236 unsupported-cmd gate against a capable panel).
  // Return null so the raw error surfaces and the gate is never poisoned.
  const reading =
    typeof panelVersion === "object" && panelVersion !== null
      ? panelVersion
      : readPanelVersion(panelVersion);
  // TWO DIFFERENT QUESTIONS, deliberately given different inputs.
  //
  // The #352 VETO asks "might this rewrite be bogus?", and its fail-safe answer
  // is to suppress: surface the raw error and do not poison the #236 learned
  // gate. An inherited version is weak evidence, but it is evidence, and being
  // conservative here costs only a less-friendly message — so it keeps the value
  // this call site has always given it, and the gate's behaviour is unchanged.
  if (panelSupportsCmd(cmd, reading.version ?? reading.inherited)) return null;
  // The MESSAGE asks "what did we observe?", and may only state what THIS
  // connection saw. The raw handshake string ends here: everything downstream
  // sees a screened reading, so an unparseable value cannot be rendered as a
  // version, and an inherited one cannot be attributed to this connection (both
  // of which this consumer used to do — it built its own view of the raw field).
  return buildPanelTooOldError(cmd, reading, mcpVersion);
}

/**
 * Bridge commands with NO side effect — safe to re-dispatch after a reconnect and
 * safe to WAIT ON longer (a read can't be double-applied). Module-level so both
 * the mutating-vs-read classification and the default-timeout policy share one
 * authoritative list. Everything not listed is treated as mutating.
 */
/**
 * #770/#803 — the result of reading a tab's trusted workflow command stamp.
 * Three states, because "could not read it" is not "there is none": collapsing
 * them is what let a recovery report an absence it never observed. See
 * {@link UiBridge.workflowUuidFor}.
 */
export type TabWorkflowUuidRead =
  | { known: true; uuid?: string }
  | { known: false; reason: string };

/** #2314 — the latest structured current-view identity observed from a panel
 * reply. This is deliberately separate from the workflow stamp: two subgraphs
 * in one workflow may reuse the same inner node ids and types. */
export type TabPromotedScopeRead =
  | {
      known: true;
      scope: "root" | "subgraph";
      ownerNodeId: string | null;
      workflowUuid?: string;
      graphIdentity?: string;
    }
  | { known: false; reason: string };

/**
 * What the orchestrator's fence-adoption validator answers (#1077).
 *
 * `boolean` is still accepted so the injected resolver can stay simple (and so
 * every existing test that registers only the read half keeps compiling); the
 * object form carries the REASON a refusal happened, which is the difference
 * between "the adoption was refused" and an actionable message.
 */
export type FenceAdoptOutcome = boolean | { ok: true } | { ok: false; reason: string };

export const BRIDGE_READONLY_CMDS: ReadonlySet<string> = new Set<string>([
  "graph_serialize",
  // Reads the tab's own /object_info and returns it. Touches nothing.
  "graph_get_object_info",
  // #1400: reads the tab's LiteGraph class registry and probe-constructs
  // provenance-clean classes off-graph. Touches no canvas; idempotent — safe to
  // re-dispatch after a socket drop (the orchestrator pulls it on every hello).
  "graph_get_virtual_types",
  "graph_outline",
  "graph_get_errors",
  "graph_get_state",
  "graph_get_subgraph",
  "graph_view_selected",
  "graph_view_nodes_in_viewport",
  // panel#2191 — a capture, and nothing else. The frontend handler saves
  // ds.scale / ds.offset, LiteGraph.vueNodesMode and the active (sub)graph, fits
  // the whole graph, draws, encodes a PNG, and restores all four in a `finally`.
  // Re-dispatching it after a reconnect re-takes the same picture; it is strictly
  // SAFER to replay than the two entries above it, which move the user's viewport
  // and do not put it back.
  //
  // Its absence here was not a judgement, it was an omission — and it was the
  // whole of panel#2191. `ctx.mutating` is `!READONLY_CMDS.has(cmd)`, so a
  // reply-timeout on a screenshot told the reporter their screenshot "MUTATES and
  // was already delivered to the tab … a blind retry can apply it twice", about a
  // command GRAPH_CMD_EFFECT (thirty lines below) already classifies as `inert`
  // and the panel's own READ_ONLY_GRAPH_COMMANDS already classifies as a read.
  // Two ledgers said read; the one that writes the message said mutation.
  //
  // THE CONSEQUENCE, written down because it is NOT free and a reviewer should
  // not have to reconstruct it. Membership here also makes a command eligible for
  // handleMidCommandDisconnect's park-and-resume — and that resume used to key on
  // `ctx.tabId` ALONE, so a route key that RECURS (#486: "same key is not the same
  // tab") could hand a parked read to whichever tab happened to hold the key at
  // resume time. #2761 closed that at both resume sites: a parked read now resumes
  // only onto a connection that PROVES it is the tab that issued it (see
  // `isProvenSameTab`). A wrong-tab SERIALIZE — worse than a wrong-tab picture,
  // because it drives edits — can no longer resolve the departed caller's promise.
  //
  // The price, paid knowingly: a panel that advertises no `tab_session_id` can
  // never prove a return, so membership here no longer buys it reconnect survival
  // — its mid-command drop fails immediately instead. Every current panel that
  // routes at all sends one, so this falls on old builds, and it is the same side
  // `tabConnectionIdentity` already takes for them.
  //
  // This entry declines the park branch outright anyway: the panel_screenshot call
  // site passes `maxReconnectRetries: 0`. A screenshot that drops mid-capture fails
  // honestly and is free to re-ask, so it has nothing to gain from resuming.
  "graph_screenshot",
  "graph_prompt_director_audit",
  "graph_query",
  "civitai_results",
  // #2145: Manager search reads registry data only; it does not touch the canvas.
  "nodes_search",
  // #2181: Manager queue status only observes install progress; it is safe to
  // re-dispatch after a reconnect and must not report mutation outcome warnings.
  "nodes_queue_status",
  // #2283: fixed ComfyUI diagnostics reads relayed through the authenticated
  // panel channel; safe to resume after a bridge reconnect.
  "fetch_comfyui_read",
  "get_todo",
  // #608: a forced /object_info re-register + combo refresh. It has NO effect on
  // graph content — it only re-registers node defs and rebuilds combo option lists
  // (idempotent, undo-neutral) — so it is classified with the READS: it earns the
  // tolerant read default timeout (a fresh /object_info on a large install can run
  // many seconds), and on a mid-command socket drop it is PARKED and resumed on the
  // tab's re-hello rather than surfacing a scary OUTCOME-UNKNOWN the orchestrator
  // won't retry. Re-running it is always safe.
  "refresh_nodes",
]);

/**
 * What a `graph_*` command can do to the user's WORKFLOW — the single question
 * the #570 write gate asks.
 *
 * THIS IS A LEDGER, NOT A DERIVED SET (#778). The gate used to answer its
 * question with a value computed for a DIFFERENT one: `BRIDGE_READONLY_CMDS`
 * exists to decide the default reply timeout and whether a mid-command socket
 * drop may be parked and resumed, so it lists only commands that are safe to
 * RE-DISPATCH. Reading "not in that set" as "mutates the canvas" silently
 * misclassified every command that is a genuine read but not idempotently
 * re-dispatchable — and every view/selection/scope change, which touches no
 * workflow content at all. `graph_find_nodes` (#778) was the reported instance;
 * `graph_list_subgraphs`, `graph_screenshot`, `graph_canvas`,
 * `graph_select_nodes`, `graph_enter_subgraph`, `graph_exit_subgraph` and
 * `graph_copy_nodes` were the same defect, unreported. (`graph_screenshot` was
 * later reported on its own — panel#2191, where the mutation reading reached the
 * user as "this command MUTATES … a blind retry can apply it twice" — and is now
 * in BRIDGE_READONLY_CMDS as well as here.) The orchestrator already
 * knew they were reads — RETRY_TOKEN_CMD_BY_TOOL's doc names them one by one as
 * "view/read-only" and "reads in spirit" — but that knowledge lived in a third
 * list, so the gate could not see it.
 *
 * So each command is classified ONCE, here, by effect:
 *
 *  - `inert`    — cannot change workflow CONTENT and cannot act on it. Pure
 *                 queries, plus viewport / selection / subgraph-scope /
 *                 clipboard changes. Delivered to the wrong workflow after a
 *                 tab switch, the worst case is that the user is looking at
 *                 something unexpected — nothing of theirs is altered, so the
 *                 per-command workflow fence buys nothing and refusing these on
 *                 an old panel only removes read access for no safety gain.
 *  - `targeted` — changes workflow content, publishes from it, or queues a
 *                 render of it. A delivered frame cannot be retracted, so these
 *                 MUST be fenced to the workflow they were issued for.
 *
 * Unlisted commands FAIL CLOSED to `targeted`: a command nobody classified must
 * never be waved through the gate by omission. `graph-command-effect.test.ts`
 * turns that silent fallback into a failing test by scanning the orchestrator
 * for every `graph_*` command it actually dispatches and requiring an entry
 * here — which is the part that was missing when #778 shipped.
 */
export type GraphCmdEffect = "inert" | "targeted";

export const GRAPH_CMD_EFFECT: Readonly<Record<string, GraphCmdEffect>> = {
  // ---- inert: reads -------------------------------------------------------
  graph_serialize: "inert",
  graph_get_object_info: "inert",
  // #1400 — a registry query, not a canvas one: it describes the page's node
  // CLASSES, and no workflow's content or identity rides on it.
  graph_get_virtual_types: "inert",
  graph_outline: "inert",
  graph_get_errors: "inert",
  graph_get_state: "inert",
  graph_get_subgraph: "inert",
  graph_prompt_director_audit: "inert",
  graph_query: "inert",
  // #778 — the reported instance: a filtered node query, no different from
  // graph_query, refused as a canvas mutation on a panel that does not advertise
  // the workflow fence.
  graph_find_nodes: "inert",
  // Lists saved subgraph BLUEPRINTS from the user's library. Its own tool
  // description ends "Read-only."
  graph_list_subgraphs: "inert",
  graph_screenshot: "inert",
  // ---- inert: view / selection / scope / clipboard ------------------------
  graph_view_selected: "inert",
  graph_view_nodes_in_viewport: "inert",
  // Moves the viewport only ("It changes what they are looking AT and returns
  // nothing about the graph … View-only"). NOT added to BRIDGE_READONLY_CMDS:
  // `pan` is a dx/dy DELTA, so re-dispatching it after a reconnect would pan
  // twice. Inert for the fence, not idempotent for the parker — which is exactly
  // the distinction collapsing the two lists destroyed.
  graph_canvas: "inert",
  graph_select_nodes: "inert",
  graph_enter_subgraph: "inert",
  graph_exit_subgraph: "inert",
  // Reads nodes OUT of the graph into the clipboard. Writes nothing back; the
  // paste that would write is `graph_paste_nodes`, which is targeted.
  graph_copy_nodes: "inert",
  // ---- targeted: content edits -------------------------------------------
  graph_add_node: "targeted",
  graph_remove_node: "targeted",
  graph_clear: "targeted",
  graph_connect: "targeted",
  graph_disconnect: "targeted",
  graph_set_widget: "targeted",
  // Removes ONE dynamic widget row (artokun/comfyui-mcp#938). "targeted" for the same
  // reason set_widget is: it changes one node's content, and it awaits a fresh
  // /object_info before writing — so it needs the fence that covers the await, not only
  // the one at dispatch.
  graph_remove_widget: "targeted",
  graph_set_node_property: "targeted",
  // artokun/comfyui-mcp#1709 — writes App Mode metadata (extra.linearData /
  // extra.linearMode) onto the live root graph. Not a node edit, but it mutates
  // the open workflow, so the fence's "acts on the workflow it was issued for"
  // promise applies exactly as it does to graph_load.
  graph_configure_app_mode: "targeted",
  graph_move_node: "targeted",
  graph_resize_node: "targeted",
  graph_set_title: "targeted",
  graph_set_node_collapsed: "targeted",
  graph_set_node_color: "targeted",
  graph_edit_node: "targeted",
  graph_set_node_mode: "targeted",
  graph_update_node: "targeted",
  graph_create_group: "targeted",
  graph_edit_group: "targeted",
  graph_remove_group: "targeted",
  graph_move_group: "targeted",
  graph_create_subgraph: "targeted",
  graph_add_subgraph: "targeted",
  graph_unpack_subgraph: "targeted",
  graph_subgraph_group: "targeted",
  graph_expose_subgraph_input: "targeted",
  graph_expose_subgraph_output: "targeted",
  // Removes a boundary slot and drops the wires crossing it (artokun/comfyui-mcp#1294)
  // — a content edit, same class as the expose pair it inverts.
  graph_unexpose_subgraph_input: "targeted",
  graph_unexpose_subgraph_output: "targeted",
  graph_promote_widget: "targeted",
  graph_move_rail: "targeted",
  graph_paste_nodes: "targeted",
  graph_auto_layout: "targeted",
  graph_load: "targeted",
  // Publishes a subgraph node from THIS graph into the user's blueprint library
  // — a persistent artifact built from whichever workflow received the command.
  graph_save_subgraph: "targeted",
  // Does not edit the graph, but QUEUES it: the wrong workflow would consume the
  // GPU and write output files the user never asked for. The fence's promise is
  // "this command acts on the workflow it was issued for", and a render is an
  // act on it.
  graph_run: "targeted",
};

/**
 * Every `graph_*` command this process has had to classify BY DEFAULT, because
 * it had no GRAPH_CMD_EFFECT entry.
 *
 * The ledger's completeness is checked by scanning the sources for the commands
 * the orchestrator dispatches — and a source scan can only see what it can
 * recognise. A command routed through a helper, an alias, or a computed name
 * walks around it, the suite stays green, and the command silently falls back to
 * `targeted`: the unclassified-read over-refusal (#778) rebuilt behind the guard
 * that exists to prevent it. That is the same shape as the vocabulary ratchet,
 * where deleting a baseline line is the documented way to disarm the gate.
 *
 * So the fallback also RECORDS, at the point of use. This observation cannot be
 * evaded by how a call is spelled — it is taken from the command actually being
 * routed — and it gives the tests an assertion that does not depend on reading
 * source text: drive the real tool surface, then assert this set is empty.
 */
const unclassifiedGraphCmds = new Set<string>();

/** The `graph_*` commands classified by fallback since process start. Empty is
 *  the invariant; anything in it is a ledger gap, not a runtime condition. */
export function unclassifiedGraphCommandsSeen(): ReadonlySet<string> {
  return unclassifiedGraphCmds;
}

/** Test hook — clear the record between probes. */
export function __resetUnclassifiedGraphCommands(): void {
  unclassifiedGraphCmds.clear();
}

/** Record + warn ONCE per command name. Deliberately cannot throw: this runs on
 *  the dispatch path of every graph command, and a guard that can fail is not a
 *  guard. It does not change the decision — the fallback is still `targeted`,
 *  still fail-closed; it only makes the fallback observable instead of silent. */
function noteUnclassifiedGraphCmd(cmdName: string): void {
  if (unclassifiedGraphCmds.has(cmdName)) return;
  unclassifiedGraphCmds.add(cmdName);
  try {
    logger.warn(
      `[ui-bridge] graph command "${cmdName}" has no GRAPH_CMD_EFFECT entry — fencing it as a ` +
        `WRITE by default. If it is a read or a view/selection change this needlessly refuses ` +
        `it on every panel below the workflow-fence version (#778). Classify it in ` +
        `GRAPH_CMD_EFFECT (src/services/ui-bridge.ts).`,
    );
  } catch {
    /* an error-path guard must never become the error */
  }
}

/** #570 P0c — a graph command that must be fenced to the workflow it was issued for.
 *  Answered from GRAPH_CMD_EFFECT, which classifies by EFFECT; an unlisted `graph_*`
 *  command fails closed to `targeted` so a new mutator is never waved through by
 *  omission — and is recorded (see unclassifiedGraphCommandsSeen) so the omission
 *  is visible rather than silent. */
export function isMutatingGraphCommand(cmdName: string): boolean {
  if (!cmdName.startsWith("graph_")) return false;
  const effect = GRAPH_CMD_EFFECT[cmdName];
  if (effect === undefined) {
    noteUnclassifiedGraphCmd(cmdName);
    return true; // fail closed
  }
  return effect === "targeted";
}

/** #570 P0c — the four workflow mutators. workflow_save / workflow_save_as ignore any path and
 *  always target the active workflow; workflow_rename / workflow_close resolve a path selector
 *  against the panel's OPEN workflows (`path ? openWorkflows.find(path) : activeWorkflow`), which
 *  the SERVER cannot evaluate — and a path that names a non-active workflow NOW can name the
 *  active one after an in-place replacement at that path. So the server cannot prove any of these
 *  stays off the active canvas and gates all four (an enforcing panel resolves the target
 *  precisely client-side; a non-enforcing panel fails closed — read-only for these ops). */
const ACTIVE_WORKFLOW_MUTATORS = new Set<string>([
  "workflow_save",
  "workflow_save_as",
  "workflow_rename",
  "workflow_close",
]);

/** #570 P0c — commands that MUTATE the currently-active workflow/canvas and must therefore be
 *  fenced to the workflow they were issued for. Fail closed for these unless the connected panel
 *  enforces the per-command workflow stamp (`workflow_open`/`workflow_new` are navigation/creation
 *  with their OWN explicit or new target — not active-content mutations — so they are excluded).
 *
 *  Decide by the COMMAND, not by a raw `path` string: the server cannot resolve a workflow path
 *  selector to a specific open workflow, and an in-place replacement can make a once-non-active
 *  path resolve to the active workflow — so raw path presence can never prove a rename/close
 *  stays off the active canvas. Hence all four workflow mutators are gated unconditionally; the
 *  ENFORCING panel's client-side fence (activeWorkflowFenceApplies) does the precise
 *  resolved-target check that safely exempts a deterministically non-active target. */
export function requiresWorkflowStampEnforcement(cmd: { cmd?: unknown }): boolean {
  const name = typeof cmd.cmd === "string" ? cmd.cmd : "";
  if (isMutatingGraphCommand(name)) return true;
  return ACTIVE_WORKFLOW_MUTATORS.has(name);
}

/** #602 — commands whose execution and reply never reference a canvas (Manager
 *  registry/server operations, ComfyUI-server controls). Mirrors the panel's
 *  CANVAS_INDEPENDENT_COMMANDS: a stale stamp/target pairing is irrelevant to
 *  them, so the dispatch-time agreement gate must not refuse them. */
const STAMP_TARGET_CANVAS_INDEPENDENT = new Set<string>([
  "nodes_search",
  "nodes_list",
  "nodes_install",
  "nodes_queue_status",
  "graph_update_node",
  // #1400 — reads the GLOBAL LiteGraph registry, never a canvas, and the
  // orchestrator pulls it at hello, where no workflow stamp exists to agree
  // with. Mirrors the panel's CANVAS_INDEPENDENT_COMMANDS entry.
  "graph_get_virtual_types",
  "comfy_reboot",
  "free_vram",
]);

/**
 * #1656/#1494 — the dispatch-time agreement gate's verdict, as a value.
 *
 * FOUR outcomes, not two, because the three non-refusing ones have to stay
 * distinguishable: `agrees` is an observation that the two identities match,
 * `unreadable` is an observation NOT MADE (a missing value is not divergence — the
 * panel's own fence judges those), and `same_address` means both answers came from
 * one lookup and could only ever agree. Collapsing them into a bare boolean is how a
 * "no refusal" would come to be reported as "the target was confirmed".
 */
export type StampTargetVerdict =
  | {
      refuses: false;
      kind: "agrees" | "unreadable" | "same_address";
      issuedFor?: string;
      landedOn?: string;
    }
  | { refuses: true; kind: "disagrees" | "carried"; issuedFor: string; landedOn: string };

/** #1656 — commands that read or mutate whichever canvas the routed tab has ACTIVE,
 *  and therefore may only be dispatched when the session's workflow stamp and the
 *  tab's reported active workflow AGREE (see the dispatch gate in send()).
 *
 *  Mirrors the panel's activeWorkflowFenceApplies as far as the server can evaluate
 *  it. Exempt, deliberately:
 *   - canvas-independent server/Manager commands (#602): no canvas to get wrong;
 *   - workflow_list: the fence-EXEMPT recovery probe — gating it would make the
 *     documented rebind depend on the fence being already-correct (panel #932's
 *     circularity), and its handler reads the live binding at execution time, so a
 *     stale pairing cannot make it report a stale answer;
 *   - workflow_open / workflow_new: navigation/creation with their own explicit or
 *     new target — they are how a diverged session re-selects;
 *   - workflow_rename / workflow_close carrying a path selector: the selector may
 *     name a genuinely NON-active workflow, which the panel resolves precisely and
 *     exempts; the server cannot evaluate that, so those stay with the panel's
 *     fence rather than risk a false refusal of a legitimate background op. */
export function requiresStampTargetAgreement(cmd: { cmd?: unknown }): boolean {
  const name = typeof cmd.cmd === "string" ? cmd.cmd : "";
  if (!name) return false;
  if (STAMP_TARGET_CANVAS_INDEPENDENT.has(name)) return false;
  if (name === "workflow_list" || name === "workflow_open" || name === "workflow_new") return false;
  if (name === "workflow_rename" || name === "workflow_close") {
    const path = (cmd as { path?: unknown }).path;
    return !(typeof path === "string" && path.trim());
  }
  if (name.startsWith("graph_")) return true;
  return name === "workflow_save" || name === "workflow_save_as";
}

/**
 * #1815 — which resolver address a command's `workflow_uuid` is taken from.
 *
 * Graph reads/writes and the four active-workflow mutators are issued FOR a
 * workflow: they keep the caller's address so a switch fails closed (#570/#1656).
 * Everything else (Manager search/install/reboot, the workflow_list recovery
 * probe, open/new) does not act on that workflow. Stamping those with the
 * conversation's issue-time identity is what wedged the reporter: the panel
 * compared the stale stamp and refused even `nodes_search`, and the documented
 * rebind then asked `workflow_list` under the same stamp and reported "the
 * panel did not answer". Those commands take the routed tab's last-advertised
 * identity instead — the live canvas, not the turn they were conceived in.
 */
export function commandStampAddress(
  cmd: { cmd?: unknown },
  callerTabId: string | undefined,
  routedTabId: string,
): string {
  return requiresStampTargetAgreement(cmd) ? (callerTabId ?? routedTabId) : routedTabId;
}

/**
 * Default reply timeout for a MUTATING command with no explicit timeout.
 *
 * This was 6000 ms — the flat pre-#574 default, kept when reads were raised to
 * 20 s, on the rationale "fail fast so the agent isn't blocked on a stuck write".
 * That rationale had the asymmetry backwards, and #694's recurrence is what it
 * costs: `panel_set_node_mode` timed out at 6 s on a live tab, and an immediate
 * `panel_query_graph` showed the mode HAD been set.
 *
 * The reason reads got 20 s applies to writes with more force, not less. It is the
 * same busy-but-alive main thread — a write does strictly more of that work, since
 * it mutates, re-renders, and answers the workflow-stamp check — and the two
 * failures are not equally expensive:
 *
 *   - A read abandoned too early costs a retry. Nothing is ambiguous.
 *   - A write abandoned too early is UNRECOVERABLE ambiguity. The command was
 *     already delivered, so it may have applied; the bridge deliberately refuses
 *     to auto-retry it (#334), and the caller is left to verify by hand before it
 *     can safely do anything. Which is exactly the manual step the reporter
 *     performed.
 *
 * So the cheap failure got the patience and the expensive one got the hair
 * trigger. Writes now wait as long as reads. This lowers how OFTEN a live tab is
 * declared unknown; it does not make an unknown recoverable — that needs the
 * caller-supplied retry identity #694 is actually about.
 *
 * Never below the read bound: see the invariant test.
 */
export const BRIDGE_DEFAULT_TIMEOUT_MS = 20_000;

/**
 * How long after a headless client's socket closes it still counts as present
 * for the #875 restart-deferral gate (#1176).
 *
 * Chosen from what the window has to cover and what it costs if it is wrong.
 *
 * It must cover: a phone whose screen went off, which the mobile OS suspends
 * within seconds and which reconnects when the user next picks it up. That is a
 * pocket interval — minutes to hours, unbounded in principle.
 *
 * It costs: a deferred auto-update, for this long, after a phone genuinely
 * leaves. Nothing is lost — the update applies at the next check — so the price
 * of being generous is a delay, while the price of being stingy is the reported
 * bug: a rotated tunnel hostname and a phone that cannot get back in.
 *
 * Asymmetric, so lean generous. Thirty minutes covers a meeting or a commute and
 * still lets an install that has truly lost its phone update within the hour,
 * with no unpairing step and no user action — which is the property that made the
 * sticky `isHeadless()` unacceptable for this gate.
 */
export const HEADLESS_RECENCY_MS = 30 * 60_000;

/**
 * The first panel version whose save / new-workflow replies carry `workflow_uuid`
 * (panel #800) — the value `refreshFenceFromOwnReply` (#1161) needs to repair a
 * session fence without the round trip the fence itself refuses.
 *
 * Verified against the panel repo rather than assumed: #800 landed after the
 * 0.11.44 release commit and first shipped in 0.11.45.
 */
export const PANEL_MIN_VERSION_REPLY_UUID = "0.11.45";
/** More tolerant default for a READ (idempotent) command with no explicit timeout.
 *  A legitimately busy-but-alive panel main thread — e.g. Preview3D parsing a large
 *  FBX — can take many seconds to service a graph_query; failing it at the tight
 *  6s default surfaced a FALSE "tab backgrounded or frozen" timeout even though a
 *  retry moments later succeeded (#357). Reads have no side effect, so waiting
 *  longer is safe; a genuinely dead/frozen tab still times out, just at this bound.
 *  Note: a WebSocket pong is answered by the browser network stack even while JS is
 *  blocked, so it can't distinguish busy-JS from dead-JS — a tolerant read timeout,
 *  not pong-liveness, is the correct lever here. */
export const BRIDGE_READ_DEFAULT_TIMEOUT_MS = 20_000;

/** The default reply timeout to use for `cmd` when the caller passed none. Read
 *  ops get the tolerant bound; everything else stays tight (#357). */
export function defaultBridgeTimeoutMs(cmdName: string): number {
  return BRIDGE_READONLY_CMDS.has(cmdName)
    ? BRIDGE_READ_DEFAULT_TIMEOUT_MS
    : BRIDGE_DEFAULT_TIMEOUT_MS;
}

export interface BridgeCommand {
  cmd: string;
  [key: string]: unknown;
}

function commandAskId(command: BridgeCommand): string | undefined {
  const id = command.ask_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function messageAskId(msg: Record<string, unknown>): string | undefined {
  const id = msg.ask_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** panel#1859 — the floor comes from the table the gate itself reads, so the
 * two can never disagree. With no parseable entry the sentence still names a
 * remedy; it just cannot name a number, which beats naming a wrong one. */
function fenceRefusal(tabId: string, fence: string, capability: string): Error {
  const floor = panelVersionForCapability(capability);
  return new Error(
    `graph_set_widget was refused before dispatch because panel tab ${tabId} ` +
      `does not advertise the atomic ${fence} write fence. Update the ` +
      `panel ${floor ? `to ${floor}+` : "to a build that advertises it"} and ` +
      `hard-refresh the browser tab.`,
  );
}

function expectedNodeTypeFenceRefusal(tabId: string): Error {
  return fenceRefusal(tabId, "expected-node-type", "enforces_expected_node_type_at_write");
}

function expectedNodeIdentityFenceRefusal(tabId: string): Error {
  return fenceRefusal(tabId, "expected-node-identity", "enforces_expected_node_identity_at_write");
}

function expectedScopeFenceRefusal(tabId: string): Error {
  return fenceRefusal(tabId, "promoted-scope", "enforces_expected_scope_at_write");
}

function expectedScopeGraphIdentityFenceRefusal(tabId: string): Error {
  return fenceRefusal(
    tabId,
    "promoted graph-identity",
    "enforces_expected_scope_graph_identity_at_write",
  );
}

function promotedParentRailFenceRefusal(tabId: string): Error {
  return fenceRefusal(tabId, "promoted parent-rail", "enforces_promoted_parent_rail_at_write");
}

function commandCarriesExpectedGraphIdentity(cmd: BridgeCommand): boolean {
  const scope = cmd.expected_scope;
  return !!scope && typeof scope === "object" && !Array.isArray(scope) &&
    Object.prototype.hasOwnProperty.call(scope, "graph_identity");
}

function commandCarriesPromotedParentRail(cmd: BridgeCommand): boolean {
  const scope = cmd.expected_scope;
  return !!scope && typeof scope === "object" && !Array.isArray(scope) &&
    Object.prototype.hasOwnProperty.call(scope, "parent_rail");
}

/** Normalize a syntactically valid HTTP(S) WebSocket handshake `Origin` into a
 *  canonical scheme://host:port string. This is metadata for diagnostics and
 *  workflow identity, not authentication: an arbitrary client can write the
 *  header when the listener is tokenless. Reject paths, queries, userinfo,
 *  unsupported schemes, and other values rather than stripping them into a
 *  value that looks trustworthy. */
function normalizeHandshakeOrigin(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw) && raw.length !== 1) return undefined;
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (typeof val !== "string" || val === "" || val.toLowerCase() === "null") return undefined;
  try {
    const u = new URL(val);
    if (
      (u.protocol !== "http:" && u.protocol !== "https:") ||
      u.username !== "" ||
      u.password !== "" ||
      u.pathname !== "/" ||
      u.search !== "" ||
      u.hash !== ""
    ) {
      return undefined;
    }
    // Origin serializes as scheme://host with no trailing slash. Requiring the
    // exact serialization prevents a client from smuggling a path-like spelling
    // that this boundary would otherwise normalize away.
    if (val !== `${u.protocol}//${u.host}`) return undefined;
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return `${u.protocol}//${u.hostname.toLowerCase()}:${port}`;
  } catch {
    return undefined;
  }
}

/** AUTHORITATIVE, TYPED dispatch outcome carried on a bridge command REJECTION so a
 *  caller never has to infer it from message text:
 *   - `false` = the command was NEVER written to the socket (a PRE-write send() failure);
 *   - `true`  = the command WAS written and the socket then died before a reply (a
 *     POST-write mid-command OUTCOME-UNKNOWN drop).
 *  Absent on all other errors (a reply-timeout, a genuine refusal, "panel gone", etc.). */
const DISPATCHED = Symbol.for("comfyui-mcp.bridge.dispatched");

/** Tag an error with the typed {@link DISPATCHED} outcome and return it (for throw/reject). */
export function markDispatched<E extends Error>(err: E, dispatched: boolean): E {
  Object.defineProperty(err, DISPATCHED, {
    value: dispatched,
    enumerable: false,
    configurable: true,
  });
  return err;
}

/** Read the typed dispatch outcome from an error, or undefined if it carries none.
 *  A reboot readiness check uses this to classify a PRE-write send failure
 *  (`false`) categorically as NOT-dispatched — never as an accepted/dropped reboot —
 *  regardless of any post-write phrase its message text may quote. */
export function dispatchOutcomeOf(err: unknown): boolean | undefined {
  if (err == null || (typeof err !== "object" && typeof err !== "function")) return undefined;
  const v = (err as Record<symbol, unknown>)[DISPATCHED];
  return typeof v === "boolean" ? v : undefined;
}

/** Marks an error as a card/command REPLY-TIMEOUT: the command WAS sent (or was about
 *  to be) and the tab simply never answered within the window — distinct from a
 *  disconnect ("panel gone") or a pre-write send failure. Callers that offer a
 *  late-answer grace (panel_ask / confirm / the adult-consent card) key their
 *  recoverable-timeout decision on THIS typed marker rather than parsing the message
 *  text, so an arbitrary tab_id (e.g. one containing spaces, which no text regex could
 *  reliably segment) can never misroute a genuine timeout away from the late-reply
 *  buffer. */
const REPLY_TIMEOUT = Symbol.for("comfyui-mcp.bridge.reply-timeout");

/** Marks an error as a CAPABILITY refusal: the connected panel does not enforce the
 *  workflow-stamp contract a mutation needs (#570/#718), so the command was refused
 *  pre-dispatch. Unlike a transient routing failure, NEITHER a retry nor a rebind can
 *  add the missing capability — only a panel update + browser hard-refresh can — so
 *  callers must key their recovery wording on THIS typed marker (#709) instead of
 *  appending the generic "retry / rebind" suffix, which sends the agent into a futile
 *  loop that contradicts the refusal's own guidance. */
const CAPABILITY_REFUSAL = Symbol.for("comfyui-mcp.bridge.capability-refusal");

/** Tag an error as a capability refusal and return it (for throw/reject). */
export function markCapabilityRefusal<E extends Error>(err: E): E {
  Object.defineProperty(err, CAPABILITY_REFUSAL, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return err;
}

/** True when `err` carries the typed capability-refusal marker set by the bridge. */
export function isCapabilityRefusal(err: unknown): boolean {
  if (err == null || (typeof err !== "object" && typeof err !== "function")) return false;
  return (err as Record<symbol, unknown>)[CAPABILITY_REFUSAL] === true;
}

/** Marks an error as a ROUTING-AMBIGUITY refusal: every tab is healthy and reachable,
 *  but the turn was issued from SEVERAL of them at once, so no single one is honestly
 *  "the" target (#884). Like a capability refusal this is pre-dispatch and settled —
 *  the pin is decided once per batch and does not heal on its own clock — but it is
 *  the OPPOSITE of a connectivity problem, and callers had no way to tell the two
 *  apart: the refusal opens with the literal phrase "no connected tab", which is also
 *  the machine-readable marker of the genuine post-restart "Connected: none" window.
 *  A substring classifier therefore read this as a transient reconnect, retried it
 *  pointlessly, and then reported "the panel is still reconnecting after a
 *  restart/reload" — a fabricated diagnosis of a panel that was never disconnected
 *  (#1001). Key on THIS marker, never on the text. */
const ROUTING_AMBIGUITY = Symbol.for("comfyui-mcp.bridge.routing-ambiguity");

/** Tag an error as a routing-ambiguity refusal and return it (for throw/reject). */
export function markRoutingAmbiguity<E extends Error>(err: E): E {
  Object.defineProperty(err, ROUTING_AMBIGUITY, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return err;
}

/** True when `err` carries the typed routing-ambiguity marker set by the bridge. */
export function isRoutingAmbiguity(err: unknown): boolean {
  if (err == null || (typeof err !== "object" && typeof err !== "function")) return false;
  return (err as Record<symbol, unknown>)[ROUTING_AMBIGUITY] === true;
}

/**
 * The disclosure appended to a reply-timeout for a MUTATING command.
 *
 * A reply-timeout and a mid-command disconnect carry the SAME risk — the request
 * was already written to the socket — but only the disconnect said so, in
 * handleMidCommandDisconnect's "OUTCOME UNKNOWN … verify before retrying". If
 * anything the timeout is the LIKELIER of the two to have applied: its write
 * SUCCEEDED on a live socket and the tab merely failed to answer in time, whereas
 * a drop may have killed the socket before the bytes landed.
 *
 * Yet its message ended at "the ComfyUI tab may be backgrounded or frozen", which
 * reads as an explanation for why nothing happened. A caller acting on that
 * re-issues the command — adding the node twice, queueing the render twice. The
 * bridge deliberately does not auto-retry a reply-timeout for exactly this reason
 * (isTransientReconnectError excludes it, #334); the message simply never told the
 * caller why, so the caller supplies the retry the bridge refused to.
 *
 * DELIBERATELY NOT the words "OUTCOME UNKNOWN". That string is a SENTINEL:
 * rebootDropped() and isReconnectDrop() in panel-tools.ts both identify a
 * POST-WRITE drop with /disconnected mid-command|OUTCOME UNKNOWN/i. Using it here
 * would silently reclassify every frozen-tab timeout as a drop — and
 * rebootDropped's contract EXPLICITLY excludes "did not reply within N ms",
 * because treating a live-but-frozen tab as an accepted reboot would let readiness
 * certify a cycle that was never requested. Same disclosure, different words, on
 * purpose. A read needs none of this: re-running it cannot double-apply.
 */
function mutatedButUnacked(ctx: SendCtx): string {
  if (!ctx.mutating) return "";
  return (
    `. This command MUTATES and was already delivered to the tab, so it may have been ` +
    `applied despite the missing reply — check the current state before re-issuing it; ` +
    `a blind retry can apply it twice`
  );
}

/**
 * #2069 — the clause after "within N ms". A sibling reply during the wait is
 * proof the tab is servicing the socket, so "backgrounded or frozen" is a
 * false diagnosis (the reporter's concurrent graph reads completed).
 */
function replyTimeoutSuffix(ctx: SendCtx): string {
  if (ctx.siblingReply) {
    return (
      ` — the tab is not frozen: it answered "${ctx.siblingReply}" while this command was still waiting. ` +
      `Retry "${ctx.command.cmd}" on its own; concurrent graph reads on the same tab can leave this command unanswered`
    );
  }
  return ` — the ComfyUI tab may be backgrounded or frozen${mutatedButUnacked(ctx)}`;
}

function noReplyTimeoutMessage(tabId: string, ctx: SendCtx): string {
  return `Panel tab ${tabId} did not reply to "${ctx.command.cmd}" within ${ctx.timeoutMs} ms${replyTimeoutSuffix(ctx)}`;
}

/** Graph commands share one frontend handler/main thread per tab. Concurrent
 *  frames can leave graph_get_errors unanswered (#2069). */
function usesGraphCommandLane(cmd: string): boolean {
  return cmd.startsWith("graph_");
}

/**
 * Whether the per-tab graph lane must wait for this command's ACK before
 * dispatching the next graph frame.
 *
 * Reads still wait (#2069): concurrent graph frames share the panel's main
 * thread and /object_info coalescer, and graph_get_errors is the one that
 * then misses its reply. Targeted mutations apply on the canvas immediately
 * and only then await schema work; holding the lane until that ACK is what
 * stranded concurrent panel_set_widget (#2559) — the frontend applied every
 * write, then waited for a sibling mutation the lane would not dispatch, so
 * none of the MCP promises settled.
 */
function graphLaneWaitsForReply(cmd: string): boolean {
  return GRAPH_CMD_EFFECT[cmd] !== "targeted";
}

/** True when a panel reply body is a graph_set_widget success (`set: {…}`). */
function isSetWidgetReplyResult(result: unknown): boolean {
  return (
    !!result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    Object.prototype.hasOwnProperty.call(result, "set")
  );
}

/**
 * A mutation the panel acknowledged AFTER its reply timeout (#694, #1175).
 *
 * `result` is the panel's own reply body, present only when it was retained (see
 * MAX_LATE_MUTATION_RESULT_CHARS). ABSENT IS NOT EMPTY: a consumer that needs the
 * body must branch on the property existing, never read `undefined` as "the panel
 * replied with nothing".
 */
export type LateMutation = {
  ok: true;
  cmd: string;
  tabId: string;
  lateByMs: number;
  result?: unknown;
};

/**
 * A mutation that was written to the panel and has not yet been acknowledged
 * (#2527). Keyed by the dispatched rid so a late frontend reply, a graph read,
 * or a retry_of can reconcile the exact delivered command instead of racing a
 * stale snapshot.
 */
export type DeliveredMutationReceipt = {
  rid: string;
  cmd: string;
  tabId: string;
  ts: number;
  frame: Record<string, unknown>;
  status: "in_flight" | "timed_out";
};

/** Peek of a delivered mutation, including one that already settled late. */
export type PeekedDeliveredMutation = {
  rid: string;
  cmd: string;
  tabId: string;
  frame: Record<string, unknown>;
  status: "in_flight" | "timed_out" | "settled";
};

/** A prompt id captured by the Panel after the graph_run reply window (#1728). */
export type LateRunReceipt = {
  runRid: string;
  tabId: string;
  promptIds: string[];
  completionKeys: Array<{ promptId: string; completionKey: string }>;
  lateByMs: number;
};

export type LateRunReceiptHandoff = (receipt: LateRunReceipt) => void;

/**
 * Size ceiling on a RETAINED reply payload (#1175).
 *
 * #694 kept only the FACT of a late completion, which is all its consumer (the
 * retry-token notice) needs. panel_run needs the reply itself: the run's prompt
 * ids live in it, and without them a recovered run cannot be ticketed for its
 * completion. So the body is kept too — but the late-mutation map is bounded by
 * COUNT, not by bytes, and a mutation reply is small only by convention. Over the
 * ceiling the ENTRY IS STILL RETAINED and only the body is dropped, so the
 * retry-token notice is never lost to a large payload; that caller falls back to
 * the recovery they already had. 32 KiB of JSON is far above any panel mutation
 * reply this repo measures and bounds the map's bodies at 8 MiB worst case.
 */
export const MAX_LATE_MUTATION_RESULT_CHARS = 32 * 1024;

/**
 * The retainable form of a late reply's body: `{ result }` when it is worth
 * keeping, `{}` when it is not (#1175).
 *
 * Returns a SPREADABLE object rather than a value so "no body retained" and "the
 * panel's body was literally undefined" stay distinguishable at the property
 * level — the distinction panel_run branches on before deciding it can rebuild a
 * run from this entry.
 *
 * Declines on two grounds, both measured rather than assumed:
 *  - NOT SERIALISABLE. A body with a cycle (or a throwing toJSON) cannot reach a
 *    ToolResult anyway, and must never take the retention path down with it: the
 *    FACT of the completion is the more valuable half and is retained regardless.
 *  - OVER THE CEILING. Bounded by the same JSON the caller would have received,
 *    so the check measures the thing being stored.
 */
function retainableLateResult(result: unknown): { result?: unknown } {
  if (result === undefined) return {};
  try {
    const json = JSON.stringify(result);
    if (typeof json !== "string") return {};
    if (json.length > MAX_LATE_MUTATION_RESULT_CHARS) return {};
    return { result };
  } catch {
    return {};
  }
}

/** Clone the dispatched command minus rid so a later retry can replay it. */
function cloneDeliveredMutationFrame(frame: Record<string, unknown>): Record<string, unknown> {
  let cloned: Record<string, unknown>;
  try {
    const json = JSON.stringify(frame);
    cloned = typeof json === "string" ? (JSON.parse(json) as Record<string, unknown>) : { ...frame };
  } catch {
    cloned = { ...frame };
  }
  delete cloned.rid;
  return cloned;
}

/** Tag an error as a reply-timeout and return it (for throw/reject). */
/**
 * Key for a pending "is this tab gone?" clock (#486).
 *
 * (tab id, INCARNATION) — a `wf:` route recurs (#1285: it is
 * `wf:<tabRouteId>:<path>`, not a hash), so it names a workflow,
 * not a browser tab. The incarnation is the panel's sessionStorage-backed
 * `tab_session_id`: unique per browser tab and stable across a reload, which is
 * exactly the distinction the clock has to draw. JSON-encoded so neither part
 * can be forged into the other by a separator.
 */
export function tabIncarnationSlot(tabId: string, incarnation: string | undefined): string {
  return JSON.stringify([tabId, incarnation ?? null]);
}

export function markReplyTimeout<E extends Error>(err: E): E {
  Object.defineProperty(err, REPLY_TIMEOUT, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return err;
}

/** True when `err` carries the typed reply-timeout marker set by the bridge. */
export function isReplyTimeoutTagged(err: unknown): boolean {
  if (err == null || (typeof err !== "object" && typeof err !== "function")) return false;
  return (err as Record<symbol, unknown>)[REPLY_TIMEOUT] === true;
}

/**
 * panel#1524 — a POST-write mid-command disconnect: the request was written to a
 * socket that then died before a reply. Distinct from a reply-timeout (the tab
 * stayed connected and simply never answered) and from a pre-write send failure
 * (`dispatched:false`). Callers that wait for a late mutation receipt — panel_run
 * reconciling a `graph_run` that already queued — key on THIS marker rather than
 * parsing "OUTCOME UNKNOWN" out of the message, for the same reason reply-timeout
 * has a typed mark: an acked panel error can quote that sentence verbatim.
 */
const MID_COMMAND_DISCONNECT = Symbol.for("comfyui-mcp.bridge.mid-command-disconnect");

/** Tag an error as a mid-command disconnect and return it (for throw/reject). */
export function markMidCommandDisconnect<E extends Error>(err: E): E {
  Object.defineProperty(err, MID_COMMAND_DISCONNECT, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return err;
}

/** True when `err` carries the typed mid-command-disconnect marker. */
export function isMidCommandDisconnectTagged(err: unknown): boolean {
  if (err == null || (typeof err !== "object" && typeof err !== "function")) return false;
  return (err as Record<symbol, unknown>)[MID_COMMAND_DISCONNECT] === true;
}

/**
 * Frame `type`s that are safe to MIRROR to a tab's viewers — genuine shared-session
 * activity a remote-control phone should see. This is an ALLOWLIST (default-deny):
 * a `cid`-based denylist leaked cid-less correlated replies (pair_url, secret_saved,
 * OAuth acks, and history replies to a no-cid request). Anything not listed here —
 * acks, model/backend config, pairing/secret frames, correlated replies — stays with
 * the primary and the ONE socket that asked. New frame types are non-mirroring until
 * explicitly added, so a future secret-bearing frame can't leak by default.
 */
const MIRROR_SAFE_FRAME_TYPES: ReadonlySet<string> = new Set([
  "say",
  "stream",
  "thinking",
  "echo",
  "turn",
  "turn_anchor",
  "session",
  "agent_status",
  "action",
  "download_progress",
]);

/** #884 — whether a frame type reaches mirror VIEWERS through the mirror
 *  fan-out above. The orchestrator's conversation fanout excludes an attached
 *  viewer's own tab for exactly these types (it already gets them via its
 *  driven tab — direct delivery would double every frame on the phone), while
 *  non-mirrored frames (e.g. seen-acks for a message the phone itself sent)
 *  are still delivered directly (codex round 3, P2). */
export function isMirrorSafeFrameType(frameType: string): boolean {
  return MIRROR_SAFE_FRAME_TYPES.has(frameType);
}

export class UiBridge {
  /** Max EADDRINUSE retries before degrading to "panel unavailable". */
  private static readonly MAX_BIND_ATTEMPTS = 5;
  /** Backoff base; delays are 200, 400, 800, 1600, 3200ms (~6.2s total). */
  private static readonly BIND_RETRY_BASE_MS = 200;
  /** WebSocket keepalive: ping every 25s so a proxied connection (the cloudflared
   *  tunnel behind a secure wss:// bridge) is never idle long enough for Cloudflare
   *  to reap it (~100s idle timeout) during a long, quiet agent turn. Harmless on
   *  loopback. */
  private static readonly HEARTBEAT_MS = 25_000;
  /** Terminate a socket only after this many consecutive missed pongs (~50s of
   *  silence) — lenient enough that a briefly-backgrounded/throttled tab isn't
   *  falsely dropped, strict enough to reap a silently-dead tunnel connection. */
  private static readonly MAX_MISSED_PONGS = 2;

  private wss: WebSocketServer | null = null;
  /** Extra always-token-gated listeners — the on-demand phone-pairing bind (LAN
   *  and/or a loopback port a cloudflared tunnel fronts). Their connections route
   *  through the same tab/rid logic as the primary bridge; the primary loopback
   *  listener stays token-less so the local browser panel is unaffected. */
  private readonly extraServers: WebSocketServer[] = [];
  private conns = new Map<string, Conn>(); // tabId -> connection (canvas-owning primary)
  /**
   * EVERY accepted socket, from the moment it is accepted — including the ones
   * still ANONYMOUS because no `hello` has named a tab id yet.
   *
   * `conns` is keyed by tab id, so it cannot see an anonymous socket at all.
   * `stop()` used to close only `conns` and then await `wss.close()`, which waits
   * for every open socket: one anonymous connection (a browser that opened the
   * WebSocket and never sent hello, or was mid-handshake at shutdown) would hang
   * teardown forever. Tracking from accept is what makes stop() actually able to
   * close what it is about to wait on.
   */
  private sockets = new Set<BridgeSocket>();
  /** Incremented for every accepted panel hello; never reused during this bridge lifetime. */
  private nextHelloGeneration = 0;
  /** Mobile "mirror" viewers subscribed to a tab's live output (remote control):
   *  push()-path frames for a tabId fan out to these IN ADDITION to the primary,
   *  so a phone sees the desktop tab's agent activity/renders. They NEVER receive
   *  canvas send()-commands (owner-only) and their own correlated replies are
   *  socket-scoped. Keyed by the mirrored (primary) tabId. Empty in the normal
   *  case → zero effect on existing panel behavior. */
  private subscribers = new Map<string, Set<BridgeSocket>>();
  /** A mirroring viewer's socket → the desktop tab it drives. While attached, the
   *  viewer's INBOUND events (user_message, interrupt, new_session, …) are routed
   *  to THIS tab's shared session instead of the viewer's own — that's what makes
   *  it remote control rather than a passive view. Cleared on detach/disconnect. */
  private mirrorViewers = new Map<BridgeSocket, string>();
  /** #570 — injected by the orchestrator: the trusted per-instance workflow uuid this
   *  tabId currently maps to (from tabStableIdentity). Used to STAMP each dispatched
   *  command so the panel can refuse to execute it against a workflow it has since switched
   *  to (the generation-bound-command leak: the server can't retract a frame already
   *  delivered to the browser, but the browser can decline to APPLY a stale one). */
  private resolveTabWorkflowUuid: ((tabId: string) => string | undefined) | null = null;
  /** #2314 — latest structured current-view witness per routing tab. Cleared on
   * hello/rebind boundaries; populated only from successful panel replies. */
  private readonly promotedScopes = new Map<string, TabPromotedScopeRead>();
  /** #1656 — orchestrator-injected: is this tab's CURRENT stamp one that was CARRIED
   *  from a tab id the same socket retired (carryWorkflowCommandStamp), rather than one
   *  the tab itself has proven under this id?
   *
   *  The stamp map answers "what uuid is on this tab" but not "who said so", and the two
   *  are different facts. On a same-socket re-hello that mints a new tab id — a workflow
   *  switch, or the tmp: -> wf: transition of a save/rename — the retiring id's uuid is
   *  copied onto the new id and overwritten only if THAT hello resolved an identity. When
   *  it did not, the value sitting on the new tab id was advertised by a tab that no longer
   *  exists, about a canvas that is no longer mounted. The dispatch-time agreement gate
   *  below must not read it as this tab's advertisement. Absent predicate = the mechanism
   *  is not wired (tests/embedders): treated as PROVEN, which is exactly the pre-#1656
   *  behaviour. */
  private isCarriedTabStamp: ((tabId: string) => boolean) | null = null;
  /** #1656 — orchestrator-injected: see {@link corroborateTabStamp}. */
  private corroborateTabStampFn: ((tabId: string, workflowUuid: string) => boolean) | null = null;
  /** #884 P0 — orchestrator-injected: the tab a conversation's IN-FLIGHT turn is
   *  PINNED to (string), `null` when the turn's origin is ambiguous (refuse), or
   *  undefined when no turn is in flight (fall back to active-tab resolution).
   *  See resolveTarget's scope branch. */
  private scopeTargetResolver: ((scopeId: string) => string | null | undefined) | null = null;
  /** #884 — orchestrator-injected EXPLICIT recovery: re-pin a conversation's
   *  in-flight turn onto the tab that is active now (the documented
   *  panel_set_workflow_target({mode:"current"}) consent). Returns the tab it
   *  repinned to, or undefined when nothing is resolvable. */
  private scopeRepinHandler:
    | ((
        scopeId: string,
        preferredWorkflowPath?: string,
        request?: ScopeRepinRequest,
      ) => ScopeRepinOutcome)
    | null = null;
  /**
   * panel#1292 — an in-flight `mode:"current"` bind that is recovering a null
   * turn pin. Same-batch siblings (`panel_graph_outline`, `panel_set_todo`)
   * start while the pin is still ambiguous; `send()` waits here instead of
   * minting the #884 refusal the bind is about to clear. Ref-counted so two
   * overlapping binds on one scope do not drop the wait early.
   */
  private scopeRecovery = new Map<
    string,
    { count: number; done: Promise<void>; finish: () => void }
  >();
  /**
   * panel#1557 — deferred mode:"current" consent, keyed by scope address.
   * Lives here rather than on the tool ctx so an HTTP MCP session drop cannot
   * drop it while the dead turn pin is still on the tracker.
   */
  private pendingScopeRecoveryConsent = new Set<string>();
  /** #884 — orchestrator-injected: normalize a hello's raw `backend` value the
   *  same way the orchestrator does (unknown/absent → the default backend), so
   *  the backend-qualified scope-buffer replay matches the conversation the
   *  tab actually JOINS. Without it, a hello omitting `backend` never drained
   *  the default conversation's mailbox (confirming-gate 2, P1). */
  private helloBackendNormalizer: ((raw: unknown) => string) | null = null;
  /**
   * #716 — an explicit workflow navigation can establish a newer command-stamp
   * identity before the panel's next hello.  The orchestrator owns the value and
   * validates it against the server-observed origin; the bridge merely gives a
   * successful tab-bound command a narrow way to ask for that refresh.
   */
  private refreshTabWorkflowUuid:
    | ((tabId: string, workflowUuid: string) => FenceAdoptOutcome)
    | null = null;
  /** Per-tab reason for the most recent REFUSED fence adoption (#1077). Cleared
   *  on the next successful adoption, so it never outlives the state it explains. */
  private readonly fenceRefusals = new Map<string, string>();
  /** #570 P0a — records the mirror subscribers/viewers a same-socket re-hello OPTIMISTICALLY
   *  moved from the retiring id to the new id, keyed by the RETIRING (from) id. The move
   *  happens BEFORE the orchestrator can classify the switch as proven/unproven; if it turns
   *  out UNPROVEN, revokeTabMigration(fromId) uses this to DETACH exactly those moved viewers
   *  (reverting their input to their own session) and pull them back out of the destination's
   *  subscriber set — so a phone mirroring workflow A never silently follows into B. Only the
   *  MOVED sockets are undone, so B's OWN pre-existing viewers are untouched. */
  private migratedMirror = new Map<
    string,
    {
      to: string;
      viewers: Set<BridgeSocket>;
      subs: Set<BridgeSocket>;
      /** The `lastActiveSeq` value this migration's last-active carry produced, or
       *  null when nothing was carried. The undo compares it so a FRESH selection
       *  made after the carry (a user_message from the destination) is never
       *  reverted — value equality alone cannot tell the two apart (#568). */
      lastActiveSeq: number | null;
    }
  >();
  /** Injected by the orchestrator: does this tabId have a live agent session?
   *  (SessionStore/PanelAgentManager live there.) Flags desktopTabs() for the
   *  mobile mirror picker's green "session attached" dot. */
  private hasSessionPredicate: ((tabId: string) => boolean) | null = null;
  /**
   * Tab-id migrations (oldTabId → newTabId). When a panel socket re-hellos under
   * a NEW tab id (e.g. after a panel update that changed the id scheme from
   * random UUID to deterministic tmp:/wf: prefixed ids), the old id is mapped to
   * the new one so agent sessions that were bound to the old id can still resolve
   * their target via resolveTarget — the session self-heals instead of throwing
   * "no connected tab with id …" on every panel_* call.
   */
  private tabMigrations = new Map<string, { to: string; sock: BridgeSocket }>();
  /** Per-tab "mailbox" of undeliverable render deliveries (show_media), buffered
   *  while a client is OFFLINE and flushed on reconnect — so a finished render is
   *  never lost when the mobile app is backgrounded/killed mid-render. Keyed by a
   *  STABLE tab id (the phone persists one) OR a scope address (no tab was
   *  routable). In-memory: survives disconnect ⇄ reconnect within an orchestrator
   *  run, not a full orchestrator restart. Bounded per tab + TTL'd.
   *
   *  #2013 — `expectHeadless` is the kind of client the entry was produced for
   *  (`true` phone/remote, `false` canvas, omitted when unknown). A scope-keyed
   *  box used to flush to the first hello, which is how "could not route" became
   *  "queued for whoever connects next". The flush now declines a mismatched
   *  recipient and keeps the box for a matching reconnect. */
  private readonly mailbox = new Map<
    string,
    Array<{ cmd: BridgeCommand; ts: number; expectHeadless?: boolean }>
  >();
  private static readonly MAILBOX_MAX = 30;
  private static readonly MAILBOX_TTL_MS = 24 * 60 * 60 * 1000;
  /** Tab ids whose most recent connected socket was headless. Retained across a
   *  disconnect for mailbox/media routing, but cleared if a fresh desktop socket
   *  later reuses the id (see isCurrentHeadless). */
  private readonly headlessSeen = new Set<string>();
  private seenTabs = new Set<string>(); // tabIds ever announced — dedup connect logs across reconnect churn
  /** True once a CANVAS-OWNING (non-headless) tab has helloed — i.e. a real ComfyUI
   *  browser tab with the comfyui-mcp-panel pack was open this session. Distinct from
   *  `seenTabs`, which also counts headless mobile/remote pseudo-panels: those prove
   *  neither that the desktop pack is installed nor that a browser tab exists to
   *  refresh, so they must NOT drive the "refresh the ComfyUI browser tab" guidance
   *  (#436.4). Never cleared — a faithful "a real panel tab connected once" mark. */
  private everConnectedDesktopTab = false;
  /** Frames pushed at a tab with NO live connection, buffered for replay when that
   *  tab re-hellos. Per-workflow sessions re-target ONE socket between workflow tab
   *  ids, so a backgrounded workflow's agent output would otherwise be dropped on
   *  the floor and its finished turn lost to the user. Complements the send()-path
   *  `mailbox` (which buffers show_media command deliveries): this one buffers
   *  push()-path frames (agent turn output). Bounded per tab. */
  private missedFrames = new Map<string, Record<string, unknown>[]>();
  private static readonly MAX_MISSED_FRAMES = 100;
  private pending = new Map<string, Pending>();
  /**
   * #2069 / #2559 — per-tab chain of `graph_*` dispatches. The panel's WS
   * listener is async-per-message, so concurrent READ frames share the main
   * thread and the /object_info coalescer; graph_get_errors is the one that
   * then misses its reply window. Targeted mutations release the lane once
   * the frame is on the wire: they apply immediately, and waiting for their
   * ACK before the next dispatch deadlocks when the frontend coalesces
   * several widget writes (#2559). Timeout clocks start at dispatch, not at
   * enqueue.
   */
  private graphLane = new Map<string, Promise<unknown>>();
  /** ask_user card sends (rid → {ask_id, ts}): lets a reply that validates AFTER
   *  the reply timer fired (dropped from `pending`) still be buffered for the
   *  caller, instead of being discarded as a "late reply for a timed-out command"
   *  (#486). Timestamped so an abandoned mapping (timeout/disconnect/send-failure
   *  whose late reply never arrives) is TTL-pruned rather than kept forever. */
  private askRidToId = new Map<
    string,
    {
      askId: string;
      ts: number;
      tabId: string;
      /**
       * This card's answer is a CREDENTIAL (#1352). It may be buffered in memory so a
       * late-arriving value can still be applied, but it must never reach the durable
       * late-answer journal: `panel_request_secret` exists precisely so the value lands
       * nowhere it can be read back, and a journal is exactly such a place.
       */
      sensitive?: boolean;
    }
  >();
  /**
   * Notified the instant a LATE (post-reply-timeout) ask answer validates (#486).
   *
   * The buffer below only helps a caller that is still alive to poll it. The
   * whole of #486 is the case where nobody is: the `tools/call` that asked has
   * been abandoned, so the answer would sit here unread until the TTL pruned it.
   * This hands it to the orchestrator's ask journal at ARRIVAL, with no live
   * caller required — after which it is durable and can be replayed or pushed.
   */
  private lateAskSink: ((askId: string, result: unknown, tabId: string) => void) | null = null;
  /**
   * In-flight confirm/ask waiters keyed by `ask_id` (#2440). A card approval that
   * lands without the original command rid used to be cached only for a later
   * takeLateAskReply(); if a restart was still waiting, that waiter timed out and
   * the next call consumed the click. These fire first, before the late buffer.
   */
  private lateAskWaiters = new Map<string, Set<(result: unknown) => void>>();
  /** See setTabGoneListener. */
  private onTabGone: ((tabId: string, incarnation: string) => void) | null = null;
  /** See setTabTakenOverListener. */
  private onTabTakenOver: ((tabId: string, departed: string) => void) | null = null;
  /**
   * How long a tab must stay away before it counts as GONE rather than
   * reconnecting.
   *
   * A reload closes the socket and re-hellos moments later, so firing on the
   * close itself would retire live per-tab state during an ordinary F5. Sized
   * far above any reload (and above RECONNECT_GRACE_MS, which bounds a much more
   * urgent decision): waiting costs nothing but a little bookkeeping held
   * slightly longer, while firing early destroys it.
   */
  private tabGoneGraceMs = 60_000;
  /** Armed tab-gone clocks, keyed by (tab id, incarnation) — see armTabGone. */
  private tabGoneTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; tabId: string; incarnation: string }
  >();
  /** Counter behind the synthetic `anon:<n>` incarnations. */
  private nextAnonIncarnation = 0;
  /**
   * Which (tab, incarnation) each live socket registered as.
   *
   * The close handler needs this because "was I the primary connection?" is the
   * WRONG question: when a second tab takes over a recurring `wf:` route key the
   * bridge closes the first socket, and by the time that close fires the map
   * already points at the newcomer — so the departing tab was never armed at all
   * and could never be declared gone. The socket knows who it was; ask it.
   */
  private sockIncarnation = new Map<BridgeSocket, { tabId: string; incarnation: string }>();
  /** Buffered late-but-valid ask_user answers (ask_id → result), drained by the
   *  caller via takeLateAskReply(). Bounded by a short TTL — a stale unclaimed
   *  answer is pruned rather than kept forever. */
  private lateAskReplies = new Map<string, { result: unknown; ts: number }>();
  /** TTL for a BUFFERED late ask answer — see the exported LATE_ASK_TTL_MS. */
  private static readonly LATE_ASK_TTL_MS = LATE_ASK_TTL_MS;
  /**
   * Mutations written to the panel and not yet acknowledged (#2527 / #694).
   *
   * Populated at dispatch (not only at timeout) so a graph read or retry_of can
   * still name the exact delivered command while the frontend is settling.
   * Status becomes `timed_out` when we STOP WAITING — the reply timer firing
   * (#694) or a mid-command disconnect of a filtered mutation (panel#1524).
   * A mutation that replies in time is forgotten: the caller already has the
   * outcome. Without the disconnect arm, the panel's lost-reply replay of a
   * `graph_run` that already queued is an unknown rid and is dropped.
   *
   * Deliberately mutations only. A read that is abandoned costs a retry
   * (#1154's asymmetry); retaining reads would make this unbounded noise.
   */
  private deliveredMutations = new Map<
    string,
    { cmd: string; tabId: string; ts: number; frame: Record<string, unknown>; status: "in_flight" | "timed_out" }
  >();
  /** Installed by the retry-token layer; see setLateMutationFilter. Null means
   *  retain nothing. */
  private lateMutationFilter: ((cmdName: string) => boolean) | null = null;
  /** Late completions of timed-out mutations (rid -> outcome), drained once via
   *  takeLateMutation(). Success only: see the recordLateMutation comment. */
  private lateMutations = new Map<
    string,
    {
      ok: true;
      cmd: string;
      tabId: string;
      ts: number;
      lateByMs: number;
      result?: unknown;
      frame: Record<string, unknown>;
    }
  >();
  /** Waiters blocked on a tab's outcome-unknown mutations settling (#2527). */
  private mutationSettleWaiters: Array<{ tabId: string; finish: () => void }> = [];
  /** Exact prompt receipts sent by the Panel after its graph_run command returned. */
  private lateRunReceipts = new Map<
    string,
    { tabId: string; promptIds: string[]; completionKeys: Map<string, string>; ts: number }
  >();
  /** Bounded post-reconcile owners for exact receipts that arrive after panel_run returned. */
  private lateRunReceiptHandoffs = new Map<
    string,
    {
      tabId: string;
      expiresAt: number;
      onReceipt: LateRunReceiptHandoff;
      // Panel receipts are at-least-once across reconnect/retry. Keep the
      // prompt identities already handed to the owner so a duplicate cannot
      // reopen an existing RunCompletions ticket.
      deliveredPromptIds: Set<string>;
    }
  >();
  /**
   * TTL for both maps above.
   *
   * Unlike the ask mapping below this one CAN have a clock, because the thing it
   * enables is bounded: telling a caller "your earlier write did land" is only
   * useful while that caller is still working on the same thing. Ten minutes
   * comfortably covers an agent turn. Past it the honest state is the one the
   * caller already has -- outcome unknown, verify by observation -- which is
   * what the timeout disclosure told them to do in the first place.
   */
  private static readonly LATE_MUTATION_TTL_MS = 10 * 60 * 1000;
  /** A ticket handoff outlives the normal reconcile grace, but never indefinitely. */
  private static readonly LATE_RUN_RECEIPT_HANDOFF_TTL_MS = 60 * 1000;
  /** Hard cardinality bound, so a pathological tab timing out in a loop cannot
   *  grow either map without limit even inside the TTL. */
  private static readonly MAX_LATE_MUTATIONS = 256;
  /**
   * Ask cards whose rid→ask_id mapping is retained.
   *
   * This mapping is a different thing from the buffer above, with a different
   * job: it is what lets a late reply be RECOGNISED as a card answer at all, and
   * therefore what gates the durable ask journal (#486). It deliberately has NO
   * TTL. A question card sits on screen until the user deals with it, which can
   * be arbitrarily longer than any tool call, so any clock here would be a
   * stopwatch quietly deciding that a validated answer no longer counts — and
   * the answer would be dropped with no record at all. Three small fields per
   * card, so a whole session's worth costs nothing; overflowing THIS is the only
   * way a mapping is ever forgotten, and it is logged at ERROR.
   */
  private static readonly MAX_ASK_RID_MAPPINGS = 1024;
  /** In-flight IDEMPOTENT reads whose socket dropped mid-command, parked per tabId
   *  waiting a bounded grace for that tab to reconnect so we can re-dispatch them
   *  (resume) instead of hard-failing. Never holds mutating commands. */
  private awaitingReconnect = new Map<string, AwaitingReconnectEntry[]>();
  /** How long a dropped idempotent read waits for its tab to re-hello before we
   *  declare the panel genuinely gone. Bounded so a caller never hangs. */
  private static readonly RECONNECT_GRACE_MS = 4000;
  /** No single bridge send may be re-dispatched more than once by reconnect
   *  handling. Callers can lower this to zero for identity-sensitive probes. */
  private static readonly MAX_RECONNECT_RETRIES = 1;
  /** Bridge commands with no side effect — safe to re-dispatch after a reconnect.
   *  Everything else is treated as mutating (no auto-retry) so a render/edit is
   *  never silently double-applied. Single source of truth at module scope
   *  (BRIDGE_READONLY_CMDS) so the mutating flag and the default-timeout policy
   *  can never drift apart. */
  private static readonly READONLY_CMDS = BRIDGE_READONLY_CMDS;
  private portInUse = false;
  private bindRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive missed pongs per socket — reset to 0 on each pong. */
  private missedPongs = new WeakMap<WebSocket, number>();
  private port: number;
  /** When set, connections MUST present `?token=<token>` on the WS upgrade
   *  (constant-time compared). Used for the secure `wss://` bridge exposed over a
   *  cloudflared tunnel, where the endpoint is publicly reachable. null in the
   *  default loopback-only mode (no auth needed — not reachable off-box). */
  private token: string | null;
  /** Bind host. Default loopback; a LAN/all-interfaces bind (0.0.0.0, a LAN IP)
   *  is allowed ONLY together with a token — panel #54: browsers on OTHER
   *  machines reaching a 24/7 server-side orchestrator. */
  private host: string;
  /** Tab the user most recently typed in — the default command target. Always
   *  written through {@link setLastActiveTab} so {@link lastActiveSeq} stays in step. */
  private lastActiveTabId: string | null = null;
  /** Monotonic counter bumped on every last-active write. Lets the tab-id-migration
   *  undo tell "the value I carried is still the current selection" from "the same
   *  value was re-selected since" — the two are indistinguishable by value (#568). */
  private lastActiveSeq = 0;
  /** Resolves true once the port is bound, false if binding ultimately fails. */
  private readyPromise: Promise<boolean> | null = null;
  private readyResolve: ((ok: boolean) => void) | null = null;

  /**
   * Called for panel-initiated frames (no rid): user messages, hellos.
   *
   * #1411 — ASSIGNING THIS DRAINS WHATEVER ARRIVED BEFORE IT.
   *
   * The bridge binds its port and starts accepting frames several seconds before
   * the orchestrator installs this handler (measured on the reporting machine:
   * listening at T+0.0s, orchestrator ready at T+3.7s). Every frame in that window
   * used to hit `this.onPanelMessage?.(…)` and vanish — accepted, stamped, echoed
   * into the panel transcript, then dropped with no queue, no ack and no error. The
   * user watches their own message appear and nothing happen, which reads as the
   * agent ignoring them rather than as a fault.
   *
   * A panel reaches this window whenever the orchestrator restarts under an open
   * sidebar: a self-restart on rebuild, a crash restart, a machine waking up.
   */
  private panelMessageHandler: ((event: PanelEvent) => void) | null = null;

  get onPanelMessage(): ((event: PanelEvent) => void) | null {
    return this.panelMessageHandler;
  }

  set onPanelMessage(fn: ((event: PanelEvent) => void) | null) {
    this.panelMessageHandler = fn;
    if (fn) this.drainPreHandlerFrames();
  }

  /** Frames that arrived before the handler existed, in ARRIVAL ORDER — so the
   *  handler sees the sequence the panel actually sent (its `hello` before its
   *  first message), not a reordering invented by the queue. */
  private preHandlerFrames: PanelEvent[] = [];
  /** How many were refused once the cap was hit. Reported, never silent. */
  private preHandlerDropped = 0;
  private draining = false;
  private drainScheduled = false;
  private pendingDrain: ReturnType<typeof setImmediate> | null = null;
  /** Set by stop(): no further continuation may be scheduled after teardown. */
  private drainStopped = false;

  /**
   * Bounds on the pre-handler queue — COUNT and BYTES (codex review, P1).
   *
   * The window is bounded by boot, so these are generous for the case they exist
   * for. They are bounds rather than an unbounded buffer because nothing
   * guarantees a handler is EVER installed, and because this is an INGRESS path
   * that previously discarded: retaining 200 arbitrarily large frames would be new
   * memory exposure, quieter than the bug being fixed. A frame count alone is not
   * a resource bound.
   *
   * On overflow the EARLIEST frames are kept: the first of them is the `hello` that
   * identifies the tab, and a message replayed without it is worth less than the
   * message that was refused.
   */
  private static readonly MAX_PRE_HANDLER_FRAMES = 200;
  private static readonly MAX_PRE_HANDLER_BYTES = 1_000_000;
  private preHandlerBytes = 0;

  /** Rough wire size of a held frame. Only ever computed inside the pre-handler
   *  window, which both bounds cap, so this cannot become a hot-path cost. */
  private static frameBytes(event: PanelEvent): number {
    try {
      return JSON.stringify(event)?.length ?? 0;
    } catch {
      return 0; // unserialisable: counted as free rather than refused
    }
  }

  /** Deliver a panel-initiated frame, or hold it until there is somewhere to
   *  deliver it (#1411). Never drops silently. */
  private deliverPanelEvent(event: PanelEvent): void {
    // A stopped bridge dispatches NOTHING. Past teardown there is nowhere for a
    // frame to go: delivering it pretends a dead bridge is live, and holding it is
    // a leak nothing will ever drain. This has to precede the live-delivery path —
    // sitting after it, a frame arriving post-stop was handed straight to a handler
    // that was still installed.
    if (this.drainStopped) return;
    const fn = this.panelMessageHandler;
    // The queue is the ordering authority whenever ANYTHING is still waiting on it
    // (codex rounds 1 and 3, both P1). Three conditions, one rule — deliver
    // directly only when there is nothing ahead of this frame:
    //   * a drain in flight: a frame produced BY a handler must land behind what is
    //     still held, or A,B,C arrives as A,C,B;
    //   * a scheduled continuation: a socket frame D arriving between the pass and
    //     its setImmediate would otherwise overtake the C that is already queued;
    //   * a non-empty queue at all: nothing may be delivered around held frames.
    if (fn && !this.draining && !this.drainScheduled && this.preHandlerFrames.length === 0) {
      fn(event);
      return;
    }
    const bytes = UiBridge.frameBytes(event);
    if (
      this.preHandlerFrames.length >= UiBridge.MAX_PRE_HANDLER_FRAMES ||
      this.preHandlerBytes + bytes > UiBridge.MAX_PRE_HANDLER_BYTES
    ) {
      this.preHandlerDropped += 1;
      if (this.preHandlerDropped === 1) {
        logger.warn(
          `[ui-bridge] the panel-message handler is still not installed and the held-frame ` +
            `budget is full (${this.preHandlerFrames.length} frames, ${this.preHandlerBytes} B) ` +
            `— further frames are being REFUSED, not queued (#1411). Anything sent from here ` +
            `until the orchestrator finishes starting is lost.`,
        );
      }
      return;
    }
    this.preHandlerBytes += bytes;
    this.preHandlerFrames.push(event);
  }

  /**
   * Hand over everything held, in order, then report anything that was refused.
   *
   * A WORK LOOP, not a snapshot of the queue (codex review, P1). Two things can
   * happen while a frame is being handled, and both are handled by re-reading the
   * queue and the handler on every iteration rather than by capturing them once:
   * a handler can cause another frame to arrive (it must go to the BACK), and a
   * handler can swap itself out and back (its own drain is suppressed by
   * `draining`, so this loop has to be the thing that finishes the job).
   */
  private drainPreHandlerFrames(): void {
    if (this.draining) return; // a handler assigned FROM a handler must not re-enter
    if (this.preHandlerFrames.length === 0 && this.preHandlerDropped === 0) return;
    const held = this.preHandlerFrames.length;
    this.draining = true;
    let delivered = 0;
    // A BUDGET, because the loop body can extend the queue it is draining (codex
    // round 2, P1): a handler that feeds one frame back per frame it handles would
    // otherwise keep this synchronous loop non-empty forever and wedge the event
    // loop — worse than the bug being fixed. The budget is the number of frames
    // held when the drain STARTED, which is exactly the pre-handler backlog this
    // exists to deliver; anything produced while draining is new work and is
    // rescheduled below rather than dropped.
    let budget = held;
    try {
      for (;;) {
        const handler = this.panelMessageHandler;
        // Cleared mid-drain: keep the rest HELD rather than dropping them — there
        // is nowhere to deliver them, which is the situation this queue exists for.
        if (!handler || this.preHandlerFrames.length === 0) break;
        if (budget <= 0) break; // yield the rest to the next tick
        budget -= 1;
        const event = this.preHandlerFrames.shift() as PanelEvent;
        this.preHandlerBytes = Math.max(0, this.preHandlerBytes - UiBridge.frameBytes(event));
        delivered += 1;
        try {
          handler(event);
        } catch (err) {
          // One bad frame must not strand the rest — including the user's message.
          logger.warn(
            `[ui-bridge] a held frame threw while being delivered: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      this.draining = false;
    }
    // Anything still held — produced during this pass, or queued by a handler that
    // swapped itself out and back — is delivered on a later tick. Never dropped,
    // and never spun on: each pass does a bounded amount of synchronous work.
    // The teardown race codex round 4 raised — a handler calling stop() mid-drain,
    // leaving pendingDrain null at the moment stop() looks for it — is closed
    // upstream of here rather than by a fourth condition on this line: stop() drops
    // whatever is held, and deliverPanelEvent refuses anything after it, so by this
    // point a stopped bridge has nothing left to schedule. A `!drainStopped` clause
    // was tried and removed: mutation testing showed it could never change the
    // outcome, and a guard that cannot fail reads as protection while providing
    // none.
    if (this.preHandlerFrames.length > 0 && this.panelMessageHandler && !this.drainScheduled) {
      this.drainScheduled = true;
      const pending = setImmediate(() => {
        this.pendingDrain = null;
        this.drainScheduled = false;
        this.drainPreHandlerFrames();
      });
      // UNREF'd (codex round 3, P1; re-examined round 4): a handler that emits a frame per delivery keeps
      // one continuation perpetually pending, and a referenced immediate would stop
      // a short-lived CLI — or a test — from ever exiting. Held so stop() can cancel
      // it: a bridge torn down inside the schedule-to-callback window must not run
      // it afterwards.
      //
      // The cost of unref is that a process which would otherwise exit does not wait
      // for this. That is acceptable HERE and nowhere else in the queue: the budget
      // is the whole backlog, so everything that arrived before the handler is
      // delivered in the FIRST, synchronous pass. A continuation therefore only ever
      // carries frames a handler produced while being drained — work whose consumer
      // is going away too. The alternative, a referenced immediate, hangs the process
      // forever on a self-feeding handler, which is strictly worse.
      pending.unref?.();
      this.pendingDrain = pending;
    }
    if (delivered > 0) {
      logger.info(
        `[ui-bridge] delivered ${delivered} of ${held} panel frame(s) that arrived before the ` +
          `handler was installed (#1411)`,
      );
    }
    if (this.preHandlerDropped > 0) {
      logger.warn(
        `[ui-bridge] ${this.preHandlerDropped} panel frame(s) were REFUSED before the handler ` +
          `was installed and are gone (#1411)`,
      );
      this.preHandlerDropped = 0;
    }
  }

  /** Test seam: how many frames are held right now, and how many were refused. */
  preHandlerBacklog(): { held: number; dropped: number; bytes: number } {
    return {
      held: this.preHandlerFrames.length,
      dropped: this.preHandlerDropped,
      bytes: this.preHandlerBytes,
    };
  }

  constructor(port = DEFAULT_BRIDGE_PORT, token: string | null = null, host = "127.0.0.1") {
    this.port = port;
    this.token = token;
    this.host = host;
    if (!isLoopbackBindHost(host) && !token) {
      // The bridge drives the live canvas + agent; exposing it beyond loopback
      // without auth is never acceptable — refuse loudly at construction.
      throw new Error(
        `UiBridge: refusing to bind the panel bridge on non-loopback host "${host}" without a token. ` +
          `Set COMFYUI_MCP_BRIDGE_TOKEN (or let the orchestrator generate one).`,
      );
    }
  }

  /** Constant-time token check for the WS upgrade. Always true when no token is
   *  configured (loopback mode). Length-mismatch short-circuits before the
   *  timing-safe compare (which requires equal-length buffers). */
  private tokenOk(provided: string): boolean {
    if (!this.token) return true;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  start(): void {
    this.portInUse = false;
    this.readyPromise = new Promise<boolean>((resolve) => {
      this.readyResolve = resolve;
    });
    this.attemptListen(0);
  }

  /**
   * WebSocket keepalive. Every HEARTBEAT_MS, ping each live socket so a proxied
   * connection (cloudflared tunnel) never sits idle long enough for Cloudflare to
   * reap it during a long, quiet agent turn — the root cause of "intermittent
   * connection and drops" on the secure wss:// bridge. A socket that misses
   * MAX_MISSED_PONGS pings in a row is treated as dead and terminated so the panel
   * reconnects onto a clean socket. The timer is unref'd so it never keeps the
   * process alive on its own.
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      // Ping the primary listener AND any pairing listeners — a phone on a LAN or
      // tunnel bind needs the same idle-keepalive the browser panel gets.
      const servers = [this.wss, ...this.extraServers].filter(
        (s): s is WebSocketServer => s !== null,
      );
      for (const server of servers) {
        for (const sock of server.clients) {
          const missed = this.missedPongs.get(sock) ?? 0;
          if (missed >= UiBridge.MAX_MISSED_PONGS) {
            try {
              sock.terminate();
            } catch {
              // already gone
            }
            continue;
          }
          this.missedPongs.set(sock, missed + 1);
          try {
            sock.ping();
          } catch {
            // socket mid-close — the next tick's terminate/close handler cleans up
          }
        }
      }
    }, UiBridge.HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  /**
   * Resolves true once the bridge port is bound, false if it ultimately can't
   * bind (port held by another process). Lets a caller that *must* own the port
   * — the panel orchestrator — fail loudly instead of running uselessly.
   */
  whenReady(): Promise<boolean> {
    return this.readyPromise ?? Promise.resolve(this.wss !== null);
  }

  /**
   * Bind the loopback bridge port, retrying briefly on EADDRINUSE. A fast
   * `/mcp` reconnect can race the previous session's bridge before the OS has
   * released the port; rather than degrade immediately we back off and retry,
   * so the common restart case self-heals. Non-blocking — this never delays
   * MCP stdio startup, which is what matters for the client's init timeout.
   */
  private attemptListen(attempt: number): void {
    // Loopback by default — this drives the user's live editor. Two ways it can
    // be reachable off-box, BOTH token-gated on the WS upgrade:
    //   • secure mode: loopback bind fronted by a cloudflared wss:// tunnel
    //   • LAN mode (panel #54): a non-loopback bind host, for a 24/7 server-side
    //     orchestrator; the constructor enforces token-with-non-loopback.
    const wss = new WebSocketServer({
      port: this.port,
      host: this.host,
      verifyClient: this.token
        ? (info, cb) => {
            let provided = "";
            try {
              provided =
                new URL(info.req.url ?? "/", "http://127.0.0.1").searchParams.get("token") ?? "";
            } catch {
              provided = "";
            }
            if (this.tokenOk(provided)) return cb(true);
            logger.warn("[ui-bridge] rejected a bridge connection with a missing/invalid token");
            cb(false, 401, "Unauthorized");
          }
        : undefined,
    });

    wss.on("listening", () => {
      this.portInUse = false;
      this.wss = wss;
      logger.info(
        `[ui-bridge] listening on ws://${this.host}:${this.port}${this.token ? " (token-gated)" : ""}`,
      );
      this.startHeartbeat();
      this.readyResolve?.(true);
      this.readyResolve = null;
    });

    wss.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Discard this server; a fresh one is created per retry.
        try {
          wss.close();
        } catch {
          // Nothing bound to clean up.
        }
        if (attempt < UiBridge.MAX_BIND_ATTEMPTS) {
          const delay = UiBridge.BIND_RETRY_BASE_MS * 2 ** attempt;
          logger.warn(
            `[ui-bridge] port ${this.port} in use — a previous session may still be releasing it; retrying in ${delay}ms (attempt ${attempt + 1}/${UiBridge.MAX_BIND_ATTEMPTS})`,
          );
          this.bindRetryTimer = setTimeout(() => {
            this.bindRetryTimer = null;
            this.attemptListen(attempt + 1);
          }, delay);
          return;
        }
        this.portInUse = true;
        // #1524 — this used to promise "this session's MCP tools still work, but
        // panel_* commands are unavailable until that session exits", describing
        // a degraded-but-running process. That process does not exist:
        // `startUiBridge` has exactly ONE caller, and on a false `whenReady()` it
        // tries to reclaim the port and then `process.exit(1)`s. So the sentence
        // described a mode the code cannot enter, and anyone diagnosing a
        // portless orchestrator against it was reading a fiction.
        // THREE rewrites of this sentence were false, each in a new way: it
        // promised a degraded-but-running mode that cannot exist; then a takeover
        // attempt that only happens on a TTY; then an interactive prompt that also
        // requires a reclaimable pid, and an owner that need not be ours at all.
        //
        // Every error was the same mistake — narrating what the ORCHESTRATOR will
        // do next, from a module that cannot see those conditions. So this now
        // reports only what the bridge itself observed, and leaves the outcome to
        // the code that decides it (which logs its own, accurate message).
        logger.warn(
          `[ui-bridge] could not bind port ${this.port} after ${UiBridge.MAX_BIND_ATTEMPTS} ` +
            `attempts — it is held by another process. The panel bridge is NOT listening.`,
        );
        this.readyResolve?.(false);
        this.readyResolve = null;
      } else if (this.wss) {
        // We had successfully bound (listening) and the server errored AFTER
        // startup — the port/bridge is gone and can't recover in-process. Exit so
        // the panel pack respawns a CLEAN orchestrator instead of leaving a zombie
        // (process alive, bridge dead → panel can't reconnect). This was a root
        // cause of "the panel agent will no longer reconnect."
        logger.error(
          `[ui-bridge] fatal: server error after startup (${err.message}) — exiting so a fresh orchestrator can take over`,
        );
        this.wss = null;
        process.exit(1);
      } else {
        logger.error(`[ui-bridge] server error: ${err.message}`);
        // Never reached "listening" — unblock any whenReady() waiter.
        this.readyResolve?.(false);
        this.readyResolve = null;
      }
    });

    wss.on("connection", (sock, req) => {
      // Keepalive bookkeeping for the SERVER-LEVEL heartbeat loop, which only
      // iterates real wss.clients (relay-mediated shim connections aren't real
      // sockets bound by this server, so they're intentionally excluded — see
      // relay-client.ts / the relay README for why that's believed low-risk).
      this.missedPongs.set(sock, 0);
      sock.on("pong", () => this.missedPongs.set(sock, 0));
      // SERVER-OBSERVED handshake Origin, kept as syntactically validated metadata.
      // On this tokenless local listener a non-browser client can forge the header,
      // so it is never an authorization signal for outbound MCP requests.
      const handshakeOrigin = normalizeHandshakeOrigin(req?.headers?.origin);
      // Trusted-local ONLY when the primary listener is a token-less loopback bind
      // (no LAN bind, no tunnel/secure token in front) — see handleConnection's doc.
      this.handleConnection(sock, !this.token && isLoopbackBindHost(this.host), handshakeOrigin);
    });
  }

  /**
   * Attach a non-loopback panel connection — used by the relay client
   * (relay-client.ts) to feed a relay-multiplexed panel-tab connection into the
   * exact same hello/rid/tab-routing logic a direct loopback socket gets. From
   * here on the relay shim is indistinguishable from a real connection.
   */
  /**
   * @param serverOrigin The origin to scope this connection's workflow identity
   *   to. A relay socket has no handshake to observe one from (#1077), so the
   *   caller supplies the one it already knows — see `setupRelayBridge`. Omitting
   *   it leaves the connection unable to ever adopt a workflow fence.
   */
  attachRelayConnection(sock: BridgeSocket, serverOrigin?: string): void {
    this.handleConnection(sock, false, serverOrigin);
  }

  /**
   * Open a SECOND, ALWAYS token-gated listener on `host:port` and route its
   * connections through the same tab/rid logic as the primary bridge. Used by the
   * on-demand "pair a phone" flow: a `0.0.0.0` bind so a phone can reach it over
   * the LAN, and/or a loopback port a cloudflared quick-tunnel fronts. The primary
   * loopback listener stays token-less, so the local browser panel is untouched.
   * Resolves once bound; rejects if the port can't be bound. Idempotent-ish: the
   * caller is responsible for not re-binding the same port.
   */
  addListener(host: string, port: number, token: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const wss = new WebSocketServer({
        port,
        host,
        verifyClient: (info, cb) => {
          let provided = "";
          try {
            provided =
              new URL(info.req.url ?? "/", "http://127.0.0.1").searchParams.get("token") ?? "";
          } catch {
            provided = "";
          }
          const a = Buffer.from(provided);
          const b = Buffer.from(token);
          if (a.length === b.length && timingSafeEqual(a, b)) return cb(true);
          logger.warn("[ui-bridge] pairing listener rejected a connection with a missing/invalid token");
          cb(false, 401, "Unauthorized");
        },
      });
      wss.on("connection", (sock, req) => {
        this.missedPongs.set(sock, 0);
        sock.on("pong", () => this.missedPongs.set(sock, 0));
        // #2757/#2752 — READ THE HANDSHAKE `Origin`, exactly as the primary
        // listener does. This callback used to take `(sock)` alone and throw the
        // upgrade request away, so every connection arriving here had
        // `serverOrigin === undefined`.
        //
        // That is not an edge case: this is the listener the cloudflared
        // quick-tunnel is put in front of (`ensureSecureBridge` calls
        // `addListener("0.0.0.0", tunnelPort, tunnelToken)`), so it carries EVERY
        // remote-pod panel tab. cloudflared forwards the browser's `Origin`
        // header on the upgrade untouched — the orchestrator simply never looked.
        // The consequence is the reported wedge: `workflowIdentityParts()` gates
        // on an origin being PRESENT, so no tunnel-fronted tab could ever adopt a
        // workflow fence, and `panel_set_workflow_target({mode:"current"})`
        // applied the mode while refusing the rebind — permanently, for the whole
        // session.
        //
        // `local` stays false. This listener is token-gated and reachable off the
        // machine; the origin is identity/diagnostic metadata, never a
        // trusted-local or authorization signal (see handleConnection's doc).
        this.handleConnection(sock, false, normalizeHandshakeOrigin(req?.headers?.origin));
      });
      wss.on("listening", () => {
        settled = true;
        this.extraServers.push(wss);
        logger.info(`[ui-bridge] pairing listener on ws://${host}:${port} (token-gated)`);
        resolve();
      });
      wss.on("error", (err: NodeJS.ErrnoException) => {
        if (!settled) {
          settled = true;
          try {
            wss.close();
          } catch {
            // nothing bound
          }
          reject(err);
        } else {
          logger.warn(`[ui-bridge] pairing listener error: ${err.message}`);
        }
      });
    });
  }

  /**
   * @param local True only when the socket arrived on the token-less loopback
   *   primary listener. This is a bind/transport fact, not browser provenance:
   *   an arbitrary local client can still connect and forge HTTP headers.
   *   Token-gated/tunnel-fronted, relay, and LAN/pairing connections are `false`.
   * @param serverOrigin The origin (scheme://host:port) this connection's workflow
   *   identity is scoped to. Normally it is captured from the WebSocket upgrade's
   *   syntactically validated `Origin` header; a relay socket has no upgrade, so
   *   `attachRelayConnection` supplies an orchestrator-derived value. Neither path
   *   is an authorization signal for outbound requests.
   */
  private handleConnection(sock: BridgeSocket, local = false, serverOrigin?: string): void {
    // Track from ACCEPT, not from hello: an anonymous socket is still a socket,
    // and stop() must be able to close it (see `sockets`). Removed on close so
    // the set never outgrows the live connections.
    this.sockets.add(sock);
    sock.on("close", () => this.sockets.delete(sock));
    // The connection is anonymous until its hello frame names a tab id.
    let tabId: string | null = null;
    // A socket's KIND (canvas-owning panel vs headless viewer) is pinned on its
    // FIRST hello and is authoritative thereafter. The `headless` flag on later
    // hellos is client-controlled, so a headless viewer could otherwise flip it to
    // `false` to pass the same-kind takeover check and seize a desktop tab's id.
    let socketHeadless: boolean | null = null;
    // #422: capability proven under a PRE-MIGRATION tab id (tmp:<uuid> → wf:<tabRouteId>:<path>,
    // same socket/panel) so the veto survives the id change. The retiring conn is
    // deleted during migration below; without carrying this, a graph-edit-triggered
    // migration + undercutting-version hello would reintroduce the false "too old" gate.
    let migratedProvenSupported: Set<string> | undefined;
    // Same idea for the panel language: a WORKFLOW SWITCH re-hellos on this socket under a
    // NEW tab id, so the retiring conn is not `existing` and same-socket inheritance cannot
    // see it. Without this carry-over a panel that omitted `locale` on the switch hello would
    // drop back to English mid-session — which is exactly the case the field's doc claims is
    // preserved. Consumed once, with migratedProvenSupported.
    let migratedLocale: Locale | undefined;

    sock.on("message", (buf: unknown) => {
      const raw = String(buf);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        logger.warn("[ui-bridge] dropping malformed frame from panel");
        return;
      }

      // Hello: register (or refresh) this connection under its tab id.
      if (msg.type === "hello" && typeof msg.tab_id === "string") {
        // SECURITY (codex review): migrated_from is a SERVER-stamped field. A
        // client-supplied value would let any tab rebind another tab's agent —
        // scrub it unconditionally before the migration check below may re-add it.
        delete (msg as Record<string, unknown>).migrated_from;
        // A single socket may RE-HELLO under a new tab id when the user switches
        // ComfyUI workflow tabs (per-workflow sessions). Drop this socket's PRIOR
        // tab mapping so a background agent's push() to the old tab can't leak into
        // the newly-targeted view (frames carry no tab_id — the socket is the tab).
        if (tabId && tabId !== msg.tab_id && this.conns.get(tabId)?.sock === sock) {
          // PATH-COMPRESS the migration map: the reported field failure chains
          // ids (random UUID → tmp:<uuid> → wf:<tabRouteId>:<path>). A single-hop lookup on
          // the ORIGINAL id would land on the dead intermediate — rewrite every
          // entry pointing at the id being retired so any historical id resolves
          // to the LIVE tab in one step, and the map never grows chains. Entries
          // are SOCKET-SCOPED (codex review): wf:<tabRouteId>:<path> ids are deterministic and
          // recur across reconnects, so a migration must only ever route to the
          // socket that created it — compression too stays within this socket.
          for (const [from, entry] of this.tabMigrations) {
            if (entry.to === tabId && entry.sock === sock) {
              this.tabMigrations.set(from, { to: msg.tab_id as string, sock });
            }
          }
          this.tabMigrations.set(tabId, { to: msg.tab_id as string, sock });
          // Authoritative migration signal for the orchestrator (same-socket
          // re-hello — the ONLY safe rebind trigger; title matching is not).
          (msg as Record<string, unknown>).migrated_from = tabId;
          // Carry the retiring conn's proven-supported veto to the migrated id (#422)
          // — same socket/panel, so demonstrated capability must not be lost.
          migratedProvenSupported = this.conns.get(tabId)?.provenSupportedCmds;
          // …and the panel language, for the same reason: same socket, same browser tab, same
          // person reading the bubbles.
          migratedLocale = this.conns.get(tabId)?.locale;
          this.conns.delete(tabId);
          // Move mirror subscribers to the migrated tab id so viewers keep this
          // tab's live feed across a same-socket re-hello. #570 P0a — this is OPTIMISTIC
          // (it happens before the orchestrator can classify the switch); record exactly
          // which sockets we move so revokeTabMigration() can pull JUST these back out if
          // the switch turns out to be to a DIFFERENT workflow (never depending on the
          // destination's own session ownership to trigger the undo).
          const movedViewers = new Set<BridgeSocket>();
          const movedSubs = new Set<BridgeSocket>();
          // #568 — the LAST-ACTIVE selection is per-TAB identity state, so it has to move
          // with the tab id exactly like the mirror sets below. Left pointing at the id
          // being retired it names a tab that no longer exists, and with 2+ tabs connected
          // resolveTarget()/resolveActiveTabId() then report "none is last active" — which
          // disables panel_set_workflow_target({mode:"current"}), the ONE documented escape
          // hatch for a session whose binding went stale. The reported wedge (save-as with
          // two tabs open) is exactly that: the retiring id is removed, the selection is
          // left on it, and nothing can rebind. Moving it is not a guess — the same SOCKET
          // re-helloed, which is the server-observed proof that the new id and the old id
          // are the same browser tab. OPTIMISTIC like the mirror move (the orchestrator
          // classifies proven-vs-switch only afterwards); revokeTabMigration() undoes it.
          const movedLastActiveSeq =
            this.lastActiveTabId === tabId ? this.setLastActiveTab(msg.tab_id as string) : null;
          const migSubs = this.subscribers.get(tabId);
          if (migSubs) {
            this.subscribers.delete(tabId);
            const dest = this.subscribers.get(msg.tab_id as string) ?? new Set<BridgeSocket>();
            for (const s of migSubs) {
              dest.add(s);
              movedSubs.add(s);
            }
            this.subscribers.set(msg.tab_id as string, dest);
          }
          // Re-point any viewers driving the OLD id at the new one so their input
          // keeps reaching this tab's session across the re-hello.
          for (const [s, drivenTab] of this.mirrorViewers) {
            if (drivenTab === tabId) {
              this.mirrorViewers.set(s, msg.tab_id as string);
              movedViewers.add(s);
            }
          }
          if (movedViewers.size || movedSubs.size || movedLastActiveSeq !== null) {
            this.migratedMirror.set(tabId, {
              to: msg.tab_id as string,
              viewers: movedViewers,
              subs: movedSubs,
              lastActiveSeq: movedLastActiveSeq,
            });
          }
        }
        tabId = msg.tab_id;
        // Pin the socket's kind on its first hello; ignore any later flip so the
        // takeover guard below can't be bypassed with a forged `headless` value.
        if (socketHeadless === null) {
          socketHeadless = (msg as { headless?: unknown }).headless === true;
        }
        const incomingHeadless = socketHeadless;
        const existing = this.conns.get(tabId);
        if (existing && existing.sock !== sock) {
          // SECURITY: a viewer must not hello-hijack another client's tab id. The
          // reconnect-supersede path evicts the current holder, so without this a
          // headless phone could re-hello under a DESKTOP's id, kill its socket, and
          // register as that tab — bypassing attach_tab's authoritative stamping and
          // driving the tab it never attached to. Only same-kind reconnects (a real
          // reload: desktop→desktop, phone→phone) may supersede. Cross-kind is refused.
          if (existing.headless !== incomingHeadless) {
            logger.warn(
              `[ui-bridge] refused cross-kind hello takeover of tab ${tabId.slice(0, 8)} ` +
              `(existing headless=${existing.headless}, incoming headless=${incomingHeadless})`,
            );
            try {
              sock.close();
            } catch {
              // Already gone.
            }
            return;
          }
          // Same tab reconnected (reload) — supersede the stale socket.
          try {
            existing.sock.close();
          } catch {
            // Already gone.
          }
        }
        const incomingTabSessionId =
          typeof (msg as { tab_session_id?: unknown }).tab_session_id === "string" &&
          (msg as { tab_session_id?: string }).tab_session_id?.trim()
            ? (msg as { tab_session_id?: string }).tab_session_id!.trim()
            : undefined;
        // #486 — THIS tab is back. Cancel its pending "is it gone?" clock, so an
        // ordinary reload never retires state only this tab can be told about.
        //
        // Matched on the BROWSER-TAB SESSION, not the key: a `wf:` route key
        // recurs, so a DIFFERENT tab opening the same saved workflow takes it
        // over. Keyed on the id alone, that stranger's hello would cancel the
        // departed tab's clock — and a later result from the stranger could then
        // report and settle the departed tab's lost-answer disclosure as its own.
        // Same key is not the same tab; only the same incarnation coming back is
        // a proven return.
        // ALWAYS an identity for this connection — the panel's proven one, or a
        // fresh synthetic. See PanelConn.incarnationId for why anonymous ones must
        // be distinct rather than shared.
        // PER CONNECTION, not per hello. A panel re-hellos on its own live socket
        // (a title change, a re-registration), and minting a fresh `anon:<n>`
        // there would make the connection look like a stranger to itself: the
        // takeover branch below would fire and close its own asks, after which
        // its real conversation could neither recover nor be pushed its answers.
        // The identity is a property of the connection; an event that can repeat
        // on one connection must not mint a new one.
        const incarnationId =
          incomingTabSessionId ??
          this.sockIncarnation.get(sock)?.incarnation ??
          `anon:${++this.nextAnonIncarnation}`;
        this.sockIncarnation.set(sock, { tabId, incarnation: incarnationId });
        // #486 — A DIFFERENT BROWSER TAB has taken this recurring key over. That is
        // not a reconnect, it is a change of occupant: the previous tab's
        // conversation is over, and anything of its still addressed to this key must
        // stop being answerable BEFORE the newcomer can reach it. Fired here, at the
        // hello, rather than on the departing socket's grace — a takeover is proof,
        // so there is nothing to wait for.
        if (existing && existing.incarnationId !== incarnationId) {
          try {
            this.onTabTakenOver?.(tabId, existing.incarnationId);
          } catch (err) {
            logger.warn(
              `[ui-bridge] tab-takeover listener threw for ${tabId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        this.cancelTabGone(tabId, incarnationId);
        // A hello can keep the route id while replacing the viewed workflow or
        // subgraph. Do not let a scope witness from the prior canvas authorize
        // a later promoted write.
        this.promotedScopes.delete(tabId);
        this.conns.set(tabId, {
          sock,
          tabId,
          title: typeof msg.title === "string" && msg.title ? msg.title : "untitled",
          connectedAt: existing?.connectedAt ?? new Date().toISOString(),
          helloGeneration: ++this.nextHelloGeneration,
          // #709: do not inherit across a different socket reusing a workflow
          // tab id. The browser-tab identity must have arrived on THIS hello,
          // otherwise it cannot prove that the tab receiving the reboot is the
          // tab that came back afterwards.
          tabSessionId: incomingTabSessionId,
          incarnationId,
          headless: incomingHeadless,
          panelVersion:
            typeof (msg as { panel_version?: unknown }).panel_version === "string"
              ? ((msg as { panel_version?: string }).panel_version || undefined)
              : existing?.panelVersion,
          // Did THIS hello carry its own version? Only then may proactive gating trust
          // it (#392) — an omitted-version reconnect inherits panelVersion for messaging
          // but must not be proactively blocked on it (see the field's doc comment).
          panelVersionAdvertised:
            typeof (msg as { panel_version?: unknown }).panel_version === "string" &&
            !!(msg as { panel_version?: string }).panel_version,
          // #570 P0c — re-read from THIS hello, never inherited (a reconnect may be a newly
          // updated build). Strict === true so any non-true / absent value is non-enforcing.
          enforcesWorkflowStamp:
            (msg as { enforces_workflow_stamp?: unknown }).enforces_workflow_stamp === true,
          enforcesWorkflowStampAtWrite:
            (msg as { enforces_workflow_stamp_at_write?: unknown }).enforces_workflow_stamp_at_write === true,
          enforcesExpectedNodeTypeAtWrite:
            (msg as { enforces_expected_node_type_at_write?: unknown }).enforces_expected_node_type_at_write === true,
          enforcesExpectedNodeIdentityAtWrite:
            (msg as { enforces_expected_node_identity_at_write?: unknown })
              .enforces_expected_node_identity_at_write === true,
          enforcesExpectedScopeAtWrite:
            (msg as { enforces_expected_scope_at_write?: unknown }).enforces_expected_scope_at_write === true,
          enforcesExpectedScopeGraphIdentityAtWrite:
            (msg as { enforces_expected_scope_graph_identity_at_write?: unknown })
              .enforces_expected_scope_graph_identity_at_write === true,
          publishesPromotedTerminalWitnesses:
            (msg as { publishes_promoted_terminal_witnesses?: unknown })
              .publishes_promoted_terminal_witnesses === true,
          enforcesPromotedParentRailAtWrite:
            (msg as { enforces_promoted_parent_rail_at_write?: unknown })
              .enforces_promoted_parent_rail_at_write === true,
          // Re-read per hello like the stamps above: a reconnect can be a different build.
          acceptsAgentNotes:
            (msg as { accepts_agent_notes?: unknown }).accepts_agent_notes === true,
          // #2017 — painter kinds THIS hello claimed. Never inherited: an omitted
          // list on a reconnect must fall back to the version floor, not to a
          // previous connection's claim.
          showMediaKinds: readHelloShowMediaKinds(
            (msg as { show_media_kinds?: unknown }).show_media_kinds,
          ),
          // Fresh per hello — see the field's doc comment (#236).
          unsupportedCmds: new Set<string>(),
          // INHERITED across a reconnect (the panel code did not get older) so a command
          // this connection already served is never re-gated as "too old" by a later
          // undercutting advertised version (#422). Also carries a PRE-MIGRATION proven
          // set (tmp:→wf: id change, same socket) so the veto survives the id migration.
          // Safe polarity — see the field doc; a genuine downgrade re-proves via the
          // Unknown-command reply which clears it.
          provenSupportedCmds: new Set<string>([
            ...(existing?.provenSupportedCmds ?? []),
            ...(migratedProvenSupported ?? []),
          ]),
          // window.location the browser was served from — the ComfyUI instance THIS
          // tab fronts. Preserved across a SAME-SOCKET re-hello that omits it, but
          // NEVER inherited by a DIFFERENT socket reusing this (possibly recurring
          // wf:<tabRouteId>:<path>) tab id — that could let an unrelated instance's origin certify
          // this tab's restart (#509, codex: cross-ownership inheritance).
          originUrl:
            typeof (msg as { comfyui_url?: unknown }).comfyui_url === "string" &&
            (msg as { comfyui_url?: string }).comfyui_url
              ? (msg as { comfyui_url?: string }).comfyui_url
              : existing?.sock === sock
                ? existing?.originUrl
                : undefined,
          // SERVER-OBSERVED handshake Origin of THIS socket (from the WS upgrade, not the
          // hello) — bound per-socket. A same-socket re-hello keeps it; a DIFFERENT socket
          // taking over the id carries its OWN handshake Origin (never inherits the old).
          serverOrigin: existing?.sock === sock ? (serverOrigin ?? existing?.serverOrigin) : serverOrigin,
          // Server-trusted provenance of THIS socket (not client-controlled).
          local,
          // The panel's own resolved UI language, so `say` bubbles land in the language of
          // the controls they name. Narrowed here rather than at the read sites: an unshipped
          // or garbage value becomes undefined once, at the boundary, instead of every caller
          // having to defend against it.
          //
          // PRESENCE decides inheritance, not resolvability. A hello that CARRIES the field is
          // authoritative even when we cannot ship what it asked for: a user who just switched
          // the panel to German must get English, not the Japanese they had a moment ago —
          // otherwise every bubble names controls in a language no longer on their screen.
          //
          // Only an ABSENT field inherits, and only from this same socket (the `originUrl`
          // rule above, same reason: wf: ids recur, so a DIFFERENT socket reusing this id is a
          // different browser tab whose language we have not been told) — or from the conn
          // this socket is migrating away from, since a workflow switch re-hellos under a NEW
          // tab id. Cosmetic either way; nothing gates on it.
          locale:
            "locale" in msg
              ? typeof msg.locale === "string"
                ? (resolveLocale(msg.locale) ?? undefined)
                : undefined
              : ((existing?.sock === sock ? existing?.locale : undefined) ?? migratedLocale),
        });
        // CONSUME the migration carry-over exactly once: it belongs to THIS hello's
        // conn only. Leaving it set would let a LATER same-socket re-hello rebuild the
        // proven veto from the stale pre-migration set — even after a genuine
        // Unknown-command reply cleared it — re-bypassing the undercut-version gate
        // (codex round-8 P1).
        migratedProvenSupported = undefined;
        migratedLocale = undefined;
        if (incomingHeadless) {
          this.headlessSeen.add(tabId);
        } else {
          // A different, fresh socket may legally reuse a disconnected tab id. Its
          // first hello is authoritative for THIS live session, so do not let an
          // old phone's sticky media classification hide a real desktop tab or
          // suppress its panel-version repair.
          this.headlessSeen.delete(tabId);
          // A canvas-owning (non-headless) hello PROVES the comfyui-mcp-panel pack is
          // installed and a real ComfyUI browser tab was open — the precondition for
          // the "refresh the browser tab" guidance (#436.4). A headless mobile/remote
          // pseudo-panel must NOT set this: if only a phone ever connected, there may be
          // no desktop tab to refresh and no proof the sidebar pack is installed (codex).
          this.everConnectedDesktopTab = true;
        }
        this.broadcastTabList(); // a tab connected/reconnected — refresh mirror pickers
        // Log a real connect ONCE per tab id. A reconnect/ping-pong loop (a new
        // socket every couple seconds — e.g. two browser contexts sharing one tab
        // id) would otherwise spam this; dedup by tab id so churn stays at debug.
        if (!this.seenTabs.has(tabId)) {
          this.seenTabs.add(tabId);
          logger.info(
            `[ui-bridge] panel tab connected: ${tabId.slice(0, 8)} (“${this.conns.get(tabId)?.title}”) — ${this.conns.size} tab(s) total`,
          );
        } else {
          logger.debug(`[ui-bridge] tab ${tabId.slice(0, 8)} (re)hello`);
        }
        // #570 P0 — run the orchestrator's hello handler FIRST. Its identity-boundary reset
        // can call dropQueuedDeliveries(tabId) on an UNPROVEN workflow transition (a saved
        // workflow overwritten in place, reconnecting under the same wf:<path>), so the
        // buffered items below — which belong to the PRIOR workflow — are NOT replayed into
        // the replacement (a wrong-conversation/media delivery). For a PROVEN reconnect it
        // drops nothing, so the replay/flush proceeds exactly as before, just after the ack.
        this.deliverPanelEvent(msg as PanelEvent);
        // Replay anything this tab's agent produced while the tab had no live connection
        // (its socket was re-helloed to another workflow). The panel swaps to this
        // workflow's thread synchronously, so they render + record into the RIGHT
        // conversation (or nothing, if the reset above dropped them).
        const missed = this.missedFrames.get(tabId);
        if (missed?.length) {
          this.missedFrames.delete(tabId);
          for (const f of missed) {
            try {
              sock.send(JSON.stringify(f));
            } catch {
              break; // socket died mid-flush — frames stay lost, next turn recovers
            }
          }
          logger.debug(`[ui-bridge] replayed ${missed.length} missed frame(s) to tab ${tabId.slice(0, 8)}`);
        }
        // Deliver anything that finished while this tab was away.
        this.flushMailbox(tabId);
        // #884 — conversation frames/deliveries produced while ZERO tabs were
        // connected are buffered under a SCOPE ADDRESS (bare `orchestrator` or
        // the backend-qualified agent key — the session is orchestrator-scoped,
        // not tab-scoped). The first tab of the MATCHING conversation picks
        // them up: a backend-qualified buffer only drains to a hello on that
        // backend — a Codex tab helloing first must never receive a Claude
        // conversation's buffered output (confirming-gate P1). Bare-scope
        // buffers (backend-unattributed) drain to any hello, as before.
        // The backend this hello JOINS, normalized exactly as the orchestrator
        // will map it (unknown/absent → the default backend) — an omitted or
        // misspelled `backend` must still drain the default conversation's
        // buffers (confirming-gate 2, P1). Without a normalizer (tests, bare
        // bridges) only an exact advertised backend matches.
        const rawHelloBackend = (msg as { backend?: unknown }).backend;
        const helloBackend = this.helloBackendNormalizer
          ? this.helloBackendNormalizer(rawHelloBackend)
          : typeof rawHelloBackend === "string"
            ? rawHelloBackend.toLowerCase()
            : undefined;
        const scopeKeyMatchesHello = (scopeKey: string): boolean =>
          scopeKey === SHARED_SESSION_SCOPE ||
          (helloBackend !== undefined && scopeKey === `${SHARED_SESSION_SCOPE}::${helloBackend}`);
        for (const scopeKey of [...this.missedFrames.keys()]) {
          if (!isScopeAddress(scopeKey) || !scopeKeyMatchesHello(scopeKey)) continue;
          const sharedMissed = this.missedFrames.get(scopeKey);
          if (!sharedMissed?.length) {
            this.missedFrames.delete(scopeKey);
            continue;
          }
          // Deliver first, delete after: a socket failing mid-flush keeps the
          // REMAINDER buffered for the next hello instead of losing it
          // (confirming-gate P1 — the old delete-first shape dropped it).
          let sent = 0;
          for (const f of sharedMissed) {
            try {
              sock.send(JSON.stringify(f));
              sent += 1;
            } catch {
              break; // socket died mid-flush — the remainder stays buffered
            }
          }
          if (sent >= sharedMissed.length) this.missedFrames.delete(scopeKey);
          else this.missedFrames.set(scopeKey, sharedMissed.slice(sent));
          logger.debug(
            `[ui-bridge] replayed ${sent}/${sharedMissed.length} shared-session frame(s) to tab ${tabId.slice(0, 8)}`,
          );
        }
        for (const scopeKey of [...this.mailbox.keys()]) {
          if (isScopeAddress(scopeKey) && scopeKeyMatchesHello(scopeKey)) {
            this.flushMailbox(scopeKey, this.conns.get(tabId));
          }
        }
        // Resume any idempotent reads that were dropped mid-command by this tab's
        // previous socket (bounded reconnect grace) onto the fresh connection.
        this.resumeAwaitingReconnect(tabId);
        return;
      }

      const rid = typeof msg.rid === "string" ? msg.rid : undefined;
      if (rid) {
        const p = this.pending.get(rid);
        if (!p) {
          // Late reply for a timed-out command. If it was an ask_user card whose
          // caller may still be within the MCP tools/call budget, BUFFER the
          // validated answer keyed by its ask_id so the caller can retrieve it via
          // takeLateAskReply() instead of losing it (#486). Everything else drops.
          //
          // #2440 — deliver to a STILL-WAITING restart/confirm first. A reply can
          // miss `pending` (rid rewritten, timer already fired) while the tool
          // call that painted the card is still blocked on it. Caching only for
          // the next call left that waiter to time out after the user clicked.
          const entry = this.askRidToId.get(rid);
          const askId = entry?.askId ?? messageAskId(msg);
          if (askId && msg.ok) {
            const live = this.findPendingForAskId(askId);
            if (live) {
              this.askRidToId.delete(rid);
              this.settlePendingAskSuccess(live.rid, live.pending, msg.result, sock);
              return;
            }
            this.wakeLateAskWaiters(askId, msg.result);
          }
          if (entry) {
            this.askRidToId.delete(rid);
            if (msg.ok) {
              this.pruneLateAsk();
              this.lateAskReplies.set(entry.askId, { result: msg.result, ts: Date.now() });
              // …and hand it to the durable journal RIGHT NOW, whether or not any
              // caller is still polling (#486). The buffer above is only reachable
              // by a live poller; this is what makes an answer given after the
              // tool call died survive at all. Never let a sink fault break the
              // message loop.
              //
              // EXCEPT FOR A CREDENTIAL (#1352). The in-memory buffer above is bounded by
              // a TTL and cleared when claimed; the journal is durable BY DESIGN, which is
              // the one property a secret must not have. So a secret card's late answer is
              // recoverable within this process and nowhere else — and if nothing claims
              // it, it expires unread rather than being written down.
              //
              // The journal ALSO declines it on its own (`AskAnswers.tracks` accepts only
              // panel_ask-prefixed ids), so this is the second of two barriers rather than
              // the only one. It is still worth having here: that prefix rule is the
              // JOURNAL's policy, expressed in another file for its own reasons, and a
              // guarantee about credentials should not depend on it staying that way.
              try {
                if (!entry.sensitive) this.lateAskSink?.(entry.askId, msg.result, entry.tabId);
              } catch (err) {
                logger.warn(
                  `[ui-bridge] late ask-answer sink threw (the answer is still buffered): ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          }
          // #2559 — a concurrent widget write can land its ACK under a rid the
          // bridge is no longer waiting on (rewritten, coalesced, or already
          // recorded as late) while a sibling graph_set_widget on THIS socket
          // is still blocked. Deliver the result to that waiter instead of
          // stranding the MCP tool call.
          const fifo = this.findFifoPendingForSetWidgetReply(sock, msg);
          if (fifo) {
            this.askRidToId.delete(rid);
            this.settlePendingReply(fifo.rid, fifo.pending, msg, sock);
            return;
          }
          this.recordLateMutation(rid, msg);
          return;
        }
        this.settlePendingReply(rid, p, msg, sock);
        return;
      }

      // #2440 — a card approval that names its ask_id but not the command rid
      // still belongs to the in-flight confirm. Deliver it to that waiter
      // before caching it for a subsequent call.
      const ridlessAskId = messageAskId(msg);
      if (
        ridlessAskId &&
        msg.ok === true &&
        "result" in msg &&
        typeof msg.type !== "string"
      ) {
        const live = this.findPendingForAskId(ridlessAskId);
        if (live) {
          this.settlePendingAskSuccess(live.rid, live.pending, msg.result, sock);
          return;
        }
        this.wakeLateAskWaiters(ridlessAskId, msg.result);
        this.pruneLateAsk();
        this.lateAskReplies.set(ridlessAskId, { result: msg.result, ts: Date.now() });
        try {
          if (tabId) this.lateAskSink?.(ridlessAskId, msg.result, tabId);
        } catch (err) {
          logger.warn(
            `[ui-bridge] late ask-answer sink threw (the answer is still buffered): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }

      // Lightweight title update — keep the tab's title fresh
      // WITHOUT re-greeting. The panel sends this on title mutations instead of
      // a full hello, so a graph build / run progress doesn't spam greetings.
      if (msg.type === "title" && tabId) {
        const conn = this.conns.get(tabId);
        if (conn && typeof msg.title === "string" && msg.title) conn.title = msg.title;
        this.broadcastTabList(); // a title changed — refresh mirror pickers
        return;
      }

      // Desktop-tab mirroring (mobile remote control). Handled HERE (we hold the
      // requesting socket) so the replies are socket-scoped — never fanned out to
      // other viewers or the primary. Additive: unknown to the desktop panel.
      if (msg.type === "list_tabs") {
        try {
          sock.send(JSON.stringify({ type: "tab_list", cid: msg.cid, tabs: this.desktopTabs() }));
        } catch {
          /* socket died — the caller times out */
        }
        return;
      }
      if (msg.type === "attach_tab" && typeof msg.target_tab_id === "string") {
        const target = msg.target_tab_id;
        // Only allow mirroring a real, non-headless desktop tab — reject stale ids
        // and prevent subscribing to another headless (mobile) client.
        const valid = this.conns.has(target) && !this.headlessSeen.has(target);
        if (valid) {
          // A viewer mirrors ONE tab at a time — drop any prior subscription first so
          // re-attaching (A→B) doesn't keep streaming A's activity alongside B's.
          for (const [tid, s] of this.subscribers) {
            if (s.delete(sock) && s.size === 0) this.subscribers.delete(tid);
          }
          let set = this.subscribers.get(target);
          if (!set) {
            set = new Set();
            this.subscribers.set(target, set);
          }
          set.add(sock);
          // Route this viewer's inbound events to the mirrored tab (remote control).
          this.mirrorViewers.set(sock, target);
        }
        try {
          sock.send(
            JSON.stringify({
              type: "tab_attached",
              cid: msg.cid,
              tab_id: target,
              ok: valid,
              ...(valid ? {} : { error: "no such desktop tab" }),
            }),
          );
        } catch {
          /* socket died */
        }
        return;
      }
      if (msg.type === "detach_tab") {
        for (const [tid, set] of this.subscribers) {
          if (set.delete(sock) && set.size === 0) this.subscribers.delete(tid);
        }
        this.mirrorViewers.delete(sock); // stop routing its input to the mirrored tab
        return;
      }

      // Panel-initiated event. Stamp the tab and track activity. A mirroring viewer
      // (phone attached to a desktop tab) DRIVES that tab's shared session, so its
      // events route to the mirrored tab id — not the viewer's own — which is what
      // turns the mirror into remote control. Stamping is server-authoritative here
      // (it overwrites any client-supplied tab_id), so a viewer can't target a tab
      // it hasn't attached to.
      if (typeof msg.type === "string") {
        const effectiveTab = this.mirrorViewers.get(sock) ?? tabId;
        if (effectiveTab) {
          msg.tab_id = effectiveTab;
          msg.title = this.conns.get(effectiveTab)?.title;
          if (msg.type === "user_message") this.setLastActiveTab(effectiveTab);
        }
        // #1728 — this is a control receipt, not an agent-facing completion.
        // Retain it by the original graph_run rid so panel_run can open the
        // server ticket even when the normal command reply was already returned.
        if (msg.type === "run_receipt") {
          this.recordLateRunReceipt(msg, effectiveTab);
          return;
        }
        this.deliverPanelEvent(msg as PanelEvent);
      }
    });

    sock.on("close", () => {
      // Prune this socket's migration aliases — they can only ever route to
      // this socket (socket-scoped), so they're inert once it dies. Keeps the
      // map bounded over long-lived orchestrators (codex review).
      for (const [from, entry] of this.tabMigrations) {
        if (entry.sock === sock) this.tabMigrations.delete(from);
      }
      // #570 P0a — prune recorded mirror-migration undo state referencing this dying tab
      // (a proven-keep switch never calls revokeTabMigration, so its entry would otherwise
      // linger). Keyed by / pointing at this tab id → inert once it's gone.
      for (const [from, m] of this.migratedMirror) {
        if (from === tabId || m.to === tabId) this.migratedMirror.delete(from);
      }
      // Drop this socket from any mirror subscriptions (it was a viewer).
      for (const [tid, set] of this.subscribers) {
        if (set.delete(sock) && set.size === 0) this.subscribers.delete(tid);
      }
      this.mirrorViewers.delete(sock);
      // #486 — WHICH connection just died, from the socket itself. Asked before
      // any of the map surgery below, and independently of whether this socket
      // was still the primary: a second tab taking over a recurring key closes
      // this one AFTER installing itself, so "am I in the map?" answers no for a
      // tab that very much did just leave.
      const departing = this.sockIncarnation.get(sock);
      this.sockIncarnation.delete(sock);
      let wasPrimary = false;
      if (tabId && this.conns.get(tabId)?.sock === sock) {
        wasPrimary = true;
        // #1176 — start the recency clock BEFORE the conn is dropped, while its
        // `headless` flag is still readable. This is the only place that knows a
        // headless socket just closed; after the delete the information is gone.
        if (this.conns.get(tabId)?.headless === true) {
          this.lastHeadlessDisconnectAt = performance.now();
        }
        // #2013 — remember the kind that just left so a subsequent scope-keyed
        // mailbox (zero live tabs) is tagged for that client, not for "whoever
        // hellos next".
        this.lastDisconnectedHeadless = this.conns.get(tabId)?.headless === true;
        this.conns.delete(tabId);
        if (this.lastActiveTabId === tabId) this.setLastActiveTab(null);
        // The mirrored desktop tab is gone — detach its viewers so their input
        // reverts to their OWN session instead of routing into a dead id (and its
        // output isn't silently buffered forever). They can re-attach if it returns.
        for (const [s, drivenTab] of this.mirrorViewers) {
          if (drivenTab === tabId) this.mirrorViewers.delete(s);
        }
        this.subscribers.delete(tabId);
        logger.info(
          `[ui-bridge] panel tab disconnected: ${tabId.slice(0, 8)} — ${this.conns.size} tab(s) remain`,
        );
      }
      if (wasPrimary) this.broadcastTabList(); // a desktop tab left — refresh pickers
      // #486 — a socket close is NOT evidence the tab is gone; it is evidence a
      // socket closed, and an ordinary F5 produces exactly this. Arm the clock for
      // THIS connection's incarnation and let it fire only if that incarnation
      // stays away. Armed whether or not the socket was still primary: a takeover
      // by a second tab on the same recurring key leaves the departing tab out of
      // the map, and it is exactly the one that must still be declarable.
      if (departing && this.conns.get(departing.tabId)?.incarnationId !== departing.incarnation) {
        this.armTabGone(departing.tabId, departing.incarnation);
      }
      // An in-flight command's socket just died. Instead of hard-failing every one
      // with a bare "disconnected" (which reads as a clean failure and invites a
      // blind retry — double render for a run), hand each to the disconnect handler:
      // idempotent reads wait a bounded grace for the tab to reconnect and resume;
      // mutating commands surface an honest OUTCOME-UNKNOWN error.
      for (const [rid, p] of this.pending) {
        if (p.sock === sock) {
          clearTimeout(p.timer);
          this.pending.delete(rid);
          this.handleMidCommandDisconnect(p, rid);
        }
      }
    });
  }

  /** The ONLY writer of {@link lastActiveTabId}. Returns the sequence number this
   *  write produced so a caller (the tab-id-migration carry) can later prove that
   *  its own write is still the current selection before undoing it (#568). */
  private setLastActiveTab(tabId: string | null): number {
    this.lastActiveTabId = tabId;
    this.lastActiveSeq += 1;
    return this.lastActiveSeq;
  }

  connected(): boolean {
    return this.conns.size > 0;
  }

  /** Would a command bound to this EXACT tabId reach a live tab right now?
   *  (Exact id, an unambiguous prefix, or a live same-socket migration alias —
   *  the same acceptance `resolveTarget` uses, but as a boolean and never
   *  throwing.) The orchestrator uses this to tell an orphaned session from a
   *  healthy one before deciding whether to self-heal via a rebind. */
  canReach(tabId: string): boolean {
    try {
      this.resolveTarget(tabId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * WHY `tabId` does not resolve, or undefined when it does (#1077).
   *
   * `canReach()` and `tabServerOrigin()` both swallow the throw, so a turn whose
   * target is AMBIGUOUS (issued from several workflows at once, #1001) is
   * indistinguishable from a dead tab or a connection with no Origin. The fence
   * validator reads exactly those two signals, so an ambiguous turn was reported
   * as "the routed tab is no longer reachable" — or, worse, as the structural
   * no-Origin case, whose remedy tells the user that refreshing cannot help and
   * to stop using the relay backend. Every part of that is wrong here: the tabs
   * are connected, nothing is structural, and it clears on the next
   * single-origin message.
   *
   * The distinction is available and typed — resolveTarget marks the ambiguity
   * refusal — it was simply being discarded by the boolean-returning callers.
   */
  resolveFailure(tabId: string): "ambiguous" | "unresolved" | undefined {
    try {
      this.resolveTarget(tabId);
      return undefined;
    } catch (err) {
      return isRoutingAmbiguity(err) ? "ambiguous" : "unresolved";
    }
  }

  /** The LIVE tab id `tabId` currently resolves to (exact id, unambiguous
   *  prefix, or the same-socket migration-alias chain — the SAME acceptance
   *  {@link canReach}/resolveTarget use), or undefined when nothing resolves.
   *  The orchestrator's provider-switch pin invalidation judges a pin by where
   *  it ROUTES, not by the id it carries: path compression rewrites every
   *  historical alias to the newest live id in one step (see the migration
   *  block in the hello handler), so a pin can name an id no single hello ever
   *  reported as `migrated_from` and still resolve onto the switched tab. */
  liveTabIdFor(tabId: string): string | undefined {
    try {
      return this.resolveTarget(tabId).tabId;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the live tab resolved for `tabId` can safely accept a mutation of
   * its active workflow. This mirrors the two pre-dispatch conditions in
   * {@link send}: the tab's CURRENT hello must advertise both the dispatch-time
   * workflow-stamp fence and its after-await write-boundary recheck, and the
   * orchestrator must have a trusted workflow stamp to
   * put on the command. A websocket reconnect alone proves neither (the browser
   * can reconnect with a cached, pre-#570 panel bundle), so callers reporting
   * graph-tool readiness must use this rather than `canReach` alone.
   *
   * This is an accidental-version-skew capability signal, not an attestation:
   * like the send gate, it intentionally describes the local panel protocol
   * needed to avoid an unfenced wrong-workflow write.
   */
  /**
   * Send operational status to the AGENT ONLY — never rendered in the user's chat.
   *
   * For the walls of text that are true, necessary and addressed to the wrong reader: a
   * failed panel auto-sync and its lock-recovery procedure, for instance. The agent has
   * to know; the person asking for an image does not, and printing one mid-conversation
   * reads like the assistant lost its place.
   *
   * FALLS BACK TO A VISIBLE `say` when the panel does not advertise `accepts_agent_notes`.
   * An older panel drops an unknown frame silently, so sending unconditionally would turn
   * "too loud" into "gone" — and a notice nobody sees is worse than an ugly one. The
   * fallback is the current behaviour exactly, so an un-updated panel is unaffected.
   *
   * Returns which channel was used, so a caller can log the difference rather than
   * assume.
   */
  pushAgentNote(text: string, tabId?: string): "agent_note" | "say" {
    // Resolve through resolveTarget — the SAME lookup push() will use (codex, P1).
    // A direct conns.get() misses alias/migration mappings that resolveTarget follows,
    // so a tab that re-helloed under a new id mid-operation would be judged incapable
    // here and then delivered to perfectly capable panel: the wall of text reappears on
    // exactly the build that can hide it. Reading it the same way removes the
    // disagreement, and there is no await between this and the push, so run-to-
    // completion guarantees the two see the same connection.
    let conn: Conn | undefined;
    if (tabId) {
      try {
        conn = this.resolveTarget(tabId);
      } catch {
        // Not routable. push() will buffer for replay on the next hello; the frame it
        // buffers must be the SAFE one, because we cannot know what will pick it up.
        conn = undefined;
      }
    }
    const hidden = conn?.acceptsAgentNotes === true;
    this.push({ type: hidden ? "agent_note" : "say", text }, tabId);
    return hidden ? "agent_note" : "say";
  }

  tabCanMutateGraph(tabId: string): boolean {
    // FAIL-CLOSED convenience for the readiness callers: an unreadable probe is
    // treated as "not ready", which is the right default when the question is
    // "may I promise the user graph tools work?". Callers that must DESCRIBE the
    // state to a human should use tabGraphMutationCapability instead — see below.
    const r = this.tabGraphMutationCapability(tabId);
    return r.known ? r.canMutate : false;
  }

  /**
   * panel#1859 — whether the receiver for `tabId` can be resolved AT ALL.
   *
   * Every capability accessor below answers `false` for two different facts:
   * "this hello did not advertise it" and "resolveTarget threw, so there is no
   * hello to read". Fail-closed is right for the GATE — an unreadable receiver
   * must not be dispatched to. It is wrong for the MESSAGE: describing an
   * unresolved tab as an out-of-date panel build tells a user to update and
   * hard-refresh when what they need is to reconnect, which is the same class
   * of unreachable advice panel#1859 is about.
   *
   * Same split the file already draws between `tabCanMutateGraph` (fail-closed
   * boolean for readiness) and `tabGraphMutationCapability` (tri-state for
   * callers that must DESCRIBE the state to a human). Read this in the same
   * synchronous turn as the capability itself: with no await between them,
   * run-to-completion guarantees both see the same connection.
   */
  tabReceiverResolvable(tabId: string): boolean {
    try {
      this.resolveTarget(tabId);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether THIS connected panel enforces graph_set_widget's optional
   * expected-node-type fence at the actual mutation boundary (#2107). */
  tabExpectedNodeTypeFenceCapability(tabId: string): boolean {
    try {
      return this.resolveTarget(tabId).enforcesExpectedNodeTypeAtWrite === true;
    } catch {
      return false;
    }
  }

  /** Whether THIS connected panel enforces graph_set_widget's optional opaque
   * expected-node-identity fence at the actual mutation boundary. */
  tabExpectedNodeIdentityFenceCapability(tabId: string): boolean {
    try {
      return this.resolveTarget(tabId).enforcesExpectedNodeIdentityAtWrite === true;
    } catch {
      return false;
    }
  }

  /** Whether THIS connected panel publishes the complete renamed-promotion
   * terminal witness required for alias-independent promoted-write preflight. */
  tabPromotedTerminalWitnessCapability(tabId: string): boolean {
    try {
      return this.resolveTarget(tabId).publishesPromotedTerminalWitnesses === true;
    } catch {
      return false;
    }
  }

  /** Whether THIS connected panel re-resolves the promoted parent rail at the
   * final graph_set_widget mutation boundary. */
  tabPromotedParentRailFenceCapability(tabId: string): boolean {
    try {
      return this.resolveTarget(tabId).enforcesPromotedParentRailAtWrite === true;
    } catch {
      return false;
    }
  }

  /**
   * The version THIS connection advertised in its own hello (#1828).
   *
   * Routed through `connPanelVersionReading` so an inherited reconnect value is
   * `.inherited` and never `.version` — a caller comparing against
   * `requiredPanelVersion()` must not treat a stale inherited reading as this
   * tab's current build. Unroutable tabs and omitted-version hellos yield `{}`.
   */
  advertisedPanelVersion(tabId: string): PanelVersionReading {
    try {
      return connPanelVersionReading(this.resolveTarget(tabId));
    } catch {
      return {};
    }
  }

  /**
   * Painter kinds THIS connection advertised in its own hello (`show_media_kinds`).
   * Undefined when the hello omitted the field or the tab cannot be resolved —
   * callers then fall back to {@link SHOW_MEDIA_KIND_MIN_PANEL_VERSION} (#2017).
   */
  tabShowMediaKinds(tabId: string): readonly string[] | undefined {
    try {
      return this.resolveTarget(tabId).showMediaKinds;
    } catch {
      return undefined;
    }
  }

  /**
   * Is the connected panel PROVABLY too old to publish a workflow_uuid on the
   * replies the fence recovery trusts? (#1043)
   *
   * `refreshFenceFromOwnReply` (#1161) repairs the session fence from the
   * command's OWN reply, before attempting the round trip the fence refuses.
   * That depends on the panel putting `workflow_uuid` on a save / new-workflow
   * reply, which is panel #800 — first shipped in panel 0.11.45.
   *
   * Three reports (#1043, #1077, #1174) hit the same deadlock on panels BELOW
   * that: the recovery finds nothing to adopt, falls back to the fenced read, and
   * the user is told only that the identity "could not be read". The fix is
   * present and inert, and the message names none of that.
   *
   * TRI-STATE, and the distinction is load-bearing: an UNKNOWN version must not
   * render as "your panel is too old", which would send someone to update a panel
   * that is already current. Only a parseable version below the minimum returns
   * `{ tooOld: true }`.
   */
  panelTooOldForReplyUuid(tabId: string): {
    tooOld: boolean;
    version?: string;
    needed: string;
    /**
     * The panel has NEVER advertised a version on this tab (#1560).
     *
     * Distinct from `advertised === false`, which only means THIS connection's
     * hello omitted it while a previous one supplied a value — the inherited case
     * the tri-state guard above exists for, where staying silent is right.
     *
     * Never having one is different, and it is evidence rather than absence:
     * `panel_version` has ridden the hello since panel v0.11.83 (measured — the
     * commit is an ancestor of v0.11.83 and of no earlier tag), so a panel that
     * has never sent one is BELOW 0.11.83.
     *
     * THAT IS ALL IT PROVES, and an earlier version of this said more (review, P1):
     * "below 0.11.83" does NOT imply "below 0.11.45". Panels in 0.11.45–0.11.82
     * publish the reply uuid perfectly well and simply predate version
     * advertisement, so telling one of those to update would name a cause that is
     * not theirs. The caller renders this as a possibility to CHECK, never as a
     * finding.
     *
     * It is still worth saying, because the band that cannot speak for itself is
     * where the #1043 deadlock lives: #1560's reporter was on 0.11.37 and got a
     * bare "the panel did not answer" with nothing to act on.
     */
    neverAdvertised?: boolean;
  } {
    const needed = PANEL_MIN_VERSION_REPLY_UUID;
    let version: string | undefined;
    let advertised = false;
    // Did the LOOKUP itself succeed? A throw leaves `version` undefined, which is
    // indistinguishable from "the panel never sent one" unless it is tracked
    // separately — and rendering an unreadable tab as "your panel is old" would
    // accuse a CURRENT panel whose socket merely closed (review, P1). Absence of
    // evidence, one level down.
    let resolved = false;
    try {
      const t = this.resolveTarget(tabId);
      resolved = true;
      version = t.panelVersion;
      // #1043 (codex review) — the version must come from THIS connection's own
      // hello. A re-hello that omits `panel_version` INHERITS the previous value,
      // so a panel that was updated and reloaded without re-advertising would
      // still show its old version — and we would tell someone to update a panel
      // they just updated. `panelVersionAdvertised` exists for exactly this, and
      // the proactive command gate already refuses to act on an inherited value.
      advertised = t.panelVersionAdvertised === true;
    } catch {
      version = undefined;
    }
    // NEVER advertised is not the same as "not advertised on this connection"
    // (#1560). The latter inherits a known value and must stay silent; the former
    // is only possible below v0.11.83, which is itself below `needed`.
    //
    // `tooOld` stays FALSE for it on purpose: this is an inference from a missing
    // field, not a version comparison, and the two must not be reported with the
    // same confidence. The caller renders it as a hedge.
    if (!advertised) {
      return resolved && version === undefined
        ? { tooOld: false, needed, neverAdvertised: true }
        : { tooOld: false, needed };
    }
    if (!version || !SEMVER_RE.test(version.trim())) return { tooOld: false, needed };
    return { tooOld: compareSemver(version, needed) < 0, version, needed };
  }

  /**
   * #1656/#1494 — the dispatch-time agreement question, with ONE implementation.
   *
   * `send()` asks it to decide whether a fenced command may be written, and
   * `tabGraphMutationCapability` asks it so the fence-rebind recovery can report the
   * same answer. They used to be unable to: the gate compares the session's stamp
   * against the routed tab's LAST ADVERTISED identity, while the recovery compares
   * the session's stamp against the LIVE canvas it reads with `workflow_list`. Those
   * are different facts, and when only the advertisement is stale they disagree —
   * the recovery reported `already_current` / `graph_binding:"bound"` on the very
   * uuid the gate was refusing against, so it announced success and cleared nothing
   * (#1494's report, verbatim). Sharing the predicate is what keeps them honest.
   *
   * `refuses:false` is returned for every state the gate itself lets through,
   * including an UNREADABLE side — a missing value is not evidence of divergence,
   * and the panel's own fence is the judge there (unchanged from #1656).
   */
  private stampTargetVerdict(
    callerTabId: string,
    routedTabId: string,
  ): StampTargetVerdict {
    // A caller addressing the connection by its canonical id reads BOTH answers from
    // the same lookup, so they can only agree — never a disagreement to report.
    if (callerTabId === routedTabId) return { refuses: false, kind: "same_address" };
    const issuedFor = this.resolveTabWorkflowUuid?.(callerTabId);
    const landedOn = this.resolveTabWorkflowUuid?.(routedTabId);
    if (!issuedFor || !landedOn) return { refuses: false, kind: "unreadable" };
    if (issuedFor !== landedOn) return { refuses: true, kind: "disagrees", issuedFor, landedOn };
    if (this.isCarriedTabStamp?.(routedTabId) === true) {
      return { refuses: true, kind: "carried", issuedFor, landedOn };
    }
    return { refuses: false, kind: "agrees", issuedFor, landedOn };
  }

  /**
   * #770/#803 — the same question, TRI-STATE, for anyone who has to REPORT the
   * answer rather than act on it.
   *
   * `tabCanMutateGraph` collapses an unreadable probe into `false`, which is a
   * safe default for gating but a false statement when rendered: it made the
   * recovery tell users their panel "does not advertise the write-boundary
   * fence" when in truth we had merely failed to look. That is the same fold
   * `workflowUuidFor` had, one method over, and it defeated the `unverified`
   * distinction in exactly the production contexts it was added for.
   *
   *  - `{ known: true, canMutate: true }` — observed: this tab can mutate.
   *  - `{ known: true, canMutate: false, because }` — observed that it cannot, and
   *    WHY. The two whys have different remedies, so they must not share a value
   *    (codex gate P1): an old panel needs a pack update and a hard refresh, an
   *    unroutable tab needs neither and cannot do READS either.
   *  - `{ known: false, reason }`   — the probe itself failed; nothing is known.
   */
  tabGraphMutationCapability(
    tabId: string,
  ):
    | { known: true; canMutate: true }
    | {
        known: true;
        canMutate: false;
        because:
          | "unroutable"
          | "disconnected"
          | "no_identity"
          | "capability"
          | "target_disagreement";
      }
    | { known: false; reason: string } {
    let conn: Conn;
    try {
      conn = this.resolveTarget(tabId);
    } catch {
      // Cannot route to the tab at all. That IS an observation about mutability —
      // an unroutable tab mutates nothing — so it is `known`, not unknown.
      //
      // It is NOT the same observation as "this panel build lacks the write
      // fence", and sharing one value with that case sent users to a remedy for a
      // problem they did not have — update the pack, hard-refresh — while the tab
      // was simply gone and their reads were failing too.
      return { known: true, canMutate: false, because: "unroutable" };
    }
    try {
      const stamp = this.resolveTabWorkflowUuid?.(tabId);
      // `canMutate` is a conjunction of four unrelated conditions, and folding
      // all four into "capability" sent three of them to the one remedy that
      // cannot help (codex gate). Each is reported as itself, most transient
      // first — a closing socket is not an old panel, and a modern panel with no
      // trusted stamp is a BINDING problem that reads survive and a rebind fixes.
      if (conn.sock.readyState !== WebSocket.OPEN) {
        return { known: true, canMutate: false, because: "disconnected" };
      }
      if (!conn.enforcesWorkflowStamp || !conn.enforcesWorkflowStampAtWrite) {
        // The only genuinely version-shaped cause: this build does not advertise
        // the write-boundary fence, and no retry can add it.
        return { known: true, canMutate: false, because: "capability" };
      }
      if (typeof stamp !== "string" || stamp.length === 0) {
        return { known: true, canMutate: false, because: "no_identity" };
      }
      // #1494 — LAST, because it presupposes everything above it: a routable, open,
      // fence-advertising tab that DOES have a stamp, whose stamp nevertheless
      // disagrees with what the routed tab last advertised. `send()` refuses every
      // fenced command in that state, so answering `canMutate:true` here made the
      // rebind recovery report a working binding while nothing could be dispatched.
      // Reported as its own cause, never folded into `no_identity`: there IS an
      // identity, and the remedy is the opposite one (prove an identity for the
      // ROUTED tab, rather than acquire one for the session).
      const verdict = this.stampTargetVerdict(tabId, conn.tabId);
      if (verdict.refuses) {
        return { known: true, canMutate: false, because: "target_disagreement" };
      }
      return { known: true, canMutate: true };
    } catch (err) {
      // The stamp resolver threw: the capability inputs could not be read, so the
      // answer is unknown — NOT "the panel lacks the capability".
      return {
        known: false,
        reason: err instanceof Error ? err.message : String(err ?? "unknown error"),
      };
    }
  }

  /**
   * Monotonic registration generation for a currently OPEN panel connection.
   * Restart readiness snapshots this immediately before dispatch, then requires
   * a strictly newer hello before saying graph tools are back. Unknown, migrated
   * aliases that no longer resolve, and closing sockets deliberately return
   * undefined: none proves a usable post-restart panel binding.
   */
  tabConnectionGeneration(tabId: string): number | undefined {
    try {
      const conn = this.resolveTarget(tabId);
      return conn.sock.readyState === WebSocket.OPEN ? conn.helloGeneration : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Restart-readiness binding for a live panel. A generation alone is not
   * sufficient: another browser tab can open the same saved workflow and take
   * over its recurring `tabId`. The tuple proves a newer hello from the SAME
   * browser-tab session that received the restart dispatch. Old panels which do
   * not advertise `tab_session_id` deliberately return undefined rather than
   * fabricating graph-tool readiness.
   */
  tabConnectionIdentity(tabId: string): { generation: number; tabSessionId: string } | undefined {
    try {
      const conn = this.resolveTarget(tabId);
      if (conn.sock.readyState !== WebSocket.OPEN || !conn.tabSessionId) return undefined;
      return { generation: conn.helloGeneration, tabSessionId: conn.tabSessionId };
    } catch {
      return undefined;
    }
  }

  /** Whether THIS connected panel enforces graph_set_widget's optional
   * expected promoted owner/workflow witness at the actual mutation boundary
   * (#2314). */
  tabExpectedScopeFenceCapability(tabId: string): boolean {
    try {
      return this.resolveTarget(tabId).enforcesExpectedScopeAtWrite === true;
    } catch {
      return false;
    }
  }

  /** Whether THIS connected panel also enforces the stable graph identity in
   * an expected promoted scope at the actual mutation boundary (#2314 P1). */
  tabExpectedScopeGraphIdentityFenceCapability(tabId: string): boolean {
    try {
      return this.resolveTarget(tabId).enforcesExpectedScopeGraphIdentityAtWrite === true;
    } catch {
      return false;
    }
  }

  /** Return the latest structured current-view owner observed for this tab.
   * Reads which carry no `viewing` field do not overwrite it; a malformed
   * structured identity is retained as unknown so a promoted write cannot use
   * an earlier owner proof after the current-view witness became unreadable.
   *
   * Look up through {@link resolveTarget} (exact id, prefix, same-socket
   * migration alias, or scope address), not `Map.get(tabId)`. `notePromotedScope`
   * stores under the canonical live tab id from send(); panel sessions bind
   * `ctx.tabId` to `orchestrator::<backend>` (#884). A direct get on that
   * address never hits the cache, so a hello-cleared then re-queried witness
   * still read as unknown and `panel_set_widget` refused a promoted write
   * after a confirmed current-workflow rebind (#2435, panel#1925). */
  promotedScopeFor(tabId: string): TabPromotedScopeRead {
    const unknown: TabPromotedScopeRead = {
      known: false,
      reason: "no current panel graph-scope witness has been observed",
    };
    let key = tabId;
    try {
      key = this.resolveTarget(tabId).tabId;
    } catch {
      return unknown;
    }
    return this.promotedScopes.get(key) ?? unknown;
  }

  /** Overwrite a stale subgraph witness with a live root viewing. */
  applyLiveRootViewing(tabId: string, viewing: unknown): void {
    const parsed = this.parsePromotedScopeResult({ viewing });
    if (!parsed || parsed.known !== true || parsed.scope !== "root") return;
    let key = tabId;
    try {
      key = this.resolveTarget(tabId).tabId;
    } catch {
      key = tabId;
    }
    this.promotedScopes.set(key, parsed);
  }

  /** Drop a cached subgraph/promoted current-view identity after a root read
   * or a successful mode:current rebind. */
  clearPromotedSubgraphIdentity(tabId: string): void {
    let key = tabId;
    try {
      key = this.resolveTarget(tabId).tabId;
    } catch {
      key = tabId;
    }
    const current = this.promotedScopes.get(key);
    if (current?.known === true && current.scope === "subgraph") {
      this.promotedScopes.delete(key);
    }
  }

  /** Read the current panel view from the live graph immediately before a
   *  promoted write. `promotedScopeFor` is intentionally only a cached witness
   *  for synchronous dispatch fences; this method performs the authoritative
   *  current-view probe and never treats that cache as a substitute. */
  async readPromotedScope(tabId: string, innerNodeId: number | string): Promise<TabPromotedScopeRead> {
    try {
      const result = await this.send(
        {
          cmd: "graph_query",
          ids: [innerNodeId],
          fields: "compact",
          limit: 1,
        },
        { tabId },
      );
      return (
        this.parsePromotedScopeResult(result) ?? {
          known: false,
          reason: "the panel current-view query returned no structured scope identity",
        }
      );
    } catch (err) {
      return {
        known: false,
        reason: err instanceof Error ? err.message : String(err ?? "unknown error"),
      };
    }
  }

  /** #884 P0 — inject the orchestrator's turn-target pin (see the field doc and
   *  resolveTarget's scope branch). */
  setScopeTargetResolver(fn: (scopeId: string) => string | null | undefined): void {
    this.scopeTargetResolver = fn;
  }

  /** #884 — inject the explicit-repin recovery handler (see the field doc). */
  setScopeRepinHandler(
    fn: (
      scopeId: string,
      preferredWorkflowPath?: string,
      request?: ScopeRepinRequest,
    ) => ScopeRepinOutcome,
  ): void {
    this.scopeRepinHandler = fn;
  }

  /** #884 — EXPLICIT recovery consent (panel_set_workflow_target
   *  mode:"current" on a scope-bound session): re-pin the conversation's
   *  in-flight turn onto the tab that is active now, escaping a dead or
   *  ambiguous pin. Returns the repinned tab id, or — when nothing was
   *  repinned — WHY (#1077 Finding 2). A bare undefined was indistinguishable
   *  across four different refusals, and a session wedged on any of them was
   *  told only that the adoption was refused. */
  repinScopeToActive(scopeId: string): ScopeRepinOutcome {
    return this.scopeRepinHandler?.(scopeId);
  }

  /**
   * #888 — the same EXPLICIT recovery, aimed at a NAMED workflow's tab instead
   * of "the active one".
   *
   * Same handler, so the P0 gate is shared by construction: a pin that still
   * reaches a live tab of this conversation is never displaced onto a
   * background tab, however explicit the request. What a NAME adds is recovery
   * in the state where "current" is legitimately refused — several eligible
   * tabs and no active one among them — which is precisely the state that
   * refusal already tells the agent to escape by naming a workflow.
   *
   * #2531 — `alignLiveCanvas` is extra consent from a successful
   * panel_open_workflow / verified-active pin: rewrite lastOrigin onto THIS
   * canvas's live id rather than reporting pin success while the next
   * origin-less turn still inherits the pre-switch workflow.
   */
  repinScopeToWorkflow(
    scopeId: string,
    workflowPath: string,
    request?: ScopeRepinRequest,
  ): ScopeRepinOutcome {
    return this.scopeRepinHandler?.(scopeId, workflowPath, request);
  }

  /**
   * panel#1292 — mark that this scope's turn pin is being recovered. `send()`
   * waits for {@link endScopeRecovery} before minting the mixed-origin refusal
   * so a same-batch sibling can ride the bind rather than lose the race.
   */
  beginScopeRecovery(scopeId: string): void {
    const rec = this.scopeRecovery.get(scopeId);
    if (rec) {
      rec.count += 1;
      return;
    }
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.scopeRecovery.set(scopeId, { count: 1, done, finish });
  }

  /** panel#1292 — the matching close for {@link beginScopeRecovery}. */
  endScopeRecovery(scopeId: string): void {
    const rec = this.scopeRecovery.get(scopeId);
    if (!rec) return;
    rec.count -= 1;
    if (rec.count > 0) return;
    rec.finish();
    this.scopeRecovery.delete(scopeId);
  }

  /** panel#1557 — keep a deferred mode:"current" recovery across MCP sessions. */
  armScopeRecoveryConsent(scopeId: string): void {
    this.pendingScopeRecoveryConsent.add(scopeId);
  }

  hasScopeRecoveryConsent(scopeId: string): boolean {
    return this.pendingScopeRecoveryConsent.has(scopeId);
  }

  clearScopeRecoveryConsent(scopeId: string): void {
    this.pendingScopeRecoveryConsent.delete(scopeId);
  }

  /**
   * Wait for an in-flight scope recovery, or (if none is registered yet) yield
   * once so a same-tick bind can register. Always returns: the caller retries
   * `resolveTarget` and throws the original refusal if the pin is still null.
   */
  private awaitScopePinRecovery(scopeId: string): Promise<void> {
    const rec = this.scopeRecovery.get(scopeId);
    if (rec) return rec.done;
    return Promise.resolve().then(() => {
      const rec2 = this.scopeRecovery.get(scopeId);
      if (rec2) return rec2.done;
      return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
        const rec3 = this.scopeRecovery.get(scopeId);
        if (rec3) return rec3.done;
      });
    });
  }

  /** #884 — inject the hello-backend normalizer (see the field doc). */
  setHelloBackendNormalizer(fn: (raw: unknown) => string): void {
    this.helloBackendNormalizer = fn;
  }

  /** #884 — the real tab id a SCOPE ADDRESS currently resolves to (the pinned
   *  in-flight-turn tab when one is set, else the active tab: last user
   *  activity, else most recent interactive connect), or undefined when it
   *  cannot resolve (no tab connected / pin gone / ambiguous). Never throws.
   *  Pass the caller's own (possibly backend-qualified) scope address so the
   *  pin of the RIGHT conversation is consulted; defaults to the bare scope. */
  resolveSharedTabId(scopeId: string = SHARED_SESSION_SCOPE): string | undefined {
    try {
      return this.resolveTarget(scopeId).tabId;
    } catch {
      return undefined;
    }
  }

  /** #884 — is this tab's live socket currently ATTACHED as a mirror viewer
   *  (driving a desktop tab)? Such a client already receives the conversation
   *  through the mirror fan-out of its driven tab, so the orchestrator's
   *  conversation fanout must not ALSO deliver to its own tab id — that
   *  double-delivers every say/stream/turn frame to the phone (codex round 2).
   *  Unknown/disconnected tabs → false. */
  isAttachedViewerTab(tabId: string): boolean {
    const conn = this.conns.get(tabId);
    return !!conn && this.mirrorViewers.has(conn.sock);
  }

  /** The id of the tab a NO-tabId command would target right now: the sole
   *  connection, else the last active tab. Throws the SAME clear errors as the
   *  no-tabId `send` path when it can't pick a single one (none connected, or
   *  2+ with no last-active). This is the EXPLICIT resolution the orchestrator
   *  invokes at a user/agent-initiated rebind moment — it deliberately does NOT
   *  weaken `resolveTarget`, so multi-tab routing stays conservative. */
  resolveActiveTabId(): string {
    return this.resolveTarget().tabId;
  }

  /** The ComfyUI origin the given tab's browser was served from (`comfyui_url` in
   *  its `hello`), or undefined if the tab never advertised one / is unknown. Lets a
   *  tool HTTP-probe the EXACT instance THIS tab fronts rather than the process-
   *  global target a different instance may have retargeted (#509). Resolves the id
   *  through the SAME prefix + migration-alias path as command routing (resolveTarget)
   *  so a migrated session still finds its origin; never throws. */
  tabOrigin(tabId: string): string | undefined {
    try {
      return this.resolveTarget(tabId).originUrl;
    } catch {
      return undefined;
    }
  }

  /** SERVER-OBSERVED, syntactically validated origin (scheme://host:port) of the given
   *  tab's WebSocket handshake. Unlike {@link tabOrigin}, it is independent of the
   *  hello claim, but it is not authentication on a tokenless listener: a local
   *  non-browser client can forge the HTTP header. Undefined when unusable. Resolves
   *  migration aliases like tabOrigin; never throws. */
  tabServerOrigin(tabId: string): string | undefined {
    try {
      return this.resolveTarget(tabId).serverOrigin;
    } catch {
      return undefined;
    }
  }

  /**
   * The panel language to render a HUMAN-facing frame in for `tabId` — English when the
   * tab never advertised one, advertised one we do not ship, or is not connected.
   *
   * Resolved through the SAME path as `push` (exact id → prefix → same-socket migration
   * alias → scope address), so the language is the language of the tab that will actually
   * RECEIVE the frame, not of whatever id the caller happened to hold. A `say` naming
   * "Settings → OpenRouter" is useless in a language the panel around it is not in.
   *
   * NEVER THROWS, and that is the load-bearing part: these strings are emitted while
   * reporting OTHER failures — a start failure, a lost render completion, a panel sync that
   * did not happen — so a locale lookup that could throw would turn a report of one failure
   * into two. English is always an acceptable answer; an exception never is.
   */
  tabLocale(tabId: string): Locale {
    try {
      return this.resolveTarget(tabId).locale ?? "en";
    } catch {
      return "en";
    }
  }

  /** #952 — the DISTINCT ComfyUI origins the connected tabs actually front, for
   *  the headless-fetch drift comparison (see comfyui/fetch.ts). Trusted
   *  handshake Origins only, so a tab that supplied none is simply absent rather
   *  than guessed at: an incomplete list must never be read as "no drift". Order
   *  follows connection order; never throws. */
  connectedServerOrigins(): string[] {
    const out: string[] = [];
    for (const conn of this.conns.values()) {
      const origin = conn.serverOrigin;
      if (typeof origin === "string" && origin !== "" && !out.includes(origin)) out.push(origin);
    }
    return out;
  }

  /** Fence a same-socket migration alias (#570 P0a): drop the `fromId → to` route and
   *  every other entry that points at the SAME target (fromId's path-compressed chain),
   *  so a RETIRED workflow's stale / in-flight panel_* calls addressed to fromId can no
   *  longer resolve THROUGH the alias onto the newly-selected workflow's canvas. Called
   *  when a same-socket re-hello is NOT a proven same-workflow continuation (a workflow
   *  SWITCH). The new tab routes directly via its own live connection, so fencing the old
   *  routes never affects it; a stale call to fromId simply fails to resolve (and its
   *  now-stopped agent ignores the error) instead of mutating the wrong graph. */
  revokeTabMigration(fromId: string): void {
    const target = this.tabMigrations.get(fromId)?.to;
    this.tabMigrations.delete(fromId);
    if (target) {
      for (const [from, entry] of this.tabMigrations) {
        if (entry.to === target) this.tabMigrations.delete(from);
      }
    }
    // #570 P0a — this migration was just REJECTED as a switch to a DIFFERENT workflow, so
    // UNDO the optimistic mirror move: detach exactly the viewers/subscribers we moved onto
    // the destination (never the destination's OWN viewers). Detached viewers revert to their
    // own session; their input stops driving the destination. This runs UNCONDITIONALLY on the
    // revoke — it does NOT depend on the destination having (or lacking) its own bound session,
    // which is the gap that let a mirror follow A→B when B already owned an exact session.
    const moved = this.migratedMirror.get(fromId);
    if (moved) {
      this.migratedMirror.delete(fromId);
      const destSubs = this.subscribers.get(moved.to);
      if (destSubs) {
        for (const s of moved.subs) destSubs.delete(s);
        if (destSubs.size === 0) this.subscribers.delete(moved.to);
      }
      for (const s of moved.viewers) {
        // Only revert a viewer we moved that is STILL pointed at this destination (it may have
        // since re-attached elsewhere, which we must not clobber).
        if (this.mirrorViewers.get(s) === moved.to) this.mirrorViewers.delete(s);
      }
      // #568 — undo the optimistic last-active carry too. This re-hello turned out to be a
      // switch to a DIFFERENT workflow, so the destination is NOT the successor of the tab
      // the selection named. Do NOT hand it back to fromId either: that id is retired. UNKNOWN
      // gets its OWN representation (null) rather than being folded into either answer, so
      // resolveTarget() refuses with "none is last active — pass tab_id" and an orphaned
      // session's explicit rebind FAILS instead of silently retargeting onto a DIFFERENT
      // workflow's canvas. Undo ONLY the exact write we made: a user_message from the
      // destination since then is a fresh, genuine selection (same value, newer seq) and stands.
      if (moved.lastActiveSeq !== null && this.lastActiveSeq === moved.lastActiveSeq) {
        this.setLastActiveTab(null);
      }
    }
  }

  /** True when this tab's socket arrived on the token-less loopback primary
   *  listener. This reports local transport placement only; it is not browser
   *  provenance and must not authorize a new outbound request. Relay/tunnel/
   *  LAN/pairing tabs → false. Resolves migration aliases like tabOrigin;
   *  unknown → false. */
  tabIsLocal(tabId: string): boolean {
    try {
      return this.resolveTarget(tabId).local === true;
    } catch {
      return false;
    }
  }

  /** True when the tab advertised itself as a canvas-less (mobile/remote) client
   *  in its `hello`. Unknown tabs → false. */
  /**
   * #875 — is any CURRENTLY-CONNECTED client headless (a paired phone / mirror)?
   *
   * Deliberately NOT `isHeadless()`, which is STICKY by design: a tab that ever
   * connected headless stays "headless" while offline so a render finishing
   * during a disconnect is byte-inlined for the mailbox. That is right for
   * rendering decisions and wrong for a LIVENESS gate — using it would report a
   * phone that paired once and left as still connected, and the self-restarter
   * would defer updates forever.
   */
  hasLiveHeadlessClient(): boolean {
    for (const c of this.conns.values()) if (c.headless === true) return true;
    // #1176 — A BACKGROUNDED PHONE IS NOT A DEPARTED PHONE.
    //
    // `conns` holds currently-OPEN sockets. A phone at work with its screen off
    // has had its WebSocket suspended or closed by the mobile OS, so the loop
    // above answers false and the restart gate opens — and the restart mints a
    // NEW cloudflared hostname. A reporter picked their phone up to:
    //
    //   Failed host lookup: 'cameron-timing-face-spies.trycloudflare.com'
    //   (No address associated with hostname, errno = 7)
    //
    // Not a timeout and not a refusal: the hostname no longer existed.
    //
    // The sticky `isHeadless()` was rejected for this gate, correctly — a phone
    // that paired once and left would defer updates forever. But "socket open
    // right now" and "ever paired" are not the only options, and the state
    // between them is not an edge case: a phone in a pocket is the EXPECTED
    // condition for someone who paired it to use at work.
    //
    // So: a bounded recency window. It keeps the property that killed the sticky
    // option — a phone that genuinely left stops deferring, on its own, without
    // anyone unpairing anything — while covering the normal mobile case.
    return this.recentHeadlessWithin(HEADLESS_RECENCY_MS);
  }

  /** Was a headless client connected within `ms`? (#1176) Reads the disconnect
   *  clock, so it answers true for a phone whose socket the OS suspended and
   *  false for one that has genuinely been gone longer than the window. */
  private recentHeadlessWithin(ms: number): boolean {
    if (this.lastHeadlessDisconnectAt === undefined) return false;
    return performance.now() - this.lastHeadlessDisconnectAt < ms;
  }

  /**
   * When a headless client last held an open socket (#1176), on the MONOTONIC
   * clock — `performance.now()`, not `Date.now()`.
   *
   * This measures ELAPSED TIME, and the wall clock is not a measure of elapsed
   * time: an NTP correction can move it. On Windows a step of more than the
   * window would make a phone that disconnected seconds ago look long gone, and
   * the restart would rotate the tunnel hostname — the exact bug this window
   * exists to prevent, reintroduced by the clock rather than by the logic. A
   * backward step would defer far longer than intended. (codex review, PR #1185)
   *
   * `performance.now()` is monotonic from process start, which is the right
   * lifetime here: the value is only ever compared against another reading from
   * the same process, and a restart clears it — after which there is no phone
   * this process has seen, which is the correct answer anyway.
   *
   * Undefined until a headless client actually disconnects, so an install that
   * has never seen a phone can never defer.
   */
  private lastHeadlessDisconnectAt: number | undefined;
  /** Kind of the most recently departed PRIMARY tab (`true` headless, `false`
   *  canvas). #2013 uses this when a scope-keyed mailbox is stored with ZERO
   *  live tabs — the last client to leave is who the conversation was talking
   *  to, and the flush declines a hello of the other kind. Undefined until a
   *  primary has actually disconnected this process. */
  private lastDisconnectedHeadless: boolean | undefined;

  /** Test seam: place the recency clock in the past without sleeping. Takes a
   *  `performance.now()`-based reading, matching the field. */
  markHeadlessDisconnectForTests(at: number): void {
    this.lastHeadlessDisconnectAt = at;
  }

  isHeadless(tabId: string): boolean {
    // Sticky: a tab that EVER connected headless stays "headless" even while
    // offline, so a render finishing during a disconnect is byte-inlined (not a
    // bytes-less viewRef) and is renderable when the mailbox flushes to the phone.
    return this.conns.get(tabId)?.headless === true || this.headlessSeen.has(tabId);
  }

  /**
   * The current live socket's first-hello-pinned kind. Unlike isHeadless(), this
   * deliberately does not consult disconnected history: unattended operations
   * such as panel auto-sync must act on the tab that is connected NOW.
   */
  isCurrentHeadless(tabId: string): boolean {
    return this.conns.get(tabId)?.headless === true;
  }

  /** Drop expired late-ask entries (buffered answers + unresolved rid mappings) so
   *  an abandoned card never leaks memory. Cheap; called on each ask send/take. */
  /**
   * A reply landed for an rid nothing is waiting on. If it is the late
   * completion of a mutation we abandoned, keep it (#694).
   *
   * SUCCESS ONLY, and that asymmetry is the point. A late `ok:false` says the
   * write was refused -- which is not news: the caller was already told it did
   * not complete, and they were told truthfully. Promoting it to "it failed"
   * would convert "we never found out" into a verdict we did not earn, the same
   * fold as #796 pointing the other way. Only `ok:true` carries information the
   * caller does not already have.
   */
  private recordLateMutation(rid: string, msg: { ok?: unknown; result?: unknown }): void {
    const started = this.deliveredMutations.get(rid);
    if (!started) return;
    this.deliveredMutations.delete(rid);
    if (msg.ok !== true) {
      this.notifyMutationSettled(started.tabId);
      return;
    }
    const now = Date.now();
    this.pruneLateMutations();
    this.lateMutations.set(rid, {
      ok: true,
      cmd: started.cmd,
      tabId: started.tabId,
      ts: now,
      lateByMs: now - started.ts,
      frame: started.frame,
      ...retainableLateResult(msg.result),
    });
    logger.debug(
      `[ui-bridge] "${started.cmd}" on tab ${started.tabId} completed ${now - started.ts} ms AFTER its reply timeout — retained for the caller (#694)`,
    );
    this.notifyMutationSettled(started.tabId);
  }

  /**
   * Drain the late outcome for `rid`, if the write landed after its timeout.
   *
   * Drains once: this exists so a caller can be TOLD, and telling them twice
   * would read as two separate recoveries of the same write.
   */
  takeLateMutation(rid: string): LateMutation | undefined {
    this.pruneLateMutations();
    const hit = this.lateMutations.get(rid);
    if (!hit) return undefined;
    this.lateMutations.delete(rid);
    return {
      ok: true,
      cmd: hit.cmd,
      tabId: hit.tabId,
      lateByMs: hit.lateByMs,
      ...("result" in hit ? { result: hit.result } : {}),
    };
  }

  /**
   * Look at the late outcome for `rid` WITHOUT draining it (#1175).
   *
   * takeLateMutation drains, deliberately, so a caller is told once. That makes
   * it the wrong instrument for a caller that has to DECIDE whether this entry is
   * the one it can use: panel_run can only rebuild a run from a retained
   * `graph_run` BODY, and a take that then walked away would have consumed the
   * retry-token notice -- the recovery the caller still had -- to answer a
   * question. Peek first, take only what will be used.
   */
  peekLateMutation(rid: string): LateMutation | undefined {
    this.pruneLateMutations();
    const hit = this.lateMutations.get(rid);
    if (!hit) return undefined;
    return {
      ok: true,
      cmd: hit.cmd,
      tabId: hit.tabId,
      lateByMs: hit.lateByMs,
      ...("result" in hit ? { result: hit.result } : {}),
    };
  }

  /**
   * Outcome-unknown (timed-out, not yet settled) mutations on `tabId` (#2527).
   * Graph reads wait on these, or disclose them when the frontend has not
   * acknowledged yet.
   */
  listOutstandingMutations(tabId: string): DeliveredMutationReceipt[] {
    this.pruneLateMutations();
    const out: DeliveredMutationReceipt[] = [];
    for (const [rid, e] of this.deliveredMutations) {
      if (e.tabId !== tabId || e.status !== "timed_out") continue;
      out.push({ rid, cmd: e.cmd, tabId: e.tabId, ts: e.ts, frame: e.frame, status: e.status });
    }
    return out;
  }

  /** Look up a delivered mutation by rid without draining a late completion. */
  peekDeliveredMutation(rid: string): PeekedDeliveredMutation | undefined {
    this.pruneLateMutations();
    const settled = this.lateMutations.get(rid);
    if (settled) {
      return {
        rid,
        cmd: settled.cmd,
        tabId: settled.tabId,
        frame: settled.frame,
        status: "settled",
      };
    }
    const live = this.deliveredMutations.get(rid);
    if (!live) return undefined;
    return { rid, cmd: live.cmd, tabId: live.tabId, frame: live.frame, status: live.status };
  }

  /**
   * Wait until every timed-out mutation on `tabId` has a frontend settlement,
   * or `budgetMs` elapses (#2527). Resolves without throwing.
   */
  waitForOutstandingMutations(tabId: string, budgetMs: number): Promise<void> {
    this.pruneLateMutations();
    if (this.listOutstandingMutations(tabId).length === 0) return Promise.resolve();
    const budget = Number.isFinite(budgetMs) ? Math.max(0, Math.floor(budgetMs)) : 0;
    if (budget <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.mutationSettleWaiters = this.mutationSettleWaiters.filter((w) => w !== waiter);
        resolve();
      };
      const waiter = { tabId, finish };
      const timer = setTimeout(finish, budget);
      this.mutationSettleWaiters.push(waiter);
      if (this.listOutstandingMutations(tabId).length === 0) finish();
    });
  }

  private outstandingTimedOutCount(tabId: string): number {
    let n = 0;
    for (const e of this.deliveredMutations.values()) {
      if (e.tabId === tabId && e.status === "timed_out") n += 1;
    }
    return n;
  }

  private notifyMutationSettled(tabId: string): void {
    if (this.mutationSettleWaiters.length === 0) return;
    if (this.outstandingTimedOutCount(tabId) > 0) return;
    const waiters = this.mutationSettleWaiters.filter((w) => w.tabId === tabId);
    if (waiters.length === 0) return;
    this.mutationSettleWaiters = this.mutationSettleWaiters.filter((w) => w.tabId !== tabId);
    for (const waiter of waiters) waiter.finish();
  }

  /** Record one exact prompt id from the Panel's late graph_run capture. */
  private recordLateRunReceipt(msg: Record<string, unknown>, tabId: string | null): void {
    const runRid = typeof msg.run_rid === "string" ? msg.run_rid.trim() : "";
    const promptId = typeof msg.prompt_id === "string" ? msg.prompt_id.trim() : "";
    const completionKey =
      typeof msg.completion_key === "string" && msg.completion_key.length > 0 && msg.completion_key.length <= 512
        ? msg.completion_key
        : "";
    if (!runRid || !promptId || !tabId) return;
    this.pruneLateMutations();
    const prior = this.lateRunReceipts.get(runRid);
    if (prior && prior.tabId !== tabId) return;
    const handoff = this.lateRunReceiptHandoffs.get(runRid);
    const promptIds = prior?.promptIds ?? [];
    const completionKeys = prior?.completionKeys ?? new Map<string, string>();
    const isNewPromptId = !promptIds.includes(promptId);
    if (
      handoff &&
      handoff.expiresAt > Date.now() &&
      handoff.tabId === tabId &&
      handoff.deliveredPromptIds.has(promptId)
    ) {
      // The owner already consumed this stable prompt identity. Do not even
      // re-buffer the at-least-once duplicate behind the TTL map.
      return;
    }
    if (isNewPromptId) {
      // A Panel batch is bounded by the same map cardinality as other late
      // receipts; never let a forged control frame create an unbounded list.
      if (promptIds.length >= UiBridge.MAX_LATE_MUTATIONS) return;
      promptIds.push(promptId);
    }
    if (completionKey) completionKeys.set(promptId, completionKey);
    this.lateRunReceipts.set(runRid, { tabId, promptIds, completionKeys, ts: prior?.ts ?? Date.now() });
    if (
      handoff &&
      handoff.expiresAt > Date.now() &&
      handoff.tabId === tabId &&
      !handoff.deliveredPromptIds.has(promptId)
    ) {
      const receipt = this.peekLateRunReceipt(runRid);
      if (receipt) {
        try {
          handoff.onReceipt(receipt);
          for (const deliveredId of receipt.promptIds) {
            if (typeof deliveredId === "string" && deliveredId.trim() !== "") {
              handoff.deliveredPromptIds.add(deliveredId.trim());
            }
          }
        } catch {
          // A receipt must remain buffered if its late consumer is transiently
          // unavailable; the owner can still drain it explicitly.
        }
      }
    }
  }

  /**
   * Keep an exact run receipt actionable after panel_run's bounded reconcile
   * window. Registration also drains an already-buffered receipt, which closes
   * the race between the normal ticket pass and this late owner.
   */
  registerLateRunReceiptHandoff(
    runRid: string,
    tabId: string,
    onReceipt: LateRunReceiptHandoff,
    ttlMs = UiBridge.LATE_RUN_RECEIPT_HANDOFF_TTL_MS,
  ): () => void {
    const rid = typeof runRid === "string" ? runRid.trim() : "";
    const tab = typeof tabId === "string" ? tabId.trim() : "";
    if (!rid || !tab || typeof onReceipt !== "function") return () => {};
    this.pruneLateMutations();
    const entry = {
      tabId: tab,
      expiresAt: Date.now() + Math.max(1, ttlMs),
      onReceipt,
      deliveredPromptIds: new Set<string>(),
    };
    this.lateRunReceiptHandoffs.set(rid, entry);
    const current = this.peekLateRunReceipt(rid);
    if (current && current.tabId === tab) {
      try {
        onReceipt(current);
        for (const promptId of current.promptIds) {
          if (typeof promptId === "string" && promptId.trim() !== "") {
            entry.deliveredPromptIds.add(promptId.trim());
          }
        }
      } catch {
        // Keep the map entry for a later frame/explicit drain.
      }
    }
    return () => {
      if (this.lateRunReceiptHandoffs.get(rid) === entry) this.lateRunReceiptHandoffs.delete(rid);
    };
  }

  /** Drain a Panel late prompt receipt once, after panel_run consumes it. */
  takeLateRunReceipt(runRid: string): LateRunReceipt | undefined {
    this.pruneLateMutations();
    const hit = this.lateRunReceipts.get(runRid);
    if (!hit) return undefined;
    this.lateRunReceipts.delete(runRid);
    return {
      runRid,
      tabId: hit.tabId,
      promptIds: [...hit.promptIds],
      completionKeys: [...hit.completionKeys.entries()].map(([promptId, completionKey]) => ({ promptId, completionKey })),
      lateByMs: Math.max(0, Date.now() - hit.ts),
    };
  }

  /** Peek without draining so panel_run only consumes a receipt it can use. */
  peekLateRunReceipt(runRid: string): LateRunReceipt | undefined {
    this.pruneLateMutations();
    const hit = this.lateRunReceipts.get(runRid);
    if (!hit) return undefined;
    return {
      runRid,
      tabId: hit.tabId,
      promptIds: [...hit.promptIds],
      completionKeys: [...hit.completionKeys.entries()].map(([promptId, completionKey]) => ({ promptId, completionKey })),
      lateByMs: Math.max(0, Date.now() - hit.ts),
    };
  }

  /** TTL + cardinality bound for both #694 maps. */
  private pruneLateMutations(): void {
    const now = Date.now();
    const prunedTabs = new Set<string>();
    for (const [rid, e] of this.deliveredMutations) {
      if (now - e.ts > UiBridge.LATE_MUTATION_TTL_MS) {
        this.deliveredMutations.delete(rid);
        prunedTabs.add(e.tabId);
      }
    }
    for (const [rid, e] of this.lateMutations) {
      if (now - e.ts > UiBridge.LATE_MUTATION_TTL_MS) this.lateMutations.delete(rid);
    }
    for (const [rid, e] of this.lateRunReceipts) {
      if (now - e.ts > UiBridge.LATE_MUTATION_TTL_MS) this.lateRunReceipts.delete(rid);
    }
    for (const [rid, e] of this.lateRunReceiptHandoffs) {
      if (e.expiresAt <= now) this.lateRunReceiptHandoffs.delete(rid);
    }
    // Map iteration is insertion-ordered, so dropping from the front drops the
    // oldest. Quiet, unlike the ask-mapping overflow: losing one of 256 late
    // completions costs the caller a notice they can still get by looking, where
    // losing an ask mapping loses a user's answer outright.
    for (const map of [this.deliveredMutations, this.lateMutations, this.lateRunReceipts, this.lateRunReceiptHandoffs]) {
      while (map.size > UiBridge.MAX_LATE_MUTATIONS) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        const dropped = map.get(oldest.value);
        if (dropped && "tabId" in dropped && typeof dropped.tabId === "string") {
          prunedTabs.add(dropped.tabId);
        }
        map.delete(oldest.value);
      }
    }
    for (const tabId of prunedTabs) this.notifyMutationSettled(tabId);
  }

  private pruneLateAsk(): void {
    const now = Date.now();
    for (const [id, e] of this.lateAskReplies) {
      if (now - e.ts > UiBridge.LATE_ASK_TTL_MS) this.lateAskReplies.delete(id);
    }
    // NOTE: rid→ask_id mappings are deliberately NOT TTL-pruned — see
    // MAX_ASK_RID_MAPPINGS. A card can be answered arbitrarily late, and this
    // mapping is the only thing that makes such an answer recognisable.
    //
    // The cardinality cap is the sole bound: drop the oldest-inserted mappings so
    // the map can never grow without limit. LOUD, because past this point a late
    // answer for that card can no longer be recognised — a real (if wildly
    // unlikely) degradation, not routine housekeeping.
    if (this.askRidToId.size > UiBridge.MAX_ASK_RID_MAPPINGS) {
      const excess = this.askRidToId.size - UiBridge.MAX_ASK_RID_MAPPINGS;
      logger.error(
        `[ui-bridge] over ${UiBridge.MAX_ASK_RID_MAPPINGS} question cards are open at once — forgetting the ${excess} oldest; a late answer for those can no longer be delivered`,
      );
      let i = 0;
      const orphanedTabs = new Set<string>();
      for (const [rid, e] of this.askRidToId) {
        if (i++ >= excess) break;
        this.askRidToId.delete(rid);
        orphanedTabs.add(e.tabId);
      }
      // TELL THE USER, on their own screen.
      //
      // Preferring loss over misattribution here is a sound call, but a server
      // log is not a disclosure to the person holding the mouse: without this,
      // the next thing that happens is someone clicking a button on a card that
      // is still sitting there and having it do NOTHING — no answer delivered, no
      // error, no sign anything went wrong. That is the worst possible
      // presentation of a deliberate trade. Say it once per affected tab, at the
      // moment we know, and name what to do instead.
      for (const tabId of orphanedTabs) {
        try {
          this.push(
            {
              type: "say",
              // The ⚠️ stays outside the translated span: it is the status marker the panel's
              // own bubble styling and a skimming eye both key on, and it means the same thing
              // in every language.
              text: `⚠️ ${trFor(
                this.tabLocale(tabId),
                "say.too_many_question_cards",
                "Too many question cards are open at once in this tab, so the oldest ones can no " +
                  "longer accept an answer — clicking them will do nothing. Answer the most recent card, " +
                  "or just type your choice in the chat and the agent will pick it up.",
              )}`,
            },
            tabId,
          );
        } catch {
          // Best-effort: the log above is the durable record.
        }
      }
    }
  }

  /** Retrieve (and remove) a late-but-valid ask_user answer buffered for `askId`
   *  after the card-reply timeout, or undefined if none arrived. The panel_ask
   *  handler polls this for a bounded grace so a slow-but-valid pick is honored
   *  rather than discarded (#486). */
  /** Wire the durable ask-answer journal to late (post-timeout) card answers
   *  (#486). Called once at orchestrator start-up. */
  setLateAskReplySink(sink: (askId: string, result: unknown, tabId: string) => void): void {
    this.lateAskSink = sink;
  }

  /**
   * Declare which commands are worth retaining a late completion for (#694).
   *
   * FAIL CLOSED: with no filter installed nothing is retained, because nothing
   * could drain it either -- the drainer and the filter are the same layer.
   *
   * The bridge cannot answer this itself, and the first attempt at this proved
   * why. It gated on `ctx.mutating`, i.e. `!BRIDGE_READONLY_CMDS.has(cmd)` --
   * the discriminator this very file documents (see BRIDGE_READONLY_CMDS) as
   * misclassifying graph_find_nodes, graph_list_subgraphs, graph_canvas,
   * graph_select_nodes, graph_enter/exit_subgraph and graph_copy_nodes
   * (graph_screenshot was in that list too until panel#2191 admitted it to the
   * set). That is #778, and re-asking it retained seven reads under
   * a comment claiming reads were excluded. The real question is not "does this
   * mutate" but "can this rid ever come back to us as a retry token", which only
   * the retry-token layer knows. So it tells us.
   */
  setLateMutationFilter(fn: ((cmdName: string) => boolean) | null): void {
    this.lateMutationFilter = fn;
  }

  /** Notified when a tab's PRIMARY connection is dropped and it leaves the
   *  connection map (#486). Lets per-tab bookkeeping that can only ever be
   *  delivered to that tab be surfaced and retired, instead of accumulating for
   *  a tab that may never reconnect. */
  /**
   * Notified when a DIFFERENT browser tab takes over a recurring tab key (#486).
   *
   * Distinct from the gone-listener, and deliberately immediate: a disconnect
   * might be a reload, but a takeover is PROOF the previous occupant is done —
   * something else is holding its key right now. Anything keyed by tab id that
   * belongs to the departed occupant's CONVERSATION must be retired here, before
   * the newcomer can reach it.
   */
  setTabTakenOverListener(listener: (tabId: string, departed: string) => void): void {
    this.onTabTakenOver = listener;
  }

  setTabGoneListener(
    listener: (tabId: string, incarnation: string) => void,
    opts: { graceMs?: number } = {},
  ): void {
    this.onTabGone = listener;
    if (typeof opts.graceMs === "number" && opts.graceMs >= 0) this.tabGoneGraceMs = opts.graceMs;
  }

  /**
   * Start the "is this tab actually gone?" clock for the INCARNATION that just
   * left — its browser-tab session id, which is sessionStorage-backed and so
   * survives a reload while being unique per browser tab.
   *
   * `incarnation` undefined means the departing panel never identified itself
   * (an old build). Nothing can then PROVE it came back, so nothing may suppress
   * the signal: it fires at the end of the grace. Unknown-return has to let the
   * disclosure surface — folding "could not tell" into "it's back" is how a
   * warning goes missing.
   */
  private armTabGone(tabId: string, incarnation: string): void {
    if (!this.onTabGone) return;
    // Keyed per INCARNATION, so two browser tabs that share a recurring
    // `wf:` route key each get their own clock. Keyed by tab id alone, the
    // second tab's departure would silently drop the first tab's pending
    // signal and it would never be declarable gone at all.
    const slot = tabIncarnationSlot(tabId, incarnation);
    const prev = this.tabGoneTimers.get(slot);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => this.fireTabGone(slot, tabId, incarnation), this.tabGoneGraceMs);
    // Never hold the process open just to declare a tab gone.
    timer.unref?.();
    this.tabGoneTimers.set(slot, { timer, tabId, incarnation });
  }

  /** The clock elapsed for one (tab, incarnation). Split out so a test can run
   *  it at a chosen moment instead of racing a wall-clock grace. */
  private fireTabGone(slot: string, tabId: string, incarnation: string): void {
    this.tabGoneTimers.delete(slot);
    // Re-check on the INCARNATION, not the key: something else may now hold this
    // recurring id, and a stranger holding the key is not this tab coming back.
    if (this.conns.get(tabId)?.incarnationId === incarnation) return;
    try {
      this.onTabGone?.(tabId, incarnation);
    } catch (err) {
      logger.warn(
        `[ui-bridge] tab-gone listener threw for ${tabId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * TEST ONLY — run every armed gone-clock right now.
   *
   * The clocks are the one part of this file whose behaviour is defined by
   * elapsed time, and a test that races a real grace is worse than no test: too
   * short and it fails on a correct implementation, too long and a timer that
   * fires before the successor's hello lands makes a broken cancel look caught.
   * Widening the window only hides the second direction. So tests wait for the
   * state they care about to be provably reached, then run the clocks here.
   */
  __runTabGoneClocksForTest(): void {
    for (const [slot, armed] of [...this.tabGoneTimers]) {
      clearTimeout(armed.timer);
      this.fireTabGone(slot, armed.tabId, armed.incarnation);
    }
  }

  /**
   * THIS tab is back (or is being torn down deliberately) — it is not gone.
   *
   * Only the SAME incarnation cancels. A different browser tab taking over a
   * recurring `wf:` route key must leave the departed tab's clock running, or
   * the departed tab becomes permanently undeclarable and its disclosure can be
   * settled by a conversation that never owned it. `undefined` cancels
   * unconditionally, for the deliberate teardown path that has no incarnation to
   * name.
   */
  private cancelTabGone(tabId: string, incarnation: string): void {
    // Only the SAME incarnation cancels. An anonymous connection gets a fresh
    // synthetic id, so it can never match a predecessor's slot — an unidentified
    // panel therefore still cannot suppress anyone's owed warning, which is the
    // asymmetry this must preserve.
    const slot = tabIncarnationSlot(tabId, incarnation);
    const armed = this.tabGoneTimers.get(slot);
    if (!armed) return;
    clearTimeout(armed.timer);
    this.tabGoneTimers.delete(slot);
  }

  takeLateAskReply(askId: string): unknown | undefined {
    this.pruneLateAsk();
    const e = this.lateAskReplies.get(askId);
    if (!e) return undefined;
    this.lateAskReplies.delete(askId);
    return e.result;
  }

  /**
   * #2440 — subscribe to a card approval for `askId` so an in-flight confirm can
   * resolve as soon as the click lands, rather than only when a later call drains
   * the late-reply buffer. Returns an unsubscribe function.
   */
  subscribeLateAskReply(askId: string, onReply: (result: unknown) => void): () => void {
    let set = this.lateAskWaiters.get(askId);
    if (!set) {
      set = new Set();
      this.lateAskWaiters.set(askId, set);
    }
    set.add(onReply);
    return () => {
      const live = this.lateAskWaiters.get(askId);
      if (!live) return;
      live.delete(onReply);
      if (live.size === 0) this.lateAskWaiters.delete(askId);
    };
  }

  private wakeLateAskWaiters(askId: string, result: unknown): boolean {
    const waiters = this.lateAskWaiters.get(askId);
    if (!waiters || waiters.size === 0) return false;
    this.lateAskWaiters.delete(askId);
    for (const onReply of waiters) {
      try {
        onReply(result);
      } catch (err) {
        logger.warn(
          `[ui-bridge] late-ask waiter threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return true;
  }

  private findPendingForAskId(askId: string): { rid: string; pending: Pending } | undefined {
    for (const [rid, pending] of this.pending) {
      if (commandAskId(pending.ctx.command) === askId) return { rid, pending };
      const mapped = this.askRidToId.get(rid);
      if (mapped?.askId === askId) return { rid, pending };
    }
    return undefined;
  }

  private settlePendingAskSuccess(
    rid: string,
    pending: Pending,
    result: unknown,
    sock: BridgeSocket,
  ): void {
    this.settlePendingReply(rid, pending, { ok: true, result }, sock);
  }

  /**
   * #2559 — oldest in-flight graph_set_widget on this socket, used when a
   * mutation ACK misses its rid (coalesced / rewritten) while the waiter is
   * still blocked. Never steals a non-widget pending.
   */
  private findFifoPendingForSetWidgetReply(
    sock: BridgeSocket,
    msg: Record<string, unknown>,
  ): { rid: string; pending: Pending } | undefined {
    if (msg.ok === true && !isSetWidgetReplyResult(msg.result)) return undefined;
    const set =
      msg.ok === true && isSetWidgetReplyResult(msg.result)
        ? (msg.result as { set: Record<string, unknown> }).set
        : undefined;
    let oldest: { rid: string; pending: Pending } | undefined;
    let widgetPending = 0;
    for (const [rid, pending] of this.pending) {
      if (pending.sock !== sock) continue;
      if (pending.cmd !== "graph_set_widget") {
        if (msg.ok !== true) return undefined;
        continue;
      }
      widgetPending += 1;
      const cmd = pending.ctx.command;
      if (
        set &&
        cmd.node_id != null &&
        set.node_id != null &&
        String(cmd.node_id) !== String(set.node_id)
      ) {
        continue;
      }
      oldest ??= { rid, pending };
    }
    if (msg.ok !== true && widgetPending !== 1) return undefined;
    return oldest;
  }

  /** Resolve or reject one in-flight command from a panel `{ rid, ok, … }` reply. */
  private settlePendingReply(
    rid: string,
    pending: Pending,
    msg: Record<string, unknown>,
    sock: BridgeSocket,
  ): void {
    clearTimeout(pending.timer);
    this.pending.delete(rid);
    this.askRidToId.delete(rid);
    this.forgetDeliveredMutation(rid);
    if (msg.ok) {
      // #422 — the panel DEMONSTRABLY served this command. Record it on the LIVE
      // connection (following a same-socket tmp:→wf: migration whose reply landed
      // after the id change), so a later re-hello advertising an undercutting
      // version can never re-gate it as "too old". Scoped to THIS reply's socket so
      // an unrelated tab reusing the id can never be granted the veto.
      const served = this.liveConnForTab(pending.ctx.tabId, sock);
      served?.provenSupportedCmds.add(pending.cmd);
      this.notePromotedScope(pending.ctx.tabId, msg.result);
      this.noteSiblingSuccess(pending.ctx, rid);
      pending.resolve(msg.result);
      return;
    }
    // #1529 — carry the panel's STRUCTURED refusal onto the error.
    //
    // `msg.error` is arbitrary text, and the retry path needs one fact it
    // cannot get from text: did the executor run? The panel states that in a
    // field (panel 0.14.35), and dropping it here is why the first attempt at
    // the retry had to match wording — which was reverted as a P0, because a
    // genuine mid-write failure can contain the same sentence and the cost of
    // being wrong is a re-applied mutation.
    //
    // Validated before it is attached, so only a complete pre-executor claim
    // travels; anything else leaves the error exactly as it was.
    // #1560 — and record the fact that this reply EXISTS, structurally.
    // `ctx.call` flattens every failure into `isError`, so a command the panel
    // SERVED and refused arrives indistinguishable from one the tab never
    // answered — and a caller that reports "the channel is not answering" then
    // says it about a panel that is demonstrably talking. This branch is the
    // one place that knows the difference: a reply was received.
    const p = pending;
    const err = attachPanelAnswered(new Error(String(msg.error ?? "panel reported an error")));
    // OWN property on the WIRE message too (review, P0). A polluted
    // Object.prototype.refusal would otherwise give every ordinary panel
    // error — including a genuine mid-write one carrying no refusal of its
    // own — the authority to have a mutation re-issued.
    const refusal = hasOwnField(msg, "refusal")
      ? readPanelRefusal((msg as { refusal?: unknown }).refusal)
      : null;
    const workflowListReadiness =
      p.cmd === "workflow_list" && hasOwnField(msg, "workflow_list_readiness")
        ? readWorkflowListReadiness(
            (msg as { workflow_list_readiness?: unknown }).workflow_list_readiness,
          )
        : null;
    let rejected = refusal ? attachPanelRefusal(err, refusal) : err;
    if (workflowListReadiness) {
      rejected = attachWorkflowListReadiness(rejected, workflowListReadiness);
    }
    p.reject(rejected);
  }

  /** The incarnation currently holding `tabId` — the identity every structure
   *  that stores per-tab state must scope to, so a different browser tab taking
   *  over a recurring `wf:` route key cannot read, settle or inherit it (#486). */
  tabIncarnation(tabId: string): string | undefined {
    return this.conns.get(tabId)?.incarnationId;
  }

  /** All currently connected tabs, most recent hello last. */
  tabs(): PanelTab[] {
    return Array.from(this.conns.values()).map((c) => ({
      tab_id: c.tabId,
      title: c.title,
      connected_at: c.connectedAt,
    }));
  }

  /**
   * Parseable panel versions THIS connection advertised in its own hello.
   * Inherited reconnect values are omitted — those are not the live bundle.
   */
  advertisedPanelVersions(): string[] {
    const versions: string[] = [];
    for (const conn of this.conns.values()) {
      const version = connPanelVersionReading(conn).version;
      if (version) versions.push(version);
    }
    return versions;
  }

  /** True once a real CANVAS-OWNING panel tab has connected during this bridge's
   *  lifetime. When a later state has zero tabs, this distinguishes "the pack is
   *  installed and a tab merely dropped" (typically a ComfyUI restart or a browser-tab
   *  reload) from "nothing has ever connected — the pack may be missing". Drives the
   *  actionable no-panel guidance below (#436 priority 4): a session that flapped after
   *  a restart must be told to refresh the ComfyUI browser tab, NOT sent to diagnose a
   *  nonexistent install problem. Uses `everConnectedDesktopTab` (NOT `seenTabs`) so a
   *  headless-only history — a phone mirror that connected but no desktop tab — never
   *  triggers desktop-tab guidance (codex). */
  private hasEverConnected(): boolean {
    return this.everConnectedDesktopTab;
  }

  /** Actionable guidance for a ZERO-tab state, shared by `status()` and the tab-id
   *  resolution refusal so every "no tab" surface says the same true, actionable
   *  thing. Once a tab has connected, the pack is installed and the tab just
   *  disconnected — point the user at refreshing the ComfyUI browser tab (the ONLY
   *  thing that reliably restores the binding after a restart, per #436).
   *
   *  The never-connected branch is the one that has to be careful. What this bridge
   *  observed is narrow and specific: no CANVAS-OWNING tab has helloed it since it
   *  bound its port. It is `everConnectedDesktopTab`, so a headless client (phone
   *  mirror, remote viewer) that connected and left does not count and must not be
   *  described away — hence "no ComfyUI canvas tab", never "nothing at all".
   *
   *  That observation is a BUCKET holding at least five situations (no ComfyUI
   *  running, ComfyUI running without the pack loaded, the Agent tab open but never
   *  Connected — the panel attaches only on Connect, so this is the ordinary state
   *  of a freshly opened tab — a panel that connected to some OTHER bridge address,
   *  and a panel that reached THIS bridge whose handshake never completed). That
   *  last one is easy to lose: `conns` is only populated by a valid hello, so a
   *  token-rejected socket or one that opens and never helloes (tracked as
   *  anonymous, see handleConnection) leaves this count at zero exactly like a
   *  panel dialling somewhere else. Step 4 therefore offers BOTH and names the
   *  orchestrator log as what separates them, rather than sending a user to rewrite
   *  Bridge URL settings for a failure on the bridge they are already on. It used to be narrated as one of them ("open ComfyUI with the pack
   *  installed"), which is the #804 shape: an unobserved cause
   *  asserted from an observation that cannot separate them, sending a user who
   *  already installed the pack off to install it again. So it now states what was
   *  observed, says plainly that the observation does not discriminate, and gives an
   *  ORDERED check whose steps do.
   *
   *  The remedies are phrased as things the USER does rather than tools the agent
   *  calls, because this string is read by agents with very different tool sets
   *  (#784: guidance naming install_comfyui(action:'panel') reached a session that did not have it),
   *  so the one tool named here carries BOTH of its conditions: holding the tool is
   *  not enough, because install_comfyui(action:'panel') is local-only and refuses outright in
   *  remote/cloud mode (panel-installer.ts) — "you have the tool" and "the tool can
   *  do this here" are different facts, and only naming the first is the same
   *  half-checked remedy this whole change exists to remove. For the same reason the
   *  address mismatch points at the panel's Bridge URL setting rather than at
   *  COMFYUI_MCP_BRIDGE_PORT: that env var picks THIS listener's port, so it
   *  cannot correct a panel dialling a different host, token or wss:// tunnel —
   *  a remedy has to be reachable from where the mismatch actually lives.
   *
   *  And the address here is described as a BIND address rather than pasted as a
   *  `ws://` URL, because under COMFYUI_MCP_BRIDGE_HOST=0.0.0.0 (the documented LAN
   *  setup) it is a wildcard no panel can dial, and it carries no token. The
   *  paste-able form is what the orchestrator prints at startup, so the comparison
   *  step sends the reader there — and enumerates the three shapes that line takes
   *  (LAN block, loopback address, or secure tunnel with a ready-to-paste wss URL) rather than
   *  promising a "Bridge URL" that only the LAN branch actually emits. */
  noPanelGuidance(): string {
    return this.hasEverConnected()
      ? "the ComfyUI panel tab is not connected — this is almost always because ComfyUI was just restarted or the browser tab reloaded, which drops the Agent panel's socket. Ask the user to refresh (reload) the ComfyUI browser tab to reconnect the Agent panel, then retry. (The comfyui-mcp-panel pack IS installed — a tab connected earlier this session — so this is a reconnect, not an install problem.)"
      : `no panel connected — no ComfyUI canvas tab has connected to this bridge (bound on ${this.host}:${this.port}) since it started. That is the whole of what is known here, and it does not distinguish which of the steps below is the missing one. Ask the user to check, in this order: (1) is ComfyUI open in a browser at all; (2) does its sidebar have an Agent tab — if not, that ComfyUI does not have the panel pack installed and loaded (ComfyUI-Manager lists it as comfyui-agent-panel; the install_comfyui(action:'panel') tool can do it too, but only when this session has that tool AND the ComfyUI is on this machine — it is local-only and refuses in remote/cloud mode, so a remote ComfyUI has to be installed on its own host); (3) if the Agent tab is there, has a provider been picked and Connect clicked? The panel attaches on Connect, never on load, so a freshly opened tab is expected to show nothing yet; (4) if it reports itself connected and this bridge still has no tab, that splits two ways this state cannot tell apart, because a tab only appears here once a socket completes a valid hello: EITHER the panel reached some other bridge, OR it reached this one and the handshake never completed (a rejected token, or a socket that opened and never helloed — both leave this count at zero). The orchestrator log separates them: a rejected or silent socket is logged here, and nothing arriving at all means it is dialling elsewhere. For the elsewhere case the panel dials whatever is in its Settings → Advanced → Bridge URL, so compare that against what this orchestrator reported when it started — a LAN bind prints a ready-to-paste Bridge URL carrying a reachable host and the required token, a loopback run prints its ws:// address, and a secure-tunnel run prints a ready-to-paste wss:// address, so a hand-set Bridge URL should match that value.`;
  }

  status(): string {
    if (this.portInUse) {
      return `port ${this.port} is held by another comfyui-mcp session — close that session (or whatever owns the port) and reconnect`;
    }
    if (this.conns.size === 0) {
      return this.noPanelGuidance();
    }
    const lines = this.tabs().map(
      (t) =>
        `- tab ${t.tab_id.slice(0, 8)} “${t.title}”${t.tab_id === this.lastActiveTabId ? " (last active)" : ""}`,
    );
    return `${this.conns.size} panel tab(s) connected:\n${lines.join("\n")}`;
  }

  /** Resolve which tab a command should go to. */
  private resolveTarget(tabId?: string): Conn {
    // #884 — a SCOPE ADDRESS (`orchestrator` or the backend-qualified
    // `orchestrator::<backend>`) is not a tab: an agent session spans every
    // tab/workflow, so a command addressed to the scope resolves to a routing
    // target at dispatch time (job (b): routing target, decoupled from session
    // identity).
    //
    // WHILE A TURN IS IN FLIGHT the target is PINNED to the tab the turn was
    // issued from (the orchestrator-injected scopeTargetResolver): "the active
    // tab" is ambiguous by construction mid-turn — a queued message from
    // another tab would otherwise re-aim the running turn's tool calls at a
    // workflow the turn was never about (confirming-gate P0: navigate-then-
    // mutate on the WRONG tab, laundered by the #716 stamp refresh). A pinned
    // tab resolves like any real tab id — including the same-socket migration
    // alias, so a workflow switch on the turn's OWN tab still follows — and
    // when it is GONE the resolution THROWS the standard no-connected-tab
    // error (parked/retried by the reconnect machinery) instead of silently
    // falling back to another tab. `null` from the resolver = the turn's
    // origin is ambiguous (a mixed-origin batch) → refuse loudly.
    //
    // With NO turn in flight (resolver returns undefined): the tab the user
    // last talked from, else the most recently connected interactive
    // (canvas-owning) tab, else the most recent headless one.
    if (isScopeAddress(tabId)) {
      const pin = this.scopeTargetResolver?.(tabId);
      if (pin === null) {
        // TYPED, not text-matched (#1001): this refusal's own opening words are
        // "no connected tab", which is exactly what the transient-reconnect
        // classifier keys on — yet the tabs here are all connected and fine.
        throw markRoutingAmbiguity(
          new Error(
            `no connected tab can be chosen for "${tabId}": the current turn was issued from ` +
              `multiple workflows at once, so its target is ambiguous. Target a workflow ` +
              `explicitly (panel_set_workflow_target / panel_open_workflow) or wait for the ` +
              `next single-origin message.`,
          ),
        );
      }
      if (typeof pin === "string" && pin.length > 0) {
        // Resolve the pinned tab as a normal tab id (exact / prefix / same-
        // socket migration alias). A miss throws the standard error — loud,
        // never a silent re-target.
        return this.resolveTarget(pin);
      }
      return this.resolveScopeActive(tabId);
    }
    if (tabId) {
      // Accept full ids or unambiguous prefixes (status shows 8-char ids).
      const exact = this.conns.get(tabId);
      if (exact) return exact;
      const prefixed = Array.from(this.conns.values()).filter((c) =>
        c.tabId.startsWith(tabId),
      );
      // Tab-id migration fallback — checked AFTER prefix matching (codex
      // review: a stale alias must never shadow a legitimately connected
      // prefix match), and only honored when the live connection is STILL the
      // socket that created the migration (wf:<tabRouteId>:<path> ids recur — an unrelated
      // later tab reusing the id must not inherit someone else's alias).
      if (prefixed.length === 0) {
        const migrated = this.tabMigrations.get(tabId);
        if (migrated) {
          const target = this.conns.get(migrated.to);
          if (target && target.sock === migrated.sock) return target;
        }
      }
      if (prefixed.length === 1) return prefixed[0];
      if (prefixed.length > 1) {
        throw new Error(`tab_id "${tabId}" is ambiguous — matches ${prefixed.length} tabs`);
      }
      const connected = this.tabs();
      // ZERO tabs → this is the post-restart "Connected: none" window. Keep the
      // machine-readable "no connected tab … Connected: none" phrase intact (the
      // panel-tools retry/transient classifier and existing tests key on it) but
      // APPEND the actionable next step so the agent stops diagnosing a nonexistent
      // install problem and instead surfaces the real fix — refresh the ComfyUI
      // browser tab (#436 priority 4). Other-tabs-live keeps the exact tab listing.
      throw new Error(
        connected.length === 0
          ? `no connected tab with id "${tabId}". Connected: none — ${this.noPanelGuidance()}`
          : `no connected tab with id "${tabId}". Connected: ${connected
              .map((t) => `${t.tab_id.slice(0, 8)} (“${t.title}”)`)
              .join(", ")}`,
      );
    }
    if (this.conns.size === 1) {
      return this.conns.values().next().value as Conn;
    }
    if (this.lastActiveTabId && this.conns.has(this.lastActiveTabId)) {
      return this.conns.get(this.lastActiveTabId) as Conn;
    }
    if (this.conns.size === 0) {
      throw new Error(`Panel not reachable: ${this.status()}`);
    }
    throw new Error(
      `Multiple panel tabs are connected and none is "last active" — pass tab_id. ${this.status()}`,
    );
  }

  /** #884 — the ACTIVE-tab resolution for a scope address with NO turn pin in
   *  force: the tab the user last talked from, else the most recently connected
   *  interactive (canvas-owning) tab, else the most recent headless one. Also
   *  the basis of the EXPLICIT repin recovery (repinScopeToActive), which must
   *  bypass a dead pin by construction. */
  private resolveScopeActive(tabId: string): Conn {
    if (this.lastActiveTabId) {
      const active = this.conns.get(this.lastActiveTabId);
      if (active) return active;
    }
    let interactive: Conn | undefined;
    let headless: Conn | undefined;
    for (const c of this.conns.values()) {
      if (c.headless) {
        if (!headless || c.helloGeneration > headless.helloGeneration) headless = c;
      } else if (!interactive || c.helloGeneration > interactive.helloGeneration) {
        interactive = c;
      }
    }
    const best = interactive ?? headless;
    if (best) return best;
    // Keep the machine-readable "no connected tab … Connected: none" phrase —
    // the panel-tools transient classifier keys on it.
    throw new Error(
      `no connected tab with id "${tabId}". Connected: none — ${this.noPanelGuidance()}`,
    );
  }

  /** #884 — the tab id the ACTIVE-tab (pin-bypassing) scope resolution picks
   *  right now, or undefined when no tab is connected. Never throws. The
   *  orchestrator's explicit-repin handler uses this — the whole point of that
   *  recovery is to escape a dead/ambiguous pin, so it must not consult it. */
  resolveActiveScopeTab(): string | undefined {
    try {
      return this.resolveScopeActive(SHARED_SESSION_SCOPE).tabId;
    } catch {
      return undefined;
    }
  }

  /** The tab the user last talked from, if that tab is still connected.
   *  Unlike {@link resolveActiveScopeTab}, this does NOT fall back to the most
   *  recently connected canvas — that fallback is a guess among 2+ tabs and
   *  must not auto-clear an AMBIGUOUS pin (#1001). */
  liveLastActiveTabId(): string | undefined {
    if (this.lastActiveTabId && this.conns.has(this.lastActiveTabId)) return this.lastActiveTabId;
    return undefined;
  }

  /** The LIVE connection for a (possibly RETIRED) canonical tab id, scoped to the SOCKET
   *  that produced the reply. Returns the conn under `tabId` when it is STILL that exact
   *  socket, else the socket-scoped migration target it was renamed to (tmp:→wf:). Used
   *  by the #422 proven-supported bookkeeping so an in-flight reply that lands AFTER a
   *  same-socket re-hello migration records/clears on the migrated connection — and NEVER
   *  on an UNRELATED tab that reused the (recurring wf:<tabRouteId>:<path> / recycled tmp:) id on a
   *  DIFFERENT socket, which the socket check rejects (codex round-4/7 P1). Returns
   *  undefined when neither resolves for this socket. */
  private liveConnForTab(tabId: string, sock: BridgeSocket): Conn | undefined {
    const direct = this.conns.get(tabId);
    if (direct && direct.sock === sock) return direct;
    const migrated = this.tabMigrations.get(tabId);
    if (migrated && migrated.sock === sock) {
      const target = this.conns.get(migrated.to);
      if (target && target.sock === sock) return target;
    }
    return undefined;
  }

  /** Deliveries worth mailboxing when the target is offline (a finished render),
   *  vs. interactive canvas ops that should just fail.
   *
   *  #2013 — this is the ONE command that does not reject when `resolveTarget`
   *  throws. Every other command surfaces `dispatched:false`. Callers that
   *  reason "unroutable ⇒ not delivered" are wrong here: the frame is buffered
   *  and the receipt is `{ok:true, mailboxed:true, …}`. */
  private static isMailboxable(cmd: BridgeCommand): boolean {
    return cmd.cmd === "show_media";
  }

  /**
   * #2013 — kind of client this mailbox entry is for. `true` = headless
   * (phone/remote), `false` = canvas, `undefined` = unknown (never seen, or a
   * scope address whose last client we cannot name). The flush declines a live
   * client that does not match, rather than delivering blind.
   */
  private intendedMailboxKind(tabId: string): boolean | undefined {
    if (!isScopeAddress(tabId)) {
      if (this.conns.get(tabId)?.headless === true || this.headlessSeen.has(tabId)) return true;
      if (this.conns.has(tabId) || this.seenTabs.has(tabId)) return false;
      return undefined;
    }
    // Scope address: nobody is named. Prefer a UNIQUE live kind, else the kind
    // that just left (zero tabs), else unknown — never a guess about who will
    // hello.
    let liveHeadless = false;
    let liveCanvas = false;
    for (const c of this.conns.values()) {
      if (c.headless) liveHeadless = true;
      else liveCanvas = true;
    }
    if (liveHeadless && !liveCanvas) return true;
    if (liveCanvas && !liveHeadless) return false;
    if (this.conns.size === 0) return this.lastDisconnectedHeadless;
    return undefined;
  }

  /** #2013 — the receipt a mailboxed send returns. A concrete tab is a known
   *  recipient (flushMailbox uses `conns.get(tabId)`). A scope address is not:
   *  the box sits under the conversation key and used to drain to the first
   *  matching hello. `queued_for: null` / `recipient_known: false` is how
   *  "queued for whoever connects next" stops reading as a delivery. */
  private mailboxReceipt(tabId: string): {
    ok: true;
    mailboxed: true;
    queued_for: string | null;
    recipient_known: boolean;
  } {
    const recipientKnown = !isScopeAddress(tabId);
    return {
      ok: true,
      mailboxed: true,
      queued_for: recipientKnown ? tabId : null,
      recipient_known: recipientKnown,
    };
  }

  private storeMailbox(tabId: string, cmd: BridgeCommand): void {
    const box = this.mailbox.get(tabId) ?? [];
    const expectHeadless = this.intendedMailboxKind(tabId);
    box.push(
      expectHeadless === undefined ? { cmd, ts: Date.now() } : { cmd, ts: Date.now(), expectHeadless },
    );
    while (box.length > UiBridge.MAILBOX_MAX) box.shift();
    this.mailbox.set(tabId, box);
    logger.info(
      `[ui-bridge] mailboxed "${cmd.cmd}" for offline tab ${tabId.slice(0, 8)} (${box.length} queued` +
        `${expectHeadless === undefined ? ", recipient unknown" : expectHeadless ? ", for headless" : ", for canvas"})`,
    );
  }

  /** #570 P0 — COMPLETE per-tab bridge reset: cancel/clear EVERY per-tab QUEUE that would
   *  otherwise deliver or re-dispatch the PRIOR workflow's work after an UNPROVEN identity
   *  transition (a saved workflow overwritten in place, reconnecting under the same
   *  wf:<path>). Enumerate every per-tabId delivery/dispatch structure so no future queue is
   *  forgotten:
   *   - missedFrames  — buffered say/session/stream frames (replayed on hello);
   *   - mailbox       — finished-render show_media (flushed on hello);
   *   - awaitingReconnect — idempotent reads parked on a mid-command drop, which
   *     resumeAwaitingReconnect() would re-dispatch onto the REPLACEMENT tab's socket and
   *     deliver its graph/data back into the PRIOR workflow's still-running tool call.
   *   - mirror subscribers / viewers — a MIRROR channel is also a per-tab delivery path: a
   *     phone attached to workflow A keeps receiving this tab's session/say frames and its
   *     input is stamped for this tab. On a same-socket SWITCH the hello handler already
   *     MOVED the old id's subscribers/viewers onto the NEW id BEFORE continuity could be
   *     proven, so on an unproven transition a mirror viewer would silently follow A→B
   *     without ever attaching to B (codex review). Detach viewers driving this tab (their
   *     input reverts to their OWN session) and drop this tab's subscriber set (stop feeding
   *     it B's frames); they can re-attach explicitly if they still want this view.
   *  The remaining routing/lifecycle structures (conns, migration aliases) are intentionally
   *  NOT touched here — the socket stays; only queued WORK and unproven mirror bindings are
   *  dropped. Called by the orchestrator's identity-boundary reset (with the surviving id) and
   *  the switch retire branch (with the retired id), and the bridge defers its on-hello
   *  replay/flush/resume until AFTER onPanelMessage so this purge lands first. */
  dropQueuedDeliveries(tabId: string): void {
    this.promotedScopes.delete(tabId);
    this.missedFrames.delete(tabId);
    this.mailbox.delete(tabId);
    // MIRROR teardown (see above): a viewer must not auto-follow an unproven workflow switch.
    for (const [s, drivenTab] of this.mirrorViewers) {
      if (drivenTab === tabId) this.mirrorViewers.delete(s);
    }
    this.subscribers.delete(tabId);
    const awaiting = this.awaitingReconnect.get(tabId);
    if (awaiting) {
      this.awaitingReconnect.delete(tabId);
      for (const entry of awaiting) {
        clearTimeout(entry.graceTimer);
        try {
          entry.ctx.reject(
            new Error(
              `panel tab ${tabId.slice(0, 8)} was replaced by a different workflow before its command ("${entry.ctx.command.cmd}") could resume — cancelled to avoid running it against the new workflow`,
            ),
          );
        } catch {
          // reject already settled — nothing to do
        }
      }
    }
    // In-flight command promises for this tab: a reply arriving AFTER the workflow was
    // replaced must NOT resolve the PRIOR workflow's tool call (leaking the replacement's
    // graph/data back into it). Reject + drop them. (The already-written command may still
    // EXECUTE in the browser — that is the deferred generation-bound-command residual, which
    // server-side cancellation cannot retract; this only fences the reply/data flow back.)
    for (const [rid, p] of this.pending) {
      if (p.ctx.tabId !== tabId) continue;
      clearTimeout(p.timer);
      this.pending.delete(rid);
      try {
        p.reject(
          new Error(
            `panel tab ${tabId.slice(0, 8)} was replaced by a different workflow — in-flight "${p.cmd}" cancelled so its reply can't resolve the prior workflow's call`,
          ),
        );
      } catch {
        // reject already settled — nothing to do
      }
    }
  }

  /** Deliver any buffered render frames to a tab that just (re)connected, plus a
   *  `mailbox_flush` summary so the client can notify "N renders finished while
   *  you were away". Expired items (past TTL) are dropped.
   *
   *  #2013 — a box tagged for one kind of client is NOT handed to the other.
   *  Declined entries stay queued for a matching reconnect rather than
   *  disappearing into the first hello (the scope-keyed "whoever connects next"
   *  path). Untagged entries (unknown recipient) still flush, which is the
   *  original "phone was away, here is your render" behaviour. */
  private flushMailbox(tabId: string, deliverTo?: Conn): void {
    const box = this.mailbox.get(tabId);
    if (!box || box.length === 0) return;
    // #884 — `deliverTo` lets the SHARED-SCOPE mailbox (deliveries produced while
    // zero tabs were connected) flush to the first tab that hellos; the scope
    // itself never owns a conn.
    const conn = deliverTo ?? this.conns.get(tabId);
    if (!conn) return;
    const now = Date.now();
    const kept: typeof box = [];
    let delivered = 0;
    let declined = 0;
    for (const m of box) {
      if (now - m.ts > UiBridge.MAILBOX_TTL_MS) continue;
      if (m.expectHeadless !== undefined && conn.headless !== m.expectHeadless) {
        kept.push(m);
        declined += 1;
        continue;
      }
      try {
        conn.sock.send(JSON.stringify({ rid: randomUUID(), ...m.cmd, mailbox: true }));
        delivered += 1;
      } catch {
        // socket raced closed; drop this one like the pre-#2013 flush
      }
    }
    if (kept.length > 0) this.mailbox.set(tabId, kept);
    else this.mailbox.delete(tabId);
    if (delivered > 0) {
      try {
        conn.sock.send(JSON.stringify({ type: "mailbox_flush", count: delivered }));
      } catch {
        /* best-effort */
      }
      logger.info(
        `[ui-bridge] flushed ${delivered} mailboxed frame(s) to reconnected tab ${tabId.slice(0, 8)}` +
          (declined > 0 ? ` (${declined} held for a matching client)` : ""),
      );
    } else if (declined > 0) {
      logger.info(
        `[ui-bridge] held ${declined} mailboxed frame(s) past tab ${tabId.slice(0, 8)} — kind mismatch`,
      );
    }
  }

  async send(
    cmd: BridgeCommand,
    opts: {
      tabId?: string;
      timeoutMs?: number;
      onDispatchedRid?: (rid: string) => void;
      /** Synchronous fence at the final live-connection dispatch boundary. */
      beforeDispatch?: () => void;
      /** Maximum bridge-owned reconnect re-dispatches for this send. The bridge
       * clamps this to its finite global bound; zero makes a read one-shot. */
      maxReconnectRetries?: number;
    } = {},
  ): Promise<unknown> {
    // #357: read (idempotent) ops get a more tolerant default so a busy-but-alive
    // panel main thread (e.g. Preview3D loading a large FBX) isn't declared frozen;
    // mutating ops keep the tight default. An explicit opts.timeoutMs always wins.
    const timeoutMs = opts.timeoutMs ?? defaultBridgeTimeoutMs(cmd.cmd);
    let conn: Conn;
    // panel#1292 — a mixed-origin pin is decided once per batch, but
    // `mode:"current"` is the advertised recovery and may be running in THIS
    // same batch. Wait for that recovery once before minting the refusal;
    // `canReach` stays sync (it swallows the throw) so the wait is send-only.
    let waitedForScopeRecovery = false;
    for (;;) {
      try {
        conn = this.resolveTarget(opts.tabId);
        break;
      } catch (err) {
        if (
          !waitedForScopeRecovery &&
          isRoutingAmbiguity(err) &&
          opts.tabId &&
          isScopeAddress(opts.tabId)
        ) {
          await this.awaitScopePinRecovery(opts.tabId);
          waitedForScopeRecovery = true;
          continue;
        }
        // Offline target: buffer a finished-render delivery for reconnect instead of
        // failing, so the agent's "here's your image" isn't lost while the phone is away.
        if (opts.tabId && UiBridge.isMailboxable(cmd)) {
          this.storeMailbox(opts.tabId, cmd);
          return this.mailboxReceipt(opts.tabId);
        }
        // resolveTarget threw BEFORE any socket write — no tab could be routed to (no
        // connected tab / ambiguous / multiple / not reachable), so nothing was
        // transmitted. Tag the rejection with the AUTHORITATIVE typed flag
        // dispatched:false so a caller classifies "nothing applied" categorically (reboot
        // readiness; the mutating-command rebind hint, panel #442) — never by
        // string-matching a message whose text a post-dispatch executor error could quote.
        throw markDispatched(err instanceof Error ? err : new Error(String(err)), false);
      }
    }
    // #236 — proactively gate a command this exact connection has already proven
    // unsupported (see Conn.unsupportedCmds), instead of dispatching it again just
    // to have the panel reject it and re-parse the same "Unknown command" string.
    // Never a false gate: membership here is only ever set from a REAL rejection
    // on THIS connection (in dispatch()'s rejectMapped below), never inferred from
    // panelVersion alone.
    if (conn.unsupportedCmds.has(cmd.cmd)) {
      return Promise.reject(buildPanelTooOldError(cmd.cmd, connPanelVersionReading(conn)));
    }
    // #392 — PROACTIVELY gate a command whose changelog-verified minimum the panel's
    // ADVERTISED version parseably undercuts (e.g. graph_query on a <0.7.0 panel), so
    // the honest, correctly-versioned "update your panel" verdict fires on the FIRST
    // call — no round-trip to collect an "Unknown command" reply, and it still works
    // if a frozen old panel wouldn't reply. Conservative (panelVersionProvesUnsupported
    // gates ONLY explicitly-listed commands against their true minimum, never the
    // inflated fallback), so a capable panel is never falsely gated. Intentionally does
    // NOT add to conn.unsupportedCmds — that learned set stays reserved for REAL
    // rejections (#236), so nothing is permanently poisoned from version alone.
    // Gated on panelVersionAdvertised so a stale version INHERITED across an
    // omitted-version reconnect never blocks a possibly-upgraded panel unprobed.
    // And VETOED by demonstrated capability (#422): if this connection has already
    // executed cmd successfully, the panel plainly supports it, so a later re-hello
    // whose advertised version parseably undercuts the declared minimum must NOT
    // regress it to "too old" — observed behaviour outranks an advertised version.
    if (
      conn.panelVersionAdvertised &&
      !conn.provenSupportedCmds.has(cmd.cmd) &&
      panelVersionProvesUnsupported(cmd.cmd, conn.panelVersion)
    ) {
      return Promise.reject(buildPanelTooOldError(cmd.cmd, connPanelVersionReading(conn)));
    }
    // #2107 — an expected_node_type is meaningful only when the receiving panel
    // checks it immediately before mutating. An old panel silently ignoring this
    // optional field would reopen the node-replacement race, so never dispatch it
    // without the matching hello capability.
    if (
      cmd.cmd === "graph_set_widget" &&
      Object.prototype.hasOwnProperty.call(cmd, "expected_node_type") &&
      !conn.enforcesExpectedNodeTypeAtWrite
    ) {
      const refusal = markDispatched(
        expectedNodeTypeFenceRefusal(conn.tabId),
        false,
      );
      return Promise.reject(markCapabilityRefusal(refusal));
    }
    if (
      cmd.cmd === "graph_set_widget" &&
      Object.prototype.hasOwnProperty.call(cmd, "expected_node_identity") &&
      !conn.enforcesExpectedNodeIdentityAtWrite
    ) {
      const refusal = markDispatched(
        expectedNodeIdentityFenceRefusal(conn.tabId),
        false,
      );
      return Promise.reject(markCapabilityRefusal(refusal));
    }
    // #2314 — an expected_scope is meaningful only when the receiving panel
    // compares it against its LIVE current graph at the synchronous mutation
    // boundary. An older panel silently ignoring this optional field could
    // write a colliding inner node after receiver navigation, so refuse before
    // dispatch.
    if (
      cmd.cmd === "graph_set_widget" &&
      Object.prototype.hasOwnProperty.call(cmd, "expected_scope") &&
      !conn.enforcesExpectedScopeAtWrite
    ) {
      const refusal = markDispatched(
        expectedScopeFenceRefusal(conn.tabId),
        false,
      );
      return Promise.reject(markCapabilityRefusal(refusal));
    }
    if (
      cmd.cmd === "graph_set_widget" &&
      commandCarriesExpectedGraphIdentity(cmd) &&
      !conn.enforcesExpectedScopeGraphIdentityAtWrite
    ) {
      const refusal = markDispatched(
        expectedScopeGraphIdentityFenceRefusal(conn.tabId),
        false,
      );
      return Promise.reject(markCapabilityRefusal(refusal));
    }
    if (
      cmd.cmd === "graph_set_widget" &&
      commandCarriesPromotedParentRail(cmd) &&
      !conn.enforcesPromotedParentRailAtWrite
    ) {
      const refusal = markDispatched(
        promotedParentRailFenceRefusal(conn.tabId),
        false,
      );
      return Promise.reject(markCapabilityRefusal(refusal));
    }
    // #570 P0c — FAIL CLOSED for a command that mutates the ACTIVE workflow/canvas (every
    // graph_* mutator, plus path-less workflow_save/save_as/rename/close) when the resolved
    // panel does NOT enforce the per-command workflow-instance stamp. Such a panel would
    // silently IGNORE the stamp and could apply a command delivered AFTER a workflow switch to
    // the wrong workflow — a delivered frame cannot be retracted, so fencing only the reply
    // can't undo the mutation (workflow_close would discard the new workflow's unsaved work).
    // Refusing to DISPATCH is the only server-side guarantee. Reads (outline, query, get_state,
    // serialize, …) and path-targeted workflow ops stay allowed, so an old panel keeps
    // read-only graph access with a clear "update to edit" error, never a silent wrong write.
    //
    // Require ALL THREE (codex): the panel must advertise the dispatch-time fence, the
    // after-await write-boundary recheck, AND the command must actually CARRY a trusted
    // workflow-uuid stamp. Either fence alone is not enough — if the tab has no
    // resolvable identity (missing/malformed uuid, relay client), the frame ships UNSTAMPED and
    // the panel's fence has nothing to compare, so a stale mutation after a switch would run
    // unfenced despite the "enforces" claim. No stamp ⇒ nothing to fence ⇒ refuse the mutation.
    //
    // NOTE — this gate is ACCIDENTAL version-skew protection (honest old panel ⇒ read-only graph
    // until updated), NOT a security boundary: the enforcement flag and the uuid are both client-
    // supplied, so a user who modifies their OWN panel can spoof them — but that only leaks their
    // own workflow into their own workflow (self-attack, no privacy boundary). See the
    // enforcesWorkflowStamp field doc. Deliberately no attestation.
    if (requiresWorkflowStampEnforcement(cmd)) {
      // #884 — the resolver is passed the CALLER's id, including the SHARED
      // SCOPE: the orchestrator answers a scope caller with the workflow the
      // CURRENT TURN was issued for (captured at user-message dispatch, #570's
      // issue-time rule preserved), so a mutation conceived while the user was
      // on workflow A is still declined by the panel after a switch to B —
      // never silently re-aimed at whatever the active tab shows now.
      const stamp = this.resolveTabWorkflowUuid?.(opts.tabId ?? conn.tabId);
      const hasTrustedStamp = typeof stamp === "string" && stamp.length > 0;
      if (!conn.enforcesWorkflowStamp || !conn.enforcesWorkflowStampAtWrite || !hasTrustedStamp) {
        // The two CAPABILITY branches (missing panel fences) are typed so the tool
        // layer drops its futile retry/rebind suffix (#709). The NO-IDENTITY branch
        // is deliberately NOT capability-marked: an unresolvable workflow identity
        // is a binding problem a retry/rebind genuinely fixes, so the generic
        // wrapper must keep firing for it (codex gate — the marker must never
        // false-positive a non-capability refusal).
        const capabilityMissing = !conn.enforcesWorkflowStamp || !conn.enforcesWorkflowStampAtWrite;
        // #709 — user-facing, so name the FULL tab id: the log-style slice(0,8)
        // rendering ("wf:workf") was misread as a corrupted routing identity and
        // sent the diagnosis down a wrong path. And lead with the recovery that
        // actually clears the dominant cause: the on-disk pack can be current
        // while the open browser tab keeps running a CACHED older bundle (a
        // restart reconnects the tab but never re-downloads the extension JS),
        // so the capability the hello advertises lags the version on disk.
        //
        // #774/#784 — the recovery is resolved from THIS session's context, not
        // hardcoded. This gate is hard by design (a wrong-workflow write cannot
        // be retracted), which makes it doubly important that the one remedy it
        // names is a remedy the caller can actually reach: in remote/cloud mode
        // install_comfyui(action:'panel') is a no-op, and on the embedded `panel_*` surface it is
        // not even present. describePanelUpdateRecovery names it only where it
        // works, and hands over concrete host-side commands everywhere else.
        //
        // And FIRST it asks a different question: is the INSTALL even the
        // problem? `resolveStaleBundleSkew` answers that from the version the
        // panel sync read OFF DISK at this tab's own hello. When the pack on
        // disk already clears the floor, no update of any kind helps and the
        // remedy is a cache-bypassing reload of this tab.
        // `conn.panelVersion` is INHERITED across a reconnect whose hello omitted
        // the field (see the field's doc); `panelVersionAdvertised` is the record
        // of whether THIS connection actually stated one. Only the advertised
        // value may be attributed to this tab, or to the skew diagnosis, which
        // otherwise reasons about an observation the current tab never made
        // (codex gate). An inherited value is still worth SHOWING — it is a real
        // earlier reading — but labelled as what it is.
        // The distinction that matters is PARSEABLE vs NOT, not empty vs
        // non-empty. An earlier fix trimmed the field so `panel_version: "   "`
        // stopped rendering as "this tab reports panel    " — but that only
        // screened BLANK, and `panel_version: "nightly"` sailed through as
        // "this tab reports panel nightly": a version-shaped claim built from a
        // string we never parsed, which is this cluster's own defect surviving
        // inside its fix. It is not a rare input either — ComfyUI-Manager
        // reports "nightly" for a git-installed pack, so it is the normal case
        // for anyone running the panel from source rather than the Registry.
        //
        // So: `rawAdvertised` is what this handshake actually said (evidence,
        // shown verbatim), and `advertised` is what we may COMPARE or attribute
        // as a version. Anything that fails the strict SemVer screen has the
        // same evidential value as no version at all and takes the unreadable
        // path — including into `resolveStaleBundleSkew`, which then reasons
        // from "no comparable version" instead of silently rejecting a value it
        // would have screened out one line later anyway.
        // The SAME reading every other consumer uses, so parseability AND
        // provenance are decided once: `.version` is comparable and
        // attributable, `.raw` is this handshake's unparseable text, `.inherited`
        // is an earlier connection's.
        const reading = connPanelVersionReading(conn);
        const rawAdvertised = reading.raw;
        const advertised = reading.version;
        const skewReading = resolveStaleBundleSkew(advertised);
        const unconfirmed =
          skewReading != null && "diskVersionUnconfirmed" in skewReading;
        const recovery = describePanelUpdateRecovery(
          undefined,
          unconfirmed ? undefined : (skewReading as PanelBundleSkew | undefined),
          unconfirmed,
        );
        // #819/#823 — do not fold an ABSENT reading into a definite verdict.
        // "detected panel version unknown; this MCP requires panel 0.11.35+"
        // reads as "your panel is too old", but a missing version is a missing
        // OBSERVATION: the tab sent no version, and a CURRENT install behind a
        // stale cached browser bundle presents exactly the same way. Report what
        // was actually seen and let the recovery cover both.
        const NOT_OBSERVED =
          `so its age was not observed — this is equally consistent with an old install ` +
          `and with a current one whose browser tab is running a cached older bundle`;
        const observed = advertised
          ? `this tab reports panel ${advertised}`
          : rawAdvertised
            ? // It said SOMETHING, and that something is evidence worth showing —
              // but it is not a version, so it may not be narrated as one. The
              // most common value here is "nightly" (a git-installed pack), for
              // which the true version is genuinely indeterminate.
              `this tab advertised "${rawAdvertised}", which is not a version this MCP can ` +
              `compare (ComfyUI-Manager reports "nightly" for a git-installed pack), ` +
              `${NOT_OBSERVED}`
            : reading.inherited
              ? `this tab advertised NO panel version in its current handshake (an EARLIER ` +
                `connection for this tab reported ${reading.inherited}, which may be out of ` +
                `date), ${NOT_OBSERVED}`
              : `this tab advertised NO panel version, ${NOT_OBSERVED}`;
        // The FENCE's own minimum, never the aggregate requiredPanelVersion():
        // a write needs the two workflow-fence capabilities and nothing else, so
        // quoting the global max would name a version this command does not
        // require the moment any unrelated command declares a higher one.
        const fenceMin = requiredPanelVersionForWorkflowFence();
        // And symmetrically: when THIS build cannot state the fence's minimum,
        // quote no number at all (codex gate). Falling back to the bridge
        // baseline would assert "0.11.4, the first build that fences every
        // command" — false, and false in the direction that sends a user to an
        // update that will not clear the gate. An unreadable table is another
        // unmade observation.
        const needs = (capability: string): string =>
          fenceMin
            ? `a graph WRITE needs panel ${fenceMin}+, the first build that ${capability}`
            : `a graph WRITE needs a panel that ${capability}, but this MCP build cannot say ` +
              `which version first shipped it (its capability table is incomplete) — no ` +
              `version is quoted here rather than a wrong one; update to the latest panel`;
        const why = !conn.enforcesWorkflowStamp
          ? `panel tab ${conn.tabId} does not enforce per-command workflow targeting (${observed}; ` +
            `${needs("fences every command to the workflow it was issued for")}). ${recovery}`
          : !conn.enforcesWorkflowStampAtWrite
            ? `panel tab ${conn.tabId} does not recheck workflow targeting at the graph write ` +
              `boundary after asynchronous work (${observed}; ` +
                `${needs("rechecks the fence after an await")}). ${recovery}`
          : `this workflow has no trusted identity for the panel to fence the command against`;
        // #1519 — WHAT THIS REFUSAL MAY SAY ABOUT READS, which is less than it used
        // to say, and in one state is nothing at all.
        //
        // The trailing sentence used to be unconditional, and in the state #1519
        // reports it is FALSE. A panel that advertises the per-command fence refuses
        // an UNSTAMPED command OUTRIGHT, reads included, because #718 closed exactly
        // that fail-open hole ("An UNSTAMPED command is refused too … an advertised
        // fence must not fail open" — comfyui-mcp-panel.js; the predicate is
        // commandWorkflowMismatch, which counts a missing stamp as a mismatch, and
        // activeWorkflowFenceApplies, which covers every graph_* read). So when this
        // refusal fires for the no-trusted-stamp reason, graph_outline does NOT work
        // either — it answers `workflow instance mismatch: this command carries no
        // workflow-instance stamp`, which is the error #1519 was filed with. The
        // reporter was told reads still worked, hit a refusal this sentence says
        // cannot happen, and had to find the rebind themselves.
        //
        // THREE answers, because PRESENCE IS NOT AGREEMENT (review, P1 — and the
        // first version of this fix got it wrong in exactly the way #1519 is about).
        //
        // That version asked "is there a trusted stamp?" and promised reads work
        // whenever there was one. But a read does not succeed because a stamp
        // EXISTS; it succeeds when the stamp still EQUALS the active canvas. The
        // resolver answers with the workflow the turn was ISSUED FOR (#570/#884) —
        // a value that is deliberately allowed to go stale, since declining a
        // command aimed at the workflow the user has since left is the fence's
        // whole purpose. So "trusted" and "current" are different questions, and
        // the fix had merely MOVED the false promise from the no-stamp branch into
        // the stale-stamp one. Measured on a real bridge before this was changed: a
        // stale-stamped connection was told reads still work, and the very next
        // graph_outline came back "workflow instance mismatch: this command was
        // issued for workflow instance aaaa…, and the active canvas reports bbbb…".
        //
        //   no fence advertised   → reads EXECUTE. Nothing compares them; this is
        //                           the old panel the two capability branches exist
        //                           for, and the original sentence is true for it.
        //   fence, no stamp       → reads are REFUSED, provably: a missing stamp is
        //                           a mismatch by definition (commandWorkflowMismatch).
        //   fence, stamp present  → UNKNOWN, and it must SAY unknown. Whether the
        //                           read passes depends on stamp-vs-active equality,
        //                           and this side cannot evaluate it: `Conn` carries
        //                           no live canvas uuid, and workflowUuidFor() reads
        //                           the SAME resolver the stamp came from, so
        //                           comparing them would compare a value with itself
        //                           and always agree. Only the panel can answer, and
        //                           a pre-dispatch refusal may not take a round trip
        //                           to ask. Asserting either outcome here would be
        //                           the unmeasured claim this whole issue is about.
        //
        // It deliberately names no remedy. This gate is entered only for a MUTATION,
        // and the orchestrator's #1331 handler MEASURES which of the two no-identity
        // states this is before naming one — including saying, when it applies, that
        // panel_set_workflow_target({mode:"current"}) will NOT clear it. A remedy
        // guessed here would contradict the one that was checked.
        const trustedStamp = typeof stamp === "string" && stamp.length > 0 ? stamp : "";
        const readsVerdict: "execute" | "refused" | "unknown" = !conn.enforcesWorkflowStamp
          ? "execute"
          : trustedStamp
            ? "unknown"
            : "refused";
        // The exempt probe is named in both fenced verdicts, as the thing to TRY and
        // by its ROLE rather than by an outcome: `workflow_list` is fence-EXEMPT
        // because it is the recovery probe (commandIsCanvasTargetless, panel #759),
        // but in the #1331 state the repair it exists for finds no identity to adopt
        // and does NOT clear the refusal — so "so a stale binding can be repaired"
        // would read as a promise the appended #1331 verdict then contradicts. The
        // exemption also first shipped in panel 0.11.83 while this branch is reachable
        // from 0.11.35, so a build in between fences the probe too (the state
        // panel-tools' `unreadable` remedy documents). Measured against the panel
        // repo, not assumed: #1519's own reporter is on 0.13.0, whose release commit
        // HAS the exemption. Naming a version here would need a table entry for a
        // value this message cannot usually read anyway, so it says which builds
        // differ instead of asserting one.
        const PROBE =
          `Try panel_list_workflows — the panel exempts that read from this fence (it is the ` +
          `recovery probe), though a build predating the exemption fences it too. Non-graph ` +
          `tools are unaffected.`;
        // #1935 — name TOOLS, not the bridge commands they dispatch. An agent
        // that follows this recovery advice calls what it is told to call, and
        // none of graph_outline / graph_query / graph_get_state is registered.
        // The mapping is not a mechanical `panel_` prefix (graph_query →
        // panel_query_graph), so names come from panelToolForGraphCmd /
        // QUEUE_BUSY_READ_TOOLS rather than a third hand-written list.
        // graph_get_state is an internal pre-0.8.2 fallback with no callable
        // tool — the reverse index omits it, so it drops out of the execute
        // list rather than being advertised.
        const readTools = QUEUE_BUSY_READ_TOOLS.join(" / ");
        const viewTools = (
          [
            "graph_outline",
            "graph_query",
            "graph_get_state",
            "graph_find_nodes",
            "graph_list_subgraphs",
            "graph_screenshot",
            "graph_canvas",
          ] as const
        )
          .map((c) => panelToolForGraphCmd(c))
          .filter((n): n is string => n !== undefined)
          .join(", ");
        const readsNote =
          readsVerdict === "refused"
            ? `GRAPH READS ARE REFUSED TOO, for this same missing stamp: this tab's panel ` +
              `enforces the per-command fence and refuses an UNSTAMPED command rather than ` +
              `fail open, so ${readTools} answer "workflow instance mismatch: ` +
              `this command carries no workflow-instance stamp" as well. ${PROBE}`
            : readsVerdict === "unknown"
              ? `WHETHER GRAPH READS STILL WORK IS NOT KNOWN FROM HERE, and is not claimed: a ` +
                `read carries this session's stamp (${trustedStamp}), and this tab's panel runs ` +
                `it only while that stamp still names the ACTIVE canvas — a comparison only the ` +
                `panel can make. If the workflow was switched or replaced after this session ` +
                `bound to it, ${readTools} are refused with "workflow instance ` +
                `mismatch" as well; if it was not, they work. ${PROBE}`
              : `Reads and view-only commands still work (${viewTools}).`;
        // Same defect on the SUBJECT: `cmd.cmd` is the bridge command the tool
        // dispatched (observed: panel_add_node arrives here as graph_add_node).
        // Ambiguous commands fall back to a subject naming no tool at all.
        const subject =
          panelToolForGraphCmd(typeof cmd.cmd === "string" ? cmd.cmd : "") ?? "This command";
        const refusal = markDispatched(
          new Error(
            `"${subject}" cannot be safely targeted to the active workflow: ${why}. ${readsNote}`,
          ),
          false,
        );
        return Promise.reject(capabilityMissing ? markCapabilityRefusal(refusal) : refusal);
      }
    }
    // #1656 — the stamp and the routing target are resolved from DIFFERENT inputs,
    // and after a tab switch they can name different canvases. Routing follows the
    // panel's re-hello at once (the migration alias / last-active carry move the
    // connection onto the NEW canvas), while the stamp is resolved from the
    // CALLER'S address — for the shared scope, the conversation's issue-time
    // workflow, which is deliberately never re-resolved at dispatch (#570/#884) and
    // so still names the PREVIOUS canvas. The panel-side fence is meant to refuse
    // that pairing, but it compares the stamp against the frontend's LIVE identity,
    // which can lag the very switch the hello already reported — and in that window
    // the command executes on the previous canvas instead of being refused
    // (observed: outline + save ran on the prior workflow after the switch and
    // returned its uuid/path, with no error).
    //
    // This side sees both halves: the session's stamp (the caller-address answer)
    // and the identity the routed tab last advertised (the canonical-id answer,
    // refreshed by every hello). When BOTH are known and they DISAGREE, the
    // command's fence provably does not name the canvas it would land on, so refuse
    // BEFORE the socket write — nothing is dispatched, and the refusal names the
    // documented rebind. With a settled panel this changes no outcome (a
    // mismatched stamp is refused there too); it closes the window in which the
    // refusal does not happen. An UNREADABLE side is not evidence of divergence:
    // either value missing keeps the existing behaviour and lets the panel fence
    // judge. And a caller addressing the connection by its canonical id is skipped
    // outright — both answers then come from the same lookup and can only agree.
    //
    // #1656 (recurrence) — the gate above compares two VALUES and calls equality
    // "agreement". That inference is only sound when the routed tab's value is
    // something THAT TAB advertised. `carryWorkflowCommandStamp` copies the retiring
    // id's uuid onto the new id on every same-socket re-hello that mints one, and the
    // hello handler overwrites it only `if (newIdentity)`. Its docstring's promise —
    // "carrying cannot widen authorization" — was written about the PANEL's fence,
    // which tests the carried value against the live canvas; this gate instead treats
    // it as an observation about the new canvas, and there the promise fails. Worse
    // than "may agree": the conversation's issue-time stamp is captured from that same
    // map (`turnOrigins.recordForMid(mid, tabCommandWorkflowUuid.get(tab), tab)`), so a
    // carry makes both sides the SAME STRING by construction — the gate is guaranteed
    // to pass in exactly the window where the canvas changed, and starts refusing only
    // once some later hello finally proves a different identity. That is the reported
    // shape verbatim: six mutations accepted onto the previous canvas, the seventh
    // refused.
    //
    // So a CARRIED stamp is not agreement, it is an absence of evidence about a canvas
    // this command is about to read or mutate — and #570's rule for that is to refuse
    // the dispatch, because a delivered frame cannot be retracted. Deliberately narrow:
    // only the commands requiresStampTargetAgreement() already covers (workflow_list,
    // workflow_open/new, canvas-independent ops and path-selectored rename/close stay
    // exempt, so the documented rebind is reachable and clears this by proving an
    // identity for the tab's CURRENT id), and only while the carry is unproven — the
    // instant any hello or validated reply establishes an identity for this tab id, the
    // provenance flips to proven and nothing about the pre-#1656 behaviour changes.
    if (opts.tabId && opts.tabId !== conn.tabId && requiresStampTargetAgreement(cmd)) {
      // #1494 — ONE implementation of the question, asked here and by
      // `tabGraphMutationCapability`. The recovery this refusal names used to answer
      // "bound / already_current" while this gate went on refusing every fenced
      // command, because the two sides read DIFFERENT facts: the gate compares the
      // session stamp against the routed tab's advertisement, the recovery compares
      // the session stamp against the LIVE canvas. Sharing the predicate is what
      // stops them contradicting each other again.
      const verdict = this.stampTargetVerdict(opts.tabId, conn.tabId);
      if (verdict.refuses && verdict.kind === "disagrees") {
        return Promise.reject(
          markDispatched(
            new Error(
              `workflow instance mismatch: this command was issued for workflow instance ${verdict.issuedFor}, ` +
                `but the tab it routed to has since reported a different active workflow (${verdict.landedOn}). ` +
                `Nothing was dispatched. Re-target with panel_set_workflow_target({mode:"current"}), ` +
                `then retry.`,
            ),
            false,
          ),
        );
      }
      if (verdict.refuses && verdict.kind === "carried") {
        return Promise.reject(
          markDispatched(
            new Error(
              `workflow instance mismatch: this command was issued for workflow instance ${verdict.issuedFor}, ` +
                `and the tab it routed to has not re-established its workflow identity since it ` +
                `re-registered under a new id — the uuid it currently carries (${verdict.landedOn}) was ` +
                `inherited from the tab id it replaced, so it is not evidence about the canvas now ` +
                `mounted there. Nothing was dispatched. Re-target with ` +
                `panel_set_workflow_target({mode:"current"}), then retry.`,
            ),
            false,
          ),
        );
      }
    }
    if (conn.sock.readyState !== WebSocket.OPEN) {
      if (opts.tabId && UiBridge.isMailboxable(cmd)) {
        this.storeMailbox(opts.tabId, cmd);
        return Promise.resolve(this.mailboxReceipt(opts.tabId));
      }
      // The resolved socket is not OPEN — the command cannot be written, so nothing is
      // dispatched. Typed dispatched:false, same as the resolveTarget refusal above.
      return Promise.reject(
        markDispatched(new Error(`Panel tab ${conn.tabId.slice(0, 8)} is not open`), false),
      );
    }
    const launch = (releaseLane: () => void): Promise<unknown> => {
      // Re-resolve after a graph-lane wait: the tab may have migrated while a
      // predecessor occupied the lane. Gates above already ran against `conn`.
      let live: Conn;
      try {
        live = this.resolveTarget(opts.tabId);
      } catch (err) {
        return Promise.reject(
          markDispatched(err instanceof Error ? err : new Error(String(err)), false),
        );
      }
      // The graph lane may have waited behind another command. Re-read the
      // capability on the connection that will actually receive the frame;
      // a reconnect during that wait must not turn the optional fence into a
      // silently ignored field on an older panel.
      if (
        cmd.cmd === "graph_set_widget" &&
        Object.prototype.hasOwnProperty.call(cmd, "expected_node_type") &&
        !live.enforcesExpectedNodeTypeAtWrite
      ) {
        return Promise.reject(
          markCapabilityRefusal(markDispatched(expectedNodeTypeFenceRefusal(live.tabId), false)),
        );
      }
      if (
        cmd.cmd === "graph_set_widget" &&
        Object.prototype.hasOwnProperty.call(cmd, "expected_node_identity") &&
        !live.enforcesExpectedNodeIdentityAtWrite
      ) {
        return Promise.reject(
          markCapabilityRefusal(markDispatched(expectedNodeIdentityFenceRefusal(live.tabId), false)),
        );
      }
      if (
        cmd.cmd === "graph_set_widget" &&
        Object.prototype.hasOwnProperty.call(cmd, "expected_scope") &&
        !live.enforcesExpectedScopeAtWrite
      ) {
        return Promise.reject(
          markCapabilityRefusal(markDispatched(expectedScopeFenceRefusal(live.tabId), false)),
        );
      }
      if (
        cmd.cmd === "graph_set_widget" &&
        commandCarriesExpectedGraphIdentity(cmd) &&
        !live.enforcesExpectedScopeGraphIdentityAtWrite
      ) {
        return Promise.reject(
          markCapabilityRefusal(
            markDispatched(expectedScopeGraphIdentityFenceRefusal(live.tabId), false),
          ),
        );
      }
      if (
        cmd.cmd === "graph_set_widget" &&
        commandCarriesPromotedParentRail(cmd) &&
        !live.enforcesPromotedParentRailAtWrite
      ) {
        return Promise.reject(
          markCapabilityRefusal(
            markDispatched(promotedParentRailFenceRefusal(live.tabId), false),
          ),
        );
      }
      if (live.sock.readyState !== WebSocket.OPEN) {
        if (opts.tabId && UiBridge.isMailboxable(cmd)) {
          this.storeMailbox(opts.tabId, cmd);
          return Promise.resolve(this.mailboxReceipt(opts.tabId));
        }
        return Promise.reject(
          markDispatched(new Error(`Panel tab ${live.tabId.slice(0, 8)} is not open`), false),
        );
      }
      // This is the last synchronous point after the graph lane has waited and
      // the receiver has been re-resolved. A handler-side callback run before
      // bridge.send() cannot fence a reconnect or same-workflow tab rebind in
      // that interval. A throwing callback is a pre-dispatch refusal: no frame
      // has been written and no mutation can have landed.
      try {
        opts.beforeDispatch?.();
      } catch (err) {
        return Promise.reject(
          markDispatched(err instanceof Error ? err : new Error(String(err)), false),
        );
      }
      return new Promise((resolve, reject) => {
        const requestedReconnectRetries = opts.maxReconnectRetries;
        const reconnectRetriesRemaining =
          requestedReconnectRetries === undefined
            ? UiBridge.MAX_RECONNECT_RETRIES
            : Number.isFinite(requestedReconnectRetries)
              ? Math.max(
                  0,
                  Math.min(
                    UiBridge.MAX_RECONNECT_RETRIES,
                    Math.floor(requestedReconnectRetries),
                  ),
                )
              : 0;
        const ctx: SendCtx = {
          resolve,
          reject,
          command: cmd,
          timeoutMs,
          // Canonical id of the resolved connection (NOT the caller's possibly-prefix
          // or migration-alias tabId) — the key the reconnect hello will use, so a
          // parked read is found and resumed.
          tabId: live.tabId,
          mutating: !UiBridge.READONLY_CMDS.has(cmd.cmd),
          // Timeout starts at DISPATCH, not enqueue: waiting for a sibling graph
          // read cannot itself produce the reporter's 30 s false timeout (#2069).
          deadline: Date.now() + timeoutMs,
          reconnectRetriesRemaining,
          // #2761 — captured HERE, on the connection that actually receives the
          // frame, not read back later from `conns` (by resume time the key may be
          // held by somebody else, which is the whole point of storing it).
          issuedToTabSessionId: live.tabSessionId,
          // #570 — graph ops resolve from the CALLER'S intended tab (opts.tabId), NOT
          // the canonical conn.tabId: after a same-socket switch the two differ, and
          // we must stamp the workflow the command was ISSUED FOR (so the panel, now
          // showing a different one, declines it) — never the workflow it happens to
          // have landed on. #884: for the SHARED SCOPE the orchestrator's resolver
          // answers with the current TURN's issue-time workflow — same rule,
          // conversation-level.
          //
          // #1815 — Manager / recovery / navigation commands do not act on that
          // workflow. They take the routed tab's advertised identity so a stale
          // conversation stamp cannot refuse a search, an install, a reboot, or the
          // workflow_list the documented rebind needs.
          workflowUuid:
            this.resolveTabWorkflowUuid?.(commandStampAddress(cmd, opts.tabId, live.tabId)) ??
            undefined,
          onDispatchedRid: (rid) => {
            releaseLane();
            opts.onDispatchedRid?.(rid);
          },
        };
        this.dispatch(live, ctx);
      });
    };
    if (usesGraphCommandLane(cmd.cmd)) {
      return this.enqueueGraphLane(conn.tabId, launch, graphLaneWaitsForReply(cmd.cmd));
    }
    return launch(() => {});
  }

  /** Serialize `graph_*` dispatches per tab so concurrent reads cannot occupy
   *  the panel at once (#2069). Targeted mutations release once the frame is
   *  written so a sibling widget write can dispatch while the first awaits its
   *  schema ACK (#2559). Failures still release the lane. */
  private enqueueGraphLane<T>(
    tabId: string,
    run: (releaseLane: () => void) => Promise<T>,
    waitForReply: boolean,
  ): Promise<T> {
    const prev = this.graphLane.get(tabId) ?? Promise.resolve();
    let releaseLane = () => {};
    const gate = waitForReply
      ? null
      : new Promise<void>((resolve) => {
          releaseLane = resolve;
        });
    const next = prev.then(
      () => run(releaseLane),
      () => run(releaseLane),
    );
    const tail: Promise<unknown> =
      waitForReply || !gate
        ? next.then(
            () => undefined,
            () => undefined,
          )
        : Promise.race([
            gate,
            next.then(
              () => undefined,
              () => undefined,
            ),
          ]);
    this.graphLane.set(tabId, tail);
    void tail.then(() => {
      if (this.graphLane.get(tabId) === tail) this.graphLane.delete(tabId);
    });
    return next;
  }

  /** Record that `ctx`'s command answered, so any still-waiting sibling on the
   *  same tab can refuse the frozen-tab diagnosis (#2069). */
  private noteSiblingSuccess(ctx: SendCtx, exceptRid: string): void {
    for (const [rid, p] of this.pending) {
      if (rid === exceptRid) continue;
      if (p.ctx.tabId !== ctx.tabId) continue;
      p.ctx.siblingReply ??= ctx.command.cmd;
    }
  }

  /** Record only the panel's structured current-view witness. This is a cache
   * of an authenticated panel reply, not caller-supplied command metadata. */
  private notePromotedScope(tabId: string, result: unknown): void {
    const parsed = this.parsePromotedScopeResult(result);
    if (parsed) this.promotedScopes.set(tabId, parsed);
  }

  /** Parse only structured `viewing` metadata. `undefined` means the command
   * did not publish a scope witness and must not overwrite the cache. */
  private parsePromotedScopeResult(result: unknown): TabPromotedScopeRead | undefined {
    if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
    const payload = result as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(payload, "viewing")) return undefined;
    const viewing = payload.viewing;
    if (!viewing || typeof viewing !== "object" || Array.isArray(viewing)) {
      return {
        known: false,
        reason: "the panel returned malformed current-view metadata",
      };
    }
    const identity = viewing as Record<string, unknown>;
    if (identity.scope !== "root" && identity.scope !== "subgraph") {
      return {
        known: false,
        reason: "the panel returned an unknown current-view scope",
      };
    }
    const rawOwner = identity.owner_node_id;
    let ownerNodeId: string | null = null;
    if (rawOwner !== undefined && rawOwner !== null) {
      if (
        (typeof rawOwner !== "number" || !Number.isSafeInteger(rawOwner)) &&
        (typeof rawOwner !== "string" || rawOwner.length === 0)
      ) {
        return {
          known: false,
          reason: "the panel returned a malformed current-view owner",
        };
      }
      ownerNodeId = String(rawOwner);
    }
    const rawWorkflowUuid = identity.workflow_uuid;
    if (
      rawWorkflowUuid !== undefined &&
      (typeof rawWorkflowUuid !== "string" || rawWorkflowUuid.length === 0)
    ) {
      return {
        known: false,
        reason: "the panel returned a malformed current-view workflow identity",
      };
    }
    const rawGraphIdentity = identity.graph_identity;
    if (
      rawGraphIdentity !== undefined &&
      (typeof rawGraphIdentity !== "string" ||
        rawGraphIdentity.length === 0 ||
        rawGraphIdentity.length > 256)
    ) {
      return {
        known: false,
        reason: "the panel returned a malformed current-view graph identity",
      };
    }
    return {
      known: true,
      scope: identity.scope,
      ownerNodeId,
      ...(rawWorkflowUuid !== undefined ? { workflowUuid: rawWorkflowUuid } : {}),
      ...(rawGraphIdentity !== undefined ? { graphIdentity: rawGraphIdentity } : {}),
    };
  }

  /** Write one attempt of a command to a live socket and arm its reply timer.
   *  Reused verbatim when an idempotent read is re-dispatched onto a fresh socket
   *  after a mid-command reconnect (so resume runs the exact same path as a first
   *  send). Rejections/resolutions go through the shared SendCtx. */
  private dispatch(conn: Conn, ctx: SendCtx): void {
    const cmd = ctx.command;
    // Never let a re-dispatch (reconnect resume) extend the caller's original
    // deadline — clamp the reply timeout to the time remaining.
    const remaining = ctx.deadline - Date.now();
    if (remaining <= 0) {
      ctx.reject(markReplyTimeout(new Error(noReplyTimeoutMessage(conn.tabId, ctx))));
      return;
    }
    const replyTimeoutMs = Math.min(ctx.timeoutMs, remaining);
    const rid = randomUUID();
    // Track an ask_user card's stable ask_id against this attempt's rid so a reply
    // that validates AFTER the reply timer fires (and drops out of `pending`) can
    // still be buffered for the caller by rid, not discarded (#486 late answer).
    const askId = (cmd as { ask_id?: unknown }).ask_id;
    if (typeof askId === "string" && askId) {
      this.pruneLateAsk();
      // INFERRED FROM THE COMMAND, never from a caller-supplied flag (#1352). A flag is
      // one forgotten argument away from journaling a credential, and the set of
      // secret-collecting commands is closed and known here.
      const sensitive = cmd.cmd === "request_secret";
      // Carry the ROUTED tab id with the mapping: the late-reply branch runs in a
      // scope that only knows the socket, and the journal needs the tab the card
      // was rendered on to address the answer.
      this.askRidToId.set(rid, {
        askId,
        ts: Date.now(),
        tabId: ctx.tabId,
        ...(sensitive ? { sensitive: true } : {}),
      });
    }
    // Rewrite an old-panel "Unknown command" rejection into an actionable
    // update-your-panel message (see makeUnknownCommandError). Applied to the
    // reply-error path only; the happy path and genuine command errors are
    // passed through untouched.
    const rejectMapped = (err: Error) => {
      const friendly = makeUnknownCommandError(err.message, connPanelVersionReading(conn));
      // Apply the learned verdict to the LIVE connection — following a same-socket
      // migration whose reply landed after the tmp:→wf: id change — so neither the
      // reactive #236 unsupported gate NOR the #422 proven veto is stranded on a
      // deleted conn (codex round-4/6 P1). Scoped to the dispatch socket (conn.sock) so a
      // reused id on a DIFFERENT socket is never touched; falls back to the captured conn.
      const target = this.liveConnForTab(ctx.tabId, conn.sock) ?? conn;
      if (friendly) {
        // Learned, not assumed (#236) — this exact connection just proved it
        // doesn't support cmd.cmd, so every later call in this session is gated
        // proactively (see the `send()` preflight above) instead of round-
        // tripping to the panel again.
        target.unsupportedCmds.add(cmd.cmd);
      }
      // …and it can no longer be "proven supported" — a genuine downgrade that
      // reintroduces the command clears the stale #422 veto so the gate re-applies.
      // Keyed on the RAW Unknown-command shape (not `friendly`): a panel advertising a
      // new-enough version suppresses the "too old" rewrite (friendly === null) yet its
      // Unknown-command reply still disproves prior support, so the veto must clear here.
      if (isUnknownCommandReply(err.message)) {
        target.provenSupportedCmds.delete(cmd.cmd);
      }
      // #1560 — a rewrite is still a REPLY. `friendly` is minted from an "Unknown
      // command" answer the panel sent, so the substituted error must carry the
      // same "something answered" mark the original does; dropping it here would
      // label a talking panel silent and send its user to hard-refresh a healthy
      // tab. PROPAGATED from the source error, never re-derived from the
      // replacement's wording.
      const mapped = friendly ? inheritPanelAnswered(err, friendly) : err;
      ctx.reject(inheritWorkflowListReadiness(err, mapped));
    };
    const timer = setTimeout(() => {
      this.pending.delete(rid);
      // #694 — remember that THIS rid was a mutation we stopped waiting for. The
      // panel may still reply; without this the reply is an unknown rid and the
      // message loop drops it, which is precisely how a write that landed stays
      // invisible to the caller who was told "outcome unknown".
      this.retainAbandonedMutation(rid, cmd.cmd, ctx.tabId);
      // This timer only fires AFTER sock.send() below returned successfully — the command
      // WAS WRITTEN to the socket; the tab (possibly backgrounded/frozen) merely didn't
      // reply in time and may still apply it. So this is a POST-write outcome: tag it
      // dispatched:true so a mutating caller (e.g. comfy_reboot readiness) treats it as an
      // accepted-but-unacked dispatch and verifies by observation, rather than mistaking a
      // genuinely-sent command for one that never went out (#509).
      //
      // #803 — name the FULL tab id, never the log-style 8-char slice. Routing tab
      // ids are `wf:<path>` / `tmp:<key>`, so an 8-char slice renders EVERY workflow
      // tab as the identical, alarming-looking `wf:workf`: two tabs timing out are
      // indistinguishable in the transcript and the id reads like a corrupted key
      // (it sent one diagnosis down a wrong path outright). Same call as the #709
      // refusal above. `isAckTimeout`/`isReplyTimeoutError` both segment the id with
      // a lazy `.+?` bounded by the fixed ` did not reply to "` delimiter, so a full
      // id CONTAINING SPACES (`wf:workflows/Untitled 2026-08-04.json`) still matches.
      ctx.reject(
        markReplyTimeout(
          markDispatched(new Error(noReplyTimeoutMessage(conn.tabId, ctx)), true),
        ),
      );
    }, replyTimeoutMs);
    const pending: Pending = {
      resolve: ctx.resolve,
      reject: rejectMapped,
      timer,
      sock: conn.sock,
      cmd: cmd.cmd,
      ctx,
    };
    this.pending.set(rid, pending);
    try {
      // #570 — stamp the intended workflow uuid so the panel refuses to APPLY this command
      // if it has since switched to a different workflow (a frame already delivered to the
      // browser cannot be retracted server-side; the client fences execution instead).
      //
      // workflow_uuid is BRIDGE-OWNED metadata, NEVER caller-settable (codex): a caller that
      // could supply its own workflow_uuid would just set it to the DESTINATION workflow after a
      // switch and sail past the panel fence. So ALWAYS overwrite with the trusted resolver value
      // (ctx.workflowUuid), and STRIP any caller-supplied value entirely when we have no trusted
      // one — an identity-less tab / old panel ships unstamped. Mutations are already refused by
      // the requiresWorkflowStampEnforcement gate above.
      //
      // #1519 — this used to add "reads execute, reply still server-fenced". THAT IS NOT TRUE of a
      // current panel. Its fence refuses an UNSTAMPED command outright, reads included, because
      // #718 closed exactly that fail-open hole ("An UNSTAMPED command is refused too … an
      // advertised fence must not fail open" — comfyui-mcp-panel.js). So a read dispatched from a
      // session with no trusted identity comes back as `workflow instance mismatch: this command
      // carries no workflow-instance stamp`, which is what #1519 reports.
      //
      // The two halves therefore hold incompatible contracts, both deliberate: this side expects
      // an unstamped read to run, that side refuses it. #1519's remaining slice is taken in the
      // orchestrator, not here: an inert graph read refused for a missing stamp has a first
      // fence minted from the live canvas and is retried once. This dispatch is still unstamped
      // when this side has no trusted identity — weakening #718, or adopting a WRONG stamp onto
      // a different workflow (removed from #1478 / #1646 for cause), is still not done here.
      // What is settled is that the old sentence described behaviour that does not happen —
      // and the USER-FACING half of the same claim is fixed: the write refusal above no longer
      // promises that graph reads still work when this side has no stamp to give them (see
      // `graphReadsRefusedToo`). Nothing about what is DISPATCHED changed here.
      //
      // #694 hardening: mint the rid LAST so a caller-supplied cmd.rid can NEVER
      // override it — the rid is BRIDGE-OWNED (reply correlation in `pending`,
      // the onDispatchedRid observer, and the panel's retry_of dedupe token all
      // key on it). Previously `{ rid, ...cmd }` let a caller cmd.rid clobber the
      // minted rid, silently breaking reply correlation for that command.
      const frame: Record<string, unknown> = { ...cmd, rid };
      // #2559 — the panel bounds duplicate-rid waits from THIS number. Use the
      // caller-requested timeout, not the remaining clamp: retry_of fingerprints
      // exclude only rid/retry_of, so a shrinking remainder would make a retry
      // look like a different command. Always overwrite after the spread (same
      // rule as rid).
      frame.timeout_ms = ctx.timeoutMs;
      if (ctx.workflowUuid) frame.workflow_uuid = ctx.workflowUuid;
      else delete frame.workflow_uuid;
      conn.sock.send(JSON.stringify(frame));
      this.rememberDeliveredMutation(rid, cmd.cmd, ctx.tabId, frame);
      try { ctx.onDispatchedRid?.(rid); } catch { /* observer faults are non-fatal */ }
    } catch (err) {
      clearTimeout(timer);
      this.pending.delete(rid);
      this.forgetDeliveredMutation(rid);
      // The write to the socket FAILED — the command was NEVER transmitted, so nothing
      // was dispatched (distinct from a POST-write mid-command drop). Surface that
      // explicitly so callers don't mistake it for an in-flight/accepted command (a
      // reboot readiness check must NOT treat a pre-write send failure as a fired reboot).
      // Carry an AUTHORITATIVE TYPED flag `dispatched:false` so a caller classifies this
      // categorically — never by string-matching a detail that might quote a post-write
      // phrase ("OUTCOME UNKNOWN") from the underlying socket error.
      const detail = err instanceof Error ? err.message : String(err);
      ctx.reject(
        markDispatched(
          new Error(
            `failed to send "${cmd.cmd}" to panel tab ${conn.tabId.slice(0, 8)} — the command was NOT dispatched (${detail})`,
          ),
          false,
        ),
      );
    }
  }

  /**
   * Remember a mutation the moment it is written, so a graph read or retry_of
   * can name the exact delivered command until the frontend settles (#2527).
   */
  private rememberDeliveredMutation(
    rid: string,
    cmd: string,
    tabId: string,
    frame: Record<string, unknown>,
  ): void {
    if (!rid || !this.lateMutationFilter?.(cmd)) return;
    this.pruneLateMutations();
    this.deliveredMutations.set(rid, {
      cmd,
      tabId,
      ts: Date.now(),
      frame: cloneDeliveredMutationFrame(frame),
      status: "in_flight",
    });
  }

  private forgetDeliveredMutation(rid: string): void {
    const hit = this.deliveredMutations.get(rid);
    if (!hit) return;
    this.deliveredMutations.delete(rid);
    if (hit.status === "timed_out") this.notifyMutationSettled(hit.tabId);
  }

  /**
   * Remember that we stopped waiting for `rid` so a later reply — a frozen tab
   * catching up, or a lost-reply replay after reconnect — is retained instead of
   * dropped as an unknown rid (#694, panel#1524).
   */
  private retainAbandonedMutation(rid: string, cmd: string, tabId: string): void {
    if (!rid || !this.lateMutationFilter?.(cmd)) return;
    this.pruneLateMutations();
    const prior = this.deliveredMutations.get(rid);
    if (prior) {
      prior.status = "timed_out";
      prior.ts = Date.now();
      return;
    }
    this.deliveredMutations.set(rid, {
      cmd,
      tabId,
      ts: Date.now(),
      frame: { cmd },
      status: "timed_out",
    });
  }

  /** A pending command's socket died before its reply arrived. Decide, WITHOUT
   *  ever risking double execution, whether to wait for the tab to reconnect and
   *  resume (idempotent reads) or surface an honest outcome-unknown/gone error. */
  private handleMidCommandDisconnect(pend: Pending, rid: string): void {
    const { ctx, cmd } = pend;
    const short = ctx.tabId.slice(0, 8);
    // Idempotent read, still within its deadline → park it for a bounded grace and
    // re-dispatch if the same tab re-hellos. Safe: re-running a read has no side
    // effect, and it was in `pending` (un-acked), so no reply was lost.
    if (
      !ctx.mutating &&
      ctx.reconnectRetriesRemaining > 0 &&
      Date.now() < ctx.deadline
    ) {
      // A replacement socket for this tab is ALREADY live (a reload/supersede whose
      // hello landed before this dead socket's close handler ran — so resume already
      // fired and won't fire again). Re-dispatch straight onto it instead of parking
      // and expiring as "gone". Safe: idempotent read, un-acked.
      //
      // #2761 — "a replacement socket is live under this key" is NOT "this tab is
      // back". `isProvenSameTab` is the same test resumeAwaitingReconnect applies;
      // without it this fast path is the earlier of the two ways a stranger gets
      // handed the read, and it fires FIRST (its hello beat the close handler), so
      // fixing only the resume would leave the race that is hardest to reproduce.
      // Unproven, fall through and park: if the issuing tab proves a return inside
      // the grace it still resumes, and if it does not, the timer below rejects —
      // which is the honest outcome.
      const live = this.conns.get(ctx.tabId);
      if (
        live &&
        live.sock !== pend.sock &&
        live.sock.readyState === WebSocket.OPEN &&
        isProvenSameTab(ctx, live)
      ) {
        ctx.reconnectRetriesRemaining -= 1;
        logger.info(
          `[ui-bridge] tab ${short} already reconnected — resuming "${cmd}" on the live socket`,
        );
        this.dispatch(live, ctx);
        return;
      }
      // #2761 — a read issued to a tab that never advertised a `tab_session_id`
      // can NEVER be resumed: no future hello can prove it is that tab. Parking it
      // would burn the caller's whole remaining budget on a wait with no reachable
      // success, so fail now and say why. This is the visible cost of the proof
      // rule, and it is deliberately loud rather than a silent stall.
      if (ctx.issuedToTabSessionId === undefined) {
        logger.info(
          `[ui-bridge] tab ${short} dropped mid-command ("${cmd}") without a browser-tab identity — a reconnect on this route key could not be proven to be the same tab, so it is not parked`,
        );
        ctx.reject(
          new Error(
            `panel tab ${short} disconnected mid-command ("${cmd}") and advertised no browser-tab identity, so a reconnect on this route key cannot be proven to be the same tab — the read was not resumed rather than risk answering with a different canvas. Retry once a tab is connected; updating the panel restores automatic resume.`,
          ),
        );
        return;
      }
      const unprovenAtDrop = live !== undefined;
      if (unprovenAtDrop) {
        logger.info(
          `[ui-bridge] tab ${short} route key is held by a connection that did not prove it is the same browser tab — not resuming "${cmd}" onto it; parking for a proven return`,
        );
      }
      ctx.reconnectRetriesRemaining -= 1;
      const list = this.awaitingReconnect.get(ctx.tabId) ?? [];
      const graceMs = Math.max(0, Math.min(UiBridge.RECONNECT_GRACE_MS, ctx.deadline - Date.now()));
      const entry: AwaitingReconnectEntry = {
        ctx,
        refusedUnprovenReturn: unprovenAtDrop,
        graceTimer: setTimeout(() => {
          this.removeAwaiting(ctx.tabId, entry);
          ctx.reject(
            new Error(
              // #2761 — "genuinely gone" is only true when nobody proved up on the
              // key. If a different browser tab did, say THAT: an operator looking
              // at a live panel would otherwise be told it had vanished, and the
              // remedy is different (re-issue against the tab you meant, not wait).
              entry.refusedUnprovenReturn
                ? `panel tab ${short} disconnected mid-command ("${cmd}") and the connection now holding its route key could not prove it is the same browser tab — the read was NOT resumed onto it, because its answer could describe a different canvas. Re-issue it against the tab you meant.`
                : `panel tab ${short} disconnected mid-command ("${cmd}") and did not reconnect within ${graceMs} ms — panel genuinely gone; retry once a tab is connected`,
            ),
          );
        }, graceMs),
      };
      list.push(entry);
      this.awaitingReconnect.set(ctx.tabId, list);
      logger.info(
        `[ui-bridge] tab ${short} dropped mid-command ("${cmd}") — awaiting reconnect up to ${graceMs} ms to resume (idempotent)`,
      );
      return;
    }
    // Mutating command (or read past its deadline): the request was ALREADY written
    // to the now-dead socket, so the panel/ComfyUI MAY have applied it. Reporting a
    // bare failure invites a blind retry that double-applies the action (e.g. a
    // second render). Say the outcome is UNKNOWN so the caller verifies first.
    if (ctx.mutating) {
      // panel#1524 — keep the rid so a lost-reply replay of a write that already
      // applied (a `graph_run` that queued a paid render) is retained, not dropped.
      // NEVER re-dispatch: resumeAwaitingReconnect is for idempotent reads only.
      this.retainAbandonedMutation(rid, cmd, ctx.tabId);
      ctx.reject(
        markMidCommandDisconnect(
          markDispatched(
            new Error(
              // #952 — the remedy depends on WHAT was interrupted. An interactive
              // card cannot be checked with queue/get_image, and a retry after a
              // reconnect duplicates it in front of a human.
              midCommandDisconnectMessage({ short, cmd }),
            ),
            true,
          ),
        ),
      );
    } else {
      ctx.reject(
        new Error(
          `panel tab ${short} disconnected mid-command ("${cmd}") — panel genuinely gone; retry once a tab is connected`,
        ),
      );
    }
  }

  private removeAwaiting(tabId: string, entry: AwaitingReconnectEntry): void {
    const list = this.awaitingReconnect.get(tabId);
    if (!list) return;
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.awaitingReconnect.delete(tabId);
  }

  /** A tab re-helloed: resume any idempotent reads parked for it on a mid-command
   *  disconnect by re-dispatching them onto the fresh socket.
   *
   *  #2761 — "a hello arrived for this key" is not "this tab is back". A `wf:`
   *  route key RECURS, so the connection now holding it may be a different browser
   *  tab that opened the same saved workflow; handing it a parked `graph_serialize`
   *  answers the departed caller with a stranger's canvas, and an agent then edits
   *  against it. So an entry resumes only onto a connection that PROVES it is the
   *  tab that issued it (`isProvenSameTab`). Everything else stays parked — its own
   *  grace timer decides — so a proven return later in the window is still served,
   *  and an unproven one never is. */
  private resumeAwaitingReconnect(tabId: string): void {
    const list = this.awaitingReconnect.get(tabId);
    if (!list || list.length === 0) return;
    const conn = this.conns.get(tabId);
    if (!conn) return;
    // Clear the key BEFORE dispatching, exactly as this did before #2761: a
    // re-dispatch that fails and re-parks must land in a fresh list, not be
    // clobbered by a write-back of the list we are iterating. Withheld entries
    // are merged onto whatever is there when the loop ends.
    this.awaitingReconnect.delete(tabId);
    const withheld: AwaitingReconnectEntry[] = [];
    for (const entry of list) {
      if (!isProvenSameTab(entry.ctx, conn)) {
        entry.refusedUnprovenReturn = true;
        withheld.push(entry);
        logger.warn(
          `[ui-bridge] tab ${tabId.slice(0, 8)} did not prove it is the browser tab that issued "${entry.ctx.command.cmd}" — withholding the parked read rather than answering its caller with another tab's canvas`,
        );
        continue;
      }
      clearTimeout(entry.graceTimer);
      logger.info(
        `[ui-bridge] tab ${tabId.slice(0, 8)} reconnected — resuming "${entry.ctx.command.cmd}"`,
      );
      this.dispatch(conn, entry.ctx);
    }
    // Withheld entries keep their LIVE grace timers, so they must stay in the
    // map: the timer alone would still reject the caller, but dropping the entry
    // here would put it out of reach of a later resume (the original tab
    // reclaiming its key inside the grace) and of dropQueuedDeliveries/stop(),
    // which cancel parked reads by walking this map.
    if (withheld.length > 0) {
      const reparked = this.awaitingReconnect.get(tabId);
      this.awaitingReconnect.set(tabId, reparked ? [...reparked, ...withheld] : withheld);
    }
  }

  /** Push a fire-and-forget frame. Targeted when tabId given, else broadcast.
   *  Truly fire-and-forget: if the target tab has gone, this no-ops (returns 0)
   *  rather than throwing — a throw here becomes an unhandled rejection in the
   *  async push call sites and would crash the orchestrator. */
  /** Inject the "does this tab have a live session?" predicate (SessionStore lives
   *  in the orchestrator). */
  setHasSessionPredicate(fn: (tabId: string) => boolean): void {
    this.hasSessionPredicate = fn;
  }

  /** #570 — inject the tabId → trusted workflow uuid resolver (tabStableIdentity lives in
   *  the orchestrator). Enables the per-command workflow-instance stamp/fence. */
  setTabWorkflowUuidResolver(
    fn: (tabId: string) => string | undefined,
    refresh?: (tabId: string, workflowUuid: string) => FenceAdoptOutcome,
  ): void {
    this.resolveTabWorkflowUuid = fn;
    this.refreshTabWorkflowUuid = refresh ?? null;
  }

  /** #1656 — inject the stamp-PROVENANCE predicate (see {@link isCarriedTabStamp}).
   *  Separate from the resolver on purpose: the resolver's value is still used to STAMP
   *  the frame (a carried stamp is better than none — #1331), and only the agreement
   *  gate is forbidden to accept it as evidence about the routed tab's canvas. */
  setCarriedTabStampPredicate(fn: (tabId: string) => boolean): void {
    this.isCarriedTabStamp = fn;
  }

  /** #1656 — inject the CORROBORATION half: "the live canvas was read and it is this
   *  instance". Deliberately NOT `refreshWorkflowUuid`. That one WRITES a stamp (and a
   *  conversation's issue-time stamp with it), which is a retarget the read-only mismatch
   *  probe must never perform (#1646); this one may only promote the PROVENANCE of a value
   *  that already matches, and the orchestrator's implementation refuses outright when it
   *  does not match. Nothing it can do changes which workflow anything is fenced to. */
  setTabStampCorroborator(fn: (tabId: string, workflowUuid: string) => boolean): void {
    this.corroborateTabStampFn = fn;
  }

  /**
   * #1656 — record that the routed tab's CURRENT stamp has been confirmed by a live read
   * of the canvas, so a value that was inherited on a same-socket re-hello stops being
   * treated as inherited by the dispatch-time agreement gate.
   *
   * Returns whether the corroboration was accepted. Never throws: this is a diagnostic
   * running inside a refusal path, and a diagnostic must never replace the outcome it is
   * describing.
   */
  corroborateTabStamp(tabId: string, workflowUuid: string): boolean {
    try {
      return this.corroborateTabStampFn?.(tabId, workflowUuid) === true;
    } catch {
      return false;
    }
  }

  /**
   * #2209 — RECONCILE the routed tab's stale advertisement with an identity the panel
   * has just reported for that same tab, so the recovery the gate's own refusal
   * prescribes can actually clear it.
   *
   * #1494 made the disagreement VISIBLE: `panel_set_workflow_target({mode:"current"})`
   * stopped claiming `bound` while the gate refused, because the two sides compare
   * different facts — the gate compares the session's stamp against the identity the
   * ROUTED TAB last advertised, the rebind compares it against the LIVE canvas. When the
   * advertisement is the stale side the rebind short-circuits (`already_current`) and
   * repairs nothing, so the only thing that ever cleared it was the panel noticing its
   * own drift and re-advertising — capped at MISMATCH_REHELLO_MAX_PER_IDENTITY (3), after
   * which the session is wedged for good. The reporter's workaround was to issue the
   * identical read twice and let the race settle it.
   *
   * This writes the advertisement the panel's own drift re-hello would write, from an
   * observation already in hand. THREE gates, and the middle one is the safety argument:
   *
   *  - only the `disagrees` arm. `carried` is an equal pair whose PROVENANCE is doubted,
   *    and it has its own non-writing remedy ({@link corroborateTabStamp}); the
   *    non-refusing kinds have nothing to reconcile.
   *  - the observation must EQUAL what the session already holds. So this can never
   *    re-point a session at another canvas: the value written is the one the session is
   *    already fenced to, and the only thing that changes is the routed tab's stale
   *    advertisement. Re-read HERE rather than trusted from the caller — the session's
   *    stamp can move between the caller's read and this write, and a stamp that moved
   *    makes the observation stale rather than reconcilable.
   *  - the write goes through the orchestrator's validator ({@link refreshWorkflowUuid}),
   *    addressed to the ROUTED tab's canonical id — the exact key the gate reads — so the
   *    uuid is re-checked for shape and origin binding and is never adopted off parsed
   *    prose, and a tab id that is not a scope address cannot touch any conversation's
   *    issue-time stamp.
   *
   * Being wrong is bounded: the panel authorizes a fenced command IFF the stamp equals
   * its LIVE active workflow, so a reconciliation the canvas has already moved past is
   * refused by the panel itself — exactly as it is for any session whose stamp equals the
   * last identity the panel reported. It cannot land a command on the wrong canvas.
   */
  reconcileStampTarget(
    tabId: string,
    observedWorkflowUuid: string,
  ):
    | { ok: true; routedTabId: string; replaced: string }
    | {
        ok: false;
        why: "unroutable" | "no_disagreement" | "stamp_moved" | "refused";
        /** The stale identity the routed tab is advertising — present only on the arms
         *  that FOUND a disagreement and could not reconcile it. */
        landedOn?: string;
        reason?: string;
      } {
    let routedTabId: string;
    try {
      routedTabId = this.resolveTarget(tabId).tabId;
    } catch {
      return { ok: false, why: "unroutable" };
    }
    const verdict = this.stampTargetVerdict(tabId, routedTabId);
    if (!verdict.refuses || verdict.kind !== "disagrees") {
      return { ok: false, why: "no_disagreement" };
    }
    if (verdict.issuedFor !== observedWorkflowUuid) {
      return {
        ok: false,
        why: "stamp_moved",
        landedOn: verdict.landedOn,
        reason: verdict.issuedFor,
      };
    }
    if (!this.refreshWorkflowUuid(routedTabId, observedWorkflowUuid)) {
      const reason = this.lastFenceRefusal(routedTabId);
      return { ok: false, why: "refused", landedOn: verdict.landedOn, ...(reason ? { reason } : {}) };
    }
    return { ok: true, routedTabId, replaced: verdict.landedOn };
  }

  /**
   * #1077 — WHY the last adoption for this tab was refused, if it was.
   *
   * The validator has three independent gates (the tab is unreachable, it does
   * not resolve to a real panel tab, or the identity did not validate) and every
   * one of them returned a bare `false`. The caller could only say "the adoption
   * was REFUSED", so a permanently-wedged session gave the user no way to tell
   * which gate tripped — and the reporter who traced this had NO orchestrator log
   * to fall back on, which is why the reason has to travel to the tool result
   * rather than only to stderr.
   *
   * It matters here more than a diagnostic usually would, because one of those
   * gates can be structurally unsatisfiable: without a server Origin,
   * workflowIdentityParts can NEVER validate and the fence can never be adopted,
   * no matter how many times the user refreshes the tab. The two transports that
   * used to land there have both been given one — the relay derives it from
   * COMFYUI_URL (#1077/#1240) and the token-gated tunnel/pairing listener now
   * reads it off the upgrade (#2757) — so what is left here is a genuinely
   * origin-less client: a non-browser one, or a proxy that strips the header.
   */
  lastFenceRefusal(tabId: string): string | undefined {
    return this.fenceRefusals.get(tabId);
  }

  /**
   * #716 — accept a command-stamp refresh only through the orchestrator's
   * validator.  A panel-tool response is not allowed to write bridge state
   * directly; missing/invalid values simply leave the existing fail-closed
   * stamp in place.
   */
  refreshWorkflowUuid(tabId: string, workflowUuid: string): boolean {
    const outcome = this.refreshTabWorkflowUuid?.(tabId, workflowUuid) ?? false;
    // Accepts the plain boolean too: the resolver is injected by the orchestrator
    // and by tests, and a bare `false` simply carries no reason to record.
    if (typeof outcome === "boolean") {
      if (outcome) this.fenceRefusals.delete(tabId);
      return outcome;
    }
    if (outcome.ok) {
      this.fenceRefusals.delete(tabId);
      return true;
    }
    this.fenceRefusals.set(tabId, outcome.reason);
    return false;
  }

  /**
   * #770/#803 — READ the trusted command stamp currently fencing `tabId`.
   *
   * TRI-STATE on purpose (codex gate). An earlier version returned
   * `string | undefined` and swallowed a throwing resolver into `undefined`,
   * which made "I could not read the fence" indistinguishable from "there is no
   * fence" — so a failed read rendered to the user as a definite absence, and the
   * recovery narrated a state nobody had observed. Since this is the ONLY window
   * onto the stamp, the distinction has to survive here or it is lost for good.
   *
   *  - `{ known: true, uuid }` — this tab IS fenced, by this uuid.
   *  - `{ known: true }`       — this tab is definitively NOT fenced (no resolver
   *                              value: an old panel, or an identity regression
   *                              cleared it).
   *  - `{ known: false }`      — the read itself failed; nothing is known.
   *
   * Never throws: the resolver is orchestrator-supplied, and a guard that can
   * throw is not a guard.
   */
  workflowUuidFor(tabId: string): TabWorkflowUuidRead {
    if (!this.resolveTabWorkflowUuid) {
      // No resolver injected at all — the stamp mechanism is not wired in this
      // process. That is a genuine "cannot know", not proof of an absent fence.
      return { known: false, reason: "no workflow-uuid resolver is installed on this bridge" };
    }
    try {
      const uuid = this.resolveTabWorkflowUuid(tabId);
      return { known: true, uuid: typeof uuid === "string" && uuid.length > 0 ? uuid : undefined };
    } catch (err) {
      return {
        known: false,
        reason: err instanceof Error ? err.message : String(err ?? "unknown error"),
      };
    }
  }

  /** The open DESKTOP tabs (non-headless primaries) for the mobile mirror picker. */
  desktopTabs(): Array<{ tab_id: string; title: string; has_session: boolean }> {
    const out: Array<{ tab_id: string; title: string; has_session: boolean }> = [];
    for (const [tabId, conn] of this.conns) {
      if (this.headlessSeen.has(tabId)) continue; // skip mobile/remote viewers
      out.push({
        tab_id: tabId,
        title: conn.title ?? "",
        has_session: this.hasSessionPredicate ? this.hasSessionPredicate(tabId) : false,
      });
    }
    return out;
  }

  /** Push the current desktop-tab list to every mirror subscriber — call when the
   *  connected-tab set or a session's live state changes so phones stay in sync. */
  broadcastTabList(): void {
    if (this.subscribers.size === 0) return;
    const frame = JSON.stringify({ type: "tab_list", tabs: this.desktopTabs() });
    const seen = new Set<BridgeSocket>();
    for (const set of this.subscribers.values()) {
      for (const sock of set) {
        if (seen.has(sock) || sock.readyState !== WebSocket.OPEN) continue;
        seen.add(sock);
        try {
          sock.send(frame);
        } catch {
          /* socket mid-disconnect — drop */
        }
      }
    }
  }

  push(frame: Record<string, unknown>, tabId?: string): number {
    let sent = 0;
    let targets: Conn[];
    if (tabId) {
      try {
        targets = [this.resolveTarget(tabId)];
      } catch {
        // Tab not connected (e.g. the user switched to another workflow and the
        // shared socket re-helloed under that workflow's id). Buffer for replay on
        // this tab's next hello, so a backgrounded agent's turn isn't lost.
        const q = this.missedFrames.get(tabId) ?? [];
        q.push(frame);
        if (q.length > UiBridge.MAX_MISSED_FRAMES) q.splice(0, q.length - UiBridge.MAX_MISSED_FRAMES);
        this.missedFrames.set(tabId, q);
        return 0;
      }
    } else {
      targets = Array.from(this.conns.values());
    }
    const payload = JSON.stringify(frame);
    for (const conn of targets) {
      if (conn.sock.readyState !== WebSocket.OPEN) continue;
      try {
        conn.sock.send(payload);
        sent += 1;
      } catch {
        // Tab mid-disconnect — drop.
      }
    }
    // Mirror fan-out: also deliver a tab-scoped frame to any phones mirroring this
    // tab (remote control). No-op when nothing is subscribed → existing panel
    // behavior unchanged. The primary is already in `targets`, so skip it here.
    // ONLY shared-session activity frames mirror (allowlist, default-deny) — this
    // is what keeps correlated/secret frames (acks, pair_url, secret_saved, OAuth,
    // history replies, tool_result) with the ONE socket that asked.
    if (tabId && typeof frame.type === "string" && MIRROR_SAFE_FRAME_TYPES.has(frame.type)) {
      // Look subscribers up under the RESOLVED (canonical) tab id: after a
      // migration, agents keep pushing under a tab's ORIGINAL id while its
      // subscribers moved to the new id, so `targets[0]` (the resolved primary)
      // holds the id the viewers are actually keyed under.
      const canonicalId = targets.length === 1 ? targets[0].tabId : tabId;
      const subs = this.subscribers.get(canonicalId);
      if (subs) {
        const primarySock = targets[0]?.sock;
        for (const sock of subs) {
          if (sock === primarySock || sock.readyState !== WebSocket.OPEN) continue;
          try {
            sock.send(payload);
            sent += 1;
          } catch {
            /* viewer mid-disconnect — drop */
          }
        }
      }
    }
    return sent;
  }

  async stop(): Promise<void> {
    // Fence FIRST, then cancel: a drain in flight must not schedule a successor
    // behind this call (codex round 4, P1).
    this.drainStopped = true;
    if (this.pendingDrain) {
      clearImmediate(this.pendingDrain);
      this.pendingDrain = null;
      this.drainScheduled = false;
    }
    if (this.preHandlerFrames.length > 0) {
      // Held frames die with the bridge. That is the honest end state — there is
      // nowhere left to deliver them — but it is never silent, because "the frame
      // vanished and nothing said so" is the whole of #1411.
      logger.warn(
        `[ui-bridge] stopping with ${this.preHandlerFrames.length} panel frame(s) still held ` +
          `and undelivered (#1411)`,
      );
      this.preHandlerFrames = [];
      this.preHandlerBytes = 0;
    }
    for (const armed of this.tabGoneTimers.values()) clearTimeout(armed.timer);
    this.tabGoneTimers.clear();
    if (this.bindRetryTimer) {
      clearTimeout(this.bindRetryTimer);
      this.bindRetryTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const [rid, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("bridge stopped"));
      this.pending.delete(rid);
    }
    for (const [tabId, list] of this.awaitingReconnect) {
      for (const entry of list) {
        clearTimeout(entry.graceTimer);
        entry.ctx.reject(new Error("bridge stopped"));
      }
      this.awaitingReconnect.delete(tabId);
    }
    for (const conn of this.conns.values()) {
      try {
        conn.sock.close();
      } catch {
        // Already gone.
      }
    }
    this.conns.clear();
    // …and every socket that never got as far as a hello. `wss.close()` below
    // waits on EVERY open socket, so closing only the tab-keyed ones left an
    // anonymous connection able to hang teardown indefinitely.
    for (const sock of this.sockets) {
      try {
        sock.close();
      } catch {
        // Already gone.
      }
    }
    this.sockets.clear();
    for (const s of this.extraServers.splice(0)) {
      try {
        s.close();
      } catch {
        // already gone
      }
    }
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    this.wss = null;
  }
}

/** Bind-host classification for the guard above. `0.0.0.0`/`::` are exposure
 *  (all interfaces), so they are NOT loopback for this purpose. */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

// Module-level singleton (the last bridge started in this process).
let bridgeInstance: UiBridge | null = null;

/**
 * #694 — SESSION EPOCH: one randomUUID minted per orchestrator PROCESS. Stamped
 * ONLY on the `models` push frame (orchestrator pushModels) — never per-command —
 * so the panel can scope its retry_of dedupe cache to the process that minted the
 * rids those tokens name: a restarted orchestrator's tokens can never collide with
 * a prior process's. Module-level so exactly one value exists per process.
 */
export const SESSION_EPOCH: string = randomUUID();

export function startUiBridge(port?: number, token?: string | null, host?: string): UiBridge {
  if (!bridgeInstance) {
    bridgeInstance = new UiBridge(
      port ??
        (Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || DEFAULT_BRIDGE_PORT),
      token ?? null,
      host ?? "127.0.0.1",
    );
    bridgeInstance.start();
  }
  return bridgeInstance;
}

export function getUiBridge(): UiBridge | null {
  return bridgeInstance;
}
