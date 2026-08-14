// #1415 — the orchestrator→child half of the #952 drift comparison.
//
// The comparison itself already shipped and is already tested
// (fetch-failure-diagnostics.test.ts). What was missing is the transport: its
// source is injected from the bridge, which only exists in the orchestrator
// process, while every headless comfyui tool runs in a spawned stdio child. This
// file covers the small file channel that carries the set across.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PANEL_ORIGINS_FILE,
  PANEL_ORIGINS_HEARTBEAT_MS,
  PANEL_ORIGINS_MAX_AGE_MS,
  publishConnectedPanelOrigins,
  readPublishedPanelOrigins,
  resetPublishedPanelOrigins,
} from "../../services/panel-origin-channel.js";
import { CONTROL_PREFIX, listTargetChangeRequests } from "../../services/download-progress.js";

let dir = "";
const savedEnv = process.env.COMFYUI_MCP_PROGRESS_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "comfyui-mcp-origins-"));
  // The CHILD's view of the channel: the orchestrator hands it this dir in the
  // spawn env (buildComfyuiMcpEnv → COMFYUI_MCP_PROGRESS_DIR).
  process.env.COMFYUI_MCP_PROGRESS_DIR = dir;
  resetPublishedPanelOrigins();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.COMFYUI_MCP_PROGRESS_DIR;
  else process.env.COMFYUI_MCP_PROGRESS_DIR = savedEnv;
  rmSync(dir, { recursive: true, force: true });
  resetPublishedPanelOrigins();
});

describe("panel-origin channel", () => {
  it("carries the origins the orchestrator published", () => {
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8188"]);
    expect(readPublishedPanelOrigins()).toEqual(["http://127.0.0.1:8188"]);
  });

  // The direction that matters most: a stale claim is worse than no claim. The
  // publisher is level-triggered on the orchestrator's poll tick, so a tab that
  // disconnects blanks the file rather than leaving the child quoting a panel
  // that is gone.
  it("BLANKS when the last panel disconnects", () => {
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8188"]);
    publishConnectedPanelOrigins(dir, []);
    expect(readPublishedPanelOrigins()).toEqual([]);
  });

  it("reads nothing when there is no channel — a plain MCP server", () => {
    delete process.env.COMFYUI_MCP_PROGRESS_DIR;
    expect(readPublishedPanelOrigins()).toEqual([]);
  });

  it("reads nothing when nothing has been published yet", () => {
    expect(readPublishedPanelOrigins()).toEqual([]);
  });

  it("reads nothing from a mid-write or corrupt file", () => {
    writeFileSync(join(dir, PANEL_ORIGINS_FILE), '{"origins": ["http://127.');
    expect(readPublishedPanelOrigins()).toEqual([]);
  });

  it("ignores a payload whose origins are not strings", () => {
    // Carries pid/updated because the record format gained them (review, finding
    // 1) — without those the reader now answers [] for a different reason and
    // this would pass while proving nothing about the string filter.
    writeFileSync(
      join(dir, PANEL_ORIGINS_FILE),
      JSON.stringify({ origins: [1, null, "", "http://a:1"], updated: Date.now(), pid: process.pid }),
    );
    expect(readPublishedPanelOrigins()).toEqual(["http://a:1"]);
  });

  it("survives an unwritable directory instead of throwing into the poll tick", () => {
    expect(() => publishConnectedPanelOrigins(join(dir, "nope", "\0bad"), ["http://a:1"])).not.toThrow();
  });

  it("does nothing at all without a dir", () => {
    publishConnectedPanelOrigins("", ["http://127.0.0.1:8188"]);
    expect(readPublishedPanelOrigins()).toEqual([]);
  });

  // This runs on a 700ms tick for the life of the orchestrator.
  it("writes only when the set changed", () => {
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8188"]);
    const first = readFileSync(join(dir, PANEL_ORIGINS_FILE), "utf-8");
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8188"]);
    expect(readFileSync(join(dir, PANEL_ORIGINS_FILE), "utf-8")).toBe(first);
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8189"]);
    expect(readFileSync(join(dir, PANEL_ORIGINS_FILE), "utf-8")).not.toBe(first);
  });
});

