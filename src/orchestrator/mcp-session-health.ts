// #1524 — read the harness's OWN report of which MCP servers a session came up
// with, instead of discarding it.
//
// The reported failure: mid-session both MCP servers dropped; the `comfyui` half
// came back and all 92 `panel_*` tools did not. The orchestrator kept running and
// kept its ports, the panel looked healthy, and the agent spent the rest of a
// six-hour session unable to touch the user's canvas. Nothing anywhere said so —
// the reporter established it by hand, by noticing a tool-list diff and then
// probing with `ToolSearch`.
//
// It did not have to be established by hand. Every Claude session opens with a
// `system`/`init` message carrying `mcp_servers: {name, status}[]`, which is the
// CLI's authoritative per-session statement of what actually connected. Verified
// against the installed harness (agent SDK 0.3.197) with one server of each kind
// configured:
//
//   [{"name":"deadstdio","status":"failed"},{"name":"panel","status":"connected"}]
//
// — so it covers BOTH transports the panel uses: the in-process `createSdkMcpServer`
// panel server (Claude lane) and the stdio `comfyui` child. `route()` already reads
// that message for the session id and throws the rest away.
//
// This module is the comparison and the wording. The comparison says what was
// observed and nothing more: it does not diagnose WHY a server is missing
// (still open for #1524, and the two candidate causes need different fixes).
// The wording carries the recovery story the same way: a reconnect attempt is
// reported as attempted, its outcome as whatever the re-read status poll said —
// never as a promise that a restart or reconnect would help.

/** One entry of the `system`/`init` `mcp_servers` report. */
export interface ReportedMcpServer {
  name: string;
  status: string;
}

/** A configured server the session did not come up with. */
export interface DegradedMcpServer {
  name: string;
  /** The reported status, or `null` when the server was absent from the report. */
  status: string | null;
}

/** What a report says about the servers we configured. */
export interface McpSessionHealth {
  /** Configured servers the session does not have. */
  degraded: DegradedMcpServer[];
  /**
   * Configured servers still CONNECTING when this report was taken.
   *
   * `pending` is a settled-later status, not a failure: the SDK's server startup
   * does not block the session, so a slow server is legitimately pending in the
   * `init` report and connects a moment afterwards. Calling that degraded would
   * fire on healthy sessions, which is the one outcome worse than the silence
   * this replaces.
   *
   * But it must not be read as "fine" either — a server pending at init can go
   * on to FAIL, and since `init` is the only report the session pushes, nothing
   * would ever say so. The caller re-reads these names later (the SDK's
   * `mcpServerStatus()` poll) and reports whatever they settled as.
   */
  pending: string[];
}

/**
 * Compare the MCP servers we handed the session against the ones it reports.
 *
 * `configured` is the set of names passed as `Options.mcpServers`. Because the
 * panel always sets `strictMcpConfig: true`, the session's server set is exactly
 * ours — no user/project config can appear in the report and no name of ours can
 * be legitimately replaced.
 *
 * Splits the configured servers into the ones the session does not have
 * (`degraded`) and the ones still connecting (`pending`), in the order they were
 * configured. Both empty means every server we asked for is up — which is the
 * case this has to get right first, since a false "your tools are gone" is worse
 * than the silence it replaces.
 *
 * Two deliberate silences:
 *
 *  - An ABSENT or empty report yields nothing. A harness that does not populate
 *    the field at all (or has not yet) tells us nothing about our servers, and
 *    reading its silence as failure would fire on every healthy session.
 *  - Any status that is not recognizably a failure is treated as fine. The set of
 *    statuses is the CLI's to grow; a new one must not become an alarm here.
 *
 * Absence from a NON-EMPTY report does count: the report is populated, the config
 * is strict, so a name of ours missing from it is a server the session does not
 * have. That case matters — a server whose connection fails before it is
 * advertised is missing rather than failed.
 */
