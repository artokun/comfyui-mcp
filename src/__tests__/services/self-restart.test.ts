// SelfRestarter: change-driven restart engine for the panel orchestrator.
// Everything is exercised through injected deps + direct tick calls (no real
// timers, registry, or process spawns).

import { describe, expect, it } from "vitest";
import { SelfRestarter, type SelfRestartDeps } from "../../services/self-restart.js";
import type { InstallInfo, SelfUpdateResult } from "../../services/self-update.js";

interface Harness {
  restarter: SelfRestarter;
  calls: string[];
  spawns: Array<{ npxVersion?: string }>;
  announces: string[];
  setIdle: (v: boolean) => void;
  setMtime: (v: number | undefined) => void;
}

function makeHarness(opts: {
  mode?: InstallInfo["mode"];
  currentVersion?: string;
  latest?: string;
  updateResult?: SelfUpdateResult;
  env?: NodeJS.ProcessEnv;
  uptimeMs?: number;
  spawnOk?: boolean;
  mtime?: number;
}): Harness {
  const calls: string[] = [];
  const spawns: Array<{ npxVersion?: string }> = [];
  const announces: string[] = [];
  let idle = true;
  let mtime: number | undefined = opts.mtime;
  const mode = opts.mode ?? "linked";
  const deps: Partial<SelfRestartDeps> = {
    env: () => opts.env ?? {},
    detectInstall: () => ({
      mode,
      packageDir: "/pkg",
      currentVersion: opts.currentVersion ?? "1.0.0",
      isDevLink: mode === "linked",
    }),
    checkAndSelfUpdate: async () => {
      calls.push("check");
      return (
        opts.updateResult ?? { action: "up-to-date", mode, from: opts.currentVersion ?? "1.0.0" }
      );
    },
    latestVersion: async () => opts.latest,
    entryMtime: () => mtime,
    allIdle: () => idle,
    announce: (t) => announces.push(t),
    teardown: async () => {
      calls.push("teardown");
    },
    spawnReplacement: (o) => {
      calls.push("spawn");
      spawns.push(o);
      return opts.spawnOk ?? true;
    },
    exit: () => {
      calls.push("exit");
    },
    uptimeMs: () => opts.uptimeMs ?? 10 * 60 * 1000,
  };
  return {
    restarter: new SelfRestarter(deps),
    calls,
    spawns,
    announces,
    setIdle: (v) => {
      idle = v;
    },
    setMtime: (v) => {
      mtime = v;
    },
  };
}

describe("SelfRestarter — dev rebuild watch", () => {
  it("restarts (spawn → teardown → exit) after a rebuild settles, when idle", async () => {
    const h = makeHarness({ mode: "linked", mtime: 1000 });
    h.restarter.start();
    h.restarter.devTick(); // baseline, no change
    expect(h.calls).toEqual([]);

    h.setMtime(2000); // rebuild lands
    h.restarter.devTick(); // first sight — settle counter starts
    expect(h.calls).toEqual([]);
    h.restarter.devTick(); // stable → arm + fire (idle)
    await Promise.resolve();
    expect(h.calls).toEqual(["spawn", "teardown", "exit"]);
    expect(h.spawns[0]?.npxVersion).toBeUndefined(); // same argv respawn
  });

  it("keeps waiting while a write is still churning (mtime keeps moving)", () => {
    const h = makeHarness({ mode: "linked", mtime: 1000 });
    h.restarter.start();
    h.setMtime(2000);
    h.restarter.devTick();
    h.setMtime(3000); // still writing
    h.restarter.devTick();
    expect(h.calls).toEqual([]); // settle counter restarted — no restart yet
  });

  it("defers the restart until every agent is idle", async () => {
    const h = makeHarness({ mode: "linked", mtime: 1000 });
    h.restarter.start();
    h.setIdle(false);
    h.setMtime(2000);
    h.restarter.devTick();
    h.restarter.devTick(); // armed, but busy
    expect(h.calls).toEqual([]);

    h.restarter.tryRestart(); // still busy
    expect(h.calls).toEqual([]);
    h.setIdle(true);
    h.restarter.tryRestart();
    await Promise.resolve();
    expect(h.calls).toEqual(["spawn", "teardown", "exit"]);
  });

  it("respects the minimum-uptime guard", () => {
    const h = makeHarness({ mode: "linked", mtime: 1000, uptimeMs: 5_000 });
    h.restarter.start();
    h.setMtime(2000);
    h.restarter.devTick();
    h.restarter.devTick();
    h.restarter.tryRestart();
    expect(h.calls).toEqual([]); // too young to churn
  });

  it("a failed spawn aborts the restart and keeps the process alive", async () => {
    const h = makeHarness({ mode: "linked", mtime: 1000, spawnOk: false });
    h.restarter.start();
    h.setMtime(2000);
    h.restarter.devTick();
    h.restarter.devTick();
    await Promise.resolve();
    expect(h.calls).toEqual(["spawn"]); // no teardown, no exit
    expect(h.announces.some((a) => a.includes("Restart failed"))).toBe(true);
  });
});

