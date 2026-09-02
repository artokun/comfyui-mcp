import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";
import { ValidationError } from "../../utils/errors.js";

/**
 * The consolidated `node_pack` tool (0.50.0 slice 12): the nine custom-node
 * AUTHORING tools folded into one action-parameterized tool under a genuinely
 * new name. Proves the consolidation did not change behaviour — every action
 * calls the identical service the old tool called, with the same arguments and
 * the same content block — and that the flat-enum shape actually EXPOSES its
 * parameters (the discriminated-union trap renders zero params).
 *
 * Absorbs the coverage of the retired node-authoring tool test: that the
 * scaffold/publish descriptions still carry their LOCAL-ONLY and IRREVERSIBLE
 * warnings, that snake_case args are mapped to the services' camelCase options,
 * and that a service throw becomes an isError result rather than a crash.
 */

const mocks = vi.hoisted(() => ({
  scaffoldCustomNode: vi.fn(),
  publishCustomNode: vi.fn(),
  verifyCustomNode: vi.fn(),
  listNodePackFiles: vi.fn(),
  readNodeFile: vi.fn(),
  searchNodePacks: vi.fn(),
  writeNodeFile: vi.fn(),
  applyNodePatch: vi.fn(),
  nodePackGit: vi.fn(),
  resolveCustomNodesScanBaseLive: vi.fn(),
}));

vi.mock("../../services/node-authoring.js", () => ({
  scaffoldCustomNode: (...a: unknown[]) => mocks.scaffoldCustomNode(...a),
  publishCustomNode: (...a: unknown[]) => mocks.publishCustomNode(...a),
}));

vi.mock("../../services/node-verify.js", () => ({
  verifyCustomNode: (...a: unknown[]) => mocks.verifyCustomNode(...a),
}));

// The handler resolves the local install base ASYNC and live-aware (#1653)
// before dispatching to the sync authoring services; seam it so no test
// depends on real config or a reachable server.
vi.mock("../../services/workspace-env.js", () => ({
  resolveCustomNodesScanBaseLiveStrict: (...a: unknown[]) =>
    mocks.resolveCustomNodesScanBaseLive(...a),
}));

vi.mock("../../services/node-dev.js", () => ({
  listNodePackFiles: (...a: unknown[]) => mocks.listNodePackFiles(...a),
  readNodeFile: (...a: unknown[]) => mocks.readNodeFile(...a),
  searchNodePacks: (...a: unknown[]) => mocks.searchNodePacks(...a),
  writeNodeFile: (...a: unknown[]) => mocks.writeNodeFile(...a),
  applyNodePatch: (...a: unknown[]) => mocks.applyNodePatch(...a),
  nodePackGit: (...a: unknown[]) => mocks.nodePackGit(...a),
  // The clamp constants the descriptions quote — real numbers so the rendered
  // prose is checked against something, not against `undefined`.
  READ_DEFAULT_LINES: 400,
  READ_MAX_LINES: 2000,
  READ_DEFAULT_CHARS: 12000,
  READ_MAX_CHARS: 24000,
  SEARCH_DEFAULT_RESULTS: 50,
  SEARCH_MAX_RESULTS: 200,
  CMD_OUTPUT_MAX: 12000,
  LIST_DEFAULT_ENTRIES: 300,
  LIST_MAX_ENTRIES: 2000,
  MIN_OUTPUT_CHARS: 240,
}));

import { registerNodePackTools } from "../../tools/node-pack.js";

type Handler = (args: Record<string, any>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

interface Registered {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  handler: Handler;
}

function registered(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    tool: (name: string, description: string, shape: z.ZodRawShape, handler: Handler) => {
      tools.push({ name, description, shape, handler });
    },
  };
  registerNodePackTools(server as never);
  return tools;
}

function handler(): Handler {
  const tools = registered();
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("node_pack");
  return tools[0].handler;
}

const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

const ALL_SERVICES = [
  "scaffoldCustomNode",
  "publishCustomNode",
  "verifyCustomNode",
  "listNodePackFiles",
  "readNodeFile",
  "searchNodePacks",
  "writeNodeFile",
  "applyNodePatch",
  "nodePackGit",
] as const;

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  for (const name of ALL_SERVICES) mocks[name].mockReturnValue({ ok: true });
  mocks.verifyCustomNode.mockResolvedValue({ ok: true });
  // Default: no local base resolvable — the service's own refusal is what a
  // caller must see then.
  mocks.resolveCustomNodesScanBaseLive.mockResolvedValue(undefined);
});

