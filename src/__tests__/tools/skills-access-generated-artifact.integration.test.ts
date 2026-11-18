import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const mocks = vi.hoisted(() => ({ generate: vi.fn(), getDetails: vi.fn() }));
vi.mock("../../services/skill-generator.js", () => ({ generateSkill: mocks.generate }));
vi.mock("../../services/registry-client.js", () => ({ getNodePackDetails: mocks.getDetails }));
// Avoid importing real configuration, which probes local ComfyUI ports at load.
vi.mock("../../config.js", () => ({
  getComfyUIBaseUrl: () => "http://comfy.test:8188",
  getComfyUIAuthHeaders: () => ({}),
}));

import { registerSkillsAccessTools } from "../../tools/skills-access.js";

const MARKDOWN = "---\nname: deno-custom-nodes\n---\n\n# Node capabilities\n\n## Sources\n\nOfficial: README.\n";
let root: string;
let cacheRoot: string;
let client: Client;
let server: McpServer;
const noNetwork = vi.fn(() => { throw new Error("Unexpected network access in generated-skill regression"); });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cmcp-generated-artifact-"));
  cacheRoot = join(root, "cache");
  vi.stubEnv("COMFYUI_SKILL_CACHE_DIR", cacheRoot);
  vi.stubGlobal("fetch", noNetwork);
  vi.clearAllMocks();
  mocks.generate.mockResolvedValue(MARKDOWN);
  mocks.getDetails.mockResolvedValue({ latest_version: "1.2.3", versions: [] });
  server = new McpServer({ name: "generated-artifact-test", version: "1.0.0" });
  registerSkillsAccessTools(server);
  client = new Client({ name: "generated-artifact-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  expect(noNetwork).not.toHaveBeenCalled();
});

function generate(extra: { refresh?: boolean; install_in?: string } = {}) {
  return client.callTool({
    name: "list_packs",
    arguments: { action: "generate_skill", source: "deno-custom-nodes", ...extra },
  });
}

async function cachedMarkdown() {
  const entries = await readdir(cacheRoot);
  expect(entries).toHaveLength(1);
  return readFile(join(cacheRoot, entries[0], "SKILL.md"), "utf8");
}

describe("#2917 generated SKILL.md survives structured MCP results", () => {
  it("returns the artifact on a miss to both structured-only and text consumers", async () => {
    const result = await generate();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ markdown: MARKDOWN, cache_hit: false, version: "1.2.3" });
    expect(result.content).toEqual([{ type: "text", text: MARKDOWN }]);
    expect(await cachedMarkdown()).toBe(MARKDOWN);
  });

  it("returns the cached artifact without regenerating it", async () => {
    await generate();
    mocks.generate.mockResolvedValue("# Must not replace cached skill");
    const hit = await generate();
    expect(hit.structuredContent).toMatchObject({ markdown: MARKDOWN, cache_hit: true });
    expect(hit.content).toEqual([{ type: "text", text: MARKDOWN }]);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it("returns and caches the refreshed artifact rather than the old contents", async () => {
    await generate();
    const refreshed = "# Refreshed node capabilities\n";
    mocks.generate.mockResolvedValue(refreshed);
    const result = await generate({ refresh: true });
    expect(result.structuredContent).toMatchObject({ markdown: refreshed, cache_hit: false });
    expect(result.content).toEqual([{ type: "text", text: refreshed }]);
    expect(await cachedMarkdown()).toBe(refreshed);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });

  it("still delivers the artifact when the cache cannot be written", async () => {
    // A file at the cache root deterministically blocks directory creation on
    // Windows and POSIX; no real user cache or permission changes are needed.
    await writeFile(cacheRoot, "blocked", "utf8");
    const result = await generate();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ markdown: MARKDOWN, cache_hit: false });
    expect(result.content).toEqual([{ type: "text", text: MARKDOWN }]);
    expect(await readFile(cacheRoot, "utf8")).toBe("blocked");
  });

  it("returns the exact artifact after an explicitly requested installation", async () => {
    const destination = join(root, "installed");
    const result = await generate({ install_in: destination });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ markdown: MARKDOWN, cache_hit: false });
    expect(result.content).toEqual([{ type: "text", text: `Skill file written to ${join(destination, "SKILL.md")}\n\n${MARKDOWN}` }]);
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toBe(MARKDOWN);
  });

  it("reports a failed requested installation as an error, never a written artifact", async () => {
    const destination = join(root, "blocked-install");
    await writeFile(destination, "preserve this file", "utf8");
    const result = await generate({ install_in: destination });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result.content)).not.toContain("Skill file written to");
    expect(await readFile(destination, "utf8")).toBe("preserve this file");
    // The independent read-through cache may succeed before installation fails.
    expect(await cachedMarkdown()).toBe(MARKDOWN);
  });
});
