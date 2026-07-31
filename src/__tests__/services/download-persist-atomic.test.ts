import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm as fsRm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Force renameSync failure on demand to exercise persistDownloadJob's atomic-write
// failure path (#529). node:fs (the SYNC api download-progress uses) is mocked; only
// renameSync is wrapped — everything else passes through. node:fs/promises (used by this
// test for setup) is a DIFFERENT module and stays real.
const h = vi.hoisted(() => ({
  realRename: undefined as ((from: string, to: string) => void) | undefined,
  fail: false,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  h.realRename = actual.renameSync as (from: string, to: string) => void;
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (h.fail) throw new Error("EPERM: forced rename failure");
      return h.realRename!(from, to);
    },
  };
});

import {
  persistDownloadJob,
  readPersistedDownloadJob,
  setProgressDir,
  PERSIST_OWNER,
} from "../../services/download-progress.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "djobs-atomic-"));
  setProgressDir(dir);
  h.fail = false;
});

afterEach(async () => {
  setProgressDir("");
  h.fail = false;
  await fsRm(dir, { recursive: true, force: true });
});

const rec = (status: "downloading" | "done") => ({
  id: "atomicid00000001",
  trayId: "atomictray000001",
  progressId: "p",
  url: "https://example.com/model.safetensors",
  target_subfolder: "checkpoints",
  status,
  path: status === "done" ? "/M/checkpoints/x.safetensors" : undefined,
  started_at: Date.now(),
});

describe("persistDownloadJob atomic write (#529 torn-write guard)", () => {
  it("a normal persist writes atomically, reports durable, and leaves no temp behind", async () => {
    expect(persistDownloadJob(rec("downloading"))).toBe(true); // durably replaced
    const files = await readdir(dir);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(readPersistedDownloadJob("atomicid00000001")?.status).toBe("downloading");
  });

  it("on a rename failure, NEVER rewrites the scanned .json in place (no torn-write) and leaks no temp", async () => {
    // First persist succeeds atomically → a complete record on disk.
    persistDownloadJob(rec("downloading"));
    const filePath = join(dir, `control-job-atomicid00000001-${PERSIST_OWNER}.json`);
    const rawBefore = await readFile(filePath, "utf8");
    expect(JSON.parse(rawBefore).status).toBe("downloading");

    // Force EVERY rename attempt to fail on the next persist (a done update).
    h.fail = true;
    expect(persistDownloadJob(rec("done"))).toBe(false); // NOT durably replaced

    // The scanned .json is UNCHANGED — the prior COMPLETE record was NOT rewritten in
    // place (an in-place truncate+write is exactly the torn-read that lets another process
    // see the record as absent and start a SECOND writer). Still valid + readable.
    const rawAfter = await readFile(filePath, "utf8");
    expect(rawAfter).toBe(rawBefore);
    expect(readPersistedDownloadJob("atomicid00000001")?.status).toBe("downloading");
    // No temp leaked.
    expect((await readdir(dir)).some((f) => f.endsWith(".tmp"))).toBe(false);

    // Recovery: once rename works again (next heartbeat), the atomic replace applies.
    h.fail = false;
    expect(persistDownloadJob(rec("done"))).toBe(true); // durable this time
    expect(readPersistedDownloadJob("atomicid00000001")?.status).toBe("done");
    expect((await readdir(dir)).some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});