export function inspectMcpServers(
  configured: readonly string[],
  reported: readonly ReportedMcpServer[] | undefined,
): McpSessionHealth {
  if (!Array.isArray(reported) || reported.length === 0) return { degraded: [], pending: [] };
  const byName = new Map<string, string>();
  for (const entry of reported) {
    if (entry && typeof entry.name === "string") byName.set(entry.name, String(entry.status ?? ""));
  }
  const degraded: DegradedMcpServer[] = [];
  const pending: string[] = [];
  for (const name of configured) {
    if (!byName.has(name)) {
      degraded.push({ name, status: null });
      continue;
    }
    const status = (byName.get(name) ?? "").trim().toLowerCase();
    if (status === "pending") pending.push(name);
    else if (FAILED_STATUSES.has(status)) degraded.push({ name, status: byName.get(name) ?? "" });
  }
  return { degraded, pending };
}


/**
 * Configured servers that CONNECTED and contributed no tools (#2742).
 *
 * The #1524 comparison above asks whether a server is present and what its status
 * is. That is blind to the variant five reporters hit on 0.52.174 through
 * 0.52.178: `panel=connected` in every session, panel_* absent from both the
 * direct declarations and the deferred catalog, no notice, no down-episode, no
 * reconnect. Status `connected` was being read as proof of a usable toolset, and
 * it is not — a server can connect and register nothing.
 *
 * The cost of that blindness is the whole report: "every signal the product
 * surfaces said the panel was connected", and one reporter reinstalled twice
 * chasing it.
 *
 * The init message carries `tools: string[]`, and an MCP tool appears there
 * namespaced as `mcp__<server>__<tool>`. So a configured server with no entry
 * under its own prefix contributed nothing.
 *
 * THREE SILENCES, each the same "a false alarm is worse than this silence" rule
 * the rest of this module follows:
 *
 *  - No tool list, or an empty one, says nothing about our servers.
 *  - A tool list containing NO `mcp__` name at all is a harness that does not
 *    list MCP tools here, not a session with none — UNLESS this process has
 *    already seen a namespaced MCP tool, which proves the harness does list them.
 *    Reporting every configured server without that proof would fire on healthy
 *    sessions on any harness shaped that way.
 *
 *    This started as an accepted blind spot, justified by `mcp__comfyui__*` being
 *    present throughout ("headless mcp__comfyui__* tools remained available" in
 *    three of the five reports). Self-review found that justification is evidence
 *    about EARLIER reports, not a property of the failure: a sixth report
 *    (2026-09-03, on 0.52.183) describes zero panel tools without saying whether
 *    comfyui tools survived, so it may sit squarely inside the blind spot — the
 *    fix would not fire on the case it was written for. The latch below closes it
 *    without inventing a false alarm: a harness that never namespaces never
 *    latches, so it is never reported on.
 *  - A server that is degraded or still pending is not reported here. It has no
 *    tools because it is not up; `inspectMcpServers` already says so, and saying
 *    it twice in different words would read as two faults.
 */
/**
 * Latched once per process: has ANY session listed a `mcp__*` tool? Until it has,
 * an absent namespace is an unknown harness, not an empty server. It only ever
 * moves false -> true, so the detection can widen but never narrow.
 *
 * HAZARD IF TOOL SEARCH IS EVER ENABLED. The SDK defers MCP tool schemas behind
 * tool search by default ("tools are deferred when tool search is enabled", the
 * `alwaysLoad` docs on every MCP server config type), and a deferred tool is not in
 * the init message's `tools`. Today nothing in this repo sets `alwaysLoad` or
 * enables tool search, so every server is treated alike and the list is populated.
 *
 * If that changes, the failure direction depends entirely on this latch:
 *  - never latched -> no `mcp__` names -> silence. The check goes inert, which is
 *    the safe direction and is what the first test pins.
 *  - already latched by an earlier non-deferred session in the SAME process -> an
 *    all-deferred session reads as EVERY server contributing zero tools, and the
 *    notice fires on a healthy session. That is the exact false positive this
 *    module exists to avoid.
 *
 * So the latch must become per-session, or deferral-aware, BEFORE tool search is
 * turned on. Being process state is only correct while every session in the process
 * shares one deferral mode.
 */
