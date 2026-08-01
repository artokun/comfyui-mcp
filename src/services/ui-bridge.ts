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
import { logger } from "../utils/logger.js";
import { compareSemver } from "./self-update.js";

export const DEFAULT_BRIDGE_PORT = 9101;

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
 *  resolve/reject, the original command, and an absolute deadline so retries are
 *  always bounded. */
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
};

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
  /** The ComfyUI origin this tab's browser was served from (`comfyui_url` =
   *  window.location in its `hello`), if sent. Lets a tool bind an HTTP probe to the
   *  EXACT instance THIS tab fronts — not the process-global target, which a
   *  different instance's hello may have retargeted (#509). */
  originUrl?: string;
  /** SERVER-OBSERVED: the browser `Origin` header from THIS socket's WebSocket upgrade
   *  handshake (scheme://host:port of the page the panel runs in). Unlike `originUrl`
   *  (client-supplied `hello.comfyui_url`, spoofable by page JS), the browser sets Origin
   *  and forbids page scripts from overriding it — so it is the TRUSTED proof of which
   *  ComfyUI a real browser tab actually fronts. Undefined when the handshake carried no
   *  Origin (a non-browser / relay client). Used to gate the reboot self-probe (#509): a
   *  socket can CLAIM any comfyui_url, but only a page genuinely SERVED FROM the boot
   *  origin gets a matching handshake Origin, so we never certify a same-instance cycle
   *  from a spoofed origin. */
  serverOrigin?: string;
  /** SERVER-TRUSTED: the socket arrived on the token-less loopback primary listener
   *  (a browser on the orchestrator's OWN host). False for relay/tunnel/LAN/pairing
   *  connections, whose advertised loopback origin is NOT the orchestrator's host
   *  and must not be directly health-probed (#509). */
  local: boolean;
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
export const BRIDGE_CMD_MIN_PANEL_VERSION: Readonly<Record<string, string>> = {
  graph_outline: "0.4.6",
  graph_find_nodes: "0.4.6",
  graph_query: "0.7.0",
  graph_serialize: "0.8.2",
};

/** The minimum panel version that supports `cmd`. */
export function minPanelVersionForCmd(cmd: string): string {
  return BRIDGE_CMD_MIN_PANEL_VERSION[cmd] ?? MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS;
}

/** A version string compareSemver can actually parse. compareSemver returns 0
 *  BOTH for "equal" and for "unparseable", so callers that must distinguish an
 *  unparseable input from a genuine tie (like panelSupportsCmd's `>= 0`) have to
 *  screen the input first — otherwise `panel_version: "dev"` would compare as 0
 *  and be mistaken for a match. */
const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

/** True when the panel ADVERTISED a PARSEABLE version (in its `hello`) that already
 *  meets `cmd`'s real minimum — i.e. this panel is new enough to support the command,
 *  so an "Unknown command" reply is NOT an age problem and must never be rewritten
 *  into a "too old — update your panel" verdict (#352 false negative). Missing OR
 *  unparseable panelVersion → we can't PROVE it's new enough, so treat as not-proven
 *  (fall through to the honest too-old path, which quotes the correct minimum, and
 *  keep the #236 learning path intact). */
