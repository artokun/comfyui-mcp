// #1574 — the tray announced "transfer completed" while the transfer was still streaming.
//
// The reporter checked three things immediately after the event arrived:
//
//   download_model action:"status" {id}  → **downloading** … still streaming, started 634s ago
//   list_local_models                    → the file was ABSENT
//   get_system_stats a few minutes later → the category count went 8 → 9
//
// The file landed AFTER the event. They also read the formatting code and correctly ruled it
// out: it emits the completion clause for rows where `status === "done"`, so something
// upstream had already put the row in that state.
//
// The completion event is built from a PROGRESS ROW; `download_model action:"status"` answers
// from the JOB RECORD. Two stores, and the event consults only one.
//
// ## Two review findings shaped this file
//
// 1. SUPPRESSING the contradicted event is wrong. A terminal record can legitimately still
//    read "downloading" until the ~15s persistence heartbeat retries (#1545), and the
//    debounce bucket is deleted before the check and never requeued — so dropping the event
//    would PERMANENTLY lose the completion for a download that genuinely finished. The event
//    always fires; the disagreement is disclosed on it.
//
// 2. The first guard compared the row's id to the JOB's id. Those are different identities —
//    the report shows both (`6226e26ba97f8527` against tray `93015fbfa0fa9933`) — so it never
//    matched and was completely INERT. Its unit tests missed that because they fed synthetic
//    rows carrying whatever id the assertion wanted. Every fixture here now uses the REAL
//    shape: the row carries the progress/tray id, the job carries its own separate id.
import { describe, expect, it } from "vitest";

import {
  COMPLETION_DISAGREEMENT_NOTE,
  FAILURE_DISAGREEMENT_NOTE,
  completionDisagreesWithRecord,
  failureDisagreesWithRecord,
} from "../../orchestrator/download-done-guard.js";

/** A progress row: identified by the PROGRESS/TRAY id, as written on disk. */
const row = (over: Record<string, unknown> = {}) => ({
  id: "93015fbfa0fa9933",
  name: "model.safetensors",
  status: "done",
  ...over,
});

/** A job record: its own public `id`, plus the tray/progress identity the rows use. */
const job = (over: Record<string, unknown> = {}) => ({
  id: "6226e26ba97f8527",
  trayId: "93015fbfa0fa9933",
  filename: "model.safetensors",
  status: "downloading",
  ...over,
});

describe("a completion the record disagrees with is DISCLOSED (#1574)", () => {
  it("flags the reported case: row says done, the job record still says downloading", () => {
    expect(completionDisagreesWithRecord(row(), [job()])).toBe(true);
  });

  it("matches on the PROGRESS identity, not the job's public id", () => {
    // The bug that made the first version inert. A row is never written under the job's
    // public id, so comparing against it matched nothing and silently agreed with everything.
    expect(completionDisagreesWithRecord(row({ id: "6226e26ba97f8527" }), [job()])).toBe(false);
    // progressId wins over trayId when both are present — it is what writes the rows.
    expect(
      completionDisagreesWithRecord(row({ id: "prog-1" }), [job({ progressId: "prog-1" })]),
    ).toBe(true);
    expect(
      completionDisagreesWithRecord(row({ id: "93015fbfa0fa9933" }), [
        job({ progressId: "prog-1" }),
      ]),
    ).toBe(false);
  });

  it("says nothing when the record agrees", () => {
    expect(completionDisagreesWithRecord(row(), [job({ status: "done" })])).toBe(false);
  });

  it("says nothing when the record has no opinion", () => {
    // The record store resets on an orchestrator respawn — exactly the reported session. An
    // ABSENT record is not evidence the transfer is still running.
    expect(completionDisagreesWithRecord(row(), [])).toBe(false);
    expect(completionDisagreesWithRecord(row(), [job({ trayId: "someone-else" })])).toBe(false);
  });

  it("only looks at COMPLETIONS — a failure row is untouched", () => {
    expect(completionDisagreesWithRecord(row({ status: "error" }), [job()])).toBe(false);
  });

  it("does not let a completion check stand in for a failure check", () => {
    // #2057 is the failure direction. If this started returning true, the formatter
    // would treat a contradicted FAILED as a contradicted completion and talk about
    // bytes finishing — the wrong hedge.
    expect(completionDisagreesWithRecord(row({ status: "error" }), [job({ status: "downloading" })])).toBe(
      false,
    );
  });

  it("a terminal record other than downloading does not disagree", () => {
    for (const status of ["error", "cancelled", "done"]) {
      expect(completionDisagreesWithRecord(row(), [job({ status })]), status).toBe(false);
    }
  });

  it("junk never throws — this runs on the event path", () => {
    for (const bad of [null, undefined, {}, { status: "done" }]) {
      expect(() => completionDisagreesWithRecord(bad as never, [job()])).not.toThrow();
    }
    expect(completionDisagreesWithRecord(row(), null as never)).toBe(false);
  });

  it("the note states BOTH readings rather than picking a winner", () => {
    // It cannot establish which store is right, and saying "this download is not finished"
    // would be a claim it has not earned — the record legitimately lags sometimes.
    expect(COMPLETION_DISAGREEMENT_NOTE).toMatch(/still reports this transfer as downloading/i);
    expect(COMPLETION_DISAGREEMENT_NOTE).toMatch(/can lag/i);
    expect(COMPLETION_DISAGREEMENT_NOTE).toMatch(/before loading it/i);
    // …and it must NOT assert the download is unfinished. It cannot establish that — the
    // record legitimately lags sometimes — and stating it would make every lagging record
    // read as a failed download.
    expect(COMPLETION_DISAGREEMENT_NOTE).not.toMatch(/is NOT finished|did not finish|has not finished/i);
    expect(COMPLETION_DISAGREEMENT_NOTE).toMatch(/may simply be that/i);
  });
});

