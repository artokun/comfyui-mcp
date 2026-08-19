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
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
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
export const DEFAULT_PANEL_BRIDGE_PORT = 9180;

export type PanelLauncherConfig = {
  protocol: 1;
  host: "127.0.0.1";
  port: number;
  token: string;
  pid?: number;
  updated_at: string;
};

export type LauncherPaths = {
  root: string;
  launcherDir: string;
  config: string;
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
  mkdirSync(paths.launcherDir, { recursive: true });
  copyFileSync(source, paths.broker);

  const previous = readPanelLauncherConfig(home);

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
    if (previous?.port) {
      const live = (await queryPanelLauncher(home)) as { running?: boolean };
      if (live.running) return; // a real broker answered — leave it alone
    }
    const child = spawnBroker(nodePath, [paths.broker, "run"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref?.();
  };
  writePanelLauncherConfig(
    {
      protocol: PANEL_LAUNCHER_PROTOCOL,
      host: "127.0.0.1",
      port: previous?.port ?? 0,
      token: previous?.token ?? randomBytes(32).toString("base64url"),
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

  if (platform === "win32") {
    writeFileSync(
      paths.windowsScript,
      `@echo off\r\n"${nodePath}" "${paths.broker}" run\r\n`,
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
      try {
        run("schtasks.exe", ["/Run", "/TN", PANEL_LAUNCHER_TASK], { stdio: "ignore" });
        return paths; // the task is registered AND running it worked
      } catch {
        // Registered but not startable right now (non-interactive session). The
        // autostart is in place for the next logon, so do NOT add a second one —
        // just get a broker up for THIS session.
      }
    }
    await startBrokerIfIdle();
    return paths;
  }

  if (platform === "darwin") {
    mkdirSync(dirname(paths.macPlist), { recursive: true });
    writeFileSync(
      paths.macPlist,
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
        `<plist version="1.0"><dict>\n` +
        `<key>Label</key><string>${PANEL_LAUNCHER_LABEL}</string>\n` +
        `<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(paths.broker)}</string><string>run</string></array>\n` +
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
    run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, paths.macPlist], { stdio: "ignore" });
    return paths;
  }

  mkdirSync(dirname(paths.linuxService), { recursive: true });
  writeFileSync(
    paths.linuxService,
    `[Unit]\nDescription=ComfyUI MCP panel launcher\n\n` +
      `[Service]\nExecStart="${nodePath}" "${paths.broker}" run\nRestart=on-failure\n\n` +
      `[Install]\nWantedBy=default.target\n`,
    "utf8",
  );
  try {
    run("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    run("systemctl", ["--user", "enable", "--now", "comfyui-mcp-launcher.service"], {
      stdio: "ignore",
    });
  } catch {
    mkdirSync(dirname(paths.linuxAutostart), { recursive: true });
    writeFileSync(
      paths.linuxAutostart,
      `[Desktop Entry]\nType=Application\nName=ComfyUI MCP Launcher\n` +
        `Exec="${nodePath}" "${paths.broker}" run\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`,
      "utf8",
    );
    await startBrokerIfIdle();
  }
  return paths;
}

export type UninstallLauncherOptions = Pick<
  InstallLauncherOptions,
  "home" | "platform" | "exec" | "appData"
>;

export function uninstallPanelLauncher(options: UninstallLauncherOptions = {}): void {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const run = options.exec ?? execFileSync;
  // Same resolution as install, or uninstall deletes a path the install never
  // wrote and leaves the real autostart in place.
  const paths = panelLauncherPaths(home, roamingAppData(options));
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
  rmSync(paths.config, { force: true });
  rmSync(paths.launcherDir, { force: true, recursive: true });
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
 *  treating any process occupying port 9180 as the orchestrator. */
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
    socket.on("data", (chunk) => {
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

export type TerminalLaunch = { process?: ChildProcess; pid?: number; platform: NodeJS.Platform };

export type TerminalCommand = { executable: string; args: string[] };

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
  return { process: child, pid: child.pid, platform };
}

function minimizeOwnedTerminal(launch: TerminalLaunch | null): boolean {
  if (!launch?.pid || launch.platform !== "win32") return false;
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

export async function startPanelLauncherBroker(home: string = homedir()): Promise<Server> {
  const current = readPanelLauncherConfig(home);
  if (!current) throw new Error("Panel launcher is not installed or its config is invalid");
  let launch: TerminalLaunch | null = null;
  let lastLaunchAt = 0;
  let starting: Promise<{ already_running: boolean; started: boolean }> | null = null;
  const ensureRunning = () => {
    if (!starting) {
      starting = probePanelOrchestrator().then((running) => {
        if (running) {
          lastLaunchAt = 0;
          return { already_running: true, started: false };
        }
        if (lastLaunchAt && Date.now() - lastLaunchAt < 90_000) {
          return { already_running: false, started: false, start_in_progress: true };
        }
        launch = launchMcpTerminal();
        lastLaunchAt = Date.now();
        return { already_running: false, started: true };
      }).finally(() => {
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
      jsonResponse(res, 200, {
        ok: true,
        protocol: PANEL_LAUNCHER_PROTOCOL,
        orchestrator_running: await probePanelOrchestrator(),
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
  writePanelLauncherConfig(
    { ...current, port: address.port, pid: process.pid, updated_at: new Date().toISOString() },
    home,
  );
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
  startPanelLauncherBroker().catch((error) => {
    process.stderr.write(`ComfyUI MCP launcher failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
