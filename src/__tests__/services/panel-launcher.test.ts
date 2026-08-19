import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  installPanelLauncher,
  panelLauncherPaths,
  readPanelLauncherConfig,
  startPanelLauncherBroker,
  terminalCommandForPlatform,
  uninstallPanelLauncher,
} from "../../services/panel-launcher.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    uninstallPanelLauncher({ home, platform: "linux", exec: (() => undefined) as never });
  }
});

function fixture(): { home: string; source: string } {
  const home = mkdtempSync(join(tmpdir(), "cmcp-launcher-"));
  homes.push(home);
  const source = join(home, "source.mjs");
  writeFileSync(source, "// compiled standalone broker\n", "utf8");
  return { home, source };
}

describe("panel launcher install", () => {
  it("installs a stable broker, private token config, and per-user Windows task", async () => {
    const { home, source } = fixture();
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const paths = await installPanelLauncher({
      home,
      platform: "win32",
      nodePath: "C:\\Node\\node.exe",
      brokerSource: source,
      exec: ((file: string, args: readonly string[]) => {
        calls.push({ file, args });
      }) as never,
    });
    const config = readPanelLauncherConfig(home);
    expect(config).toMatchObject({ protocol: 1, host: "127.0.0.1", port: 0 });
    expect(config?.token.length).toBeGreaterThanOrEqual(32);
    expect(readFileSync(paths.broker, "utf8")).toContain("standalone broker");
    expect(readFileSync(paths.windowsScript, "utf8")).toContain(
      '"C:\\Node\\node.exe"',
    );
    expect(calls.map((call) => call.args[0])).toEqual(["/Create", "/Run"]);
  });

  it("preserves the authentication token across reinstalls", async () => {
    const { home, source } = fixture();
    const exec = (() => undefined) as never;
    await installPanelLauncher({ home, platform: "win32", brokerSource: source, exec });
    const first = readPanelLauncherConfig(home)?.token;
    await installPanelLauncher({ home, platform: "win32", brokerSource: source, exec });
    expect(readPanelLauncherConfig(home)?.token).toBe(first);
  });

  it("falls back to a Startup autostart when the scheduled task is DENIED", async () => {
    // The failure this covers is not hypothetical: on a machine whose policy or
    // task-store ACL refuses task creation to the user, `schtasks /Create` fails
    // with "ERROR: Access is denied." for ANY task name — a throwaway probe is
    // refused identically. The install had already written every file it needed
    // and then threw, so the panel's Connect button kept sending the user to an
    // install that could not succeed on that account.
    const { home, source } = fixture();
    const spawned: Array<readonly string[]> = [];
    const execOpts: Array<{ stdio?: unknown }> = [];
    const warnings: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let paths;
    try {
      paths = await installPanelLauncher({
      home,
      platform: "win32",
      nodePath: "C:\\Node\\node.exe",
      brokerSource: source,
      exec: ((_file: string, _args: readonly string[], opts: { stdio?: unknown }) => {
        execOpts.push(opts);
        const err = new Error("Command failed: schtasks.exe /Create …") as Error & {
          stderr: string;
        };
        err.stderr = "ERROR: Access is denied.\r\n";
        throw err;
      }) as never,
      spawnImpl: ((_file: string, args: readonly string[]) => {
        spawned.push(args);
        return { unref() {} };
      }) as never,
      });
    } finally {
      process.stderr.write = realWrite;
    }

    // The TOOL's own reason, not our paraphrase of it. Piping schtasks' stderr
    // is what makes this possible: with stdio "ignore" the only text available
    // was "Command failed: schtasks.exe …", which cannot tell a denial apart
    // from a bad argument or a missing binary.
    expect(warnings.join("")).toContain("Access is denied");
    // Pinned at the CALL, not just at the message: a fake exec carries a
    // `.stderr` no matter what stdio was requested, so asserting only on the
    // rendered warning cannot tell piped from swallowed — the real binary can.
    expect(execOpts[0]?.stdio).toEqual(["ignore", "ignore", "pipe"]);
    // A per-user autostart, which needs no elevation — the exact constraint the
    // scheduled task could not satisfy.
    expect(paths.windowsStartup).toContain("Startup");
    expect(readFileSync(paths.windowsStartup, "utf8")).toContain(paths.windowsScript);
    // …and the broker starts NOW, or the install "succeeds" while leaving the
    // panel with nothing to talk to until the next logon.
    expect(spawned).toEqual([[paths.broker, "run"]]);
    // The install must not throw: everything the launcher needs now exists.
    expect(readPanelLauncherConfig(home)?.token.length).toBeGreaterThanOrEqual(32);
  });

  it("does not start a second broker when one ANSWERS on the recorded port", async () => {
    const { home, source } = fixture();
    const spawned: Array<readonly string[]> = [];
    await installPanelLauncher({
      home,
      platform: "win32",
      brokerSource: source,
      exec: (() => undefined) as never,
    });
    const cfg = JSON.parse(readFileSync(panelLauncherPaths(home).config, "utf8"));

    // A broker that actually answers — the only evidence that justifies skipping
    // the spawn. Started on a real port with the config's own token.
    const server = createServer((req, res) => {
      const ok = req.headers.authorization === `Bearer ${cfg.token}`;
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok, protocol: 1, orchestrator_running: false }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    writeFileSync(
      panelLauncherPaths(home).config,
      JSON.stringify({ ...cfg, port, pid: process.pid }),
      "utf8",
    );

    try {
      await installPanelLauncher({
        home,
        platform: "win32",
        brokerSource: source,
        exec: (() => {
          throw new Error("denied");
        }) as never,
        spawnImpl: ((_file: string, args: readonly string[]) => {
          spawned.push(args);
          return { unref() {} };
        }) as never,
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(spawned).toEqual([]);
  });

  it("still finds the live broker on a SECOND install (no pid needed)", async () => {
    // The previous version of this test hand-wrote `pid: process.pid` into the
    // config immediately before installing — manufacturing the exact state that
    // install itself destroys, and so blind by construction to the real bug:
    // the config write dropped `pid`, the liveness guard required one, and every
    // install after the first skipped the query and spawned a duplicate broker
    // beside a live one. Here the config is only ever written by the code under
    // test (merge-gate P1).
    const { home, source } = fixture();
    const spawned: Array<readonly string[]> = [];
    const denied = (() => {
      throw new Error("denied");
    }) as never;
    const record = ((_file: string, args: readonly string[]) => {
      spawned.push(args);
      return { unref() {} };
    }) as never;

    await installPanelLauncher({ home, platform: "win32", brokerSource: source, exec: denied, spawnImpl: record });
    const cfg = JSON.parse(readFileSync(panelLauncherPaths(home).config, "utf8"));
    const server = createServer((req, res) => {
      const ok = req.headers.authorization === `Bearer ${cfg.token}`;
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok, protocol: 1, orchestrator_running: false }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    // Exactly what a live broker publishes: its port and pid, nothing hand-made.
    writeFileSync(
      panelLauncherPaths(home).config,
      JSON.stringify({ ...cfg, port, pid: process.pid }),
      "utf8",
    );

    try {
      spawned.length = 0;
      await installPanelLauncher({ home, platform: "win32", brokerSource: source, exec: denied, spawnImpl: record });
      expect(spawned, "second install spawned a rival broker").toEqual([]);
      // …and the install must not have erased the pid for the NEXT one either.
      expect(readPanelLauncherConfig(home)?.pid).toBe(process.pid);
      spawned.length = 0;
      await installPanelLauncher({ home, platform: "win32", brokerSource: source, exec: denied, spawnImpl: record });
      expect(spawned, "third install spawned a rival broker").toEqual([]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("an UNWRITABLE Startup folder still leaves this session with a broker", async () => {
    // EDR/AppLocker blocking Startup persistence, or Roaming AppData redirected
    // to an offline share — the same managed accounts whose policy denied the
    // task in the first place. Unguarded, the write threw before the broker was
    // started and the session got nothing: #1798's stranding loop moved from the
    // schtasks line to the Startup line. Losing the autostart is survivable;
    // losing the broker is the bug this whole path exists to fix.
    const { home, source } = fixture();
    const spawned: Array<readonly string[]> = [];
    // A FILE where the Startup tree needs directories → mkdirSync throws ENOTDIR.
    const blocked = join(home, "blocked-appdata");
    writeFileSync(blocked, "not a directory", "utf8");
    const paths = await installPanelLauncher({
      home,
      appData: blocked,
      platform: "win32",
      brokerSource: source,
      exec: (() => {
        throw new Error("denied");
      }) as never,
      spawnImpl: ((_file: string, args: readonly string[]) => {
        spawned.push(args);
        return { unref() {} };
      }) as never,
    });
    expect(existsSync(paths.windowsStartup)).toBe(false);
    expect(spawned, "install threw before starting a broker").toEqual([[paths.broker, "run"]]);
  });

  it("the PORT is the evidence — a live broker with no pid recorded still counts", async () => {
    // The pid is not evidence of anything the query needs: it is the port and
    // token that get asked. A config carrying a port but no pid — an older
    // broker, or any write that did not publish one — must not send us spawning
    // a rival on top of a broker that is plainly answering.
    const { home, source } = fixture();
    const spawned: Array<readonly string[]> = [];
    await installPanelLauncher({
      home,
      platform: "win32",
      brokerSource: source,
      exec: (() => undefined) as never,
    });
    const cfg = JSON.parse(readFileSync(panelLauncherPaths(home).config, "utf8"));
    const server = createServer((req, res) => {
      const ok = req.headers.authorization === `Bearer ${cfg.token}`;
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok, protocol: 1, orchestrator_running: true }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const { pid: _dropped, ...noPid } = { ...cfg, port } as Record<string, unknown>;
    writeFileSync(panelLauncherPaths(home).config, JSON.stringify(noPid), "utf8");
    try {
      await installPanelLauncher({
        home,
        platform: "win32",
        brokerSource: source,
        exec: (() => {
          throw new Error("denied");
        }) as never,
        spawnImpl: ((_file: string, args: readonly string[]) => {
          spawned.push(args);
          return { unref() {} };
        }) as never,
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(spawned).toEqual([]);
  });

  it("a stranger on the recycled port is not mistaken for our broker", async () => {
    const { home, source } = fixture();
    const spawned: Array<readonly string[]> = [];
    await installPanelLauncher({
      home,
      platform: "win32",
      brokerSource: source,
      exec: (() => undefined) as never,
    });
    const cfg = JSON.parse(readFileSync(panelLauncherPaths(home).config, "utf8"));
    // 200 + parseable JSON, but not our protocol — ports get recycled and the
    // next holder may answer anything at all.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hello: "some other service" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    writeFileSync(
      panelLauncherPaths(home).config,
      JSON.stringify({ ...cfg, port, pid: process.pid }),
      "utf8",
    );
    try {
      await installPanelLauncher({
        home,
        platform: "win32",
        brokerSource: source,
        exec: (() => {
          throw new Error("denied");
        }) as never,
        spawnImpl: ((_file: string, args: readonly string[]) => {
          spawned.push(args);
          return { unref() {} };
        }) as never,
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(spawned).toEqual([[panelLauncherPaths(home).broker, "run"]]);
  });

  it("a /Create failure with the task ALREADY registered adds no second autostart", async () => {
    // /Create failing does not prove the account cannot register a task: the Task
    // Scheduler service stopped or set to Manual, RPC unavailable, or a GPO
    // applied after an earlier successful install all fail while leaving a live
    // registered task. Writing the Startup entry anyway put it beside that task
    // and both fired at logon — two brokers racing on launcher.json.
    const { home, source } = fixture();
    const spawned: Array<readonly string[]> = [];
    const seen: string[] = [];
    const paths = await installPanelLauncher({
      home,
      platform: "win32",
      brokerSource: source,
      exec: ((_file: string, args: readonly string[]) => {
        seen.push(String(args[0]));
        if (args[0] === "/Create") throw new Error("The Task Scheduler service is not available.");
        return undefined; // /Query succeeds → the task exists
      }) as never,
      spawnImpl: ((_file: string, args: readonly string[]) => {
        spawned.push(args);
        return { unref() {} };
      }) as never,
    });
    expect(seen).toContain("/Query");
    expect(existsSync(paths.windowsStartup), "wrote a duplicate autostart").toBe(false);
  });

  it("DOES start one when the pid is alive but nothing answers (recycled pid)", async () => {
    const { home, source } = fixture();
    const spawned: Array<readonly string[]> = [];
    await installPanelLauncher({
      home,
      platform: "win32",
      brokerSource: source,
      exec: (() => undefined) as never,
    });
    // Windows recycles pids aggressively across a reboot, so an unrelated
    // process can be wearing the pid we recorded. Trusting `process.kill(pid, 0)`
    // meant spawning NOTHING while the config still advertised a dead port — the
    // panel then reports the launcher as not running and sends the user back to
    // the install they just ran: #1798's loop, re-entered through its own fix.
    const cfg = JSON.parse(readFileSync(panelLauncherPaths(home).config, "utf8"));
    writeFileSync(
      panelLauncherPaths(home).config,
      // OUR pid (certainly alive) + a port with no listener.
      JSON.stringify({ ...cfg, pid: process.pid, port: 9 }),
      "utf8",
    );
    await installPanelLauncher({
      home,
      platform: "win32",
      brokerSource: source,
      exec: (() => {
        throw new Error("denied");
      }) as never,
      spawnImpl: ((_file: string, args: readonly string[]) => {
        spawned.push(args);
        return { unref() {} };
      }) as never,
    });
    expect(spawned).toEqual([[panelLauncherPaths(home).broker, "run"]]);
  });

  it("puts the Startup entry under %APPDATA%, not a manufactured profile path", async () => {
    // Group Policy "Redirect the Roaming AppData folder" points %APPDATA% at a
    // share while USERPROFILE stays local — the same managed-domain population
    // whose policy denies schtasks. Deriving the path from home would create a
    // folder Explorer never scans and still report success.
    const { home, source } = fixture();
    const redirected = join(home, "redirected-appdata");
    const paths = await installPanelLauncher({
      home,
      appData: redirected,
      platform: "win32",
      brokerSource: source,
      exec: (() => {
        throw new Error("denied");
      }) as never,
      spawnImpl: (() => ({ unref() {} })) as never,
    });
    expect(paths.windowsStartup.startsWith(redirected)).toBe(true);
    expect(existsSync(paths.windowsStartup)).toBe(true);
    // …and uninstall resolves the SAME root, or it deletes a path the install
    // never wrote and leaves the real autostart running.
    uninstallPanelLauncher({
      home,
      appData: redirected,
      platform: "win32",
      exec: (() => undefined) as never,
    });
    expect(existsSync(paths.windowsStartup)).toBe(false);
  });

  it("a task that registers but cannot RUN right now gets no second autostart", async () => {
    // /Create and /Run fail for different reasons. An /IT task invoked over a
    // non-interactive session (OpenSSH, WinRM, a CI service) is created fine and
    // refuses to run right now — SCHED_E_TASK_NOT_READY. Treating that as "the
    // account cannot register an autostart" wrote a Startup entry beside the live
    // task, so every later logon started TWO brokers, both rewriting
    // launcher.json.
    const { home, source } = fixture();
    const spawned: Array<readonly string[]> = [];
    const paths = await installPanelLauncher({
      home,
      platform: "win32",
      brokerSource: source,
      exec: ((_file: string, args: readonly string[]) => {
        if (args[0] === "/Run") throw new Error("The task cannot be run…");
        return undefined;
      }) as never,
      spawnImpl: ((_file: string, args: readonly string[]) => {
        spawned.push(args);
        return { unref() {} };
      }) as never,
    });
    // The task IS registered — no duplicate autostart.
    expect(existsSync(paths.windowsStartup)).toBe(false);
    // …but this session still needs a broker, since /Run did not give it one.
    expect(spawned).toEqual([[paths.broker, "run"]]);
  });

  it("uninstall removes the Startup fallback, not just the task", async () => {
    const { home, source } = fixture();
    const paths = await installPanelLauncher({
      home,
      platform: "win32",
      brokerSource: source,
      exec: (() => {
        throw new Error("denied");
      }) as never,
      spawnImpl: (() => ({ unref() {} })) as never,
    });
    expect(readFileSync(paths.windowsStartup, "utf8")).toContain(paths.windowsScript);
    uninstallPanelLauncher({ home, platform: "win32", exec: (() => undefined) as never });
    // Removing only the task would leave exactly the accounts that needed the
    // fallback with a launcher that survives every uninstall.
    expect(existsSync(paths.windowsStartup)).toBe(false);
  });

  it("writes a Linux user service and falls back to XDG autostart", async () => {
    const { home, source } = fixture();
    const paths = await installPanelLauncher({
      home,
      platform: "linux",
      nodePath: process.execPath,
      brokerSource: source,
      exec: (() => {
        throw new Error("no systemd user session");
      }) as never,
    });
    expect(readFileSync(paths.linuxService, "utf8")).toContain("ExecStart=");
    expect(readFileSync(paths.linuxAutostart, "utf8")).toContain("X-GNOME-Autostart-enabled=true");
  });
});

describe("panel launcher broker", () => {
  it("binds loopback and rejects requests without the private bearer token", async () => {
    const { home, source } = fixture();
    await installPanelLauncher({
      home,
      platform: "win32",
      brokerSource: source,
      exec: (() => undefined) as never,
    });
    const server = await startPanelLauncherBroker(home);
    try {
      const config = readPanelLauncherConfig(home)!;
      const base = `http://127.0.0.1:${config.port}`;
      const denied = await fetch(`${base}/v1/status`);
      expect(denied.status).toBe(401);
      const accepted = await fetch(`${base}/v1/status`, {
        headers: { Authorization: `Bearer ${config.token}` },
      });
      expect(accepted.status).toBe(200);
      const body = await accepted.json() as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, protocol: 1 });
      expect(body).not.toHaveProperty("token");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("native terminal command", () => {
  it("is fixed and always resolves the latest MCP package", async () => {
    expect(terminalCommandForPlatform("win32", { ComSpec: "cmd.exe" })).toEqual({
      executable: "cmd.exe",
      args: ["/d", "/k", "npx.cmd -y comfyui-mcp@latest connect"],
    });
    expect(terminalCommandForPlatform("darwin").args.join(" ")).toContain(
      "npx -y comfyui-mcp@latest connect",
    );
    expect(
      terminalCommandForPlatform("linux", { PATH: "/bin" }, (path) => path.endsWith("kgx")),
    ).toEqual({
      executable: "kgx",
      args: ["--", "sh", "-lc", "exec npx -y comfyui-mcp@latest connect"],
    });
  });

  it("fails clearly when Linux has no supported graphical terminal", async () => {
    expect(() => terminalCommandForPlatform("linux", { PATH: "/empty" }, () => false)).toThrow(
      "No supported graphical terminal",
    );
  });
});

describe("launcher paths", () => {
  it("keeps every mutable launcher artifact under the selected user home", async () => {
    const { home } = fixture();
    const paths = panelLauncherPaths(home);
    expect(paths.config.startsWith(home)).toBe(true);
    expect(paths.broker.startsWith(home)).toBe(true);
    // The one that escaped: a one-arg call must NOT resolve the Startup entry
    // to the real user's %APPDATA%, or a sandboxed caller writes a persistent
    // autostart outside the home it chose.
    expect(paths.windowsStartup.startsWith(home)).toBe(true);
  });
});
