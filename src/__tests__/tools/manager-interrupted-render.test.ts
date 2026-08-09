// #1197 — the RENDERED output for a ComfyUI-Manager download carried across an
// orchestrator restart.
//
// This file exists because of how the fix kept failing. Three separate rounds
// produced a correct change that never reached the reader:
//
//   1. the tool DESCRIPTION was overridden by the record's own error text;
//   2. the record's error text was overridden by the status TOKEN, which still
//      said `**error**` beside "very likely STILL RUNNING";
//   3. `action:"cancel"` said "already error — nothing to cancel", which reads
//      as confirmation the transfer is over.
//
// A reviewer neutered all three user-visible sites at once and the FULL SUITE
// stayed byte-identical — 385 files, 7884 passed. Nothing guarded the layer the
// user actually reads, which is exactly the layer that kept being wrong.
//
// The stakes: a Manager fetch runs on the ComfyUI HOST, which a restart here
// does not touch. Telling that caller the transfer stopped, or that cancelling
// found nothing to cancel, invites a re-issue — and a second dispatch to the
// same destination corrupts the model (node-management.ts:971-979).

import { beforeEach, describe, expect, it, vi } from "vitest";

const listDownloadJobsMock = vi.fn();
const getDownloadJobMock = vi.fn();
const cancelDownloadJobMock = vi.fn();

vi.mock("../../services/download-jobs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/download-jobs.js")>();
  return {
    ...actual,
    listDownloadJobs: (...a: unknown[]) => listDownloadJobsMock(...a),
    getDownloadJob: (...a: unknown[]) => getDownloadJobMock(...a),
    cancelDownloadJob: (...a: unknown[]) => cancelDownloadJobMock(...a),
  };
});

const { registerModelManagementTools } = await import("../../tools/model-management.js");

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function tools() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, ...rest: unknown[]) => {
      handlers.set(name, rest.find((a) => typeof a === "function") as ToolHandler);
    },
  };
  registerModelManagementTools(server as never);
  const download = handlers.get("download_model")!;
  return {
    status: (args: Record<string, unknown> = {}) => download({ ...args, action: "status" }),
    cancel: (args: Record<string, unknown>) => download({ ...args, action: "cancel" }),
  };
}

/** A Manager dispatch that an orchestrator restart carried across. */
const migratedManagerJob = {
  id: "mgr-12gb",
  trayId: "tray-mgr",
  status: "error" as const,
  interruptedByRestart: true,
  viaManager: true,
  error: "This download is no longer being WATCHED … very likely STILL RUNNING …",
  url: "https://example.invalid/wan22.safetensors",
  targetSubfolder: "diffusion_models",
  startedAt: Date.now() - 600_000,
};

beforeEach(() => {
  listDownloadJobsMock.mockReset();
  getDownloadJobMock.mockReset();
  cancelDownloadJobMock.mockReset();
});

describe("the rendered status for an interrupted Manager dispatch (#1197)", () => {
  it("does NOT lead with the word error", async () => {
    // The token is read first, so `**error**` beside "still running" is a
    // contradiction the reader resolves by position — which is why fixing only
    // the message body changed nothing for the caller.
    listDownloadJobsMock.mockReturnValue([migratedManagerJob]);
    const out = await tools().status();
    const text = out.content[0].text;

    expect(text).not.toMatch(/\*\*error\*\*/);
    expect(text).toMatch(/host may still be fetching/);
  });

  it("labels it NO LONGER WATCHED, not INTERRUPTED", async () => {
    // "INTERRUPTED" asserts the transfer stopped. For the Manager route that is
    // the one thing this code cannot know and the host most likely contradicts.
    listDownloadJobsMock.mockReturnValue([migratedManagerJob]);
    const text = (await tools().status()).content[0].text;

    expect(text).toMatch(/NO LONGER WATCHED/);
    expect(text).not.toMatch(/INTERRUPTED —/);
  });

  it("keeps INTERRUPTED for a LOCAL interrupted download", async () => {
    // The narrowing must not cost the local case its accurate label.
    listDownloadJobsMock.mockReturnValue([
      { ...migratedManagerJob, id: "local-1", viaManager: false, error: "local stopped" },
    ]);
    const text = (await tools().status()).content[0].text;

    expect(text).toMatch(/INTERRUPTED —/);
    expect(text).not.toMatch(/host may still be fetching/);
  });

  it("cancel does not report it as already finished", async () => {
    // "already **error** — nothing to cancel" reads as confirmation the
    // transfer is over. It is not, and a cancel could not have stopped it
    // either — there is no Manager recall API.
    getDownloadJobMock.mockReturnValue(migratedManagerJob);
    cancelDownloadJobMock.mockReturnValue({
      found: true,
      owned: false,
      aborted: false,
      status: "error",
      job: migratedManagerJob,
    });

    const text = (await tools().cancel({ id: "mgr-12gb" })).content[0].text;

    expect(text).not.toMatch(/nothing to cancel/);
    expect(text).toMatch(/NOT the same as stopped/);
    expect(text).toMatch(/corrupts the model/);
  });

  it("cancel still reports a genuinely settled download plainly", async () => {
    // The narrowing is scoped to the interrupted-Manager case; an ordinary
    // finished download must keep its short answer.
    const done = { ...migratedManagerJob, status: "done" as const, interruptedByRestart: false };
    getDownloadJobMock.mockReturnValue(done);
    cancelDownloadJobMock.mockReturnValue({
      found: true,
      owned: false,
      aborted: false,
      status: "done",
      job: done,
    });

    const text = (await tools().cancel({ id: "mgr-12gb" })).content[0].text;
    expect(text).toMatch(/already \*\*done\*\* — nothing to cancel/);
  });
});
