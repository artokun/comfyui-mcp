import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated `list_packs` tool (0.50.0 slice 9): the nine knowledge tools
 * folded into one action-parameterized tool. Proves the consolidation did not
 * change behaviour — every action calls the identical service the old tool
 * called, with the same arguments and the same content block — and that the
 * flat-enum shape actually EXPOSES its parameters (the discriminated-union trap
 * renders zero params).
 *
 * The one thing this tool has that `queue` did not: NINE read actions and ONE
 * that installs custom node packs (third-party code) on the connected ComfyUI.
 * A read-only-looking tool that silently installs is a wrong-expectation defect,
 * so "no read action reaches the install service" is asserted explicitly rather
 * than left to the shape of the switch.
 */

const mocks = vi.hoisted(() => ({
  extractWorkflowDependencies: vi.fn(),
  installWorkflowDependencies: vi.fn(),
  generateSkillCached: vi.fn(),
  checkWorkflowRuntime: vi.fn(),
  requestPanelTemplateIndex: vi.fn(),
}));

const comfyui = vi.hoisted(() => ({
  baseUrl: "http://comfy.test:8188",
  authHeaders: {} as Record<string, string>,
}));

vi.mock("../../services/workflow-deps.js", () => ({
  extractWorkflowDependencies: (...args: unknown[]) => mocks.extractWorkflowDependencies(...args),
  installWorkflowDependencies: (...args: unknown[]) => mocks.installWorkflowDependencies(...args),
  defaultWorkflowDepsDeps: () => ({ deps: "sentinel" }),
}));

vi.mock("../../services/skill-cache.js", () => ({
  generateSkillCached: (...args: unknown[]) => mocks.generateSkillCached(...args),
}));

vi.mock("../../services/api-nodes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/api-nodes.js")>();
  return {
    ...actual,
    checkWorkflowRuntime: (...args: unknown[]) => mocks.checkWorkflowRuntime(...args),
  };
});

vi.mock("../../config.js", () => ({
  getComfyUIBaseUrl: () => comfyui.baseUrl,
  getComfyUIAuthHeaders: () => comfyui.authHeaders,
}));

vi.mock("../../services/panel-template-relay.js", () => ({
  requestPanelTemplateIndex: (...args: unknown[]) => mocks.requestPanelTemplateIndex(...args),
}));

import {
  registerSkillsAccessTools,
  enumeratePacks,
  resolvePackWorkflowFile,
  resolveWorkflowFileName,
  describeMissingWorkflow,
  coercePackMeta,
} from "../../tools/skills-access.js";

type Handler = (args: Record<string, any>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}>;

interface Registered {
  name: string;
  shape: z.ZodRawShape;
  handler: Handler;
}

function registered(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    tool: (name: string, _desc: string, shape: z.ZodRawShape, handler: Handler) => {
      tools.push({ name, shape, handler });
    },
  };
  registerSkillsAccessTools(server as never);
  return tools;
}

/** The whole knowledge surface is now ONE tool (0.50.0 slice 9). */
function handler(): Handler {
  const tools = registered();
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("list_packs");
  return tools[0].handler;
}

const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

const ACTIONS = [
  "list",
  "read_workflow",
  "read_manifest",
  "list_templates",
  "check_runtime",
  "extract_deps",
  "install_deps",
  "skill_list",
  "skill_read",
  "generate_skill",
] as const;

const savedFetch = global.fetch;

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  comfyui.baseUrl = "http://comfy.test:8188";
  comfyui.authHeaders = {};
  // Every action that touches the network gets a healthy default so a test
  // about SOMETHING ELSE never accidentally exercises an error path.
  global.fetch = vi.fn(
    async () =>
      new Response('{"pack-a":[{"name":"t1"}]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = savedFetch;
});