describe("node_pack registration", () => {
  it("registers exactly one tool named `node_pack` (9→1)", () => {
    const tools = registered();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("node_pack");
  });

  // The whole reason for the flat-enum shape rule: a z.discriminatedUnion renders
  // as ZERO parameters, hiding every input from the model.
  it("exposes a visible flat `action` enum with every per-action parameter", () => {
    const [{ shape }] = registered();
    // io: "input" — the conversion options the MCP SDK itself uses, so this is
    // the schema a client is actually given.
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action",
      "case_sensitive",
      "category",
      "class_types",
      "content",
      "create_dirs",
      "description",
      "display_name",
      "git_action",
      "glob",
      "line_count",
      "max_chars",
      "max_entries",
      "max_results",
      "message",
      "name",
      "overwrite",
      "pack",
      "patch",
      "path",
      "paths",
      "publisher_id",
      "query",
      "restart",
      "start_line",
      "with_ci",
      "with_frontend",
    ]);
    expect(json.properties?.action.enum?.sort()).toEqual([
      "git",
      "list_files",
      "patch",
      "publish",
      "read",
      "scaffold",
      "search",
      "verify",
      "write",
    ]);
    // Only `action` can be required — the rest are per-action, enforced in the handler.
    expect(json.required).toEqual(["action"]);
  });

  // The ONE argument the fold could not preserve: node_pack_git's own `action`
  // collided with the dispatch field. It must still exist, under `git_action`,
  // with the identical five values — dropping one would silently remove a git
  // operation the retired tool could run.
  it("keeps the git sub-action under `git_action` with all five values", () => {
    const [{ shape }] = registered();
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
    };
    expect(json.properties?.git_action.enum).toEqual([
      "status",
      "diff",
      "log",
      "commit",
      "push",
    ]);
  });

  it("keeps the descriptions' local-only and irreversible warnings", () => {
    const [{ description }] = registered();
    expect(description).toMatch(/LOCAL-ONLY/);
    expect(description).toMatch(/jailed to custom_nodes/);
    expect(description).toMatch(/pack-relative paths to stage\/scope/);
    // scaffold's and publish's original warnings, both carried into the
    // per-action prose rather than lost in the merge.
    expect(description).toMatch(/IRREVERSIBLE, EXTERNAL action/);
    expect(description).toMatch(/COMFYUI_MCP_ALLOW_GIT_WRITES=1/);
    // The real clamps, quoted from the exported constants (#809), not hand-typed.
    expect(description).toMatch(/install_custom_node/);
  });

  it("an unknown action returns a clear error result", async () => {
    const res = await handler()({ action: "bogus" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unknown node_pack action/i);
    expect(text(res)).toMatch(/list_files/);
  });
});

