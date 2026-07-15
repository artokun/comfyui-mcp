// Orchestrator self-updater + self-restarter.
//
// self-update.ts can refresh the package ON DISK, but a long-lived orchestrator
// process keeps running the OLD code until someone restarts it — the exact trap
// that produced "regression" reports from a days-old process serving a freshly
// rebuilt dist. This engine closes the loop for the PANEL ORCHESTRATOR mode
// (`connect` / `--panel-orchestrator`) only:
//
//   - PUBLISHED installs (global / local / npx): periodically re-check the npm
//     registry. global/local self-update on disk (self-update.ts) and then
//     restart into the new code; npx respawns pinned to the new version (npx
//     fetches it on launch).
//   - DEV installs (npm link / checkout): NEVER touch the disk — instead watch
//     the running entry script's mtime and restart when a rebuild lands, so
//     `npm run build` is all a developer needs.
//
// Restart discipline: a restart may NEVER eat a reply. We wait until every
// agent is idle with nothing queued (plus any extra caller gate — held
// messages, a render in flight), announce to the panel, spawn a DETACHED
// replacement with the same command line, then run the caller's clean teardown
// and exit. The replacement rides the bridge's existing bind-retry while our
// port frees; agent sessions resume from the durable session store; the panel
// reconnects on its own.
//
// Loop safety: restarts are strictly CHANGE-driven (a version newer than the
// one running, or an entry mtime newer than the one we booted with), so a
// freshly restarted process observes "no change" and settles. A minimum-uptime
// guard adds defense in depth. NEVER used in MCP stdio mode — the MCP client
// owns that lifecycle.
//
// Opt-outs (default ON):
//   COMFYUI_MCP_AUTO_UPDATE_DISABLE=1  master off (checks + restarts;
//                                      COMFYUI_MCP_AUTOUPDATE=0 still works)
//   COMFYUI_MCP_AUTORESTART=0          keep checking/notifying, never restart
//   COMFYUI_MCP_UPDATE_CHECK_MS        registry re-check period (default 1h)

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import {
  PACKAGE_NAME,
  checkAndSelfUpdate,
  detectInstallMode,
  getLatestPublishedVersion,
  isAutoUpdateDisabled,
  isNewer,
  type InstallInfo,
} from "./self-update.js";
import { logger } from "../utils/logger.js";

/** Registry re-check period. An hour keeps update latency low at ~24 tiny
 *  registry GETs a day; override for tuning/tests. */
const DEFAULT_UPDATE_CHECK_MS = 60 * 60 * 1000;
/** Dev rebuild watch period — a cheap statSync, so it can be tight. */
const DEV_WATCH_MS = 10_000;
/** A rebuild writes many files; require the entry mtime to hold still for one
 *  extra poll so we don't restart into a half-written dist. */
const DEV_SETTLE_POLLS = 2;
/** How often to re-test the idle gate while a restart is pending. */
const IDLE_POLL_MS = 5_000;
/** Defense-in-depth against restart churn: never restart a process younger
 *  than this (change-driven triggers make a true loop impossible anyway). */
const MIN_UPTIME_MS = 2 * 60 * 1000;

export interface SelfRestartDeps {
  env: () => NodeJS.ProcessEnv;
  detectInstall: () => InstallInfo;
  /** self-update.ts policy engine (updates global/local installs on disk). */
  checkAndSelfUpdate: typeof checkAndSelfUpdate;
  latestVersion: () => Promise<string | undefined>;
  /** mtime (ms) of the running entry script, or undefined. Never throws. */
  entryMtime: () => number | undefined;
  /** Every agent idle + nothing queued (caller may fold in extra gates). */
  allIdle: () => boolean;
  /** Broadcast a chat line to every panel tab. */
  announce: (text: string) => void;
  /** Clean teardown (close bridge/listeners, stop agents) — NO process.exit. */
  teardown: () => Promise<void>;
  /** Spawn the detached replacement process. Returns false on failure. */
  spawnReplacement: (opts: { npxVersion?: string }) => boolean;
  exit: (code: number) => void;
  uptimeMs: () => number;
}

