// #1789 — `panel_run` promised "you WILL be notified … end your turn now and
// wait", the panel's `executed` frame never arrived, and the agent sat idle
// through a clean 28.77s render until a human broke the silence.
//
// Two halves are pinned here:
//   1. DELIVERY. The orchestrator already observes every completion on the
//      monitored ComfyUI (QueueMonitor's 1 Hz /history tail diff). The watchdog
//      joins that observation to the open panel_run ticket and synthesises the
//      completion the panel never sent — into the SAME journal, so it is
//      correlated as the run the agent queued, replayed if no agent takes it,
//      and acked like any other.
//   2. THE PROMISE. panel_run's rider no longer forbids ever looking; it names
//      ONE bounded check with the prompt id.
//
// The journal-level tests drive the REAL RunCompletions singleton, so a
// regression in `awaitingCompletion` (the predicate the whole fallback is gated
// on) fails here rather than shipping.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../comfyui/client.js";
import {
  createRunCompletionWatchdog,
  synthesizeCompletionPayload,
  resolveHistoryCompletionImages,
  resolveHistoryCompletionStatus,
  completionStatusFromHistoryEntry,
  historyOutputRefsFromEntry,
  DEFAULT_SYNTHESIS_GRACE_MS,
  DEFAULT_STORYBOARD_GRACE_MS,
} from "../../orchestrator/run-completion-watchdog.js";
import type { CompletionStatus } from "../../services/queue-monitor.js";
import { RunCompletions, type CompletionPayload, type RunTicket } from "../../orchestrator/run-completion-journal.js";

const TAB = "tab-1789";
const CONV = "orchestrator::claude";
const PID = "d5e14286-b746-4817-9ce5-45fc052b6a8f";

beforeEach(() => RunCompletions.reset());
afterEach(() => RunCompletions.reset());

/** A watchdog wired to the real journal, with a controllable clock. */
function makeWatchdog(
  clock: { t: number },
  extras: {
    resolveOutputs?: (promptId: string) => Promise<CompletionPayload["images"]>;
    lookupStatus?: (promptId: string) => Promise<CompletionStatus | null>;
  } = {},
) {
  const delivered: Array<{ payload: CompletionPayload; ticket: RunTicket }> = [];
  const wd = createRunCompletionWatchdog({
    awaiting: (id) => RunCompletions.awaitingCompletion(id),
    deliver: (payload, ticket) => {
      delivered.push({ payload, ticket });
      RunCompletions.record(ticket.tabId, payload, {
        ...(ticket.conversation !== undefined ? { conversation: ticket.conversation } : {}),
      });
    },
    now: () => clock.t,
    ...(extras.resolveOutputs ? { resolveOutputs: extras.resolveOutputs } : {}),
    ...(extras.lookupStatus ? { lookupStatus: extras.lookupStatus } : {}),
  });
  return { wd, delivered };
}

const VIDEO_FILENAME = "perfume_citrus_spring_00001_.mp4";
const VIDEO_SUBFOLDER = "video";

function saveVideoHistoryEntry(promptId: string): HistoryEntry {
  return {
    prompt: {},
    outputs: {
      "12": {
        videos: [{ filename: VIDEO_FILENAME, subfolder: VIDEO_SUBFOLDER, type: "output" }],
      },
    },
    status: {
      status_str: "success",
      completed: true,
      messages: [
        ["execution_start", { prompt_id: promptId, timestamp: 1_000 }],
        ["execution_success", { prompt_id: promptId, timestamp: 503_060 }],
      ],
    },
  } as HistoryEntry;
}