// ── WIRING. The guard is inert unless the tick sets the flag, the bucket carries the id the
//    match needs, and the formatter renders the note. All three are single lines.

describe("the disagreement actually reaches the user (#1574)", () => {
  const read = async (file: string): Promise<string> => {
    const { readFileSync } = await import("node:fs");
    return readFileSync(new URL(`../../orchestrator/${file}`, import.meta.url), "utf-8");
  };

  it("the bucket carries the row id the match depends on", async () => {
    // Without this the guard has nothing to match a job against, and agrees with everything.
    // That is precisely how the first version shipped as a no-op.
    const src = await read("index.ts");
    const at = src.indexOf("bucket.downloads.set(supKey, {");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 400)).toMatch(/id: typeof row\.id === "string" \? row\.id : undefined/);
  });

  it("the tick FLAGS the disagreeing entries", async () => {
    const src = await read("index.ts");
    expect(src).toMatch(/settled\.filter\(\(d\) => completionDisagreesWithRecord\(d, records\)\)/);
    expect(src).toMatch(/settled\.filter\(\(d\) => failureDisagreesWithRecord\(d, records\)\)/);
    expect(src).toMatch(/\.recordDisagrees = true/);
  });

  it("and still injects EVERY settled entry", async () => {
    // The review finding. Suppressing loses a real completion permanently, because the
    // bucket is already deleted and never requeued.
    const src = await read("index.ts");
    // EXACTLY settled, with nothing chained onto it. A .filter() appended here reads as
    // "still uses settled" to a looser regex, and is the exact regression this forbids.
    expect(src).toMatch(/kind: "download_done", downloads: settled }/);
    expect(src).not.toMatch(/downloads: settled\s*\.filter/);
    expect(src).not.toMatch(/downloads: honest/);
    expect(src).not.toMatch(/if \(honest\.length === 0\) continue;/);
  });

  it("the formatter renders the caveat beside the completion", async () => {
    const src = await read("panel-agent.ts");
    const at = src.indexOf("transfer completed: ${done.join");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 900);
    expect(block).toMatch(/recordDisagrees/);
    expect(block).toMatch(/COMPLETION_DISAGREEMENT_NOTE/);
  });

  it("a record read that throws leaves the event untouched", async () => {
    const src = await read("index.ts");
    const at = src.indexOf("listDownloadJobs()");
    const block = src.slice(at - 200, at + 400);
    expect(block).toMatch(/catch/);
    expect(block).toMatch(/return \[\];/);
  });
});

// ── (id, target) IDENTITY and the CONTRADICTING SENTENCE — both from review round 2.

