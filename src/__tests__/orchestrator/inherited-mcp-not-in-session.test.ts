// #2311 — panel_list_mcp reported an inherited MCP server as "available to you"
// on a Codex session that had never been handed it.
//
// The reporter had `story-mixer-comfy` in their Claude config. panel_list_mcp
// listed it under `inherited`; the deferred tool registry held none of its tools;
// `list_mcp_resources(server="story-mixer-comfy")` answered `unknown MCP server`.
// Configured state was being reported as callable state.
//
// It is our own wiring that decides this, so it is observable rather than guessed:
//
//   buildMcpServers()            spreads readUserMcpServers() ...
//   PanelAgent's constructor     ... and forwards deps.mcpServers to the default
//                                ClaudeBackend ONLY — an INJECTED backend ignores
//                                that field entirely
//   makeHttpBackendMcpServers()  is what every injected (CLI) backend is wired
//                                from, and it declares exactly two servers: the
//                                stdio `comfyui` child and the loopback `panel`
//                                HTTP MCP
//
// So the Claude lane inherits and no other lane does. These tests drive the two
// REAL lane constructors — the loopback HTTP server over a real socket, and the
// in-process Anthropic SDK server over a linked transport pair — because a unit
// test on the shared handler proves the mechanism and says nothing about whether
// either lane reaches it. That gap is the whole bug: the handler was always
// capable of telling the truth, and neither lane ever told it which one it was.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// The reporter's own server name, and a config path that is not the developer's.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "mcp-2311-"));
const CONFIG = join(CONFIG_DIR, ".claude.json");
const SERVER = "story-mixer-comfy";
writeFileSync(
  CONFIG,
  JSON.stringify({
    mcpServers: { [SERVER]: { type: "stdio", command: "python", args: ["-m", "story_mixer"] } },
  }),
);
process.env.COMFYUI_MCP_CLAUDE_JSON = CONFIG;

import { startPanelMcpHttpServer, type PanelMcpHttpServer } from "../../orchestrator/panel-mcp-http.js";
import { createPanelMcpServer } from "../../orchestrator/panel-tools.js";
import { inheritedMcpRetraction, PANEL_SYSTEM_APPEND } from "../../orchestrator/index.js";
import { backendInheritsUserMcpServers } from "../../services/user-mcp-config.js";
import { backendOfAgentKey } from "../../services/session-scope.js";
import type { UiBridge } from "../../services/ui-bridge.js";

/** A bridge these tests never actually reach — panel_list_mcp touches no tab. */
const TAB = "orchestrator::codex";
const bridge = {
  send: async () => ({ ok: true }),
  push: () => 1,
  canReach: () => true,
  isHeadless: () => false,
  tabs: () => [{ tab_id: TAB, title: "A", connected_at: 0 }],
  resolveActiveTabId: () => TAB,
} as unknown as UiBridge;

interface ListMcpReply {
  user_config_servers: string[];
  declared_to_this_session: boolean | "unknown";
  builtin: string[];
  note: string;
}

function replyOf(content: unknown): ListMcpReply {
  const first = (content as Array<{ type: string; text: string }>)[0];
  return JSON.parse(first.text) as ListMcpReply;
}

// ---------------------------------------------------------------------------
// The CLI lane — the reported one. Driven over a real socket, real MCP protocol.
// ---------------------------------------------------------------------------

const RAW_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function parseBody(body: string): { result?: { content?: unknown; isError?: boolean } } {
  const trimmed = body.trim();
  const json = trimmed.startsWith("{")
    ? trimmed
    : trimmed
        .split(/\r?\n/)
        .find((line) => line.startsWith("data:"))
        ?.slice("data:".length)
        .trim();
  if (!json) throw new Error(`MCP response was not JSON or SSE: ${body}`);
  return JSON.parse(json) as { result?: { content?: unknown; isError?: boolean } };
}

let httpServer: PanelMcpHttpServer | undefined;
afterEach(async () => {
  await httpServer?.stop();
  httpServer = undefined;
});

async function callListMcpOverHttp(): Promise<ListMcpReply> {
  // Ephemeral port so a developer's live orchestrator on 9181 is never disturbed.
  httpServer = await startPanelMcpHttpServer(bridge, 0);
  const url = httpServer.urlFor(TAB);
  const init = await fetch(url, {
    method: "POST",
    headers: RAW_HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-2311", version: "1" },
      },
    }),
  });
  expect(init.status).toBe(200);
  const sid = init.headers.get("mcp-session-id");
  expect(sid).toBeTruthy();
  await init.text();
  const ready = await fetch(url, {
    method: "POST",
    headers: { ...RAW_HEADERS, "mcp-session-id": sid! },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  await ready.text();

  const res = await fetch(url, {
    method: "POST",
    headers: { ...RAW_HEADERS, "mcp-session-id": sid! },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "panel_list_mcp", arguments: {} },
    }),
  });
  const payload = parseBody(await res.text());
  expect(payload.result?.isError ?? false).toBe(false);
  return replyOf(payload.result?.content);
}