describe("#1789: a completion the panel never reported is filled in from ComfyUI's history", () => {
  it("synthesises the completion for an open ticket once the grace elapses", () => {
    const clock = { t: 1_000_000 };
    const { wd, delivered } = makeWatchdog(clock);
    expect(RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV })).toBe(true);

    wd.observe([{ promptId: PID, status: "success" }]);
    expect(wd.armedCount()).toBe(1);

    // Inside the grace: stay quiet — the panel's own frame is still the better
    // one and its reconcile sweep has not even run yet.
    clock.t += DEFAULT_SYNTHESIS_GRACE_MS - 1;
    wd.tick();
    expect(delivered).toHaveLength(0);

    clock.t += 2;
    wd.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload.prompt_id).toBe(PID);
    expect(delivered[0].ticket.tabId).toBe(TAB);
    expect(wd.armedCount()).toBe(0);
  });

  it("the synthesised completion is CORRELATED as the run the agent queued, and reaches an agent", () => {
    const clock = { t: 2_000_000 };
    const { wd } = makeWatchdog(clock);
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    wd.observe([{ promptId: PID, status: "success" }]);
    clock.t += DEFAULT_SYNTHESIS_GRACE_MS;
    wd.tick();

    const outstanding = RunCompletions.outstanding(TAB);
    expect(outstanding).toHaveLength(1);
    // NOT "foreign"/UNDETERMINED: the agent must be told this is ITS render.
    expect(outstanding[0].correlation).toEqual({ status: "matched", promptId: PID });

    const seen: CompletionPayload[] = [];
    const { delivered: n } = RunCompletions.deliverPending(TAB, (p) => {
      seen.push(p);
      return true;
    });
    expect(n).toBe(1);
    expect(seen[0].run_correlation).toBe("matched");
    expect(String(seen[0].note)).toContain("finished SUCCESSFULLY");
  });

  it("stays SILENT when the panel's real frame lands inside the grace", () => {
    const clock = { t: 3_000_000 };
    const { wd, delivered } = makeWatchdog(clock);
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    wd.observe([{ promptId: PID, status: "success" }]);

    // The panel reports it — the normal path — while the arm is still held.
    RunCompletions.record(TAB, { kind: "executed", prompt_id: PID, images: [{ filename: "a.png" }] }, { conversation: CONV });

    clock.t += DEFAULT_SYNTHESIS_GRACE_MS + 1;
    wd.tick();
    expect(delivered).toHaveLength(0);
    // …and the agent still gets exactly ONE completion: the panel's, with pixels.
    expect(RunCompletions.outstanding(TAB)).toHaveLength(1);
    expect(RunCompletions.outstanding(TAB)[0].payload.images).toHaveLength(1);
  });

  it("stays silent for a run this session never queued (a render the USER started)", () => {
    const clock = { t: 4_000_000 };
    const { wd, delivered } = makeWatchdog(clock);
    // No openRun at all — there is no promise to keep, and waking the agent for
    // a foreign render is the failure #889/#559 already paid for.
    wd.observe([{ promptId: "p-foreign", status: "success" }]);
    expect(wd.armedCount()).toBe(0);
    clock.t += DEFAULT_SYNTHESIS_GRACE_MS + 1;
    wd.tick();
    expect(delivered).toHaveLength(0);
  });

  it("stays silent once the run's completion has already been ACKED", () => {
    const clock = { t: 5_000_000 };
    const { wd, delivered } = makeWatchdog(clock);
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    const entry = RunCompletions.record(TAB, { kind: "executed", prompt_id: PID }, { conversation: CONV });
    RunCompletions.deliverPending(TAB, () => true);
    RunCompletions.ack(entry.token); // the turn that carried it ended

    wd.observe([{ promptId: PID, status: "success" }]);
    expect(wd.armedCount()).toBe(0); // settled ticket ⇒ nothing is owed
    clock.t += DEFAULT_SYNTHESIS_GRACE_MS + 1;
    wd.tick();
    expect(delivered).toHaveLength(0);
  });

  it("a re-observation does NOT push the deadline out", () => {
    const clock = { t: 6_000_000 };
    const { wd, delivered } = makeWatchdog(clock);
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    wd.observe([{ promptId: PID, status: "success" }]);
    // A repeated observation every second, forever, must not make the arm
    // immortal — that would reproduce the very "waits indefinitely" bug.
    for (let i = 0; i < 60; i++) {
      clock.t += 1000;
      wd.observe([{ promptId: PID, status: "success" }]);
    }
    wd.tick();
    expect(delivered).toHaveLength(1);
  });

  it("a FAILED run is reported as a failure — and NOT as an urgent run_error", () => {
    const clock = { t: 7_000_000 };
    const { wd, delivered } = makeWatchdog(clock);
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    wd.observe([{ promptId: PID, status: "error" }]);
    clock.t += DEFAULT_SYNTHESIS_GRACE_MS;
    wd.tick();
    expect(delivered).toHaveLength(1);
    // `run_error` INTERRUPTS the live turn; a status read out of a history
    // record a minute later does not warrant that blast radius (#1489).
    expect(delivered[0].payload.kind).toBe("executed");
    expect(String(delivered[0].payload.note)).toContain("FAILED");
    expect(String(delivered[0].payload.note)).toContain("Do NOT report the run as successful");
  });

  it("a deliver() that throws does not re-fire on every later tick", () => {
    const clock = { t: 8_000_000 };
    let calls = 0;
    const wd = createRunCompletionWatchdog({
      awaiting: (id) => RunCompletions.awaitingCompletion(id),
      deliver: () => {
        calls++;
        throw new Error("boom");
      },
      now: () => clock.t,
    });
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    wd.observe([{ promptId: PID, status: "success" }]);
    clock.t += DEFAULT_SYNTHESIS_GRACE_MS;
    wd.tick();
    wd.tick();
    wd.tick();
    expect(calls).toBe(1);
  });
});

