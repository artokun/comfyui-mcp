// #977 — the orchestrator had no idea a multi-step plan was in flight.
//
// `panel_set_todo` was a pure pass-through to the panel UI: the checklist went to
// the browser and nothing here retained it. So when a render finished, the
// completion notification could only speak one way — "Reply with ONE short
// sentence … you do NOT need to call any tools" — which reads as "stop now".
//
// Combined with panel_run's own "just end your turn now and wait", the emergent
// default became: queue → end turn → render → one sentence → end turn again. A
// user running a five-variant sweep had to send a message to advance every step,
// while the orchestrator's system prompt was simultaneously telling the agent to
// treat a todo list as a loop and "keep going … Do NOT stop between steps". The
// per-event wording won because it is the most recent and most specific text in
// context.
//
// The checklist was the machine-readable signal all along — the agent had already
// declared the plan. Retaining it lets the completion notice distinguish "this
// was the last thing you were doing" from "you are three of five renders into a
// sweep you told the user about", which are different situations that deserve
// different instructions.

/** One checklist entry as `panel_set_todo` accepts it. */
export interface TodoItem {
  text?: unknown;
  status?: unknown;
}

/** What the last `panel_set_todo` on a tab declared. */
export interface TodoSnapshot {
  items: TodoItem[];
  /** Entries not yet finished — the ones that make a plan "in flight". */
  pending: number;
}

/** Statuses that mean "still to do". Anything else (done/completed/cancelled,
 *  or an unrecognised value) counts as settled — a plan is only treated as
 *  in-flight on POSITIVE evidence, so an unknown status can never manufacture
 *  one and suppress the yield nudge forever. */
const PENDING_STATUSES = new Set(["pending", "in_progress", "in-progress", "todo", "active"]);

const byTab = new Map<string, TodoSnapshot>();

/** Bounded: one snapshot per tab, and tabs are few. Guards against a pathological
 *  churn of synthetic tab ids retaining memory forever. */
const MAX_TABS = 64;

export function recordTodo(tabId: string | undefined, items: unknown): void {
  if (!tabId) return;
  if (!Array.isArray(items)) {
    // A malformed payload tells us nothing about the plan. Forgetting is safer
    // than keeping a stale snapshot that would keep claiming work remains.
    byTab.delete(tabId);
    return;
  }
  const list = items as TodoItem[];
  const pending = list.filter(
    (i) => typeof i?.status === "string" && PENDING_STATUSES.has(i.status.trim().toLowerCase()),
  ).length;
  byTab.set(tabId, { items: list, pending });
  while (byTab.size > MAX_TABS) {
    const oldest = byTab.keys().next().value;
    if (oldest === undefined) break;
    byTab.delete(oldest);
  }
}

/** The last checklist this tab declared, or undefined if it never did. */
export function todoFor(tabId: string | undefined): TodoSnapshot | undefined {
  return tabId ? byTab.get(tabId) : undefined;
}

/**
 * Is a multi-step plan still running on this tab?
 *
 * Requires POSITIVE evidence — a retained checklist with at least one unfinished
 * entry. No checklist, an empty one, or one whose entries are all settled all
 * answer false, so the ordinary "acknowledge and stop" wording remains the
 * default and only a declared, unfinished plan changes it.
 */
export function planInFlight(tabId: string | undefined): boolean {
  return (todoFor(tabId)?.pending ?? 0) > 0;
}

/** Test seam — the map is module state. */
export function __resetTodoState(): void {
  byTab.clear();
}

/**
 * The closing instruction on a render-completion notice (#977).
 *
 * Named and exported rather than inlined in PanelAgent.injectEvent, because
 * inline it was reachable only through a full agent harness — and a mutation
 * that ignored the plan entirely (the exact regression) broke no test at all.
 *
 * The wording is the whole fix: a fixed "you do NOT need to call any tools"
 * reads as "stop now", and an agent three renders into a sweep it announced will
 * obey the most recent, most specific instruction over the system prompt telling
 * it to keep going.
 *
 * #2369 — a replayed (re-delivered after journal replay) completion has no plan
 * context to continue. A completion-only replay that includes "CONTINUE your plan"
 * turns a single late handoff into an unbounded loop: each replay becomes a new
 * user turn, the agent replies, and the next replay cycles it again. Replayed
 * completions always get the acknowledge-and-stop wording, even if a plan remains
 * in flight.
 */
export function runCompletionDirective(tabId: string | undefined, opts?: { replayed?: boolean }): string {
  // Replayed completions carry no plan context — they are ancient messages
  // re-delivered from the journal after an MCP reconnect. Instruct the agent to
  // acknowledge and stop, not continue, even if a plan remains.
  if (opts?.replayed) {
    return `Reply with ONE short sentence acknowledging the result and suggesting a sensible next step — you do NOT need to call any tools. Don't repeat an earlier comment.`;
  }
  return planInFlight(tabId)
    ? `Acknowledge the result in ONE short sentence, then CONTINUE your plan — you have unfinished items on your todo list, so do NOT stop here or wait for the user. Carry straight on with the next step (queue it now if that is what the plan says). Don't repeat an earlier comment.`
    : `Reply with ONE short sentence acknowledging the result and suggesting a sensible next step — you do NOT need to call any tools. Don't repeat an earlier comment.`;
}

