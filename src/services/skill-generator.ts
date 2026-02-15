import { config } from "../config.js";
import { getObjectInfo } from "../comfyui/client.js";
import type { ComfyUINodeDef, ObjectInfo } from "../comfyui/types.js";
import { ComfyUIError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillData {
  name: string;
  version: string;
  description: string;
  repository: string;
  nodes: SkillNodeInfo[];
  examples: SkillExample[];
}

export interface SkillNodeInfo {
  className: string;
  displayName: string;
  category: string;
  inputs: Array<{
    name: string;
    type: string;
    required: boolean;
    default?: unknown;
  }>;
  outputs: Array<{ name: string; type: string }>;
}

export interface SkillExample {
  name: string;
  description: string;
  workflow?: unknown;
}

interface GitHubContentEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  download_url: string | null;
}

interface GitHubFileContent {
  content: string;
  encoding: string;
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };
  if (config.githubToken) {
    headers["Authorization"] = `Bearer ${config.githubToken}`;
  }
  return headers;
}

export async function fetchGitHubFile(
  owner: string,
  repo: string,
  path: string,
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    throw new ComfyUIError(
      `GitHub API error ${res.status} fetching ${path}`,
      "GITHUB_ERROR",
    );
  }
  const data = (await res.json()) as GitHubFileContent;
  if (data.encoding === "base64") {
    return Buffer.from(data.content, "base64").toString("utf-8");
  }
  return data.content;
}

async function listGitHubDir(
  owner: string,
  repo: string,
  path = "",
): Promise<GitHubContentEntry[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    throw new ComfyUIError(
      `GitHub API error ${res.status} listing ${path || "/"}`,
      "GITHUB_ERROR",
    );
  }
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data as GitHubContentEntry[];
}

// ---------------------------------------------------------------------------
// Registry helper
// ---------------------------------------------------------------------------

