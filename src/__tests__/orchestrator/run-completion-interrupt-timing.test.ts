// #2512 — an interrupted/cancelled prompt must emit its run-completion at
// interrupt time, with duration/finished-at from ComfyUI's execution record,
// not from the next "got prompt" an hour later.
//
// The panel defers its "Run finished … workflow completed in 79m" card until
// the next queue activity. The orchestrator already observes the interrupt
// (QueueMonitor) and already journals completions (RunCompletions). This file
// drives those shipped functions: buildCompletionNotification for timing, the
// watchdog + journal for immediate delivery.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../comfyui/client.js";
import { buildCompletionNotification } from "../../services/job-watcher.js";
import { extractExecutionStats } from "../../services/job-history.js";
import {
  createRunCompletionWatchdog,
  parseHistoryCompletion,
  synthesizeCompletionPayload,
  DEFAULT_SYNTHESIS_GRACE_MS,
} from "../../orchestrator/run-completion-watchdog.js";
import { RunCompletions, type CompletionPayload, type RunTicket } from "../../orchestrator/run-completion-journal.js";

const TAB = "tab-2512";
const CONV = "orchestrator::claude";
const PID = "0871d72c-2512-4c0e-9f14-cancelled-late";

/** Queue at 09:33:47, interrupt at 09:54:55 (ComfyUI: Prompt executed in 00:21:08). */
const QUEUED_AT = 1_700_000_000_000;
const INTERRUPT_MS = 21 * 60 * 1000 + 8 * 1000;
const INTERRUPTED_AT = QUEUED_AT + INTERRUPT_MS;
/** Next "got prompt" — the wall clock that used to inflate duration to ~79m. */
const NEXT_PROMPT_AT = QUEUED_AT + 79 * 60 * 1000 + 14 * 1000;

beforeEach(() => RunCompletions.reset());
afterEach(() => RunCompletions.reset());

function interruptedHistory(promptId: string): HistoryEntry {
  return {
    prompt: {},
    outputs: {},
    status: {
      status_str: "error",
      completed: true,
      messages: [
        ["execution_start", { prompt_id: promptId, timestamp: QUEUED_AT }],
        ["execution_interrupted", { prompt_id: promptId, timestamp: INTERRUPTED_AT }],
      ],
    },
  };
}

function makeWatchdog(
  clock: { t: number },
  resolveOutputs?: (promptId: string) => Promise<ReturnType<typeof parseHistoryCompletion>>,
) {
  const delivered: Array<{ payload: CompletionPayload; ticket: RunTicket }> = [];
  const wd = createRunCompletionWatchdog({
    awaiting: (id) => RunCompletions.awaitingCompletion(id),
    knownTicket: (id) => RunCompletions.ticketFor(id),
    deliver: (payload, ticket) => {
      delivered.push({ payload, ticket });
      RunCompletions.record(ticket.tabId, payload, {
        ...(ticket.conversation !== undefined ? { conversation: ticket.conversation } : {}),
      });
    },
    now: () => clock.t,
    ...(resolveOutputs ? { resolveOutputs } : {}),
  });
  return { wd, delivered };
}

describe("#2512: interrupted completion timing comes from ComfyUI, not next-prompt delivery", () => {
  it("buildCompletionNotification uses the interrupt timestamp, not Date.now() at a later prompt", () => {
    const entry = interruptedHistory(PID);
    const notification = buildCompletionNotification(PID, entry, QUEUED_AT);

    expect(notification.status).toBe("interrupted");
    expect(notification.duration_ms).toBe(INTERRUPT_MS);
    expect(Date.parse(notification.timestamp)).toBe(INTERRUPTED_AT);
    // The inflated wall-clock (queue → next prompt) must not win.
    expect(notification.duration_ms).toBeLessThan(NEXT_PROMPT_AT - QUEUED_AT);
    expect(Date.parse(notification.timestamp)).toBeLessThan(NEXT_PROMPT_AT);
  });

  it("extractExecutionStats treats execution_interrupted as the terminal end event", () => {
    const stats = extractExecutionStats(interruptedHistory(PID));
    expect(stats?.total_duration_ms).toBe(INTERRUPT_MS);
  });

  it("parseHistoryCompletion (the shipped history parse) carries that duration into the journal payload", () => {
    const parsed = parseHistoryCompletion(PID, interruptedHistory(PID));
    expect(parsed.status).toBe("interrupted");
    expect(parsed.duration_ms).toBe(INTERRUPT_MS);
    expect(Date.parse(parsed.timestamp)).toBe(INTERRUPTED_AT);
  });

  it("the synthesised interrupt notice names ComfyUI's duration, not the next-prompt wait", () => {
    const parsed = parseHistoryCompletion(PID, interruptedHistory(PID));
    const payload = synthesizeCompletionPayload(
      { promptId: PID, status: "interrupted", observedAt: INTERRUPTED_AT },
      {
        deliveredAt: NEXT_PROMPT_AT,
        durationMs: parsed.duration_ms,
        finishedAt: parsed.timestamp,
      },
    );
    expect(payload.run_status).toBe("interrupted");
    expect(payload.duration_ms).toBe(INTERRUPT_MS);
    expect(payload.finished_at).toBe(parsed.timestamp);
    expect(String(payload.note)).toContain("21m 8s");
    expect(String(payload.note)).not.toMatch(/79m/);
  });

  it("watchdog journals the interrupt immediately — not after grace, not at the next prompt", async () => {
    const clock = { t: INTERRUPTED_AT };
    const entry = interruptedHistory(PID);
    const { wd, delivered } = makeWatchdog(clock, async () => parseHistoryCompletion(PID, entry));
    expect(RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV })).toBe(true);

    wd.observe([{ promptId: PID, status: "interrupted" }]);
    await wd.tick();

    expect(delivered).toHaveLength(1);
    expect(wd.armedCount()).toBe(0);
    expect(delivered[0].payload.run_status).toBe("interrupted");
    expect(delivered[0].payload.duration_ms).toBe(INTERRUPT_MS);
    expect(Date.parse(String(delivered[0].payload.finished_at))).toBe(INTERRUPTED_AT);
    expect(String(delivered[0].payload.note)).toContain("INTERRUPTED");
    expect(String(delivered[0].payload.note)).toContain("21m 8s");

    const outstanding = RunCompletions.outstanding(TAB);
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0].correlation).toEqual({ status: "matched", promptId: PID });
    expect(outstanding[0].payload.duration_ms).toBe(INTERRUPT_MS);

    // An hour later the next prompt arrives. Nothing new is synthesised, and
    // duration stays the interrupt span — not queue-to-now.
    clock.t = NEXT_PROMPT_AT;
    await wd.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload.duration_ms).toBe(INTERRUPT_MS);
    expect(DEFAULT_SYNTHESIS_GRACE_MS).toBeGreaterThan(0);
  });
});
