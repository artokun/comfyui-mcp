/**
 * Explicitly-installed companion for panel-driven orchestrator startup.
 *
 * This file intentionally imports only Node built-ins. `launcher install`
 * copies the compiled module into ~/.comfyui-mcp/launcher/broker.mjs, so the
 * login service is stable even when the command was invoked through npx's
 * disposable cache.
 */
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PANEL_LAUNCHER_PROTOCOL = 1;
export const PANEL_LAUNCHER_LABEL = "io.artokun.comfyui-mcp-launcher";
export const PANEL_LAUNCHER_TASK = "ComfyUI MCP Launcher";
export const DEFAULT_PANEL_BRIDGE_PORT = 9199;
/** Pre-#2030 default. Logitech G HUB (`lghub_agent`) occupies 9180 on many desktops. */
export const LEGACY_PANEL_BRIDGE_PORT = 9180;

/** The broker must not hand the orchestrator the broker's own login terminal. */
export const ORCHESTRATOR_RECOVERY_DELAY_MS = 15_000;
/** A broken install must not turn the login broker into an unbounded spawn loop. */
export const ORCHESTRATOR_RECOVERY_MAX_ATTEMPTS = 3;
export const ORCHESTRATOR_RECOVERY_WINDOW_MS = 5 * 60_000;

export type PanelLauncherConfig = {
  protocol: 1;
  host: "127.0.0.1";
  port: number;
  token: string;
  /** Changes when a new install supersedes an unfinished fallback launch. */
  install_id?: string;
  /** Random command-line marker proving that a recorded pid is our broker. */
  broker_id?: string;
  /** Executable recorded when the autostart command was installed. */
  broker_executable?: string;
  pid?: number;
  updated_at: string;
};

export type LauncherPaths = {
  root: string;
  launcherDir: string;
  config: string;
  /** Cross-process lock for config publication and uninstall teardown. */
  lock: string;
  /** Persistent uninstall tombstone; prevents an old broker from republishing config. */
  teardown: string;
  broker: string;
  windowsScript: string;
  /** Windows fallback autostart, for accounts that may not create scheduled
   *  tasks. The Startup folder is per-user and needs no elevation. */
  windowsStartup: string;
  macPlist: string;
  linuxService: string;
  linuxAutostart: string;
};

export function panelLauncherPaths(
  home: string = homedir(),
  // Derive from `home`, not the process environment: a caller passing only a
  // home (test harness, sandbox, per-user install) must get every artifact
  // under that home, not a Startup entry in the REAL user's %APPDATA%.
  appData: string = roamingAppData({ home }),
): LauncherPaths {
  const root = join(home, ".comfyui-mcp");
  const launcherDir = join(root, "launcher");
  return {
    root,
    launcherDir,
    config: join(root, "launcher.json"),
    lock: join(root, "launcher.lock"),
    teardown: join(root, "launcher.uninstalled"),
    broker: join(launcherDir, "broker.mjs"),
    windowsScript: join(launcherDir, "start-launcher.cmd"),
    windowsStartup: join(
      appData,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "comfyui-mcp-launcher.cmd",
    ),
    macPlist: join(home, "Library", "LaunchAgents", `${PANEL_LAUNCHER_LABEL}.plist`),
    linuxService: join(home, ".config", "systemd", "user", "comfyui-mcp-launcher.service"),
    linuxAutostart: join(home, ".config", "autostart", "comfyui-mcp-launcher.desktop"),
  };
}

function isConfig(value: unknown): value is PanelLauncherConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.protocol === PANEL_LAUNCHER_PROTOCOL &&
    v.host === "127.0.0.1" &&
    Number.isInteger(v.port) &&
    Number(v.port) >= 0 &&
    Number(v.port) <= 65535 &&
    typeof v.token === "string" &&
    v.token.length >= 32 &&
    (v.install_id === undefined ||
      (typeof v.install_id === "string" && /^[A-Za-z0-9_-]{32,}$/.test(v.install_id))) &&
    (v.pid === undefined ||
      (Number.isInteger(v.pid) && Number(v.pid) > 0 && Number(v.pid) <= 0x7fffffff)) &&
    (v.broker_id === undefined ||
      (typeof v.broker_id === "string" && /^[A-Za-z0-9_-]{32,}$/.test(v.broker_id))) &&
    (v.broker_executable === undefined ||
      (typeof v.broker_executable === "string" &&
        v.broker_executable.length > 0 &&
        v.broker_executable.length <= 4096 &&
        !/[\u0000\r\n]/.test(v.broker_executable))) &&
    typeof v.updated_at === "string"
  );
}

export function readPanelLauncherConfig(home: string = homedir()): PanelLauncherConfig | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(panelLauncherPaths(home).config, "utf8"));
    return isConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writePanelLauncherConfig(config: PanelLauncherConfig, home: string): void {
  const path = panelLauncherPaths(home).config;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ACLs are owned by the current user; chmod is best-effort there.
  }
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Why a service manager refused, as a single line fit for a CLI message.
 *
 * `execFileSync` throws an Error whose `stderr` holds the tool's own words
 * ("ERROR: Access is denied."), but only when the caller piped it; the generic
 * `message` is just the command line, which tells the user nothing they can act
 * on. Prefer the tool's reason and fall back to the message.
 */
function schtasksReason(err: unknown): string {
  const stderr = (err as { stderr?: unknown })?.stderr;
  const text =
    typeof stderr === "string"
      ? stderr
      : stderr && typeof (stderr as Buffer).toString === "function"
        ? (stderr as Buffer).toString("utf8")
        : "";
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line?.trim() || (err instanceof Error ? err.message : String(err));
}

export type InstallLauncherOptions = {
  home?: string;
  platform?: NodeJS.Platform;
  nodePath?: string;
  brokerSource?: string;
  exec?: typeof execFileSync;
  /** Injected for the tests, so a fallback case can assert the broker was
   *  started without actually starting one. */
  spawnImpl?: typeof spawn;
  /**
   * Roaming AppData root. Defaults to `%APPDATA%` in production and to a path
   * under `home` whenever the caller overrode `home` (tests, and any call that
   * is deliberately not talking about the real profile).
   *
   * NOT derived from `home` unconditionally: Group Policy "Redirect the Roaming
   * AppData folder" points `%APPDATA%` at a share while `USERPROFILE` stays
   * local, so `<home>/AppData/Roaming` is then a directory Explorer never scans.
   * `mkdirSync(…, {recursive:true})` would happily manufacture it and the
   * install would report success for an autostart that can never fire — on
   * precisely the managed domain accounts whose policy denies `schtasks` in the
   * first place, i.e. the whole population this fallback exists for.
   */
  appData?: string;
};

/** Roaming AppData for a call: explicit wins, then an overridden home, then the
 *  real `%APPDATA%`, then the conventional layout. */
function roamingAppData(opts: { home?: string; appData?: string }): string {
  if (opts.appData) return opts.appData;
  if (opts.home) return join(opts.home, "AppData", "Roaming");
  const env = process.env.APPDATA?.trim();
  return env || join(homedir(), "AppData", "Roaming");
}