describe("#1789: awaitingCompletion answers 'is this run still owed its notification?'", () => {
  it("#1556: the grace no longer waits for a panel sweep that may never come", () => {
    // The panel's own recovery sweep is 20 s. Waiting past it is what left the
    // reporter's successful SaveImage silent for 45 s, so the grace stays under
    // it and reconnect skips even that (reconcile()). #2001 raised the number
    // from 5 s to 10 s because 5 s was under the panel's OWN still-probe bound —
    // see the #2001 block below for the behaviour that pins it.
    expect(DEFAULT_SYNTHESIS_GRACE_MS).toBeLessThan(20_000);
    expect(DEFAULT_SYNTHESIS_GRACE_MS).toBeGreaterThan(1_000);
  });

  it("true for a fresh ticket, false once ANY completion for it is journaled", () => {
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    expect(RunCompletions.awaitingCompletion(PID)?.promptId).toBe(PID);
    expect(RunCompletions.owedCompletions().map((t) => t.promptId)).toEqual([PID]);
    RunCompletions.record(TAB, { kind: "executed", prompt_id: PID }, { conversation: CONV });
    expect(RunCompletions.awaitingCompletion(PID)).toBeUndefined();
    expect(RunCompletions.owedCompletions()).toEqual([]);
  });

  it("false while the completion is merely HANDED OFF (the journal owns the replay from there)", () => {
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    RunCompletions.record(TAB, { kind: "executed", prompt_id: PID }, { conversation: CONV });
    RunCompletions.deliverPending(TAB, () => true); // state → handed_off, not acked
    expect(RunCompletions.awaitingCompletion(PID)).toBeUndefined();
  });

  it("false for a REUSED prompt id — a synthesised notice could not say WHICH run finished", () => {
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV }); // queued again
    expect(RunCompletions.ticketFor(PID)?.reused).toBe(true);
    expect(RunCompletions.awaitingCompletion(PID)).toBeUndefined();
  });

  it("false for an id with no ticket at all", () => {
    expect(RunCompletions.awaitingCompletion("nobody-queued-this")).toBeUndefined();
  });
});

