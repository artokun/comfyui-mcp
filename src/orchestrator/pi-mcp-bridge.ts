// pi.dev MCP-bridge DETECTION (#2996) — "does THIS pi install have an MCP client
// that the user has pointed at servers?", answered from disk only, in the same
// mirror-pi's-own-resolution style as pi-credentials.ts.
//
// Why this exists: the panel appends PI_CAPABILITY_OVERRIDE to every pi turn,
// telling the model that pi "has NO ComfyUI tools … NONE of them exist in your
// runtime". That was transcribed from a STOCK pi, which had no MCP client. It is
// false in two situations that are now common:
//
//   1. the `pi-mcp-adapter` extension (npm:pi-mcp-adapter) is installed as a pi
//      package. It surfaces the user's MCP servers through ONE proxy tool named
//      `mcp` (search / describe / call), or as direct tools for a server that
//      declares `directTools`;
//   2. pi 0.99+ ships built-in MCP: `pi mcp add` writes `~/.pi/agent/mcp.json`,
//      and each server tool is registered as `mcp__<server>__<tool>`, reached by
//      default through `codemode` (or `tool_search` / direct per `exposure`).
//
// In both, `pi --mode json` loads extensions (we never pass --no-extensions or
// --no-mcp), so the bridge is live in panel turns. A user who wired the comfyui
// stdio server or the panel HTTP MCP into it asks for canvas work and is told,
// by OUR prompt, that no such tool exists — and the model obeys. That is the
// mirror image of the defect NO_PANEL_TOOLS_OVERRIDE guards (#804's shape, the
// other way round): denying a capability the user has.
//
// Sources (re-verify against these, not against memory):
//   earendil-works/pi  packages/coding-agent/docs/mcp.md      — mcp.json location + shape,
//                                                               `mcp__<server>__<tool>`,
//                                                               "-builtin:mcp" disables it
//   earendil-works/pi  packages/coding-agent/docs/settings.md — `packages` / `extensions`
//   earendil-works/pi  packages/coding-agent/docs/packages.md — a package is a string
//                                                               source or `{ source, … }`
//   nicobailon/pi-mcp-adapter docs/configuration.md           — files it reads, precedence,
//                                                               it replaces builtin:mcp
//
// PRECISION BAR (deliberate, and asymmetric on purpose): the two verdicts fail in
// opposite directions, and they are not equally bad.
//
//   - false NEGATIVE (bridge present, we say none): the current bug. The model is
//     ordered to refuse canvas work and to tell the user to switch backends.
//   - false POSITIVE (we say "a bridge may be present"): the honest note that
//     replaces the retraction does NOT assert tools exist — it says any MCP tools
//     come from the user's own bridge and that the model must go by the tool list
//     it was actually handed, saying plainly if none is there. A stock pi handed
//     that note behaves exactly as it does under the hard retraction.
//
// So "bridge present" means: a plausible, WELL-FORMED, PRESENT bridge on disk —
// an adapter package listed in pi's settings, or built-in MCP not disabled — AND
// at least one enabled server in a file that bridge reads. Whether the server
// actually starts, authenticates, or exposes the tool the user wants is invisible
// from disk and is deliberately left to the model's own tool list.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { piAgentDir, stripJsonComments } from "./pi-credentials.js";

/** Which bridge put MCP tools into pi's runtime. */
export type PiMcpBridgeKind = "pi-mcp-adapter" | "builtin";

export interface PiMcpBridge {
  kind: PiMcpBridgeKind;
  /** Enabled server names, in file order, de-duplicated. Never empty. */
  servers: string[];
}

/**
 * Read a pi config file the way pi does (UTF-8, leading BOM stripped, JSONC
 * comments removed — pi's settings/mcp readers accept both) and parse it as a
 * plain object. Null for missing, unreadable, malformed, or non-object content.
 * BOM tolerance matters here for the same reason as #2995: on Windows a
 * PowerShell-written mcp.json carries U+FEFF and `JSON.parse` throws on it.
 */
function readJsonObject(file: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(raw));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The `source` string of each entry in pi's `packages` setting. pi accepts a bare
 * string (`"npm:pi-mcp-adapter@2.24.0"`) or an object with `source` (packages.md).
 */
function packageSources(settings: Record<string, unknown> | null): string[] {
  const packages = settings?.packages;
  if (!Array.isArray(packages)) return [];
  const out: string[] = [];
  for (const entry of packages) {
    if (typeof entry === "string") out.push(entry);
    else if (isPlainObject(entry) && typeof entry.source === "string")
      out.push(entry.source);
  }
  return out;
}

/**
 * Whether a package source names the MCP adapter. Matches the npm name with or
 * without a version/tag (`npm:pi-mcp-adapter`, `npm:pi-mcp-adapter@2.24.0`), and
 * its git form (`git:github.com/nicobailon/pi-mcp-adapter`, a GitHub URL). A
 * local-path source whose last segment is the package is accepted too. Exported
 * for the tests; the bar is "pi would load this as pi-mcp-adapter", nothing wider.
 */
