// The P0 guard: the agent's SDK session id must survive the orchestrator PROCESS
// being killed and respawned (a wedge auto-restart), so the agent resumes the SAME
// conversation instead of silently forgetting everything. SessionStore is the
// durable, disk-backed copy that makes that possible — independent of whether the
// panel re-sends `hello.resume`. A fresh SessionStore on the same port simulates a
// brand-new orchestrator process reading what the previous one persisted.
//
// #884 (orchestrator-scoped sessions) reshaped the store:
//  - it lives in ~/.comfyui-mcp/sessions (owner-stated: "persisted via DB on the
//    disk … inside of .comfyui-mcp sessions"), not the OS temp dir — with a
//    one-shot LOCATION migration from the old tmpdir file;
//  - the keys of record are the shared `orchestrator::<backend>` composite keys —
//    with a one-shot KEYING adoption of the newest legacy per-workflow entry per
//    backend, so upgrading users keep their most recent conversation's memory;
//  - the per-workflow `stable` index (and its poison machinery) is gone: the
//    shared key never churns, so there is nothing for it to rescue. A pre-#884
//    v2 file's stable entries are dropped on load.

import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, workflowIdentityParts } from "../../orchestrator/session-store.js";
import { SHARED_SESSION_SCOPE, sharedAgentKey } from "../../services/session-scope.js";

const PORT = 59187;
const UUID_A = "11111111-1111-4111-8111-111111111111";

// Every test gets its own scratch dir so nothing touches the real home and no
// state leaks between tests. The pre-#884 tmpdir file for this port is removed
// too — a stale one would be silently migrated into the next store.
const dirs: string[] = [];
function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cmcp-sessions-"));
  dirs.push(d);
  return d;
}
const LEGACY_FILE = join(tmpdir(), `comfyui-mcp-panel-sessions-${PORT}.json`);
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  try {
    rmSync(LEGACY_FILE);
  } catch {
    /* already gone */
  }
});

const fileFor = (dir: string, port = PORT) => join(dir, `panel-sessions-${port}.json`);

