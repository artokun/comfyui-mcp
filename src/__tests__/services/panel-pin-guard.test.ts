// The pin guard at the point the PANEL PACK IS IDENTIFIED AS THE TARGET.
//
// The bug these tests exist for: the pin was originally enforced only inside
// `runPanelAction`, which was described as "the mutation choke point". It wasn't
// — the panel is an ordinary custom node pack, so `install_custom_node(action:"update")`
// and `id="all"` reached the SAME ComfyUI-Manager mutation without ever passing
// the guard. A pinned user was one generic call away from being moved.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetPanelBaseCache } from "../../services/panel-workspace.js";
import {
  mkdtempSync,
  existsSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// #798 — durability is observable only as "fsync happened on THAT FILE before
// the write was reported done". Track openSync fd→path and record which paths
// get fsync'd (delegating to the real fs throughout), so the tests below fail
// if the fsync is ever removed from a load-bearing write. Counting bare calls
// is not enough: the best-effort DIRECTORY fsync would keep a bare counter
// green with the file fsync deleted. closeSync drops the mapping so a recycled
// fd can never attribute a later fsync to a dead path.
const fsyncTracker = vi.hoisted(() => ({
  paths: [] as string[],
  fdPaths: new Map<number, string>(),
  onBeforeRename: undefined as undefined | ((from: string, to: string) => void),
  onBeforeLink: undefined as undefined | ((from: string, to: string) => void),
  /** When set, the next fsync on a path containing this substring throws. */
  failFsyncFor: undefined as string | undefined,
  /** When set, an fsync on EXACTLY this path throws (with `code` if given). */
  failFsyncExact: undefined as { path: string; code?: string } | undefined,
  /** When set, openSync on EXACTLY this path throws EACCES. */
  failOpenFor: undefined as string | undefined,
  /** When set, writeSync on a path containing this substring reports 0 bytes. */
  zeroWriteFor: undefined as string | undefined,
  /** When set, rmSync on a path containing this substring throws EPERM. */
  failRmFor: undefined as string | undefined,
  onBeforeOpen: undefined as undefined | ((path: string, flags: unknown) => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (
      p: Parameters<typeof actual.openSync>[0],
      flags: Parameters<typeof actual.openSync>[1],
      mode?: Parameters<typeof actual.openSync>[2],
    ) => {
      if (fsyncTracker.failOpenFor && String(p) === fsyncTracker.failOpenFor) {
        const err = new Error("injected open failure") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      fsyncTracker.onBeforeOpen?.(String(p), flags);
      const fd = actual.openSync(p, flags, mode);
      fsyncTracker.fdPaths.set(fd, String(p));
      return fd;
    },
    closeSync: (fd: number) => {
      fsyncTracker.fdPaths.delete(fd);
      return actual.closeSync(fd);
    },
    fsyncSync: (fd: number) => {
      const p = fsyncTracker.fdPaths.get(fd);
      if (p) {
        fsyncTracker.paths.push(p);
        if (fsyncTracker.failFsyncExact && p === fsyncTracker.failFsyncExact.path) {
          const spec = fsyncTracker.failFsyncExact;
          fsyncTracker.failFsyncExact = undefined;
          const err = new Error("injected fsync failure") as NodeJS.ErrnoException;
          if (spec.code) err.code = spec.code;
          throw err;
        }
        if (fsyncTracker.failFsyncFor && p.includes(fsyncTracker.failFsyncFor)) {
          fsyncTracker.failFsyncFor = undefined;
          throw new Error("injected fsync failure");
        }
      }
      return actual.fsyncSync(fd);
    },
    // Test hook for the reclaim's replace-between-observation-and-rename race:
    // lets a test swap the lock's content at the exact moment it is moved aside.
    renameSync: (
      from: Parameters<typeof actual.renameSync>[0],
      to: Parameters<typeof actual.renameSync>[1],
    ) => {
      fsyncTracker.onBeforeRename?.(String(from), String(to));
      return actual.renameSync(from, to);
    },
    // Same, for the reclaim's link-back restore: lets a test land a fresh lock
    // at the path in the exact gap the restore must never overwrite into.
    linkSync: (
      from: Parameters<typeof actual.linkSync>[0],
      to: Parameters<typeof actual.linkSync>[1],
    ) => {
      fsyncTracker.onBeforeLink?.(String(from), String(to));
      return actual.linkSync(from, to);
    },
    // A writeSync that reports 0 bytes written (without writing) — the
    // resource-pressure short write the lock init must detect, not spin on.
    writeSync: (fd: number, ...args: unknown[]) => {
      const p = fsyncTracker.fdPaths.get(fd);
      if (p && fsyncTracker.zeroWriteFor && p.includes(fsyncTracker.zeroWriteFor)) {
        return 0;
      }
      return (actual.writeSync as (...a: unknown[]) => number)(fd, ...args);
    },
    // An rmSync that fails (AV holding the file) — cleanup paths must report
    // the OUTCOME honestly, not misclassify the main operation as failed.
    rmSync: (p: Parameters<typeof actual.rmSync>[0], ...args: unknown[]) => {
      if (fsyncTracker.failRmFor && String(p).includes(fsyncTracker.failRmFor)) {
        const err = new Error("injected rm failure") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return (actual.rmSync as (...a: unknown[]) => void)(p, ...args);
    },
  };
});

import {
  activePanelPendingOps,
  assertPanelPinAllows,
  clearPanelPendingOp,
  PanelPinnedError,
  panelLockPath,
  panelPendingOpsPath,
  reclaimAbandonedPanelLock,
  recordPanelPendingOp,
  targetsPanelPack,
  targetsPanelPackExactly,
  withPanelMutationLock,
} from "../../services/panel-pin-guard.js";
import { setPanelVersionPin, PANEL_PIN_ENV_VAR } from "../../services/panel-settings.js";

let dir: string;

beforeEach(() => {
  // #1222 - the panel-base cache is module-level. Its production guards
  // (target key, target generation, 60s TTL) never fire inside one test file,
  // so a resolution primed by one test is inherited by the next -- and
  // panelRecoveryContext() reads it to choose between two ENTIRELY different
  // remedies, making which assertion passes depend on execution order.
  //
  // Per FILE, not global: a setup file cannot import this module, because
  // setupFiles runs before per-suite vi.mock factories apply and the early
  // import resolves against the real environment instead. Copied from
  // panel-recovery-cluster.test.ts, which does this correctly and is not
  // one of the flaky files.
  __resetPanelBaseCache();
  dir = mkdtempSync(join(tmpdir(), "cmcp-pinguard-"));
  process.env.COMFYUI_MCP_PANEL_SETTINGS = join(dir, "panel-settings.json");
  process.env.COMFYUI_MCP_PANEL_LOCK = join(dir, "panel-op.lock");
  process.env.COMFYUI_MCP_PANEL_PENDING = join(dir, "panel-pending-ops.json");
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_PANEL_SETTINGS;
  delete process.env.COMFYUI_MCP_PANEL_LOCK;
  delete process.env.COMFYUI_MCP_PANEL_PENDING;
  delete process.env[PANEL_PIN_ENV_VAR];
  rmSync(dir, { recursive: true, force: true });
});

describe("targetsPanelPack — every spelling of the panel is the panel", () => {
  it.each([
    "comfyui-agent-panel", // registry id / pyproject name
    "comfyui-mcp-panel", // repo + custom_nodes dir name
    "ComfyUI-MCP-Panel", // case variant
    "  comfyui-agent-panel  ", // padded
    "https://github.com/artokun/comfyui-mcp-panel", // git URL
    "https://github.com/artokun/comfyui-mcp-panel.git", // git URL with .git
    "all", // bulk: moves the panel along with everything else
    "ALL",
  ])("matches %j", (id) => {
    expect(targetsPanelPack(id)).toBe(true);
  });

  it.each([
    // Every REF-CARRYING form parseGitUrl accepts. Naively taking the last path
    // segment turned "...panel.git@v0.11.28" into itself and ".../tree/main"
    // into "main", so both slipped past the matcher and moved a pinned panel.
    "https://github.com/artokun/comfyui-mcp-panel.git@v0.11.28",
    "https://github.com/artokun/comfyui-mcp-panel@nightly",
    "comfyui-mcp-panel@0.11.20",
    "https://github.com/artokun/comfyui-mcp-panel/tree/main",
    "https://github.com/artokun/comfyui-mcp-panel/commit/abc1234",
    "https://github.com/artokun/comfyui-mcp-panel/commits/main",
    "https://github.com/artokun/comfyui-mcp-panel/releases/tag/v0.11.28",
    "https://gitlab.com/artokun/comfyui-mcp-panel/-/tree/main",
    "https://gitlab.com/artokun/comfyui-mcp-panel/-/commit/abc1234",
    "https://bitbucket.org/artokun/comfyui-mcp-panel/src/main",
    "git@github.com:artokun/comfyui-mcp-panel.git",
    "https://github.com/artokun/comfyui-mcp-panel/",
    "https://github.com/artokun/comfyui-mcp-panel.git?foo=1",
    "artokun/comfyui-agent-panel", // "author/repo" form the panel tools accept
  ])("matches the ref-carrying / URL form %j", (id) => {
    expect(targetsPanelPack(id)).toBe(true);
  });

  it.each([
    "comfyui-manager",
    "was-node-suite",
    "",
    "   ",
    "comfyui-panel-other",
    "https://github.com/someone/comfyui-mcp-panel-fork",
    "https://github.com/someone/other-pack/tree/comfyui-mcp-panel",
  ])("does not match unrelated id %j", (id) => {
    expect(targetsPanelPack(id)).toBe(false);
  });

  it("separates an exact panel target from a bulk one (only the former can be redirected)", () => {
    expect(targetsPanelPackExactly("comfyui-agent-panel")).toBe(true);
    // "all" targets the panel but cannot be routed through the panel-only path.
    expect(targetsPanelPackExactly("all")).toBe(false);
    expect(targetsPanelPack("all")).toBe(true);
  });
});

describe("assertPanelPinAllows — the generic-tool door", () => {
  it("permits everything when nothing is pinned", () => {
    expect(() => assertPanelPinAllows("update", "comfyui-agent-panel")).not.toThrow();
    expect(() => assertPanelPinAllows("update", "all")).not.toThrow();
  });

  it("permits an unrelated pack even while the panel is pinned", () => {
    setPanelVersionPin("0.11.3");
    expect(() => assertPanelPinAllows("update", "was-node-suite")).not.toThrow();
  });

  it.each(["install", "update", "reinstall", "fix"])(
    "REFUSES %s of the panel by registry id while pinned",
    (action) => {
      setPanelVersionPin("0.11.3");
      expect(() => assertPanelPinAllows(action, "comfyui-agent-panel")).toThrow(
        PanelPinnedError,
      );
      expect(() => assertPanelPinAllows(action, "comfyui-agent-panel")).toThrow(
        /pinned to 0\.11\.3/i,
      );
    },
  );

  it("REFUSES the panel by repo name and by git URL while pinned", () => {
    setPanelVersionPin("0.11.3");
    expect(() => assertPanelPinAllows("update", "comfyui-mcp-panel")).toThrow(
      PanelPinnedError,
    );
    expect(() =>
      assertPanelPinAllows("update", "https://github.com/artokun/comfyui-mcp-panel.git"),
    ).toThrow(PanelPinnedError);
  });

  it('REFUSES a bulk id="all" while pinned, and says why "all" cannot be partial', () => {
    // The scenario that made this Critical: nothing about "all" names the panel,
    // yet it moves it.
    setPanelVersionPin("0.11.3");
    expect(() => assertPanelPinAllows("update", "all")).toThrow(PanelPinnedError);
    expect(() => assertPanelPinAllows("update", "all")).toThrow(
      /cannot update everything-except-one-pack|individually by id/i,
    );
  });

  it("REFUSES under an ENV pin and says unpin alone will not clear it", () => {
    process.env[PANEL_PIN_ENV_VAR] = "0.11.3";
    expect(() => assertPanelPinAllows("update", "all")).toThrow(
      new RegExp(PANEL_PIN_ENV_VAR),
    );
  });

  it("REFUSES when the pin is present but unreadable (can't tell → pinned)", () => {
    mkdirSync(dirname(process.env.COMFYUI_MCP_PANEL_SETTINGS as string), {
      recursive: true,
    });
    writeFileSync(process.env.COMFYUI_MCP_PANEL_SETTINGS as string, "{ not json");
    expect(() => assertPanelPinAllows("update", "comfyui-agent-panel")).toThrow(
      PanelPinnedError,
    );
  });

  it("permits again once the pin is cleared via the env escape hatch", () => {
    setPanelVersionPin("0.11.3");
    expect(() => assertPanelPinAllows("update", "all")).toThrow();
    process.env[PANEL_PIN_ENV_VAR] = "off";
    expect(() => assertPanelPinAllows("update", "all")).not.toThrow();
  });
});

describe("withPanelMutationLock — a FILE lock, so it holds across processes", () => {
  it("serializes overlapping operations", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const op = async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    };
    await Promise.all([
      withPanelMutationLock(op),
      withPanelMutationLock(op),
      withPanelMutationLock(op),
    ]);
    expect(maxConcurrent).toBe(1);
  });

  it("releases the lock file afterwards, including on rejection", async () => {
    await withPanelMutationLock(async () => undefined);
    expect(existsSync(panelLockPath())).toBe(false);

    await expect(
      withPanelMutationLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(panelLockPath())).toBe(false);

    // A rejection must not wedge the queue for everyone after it.
    await expect(withPanelMutationLock(async () => "ok")).resolves.toBe("ok");
  });

  it("is RE-ENTRANT so a guarded service can be called from inside a held lock", async () => {
    // runPanelAction holds the lock and then calls updateCustomNode, which takes
    // it again — a non-re-entrant lock would deadlock here.
    const result = await withPanelMutationLock(async () =>
      withPanelMutationLock(async () => "inner ran"),
    );
    expect(result).toBe("inner ran");
  });

  it("re-entrancy is ASYNC-CONTEXT-scoped, not process-global", async () => {
    // The bug: a process-global "held" flag let an UNRELATED concurrent caller
    // (a pin write) sail straight through while an update held the lock —
    // landing in the exact window between the update's final pin check and its
    // Manager call. Only work nested INSIDE the holder may skip the lock.
    const order: string[] = [];
    let releaseHolder: (() => void) | undefined;
    const holderDone = new Promise<void>((r) => {
      releaseHolder = r;
    });

    const holder = withPanelMutationLock(async () => {
      order.push("holder:start");
      // Nested-inside-the-holder: exempt, runs immediately.
      await withPanelMutationLock(async () => order.push("nested"));
      await holderDone;
      order.push("holder:end");
    });

    // Started from OUTSIDE the holder's async context while it is held.
    await new Promise((r) => setTimeout(r, 20));
    const outsider = withPanelMutationLock(async () => order.push("outsider"));

    await new Promise((r) => setTimeout(r, 20));
    // The outsider must NOT have run yet — it is queued behind the holder.
    expect(order).toEqual(["holder:start", "nested"]);

    releaseHolder?.();
    await Promise.all([holder, outsider]);
    expect(order).toEqual(["holder:start", "nested", "holder:end", "outsider"]);
  });

  it("does NOT reclaim a fresh lock even when its recorded pid is dead", async () => {
    // Age is a mandatory part of the proof. A just-created lock can still be
    // in the small window before its writer has committed its pid record.
    writeFileSync(panelLockPath(), JSON.stringify({ pid: 999999 }));
    await expect(
      withPanelMutationLock(async () => "should not run", { timeoutMs: 300 }),
    ).rejects.toThrow(/Timed out .* waiting for the panel operation lock/);
    expect(existsSync(panelLockPath())).toBe(true);
  });

  it("fails closed on a stale dead-owner lock and names the safe recovery boundary", async () => {
    const path = panelLockPath();
    writeFileSync(path, JSON.stringify({ pid: 0x7fffffff }));
    const old = new Date(Date.now() - 60 * 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(path, old, old);

    await expect(
      withPanelMutationLock(async () => "must not run", { timeoutMs: 300 }),
    ).rejects.toThrow(/stop or restart every comfyui-mcp orchestrator.*delete this exact lock file/i);
    expect(existsSync(path)).toBe(true);
  });

  it("does NOT reclaim an old lock whose owner is still ALIVE", async () => {
    // Age alone let two waiters both judge a lock stale, and the slower one
    // could then delete the FRESH lock the faster one had just taken — two
    // mutations in flight, the exact thing the lock prevents. A live owner's
    // lock must never read as stale, however old it looks.
    const path = panelLockPath();
    writeFileSync(path, JSON.stringify({ pid: process.pid })); // definitely alive
    const old = new Date(Date.now() - 60 * 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(path, old, old);
    await expect(
      withPanelMutationLock(async () => "should not run", { timeoutMs: 300 }),
    ).rejects.toThrow(/Timed out/);
    expect(existsSync(path)).toBe(true);
  });

  it("fails closed on an old unreadable lock", async () => {
    const path = panelLockPath();
    writeFileSync(path, "not json");
    const old = new Date(Date.now() - 60 * 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(path, old, old);
    await expect(
      withPanelMutationLock(async () => "recovered", { timeoutMs: 300 }),
    ).rejects.toThrow(/Timed out/);
    expect(existsSync(path)).toBe(true);
  });

  it("fails closed on an old lock without a valid pid", async () => {
    const path = panelLockPath();
    writeFileSync(path, JSON.stringify({ pid: "not-a-pid" }));
    const old = new Date(Date.now() - 60 * 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(path, old, old);
    await expect(
      withPanelMutationLock(async () => "should not run", { timeoutMs: 300 }),
    ).rejects.toThrow(/Timed out/);
    expect(existsSync(path)).toBe(true);
  });

  it("resolves with the action's OWN result, and only after its side effects finished", async () => {
    // Regression coverage for the review claim that the chaining let callers
    // resolve early (receiving undefined, racing the post-state). The caller
    // must get the guarded action's completion value — and any code running
    // after the returned promise resolves must observe the FINISHED
    // post-state, including a following lock acquisition.
    const order: string[] = [];
    const result = await withPanelMutationLock(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("side effect committed");
      return "the action result";
    });
    expect(result).toBe("the action result");
    expect(order).toEqual(["side effect committed"]);

    const observedByNextAcquisition = await withPanelMutationLock(async () =>
      order.slice(),
    );
    expect(observedByNextAcquisition).toEqual(["side effect committed"]);
  });

  it("the timeout error reports the OBSERVED lock state and names the unlock remedy (#760)", async () => {
    // The recurrence reports on #760 hit this blind: a 60s timeout with no lock
    // owner, no age, and no remedy short of hand-deleting an internal file. The
    // message must say what was actually observed and what to do about it.
    const path = panelLockPath();
    writeFileSync(
      path,
      JSON.stringify({ pid: 0x7fffffff, startedAt: "2026-08-02T10:06:42.831Z" }),
    );
    const old = new Date(Date.now() - 60 * 60_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(path, old, old);

    const err = await withPanelMutationLock(async () => "must not run", {
      timeoutMs: 300,
    }).catch((e: Error) => e);
    const message = (err as Error).message;
    expect(message).toContain(String(0x7fffffff));
    expect(message).toMatch(/no longer running/);
    expect(message).toContain("install_comfyui(action:'panel', panel_action:'unlock')");
    // The manual boundary stays as the fallback.
    expect(message).toMatch(
      /stop or restart every comfyui-mcp orchestrator.*delete this exact lock file/i,
    );
  });

  it("the timeout error says when the observed owner is STILL RUNNING", async () => {
    // The same message must not suggest reclaiming a live holder's lock.
    writeFileSync(panelLockPath(), JSON.stringify({ pid: process.pid }));
    const err = await withPanelMutationLock(async () => "must not run", {
      timeoutMs: 300,
    }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/STILL RUNNING/);
  });

  it("a failed lock init removes the just-created file instead of wedging every later op", async () => {
    // Codex gate: if the write/fsync/close after the exclusive create fails,
    // the husk would otherwise stay behind with THIS (live) process's pid —
    // every later acquire times out behind it, and reclaim rightly refuses a
    // live owner's lock. The init path must clean up after itself.
    fsyncTracker.failFsyncFor = "panel-op.lock";
    await expect(
      withPanelMutationLock(async () => "must not run", { timeoutMs: 300 }),
    ).rejects.toThrow(/Could not take the panel operation lock/);
    expect(existsSync(panelLockPath())).toBe(false);
    // And the very next operation acquires cleanly.
    await expect(
      withPanelMutationLock(async () => "recovered", { timeoutMs: 500 }),
    ).resolves.toBe("recovered");
  });

  it("a zero-byte short write fails the acquire (never spins, never leaves a husk)", async () => {
    // Codex gate round 6: writeSync reports bytes written; ignoring that, a
    // truncated lock record is fsync'd as if valid — and its unreadable owner
    // pid would wedge reclaim forever. A zero-progress write must fail the
    // init (and the init cleanup must remove the just-created file).
    fsyncTracker.zeroWriteFor = "panel-op.lock";
    try {
      await expect(
        withPanelMutationLock(async () => "must not run", { timeoutMs: 300 }),
      ).rejects.toThrow(/short write/);
      expect(existsSync(panelLockPath())).toBe(false);
    } finally {
      fsyncTracker.zeroWriteFor = undefined;
    }
    await expect(
      withPanelMutationLock(async () => "recovered", { timeoutMs: 500 }),
    ).resolves.toBe("recovered");
  });
});

describe("reclaimAbandonedPanelLock — the explicit recovery for a wedged lock (#760)", () => {
  // Comfortably not a live pid on any platform.
  const DEAD_PID = 0x7fffffff;

  async function plantLock(contents: string, ageMs = 0): Promise<string> {
    const path = panelLockPath();
    writeFileSync(path, contents);
    if (ageMs > 0) {
      const t = new Date(Date.now() - ageMs);
      const { utimesSync } = await import("node:fs");
      utimesSync(path, t, t);
    }
    return path;
  }

  it("reports no-lock when there is nothing to reclaim", () => {
    const res = reclaimAbandonedPanelLock();
    expect(res.outcome).toBe("no-lock");
    expect(res.detail).toMatch(/nothing to reclaim/i);
  });

  it("reclaims a lock that is BOTH old AND owned by a dead pid — and a new op proceeds", async () => {
    const path = await plantLock(
      JSON.stringify({ pid: DEAD_PID, startedAt: "2026-08-02T10:06:42.831Z" }),
      60 * 60_000,
    );
    const res = reclaimAbandonedPanelLock();
    expect(res.outcome).toBe("reclaimed");
    expect(res.detail).toContain(String(DEAD_PID));
    expect(existsSync(path)).toBe(false);
    // The point of the reclaim: the wedged acquire path works again at once.
    await expect(
      withPanelMutationLock(async () => "recovered", { timeoutMs: 500 }),
    ).resolves.toBe("recovered");
  });

  it("REFUSES an old lock whose recorded pid still exists, and leaves it in place", async () => {
    // Age alone is not abandonment: this is exactly the lock a slow-but-live
    // operation holds, and reclaiming it would run two mutations at once.
    //
    // The REFUSAL is unchanged; what changed is the reason it gives. This used to
    // assert "STILL RUNNING", which a bare `process.kill(pid, 0)` cannot support
    // for a lock this old — the pid may since have been reused. Refusing on an
    // honest "undetermined" protects the same live operation without making a
    // claim the evidence does not carry.
    const path = await plantLock(JSON.stringify({ pid: process.pid }), 60 * 60_000);
    const res = reclaimAbandonedPanelLock();
    expect(res.outcome).toBe("refused");
    expect(res.detail).toMatch(/cannot be determined/i);
    expect(existsSync(path)).toBe(true);
  });

  it("REFUSES a recent lock even when its recorded pid is dead", async () => {
    // A just-taken lock can be in the window before its writer committed the
    // pid record; youth means "cannot call it abandoned", not "abandoned".
    const path = await plantLock(JSON.stringify({ pid: DEAD_PID }));
    const res = reclaimAbandonedPanelLock();
    expect(res.outcome).toBe("refused");
    expect(res.detail).toMatch(/window/);
    expect(existsSync(path)).toBe(true);
  });

  it("REFUSES an old lock whose content is not valid JSON", async () => {
    // Unreadable content proves nothing about the owner — treating "we could
    // not tell" as "the owner is gone" is how a live holder's lock gets deleted.
    const path = await plantLock("not json", 60 * 60_000);
    const res = reclaimAbandonedPanelLock();
    expect(res.outcome).toBe("refused");
    expect(res.detail).toMatch(/not valid JSON/);
    expect(existsSync(path)).toBe(true);
  });

  it("REFUSES an old EMPTY lock (a crash mid-write) rather than guessing", async () => {
    const path = await plantLock("", 60 * 60_000);
    const res = reclaimAbandonedPanelLock();
    expect(res.outcome).toBe("refused");
    expect(existsSync(path)).toBe(true);
  });

  it("REFUSES an old lock whose record has no valid pid", async () => {
    const path = await plantLock(JSON.stringify({ pid: "not-a-pid" }), 60 * 60_000);
    const res = reclaimAbandonedPanelLock();
    expect(res.outcome).toBe("refused");
    expect(res.detail).toMatch(/no valid owner pid/);
    expect(existsSync(path)).toBe(true);
  });

  it("never deletes a lock that was REPLACED between the observation and the reclaim", async () => {
    // The race the byte-compare exists for: the abandoned lock is observed,
    // then a DIFFERENT holder's lock lands at the path before the rename
    // moves it aside. What is moved aside no longer matches the observed
    // bytes, so it must be put back — never deleted.
    const path = await plantLock(JSON.stringify({ pid: DEAD_PID }), 60 * 60_000);
    const freshLock = JSON.stringify({ pid: process.pid, startedAt: "fresh" });
    fsyncTracker.onBeforeRename = (from) => {
      if (from !== path) return; // only the lock-aside rename, not temp renames
      // Replace the path's content with a fresh holder's lock, then let the
      // real rename move THAT aside.
      writeFileSync(path, freshLock);
    };
    try {
      const res = reclaimAbandonedPanelLock();
      expect(res.outcome).toBe("refused");
      expect(res.detail).toMatch(/DIFFERENT holder/);
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(path, "utf-8")).toBe(freshLock);
    } finally {
      fsyncTracker.onBeforeRename = undefined;
    }
  });

  it("the restore never OVERWRITES a fresh lock that lands in the restore gap", async () => {
    // Codex gate finding: a rename-based restore silently REPLACES an existing
    // destination, so a fresh lock created between the aside and the restore
    // would be destroyed. The link-based restore must fail EEXIST instead and
    // leave BOTH files in place, reported.
    const path = await plantLock(JSON.stringify({ pid: DEAD_PID }), 60 * 60_000);
    const replaced = JSON.stringify({ pid: 0x7ffffffe, startedAt: "replaced" });
    const freshest = JSON.stringify({ pid: process.pid, startedAt: "freshest" });
    fsyncTracker.onBeforeRename = (from) => {
      if (from === path) writeFileSync(path, replaced); // force the byte mismatch
    };
    fsyncTracker.onBeforeLink = (_from, to) => {
      if (to === path) writeFileSync(path, freshest); // a fresh lock in the gap
    };
    try {
      const res = reclaimAbandonedPanelLock();
      expect(res.outcome).toBe("refused");
      expect(res.detail).toMatch(/preserved at/);
      const { readFileSync, readdirSync } = await import("node:fs");
      // The fresh lock at the path is untouched...
      expect(readFileSync(path, "utf-8")).toBe(freshest);
      // ...and the replaced lock is preserved at the claim path, not deleted.
      const claim = readdirSync(dirname(path)).find((f) => f.includes("reclaim-"));
      expect(claim).toBeDefined();
      expect(readFileSync(join(dirname(path), claim!), "utf-8")).toBe(replaced);
    } finally {
      fsyncTracker.onBeforeRename = undefined;
      fsyncTracker.onBeforeLink = undefined;
    }
  });

  it("an observation made on a REPLACED fresh lock reads the fresh age, never the stale one", async () => {
    // Codex gate round 3: with a path-based stat then a path-based read, a lock
    // replaced between them pairs the STALE lock's mtime with the FRESH lock's
    // pid, and a young lock gets reclaimed. The observation is descriptor-
    // pinned, so the age and the owner bytes always come from one instance.
    const path = await plantLock(JSON.stringify({ pid: DEAD_PID }), 60 * 60_000);
    const fresh = JSON.stringify({ pid: DEAD_PID - 1, startedAt: "fresh" });
    fsyncTracker.onBeforeOpen = (p, flags) => {
      if (p === path && flags === "r") {
        // Replace the stale lock with a fresh one just before observation.
        rmSync(path, { force: true });
        writeFileSync(path, fresh);
      }
    };
    try {
      const res = reclaimAbandonedPanelLock();
      expect(res.outcome).toBe("refused");
      expect(res.detail).toMatch(/window/); // the age gate, with the FRESH age
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(path, "utf-8")).toBe(fresh);
    } finally {
      fsyncTracker.onBeforeOpen = undefined;
    }
  });

  it("an unopenable lock is REFUSED, never reported as absent (codex gate)", async () => {    // Only ENOENT proves absence. A present-but-unopenable lock (permissions,
    // AV interference) must not read as "nothing to reclaim" — it is still
    // blocking every panel operation.
    const path = await plantLock(JSON.stringify({ pid: DEAD_PID }), 60 * 60_000);
    fsyncTracker.failOpenFor = path;
    try {
      const res = reclaimAbandonedPanelLock();
      expect(res.outcome).toBe("refused");
      expect(res.detail).toMatch(/could not be opened/);
      expect(res.detail).not.toMatch(/nothing to reclaim/i);
    } finally {
      fsyncTracker.failOpenFor = undefined;
    }
    expect(existsSync(path)).toBe(true);
  });

  it("a reclaim whose aside-copy cleanup fails still reports the reclaim honestly (codex gate)", async () => {
    // The lock path is already free once the verified stale lock is moved
    // aside, so an AV/EPERM failure removing the aside copy is a CLEANUP
    // issue — the reclaim must still report success and name the leftover,
    // never throw a generic failure for work that succeeded.
    const path = await plantLock(JSON.stringify({ pid: DEAD_PID }), 60 * 60_000);
    fsyncTracker.failRmFor = ".reclaim-";
    try {
      const res = reclaimAbandonedPanelLock();
      expect(res.outcome).toBe("reclaimed");
      expect(res.detail).toMatch(/blocks nothing/);
      expect(res.detail).toMatch(/reclaim-/);
      expect(existsSync(path)).toBe(false);
    } finally {
      fsyncTracker.failRmFor = undefined;
    }
  });

  it("never leaves a stray claim file behind after a successful reclaim", async () => {
    const path = await plantLock(JSON.stringify({ pid: DEAD_PID }), 60 * 60_000);
    const res = reclaimAbandonedPanelLock();
    expect(res.outcome).toBe("reclaimed");
    const { readdirSync } = await import("node:fs");
    const leftovers = readdirSync(dirname(path)).filter((f) => f.includes("reclaim"));
    expect(leftovers).toEqual([]);
  });
});

describe("durable writes (#798) — records that must not outlive the action they describe", () => {
  beforeEach(() => {
    fsyncTracker.paths.length = 0;
  });

  it("recordPanelPendingOp fsyncs the marker's own bytes before the Manager handoff", () => {
    recordPanelPendingOp("update-all", "a queued update-all may still move the panel", 60_000);
    // The atomic write fsyncs the temp file the marker is renamed from.
    expect(fsyncTracker.paths.some((p) => p.includes("panel-pending-ops.json"))).toBe(true);
  });

  it("the panel op lock write is fsync'd — its pid record is what proves abandonment", async () => {
    await withPanelMutationLock(async () => undefined);
    expect(fsyncTracker.paths.some((p) => p.includes("panel-op.lock"))).toBe(true);
  });

  it("a pin write is fsync'd — a protection record must not be lost after being reported", () => {
    setPanelVersionPin("0.11.20");
    expect(fsyncTracker.paths.some((p) => p.includes("panel-settings.json"))).toBe(true);
  });

  it("a directory fsync failure that is NOT 'unsupported' fails the write (codex gate)", () => {
    // EIO-style failures must not be swallowed like the Windows EPERM: the
    // rename's directory entry is then not proven durable, and reporting the
    // marker as written would be a false durable-success.
    fsyncTracker.failFsyncExact = { path: dirname(panelPendingOpsPath()) };
    expect(() =>
      recordPanelPendingOp("update-all", "doomed marker", 60_000),
    ).toThrow(/Could not persist the pending update-all marker/);
    // The record itself LANDED (temp fsync + atomic rename succeeded before the
    // directory sync failed) — but the refusal means the guarded operation will
    // never run, so the landed record is rolled back (id-matched): leaving it
    // would warn every later pin about a phantom pending op.
    expect(activePanelPendingOps()).toEqual([]);
    // And no torn temp file remains from either write.
    const leftovers = readdirSync(dirname(panelPendingOpsPath())).filter((f) =>
      f.includes(".tmp-"),
    );
    expect(leftovers).toEqual([]);
  });

  it("a failed POST-HANDOFF enrichment keeps the landed marker (codex gate round 5)", () => {
    // update-all records the marker BEFORE the Manager handoff, then RE-RECORDS
    // it enriched with base/uiId after the queue accepts. A failure of that
    // second write must NOT roll back: the operation is already pending out of
    // band, and deleting its record is how a later pin claims clean protection
    // over a live window.
    recordPanelPendingOp("update-all", "first", 60_000);
    fsyncTracker.failFsyncExact = { path: dirname(panelPendingOpsPath()) };
    expect(() =>
      recordPanelPendingOp("update-all", "enriched", 60_000, {
        base: "http://orig:8188",
        keepRecordOnFailure: true,
      }),
    ).toThrow(/Could not persist the pending update-all marker/);
    // The enrich write landed (temp fsync + rename) before the directory sync
    // failed, and it survives: the marker still describes the live operation.
    const active = activePanelPendingOps();
    expect(active).toHaveLength(1);
    expect(active[0].detail).toBe("enriched");
    expect(active[0].base).toBe("http://orig:8188");
  });

  it("a failed re-record restores the REPLACED predecessor, not an empty file (codex gate round 7)", () => {
    // update-all A is already with the Manager (its marker landed). A second
    // update-all B records its marker BEFORE its own handoff, replacing A's
    // same-kind record — and that write fails after landing. B never starts,
    // but A is still pending: the rollback must bring A's record back, not
    // leave the file empty (a later pin would claim clean protection over A's
    // live window) nor keep B (a phantom).
    const first = recordPanelPendingOp("update-all", "first", 60_000);
    fsyncTracker.failFsyncExact = { path: dirname(panelPendingOpsPath()) };
    expect(() => recordPanelPendingOp("update-all", "second", 60_000)).toThrow(
      /Could not persist the pending update-all marker/,
    );
    const active = activePanelPendingOps();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(first.id);
    expect(active[0].detail).toBe("first");
  });

  it("a platform that cannot fsync directories at all (EPERM, e.g. Windows) still completes the write", () => {
    fsyncTracker.failFsyncExact = { path: dirname(panelPendingOpsPath()), code: "EPERM" };
    const op = recordPanelPendingOp("update-all", "tolerated dir fsync", 60_000);
    expect(activePanelPendingOps().map((o) => o.id)).toEqual([op.id]);
  });
});

describe("assertPanelNotTargetedUnverifiable — paths that cannot verify", () => {
  it("refuses a panel target even when NOTHING is pinned", async () => {
    // panel_install_node / panel_update_node / the fix action report success
    // straight off the Manager queue, which a stale Manager drains without doing
    // any work. There is no verified redirect for them, so they refuse and name
    // install_comfyui(action:'panel') rather than move the panel unverifiably.
    const { assertPanelNotTargetedUnverifiable } = await import(
      "../../services/panel-pin-guard.js"
    );
    expect(() =>
      assertPanelNotTargetedUnverifiable("panel_update_node", "comfyui-agent-panel"),
    ).toThrow(/install_comfyui\(action:'panel'/);
    expect(() =>
      assertPanelNotTargetedUnverifiable(
        "panel_install_node",
        "https://github.com/artokun/comfyui-mcp-panel.git@v1",
      ),
    ).toThrow(/install_comfyui\(action:'panel'/);
  });

  it("reports the PIN first when one is set (the more specific reason)", async () => {
    const { assertPanelNotTargetedUnverifiable } = await import(
      "../../services/panel-pin-guard.js"
    );
    setPanelVersionPin("0.11.3");
    expect(() =>
      assertPanelNotTargetedUnverifiable("panel_update_node", "comfyui-agent-panel"),
    ).toThrow(/pinned to 0\.11\.3/i);
  });

  it("leaves unrelated packs and absent ids alone", async () => {
    const { assertPanelNotTargetedUnverifiable } = await import(
      "../../services/panel-pin-guard.js"
    );
    expect(() =>
      assertPanelNotTargetedUnverifiable("panel_update_node", "ComfyUI-WanVideoWrapper"),
    ).not.toThrow();
    expect(() =>
      assertPanelNotTargetedUnverifiable("panel_install_node", undefined),
    ).not.toThrow();
  });
});

describe("pending-op markers — record, read, and clear (#689)", () => {
  it("round-trips the optional base/uiId capture fields", () => {
    const op = recordPanelPendingOp("update-all", "test marker", 60_000, {
      base: "http://orig:8188",
      uiId: "ui-123",
    });
    const active = activePanelPendingOps();
    expect(active).toHaveLength(1);
    expect(active[0].base).toBe("http://orig:8188");
    expect(active[0].uiId).toBe("ui-123");
    expect(active[0].queuedAt).toBe(op.queuedAt);
  });

  it("markers without the optional fields still read fine (older shape)", () => {
    recordPanelPendingOp("update-all", "bare marker", 60_000);
    const active = activePanelPendingOps();
    expect(active).toHaveLength(1);
    expect(active[0].base).toBeUndefined();
    expect(active[0].uiId).toBeUndefined();
  });

  it("clearPanelPendingOp removes ONLY the exact record handed in", () => {
    const first = recordPanelPendingOp("update-all", "first", 60_000);
    // A newer marker of the same kind REPLACES the old one on record...
    const second = recordPanelPendingOp("update-all", "second", 60_000);
    expect(activePanelPendingOps().map((o) => o.detail)).toEqual(["second"]);

    // ...so clearing the STALE one is a no-op that must not touch the new one.
    expect(clearPanelPendingOp(first)).toBe(true);
    expect(activePanelPendingOps().map((o) => o.detail)).toEqual(["second"]);

    // Clearing the live one removes exactly it.
    expect(clearPanelPendingOp(second)).toBe(true);
    expect(activePanelPendingOps()).toEqual([]);
  });

  it("clearPanelPendingOp leaves other kinds alone", () => {
    const update = recordPanelPendingOp("update-all", "u", 60_000);
    recordPanelPendingOp("snapshot-restore", "s", 60_000);
    expect(clearPanelPendingOp(update)).toBe(true);
    expect(activePanelPendingOps().map((o) => o.kind)).toEqual(["snapshot-restore"]);
  });

  it("clearPanelPendingOp fails CLOSED on an unreadable marker file", () => {
    const op = recordPanelPendingOp("update-all", "u", 60_000);
    writeFileSync(panelPendingOpsPath(), "{ not json"); // corrupt it afterwards
    expect(clearPanelPendingOp(op)).toBe(false);
    // ...and the unreadable record still reads as a (synthetic) pending op.
    expect(activePanelPendingOps()).toHaveLength(1);
    expect(activePanelPendingOps()[0].kind).toBe("unknown");
  });

  it("a clear whose write landed before a directory-sync failure reports the OBSERVED state (codex gate)", () => {
    // The clear's atomic rename lands before the directory sync fails, so the
    // record IS gone. Reporting it as surviving (the old catch-all false)
    // would attach a phantom "still pending" warning to the pin result.
    const op = recordPanelPendingOp("update-all", "u", 60_000);
    fsyncTracker.failFsyncExact = { path: dirname(panelPendingOpsPath()) };
    expect(clearPanelPendingOp(op)).toBe(true);
    expect(activePanelPendingOps()).toEqual([]);
  });

  it("a ZERO-BYTE marker file unwedges recording WITHOUT silently dropping the warning (#798 + #847)", () => {
    // Two branches reached this case from opposite ends and `main` settled it.
    //
    // #798 argued a 0-byte file provably holds NO record, so reading it as
    // "unreadable" refuses every later update-all and warns on every pin forever,
    // with no recovery path. True — that wedge was real.
    //
    // #847 then observed the other half: an INTERRUPTED write cannot be told from
    // a file that never got content, so treating it as a clean empty read drops a
    // warning that may have described a genuinely queued operation.
    //
    // Both are right, and they are not in tension. The reconciled contract lifts
    // the block but keeps the doubt: recording works again, and an explicit
    // indeterminate record is carried forward so a later pin still warns.
    writeFileSync(panelPendingOpsPath(), "");

    // The wedge is gone — this is what #798 was for.
    const op = recordPanelPendingOp("update-all", "after the torn write", 60_000);
    const ids = activePanelPendingOps().map((o) => o.id);
    expect(ids).toContain(op.id);

    // …and the doubt survives — this is what #847 was for. Asserting `[]` here,
    // as the original did, is exactly the silent drop.
    const carried = activePanelPendingOps().filter((o) => o.kind === "unknown");
    expect(carried).toHaveLength(1);
    expect(carried[0].detail).toMatch(/EMPTY pending-operation marker/i);
    expect(carried[0].detail).toMatch(/may still be outstanding/i);
  });

  it("the marker write is atomic — no temp file is left behind (#798)", () => {
    recordPanelPendingOp("update-all", "u", 60_000);
    const leftovers = readdirSync(dirname(panelPendingOpsPath())).filter((f) =>
      f.includes(".tmp-"),
    );
    expect(leftovers).toEqual([]);
  });
});

describe("#847 — a zero-byte pending-ops file must not wedge update-all forever", () => {
  const pendingPath = () => process.env.COMFYUI_MCP_PANEL_PENDING as string;

  it("records a new op over an EMPTY marker instead of refusing forever", () => {
    // The wedge: recordPanelPendingOp threw on any unreadable prior, and it runs
    // BEFORE the Manager handoff — so the only thing that could replace the bad
    // file was the very operation the bad file blocked. update-all could never
    // start again until a human deleted the file by hand.
    writeFileSync(pendingPath(), "", "utf-8");

    const op = recordPanelPendingOp("update-all", "after an empty marker", 60_000);

    expect(op, "an empty marker records no operation, so it is safe to supersede").toBeTruthy();
    expect(op?.kind).toBe("update-all");
    // And it really landed — recordPanelPendingOp read-back verifies, but assert
    // the observable outcome too, since that is what unwedges the next run.
    expect(activePanelPendingOps().some((o) => o.kind === "update-all")).toBe(true);
  });

  it("treats a WHITESPACE-ONLY marker the same as empty", () => {
    writeFileSync(pendingPath(), "  \n\t \n", "utf-8");
    expect(recordPanelPendingOp("update-all", "after whitespace", 60_000)).toBeTruthy();
  });

  it("STILL refuses when the marker has content it cannot decode", () => {
    // The safety property the original refusal existed for, and it must survive:
    // content we cannot decode may describe a real queued operation, and
    // overwriting it destroys a warning we were never able to read.
    writeFileSync(pendingPath(), '{"ops":[{"kind":"update-all","queuedAt":', "utf-8");

    expect(() => recordPanelPendingOp("update-all", "over undecodable content", 60_000)).toThrow(
      /could not be decoded/,
    );
  });

  it("names the file path in the refusal, so it is actionable", () => {
    // Plain substring, deliberately: building a RegExp from a Windows path means
    // escaping backslashes, and an escape written through a shell heredoc is
    // exactly how this repo has produced literal control bytes and broken
    // character classes before. A `toThrow(string)` does a substring match and
    // needs no escaping at all.
    writeFileSync(pendingPath(), "not json at all", "utf-8");
    let message = "";
    try {
      recordPanelPendingOp("update-all", "x", 60_000);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(pendingPath());
    expect(message).toContain("delete it to clear this");
  });

  it("an EMPTY marker still WARNS — it cannot prove nothing is pending", () => {
    // Deliberately still conservative on the READ question. An interrupted write
    // is indistinguishable from a file that never got content, so claiming
    // nothing is pending would be the fabrication. Only the WRITE question
    // changed, because that one asks whether overwriting loses information.
    writeFileSync(pendingPath(), "", "utf-8");

    const active = activePanelPendingOps();
    expect(active).toHaveLength(1);
    expect(active[0].kind).toBe("unknown");
    // The detail must say it self-clears — that is the half that made this a dead
    // end. Asserting the REASON, not merely that a warning exists.
    expect(active[0].detail).toMatch(/EMPTY/);
    expect(active[0].detail).toMatch(/clears on its own|replaces it/);
  });

  it("an UNDECODABLE marker warns differently — it does NOT self-clear", () => {
    writeFileSync(pendingPath(), "not json at all", "utf-8");

    const active = activePanelPendingOps();
    expect(active).toHaveLength(1);
    expect(active[0].detail).toMatch(/NOT replaced automatically/);
    // The two branches must not give the same advice: one clears itself, the
    // other needs a human decision, and telling a user the wrong one wastes the
    // trip either way.
    expect(active[0].detail).not.toMatch(/clears on its own/);
  });
});

describe("#847 gate P0 — superseding an empty marker must not hide a queued op", () => {
  const pendingPath = () => process.env.COMFYUI_MCP_PANEL_PENDING as string;

  it("carries an indeterminate record forward when it supersedes an EMPTY marker", () => {
    // The independent gate found the hole in my first cut: writeFileSync
    // TRUNCATES, so a crash after truncation and before content leaves a
    // zero-byte file that DID hold a real op. Superseding it silently dropped
    // that warning. The block is lifted; the warning must survive it.
    writeFileSync(pendingPath(), "", "utf-8");

    recordPanelPendingOp("update-all", "after an empty marker", 60_000);

    const active = activePanelPendingOps();
    expect(active.some((o) => o.kind === "update-all")).toBe(true);
    const carried = active.find((o) => o.kind === "unknown");
    expect(carried, "an indeterminate record must be carried forward").toBeDefined();
    expect(carried?.detail).toMatch(/EMPTY pending-operation marker/);
    expect(carried?.detail).toMatch(/may still be outstanding/);
  });

  it("does NOT invent an indeterminate record when the prior marker was absent", () => {
    // Discrimination: the carry-forward must be tied to the empty case, not
    // emitted on every write. An absent file is genuinely proof of nothing
    // pending, and warning there would be the fold pointed the other way.
    expect(existsSync(pendingPath())).toBe(false);

    recordPanelPendingOp("update-all", "clean start", 60_000);

    const active = activePanelPendingOps();
    expect(active.some((o) => o.kind === "update-all")).toBe(true);
    expect(active.some((o) => o.kind === "unknown")).toBe(false);
  });

  it("writes atomically — no zero-byte window, and no staging file left behind", () => {
    recordPanelPendingOp("update-all", "atomic", 60_000);

    // A truncating writer can be observed mid-write as zero bytes; a rename
    // cannot. The observable proxy for "the temp path was cleaned up" is that
    // nothing but the marker remains in the directory.
    const dirEntries = readdirSync(dirname(pendingPath()));
    expect(dirEntries.filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(readFileSync(pendingPath(), "utf-8").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Once a lock can be TAKEN AWAY, every other operation on it has to prove it
// still owns what it is about to touch. Reclaiming is the right fix for #760;
// these are the failures reclaiming creates.

describe("#836 — a reclaimable lock needs ownership proofs everywhere", () => {
  /** Same helper as the reclaim suite above, which scopes it to its own block. */
  async function plantLock(contents: string, ageMs = 0): Promise<string> {
    const path = panelLockPath();
    writeFileSync(path, contents);
    if (ageMs > 0) {
      const t = new Date(Date.now() - ageMs);
      const { utimesSync } = await import("node:fs");
      utimesSync(path, t, t);
    }
    return path;
  }

  it("the release does NOT delete a lock that replaced ours while we ran", async () => {
    // The sequence the gate walked: our lock is reclaimed mid-operation and a
    // DIFFERENT process takes the freed path. A bare `rmSync(path)` on release
    // then deletes THEIR lock — leaving the door open with a writer inside. That
    // is strictly worse than the stuck lock this PR set out to fix.
    let released: (() => void) | undefined;
    const path = panelLockPath();
    await withPanelMutationLock(async () => {
      // Someone reclaims ours and takes the path. Same shape as a reclaim
      // followed by a fresh acquire.
      writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: "theirs", token: "THEIRS" }));
    });
    // The successor's lock must still be there.
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8")).token).toBe("THEIRS");
    void released;
  });

  it("a lock that lands in the release GAP is restored, not deleted", async () => {
    // The decisive interleaving, which the sibling test does not reach: there the
    // replacement is written BEFORE release begins, so even a plain
    // read-then-check would catch it. Here it lands in the release itself — the
    // window that makes read-then-unlink insufficient, because a reclaimer can
    // move the verified file aside and a third agent can take the freed pathname
    // before the unlink.
    //
    // The hook fires as the release is about to take the path aside, so what it
    // actually moves is the INTRUDER's lock — precisely the "this is not mine"
    // case. It must go back, not into the bin.
    const path = panelLockPath();
    const intruder = JSON.stringify({ pid: process.pid, startedAt: "gap", token: "INTRUDER" });
    fsyncTracker.onBeforeRename = (from) => {
      if (from === path) writeFileSync(path, intruder);
    };
    try {
      await withPanelMutationLock(async () => {
        /* the guarded work is irrelevant; the release is the subject */
      });
      // Restored intact. A bare rmSync — or a read-then-unlink that lost the race
      // — would have removed a lock its owner still believes it holds.
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf-8")).token).toBe("INTRUDER");
    } finally {
      fsyncTracker.onBeforeRename = undefined;
      rmSync(path, { force: true });
    }
  });

  it("the release DOES delete its own lock — the ownership check must not leak locks", async () => {
    // The other direction: an ownership check that never matches would leave a
    // lock behind after every operation and wedge the next one. This is what
    // stops the fix above from becoming the bug it replaced.
    const path = panelLockPath();
    await withPanelMutationLock(async () => {
      expect(existsSync(path)).toBe(true); // held during the operation
    });
    expect(existsSync(path)).toBe(false); // and cleaned up after
  });

  it("a failed ROLLBACK is disclosed, not swallowed behind a clean-looking refusal", async () => {
    // A catch that can throw is not a guard. The rollback runs INSIDE the failure
    // path, so its own failure had nowhere to go: it was swallowed, and the
    // refusal read as though the disk were clean. What actually remained was a
    // phantom marker a later pin reads as a real queued operation.
    //
    // The record must precede the Manager handoff, so no ordering removes this
    // window — what can be made reliable is SAYING so.
    recordPanelPendingOp("update-all", "first", 60_000);
    const pendingPath = panelPendingOpsPath();
    let renames = 0;
    fsyncTracker.failFsyncExact = { path: dirname(pendingPath) };
    fsyncTracker.onBeforeRename = (_from, to) => {
      // Let our own write land, then fail the ROLLBACK's rename.
      if (to === pendingPath && ++renames >= 2) {
        throw Object.assign(new Error("rollback rename refused"), { code: "EIO" });
      }
    };
    try {
      let message = "";
      try {
        recordPanelPendingOp("update-all", "second", 60_000);
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toMatch(/Could not persist the pending update-all marker/);
      // The disclosure the swallow used to hide.
      expect(message).toMatch(/rolling it back ALSO failed/i);
      expect(message).toMatch(/may remain at/i);
      expect(message).toMatch(/an operation that never started/i);
    } finally {
      fsyncTracker.onBeforeRename = undefined;
      fsyncTracker.failFsyncExact = undefined;
    }
  });

  it("does NOT cry phantom when the rollback ALREADY restored before it failed", async () => {
    // `writeFileDurable` renames before it fsyncs the directory, so a throw from
    // that last step can mean the rollback has ALREADY put the prior records back.
    // Warning on the exception alone produced a false alarm — and with a real
    // same-kind predecessor restored, the "delete that record" advice pointed at
    // someone's LIVE record (codex gate). The disk is what settles it.
    const first = recordPanelPendingOp("update-all", "first", 60_000);
    const dir = dirname(panelPendingOpsPath());
    // `failFsyncExact` is ONE-SHOT, so arming it once only fails our own write and
    // lets the rollback succeed — which passes this assertion without ever
    // reaching the guard it is about. Re-arm it for the ROLLBACK's write, so the
    // rollback ALSO throws, and does so AFTER its rename has already restored the
    // predecessor. That is the exact shape the false alarm came from.
    let renames = 0;
    fsyncTracker.failFsyncExact = { path: dir };
    fsyncTracker.onBeforeRename = (_from, to) => {
      if (to === panelPendingOpsPath() && ++renames >= 2) {
        fsyncTracker.failFsyncExact = { path: dir };
      }
    };
    try {
      let message = "";
      try {
        recordPanelPendingOp("update-all", "second", 60_000);
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toMatch(/Could not persist the pending update-all marker/);
      // The predecessor really is back...
      const active = activePanelPendingOps();
      expect(active.map((o) => o.id)).toEqual([first.id]);
      // ...so there is no phantom, and the refusal must not claim one.
      expect(message).not.toMatch(/may remain at/i);
      expect(message).not.toMatch(/ALSO failed/i);
    } finally {
      fsyncTracker.failFsyncExact = undefined;
      fsyncTracker.onBeforeRename = undefined;
    }
  });

  it("an OLD lock whose pid exists is reported as UNDETERMINED, not 'STILL RUNNING'", async () => {
    // PID recycling. `process.kill(pid, 0)` says a process with that NUMBER
    // exists; after a crashed holder's number is reused that is not our holder.
    // Asserting "STILL RUNNING" refused the reclaim forever — #760's wedge
    // surviving its own fix.
    const path = await plantLock(
      JSON.stringify({ pid: process.pid, startedAt: "long ago" }),
      7 * 24 * 60 * 60_000, // a week old: no panel operation runs this long
    );
    const res = reclaimAbandonedPanelLock();

    expect(res.outcome).toBe("refused");
    expect(res.detail).toMatch(/may have been REUSED/i);
    expect(res.detail).toMatch(/cannot be determined/i);
    // The false certainty, gone — and with it the dead end it created.
    expect(res.detail).not.toMatch(/STILL RUNNING/);
    expect(res.detail).toMatch(/delete .* by hand/i);
    // Nothing was deleted: refusing is still right, only the reason changed.
    expect(existsSync(path)).toBe(true);
  });

  it("a lock INSIDE the stale window is refused on AGE, before liveness is consulted at all", async () => {
    // The inverse direction, corrected. An earlier draft of this test asserted
    // "STILL RUNNING" for a 45-minute-old lock — but the reuse doubt is bounded by
    // STALE_LOCK_MS (10 minutes), the same line the age check draws, so 45 minutes
    // is already past it. There is no age at which the reclaim path both consults
    // liveness AND can trust the pid, which is why that branch was removed rather
    // than left as unreachable code that reads like a guarantee.
    //
    // What this pins is that a young lock never gets there: it is refused for
    // being young, which is a fact about the lock and not a guess about a pid.
    await plantLock(JSON.stringify({ pid: process.pid, startedAt: "recent" }), 60_000);
    const res = reclaimAbandonedPanelLock();
    expect(res.outcome).toBe("refused");
    expect(res.detail).toMatch(/inside the/i);
    expect(res.detail).not.toMatch(/STILL RUNNING/);
    expect(res.detail).not.toMatch(/cannot be determined/i);
  });
});
