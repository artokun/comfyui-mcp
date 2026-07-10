import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config.js";
import {
  assertSafeRepoName,
  nonInteractiveGitEnv,
} from "./node-management.js";
import { ComfyUIError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Path-jailed live custom-node dev tools.
//
// Port of filliptm/ComfyUI_FL-MCP's coding_tools.py (read/search/write/patch/
// git, hard-jailed to custom_nodes/ with bounded output) onto our stack, plus
// Windows symlink/junction/ADS safety and the seam-injected deps pattern used
// by node-authoring.ts. LOCAL-ONLY: every tool needs config.comfyuiPath.
//
// Design + rationale: docs/design/node-dev-tools.md.
// ---------------------------------------------------------------------------

export class NodeDevError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "NODE_DEV_ERROR", details);
    this.name = "NodeDevError";
  }
}

/**
 * Refusal returned when a git write (commit/push) is attempted while the
 * COMFYUI_MCP_ALLOW_GIT_WRITES flag is off. Structured so an agent can
 * self-correct (see docs/design/node-dev-tools.md). The gates framework is
 * deferred to ROADMAP Theme G; this narrow flag is what Theme G will absorb.
 */
export class GitWritesDisabledError extends ComfyUIError {
  constructor(action: string) {
    super(
      `node_pack_git "${action}" is disabled by configuration. Set the ` +
        `environment variable COMFYUI_MCP_ALLOW_GIT_WRITES=1 (or "true") to ` +
        `allow git commit/push from this server, then retry. Read-only actions ` +
        `(status/diff/log) are always available.`,
      "DISABLED_BY_CONFIG",
    );
    this.name = "GitWritesDisabledError";
  }

  toToolResult(): CallToolResult {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "DISABLED_BY_CONFIG",
            disabled_by_config: true,
            required_flag: "COMFYUI_MCP_ALLOW_GIT_WRITES=1",
            message: this.message,
          }),
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// FL-MCP output-bounding constants (its proven values).
// ---------------------------------------------------------------------------

export const READ_DEFAULT_LINES = 240;
export const READ_MAX_LINES = 800;
export const READ_DEFAULT_CHARS = 12_000;
export const READ_MAX_CHARS = 24_000;
/** Long lines are chunked at this width so a single minified line can't blow the budget. */
export const LONG_LINE_CHUNK = 1_000;
/** Per-match line cap for search results. */
export const SEARCH_LINE_MAX = 600;
/** Bound on any subprocess (git / patch) stdout+stderr surfaced to the caller. */
export const CMD_OUTPUT_MAX = 12_000;
export const LIST_DEFAULT_ENTRIES = 500;
export const LIST_MAX_ENTRIES = 2_000;
export const SEARCH_DEFAULT_RESULTS = 50;
export const SEARCH_MAX_RESULTS = 100;
/** Skip files larger than this in the builtin search walker. */
const SEARCH_MAX_FILE_BYTES = 1024 * 1024;
/** Hard cap on files the builtin walker will open in one search. */
const SEARCH_MAX_SCANNED_FILES = 20_000;

const GIT_TIMEOUT_MS = 60_000;
const GIT_PUSH_TIMEOUT_MS = 180_000;

const SKIP_DIRS = new Set([".git", "__pycache__", "node_modules"]);

// ---------------------------------------------------------------------------
// Seams — overridable for testing without touching real disk / subprocess.
// ---------------------------------------------------------------------------

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface NodeDevDeps {
  existsSync: (p: string) => boolean;
  isDirectory: (p: string) => boolean;
  isFile: (p: string) => boolean;
  fileSize: (p: string) => number;
  /** One directory level, names + isDir flag. */
  listDir: (p: string) => DirEntry[];
  readFileText: (p: string) => string;
  readFileBuffer: (p: string) => Buffer;
  writeFileText: (p: string, contents: string) => void;
  mkdirp: (p: string) => void;
  /** Resolve symlinks/junctions (fs.realpathSync.native semantics). */
  realpath: (p: string) => string;
  /** Whether `rg` (ripgrep) is on PATH. */
  hasRipgrep: () => boolean;
  runGit: (
    args: string[],
    opts: { cwd: string; timeoutMs: number; input?: string },
  ) => RunResult;
  runRipgrep: (
    args: string[],
    opts: { cwd: string; timeoutMs: number },
  ) => RunResult;
}

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; input?: string; env?: NodeJS.ProcessEnv },
): RunResult {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf-8",
    timeout: opts.timeoutMs,
    input: opts.input,
    env: opts.env,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (res.error) {
    const e = res.error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new NodeDevError(
        `"${cmd}" was not found on PATH. Install ${cmd} to use this operation.`,
      );
    }
    throw new NodeDevError(`Failed to execute ${cmd}: ${e.message}`);
  }
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