// ---------------------------------------------------------------------------
// #1018 — the status vocabulary the caller brings.
//
// The schema accepted exactly `pending` | `active` | `done`, and an agent's FIRST
// panel_set_todo submitted `in_progress` and `completed`. Those are not a typo:
// they are the near-universal todo vocabulary in agent tooling, so an agent that
// has never read this particular tool's enum reaches for them by default. The
// call was rejected at the protocol layer with a bare
//
//     MCP error -32602: Input validation error; expected one of `pending`|`active`|`done`
//
// which costs a full round trip at exactly the worst moment — plan setup, the
// first thing the user sees. Nothing about the request was ambiguous: the intent
// of `in_progress` is not in question.
//
// So the schema accepts the aliases and normalizes them here, at the boundary.
// Everything downstream — the panel UI, recordTodo's snapshot (#977), the
// completion-directive logic that reads it — continues to see ONLY the canonical
// three. This adds no new state and changes no behaviour for a caller that
// already used the canonical values.
//
// The tool DESCRIPTION still teaches `pending → active → done`, deliberately.
// The aliases are a compatibility shim, not a second vocabulary to document: an
// agent should be told one set of names, and simply not be punished for the
// obvious synonyms.

/** Canonical checklist states, in progress order. */
export const TODO_STATUSES = ["pending", "active", "done"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

/**
 * Accepted synonyms → canonical. Kept deliberately small: these are the spellings
 * agents actually produce, not an open thesaurus. An unknown value is NOT mapped
 * — it still fails validation, because guessing at a status nobody recognises
 * would put a wrong state in front of the user.
 */
const TODO_STATUS_ALIASES: Record<string, TodoStatus> = {
  in_progress: "active",
  "in-progress": "active",
  inprogress: "active",
  running: "active",
  current: "active",
  completed: "done",
  complete: "done",
  finished: "done",
  todo: "pending",
  not_started: "pending",
  "not-started": "pending",
  queued: "pending",
};

/** Every spelling the schema admits (canonical first, for the error message). */
export const TODO_STATUS_INPUTS: string[] = [...TODO_STATUSES, ...Object.keys(TODO_STATUS_ALIASES)];

/** Map an accepted spelling to its canonical form. Unknown input is returned
 *  unchanged — validation, not this function, is what rejects it. */
export function normalizeTodoStatus(status: string): string {
  if ((TODO_STATUSES as readonly string[]).includes(status)) return status;
  return TODO_STATUS_ALIASES[status.trim().toLowerCase()] ?? status;
}

/** Normalize a checklist's statuses in place-safe fashion (returns a new array).
 *  Items without a status are left alone — the default is applied downstream. */
export function normalizeTodoItems<T extends { status?: unknown }>(items: T[]): T[] {
  return items.map((item) =>
    typeof item?.status === "string" ? { ...item, status: normalizeTodoStatus(item.status) } : item,
  );
}

/** One checklist row after the aliases and the implied default are folded away.
 *  Used to compare a delivered `set_todo` against a later `get_todo` read (#2481). */
export interface CanonicalTodoEntry {
  text: string;
  status: string;
}

function todoStatusOrDefault(status: unknown): string {
  return typeof status === "string" && status.trim() !== ""
    ? normalizeTodoStatus(status)
    : "pending";
}

function todoTextOf(entry: Record<string, unknown>): string | null {
  if (typeof entry.text === "string") return entry.text;
  if (typeof entry.content === "string") return entry.content;
  return null;
}

/**
 * Fold a checklist into comparable `{text, status}` rows, or null when the
 * payload is not a list of items with a step description. Empty is valid (clear
 * the tray). Missing status is `pending` — the schema's default, which the panel
 * applies even when the caller omitted it.
 */
export function canonicalTodoEntries(items: unknown): CanonicalTodoEntry[] | null {
  if (!Array.isArray(items)) return null;
  const out: CanonicalTodoEntry[] = [];
  for (const entry of items) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const rec = entry as Record<string, unknown>;
    const text = todoTextOf(rec);
    if (text === null) return null;
    out.push({ text, status: todoStatusOrDefault(rec.status) });
  }
  return out;
}

/** True when both payloads describe the same ordered checklist. */
export function todoListsMatch(sent: unknown, observed: unknown): boolean {
  const a = canonicalTodoEntries(sent);
  const b = canonicalTodoEntries(observed);
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text || a[i].status !== b[i].status) return false;
  }
  return true;
}