async function resolveRegistryRepo(registryId: string): Promise<string> {
  const url = `https://api.comfy.org/nodes/${encodeURIComponent(registryId)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new ComfyUIError(
      `ComfyUI Registry error ${res.status} for "${registryId}"`,
      "REGISTRY_ERROR",
    );
  }
  const data = (await res.json()) as { repository?: string };
  if (!data.repository) {
    throw new ComfyUIError(
      `No repository URL found for registry ID "${registryId}"`,
      "REGISTRY_ERROR",
    );
  }
  return data.repository;
}

// ---------------------------------------------------------------------------
// Parse owner/repo from a GitHub URL
// ---------------------------------------------------------------------------

function parseGitHubUrl(url: string): { owner: string; repo: string } {
  // Handles: https://github.com/owner/repo, https://github.com/owner/repo.git
  const match = url.match(
    /github\.com\/([^/]+)\/([^/?.#]+)/,
  );
  if (!match) {
    throw new ComfyUIError(
      `Cannot parse GitHub owner/repo from "${url}"`,
      "VALIDATION_ERROR",
    );
  }
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

// ---------------------------------------------------------------------------
// NODE_CLASS_MAPPINGS parser
// ---------------------------------------------------------------------------

export function parseNodeClassMappings(
  pythonSource: string,
): Record<string, string> {
  const mappings: Record<string, string> = {};

  // Pattern 1: NODE_CLASS_MAPPINGS = { "DisplayName": ClassName, ... }
  // Handles multiline dicts with various quoting
  const dictMatch = pythonSource.match(
    /NODE_CLASS_MAPPINGS\s*=\s*\{([^}]*)\}/s,
  );
  if (dictMatch) {
    const body = dictMatch[1];
    // Match entries like "DisplayName": ClassName or 'DisplayName': ClassName
    const entryPattern = /["']([^"']+)["']\s*:\s*([A-Za-z_]\w*)/g;
    let m: RegExpExecArray | null;
    while ((m = entryPattern.exec(body)) !== null) {
      mappings[m[1]] = m[2];
    }
  }

  // Pattern 2: NODE_CLASS_MAPPINGS["DisplayName"] = ClassName
  const assignPattern =
    /NODE_CLASS_MAPPINGS\[["']([^"']+)["']\]\s*=\s*([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = assignPattern.exec(pythonSource)) !== null) {
    mappings[m[1]] = m[2];
  }

  // Pattern 3: NODE_CLASS_MAPPINGS.update({ ... })
  const updateMatch = pythonSource.match(
    /NODE_CLASS_MAPPINGS\.update\(\s*\{([^}]*)\}\s*\)/s,
  );
  if (updateMatch) {
    const body = updateMatch[1];
    const entryPattern = /["']([^"']+)["']\s*:\s*([A-Za-z_]\w*)/g;
    let m2: RegExpExecArray | null;
    while ((m2 = entryPattern.exec(body)) !== null) {
      mappings[m2[1]] = m2[2];
    }
  }

  return mappings;
}

// ---------------------------------------------------------------------------
// Collect Python files with NODE_CLASS_MAPPINGS from a repo
// ---------------------------------------------------------------------------

async function findNodeMappings(
  owner: string,
  repo: string,
): Promise<Record<string, string>> {
  const allMappings: Record<string, string> = {};

  // List root directory
  const rootEntries = await listGitHubDir(owner, repo);

  // Gather Python files at root level + common sub-directories
  const pyFiles: string[] = [];
  const subDirs: string[] = [];

  for (const entry of rootEntries) {
    if (entry.type === "file" && entry.name.endsWith(".py")) {
      pyFiles.push(entry.path);
    } else if (entry.type === "dir") {
      subDirs.push(entry.path);
    }
  }

  // Check common node directories (first level only to avoid excessive API calls)
  for (const dir of subDirs.slice(0, 10)) {
    try {
      const dirEntries = await listGitHubDir(owner, repo, dir);
      for (const entry of dirEntries) {
        if (entry.type === "file" && entry.name.endsWith(".py")) {
          pyFiles.push(entry.path);
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  // Fetch Python files and parse NODE_CLASS_MAPPINGS (limit to avoid rate limits)
  const filesToCheck = pyFiles.slice(0, 30);
  const fetches = filesToCheck.map(async (path) => {
    try {
      const source = await fetchGitHubFile(owner, repo, path);
      if (source.includes("NODE_CLASS_MAPPINGS")) {
        const parsed = parseNodeClassMappings(source);
        Object.assign(allMappings, parsed);
      }
    } catch {
      // Skip files we can't fetch
    }
  });

  await Promise.all(fetches);
  return allMappings;
}

// ---------------------------------------------------------------------------
// Find example workflows in the repo
// ---------------------------------------------------------------------------

async function findExampleWorkflows(
  owner: string,
  repo: string,
): Promise<SkillExample[]> {
  const examples: SkillExample[] = [];
  const jsonPaths: string[] = [];

  // Check root and common example dirs
  const dirsToCheck = ["", "examples", "workflows", "example_workflows"];

  for (const dir of dirsToCheck) {
    try {
      const entries = await listGitHubDir(owner, repo, dir);
      for (const entry of entries) {
        if (entry.type === "file" && entry.name.endsWith(".json")) {
          jsonPaths.push(entry.path);
        }
      }
    } catch {
      // Directory may not exist
    }
  }

  // Fetch up to 5 example workflows
  for (const path of jsonPaths.slice(0, 5)) {
    try {
      const content = await fetchGitHubFile(owner, repo, path);
      const workflow = JSON.parse(content);
      // Quick heuristic: ComfyUI workflows have nodes with class_type
      const isWorkflow =
        typeof workflow === "object" &&
        workflow !== null &&
        Object.values(workflow).some(
          (v: unknown) =>
            typeof v === "object" &&
            v !== null &&
            "class_type" in (v as Record<string, unknown>),
        );
      if (isWorkflow) {
        const name = path
          .split("/")
          .pop()!
          .replace(/\.json$/, "")
          .replace(/[_-]/g, " ");
        examples.push({
          name,
          description: `Example workflow from ${path}`,
          workflow,
        });
      }
    } catch {
      // Skip unparseable files
    }
  }

  return examples;
}

// ---------------------------------------------------------------------------
// Fetch README for description
// ---------------------------------------------------------------------------

async function fetchReadme(
  owner: string,
  repo: string,
): Promise<string | null> {
  const candidates = ["README.md", "readme.md", "README.rst", "README"];
  for (const name of candidates) {
    try {
      return await fetchGitHubFile(owner, repo, name);
    } catch {
      // Try next
    }
  }
  return null;
}

function extractFirstParagraph(markdown: string): string {
  // Skip leading headings/badges, grab first non-empty text block
  const lines = markdown.split("\n");
  const paragraphLines: string[] = [];
  let started = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!started) {
      // Skip headings, blank lines, badge images, HTML
      if (
        trimmed === "" ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("![") ||
        trimmed.startsWith("<") ||
        trimmed.startsWith("[![")
      ) {
        continue;
      }
      started = true;
    }
    if (started) {
      if (trimmed === "" || trimmed.startsWith("#")) break;
      paragraphLines.push(trimmed);
    }
  }

  return paragraphLines.join(" ").slice(0, 500);
}

// ---------------------------------------------------------------------------
// Match nodes against ComfyUI object_info
// ---------------------------------------------------------------------------

function buildNodeInfo(
  classNameToDisplay: Record<string, string>,
  objectInfo: ObjectInfo,
): SkillNodeInfo[] {
  const nodes: SkillNodeInfo[] = [];

  for (const [displayName, className] of Object.entries(classNameToDisplay)) {
    // object_info is keyed by the internal class name
    const nodeDef: ComfyUINodeDef | undefined = objectInfo[className];

    const inputs: SkillNodeInfo["inputs"] = [];
    const outputs: SkillNodeInfo["outputs"] = [];

    if (nodeDef) {
      // Required inputs
      if (nodeDef.input.required) {
        for (const [name, spec] of Object.entries(nodeDef.input.required)) {
          const type = Array.isArray(spec[0]) ? spec[0].join(" | ") : spec[0];
          const defaultVal = spec[1]?.default;
          inputs.push({ name, type, required: true, default: defaultVal });
        }
      }
      // Optional inputs
      if (nodeDef.input.optional) {
        for (const [name, spec] of Object.entries(nodeDef.input.optional)) {
          const type = Array.isArray(spec[0]) ? spec[0].join(" | ") : spec[0];
          const defaultVal = spec[1]?.default;
          inputs.push({ name, type, required: false, default: defaultVal });
        }
      }
      // Outputs
      for (let i = 0; i < nodeDef.output.length; i++) {
        outputs.push({
          name: nodeDef.output_name[i] || nodeDef.output[i],
          type: nodeDef.output[i],
        });
      }
    }

    nodes.push({
      className,
      displayName: nodeDef?.display_name || displayName,
      category: nodeDef?.category || "unknown",
      inputs,
      outputs,
    });
  }

  // Sort by category then display name for consistent output
  nodes.sort((a, b) =>
    a.category === b.category
      ? a.displayName.localeCompare(b.displayName)
      : a.category.localeCompare(b.category),
  );

  return nodes;
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

export function renderSkillMarkdown(data: SkillData): string {
  const tags = new Set<string>(["comfyui"]);
  for (const node of data.nodes) {
    if (node.category && node.category !== "unknown") {
      // Take the top-level category
      const top = node.category.split("/")[0].trim().toLowerCase();
      if (top) tags.add(top);
    }
  }

  const lines: string[] = [];

  // Frontmatter
  lines.push("---");
  lines.push(`name: ${data.name}`);
  lines.push(`version: ${data.version}`);
  lines.push(`description: ${data.description}`);
  lines.push(`tags: [${[...tags].join(", ")}]`);
  lines.push("---");
  lines.push("");

  // Title
  lines.push(`# ${data.name}`);
  lines.push("");
  if (data.description) {
    lines.push(data.description);
    lines.push("");
  }
  if (data.repository) {
    lines.push(`Repository: ${data.repository}`);
    lines.push("");
  }

  // Nodes
  lines.push("## Nodes");
  lines.push("");

  for (const node of data.nodes) {
    lines.push(`### ${node.displayName}`);
    lines.push(`**Class**: \`${node.className}\``);
    lines.push(`**Category**: ${node.category}`);
    lines.push("");

    if (node.inputs.length > 0) {
      lines.push("**Inputs**:");
      lines.push("| Name | Type | Required | Default |");
      lines.push("|------|------|----------|---------|");
      for (const inp of node.inputs) {
        const def =
          inp.default !== undefined ? String(inp.default) : "";
        lines.push(
          `| ${inp.name} | ${inp.type} | ${inp.required ? "Yes" : "No"} | ${def} |`,
        );
      }
      lines.push("");
    }

    if (node.outputs.length > 0) {
      lines.push("**Outputs**:");
      lines.push("| Name | Type |");
      lines.push("|------|------|");
      for (const out of node.outputs) {
        lines.push(`| ${out.name} | ${out.type} |`);
      }
      lines.push("");
    }
  }

  // Examples
  if (data.examples.length > 0) {
    lines.push("## Usage Examples");
    lines.push("");
    for (const ex of data.examples) {
      lines.push(`### ${ex.name}`);
      lines.push(ex.description);
      lines.push("");
      if (ex.workflow && typeof ex.workflow === "object") {
        const wf = ex.workflow as Record<
          string,
          { class_type?: string }
        >;
        const nodeTypes = [
          ...new Set(
            Object.values(wf)
              .filter((v) => v.class_type)
              .map((v) => v.class_type!),
          ),
        ];
        if (nodeTypes.length > 0) {
          lines.push(`Key nodes used: ${nodeTypes.join(", ")}`);
          lines.push("");
        }
      }
    }
  }

  // Composition Patterns
  lines.push("## Composition Patterns");
  lines.push("");
  lines.push(
    "- To use with LoRA: Insert LoraLoader between CheckpointLoader and the first node that uses MODEL/CLIP",
  );
  lines.push(
    "- To chain with ControlNet: Add ControlNetLoader and ControlNetApply before the sampler",
  );
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function generateSkill(source: string): Promise<string> {
  logger.info("Generating skill", { source });

  // Step 1: Resolve repository URL
  let repoUrl: string;
  if (source.includes("github.com")) {
    repoUrl = source;
  } else {
    // Assume it's a registry ID
    logger.info("Looking up registry ID", { registryId: source });
    repoUrl = await resolveRegistryRepo(source);
  }

  const { owner, repo } = parseGitHubUrl(repoUrl);
  logger.info("Resolved repository", { owner, repo });

  // Step 2: Fetch README for description
  const readme = await fetchReadme(owner, repo);
  const description = readme
    ? extractFirstParagraph(readme)
    : "ComfyUI custom node pack";

  // Step 3: Find NODE_CLASS_MAPPINGS in Python files
  const classNameToDisplay = await findNodeMappings(owner, repo);
  const nodeCount = Object.keys(classNameToDisplay).length;
  logger.info("Found node class mappings", { count: nodeCount });

  if (nodeCount === 0) {
    logger.warn("No NODE_CLASS_MAPPINGS found in repository");
  }

  // Step 4: Match against ComfyUI object_info (best-effort)
  let objectInfo: ObjectInfo = {};
  try {
    objectInfo = await getObjectInfo();
  } catch (err) {
    logger.warn("Could not fetch object_info from ComfyUI (server may be offline)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const nodes = buildNodeInfo(classNameToDisplay, objectInfo);

  // Step 5: Find example workflows
  const examples = await findExampleWorkflows(owner, repo);
  logger.info("Found example workflows", { count: examples.length });

  // Step 6: Render SKILL.md
  const data: SkillData = {
    name: repo,
    version: "1.0.0",
    description,
    repository: repoUrl,
    nodes,
    examples,
  };

  return renderSkillMarkdown(data);
}