export const defaultDeps: NodeDevDeps = {
  existsSync,
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  fileSize: (p) => {
    try {
      return statSync(p).size;
    } catch {
      return 0;
    }
  },
  listDir: (p) =>
    readdirSync(p, { withFileTypes: true }).map((d) => ({
      name: d.name,
      isDir: d.isDirectory(),
    })),
  readFileText: (p) => readFileSync(p, "utf-8"),
  readFileBuffer: (p) => readFileSync(p),
  writeFileText: (p, contents) => writeFileSync(p, contents, "utf-8"),
  mkdirp: (p) => {
    mkdirSync(p, { recursive: true });
  },
  realpath: (p) => realpathSync.native(p),
  hasRipgrep: () => {
    try {
      const res = spawnSync("rg", ["--version"], {
        stdio: "ignore",
        timeout: 5_000,
        windowsHide: true,
      });
      return res.status === 0;
    } catch {
      return false;
    }
  },
  runGit: (args, opts) =>
    defaultSpawn("git", args, { ...opts, env: nonInteractiveGitEnv() }),
  runRipgrep: (args, opts) => defaultSpawn("rg", args, opts),
};

// ---------------------------------------------------------------------------
// Path jail
// ---------------------------------------------------------------------------

const WIN_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/**
 * Reject inputs whose SHAPE is dangerous on Windows (NTFS alternate data
 * streams, reserved device names, trailing dots/spaces, UNC paths, and
 * drive-relative paths like "C:x"). Applied to raw input on every platform so
 * behavior is uniform and a repo synced from Windows can't smuggle a hazard.
 */
function assertNoWindowsHazards(raw: string): void {
  // UNC path (\\server\share or //server/share).
  if (/^[\\/]{2}/.test(raw)) {
    throw new NodeDevError(
      `Refusing UNC path "${raw}": paths must stay inside custom_nodes/.`,
    );
  }
  // Drive-relative path: a drive letter + colon NOT followed by a separator
  // ("C:x" resolves against the drive's CWD, escaping the jail).
  if (/^[a-zA-Z]:(?![\\/])/.test(raw)) {
    throw new NodeDevError(
      `Refusing drive-relative path "${raw}": it is ambiguous and can escape ` +
        `custom_nodes/. Use a path relative to custom_nodes/ or a full absolute path.`,
    );
  }
  // Strip a leading absolute drive prefix ("C:") before scanning segments so
  // the drive's own colon isn't flagged as an ADS.
  const afterDrive = /^[a-zA-Z]:[\\/]/.test(raw) ? raw.slice(2) : raw;
  for (const seg of afterDrive.split(/[\\/]/)) {
    if (!seg) continue;
    if (seg.includes(":")) {
      throw new NodeDevError(
        `Refusing NTFS alternate data stream in "${seg}": ':' is not allowed in a path segment.`,
      );
    }
    const stem = seg.split(".")[0]!.toUpperCase();
    if (WIN_RESERVED.has(seg.toUpperCase()) || WIN_RESERVED.has(stem)) {
      throw new NodeDevError(
        `Refusing reserved Windows device name "${seg}".`,
      );
    }
    if (/[ .]$/.test(seg)) {
      throw new NodeDevError(
        `Refusing path segment "${seg}": trailing dot or space is unsafe on Windows.`,
      );
    }
  }
}

