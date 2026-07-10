import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

// Mock config so importing node-dev doesn't trigger real port detection and
// lets us point comfyuiPath at a temp workspace per-test.
vi.mock("../../config.js", () => {
  const config: { comfyuiPath: string | undefined; githubToken?: string } = {
    comfyuiPath: undefined,
  };
  return { config, getComfyUIBaseUrl: () => "http://127.0.0.1:8188" };
});

import { config } from "../../config.js";
import {
  resolveInJail,
  chunkLongLines,
  boundText,
  parsePatchPaths,
  listNodePackFiles,
  readNodeFile,
  searchNodePacks,
  writeNodeFile,
  applyNodePatch,
  nodePackGit,
  gitWritesEnabled,
  GitWritesDisabledError,
  NodeDevError,
  LONG_LINE_CHUNK,
  READ_MAX_CHARS,
  defaultDeps,
  type NodeDevDeps,
  type RunResult,
} from "../../services/node-dev.js";

const IS_WIN = platform() === "win32";

// ---------------------------------------------------------------------------
// Seam factory — an in-memory-ish deps whose fs comes from a real tmpdir but
// whose git/ripgrep are recorded mocks. Callers pass a runGit override.
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<NodeDevDeps> = {}): {
  deps: NodeDevDeps;
  gitCalls: { args: string[]; cwd: string; input?: string }[];
  rgCalls: { args: string[]; cwd: string }[];
} {
  const gitCalls: { args: string[]; cwd: string; input?: string }[] = [];
  const rgCalls: { args: string[]; cwd: string }[] = [];
  const deps: NodeDevDeps = {
    ...defaultDeps,
    hasRipgrep: () => false,
    runGit: (args, opts) => {
      gitCalls.push({ args, cwd: opts.cwd, input: opts.input });
      return { status: 0, stdout: "", stderr: "" } as RunResult;
    },
    runRipgrep: (args, opts) => {
      rgCalls.push({ args, cwd: opts.cwd });
      return { status: 1, stdout: "", stderr: "" } as RunResult;
    },
    ...overrides,
  };
  return { deps, gitCalls, rgCalls };
}

let workspace: string;
let customNodes: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "node-dev-"));
  customNodes = join(workspace, "custom_nodes");
  mkdirSync(customNodes, { recursive: true });
  config.comfyuiPath = workspace;
  delete process.env.COMFYUI_MCP_ALLOW_GIT_WRITES;
});

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  config.comfyuiPath = undefined;
  vi.restoreAllMocks();
  delete process.env.COMFYUI_MCP_ALLOW_GIT_WRITES;
});

// ---------------------------------------------------------------------------
// Jail table
// ---------------------------------------------------------------------------

describe("resolveInJail", () => {
  it("accepts a plain pack-relative path", () => {
    mkdirSync(join(customNodes, "MyPack"), { recursive: true });
    const { rel } = resolveInJail("MyPack");
    expect(rel).toBe("MyPack");
  });

  const escapes: [string, string][] = [
    ["parent traversal (posix)", "../secret"],
    ["parent traversal (win)", "..\\secret"],
    ["nested traversal", "MyPack/../../secret"],
    ["ADS stream", "nodes.py:zone"],
    ["drive-relative", "C:evil"],
    ["UNC posix", "//server/share"],
    ["UNC win", "\\\\server\\share"],
    ["reserved name CON", "CON"],
    ["reserved name COM1.txt", "COM1.txt"],
    ["trailing dot", "foo."],
    ["trailing space in a segment", "sub /nodes.py"],
    ["dotdot pack", ".."],
  ];
  for (const [label, input] of escapes) {
    it(`rejects ${label}`, () => {
      expect(() => resolveInJail(input)).toThrow(NodeDevError);
    });
  }

  it("rejects an absolute path outside the root", () => {
    expect(() => resolveInJail(join(workspace, "outside"))).toThrow(NodeDevError);
  });

  it("accepts an absolute path inside the root", () => {
    mkdirSync(join(customNodes, "Inside"), { recursive: true });
    const { rel } = resolveInJail(join(customNodes, "Inside"));
    expect(rel).toBe("Inside");
  });

  it("rejects a junction that escapes the jail (win32)", () => {
    if (!IS_WIN) return; // junctions are Windows-only
    const outside = join(workspace, "outside_target");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "loot.txt"), "secret");
    const link = join(customNodes, "junction");
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      return; // environment can't create junctions — skip
    }
    // Lexically "junction/loot.txt" is inside; realpath must catch the escape.
    expect(() => resolveInJail("junction/loot.txt")).toThrow(NodeDevError);
  });

  it("refuses when comfyuiPath is unset (remote mode)", () => {
    config.comfyuiPath = undefined;
    expect(() => resolveInJail("MyPack")).toThrow(/local ComfyUI install/);
  });
});

// ---------------------------------------------------------------------------
// Bounding math
// ---------------------------------------------------------------------------

