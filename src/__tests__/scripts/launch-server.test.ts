// #1447 — the plugin's .mcp.json ran `npx -y comfyui-mcp --full` directly, so a
// cold npx cache downloaded the whole dependency tree inside the client's MCP
// handshake timeout; the kill discarded the partial install and every retry
// paid full price again. The fix is a launcher (plugin/scripts/launch-server.mjs)
// that prefers a globally installed comfyui-mcp (warm, sub-second) and falls
// back to the original npx invocation when there isn't one.
//
// The decisions are exercised against the REAL exports — the launcher is
// import-safe by design, so importing it here is also the proof that importing
// it spawns nothing.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const launcher = await import("../../../plugin/scripts/launch-server.mjs");
const { globalEntry, serverSpec } = launcher as {
  globalEntry: (stdout: unknown, opts?: { exists?: (p: string) => boolean }) => string | null;
  serverSpec: (
    entry: string | null,
    extraArgs: string[],
    opts?: { platform?: string; node?: string },
  ) => { command: string; args: string[]; shell: boolean };
};

const mcpJson = (): { comfyui: { command: string; args: string[] } } =>
  JSON.parse(readFileSync(new URL("../../../plugin/.mcp.json", import.meta.url), "utf8"));

describe("launch-server global resolution (#1447)", () => {
  it("resolves the global entry point when the install is present", () => {
    const entry = globalEntry("/usr/local/lib/node_modules\n", { exists: () => true });
    expect(entry).toMatch(/node_modules[\\/]comfyui-mcp[\\/]dist[\\/]index\.js$/);
  });

  it("returns null — the npx path — when npm output is unusable", () => {
    for (const bad of [null, undefined, "", "  \n", 42]) {
      expect(globalEntry(bad, { exists: () => true })).toBeNull();
    }
  });

  it("returns null when the global install is absent or lacks dist/index.js", () => {
    expect(globalEntry("/usr/local/lib/node_modules", { exists: () => false })).toBeNull();
  });

  it("checks for the entry under the probed root, not a hardcoded prefix", () => {
    let checked = "";
    globalEntry("C:\\Users\\u\\AppData\\Roaming\\npm", {
      exists: (p: string) => {
        checked = p;
        return false;
      },
    });
    expect(checked).toMatch(/^C:[\\/]Users[\\/]u[\\/]AppData[\\/]Roaming[\\/]npm[\\/]/);
  });
});

describe("launch-server spawn spec (#1447)", () => {
  it("warm path: spawns node on the resolved entry, no shell", () => {
    const spec = serverSpec("/global/node_modules/comfyui-mcp/dist/index.js", ["--full"], {
      platform: "linux",
      node: "/usr/bin/node",
    });
    expect(spec).toEqual({
      command: "/usr/bin/node",
      args: ["/global/node_modules/comfyui-mcp/dist/index.js", "--full"],
      shell: false,
    });
  });

  it("fallback is exactly the pre-fix invocation, with the plugin's args preserved", () => {
    const spec = serverSpec(null, ["--full"], { platform: "linux" });
    expect(spec.command).toBe("npx");
    expect(spec.args).toEqual(["-y", "comfyui-mcp", "--full"]);
    expect(spec.shell).toBe(false);
  });

  it("fallback on Windows is one validated command string — no DEP0190, no unsafe tokens", () => {
    // Node refuses to spawn npx.cmd without a shell since the 18.20.2/20.12.2
    // bat-file fix, and shell + an args array warns DEP0190 on every launch
    // (args are concatenated unescaped). So the Windows spec concatenates
    // itself, after validating every token.
    const spec = serverSpec(null, ["--full"], { platform: "win32" });
    expect(spec).toEqual({ command: "npx -y comfyui-mcp --full", args: [], shell: true });
    // …and it refuses loudly rather than letting a shell metacharacter through.
    expect(() => serverSpec(null, ["--full; rm -rf /"], { platform: "win32" })).toThrow(
      /unsafe shell token/,
    );
    expect(() => serverSpec(null, ['--name "x"'], { platform: "win32" })).toThrow(
      /unsafe shell token/,
    );
    // POSIX keeps the args array and no shell at all.
    expect(serverSpec(null, [], { platform: "darwin" })).toEqual({
      command: "npx",
      args: ["-y", "comfyui-mcp"],
      shell: false,
    });
  });
});

describe("plugin/.mcp.json (#1447)", () => {
  it("launches the wrapper via the plugin root, not npx", () => {
    const cfg = mcpJson().comfyui;
    expect(cfg.command).toBe("node");
    expect(cfg.args[0]).toBe("${CLAUDE_PLUGIN_ROOT}/scripts/launch-server.mjs");
  });

  it("still starts the server in --full mode", () => {
    expect(mcpJson().comfyui.args).toContain("--full");
  });

  it("the wrapper is import-safe — side effects sit behind the main guard", () => {
    // The dynamic import at the top of this file is the behavioural half: had
    // main() run, the test process would have spawned an npx install. This
    // pins the source shape that makes the import safe.
    const src = readFileSync(
      new URL("../../../plugin/scripts/launch-server.mjs", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
    expect(src).toMatch(/if \(isMain\) \{/);
  });

  it("the wrapper never writes to stdout — stdio is the MCP transport", () => {
    const src = readFileSync(
      new URL("../../../plugin/scripts/launch-server.mjs", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/console\.log\(/);
    expect(src).not.toMatch(/process\.stdout\.write\(/);
    // stdio must be inherited verbatim, or the handshake frames never reach the client.
    expect(src).toMatch(/stdio: "inherit"/);
  });
});
