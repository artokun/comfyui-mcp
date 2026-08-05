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
import { resolveEffectiveComfyUIBase } from "./workspace-env.js";
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
/**
 * #809 (codex gate): the FLOOR for any `max_chars`, mirroring query_workflow's own 500.
 * A budget of 1 cannot hold the sentence that explains why the output was cut, so it
 * used to produce either an unexplained empty field or a marker that breached the very
 * bound it described. Neither is honest. This raises a FLOOR, not a cap — the ceiling is
 * untouched — and it is the smallest value at which the tool can still answer "why is
 * this empty?".
 */
export const MIN_OUTPUT_CHARS = 500;

/**
 * #809 (codex gate): "raise `X` up to N" is ITSELF a dead retry when the caller is
 * already at N. Telling someone at max_results=100 to raise it to 100 wastes exactly the
 * round trip this issue exists to prevent, and teaches the same wrong lesson ("the tool
 * can't do this"). At the ceiling the remedy must switch to what is actually left.
 */
export function raiseOrCeiling(param: string, inForce: number, ceiling: number): string {
  return inForce >= ceiling
    ? `\`${param}\` is already at its ceiling of ${ceiling}, so raising it is not an option`
    : `raise \`${param}\` up to ${ceiling}`;
}
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
  // Resolve the effective LOCAL ComfyUI base the same way every other
  // filesystem-backed tool does: COMFYUI_PATH first, then the saved default
  // workspace (set via workspace action:"set_default") when COMFYUI_PATH is unset. This
  // is what get_environment / workspace action:"get" already report, so custom-node
  // source tools no longer reject a loopback session that has a saved default
  // workspace as if it were remote (#506). Returns undefined only in remote
  // mode or when no local install is known — then we refuse with a clear error.
  const base = resolveEffectiveComfyUIBase();
  if (!base) {
    throw new NodeDevError(
      "This operation requires a local ComfyUI install, but none is configured " +
        "(COMFYUI_PATH is unset, no saved default workspace, or running in remote " +
        "--comfyui-url mode). Set COMFYUI_PATH or a default workspace " +
        "(workspace action:\"set_default\") to read, search, or edit custom-node source.",
    );
  }
  return resolve(base, "custom_nodes");
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

/**
 * Clip text to maxChars, appending a truncation notice when clipped.
 *
 * #809: the default notice ("request a narrower range") named no parameter at all, so
 * a caller could not tell WHICH argument to change or how far it could go. Callers now
 * pass a notice built by `boundedNotice`, which states how much was dropped, the exact
 * parameter to raise, and that parameter's REAL clamp — not the one in the prose.
 */