describe("bounding helpers", () => {
  it("chunkLongLines splits over-width lines", () => {
    const long = "x".repeat(LONG_LINE_CHUNK * 2 + 5);
    const out = chunkLongLines(["short", long]);
    expect(out[0]).toBe("short");
    expect(out.slice(1).every((l) => l.length <= LONG_LINE_CHUNK)).toBe(true);
    expect(out.slice(1).join("")).toBe(long);
  });

  it("boundText clips and flags truncation", () => {
    const r = boundText("abcdef", 3);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("abc")).toBe(true);
    const ok = boundText("abc", 10);
    expect(ok.truncated).toBe(false);
    expect(ok.text).toBe("abc");
  });

  it("readNodeFile reports total_lines on a CRLF file and clips char budget", () => {
    const pack = join(customNodes, "Pack");
    mkdirSync(pack, { recursive: true });
    const body = ["l1", "l2", "l3", "l4"].join("\r\n");
    writeFileSync(join(pack, "a.py"), body);
    const res = readNodeFile({ path: "Pack/a.py" });
    expect(res.total_lines).toBe(4);
    expect(res.start_line).toBe(1);

    // char clip
    writeFileSync(join(pack, "big.txt"), "y".repeat(50_000));
    const clipped = readNodeFile({ path: "Pack/big.txt", maxChars: READ_MAX_CHARS });
    expect(clipped.truncated).toBe(true);
    expect(clipped.content.length).toBeLessThan(50_000);
  });
});

// ---------------------------------------------------------------------------
// list + search
// ---------------------------------------------------------------------------

describe("listNodePackFiles", () => {
  it("lists files, skips .git/__pycache__, flags repo + pyproject", () => {
    const pack = join(customNodes, "Pack");
    mkdirSync(join(pack, ".git"), { recursive: true });
    mkdirSync(join(pack, "__pycache__"), { recursive: true });
    writeFileSync(join(pack, ".git", "config"), "x");
    writeFileSync(join(pack, "__pycache__", "a.pyc"), "x");
    writeFileSync(join(pack, "pyproject.toml"), "[project]");
    writeFileSync(join(pack, "nodes.py"), "print(1)");
    const res = listNodePackFiles({ pack: "Pack" });
    const paths = res.entries.map((e) => e.path);
    expect(paths).toContain("nodes.py");
    expect(paths.some((p) => p.includes(".git"))).toBe(false);
    expect(paths.some((p) => p.includes("__pycache__"))).toBe(false);
    expect(res.is_git_repo).toBe(true);
    expect(res.has_pyproject).toBe(true);
  });
});

describe("searchNodePacks", () => {
  it("builtin fallback finds matches and skips binary files", () => {
    const pack = join(customNodes, "Pack");
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(pack, "nodes.py"), "class FooNode:\n    pass\n");
    writeFileSync(join(pack, "bin.dat"), Buffer.from([0, 1, 2, 0, 70, 111, 111]));
    const res = searchNodePacks({ query: "FooNode" });
    expect(res.engine).toBe("builtin");
    expect(res.matches.length).toBe(1);
    // Default path "." searches the whole jail root, so file is root-relative.
    expect(res.matches[0].file).toBe("Pack/nodes.py");
    expect(res.matches[0].line).toBe(1);
  });

  it("routes through the ripgrep seam when rg is present (exact argv)", () => {
    const pack = join(customNodes, "Pack");
    mkdirSync(pack, { recursive: true });
    const rgCallsSpy: { args: string[]; cwd: string }[] = [];
    const { deps } = makeDeps({
      hasRipgrep: () => true,
      runRipgrep: (args, opts) => {
        rgCallsSpy.push({ args, cwd: opts.cwd });
        return { status: 0, stdout: "nodes.py:3:hit here\n", stderr: "" };
      },
    });
    const res = searchNodePacks({ query: "hit" }, deps);
    expect(res.engine).toBe("ripgrep");
    expect(res.matches).toEqual([{ file: "nodes.py", line: 3, text: "hit here" }]);
    expect(rgCallsSpy[0].args).toContain("--regexp");
    expect(rgCallsSpy[0].args).toContain("hit");
    // no option-injection: query passed after --regexp, not as a bare arg
    expect(rgCallsSpy[0].args[rgCallsSpy[0].args.indexOf("--regexp") + 1]).toBe("hit");
  });
});

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

describe("writeNodeFile", () => {
  it("creates a new file and refuses to clobber without overwrite", () => {
    const res = writeNodeFile({ path: "Pack/new.py", content: "x = 1" });
    expect(res.created).toBe(true);
    expect(existsSync(join(customNodes, "Pack", "new.py"))).toBe(true);
    expect(() => writeNodeFile({ path: "Pack/new.py", content: "y = 2" })).toThrow(
      NodeDevError,
    );
    const over = writeNodeFile({ path: "Pack/new.py", content: "y = 2", overwrite: true });
    expect(over.created).toBe(false);
  });

  it("refuses a path outside the jail", () => {
    expect(() => writeNodeFile({ path: "../evil.py", content: "x" })).toThrow(NodeDevError);
  });
});

