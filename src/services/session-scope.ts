// Orchestrator-scoped agent sessions (#884).
//
// THE INVARIANT (owner-stated, absolute): agents are SESSION-bound, not
// workflow-bound. One agent session spans every panel, every browser tab and
// every open workflow served by this orchestrator; the sessions are stored and
// managed by the orchestrator and persisted on disk (~/.comfyui-mcp/sessions),
// not in the browser. A workflow-scoped, tab-scoped or panel-scoped agent is a
// bug, never the design.
//
// This module separates the two jobs the panel `tab_id` used to do at once:
//   (a) SESSION IDENTITY — which conversation/agent a message belongs to. That
//       is now the orchestrator-owned shared scope below plus the backend name
//       (switching provider already restarts the agent, so the backend half of
//       the composite key is legitimately part of agent identity — the
//       workflow half was the regression).
//   (b) ROUTING TARGET — which panel/workflow a tool call acts on and where
//       frames fan back out to. That job keeps the real per-tab ids: commands
//       addressed to the shared scope resolve to the ACTIVE tab at dispatch
//       time (UiBridge.resolveTarget), and conversation frames fan out to every
//       connected tab participating in the backend's conversation.
//
// The scope constant deliberately contains no "::" (the agent-key separator)
// and can never collide with a panel tab id (those are `wf:<path>` /
// `tmp:<uuid>` / test `e2e-*`/`spike-*` ids).

/** The single orchestrator-owned session scope. `agentKeyFor` composes it with
 *  the tab's backend: `orchestrator::claude`, `orchestrator::codex`, … */
export const SHARED_SESSION_SCOPE = "orchestrator";

/** The composite agent key for a backend's shared conversation. */
export function sharedAgentKey(backend: string, sep = "::"): string {
  return SHARED_SESSION_SCOPE + sep + backend;
}

/** Is this id the shared session scope (as opposed to a real panel tab id)? */
export function isSharedScopeId(id: string | undefined | null): boolean {
  return id === SHARED_SESSION_SCOPE;
}

/**
 * Is this id a scope ADDRESS — the bare scope, or a backend-qualified scope
 * (`orchestrator::<backend>`, i.e. an agent key used as a routing address)?
 * The panel MCP servers bind the QUALIFIED form so the workflow-stamp resolver
 * can answer per CONVERSATION (two backends' concurrently in-flight turns must
 * not share one issue-time stamp); the bridge routes both forms to the active
 * tab. A real panel tab id (`wf:…`/`tmp:…`) never matches.
 */
export function isScopeAddress(id: string | undefined | null): id is string {
  return (
    typeof id === "string" &&
    (id === SHARED_SESSION_SCOPE || id.startsWith(SHARED_SESSION_SCOPE + "::"))
  );
}

/**
 * The CONVERSATION a scope address names: the backend-qualified agent key
 * (`orchestrator::<backend>`), or undefined for the bare scope and for a real
 * panel tab id.
 *
 * This is the identity a journal ticket is OWNED by (#704). A panel tab id is a
 * routing address and it churns — a reconnecting panel re-registers under a new
 * id, and only a same-socket re-hello leaves a migration trail to follow — so a
 * run ticketed by tab alone stopped being recognizable as the agent's own after
 * a reconnect. The conversation spans every tab and workflow (#884) and outlives
 * the address. Deliberately NOT the bare scope: the conversation is per BACKEND
 * (two providers are two conversations), so an unqualified address names no one
 * and yields undefined rather than a value that could match the wrong one.
 */
export function conversationOfScopeAddress(id: string | undefined | null): string | undefined {
  return typeof id === "string" && id.startsWith(SHARED_SESSION_SCOPE + "::") ? id : undefined;
}

/**
 * The connected panel tabs participating in a backend's shared conversation —
 * every tab whose selected backend matches. Agent output (say/stream/turn/…)
 * fans out to ALL of them: the same conversation is visible from every tab.
 * When this is EMPTY the orchestrator PARKS the frame per agent key (backend-
 * qualified — a claude turn finishing while only a codex tab is open must never
 * leak into the codex conversation) and flushes it to the next hello /
 * set_backend join on that backend.
 */
export function conversationTabs(opts: {
  connected: string[];
  backendForTab: (tabId: string) => string;
  backend: string;
}): string[] {
  return opts.connected.filter((t) => opts.backendForTab(t) === opts.backend);
}

/**
 * May a provider switch RETIRE the outgoing backend's shared agent? Only when
 * no OTHER connected tab still runs on that backend — the conversation is
 * shared, so one tab switching provider must never stop an agent other tabs
 * are actively using. (retire() preserves the durable session either way, so a
 * wrongly-kept agent is merely idle, and a retired one resumes on demand.)
 */
export function shouldRetireSharedAgent(opts: {
  switchingTab: string;
  prevBackend: string;
  connected: string[];
  backendForTab: (tabId: string) => string;
}): boolean {
  return !opts.connected.some(
    (t) => t !== opts.switchingTab && opts.backendForTab(t) === opts.prevBackend,
  );
}