describe("#1789: the synthesised note claims only what was observed", () => {
  it("names the prompt id, the delay, and where the images actually are", () => {
    const payload = synthesizeCompletionPayload(
      { promptId: PID, status: "success", observedAt: 1000 },
      { deliveredAt: 1000 + 46_000 },
    );
    const note = String(payload.note);
    expect(note).toContain(PID);
    expect(note).toContain("46s");
    // #2001 — WHAT WAS OBSERVED, NOT WHAT THE PANEL DID. This used to read "the
    // panel never delivered its completion event", which the orchestrator cannot
    // know: all it saw is that no completion reached IT. A panel still composing
    // its frame (bounded at 8 s per still probe, 25 s per video storyboard) was
    // reported as a broken panel, and #2001 is that notice, filed as a bug.
    expect(note).toContain("No completion for it reached the orchestrator");
    expect(note).not.toContain("the panel never delivered");
    // …and the agent is told what the late panel frame it may still get MEANS,
    // so one render is not reported as two.
    expect(note).toContain("possible repeat");
    expect(note).toContain("not a second render");
    // It must NOT pretend to carry pixels it never fetched.
    expect(payload.images).toEqual([]);
    expect(note).toContain('get_image (action:"list_outputs")');
    // Machine-readable provenance, so a consumer can tell this from a panel frame.
    expect(payload.completion_source).toBe("orchestrator-history-watchdog");
    expect(payload.run_status).toBe("success");
  });

  it("an INTERRUPTED run is not described as a crash", () => {
    const note = String(
      synthesizeCompletionPayload(
        { promptId: PID, status: "interrupted", observedAt: 0 },
        { deliveredAt: 45_000 },
      ).note,
    );
    expect(note).toContain("INTERRUPTED");
    expect(note).toContain("Nothing crashed");
  });

  it("#1853: history output refs ride the synthesised payload, and the note stops claiming they are missing", () => {
    const refs = historyOutputRefsFromEntry(PID, saveVideoHistoryEntry(PID));
    const payload = synthesizeCompletionPayload(
      { promptId: PID, status: "success", observedAt: 1000 },
      { deliveredAt: 1000 + 46_000, images: refs },
    );
    // #1861 — the refs still ride, but a VIDEO is NAMED, never attached. `images` is
    // consumed by attaching inline with the media type forced to image/png, so an .mp4
    // in it becomes ftyp bytes sent as a PNG. This test previously asserted exactly that.
    expect(payload.images.some((img) => img.filename === VIDEO_FILENAME)).toBe(false);
    expect(String(payload.note)).toContain(VIDEO_FILENAME);
    expect(String(payload.note)).toContain("NOT attached (not an inline-attachable image)");
    // The agent still learns the run produced output and how to get it.
    expect(String(payload.note)).toContain("get_image");
  });

  it("#1861: the allowlist tracks what the ATTACH PATH can label, not what is an image", () => {
    // claude-backend.ts keeps only image/{png,jpeg,gif,webp} and rewrites everything else
    // to image/png. .bmp IS an image, and ComfyUI serves it image/bmp — so attaching it
    // would declare PNG over BMP bytes. A smaller lie than an .mp4, the same lie.
    const payload = synthesizeCompletionPayload(
      { promptId: PID, status: "success", observedAt: 0 },
      {
        deliveredAt: 45_000,
        images: [
          { filename: "keep_00001_.png", type: "output" },
          { filename: "keep_00002_.WEBP", type: "output" },
          { filename: "name_only_00001_.bmp", type: "output" },
          { filename: "name_only_00002_.avif", type: "output" },
          { filename: "no_extension_at_all", type: "output" },
        ],
      },
    );
    expect(payload.images.map((i) => i.filename)).toEqual(["keep_00001_.png", "keep_00002_.WEBP"]);
    for (const named of ["name_only_00001_.bmp", "name_only_00002_.avif", "no_extension_at_all"]) {
      expect(String(payload.note)).toContain(named);
    }
    expect(String(payload.note)).toContain("NOT attached (not an inline-attachable image)");
  });

  it("empty or malformed image refs are dropped, never forwarded as outputs", () => {
    const payload = synthesizeCompletionPayload(
      { promptId: PID, status: "success", observedAt: 0 },
      {
        deliveredAt: 45_000,
        images: [
          { filename: "" },
          { filename: "   " },
          // An IMAGE here: this test is about blanks and dedup, and a video fixture would
          // now be filtered for an unrelated reason and prove nothing about either.
          { filename: "render_00001_.png", subfolder: "out", type: "output" },
          { filename: "render_00001_.png", subfolder: "out", type: "output" },
        ],
      },
    );
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0].filename).toBe("render_00001_.png");
  });
});