describe("node_pack actions call the same services with the same arguments", () => {
  it('action:"scaffold" maps every snake_case arg to its camelCase option', async () => {
    mocks.scaffoldCustomNode.mockReturnValueOnce({ created: ["pyproject.toml"] });
    const res = await handler()({
      action: "scaffold",
      name: "my-pack",
      display_name: "My Pack",
      category: "custom/mine",
      description: "does things",
      publisher_id: "pub123",
      with_frontend: true,
      with_ci: true,
      overwrite: true,
    });
    expect(mocks.scaffoldCustomNode).toHaveBeenCalledWith(
      {
        name: "my-pack",
        displayName: "My Pack",
        category: "custom/mine",
        description: "does things",
        publisherId: "pub123",
        withFrontend: true,
        withCi: true,
        overwrite: true,
      },
      undefined,
      undefined,
    );
    expect(JSON.parse(text(res))).toEqual({ created: ["pyproject.toml"] });
  });

  it('action:"verify" maps class_types → classTypes and passes restart', async () => {
    mocks.verifyCustomNode.mockResolvedValueOnce({ registered: ["MyNode"] });
    const res = await handler()({
      action: "verify",
      name: "my-pack",
      class_types: ["MyNode"],
      restart: false,
    });
    expect(mocks.verifyCustomNode).toHaveBeenCalledWith({
      name: "my-pack",
      classTypes: ["MyNode"],
      restart: false,
    });
    expect(JSON.parse(text(res))).toEqual({ registered: ["MyNode"] });
  });

  it('action:"publish" takes name or path, and needs neither', async () => {
    await handler()({ action: "publish", name: "my-pack" });
    expect(mocks.publishCustomNode).toHaveBeenCalledWith(
      { name: "my-pack", path: undefined },
      undefined,
      undefined,
    );
    await handler()({ action: "publish", path: "/abs/packs/my-pack" });
    expect(mocks.publishCustomNode).toHaveBeenCalledWith(
      {
        name: undefined,
        path: "/abs/packs/my-pack",
      },
      undefined,
      undefined,
    );
  });

  it('action:"list_files" maps max_entries → maxEntries', async () => {
    await handler()({ action: "list_files", pack: "MyPack", glob: "**/*.py", max_entries: 10 });
    expect(mocks.listNodePackFiles).toHaveBeenCalledWith(
      {
        pack: "MyPack",
        glob: "**/*.py",
        maxEntries: 10,
      },
      undefined,
      undefined,
    );
  });

  it('action:"read" maps start_line/line_count/max_chars', async () => {
    await handler()({
      action: "read",
      path: "MyPack/nodes.py",
      start_line: 20,
      line_count: 50,
      max_chars: 3000,
    });
    expect(mocks.readNodeFile).toHaveBeenCalledWith(
      {
        path: "MyPack/nodes.py",
        startLine: 20,
        lineCount: 50,
        maxChars: 3000,
      },
      undefined,
      undefined,
    );
  });

  it('action:"search" maps max_results/case_sensitive and reuses `path` as the search root', async () => {
    await handler()({
      action: "search",
      query: "class Foo",
      path: "MyPack",
      glob: "**/*.py",
      max_results: 7,
      case_sensitive: true,
    });
    expect(mocks.searchNodePacks).toHaveBeenCalledWith(
      {
        query: "class Foo",
        path: "MyPack",
        glob: "**/*.py",
        maxResults: 7,
        caseSensitive: true,
      },
      undefined,
      undefined,
    );
  });

  it('action:"write" maps create_dirs → createDirs', async () => {
    await handler()({
      action: "write",
      path: "MyPack/nodes.py",
      content: "x = 1\n",
      overwrite: true,
      create_dirs: false,
    });
    expect(mocks.writeNodeFile).toHaveBeenCalledWith(
      {
        path: "MyPack/nodes.py",
        content: "x = 1\n",
        overwrite: true,
        createDirs: false,
      },
      undefined,
      undefined,
    );
  });

  it('action:"patch" passes the diff POSITIONALLY, as the retired tool did', async () => {
    await handler()({ action: "patch", patch: "--- a/MyPack/x.py\n+++ b/MyPack/x.py\n" });
    expect(mocks.applyNodePatch).toHaveBeenCalledWith(
      "--- a/MyPack/x.py\n+++ b/MyPack/x.py\n",
      undefined,
      undefined,
    );
  });

  it('action:"git" hands `git_action` to the service under its original `action` key', async () => {
    await handler()({
      action: "git",
      pack: "MyPack",
      git_action: "commit",
      message: "fix: thing",
      paths: ["x.py"],
      max_chars: 5000,
    });
    expect(mocks.nodePackGit).toHaveBeenCalledWith(
      {
        pack: "MyPack",
        action: "commit",
        message: "fix: thing",
        paths: ["x.py"],
        maxChars: 5000,
      },
      undefined,
      undefined,
    );
  });

  it("turns a service throw into an isError result rather than crashing", async () => {
    mocks.scaffoldCustomNode.mockImplementationOnce(() => {
      throw new ValidationError("name must be a safe slug");
    });
    const res = await handler()({ action: "scaffold", name: "..", display_name: "X" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("name must be a safe slug");
  });
});

describe("node_pack adopts the trusted live workspace (#1653)", () => {
  it('action:"scaffold" threads the live-resolved local base to the service', async () => {
    // The session shape from #1653: install_comfyui (action:"environment")
    // detected the trusted local workspace, but neither COMFYUI_PATH nor a
    // default workspace is set. The handler must hand that running server's
    // root to scaffold instead of letting it refuse as "no local install".
    mocks.resolveCustomNodesScanBaseLive.mockResolvedValueOnce("/live/ComfyUI");
    await handler()({ action: "scaffold", name: "my-pack", display_name: "My Pack" });
    expect(mocks.scaffoldCustomNode).toHaveBeenCalledWith(
      expect.objectContaining({ name: "my-pack" }),
      undefined,
      "/live/ComfyUI",
    );
  });

  it('does not let a fail-closed scan-root refusal fall back to COMFYUI_PATH', async () => {
    mocks.resolveCustomNodesScanBaseLive.mockRejectedValueOnce(
      new ValidationError(
        'The connected ComfyUI declares --base-directory "C:/missing" but that directory is currently unavailable. Refusing to use COMFYUI_PATH or the main.py checkout because custom_nodes would be written where this runtime does not scan.',
      ),
    );

    const result = await handler()({
      action: "scaffold",
      name: "my-pack",
      display_name: "My Pack",
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/currently unavailable/);
    expect(text(result)).toMatch(/does not scan/);
    expect(mocks.scaffoldCustomNode).not.toHaveBeenCalled();
  });

  it('action:"publish" by name resolves the live base; an explicit path never probes it', async () => {
    mocks.resolveCustomNodesScanBaseLive.mockResolvedValue("/live/ComfyUI");
    await handler()({ action: "publish", name: "my-pack" });
    expect(mocks.publishCustomNode).toHaveBeenCalledWith(
      { name: "my-pack", path: undefined },
      undefined,
      "/live/ComfyUI",
    );

    mocks.resolveCustomNodesScanBaseLive.mockClear();
    await handler()({ action: "publish", path: "/abs/packs/my-pack" });
    // An explicit path is a self-contained local target (and stays legal in
    // remote mode) — resolving a live base for it would be a wasted probe.
    expect(mocks.resolveCustomNodesScanBaseLive).not.toHaveBeenCalled();
    expect(mocks.publishCustomNode).toHaveBeenCalledWith(
      { name: undefined, path: "/abs/packs/my-pack" },
      undefined,
      undefined,
    );
  });

  it('threads the SAME live-resolved base to verify and every file-touching action (#1715/#2031)', async () => {
    // Authoring AND verification must share one scan-root resolution, so every
    // action receives the resolver's answer — Desktop --base-directory (#1715)
    // or the live checkout on a split install that has no --base-directory
    // (#2031). Here a proven scan root, whatever produced it.
    mocks.resolveCustomNodesScanBaseLive.mockResolvedValue("/live/base-dir");
    await handler()({ action: "verify", name: "MyPack" });
    expect(mocks.verifyCustomNode).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedBase: "/live/base-dir" }),
    );
    await handler()({ action: "list_files", pack: "MyPack" });
    expect(mocks.listNodePackFiles).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      "/live/base-dir",
    );
    await handler()({ action: "read", path: "MyPack/x.py" });
    expect(mocks.readNodeFile).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      "/live/base-dir",
    );
    await handler()({ action: "search", query: "q" });
    expect(mocks.searchNodePacks).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      "/live/base-dir",
    );
    await handler()({ action: "write", path: "MyPack/x.py", content: "c" });
    expect(mocks.writeNodeFile).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      "/live/base-dir",
    );
    await handler()({ action: "patch", patch: "d" });
    expect(mocks.applyNodePatch).toHaveBeenCalledWith("d", undefined, "/live/base-dir");
    await handler()({ action: "git", pack: "MyPack", git_action: "status" });
    expect(mocks.nodePackGit).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      "/live/base-dir",
    );
  });
});

