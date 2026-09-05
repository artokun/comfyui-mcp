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
// So the Claude lane inherits and no other lane does. But the LANE is only half
// the question, as the first review round found: even on the Claude lane the
// session was spawned with a snapshot, while panel_list_mcp reads the file LIVE.
// panel_add_mcp writes immediately, so between that write and the panel_reload
// that respawns the agent, a lane-only answer reports a brand-new server as
// declared to a session that has never heard of it — the same bug one layer down.
// So the reply answers PER SERVER, from the spawn snapshot.
//
// And the second round found the limit of even that. What we hand a spawn is not
// what the session ends up with: a spawn that RESUMES a stored session gets the
// MCP set recorded WITH that session and ignores the config we just read (#1700 —
// which is exactly why restartForMcpConfig also FORKS), and a declared server can
// simply fail to start (#1524). So the field is named `declared_to_this_spawn` and
// says what WE did, which is all we can establish from here. Nothing in this reply
// asserts that the agent HAS a tool; the note sends it to the one thing that
// settles it — calling one.
//
// These tests drive the two REAL lane constructors — the loopback HTTP server
// over a real socket, and the in-process Anthropic SDK server over a linked
// transport pair — because a unit test on the shared handler proves the mechanism
// and says nothing about whether either lane reaches it. That gap is the whole
// bug: the handler was always capable of telling the truth, and neither lane ever
// told it which one it was.

import { afterEach, describe, expect, it } from "vitest";
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

function writeConfig(...names: string[]): void {
  const mcpServers: Record<string, unknown> = {};
  for (const n of names) mcpServers[n] = { type: "stdio", command: "python", args: ["-m", n] };
  writeFileSync(CONFIG, JSON.stringify({ mcpServers }));
}
writeConfig(SERVER);
process.env.COMFYUI_MCP_CLAUDE_JSON = CONFIG;

import { startPanelMcpHttpServer, type PanelMcpHttpServer } from "../../orchestrator/panel-mcp-http.js";
import { buildPanelToolDefs, createPanelMcpServer } from "../../orchestrator/panel-tools.js";
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
  servers: Record<string, { in_user_config: boolean; declared_to_this_spawn: boolean | "unknown" }>;
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
  writeConfig(SERVER);
});

async function callListMcpOverHttp(
  manifestOutcomeScopeForTab?: (tabId: string) => string | undefined,
): Promise<ListMcpReply> {
  // Ephemeral port so a developer's live orchestrator on 9181 is never disturbed.
  httpServer = await startPanelMcpHttpServer(
    bridge,
    0,
    "127.0.0.1",
    undefined,
    undefined,
    manifestOutcomeScopeForTab,
  );
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
    expect(reply.servers[SERVER].in_user_config).toBe(true);
    // …but the availability verdict is the fix. `true` here is the bug.
    expect(reply.servers[SERVER].declared_to_this_spawn).toBe(false);
  });

  it("tells the agent the consequence, not just the flag", async () => {
    const { note } = await callListMcpOverHttp();
    expect(note).toMatch(/we handed you none of these/);
    // The exact symptom the reporter hit, so the agent recognizes it rather than
    // treating it as a transient fault and retrying.
    expect(note).toMatch(/unknown-server error/);
    // panel_reload is what the prompt tells the agent to reach for; it does not help.
    expect(note).toMatch(/panel_reload will not change\s+that/);
    expect(note).toMatch(/do not tell the user you\s+have that capability/);
  });

  it("retracts ONLY our own claim, and does not speak for the CLI's own config", async () => {
    // Over-retracting is the same defect pointing the other way: codex reads
    // ~/.codex/config.toml and gemini/qwen read their own, and a session may well
    // hold servers from them. We know what WE declared and nothing more.
    const { note } = await callListMcpOverHttp();
    expect(note).toMatch(/says nothing about MCP servers your own CLI config may give you/);
    expect(note).toMatch(/go by the tool list you were actually given/);
    // Nor does it write the tools off as useless — the write really does reach the
    // user's own sessions, which is a genuine reason to still offer it.
    expect(note).toMatch(/panel_add_mcp is still worth offering/);
  });

  it("does not invent a spawn-snapshot story for a lane that inherits nothing", async () => {
    // On this lane a server added mid-session is not "pending a reload" — it is
    // never coming. Saying otherwise would replace one false promise with another.
    writeConfig(SERVER, "added-later");
    const { note, servers } = await callListMcpOverHttp();
    expect(servers["added-later"].declared_to_this_spawn).toBe(false);
    expect(note).not.toMatch(/panel_reload respawns this session and picks them up/);
  });

  it("still reports the servers this lane genuinely was handed", async () => {
    const reply = await callListMcpOverHttp();
    expect(reply.builtin).toEqual(["comfyui", "panel"]);
  });

  it("preserves the backend-qualified agent key at the HTTP outcome-scope boundary", async () => {
    let receivedTabId: string | undefined;
    await callListMcpOverHttp((tabId) => {
      receivedTabId = tabId;
      return tabId;
    });
    // The production Codex/Gemini URL is addressed by the composite agent key,
    // not by a real panel tab. The callback must receive that exact key so the
    // queue-status reader can find the child outcome under the same scope.
    expect(receivedTabId).toBe(TAB);
  });
});