describe("list_packs registration", () => {
  it("registers exactly one tool named `list_packs` (9→1)", () => {
    const tools = registered();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("list_packs");
  });

  // The whole reason for the flat-enum shape rule: a z.discriminatedUnion renders
  // as ZERO parameters, hiding every input from the model.
  it("exposes a visible flat `action` enum with every per-action parameter", () => {
    const [{ shape }] = registered();
    // io: "input" — the conversion options the MCP SDK itself uses
    // (sdk/server/zod-json-schema-compat.js, asserted by docs-schema-parity.test.ts),
    // so this is the schema a client is actually given.
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action",
      "graph",
      "install_in",
      "name",
      "pack",
      "refresh",
      "source",
      "workflow",
    ]);
    expect(json.properties?.action.enum?.slice().sort()).toEqual([...ACTIONS].sort());
    // Only `action` can be required — the rest are per-action, enforced in the handler.
    expect(json.required).toEqual(["action"]);
  });

  it("an unknown action returns a clear error result naming the valid actions", async () => {
    const res = await handler()({ action: "bogus" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unknown list_packs action/i);
    expect(text(res)).toMatch(/install_deps/);
    expect(text(res)).toMatch(/skill_read/);
  });

  // The description is the ONLY thing standing between a model and an unexpected
  // write: eight actions read, one installs third-party code, and one overwrites
  // a file when `install_in` is given. A reworded description that drops either
  // warning re-opens exactly that wrong expectation — and a note that UNDERCOUNTS
  // the mutations (the first draft of this said "eight of nine only read") is the
  // same defect wearing a safety label, so both are pinned.
  it("the description discloses BOTH mutating actions, and undercounts neither", () => {
    let description = "";
    registerSkillsAccessTools({
      tool: (_n: string, d: string) => {
        description = d;
      },
    } as never);
    const bullet = (action: string) =>
      description.split(/\r?\n/).find((l) => l.startsWith(`- action:"${action}"`)) ?? "";

    // Asserted as the CLAIM, not as two independent keywords: the rejected
    // wording ("the ONE action on this tool that CHANGES the user's machine")
    // also contains MUTATING and INSTALL, so a keyword check would pass a revert
    // to the very sentence that contradicts generate_skill's disk writes.
    const install = bullet("install_deps");
    expect(install).toContain("MUTATING");
    expect(install).toMatch(/the ONE action on this tool that INSTALLS anything/);
    expect(install).not.toMatch(/ONE action on this tool that CHANGES/);

    // generate_skill writes TWICE over: its read-through cache on every miss
    // (unconditional, in the user's home), and the caller's `install_in`
    // directory when given. An earlier draft said "read-only otherwise", which
    // the cache write makes false — so both writes are pinned, not just the
    // conditional one.
    //
    // Both halves are asserted as the WRITE claim, not by keyword: the bullet
    // also explains the cache mechanically ("On cache miss, fetches the repo
    // README…"), so a bare /cache miss/ match passes even with the mutation
    // warning deleted — which is how the first version of this assertion
    // survived exactly that deletion.
    const generate = bullet("generate_skill");
    expect(generate).toContain("MUTATING");
    expect(generate).toMatch(/WRITES to the read-through skill cache/);
    expect(generate).toMatch(/`install_in` is set it ALSO creates/);
    expect(generate).toMatch(/overwrit/i);

    // ...and the action enum's own help repeats it, because a model that skims
    // the bullets still reads the enum description. Asserted as a RELATIONSHIP
    // ("generate_skill … WRITES … install_in") rather than the bare presence of
    // the words: `install_deps` and `install_in` both appeared in the rejected
    // wording that claimed install_deps was the only mutating action, so
    // presence alone would pass a reverted description.
    const actionDesc = String(
      (registered()[0].shape.action as unknown as { description?: string }).description ?? "",
    );
    expect(actionDesc).toContain("INSTALLS");
    expect(actionDesc).toMatch(/"generate_skill" also WRITES to disk[^.]*install_in/);
    // The rejected claim must not come back.
    expect(actionDesc).not.toMatch(/only mutating action/i);
  });
});