describe("node_pack per-action requiredness names the missing field", () => {
  it.each([
    [{ action: "scaffold", display_name: "X" }, "scaffold", "name"],
    [{ action: "scaffold", name: "my-pack" }, "scaffold", "display_name"],
    [{ action: "list_files" }, "list_files", "pack"],
    [{ action: "read" }, "read", "path"],
    [{ action: "search" }, "search", "query"],
    [{ action: "write", content: "x" }, "write", "path"],
    [{ action: "write", path: "MyPack/x.py" }, "write", "content"],
    [{ action: "patch" }, "patch", "patch"],
    [{ action: "git", git_action: "status" }, "git", "pack"],
    [{ action: "git", pack: "MyPack" }, "git", "git_action"],
  ])("%o names `%s`.`%s`", async (args, action, field) => {
    const res = await handler()(args);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain(`node_pack action:"${action}" requires \`${field}\``);
    for (const name of ALL_SERVICES) expect(mocks[name]).not.toHaveBeenCalled();
  });

  it('action:"verify" and action:"publish" require nothing — the service resolves the pack', async () => {
    expect((await handler()({ action: "verify" })).isError).toBeUndefined();
    expect(mocks.verifyCustomNode).toHaveBeenCalledWith({
      name: undefined,
      classTypes: undefined,
      restart: undefined,
    });
    expect((await handler()({ action: "publish" })).isError).toBeUndefined();
    expect(mocks.publishCustomNode).toHaveBeenCalledWith(
      { name: undefined, path: undefined },
      undefined,
      undefined,
    );
  });
});

