import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";

// Mock config so importing node-authoring doesn't trigger real port detection
// and lets us flip comfyuiPath per-test.
vi.mock("../../config.js", () => {
  const config: { comfyuiPath: string | undefined } = {
    comfyuiPath: "/fake/comfy",
  };
  return { config };
});

import { config } from "../../config.js";
import {
  scaffoldCustomNode,
  publishCustomNode,
  validatePackName,
  parsePyproject,
  extractRegistryUrl,
  buildPyprojectToml,
  buildInitPy,
  buildNodesPy,
  NodeAuthoringError,
  type AuthoringDeps,
} from "../../services/node-authoring.js";
import { ValidationError } from "../../utils/errors.js";

interface WriteCall {
  path: string;
  contents: string;
}
interface RunCall {
  cmd: string;
  args: string[];
  opts: { cwd: string; env?: Record<string, string> };
}

function makeDeps(overrides: Partial<AuthoringDeps> = {}): {
  deps: AuthoringDeps;
  writes: WriteCall[];
  mkdirs: string[];
  runs: RunCall[];
  files: Map<string, string>;
} {
  const writes: WriteCall[] = [];
  const mkdirs: string[] = [];
  const runs: RunCall[] = [];
  const files = new Map<string, string>();

  const deps: AuthoringDeps = {
    existsSync: vi.fn(() => true),
    mkdirp: vi.fn((p: string) => {
      mkdirs.push(p);
    }),
    writeFile: vi.fn((p: string, contents: string) => {
      writes.push({ path: p, contents });
      files.set(p, contents);
    }),
    readFile: vi.fn((p: string) => files.get(p) ?? ""),
    isNonEmptyDir: vi.fn(() => false),
    hasCommand: vi.fn(() => true),
    run: vi.fn((cmd: string, args: string[], opts) => {
      runs.push({ cmd, args, opts });
      return "Published successfully";
    }),
    ...overrides,
  };
  return { deps, writes, mkdirs, runs, files };
}

const CUSTOM_NODES = join("/fake/comfy", "custom_nodes");

beforeEach(() => {
  config.comfyuiPath = "/fake/comfy";
  delete process.env.REGISTRY_ACCESS_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.REGISTRY_ACCESS_TOKEN;
});

// ---------------------------------------------------------------------------
// validatePackName / path-safety
// ---------------------------------------------------------------------------