describe("#1853: a dropped panel frame still yields the completed prompt's history outputs", () => {
  it("the synthesised completion NAMES SaveVideo outputs from /history, and never attaches them", async () => {
    const clock = { t: 9_000_000 };
    const entry = saveVideoHistoryEntry(PID);
    const { wd, delivered } = makeWatchdog(clock, {
      resolveOutputs: (id) =>
        resolveHistoryCompletionImages(id, async (promptId) => ({ [promptId]: entry })),
    });
    expect(RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV })).toBe(true);

    wd.observe([{ promptId: PID, status: "success" }]);
    // #2001 — a SaveVideo run is one the panel has to storyboard before it can
    // send, and it bounds that at 25 s. The ordinary grace must NOT pre-empt it.
    clock.t += DEFAULT_SYNTHESIS_GRACE_MS;
    await wd.tick();
    expect(delivered).toHaveLength(0);
    expect(wd.armedCount()).toBe(1);

    clock.t += DEFAULT_STORYBOARD_GRACE_MS - DEFAULT_SYNTHESIS_GRACE_MS;
    await wd.tick();

    expect(delivered).toHaveLength(1);
    const payload = delivered[0].payload;
    expect(payload.prompt_id).toBe(PID);
    // #1861 — a video must never reach `images`: its only consumer attaches inline with
    // the type forced to image/png.
    expect(payload.images.some((img) => img.filename === VIDEO_FILENAME)).toBe(false);
    expect(String(payload.note)).toContain(VIDEO_FILENAME);
    expect(String(payload.note)).toContain("NOT attached (not an inline-attachable image)");

    const seen: CompletionPayload[] = [];
    RunCompletions.deliverPending(TAB, (p) => {
      seen.push(p);
      return true;
    });
    expect(seen[0].images.some((img) => img.filename === VIDEO_FILENAME)).toBe(false);
    expect(String(seen[0].note)).toContain(VIDEO_FILENAME);
  });

  it("history with no media stays status-only — nothing is invented", async () => {
    const clock = { t: 10_000_000 };
    const empty: HistoryEntry = {
      prompt: {},
      outputs: {},
      status: { status_str: "success", completed: true, messages: [] },
    };
    const { wd, delivered } = makeWatchdog(clock, {
      resolveOutputs: (id) =>
        resolveHistoryCompletionImages(id, async (promptId) => ({ [promptId]: empty })),
    });
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    wd.observe([{ promptId: PID, status: "success" }]);
    clock.t += DEFAULT_SYNTHESIS_GRACE_MS;
    await wd.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload.images).toEqual([]);
    expect(String(delivered[0].payload.note)).toContain("NOT attached");
  });

  it("a history fetch failure still delivers the status-only notice", async () => {
    const clock = { t: 11_000_000 };
    const { wd, delivered } = makeWatchdog(clock, {
      resolveOutputs: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    wd.observe([{ promptId: PID, status: "success" }]);
    clock.t += DEFAULT_SYNTHESIS_GRACE_MS;
    await wd.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload.images).toEqual([]);
    expect(String(delivered[0].payload.note)).toContain("NOT attached");
  });

  it("a panel frame that lands during the history fetch still wins", async () => {
    const clock = { t: 12_000_000 };
    let release!: (refs: NonNullable<CompletionPayload["images"]>) => void;
    const { wd, delivered } = makeWatchdog(clock, {
      resolveOutputs: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    wd.observe([{ promptId: PID, status: "success" }]);
    clock.t += DEFAULT_SYNTHESIS_GRACE_MS;
    const pending = wd.tick();
    RunCompletions.record(
      TAB,
      { kind: "executed", prompt_id: PID, images: [{ filename: "storyboard.png" }] },
      { conversation: CONV },
    );
    release([{ filename: VIDEO_FILENAME, subfolder: VIDEO_SUBFOLDER, type: "output" }]);
    await pending;
    expect(delivered).toHaveLength(0);
    expect(RunCompletions.outstanding(TAB)[0].payload.images).toEqual([{ filename: "storyboard.png" }]);
  });

  it("resolveHistoryCompletionImages returns [] when /history has no entry for the prompt", async () => {
    const refs = await resolveHistoryCompletionImages(PID, async () => ({}));
    expect(refs).toEqual([]);
  });

  it("historyOutputRefsFromEntry reads images AND videos through the shipped parser", () => {
    const entry = {
      prompt: {},
      outputs: {
        "9": { images: [{ filename: "still.png", subfolder: "", type: "output" }] },
        "12": { videos: [{ filename: VIDEO_FILENAME, subfolder: VIDEO_SUBFOLDER, type: "output" }] },
      },
      status: { status_str: "success", completed: true, messages: [] },
    } as HistoryEntry;
    const refs = historyOutputRefsFromEntry(PID, entry);
    expect(refs.some((img) => img.filename === "still.png")).toBe(true);
    expect(refs.some((img) => img.filename === VIDEO_FILENAME && img.subfolder === VIDEO_SUBFOLDER)).toBe(true);
  });
});

describe("#1556: reconnect reconciles owed panel_run ids against ComfyUI history immediately", () => {
  it("an already-armed observation is delivered without waiting the grace", async () => {
    const clock = { t: 20_000_000 };
    const { wd, delivered } = makeWatchdog(clock);
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    wd.observe([{ promptId: PID, status: "success" }]);
    expect(wd.armedCount()).toBe(1);

    await wd.reconcile([]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload.prompt_id).toBe(PID);
    expect(wd.armedCount()).toBe(0);
    expect(RunCompletions.awaitingCompletion(PID)).toBeUndefined();
  });

  it("an unarmed owed ticket is synthesised from /history on reconcile, not after the grace", async () => {
    const clock = { t: 21_000_000 };
    const lookedUp: string[] = [];
    const { wd, delivered } = makeWatchdog(clock, {
      lookupStatus: async (id) => {
        lookedUp.push(id);
        return resolveHistoryCompletionStatus(id, async (promptId) => ({
          [promptId]: {
            prompt: {},
            outputs: {
              "9": { images: [{ filename: "ComfyUI_00001_.png", type: "output" }] },
            },
            status: { status_str: "success", completed: true, messages: [] },
          },
        }));
      },
      resolveOutputs: (id) =>
        resolveHistoryCompletionImages(id, async (promptId) => ({
          [promptId]: {
            prompt: {},
            outputs: {
              "9": { images: [{ filename: "ComfyUI_00001_.png", type: "output" }] },
            },
            status: { status_str: "success", completed: true, messages: [] },
          },
        })),
    });
    expect(RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV })).toBe(true);
    expect(wd.armedCount()).toBe(0);

    await wd.reconcile(RunCompletions.owedCompletions().map((t) => t.promptId));

    expect(lookedUp).toEqual([PID]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload.prompt_id).toBe(PID);
    expect(delivered[0].payload.completion_source).toBe("orchestrator-history-watchdog");
    expect(delivered[0].payload.images).toEqual([{ filename: "ComfyUI_00001_.png", type: "output" }]);
    expect(RunCompletions.outstanding(TAB)[0].correlation).toEqual({ status: "matched", promptId: PID });
  });

  it("a still-running history record is NOT synthesised", async () => {
    const clock = { t: 22_000_000 };
    const { wd, delivered } = makeWatchdog(clock, {
      lookupStatus: (id) =>
        resolveHistoryCompletionStatus(id, async (promptId) => ({
          [promptId]: {
            prompt: {},
            outputs: {},
            status: { status_str: "running", completed: false, messages: [] },
          },
        })),
    });
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    await wd.reconcile([PID]);
    expect(delivered).toHaveLength(0);
    expect(RunCompletions.awaitingCompletion(PID)?.promptId).toBe(PID);
  });

  it("a missing history record is NOT synthesised", async () => {
    const clock = { t: 23_000_000 };
    const { wd, delivered } = makeWatchdog(clock, {
      lookupStatus: (id) => resolveHistoryCompletionStatus(id, async () => ({})),
    });
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    await wd.reconcile([PID]);
    expect(delivered).toHaveLength(0);
  });

  it("a ticket the panel already journaled is skipped — exactly one completion", async () => {
    const clock = { t: 24_000_000 };
    let lookups = 0;
    const { wd, delivered } = makeWatchdog(clock, {
      lookupStatus: async () => {
        lookups += 1;
        return "success";
      },
    });
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    RunCompletions.record(
      TAB,
      { kind: "executed", prompt_id: PID, images: [{ filename: "panel.png" }] },
      { conversation: CONV },
    );

    await wd.reconcile([PID]);
    expect(lookups).toBe(0);
    expect(delivered).toHaveLength(0);
    expect(RunCompletions.outstanding(TAB)).toHaveLength(1);
    expect(RunCompletions.outstanding(TAB)[0].payload.images).toEqual([{ filename: "panel.png" }]);
  });

  it("reconcile is idempotent — a second call does not produce a second delivery", async () => {
    const clock = { t: 25_000_000 };
    const { wd, delivered } = makeWatchdog(clock, {
      lookupStatus: async () => "success",
    });
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    await wd.reconcile([PID]);
    await wd.reconcile([PID]);
    expect(delivered).toHaveLength(1);
  });

  it("a foreign prompt this session never queued is not looked up", async () => {
    const clock = { t: 26_000_000 };
    const lookedUp: string[] = [];
    const { wd, delivered } = makeWatchdog(clock, {
      lookupStatus: async (id) => {
        lookedUp.push(id);
        return "success";
      },
    });
    await wd.reconcile(["p-foreign"]);
    expect(lookedUp).toEqual([]);
    expect(delivered).toHaveLength(0);
  });

  it("a panel frame that lands during the history-status lookup still wins", async () => {
    const clock = { t: 27_000_000 };
    let release!: (status: CompletionStatus | null) => void;
    const { wd, delivered } = makeWatchdog(clock, {
      lookupStatus: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    const pending = wd.reconcile([PID]);
    RunCompletions.record(
      TAB,
      { kind: "executed", prompt_id: PID, images: [{ filename: "storyboard.png" }] },
      { conversation: CONV },
    );
    release("success");
    await pending;
    expect(delivered).toHaveLength(0);
    expect(RunCompletions.outstanding(TAB)[0].payload.images).toEqual([{ filename: "storyboard.png" }]);
  });
});

describe("#1556: completionStatusFromHistoryEntry is fail-closed", () => {
  it("success / interrupted / error from the shipped history shape", () => {
    expect(
      completionStatusFromHistoryEntry({
        status: { status_str: "success", completed: true, messages: [] },
      }),
    ).toBe("success");
    expect(
      completionStatusFromHistoryEntry({
        status: {
          status_str: "error",
          completed: false,
          messages: [["execution_interrupted", { prompt_id: PID }]],
        },
      }),
    ).toBe("interrupted");
    expect(
      completionStatusFromHistoryEntry({
        status: {
          status_str: "error",
          completed: true,
          messages: [["execution_error", { prompt_id: PID }]],
        },
      }),
    ).toBe("error");
  });

  it("missing, unreadable, or still-running records are null — never a fabricated finish", () => {
    expect(completionStatusFromHistoryEntry(undefined)).toBeNull();
    expect(completionStatusFromHistoryEntry(null)).toBeNull();
    expect(completionStatusFromHistoryEntry({})).toBeNull();
    expect(
      completionStatusFromHistoryEntry({
        status: { status_str: "running", completed: false, messages: [] },
      }),
    ).toBeNull();
  });

  it("resolveHistoryCompletionStatus drives getHistory and returns null on an empty map", async () => {
    expect(await resolveHistoryCompletionStatus(PID, async () => ({}))).toBeNull();
    expect(await resolveHistoryCompletionStatus("", async () => ({}))).toBeNull();
    expect(
      await resolveHistoryCompletionStatus(PID, async (id) => ({
        [id]: {
          prompt: {},
          outputs: {},
          status: { status_str: "success", completed: true, messages: [] },
        },
      })),
    ).toBe("success");
  });
});

// #2001 — THE ORCHESTRATOR MUST NOT ANNOUNCE A SILENCE THE PANEL HAS NOT REACHED.
//
// #1556 cut the grace to 5 s on the premise that the panel's frame "lands within
// a second or two". The panel composes ONE consolidated frame and sends nothing
// until every part of it resolves, and its own code bounds that work past 5 s:
// 8 s per still probe (`fetchImageBytes` / `fetchImageDimensions`) and 25 s per
// video storyboard (`videoStoryboardTimeoutMs`). At 5 s the orchestrator was
// therefore pre-empting a working panel and telling the agent, in words, that
// the panel "never delivered its completion event" — which is what #2001
// reported, twice, five seconds after two clean SaveImage renders.
//
// Both halves are pinned by BEHAVIOUR with literal millisecond bounds, not by
// re-reading the constants under test: put the old 5 s back, or drop the
// storyboard extension, and these fail.
describe("#2001: the grace is read off the panel's own send bounds", () => {
  /** A completed stills-only run — nothing here needs a storyboard. */
  const stillsHistory = (promptId: string): HistoryEntry =>
    ({
      prompt: {},
      outputs: { "9": { images: [{ filename: "ComfyUI_00042_.png", type: "output" }] } },
      status: {
        status_str: "success",
        completed: true,
        messages: [["execution_success", { prompt_id: promptId, timestamp: 2_000 }]],
      },
    }) as HistoryEntry;

  const stillsWatchdog = (clock: { t: number }) =>
    makeWatchdog(clock, {
      resolveOutputs: (id) =>
        resolveHistoryCompletionImages(id, async (promptId) => ({ [promptId]: stillsHistory(promptId) })),
    });

  it("a stills run is still composing at 8 s — the panel's own probe bound — so nothing is synthesised", async () => {
    const clock = { t: 30_000_000 };
    const { wd, delivered } = stillsWatchdog(clock);
    expect(RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV })).toBe(true);
    wd.observe([{ promptId: PID, status: "success" }]);

    // 8 000 ms is the panel's OWN bound on each of the two per-output probes it
    // awaits before it sends. A grace at or under this races a healthy panel.
    clock.t += 8_000;
    await wd.tick();
    expect(delivered).toHaveLength(0);
    expect(wd.armedCount()).toBe(1);

    clock.t += DEFAULT_SYNTHESIS_GRACE_MS - 8_000;
    await wd.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload.prompt_id).toBe(PID);
  });

  it("a stills run is NOT given the storyboard extension — it lands on the ordinary grace", async () => {
    const clock = { t: 31_000_000 };
    const { wd, delivered } = stillsWatchdog(clock);
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    wd.observe([{ promptId: PID, status: "success" }]);

    clock.t += DEFAULT_SYNTHESIS_GRACE_MS;
    await wd.tick();
    expect(delivered).toHaveLength(1);
    expect(wd.armedCount()).toBe(0);
  });

  it("a run the panel must storyboard is held past 25 s, then answered — the extension is granted ONCE", async () => {
    const clock = { t: 32_000_000 };
    const entry = saveVideoHistoryEntry(PID);
    const { wd, delivered } = makeWatchdog(clock, {
      resolveOutputs: (id) =>
        resolveHistoryCompletionImages(id, async (promptId) => ({ [promptId]: entry })),
    });
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    wd.observe([{ promptId: PID, status: "success" }]);

    clock.t += DEFAULT_SYNTHESIS_GRACE_MS;
    await wd.tick();
    expect(delivered).toHaveLength(0);

    // 25 000 ms is the panel's own storyboard bound; still inside it.
    clock.t += 25_000 - DEFAULT_SYNTHESIS_GRACE_MS;
    await wd.tick();
    expect(delivered).toHaveLength(0);
    expect(wd.armedCount()).toBe(1);

    // Past it — the panel has abandoned the storyboard and sent its note-only
    // fallback by now, so silence is no longer explained by composing.
    clock.t += DEFAULT_STORYBOARD_GRACE_MS - 25_000;
    await wd.tick();
    expect(delivered).toHaveLength(1);
    // ONCE: nothing is left armed to be extended a second time.
    expect(wd.armedCount()).toBe(0);

    // …and a further tick long afterwards adds nothing.
    clock.t += DEFAULT_STORYBOARD_GRACE_MS * 4;
    await wd.tick();
    expect(delivered).toHaveLength(1);
  });

  it("the panel's own frame landing during the extension wins — nothing is synthesised at all", async () => {
    const clock = { t: 33_000_000 };
    const entry = saveVideoHistoryEntry(PID);
    const { wd, delivered } = makeWatchdog(clock, {
      resolveOutputs: (id) =>
        resolveHistoryCompletionImages(id, async (promptId) => ({ [promptId]: entry })),
    });
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });
    wd.observe([{ promptId: PID, status: "success" }]);

    clock.t += DEFAULT_SYNTHESIS_GRACE_MS;
    await wd.tick();
    expect(delivered).toHaveLength(0);

    // The panel finishes its storyboard at 18 s and sends the real frame.
    RunCompletions.record(TAB, { kind: "executed", prompt_id: PID }, { conversation: CONV });

    clock.t += DEFAULT_STORYBOARD_GRACE_MS;
    await wd.tick();
    expect(delivered).toHaveLength(0);
    expect(wd.armedCount()).toBe(0);
  });

  it("reconcile() does NOT wait for the storyboard bound — a missed-WS recovery answers now", async () => {
    const clock = { t: 34_000_000 };
    const entry = saveVideoHistoryEntry(PID);
    const { wd, delivered } = makeWatchdog(clock, {
      resolveOutputs: (id) =>
        resolveHistoryCompletionImages(id, async (promptId) => ({ [promptId]: entry })),
      lookupStatus: async (id) => resolveHistoryCompletionStatus(id, async (pid) => ({ [pid]: entry })),
    });
    RunCompletions.openRun(PID, { tabId: TAB, conversation: CONV });

    await wd.reconcile(RunCompletions.owedCompletions().map((t) => t.promptId));

    expect(delivered).toHaveLength(1);
    expect(delivered[0].payload.prompt_id).toBe(PID);
    expect(wd.armedCount()).toBe(0);
  });
});
