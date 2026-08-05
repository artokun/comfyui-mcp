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
import {
  describePanelUpdateRecovery,
  type PanelBundleSkew,
} from "./panel-recovery.js";
import { primePanelBase, verifiedPanelDiskVersion } from "./panel-workspace.js";
import { compareSemver, detectInstallMode } from "./self-update.js";

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
  /** #570 — the trusted per-instance workflow uuid this command was ISSUED FOR (the
   *  caller's intended tab), stamped onto the outgoing frame so the panel can refuse to
   *  EXECUTE it against a DIFFERENT workflow it has since switched to. Undefined for a tab
   *  with no established workflow identity (old panel / relay) → no client-side fence. */
  workflowUuid?: string;
  onDispatchedRid?: (rid: string) => void;
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
  /** Monotonic bridge-local hello generation. Every hello gets a new value, even
   * on the same socket/tab id, so restart readiness can require a post-dispatch
   * panel registration rather than mistaking the pre-restart socket for a reconnect. */
  helloGeneration: number;
  /** Browser-tab-scoped session identity supplied by current panel builds.
   * Unlike `tabId`, which is commonly derived from a saved workflow path and
   * can therefore recur in a second browser tab, this stays with one browser
   * tab across a ComfyUI restart. It is used only as an accidental-routing
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
};

/**
 * The panel version each non-command bridge capability was ACTUALLY introduced
 * in.  These belong beside the command minimums because the orchestrator uses
 * their combined maximum for proactive sync advice.  Otherwise a capability
 * gate can correctly refuse an old panel while install_panel incorrectly calls
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

/**
 * The highest panel version this MCP build needs across its bridge commands and
 * handshake capabilities. Keep this beside both capability tables so proactive
 * panel sync and a bridge refusal report the same derived requirement.
 */