describe("a row is identified by (id, target), not id alone (#1574)", () => {
  it("does not match a record for the same id at a DIFFERENT target", () => {
    // A concurrent LOCAL and POD transfer of one URL share an id and must stay two
    // transfers with two outcomes — the same reason supersession keys on (id, target).
    // Matching id alone could annotate the wrong completion, or miss a real disagreement
    // by finding the other one first.
    expect(
      completionDisagreesWithRecord(row({ target: "/local/models" }), [
        job({ target: "/pod/models", status: "downloading" }),
      ]),
    ).toBe(false);
  });

  it("matches when the targets agree", () => {
    expect(
      completionDisagreesWithRecord(row({ target: "/local/models" }), [
        job({ target: "/local/models", status: "downloading" }),
      ]),
    ).toBe(true);
  });

  it("still matches when EITHER side has no target", () => {
    // Rows and records predating the field, or a route that never sets it, must keep
    // matching — requiring it on both sides would make the check inert again, which is
    // exactly how the first version shipped.
    expect(completionDisagreesWithRecord(row(), [job({ target: "/pod/models" })])).toBe(true);
    expect(completionDisagreesWithRecord(row({ target: "/local" }), [job()])).toBe(true);
  });
});

describe("the event does not contradict its own caveat (#1574)", () => {
  const formatter = async (): Promise<string> => {
    const { readFileSync } = await import("node:fs");
    return readFileSync(new URL("../../orchestrator/panel-agent.ts", import.meta.url), "utf-8");
  };

  it("the bytes-finished claim is conditional on there being no disagreement", async () => {
    // Review found the caveat being appended and then flatly contradicted two sentences
    // later by an unconditional "The bytes finished transferring" — the same defect #1150
    // fixed here in the other direction.
    const src = await formatter();
    const at = src.indexOf("The bytes finished transferring");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(Math.max(0, at - 700), at + 200);
    expect(block).toMatch(/disagrees/);
    expect(block).toMatch(/The tray reported the bytes finished/);
  });

  it("the disagreeing wording reports what the tray SAID rather than asserting it", async () => {
    const src = await formatter();
    const at = src.indexOf("The tray reported the bytes finished");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).toMatch(/see the caveat above/);
  });
});

describe("an exact (id, target) record wins over a targetless one (#1574)", () => {
  it("does not let a targetless DOWNLOADING shadow the exact DONE", () => {
    // Review, round 3. Scanning in array order and accepting the first id match reported a
    // disagreement that does not exist — hedging a completion that was perfectly fine.
    expect(
      completionDisagreesWithRecord(row({ target: "/local/models" }), [
        job({ target: undefined, status: "downloading" }),
        job({ target: "/local/models", status: "done" }),
      ]),
    ).toBe(false);
  });

  it("…and finds the exact DOWNLOADING behind a targetless DONE", () => {
    // The same ordering hazard in the direction that must still be reported.
    expect(
      completionDisagreesWithRecord(row({ target: "/local/models" }), [
        job({ target: undefined, status: "done" }),
        job({ target: "/local/models", status: "downloading" }),
      ]),
    ).toBe(true);
  });

  it("falls back to a targetless record only when nothing matches on target", () => {
    expect(
      completionDisagreesWithRecord(row({ target: "/local/models" }), [
        job({ target: "/pod/models", status: "done" }),
        job({ target: undefined, status: "downloading" }),
      ]),
    ).toBe(true);
  });
});

// #2057 — the tray announced FAILED (and claimed nothing transferred) while the transfer
// was still streaming. Same two stores as #1574, opposite terminal.
//
// The reporter's handles: job `07d14bb0c73bc007`, tray `31bba4a9cdb04e28`. Status at
// t+106s was downloading 0.14/19.53 GB; the panel then emitted FAILED + NOTHING
// transferred; status at t+163s was downloading 0.22/19.53 GB. Bytes advanced across
// the failure notification, so the job record is the authority — not the tray row.
//
// #1150 could not see this: it only flags a failure whose FILENAME is still a live
// tray row, and here the tray row itself was the error.

const errorRow = (over: Record<string, unknown> = {}) =>
  row({ id: "31bba4a9cdb04e28", status: "error", ...over });
const liveJob = (over: Record<string, unknown> = {}) =>
  job({ id: "07d14bb0c73bc007", trayId: "31bba4a9cdb04e28", status: "downloading", ...over });

