import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("installs a stable broker, private token config, and per-user Windows task", () => {
    const { home, source } = fixture();
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const paths = installPanelLauncher({
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

  it("preserves the authentication token across reinstalls", () => {
    const { home, source } = fixture();
    const exec = (() => undefined) as never;
    installPanelLauncher({ home, platform: "win32", brokerSource: source, exec });
    const first = readPanelLauncherConfig(home)?.token;
    installPanelLauncher({ home, platform: "win32", brokerSource: source, exec });
    expect(readPanelLauncherConfig(home)?.token).toBe(first);
  });

  it("falls back to a Startup autostart when the scheduled task is DENIED", () => {
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
      paths = installPanelLauncher({
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

  it("does not start a second broker when the previous one is alive", () => {
    const { home, source } = fixture();
    const spawned: Array<readonly string[]> = [];
    installPanelLauncher({ home, platform: "win32", brokerSource: source, exec: (() => undefined) as never });
    // Claim a live broker by writing OUR pid into the config — process.kill(pid, 0)
    // succeeds for it, so the fallback must leave it alone rather than start a
    // rival that fights it for the port.
    const cfg = JSON.parse(readFileSync(panelLauncherPaths(home).config, "utf8"));
    writeFileSync(
      panelLauncherPaths(home).config,
      JSON.stringify({ ...cfg, pid: process.pid }),
      "utf8",
    );
    installPanelLauncher({
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
    expect(spawned).toEqual([]);
  });

  it("uninstall removes the Startup fallback, not just the task", () => {
    const { home, source } = fixture();
    const paths = installPanelLauncher({
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

  it("writes a Linux user service and falls back to XDG autostart", () => {
    const { home, source } = fixture();
    const paths = installPanelLauncher({
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
    installPanelLauncher({
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
  it("is fixed and always resolves the latest MCP package", () => {
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

  it("fails clearly when Linux has no supported graphical terminal", () => {
    expect(() => terminalCommandForPlatform("linux", { PATH: "/empty" }, () => false)).toThrow(
      "No supported graphical terminal",
    );
  });
});

describe("launcher paths", () => {
  it("keeps every mutable launcher artifact under the selected user home", () => {
    const { home } = fixture();
    const paths = panelLauncherPaths(home);
    expect(paths.config.startsWith(home)).toBe(true);
    expect(paths.broker.startsWith(home)).toBe(true);
  });
});