/**
 * Map a hello frame's raw `backend` field to the conversation it JOINS: a
 * known backend name (case-insensitive), else the default. This one function
 * is used BOTH by the orchestrator's hello handler (deciding which
 * conversation the tab joins) and by the bridge's backend-qualified mailbox
 * drain (deciding whose buffers it receives) — confirming gate 2, P1: when
 * those two mappings disagreed, a tab joined one conversation and stranded
 * another's mailbox, so they now share this single implementation (and the
 * ui-bridge tests drive it, not a test-local approximation — gate 3, P2).
 */
export function normalizeHelloBackend(
  raw: unknown,
  knownBackends: ReadonlySet<string>,
  defaultBackend: string,
): string {
  const named = typeof raw === "string" ? raw.toLowerCase() : undefined;
  return named && knownBackends.has(named) ? named : defaultBackend;
}

/** A message's workflow origin, for detecting that the conversation's focus
 *  moved to a different workflow/tab between two user messages. */
export function messageOrigin(tabId: string, workflowUuid?: string): string {
  return `${tabId}|${workflowUuid ?? ""}`;
}

/**
 * The context line prepended to a user message when its ORIGIN workflow/tab
 * differs from the previous message's in the same conversation — this is how
 * one session keeps "knowledge of all open workflows": the agent is told,
 * mechanically and only on a change, which canvas it is now operating on.
 * Returns null when the origin is unchanged (or on the conversation's very
 * first message, where there is nothing to contrast with).
 */
export function workflowOriginNote(opts: {
  prevOrigin: string | undefined;
  origin: string;
  tabId: string;
  title?: string;
}): string | null {
  if (!opts.prevOrigin || opts.prevOrigin === opts.origin) return null;
  const label = opts.title?.trim() ? `“${opts.title.trim()}” (${opts.tabId})` : opts.tabId;
  return (
    `[panel: this message was sent from a different workflow than the previous one — ` +
    `you are now operating on ${label}. Panel/graph tools target THIS workflow now; ` +
    `the conversation itself continues (one session spans all open workflows).]`
  );
}

/**
 * A SHORT, still-DISTINGUISHING rendering of a tab id (#934).
 *
 * Tab ids come in two shapes. A browser tab is a uuid, where `.slice(0, 8)` is a
 * fine abbreviation — eight hex chars separate any two tabs you are likely to
 * hold at once. A workflow-keyed tab is `wf:<path>`, and there `.slice(0, 8)`
 * yields the literal string `wf:workf` for EVERY workflow under `workflows/`.
 *
 * That is how panel_set_workflow_target came to report
 *
 *     Rebound this session from tab wf:workf onto the active tab wf:workf
 *
 * for a rebind between two different workflows: the note read as a no-op, in the
 * middle of a wedge whose whole question was whether the retarget had done
 * anything. Two different tabs must not render identically.
 *
 * So: keep the uuid behaviour, and for a `wf:` id keep the part that actually
 * varies — the tail of the path, which carries the filename.
 */
export function shortTabId(id: string | undefined | null): string {
  if (!id) return String(id ?? "");
  if (!id.startsWith("wf:")) return id.slice(0, 8);
  const rest = id.slice(3);
  // #1285 — A TAB ID IS A ROUTE, NOT A PATH. The panel's own bridge-route.js
  // (#640) defines two shapes and says they are not interchangeable:
  //
  //   savedWorkflowHandle(path)           -> wf:<path>              names a WORKFLOW
  //   savedWorkflowRoute(tabRouteId,path) -> wf:<tabRouteId>:<path> names a TAB
  //
  // `bridge.tabs()` returns ROUTES, and this treated the whole remainder as a
  // path — so it rendered `wf:<tabRouteId>:<path>` down to just the basename and
  // threw away the ONE component that distinguishes two tabs showing the SAME
  // file. That is #934's failure returning by another door: two different tabs
  // rendering identically, in the messages written to tell them apart.
  //
  // The separator is the FIRST colon, because savedWorkflowRoute refuses a
  // tabRouteId containing one (verified against the live served panel). A path
  // may contain colons — `C:\…` — so a head that is one character, or that holds
  // a path separator, is not a route id and the whole remainder stays a path.
  const sep = rest.indexOf(":");
  const head = sep === -1 ? "" : rest.slice(0, sep);
  const isRoute = sep > 1 && !/[/\\]/.test(head);
  const path = isRoute ? rest.slice(sep + 1) : rest;
  // The basename is what distinguishes two workflow tabs; the directory prefix
  // is shared by all of them and is exactly what the old slice kept.
  const base = path.split(/[/\\]/).pop() || path;
  const MAX = 40;
  const shownPath = base.length > MAX ? `…${base.slice(-MAX)}` : base;
  return isRoute ? `wf:${head.slice(0, 6)}:${shownPath}` : `wf:${shownPath}`;
}