export function boundText(
  text: string,
  maxChars: number,
  /**
   * REQUIRED (codex gate): there is no safe default. `boundText` is shared by tools with
   * DIFFERENT levers — read_node_file has `max_chars`, apply_node_patch has none — so a
   * default naming `max_chars` would ship a dead remedy to whichever caller lacks it.
   * Every call site states its own.
   */
  notice: (dropped: number) => string,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  // The marker is spent from the SAME budget it describes (codex gate): reserve its
  // worst-case size up front so the returned text still honours `maxChars`. The digit
  // count is bounded by text.length, so the reserve can never be too small.
  //
  // The one case that cannot honour it: a budget SMALLER than the marker itself. There
  // the marker still wins and content is dropped entirely — an empty field with no
  // explanation reads as "the file is empty", which is a worse lie than an over-budget
  // sentence. Every real caller clamps well above the marker, so this is a corner, not
  // the contract.
  const reserve = notice(text.length).length;
  const keep = Math.max(0, maxChars - reserve);
  return { text: text.slice(0, keep) + notice(text.length - keep), truncated: true };
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
  /** #809: the remedy in prose. A bare `truncated` boolean is not text the model reads,
   *  so an agent that hits it concludes the pack simply has these files. */
  truncation_hint?: string;
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
      // #809 (codex gate): stopping AT the cap cannot tell "exactly cap entries" from
      // "capped", so a pack with exactly `max_entries` files was reported as truncated.
      // Take ONE past the cap, then drop it: the extra entry is the proof, and its
      // presence is the only honest truncation signal.
      const take = (entry: ListedEntry): boolean => {
        entries.push(entry);
        if (entries.length > cap) {
          entries.pop();
          truncated = true;
          return true;
        }
        return false;
      };
      if (item.isDir) {
        if (SKIP_DIRS.has(item.name)) continue;
        if (!matcher || matcher.test(rel)) {
          if (take({ path: rel, size: 0, dir: true })) return;
        }
        walk(full);
      } else {
        if (matcher && !matcher.test(rel)) continue;
        if (take({ path: rel, size: deps.fileSize(full), dir: false })) return;
      }
    }
  };
  walk(packDir);

  return {
    pack: name,
    root: packDir,
    entries,
    truncated,
    ...(truncated
      ? {
          truncation_hint:
            `Stopped at \`max_entries\`=${cap} after ${entries.length} entr(ies); the walk did NOT ` +
            `finish, so this is not the pack's full file list. ` +
            `${raiseOrCeiling("max_entries", cap, LIST_MAX_ENTRIES)}, or narrow with \`glob\` (e.g. '**/*.py').`,
        }
      : {}),
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

/**
 * #809: read_node_file's truncation notice. Exported (with the other notice builders
 * below) so the schema-driven remedy test can check the parameters they name against
 * read_node_file's REAL zod shape without standing up a filesystem — an untested hint
 * string is precisely how this issue's defect 1 happened.
 *
 * Two DIFFERENT levers, both named: the char budget and the line window. A caller cut by
 * one and told to raise the other burns a retry and concludes the file is unreadable.
 */
export const readBoundNotice =
  (maxChars: number, startLine: number, endLine: number, sliceLineCount = 2) =>
  (dropped: number) => {
    // Paging by `start_line`/`line_count` indexes SOURCE lines. On a slice that is ONE
    // physical line (a minified bundle, an embedded blob) there is nothing to page to —
    // offering it would be a lever that exists and cannot move (codex gate). Say what is
    // actually true: past the ceiling this tool cannot return the rest of that line.
    const onePhysicalLine = sliceLineCount <= 1;
    // Deliberately NOT quoting a length for that line (codex gate): what was measured is
    // the CHUNKED text, which carries inserted newlines, so any number here would be a
    // small lie inside a marker whose whole job is to be trusted.
    const rest = onePhysicalLine
      ? `this slice is a SINGLE physical line, so \`start_line\`/\`line_count\` cannot reach the rest — ` +
        (maxChars >= READ_MAX_CHARS
          ? `at the ${READ_MAX_CHARS} ceiling this tool cannot return more of it; search within it with search_node_packs instead`
          : `${raiseOrCeiling("max_chars", maxChars, READ_MAX_CHARS)}, and past that use search_node_packs to locate what you need inside it`)
      : `${raiseOrCeiling("max_chars", maxChars, READ_MAX_CHARS)}, or page with \`start_line\`/\`line_count\` (max ${READ_MAX_LINES} lines)`;
    return `\n\n[... ${dropped} more char(s) in lines ${startLine}-${endLine} cut by \`max_chars\`=${maxChars}; ${rest} ...]`;
  };

export interface ReadFileResult {
  path: string;
  content: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  size: number;
  truncated: boolean;
  /** #809: present when content was dropped WITHOUT an inline marker (the line window
   *  ended short of the file) — names the parameter to page with. */
  truncation_hint?: string;
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
    // #809: floor at MIN_OUTPUT_CHARS so the truncation notice always fits inside the
    // budget it describes. The CEILING is unchanged.
    Math.max(MIN_OUTPUT_CHARS, Math.floor(options.maxChars ?? READ_DEFAULT_CHARS)),
    READ_MAX_CHARS,
  );

  const startIdx = startLine - 1;
  const slice = allLines.slice(startIdx, startIdx + lineCount);
  const endLine = Math.min(totalLines, startIdx + slice.length);

  const chunked = chunkLongLines(slice);
  // #809: name BOTH levers this tool actually has — the char budget and the line window
  // — with their real clamps, so a caller who hit the wrong one doesn't retry the wrong
  // parameter and conclude the file is unreadable.
  const bounded = boundText(
    chunked.join("\n"),
    maxChars,
    // slice.length is the count of SOURCE lines — the unit `start_line`/`line_count`
    // address. `chunked` is longer when a line was split, and paging cannot reach those
    // chunks, so the notice must be told the real number (codex gate).
    readBoundNotice(maxChars, startLine, endLine, slice.length),
  );
  // The line window can end short of the file INDEPENDENTLY of the char budget — two
  // different cuts with two different remedies. Suppressing this note whenever the char
  // budget also fired lost the continuation point exactly when the caller needed it most
  // (codex gate): the inline marker only describes the chars cut WITHIN the shown range,
  // and says nothing about the lines beyond it.
  const linesCut = endLine < totalLines;
  const truncationHint = linesCut
    ? `Shown lines ${startLine}-${endLine} of ${totalLines} (${totalLines - endLine} line(s) remain); continue with \`start_line\`:${endLine + 1} (\`line_count\` max ${READ_MAX_LINES}).`
    : undefined;

  return {
    path: rel.split(/[\\/]/).join("/"),
    content: bounded.text,
    start_line: startLine,
    end_line: endLine,
    total_lines: totalLines,
    size,
    truncated: bounded.truncated || linesCut,
    ...(truncationHint ? { truncation_hint: truncationHint } : {}),
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
  /** #809: WHICH cap fired — "max_results" has a lever (`max_results`), "scanned_files"
   *  does NOT (it is a fixed walker bound) and must be narrowed with `path`/`glob`
   *  instead. Naming the wrong one of these sends the caller at a dead parameter. */
  truncated_by?: "max_results" | "scanned_files";
  /** The remedy in prose — a boolean alone never reaches the model's reading of the result. */
  truncation_hint?: string;
}

/** #809: a hard 600-char slice with no marker read as if the line simply ended there.
 *  Mark it, and say the cap is fixed so nobody retries a parameter that can't move it. */
export function clipMatchLine(text: string): string {
  if (text.length <= SEARCH_LINE_MAX) return text;
  // The marker is spent from the SAME cap it describes (codex gate), so reserve its
  // worst-case size — the emitted field still honours SEARCH_LINE_MAX.
  const marker = (dropped: number) =>
    // "read the FULL line" would over-promise (codex gate): read_node_file has its own
    // 24000-char budget, so it returns MORE of the line, not necessarily all of it.
    `…(+${dropped} chars; fixed ${SEARCH_LINE_MAX}-char per-line cap — read more of it with read_node_file, itself bounded by its own max_chars, max ${READ_MAX_CHARS})`;
  const keep = Math.max(0, SEARCH_LINE_MAX - marker(text.length).length);
  return text.slice(0, keep) + marker(text.length - keep);
}

/** #809: the whole-result remedy, naming the lever that matches the cause. */
export function searchTruncationHint(
  reason: "max_results" | "scanned_files",
  shown: number,
  cap: number,
): string {
  return reason === "max_results"
    ? `Stopped at \`max_results\`=${cap} after ${shown} match(es); there may be more. ${raiseOrCeiling("max_results", cap, SEARCH_MAX_RESULTS)}, or narrow with \`path\`/\`glob\`.`
    : `Stopped after scanning ${SEARCH_MAX_SCANNED_FILES} files (a FIXED walker bound — no parameter raises it) with ${shown} match(es) found. Narrow with \`path\`/\`glob\`, or install ripgrep on PATH to remove this bound.`;
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
    // #809 (codex gate): ask for ONE past the cap. `--max-count` is PER FILE, so with
    // `cap` exactly, a file holding more matches had them dropped BY RIPGREP before we
    // saw a line — and the loop below reported truncated:false. With `cap + 1`, any
    // truncation anywhere necessarily produces a (cap+1)-th line, which the loop sees;
    // and a search with exactly `cap` real matches produces no extra line, so it is no
    // longer mislabelled as truncated. Both directions of the lie are closed by the
    // same +1.
    "--max-count",
    String(cap + 1),
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
  // Paired with the `cap + 1` above: seeing a (cap+1)-th line is the PROOF that content
  // was dropped, and its absence is proof that nothing was. No per-file bookkeeping is
  // needed — rg cannot hide a match without also pushing the global count past `cap`.
  for (const raw of res.stdout.split(/\r?\n/)) {
    if (!raw) continue;
    const m = /^(.*?):(\d+):(.*)$/.exec(raw);
    if (!m) continue;
    if (matches.length >= cap) {
      truncated = true;
      break;
    }
    matches.push({
      file: m[1],
      line: Number(m[2]),
      text: clipMatchLine(m[3]),
    });
  }
  return {
    engine: "ripgrep",
    matches,
    truncated,
    // ripgrep walks everything, so the only cut here is the result cap.
    ...(truncated
      ? {
          truncated_by: "max_results" as const,
          truncation_hint: searchTruncationHint("max_results", matches.length, cap),
        }
      : {}),
  };
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
  // #809: the builtin walker has TWO independent cuts with OPPOSITE remedies — the
  // result cap (raise `max_results`) and the fixed scanned-file bound (no lever;
  // narrow the search). Remember which one fired.
  //
  // WRITE-ONCE (codex gate): the FIRST cut is the one the caller has to act on. A later
  // write would flip an actionable "raise `max_results`" into "no parameter raises it",
  // which is the exact wrong-lever defect this issue exists to remove. The recursive walk
  // already unwinds on `truncated`, so no overwrite path is known today — this makes the
  // invariant explicit rather than depending on every future early-return staying correct.
  let reason: "max_results" | "scanned_files" | null = null;
  const setReason = (r: "max_results" | "scanned_files") => {
    if (reason === null) reason = r;
  };
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
        setReason("scanned_files");
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
          // #809 (codex gate): stopping AT the cap cannot distinguish "exactly cap
          // matches" from "capped". Reaching a (cap+1)-th match is the proof.
          if (matches.length >= cap) {
            truncated = true;
            setReason("max_results");
            return;
          }
          matches.push({
            file: rel,
            line: i + 1,
            text: clipMatchLine(lines[i]),
          });
        }
      }
    }
  };
  walk(searchDir);
  return {
    engine: "builtin",
    matches,
    truncated,
    ...(truncated && reason
      ? {
          truncated_by: reason,
          truncation_hint: searchTruncationHint(reason, matches.length, cap),
        }
      : {}),
  };
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