// The progress dir is shared with the download tray and the target-change
// control channel. This file must be invisible to both, and the only thing
// making that true is its name.
describe("the channel file cannot be mistaken for a download row or a request", () => {
  it("carries the control prefix pollDownloads filters on", () => {
    expect(PANEL_ORIGINS_FILE.startsWith(CONTROL_PREFIX)).toBe(true);
  });

  it("is not read as a pending target-change request", () => {
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8188"]);
    expect(listTargetChangeRequests(dir)).toEqual([]);
  });
});

// ── Staleness across the publisher's death (review, finding 1) ──────────────
//
// The blank-on-disconnect rule holds only while the orchestrator is alive to run
// its tick. Killed, it leaves its last record on disk in a directory that
// outlives it, and the drift sentence is one an agent acts on — quoting a panel
// that has not existed since yesterday is worse than the generic message.

/** A pid that is definitely NOT running: spawn something trivial, wait for it to
 *  exit, and use its pid. Deterministic, unlike picking a large number. */
function deadPid(): number {
  const done = spawnSync(process.execPath, ["-e", "0"]);
  if (typeof done.pid !== "number") throw new Error("could not obtain a dead pid");
  return done.pid;
}

/** Write a record by hand — the publisher always stamps its OWN pid, so a record
 *  from another (dead) process cannot be produced through the public API. */
function writeRecord(record: unknown): void {
  writeFileSync(join(dir, PANEL_ORIGINS_FILE), JSON.stringify(record));
}

describe("panel-origin channel — staleness", () => {
  const origins = ["http://127.0.0.1:8188"];

  it("ignores a record whose publisher is gone", () => {
    writeRecord({ origins, updated: Date.now(), pid: deadPid() });
    expect(readPublishedPanelOrigins()).toEqual([]);
  });

  it("ignores a record with NO pid — an old-format file proves nothing", () => {
    // The pre-review format. Reading it as live would be exactly the bug.
    writeRecord({ origins, updated: Date.now() });
    expect(readPublishedPanelOrigins()).toEqual([]);
  });

  it("ignores a stale record even when the pid is alive (pid reuse)", () => {
    // The hole a bare liveness check leaves: the OS handed the dead
    // orchestrator's pid to something unrelated, which is alive and answers yes.
    writeRecord({ origins, updated: Date.now() - PANEL_ORIGINS_MAX_AGE_MS - 1, pid: process.pid });
    expect(readPublishedPanelOrigins()).toEqual([]);
  });

  it("ignores a record stamped in the FUTURE", () => {
    // A clock step must not read as maximally fresh — `now - updated` goes
    // negative and would pass a naive age comparison forever.
    writeRecord({ origins, updated: Date.now() + 60_000, pid: process.pid });
    expect(readPublishedPanelOrigins()).toEqual([]);
  });

  it("accepts a live, fresh record", () => {
    // The direction that must keep working: everything above rejects, so a test
    // that only asserted rejection could pass with the reader hard-wired to [].
    writeRecord({ origins, updated: Date.now(), pid: process.pid });
    expect(readPublishedPanelOrigins()).toEqual(origins);
  });

  it("accepts a record right up to the age limit, and not past it", () => {
    const now = Date.now();
    writeRecord({ origins, updated: now - PANEL_ORIGINS_MAX_AGE_MS + 1_000, pid: process.pid });
    expect(readPublishedPanelOrigins(now)).toEqual(origins);
    writeRecord({ origins, updated: now - PANEL_ORIGINS_MAX_AGE_MS - 1_000, pid: process.pid });
    expect(readPublishedPanelOrigins(now)).toEqual([]);
  });

  it("the publisher stamps its own pid, so its OWN record reads back", () => {
    // Ties the two halves together: whatever the writer stamps must be what the
    // reader accepts. Asserted through the public API rather than by inspecting
    // the JSON, so a change to the field name fails here too.
    publishConnectedPanelOrigins(dir, origins);
    expect(readPublishedPanelOrigins()).toEqual(origins);
    const raw = JSON.parse(readFileSync(join(dir, PANEL_ORIGINS_FILE), "utf-8"));
    expect(raw.pid).toBe(process.pid);
  });
});