// ---------------------------------------------------------------------------
// patch — two-phase, real temp git repo
// ---------------------------------------------------------------------------

describe("parsePatchPaths", () => {
  it("extracts touched paths and strips a/ b/ prefixes", () => {
    const patch = [
      "diff --git a/Pack/nodes.py b/Pack/nodes.py",
      "--- a/Pack/nodes.py",
      "+++ b/Pack/nodes.py",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    expect(parsePatchPaths(patch)).toEqual(["Pack/nodes.py"]);
  });
});

describe("applyNodePatch", () => {
  function initRepoPack(): string {
    const pack = join(customNodes, "Pack");
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(pack, "nodes.py"), "old\n");
    execFileSync("git", ["init", "-q"], { cwd: pack });
    execFileSync("git", ["config", "user.email", "t@t.co"], { cwd: pack });
    execFileSync("git", ["config", "user.name", "t"], { cwd: pack });
    execFileSync("git", ["add", "-A"], { cwd: pack });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: pack });
    return pack;
  }

  it("applies a clean patch (real git)", () => {
    initRepoPack();
    const patch = [
      "--- a/Pack/nodes.py",
      "+++ b/Pack/nodes.py",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const res = applyNodePatch(patch);
    expect(res.success).toBe(true);
    expect(res.stage).toBe("apply");
    expect(res.touched).toEqual(["Pack/nodes.py"]);
  });

  it("surfaces check-stage failure without applying", () => {
    initRepoPack();
    // Context that doesn't match ('nope' isn't the file content).
    const patch = [
      "--- a/Pack/nodes.py",
      "+++ b/Pack/nodes.py",
      "@@ -1 +1 @@",
      "-nope",
      "+new",
      "",
    ].join("\n");
    const res = applyNodePatch(patch);
    expect(res.success).toBe(false);
    expect(res.stage).toBe("check");
  });

  it("refuses a patch touching a path outside custom_nodes BEFORE any git call", () => {
    const { deps, gitCalls } = makeDeps();
    const patch = [
      "--- a/../escape.py",
      "+++ b/../escape.py",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    expect(() => applyNodePatch(patch, deps)).toThrow(NodeDevError);
    expect(gitCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// git — seam-mocked argv + env-flag refusal
// ---------------------------------------------------------------------------

describe("nodePackGit", () => {
  function mkPack(): void {
    mkdirSync(join(customNodes, "Pack"), { recursive: true });
  }

  it("status builds a read-only argv (no option injection)", () => {
    mkPack();
    const calls: { args: string[]; cwd: string }[] = [];
    const { deps } = makeDeps({
      runGit: (args, opts) => {
        calls.push({ args, cwd: opts.cwd });
        return { status: 0, stdout: "## main", stderr: "" };
      },
    });
    const res = nodePackGit({ pack: "Pack", action: "status" }, deps);
    expect(res.success).toBe(true);
    expect(calls[0].args).toEqual(["status", "--short", "--branch"]);
  });

  it("commit is refused with DISABLED_BY_CONFIG when the flag is off", () => {
    mkPack();
    expect(gitWritesEnabled()).toBe(false);
    let thrown: unknown;
    try {
      nodePackGit({ pack: "Pack", action: "commit", message: "x" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(GitWritesDisabledError);
    const result = (thrown as GitWritesDisabledError).toToolResult();
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.error).toBe("DISABLED_BY_CONFIG");
    expect(body.disabled_by_config).toBe(true);
    expect(body.required_flag).toBe("COMFYUI_MCP_ALLOW_GIT_WRITES=1");
  });

  it("push is refused when the flag is off", () => {
    mkPack();
    expect(() => nodePackGit({ pack: "Pack", action: "push" })).toThrow(
      GitWritesDisabledError,
    );
  });

  it("commit stages then commits when the flag is on", () => {
    mkPack();
    process.env.COMFYUI_MCP_ALLOW_GIT_WRITES = "1";
    const calls: { args: string[] }[] = [];
    const { deps } = makeDeps({
      runGit: (args) => {
        calls.push({ args });
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const res = nodePackGit(
      { pack: "Pack", action: "commit", message: "feat: x" },
      deps,
    );
    expect(res.success).toBe(true);
    expect(calls[0].args).toEqual(["add", "-A"]);
    expect(calls[1].args).toEqual(["commit", "-m", "feat: x"]);
  });

  it("commit requires a message even when the flag is on", () => {
    mkPack();
    process.env.COMFYUI_MCP_ALLOW_GIT_WRITES = "true";
    const { deps } = makeDeps();
    expect(() => nodePackGit({ pack: "Pack", action: "commit" }, deps)).toThrow(
      /message/,
    );
  });
});