let harnessListsNamespacedMcpTools = false;

/** Test seam — the latch is process state, so suites must not leak into each other. */
export function resetMcpToolNamespacingLatchForTests(): void {
  harnessListsNamespacedMcpTools = false;
}

export function serversWithoutTools(
  configured: readonly string[],
  reported: readonly ReportedMcpServer[] | undefined,
  tools: readonly string[] | undefined,
): string[] {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const namespaced = tools.filter((t) => typeof t === "string" && t.startsWith("mcp__"));
  // One namespaced tool, ever, is proof this harness lists them here. After that,
  // an EMPTY namespaced set is a real observation rather than an unknown harness.
  if (namespaced.length > 0) harnessListsNamespacedMcpTools = true;
  else if (!harnessListsNamespacedMcpTools) return [];
  const health = inspectMcpServers(configured, reported);
  const notUp = new Set<string>([...health.degraded.map((d) => d.name), ...health.pending]);
  const empty: string[] = [];
  for (const name of configured) {
    if (notUp.has(name)) continue;
    const prefix = `mcp__${name}__`;
    if (!namespaced.some((t) => t.startsWith(prefix))) empty.push(name);
  }
  return empty;
}

/**
 * The line the user sees for a connected-but-empty server (#2742).
 *
 * Deliberately NOT `degradedMcpNotice`'s wording: that one says the session
 * "started without" the server, which is false here and would send the reader
 * looking for a connection failure that did not happen. The distinction is the
 * entire point of the report.
 *
 * It also names the recovery that actually worked for the reporters, and the one
 * that did not: Disconnect → Connect keeps the same orchestrator process, so the
 * server is not re-registered; stopping the process is what re-runs it. Two
 * reporters established that by hand.
 */
export function emptyToolsMcpNotice(names: readonly string[]): string {
  if (names.length === 0) return "";
  const named = names.map((n) => `\`${n}\``).join(", ");
  const plural = names.length > 1 ? "servers" : "server";
  const their = names.length > 1 ? "their" : "its";
  return (
    `This session's MCP ${plural} ${named} reported \`connected\` but contributed ZERO tools, ` +
    `so ${their} tools are not available to the agent even though every status signal says the ` +
    `${plural} ${names.length > 1 ? "are" : "is"} healthy. Anything that needs them will fail or ` +
    `be worked around silently. This is not a connection failure and reconnecting the panel tab ` +
    `does not clear it: Disconnect → Connect keeps the same orchestrator process, which is where ` +
    `the registration lives. Stopping and restarting the orchestrator process re-runs it. ` +
    `Why the registration comes up empty is open on #2742; this reports the observation only.`
  );
}

/**
 * One row of Codex app-server `mcpServerStatus/list` (`McpServerStatus` in
 * app-server-protocol v2, camelCase on the wire).
 *
 * Live fields: `name`, `runtimeStatus`, `authStatus`, `tools` (a map, not an
 * array), `serverInfo`, `pluginId`. There is no `status` and no `enabled`.
 * Official docs: the tools inventory may be cached and does **not** prove the
 * thread is connected; omit `threadId` and `runtimeStatus` is null.
 *
 * Mapped into `ReportedMcpServer` so `inspectMcpServers` is the only comparison.
 */
export interface CodexMcpServerListing {
  name?: unknown;
  runtimeStatus?: unknown;
  authStatus?: unknown;
  tools?: unknown;
}

/**
 * Translate a Codex `mcpServerStatus/list` page into the report
 * `inspectMcpServers` already understands.
 *
 * Returns `undefined` when the listing is absent or empty — same silence as
 * an unpopulated Claude init report: a harness that did not answer tells us
 * nothing, and reading that as failure would fire on every healthy session.
 *
 * `runtimeStatus` is the connection signal. Cached `tools` never override it:
 * `{ name: "panel", runtimeStatus: "failed", tools: { panel_set_todo: … } }`
 * is a drop, which is the reporter's ALL_TOOLS gap after panel_restart_comfyui.
 * Empty tools is only a fallback when `runtimeStatus` is omitted (older
 * app-servers, or a poll that forgot `threadId`).
 */
