// #796's class where it costs the most: a file we do not own.
//
// `readClaudeJson()` returned `{}` for BOTH "there is no config" and "there is a
// config and I could not read it". Every mutation here is a read-modify-WRITE:
//
//     const cfg = readClaudeJson();                    // {} after a failed parse
//     cfg.mcpServers = servers;
//     writeFileSync(claudeJsonPath(), JSON.stringify(cfg, null, 2));
//
// So one hand-edit with a trailing comma, or one transient read error, and adding
// a single MCP server REPLACED the user's entire ~/.claude.json — every server
// they had configured, plus any credentials other tools (and this very file) had
// written into a server's `headers`/`env`.
//
// The remedy differs from our own configs on purpose. We do not move this file
// aside, because it is not ours and another program expects it at that exact
// path. Refusing to write is the only safe move, and the values the caller was
// trying to set are simply not persisted.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addUserMcpServer,
  removeUserMcpServer,
  setUserMcpServerSecret,
  readUserMcpServers,
} from "../../services/user-mcp-config.js";

let dir: string;
let cfgPath: string;
const OLD_ENV = process.env.COMFYUI_MCP_CLAUDE_JSON;

/** A real-looking config: other tools' servers, and a stored credential. */
const HEALTHY = JSON.stringify(
  {
    numStartups: 42,
    mcpServers: {
      civitai: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer KEEP-ME" } },
      other: { command: "node", args: ["x.js"] },
    },
    projects: { "/some/project": { history: ["a", "b"] } },
  },
  null,
  2,
);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmcp-claudejson-"));
  cfgPath = join(dir, ".claude.json");
  process.env.COMFYUI_MCP_CLAUDE_JSON = cfgPath;
});

afterEach(() => {
  if (OLD_ENV === undefined) delete process.env.COMFYUI_MCP_CLAUDE_JSON;
  else process.env.COMFYUI_MCP_CLAUDE_JSON = OLD_ENV;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("an unreadable ~/.claude.json is never overwritten", () => {
  // The exact reported shape: a config that is ALMOST valid.
  const TRAILING_COMMA = '{ "mcpServers": { "civitai": { "type": "http" } }, }';

  it("refuses to add a server rather than replacing the whole config", () => {
    writeFileSync(cfgPath, TRAILING_COMMA);

    expect(() => addUserMcpServer("newthing", { command: "node" })).toThrow(/Refusing to modify/);
    // The user's file is byte-identical — nothing was written.
    expect(readFileSync(cfgPath, "utf-8")).toBe(TRAILING_COMMA);
  });

  it("refuses to write a secret rather than replacing the whole config", () => {
    writeFileSync(cfgPath, TRAILING_COMMA);

    expect(() =>
      setUserMcpServerSecret({ kind: "header", server: "civitai", key: "Authorization" }, "s3cret"),
    ).toThrow(/Refusing to modify/);
    expect(readFileSync(cfgPath, "utf-8")).toBe(TRAILING_COMMA);
    // And the value never reaches the file (nor this assertion's failure output).
    expect(readFileSync(cfgPath, "utf-8")).not.toContain("s3cret");
  });

  it("refuses to remove a server rather than replacing the whole config", () => {
    writeFileSync(cfgPath, TRAILING_COMMA);

    expect(() => removeUserMcpServer("civitai")).toThrow(/Refusing to modify/);
    expect(readFileSync(cfgPath, "utf-8")).toBe(TRAILING_COMMA);
  });

  it("explains what would have been lost, so the refusal is actionable", () => {
    writeFileSync(cfgPath, TRAILING_COMMA);

    expect(() => addUserMcpServer("x", { command: "node" })).toThrow(/whole Claude configuration/);
    expect(() => addUserMcpServer("x", { command: "node" })).toThrow(/nothing has been changed/);
  });

  it("refuses on valid JSON that is not an object", () => {
    writeFileSync(cfgPath, JSON.stringify(["not", "a", "config"]));

    expect(() => addUserMcpServer("x", { command: "node" })).toThrow(/Refusing to modify/);
  });
});

describe("the healthy paths are untouched", () => {
  it("still adds a server, preserving everything else in the file", () => {
    writeFileSync(cfgPath, HEALTHY);

    addUserMcpServer("newthing", { command: "node", args: ["y.js"] });

    const after = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(after.mcpServers.newthing).toEqual({ command: "node", args: ["y.js"] });
    // The parts we must not disturb.
    expect(after.numStartups).toBe(42);
    expect(after.projects["/some/project"].history).toEqual(["a", "b"]);
    expect(after.mcpServers.civitai.headers.Authorization).toBe("Bearer KEEP-ME");
  });

  it("still writes into a MISSING config — absent is not unreadable", () => {
    addUserMcpServer("newthing", { command: "node" });

    expect(JSON.parse(readFileSync(cfgPath, "utf-8")).mcpServers.newthing).toEqual({
      command: "node",
    });
  });

  it("still removes a server, and reports absence without writing", () => {
    writeFileSync(cfgPath, HEALTHY);

    expect(removeUserMcpServer("nope")).toBe(false);
    expect(removeUserMcpServer("other")).toBe(true);

    const after = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(after.mcpServers.other).toBeUndefined();
    expect(after.mcpServers.civitai).toBeTruthy();
  });

  // The QUERY path stays lenient on purpose: an unreadable config reads as "no
  // servers", which is a wrong answer but not a destructive one, and throwing
  // here would break agent spawn for anyone with a malformed file.
  it("reading servers from an unreadable config yields none rather than throwing", () => {
    writeFileSync(cfgPath, "{ broken");

    expect(() => readUserMcpServers()).not.toThrow();
    expect(readUserMcpServers()).toEqual({});
  });
});
