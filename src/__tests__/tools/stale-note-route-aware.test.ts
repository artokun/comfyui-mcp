// #1148 — the stale-heartbeat NOTE gave the LOCAL recovery answer to both routes.
//
// It ended: "After a successful cancel, re-issuing action:'download' resumes any
// .partial the dead writer left, or restarts cleanly." True for a stream this MCP
// owns. False, and actively destructive, for a ComfyUI-Manager dispatch: there is
// no local .partial, the fetch runs on the ComfyUI HOST — which a restart here
// never touched — and Manager has no recall API, so "re-issue" means a SECOND
// server-side dispatch writing the same destination. That corrupts the model
// (#1197).
//
// This is the note an agent reads at exactly the moment it is deciding whether to
// re-issue, which is what makes the route-blindness expensive rather than untidy.
//
// The `cancelled` branch a few lines above already drew the distinction, so the
// code knew it and the stale path simply never asked. That is also why the
// description alone could not be fixed: it would then contradict the runtime
// note, which is the failure #1197 spent four rounds undoing.
//
// These tests drive the REAL registered handler, because the description pin in
// download-status-promise.test.ts cannot see the runtime string at all.

import { mkdtemp, rm as fsRm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerModelManagementTools } from "../../tools/model-management.js";
import { resetDownloadJobs } from "../../services/download-jobs.js";
import { setProgressDir } from "../../services/download-progress.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function statusHandler(): Handler {
  let found: Handler | undefined;
  // download_model registers as (name, description, schema, annotations, handler)
  // — five arguments. Capturing the FOURTH silently yields the annotations object
  // and fails as "not a function" at call time.
  const server = {
    tool: (name: string, _d: string, _s: unknown, _a: unknown, handler: Handler) => {
      if (name === "download_model") found = handler;
    },
  };
  registerModelManagementTools(server as never);
  expect(found, "download_model should be registered").toBeTruthy();
  return found!;
}

/** A stale in-flight record left by a session that is no longer heartbeating. */
async function writeStaleRecord(dir: string, viaManager: boolean): Promise<string> {
  const id = viaManager ? "managerstale0001" : "localstalexxx001";
  const body = {
    id,
    trayId: `tray-${id}`,
    progressId: `prog-${id}`,
    url: "https://example.invalid/model.safetensors",
    target_subfolder: "loras",
    status: "downloading",
    started_at: Date.now() - 600_000,
    owner: "a-session-that-went-away",
    via_manager: viaManager,
    // Well past the staleness window, so the record reports staleInflight.
    updated: Date.now() - 10 * 60_000,
  };
  await writeFile(pathJoin(dir, `control-job-${id}-${body.owner}.json`), JSON.stringify(body));
  return id;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(pathJoin(tmpdir(), "stale-route-"));
  setProgressDir(dir);
});

afterEach(async () => {
  setProgressDir("");
  resetDownloadJobs();
  await fsRm(dir, { recursive: true, force: true });
});

async function statusText(): Promise<string> {
  const res = await statusHandler()({ action: "status" });
  return res.content.map((c) => c.text).join("\n");
}

describe("the stale-heartbeat note is ROUTE-AWARE (#1148)", () => {
  it("a MANAGER dispatch is told NOT to re-issue", async () => {
    await writeStaleRecord(dir, true);
    const text = await statusText();

    expect(text, "the note must fire at all").toMatch(/heartbeat stale/);
    expect(text, "the destructive move must be named").toMatch(/do NOT re-issue/i);
    expect(text).toMatch(/CORRUPTS/);
    // And it must say WHY, so the reader can tell this from the generic warning.
    expect(text).toMatch(/no local \.partial/);
    expect(text).toMatch(/server-side/);
    // The WHY-not-yet clause has to move with it. "The original owner may still
    // be writing the same .partial" is not merely unhelpful for a Manager
    // dispatch, it is false — there is no local .partial and no local writer.
    expect(text, "the reason must not invent a local writer").not.toMatch(
      /original owner may still be writing/,
    );
    expect(text).toMatch(/ComfyUI host may still be fetching/);
  });

  it("a MANAGER dispatch is given something to do instead", async () => {
    // A refusal with no alternative is how an agent ends up re-issuing anyway.
    await writeStaleRecord(dir, true);
    expect(await statusText()).toMatch(/list_local_models/);
  });

  it("a LOCAL stream keeps the resume advice, which is true for it", async () => {
    await writeStaleRecord(dir, false);
    const text = await statusText();

    expect(text).toMatch(/heartbeat stale/);
    expect(text).toMatch(/resumes any \.partial/);
    // ...and the local reason names the local writer, which is the true one here.
    expect(text).toMatch(/original owner may still be writing/);
    expect(text).not.toMatch(/ComfyUI host may still be fetching/);
    // The Manager warning must NOT bleed onto a local stream: telling someone not
    // to re-issue a resumable local download is the same defect mirrored.
    expect(text).not.toMatch(/CORRUPTS/);
    expect(text).not.toMatch(/list_local_models/);
  });

  it("the two routes do not produce the same note", async () => {
    // The bug in one line: both routes rendered identical recovery advice.
    await writeStaleRecord(dir, true);
    const manager = await statusText();
    await fsRm(dir, { recursive: true, force: true });
    dir = await mkdtemp(pathJoin(tmpdir(), "stale-route-"));
    setProgressDir(dir);
    resetDownloadJobs();
    await writeStaleRecord(dir, false);
    const local = await statusText();

    const recovery = (t: string) => t.slice(t.indexOf("After a successful cancel"));
    expect(recovery(manager)).not.toBe(recovery(local));
  });

  it("both routes still say the cancel must PROVE the writer is gone", async () => {
    // The part that was already right and must survive the split.
    for (const viaManager of [true, false]) {
      await fsRm(dir, { recursive: true, force: true });
      dir = await mkdtemp(pathJoin(tmpdir(), "stale-route-"));
      setProgressDir(dir);
      resetDownloadJobs();
      await writeStaleRecord(dir, viaManager);
      const text = await statusText();
      expect(text, `viaManager=${viaManager}`).toMatch(/PROVEN gone/);
      expect(text, `viaManager=${viaManager}`).toMatch(/Do not report this download as failed/);
    }
  });
});