describe("validatePackName", () => {
  it("accepts a simple lowercase slug", () => {
    expect(validatePackName("my-cool-nodes")).toBe("my-cool-nodes");
    expect(validatePackName("nodes_v2")).toBe("nodes_v2");
  });

  it("rejects empty names", () => {
    expect(() => validatePackName("  ")).toThrow(ValidationError);
  });

  it.each([
    "../evil",
    "foo/bar",
    "foo\\bar",
    "..",
    "/abs/path",
    "C:\\win",
    "UPPER",
    "-leading",
    "trailing-",
    "has space",
  ])("rejects unsafe / invalid name %s", (bad) => {
    expect(() => validatePackName(bad)).toThrow(ValidationError);
  });

  it("rejects overly long names", () => {
    expect(() => validatePackName("a".repeat(65))).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// scaffoldCustomNode
// ---------------------------------------------------------------------------

describe("scaffoldCustomNode", () => {
  it("writes the canonical files into custom_nodes/<name>/", () => {
    const { deps, writes, mkdirs } = makeDeps();
    const res = scaffoldCustomNode(
      {
        name: "my-nodes",
        displayName: "My Nodes",
        category: "testing",
        description: "Some nodes",
        publisherId: "acme",
      },
      deps,
    );

    const packDir = join(CUSTOM_NODES, "my-nodes");
    expect(res.path).toBe(packDir);
    expect(res.files).toEqual([
      "pyproject.toml",
      "__init__.py",
      join("src", "__init__.py"),
      join("src", "nodes.py"),
    ]);
    expect(mkdirs).toContain(packDir);
    expect(mkdirs).toContain(join(packDir, "src"));

    const written = (rel: string) =>
      writes.find((w) => w.path === join(packDir, rel))!.contents;

    const pyproject = written("pyproject.toml");
    expect(pyproject).toContain('name = "my-nodes"');
    expect(pyproject).toContain('version = "0.0.1"');
    expect(pyproject).toContain("[project.urls]");
    expect(pyproject).toContain("[tool.comfy]");
    expect(pyproject).toContain('PublisherId = "acme"');
    expect(pyproject).toContain('DisplayName = "My Nodes"');
    expect(pyproject).toContain("dependencies = []");

    const init = written("__init__.py");
    expect(init).toContain("NODE_CLASS_MAPPINGS");
    expect(init).toContain("NODE_DISPLAY_NAME_MAPPINGS");
    expect(init).not.toContain("WEB_DIRECTORY");

    const nodes = written(join("src", "nodes.py"));
    expect(nodes).toContain("def INPUT_TYPES");
    expect(nodes).toContain("RETURN_TYPES");
    expect(nodes).toContain("FUNCTION =");
    expect(nodes).toContain('CATEGORY = "testing"');
  });

  it("emits a frontend stub and WEB_DIRECTORY when with_frontend is set", () => {
    const { deps, writes } = makeDeps();
    const res = scaffoldCustomNode(
      { name: "fe-pack", displayName: "FE Pack", withFrontend: true },
      deps,
    );
    expect(res.withFrontend).toBe(true);
    const packDir = join(CUSTOM_NODES, "fe-pack");
    expect(res.files).toContain(join("web", "js", "fe-pack.js"));

    const init = writes.find((w) => w.path === join(packDir, "__init__.py"))!.contents;
    expect(init).toContain('WEB_DIRECTORY = "./web"');

    const js = writes.find((w) => w.path === join(packDir, "web", "js", "fe-pack.js"))!.contents;
    expect(js).toContain("registerExtension");
  });

  it("refuses to overwrite a non-empty dir unless overwrite:true", () => {
    const { deps, writes } = makeDeps({ isNonEmptyDir: vi.fn(() => true) });
    expect(() =>
      scaffoldCustomNode({ name: "exists", displayName: "Exists" }, deps),
    ).toThrow(ValidationError);
    expect(writes).toHaveLength(0);

    // With overwrite, it proceeds.
    const { deps: deps2, writes: writes2 } = makeDeps({
      isNonEmptyDir: vi.fn(() => true),
    });
    scaffoldCustomNode(
      { name: "exists", displayName: "Exists", overwrite: true },
      deps2,
    );
    expect(writes2.length).toBeGreaterThan(0);
  });

  it("rejects a path-traversing name without writing anything", () => {
    const { deps, writes } = makeDeps();
    expect(() =>
      scaffoldCustomNode({ name: "../escape", displayName: "Escape" }, deps),
    ).toThrow(ValidationError);
    expect(writes).toHaveLength(0);
  });

  it("throws a clear error in remote mode (no comfyuiPath)", () => {
    config.comfyuiPath = undefined;
    const { deps } = makeDeps();
    expect(() =>
      scaffoldCustomNode({ name: "x", displayName: "X" }, deps),
    ).toThrow(/local ComfyUI install/i);
  });

  it("writes a placeholder PublisherId when none is given", () => {
    const { deps, writes } = makeDeps();
    const res = scaffoldCustomNode({ name: "no-pub", displayName: "No Pub" }, deps);
    const pyproject = writes.find((w) => w.path.endsWith("pyproject.toml"))!.contents;
    expect(pyproject).toContain('PublisherId = "your-publisher-id"');
    expect(res.message).toMatch(/PublisherId/);
  });
});

// ---------------------------------------------------------------------------
// Template builders (pure)
// ---------------------------------------------------------------------------

describe("template builders", () => {
  it("derives a PascalCase class name and uses it consistently", () => {
    const init = buildInitPy({
      className: "MyNodesNode",
      displayName: "My Nodes",
      withFrontend: false,
    });
    expect(init).toContain("from .src.nodes import MyNodesNode");
    expect(init).toContain('"MyNodesNode": MyNodesNode');
  });

  it("escapes quotes in TOML strings", () => {
    const toml = buildPyprojectToml({
      name: "p",
      description: 'has "quotes"',
      publisherId: "pub",
      displayName: 'Disp "X"',
    });
    expect(toml).toContain('description = "has \\"quotes\\""');
    expect(toml).toContain('DisplayName = "Disp \\"X\\""');
  });

  it("nodes.py defines the standard node contract", () => {
    const nodes = buildNodesPy({
      className: "FooNode",
      displayName: "Foo",
      category: "cat",
    });
    expect(nodes).toContain("class FooNode:");
    expect(nodes).toContain("@classmethod");
    expect(nodes).toContain("def INPUT_TYPES(cls):");
    expect(nodes).toContain("def run(self");
  });
});

// ---------------------------------------------------------------------------
// parsePyproject / extractRegistryUrl
// ---------------------------------------------------------------------------

describe("parsePyproject", () => {
  it("extracts name, version, and PublisherId", () => {
    const toml = buildPyprojectToml({
      name: "mypack",
      description: "d",
      publisherId: "acme",
      displayName: "My Pack",
    });
    const parsed = parsePyproject(toml);
    expect(parsed.projectName).toBe("mypack");
    expect(parsed.version).toBe("0.0.1");
    expect(parsed.publisherId).toBe("acme");
  });

  it("returns undefined fields for an empty/garbage toml", () => {
    const parsed = parsePyproject("not a toml");
    expect(parsed.projectName).toBeUndefined();
    expect(parsed.publisherId).toBeUndefined();
  });

  it("does not bleed [project].name into a missing PublisherId", () => {
    const toml = `[project]\nname = "x"\nversion = "1.0.0"\n`;
    const parsed = parsePyproject(toml);
    expect(parsed.projectName).toBe("x");
    expect(parsed.publisherId).toBeUndefined();
  });

  it("reads version even when a dependencies array (with '[') precedes it", () => {
    // A hand-edited pyproject may declare a non-empty dependencies array before
    // version. The inline '[' must not truncate the [project] section.
    const toml = `[project]
name = "p"
dependencies = ["torch", "numpy"]
version = "3.1.0"

[tool.comfy]
PublisherId = "acme"
`;
    const parsed = parsePyproject(toml);
    expect(parsed.projectName).toBe("p");
    expect(parsed.version).toBe("3.1.0");
    expect(parsed.publisherId).toBe("acme");
  });

  it("parses [tool.comfy] when it is the last section without a trailing newline", () => {
    const toml = `[project]\nname = "p"\nversion = "2.0.0"\n\n[tool.comfy]\nPublisherId = "zz"`;
    const parsed = parsePyproject(toml);
    expect(parsed.version).toBe("2.0.0");
    expect(parsed.publisherId).toBe("zz");
  });
});

describe("extractRegistryUrl", () => {
  it("finds a registry.comfy.org URL in output", () => {
    const out = "Done! View at https://registry.comfy.org/nodes/mypack ok";
    expect(extractRegistryUrl(out)).toBe("https://registry.comfy.org/nodes/mypack");
  });
  it("returns undefined when no URL present", () => {
    expect(extractRegistryUrl("nothing here")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// publishCustomNode
// ---------------------------------------------------------------------------

describe("publishCustomNode", () => {
  const goodToml = buildPyprojectToml({
    name: "mypack",
    description: "d",
    publisherId: "acme",
    displayName: "My Pack",
  });

  function depsWithToml(toml: string, extra: Partial<AuthoringDeps> = {}) {
    return makeDeps({
      existsSync: vi.fn(() => true),
      readFile: vi.fn(() => toml),
      ...extra,
    }).deps;
  }

  it("runs `comfy node publish` in the pack dir, token via env not args", () => {
    process.env.REGISTRY_ACCESS_TOKEN = "secret-token-123";
    const runSpy = vi.fn(
      () => "Published https://registry.comfy.org/nodes/mypack/versions/0.0.1",
    );
    const deps = makeDeps({
      existsSync: vi.fn(() => true),
      readFile: vi.fn(() => goodToml),
      run: runSpy,
    }).deps;

    const res = publishCustomNode({ name: "mypack" }, deps);

    expect(res.published).toBe(true);
    expect(res.packName).toBe("mypack");
    expect(res.version).toBe("0.0.1");
    expect(res.registryUrl).toBe(
      "https://registry.comfy.org/nodes/mypack/versions/0.0.1",
    );

    expect(runSpy).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = runSpy.mock.calls[0];
    expect(cmd).toBe("comfy");
    expect(args).toEqual(["node", "publish"]);
    expect(opts.cwd).toBe(join(CUSTOM_NODES, "mypack"));
    // Token MUST travel via env...
    expect(opts.env).toEqual({ REGISTRY_ACCESS_TOKEN: "secret-token-123" });
    // ...and MUST NOT appear in argv (which is logged).
    expect(args.join(" ")).not.toContain("secret-token-123");
  });

  it("uses an explicit path when given, overriding name", () => {
    process.env.REGISTRY_ACCESS_TOKEN = "tok";
    const runSpy = vi.fn(() => "ok");
    const deps = makeDeps({
      existsSync: vi.fn(() => true),
      readFile: vi.fn(() => goodToml),
      run: runSpy,
    }).deps;
    publishCustomNode({ path: "/elsewhere/mypack" }, deps);
    expect(runSpy.mock.calls[0][2].cwd).toBe("/elsewhere/mypack");
  });

  it("throws when REGISTRY_ACCESS_TOKEN is missing (and never runs)", () => {
    const runSpy = vi.fn(() => "ok");
    const deps = makeDeps({
      existsSync: vi.fn(() => true),
      readFile: vi.fn(() => goodToml),
      run: runSpy,
    }).deps;
    expect(() => publishCustomNode({ name: "mypack" }, deps)).toThrow(
      /REGISTRY_ACCESS_TOKEN/,
    );
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("rejects the scaffold placeholder PublisherId", () => {
    process.env.REGISTRY_ACCESS_TOKEN = "tok";
    const placeholder = buildPyprojectToml({
      name: "p",
      description: "d",
      publisherId: "your-publisher-id",
      displayName: "P",
    });
    const deps = depsWithToml(placeholder);
    expect(() => publishCustomNode({ name: "p" }, deps)).toThrow(
      /placeholder/i,
    );
  });

  it("reports missing required pyproject fields", () => {
    process.env.REGISTRY_ACCESS_TOKEN = "tok";
    const deps = depsWithToml(`[project]\nname = "p"\n`); // no version, no PublisherId
    expect(() => publishCustomNode({ name: "p" }, deps)).toThrow(
      /missing required field/i,
    );
  });

  it("errors when pyproject.toml is absent", () => {
    process.env.REGISTRY_ACCESS_TOKEN = "tok";
    const deps = makeDeps({
      // pack dir exists, pyproject does not
      existsSync: vi.fn((p: string) => !p.endsWith("pyproject.toml")),
    }).deps;
    expect(() => publishCustomNode({ name: "p" }, deps)).toThrow(
      NodeAuthoringError,
    );
  });

  it("errors when comfy-cli is not installed", () => {
    process.env.REGISTRY_ACCESS_TOKEN = "tok";
    const deps = depsWithToml(goodToml, { hasCommand: vi.fn(() => false) });
    expect(() => publishCustomNode({ name: "mypack" }, deps)).toThrow(
      /comfy-cli is not installed/i,
    );
  });

  it("requires name or path", () => {
    const deps = makeDeps().deps;
    expect(() => publishCustomNode({}, deps)).toThrow(ValidationError);
  });

  it("throws a clear error in remote mode when using name", () => {
    config.comfyuiPath = undefined;
    process.env.REGISTRY_ACCESS_TOKEN = "tok";
    const deps = depsWithToml(goodToml);
    expect(() => publishCustomNode({ name: "mypack" }, deps)).toThrow(
      /local ComfyUI install/i,
    );
  });
});
