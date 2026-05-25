import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { config } from "../config.js";
import { ComfyUIError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Custom-node authoring lifecycle — scaffold a Python node pack from a
// deterministic template, then publish it to the Comfy Registry via
// `comfy node publish`.
//
// Template shape mirrors the Comfy Registry publishing guide
// (https://docs.comfy.org/registry/publishing) and the custom-node walkthrough
// (https://docs.comfy.org/custom-nodes/walkthrough):
//   - pyproject.toml carries [project] metadata plus a [tool.comfy] table with
//     PublisherId / DisplayName / Icon. The registry reads PublisherId to route
//     the pack to your account and the [project] name/version for the listing.
//   - __init__.py exports NODE_CLASS_MAPPINGS / NODE_DISPLAY_NAME_MAPPINGS (and
//     WEB_DIRECTORY when a frontend extension ships).
//   - src/nodes.py holds a sample node class with the canonical INPUT_TYPES /
//     RETURN_TYPES / FUNCTION / CATEGORY contract.
//
// Both operations are LOCAL-ONLY: they write to / run inside
// <COMFYUI_PATH>/custom_nodes and have no meaning against a remote
// --comfyui-url instance.
// ---------------------------------------------------------------------------

export class NodeAuthoringError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "NODE_AUTHORING_ERROR", details);
    this.name = "NodeAuthoringError";
  }
}

const IS_WIN = platform() === "win32";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScaffoldOptions {
  /** Folder/pack name — must be a safe slug (a-z 0-9 - _). */
  name: string;
  /** Human-readable display name shown in the ComfyUI node menu / registry. */
  displayName: string;
  /** Node menu category (e.g. "custom"). */
  category?: string;
  /** Short description for pyproject [project].description. */
  description?: string;
  /** Registry publisher id stamped into [tool.comfy].PublisherId. */
  publisherId?: string;
  /** Emit a web/js extension stub and wire WEB_DIRECTORY. */
  withFrontend?: boolean;
  /** Overwrite an existing pack directory instead of refusing. */
  overwrite?: boolean;
}

export interface ScaffoldResult {
  name: string;
  /** Absolute path to the generated pack directory. */
  path: string;
  /** Pack-relative paths of every file written. */
  files: string[];
  withFrontend: boolean;
  message: string;
}

export interface PublishOptions {
  /** Pack folder name under custom_nodes/ (mutually exclusive with path). */
  name?: string;
  /** Explicit absolute path to a pack directory (overrides name). */
  path?: string;
}

export interface PublishResult {
  published: boolean;
  /** Pack name from pyproject [project].name. */
  packName: string;
  version: string;
  publisherId: string;
  /** Absolute path the publish ran in. */
  path: string;
  /** Registry URL parsed from comfy-cli output, if it emitted one. */
  registryUrl?: string;
  message: string;
  /** Raw (token-free) subprocess output. */
  output?: string;
}

// ---------------------------------------------------------------------------
// Seams — overridable for testing without touching real disk / subprocess.
// ---------------------------------------------------------------------------

export interface AuthoringDeps {
  existsSync: (p: string) => boolean;
  mkdirp: (p: string) => void;
  writeFile: (p: string, contents: string) => void;
  readFile: (p: string) => string;
  /** True if path exists AND is a directory containing at least one entry. */
  isNonEmptyDir: (p: string) => boolean;
  /** Detect whether a CLI tool is on PATH. */
  hasCommand: (cmd: string) => boolean;
  /**
   * Run a command. Returns combined stdout/stderr. The `env` is merged onto
   * process.env by the implementation — callers pass ONLY the extra vars
   * (e.g. the registry token) so secrets never appear in `args`.
   */
  run: (
    cmd: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string> },
  ) => string;
}