// ---------------------------------------------------------------------------
// The Claude lane — must keep saying yes, or the fix is a false negative.
// ---------------------------------------------------------------------------

async function openClaudeLane(agentKey: string): Promise<{
  list: () => Promise<ListMcpReply>;
  close: () => Promise<void>;
}> {
  // Built ONCE, like a spawn: the snapshot it takes is what this session got.
  const config = createPanelMcpServer(bridge, agentKey) as unknown as { instance: McpServer };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-2311-claude", version: "1" });
  await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);
  return {
    list: async () => {
      const res = await client.callTool({ name: "panel_list_mcp", arguments: {} });
      expect(res.isError ?? false).toBe(false);
      return replyOf(res.content);
    },
    close: () => client.close(),
  };
}

async function callListMcpOnClaudeLane(agentKey: string): Promise<ListMcpReply> {
  const lane = await openClaudeLane(agentKey);
  try {
    return await lane.list();
  } finally {
    await lane.close();
  }
}

describe("the Claude lane keeps reporting the servers it really does inherit", () => {
  it("reports the configured server as declared to this session", async () => {
    const reply = await callListMcpOnClaudeLane("orchestrator::claude");
    expect(reply.servers[SERVER].in_user_config).toBe(true);
    expect(reply.servers[SERVER].declared_to_this_spawn).toBe(true);
  });

  it("says DECLARED, not connected — a declared server can still come up failed", async () => {
    // mcp-session-health.ts exists precisely because a configured server can be
    // absent from the session's own `init` report. Upgrading `true` into "your
    // tools are there" would re-introduce this bug one layer down.
    const { note } = await callListMcpOnClaudeLane("orchestrator::claude");
    expect(note).toMatch(/it is NOT proof you\s+have those tools/);
    expect(note).not.toMatch(/available to you/i);
  });
});

// ---------------------------------------------------------------------------
// Codex gate round 1, P1: the lane is only half the question.
// ---------------------------------------------------------------------------

describe("a server added AFTER the session spawned is not reported as declared to it", () => {
  it("answers per server, from the spawn snapshot, not from the live config file", async () => {
    // The reviewer's exact scenario: start Claude without `foo`, panel_add_mcp it,
    // then panel_list_mcp BEFORE the panel_reload that would respawn the agent.
    const lane = await openClaudeLane("orchestrator::claude");
    try {
      expect((await lane.list()).servers[SERVER].declared_to_this_spawn).toBe(true);
      // panel_add_mcp writes to ~/.claude.json immediately.
      writeConfig(SERVER, "foo");
      const after = await lane.list();
      // The pre-existing server is unaffected...
      expect(after.servers[SERVER].declared_to_this_spawn).toBe(true);
      // ...and the new one is honestly reported as not (yet) this session's.
      expect(after.servers.foo.in_user_config).toBe(true);
      expect(after.servers.foo.declared_to_this_spawn).toBe(false);
      expect(after.note).toMatch(/Added to the config after this session started, so NOT handed to it/);
      expect(after.note).toMatch(/panel_reload respawns this session and picks them up/);
    } finally {
      await lane.close();
    }
  });

  it("does not imply a REMOVED server is gone while the session still runs it", async () => {
    // The same divergence mirrored. Dropping it from the reply entirely would say
    // it had gone; it has not, until a panel_reload respawns the agent.
    const lane = await openClaudeLane("orchestrator::claude");
    try {
      writeConfig(); // panel_remove_mcp(SERVER)
      const after = await lane.list();
      expect(after.servers[SERVER].in_user_config).toBe(false);
      expect(after.servers[SERVER].declared_to_this_spawn).toBe(true);
      expect(after.note).toMatch(/likely still running in it\s+until a panel_reload/);
    } finally {
      await lane.close();
    }
  });

  it("says by-NAME, because that is all the snapshot can establish", async () => {
    // A server removed and re-added under the same name is a DIFFERENT server the
    // session cannot see. Claiming the definitions match would be a fresh
    // over-claim wearing the fix's clothes.
    const lane = await openClaudeLane("orchestrator::claude");
    try {
      writeConfig(SERVER, "foo");
      expect((await lane.list()).note).toMatch(/Matching is by NAME only/);
    } finally {
      await lane.close();
    }
  });

  it("says nothing about a snapshot when there is no divergence to report", async () => {
    const { note } = await callListMcpOnClaudeLane("orchestrator::claude");
    expect(note).not.toMatch(/Added to the config after this session started/);
    expect(note).not.toMatch(/Matching is by NAME only/);
  });
});