describe("actions call the same services with the same arguments", () => {
  it('action:"list" returns the pack listing with its local-GPU note', async () => {
    const res = await handler()({ action: "list" });
    const parsed = JSON.parse(text(res));
    expect(typeof parsed.count).toBe("number");
    expect(Array.isArray(parsed.packs)).toBe(true);
    expect(parsed.note).toContain("LOCAL-GPU / FREE");
  });

  it('action:"skill_list" returns the bundled skill listing', async () => {
    const res = await handler()({ action: "skill_list" });
    const parsed = JSON.parse(text(res));
    expect(typeof parsed.count).toBe("number");
    expect(Array.isArray(parsed.skills)).toBe(true);
  });

  it('action:"read_workflow" resolves by pack name and reports an unknown one', async () => {
    const res = await handler()({ action: "read_workflow", name: "definitely-not-a-pack" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('No pack named "definitely-not-a-pack"');
  });

  it('action:"read_manifest" returns the pack\'s install manifest and refuses a bad name', async () => {
    // The build ships at least one pack with a manifest (action:"list" reports
    // has_manifest) — read it through the same name apply_manifest takes.
    const pack = enumeratePacks().find((p) => p.has_manifest === true);
    expect(pack, "expected at least one bundled pack with a manifest").toBeDefined();
    const res = await handler()({ action: "read_manifest", name: String(pack!.name) });
    expect(res.isError).toBeUndefined();
    // Raw manifest.yaml text, like read_workflow returns the raw graph.
    expect(text(res)).toMatch(/custom_nodes|models/);

    const unknown = await handler()({ action: "read_manifest", name: "definitely-not-a-pack" });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain('No pack named "definitely-not-a-pack"');

    const traversal = await handler()({ action: "read_manifest", name: "../skills-access" });
    expect(traversal.isError).toBe(true);
    expect(text(traversal)).toContain("Invalid pack name");
  });

  it('action:"skill_read" resolves by skill name and reports an unknown one', async () => {
    const res = await handler()({ action: "skill_read", name: "definitely-not-a-skill" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('No skill named "definitely-not-a-skill"');
  });

  it('action:"list_templates" reads the connected server\'s template index', async () => {
    const res = await handler()({ action: "list_templates" });
    expect(global.fetch).toHaveBeenCalledWith(
      "http://comfy.test:8188/api/workflow_templates",
      expect.anything(),
    );
    const parsed = JSON.parse(text(res));
    expect(parsed.source_count).toBe(1);
    expect(parsed.template_count).toBe(1);
  });

  it('action:"list_templates" uses the connected panel route before an unreachable COMFYUI_URL (#2196)', async () => {
    mocks.requestPanelTemplateIndex.mockResolvedValueOnce({
      "panel-pack": [{ name: "live-template" }],
    });
    global.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    }) as unknown as typeof fetch;

    const res = await handler()({ action: "list_templates" });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(text(res))).toMatchObject({
      source_count: 1,
      template_count: 1,
      templates: { "panel-pack": [{ name: "live-template" }] },
    });
    expect(mocks.requestPanelTemplateIndex).toHaveBeenCalledOnce();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('action:"list_templates" does not fall back to COMFYUI_URL after a panel route fails (#2196)', async () => {
    mocks.requestPanelTemplateIndex.mockRejectedValueOnce(new Error("panel template relay failed"));
    global.fetch = vi.fn(async () => {
      throw new Error("headless target must not be tried");
    }) as unknown as typeof fetch;

    const res = await handler()({ action: "list_templates" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("panel template relay failed");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('action:"list_templates" uses the shared auth and proxy-prefix path', async () => {
    comfyui.baseUrl = "https://remote.example/comfyapi";
    comfyui.authHeaders = { "X-Proxy-Token": "Token proxy-secret" };

    const res = await handler()({ action: "list_templates" });
    expect(res.isError).toBeUndefined();

    const fetchMock = global.fetch as unknown as {
      mock: { calls: Array<[string, RequestInit?]> };
    };
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://remote.example/comfyapi/api/workflow_templates");
    expect(new Headers(init?.headers).get("X-Proxy-Token")).toBe("Token proxy-secret");
  });

  it('action:"check_runtime" classifies the given graph and adds the guidance line', async () => {
    mocks.checkWorkflowRuntime.mockResolvedValueOnce({
      runtime: "api",
      usesApiNodes: true,
      apiNodes: ["SomeApiNode"],
      unknownNodes: [],
    });
    const graph = { "1": { class_type: "SomeApiNode", inputs: {} } };
    const res = await handler()({ action: "check_runtime", graph });
    expect(mocks.checkWorkflowRuntime).toHaveBeenCalledWith(graph, undefined, {
      bundledLocalPack: false,
    });
    const parsed = JSON.parse(text(res));
    expect(parsed.runtime).toBe("api");
    expect(parsed.guidance).toContain("PAID api credits");
  });

  it('action:"check_runtime" with neither pack nor graph keeps the old "provide either" error', async () => {
    const res = await handler()({ action: "check_runtime" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Provide either `pack`");
    expect(mocks.checkWorkflowRuntime).not.toHaveBeenCalled();
  });

  it('action:"extract_deps" passes the parsed workflow + deps and renders the report', async () => {
    mocks.extractWorkflowDependencies.mockResolvedValueOnce({
      classTypes: ["KSampler", "ImpactNode"],
      requiredPacks: ["impact-pack"],
      missingPacks: ["impact-pack"],
      unresolved: [],
      ambiguous: [],
      dependencies: [{ class_type: "ImpactNode", pack: "impact-pack", installed: false }],
    });
    const workflow = { "1": { class_type: "ImpactNode", inputs: {} } };
    const res = await handler()({ action: "extract_deps", workflow });
    expect(mocks.extractWorkflowDependencies).toHaveBeenCalledWith(workflow, { deps: "sentinel" });
    expect(text(res)).toContain("## Workflow dependencies (2 node type(s))");
    expect(text(res)).toContain("**NOT INSTALLED**");
    // The remediation pointer must name the LIVE call, not the retired tool.
    expect(text(res)).toContain('list_packs (action:"install_deps")');
    expect(mocks.installWorkflowDependencies).not.toHaveBeenCalled();
  });

  it('action:"extract_deps" accepts a JSON STRING workflow, as the old tool did', async () => {
    mocks.extractWorkflowDependencies.mockResolvedValueOnce({
      classTypes: [],
      requiredPacks: [],
      missingPacks: [],
      unresolved: [],
      ambiguous: [],
      dependencies: [],
    });
    await handler()({ action: "extract_deps", workflow: '{"1":{"class_type":"KSampler"}}' });
    expect(mocks.extractWorkflowDependencies).toHaveBeenCalledWith(
      { "1": { class_type: "KSampler" } },
      { deps: "sentinel" },
    );
  });

  it('action:"install_deps" passes the parsed workflow + deps and renders the install report', async () => {
    mocks.installWorkflowDependencies.mockResolvedValueOnce({
      installed: ["impact-pack"],
      alreadyInstalled: [],
      unresolved: [],
      ambiguous: [],
      queue: { total_count: 1, done_count: 0, in_progress_count: 1, is_processing: true },
    });
    const workflow = { "1": { class_type: "ImpactNode", inputs: {} } };
    const res = await handler()({ action: "install_deps", workflow });
    expect(mocks.installWorkflowDependencies).toHaveBeenCalledWith(workflow, { deps: "sentinel" });
    expect(text(res)).toContain("## Queued 1 node pack(s) for install");
    expect(text(res)).toContain("### Manager queue status");
  });

  // #2765 — the resolver refusing to name an owner only helps if the RENDERED
  // reply says so. Silence reads as "nothing else is needed", which is the
  // reading that let an approval-gated preflight point at an unrelated repo.
  it('action:"extract_deps" renders ambiguous ownership with every claimant, naming no owner', async () => {
    mocks.extractWorkflowDependencies.mockResolvedValueOnce({
      classTypes: ["Krea2EditGroundedEncode"],
      requiredPacks: [],
      missingPacks: [],
      unresolved: [],
      ambiguous: [
        {
          class_type: "Krea2EditGroundedEncode",
          candidates: ["Anomalous_Model_Browser", "comfyui-krea2edit"],
        },
      ],
      dependencies: [
        {
          class_type: "Krea2EditGroundedEncode",
          pack: null,
          builtin: false,
          installed: false,
          source: "ambiguous",
          candidates: ["Anomalous_Model_Browser", "comfyui-krea2edit"],
        },
      ],
    });
    const res = await handler()({
      action: "extract_deps",
      workflow: { "1": { class_type: "Krea2EditGroundedEncode", inputs: {} } },
    });
    const out = text(res);
    expect(out).toContain("### Ambiguous ownership (1)");
    expect(out).toContain("claimed by: Anomalous_Model_Browser, comfyui-krea2edit");
    expect(out).toContain("will not install them");
    // codex gate P1 — an ambiguous-only workflow has zero requiredPacks, and the
    // summary used to open by declaring the graph all-built-in. That is the
    // reassuring reading, printed ABOVE the warning that contradicts it.
    expect(out).not.toContain("All node types are core/built-in");
    expect(out).toContain("No custom node pack could be attributed to 1");
    // The per-node line must not present one claimant as the answer.
    expect(out).toContain("`Krea2EditGroundedEncode` → AMBIGUOUS");
    // And it must NOT be laundered through the missing-pack remediation path.
    expect(out).not.toContain("### Missing packs");
  });

  // codex gate round 3, P1 — an INSTALLED custom node whose /object_info carries
  // no python_module and which Manager cannot name lands in neither the
  // `ambiguous` nor the `unresolved` list, so a summary counted off those two
  // lists called the graph all-built-in while such a node sat in it.
  it('action:"extract_deps" does not call a graph all-built-in when a node has no attributable pack', async () => {
    mocks.extractWorkflowDependencies.mockResolvedValueOnce({
      classTypes: ["MysteryNode"],
      requiredPacks: [],
      missingPacks: [],
      unresolved: [],
      ambiguous: [],
      dependencies: [
        {
          class_type: "MysteryNode",
          pack: null,
          builtin: false,
          installed: true,
          source: "unresolved",
        },
      ],
    });
    const out = text(
      await handler()({
        action: "extract_deps",
        workflow: { "1": { class_type: "MysteryNode", inputs: {} } },
      }),
    );
    expect(out).not.toContain("All node types are core/built-in");
    expect(out).toContain("No custom node pack could be attributed to 1");
  });

  // codex gate round 3, P1 — same contradiction on the install path for an
  // unresolved-only run: nothing was installed BECAUSE nothing could be resolved.
  it('action:"install_deps" does not say "no packs needed" when packs went unresolved', async () => {
    mocks.installWorkflowDependencies.mockResolvedValueOnce({
      installed: [],
      alreadyInstalled: [],
      unresolved: ["Some-Pack"],
      ambiguous: [],
    });
    const out = text(
      await handler()({
        action: "install_deps",
        workflow: { "1": { class_type: "SomeNode", inputs: {} } },
      }),
    );
    expect(out).not.toContain("No packs needed installation");
    expect(out).toContain("Nothing installed — 1 item(s) could not be resolved to a pack");
  });

  it('action:"install_deps" reports what it deliberately did NOT install', async () => {
    mocks.installWorkflowDependencies.mockResolvedValueOnce({
      installed: [],
      alreadyInstalled: [],
      unresolved: [],
      ambiguous: [
        {
          class_type: "Krea2EditGroundedEncode",
          candidates: ["Anomalous_Model_Browser", "comfyui-krea2edit"],
        },
      ],
    });
    const res = await handler()({
      action: "install_deps",
      workflow: { "1": { class_type: "Krea2EditGroundedEncode", inputs: {} } },
    });
    const out = text(res);
    expect(out).toContain("### Not installed — ambiguous ownership (1)");
    expect(out).toContain("claimed by: Anomalous_Model_Browser, comfyui-krea2edit");
    // Nothing was installed BECAUSE we could not tell what to install — the
    // opposite of "no packs needed".
    expect(out).not.toContain("No packs needed installation");
    expect(out).toContain("Nothing installed — 1 item(s) could not be resolved to a pack");
  });

  it('action:"generate_skill" forwards source + refresh and keeps structuredContent', async () => {
    mocks.generateSkillCached.mockResolvedValueOnce({
      markdown: "# SKILL",
      cacheHit: true,
      safeKey: "k",
      cacheDir: "/cache",
      metadata: { version: "1.2.3" },
    });
    const res = await handler()({
      action: "generate_skill",
      source: "comfyui-impact-pack",
      refresh: true,
    });
    expect(mocks.generateSkillCached).toHaveBeenCalledWith("comfyui-impact-pack", {
      refresh: true,
    });
    expect(text(res)).toBe("# SKILL");
    // The return SHAPE is part of the contract the retired tool had.
    expect(res.structuredContent).toEqual({
      cache_hit: true,
      cache_key: "k",
      cache_dir: "/cache",
      version: "1.2.3",
    });
  });

  it('action:"generate_skill" still writes SKILL.md when install_in is given', async () => {
    mocks.generateSkillCached.mockResolvedValueOnce({
      markdown: "# WRITTEN",
      cacheHit: false,
      safeKey: "k",
      cacheDir: "/cache",
      metadata: { version: "9" },
    });
    const dir = await mkdtemp(join(tmpdir(), "comfyui-mcp-skillgen-"));
    try {
      const res = await handler()({
        action: "generate_skill",
        source: "x",
        install_in: join(dir, "nested"),
      });
      expect(await readFile(join(dir, "nested", "SKILL.md"), "utf8")).toBe("# WRITTEN");
      expect(text(res)).toContain("Skill file written to");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * THE MUTATION BOUNDARY. `list_packs` reads like a listing tool; one of its nine
 * actions installs third-party code. Nothing but that action may reach it.
 */
describe("only action:\"install_deps\" can reach the install service", () => {
  it("no other action calls installWorkflowDependencies, whatever else it is passed", async () => {
    // Every action is driven with a FULL argument bag, so an action that
    // mistakenly fell through to the install branch would have the workflow it
    // needs to succeed rather than failing on a missing field.
    mocks.checkWorkflowRuntime.mockResolvedValue({
      runtime: "local",
      usesApiNodes: false,
      apiNodes: [],
      unknownNodes: [],
    });
    mocks.extractWorkflowDependencies.mockResolvedValue({
      classTypes: [],
      requiredPacks: [],
      missingPacks: [],
      unresolved: [],
      ambiguous: [],
      dependencies: [],
    });
    mocks.generateSkillCached.mockResolvedValue({
      markdown: "#",
      cacheHit: true,
      safeKey: "k",
      cacheDir: "/c",
      metadata: { version: "1" },
    });
    for (const action of ACTIONS.filter((a) => a !== "install_deps")) {
      await handler()({
        action,
        name: "krea2-txt2img",
        pack: "krea2-txt2img",
        graph: { "1": { class_type: "KSampler", inputs: {} } },
        workflow: { "1": { class_type: "KSampler", inputs: {} } },
        source: "comfyui-impact-pack",
      });
      expect(
        mocks.installWorkflowDependencies,
        `action:"${action}" must not reach the install service`,
      ).not.toHaveBeenCalled();
    }
  });
});

describe("per-action presence guards (the flat shape cannot schema-require these)", () => {
  it("read_workflow/read_manifest/skill_read without a name name the field and call nothing", async () => {
    for (const action of ["read_workflow", "read_manifest", "skill_read"]) {
      const res = await handler()({ action });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain(`list_packs action:"${action}" requires \`name\``);
    }
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });

  it("extract_deps/install_deps without a workflow name the field and call nothing", async () => {
    for (const action of ["extract_deps", "install_deps"]) {
      const res = await handler()({ action });
      expect(res.isError).toBe(true);
      expect(text(res)).toContain(`list_packs action:"${action}" requires \`workflow\``);
    }
    expect(mocks.extractWorkflowDependencies).not.toHaveBeenCalled();
    expect(mocks.installWorkflowDependencies).not.toHaveBeenCalled();
  });

  it('action:"generate_skill" without a source names the field and calls nothing', async () => {
    const res = await handler()({ action: "generate_skill" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('list_packs action:"generate_skill" requires `source`');
    expect(mocks.generateSkillCached).not.toHaveBeenCalled();
  });

  // The guards test ABSENCE, not falsiness. `source: ""` passed z.string() before
  // this consolidation and reached generateSkillCached, and `workflow: ""` passed
  // the union and reached the parser, which answers with its own ValidationError.
  // A `!x` guard would swallow both and substitute generic text.
  it("an explicitly empty source still reaches the service, as before", async () => {
    mocks.generateSkillCached.mockResolvedValueOnce({
      markdown: "#",
      cacheHit: false,
      safeKey: "k",
      cacheDir: "/c",
      metadata: { version: "1" },
    });
    await handler()({ action: "generate_skill", source: "" });
    expect(mocks.generateSkillCached).toHaveBeenCalledWith("", { refresh: undefined });
  });

  it("an explicitly empty workflow still reaches the parser's own error, as before", async () => {
    const res = await handler()({ action: "extract_deps", workflow: "" });
    expect(res.isError).toBe(true);
    // The service's/parser's own validation error, NOT the presence guard's text.
    expect(text(res)).toContain("Invalid JSON string");
    expect(text(res)).not.toContain("requires `workflow`");
  });
});

describe("the eight knowledge names are retired", () => {
  const old = [
    "read_pack_workflow",
    "list_workflow_templates",
    "check_workflow_runtime",
    "extract_workflow_dependencies",
    "install_workflow_dependencies",
    "list_skills",
    "read_skill",
    "generate_node_skill",
  ];

  it("each old name is in DEAD_NAMES with a `list_packs` replacement", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.50.0");
      expect(entry!.replacement).toContain("list_packs");
    }
  });

  it("no old name is still in the live ledger, and `list_packs` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("list_packs");
  });

  // An action may never be spelled the same as a name the SAME fold retires: the
  // dead-name gate matches the bare token, so the replacement text a prose sweep
  // has to write (`list_packs (action:"list_skills")`) would itself read as a live
  // reference to the dead tool, and no sweep could ever go green. This is why
  // list_skills → action:"skill_list" and read_skill → action:"skill_read".
  it("no action is spelled the same as any retired name", () => {
    const dead = new Set(DEAD_NAMES.map((d) => d.name));
    for (const action of ACTIONS) expect(dead.has(action)).toBe(false);
  });
});

/**
 * #2748 — a workflow miss must not advertise the pack it just refused.
 *
 * Not every bundled pack ships a graph: an installer-only pack declares
 * `workflow: null` in pack.yaml (qwen-image, ltx-2.3 at time of writing), and
 * action:"list" correctly reports has_workflow: false for it. But both workflow
 * exits built their suggestion list as `enumeratePacks().map(p => p.name)` with
 * NO has_workflow filter, under a sentence promising "with a ready workflow" —
 * so check_runtime refused qwen-image and then listed qwen-image as an
 * available pack. Copying a name out of that list reproduced the same refusal,
 * which reads as the catalog disagreeing with the filesystem.
 *
 * These drive the REAL handler over the REAL bundled packs/ dir, so they fail
 * if the filter is removed or if a future pack breaks the invariant.
 */
describe("list_packs — workflow-miss suggestions (#2748)", () => {
  /** Parse the suggestion sentence into EXACT names.
   *
   *  Two parsing traps, both of which silently pass a broken assertion:
   *  - Substring matching is wrong — "qwen-image" is a prefix of
   *    "qwen-image-edit", so `toContain("qwen-image")` matches the wrong pack.
   *  - Pack names CONTAIN dots (ltx-2.3, ltx-2.3-flf, ...), so stopping the
   *    capture at the first "." truncates the list to a name that does not
   *    exist ("ltx-2"). The suggestion is the last sentence, so take the rest
   *    of the message and strip only the trailing period. */
  function suggestedNames(message: string): string[] {
    const m = /Packs with a ready workflow: (.*)$/.exec(message);
    if (!m) return [];
    return m[1]
      .replace(/\.\s*$/, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** A really-bundled pack that ships NO workflow — the #2748 shape. */
  function installerOnlyPack(): string {
    const pack = enumeratePacks().find((p) => p.has_workflow === false);
    // Premise check: if every bundled pack ever gains a workflow this whole
    // describe block is vacuous, so fail loudly rather than pass silently.
    expect(pack, "expected at least one bundled installer-only pack").toBeDefined();
    return String(pack!.name);
  }

  it('action:"check_runtime" on an installer-only pack does not deny the pack exists', async () => {
    const name = installerOnlyPack();
    const res = await handler()({ action: "check_runtime", pack: name });
    expect(res.isError).toBe(true);
    // It DOES exist and action:"list" lists it — claiming otherwise is the bug.
    expect(text(res)).not.toContain(`No pack named "${name}"`);
    expect(text(res)).toContain("ships no workflow");
  });

  it('action:"check_runtime" never suggests a pack that has no ready workflow', async () => {
    const name = installerOnlyPack();
    const res = await handler()({ action: "check_runtime", pack: name });
    const suggested = suggestedNames(text(res));
    expect(suggested.length).toBeGreaterThan(0);
    expect(suggested).not.toContain(name);
    // Every suggestion must survive the resolver the action itself uses.
    const ready = new Set(
      enumeratePacks()
        .filter((p) => p.has_workflow)
        .map((p) => String(p.name)),
    );
    for (const s of suggested) expect(ready.has(s)).toBe(true);
  });

  it('action:"read_workflow" on an installer-only pack explains it and suggests only ready packs', async () => {
    const name = installerOnlyPack();
    const res = await handler()({ action: "read_workflow", name });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("ships no workflow");
    expect(suggestedNames(text(res))).not.toContain(name);
  });

  it('action:"read_workflow" on an unknown pack suggests only packs with a ready workflow', async () => {
    const res = await handler()({ action: "read_workflow", name: "definitely-not-a-pack" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('No pack named "definitely-not-a-pack"');
    expect(suggestedNames(text(res))).not.toContain(installerOnlyPack());
  });

  it('action:"read_manifest" still suggests ALL packs — an installer-only pack HAS a manifest', async () => {
    // Deliberately NOT filtered by has_workflow: read_manifest answers a
    // different question, and hiding installer-only packs here would break the
    // one action they exist for.
    const name = installerOnlyPack();
    const res = await handler()({ action: "read_manifest", name });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toMatch(/custom_nodes|models/);
  });
});

/**
 * #2748 — action:"list" must derive has_workflow from the SAME filename the
 * resolver opens.
 *
 * The reported symptom (has_workflow: true alongside "workflow.json not found")
 * was reachable through a real divergence: enumeratePacks() took `meta.workflow`
 * verbatim, while resolvePackWorkflowFile() rejected any value that is not a
 * single safe path segment and silently fell back to workflow.json. A pack
 * declaring `workflow: "sub/graph.json"` would therefore advertise a graph the
 * resolver would never open. Today's bundled packs happen not to declare such a
 * value, so a corpus test alone cannot see it — the shared derivation is pinned
 * directly instead.
 */
describe("pack workflow filename — one derivation (#2748)", () => {
  it("falls back to workflow.json for every value the resolver would reject", () => {
    for (const declared of [
      "sub/graph.json", // separator — resolver falls back, list must too
      "../escape.json", // traversal
      "..",
      "sub\\graph.json", // Windows separator
      "", // empty
      ".hidden.json", // SAFE_NAME requires an alphanumeric first char
    ]) {
      expect(resolveWorkflowFileName({ workflow: declared })).toBe("workflow.json");
    }
  });

  it("keeps a safe declared filename, and defaults when none is declared", () => {
    expect(resolveWorkflowFileName({ workflow: "graph.json" })).toBe("graph.json");
    expect(resolveWorkflowFileName({ workflow: "workflow.json" })).toBe("workflow.json");
    // `workflow: null` (installer-only), absent, and non-string all default.
    expect(resolveWorkflowFileName({ workflow: null })).toBe("workflow.json");
    expect(resolveWorkflowFileName({})).toBe("workflow.json");
    expect(resolveWorkflowFileName({ workflow: 42 })).toBe("workflow.json");
    expect(resolveWorkflowFileName(null)).toBe("workflow.json");
    expect(resolveWorkflowFileName(undefined)).toBe("workflow.json");
  });

  /** The invariant the issue actually reports, over the REAL bundled corpus:
   *  action:"list" and the resolver must agree for every pack, always. */
  it("has_workflow agrees with resolvePackWorkflowFile for every bundled pack", () => {
    const packs = enumeratePacks();
    expect(packs.length).toBeGreaterThan(0);
    const disagreements = packs
      .map((p) => ({
        name: String(p.name),
        listed: p.has_workflow === true,
        resolved: resolvePackWorkflowFile(String(p.name)) !== null,
      }))
      .filter((r) => r.listed !== r.resolved);
    expect(disagreements).toEqual([]);
  });
});

/**
 * #2748 (gate round 2) — the workflow-miss message must not explain a state it
 * never checked.
 *
 * "Installer-only" is a deliberate, working-as-intended state. The first draft
 * of this fix returned that sentence for EVERY non-string `workflow` value, so a
 * malformed pack.yaml, a missing pack.yaml, or `workflow: 42` — all broken
 * bundles — were reported as intentional, hiding the breakage behind a
 * reassuring explanation. That is the same defect (a message asserting an
 * unverified cause) the rest of this change removes.
 *
 * The classifier is pure so every branch is reachable without planting fixture
 * directories in the real packs/ tree.
 */
describe("describeMissingWorkflow — states are not collapsed (#2748)", () => {
  const INSTALLER_ONLY = /installer-only/;

  it("calls a pack.yaml-less directory what it is, and does not claim list reports it", () => {
    const msg = describeMissingWorkflow("stray-dir", { hasPackYaml: false, meta: null });
    expect(msg).toMatch(/no pack\.yaml/);
    expect(msg).not.toMatch(INSTALLER_ONLY);
    // action:"list" requires a pack.yaml to treat a directory as a pack, so a
    // has_workflow footnote here would describe a row that does not exist.
    expect(msg).not.toMatch(/has_workflow/);
  });

  it("reports unparseable pack.yaml as unparseable, not as installer-only", () => {
    const msg = describeMissingWorkflow("broken", { hasPackYaml: true, meta: null });
    expect(msg).toMatch(/did not parse to a YAML mapping/);
    expect(msg).not.toMatch(INSTALLER_ONLY);
  });

  it("reports a non-string `workflow` as a bad declaration, not as installer-only", () => {
    for (const declared of [42, true, [], {}]) {
      const msg = describeMissingWorkflow("odd", {
        hasPackYaml: true,
        meta: { workflow: declared },
      });
      expect(msg).toMatch(/rather than a filename/);
      expect(msg).not.toMatch(INSTALLER_ONLY);
    }
  });

  it("reports a declared-but-absent workflow file as a broken bundle, naming the file", () => {
    const msg = describeMissingWorkflow("broken-bundle", {
      hasPackYaml: true,
      meta: { workflow: "graph.json" },
    });
    expect(msg).toMatch(/declared workflow file \(graph\.json\) is missing/);
    expect(msg).not.toMatch(INSTALLER_ONLY);
  });

  it("names the SANITIZED filename it actually looked for, not the raw declaration", () => {
    // An unsafe declaration falls back to workflow.json in the resolver, so the
    // message must name workflow.json — quoting "sub/graph.json" would send the
    // reader hunting for a file the code never opened.
    const msg = describeMissingWorkflow("unsafe", {
      hasPackYaml: true,
      meta: { workflow: "sub/graph.json" },
    });
    expect(msg).toMatch(/\(workflow\.json\) is missing/);
    expect(msg).not.toContain("sub/graph.json");
  });

  it("ONLY an EXPLICIT `workflow: null` is called installer-only", () => {
    const msg = describeMissingWorkflow("qwen-image", {
      hasPackYaml: true,
      meta: { workflow: null },
    });
    expect(msg).toMatch(INSTALLER_ONLY);
    expect(msg).toMatch(/has_workflow: false/);
  });

  it("an OMITTED workflow key is not treated as a declaration of installer-only", () => {
    // All 56 bundled packs write `workflow:` explicitly, so an absent key
    // expresses no intent — the author may equally have meant workflow.json to
    // be present. Blessing it as installer-only would hide a broken pack.
    const msg = describeMissingWorkflow("no-key", { hasPackYaml: true, meta: {} });
    expect(msg).not.toMatch(INSTALLER_ONLY);
    expect(msg).toMatch(/no `workflow` key/);
    expect(msg).toMatch(/default workflow\.json is not in the pack/);
  });
});

/**
 * #2748 (gate round 3) — a top-level YAML SEQUENCE is not metadata.
 *
 * `parseYaml("[]")` is truthy and `typeof === "object"`, so the obvious
 * `parsed && typeof parsed === "object"` check accepts it as a record. Every
 * field then reads `undefined`, and `workflow: undefined` is indistinguishable
 * from a deliberate `workflow: null` — so `pack.yaml` containing `[]` had its
 * malformed bundle reported as an intentional "installer-only" pack.
 */
describe("coercePackMeta — only a YAML mapping is metadata (#2748)", () => {
  it("rejects a top-level sequence, which is truthy AND typeof object", () => {
    expect([] as unknown).toBeTruthy();
    expect(typeof []).toBe("object");
    // …and is therefore exactly what a naive object check lets through.
    expect(coercePackMeta([])).toBeNull();
    expect(coercePackMeta([{ workflow: "graph.json" }])).toBeNull();
  });

  it("rejects scalars, null and undefined", () => {
    for (const v of [null, undefined, "", "text", 0, 42, false, true]) {
      expect(coercePackMeta(v)).toBeNull();
    }
  });

  it("accepts a mapping unchanged", () => {
    const meta = { workflow: "graph.json", family: "qwen" };
    expect(coercePackMeta(meta)).toEqual(meta);
    expect(coercePackMeta({})).toEqual({});
  });

  it("a sequence pack.yaml is described as unparseable, NOT as installer-only", () => {
    // The end-to-end consequence: readPackMeta returns null for `[]`, and the
    // classifier's null branch says so rather than inventing an intent.
    const msg = describeMissingWorkflow("seq-pack", {
      hasPackYaml: true,
      meta: coercePackMeta([]),
    });
    expect(msg).toMatch(/did not parse to a YAML mapping/);
    expect(msg).not.toMatch(/installer-only/);
  });
});