export function requiredPanelVersion(): string {
  let best = MIN_PANEL_VERSION_FOR_BRIDGE_COMMANDS;
  for (const min of [
    ...Object.values(BRIDGE_CMD_MIN_PANEL_VERSION),
    ...Object.values(BRIDGE_CAPABILITY_MIN_PANEL_VERSION),
  ]) {
    if (!SEMVER_RE.test(min.trim())) continue;
    if (!SEMVER_RE.test(best.trim()) || compareSemver(min, best) > 0) best = min;
  }
  return best;
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
function resolveStaleBundleSkew(panelVersion?: string): PanelBundleSkew | undefined {
  const disk = verifiedPanelDiskVersion()?.trim();
  if (!disk) {
    // Could not confirm — most often because the live-base resolution has gone
    // stale and this refusal is the first thing to ask in a while. Refresh it in
    // the background (never awaited; building an error message must not block on
    // I/O) so a retry, which agents reliably make, can answer properly.
    void primePanelBase().catch(() => {});
    return undefined;
  }
  const required = requiredPanelVersion();
  if (!SEMVER_RE.test(disk) || !SEMVER_RE.test(required.trim())) return undefined;
  if (compareSemver(disk, required) < 0) return undefined; // install really IS behind

  const advertised = panelVersion?.trim();
  if (advertised) {
    // A version we cannot parse is not proof of an old tab.
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
  panelVersion?: string,
  mcpVersion: string | undefined = mcpServerVersion(),
): Error {
  const detected = panelVersion
    ? ` (detected panel ${panelVersion}${mcpVersion ? `, mcp ${mcpVersion}` : ""})`
    : mcpVersion
      ? ` (detected mcp ${mcpVersion})`
      : "";
  const min = BRIDGE_CMD_MIN_PANEL_VERSION[cmd];
  const e = new Error(
    min
      ? `This ComfyUI-MCP panel is too old for "${cmd}"${detected} — update the ComfyUI-MCP panel ` +
          `to ≥${min} (ComfyUI Manager → update comfyui-mcp panel), then reconnect.`
      : `This ComfyUI-MCP panel does not implement "${cmd}"${detected} — update the ComfyUI-MCP panel ` +
          `to the latest release (ComfyUI Manager → update comfyui-mcp panel), then reconnect.`,
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
  const cmdPat = cmd ? cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "[\\w.-]+";
  return (
    new RegExp(`unknown command\\s*["“']?${cmdPat}`, "i").test(msg) ||
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
  mcpVersion?: string,
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
  return buildPanelTooOldError(cmd, panelVersion, mcpVersion);
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
  // #608: a forced /object_info re-register + combo refresh. It has NO effect on
  // graph content — it only re-registers node defs and rebuilds combo option lists
  // (idempotent, undo-neutral) — so it is classified with the READS: it earns the
  // tolerant read default timeout (a fresh /object_info on a large install can run
  // many seconds), and on a mid-command socket drop it is PARKED and resumed on the
  // tab's re-hello rather than surfacing a scary OUTCOME-UNKNOWN the orchestrator
  // won't retry. Re-running it is always safe.
  "refresh_nodes",
]);

/** #570 P0c — a graph command that WRITES the canvas (add/remove/connect/move/set_widget/
 *  clear/load/…). Any `graph_*` command that is NOT in the read-only allowlist mutates, so
 *  this stays correct as new graph mutators are added without having to enumerate them. */
export function isMutatingGraphCommand(cmdName: string): boolean {
  return cmdName.startsWith("graph_") && !BRIDGE_READONLY_CMDS.has(cmdName);
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

/** Tag an error as a reply-timeout and return it (for throw/reject). */
/**
 * Key for a pending "is this tab gone?" clock (#486).
 *
 * (tab id, INCARNATION) — a `wf:<hash>` tab id recurs, so it names a workflow,
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
  /**
   * #716 — an explicit workflow navigation can establish a newer command-stamp
   * identity before the panel's next hello.  The orchestrator owns the value and
   * validates it against the server-observed origin; the bridge merely gives a
   * successful tab-bound command a narrow way to ask for that refresh.
   */
  private refreshTabWorkflowUuid: ((tabId: string, workflowUuid: string) => boolean) | null = null;
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
   *  STABLE tab id (the phone persists one). In-memory: survives disconnect ⇄
   *  reconnect within an orchestrator run, not a full orchestrator restart.
   *  Bounded per tab + TTL'd. */
  private readonly mailbox = new Map<string, Array<{ cmd: BridgeCommand; ts: number }>>();
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
  /** ask_user card sends (rid → {ask_id, ts}): lets a reply that validates AFTER
   *  the reply timer fired (dropped from `pending`) still be buffered for the
   *  caller, instead of being discarded as a "late reply for a timed-out command"
   *  (#486). Timestamped so an abandoned mapping (timeout/disconnect/send-failure
   *  whose late reply never arrives) is TTL-pruned rather than kept forever. */
  private askRidToId = new Map<string, { askId: string; ts: number; tabId: string }>();
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
   * WRONG question: when a second tab takes over a recurring `wf:<hash>` key the
   * bridge closes the first socket, and by the time that close fires the map
   * already points at the newcomer — so the departing tab was never armed at all
   * and could never be declared gone. The socket knows who it was; ask it.
   */
  private sockIncarnation = new Map<BridgeSocket, { tabId: string; incarnation: string }>();
  /** Buffered late-but-valid ask_user answers (ask_id → result), drained by the
   *  caller via takeLateAskReply(). Bounded by a short TTL — a stale unclaimed
   *  answer is pruned rather than kept forever. */
  private lateAskReplies = new Map<string, { result: unknown; ts: number }>();
  /** TTL for a BUFFERED late ask answer. Only an in-flight caller drains this
   *  (its grace poll lives well under 5 minutes), and the durable copy is the
   *  journal the sink feeds — so this stays short. */
  private static readonly LATE_ASK_TTL_MS = 5 * 60 * 1000;
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
        // Matched on the BROWSER-TAB SESSION, not the key: a `wf:<hash>` key
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
        this.onPanelMessage?.(msg as PanelEvent);
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
          const entry = this.askRidToId.get(rid);
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
              try {
                this.lateAskSink?.(entry.askId, msg.result, entry.tabId);
              } catch (err) {
                logger.warn(
                  `[ui-bridge] late ask-answer sink threw (the answer is still buffered): ${err instanceof Error ? err.message : String(err)}`,
                );
              }
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
          if (msg.type === "user_message") this.setLastActiveTab(effectiveTab);
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
          this.handleMidCommandDisconnect(p);
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
  tabCanMutateGraph(tabId: string): boolean {
    try {
      const conn = this.resolveTarget(tabId);
      const stamp = this.resolveTabWorkflowUuid?.(tabId);
      return (
        conn.sock.readyState === WebSocket.OPEN &&
        conn.enforcesWorkflowStamp &&
        conn.enforcesWorkflowStampAtWrite &&
        typeof stamp === "string" &&
        stamp.length > 0
      );
    } catch {
      return false;
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
              text:
                `⚠️ Too many question cards are open at once in this tab, so the oldest ones can no ` +
                `longer accept an answer — clicking them will do nothing. Answer the most recent card, ` +
                `or just type your choice in the chat and the agent will pick it up.`,
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
    // `wf:<hash>` key each get their own clock. Keyed by tab id alone, the
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
   * recurring `wf:<hash>` key must leave the departed tab's clock running, or
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

  /** The incarnation currently holding `tabId` — the identity every structure
   *  that stores per-tab state must scope to, so a different browser tab taking
   *  over a recurring `wf:<hash>` key cannot read, settle or inherit it (#486). */
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
   *  The never-connected branch is the one that has to be careful. All this bridge
   *  observed is "nothing has helloed me since I bound my port" — a BUCKET holding
   *  at least three different situations (no ComfyUI running, ComfyUI running
   *  without the pack, pack installed and talking to some OTHER bridge address).
   *  It used to be narrated as one of them ("open ComfyUI with the pack installed"),
   *  which is the #804 shape: an unobserved cause asserted from an observation that
   *  cannot separate them, sending a user who already installed the pack off to
   *  install it again. So it now states what was observed, says plainly that the
   *  observation does not discriminate, and gives an ORDERED check whose steps do.
   *
   *  The remedies are phrased as things the USER does rather than tools the agent
   *  calls, because this string is read by agents with very different tool sets
   *  (#784: guidance naming install_panel reached a session that did not have it),
   *  so the one tool named here is named conditionally. */
  noPanelGuidance(): string {
    return this.hasEverConnected()
      ? "the ComfyUI panel tab is not connected — this is almost always because ComfyUI was just restarted or the browser tab reloaded, which drops the Agent panel's socket. Ask the user to refresh (reload) the ComfyUI browser tab to reconnect the Agent panel, then retry. (The comfyui-mcp-panel pack IS installed — a tab connected earlier this session — so this is a reconnect, not an install problem.)"
      : `no panel connected — nothing has connected to this bridge (ws://${this.host}:${this.port}) since it started, which on its own does not distinguish a missing panel from an installed one that is pointing at a different address. Ask the user to check, in this order: (1) is ComfyUI open in a browser at all; (2) is the comfyui-mcp-panel pack installed on that ComfyUI — the Agent tab in its sidebar is the proof, and no Agent tab means no pack (ComfyUI Manager lists it as comfyui-mcp; the install_panel tool also installs it, when this session has that tool); (3) if the Agent tab is there and still shows nothing connected, it reached a different bridge address than this one.`;
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

  send(cmd: BridgeCommand, opts: { tabId?: string; timeoutMs?: number; onDispatchedRid?: (rid: string) => void } = {}): Promise<unknown> {
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
        // install_panel is a no-op, and on the embedded `panel_*` surface it is
        // not even present. describePanelUpdateRecovery names it only where it
        // works, and hands over concrete host-side commands everywhere else.
        //
        // And FIRST it asks a different question: is the INSTALL even the
        // problem? `resolveStaleBundleSkew` answers that from the version the
        // panel sync read OFF DISK at this tab's own hello. When the pack on
        // disk already clears the floor, no update of any kind helps and the
        // remedy is a cache-bypassing reload of this tab.
        const recovery = describePanelUpdateRecovery(
          undefined,
          resolveStaleBundleSkew(conn.panelVersion),
        );
        const why = !conn.enforcesWorkflowStamp
          ? `panel tab ${conn.tabId} does not enforce per-command workflow targeting ` +
            `(detected panel ${conn.panelVersion ?? "version unknown"}; this MCP requires panel ` +
              `${requiredPanelVersion()}+). ${recovery}`
          : !conn.enforcesWorkflowStampAtWrite
            ? `panel tab ${conn.tabId} does not recheck workflow targeting at the graph write ` +
              `boundary after asynchronous work (detected panel ${conn.panelVersion ?? "version unknown"}; this MCP ` +
                `requires panel ${requiredPanelVersion()}+). ${recovery}`
          : `this workflow has no trusted identity for the panel to fence the command against`;
        const refusal = markDispatched(
          new Error(
            `"${cmd.cmd}" cannot be safely targeted to the active workflow: ${why}. Read-only graph ` +
              `commands (graph_outline, graph_query, graph_get_state) still work.`,
          ),
          false,
        );
        return Promise.reject(capabilityMissing ? markCapabilityRefusal(refusal) : refusal);
      }
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
        // #570 — resolve from the CALLER'S intended tab (opts.tabId), NOT the canonical
        // conn.tabId: after a same-socket switch the two differ, and we must stamp the
        // workflow the command was ISSUED FOR (so the panel, now showing a different one,
        // declines it) — never the workflow it happens to have landed on.
        workflowUuid: this.resolveTabWorkflowUuid?.(opts.tabId ?? conn.tabId) ?? undefined,
        onDispatchedRid: opts.onDispatchedRid,
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
      // Carry the ROUTED tab id with the mapping: the late-reply branch runs in a
      // scope that only knows the socket, and the journal needs the tab the card
      // was rendered on to address the answer.
      this.askRidToId.set(rid, { askId, ts: Date.now(), tabId: ctx.tabId });
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
      // #570 — stamp the intended workflow uuid so the panel refuses to APPLY this command
      // if it has since switched to a different workflow (a frame already delivered to the
      // browser cannot be retracted server-side; the client fences execution instead).
      //
      // workflow_uuid is BRIDGE-OWNED metadata, NEVER caller-settable (codex): a caller that
      // could supply its own workflow_uuid would just set it to the DESTINATION workflow after a
      // switch and sail past the panel fence. So ALWAYS overwrite with the trusted resolver value
      // (ctx.workflowUuid), and STRIP any caller-supplied value entirely when we have no trusted
      // one — an identity-less tab / old panel ships unstamped (mutations are already refused by
      // the requiresWorkflowStampEnforcement gate above; reads execute, reply still server-fenced).
      // #694 hardening: mint the rid LAST so a caller-supplied cmd.rid can NEVER
      // override it — the rid is BRIDGE-OWNED (reply correlation in `pending`,
      // the onDispatchedRid observer, and the panel's retry_of dedupe token all
      // key on it). Previously `{ rid, ...cmd }` let a caller cmd.rid clobber the
      // minted rid, silently breaking reply correlation for that command.
      const frame: Record<string, unknown> = { ...cmd, rid };
      if (ctx.workflowUuid) frame.workflow_uuid = ctx.workflowUuid;
      else delete frame.workflow_uuid;
      conn.sock.send(JSON.stringify(frame));
      try { ctx.onDispatchedRid?.(rid); } catch { /* observer faults are non-fatal */ }
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
            `panel tab ${short} disconnected mid-command ("${cmd}") — OUTCOME UNKNOWN: the command was already sent, so the panel may have applied it (for a run, ComfyUI may already be rendering). Verify before retrying (e.g. check queue action:"list" / list_output_images) instead of re-issuing it blindly.`,
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

  /** #570 — inject the tabId → trusted workflow uuid resolver (tabStableIdentity lives in
   *  the orchestrator). Enables the per-command workflow-instance stamp/fence. */
  setTabWorkflowUuidResolver(
    fn: (tabId: string) => string | undefined,
    refresh?: (tabId: string, workflowUuid: string) => boolean,
  ): void {
    this.resolveTabWorkflowUuid = fn;
    this.refreshTabWorkflowUuid = refresh ?? null;
  }

  /**
   * #716 — accept a command-stamp refresh only through the orchestrator's
   * validator.  A panel-tool response is not allowed to write bridge state
   * directly; missing/invalid values simply leave the existing fail-closed
   * stamp in place.
   */
  refreshWorkflowUuid(tabId: string, workflowUuid: string): boolean {
    return this.refreshTabWorkflowUuid?.(tabId, workflowUuid) ?? false;
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