export function customNodesRoot(): string {
  if (!config.comfyuiPath) {
    throw new NodeDevError(
      "This operation requires a local ComfyUI install, but config.comfyuiPath " +
        "is not set (running in remote --comfyui-url mode). Set COMFYUI_PATH to " +
        "your local ComfyUI directory to read, search, or edit custom-node source.",
    );
  }
  return resolve(config.comfyuiPath, "custom_nodes");
}

function isEscape(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel.startsWith("..") ||
    isAbsolute(rel) ||
    rel.split(/[\\/]/).includes("..")
  );
}

/** Realpath the deepest existing ancestor, re-appending the not-yet-existing tail. */
function realpathDeepestExisting(abs: string, deps: NodeDevDeps): string {
  let cur = abs;
  const tail: string[] = [];
  // Guard against pathological loops.
  for (let i = 0; i < 4096; i++) {
    if (deps.existsSync(cur)) {
      const real = deps.realpath(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    }
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.push(basename(cur));
    cur = parent;
  }
  return abs;
}

export interface JailResult {
  abs: string;
  rel: string;
}

/**
 * The single auditable jail resolver. Returns the realpath'd absolute path and
 * its path relative to the realpath'd custom_nodes root. Throws NodeDevError on
 * any lexical- or symlink-based escape. rel === "" denotes the root itself;
 * callers that must not touch the root reject an empty rel.
 */
export function resolveInJail(input: string, deps: NodeDevDeps = defaultDeps): JailResult {
  const raw = (input ?? "").trim();
  if (!raw) throw new NodeDevError("A path is required (received an empty string).");

  assertNoWindowsHazards(raw);

  const root = customNodesRoot();
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);

  // 1. Lexical containment on the un-resolved candidate.
  if (isEscape(root, candidate)) {
    throw new NodeDevError(
      `Refusing "${input}": resolves to "${candidate}", which is outside custom_nodes/.`,
    );
  }

  // 2. Symlink/junction safety: re-check containment on realpaths.
  const realRoot = deps.existsSync(root) ? deps.realpath(root) : root;
  const realCandidate = realpathDeepestExisting(candidate, deps);
  if (isEscape(realRoot, realCandidate)) {
    throw new NodeDevError(
      `Refusing "${input}": its real path "${realCandidate}" escapes custom_nodes/ ` +
        `(via a symlink or junction).`,
    );
  }

  return { abs: realCandidate, rel: relative(realRoot, realCandidate) };
}

/** Resolve a pack folder: name validated + jailed, must be a non-root dir. */
function resolvePackDir(pack: string, deps: NodeDevDeps): { abs: string; name: string } {
  const name = (pack ?? "").trim();
  assertSafeRepoName(name);
  const { abs, rel } = resolveInJail(name, deps);
  if (!rel) {
    throw new NodeDevError("Refusing to operate on the custom_nodes root itself.");
  }
  return { abs, name };
}

// ---------------------------------------------------------------------------
// Bounded-text helpers (pure — exported for direct testing)
// ---------------------------------------------------------------------------

/** Break any line longer than `width` into multiple lines of at most `width`. */
export function chunkLongLines(lines: string[], width = LONG_LINE_CHUNK): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    for (let i = 0; i < line.length; i += width) {
      out.push(line.slice(i, i + width));
    }
  }
  return out;
}

/** Clip text to maxChars, appending a truncation notice when clipped. */
export function boundText(
  text: string,
  maxChars: number,
  notice = "\n\n[... output truncated — request a narrower range ...]",
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + notice, truncated: true };
}

