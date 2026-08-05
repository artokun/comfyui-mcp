// The pin guard at the point the PANEL PACK IS IDENTIFIED AS THE TARGET.
//
// The bug these tests exist for: the pin was originally enforced only inside
// `runPanelAction`, which was described as "the mutation choke point". It wasn't
// — the panel is an ordinary custom node pack, so `update_custom_node(id=...)`
// and `id="all"` reached the SAME ComfyUI-Manager mutation without ever passing
// the guard. A pinned user was one generic call away from being moved.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  activePanelPendingOps,
  assertPanelPinAllows,
  clearPanelPendingOp,
  PanelPinnedError,
  panelLockPath,
  panelPendingOpsPath,
  recordPanelPendingOp,
  targetsPanelPack,
  targetsPanelPackExactly,
  withPanelMutationLock,
} from "../../services/panel-pin-guard.js";
import { setPanelVersionPin, PANEL_PIN_ENV_VAR } from "../../services/panel-settings.js";

let dir: string;

beforeEach(() => {
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
});

describe("assertPanelNotTargetedUnverifiable — paths that cannot verify", () => {
  it("refuses a panel target even when NOTHING is pinned", async () => {
    // panel_install_node / panel_update_node / fix_custom_node report success
    // straight off the Manager queue, which a stale Manager drains without doing
    // any work. There is no verified redirect for them, so they refuse and name
    // install_panel rather than move the panel unverifiably.
    const { assertPanelNotTargetedUnverifiable } = await import(
      "../../services/panel-pin-guard.js"
    );
    expect(() =>
      assertPanelNotTargetedUnverifiable("panel_update_node", "comfyui-agent-panel"),
    ).toThrow(/install_panel/);
    expect(() =>
      assertPanelNotTargetedUnverifiable(
        "panel_install_node",
        "https://github.com/artokun/comfyui-mcp-panel.git@v1",
      ),
    ).toThrow(/install_panel/);
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
});

describe("#847 — a zero-byte pending-ops file must not wedge update_all forever", () => {
  const pendingPath = () => process.env.COMFYUI_MCP_PANEL_PENDING as string;

  it("records a new op over an EMPTY marker instead of refusing forever", () => {
    // The wedge: recordPanelPendingOp threw on any unreadable prior, and it runs
    // BEFORE the Manager handoff — so the only thing that could replace the bad
    // file was the very operation the bad file blocked. update_all could never
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
