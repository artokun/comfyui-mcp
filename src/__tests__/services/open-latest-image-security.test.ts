import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../../plugin/hooks/open-latest-image.mjs", import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "");

describe("open-latest-image filename safety", () => {
  it.each(["darwin", "linux", "win32"])("passes hostile filenames as data on %s", (os) => {
    const stdin = new EventEmitter();
    const spawnSync = vi.fn();
    const execSync = vi.fn();
    const filename = 'image $(touch NEVER_RUN) & "quoted".png';
    const fakeProcess = {
      stdin: Object.assign(stdin, { setEncoding() {} }),
      env: { SystemRoot: "C:\\Windows" },
      exit: vi.fn(),
    };
    runInNewContext(source, {
      process: fakeProcess,
      readdirSync: () => [filename],
      statSync: () => ({ mtimeMs: Date.now() }),
      join: (...parts: string[]) => parts.join("/"),
      homedir: () => "/test/home",
      platform: () => os,
      execSync,
      spawnSync,
    });
    stdin.emit("data", '{"isError":false}');
    stdin.emit("end");
    expect(execSync).not.toHaveBeenCalled();
    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnSync.mock.calls[0]!;
    expect(options.shell).not.toBe(true);
    if (os === "win32") {
      expect(command).toMatch(/powershell[.]exe$/i);
      expect(args.at(-1)).toBe("Start-Process -FilePath $env:COMFYUI_MCP_OPEN_IMAGE");
      expect(args.join(" ")).not.toContain(filename);
      expect(options.env.COMFYUI_MCP_OPEN_IMAGE).toContain(filename);
    } else {
      expect(command).toBe(os === "darwin" ? "open" : "xdg-open");
      expect(args).toHaveLength(1);
      expect(args[0]).toContain(filename);
    }
  });
});