describe("panel-origin channel — heartbeat", () => {
  const origins = ["http://127.0.0.1:8188"];

  it("does NOT rewrite an unchanged set on every tick", () => {
    // The property the change-only rule exists for: at a 700ms tick, writing per
    // tick is ~86k writes an hour to say nothing changed.
    const now = Date.now();
    publishConnectedPanelOrigins(dir, origins, now);
    const first = readFileSync(join(dir, PANEL_ORIGINS_FILE), "utf-8");
    publishConnectedPanelOrigins(dir, origins, now + 700);
    publishConnectedPanelOrigins(dir, origins, now + 1_400);
    expect(readFileSync(join(dir, PANEL_ORIGINS_FILE), "utf-8")).toBe(first);
  });

  it("DOES refresh an unchanged set once the heartbeat is due", () => {
    // …and the reason it must: an unrefreshed record is indistinguishable from
    // one left by a process that died, so a legitimately-unchanged set has to
    // keep proving someone is home.
    const now = Date.now();
    publishConnectedPanelOrigins(dir, origins, now);
    const first = JSON.parse(readFileSync(join(dir, PANEL_ORIGINS_FILE), "utf-8"));
    publishConnectedPanelOrigins(dir, origins, now + PANEL_ORIGINS_HEARTBEAT_MS);
    const second = JSON.parse(readFileSync(join(dir, PANEL_ORIGINS_FILE), "utf-8"));
    expect(second.updated).toBeGreaterThan(first.updated);
    expect(second.origins).toEqual(first.origins);
  });

  it("a change writes immediately, without waiting for the heartbeat", () => {
    const now = Date.now();
    publishConnectedPanelOrigins(dir, origins, now);
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8189"], now + 700);
    // Read on the SAME clock the write used. Reading on the wall clock would put
    // `updated` 700ms in the future and trip the clock-step guard — the test
    // would fail for a reason that has nothing to do with what it asserts.
    expect(readPublishedPanelOrigins(now + 700)).toEqual(["http://127.0.0.1:8189"]);
  });

  it("does not rewrite when only the ORDER or duplication changed", () => {
    // The change key used to be the caller's raw array while the payload was the
    // filtered list, so the same connected panels arriving in a different order
    // rewrote the file to say exactly the same thing (review r2).
    // `connectedServerOrigins()` walks a live socket collection — ordering is not
    // something to assume stable.
    const now = Date.now();
    publishConnectedPanelOrigins(dir, ["http://a:1", "http://b:2"], now);
    const first = readFileSync(join(dir, PANEL_ORIGINS_FILE), "utf-8");
    publishConnectedPanelOrigins(dir, ["http://b:2", "http://a:1"], now + 700);
    publishConnectedPanelOrigins(dir, ["http://a:1", "http://a:1", "http://b:2"], now + 1_400);
    publishConnectedPanelOrigins(dir, ["http://a:1", "", "http://b:2"], now + 2_100);
    expect(readFileSync(join(dir, PANEL_ORIGINS_FILE), "utf-8")).toBe(first);
  });

  it("publishes a deduped, ordered set — and a real change still writes", () => {
    // The other direction, so the test above cannot be satisfied by never writing.
    const now = Date.now();
    publishConnectedPanelOrigins(dir, ["http://b:2", "http://a:1", "http://a:1"], now);
    expect(readPublishedPanelOrigins(now)).toEqual(["http://a:1", "http://b:2"]);
    publishConnectedPanelOrigins(dir, ["http://a:1"], now + 700);
    expect(readPublishedPanelOrigins(now + 700)).toEqual(["http://a:1"]);
  });

  it("the heartbeat stays comfortably inside the age limit", () => {
    // The two constants are only correct RELATIVE to each other: a heartbeat
    // slower than the limit would expire a live orchestrator's record between
    // refreshes, silently losing the diagnostic on every long-stable session.
    expect(PANEL_ORIGINS_HEARTBEAT_MS * 2).toBeLessThanOrEqual(PANEL_ORIGINS_MAX_AGE_MS);
  });
});

