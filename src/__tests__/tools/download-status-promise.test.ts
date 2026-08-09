// #1148 — `download_model action:"status"` promised more than the code delivers.
//
// The description said:
//
//   Survives a sidebar/tool-session reconnect: an in-flight download started in
//   a previous session is still resolvable by its `id` … so you can confirm it's
//   still running instead of starting a duplicate.
//
// That folds two events with OPPOSITE answers into one word. Established from
// the code, not the changelog:
//
//   agent / sidebar reconnect  → the orchestrator is still up, the record stays
//                                `downloading`, the transfer really is streaming.
//   orchestrator restart       → the progress dir is nonced per start and earlier
//                                dirs are reaped; `migrateInFlightJobs` carries an
//                                in-flight record over as a TERMINAL `error` with
//                                `interrupted_by_restart`. The transfer died with
//                                the process. Re-issuing is the correct move.
//
// A caller who believed the old text waited on a transfer that was not running —
// which is what cost the reporter 40 minutes, twice. #1170 made the second case
// legible; this pins the description so it cannot go back to claiming the first
// case is universal.
//
// Asserted on the REGISTERED description rather than a copy of the string, so a
// reworded-but-still-over-promising edit fails here.

import { describe, expect, it } from "vitest";

import { registerModelManagementTools } from "../../tools/model-management.js";

/** Capture each tool's registered description without a live MCP server. */
function registeredDescriptions(): Map<string, string> {
  const out = new Map<string, string>();
  const server = {
    tool: (name: string, description: string) => {
      out.set(name, description);
    },
  };
  registerModelManagementTools(server as never);
  return out;
}

describe("download_model action:\"status\" describes the survival it actually has (#1148)", () => {
  const description = (): string => {
    const d = registeredDescriptions().get("download_model");
    expect(d, "download_model should be registered").toBeTruthy();
    return d as string;
  };

  it("does not claim a bare 'survives a reconnect'", () => {
    // The exact fold. An orchestrator restart does not survive, so an unqualified
    // claim is false half the time.
    expect(description()).not.toMatch(/Survives a sidebar\/tool-session reconnect/i);
  });

  it("names the ORCHESTRATOR RESTART case and says the transfer is not running", () => {
    const d = description();
    expect(d).toMatch(/ORCHESTRATOR RESTART/);
    expect(d).toMatch(/NOT running/);
    // And tells the caller what to do about it, which is the opposite of the
    // old text's "instead of starting a duplicate".
    expect(d).toMatch(/re-issuing/i);
  });

  it("still tells the caller the agent-reconnect case IS resolvable", () => {
    // Narrowing must not throw away the true half — #529's adoption contract is
    // real, and a caller who stops trusting it starts duplicating live transfers.
    const d = description();
    expect(d).toMatch(/resolvable by its `id`/);
    expect(d).toMatch(/still streaming|reads `downloading`/);
  });

  it("does not tell the caller to conclude anything from a MISSING record", () => {
    // The carry-over that records an interruption is best-effort by design, so
    // its absence is not evidence the download is alive — the same
    // "could not determine" / "determined not" fold, one layer over (#796).
    const d = description();
    // The registered text must not promise that a missing record means finished.
    expect(d).not.toMatch(/if it is missing[^.]*it (?:finished|completed)/i);
  });
});