function defaultEntryMtime(): number | undefined {
  try {
    const entry = process.argv[1];
    if (!entry) return undefined;
    return statSync(entry).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Spawn the replacement orchestrator, detached, sharing our stdio so it keeps
 * logging into the same terminal. Same argv for dev/global/local (the on-disk
 * code is already new); npx respawns via `npx -y comfyui-mcp@<version>` because
 * re-execing the cached entry would just re-run the OLD cached code. Args after
 * the version are our own argv tail — typed by the user at launch, not remote
 * input.
 */
function defaultSpawnReplacement(opts: { npxVersion?: string }): boolean {
  try {
    const gen = Number(process.env.COMFYUI_MCP_RESTART_GEN ?? "0") + 1;
    const env = { ...process.env, COMFYUI_MCP_RESTART_GEN: String(gen) };
    const isWin = process.platform === "win32";
    const child = opts.npxVersion
      ? spawn(
          isWin ? "npx.cmd" : "npx",
          ["-y", `${PACKAGE_NAME}@${opts.npxVersion}`, ...process.argv.slice(2)],
          { detached: true, stdio: "inherit", env, shell: isWin },
        )
      : spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "inherit",
          env,
        });
    if (!child.pid) return false;
    child.unref();
    return true;
  } catch (err) {
    logger.error(`[self-restart] spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export const defaultSelfRestartDeps: SelfRestartDeps = {
  env: () => process.env,
  detectInstall: () => detectInstallMode(),
  checkAndSelfUpdate,
  latestVersion: () => getLatestPublishedVersion(),
  entryMtime: defaultEntryMtime,
  allIdle: () => true,
  announce: () => {},
  teardown: async () => {},
  spawnReplacement: defaultSpawnReplacement,
  exit: (code) => process.exit(code),
  uptimeMs: () => process.uptime() * 1000,
};

function isRestartDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env.COMFYUI_MCP_AUTORESTART ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

export class SelfRestarter {
  private deps: SelfRestartDeps;
  private info: InstallInfo;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  /** Baseline entry mtime captured at start — a REBUILD is mtime > this. */
  private bootMtime: number | undefined;
  /** Last mtime seen by the dev watcher + how many polls it has held still. */
  private lastSeenMtime: number | undefined;
  private stablePolls = 0;
  /** Armed restart (reason + optional npx target); only one at a time. */
  private pending: { reason: string; npxVersion?: string } | null = null;
  private restarting = false;
  /** Versions already announced when restart is disabled — once each. */
  private announced = new Set<string>();
  stopped = false;

  constructor(deps: Partial<SelfRestartDeps> = {}) {
    this.deps = { ...defaultSelfRestartDeps, ...deps };
    this.info = this.deps.detectInstall();
  }

  /** Wire the periodic checks. No-op when the master switch is off. */
  start(): void {
    const env = this.deps.env();
    if (isAutoUpdateDisabled(env)) {
      logger.info("[self-restart] disabled via COMFYUI_MCP_AUTO_UPDATE_DISABLE/COMFYUI_MCP_AUTOUPDATE");
      return;
    }
    const gen = Number(env.COMFYUI_MCP_RESTART_GEN ?? "0");
    if (gen > 0) {
      logger.info(
        `[self-restart] running v${this.info.currentVersion ?? "?"} after self-restart (gen ${gen}, ${this.info.mode})`,
      );
    }

    if (this.info.isDevLink || this.info.mode === "linked") {
      // DEV: restart-on-rebuild. Never mutates the checkout.
      this.bootMtime = this.deps.entryMtime();
      const t = setInterval(() => this.devTick(), DEV_WATCH_MS);
      t.unref?.();
      this.timers.push(t);
      logger.info("[self-restart] dev install — watching the built entry for rebuilds (restart-on-build)");
    } else if (this.info.mode !== "unknown") {
      const period = Number(env.COMFYUI_MCP_UPDATE_CHECK_MS) || DEFAULT_UPDATE_CHECK_MS;
      const t = setInterval(() => void this.updateTick(), period);
      t.unref?.();
      this.timers.push(t);
      logger.info(
        `[self-restart] ${this.info.mode} install — checking npm for updates every ${Math.round(period / 60000)}m`,
      );
    } else {
      logger.info("[self-restart] install mode unknown — periodic update checks disabled (manual updates only)");
      return;
    }

    const idleTimer = setInterval(() => this.tryRestart(), IDLE_POLL_MS);
    idleTimer.unref?.();
    this.timers.push(idleTimer);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** DEV: arm a restart once a rebuild lands and the dist has settled. */
  devTick(): void {
    if (this.stopped || this.pending || this.restarting) return;
    const m = this.deps.entryMtime();
    if (m === undefined || this.bootMtime === undefined || m <= this.bootMtime) return;
    if (m !== this.lastSeenMtime) {
      // Fresh write — start (or restart) the settle counter.
      this.lastSeenMtime = m;
      this.stablePolls = 1;
      return;
    }
    this.stablePolls += 1;
    if (this.stablePolls < DEV_SETTLE_POLLS) return;
    this.arm({ reason: "a new dev build landed" });
  }

  /** PUBLISHED: run the self-update policy engine; arm a restart on change. */
  async updateTick(): Promise<void> {
    if (this.stopped || this.pending || this.restarting) return;
    try {
      if (this.info.mode === "npx") {
        // npx can't be updated on disk — respawn pinned to the new version.
        const latest = await this.deps.latestVersion();
        const current = this.info.currentVersion;
        if (!latest || !current || !isNewer(latest, current)) return;
        this.arm({ reason: `updating ${current} → ${latest}`, npxVersion: latest });
        return;
      }
      // global/local: self-update.ts replaces the package on disk; "updated"
      // means the NEXT process will run the new code.
      const res = await this.deps.checkAndSelfUpdate();
      if (res.action === "updated") {
        this.arm({ reason: `updated ${res.from ?? "?"} → ${res.to ?? "?"}` });
      }
    } catch (err) {
      logger.debug(`[self-restart] update check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Record the restart intent. With AUTORESTART off, notify once instead. */
  private arm(next: { reason: string; npxVersion?: string }): void {
    if (isRestartDisabled(this.deps.env())) {
      const key = next.npxVersion ?? next.reason;
      if (!this.announced.has(key)) {
        this.announced.add(key);
        const note = `⬆️ ${PACKAGE_NAME}: ${next.reason} — auto-restart is off (COMFYUI_MCP_AUTORESTART=0); restart the orchestrator to load it.`;
        logger.info(`[self-restart] ${note}`);
        this.deps.announce(note);
      }
      return;
    }
    logger.info(`[self-restart] ${next.reason} — restarting when every agent is idle`);
    this.pending = next;
    this.tryRestart();
  }

  /** Fire the armed restart once the process is old enough and ALL idle. */
  tryRestart(): void {
    if (!this.pending || this.restarting || this.stopped) return;
    if (this.deps.uptimeMs() < MIN_UPTIME_MS) return;
    if (!this.deps.allIdle()) return;
    this.restarting = true;
    const { reason, npxVersion } = this.pending;
    this.pending = null;
    void this.doRestart(reason, npxVersion);
  }

  private async doRestart(reason: string, npxVersion?: string): Promise<void> {
    logger.info(`[self-restart] restarting now (${reason})`);
    this.deps.announce(
      `⬆️ ${reason} — restarting the agent orchestrator. Back in a few seconds; your session resumes automatically.`,
    );
    // Spawn FIRST so a spawn failure aborts the restart with the old process
    // fully intact. The child's bridge bind-retry outlasts our teardown.
    if (!this.deps.spawnReplacement({ npxVersion })) {
      logger.error("[self-restart] could not spawn the replacement — staying on the current process");
      this.deps.announce("⚠️ Restart failed to launch a replacement — still running the current version.");
      this.restarting = false;
      return;
    }
    this.stop();
    try {
      await this.deps.teardown();
    } catch (err) {
      logger.debug(`[self-restart] teardown: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.deps.exit(0);
  }
}