// ---------------------------------------------------------------------------
// UNKNOWN must stay unknown (the #796 collapse rule).
// ---------------------------------------------------------------------------

describe("nothing in the reply claims the session actually HAS the tools", () => {
  it("names the resume gap instead of reading `declared` as `available`", async () => {
    // Codex gate round 2: `userMcpServersAtSpawn` is what we handed the spawn.
    // A spawn that resumed a stored session gets the set recorded with THAT
    // session, so an orchestrator restart between panel_add_mcp and panel_reload
    // leaves the two disagreeing — and a snapshot cannot see it.
    const { note } = await callListMcpOnClaudeLane("orchestrator::claude");
    expect(note).toMatch(/what we handed the agent when it started/);
    expect(note).toMatch(/it is NOT proof you\s+have those tools/);
    expect(note).toMatch(/RESUMED a stored session/);
    expect(note).toMatch(/can still fail to start/);
    expect(note).toMatch(/The only proof is calling\s+one of its tools/);
  });

  it("never uses the word `available` about an inherited server", async () => {
    // The original defect was one sentence: "List the MCP servers available to
    // you." No lane may reintroduce it.
    for (const key of ["orchestrator::claude", "orchestrator::codex", "wf:a.json"]) {
      const { note } = await callListMcpOnClaudeLane(key);
      expect(note).not.toMatch(/available to you/i);
    }
  });
});

describe("a session whose backend was never established says so", () => {
  it("does not collapse an unestablished backend into `false`", async () => {
    // PanelAgent.rebindTabId() rewrites a migrated agent key into a BARE panel tab
    // id, which carries no backend half. A ctx built from one of those has not
    // observed an absence — and answering `false` would state one.
    const reply = await callListMcpOnClaudeLane("wf:workflows/a.json");
    expect(reply.servers[SERVER].declared_to_this_spawn).toBe("unknown");
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
    expect(note).toMatch(/declared_to_this_spawn/);
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
    expect(PANEL_SYSTEM_APPEND).toMatch(/declared_to_this_spawn/);
    expect(PANEL_SYSTEM_APPEND).toMatch(/only the Claude backend is handed them/i);
    // The clause this replaces, verbatim from #2309's shrunk preamble. It is
    // false on every CLI lane, and it is what a reworded persona would drift
    // back toward — so pin its ABSENCE, not just the correction's presence.
    expect(PANEL_SYSTEM_APPEND).not.toMatch(
      /panel_remove_mcp manage MCP servers and panel_reload loads the change into this session/,
    );
  });
});

// ---------------------------------------------------------------------------
// The CARRIER. #2234 moved this guidance OUT of the preamble and into the
// panel-operations skill, and #2309 carried the false claim across with it
// verbatim. Correcting the preamble and leaving the skill would ship a half fix
// that reads as a whole one — the skill is what the agent is told to go read.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE PROMPT IS THE WEAK CHANNEL, and this is the one that has to hold without it.
//
// CodexBackend sets `needsSystemPreamble` only in its `thread/start` branch
// (codex-backend.ts) — a RESUMED thread carries whatever persona text is already
// in its transcript, which for a thread started before this change is the old,
// false one. That is pre-existing and shared by every prompt-level retraction
// here (panelToolsRetraction, PI_CAPABILITY_OVERRIDE); re-delivering a 16KB
// preamble on every resume is a separate decision, and #2234 had just spent a
// whole change halving it.
//
// What DOES reach such a session is the tool surface: the MCP servers are
// re-declared per spawn, so `tools/list` returns THIS build's descriptions and
// every call returns THIS build's reply. So the correction must be complete in
// the description alone — an agent that never sees the corrected prompt still
// reads the rule before it can call the tool.
// ---------------------------------------------------------------------------