describe("a failure the record disagrees with is DISCLOSED (#2057)", () => {
  it("flags the reported case: row says error, the job record still says downloading", () => {
    expect(failureDisagreesWithRecord(errorRow(), [liveJob()])).toBe(true);
  });

  it("matches on the PROGRESS identity, not the job's public id", () => {
    expect(failureDisagreesWithRecord(errorRow({ id: "07d14bb0c73bc007" }), [liveJob()])).toBe(false);
    expect(
      failureDisagreesWithRecord(errorRow({ id: "prog-1" }), [liveJob({ progressId: "prog-1" })]),
    ).toBe(true);
    expect(
      failureDisagreesWithRecord(errorRow({ id: "31bba4a9cdb04e28" }), [
        liveJob({ progressId: "prog-1" }),
      ]),
    ).toBe(false);
  });

  it("says nothing when the record agrees the download failed", () => {
    expect(failureDisagreesWithRecord(errorRow(), [liveJob({ status: "error" })])).toBe(false);
  });

  it("says nothing when the record has no opinion", () => {
    expect(failureDisagreesWithRecord(errorRow(), [])).toBe(false);
    expect(failureDisagreesWithRecord(errorRow(), [liveJob({ trayId: "someone-else" })])).toBe(false);
  });

  it("only looks at FAILURES — a completion row is untouched", () => {
    expect(failureDisagreesWithRecord(errorRow({ status: "done" }), [liveJob()])).toBe(false);
  });

  it("a terminal record other than downloading does not disagree", () => {
    for (const status of ["error", "cancelled", "done"]) {
      expect(failureDisagreesWithRecord(errorRow(), [liveJob({ status })]), status).toBe(false);
    }
  });

  it("junk never throws — this runs on the event path", () => {
    for (const bad of [null, undefined, {}, { status: "error" }]) {
      expect(() => failureDisagreesWithRecord(bad as never, [liveJob()])).not.toThrow();
    }
    expect(failureDisagreesWithRecord(errorRow(), null as never)).toBe(false);
  });

  it("the note tells the agent not to report a failure, and never says FAILED", () => {
    expect(FAILURE_DISAGREEMENT_NOTE).toMatch(/still reports this transfer as downloading/i);
    expect(FAILURE_DISAGREEMENT_NOTE).toMatch(/do NOT report it as failed/i);
    expect(FAILURE_DISAGREEMENT_NOTE).not.toMatch(/FAILED/);
  });

  it("does not match a record for the same id at a DIFFERENT target", () => {
    expect(
      failureDisagreesWithRecord(errorRow({ target: "/local/models" }), [
        liveJob({ target: "/pod/models" }),
      ]),
    ).toBe(false);
  });

  it("matches when the targets agree", () => {
    expect(
      failureDisagreesWithRecord(errorRow({ target: "/local/models" }), [
        liveJob({ target: "/local/models" }),
      ]),
    ).toBe(true);
  });

  it("still matches when EITHER side has no target", () => {
    expect(failureDisagreesWithRecord(errorRow(), [liveJob({ target: "/pod/models" })])).toBe(true);
    expect(failureDisagreesWithRecord(errorRow({ target: "/local" }), [liveJob()])).toBe(true);
  });

  it("does not let a targetless DOWNLOADING shadow the exact ERROR", () => {
    expect(
      failureDisagreesWithRecord(errorRow({ target: "/local/models" }), [
        liveJob({ target: undefined, status: "downloading" }),
        liveJob({ target: "/local/models", status: "error" }),
      ]),
    ).toBe(false);
  });

  it("…and finds the exact DOWNLOADING behind a targetless ERROR", () => {
    expect(
      failureDisagreesWithRecord(errorRow({ target: "/local/models" }), [
        liveJob({ target: undefined, status: "error" }),
        liveJob({ target: "/local/models", status: "downloading" }),
      ]),
    ).toBe(true);
  });
});

describe("the failure disagreement actually reaches the user (#2057)", () => {
  const read = async (file: string): Promise<string> => {
    const { readFileSync } = await import("node:fs");
    return readFileSync(new URL(`../../orchestrator/${file}`, import.meta.url), "utf-8");
  };

  it("the formatter keeps a contradicted failure out of the FAILED list", async () => {
    const src = await read("panel-agent.ts");
    expect(src).toMatch(/failedLiveRecord/);
    expect(src).toMatch(/FAILURE_DISAGREEMENT_NOTE/);
    // The NOTHING sentence is gated on there being a genuinely-dead failure
    // and no live counterpart — otherwise the reporter's 0.22 GB transfer is
    // described as having transferred nothing.
    expect(src).toMatch(
      /failedDead\.length && !failedRetried\.length && !failedLiveRecord\.length/,
    );
  });
});