export function isMcpAdapterPackageSource(source: string): boolean {
  const s = source.trim();
  if (!s) return false;
  // npm:<name>[@<version|tag>] — the name must be exactly pi-mcp-adapter.
  const npm = /^npm:(?:@[^/@]+\/)?([^@/]+)(?:@.+)?$/.exec(s);
  if (npm) return npm[1] === "pi-mcp-adapter";
  // git / URL / local path: the final path segment names the package, minus a
  // `.git` suffix and minus a git ref — `git:github.com/nicobailon/pi-mcp-adapter@v1`
  // is the documented pinned form (packages.md), and pi identifies a git package
  // by its URL without the ref.
  const last = s
    .replace(/[?#].*$/, "")
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();
  return (
    (last ?? "").replace(/@[^@]*$/, "").replace(/\.git$/, "") ===
    "pi-mcp-adapter"
  );
}

/**
 * Enabled server names from one `mcpServers` map. Both pi's built-in reader and
 * the adapter honour `"enabled": false` (mcp.md, configuration.md); every other
 * object-valued entry counts. A non-object value, or a non-object map, yields
 * nothing — a malformed file is not a bridge.
 */
export function enabledMcpServerNames(
  config: Record<string, unknown> | null,
): string[] {
  const servers = config?.mcpServers;
  if (!isPlainObject(servers)) return [];
  const out: string[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (!isPlainObject(entry)) continue;
    if (entry.enabled === false) continue;
    out.push(name);
  }
  return out;
}

/**
 * Detect an MCP bridge in this pi install. `home`, `procEnv` and `cwd` are
 * injectable so the tests never read the developer's real ~/.pi; production
 * passes the cwd pi is spawned in (the ComfyUI install) and nothing else.
 *
 * User-global config decides WHICH bridge (an adapter package is a settings.json
 * fact; built-in MCP is on unless disabled there). Servers are then read from the
 * user-global files that bridge reads AND from the project-scoped ones in `cwd`
 * (`.pi/mcp.json` for both; `.mcp.json` for the adapter). Project servers load
 * only after pi's project trust, and under the adapter only after a per-session
 * approval a headless turn may not be able to give — so one found there is a
 * weaker signal. It still counts, deliberately: the note this verdict selects
 * asserts no tool exists and defers to the real tool list, so an over-detected
 * bridge costs nothing, while an under-detected one is the reported bug. (Codex
 * gate round 2 made this case; the previous draft read user-global files only.)
 *
 * NOT read: servers a pi PACKAGE declares in its own manifest (`pi.mcp`). Those
 * live inside pi's package store, whose layout is not documented in the sources
 * this module cites, and a miss there leaves today's behaviour in place rather
 * than introducing a new one. A user in that position can add the server to any
 * file above to be recognised.
 */
export function detectPiMcpBridge(
  home: string = homedir(),
  procEnv: NodeJS.ProcessEnv = process.env,
  cwd: string | null = null,
): PiMcpBridge | null {
  const agentDir = piAgentDir(home, procEnv);
  // A relative PI_CODING_AGENT_DIR resolves against pi's own cwd, which we cannot
  // know (same stance as pi-credentials.ts) — without the agent dir there is no
  // settings.json to read, and the stock retraction is the safe default.
  if (!agentDir) return null;

  const settings = readJsonObject(join(agentDir, "settings.json"));
  const piMcpJson = readJsonObject(join(agentDir, "mcp.json"));

  const adapterInstalled = packageSources(settings).some(
    isMcpAdapterPackageSource,
  );
  if (adapterInstalled) {
    // Every user-global file the adapter reads (configuration.md "File Layout"),
    // in its precedence order: the shared files, pi's own mcp.json (read by the
    // adapter on pi 0.99+, and the file the reporter's older setup used), and the
    // adapter-owned mcp-adapter.json, which carries its own `mcpServers` map and
    // is the file older adapters told users to rename mcp.json to.
    const files = [
      join(home, ".config", "mcp", "mcp.json"),
      join(home, ".agents", "mcp.json"),
      join(home, ".agents", "mcp", "mcp.json"),
      join(agentDir, "mcp.json"),
      join(agentDir, "mcp-adapter.json"),
      ...(cwd
        ? [
            join(cwd, ".mcp.json"),
            join(cwd, ".pi", "mcp.json"),
            join(cwd, ".pi", "mcp-adapter.json"),
          ]
        : []),
    ];
    const servers = new Set<string>();
    for (const file of files) {
      for (const name of enabledMcpServerNames(readJsonObject(file)))
        servers.add(name);
    }
    if (servers.size) return { kind: "pi-mcp-adapter", servers: [...servers] };
    return null;
  }

  // No adapter: pi's own built-in MCP (0.99+). It is on unless the user disabled
  // it with "-builtin:mcp" in `extensions` (settings.md). An mcp.json with
  // servers and no adapter package was written by `pi mcp add` or for the
  // built-in — nothing else reads that path — so its presence is the version
  // signal we cannot otherwise get from disk.
  const extensions = settings?.extensions;
  const builtinDisabled =
    Array.isArray(extensions) && extensions.some((e) => e === "-builtin:mcp");
  if (builtinDisabled) return null;
  const servers = new Set<string>(enabledMcpServerNames(piMcpJson));
  // Pi's own project file (mcp.md: read after project trust; a same-named entry
  // replaces the user-level one as a whole, which does not change the set of
  // names unless it disables one — handled by enabledMcpServerNames per file).
  if (cwd)
    for (const name of enabledMcpServerNames(
      readJsonObject(join(cwd, ".pi", "mcp.json")),
    ))
      servers.add(name);
  if (servers.size) return { kind: "builtin", servers: [...servers] };
  return null;
}