// ---------------------------------------------------------------------------
// glob → RegExp (minimal: **, *, ?)
// ---------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/\\\\]*";
      }
    } else if (c === "?") {
      re += "[^/\\\\]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else if (c === "/") {
      re += "[/\\\\]";
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

// ---------------------------------------------------------------------------
// list_node_pack_files
// ---------------------------------------------------------------------------

export interface ListFilesOptions {
  pack: string;
  glob?: string;
  maxEntries?: number;
}

export interface ListedEntry {
  path: string;
  size: number;
  dir: boolean;
}

export interface ListFilesResult {
  pack: string;
  root: string;
  entries: ListedEntry[];
  truncated: boolean;
  is_git_repo: boolean;
  has_pyproject: boolean;
}

export function listNodePackFiles(
  options: ListFilesOptions,
  deps: NodeDevDeps = defaultDeps,
): ListFilesResult {
  const { abs: packDir, name } = resolvePackDir(options.pack, deps);
  if (!deps.isDirectory(packDir)) {
    throw new NodeDevError(`Pack "${name}" does not exist under custom_nodes/.`);
  }
  const cap = Math.min(
    Math.max(1, options.maxEntries ?? LIST_DEFAULT_ENTRIES),
    LIST_MAX_ENTRIES,
  );
  const matcher = options.glob ? globToRegExp(options.glob) : null;

  const entries: ListedEntry[] = [];
  let truncated = false;
  const walk = (dir: string) => {
    if (truncated) return;
    let items: DirEntry[];
    try {
      items = deps.listDir(dir);
    } catch {
      return;
    }
    for (const item of items) {
      if (truncated) return;
      const full = join(dir, item.name);
      const rel = relative(packDir, full).split(/[\\/]/).join("/");
      if (item.isDir) {
        if (SKIP_DIRS.has(item.name)) continue;
        if (!matcher || matcher.test(rel)) {
          entries.push({ path: rel, size: 0, dir: true });
          if (entries.length >= cap) {
            truncated = true;
            return;
          }
        }
        walk(full);
      } else {
        if (matcher && !matcher.test(rel)) continue;
        entries.push({ path: rel, size: deps.fileSize(full), dir: false });
        if (entries.length >= cap) {
          truncated = true;
          return;
        }
      }
    }
  };
  walk(packDir);

  return {
    pack: name,
    root: packDir,
    entries,
    truncated,
    is_git_repo: deps.isDirectory(join(packDir, ".git")),
    has_pyproject: deps.isFile(join(packDir, "pyproject.toml")),
  };
}

// ---------------------------------------------------------------------------
// read_node_file
// ---------------------------------------------------------------------------

export interface ReadFileOptions {
  path: string;
  startLine?: number;
  lineCount?: number;
  maxChars?: number;
}

export interface ReadFileResult {
  path: string;
  content: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  size: number;
  truncated: boolean;
}

export function readNodeFile(
  options: ReadFileOptions,
  deps: NodeDevDeps = defaultDeps,
): ReadFileResult {
  const { abs, rel } = resolveInJail(options.path, deps);
  if (!rel) throw new NodeDevError("Refusing to read the custom_nodes root itself.");
  if (!deps.existsSync(abs) || !deps.isFile(abs)) {
    throw new NodeDevError(`File not found under custom_nodes/: "${options.path}".`);
  }

  const size = deps.fileSize(abs);
  const raw = deps.readFileText(abs);
  // Split on CRLF or LF so total_lines is correct on Windows files.
  const allLines = raw.split(/\r\n|\n/);
  const totalLines = allLines.length;

  const startLine = Math.max(1, Math.floor(options.startLine ?? 1));
  const lineCount = Math.min(
    Math.max(1, Math.floor(options.lineCount ?? READ_DEFAULT_LINES)),
    READ_MAX_LINES,
  );
  const maxChars = Math.min(
    Math.max(1, Math.floor(options.maxChars ?? READ_DEFAULT_CHARS)),
    READ_MAX_CHARS,
  );

  const startIdx = startLine - 1;
  const slice = allLines.slice(startIdx, startIdx + lineCount);
  const endLine = Math.min(totalLines, startIdx + slice.length);

  const chunked = chunkLongLines(slice);
  const bounded = boundText(chunked.join("\n"), maxChars);

  return {
    path: rel.split(/[\\/]/).join("/"),
    content: bounded.text,
    start_line: startLine,
    end_line: endLine,
    total_lines: totalLines,
    size,
    truncated: bounded.truncated || endLine < totalLines,
  };
}

// ---------------------------------------------------------------------------
// search_node_packs
// ---------------------------------------------------------------------------

export interface SearchOptions {
  query: string;
  path?: string;
  glob?: string;
  maxResults?: number;
  caseSensitive?: boolean;
}

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

export interface SearchResult {
  engine: "ripgrep" | "builtin";
  matches: SearchMatch[];
  truncated: boolean;
}

/** Resolve the directory a search runs over (default "." = the whole jail root). */
function resolveSearchDir(path: string | undefined, deps: NodeDevDeps): string {
  const p = (path ?? ".").trim();
  if (p === "." || p === "") return customNodesRoot();
  const { abs } = resolveInJail(p, deps);
  return abs;
}

export function searchNodePacks(
  options: SearchOptions,
  deps: NodeDevDeps = defaultDeps,
): SearchResult {
  const query = options.query ?? "";
  if (!query) throw new NodeDevError("A non-empty search query is required.");
  const cap = Math.min(
    Math.max(1, options.maxResults ?? SEARCH_DEFAULT_RESULTS),
    SEARCH_MAX_RESULTS,
  );
  const searchDir = resolveSearchDir(options.path, deps);
  if (!deps.isDirectory(searchDir)) {
    throw new NodeDevError(`Search path does not exist under custom_nodes/.`);
  }

  if (deps.hasRipgrep()) {
    return searchWithRipgrep(query, searchDir, cap, options, deps);
  }
  return searchBuiltin(query, searchDir, cap, options, deps);
}

function searchWithRipgrep(
  query: string,
  searchDir: string,
  cap: number,
  options: SearchOptions,
  deps: NodeDevDeps,
): SearchResult {
  const args = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--path-separator",
    "/",
    "--max-count",
    String(cap),
  ];
  if (!options.caseSensitive) args.push("-i");
  if (options.glob) args.push("-g", options.glob);
  for (const d of SKIP_DIRS) args.push("-g", `!${d}/`);
  args.push("--regexp", query, "--", ".");

  const res = deps.runRipgrep(args, { cwd: searchDir, timeoutMs: GIT_TIMEOUT_MS });
  // rg exits 1 when there are no matches — not an error for us.
  if (res.status !== 0 && res.status !== 1) {
    throw new NodeDevError(
      `ripgrep failed (exit ${res.status}): ${res.stderr.slice(0, 500)}`,
    );
  }

  const matches: SearchMatch[] = [];
  let truncated = false;
  for (const raw of res.stdout.split(/\r?\n/)) {
    if (!raw) continue;
    if (matches.length >= cap) {
      truncated = true;
      break;
    }
    const m = /^(.*?):(\d+):(.*)$/.exec(raw);
    if (!m) continue;
    matches.push({
      file: m[1],
      line: Number(m[2]),
      text: m[3].slice(0, SEARCH_LINE_MAX),
    });
  }
  return { engine: "ripgrep", matches, truncated };
}