describe("SessionStore", () => {
  it("#866 — REFUSES the real-home default under the test runner (guard at the write)", () => {
    // The store lives in the user's real ~/.comfyui-mcp; a test constructing it
    // without an explicit { dir } must fail loudly, never silently pollute.
    expect(() => new SessionStore(PORT)).toThrow(/Refusing to open the real/);
  });

  it("starts empty when no file exists", () => {
    const dir = scratchDir();
    const store = new SessionStore(PORT, { dir });
    expect(store.get(sharedAgentKey("claude"))).toBeUndefined();
  });

  it("persists a session id across a process restart (the P0 fix)", () => {
    const dir = scratchDir();
    const key = sharedAgentKey("claude");
    new SessionStore(PORT, { dir }).set(key, "sess-1");
    // A brand-new instance (a respawned orchestrator) reads it back from disk.
    expect(new SessionStore(PORT, { dir }).get(key)).toBe("sess-1");
  });

  it("overwrites a session id (e.g. a fork/rewind makes a new one)", () => {
    const dir = scratchDir();
    const key = sharedAgentKey("claude");
    const store = new SessionStore(PORT, { dir });
    store.set(key, "sess-1");
    store.set(key, "sess-2");
    expect(new SessionStore(PORT, { dir }).get(key)).toBe("sess-2");
  });

  it("clear() forgets a key so a NEW chat starts fresh (no resurrected resume)", () => {
    const dir = scratchDir();
    const key = sharedAgentKey("claude");
    const store = new SessionStore(PORT, { dir });
    store.set(key, "sess-1");
    store.clear(key);
    expect(store.get(key)).toBeUndefined();
    expect(new SessionStore(PORT, { dir }).get(key)).toBeUndefined();
  });

  it("survives a corrupt/garbage file by starting empty", () => {
    const dir = scratchDir();
    writeFileSync(fileFor(dir), "{not json");
    const store = new SessionStore(PORT, { dir });
    expect(store.get(sharedAgentKey("claude"))).toBeUndefined();
  });

  it("isolates ids by port (two ComfyUI instances never cross-resume)", () => {
    const dir = scratchDir();
    const key = sharedAgentKey("claude");
    new SessionStore(PORT, { dir }).set(key, "sess-a");
    expect(new SessionStore(PORT + 1, { dir }).get(key)).toBeUndefined();
  });

  it("reads an ANCIENT flat file (Record<string,string>) and keeps resuming", () => {
    const dir = scratchDir();
    writeFileSync(fileFor(dir), JSON.stringify({ "tmp:a::claude": "sess-old" }));
    const store = new SessionStore(PORT, { dir });
    expect(store.get("tmp:a::claude")).toBe("sess-old");
    // …and the format upgrade re-flushed as v2.
    const onDisk = JSON.parse(readFileSync(fileFor(dir), "utf8"));
    expect(onDisk.v).toBe(2);
    expect(onDisk.sessions["tmp:a::claude"].s).toBe("sess-old");
  });

  it("clamps a corrupt FUTURE timestamp AND persists the clamp so it can't be immortal", () => {
    const dir = scratchDir();
    writeFileSync(
      fileFor(dir),
      JSON.stringify({ v: 2, sessions: { "orchestrator::claude": { s: "sess-f", t: 1e15 } } }),
    );
    const store = new SessionStore(PORT, { dir });
    expect(store.get("orchestrator::claude")).toBe("sess-f");
    const onDisk = JSON.parse(readFileSync(fileFor(dir), "utf8"));
    expect(onDisk.sessions["orchestrator::claude"].t).toBeLessThanOrEqual(Date.now());
  });

  it("garbage-collects entries older than the TTL on load (unbounded-growth guard)", () => {
    const dir = scratchDir();
    const stale = Date.now() - SessionStore.GC_TTL_MS - 1000;
    writeFileSync(
      fileFor(dir),
      JSON.stringify({
        v: 2,
        sessions: {
          "tmp:dead::claude": { s: "sess-dead", t: stale },
          "orchestrator::claude": { s: "sess-live", t: Date.now() },
        },
      }),
    );
    const store = new SessionStore(PORT, { dir });
    expect(store.get("tmp:dead::claude")).toBeUndefined();
    expect(store.get("orchestrator::claude")).toBe("sess-live");
    const onDisk = JSON.parse(readFileSync(fileFor(dir), "utf8"));
    expect(onDisk.sessions["tmp:dead::claude"]).toBeUndefined();
  });

  describe("#884 durability — persistence failures never destroy the store (confirming-gate P0/P1)", () => {
    // Force every flush to fail portably: occupy the `.tmp` path with a
    // DIRECTORY, so writeFileSync(tmp) errors before anything touches the
    // main file.
    const blockTmp = (dir: string) => mkdirSync(`${fileFor(dir)}.tmp`, { recursive: true });

    it("a failed persist leaves the previous on-disk store INTACT (no truncate-in-place)", () => {
      const dir = scratchDir();
      const key = sharedAgentKey("claude");
      expect(new SessionStore(PORT, { dir }).set(key, "sess-good")).toBe(true);
      blockTmp(dir);
      const store = new SessionStore(PORT, { dir });
      expect(store.set(key, "sess-newer")).toBe(false); // persist FAILED, reported
      // The old on-disk state survived — a crash now loses the newer id (a
      // lost update) but never the whole store (which corrupt-refuses legacy
      // recovery and would have lost every resume id).
      rmSync(`${fileFor(dir)}.tmp`, { recursive: true, force: true });
      expect(new SessionStore(PORT, { dir }).get(key)).toBe("sess-good");
    });

    it("clear() reports a failed durable clear — the caller can disclose the resume risk", () => {
      const dir = scratchDir();
      const key = sharedAgentKey("claude");
      const store = new SessionStore(PORT, { dir });
      expect(store.set(key, "sess-1")).toBe(true);
      blockTmp(dir);
      expect(store.clear(key)).toBe(false); // disk still holds it…
      expect(store.get(key)).toBeUndefined(); // …but THIS process starts fresh
      rmSync(`${fileFor(dir)}.tmp`, { recursive: true, force: true });
      // A restart resumes the cleared conversation — exactly the hazard the
      // false return lets new_session disclose instead of claiming success.
      expect(new SessionStore(PORT, { dir }).get(key)).toBe("sess-1");
    });

    it("a leftover .tmp (crashed/failed rename) is the NEWEST state and is recovered on load", () => {
      const dir = scratchDir();
      const key = sharedAgentKey("claude");
      writeFileSync(
        fileFor(dir),
        JSON.stringify({ v: 2, sessions: { [key]: { s: "sess-old", t: Date.now() } } }),
      );
      writeFileSync(
        `${fileFor(dir)}.tmp`,
        JSON.stringify({ v: 2, sessions: { [key]: { s: "sess-newest", t: Date.now() } } }),
      );
      const store = new SessionStore(PORT, { dir });
      expect(store.get(key)).toBe("sess-newest");
      // …and the recovery re-persisted properly (tmp renamed away).
      expect(existsSync(`${fileFor(dir)}.tmp`)).toBe(false);
      expect(new SessionStore(PORT, { dir }).get(key)).toBe("sess-newest");
    });

    // Confirming gate 2, P1: both set() and clear() had an in-memory shortcut
    // that answered `true` WITHOUT touching disk. After an earlier write
    // failure that answer is a lie — the shortcut describes RAM while the
    // stale file survives a restart. These pin the honest answer.
    it("a REPEATED set after a failed write does not claim durability it never achieved", () => {
      const dir = scratchDir();
      const key = sharedAgentKey("claude");
      const store = new SessionStore(PORT, { dir });
      blockTmp(dir);
      expect(store.set(key, "sess-x")).toBe(false); // write failed, reported
      // Same id again, well inside the 1h timestamp-skip window: the shortcut
      // used to return true here, so New chat looked clean and the next
      // restart resurrected the old conversation anyway.
      expect(store.set(key, "sess-x")).toBe(false);
      // …and once the filesystem recovers, the retry actually repairs the store.
      rmSync(`${fileFor(dir)}.tmp`, { recursive: true, force: true });
      expect(store.set(key, "sess-x")).toBe(true);
      expect(new SessionStore(PORT, { dir }).get(key)).toBe("sess-x");
    });

    it("a SECOND clear after a failed clear still reports the stale on-disk entry", () => {
      const dir = scratchDir();
      const key = sharedAgentKey("claude");
      const store = new SessionStore(PORT, { dir });
      expect(store.set(key, "sess-1")).toBe(true);
      blockTmp(dir);
      expect(store.clear(key)).toBe(false);
      // The key is already gone from memory, so the old `!(key in sessions)`
      // shortcut returned true — a clean-looking New chat over a live stale
      // entry. It must stay false while the file still holds it.
      expect(store.clear(key)).toBe(false);
      rmSync(`${fileFor(dir)}.tmp`, { recursive: true, force: true });
      // Filesystem back: the retry clears disk for real, and now it IS durable.
      expect(store.clear(key)).toBe(true);
      expect(new SessionStore(PORT, { dir }).get(key)).toBeUndefined();
    });

    it("a CORRUPT leftover .tmp (crash mid-write) falls back to the main file", () => {
      const dir = scratchDir();
      const key = sharedAgentKey("claude");
      writeFileSync(
        fileFor(dir),
        JSON.stringify({ v: 2, sessions: { [key]: { s: "sess-main", t: Date.now() } } }),
      );
      writeFileSync(`${fileFor(dir)}.tmp`, "{truncated-mid-wr");
      expect(new SessionStore(PORT, { dir }).get(key)).toBe("sess-main");
    });

    // Confirming gate 3, P1: `undurable === false` proved only that the LAST
    // write succeeded. If the file is deleted or replaced EXTERNALLY after
    // that, the in-memory shortcut kept answering "durable" while a restart
    // would lose the session. The claim must not exceed the evidence: the
    // shortcut now verifies the file it last wrote is observably still there
    // (size+mtime fingerprint) and REPAIRS it otherwise.
    it("set() after the store file was DELETED externally repairs the file instead of asserting durability", () => {
      const dir = scratchDir();
      const key = sharedAgentKey("claude");
      const store = new SessionStore(PORT, { dir });
      expect(store.set(key, "sess-drift")).toBe(true);
      rmSync(fileFor(dir)); // external deletion after a clean write
      // Same id, well inside the 1h timestamp-skip window: the old shortcut
      // returned true here without touching disk — and a restart lost the id.
      expect(store.set(key, "sess-drift")).toBe(true);
      expect(existsSync(fileFor(dir))).toBe(true); // repaired, not merely claimed
      expect(new SessionStore(PORT, { dir }).get(key)).toBe("sess-drift");
    });

    it("set() after the store file was REPLACED externally repairs it too", () => {
      const dir = scratchDir();
      const key = sharedAgentKey("claude");
      const store = new SessionStore(PORT, { dir });
      expect(store.set(key, "sess-drift")).toBe(true);
      // An external writer replaced the file (different content ⇒ different
      // size, which the fingerprint catches without a full read).
      writeFileSync(fileFor(dir), JSON.stringify({ v: 2, sessions: {} }));
      expect(store.set(key, "sess-drift")).toBe(true);
      expect(new SessionStore(PORT, { dir }).get(key)).toBe("sess-drift");
    });

    it("drift repair still reports false while the filesystem refuses the rewrite", () => {
      const dir = scratchDir();
      const key = sharedAgentKey("claude");
      const store = new SessionStore(PORT, { dir });
      expect(store.set(key, "sess-drift")).toBe(true);
      rmSync(fileFor(dir));
      blockTmp(dir); // the repair write itself cannot land
      expect(store.set(key, "sess-drift")).toBe(false); // honest: nothing on disk
      rmSync(`${fileFor(dir)}.tmp`, { recursive: true, force: true });
      expect(store.set(key, "sess-drift")).toBe(true);
      expect(new SessionStore(PORT, { dir }).get(key)).toBe("sess-drift");
    });
  });

  describe("#884 LOCATION migration — tmpdir → ~/.comfyui-mcp/sessions", () => {
    it("imports the pre-#884 tmpdir file when the new location is empty", () => {
      const dir = scratchDir();
      writeFileSync(
        LEGACY_FILE,
        JSON.stringify({ v: 2, sessions: { "wf:a.json::claude": { s: "sess-tmpdir", t: Date.now() } } }),
      );
      const store = new SessionStore(PORT, { dir });
      expect(store.get("wf:a.json::claude")).toBe("sess-tmpdir");
      // …and persisted at the NEW location immediately (reboot-safe even if the
      // OS reclaims the temp file next boot).
      expect(existsSync(fileFor(dir))).toBe(true);
      const onDisk = JSON.parse(readFileSync(fileFor(dir), "utf8"));
      expect(onDisk.sessions["wf:a.json::claude"].s).toBe("sess-tmpdir");
    });

    it("an existing-but-CORRUPT home file starts EMPTY — never resurrects the tmpdir store", () => {
      // Missing ≠ corrupt (codex round 1, P1): after the one-shot migration the
      // tmpdir file is stale by definition. If a later truncated write corrupts
      // the home file, falling back to tmpdir would resume sessions the user
      // has since replaced or cleared — a WRONG resume, worse than a lost one.
      const dir = scratchDir();
      writeFileSync(
        LEGACY_FILE,
        JSON.stringify({ v: 2, sessions: { "orchestrator::claude": { s: "sess-stale", t: Date.now() } } }),
      );
      writeFileSync(fileFor(dir), "{truncated-mid-wri"); // corrupt, but EXISTS
      const store = new SessionStore(PORT, { dir });
      expect(store.get("orchestrator::claude")).toBeUndefined();
    });

    it("the new location, once present, WINS over the tmpdir file", () => {
      const dir = scratchDir();
      writeFileSync(
        LEGACY_FILE,
        JSON.stringify({ v: 2, sessions: { "orchestrator::claude": { s: "sess-old", t: Date.now() } } }),
      );
      writeFileSync(
        fileFor(dir),
        JSON.stringify({ v: 2, sessions: { "orchestrator::claude": { s: "sess-new", t: Date.now() } } }),
      );
      expect(new SessionStore(PORT, { dir }).get("orchestrator::claude")).toBe("sess-new");
    });

    it("a pre-#884 v2 file's `stable` index is dropped on load (obsolete under the shared key)", () => {
      const dir = scratchDir();
      writeFileSync(
        fileFor(dir),
        JSON.stringify({
          v: 2,
          sessions: { "wf:a.json::claude": { s: "sess-a", t: Date.now() } },
          stable: { "wfid::http://x::u::claude": { s: "sess-stable", t: Date.now() } },
        }),
      );
      const store = new SessionStore(PORT, { dir });
      expect(store.get("wf:a.json::claude")).toBe("sess-a");
      const onDisk = JSON.parse(readFileSync(fileFor(dir), "utf8"));
      expect(onDisk.stable).toBeUndefined();
    });
  });

  describe("#884 KEYING adoption — newest legacy per-workflow entry seeds the shared conversation", () => {
    it("adopts the MOST RECENTLY USED legacy entry for the backend and persists it", () => {
      const dir = scratchDir();
      const now = Date.now();
      writeFileSync(
        fileFor(dir),
        JSON.stringify({
          v: 2,
          sessions: {
            "wf:old.json::claude": { s: "sess-older", t: now - 60_000 },
            "wf:new.json::claude": { s: "sess-newest", t: now - 1_000 },
            "wf:new.json::codex": { s: "sess-codex", t: now - 500 },
          },
        }),
      );
      const store = new SessionStore(PORT, { dir });
      expect(store.get(sharedAgentKey("claude"))).toBe("sess-newest"); // newest claude entry wins
      expect(store.get(sharedAgentKey("codex"))).toBe("sess-codex"); // per-backend adoption
      // Adoption persisted: a respawn resumes the SAME shared conversation.
      expect(new SessionStore(PORT, { dir }).get(sharedAgentKey("claude"))).toBe("sess-newest");
    });

    it("an existing shared entry always wins (adoption is a one-shot fallback)", () => {
      const dir = scratchDir();
      const store = new SessionStore(PORT, { dir });
      store.set("wf:a.json::claude", "sess-legacy");
      store.set(sharedAgentKey("claude"), "sess-shared");
      expect(store.get(sharedAgentKey("claude"))).toBe("sess-shared");
    });

    it("never adopts test/spike keys, other backends, or the shared scope itself", () => {
      const dir = scratchDir();
      const store = new SessionStore(PORT, { dir });
      store.set("e2e-run::claude", "sess-e2e");
      store.set("spike-x::claude", "sess-spike");
      store.set("wf:a.json::codex", "sess-other-backend");
      expect(store.get(sharedAgentKey("claude"))).toBeUndefined();
    });

    it("a NON-shared key never adopts (legacy keys stay reachable only as themselves)", () => {
      const dir = scratchDir();
      const store = new SessionStore(PORT, { dir });
      store.set("wf:a.json::claude", "sess-a");
      expect(store.get("wf:b.json::claude")).toBeUndefined();
    });

    it("adoption CONSUMES the legacy entries, so a NEW chat can never resurrect them", () => {
      // clear() is the deliberate New-chat boundary. If get() re-adopted a legacy
      // entry right back, "New chat" would silently resurrect the conversation
      // the user just reset — adoption must therefore consume its sources.
      const dir = scratchDir();
      const store = new SessionStore(PORT, { dir });
      store.set("wf:a.json::claude", "sess-first");
      store.set("wf:b.json::claude", "sess-second");
      const adopted = store.get(sharedAgentKey("claude"));
      expect(["sess-first", "sess-second"]).toContain(adopted); // adopted one of them…
      store.clear(sharedAgentKey("claude")); // …then the user starts a NEW chat
      // BOTH legacy entries were consumed by the adoption, so nothing resurrects —
      // not even the one that lost the newest-wins pick.
      expect(store.get(sharedAgentKey("claude"))).toBeUndefined(); // stays new
      // …durably: a respawned orchestrator can't re-adopt either.
      expect(new SessionStore(PORT, { dir }).get(sharedAgentKey("claude"))).toBeUndefined();
    });
  });

  describe("workflowIdentityParts (kept: the per-command workflow STAMP, a routing fence)", () => {
    it("validates the uuid shape and requires a trusted origin", () => {
      expect(
        workflowIdentityParts({ workflowUuid: UUID_A, origin: "http://127.0.0.1:8188" }),
        // #1255 — the loopback spellings now fold to one canonical origin, so a
        // fence bound under `127.0.0.1` validates against a panel reached on
        // `localhost` and vice versa. The subject of this assertion is uuid/origin
        // VALIDATION, which is unchanged; only the canonical form it returns moved.
      ).toEqual({ origin: "http://localhost:8188", uuid: UUID_A });
      expect(workflowIdentityParts({ workflowUuid: "not-a-uuid", origin: "http://x" })).toBeUndefined();
      expect(workflowIdentityParts({ workflowUuid: UUID_A, origin: "" })).toBeUndefined();
      expect(workflowIdentityParts({ workflowUuid: undefined, origin: "http://x" })).toBeUndefined();
    });

    it("canonicalizes origin case + trailing slashes and lowercases the uuid", () => {
      expect(
        workflowIdentityParts({
          workflowUuid: UUID_A.toUpperCase(),
          origin: "HTTP://Host:8188//",
        }),
      ).toEqual({ origin: "http://host:8188", uuid: UUID_A });
    });
  });
});

