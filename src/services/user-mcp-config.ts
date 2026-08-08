// Read and write the user's Claude Code MCP-server config (~/.claude.json), so
// the panel orchestrator's background agent uses the SAME MCP servers the user's
// normal `claude` session does — and can ADD new ones programmatically (e.g.
// connect the CivitAI MCP on demand), persisting them to the user's real config.
//
// MCP servers live at the top level of ~/.claude.json under `mcpServers`, keyed
// by name; each value is a Claude Agent SDK server config (stdio | sse | http).
// We deliberately EXCLUDE any entry that looks like a comfyui-mcp instance — the
// orchestrator injects its own bridge-safe comfyui server, and a second one
// would fight for the panel bridge port.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../utils/logger.js";

/** A Claude Agent SDK MCP server config (stdio / sse / http). Opaque here. */
export type McpServerConfig = Record<string, unknown>;

/** Path to the user's Claude config. Overridable for tests. */
export function claudeJsonPath(): string {
  return process.env.COMFYUI_MCP_CLAUDE_JSON || join(homedir(), ".claude.json");
}

/**
 * Load the user's Claude config, distinguishing ABSENT from UNREADABLE (#796).
 *
 * `{}` is the right answer for a file that is not there. It is the WRONG answer
 * for one that exists and could not be read — and here that difference destroys
 * data, because every mutation below is a read-modify-WRITE:
 *
 *     const cfg = readClaudeJson();   // {} after a failed parse — the OLD shape
 *     cfg.mcpServers = servers;
 *     writeFileSync(claudeJsonPath(), JSON.stringify(cfg, null, 2));
 *
 * `~/.claude.json` is the user's entire Claude Code configuration — every MCP
 * server, plus whatever secrets other tools have written into `headers`/`env`
 * (this file writes them there itself). One hand-edit with a trailing comma, or
 * one transient read error, and adding a single MCP server replaced all of it.
 *
 * It is also NOT OUR FILE, which decides the remedy: unlike our own configs we do
 * not move it aside, because another program expects it at that exact path.
 * Refusing to write is the only safe move.
 */
function loadClaudeJson(): { cfg: Record<string, unknown>; unreadable?: string } {
  const p = claudeJsonPath();
  if (!existsSync(p)) return { cfg: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { cfg: parsed as Record<string, unknown> };
    }
    return { cfg: {}, unreadable: "it is valid JSON but not an object" };
  } catch (err) {
    logger.warn(
      `[user-mcp] could not parse ${p}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { cfg: {}, unreadable: err instanceof Error ? err.message : String(err) };
  }
}

/** The lenient read, for QUERIES. An unreadable config reads as "no servers",
 *  which is a wrong answer but not a destructive one — see readUserMcpServers. */
function readClaudeJson(): Record<string, unknown> {
  return loadClaudeJson().cfg;
}

/**
 * The read that precedes a WRITE. Refuses rather than handing back an empty
 * object that the caller would then persist over the user's real config.
 */
function readClaudeJsonForMutation(): Record<string, unknown> {
  const { cfg, unreadable } = loadClaudeJson();
  if (unreadable !== undefined) {
    throw new Error(
      `Refusing to modify ${claudeJsonPath()}: it exists but could not be read (${unreadable}). ` +
        `Writing would replace your whole Claude configuration — every MCP server, and any ` +
        `credentials stored in a server's headers/env — with just this change. Fix that file ` +
        `(a trailing comma is the usual cause) and try again; nothing has been changed.`,
    );
  }
  return cfg;
}

function serversObject(cfg: Record<string, unknown>): Record<string, McpServerConfig> {
  const m = cfg.mcpServers;
  return m && typeof m === "object" ? (m as Record<string, McpServerConfig>) : {};
}

/**
 * Would this server fight our own comfyui server for the bridge port? True for
 * anything named "comfyui" or whose config invokes comfyui-mcp.
 */
export function isConflictingServer(name: string, cfg: unknown): boolean {
  if (name.toLowerCase() === "comfyui") return true;
  const s = JSON.stringify(cfg ?? "").toLowerCase();
  return s.includes("comfyui-mcp");
}

/**
 * The user's configured MCP servers (user scope), minus anything that conflicts
 * with our injected comfyui server. This is what the panel agent inherits.
 */
export function readUserMcpServers(): Record<string, McpServerConfig> {
  const servers = serversObject(readClaudeJson());
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (isConflictingServer(name, cfg)) continue;
    out[name] = cfg;
  }
  return out;
}

const NAME_RE = /^[\w.-]+$/;

/**
 * Add (or replace) an MCP server in the user's Claude config, persisting it so
 * both the panel agent (after a reload) and the user's normal session see it.
 * Refuses conflicting names so we can't accidentally clobber the bridge.
 */
export function addUserMcpServer(name: string, config: McpServerConfig): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid MCP server name "${name}" (use letters, digits, dot, dash, underscore).`);
  }
  if (isConflictingServer(name, config)) {
    throw new Error(`Refusing to add "${name}" — it conflicts with the panel's own comfyui server.`);
  }
  const cfg = readClaudeJsonForMutation();
  const servers = serversObject(cfg);
  servers[name] = config;
  cfg.mcpServers = servers;
  writeFileSync(claudeJsonPath(), JSON.stringify(cfg, null, 2));
}

/** Where a secret value should be written on an MCP server. */
export interface McpSecretTarget {
  /** "header" → server.headers[key] (http/sse); "env" → server.env[key] (stdio). */
  kind: "header" | "env";
  /** The MCP server name (must already exist). */
  server: string;
  /** Header name (e.g. "Authorization") or env var name (e.g. "CIVITAI_API_TOKEN"). */
  key: string;
  /** Optional string prepended to the value, e.g. "Bearer ". */
  prefix?: string;
}

/**
 * Write a secret onto an existing MCP server (a header for http/sse, or an env
 * var for stdio), persisting to ~/.claude.json. The caller passes the raw secret
 * straight from the secure input; it is never logged or returned anywhere.
 */
export function setUserMcpServerSecret(target: McpSecretTarget, value: string): void {
  const cfg = readClaudeJsonForMutation();
  const servers = serversObject(cfg);
  const server = servers[target.server];
  if (!server || typeof server !== "object") {
    throw new Error(`MCP server "${target.server}" is not configured — add it first with panel_add_mcp.`);
  }
  const bag = target.kind === "header" ? "headers" : "env";
  const s = server as Record<string, unknown>;
  const existing = s[bag] && typeof s[bag] === "object" ? (s[bag] as Record<string, string>) : {};
  existing[target.key] = `${target.prefix ?? ""}${value}`;
  s[bag] = existing;
  servers[target.server] = s;
  cfg.mcpServers = servers;
  writeFileSync(claudeJsonPath(), JSON.stringify(cfg, null, 2));
}

/** Remove an MCP server from the user's config. Returns false if absent. */
export function removeUserMcpServer(name: string): boolean {
  const cfg = readClaudeJsonForMutation();
  const servers = serversObject(cfg);
  if (!(name in servers)) return false;
  delete servers[name];
  cfg.mcpServers = servers;
  writeFileSync(claudeJsonPath(), JSON.stringify(cfg, null, 2));
  return true;
}