function searchBuiltin(
  query: string,
  searchDir: string,
  cap: number,
  options: SearchOptions,
  deps: NodeDevDeps,
): SearchResult {
  const re = new RegExp(query, options.caseSensitive ? "" : "i");
  const globMatcher = options.glob ? globToRegExp(options.glob) : null;
  const matches: SearchMatch[] = [];
  let truncated = false;
  let scanned = 0;

  const walk = (dir: string) => {
    if (truncated) return;
    let items: DirEntry[];
    try {
      items = deps.listDir(dir);
    } catch {
      return;
    }
    for (const item of items) {
      if (truncated) return;
      const full = join(dir, item.name);
      if (item.isDir) {
        if (SKIP_DIRS.has(item.name) || item.name.startsWith(".")) continue;
        walk(full);
        continue;
      }
      const rel = relative(searchDir, full).split(/[\\/]/).join("/");
      if (globMatcher && !globMatcher.test(rel)) continue;
      if (deps.fileSize(full) > SEARCH_MAX_FILE_BYTES) continue;
      if (++scanned > SEARCH_MAX_SCANNED_FILES) {
        truncated = true;
        return;
      }
      let buf: Buffer;
      try {
        buf = deps.readFileBuffer(full);
      } catch {
        continue;
      }
      if (buf.includes(0)) continue; // binary — skip
      const lines = buf.toString("utf-8").split(/\r\n|\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          if (matches.length >= cap) {
            truncated = true;
            return;
          }
          matches.push({
            file: rel,
            line: i + 1,
            text: lines[i].slice(0, SEARCH_LINE_MAX),
          });
        }
      }
    }
  };
  walk(searchDir);
  return { engine: "builtin", matches, truncated };
}