/**
 * ABSENCE, not falsiness — and here it is not a nicety. `content: ""` writes an
 * EMPTY FILE, which is how Python packages get their __init__.py; a `!content`
 * guard would refuse a legitimate write. The rest passed z.string() before the
 * fold and reached the service, which answers with its own jail / not-found /
 * invalid-diff error; a falsiness guard would swallow those live answers.
 */
describe("node_pack guards on absence, never falsiness", () => {
  it('content:"" writes an EMPTY file instead of being refused', async () => {
    const res = await handler()({ action: "write", path: "MyPack/__init__.py", content: "" });
    expect(mocks.writeNodeFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "MyPack/__init__.py", content: "" }),
      undefined,
      undefined,
    );
    expect(text(res)).not.toContain("requires `content`");
  });

  it("empty strings still reach the service for pack/path/query/patch", async () => {
    await handler()({ action: "list_files", pack: "" });
    expect(mocks.listNodePackFiles).toHaveBeenCalledWith(
      expect.objectContaining({ pack: "" }),
      undefined,
      undefined,
    );

    await handler()({ action: "read", path: "" });
    expect(mocks.readNodeFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "" }),
      undefined,
      undefined,
    );

    await handler()({ action: "search", query: "" });
    expect(mocks.searchNodePacks).toHaveBeenCalledWith(
      expect.objectContaining({ query: "" }),
      undefined,
      undefined,
    );

    await handler()({ action: "patch", patch: "" });
    expect(mocks.applyNodePatch).toHaveBeenCalledWith("", undefined, undefined);

    await handler()({ action: "scaffold", name: "", display_name: "" });
    expect(mocks.scaffoldCustomNode).toHaveBeenCalledWith(
      expect.objectContaining({ name: "", displayName: "" }),
      undefined,
      undefined,
    );
  });

  it("start_line:0 and max_chars:0 are forwarded, not rewritten", async () => {
    await handler()({ action: "read", path: "MyPack/x.py", start_line: 0, max_chars: 0 });
    expect(mocks.readNodeFile).toHaveBeenCalledWith(
      expect.objectContaining({ startLine: 0, maxChars: 0 }),
      undefined,
      undefined,
    );
  });
});

/**
 * Mis-dispatch table. `node_pack` reaches a WRITE and a git commit, so a wrong
 * branch is not a wrong answer — action:"read" reaching writeNodeFile would
 * destroy the file the caller asked to look at.
 */
describe("no action can reach another action's service", () => {
  const table: Array<[Record<string, unknown>, (typeof ALL_SERVICES)[number]]> = [
    [{ action: "scaffold", name: "p", display_name: "P" }, "scaffoldCustomNode"],
    [{ action: "verify" }, "verifyCustomNode"],
    [{ action: "publish" }, "publishCustomNode"],
    [{ action: "list_files", pack: "P" }, "listNodePackFiles"],
    [{ action: "read", path: "P/x.py" }, "readNodeFile"],
    [{ action: "search", query: "q" }, "searchNodePacks"],
    [{ action: "write", path: "P/x.py", content: "c" }, "writeNodeFile"],
    [{ action: "patch", patch: "d" }, "applyNodePatch"],
    [{ action: "git", pack: "P", git_action: "status" }, "nodePackGit"],
  ];

  it.each(table)("%o reaches only its own service", async (args, expected) => {
    await handler()(args);
    for (const name of ALL_SERVICES) {
      if (name === expected) {
        expect(mocks[name], `must reach ${name}`).toHaveBeenCalledTimes(1);
      } else {
        expect(mocks[name], `must NOT reach ${name}`).not.toHaveBeenCalled();
      }
    }
  });
});

describe("the retired node-authoring names", () => {
  const old = [
    "scaffold_custom_node",
    "verify_custom_node",
    "publish_custom_node",
    "list_node_pack_files",
    "read_node_file",
    "search_node_packs",
    "write_node_file",
    "apply_node_patch",
    "node_pack_git",
  ];

  it("each old name is in DEAD_NAMES with a `node_pack` replacement", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.50.0");
      expect(entry!.replacement).toContain("node_pack");
    }
  });

  // The one renamed argument has to be discoverable from the ledger, or a
  // caller mechanically rewriting the git call lands on an action that does not
  // exist.
  it("the git replacement names `git_action`, not just the tool", () => {
    const entry = DEAD_NAMES.find((d) => d.name === "node_pack_git")!;
    expect(entry.replacement).toContain("git_action");
    for (const value of ["status", "diff", "log", "commit", "push"]) {
      expect(entry.replacement).toContain(value);
    }
  });

  it("no old name is still in the live ledger, and `node_pack` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("node_pack");
  });
});