describe("the correction survives an agent that never sees the corrected prompt", () => {
  const describedBy = (name: string): string => {
    const def = (buildPanelToolDefs() as Array<{ name: string; description?: string }>).find(
      (d) => d.name === name,
    );
    expect(def, `${name} is no longer registered`).toBeDefined();
    return def!.description ?? "";
  };

  it("panel_list_mcp's own description states the lane rule", () => {
    const d = describedBy("panel_list_mcp");
    expect(d).toMatch(/Only the Claude backend inherits them/);
    expect(d).toMatch(/NOT part of your toolset/);
    expect(d).toMatch(/declared_to_this_spawn/);
  });

  it("...and that a true is not proof, which is the round-2 correction", () => {
    const d = describedBy("panel_list_mcp");
    expect(d).toMatch(/is NOT proof you have the tools/);
    expect(d).toMatch(/a resumed session keeps the set recorded with it/);
  });

  it("panel_add_mcp's description no longer promises the tools to every backend", () => {
    const d = describedBy("panel_add_mcp");
    // The original sentence, which promised the Claude-lane outcome to everyone.
    expect(d).not.toMatch(/it then loads into THIS session after you call panel_reload/);
    expect(d).toMatch(/on every other backend .* it does NOT/);
    expect(d).toMatch(/do not promise the capability before reading it/i);
  });

  it("panel_remove_mcp's description no longer addresses every backend as if it had the server", () => {
    const d = describedBy("panel_remove_mcp");
    expect(d).not.toMatch(/^Remove an MCP server from the user's Claude config by name\. Call panel_reload/);
    expect(d).toMatch(/other backends were never handed it in the first place/);
  });
});

describe("the carrier skill does not still teach the retracted claim", () => {
  const SKILL = readFileSync(
    new URL("../../../plugin/skills/panel-operations/SKILL.md", import.meta.url),
    "utf-8",
  );

  it("no longer says panel_reload loads the change into this session, unqualified", () => {
    // The exact sentences #2309 moved here, matched across the file's own line
    // wrapping so a re-wrap cannot silently disarm the pin.
    expect(SKILL).not.toMatch(
      /then call `panel_reload` to load the change into this\s+session/,
    );
    expect(SKILL).not.toMatch(/`panel_list_mcp` shows\s+what is connected/);
  });

  it("names the lane, the field, and what a true does NOT prove", () => {
    expect(SKILL).toMatch(
      /\*\*Only the Claude backend is handed those servers\.\*\*/,
    );
    expect(SKILL).toMatch(/declared_to_this_spawn/);
    expect(SKILL).toMatch(/not\*\* proof you have the\s+tools/);
    expect(SKILL).toMatch(/RESUMED after a restart/);
    expect(SKILL).toMatch(/can still fail to start/);
  });

  it("does not over-retract — the write still reaches the user's own sessions", () => {
    expect(SKILL).toMatch(/still worth offering on any backend/);
    expect(SKILL).toMatch(/that one is not this one/);
  });
});

// ---------------------------------------------------------------------------
// The install lines. Each is one expression in a function no test can construct,
// and a helper-level test is blind to all of them.
// ---------------------------------------------------------------------------

describe("the wiring that makes the above reachable in production", () => {
  const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf-8");

  it("the loopback HTTP lane declares itself non-inheriting when it builds its ctx", () => {
    const src = read("../../orchestrator/panel-mcp-http.ts");
    expect(src).toMatch(
      /registerPanelTools\(\s*server,\s*makePanelToolCtx\(bridge, tabId, workflowTargets, onRunTicketOpened, \{\s*inheritsUserMcpServers: false,[\s\S]*?\}\),\s*\)/,
    );
  });

  it("the Claude lane derives its answer from the agent key, not a hardcoded true", () => {
    const src = read("../../orchestrator/panel-tools.ts");
    expect(src).toMatch(/const keyBackend = backendOfAgentKey\(tabId\);/);
    expect(src).toMatch(
      /const inheritsUserMcpServers =\s*keyBackend === undefined \? undefined : backendInheritsUserMcpServers\(keyBackend\);/,
    );
  });

  it("the Claude lane snapshots the spawn's server names, not the live file", () => {
    // Without this the per-server answer degrades back to "whatever the config
    // says right now", which is the round-1 P1 finding.
    const src = read("../../orchestrator/panel-tools.ts");
    expect(src).toMatch(
      /inheritsUserMcpServers === true\s*\?\s*\{ userMcpServersAtSpawn: Object\.keys\(readUserMcpServers\(\)\) \}\s*:\s*\{\}/,
    );
  });

  it("makeBackend appends the retraction to every CLI backend's system prompt", () => {
    // One expression, thirteen construction sites downstream of it. If it is
    // dropped, `inheritedMcpRetraction` keeps passing its own tests and reaches
    // nobody.
    //
    // `panelToolsRetraction`'s own argument list is matched loosely on purpose. This
    // test exists to pin that `inheritedMcpRetraction` REACHES this expression, and
    // over-pinning a sibling's signature makes it fail for reasons that have nothing
    // to do with what it guards -- which is exactly what happened when that function
    // gained a third argument. The composition and its ORDER are still asserted.
    const src = read("../../orchestrator/index.ts");
    expect(src).toMatch(
      /const sysAppend =\s*systemAppendForBackend\(backend\) \+\s*panelToolsRetraction\([^)]*\) \+\s*inheritedMcpRetraction\(backend\);/,
    );
  });
});