describe("panel-origin channel — the write is atomic (review r2)", () => {
  it("leaves no .tmp behind, and the channel file is the only artefact", () => {
    publishConnectedPanelOrigins(dir, ["http://127.0.0.1:8188"]);
    expect(readdirSync(dir)).toEqual([PANEL_ORIGINS_FILE]);
  });

  it("replaces rather than truncating — a reader never sees an empty file", () => {
    // The torn-read this exists to prevent: `writeFileSync` on the live path
    // truncates and refills, so a child reading mid-write parses nothing and
    // answers [] — dropping every live origin at exactly the moment it is
    // formatting the error those origins explain.
    //
    // Asserted through inode/identity rather than by racing a real write, which
    // would be a flaky test: a rename REPLACES the directory entry, so the file
    // seen before the second publish is not the file seen after.
    const now = Date.now();
    publishConnectedPanelOrigins(dir, ["http://a:1"], now);
    const before = statSync(join(dir, PANEL_ORIGINS_FILE));
    publishConnectedPanelOrigins(dir, ["http://b:2"], now + 700);
    const after = statSync(join(dir, PANEL_ORIGINS_FILE));
    // Precondition asserted SEPARATELY and loudly. Folding it into the check
    // below (`ino === ino && ino !== 0`) would make this pass silently on any
    // platform that reports 0, which is how a test quietly stops testing.
    // Windows and Linux both report a real value; if one ever does not, this
    // fails and asks for a decision instead of going green.
    expect(before.ino).not.toBe(0);
    expect(after.ino).not.toBe(before.ino);
    expect(readPublishedPanelOrigins(now + 700)).toEqual(["http://b:2"]);
  });

  it("cleans up and stays unpublished when the replace cannot happen", () => {
    // Reaches the retry-then-give-up path WITHOUT mocking: a directory at the
    // destination makes every `renameSync` attempt fail on both platforms.
    // (`vi.spyOn(fsModule, "renameSync")` cannot do this — an ES module
    // namespace object is frozen, so redefining a member throws.)
    //
    // Two things must hold, and the second is the one that matters: the temp is
    // dropped rather than accumulating one file per tick, and the publisher does
    // NOT record the set as published — otherwise the change-only rule would
    // suppress every retry and the channel would be stuck on the old record for
    // as long as the set stayed the same.
    const now = Date.now();
    const blocked = join(dir, PANEL_ORIGINS_FILE);
    mkdirSync(blocked);
    publishConnectedPanelOrigins(dir, ["http://b:2"], now);
    expect(readdirSync(dir)).toEqual([PANEL_ORIGINS_FILE]); // no stray .tmp
    expect(readdirSync(blocked)).toEqual([]); // …and nothing written inside it

    // Clear the obstruction; the SAME set must still be written, proving the
    // failed attempt did not mark it published.
    rmSync(blocked, { recursive: true, force: true });
    publishConnectedPanelOrigins(dir, ["http://b:2"], now + 700);
    expect(readPublishedPanelOrigins(now + 700)).toEqual(["http://b:2"]);
  });
});

describe("panel-origin channel — bounded read (review, finding 3)", () => {
  it("ignores an oversized file instead of parsing it", () => {
    // This read happens while formatting a network failure. A huge file must not
    // delay the error it is being read to explain.
    writeFileSync(
      join(dir, PANEL_ORIGINS_FILE),
      JSON.stringify({ origins: ["http://127.0.0.1:8188"], updated: Date.now(), pid: process.pid, pad: "x".repeat(70_000) }),
    );
    expect(readPublishedPanelOrigins()).toEqual([]);
  });

  it("refuses a path that is not a regular file", () => {
    // The bound is only meaningful if the thing opened is a file. A directory at
    // this path used to reach readFileSync; now fstat on the opened descriptor
    // answers first. (The FIFO case this also covers cannot be built portably —
    // Windows has no mkfifo — so a directory stands in for "not a regular file".)
    rmSync(join(dir, PANEL_ORIGINS_FILE), { force: true });
    mkdirSync(join(dir, PANEL_ORIGINS_FILE));
    expect(readPublishedPanelOrigins()).toEqual([]);
  });

  it("still reads a normal-sized record", () => {
    writeFileSync(
      join(dir, PANEL_ORIGINS_FILE),
      JSON.stringify({ origins: ["http://127.0.0.1:8188"], updated: Date.now(), pid: process.pid }),
    );
    expect(readPublishedPanelOrigins()).toEqual(["http://127.0.0.1:8188"]);
  });
});