/**
 * #809 (codex gate): apply_node_patch's ONLY parameter is `patch` — it has no
 * `max_chars`. Its git output cap is therefore fixed, and a remedy naming a lever this
 * tool does not have would be the very defect this issue is about, pointing the other
 * way. Say the cap is fixed, and name the tool that CAN page the same text.
 */
export const patchBoundNotice = (dropped: number) =>
  `\n\n[... ${dropped} more char(s) cut at the fixed ${CMD_OUTPUT_MAX}-char git-output cap — apply_node_patch has no parameter to raise it. Split the patch into smaller per-file hunks and re-apply: the output shrinks with the patch ...]`;

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
      stdout: boundText(check.stdout, CMD_OUTPUT_MAX, patchBoundNotice).text,
      stderr: boundText(check.stderr, CMD_OUTPUT_MAX, patchBoundNotice).text,
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
    stdout: boundText(apply.stdout, CMD_OUTPUT_MAX, patchBoundNotice).text,
    stderr: boundText(apply.stderr, CMD_OUTPUT_MAX, patchBoundNotice).text,
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

/** #809: node_pack_git's real ceiling is READ_MAX_CHARS (24000) — a CODE clamp the
 *  parameter description never mentioned. State it here so a caller who raises
 *  `max_chars` past it learns why the extra was silently dropped, and narrow-the-scope
 *  is offered because a whole-pack `diff` is often better answered by `paths`. */
export const gitBoundNotice = (maxChars: number) => (dropped: number) =>
  `\n\n[... ${dropped} more char(s) cut by \`max_chars\`=${maxChars}; ${raiseOrCeiling("max_chars", maxChars, READ_MAX_CHARS)} (a hard clamp), or scope the command with \`paths\` ...]`;

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
    // #809: same floor as read_node_file — a budget too small to explain itself is not a
    // usable budget. Ceiling untouched.
    Math.max(MIN_OUTPUT_CHARS, options.maxChars ?? CMD_OUTPUT_MAX),
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
          stdout: boundText(add.stdout, maxChars, gitBoundNotice(maxChars)).text,
          stderr: boundText(add.stderr, maxChars, gitBoundNotice(maxChars)).text,
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
    stdout: boundText(res.stdout, maxChars, gitBoundNotice(maxChars)).text,
    stderr: boundText(res.stderr, maxChars, gitBoundNotice(maxChars)).text,
    success: res.status === 0,
  };
}