export async function installPanelLauncher(
  options: InstallLauncherOptions = {},
): Promise<LauncherPaths> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const nodePath = options.nodePath ?? process.execPath;
  const source = options.brokerSource ?? fileURLToPath(import.meta.url);
  const run = options.exec ?? execFileSync;
  const spawnBroker = options.spawnImpl ?? spawn;
  const paths = panelLauncherPaths(home, roamingAppData(options));

  const locked = await withPanelLauncherLock(home, async () => {
    mkdirSync(paths.launcherDir, { recursive: true });
    copyFileSync(source, paths.broker);

    const previous = readPanelLauncherConfig(home);
    const token = previous?.token ?? randomBytes(32).toString("base64url");
    const previousLive = previous?.port
      ? (await queryPanelLauncher(home) as { running?: boolean })
      : { running: false };
    // Preserve the generation only for a broker that positively answers the
    // recorded port. A stale nonzero port and a port-0/unfinished install get a
    // new generation, invalidating any delayed fallback from that install.
    const installId = previousLive.running && previous?.install_id
      ? previous.install_id
      : randomBytes(24).toString("base64url");
    const brokerId = previous?.broker_id ?? randomBytes(24).toString("base64url");
    // Keep the executable evidence paired with a live recorded PID. The
    // service scripts may adopt the new node path for a future restart, but
    // uninstall must still identify the currently answering old broker.
    const brokerExecutable = previousLive.running && previous?.broker_executable
      ? previous.broker_executable
      : nodePath;
    let needsFallbackBroker = false;

  /**
   * Start the broker unless the previous one is still alive.
   *
   * Every fallback path needs this: without a service manager nothing else will
   * start the broker, so the install would "succeed" and leave the panel with
   * nothing to talk to until the next logon. Shared by the Windows and Linux
   * fallbacks rather than duplicated — they answer the identical question.
   */
  const startBrokerIfIdle = async (): Promise<void> => {
    // POSITIVE EVIDENCE, not a pid. `process.kill(pid, 0)` only proves SOME
    // process holds that number, and Windows recycles pids aggressively across a
    // reboot — so an unrelated process wearing our old pid made this skip the
    // spawn, leaving a dead port in the config and the panel telling the user to
    // re-run the install they had just run: the #1798 loop, re-entered through
    // its own fix. `queryPanelLauncher` asks the recorded port, with the recorded
    // token, whether a broker is actually answering. Anything short of a live
    // answer means start one (merge-gate P1).
    // Keyed on the PORT alone. Gating on a pid as well meant the query never ran
    // on a second install — this function's own config write used to drop the
    // pid — so a duplicate broker was spawned beside a live one (merge-gate P1).
    // The port is what the query actually uses; the pid was never evidence.
    if (
      existsSync(paths.teardown) ||
      readPanelLauncherConfig(home)?.token !== token ||
      readPanelLauncherConfig(home)?.install_id !== installId
    ) return;
    if (previous?.port) {
      const live = (await queryPanelLauncher(home)) as {
        running?: boolean;
        broker_id?: unknown;
        install_id?: unknown;
      };
      if (live.running && live.broker_id === brokerId && live.install_id === installId) {
        return; // the answering broker owns this exact generation
      }
    }
    if (
      existsSync(paths.teardown) ||
      readPanelLauncherConfig(home)?.token !== token ||
      readPanelLauncherConfig(home)?.install_id !== installId
    ) return;
    const child = spawnBroker(nodePath, brokerRunArgs(paths.broker, brokerId, installId), {
      detached: true,
      stdio: "ignore",
    });
    const current = readPanelLauncherConfig(home);
    if (current?.token === token) {
      // Only persist a PID that this fallback launch actually owns. Keeping a
      // previous PID when a spawn implementation cannot report one would make
      // uninstall capable of targeting an unrelated recycled process.
      const next = {
        ...current,
        broker_id: brokerId,
        broker_executable: brokerExecutable,
        updated_at: new Date().toISOString(),
      };
      if (child.pid) next.pid = child.pid;
      else delete next.pid;
      writeOwnedPanelLauncherConfig(next, home, { token, installId });
    }
    child.unref?.();
  };
  const initialPublished = (() => {
    // Reinstall is the explicit operation that adopts this launcher root again.
    // Remove the old uninstall tombstone while holding the same lock used by
    // uninstall, so initial config publication cannot cross that teardown.
    rmSync(paths.teardown, { force: true });
    writePanelLauncherConfig(
      {
        protocol: PANEL_LAUNCHER_PROTOCOL,
        host: "127.0.0.1",
        port: previous?.port ?? 0,
        token,
        ...(installId ? { install_id: installId } : {}),
        broker_id: brokerId,
        broker_executable: brokerExecutable,
        // The running broker's pid is the broker's to publish, not this install's
        // to erase. Dropping it made the config say "no broker has ever run here"
        // to every subsequent install (merge-gate P1) — the port and token were
        // carried over but the pid was not, which is an incoherent record of the
        // same broker.
        ...(previous?.pid ? { pid: previous.pid } : {}),
        updated_at: new Date().toISOString(),
      },
      home,
    );
    return true;
  })();
  if (initialPublished === null) {
    throw new Error("Could not acquire the panel launcher lock for install");
  }

  if (platform === "win32") {
    writeFileSync(
      paths.windowsScript,
      `@echo off\r\n"${nodePath}" "${paths.broker}" run --broker-id=${brokerId} --install-id=${installId}\r\n`,
      "utf8",
    );
    // A scheduled task is the preferred registration, but it is NOT available to
    // every account: creating one can be denied outright by machine policy or by
    // the ACL on the task store, and the denial has nothing to do with this task
    // in particular (a throwaway probe task is refused identically). On such a
    // machine the install used to throw here, having already written every file
    // it needed, and the panel's Connect button kept telling the user to run an
    // install that could never succeed.
    //
    // So Windows now gets the same shape Linux has had all along: try the
    // service manager, and when it refuses, fall back to a per-user autostart
    // and start the broker directly. The Startup folder is user-writable and
    // needs no elevation, which is exactly the constraint the scheduled task
    // could not satisfy.
    // /Create and /Run get SEPARATE try blocks, because they fail for different
    // reasons and only one of them means "this account cannot register an
    // autostart". A created task whose /Run is refused right now — an /IT task
    // invoked over a non-interactive session (OpenSSH, WinRM, a CI service),
    // SCHED_E_TASK_NOT_READY — is REGISTERED and will fire at the next logon.
    // Treating that as a refusal wrote a Startup entry beside the live task, so
    // every later logon started two brokers, both rewriting launcher.json
    // (merge-gate P1). It also printed "scheduled task refused" about a task
    // that plainly exists.
    let taskRegistered = false;
    try {
      run(
        "schtasks.exe",
        [
          "/Create",
          "/F",
          "/SC",
          "ONLOGON",
          "/IT",
          "/RL",
          "LIMITED",
          "/TN",
          PANEL_LAUNCHER_TASK,
          "/TR",
          `"${paths.windowsScript}"`,
        ],
        // NOT "ignore" (codex-taxonomy class 1): schtasks reports WHY it refused
        // on stderr, and swallowing it left the CLI printing a bare "Command
        // failed: schtasks.exe …" — indistinguishable from a missing binary, a
        // bad argument, or a denial, which is the one that actually happens.
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      taskRegistered = true;
    } catch (err) {
      // A /Create failure does NOT prove this account can never register an
      // autostart — only that THIS call failed. The Task Scheduler service being
      // stopped or set to Manual, RPC being unavailable, or a GPO applied after
      // an earlier successful install all fail here while leaving a registered
      // task intact. Writing the Startup entry anyway put it beside that task, so
      // both fired at the next logon and two brokers raced on launcher.json —
      // the same collapse the /Run branch was split out to avoid, left open on
      // this branch (merge-gate P1). So ASK whether the task exists.
      let alreadyRegistered = false;
      try {
        run("schtasks.exe", ["/Query", "/TN", PANEL_LAUNCHER_TASK], { stdio: "ignore" });
        alreadyRegistered = true;
      } catch {
        // No such task (or we cannot even query) → the fallback is warranted.
      }
      if (alreadyRegistered) {
        // It IS registered — that task is the autostart. This session may still
        // need a broker, which the /Run attempt below (and then
        // startBrokerIfIdle) provides.
        taskRegistered = true;
        process.stderr?.write?.(
          `[comfyui-mcp] schtasks /Create failed (${schtasksReason(err)}), but the ` +
            `"${PANEL_LAUNCHER_TASK}" task is already registered — leaving it as the autostart.\n`,
        );
      } else {
        // The Startup write can fail too — EDR/AppLocker blocking Startup
        // persistence, or a Roaming AppData redirected to an offline share, on
        // the very same managed accounts whose policy denied the task. Unguarded,
        // it threw before the broker was started and the session got NOTHING:
        // #1798's stranding loop relocated from the schtasks line to this one
        // (merge-gate P1). Losing the autostart is survivable; losing this
        // session's broker is the bug we are here to fix, so warn and fall
        // through to it.
        let autostartPath = "";
        try {
          mkdirSync(dirname(paths.windowsStartup), { recursive: true });
          writeFileSync(
            paths.windowsStartup,
            `@echo off\r\nstart "" /min "${paths.windowsScript}"\r\n`,
            "utf8",
          );
          autostartPath = paths.windowsStartup;
        } catch (startupErr) {
          process.stderr?.write?.(
            `[comfyui-mcp] could not write the Startup autostart ` +
              `(${startupErr instanceof Error ? startupErr.message : String(startupErr)}); ` +
              `MCP will run for this session but will NOT start at the next logon. ` +
              `Start it by hand with: ${paths.windowsScript}\n`,
          );
        }
        // Not silent: the user asked for a launcher and got a different mechanism
        // than the one this tool normally installs, which changes how they would
        // later remove or debug it.
        if (autostartPath) {
          process.stderr?.write?.(
            `[comfyui-mcp] scheduled task refused (${schtasksReason(err)}); ` +
              `registered a Startup-folder autostart instead: ${autostartPath}\n`,
          );
        }
      }
    }
    if (taskRegistered) {
      return {
        paths,
        startFallback: null,
        // The task may need the launcher lock when its broker starts and
        // publishes its runtime state. Starting it while install still owns
        // that lock made the broker exit after its bounded reacquire timeout.
        startAfterInstall: async () => {
          if (
            existsSync(paths.teardown) ||
            readPanelLauncherConfig(home)?.token !== token ||
            readPanelLauncherConfig(home)?.install_id !== installId
          ) return;
          try {
            run("schtasks.exe", ["/Run", "/TN", PANEL_LAUNCHER_TASK], { stdio: "ignore" });
          } catch {
            // Registered but not startable right now (non-interactive session).
            // The autostart is in place for the next logon, so do NOT add a
            // second one — just get a broker up for THIS session.
            await startBrokerIfIdle();
          }
        },
      }; // the task is registered AND will be started after the lock is released
    }
    needsFallbackBroker = true;
    return { paths, startFallback: startBrokerIfIdle, startAfterInstall: null };
  }

  if (platform === "darwin") {
    mkdirSync(dirname(paths.macPlist), { recursive: true });
    writeFileSync(
      paths.macPlist,
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
      `<plist version="1.0"><dict>\n` +
      `<key>Label</key><string>${PANEL_LAUNCHER_LABEL}</string>\n` +
      `<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(paths.broker)}</string><string>run</string><string>--broker-id=${xml(brokerId)}</string><string>--install-id=${xml(installId)}</string></array>\n` +
        `<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n` +
        `<key>StandardOutPath</key><string>${xml(join(paths.launcherDir, "launcher.log"))}</string>\n` +
        `<key>StandardErrorPath</key><string>${xml(join(paths.launcherDir, "launcher-error.log"))}</string>\n` +
        `</dict></plist>\n`,
      "utf8",
    );
    try {
      run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, paths.macPlist], { stdio: "ignore" });
    } catch {
      // It is normal for the label not to be loaded on first install.
    }
    return {
      paths,
      startFallback: null,
      // Keep launchctl outside the installer lock. The launched broker must be
      // able to reacquire that lock before it publishes its runtime config.
      startAfterInstall: () => {
        if (
          existsSync(paths.teardown) ||
          readPanelLauncherConfig(home)?.token !== token ||
          readPanelLauncherConfig(home)?.install_id !== installId
        ) return;
        run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, paths.macPlist], { stdio: "ignore" });
      },
    };
  }

  mkdirSync(dirname(paths.linuxService), { recursive: true });
  writeFileSync(
    paths.linuxService,
    `[Unit]\nDescription=ComfyUI MCP panel launcher\n\n` +
      `[Service]\nExecStart="${nodePath}" "${paths.broker}" run --broker-id=${brokerId} --install-id=${installId}\nRestart=on-failure\n\n` +
      `[Install]\nWantedBy=default.target\n`,
    "utf8",
  );
  const writeLinuxAutostart = (): void => {
    mkdirSync(dirname(paths.linuxAutostart), { recursive: true });
    writeFileSync(
      paths.linuxAutostart,
      `[Desktop Entry]\nType=Application\nName=ComfyUI MCP Launcher\n` +
        `Exec="${nodePath}" "${paths.broker}" run --broker-id=${brokerId} --install-id=${installId}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`,
      "utf8",
    );
  };
  try {
    run("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    run("systemctl", ["--user", "enable", "comfyui-mcp-launcher.service"], {
      stdio: "ignore",
    });
  } catch {
    writeLinuxAutostart();
    needsFallbackBroker = true;
  }
  return {
    paths,
    startFallback: needsFallbackBroker ? startBrokerIfIdle : null,
    // `enable --now` used to start the broker while the installer still held
    // the shared lock. Register under the lock, then start after it is released.
    startAfterInstall: needsFallbackBroker
      ? null
      : async () => {
          if (
            existsSync(paths.teardown) ||
            readPanelLauncherConfig(home)?.token !== token ||
            readPanelLauncherConfig(home)?.install_id !== installId
          ) return;
          try {
            run("systemctl", ["--user", "start", "comfyui-mcp-launcher.service"], { stdio: "ignore" });
          } catch {
            // A registered service that cannot start now still needs a
            // per-user fallback and a broker for this session. Reacquire the
            // lock only for the fallback artifact write; the broker itself is
            // launched after that lock is released.
            await withPanelLauncherLock(home, () => {
              if (
                existsSync(paths.teardown) ||
                readPanelLauncherConfig(home)?.token !== token ||
                readPanelLauncherConfig(home)?.install_id !== installId
              ) return false;
              writeLinuxAutostart();
              return true;
            });
            await startBrokerIfIdle();
          }
        },
  };
  });
  if (locked === null) {
    throw new Error("Could not acquire the panel launcher lock for install");
  }
  if (locked.startAfterInstall) await locked.startAfterInstall();
  if (locked.startFallback) await locked.startFallback();
  return locked.paths;
}