export function reportedFromCodexMcpListing(
  listed: readonly CodexMcpServerListing[] | undefined,
): ReportedMcpServer[] | undefined {
  if (!Array.isArray(listed) || listed.length === 0) return undefined;
  const out: ReportedMcpServer[] = [];
  for (const entry of listed) {
    if (!entry || typeof entry.name !== "string" || !entry.name) continue;
    out.push({ name: entry.name, status: statusOfCodexListing(entry) });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Codex `McpServerConnectionStatus`: notStarted | starting | connected |
 * authenticationRequired | failed | cancelled | disabled.
 */
function statusOfCodexListing(entry: CodexMcpServerListing): string {
  const runtime =
    typeof entry.runtimeStatus === "string" ? entry.runtimeStatus.trim().toLowerCase() : "";
  if (runtime) {
    if (runtime === "connected") return "connected";
    if (runtime === "starting") return "pending";
    if (runtime === "authenticationrequired") return "needs-auth";
    if (runtime === "disabled") return "disabled";
    // notStarted / failed / cancelled — drop shapes a reload can speak to.
    if (
      runtime === "failed" ||
      runtime === "cancelled" ||
      runtime === "notstarted" ||
      runtime === "error"
    ) {
      return "failed";
    }
    // Unrecognized runtimeStatus: closed list, same as inspectMcpServers —
    // a new value must not become an alarm.
    return "connected";
  }
  const auth =
    typeof entry.authStatus === "string" ? entry.authStatus.trim().toLowerCase() : "";
  if (auth === "notloggedin") return "needs-auth";
  // Older listing with no runtimeStatus: empty inventory is a drop, a
  // populated (possibly cached) map is not proof of connected either, but
  // without a runtime field we cannot tell a healthy row from a stale cache
  // — silence, matching "omit threadId → runtimeStatus is null".
  if (toolsInventoryEmpty(entry.tools)) return "failed";
  return "connected";
}

/** Codex serializes `tools` as a name→schema map; older stubs used an array. */
function toolsInventoryEmpty(tools: unknown): boolean {
  if (Array.isArray(tools)) return tools.length === 0;
  if (tools && typeof tools === "object") return Object.keys(tools).length === 0;
  return false;
}

/**
 * Statuses that mean the server is not usable. Taken from the SDK's own
 * `McpServerStatus` union (`connected | failed | needs-auth | pending |
 * disabled`), plus `error` for a host that words it that way.
 *
 * A closed list, deliberately: anything the CLI adds later reads as connected
 * rather than as an alarm, so a vocabulary change cannot start telling healthy
 * sessions their tools are gone.
 */
const FAILED_STATUSES = new Set(["failed", "needs-auth", "disabled", "error"]);

/**
 * Whether an automatic reconnect is worth attempting for a degraded status.
 *
 * `failed` / `error` / absent-from-the-report are DROP shapes — re-running the
 * connection can bring the server back. `needs-auth` waits on the user
 * completing an auth flow and `disabled` is a deliberate off switch: an
 * automatic retry of the first claims effort that cannot land, and of the
 * second overrides intent — so neither is retried, only reported.
 */
export function reconnectableMcpStatus(status: string | null): boolean {
  if (status === null) return true;
  const s = status.trim().toLowerCase();
  return s === "failed" || s === "error";
}

/**
 * The line the user sees when a session starts without a server it was given.
 *
 * Scoped the way `NO_PANEL_TOOLS_OVERRIDE` is scoped: it states the observation
 * and its one consequence, and then stops. It does not say why (unknown), does
 * not say a restart fixes it (a cause that persists survives a restart), and does
 * not vouch for the servers that DID come up — the reader can see those in the
 * same sentence.
 */
export function degradedMcpNotice(degraded: readonly DegradedMcpServer[]): string {
  if (degraded.length === 0) return "";
  const named = degraded
    .map((d) => (d.status === null ? `\`${d.name}\` (not reported)` : `\`${d.name}\` (${d.status})`))
    .join(", ");
  const plural = degraded.length > 1 ? "servers" : "server";
  const theirTools = degraded.length > 1 ? "Their tools are" : "Its tools are";
  return (
    `This session started without ${degraded.length} of its MCP ${plural}: ${named}. ` +
    `${theirTools} not available to the agent until the server connects, ` +
    `so anything that needs them will fail or be worked around silently. ` +
    `A reconnect is attempted at the next turn boundary for any of them that can be retried, ` +
    `and the outcome is reported; starting a new session (Disconnect → Connect) ` +
    `re-runs the connection from scratch. ` +
    `Whether either succeeds depends on why this one did not, which this message does not know.`
  );
}

/** Format a degraded-server list the way every notice in this module does. */
function namedDegraded(degraded: readonly DegradedMcpServer[]): string {
  return degraded
    .map((d) => (d.status === null ? `\`${d.name}\` (not reported)` : `\`${d.name}\` (${d.status})`))
    .join(", ");
}

/**
 * The line the user sees when a server is down and STAYS down past the
 * recovery this session can offer (#1524). `why` names exactly which situation
 * the session is in — the one thing the reader must not have to guess:
 *
 *  - `reconnect-failed`: an automatic reconnect was tried and the re-read still
 *    reports the server down;
 *  - `unverified`: an automatic reconnect was tried but the status re-read that
 *    would judge it could not be read — so the outcome is not claimed either
 *    way ("did not come back" would be a claim nobody checked);
 *  - `not-retriable`: the status (`needs-auth`, `disabled`) is not one an
 *    automatic reconnect can clear — nothing was attempted;
 *  - `unsupported`: the harness exposes no reconnect to ask for — nothing
 *    could be attempted.
 *
 * Like `degradedMcpNotice`, it stops at the observation: it does not diagnose
 * why the server is down and does not promise a new session fixes it.
 */
export function unrecoveredMcpNotice(
  degraded: readonly DegradedMcpServer[],
  why: "reconnect-failed" | "unverified" | "not-retriable" | "unsupported",
): string {
  if (degraded.length === 0) return "";
  const plural = degraded.length > 1;
  const reason =
    why === "reconnect-failed"
      ? `the automatic reconnect did not bring ${plural ? "them" : "it"} back`
      : why === "unverified"
        ? "an automatic reconnect was attempted, but its outcome could not be read back"
        : why === "not-retriable"
          ? "an automatic reconnect cannot clear this status, so none was attempted"
          : "this harness offers no reconnect to ask for";
  return (
    `MCP ${plural ? "servers" : "server"} ${namedDegraded(degraded)} ${plural ? "are" : "is"} ` +
    `unavailable to the agent — ${reason}. ` +
    `Anything that needs ${plural ? "their" : "its"} tools will fail or be worked around ` +
    `silently for the rest of this session. ` +
    `Starting a new session (Disconnect → Connect) re-runs the connection; ` +
    `whether it succeeds depends on why the server is down, which this message does not know.`
  );
}

/**
 * The line the user sees when a down server reads CONNECTED again (#1524).
 * `byReconnect` distinguishes the two honest shapes: the session's own
 * reconnect attempt landed, or the harness's supervision brought the server
 * back on its own (the reporter watched `comfyui` do exactly this while
 * `panel` stayed down). The claim is only ever what a status poll reported —
 * never that the tools were exercised.
 */
export function recoveredMcpNotice(names: readonly string[], byReconnect: boolean): string {
  if (names.length === 0) return "";
  const named = names.map((n) => `\`${n}\``).join(", ");
  const plural = names.length > 1;
  const how = byReconnect
    ? `the automatic reconnect brought ${plural ? "them" : "it"} back`
    : `${plural ? "they are" : "it is"} connected again`;
  return (
    `MCP ${plural ? "servers" : "server"} ${named}: ${how} — ` +
    `${plural ? "their" : "its"} tools are available to the agent. ` +
    `Anything the agent reported as unreachable while the server was down may be worth another try.`
  );
}