function defaultIsNonEmptyDir(p: string): boolean {
  try {
    if (!existsSync(p)) return false;
    return readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

function defaultHasCommand(cmd: string): boolean {
  try {
    const probe = IS_WIN ? ["where", cmd] : ["command", "-v", cmd];
    const res = spawnSync(probe[0], probe.slice(1), {
      stdio: "ignore",
      timeout: 5000,
      shell: IS_WIN ? false : true,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

function defaultRun(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): string {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    timeout: 600_000,
    // Token is injected via env, never via args (which we log).
    env: { ...process.env, ...(opts.env ?? {}) },
  });

  if (result.error) {
    const e = result.error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new NodeAuthoringError(
        `"${cmd}" was not found on PATH. Install comfy-cli (\`pip install comfy-cli\`) to publish.`,
      );
    }
    throw new NodeAuthoringError(`Failed to execute ${cmd}: ${e.message}`);
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combined = [stdout, stderr].filter(Boolean).join("\n").trim();

  if (result.status !== 0) {
    throw new NodeAuthoringError(
      `Command failed (exit ${result.status}): ${cmd} ${args.join(" ")}\n${combined}`,
    );
  }
  return combined;
}

const defaultDeps: AuthoringDeps = {
  existsSync,
  mkdirp: (p: string) => {
    mkdirSync(p, { recursive: true });
  },
  writeFile: (p: string, contents: string) => {
    writeFileSync(p, contents, "utf-8");
  },
  readFile: (p: string) => readFileSync(p, "utf-8"),
  isNonEmptyDir: defaultIsNonEmptyDir,
  hasCommand: defaultHasCommand,
  run: defaultRun,
};

// ---------------------------------------------------------------------------
// Validation helpers — pure, so tests can assert on them directly.
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

/**
 * Validate a pack name as a safe slug AND reject anything that could escape
 * custom_nodes/ (path separators, "..", absolute paths, drive letters). The
 * SLUG_RE already forbids "/", "\\", ":" and "." so traversal is impossible,
 * but we keep an explicit check for a clear, security-focused error message.
 */
export function validatePackName(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) {
    throw new ValidationError("name is required and cannot be empty.");
  }
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    isAbsolute(trimmed) ||
    /^[a-zA-Z]:/.test(trimmed)
  ) {
    throw new ValidationError(
      `Unsafe pack name "${name}": names may not contain path separators, "..", ` +
        `or be absolute — they must stay inside custom_nodes/.`,
    );
  }
  if (!SLUG_RE.test(trimmed)) {
    throw new ValidationError(
      `Invalid pack name "${name}". Use a lowercase slug: letters, digits, ` +
        `hyphens, and underscores only (e.g. "my-cool-nodes"). Must start and ` +
        `end with a letter or digit.`,
    );
  }
  if (trimmed.length > 64) {
    throw new ValidationError(`Pack name "${name}" is too long (max 64 chars).`);
  }
  return trimmed;
}

/** A python-identifier-safe variant of the slug for the sample class name. */
function toClassName(slug: string): string {
  const parts = slug.split(/[-_]+/).filter(Boolean);
  const pascal = parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
  // Ensure it doesn't start with a digit (python identifier rule).
  return /^[0-9]/.test(pascal) ? `Node${pascal}` : `${pascal}Node`;
}

/**
 * Resolve the custom_nodes root, throwing a clear error in remote mode where
 * there is no local install path to write into.
 */
function customNodesRoot(): string {
  if (!config.comfyuiPath) {
    throw new ValidationError(
      "This operation needs a local ComfyUI install, but config.comfyuiPath is " +
        "not set (running in remote --comfyui-url mode). Set COMFYUI_PATH to your " +
        "local ComfyUI directory to scaffold or publish custom nodes.",
    );
  }
  return join(config.comfyuiPath, "custom_nodes");
}

/**
 * Resolve and confirm a target pack directory is strictly inside custom_nodes/.
 * Defends against traversal even if validation upstream were bypassed.
 */
function resolvePackDir(name: string): string {
  const root = customNodesRoot();
  const dir = resolve(root, name);
  const rel = relative(root, dir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.includes(`..${sep}`)) {
    throw new ValidationError(
      `Refusing to operate outside custom_nodes/: resolved "${name}" to "${dir}".`,
    );
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Template builders — pure functions returning file contents.
// ---------------------------------------------------------------------------

function escapeToml(s: string): string {
  // TOML basic strings: escape backslash and double-quote.
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildPyprojectToml(opts: {
  name: string;
  description: string;
  publisherId: string;
  displayName: string;
}): string {
  const repoUrl = `https://github.com/${opts.publisherId}/${opts.name}`;
  return `[project]
name = "${escapeToml(opts.name)}"
description = "${escapeToml(opts.description)}"
version = "0.0.1"
license = { text = "MIT" }
dependencies = []

[project.urls]
Repository = "${escapeToml(repoUrl)}"

[tool.comfy]
PublisherId = "${escapeToml(opts.publisherId)}"
DisplayName = "${escapeToml(opts.displayName)}"
Icon = ""
`;
}

export function buildInitPy(opts: {
  className: string;
  displayName: string;
  withFrontend: boolean;
}): string {
  const lines = [
    `"""${opts.displayName} — ComfyUI custom node pack."""`,
    "",
    `from .src.nodes import ${opts.className}`,
    "",
    "NODE_CLASS_MAPPINGS = {",
    `    "${opts.className}": ${opts.className},`,
    "}",
    "",
    "NODE_DISPLAY_NAME_MAPPINGS = {",
    `    "${opts.className}": "${opts.displayName}",`,
    "}",
    "",
  ];
  if (opts.withFrontend) {
    lines.push(
      "# Serve the bundled JS extension(s) from ./web to the ComfyUI frontend.",
      'WEB_DIRECTORY = "./web"',
      "",
      '__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]',
      "",
    );
  } else {
    lines.push('__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]', "");
  }
  return lines.join("\n");
}

export function buildNodesPy(opts: {
  className: string;
  displayName: string;
  category: string;
}): string {
  return `"""Sample node for ${escapeToml(opts.displayName)}."""


class ${opts.className}:
    """A minimal example node. Replace with your own logic."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "hello", "multiline": False}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "${escapeToml(opts.category)}"

    def run(self, text):
        # TODO: implement your node. This sample echoes its input.
        return (text,)
`;
}

export function buildFrontendJs(opts: { name: string; displayName: string }): string {
  return `// Frontend extension stub for ${opts.displayName}.
// Registered via WEB_DIRECTORY in __init__.py. See:
// https://docs.comfy.org/custom-nodes/js/javascript_overview
import { app } from "../../scripts/app.js";

app.registerExtension({
  name: "${opts.name}",
  async setup() {
    console.log("[${opts.name}] frontend extension loaded");
  },
});
`;
}

// ---------------------------------------------------------------------------
// scaffold_custom_node
// ---------------------------------------------------------------------------

export function scaffoldCustomNode(
  options: ScaffoldOptions,
  deps: AuthoringDeps = defaultDeps,
): ScaffoldResult {
  const name = validatePackName(options.name);
  const displayName = (options.displayName ?? "").trim() || name;
  const category = (options.category ?? "custom").trim() || "custom";
  const description =
    (options.description ?? "").trim() || `ComfyUI custom nodes: ${displayName}`;
  // PublisherId is required for publishing later; default to a clear placeholder
  // the author must replace (rather than guessing).
  const publisherId = (options.publisherId ?? "").trim() || "your-publisher-id";
  const withFrontend = options.withFrontend ?? false;
  const className = toClassName(name);

  const packDir = resolvePackDir(name);

  // Refuse to clobber an existing pack unless explicitly allowed.
  if (deps.isNonEmptyDir(packDir) && !options.overwrite) {
    throw new ValidationError(
      `A non-empty directory already exists at ${packDir}. ` +
        `Pass overwrite:true to replace its files, or choose a different name.`,
    );
  }

  deps.mkdirp(packDir);
  deps.mkdirp(join(packDir, "src"));

  const written: string[] = [];
  const write = (relPath: string, contents: string) => {
    deps.writeFile(join(packDir, relPath), contents);
    written.push(relPath);
  };

  write(
    "pyproject.toml",
    buildPyprojectToml({ name, description, publisherId, displayName }),
  );
  write("__init__.py", buildInitPy({ className, displayName, withFrontend }));
  // src is a package; an empty __init__ makes the relative import work.
  write(join("src", "__init__.py"), "");
  write(join("src", "nodes.py"), buildNodesPy({ className, displayName, category }));

  if (withFrontend) {
    deps.mkdirp(join(packDir, "web", "js"));
    write(join("web", "js", `${name}.js`), buildFrontendJs({ name, displayName }));
  }

  logger.info(`Scaffolded custom node pack "${name}"`, { path: packDir });

  return {
    name,
    path: packDir,
    files: written,
    withFrontend,
    message:
      `Scaffolded custom node pack "${name}" at ${packDir}. ` +
      (publisherId === "your-publisher-id"
        ? `Set [tool.comfy].PublisherId in pyproject.toml before publishing. `
        : ``) +
      `Restart ComfyUI (restart_comfyui) to load it, then publish with publish_custom_node.`,
  };
}

// ---------------------------------------------------------------------------
// pyproject parsing (minimal, targeted) for publish validation
// ---------------------------------------------------------------------------

interface ParsedPyproject {
  projectName?: string;
  version?: string;
  publisherId?: string;
}

/**
 * Extract just the fields publish needs from a pyproject.toml. Intentionally
 * minimal — we read [project].name/version and [tool.comfy].PublisherId without
 * a full TOML parser (no dep), tolerating common formatting.
 */
export function parsePyproject(toml: string): ParsedPyproject {
  const result: ParsedPyproject = {};

  // Slice a [header] table: from its header line up to (but not including) the
  // next table header — a line that STARTS with "[" at column 0. We must not
  // stop at a "[" mid-line (e.g. an inline array like `dependencies = ["x"]`),
  // which would truncate the section and drop later keys such as `version`.
  const escapedHeader = (header: string) => header.replace(/[.[\]]/g, "\\$&");
  const sectionOf = (header: string): string => {
    const re = new RegExp(
      `^\\[${escapedHeader(header)}\\][^\\n]*\\n(?:(?!\\[)[^\\n]*\\n?)*`,
      "m",
    );
    const m = toml.match(re);
    return m ? m[0] : "";
  };

  const readKey = (section: string, key: string): string | undefined => {
    // Accept single- OR double-quoted TOML strings (backreference the opening
    // quote so mismatched quotes don't match). Not a full TOML parser, but it
    // covers the basic + multi-line table forms Python packaging tools emit.
    const re = new RegExp(`^\\s*${key}\\s*=\\s*(["'])(.*?)\\1`, "m");
    const m = section.match(re);
    return m ? m[2] : undefined;
  };

  const project = sectionOf("project");
  result.projectName = readKey(project, "name");
  result.version = readKey(project, "version");

  const toolComfy = sectionOf("tool.comfy");
  result.publisherId = readKey(toolComfy, "PublisherId");

  return result;
}

// ---------------------------------------------------------------------------
// publish_custom_node
// ---------------------------------------------------------------------------

/** Parse a registry URL out of comfy-cli publish output, if present. */
export function extractRegistryUrl(output: string): string | undefined {
  const m = output.match(/https?:\/\/[^\s"')]*registry\.comfy\.org[^\s"')]*/i);
  return m ? m[0] : undefined;
}

export function publishCustomNode(
  options: PublishOptions,
  deps: AuthoringDeps = defaultDeps,
): PublishResult {
  // Resolve the pack directory from either an explicit path or a name.
  let packDir: string;
  if (options.path && options.path.trim()) {
    // Publishing an explicit pack directory is a local filesystem + comfy-cli
    // operation, independent of which ComfyUI instance is targeted — so it is
    // intentionally allowed even in remote (--comfyui-url) mode. Resolving by
    // `name` (below) lives under <COMFYUI_PATH>/custom_nodes and is guarded by
    // resolvePackDir, which fails clearly when there is no local install.
    packDir = resolve(options.path.trim());
  } else if (options.name && options.name.trim()) {
    packDir = resolvePackDir(validatePackName(options.name));
  } else {
    throw new ValidationError(
      "Provide either `name` (a pack under custom_nodes/) or an explicit `path`.",
    );
  }

  if (!deps.existsSync(packDir)) {
    throw new NodeAuthoringError(`Pack directory does not exist: ${packDir}`);
  }

  const pyprojectPath = join(packDir, "pyproject.toml");
  if (!deps.existsSync(pyprojectPath)) {
    throw new NodeAuthoringError(
      `No pyproject.toml found in ${packDir}. A Comfy Registry pack must have one ` +
        `(see https://docs.comfy.org/registry/publishing).`,
    );
  }

  const parsed = parsePyproject(deps.readFile(pyprojectPath));

  const missing: string[] = [];
  if (!parsed.projectName) missing.push("[project].name");
  if (!parsed.version) missing.push("[project].version");
  if (!parsed.publisherId) missing.push("[tool.comfy].PublisherId");
  if (parsed.publisherId === "your-publisher-id") {
    throw new ValidationError(
      `[tool.comfy].PublisherId is still the placeholder "your-publisher-id" in ` +
        `${pyprojectPath}. Set it to your real Comfy Registry publisher id before publishing.`,
    );
  }
  if (missing.length > 0) {
    throw new ValidationError(
      `pyproject.toml at ${pyprojectPath} is missing required field(s): ` +
        `${missing.join(", ")}. See https://docs.comfy.org/registry/publishing.`,
    );
  }

  // Require the registry token. comfy-cli reads --token; we pass it via env so
  // it never lands in argv (which we log) — comfy-cli falls back to the
  // REGISTRY_ACCESS_TOKEN env var when --token is absent.
  const token = process.env.REGISTRY_ACCESS_TOKEN;
  if (!token || !token.trim()) {
    throw new ValidationError(
      "REGISTRY_ACCESS_TOKEN is not set. Create an API key at " +
        "https://registry.comfy.org and export it as REGISTRY_ACCESS_TOKEN before publishing.",
    );
  }

  if (!deps.hasCommand("comfy")) {
    throw new NodeAuthoringError(
      "comfy-cli is not installed (the `comfy` command was not found on PATH). " +
        "Install it with `pip install comfy-cli` to publish to the registry.",
    );
  }

  // NOTE: token is passed ONLY through env, never in args. We log args, so a
  // token in args would leak into logs.
  logger.info("Publishing custom node to Comfy Registry", {
    pack: parsed.projectName,
    version: parsed.version,
    cwd: packDir,
    args: ["node", "publish"].join(" "),
  });

  const output = deps.run("comfy", ["node", "publish"], {
    cwd: packDir,
    env: { REGISTRY_ACCESS_TOKEN: token },
  });

  const registryUrl = extractRegistryUrl(output);

  return {
    published: true,
    packName: parsed.projectName!,
    version: parsed.version!,
    publisherId: parsed.publisherId!,
    path: packDir,
    registryUrl,
    message:
      `Published "${parsed.projectName}" v${parsed.version} to the Comfy Registry` +
      (registryUrl ? ` (${registryUrl}).` : ".") +
      ` This is a public, external action and cannot be undone here.`,
    output,
  };
}