// ---------------------------------------------------------------------------
// write_node_file
// ---------------------------------------------------------------------------

export interface WriteFileOptions {
  path: string;
  content: string;
  overwrite?: boolean;
  createDirs?: boolean;
}

export interface WriteFileResult {
  path: string;
  bytes: number;
  created: boolean;
}

export function writeNodeFile(
  options: WriteFileOptions,
  deps: NodeDevDeps = defaultDeps,
): WriteFileResult {
  const { abs, rel } = resolveInJail(options.path, deps);
  if (!rel) throw new NodeDevError("Refusing to write the custom_nodes root itself.");

  const exists = deps.existsSync(abs);
  if (exists && !options.overwrite) {
    throw new NodeDevError(
      `File already exists: "${options.path}". Pass overwrite:true to replace it.`,
    );
  }
  if (exists && !deps.isFile(abs)) {
    throw new NodeDevError(`Refusing to overwrite non-file path "${options.path}".`);
  }

  const parent = dirname(abs);
  if (!deps.existsSync(parent)) {
    if (options.createDirs === false) {
      throw new NodeDevError(
        `Parent directory does not exist for "${options.path}" and create_dirs is false.`,
      );
    }
    deps.mkdirp(parent);
  }

  const content = options.content ?? "";
  deps.writeFileText(abs, content);
  logger.info("write_node_file", { path: rel, bytes: Buffer.byteLength(content) });

  return {
    path: rel.split(/[\\/]/).join("/"),
    bytes: Buffer.byteLength(content, "utf-8"),
    created: !exists,
  };
}

// ---------------------------------------------------------------------------
// apply_node_patch
// ---------------------------------------------------------------------------

export interface PatchResult {
  success: boolean;
  stage: "check" | "apply";
  touched: string[];
  stdout: string;
  stderr: string;
}

/** Extract every file path a unified diff touches (from ---/+++ headers). */
export function parsePatchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    const m = /^(?:---|\+\+\+) (.+)$/.exec(line);
    if (!m) continue;
    let p = m[1].trim();
    if (p === "/dev/null") continue;
    // Strip a trailing tab-prefixed timestamp some diff tools append.
    p = p.replace(/\t.*$/, "");
    // Strip a/ or b/ prefix.
    p = p.replace(/^[ab]\//, "");
    if (p) paths.add(p);
  }
  return [...paths];
}

export function applyNodePatch(
  patch: string,
  deps: NodeDevDeps = defaultDeps,
): PatchResult {
  if (!patch || !patch.trim()) {
    throw new NodeDevError("An empty patch was provided.");
  }
  const root = customNodesRoot();

  // Phase 1: jail-check EVERY touched path BEFORE any git call.
  const touched = parsePatchPaths(patch);
  if (touched.length === 0) {
    throw new NodeDevError(
      "Could not find any file headers (---/+++) in the patch. Provide a unified diff.",
    );
  }
  for (const p of touched) {
    const { rel } = resolveInJail(p, deps);
    if (!rel) {
      throw new NodeDevError(`Patch would touch the custom_nodes root itself ("${p}").`);
    }
  }

  const input = patch.endsWith("\n") ? patch : patch + "\n";

  // Phase 2a: git apply --check (dry run).
  const check = deps.runGit(["apply", "--check"], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
    input,
  });
  if (check.status !== 0) {
    return {
      success: false,
      stage: "check",
      touched,
      stdout: boundText(check.stdout, CMD_OUTPUT_MAX).text,
      stderr: boundText(check.stderr, CMD_OUTPUT_MAX).text,
    };
  }

  // Phase 2b: git apply (real).
  const apply = deps.runGit(["apply"], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
    input,
  });
  return {
    success: apply.status === 0,
    stage: "apply",
    touched,
    stdout: boundText(apply.stdout, CMD_OUTPUT_MAX).text,
    stderr: boundText(apply.stderr, CMD_OUTPUT_MAX).text,
  };
}