describe("a CLI-lane session is not told it has the user's Claude-config MCP servers", () => {
  it("reports the configured server as NOT declared to this session", async () => {
    const reply = await callListMcpOverHttp();
    // The server is still reported — the user has it configured, and hiding it
    // would answer a different question than the one asked.
    expect(reply.user_config_servers).toContain(SERVER);
    // …but the availability verdict is the fix. `true` here is the bug.
    expect(reply.declared_to_this_session).toBe(false);
  });

  it("tells the agent the consequence, not just the flag", async () => {
    const { note } = await callListMcpOverHttp();
    expect(note).toMatch(/NOT declared to this session/);
    // The exact symptom the reporter hit, so the agent recognizes it rather than
    // treating it as a transient fault and retrying.
    expect(note).toMatch(/unknown-server error/);
    // panel_reload is what the prompt tells the agent to reach for; it does not help.
    expect(note).toMatch(/panel_reload will NOT add them/);
    expect(note).toMatch(/do not\s+tell the user you have that capability/);
  });

  it("retracts ONLY our own claim, and does not speak for the CLI's own config", async () => {
    // Over-retracting is the same defect pointing the other way: codex reads
    // ~/.codex/config.toml and gemini/qwen read their own, and a session may well
    // hold servers from them. We know what WE declared and nothing more.
    const { note } = await callListMcpOverHttp();
    expect(note).toMatch(/says nothing about MCP servers your own CLI config may give you/);
    expect(note).toMatch(/go by the tool list you\s+were actually given/);
    // Nor does it write the tools off as useless — the write really does reach the
    // user's own sessions, which is a genuine reason to still offer it.
    expect(note).toMatch(/panel_add_mcp is still worth offering/);
  });

  it("still reports the servers this lane genuinely was handed", async () => {
    const reply = await callListMcpOverHttp();
    expect(reply.builtin).toEqual(["comfyui", "panel"]);
  });
});

// ---------------------------------------------------------------------------
// The Claude lane — must keep saying yes, or the fix is a false negative.
// ---------------------------------------------------------------------------