// #796's class, with DATA LOSS as the consequence.
//
// read() had ONE catch covering both `readFileSync` throwing and `parse` throwing,
// and returned `{ sessions: {} }` for both. Those are different states:
//
//   parse threw        → the bytes really are unusable; nothing recoverable is lost.
//   readFileSync threw → EACCES / EBUSY / EMFILE. The sessions are INTACT and
//                        readable later; we just could not open the file this
//                        instant (antivirus, backup software, another orchestrator
//                        mid-write — all routine on Windows).
//
// Starting empty on the second is silent data loss, because flush() renames over
// this.path unconditionally: the first new session — or even a touch() — replaces
// an intact store with a one-entry one, and every prior resume id is gone. The
// agent forgets every conversation, and nothing says why.
//
// This file already argues "failing to persist is strictly better than destroying
// what's there". That reasoning simply never covered a failed LOAD.
describe("a store that could not be READ is never overwritten", () => {
  /** A path that exists and cannot be read: a directory where the file goes.
   *  existsSync passes, readFileSync throws EISDIR — on every platform. */
  function unreadableStore(): { dir: string; storePath: string } {
    const dir = scratchDir();
    const storePath = join(dir, `panel-sessions-${PORT}.json`);
    mkdirSync(storePath, { recursive: true });
    return { dir, storePath };
  }

  it("starts empty but PRESERVES the file instead of clobbering it", () => {
    const { dir, storePath } = unreadableStore();

    const store = new SessionStore(PORT, { dir });
    // It could not read anything, so it has nothing.
    expect(store.get(sharedAgentKey("claude"))).toBeUndefined();

    // The first persist must move the unreadable original aside, not destroy it.
    expect(store.set(sharedAgentKey("claude"), "sess-new")).toBe(true);

    const preserved = readdirSync(dir).filter((f) => f.includes(".unreadable-"));
    expect(preserved, "the unreadable store must be kept, not overwritten").toHaveLength(1);
    // …and the new store really was written in its place.
    expect(existsSync(storePath)).toBe(true);
    expect(readFileSync(storePath, "utf8")).toContain("sess-new");
  });

  it("preserves only once — later writes are ordinary", () => {
    const { dir } = unreadableStore();
    const store = new SessionStore(PORT, { dir });

    store.set(sharedAgentKey("claude"), "sess-1");
    store.set(sharedAgentKey("claude"), "sess-2");
    store.set(sharedAgentKey("codex"), "sess-3");

    expect(readdirSync(dir).filter((f) => f.includes(".unreadable-"))).toHaveLength(1);
  });

  // The other half: a genuinely CORRUPT file is still discarded. Preserving every
  // parse failure would litter the directory and imply the data was salvageable.
  it("still starts empty for a corrupt (readable) store, with no preservation copy", () => {
    const dir = scratchDir();
    writeFileSync(join(dir, `panel-sessions-${PORT}.json`), "{ this is not json");

    const store = new SessionStore(PORT, { dir });
    expect(store.get(sharedAgentKey("claude"))).toBeUndefined();
    store.set(sharedAgentKey("claude"), "sess-1");

    expect(readdirSync(dir).filter((f) => f.includes(".unreadable-"))).toHaveLength(0);
  });
});