export type UninstallLauncherOptions = Pick<
  InstallLauncherOptions,
  "home" | "platform" | "exec" | "appData"
> & {
  /** Test seam for the owned fallback-broker stop. */
  killImpl?: typeof process.kill;
  /** Test seam; production reads the target process command line from the OS. */
  processIdentityImpl?: (pid: number, platform: NodeJS.Platform, run: typeof execFileSync) =>
    PanelLauncherProcessIdentity | null;
};

export type PanelLauncherProcessIdentity = {
  commandLine: string;
  executable: string;
};

function readPanelLauncherProcessIdentity(
  pid: number,
  platform: NodeJS.Platform,
  run: typeof execFileSync,
): PanelLauncherProcessIdentity | null {
  try {
    if (platform === "linux") {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter(Boolean);
      if (argv.length === 0) return null;
      return {
        commandLine: argv.join(" "),
        executable: readlinkSync(`/proc/${pid}/exe`),
      };
    }
    if (platform === "win32") {
      const script =
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';` +
        `if($p){$p|Select-Object -First 1 ExecutablePath,CommandLine|ConvertTo-Json -Compress}`;
      const raw = run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const parsed = JSON.parse(String(raw)) as { CommandLine?: unknown; ExecutablePath?: unknown };
      if (
        typeof parsed.CommandLine !== "string" ||
        parsed.CommandLine.length === 0 ||
        typeof parsed.ExecutablePath !== "string" ||
        parsed.ExecutablePath.length === 0
      ) return null;
      return {
        commandLine: parsed.CommandLine,
        executable: parsed.ExecutablePath,
      };
    }
    const raw = run(
      "ps",
      ["-p", String(pid), "-o", "command="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const commandLine = String(raw).trim();
    if (!commandLine) return null;
    const executable = commandLine.match(/^\s*(?:"([^"]+)"|(\S+))/)?.[1] ??
      commandLine.match(/^\s*(?:"([^"]+)"|(\S+))/)?.[2];
    return executable ? { commandLine, executable } : null;
  } catch {
    // If the platform/permissions do not expose identity, safe cleanup is to
    // leave the process alone. PID equality is never sufficient evidence.
    return null;
  }
}

function processIdentityOwnsBroker(
  identity: PanelLauncherProcessIdentity | null,
  brokerPath: string,
  brokerId: string | undefined,
  brokerExecutable: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (!identity || !brokerId || !brokerExecutable || !identity.commandLine || !identity.executable) return false;
  const normalizePath = (value: string) => {
    const path = value.replaceAll("\\", "/");
    return platform === "win32" ? path.toLowerCase() : path;
  };
  const hasToken = (commandLine: string, token: string, caseInsensitive: boolean): boolean => {
    const normalizedLine = commandLine.replaceAll("\\", "/");
    const haystack = caseInsensitive ? normalizedLine.toLowerCase() : normalizedLine;
    const needle = caseInsensitive ? token.toLowerCase() : token;
    let offset = 0;
    while (true) {
      const index = haystack.indexOf(needle, offset);
      if (index < 0) return false;
      const before = index === 0 ? "" : haystack[index - 1];
      const afterIndex = index + needle.length;
      const after = afterIndex >= haystack.length ? "" : haystack[afterIndex];
      if ((before === "" || /[\s"']/.test(before)) && (after === "" || /[\s"']/.test(after))) {
        return true;
      }
      offset = afterIndex;
    }
  };
  const commandLine = identity.commandLine;
  // The path and random per-install marker must both be present in the OS
  // observation. A recycled PID or unrelated process cannot satisfy this by
  // merely reusing the numeric pid. If the OS returns a shortened/opaque
  // command line, this deliberately fails closed.
  if (!hasToken(commandLine, normalizePath(brokerPath), platform === "win32") ||
    !hasToken(commandLine, `--broker-id=${brokerId}`, false) ||
    !hasToken(commandLine, "run", true)) {
    return false;
  }
  return normalizePath(identity.executable) === normalizePath(brokerExecutable);
}

function stopOwnedPanelLauncherBroker(
  platform: NodeJS.Platform,
  run: typeof execFileSync,
  killImpl: typeof process.kill,
  pid: number | undefined,
  brokerPath: string,
  brokerId: string | undefined,
  brokerExecutable: string | undefined,
  processIdentityImpl: UninstallLauncherOptions["processIdentityImpl"],
): void {
  // Never let an in-process test broker (or a future embedded caller) kill its
  // own process. The installed login broker always has a distinct PID.
  if (!pid || pid === process.pid) return;
  const identity = (processIdentityImpl ?? readPanelLauncherProcessIdentity)(pid, platform, run);
  if (!processIdentityOwnsBroker(identity, brokerPath, brokerId, brokerExecutable, platform)) return;
  try {
    if (platform === "win32") {
      // Stop only the owned broker. Its orchestrator child is independent and
      // may be serving an already-connected panel; what uninstall must prevent
      // is the broker's recovery loop bringing that child back.
      run("taskkill.exe", ["/PID", String(pid), "/F"], { stdio: "ignore" });
    } else {
      killImpl(pid, "SIGTERM");
    }
  } catch {
    // The service/task may already have stopped it, or the PID may have exited
    // between reading the owned config and issuing the stop.
  }
}

type LauncherLockOwner = { pid: number; token: string; started_at?: string };

function launcherProcessStartIdentity(pid: number, platform: NodeJS.Platform): string | null {
  try {
    if (platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const endOfCommand = stat.lastIndexOf(")");
      const fields = stat.slice(endOfCommand + 2).trim().split(/\s+/);
      const startTicks = fields[19]; // field 22, after the command and state fields
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return startTicks && bootId ? `${bootId}:${startTicks}` : null;
    }
    if (platform === "win32") {
      const script =
        `$p=Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\";` +
        `if($p){$p.CreationDate.ToUniversalTime().ToString(\"o\")}`;
      return String(
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
          encoding: "utf8",
          timeout: 2_000,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      ).trim() || null;
    }
    return String(
      execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).trim() || null;
  } catch {
    return null;
  }
}

let cachedLauncherProcessStartIdentity: string | null | undefined;

function currentLauncherProcessStartIdentity(): string | null {
  if (cachedLauncherProcessStartIdentity === undefined) {
    cachedLauncherProcessStartIdentity = launcherProcessStartIdentity(process.pid, process.platform);
  }
  return cachedLauncherProcessStartIdentity;
}

function readLauncherLockOwner(path: string): LauncherLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      !Number.isInteger(parsed.pid) ||
      Number(parsed.pid) <= 0 ||
      Number(parsed.pid) > 0x7fffffff ||
      typeof parsed.token !== "string"
    ) return null;
    return {
      pid: Number(parsed.pid),
      token: parsed.token,
      ...(typeof parsed.started_at === "string" ? { started_at: parsed.started_at } : {}),
    };
  } catch {
    return null;
  }
}

function launcherLockOwnerIsDead(path: string, identityCache?: Map<number, string | null>): boolean {
  const owner = readLauncherLockOwner(path);
  if (!owner) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  // A live PID is not enough: the original process may have died and the OS
  // may have recycled that number. If the platform cannot expose a start
  // identity, fail closed and leave the lock for manual recovery.
  if (!owner.started_at) return false;
  if (owner.pid === process.pid && currentLauncherProcessStartIdentity() === owner.started_at) return false;
  let current: string | null;
  if (identityCache?.has(owner.pid)) {
    current = identityCache.get(owner.pid) ?? null;
  } else {
    current = launcherProcessStartIdentity(owner.pid, process.platform);
    identityCache?.set(owner.pid, current);
  }
  return current !== null && current !== owner.started_at;
}

/**
 * Publish a complete owner record before making the lock name visible. A
 * process crash cannot leave an ownerless main/reclaim lock between exclusive
 * create and metadata publication: the completed temp file is linked into the
 * well-known name atomically, then held open until release.
 */
function tryCreateOwnedLauncherLock(path: string, owner: LauncherLockOwner): number | null {
  const tempPath = `${path}.${owner.token}.tmp`;
  let linked = false;
  try {
    writeFileSync(tempPath, JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
    try {
      linkSync(tempPath, path);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    }
    return openSync(path, "r");
  } catch (error) {
    if (linked) rmSync(path, { force: true });
    throw error;
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function withPanelLauncherLock<T>(home: string, fn: () => T): T | null;
function withPanelLauncherLock<T>(home: string, fn: () => Promise<T>): Promise<T> | null;
function withPanelLauncherLock<T>(home: string, fn: () => T | Promise<T>): T | Promise<T> | null {
  const paths = panelLauncherPaths(home);
  const reclaimPath = `${paths.lock}.reclaim`;
  mkdirSync(paths.root, { recursive: true });
  const startedAt = currentLauncherProcessStartIdentity();
  const ownerIdentityCache = new Map<number, string | null>();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const lockToken = randomBytes(16).toString("hex");
    const owner = { pid: process.pid, token: lockToken, ...(startedAt ? { started_at: startedAt } : {}) };
    let fd: number | undefined;
    let reclaimFd: number | undefined;
    let reclaimToken: string | undefined;
    fd = tryCreateOwnedLauncherLock(paths.lock, owner) ?? undefined;
    if (fd === undefined) {
      if (!launcherLockOwnerIsDead(paths.lock, ownerIdentityCache)) continue;
      try {
        reclaimToken = randomBytes(16).toString("hex");
        reclaimFd = tryCreateOwnedLauncherLock(reclaimPath, {
          pid: process.pid,
          token: reclaimToken,
          ...(startedAt ? { started_at: startedAt } : {}),
        }) ?? undefined;
        if (reclaimFd === undefined) {
          if (launcherLockOwnerIsDead(reclaimPath, ownerIdentityCache)) rmSync(reclaimPath, { force: true });
        }
        if (reclaimFd === undefined) continue;
        // The auxiliary lock is itself a crash-recoverable owner lock. A
        // process which dies between acquiring it and releasing it must not
        // strand every later stale-main-lock recovery forever.
        const stillDead = launcherLockOwnerIsDead(paths.lock, ownerIdentityCache);
        if (stillDead) {
          rmSync(paths.lock, { force: true });
          fd = tryCreateOwnedLauncherLock(paths.lock, owner) ?? undefined;
        }
      } catch {
        // Another live reclaimer owns the auxiliary lock, or the lock changed.
      }
      if (fd === undefined) {
        if (reclaimFd !== undefined) {
          closeSync(reclaimFd);
          reclaimFd = undefined;
          try {
            const owner = JSON.parse(readFileSync(reclaimPath, "utf8")) as {
              token?: unknown;
            };
            if (owner.token === reclaimToken) rmSync(reclaimPath, { force: true });
          } catch {
            // The reclaim lock was already removed or became unreadable.
          }
        }
        continue;
      }
    }
    const lockFd = fd;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      closeSync(lockFd);
      try {
        const owner = JSON.parse(readFileSync(paths.lock, "utf8")) as { token?: unknown };
        if (owner.token === lockToken) rmSync(paths.lock, { force: true });
      } catch {
        // The lock was already removed or became unreadable; do not remove a
        // replacement lock owned by another process.
      }
      if (reclaimFd !== undefined) {
        closeSync(reclaimFd);
        try {
          const owner = JSON.parse(readFileSync(reclaimPath, "utf8")) as {
            token?: unknown;
          };
          if (owner.token === reclaimToken) rmSync(reclaimPath, { force: true });
        } catch {
          // The reclaim lock was already removed or became unreadable; do not
          // remove a replacement owned by another reclaimer.
        }
      }
    };
    try {
      const result = fn();
      if (result && typeof (result as unknown as { then?: unknown }).then === "function") {
        return Promise.resolve(result as T | PromiseLike<T>).finally(release);
      }
      release();
      return result as T;
    } catch (error) {
      release();
      throw error;
    }
  }
  return null;
}

function writeOwnedPanelLauncherConfig(
  config: PanelLauncherConfig,
  home: string,
  ownership: { token: string; installId?: string; brokerId?: string },
): boolean {
  return withPanelLauncherLock(home, () => {
    const paths = panelLauncherPaths(home);
    // The tombstone is written before uninstall removes the config. A broker
    // which is still publishing after that point must not recreate launcher.json.
    if (existsSync(paths.teardown)) return false;
    const current = readPanelLauncherConfig(home);
    const sameGeneration = ownership.installId !== undefined
      ? current?.install_id === ownership.installId
      : ownership.brokerId === undefined && current?.install_id === undefined;
    const legacyRuntimeMigration =
      ownership.installId === undefined &&
      ownership.brokerId !== undefined &&
      current?.broker_id === ownership.brokerId;
    if (current?.token !== ownership.token || (!sameGeneration && !legacyRuntimeMigration)) return false;
    writePanelLauncherConfig(config, home);
    return true;
  }) ?? false;
}

function markPanelLauncherTornDown(home: string): void {
  const paths = panelLauncherPaths(home);
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.teardown, `${new Date().toISOString()}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function brokerRunArgs(broker: string, brokerId: string, installId?: string): string[] {
  return [broker, "run", `--broker-id=${brokerId}`, ...(installId ? [`--install-id=${installId}`] : [])];
}

export function uninstallPanelLauncher(options: UninstallLauncherOptions = {}): void {
  const home = options.home ?? homedir();
  const completed = withPanelLauncherLock(home, () => {
    const platform = options.platform ?? process.platform;
    const run = options.exec ?? execFileSync;
    const killImpl = options.killImpl ?? process.kill.bind(process);
    const ownedConfig = readPanelLauncherConfig(home);
    const ownedBrokerPid = ownedConfig?.pid;
    // Same resolution as install, or uninstall deletes a path the install never
    // wrote and leaves the real autostart in place.
    const paths = panelLauncherPaths(home, roamingAppData(options));
    // This must precede service-manager teardown and config deletion. A broker
    // with an in-flight probe cannot publish while this lock is held.
    markPanelLauncherTornDown(home);
    if (platform === "win32") {
    try {
      run("schtasks.exe", ["/End", "/TN", PANEL_LAUNCHER_TASK], { stdio: "ignore" });
    } catch {
      // Already stopped.
    }
    try {
      run("schtasks.exe", ["/Delete", "/F", "/TN", PANEL_LAUNCHER_TASK], { stdio: "ignore" });
    } catch {
      // Already absent is the desired end state.
    }
    // …and the fallback autostart, which is what an account that could not
    // create the task actually has. Removing only the task would leave those
    // users with a launcher that keeps coming back after every uninstall.
    rmSync(paths.windowsStartup, { force: true });
    } else if (platform === "darwin") {
    try {
      run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, paths.macPlist], { stdio: "ignore" });
    } catch {
      // Already absent.
    }
    rmSync(paths.macPlist, { force: true });
    } else {
    try {
      run("systemctl", ["--user", "disable", "--now", "comfyui-mcp-launcher.service"], {
        stdio: "ignore",
      });
      run("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    } catch {
      // systemd may not be the selected user-session manager.
    }
    rmSync(paths.linuxService, { force: true });
    rmSync(paths.linuxAutostart, { force: true });
  }
    // Service-manager teardown does not cover the direct broker started by a
    // Windows Startup/XDG fallback. Stop the broker after disabling every future
    // autostart, or its exit watcher can relaunch the orchestrator during remove.
    rmSync(paths.config, { force: true });
    // Remove ownership first so a recovery callback racing uninstall observes a
    // disabled install before we stop the recorded fallback process.
    stopOwnedPanelLauncherBroker(
      platform,
      run,
      killImpl,
      ownedBrokerPid,
      paths.broker,
      ownedConfig?.broker_id,
      ownedConfig?.broker_executable,
      options.processIdentityImpl,
    );
    rmSync(paths.launcherDir, { force: true, recursive: true });
  });
  if (completed === null) {
    throw new Error("Could not acquire the panel launcher lock for uninstall");
  }
}

function safeTokenEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

function websocketClientFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length >= 126) throw new Error("launcher probe frame unexpectedly large");
  const mask = randomBytes(4);
  const frame = Buffer.alloc(2 + 4 + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (let i = 0; i < payload.length; i += 1) frame[6 + i] = payload[i] ^ mask[i % 4];
  return frame;
}

function serverFrameTexts(buffer: Buffer): string[] {
  const out: string[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      break; // launcher probe frames are tiny; refuse an unexpected giant frame.
    }
    const masked = (second & 0x80) !== 0;
    if (masked) header += 4;
    if (offset + header + length > buffer.length) break;
    if ((first & 0x0f) === 1 && !masked) {
      out.push(buffer.subarray(offset + header, offset + header + length).toString("utf8"));
    }
    offset += header + length;
  }
  return out;
}

/** Proves that the bridge speaks the ComfyUI MCP panel protocol, rather than
 *  treating any process occupying the port as the orchestrator. */
export function probePanelOrchestrator(
  port: number = Number(process.env.COMFYUI_MCP_BRIDGE_PORT) || DEFAULT_PANEL_BRIDGE_PORT,
  timeoutMs = 1200,
): Promise<boolean> {
  return new Promise((resolve) => {
    const key = randomBytes(16).toString("base64");
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const socket = netConnect({ host: "127.0.0.1", port });
    let settled = false;
    let upgraded = false;
    let buffer = Buffer.alloc(0);
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("error", () => finish(false));
    socket.once("connect", () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    // Annotated: with no setEncoding on this socket the chunk is always a Buffer,
    // but @types/node 26 widens the callback to `string | Buffer` and Buffer.concat
    // will not take the union.
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const header = buffer.subarray(0, end).toString("utf8");
        if (!header.startsWith("HTTP/1.1 101") || !header.toLowerCase().includes(`sec-websocket-accept: ${accept.toLowerCase()}`)) {
          finish(false);
          return;
        }
        upgraded = true;
        buffer = buffer.subarray(end + 4);
        socket.write(
          websocketClientFrame({
            type: "hello",
            tab_id: `launcher-probe-${randomBytes(8).toString("hex")}`,
            backend: "claude",
          }),
        );
      }
      for (const text of serverFrameTexts(buffer)) {
        try {
          const frame = JSON.parse(text) as { type?: unknown };
          if (["session_epoch", "backends", "models"].includes(String(frame.type))) {
            finish(true);
            return;
          }
        } catch {
          // Keep waiting for a protocol frame until the bounded timeout.
        }
      }
    });
  });
}

/**
 * Probe the port this process is pinned to, or — with no pin — the new default
 * and then the 9180-era default. A live 9180 session must not look "not
 * running" to the launcher just because this build's compiled default moved.
 */
export async function probeAnyPanelOrchestrator(timeoutMs = 1200): Promise<boolean> {
  const pinned = Number(process.env.COMFYUI_MCP_BRIDGE_PORT);
  if (Number.isInteger(pinned) && pinned > 0) {
    return probePanelOrchestrator(pinned, timeoutMs);
  }
  if (await probePanelOrchestrator(DEFAULT_PANEL_BRIDGE_PORT, timeoutMs)) return true;
  return probePanelOrchestrator(LEGACY_PANEL_BRIDGE_PORT, timeoutMs);
}

export type TerminalLaunch = {
  process?: ChildProcess;
  pid?: number;
  platform: NodeJS.Platform;
  interactive?: boolean;
};

export type TerminalCommand = { executable: string; args: string[] };

/**
 * Command used by the installed broker. Unlike terminalCommandForPlatform(),
 * this is deliberately a headless child: the broker is the persistent login
 * companion, so the orchestrator must not inherit a disposable terminal or its
 * console-death semantics. `cmd /c` is used on Windows because npx is a .cmd
 * shim and the scheduled-task/Startup environment does not guarantee a shell.
 */
export function persistentCommandForPlatform(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): TerminalCommand {
  if (platform === "win32") {
    return {
      executable: env.ComSpec || "cmd.exe",
      args: ["/d", "/c", "npx.cmd -y comfyui-mcp@latest connect"],
    };
  }
  return {
    executable: "npx",
    args: ["-y", "comfyui-mcp@latest", "connect"],
  };
}

export function launchPersistentMcp(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  spawnImpl: typeof spawn = spawn,
): TerminalLaunch {
  const command = persistentCommandForPlatform(platform, env);
  const child = spawnImpl(command.executable, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: platform === "win32",
  });
  child.unref?.();
  return { process: child, pid: child.pid, platform, interactive: false };
}

export function terminalCommandForPlatform(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  executableExists: (path: string) => boolean = existsSync,
): TerminalCommand {
  if (platform === "win32") {
    return {
      executable: env.ComSpec || "cmd.exe",
      args: ["/d", "/k", "npx.cmd -y comfyui-mcp@latest connect"],
    };
  }
  if (platform === "darwin") {
    return {
      executable: "osascript",
      args: ["-e", 'tell application "Terminal" to do script "npx -y comfyui-mcp@latest connect"'],
    };
  }
  const candidates = ["x-terminal-emulator", "kgx", "gnome-terminal", "konsole", "xfce4-terminal"];
  const terminal = candidates.find((name) => {
    const dirs = (env.PATH || "").split(":").filter(Boolean);
    return dirs.some((dir) => executableExists(join(dir, name)));
  });
  if (!terminal) throw new Error("No supported graphical terminal was found");
  return {
    executable: terminal,
    args: terminal === "x-terminal-emulator"
      ? ["-e", "sh", "-lc", "exec npx -y comfyui-mcp@latest connect"]
      : terminal === "kgx" || terminal === "gnome-terminal"
        ? ["--", "sh", "-lc", "exec npx -y comfyui-mcp@latest connect"]
        : ["-e", "sh", "-lc", "exec npx -y comfyui-mcp@latest connect"],
  };
}

export function launchMcpTerminal(platform: NodeJS.Platform = process.platform): TerminalLaunch {
  const command = terminalCommandForPlatform(platform);
  const child = spawn(command.executable, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return { process: child, pid: child.pid, platform, interactive: true };
}

function minimizeOwnedTerminal(launch: TerminalLaunch | null): boolean {
  if (!launch?.pid || launch.interactive !== true || launch.platform !== "win32") return false;
  try {
    const script =
      `$p=Get-Process -Id ${launch.pid} -ErrorAction SilentlyContinue;` +
      `if($p -and $p.MainWindowHandle -ne 0){` +
      `Add-Type '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd,int nCmdShow);' -Name W -Namespace C;` +
      `[C.W]::ShowWindowAsync($p.MainWindowHandle,6)|Out-Null}`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function jsonResponse(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(data.length),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

export type PanelLauncherBrokerOptions = {
  /** Test seams; the installed broker calls this with no options. */
  spawnImpl?: typeof spawn;
  probeImpl?: () => Promise<boolean>;
  now?: () => number;
  recoveryDelayMs?: number;
  recoveryMaxAttempts?: number;
  /** Deterministic seam for uninstall racing the initial config publication. */
  beforeConfigWrite?: () => void;
  /** Identity supplied by the installed command line; absent for in-process tests/legacy launchers. */
  expectedBrokerId?: string;
  expectedInstallId?: string;
  /** The installed broker entrypoint requires its command-line identity. */
  enforceCommandIdentity?: boolean;
};

export async function startPanelLauncherBroker(
  home: string = homedir(),
  options: PanelLauncherBrokerOptions = {},
): Promise<Server> {
  const current = readPanelLauncherConfig(home);
  const spawnBroker = options.spawnImpl ?? spawn;
  const probe = options.probeImpl ?? (() => probeAnyPanelOrchestrator());
  const now = options.now ?? (() => Date.now());
  const recoveryDelayMs = options.recoveryDelayMs ?? ORCHESTRATOR_RECOVERY_DELAY_MS;
  const recoveryMaxAttempts = options.recoveryMaxAttempts ?? ORCHESTRATOR_RECOVERY_MAX_ATTEMPTS;
  if (!current) throw new Error("Panel launcher is not installed or its config is invalid");
  // Older installs may not have a marker yet. Persist one as part of this
  // broker's runtime publication so future uninstall can fail closed.
  const brokerId = current.broker_id ?? randomBytes(24).toString("base64url");
  if (options.enforceCommandIdentity && !options.expectedBrokerId) {
    throw new Error("Panel launcher broker identity is missing from startup command");
  }
  if (options.expectedBrokerId !== undefined && brokerId !== options.expectedBrokerId) {
    throw new Error("Panel launcher broker identity changed before startup");
  }
  if (options.enforceCommandIdentity && current.install_id !== undefined && !options.expectedInstallId) {
    throw new Error("Panel launcher install generation is missing from startup command");
  }
  if (options.expectedInstallId !== undefined && current.install_id !== options.expectedInstallId) {
    throw new Error("Panel launcher install generation changed before startup");
  }
  const runtimeConfig = { ...current, broker_id: brokerId };
  const brokerConfigStillOwned = () => {
    if (existsSync(panelLauncherPaths(home).teardown)) return false;
    const latest = readPanelLauncherConfig(home);
    if (latest?.token !== current.token) return false;
    return latest.install_id === current.install_id ||
      (current.install_id === undefined && latest.install_id !== undefined && latest.broker_id === brokerId);
  };
  let launch: TerminalLaunch | null = null;
  let lastLaunchAt = 0;
  let recoveryTimer: NodeJS.Timeout | null = null;
  let recoveryWindowStarted: number | null = null;
  let recoveryAttempts = 0;
  let starting: Promise<{
    already_running: boolean;
    started: boolean;
    recovery_exhausted?: boolean;
    start_in_progress?: boolean;
    disabled?: boolean;
  }> | null = null;

  const resetRecoveryBudget = () => {
    recoveryWindowStarted = null;
    recoveryAttempts = 0;
  };

  const recoveryExhausted = (): boolean => {
    if (recoveryWindowStarted === null) return false;
    if (now() - recoveryWindowStarted >= ORCHESTRATOR_RECOVERY_WINDOW_MS) {
      resetRecoveryBudget();
      return false;
    }
    return recoveryAttempts >= recoveryMaxAttempts;
  };

  const scheduleRecovery = (exitCode: number | null) => {
    if (!brokerConfigStillOwned()) return;
    if (recoveryTimer) return;
    const currentTime = now();
    if (recoveryWindowStarted === null || currentTime - recoveryWindowStarted >= ORCHESTRATOR_RECOVERY_WINDOW_MS) {
      recoveryWindowStarted = currentTime;
      recoveryAttempts = 0;
    }
    if (recoveryExhausted()) return;
    // A clean exit is the normal self-update handoff. Give the replacement npx
    // process time to resolve/install and bind before deciding it needs help.
    const delay = exitCode === 0 ? recoveryDelayMs : Math.min(recoveryDelayMs, 5_000);
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (!brokerConfigStillOwned()) return;
      if (recoveryAttempts >= recoveryMaxAttempts) return;
      recoveryAttempts += 1;
      // The failed child is no longer the launch in progress. This retry is
      // explicitly allowed through the ordinary launch cooldown.
      lastLaunchAt = 0;
      void ensureRunning(true).catch(() => {
        // The next panel request can retry after the normal cooldown. A broker
        // must never become an unbounded error/spawn loop on a broken install.
      });
    }, delay);
    recoveryTimer.unref?.();
  };

  const watchLaunch = (started: TerminalLaunch) => {
    const child = started.process;
    if (!child) return;
    const onExit = (exitCode: number | null) => {
      if (launch?.process !== child) return;
      launch = null;
      scheduleRecovery(exitCode);
    };
    child.once("exit", onExit);
    child.once("error", () => onExit(null));
  };

  const ensureRunning = (fromRecovery = false) => {
    if (!starting) {
      const afterProbe = (running: boolean) => {
        // The probe is asynchronous. Uninstall may have removed ownership while
        // it was in flight; no result from that probe may publish or launch.
        if (!brokerConfigStillOwned()) {
          return { already_running: false, started: false, disabled: true };
        }
        if (running) {
          lastLaunchAt = 0;
          if (recoveryTimer) {
            clearTimeout(recoveryTimer);
            recoveryTimer = null;
          }
          resetRecoveryBudget();
          return { already_running: true, started: false };
        }
        // Panel polls are also recovery requests. Once the bounded supervisor
        // has used its budget, do not let a request after the normal launch
        // cooldown turn the same broken install into an unbounded spawn loop.
        if (!fromRecovery && recoveryExhausted()) {
          return { already_running: false, started: false, recovery_exhausted: true };
        }
        if (!fromRecovery && lastLaunchAt && now() - lastLaunchAt < 90_000) {
          return { already_running: false, started: false, start_in_progress: true };
        }
        // Serialize the final ownership check with spawn. Uninstall cannot
        // remove the tombstone/config between this check and the OS process
        // creation, including when a test seam or platform shim re-enters JS.
        const launched = withPanelLauncherLock(home, () => {
          if (!brokerConfigStillOwned()) {
            return { already_running: false, started: false, disabled: true };
          }
          lastLaunchAt = now();
          try {
            const started = launchPersistentMcp(process.platform, process.env, spawnBroker);
            launch = started;
            watchLaunch(started);
          } catch (error) {
            // Treat a spawn refusal like an immediate child failure: surface the
            // current request's error, but let the bounded supervisor make a few
            // delayed recovery attempts instead of hot-looping on every panel poll.
            scheduleRecovery(null);
            throw error;
          }
          return { already_running: false, started: true };
        });
        if (launched === null) {
          return { already_running: false, started: false, start_in_progress: true };
        }
        return launched;
      };
      const pending = brokerConfigStillOwned()
        ? probe().then(afterProbe)
        : Promise.resolve({ already_running: false, started: false, disabled: true });
      starting = pending.finally(() => {
        starting = null;
      });
    }
    return starting;
  };
  const server = createServer(async (req, res) => {
    const supplied = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice("Bearer ".length)
      : "";
    if (!safeTokenEqual(current.token, supplied)) {
      jsonResponse(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (req.method === "GET" && req.url === "/v1/status") {
      const latest = readPanelLauncherConfig(home);
      const effectiveInstallId = brokerConfigStillOwned() ? latest?.install_id : current.install_id;
      jsonResponse(res, 200, {
        ok: true,
        protocol: PANEL_LAUNCHER_PROTOCOL,
        broker_id: brokerId,
        ...(effectiveInstallId ? { install_id: effectiveInstallId } : {}),
        orchestrator_running: await probeAnyPanelOrchestrator(),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/v1/ensure-running") {
      try {
        jsonResponse(res, 200, { ok: true, protocol: PANEL_LAUNCHER_PROTOCOL, ...(await ensureRunning()) });
      } catch (error) {
        jsonResponse(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (req.method === "POST" && req.url === "/v1/handshake-complete") {
      jsonResponse(res, 200, { ok: true, minimized: minimizeOwnedTerminal(launch) });
      return;
    }
    jsonResponse(res, 404, { ok: false, error: "not_found" });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Launcher failed to bind loopback");
  options.beforeConfigWrite?.();
  if (!brokerConfigStillOwned()) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Panel launcher was uninstalled while the broker was starting");
  }
  const published = writeOwnedPanelLauncherConfig(
    {
      ...(readPanelLauncherConfig(home) ?? runtimeConfig),
      broker_id: brokerId,
      broker_executable: process.execPath,
      port: address.port,
      pid: process.pid,
      updated_at: new Date().toISOString(),
    },
    home,
    { token: current.token, installId: current.install_id, brokerId },
  );
  if (!published) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Panel launcher ownership changed before broker publication");
  }
  return server;
}

export async function queryPanelLauncher(home: string = homedir()): Promise<Record<string, unknown>> {
  const config = readPanelLauncherConfig(home);
  if (!config || !config.port) return { ok: false, installed: !!config, running: false };
  return await new Promise((resolve) => {
    const req = httpRequest(
      {
        hostname: config.host,
        port: config.port,
        path: "/v1/status",
        method: "GET",
        headers: { Authorization: `Bearer ${config.token}` },
        timeout: 1500,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
              string,
              unknown
            >;
            // 200 + parseable JSON is not proof it is OUR broker: ports get
            // recycled, and whoever holds this one next may answer anything.
            // The body already carries the protocol — check it, or the recycled-
            // port case this liveness probe exists to kill walks straight back in
            // (merge-gate). Computed AFTER the spread so the body cannot set it.
            const running = res.statusCode === 200 && body.protocol === PANEL_LAUNCHER_PROTOCOL;
            resolve({ installed: true, ...body, running });
          } catch {
            resolve({ ok: false, installed: true, running: false, error: "invalid_response" });
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve({ ok: false, installed: true, running: false }));
    req.end();
  });
}

// The installed copy is invoked directly by the login service. The source copy
// is imported by index.ts and therefore does not enter this branch.
const invokedPath = process.argv[1] ? basename(process.argv[1]) : "";
if (invokedPath === "broker.mjs" && process.argv[2] === "run") {
  const brokerArg = process.argv.slice(3).find((arg) => arg.startsWith("--broker-id="));
  const installArg = process.argv.slice(3).find((arg) => arg.startsWith("--install-id="));
  startPanelLauncherBroker(undefined, {
    expectedBrokerId: brokerArg?.slice("--broker-id=".length),
    expectedInstallId: installArg?.slice("--install-id=".length),
    enforceCommandIdentity: true,
  }).catch((error) => {
    process.stderr.write(`ComfyUI MCP launcher failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