async function callListMcpOnClaudeLane(agentKey: string): Promise<ListMcpReply> {
  const config = createPanelMcpServer(bridge, agentKey) as unknown as { instance: McpServer };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-2311-claude", version: "1" });
  await Promise.all([
    config.instance.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const res = await client.callTool({ name: "panel_list_mcp", arguments: {} });
    expect(res.isError ?? false).toBe(false);
    return replyOf(res.content);
  } finally {
    await client.close();
  }
}

describe("the Claude lane keeps reporting the servers it really does inherit", () => {
  it("reports the configured server as declared to this session", async () => {
    const reply = await callListMcpOnClaudeLane("orchestrator::claude");
    expect(reply.user_config_servers).toContain(SERVER);
    expect(reply.declared_to_this_session).toBe(true);
  });

  it("says DECLARED, not connected — a declared server can still come up failed", async () => {
    // mcp-session-health.ts exists precisely because a configured server can be
    // absent from the session's own `init` report. Upgrading `true` into "your
    // tools are there" would re-introduce this bug one layer down.
    const { note } = await callListMcpOnClaudeLane("orchestrator::claude");
    expect(note).toMatch(/DECLARED to this session/);
    expect(note).toMatch(/Declared is not the same as connected/);
    expect(note).not.toMatch(/available to you/i);
  });
});

// ---------------------------------------------------------------------------
// UNKNOWN must stay unknown (the #796 collapse rule).
// ---------------------------------------------------------------------------

describe("a session whose backend was never established says so", () => {
  it("does not collapse an unestablished backend into `false`", async () => {
    // PanelAgent.rebindTabId() rewrites a migrated agent key into a BARE panel tab
    // id, which carries no backend half. A ctx built from one of those has not
    // observed an absence — and answering `false` would state one.
    const reply = await callListMcpOnClaudeLane("wf:workflows/a.json");
    expect(reply.declared_to_this_session).toBe("unknown");
    expect(reply.note).toMatch(/could not be established here/);
    expect(reply.note).toMatch(/until you have actually called one of its tools/);
  });
});

// ---------------------------------------------------------------------------
// The two shared predicates.
// ---------------------------------------------------------------------------

describe("backendInheritsUserMcpServers names the one lane that does", () => {
  it("is true for claude and false for every CLI backend", () => {
    expect(backendInheritsUserMcpServers("claude")).toBe(true);
    for (const b of ["codex", "gemini", "grok", "antigravity", "qwen", "ollama", "pi", "kimi"]) {
      expect(backendInheritsUserMcpServers(b)).toBe(false);
    }
  });

  it("treats an absent backend as not-inheriting rather than throwing", () => {
    expect(backendInheritsUserMcpServers(undefined)).toBe(false);
    expect(backendInheritsUserMcpServers(null)).toBe(false);
  });
});

describe("backendOfAgentKey yields undefined rather than a default", () => {
  it("splits an agent key on the LAST separator", () => {
    expect(backendOfAgentKey("orchestrator::codex")).toBe("codex");
    expect(backendOfAgentKey("wf:workflows/a.json::claude")).toBe("claude");
  });

  it("returns undefined for an id with no backend half", () => {
    // Substituting the default backend here is what would let a caller state a
    // per-backend fact about an agent whose backend it never established.
    expect(backendOfAgentKey("orchestrator")).toBeUndefined();
    expect(backendOfAgentKey("wf:workflows/a.json")).toBeUndefined();
    expect(backendOfAgentKey("tmp:abc")).toBeUndefined();
    expect(backendOfAgentKey("orchestrator::")).toBeUndefined();
    expect(backendOfAgentKey(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The prompt half. A truthful tool reply does not help if the system prompt has
// already told the model the opposite.
// ---------------------------------------------------------------------------

describe("the system prompt's MCP-extension claim is retracted off the Claude lane", () => {
  it("says nothing for the lane that really does inherit", () => {
    expect(inheritedMcpRetraction("claude")).toBe("");
  });

  it("stays silent for pi, whose own override already retracts strictly more", () => {
    expect(inheritedMcpRetraction("pi")).toBe("");
  });

  it("retracts the self-extension claim for a CLI backend", () => {
    const note = inheritedMcpRetraction("codex");
    expect(note).not.toBe("");
    expect(note).toMatch(/You do NOT inherit the user's Claude-config MCP servers/);
    expect(note).toMatch(/declared_to_this_session: false/);
    expect(note).toMatch(/panel_reload does NOT change that/);
  });

  it("does not over-retract into a second false claim", () => {
    const note = inheritedMcpRetraction("codex");
    // The tools still work and are still worth offering — saying otherwise would
    // be the same defect pointing the other way.
    expect(note).toMatch(/panel_add_mcp and panel_remove_mcp still work/);
    expect(note).toMatch(/That is all this tells you/);
    expect(note).toMatch(/says nothing about MCP servers your own CLI configuration may give you/);
  });

  it("keeps the base persona and the retraction from contradicting each other", () => {
    // The persona is what the retraction corrects; if it is reworded to drop the
    // per-session qualifier, the correction silently stops matching what it
    // corrects and a Claude-lane agent is back to reading the old claim.
    expect(PANEL_SYSTEM_APPEND).toMatch(/declared_to_this_session/);
    expect(PANEL_SYSTEM_APPEND).toMatch(/only the Claude backend inherits them/);
    expect(PANEL_SYSTEM_APPEND).not.toMatch(/panel_list_mcp shows what's connected/);
  });
});

// ---------------------------------------------------------------------------
// The install lines. Each is one expression in a function no test can construct,
// and a helper-level test is blind to all three.
// ---------------------------------------------------------------------------

describe("the wiring that makes the above reachable in production", () => {
  const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf-8");

  it("the loopback HTTP lane declares itself non-inheriting when it builds its ctx", () => {
    const src = read("../../orchestrator/panel-mcp-http.ts");
    expect(src).toMatch(
      /registerPanelTools\(\s*server,\s*makePanelToolCtx\(bridge, tabId, workflowTargets, onRunTicketOpened, \{\s*inheritsUserMcpServers: false,\s*\}\),\s*\)/,
    );
  });

  it("the Claude lane derives its answer from the agent key, not a hardcoded true", () => {
    const src = read("../../orchestrator/panel-tools.ts");
    expect(src).toMatch(/const keyBackend = backendOfAgentKey\(tabId\);/);
    expect(src).toMatch(
      /inheritsUserMcpServers:\s*keyBackend === undefined \? undefined : backendInheritsUserMcpServers\(keyBackend\),/,
    );
  });

  it("makeBackend appends the retraction to every CLI backend's system prompt", () => {
    // One expression, thirteen construction sites downstream of it. If it is
    // dropped, `inheritedMcpRetraction` keeps passing its own tests and reaches
    // nobody.
    const src = read("../../orchestrator/index.ts");
    expect(src).toMatch(
      /const sysAppend =\s*systemAppendForBackend\(backend\) \+\s*panelToolsRetraction\(backend, panelMcpHttp !== null\) \+\s*inheritedMcpRetraction\(backend\);/,
    );
  });
});