function panelSupportsCmd(cmd: string, panelVersion?: string): boolean {
  if (!panelVersion || !SEMVER_RE.test(panelVersion.trim())) return false;
  return compareSemver(panelVersion, minPanelVersionForCmd(cmd)) >= 0;
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
 *  earlier call in the same session) so both produce the identical message. The
 *  quoted minimum is COMMAND-SPECIFIC (#352) — not a blanket 0.11.4. */
function buildPanelTooOldError(cmd: string, panelVersion?: string): Error {
  const detected = panelVersion ? ` (detected ${panelVersion})` : "";
  const e = new Error(
    `This ComfyUI-MCP panel is too old for "${cmd}"${detected} — update the ComfyUI-MCP panel ` +
      `to ≥${minPanelVersionForCmd(cmd)} (ComfyUI Manager → update comfyui-mcp panel), then reconnect.`,
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
 *  rewrite, the raw panel "Unknown command" text or the rewritten "too old for"
 *  message. Callers that carry a graceful fallback (e.g. panel_strip_workflow's
 *  graph_get_state reconstruction, #384/#413) use this to decide whether to try
 *  it. When `cmd` is given, a structured tag must match it. */
export function isPanelCmdUnsupportedError(err: unknown, cmd?: string): boolean {
  const tag = (err as Partial<PanelCmdUnsupportedError> | null | undefined)
    ?.panelCmdUnsupported;
  if (typeof tag === "string") return cmd == null || tag === cmd;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const cmdPat = cmd ? cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "[\\w.-]+";
  return (
    new RegExp(`unknown command\\s*["“']?${cmdPat}`, "i").test(msg) ||
    new RegExp(`too old for\\s*["“']?${cmdPat}`, "i").test(msg)
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
 */
/** The panel dispatcher's raw "Unknown command" reply shape (anchored, quote- and
 *  case-tolerant). Shared by makeUnknownCommandError and isUnknownCommandReply so the
 *  reactive rewrite and the #422 veto-revocation agree on exactly one definition. */
const UNKNOWN_COMMAND_RE = /^unknown command\s*["“']?([\w.-]+)["”']?/i;

/** True when `error` is the panel's own "Unknown command" dispatch reply — proof this
 *  build does NOT implement the command, INDEPENDENT of any advertised-version guard
 *  (#422). Used to revoke a stale proven-supported veto even when the version is new
 *  enough to suppress the "too old" rewrite, so a genuine downgrade always re-gates. */
export function isUnknownCommandReply(error: string): boolean {
  return UNKNOWN_COMMAND_RE.test(String(error ?? "").trim());
}

export function makeUnknownCommandError(
  error: string,
  panelVersion?: string,
): Error | null {
  // Match the panel's exact shape: `Unknown command "graph_query"` (quotes
  // optional/variable). ANCHORED at the start of the (trimmed) message so an
  // unrelated error that merely QUOTES an unknown-command phrase somewhere in its
  // text is never rewritten — only the panel dispatcher's own reply, which is
  // exactly this string. Case-insensitive, tolerant of straight or smart quotes.
  const m = UNKNOWN_COMMAND_RE.exec(error.trim());
  if (!m) return null;
  const cmd = m[1];
  // #352 FALSE-NEGATIVE GUARD: if the panel advertised a version that already
  // meets this command's real minimum, the panel is NOT too old — an "Unknown
  // command" reply here means something else (a genuinely retired/renamed command,
  // or a transient), so do NOT rewrite it into a bogus "update your panel" verdict
  // (which would also POISON the #236 unsupported-cmd gate against a capable panel).
  // Return null so the raw error surfaces and the gate is never poisoned.
  if (panelSupportsCmd(cmd, panelVersion)) return null;
  return buildPanelTooOldError(cmd, panelVersion);
}

/**
 * Bridge commands with NO side effect — safe to re-dispatch after a reconnect and
 * safe to WAIT ON longer (a read can't be double-applied). Module-level so both
 * the mutating-vs-read classification and the default-timeout policy share one
 * authoritative list. Everything not listed is treated as mutating.
 */
export const BRIDGE_READONLY_CMDS: ReadonlySet<string> = new Set<string>([
  "graph_serialize",
  "graph_outline",
  "graph_get_errors",
  "graph_get_state",
  "graph_get_subgraph",
  "graph_view_selected",
  "graph_view_nodes_in_viewport",
  "graph_prompt_director_audit",
  "graph_query",
  "civitai_results",
  "get_todo",
]);

/** Tight default reply timeout for a MUTATING command with no explicit timeout —
 *  fail fast so the agent isn't blocked on a stuck write. */
export const BRIDGE_DEFAULT_TIMEOUT_MS = 6000;
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

/** Normalize a WebSocket handshake `Origin` header into a canonical scheme://host:port
 *  string, or undefined when it is absent, the opaque literal `"null"` (a sandboxed /
 *  file:// / data: origin, which proves nothing), or unparseable. The browser sets this
 *  header on the upgrade and forbids page JS from overriding it, so a value here is
 *  server-trusted provenance of the page the socket runs in. Host case is lowercased and
 *  the default port made explicit so it compares cleanly against a probe base. */
function normalizeHandshakeOrigin(raw: string | string[] | undefined): string | undefined {
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (typeof val !== "string" || val === "" || val.toLowerCase() === "null") return undefined;
  try {
    const u = new URL(val);
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

/** Tag an error as a reply-timeout and return it (for throw/reject). */
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
   *  STABLE tab id (the phone persists one). In-memory: survives disconnect ⇄
   *  reconnect within an orchestrator run, not a full orchestrator restart.
   *  Bounded per tab + TTL'd. */
  private readonly mailbox = new Map<string, Array<{ cmd: BridgeCommand; ts: number }>>();
  private static readonly MAILBOX_MAX = 30;
  private static readonly MAILBOX_TTL_MS = 24 * 60 * 60 * 1000;
  /** Tab ids that ever connected as a headless (mobile/remote) client — kept so
   *  `isHeadless` stays true across a disconnect (see isHeadless). */
  private readonly headlessSeen = new Set<string>();
  private seenTabs = new Set<string>(); // tabIds ever announced — dedup connect logs across reconnect churn
  /** Frames pushed at a tab with NO live connection, buffered for replay when that
   *  tab re-hellos. Per-workflow sessions re-target ONE socket between workflow tab
   *  ids, so a backgrounded workflow's agent output would otherwise be dropped on
   *  the floor and its finished turn lost to the user. Complements the send()-path
   *  `mailbox` (which buffers show_media command deliveries): this one buffers
   *  push()-path frames (agent turn output). Bounded per tab. */
  private missedFrames = new Map<string, Record<string, unknown>[]>();
  private static readonly MAX_MISSED_FRAMES = 100;
  private pending = new Map<string, Pending>();
  /** ask_user card sends (rid → {ask_id, ts}): lets a reply that validates AFTER
   *  the reply timer fired (dropped from `pending`) still be buffered for the
   *  caller, instead of being discarded as a "late reply for a timed-out command"
   *  (#486). Timestamped so an abandoned mapping (timeout/disconnect/send-failure
   *  whose late reply never arrives) is TTL-pruned rather than kept forever. */
  private askRidToId = new Map<string, { askId: string; ts: number }>();
  /** Buffered late-but-valid ask_user answers (ask_id → result), drained by the
   *  caller via takeLateAskReply(). Bounded by a short TTL — a stale unclaimed
   *  answer is pruned rather than kept forever. */
  private lateAskReplies = new Map<string, { result: unknown; ts: number }>();
  /** TTL for a buffered late ask answer / an unresolved rid→ask_id mapping. Long
   *  enough to cover a slow human pick within the MCP tools/call budget, short
   *  enough that abandoned entries don't accumulate. */
  private static readonly LATE_ASK_TTL_MS = 5 * 60 * 1000;
  /** In-flight IDEMPOTENT reads whose socket dropped mid-command, parked per tabId
   *  waiting a bounded grace for that tab to reconnect so we can re-dispatch them
   *  (resume) instead of hard-failing. Never holds mutating commands. */
  private awaitingReconnect = new Map<string, Array<{ ctx: SendCtx; graceTimer: ReturnType<typeof setTimeout> }>>();
  /** How long a dropped idempotent read waits for its tab to re-hello before we
   *  declare the panel genuinely gone. Bounded so a caller never hangs. */
  private static readonly RECONNECT_GRACE_MS = 4000;
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
  /** Tab the user most recently typed in — the default command target. */
  private lastActiveTabId: string | null = null;
  /** Resolves true once the port is bound, false if binding ultimately fails. */
  private readyPromise: Promise<boolean> | null = null;
  private readyResolve: ((ok: boolean) => void) | null = null;

  /** Called for panel-initiated frames (no rid): user messages, hellos. */
  onPanelMessage: ((event: PanelEvent) => void) | null = null;

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
        logger.warn(
          `[ui-bridge] port ${this.port} still in use after ${UiBridge.MAX_BIND_ATTEMPTS} attempts — another comfyui-mcp session likely owns the panel. This session's MCP tools still work, but panel_* commands are unavailable until that session exits.`,
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
      // SERVER-OBSERVED handshake Origin (the browser sets it and forbids page JS from
      // overriding it) — the trusted proof of which page this socket runs in, distinct
      // from the spoofable hello.comfyui_url (#509 self-probe gate).
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
  attachRelayConnection(sock: BridgeSocket): void {
    this.handleConnection(sock);
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
      wss.on("connection", (sock) => {
        this.missedPongs.set(sock, 0);
        sock.on("pong", () => this.missedPongs.set(sock, 0));
        this.handleConnection(sock);
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
   * @param local SERVER-TRUSTED provenance: true only when the socket arrived on
   *   the token-less loopback primary listener, i.e. a browser genuinely on the
   *   orchestrator's own host. A token-gated/tunnel-fronted primary, a relay shim,
   *   and any LAN/pairing listener are all `false` — a browser reaching those can
   *   sit on a DIFFERENT machine yet advertise its OWN 127.0.0.1 ComfyUI, which
   *   must never be treated as the orchestrator's local host (#509).
   * @param serverOrigin SERVER-OBSERVED handshake `Origin` (scheme://host:port), captured
   *   from the WebSocket upgrade — NOT client-supplied. Undefined for non-browser/relay
   *   connections. Bound to the tab so the reboot self-probe can trust which page it fronts.
   */
  private handleConnection(sock: BridgeSocket, local = false, serverOrigin?: string): void {
    // The connection is anonymous until its hello frame names a tab id.
    let tabId: string | null = null;
    // A socket's KIND (canvas-owning panel vs headless viewer) is pinned on its
    // FIRST hello and is authoritative thereafter. The `headless` flag on later
    // hellos is client-controlled, so a headless viewer could otherwise flip it to
    // `false` to pass the same-kind takeover check and seize a desktop tab's id.
    let socketHeadless: boolean | null = null;
    // #422: capability proven under a PRE-MIGRATION tab id (tmp:<uuid> → wf:<hash>,
    // same socket/panel) so the veto survives the id change. The retiring conn is
    // deleted during migration below; without carrying this, a graph-edit-triggered
    // migration + undercutting-version hello would reintroduce the false "too old" gate.
    let migratedProvenSupported: Set<string> | undefined;

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
          // ids (random UUID → tmp:<uuid> → wf:<hash>). A single-hop lookup on
          // the ORIGINAL id would land on the dead intermediate — rewrite every
          // entry pointing at the id being retired so any historical id resolves
          // to the LIVE tab in one step, and the map never grows chains. Entries
          // are SOCKET-SCOPED (codex review): wf:<hash> ids are deterministic and
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
          this.conns.delete(tabId);
          // Move mirror subscribers to the migrated tab id so viewers keep this
          // tab's live feed across a same-socket re-hello.
          const migSubs = this.subscribers.get(tabId);
          if (migSubs) {
            this.subscribers.delete(tabId);
            const dest = this.subscribers.get(msg.tab_id as string) ?? new Set<BridgeSocket>();
            for (const s of migSubs) dest.add(s);
            this.subscribers.set(msg.tab_id as string, dest);
          }
          // Re-point any viewers driving the OLD id at the new one so their input
          // keeps reaching this tab's session across the re-hello.
          for (const [s, drivenTab] of this.mirrorViewers) {
            if (drivenTab === tabId) this.mirrorViewers.set(s, msg.tab_id as string);
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
        this.conns.set(tabId, {
          sock,
          tabId,
          title: typeof msg.title === "string" && msg.title ? msg.title : "untitled",
          connectedAt: existing?.connectedAt ?? new Date().toISOString(),
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
          // wf:<hash>) tab id — that could let an unrelated instance's origin certify
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
        });
        // CONSUME the migration carry-over exactly once: it belongs to THIS hello's
        // conn only. Leaving it set would let a LATER same-socket re-hello rebuild the
        // proven veto from the stale pre-migration set — even after a genuine
        // Unknown-command reply cleared it — re-bypassing the undercut-version gate
        // (codex round-8 P1).
        migratedProvenSupported = undefined;
        if (incomingHeadless) this.headlessSeen.add(tabId);
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
        // Replay anything this tab's agent produced while the tab had no live
        // connection (its socket was re-helloed to another workflow). The panel
        // swaps to this workflow's thread synchronously before these frames can be
        // processed, so they render + record into the RIGHT conversation.
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
        // Resume any idempotent reads that were dropped mid-command by this tab's
        // previous socket (bounded reconnect grace) onto the fresh connection.
        this.resumeAwaitingReconnect(tabId);
        this.onPanelMessage?.(msg as PanelEvent);
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
          const entry = this.askRidToId.get(rid);
          if (entry) {
            this.askRidToId.delete(rid);
            if (msg.ok) {
              this.pruneLateAsk();
              this.lateAskReplies.set(entry.askId, { result: msg.result, ts: Date.now() });
            }
          }
          return;
        }
        clearTimeout(p.timer);
        this.pending.delete(rid);
        this.askRidToId.delete(rid);
        if (msg.ok) {
          // #422 — the panel DEMONSTRABLY served this command. Record it on the LIVE
          // connection (following a same-socket tmp:→wf: migration whose reply landed
          // after the id change), so a later re-hello advertising an undercutting
          // version can never re-gate it as "too old". Scoped to THIS reply's socket so
          // an unrelated tab reusing the id can never be granted the veto.
          const served = this.liveConnForTab(p.ctx.tabId, sock);
          served?.provenSupportedCmds.add(p.cmd);
          p.resolve(msg.result);
        } else {
          p.reject(new Error(String(msg.error ?? "panel reported an error")));
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
          if (msg.type === "user_message") this.lastActiveTabId = effectiveTab;
        }
        this.onPanelMessage?.(msg as PanelEvent);
      }
    });

    sock.on("close", () => {
      // Prune this socket's migration aliases — they can only ever route to
      // this socket (socket-scoped), so they're inert once it dies. Keeps the
      // map bounded over long-lived orchestrators (codex review).
      for (const [from, entry] of this.tabMigrations) {
        if (entry.sock === sock) this.tabMigrations.delete(from);
      }
      // Drop this socket from any mirror subscriptions (it was a viewer).
      for (const [tid, set] of this.subscribers) {
        if (set.delete(sock) && set.size === 0) this.subscribers.delete(tid);
      }
      this.mirrorViewers.delete(sock);
      let wasPrimary = false;
      if (tabId && this.conns.get(tabId)?.sock === sock) {
        wasPrimary = true;
        this.conns.delete(tabId);
        if (this.lastActiveTabId === tabId) this.lastActiveTabId = null;
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
      // An in-flight command's socket just died. Instead of hard-failing every one
      // with a bare "disconnected" (which reads as a clean failure and invites a
      // blind retry — double render for a run), hand each to the disconnect handler:
      // idempotent reads wait a bounded grace for the tab to reconnect and resume;
      // mutating commands surface an honest OUTCOME-UNKNOWN error.
      for (const [rid, p] of this.pending) {
        if (p.sock === sock) {
          clearTimeout(p.timer);
          this.pending.delete(rid);
          this.handleMidCommandDisconnect(p);
        }
      }
    });
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

  /** SERVER-OBSERVED origin (scheme://host:port) of the given tab's WebSocket handshake —
   *  the page the browser was actually serving when it opened this socket. Unlike
   *  {@link tabOrigin} (client-supplied `hello.comfyui_url`, spoofable), the browser sets
   *  the handshake `Origin` and blocks page JS from forging it, so this is the TRUSTED
   *  proof of which ComfyUI a real tab fronts — the origin the reboot self-probe binds to
   *  (#509). Undefined when the handshake carried no usable Origin. Resolves migration
   *  aliases like tabOrigin; never throws. */
  tabServerOrigin(tabId: string): string | undefined {
    try {
      return this.resolveTarget(tabId).serverOrigin;
    } catch {
      return undefined;
    }
  }

  /** SERVER-TRUSTED: true only when this tab's socket arrived on the token-less
   *  loopback primary listener (a browser on the orchestrator's OWN host), so its
   *  advertised loopback ComfyUI origin really is the orchestrator's local host and
   *  may be directly health-probed (#509). Relay/tunnel/LAN/pairing tabs → false.
   *  Resolves migration aliases like tabOrigin; unknown → false. */
  tabIsLocal(tabId: string): boolean {
    try {
      return this.resolveTarget(tabId).local === true;
    } catch {
      return false;
    }
  }

  /** True when the tab advertised itself as a canvas-less (mobile/remote) client
   *  in its `hello`. Unknown tabs → false. */
  isHeadless(tabId: string): boolean {
    // Sticky: a tab that EVER connected headless stays "headless" even while
    // offline, so a render finishing during a disconnect is byte-inlined (not a
    // bytes-less viewRef) and is renderable when the mailbox flushes to the phone.
    return this.conns.get(tabId)?.headless === true || this.headlessSeen.has(tabId);
  }

  /** Drop expired late-ask entries (buffered answers + unresolved rid mappings) so
   *  an abandoned card never leaks memory. Cheap; called on each ask send/take. */
  private pruneLateAsk(): void {
    const now = Date.now();
    for (const [id, e] of this.lateAskReplies) {
      if (now - e.ts > UiBridge.LATE_ASK_TTL_MS) this.lateAskReplies.delete(id);
    }
    // TTL-prune abandoned rid→ask_id mappings (a card that timed out / dropped and
    // whose late reply never came), so they don't linger past the window a caller
    // could still claim them.
    for (const [rid, e] of this.askRidToId) {
      if (now - e.ts > UiBridge.LATE_ASK_TTL_MS) this.askRidToId.delete(rid);
    }
    // Belt-and-suspenders cardinality cap in case of a burst of asks within one TTL
    // window — drop the oldest-inserted mappings so the map can never grow unbounded.
    if (this.askRidToId.size > 256) {
      const excess = this.askRidToId.size - 256;
      let i = 0;
      for (const rid of this.askRidToId.keys()) {
        if (i++ >= excess) break;
        this.askRidToId.delete(rid);
      }
    }
  }

  /** Retrieve (and remove) a late-but-valid ask_user answer buffered for `askId`
   *  after the card-reply timeout, or undefined if none arrived. The panel_ask
   *  handler polls this for a bounded grace so a slow-but-valid pick is honored
   *  rather than discarded (#486). */
  takeLateAskReply(askId: string): unknown | undefined {
    this.pruneLateAsk();
    const e = this.lateAskReplies.get(askId);
    if (!e) return undefined;
    this.lateAskReplies.delete(askId);
    return e.result;
  }

  /** All currently connected tabs, most recent hello last. */
  tabs(): PanelTab[] {
    return Array.from(this.conns.values()).map((c) => ({
      tab_id: c.tabId,
      title: c.title,
      connected_at: c.connectedAt,
    }));
  }

  status(): string {
    if (this.portInUse) {
      return `port ${this.port} is held by another comfyui-mcp session — close that session (or whatever owns the port) and reconnect`;
    }
    if (this.conns.size === 0) {
      return "no panel connected — open ComfyUI with the comfyui-mcp-panel pack installed and check the Agent sidebar tab";
    }
    const lines = this.tabs().map(
      (t) =>
        `- tab ${t.tab_id.slice(0, 8)} “${t.title}”${t.tab_id === this.lastActiveTabId ? " (last active)" : ""}`,
    );
    return `${this.conns.size} panel tab(s) connected:\n${lines.join("\n")}`;
  }

  /** Resolve which tab a command should go to. */
  private resolveTarget(tabId?: string): Conn {
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
      // socket that created the migration (wf:<hash> ids recur — an unrelated
      // later tab reusing the id must not inherit someone else's alias).
      if (prefixed.length === 0) {
        const migrated = this.tabMigrations.get(tabId);
        if (migrated) {
          const target = this.conns.get(migrated.to);
          if (target && target.sock === migrated.sock) return target;
        }
      }
      if (prefixed.length === 1) return prefixed[0];
      throw new Error(
        prefixed.length > 1
          ? `tab_id "${tabId}" is ambiguous — matches ${prefixed.length} tabs`
          : `no connected tab with id "${tabId}". Connected: ${this.tabs()
              .map((t) => `${t.tab_id.slice(0, 8)} (“${t.title}”)`)
              .join(", ") || "none"}`,
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

  /** The LIVE connection for a (possibly RETIRED) canonical tab id, scoped to the SOCKET
   *  that produced the reply. Returns the conn under `tabId` when it is STILL that exact
   *  socket, else the socket-scoped migration target it was renamed to (tmp:→wf:). Used
   *  by the #422 proven-supported bookkeeping so an in-flight reply that lands AFTER a
   *  same-socket re-hello migration records/clears on the migrated connection — and NEVER
   *  on an UNRELATED tab that reused the (recurring wf:<hash> / recycled tmp:) id on a
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
   *  vs. interactive canvas ops that should just fail. */
  private static isMailboxable(cmd: BridgeCommand): boolean {
    return cmd.cmd === "show_media";
  }

  private storeMailbox(tabId: string, cmd: BridgeCommand): void {
    const box = this.mailbox.get(tabId) ?? [];
    box.push({ cmd, ts: Date.now() });
    while (box.length > UiBridge.MAILBOX_MAX) box.shift();
    this.mailbox.set(tabId, box);
    logger.info(
      `[ui-bridge] mailboxed "${cmd.cmd}" for offline tab ${tabId.slice(0, 8)} (${box.length} queued)`,
    );
  }

  /** Deliver any buffered render frames to a tab that just (re)connected, plus a
   *  `mailbox_flush` summary so the client can notify "N renders finished while
   *  you were away". Expired items (past TTL) are dropped. */
  private flushMailbox(tabId: string): void {
    const box = this.mailbox.get(tabId);
    if (!box || box.length === 0) return;
    this.mailbox.delete(tabId);
    const conn = this.conns.get(tabId);
    if (!conn) return;
    const now = Date.now();
    const fresh = box.filter((m) => now - m.ts <= UiBridge.MAILBOX_TTL_MS);
    for (const m of fresh) {
      try {
        conn.sock.send(JSON.stringify({ rid: randomUUID(), ...m.cmd, mailbox: true }));
      } catch {
        // socket raced closed; drop
      }
    }
    if (fresh.length > 0) {
      try {
        conn.sock.send(JSON.stringify({ type: "mailbox_flush", count: fresh.length }));
      } catch {
        /* best-effort */
      }
      logger.info(
        `[ui-bridge] flushed ${fresh.length} mailboxed frame(s) to reconnected tab ${tabId.slice(0, 8)}`,
      );
    }
  }

  send(cmd: BridgeCommand, opts: { tabId?: string; timeoutMs?: number } = {}): Promise<unknown> {
    // #357: read (idempotent) ops get a more tolerant default so a busy-but-alive
    // panel main thread (e.g. Preview3D loading a large FBX) isn't declared frozen;
    // mutating ops keep the tight default. An explicit opts.timeoutMs always wins.
    const timeoutMs = opts.timeoutMs ?? defaultBridgeTimeoutMs(cmd.cmd);
    let conn: Conn;
    try {
      conn = this.resolveTarget(opts.tabId);
    } catch (err) {
      // Offline target: buffer a finished-render delivery for reconnect instead of
      // failing, so the agent's "here's your image" isn't lost while the phone is away.
      if (opts.tabId && UiBridge.isMailboxable(cmd)) {
        this.storeMailbox(opts.tabId, cmd);
        return Promise.resolve({ ok: true, mailboxed: true });
      }
      // resolveTarget threw BEFORE any socket write — no tab could be routed to (no
      // connected tab / ambiguous / multiple / not reachable), so nothing was
      // transmitted. Tag the rejection with the AUTHORITATIVE typed flag
      // dispatched:false so a caller classifies "nothing applied" categorically (reboot
      // readiness; the mutating-command rebind hint, panel #442) — never by
      // string-matching a message whose text a post-dispatch executor error could quote.
      return Promise.reject(markDispatched(err instanceof Error ? err : new Error(String(err)), false));
    }
    // #236 — proactively gate a command this exact connection has already proven
    // unsupported (see Conn.unsupportedCmds), instead of dispatching it again just
    // to have the panel reject it and re-parse the same "Unknown command" string.
    // Never a false gate: membership here is only ever set from a REAL rejection
    // on THIS connection (in dispatch()'s rejectMapped below), never inferred from
    // panelVersion alone.
    if (conn.unsupportedCmds.has(cmd.cmd)) {
      return Promise.reject(buildPanelTooOldError(cmd.cmd, conn.panelVersion));
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
      return Promise.reject(buildPanelTooOldError(cmd.cmd, conn.panelVersion));
    }
    if (conn.sock.readyState !== WebSocket.OPEN) {
      if (opts.tabId && UiBridge.isMailboxable(cmd)) {
        this.storeMailbox(opts.tabId, cmd);
        return Promise.resolve({ ok: true, mailboxed: true });
      }
      // The resolved socket is not OPEN — the command cannot be written, so nothing is
      // dispatched. Typed dispatched:false, same as the resolveTarget refusal above.
      return Promise.reject(
        markDispatched(new Error(`Panel tab ${conn.tabId.slice(0, 8)} is not open`), false),
      );
    }
    return new Promise((resolve, reject) => {
      const ctx: SendCtx = {
        resolve,
        reject,
        command: cmd,
        timeoutMs,
        // Canonical id of the resolved connection (NOT the caller's possibly-prefix
        // or migration-alias tabId) — the key the reconnect hello will use, so a
        // parked read is found and resumed.
        tabId: conn.tabId,
        mutating: !UiBridge.READONLY_CMDS.has(cmd.cmd),
        deadline: Date.now() + timeoutMs,
      };
      this.dispatch(conn, ctx);
    });
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
      ctx.reject(
        markReplyTimeout(
          new Error(
            `Panel tab ${conn.tabId.slice(0, 8)} did not reply to "${cmd.cmd}" within ${ctx.timeoutMs} ms — the ComfyUI tab may be backgrounded or frozen`,
          ),
        ),
      );
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
      this.askRidToId.set(rid, { askId, ts: Date.now() });
    }
    // Rewrite an old-panel "Unknown command" rejection into an actionable
    // update-your-panel message (see makeUnknownCommandError). Applied to the
    // reply-error path only; the happy path and genuine command errors are
    // passed through untouched.
    const rejectMapped = (err: Error) => {
      const friendly = makeUnknownCommandError(err.message, conn.panelVersion);
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
      ctx.reject(friendly ?? err);
    };
    const timer = setTimeout(() => {
      this.pending.delete(rid);
      // This timer only fires AFTER sock.send() below returned successfully — the command
      // WAS WRITTEN to the socket; the tab (possibly backgrounded/frozen) merely didn't
      // reply in time and may still apply it. So this is a POST-write outcome: tag it
      // dispatched:true so a mutating caller (e.g. comfy_reboot readiness) treats it as an
      // accepted-but-unacked dispatch and verifies by observation, rather than mistaking a
      // genuinely-sent command for one that never went out (#509).
      ctx.reject(
        markReplyTimeout(
          markDispatched(
            new Error(
              `Panel tab ${conn.tabId.slice(0, 8)} did not reply to "${cmd.cmd}" within ${ctx.timeoutMs} ms — the ComfyUI tab may be backgrounded or frozen`,
            ),
            true,
          ),
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
      conn.sock.send(JSON.stringify({ rid, ...cmd }));
    } catch (err) {
      clearTimeout(timer);
      this.pending.delete(rid);
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

  /** A pending command's socket died before its reply arrived. Decide, WITHOUT
   *  ever risking double execution, whether to wait for the tab to reconnect and
   *  resume (idempotent reads) or surface an honest outcome-unknown/gone error. */
  private handleMidCommandDisconnect(pend: Pending): void {
    const { ctx, cmd } = pend;
    const short = ctx.tabId.slice(0, 8);
    // Idempotent read, still within its deadline → park it for a bounded grace and
    // re-dispatch if the same tab re-hellos. Safe: re-running a read has no side
    // effect, and it was in `pending` (un-acked), so no reply was lost.
    if (!ctx.mutating && Date.now() < ctx.deadline) {
      // A replacement socket for this tab is ALREADY live (a reload/supersede whose
      // hello landed before this dead socket's close handler ran — so resume already
      // fired and won't fire again). Re-dispatch straight onto it instead of parking
      // and expiring as "gone". Safe: idempotent read, un-acked.
      const live = this.conns.get(ctx.tabId);
      if (live && live.sock !== pend.sock && live.sock.readyState === WebSocket.OPEN) {
        logger.info(
          `[ui-bridge] tab ${short} already reconnected — resuming "${cmd}" on the live socket`,
        );
        this.dispatch(live, ctx);
        return;
      }
      const list = this.awaitingReconnect.get(ctx.tabId) ?? [];
      const graceMs = Math.max(0, Math.min(UiBridge.RECONNECT_GRACE_MS, ctx.deadline - Date.now()));
      const entry = {
        ctx,
        graceTimer: setTimeout(() => {
          this.removeAwaiting(ctx.tabId, entry);
          ctx.reject(
            new Error(
              `panel tab ${short} disconnected mid-command ("${cmd}") and did not reconnect within ${graceMs} ms — panel genuinely gone; retry once a tab is connected`,
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
      ctx.reject(
        markDispatched(
          new Error(
            `panel tab ${short} disconnected mid-command ("${cmd}") — OUTCOME UNKNOWN: the command was already sent, so the panel may have applied it (for a run, ComfyUI may already be rendering). Verify before retrying (e.g. check get_queue / list_output_images) instead of re-issuing it blindly.`,
          ),
          true,
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

  private removeAwaiting(
    tabId: string,
    entry: { ctx: SendCtx; graceTimer: ReturnType<typeof setTimeout> },
  ): void {
    const list = this.awaitingReconnect.get(tabId);
    if (!list) return;
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.awaitingReconnect.delete(tabId);
  }

  /** A tab re-helloed: resume any idempotent reads parked for it on a mid-command
   *  disconnect by re-dispatching them onto the fresh socket. */
  private resumeAwaitingReconnect(tabId: string): void {
    const list = this.awaitingReconnect.get(tabId);
    if (!list || list.length === 0) return;
    const conn = this.conns.get(tabId);
    if (!conn) return;
    this.awaitingReconnect.delete(tabId);
    for (const entry of list) {
      clearTimeout(entry.graceTimer);
      logger.info(
        `[ui-bridge] tab ${tabId.slice(0, 8)} reconnected — resuming "${entry.ctx.command.cmd}"`,
      );
      this.dispatch(conn, entry.ctx);
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