// ---------------------------------------------------------------------------
// node_pack_git
// ---------------------------------------------------------------------------

export type GitAction = "status" | "diff" | "log" | "commit" | "push";

export interface GitOptions {
  pack: string;
  action: GitAction;
  message?: string;
  paths?: string[];
  maxChars?: number;
}

export interface GitResult {
  pack: string;
  action: GitAction;
  argv: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  success: boolean;
}

/** Whether git writes (commit/push) are permitted by env flag. Default OFF. */
export function gitWritesEnabled(): boolean {
  const v = (process.env.COMFYUI_MCP_ALLOW_GIT_WRITES ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Jail-check a caller-supplied path and return it relative to the pack dir. */
function packRelativePath(packDir: string, p: string, deps: NodeDevDeps): string {
  const { abs } = resolveInJail(p, deps);
  const rel = relative(packDir, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new NodeDevError(`Path "${p}" is outside the target pack.`);
  }
  return rel.split(/[\\/]/).join("/") || ".";
}

export function nodePackGit(
  options: GitOptions,
  deps: NodeDevDeps = defaultDeps,
): GitResult {
  const { abs: packDir, name } = resolvePackDir(options.pack, deps);
  if (!deps.isDirectory(packDir)) {
    throw new NodeDevError(`Pack "${name}" does not exist under custom_nodes/.`);
  }
  const action = options.action;
  const maxChars = Math.min(
    Math.max(1, options.maxChars ?? CMD_OUTPUT_MAX),
    READ_MAX_CHARS,
  );

  const relPaths = (options.paths ?? []).map((p) => packRelativePath(packDir, p, deps));

  let argv: string[];
  let timeoutMs = GIT_TIMEOUT_MS;
  switch (action) {
    case "status":
      argv = ["status", "--short", "--branch"];
      if (relPaths.length) argv.push("--", ...relPaths);
      break;
    case "diff":
      argv = ["diff"];
      if (relPaths.length) argv.push("--", ...relPaths);
      break;
    case "log":
      argv = ["log", "--max-count=20", "--pretty=format:%h %an %ad %s", "--date=short"];
      if (relPaths.length) argv.push("--", ...relPaths);
      break;
    case "commit": {
      if (!gitWritesEnabled()) throw new GitWritesDisabledError("commit");
      const message = (options.message ?? "").trim();
      if (!message) {
        throw new NodeDevError("commit requires a non-empty message.");
      }
      // Stage first (selective or all), then commit.
      const addArgs = relPaths.length
        ? ["add", "--end-of-options", "--", ...relPaths]
        : ["add", "-A"];
      const add = deps.runGit(addArgs, { cwd: packDir, timeoutMs });
      if (add.status !== 0) {
        return {
          pack: name,
          action,
          argv: addArgs,
          status: add.status,
          stdout: boundText(add.stdout, maxChars).text,
          stderr: boundText(add.stderr, maxChars).text,
          success: false,
        };
      }
      argv = ["commit", "-m", message];
      break;
    }
    case "push":
      if (!gitWritesEnabled()) throw new GitWritesDisabledError("push");
      argv = ["push"];
      timeoutMs = GIT_PUSH_TIMEOUT_MS;
      break;
    default:
      throw new NodeDevError(`Unknown git action "${String(action)}".`);
  }

  const res = deps.runGit(argv, { cwd: packDir, timeoutMs });
  return {
    pack: name,
    action,
    argv,
    status: res.status,
    stdout: boundText(res.stdout, maxChars).text,
    stderr: boundText(res.stderr, maxChars).text,
    success: res.status === 0,
  };
}
