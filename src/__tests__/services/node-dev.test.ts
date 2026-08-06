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
  return {
    config,
    getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
    isRemoteMode: () => false,
  };
});

// Control the effective LOCAL base node-dev resolves through, so #506's
// saved-default-workspace behavior is exercised without touching real user
// config. resolveEffectiveComfyUIBase() prefers COMFYUI_PATH then the saved
// default; the mock mirrors that: config.comfyuiPath first, else wsMock.saved.
const wsMock = vi.hoisted(() => ({ saved: undefined as string | undefined }));
vi.mock("../../services/workspace-env.js", () => ({
  resolveEffectiveComfyUIBase: () => config.comfyuiPath ?? wsMock.saved,
}));

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
  // #809
  MIN_OUTPUT_CHARS,
  SEARCH_LINE_MAX,
  SEARCH_MAX_RESULTS,
  LIST_MAX_ENTRIES,
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
  wsMock.saved = undefined;
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

  it("refuses when no local install is configured (remote mode, no saved default)", () => {
    config.comfyuiPath = undefined;
    wsMock.saved = undefined;
    expect(() => resolveInJail("MyPack")).toThrow(/local ComfyUI install/);
  });

  it("resolves against the saved default workspace when COMFYUI_PATH is unset (#506)", () => {
    // No COMFYUI_PATH, but a saved default workspace is set — a loopback session
    // must be treated as local, mirroring install_comfyui (action:"environment")/workspace action:"get", instead
    // of being rejected as remote.
    config.comfyuiPath = undefined;
    wsMock.saved = workspace;
    mkdirSync(join(customNodes, "MyPack"), { recursive: true });
    const { rel } = resolveInJail("MyPack");
    expect(rel).toBe("MyPack");
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
    // #809: the notice is REQUIRED — boundText is shared by tools with different levers,
    // so a default naming `max_chars` would ship a dead remedy to callers without one.
    const notice = (dropped: number) => `[cut ${dropped}]`;
    // The notice is reserved OUT of the budget (#809), so the budget must leave room for
    // both: 20 chars fits "abcdef"'s head plus the ~8-char marker.
    const r = boundText("abcdef".repeat(10), 20, notice);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("a")).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(20);
    const ok = boundText("abc", 10, notice);
    expect(ok.truncated).toBe(false);
    expect(ok.text).toBe("abc");
  });

  // #809 (codex gate): the marker is spent from the very budget it describes, so a longer
  // marker must not be able to push the result past maxChars — the bound is the promise
  // the parameter makes, and breaking it to explain the break would be absurd.
  it("boundText keeps the RESULT within maxChars even with a long notice", () => {
    const notice = (dropped: number) =>
      `\n\n[... ${dropped} more char(s) cut by \`max_chars\`; raise \`max_chars\` up to ${READ_MAX_CHARS} ...]`;
    const noticeLen = notice(50_000).length;
    for (const budget of [200, 1000, 5000, 12_000]) {
      const r = boundText("z".repeat(50_000), budget, notice);
      expect(r.truncated).toBe(true);
      expect(r.text.length, `budget ${budget} breached`).toBeLessThanOrEqual(budget);
      // And the marker itself survives — reserving space must not clip the instruction.
      expect(r.text).toContain("raise `max_chars`");
    }
    // A budget smaller than the marker cannot honour both; the MARKER wins, because an
    // empty unexplained field reads as "the file is empty".
    const tiny = boundText("z".repeat(50_000), 5, notice);
    expect(tiny.text).toContain("raise `max_chars`");
    expect(tiny.text.length).toBeLessThanOrEqual(noticeLen);
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
    // Force the builtin path regardless of whether rg exists on this host (#655).
    const { deps } = makeDeps();
    const res = searchNodePacks({ query: "FooNode" }, deps);
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

  // #809 (codex gate) — BOTH directions of the truncation lie, run for real rather than
  // asserted against the source text.
  //
  // `--max-count` is PER FILE, so asking rg for exactly `cap` meant a file holding more
  // had its extras dropped by rg before we saw a line (silent loss), while a search with
  // exactly `cap` real matches was labelled truncated (false alarm — the agent is told to
  // retry wider for nothing, which is how it learns to distrust the tool). Asking for
  // `cap + 1` closes both: the extra line is the proof, its absence the proof of
  // completeness.
  it("asks ripgrep for ONE past the cap so truncation can be PROVEN either way", () => {
    const seen: string[][] = [];
    const { deps } = makeDeps({
      hasRipgrep: () => true,
      runRipgrep: (args) => {
        seen.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    searchNodePacks({ query: "x", maxResults: 5 }, deps);
    expect(seen[0][seen[0].indexOf("--max-count") + 1]).toBe("6");
  });

  it("does NOT claim truncation when the match count is exactly max_results", () => {
    const lines = Array.from({ length: 3 }, (_, i) => `a.py:${i + 1}:hit`).join("\n");
    const { deps } = makeDeps({
      hasRipgrep: () => true,
      runRipgrep: () => ({ status: 0, stdout: `${lines}\n`, stderr: "" }),
    });
    const res = searchNodePacks({ query: "hit", maxResults: 3 }, deps);
    expect(res.matches).toHaveLength(3);
    expect(res.truncated).toBe(false);
    expect(res.truncation_hint).toBeUndefined();
  });

  it("DOES claim truncation — with the lever and ceiling — on the (cap+1)-th match", () => {
    const lines = Array.from({ length: 4 }, (_, i) => `a.py:${i + 1}:hit`).join("\n");
    const { deps } = makeDeps({
      hasRipgrep: () => true,
      runRipgrep: () => ({ status: 0, stdout: `${lines}\n`, stderr: "" }),
    });
    const res = searchNodePacks({ query: "hit", maxResults: 3 }, deps);
    expect(res.matches).toHaveLength(3);
    expect(res.truncated).toBe(true);
    expect(res.truncated_by).toBe("max_results");
    expect(res.truncation_hint).toContain("`max_results`");
    expect(res.truncation_hint).toContain(`up to ${SEARCH_MAX_RESULTS}`);
  });

  // codex gate: the FIRST cut is the one the caller must act on. If a later write could
  // flip an actionable "raise `max_results`" into "no parameter raises it", the remedy
  // would name the wrong lever — the defect this whole issue is about.
  it("keeps the FIRST truncation cause, so the remedy names the lever that applies", () => {
    const files = Array.from({ length: 50 }, (_, i) => ({ name: `f${i}.py`, isDir: false }));
    const { deps } = makeDeps({
      hasRipgrep: () => false,
      isDirectory: () => true,
      listDir: () => files,
      fileSize: () => 10,
      readFileBuffer: () => Buffer.from("hit\nhit\nhit\n"),
    });
    const res = searchNodePacks({ query: "hit", maxResults: 2 }, deps);
    expect(res.truncated).toBe(true);
    expect(res.truncated_by).toBe("max_results");
    expect(res.truncation_hint).toContain("`max_results`");
    expect(res.truncation_hint).not.toContain("no parameter raises it");
  });

  it("marks the 600-char per-line clip and stays inside it", () => {
    const { deps } = makeDeps({
      hasRipgrep: () => true,
      runRipgrep: () => ({ status: 0, stdout: `a.py:1:${"z".repeat(5000)}\n`, stderr: "" }),
    });
    const res = searchNodePacks({ query: "z" }, deps);
    expect(res.matches[0].text.length).toBeLessThanOrEqual(SEARCH_LINE_MAX);
    expect(res.matches[0].text).toContain("fixed 600-char per-line cap");
  });
});

// #809 (codex gate): the file walk had the same exact-cap false alarm, and reported a
// bare boolean with no total and no lever.
describe("listNodePackFiles truncation honesty (#809)", () => {
  const seed = (n: number) => {
    const pack = join(customNodes, "Pack");
    mkdirSync(pack, { recursive: true });
    for (let i = 0; i < n; i++) writeFileSync(join(pack, `f${i}.py`), "x");
  };

  it("does NOT claim truncation when the entry count is exactly max_entries", () => {
    seed(3);
    const res = listNodePackFiles({ pack: "Pack", maxEntries: 3 });
    expect(res.entries).toHaveLength(3);
    expect(res.truncated).toBe(false);
    expect(res.truncation_hint).toBeUndefined();
  });

  it("names max_entries, its ceiling, and glob when the walk really stopped early", () => {
    seed(5);
    const res = listNodePackFiles({ pack: "Pack", maxEntries: 3 });
    expect(res.entries).toHaveLength(3);
    expect(res.truncated).toBe(true);
    expect(res.truncation_hint).toContain("`max_entries`");
    expect(res.truncation_hint).toContain(`up to ${LIST_MAX_ENTRIES}`);
    expect(res.truncation_hint).toContain("`glob`");
  });
});

// #809 (codex gate): the clamps must be exercised, not asserted about. A remedy that
// quotes a ceiling the runtime does not enforce is the same defect as a wrong param.
describe("max_chars clamps are real (#809)", () => {
  it('node_pack action:"read" honours the ceiling AND the floor it advertises', () => {
    const pack = join(customNodes, "Pack");
    mkdirSync(pack, { recursive: true });
    // MANY lines, so paging by start_line/line_count is a live remedy here.
    writeFileSync(join(pack, "big.py"), Array.from({ length: 5000 }, (_, i) => `line ${i} ${"z".repeat(60)}`).join("\n"));

    // line_count high enough that the CHAR budget is what cuts, not the line window.
    const over = readNodeFile({ path: "Pack/big.py", maxChars: 1_000_000, lineCount: 800 });
    expect(over.content.length).toBeLessThanOrEqual(READ_MAX_CHARS);
    expect(over.truncated).toBe(true);
    // Clamped to the ceiling, so the remedy must NOT say "raise max_chars to 24000" —
    // the caller is already there, and that retry would change nothing (#809 codex gate).
    expect(over.content).toContain(`already at its ceiling of ${READ_MAX_CHARS}`);
    expect(over.content).not.toContain("raise `max_chars` (up to");
    // What IS left must still be named.
    expect(over.content).toContain("`start_line`");

    // A budget of 1 used to yield either an unexplained empty field or a marker that
    // breached its own bound. The FLOOR (not the ceiling) fixes that.
    const under = readNodeFile({ path: "Pack/big.py", maxChars: 1 });
    expect(under.content.length).toBeLessThanOrEqual(MIN_OUTPUT_CHARS);
    expect(under.content).toContain("raise `max_chars`");
  });

  // codex gate: `start_line`/`line_count` index SOURCE lines. On a slice that is ONE
  // physical line there is nothing to page to, so offering it names a real lever that
  // cannot move — the same wasted round trip as naming a nonexistent one.
  it("does NOT offer line paging when the slice is a single overlong line", () => {
    const pack = join(customNodes, "Pack");
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(pack, "min.js"), "z".repeat(200_000));

    const r = readNodeFile({ path: "Pack/min.js", maxChars: 1_000_000 });
    expect(r.truncated).toBe(true);
    expect(r.content).toMatch(/SINGLE physical line/);
    expect(r.content).toMatch(/`start_line`\/`line_count` cannot reach the rest/);
    // At the ceiling it must not pretend another parameter would help either.
    expect(r.content).toContain(`at the ${READ_MAX_CHARS} ceiling this tool cannot return more of it`);
    expect(r.content).toContain('node_pack (action:"search")');
  });

  it('node_pack action:"git" honours the same ceiling and floor', () => {
    mkdirSync(join(customNodes, "Pack"), { recursive: true });
    const { deps } = makeDeps({
      runGit: () => ({ status: 0, stdout: "d".repeat(200_000), stderr: "" }),
    });
    const over = nodePackGit({ pack: "Pack", action: "diff", maxChars: 1_000_000 }, deps);
    expect(over.stdout.length).toBeLessThanOrEqual(READ_MAX_CHARS);
    expect(over.stdout).toContain(`already at its ceiling of ${READ_MAX_CHARS}`);
    expect(over.stdout).toContain("`paths`");

    const under = nodePackGit({ pack: "Pack", action: "diff", maxChars: 1 }, deps);
    expect(under.stdout.length).toBeLessThanOrEqual(MIN_OUTPUT_CHARS);
    expect(under.stdout).toContain("raise `max_chars`");
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
