// The P0 guard: a tab's SDK session id must survive the orchestrator PROCESS being
// killed and respawned (a wedge auto-restart), so the agent resumes the SAME
// conversation instead of silently forgetting everything. SessionStore is the
// durable, disk-backed copy that makes that possible — independent of whether the
// panel re-sends `hello.resume`. A fresh SessionStore on the same port simulates a
// brand-new orchestrator process reading what the previous one persisted.

import { describe, expect, it, afterEach } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../orchestrator/session-store.js";

// A port unlikely to collide with a real run or another test.
const PORT = 59187;
const FILE = join(tmpdir(), `comfyui-mcp-panel-sessions-${PORT}.json`);

afterEach(() => {
  try {
    rmSync(FILE);
  } catch {
    /* already gone */
  }
});

describe("SessionStore", () => {
  it("starts empty when no file exists", () => {
    const store = new SessionStore(PORT);
    expect(store.get("tab-a")).toBeUndefined();
  });

  it("persists a session id across a process restart (the P0 fix)", () => {
    const first = new SessionStore(PORT);
    first.set("tab-a", "sess-111");
    first.set("tab-b", "sess-222");

    // A brand-new process: a fresh store on the same port reads the prior one's disk.
    const restarted = new SessionStore(PORT);
    expect(restarted.get("tab-a")).toBe("sess-111");
    expect(restarted.get("tab-b")).toBe("sess-222");
  });

  it("overwrites a tab's session id (e.g. a fork/rewind makes a new one)", () => {
    const store = new SessionStore(PORT);
    store.set("tab-a", "sess-old");
    store.set("tab-a", "sess-new");
    expect(store.get("tab-a")).toBe("sess-new");
    expect(new SessionStore(PORT).get("tab-a")).toBe("sess-new");
  });

  it("clear() forgets a tab so a NEW chat starts fresh (no resurrected resume)", () => {
    const store = new SessionStore(PORT);
    store.set("tab-a", "sess-111");
    store.clear("tab-a");
    expect(store.get("tab-a")).toBeUndefined();
    // And the erasure is durable — a restart must not bring it back.
    expect(new SessionStore(PORT).get("tab-a")).toBeUndefined();
  });

  it("survives a corrupt/garbage file by starting empty", () => {
    const store = new SessionStore(PORT);
    store.set("tab-a", "sess-111");
    // Stomp the file with junk, then reload.
    writeFileSync(FILE, "{ not json");
    expect(new SessionStore(PORT).get("tab-a")).toBeUndefined();
  });

  it("isolates ids by port (two ComfyUI instances never cross-resume)", () => {
    const a = new SessionStore(PORT);
    a.set("tab-a", "sess-from-A");
    const b = new SessionStore(PORT + 1);
    try {
      expect(b.get("tab-a")).toBeUndefined();
    } finally {
      try {
        rmSync(join(tmpdir(), `comfyui-mcp-panel-sessions-${PORT + 1}.json`));
      } catch {
        /* ignore */
      }
    }
  });
});