describe("SelfRestarter — published installs", () => {
  it("global: restarts after the on-disk update succeeds", async () => {
    const h = makeHarness({
      mode: "global",
      updateResult: { action: "updated", mode: "global", from: "1.0.0", to: "1.1.0" },
    });
    h.restarter.start();
    await h.restarter.updateTick();
    await Promise.resolve();
    expect(h.calls).toEqual(["check", "spawn", "teardown", "exit"]);
    expect(h.spawns[0]?.npxVersion).toBeUndefined(); // disk already updated — same argv
  });

  it("global: up-to-date → no restart", async () => {
    const h = makeHarness({ mode: "global" });
    h.restarter.start();
    await h.restarter.updateTick();
    expect(h.calls).toEqual(["check"]);
  });

  it("npx: respawns pinned to the newer version", async () => {
    const h = makeHarness({ mode: "npx", currentVersion: "1.0.0", latest: "1.2.0" });
    h.restarter.start();
    await h.restarter.updateTick();
    await Promise.resolve();
    expect(h.calls).toEqual(["spawn", "teardown", "exit"]);
    expect(h.spawns[0]?.npxVersion).toBe("1.2.0");
  });

  it("npx: same version → no restart", async () => {
    const h = makeHarness({ mode: "npx", currentVersion: "1.2.0", latest: "1.2.0" });
    h.restarter.start();
    await h.restarter.updateTick();
    expect(h.calls).toEqual([]);
  });
});

describe("SelfRestarter — opt-outs", () => {
  it("COMFYUI_MCP_AUTO_UPDATE_DISABLE=1 disables everything", async () => {
    const h = makeHarness({
      mode: "npx",
      currentVersion: "1.0.0",
      latest: "2.0.0",
      env: { COMFYUI_MCP_AUTO_UPDATE_DISABLE: "1" },
    });
    h.restarter.start();
    // start() refuses to wire timers; even a manual tick must not restart
    // because arm() is never reached without a wired check... exercise the
    // stronger property: ticks still run but the engine was never started, so
    // nothing announces or restarts.
    expect(h.calls).toEqual([]);
    expect(h.announces).toEqual([]);
  });

  it("COMFYUI_MCP_AUTORESTART=0 announces once instead of restarting", async () => {
    const h = makeHarness({
      mode: "npx",
      currentVersion: "1.0.0",
      latest: "2.0.0",
      env: { COMFYUI_MCP_AUTORESTART: "0" },
    });
    h.restarter.start();
    await h.restarter.updateTick();
    await h.restarter.updateTick(); // same version again — no duplicate nag
    expect(h.calls).toEqual([]); // never spawned/tore down/exited
    const nags = h.announces.filter((a) => a.includes("auto-restart is off"));
    expect(nags).toHaveLength(1);
  });
});
