import { z } from "zod";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parse as parseYaml } from "yaml";
import { errorToToolResult, ValidationError } from "../utils/errors.js";
import { getComfyUIBaseUrl } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { checkWorkflowRuntime, extractWorkflowClassTypes } from "../services/api-nodes.js";
import {
  extractWorkflowDependencies,
  installWorkflowDependencies,
  defaultWorkflowDepsDeps,
} from "../services/workflow-deps.js";
import { generateSkillCached } from "../services/skill-cache.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { templateIndexScopeNote } from "../services/template-index-scope.js";
import {
  bodyPrefixOf,
  classifyNonJson,
  isNonJsonResponseError,
  looksLikeHtmlParsedAsJson,
  readComfyJson,
  redactErrorMessage,
} from "../comfyui/json-guard.js";

// Optional, opt-in observability hook for the knowledge-parity smoke test: when
// COMFYUI_MCP_TOOL_TRACE points at a file, the knowledge tool appends a JSONL
// record of its invocation. No-op in normal operation (env unset). This is the
// only way an out-of-process harness can prove the agent actually CALLED
// list_packs (action:"skill_list"/"skill_read"/"read_workflow") on the headless
// comfyui stdio MCP, since those calls don't traverse the panel bridge.
//
// The record's `tool` is the LIVE tool name and the action rides in `args`, so a
// consumer (scripts/codex-knowledge-parity-smoke.mjs) reads exactly what was
// invoked. Only the six actions whose pre-0.50.0 tools traced are traced — adding
// the other three would change what the harness observes, which is behaviour, not
// surface.
function traceToolCall(tool: string, args: Record<string, unknown>): void {
  const path = process.env.COMFYUI_MCP_TOOL_TRACE;
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify({ tool, args, ts: Date.now() })}\n`);
  } catch {
    // tracing is best-effort and must never affect the tool's result
  }
}

/** Unchanged from the two dependency tools 0.50.0 slice 9 retired (see
 *  DEAD_NAMES): their shared input coercion, moved here with the actions
 *  action:"extract_deps" / action:"install_deps" that use it. */
function parseWorkflow(input: unknown): WorkflowJSON {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ValidationError("Workflow JSON must be an object with node IDs as keys");
      }
      return parsed as WorkflowJSON;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(`Invalid JSON string: ${(err as Error).message}`);
    }
  }
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as WorkflowJSON;
  }
  throw new ValidationError("Workflow must be a JSON string or object");
}

// SKILL ACCESS — Codex↔Claude knowledge parity for the panel agent.
//
// Claude loads ALL plugin skills natively (the panel orchestrator passes
// plugins:[{type:"local",path:pluginPath}], skills:"all"), so it knows the
// per-family expertise (e.g. krea2-txt2img) and the installer-packs system out of
// the box. Codex has NO skill mechanism. The `list_packs` tool exposes the SAME
// bundled knowledge through the comfyui MCP that BOTH backends (and any MCP
// client) share, so Codex can discover and read a model family's skill on demand
// and prefer a ready pack over hand-building a generic graph from scratch.
//
// Resolution mirrors the orchestrator's plugin lookup (src/orchestrator/index.ts
// ~L246: "the bundled plugin (skills) ships alongside dist/ in the package root").
// This file compiles to dist/tools/skills-access.js, so the package root is two
// levels up.

/** Package root — dist/tools/skills-access.js → ../../  (the package root that
 *  ships both plugin/skills and packs/). */
function packageRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

function skillsDir(): string {
  return join(packageRoot(), "plugin", "skills");
}

function packsDir(): string {
  return join(packageRoot(), "packs");
}

/** A safe single path segment: a skill / pack directory name with no traversal,
 *  separators, or oddities. Both name-taking actions validate the caller-supplied
 *  name against this AND against an actually-existing directory before reading. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Split a SKILL.md (or any frontmatter doc) into { frontmatter, body }. The
 *  frontmatter is the YAML block between the leading `---` fences; the body is
 *  everything after. Tolerant of a missing/garbled block (returns {} + full text). */
function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  // Normalize BOM + CRLF so the fence match is reliable cross-platform.
  const norm = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(norm);
  if (!m) return { frontmatter: {}, body: norm };
  let fm: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(m[1]);
    if (parsed && typeof parsed === "object") fm = parsed as Record<string, unknown>;
  } catch {
    // malformed frontmatter — fall back to no metadata, keep the body
  }
  return { frontmatter: fm, body: norm.slice(m[0].length) };
}

/** Read a skill's SKILL.md, returning null when the dir/file is missing. */
function readSkillFile(name: string): string | null {
  const file = join(skillsDir(), name, "SKILL.md");
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Enumerate bundled skills as { name, description }. Tolerant of a missing
 *  plugin dir (returns []) and of skills with no/garbled frontmatter. */
function enumerateSkills(): Array<{ name: string; description: string }> {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  const out: Array<{ name: string; description: string }> = [];
  for (const entry of readdirSync(dir)) {
    if (!SAFE_NAME.test(entry)) continue;
    let isDir = false;
    try {
      isDir = statSync(join(dir, entry)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const text = readSkillFile(entry);
    if (text == null) continue; // no SKILL.md → not a skill
    const { frontmatter } = splitFrontmatter(text);
    const name = typeof frontmatter.name === "string" ? frontmatter.name : entry;
    const description =
      typeof frontmatter.description === "string" ? frontmatter.description : "";
    out.push({ name, description });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Enumerate installer packs as { name, family, kind, description, workflow,
 *  has_workflow, has_manifest }. Reads each packs/<name>/pack.yaml. */
export function enumeratePacks(): Array<Record<string, unknown>> {
  const dir = packsDir();
  if (!existsSync(dir)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of readdirSync(dir)) {
    if (!SAFE_NAME.test(entry)) continue;
    const packDir = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(packDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const metaFile = join(packDir, "pack.yaml");
    if (!existsSync(metaFile)) continue; // not a pack
    let meta: Record<string, unknown> = {};
    try {
      const parsed = parseYaml(readFileSync(metaFile, "utf8"));
      if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
    } catch {
      // malformed pack.yaml — still report the pack with just its dir name
    }
    const workflowName = typeof meta.workflow === "string" ? meta.workflow : "workflow.json";
    out.push({
      name: entry,
      family: meta.family ?? null,
      kind: meta.kind ?? null,
      display_name: meta.display_name ?? null,
      description: typeof meta.description === "string" ? meta.description.trim() : "",
      vram: meta.vram ?? null,
      skill: meta.skill ?? null,
      // Installer packs run on the user's OWN GPU (free) — none ship API-node
      // graphs. pack.yaml may override with an explicit `runtime`, but the
      // default is local/free. (Use action:"check_runtime" to verify a graph.)
      runtime: typeof meta.runtime === "string" ? meta.runtime : "local",
      has_workflow: existsSync(join(packDir, workflowName)),
      has_manifest: existsSync(join(packDir, "manifest.yaml")),
      manifest_path: existsSync(join(packDir, "manifest.yaml"))
        ? join(packDir, "manifest.yaml")
        : null,
    });
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

/** Locate a pack's workflow.json file path (name-guarded, must exist). Returns
 *  null when the pack or its workflow is missing. Shared by action:"read_workflow"
 *  and action:"check_runtime" so they resolve the file identically. Also
 *  exported for enqueue_workflow (action:"run_template"), which resolves
 *  templates the same way. */
export function resolvePackWorkflowFile(packName: string): string | null {
  const name = packName.trim();
  if (!SAFE_NAME.test(name)) return null;
  const packDir = join(packsDir(), name);
  if (!packDir.startsWith(packsDir()) || !existsSync(packDir) || !statSync(packDir).isDirectory()) {
    return null;
  }
  let workflowName = "workflow.json";
  const metaFile = join(packDir, "pack.yaml");
  if (existsSync(metaFile)) {
    try {
      const meta = parseYaml(readFileSync(metaFile, "utf8")) as Record<string, unknown>;
      if (meta && typeof meta.workflow === "string") workflowName = meta.workflow;
    } catch {
      // keep default
    }
  }
  if (!SAFE_NAME.test(workflowName) && workflowName !== "workflow.json") {
    workflowName = "workflow.json";
  }
  const wfFile = join(packDir, workflowName);
  if (!wfFile.startsWith(packDir) || !existsSync(wfFile)) return null;
  return wfFile;
}

/**
 * The nine knowledge tools collapsed into one action-parameterized `list_packs`
 * tool (0.50.0 surface consolidation, slice 9) — bundled skills, installer packs,
 * the connected server's workflow templates, and the two workflow-readiness
 * checks (paid-API-node classification, custom-node dependency resolve/install).
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required — `name` is required for
 * read_workflow/skill_read and meaningless elsewhere, `workflow` is required for
 * extract_deps/install_deps, `source` for generate_skill. Every VALUE constraint
 * the old tools had is unchanged at the zod layer (`name` keeps its `.min(1)`);
 * the handler enforces per-action presence and names the missing field — the one
 * deliberate behavioural difference a flat enum permits. Each branch calls the
 * same function the old tool called, with the same arguments, and returns the
 * identical content block (including generate_skill's `structuredContent`).
 *
 * MUTATION — TWO actions can change the user's machine, and neither may be a
 * surprise under a tool whose name reads like a listing:
 *
 *   action:"install_deps" INSTALLS custom-node packs through ComfyUI-Manager on
 *   the connected server, which downloads and RUNS third-party code. It is the
 *   only action that installs anything, and the switch below is the only route
 *   to that service.
 *
 *   action:"generate_skill" WRITES TO DISK on every cache MISS — the generated
 *   SKILL.md is persisted into its read-through cache under the user's home
 *   (~/.comfyui-mcp/skill-cache, or COMFYUI_SKILL_CACHE_DIR) — and, when the
 *   caller passes `install_in`, ALSO creates that directory recursively and
 *   overwrites any SKILL.md in it. Both writes are exactly what its retired
 *   standalone tool did. "Read-only unless install_in" would be an overclaim:
 *   the cache write is unconditional on a miss and lands in configurable
 *   user-home state.
 *
 * The other seven actions read. Both mutations are stated in their own
 * description bullets, because a read-only-looking tool that quietly installs or
 * overwrites is a wrong-expectation defect — and so is a safety note that
 * undercounts them.
 */
export function registerSkillsAccessTools(server: McpServer): void {
  server.tool(
    "list_packs",
    "Bundled ComfyUI knowledge — installer packs, model-family skills, workflow templates — plus the two workflow-readiness checks. Driven by the `action` parameter:\n" +
      '- action:"list" — List the bundled installer packs under packs/: one-command setups for a model family (custom nodes + model weights via manifest.yaml) PLUS a ready workflow.json graph. Each entry reports its family/kind, its runtime (these packs are LOCAL-GPU / FREE — they run on the user\'s own GPU and never spend paid API credits), whether it has a ready workflow + manifest, and the manifest path for install_comfyui apply_manifest. When asked to "set up / build a <model-family> workflow", PREFER applying the matching pack and loading its ready workflow (panel_load_workflow pack:<name>) over building a generic graph from scratch. Read the ready graph with action:"read_workflow".\n' +
      '- action:"read_workflow" — Return a bundled pack\'s ready workflow.json graph by pack name (`name`; discover names + which packs have a workflow with action:"list"). This is the EXPERT graph for that model family — use it as the source of truth when setting up the family on the user\'s canvas: recreate it node-by-node with the panel_* tools (panel_add_node / panel_connect / panel_set_widget) so it lands on their live canvas, or enqueue it headlessly. Prefer this over inventing a graph from scratch. Names are validated (no path traversal) and must match an existing pack directory.\n' +
      '- action:"list_templates" — List CUSTOM-NODE-contributed ComfyUI workflow templates on the connected ComfyUI, grouped by source (each pack\'s own example_workflows/*.json). Hits the live server\'s /api/workflow_templates index. SCOPE LIMIT: this endpoint does NOT include ComfyUI\'s own core bundled templates from the comfyui-workflow-templates package (e.g. "Flux.1 Inpaint") — those are served to the frontend as static assets via a separate code path this action cannot see, so a small/empty result here does NOT mean no official template exists, only that no custom-node pack contributed one. When asked to "set up / build a <model-family> workflow", check here for a custom-node-contributed starter AFTER checking the bundled skills + installer packs (action:"skill_list" / action:"list"), and also tell the user to check the ComfyUI frontend\'s own Templates browser directly for core templates, since this action cannot enumerate those. NOTE: this lists what\'s available; loading a template onto the canvas is done in the ComfyUI frontend\'s Templates browser (the panel agent cannot load a template graph headlessly yet) — surface the matching template name to the user.\n' +
      '- action:"check_runtime" — Determine whether a workflow runs on the user\'s OWN GPU (LOCAL — free) or uses hosted API NODES (PAID api credits). Pass `pack` (a bundled pack name — always local/free) OR `graph` (a UI or API/prompt workflow JSON, as object or string). It scans the workflow\'s node class_types against the connected ComfyUI\'s API-node set (the same signal list_api_nodes uses) and returns { runtime: \'local\'|\'api\'|\'mixed\'|\'unknown\', usesApiNodes, apiNodes[], externalApiNodes[], unknownNodes[] } — \'unknown\' means some nodes couldn\'t be classified (could be paid), so treat it (and \'api\'/\'mixed\') as POSSIBLY PAID; only \'local\' is confirmed free. `externalApiNodes` is the THIRD-PARTY paid kind (a fal.ai-style pack, or any node taking a service credential): those are INSTALLED LOCALLY yet still cost money, billed by that provider on the user\'s own account with them rather than out of Comfy api credits — so when you ask the user, name the provider, not "Comfy credits" (`externalProviders` names it when recognised — e.g. ["fal.ai"]; it is absent when the node was flagged only by taking a service credential, which proves it authenticates somewhere but not to whom). ALWAYS call this before building OR loading a non-pack/ad-hoc workflow so you can ASK the user before spending paid API credits — never silently use API nodes.\n' +
      '- action:"extract_deps" — Analyze a ComfyUI workflow (`workflow`, API JSON) and determine which custom node packs it requires. Maps each node class_type to its owning node pack using ComfyUI-Manager mappings and the server\'s installed node definitions, reporting which packs are installed vs missing. READ-ONLY — it installs nothing. Works remotely (HTTP only) — mirrors `comfy-cli node deps-in-workflow`.\n' +
      '- action:"install_deps" — MUTATING: this is the ONE action on this tool that INSTALLS anything. Resolve and INSTALL the custom node packs a ComfyUI workflow (`workflow`) requires, via ComfyUI-Manager: it determines the missing packs, resets the Manager queue, QUEUES THE INSTALLS, starts the worker, and reports what was installed/already-present/unresolved. Installing a pack downloads and runs third-party code (and may pull large files) on the connected ComfyUI host — local OR remote --comfyui-url — and a ComfyUI restart is typically needed before new nodes load. Use action:"extract_deps" first if you only want to SEE what is missing. Mirrors `comfy-cli node install-deps`.\n' +
      '- action:"skill_list" — List the bundled ComfyUI model-family + workflow skills shipped with comfyui-mcp (name + description for each). These encode per-family expertise (e.g. krea2-txt2img: native krea2 CLIPLoader, Qwen3-VL encoder, 8-step turbo settings) and the installer-packs system. Call this BEFORE hand-building a <model-family> workflow from scratch — if a matching skill exists, read its full guidance with action:"skill_read" and prefer a ready installer pack (action:"list") over a generic graph. Claude loads these natively; this action gives the SAME knowledge to any MCP client (e.g. the Codex backend).\n' +
      '- action:"skill_read" — Return the full body of a bundled skill\'s SKILL.md by name (`name`; discover names with action:"skill_list"). Gives you the family\'s complete expertise on demand — model slots, node graph, recommended settings, and gotchas — so you can build the right workflow instead of guessing. Names are validated (no path traversal) and must match an existing skill directory.\n' +
      '- action:"generate_skill" — MUTATING: it WRITES to the read-through skill cache on every cache miss, and when `install_in` is set it ALSO creates that directory and overwrites any SKILL.md in it. Generate a Claude skill (SKILL.md) documenting a ComfyUI custom node pack: its nodes, inputs/outputs, and example workflows. `source` accepts a ComfyUI Registry ID (resolved via api.comfy.org) or a GitHub repository URL. Uses a read-through cache under ~/.comfyui-mcp/skill-cache (override COMFYUI_SKILL_CACHE_DIR); set refresh:true to bypass it. On cache miss, fetches the repo README and scans its Python NODE_CLASS_MAPPINGS and example workflows over the network (uses GITHUB_TOKEN if set to avoid rate limits), so internet access is required. If a ComfyUI server is reachable it enriches node input/output types from /object_info, but the server is optional. Returns the SKILL.md markdown with structured cache metadata; if install_in is set, also creates that directory (recursively) and writes SKILL.md there, overwriting any existing file.',
    {
      action: z
        .enum([
          "list",
          "read_workflow",
          "list_templates",
          "check_runtime",
          "extract_deps",
          "install_deps",
          "skill_list",
          "skill_read",
          "generate_skill",
        ])
        .describe(
          'Which knowledge operation to perform. "list", "list_templates" and "skill_list" take no other parameters; "read_workflow" and "skill_read" require `name`; "check_runtime" takes `pack` OR `graph`; "extract_deps" and "install_deps" require `workflow` (and "install_deps" INSTALLS custom nodes — the only action here that installs, though "generate_skill" also WRITES to disk: its skill cache on every miss, plus `install_in` when set); "generate_skill" requires `source` (optional `install_in`/`refresh`).',
        ),
      name: z
        .string()
        .min(1)
        .optional()
        .describe(
          'REQUIRED for action:"read_workflow" — the pack name (a directory under packs/, e.g. \'krea2-txt2img-manual\'), from action:"list". REQUIRED for action:"skill_read" — the skill name (a directory under plugin/skills/, e.g. \'krea2-txt2img\'), from action:"skill_list".',
        ),
      pack: z
        .string()
        .optional()
        .describe(
          'action:"check_runtime" — a bundled pack name (from action:"list"). Packs are local/free; this confirms it from the actual graph.',
        ),
      graph: z
        .union([z.string(), z.record(z.string(), z.unknown())])
        .optional()
        .describe(
          'action:"check_runtime" — a workflow graph to classify (UI or API/prompt format), as an object or a JSON string. Use this for ad-hoc/generated workflows.',
        ),
      workflow: z
        .union([z.string(), z.record(z.string(), z.any())])
        .optional()
        .describe(
          'REQUIRED for action:"extract_deps" and action:"install_deps" — a ComfyUI workflow in API format (JSON string or object).',
        ),
      source: z
        .string()
        .optional()
        .describe(
          'REQUIRED for action:"generate_skill" — a ComfyUI Registry node ID (e.g. \'comfyui-impact-pack\') or a GitHub repository URL.',
        ),
      install_in: z
        .string()
        .optional()
        .describe(
          'action:"generate_skill" — optional directory to write the generated SKILL.md into. Created recursively if missing; an existing SKILL.md is overwritten. Omit to only return the markdown without touching disk.',
        ),
      refresh: z
        .boolean()
        .optional()
        .describe(
          'action:"generate_skill" — bypass the read-through cache and rebuild the SKILL.md, overwriting the cached entry.',
        ),
    },
    async (args) => {
      try {
        // `name`, `workflow` and `source` cannot be schema-required in a flat
        // shape, so the handler enforces per-action presence and names the
        // missing field — the same information the old per-tool schemas gave.
        //
        // ABSENCE only, never falsiness: `source: ""` passed z.string() before
        // this consolidation and reached generateSkillCached, and `workflow: ""`
        // passed the union and reached parseWorkflow, each answering with its own
        // validation error. A `!x` guard would swallow those paths and substitute
        // generic text. (`name` keeps its `.min(1)`, so an empty string is still
        // rejected by zod exactly as before — the guard only covers absence.)
        const requireName = (action: string, what: string): string => {
          if (args.name === undefined) {
            throw new Error(`list_packs action:"${action}" requires \`name\` — ${what}.`);
          }
          return args.name;
        };
        const requireWorkflow = (action: string): string | Record<string, unknown> => {
          if (args.workflow === undefined) {
            throw new Error(
              `list_packs action:"${action}" requires \`workflow\` — a ComfyUI workflow in API format (JSON string or object).`,
            );
          }
          return args.workflow;
        };

        switch (args.action) {
          case "list":
            return listPacksAction();
          case "read_workflow":
            return readPackWorkflowAction(
              requireName("read_workflow", "the pack whose ready workflow.json to read"),
            );
          case "list_templates":
            return await listWorkflowTemplatesAction();
          case "check_runtime":
            return await checkRuntimeAction({ pack: args.pack, graph: args.graph });
          case "extract_deps":
            return await extractDepsAction(requireWorkflow("extract_deps"));
          case "install_deps":
            // THE ONLY MUTATING BRANCH. Nothing above or below reaches
            // installWorkflowDependencies, so no read action can install.
            return await installDepsAction(requireWorkflow("install_deps"));
          case "skill_list":
            return listSkillsAction();
          case "skill_read":
            return readSkillAction(requireName("skill_read", "the bundled skill to read"));
          case "generate_skill": {
            if (args.source === undefined) {
              throw new Error(
                'list_packs action:"generate_skill" requires `source` — a ComfyUI Registry node ID or a GitHub repository URL.',
              );
            }
            return await generateSkillAction({
              source: args.source,
              install_in: args.install_in,
              refresh: args.refresh,
            });
          }
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown list_packs action "${String(exhaustive)}". Expected one of: list, read_workflow, list_templates, check_runtime, extract_deps, install_deps, skill_list, skill_read, generate_skill.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}

// ── Per-action implementations ──────────────────────────────────────────────
// One function per folded action, body-for-body what that action's former
// standalone tool did, so the fold is reviewable as a move rather than a
// rewrite. Errors thrown here are caught by the single try/catch above, which is
// where each old tool's own errorToToolResult sat. (Which retired name each
// action replaces is recorded once, in DEAD_NAMES — not repeated here, where the
// dead-name gate correctly refuses to see a retired name in live source.)

type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** action:"list" */
function listPacksAction(): ToolText {
  traceToolCall("list_packs", { action: "list" });
  const packs = enumeratePacks();
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            count: packs.length,
            note: "All bundled installer packs are LOCAL-GPU / FREE (no API nodes, no paid credits). Loading or running a pack workflow runs entirely on the user's GPU.",
            packs,
          },
          null,
          2,
        ),
      },
    ],
  };
}

/** action:"read_workflow" */
function readPackWorkflowAction(rawName: string): ToolText {
  traceToolCall("list_packs", { action: "read_workflow", name: rawName });
  const name = rawName.trim();
  if (!SAFE_NAME.test(name)) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Invalid pack name "${rawName}". Use a plain pack directory name from list_packs (action:"list").`,
        },
      ],
    };
  }
  const packDir = join(packsDir(), name);
  if (!packDir.startsWith(packsDir()) || !existsSync(packDir) || !statSync(packDir).isDirectory()) {
    const known = enumeratePacks().map((p) => p.name);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `No pack named "${name}". Available packs: ${known.join(", ") || "(none bundled)"}.`,
        },
      ],
    };
  }
  // Resolve the workflow filename from pack.yaml (default workflow.json).
  let workflowName = "workflow.json";
  const metaFile = join(packDir, "pack.yaml");
  if (existsSync(metaFile)) {
    try {
      const meta = parseYaml(readFileSync(metaFile, "utf8")) as Record<string, unknown>;
      if (meta && typeof meta.workflow === "string") workflowName = meta.workflow;
    } catch {
      // keep default
    }
  }
  if (!SAFE_NAME.test(workflowName) && workflowName !== "workflow.json") {
    // pack.yaml controls this, but stay defensive against odd values.
    workflowName = "workflow.json";
  }
  const wfFile = join(packDir, workflowName);
  if (!wfFile.startsWith(packDir) || !existsSync(wfFile)) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Pack "${name}" has no ready workflow (${workflowName} not found).`,
        },
      ],
    };
  }
  const text = readFileSync(wfFile, "utf8");
  return { content: [{ type: "text" as const, text }] };
}

/** action:"list_templates" */
async function listWorkflowTemplatesAction(): Promise<ToolText> {
  traceToolCall("list_packs", { action: "list_templates" });
  // Canonical base URL + auth headers — same connected-ComfyUI path
  // enqueue_workflow (action:"template_schema") uses, so a proxied/authed
  // remote resolves
  // consistently between listing and schema lookup.
  const base = getComfyUIBaseUrl();
  const url = `${base}/api/workflow_templates`;
  // #954: a bare `fetch` here rejected with the opaque `TypeError: fetch failed`
  // and the reader had no way to see WHICH target was tried — the reported
  // symptom, from a session where the panel bridge was connected and this
  // headless address was not. comfyuiFetch names the target on a network throw,
  // and it is the same auth path every other ComfyUI call uses.
  const res = await comfyuiFetch(url, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    // A NON-2xx may still be an HTML proxy/login page — say which, instead
    // of blaming a possibly-fine ComfyUI version (#828).
    const contentType = res.headers.get("content-type") ?? "";
    // unknown-ok: "" is interpolated into an ERROR MESSAGE and nothing else — the
    // HTTP status is reported either way, so an unreadable body costs detail in the
    // text, never a wrong conclusion. Verified there is no branch on this value.
    const body = await res.text().catch(() => "");
    let parsedOk = false;
    try {
      JSON.parse(body);
      parsedOk = true;
    } catch {
      parsedOk = false;
    }
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: parsedOk
            ? // Do NOT attribute the status to ComfyUI: a JSON error body
              // can just as easily be a gateway's own envelope that never
              // reached it (#828). Offer both readings, assert neither.
              // The body goes through the same credential redaction as the
              // non-JSON path — a gateway that reflects the request could
              // otherwise echo our ComfyUI token into this tool result.
              `The request to ${url} returned ${res.status} with this JSON body: ${bodyPrefixOf(body)}. ` +
              `If that is a ComfyUI error, the server may predate the workflow-templates endpoint; if it is a gateway's own error envelope, the request never reached ComfyUI.`
            : classifyNonJson({ url, status: res.status, contentType, body }).message,
        },
      ],
    };
  }
  // A 200 whose body is an HTML document is the #828 case: the frontend's
  // catch-all (or a proxy) answered a route it never forwarded to the API.
  // readComfyJson names that instead of throwing "Unexpected token '<'".
  const index = await readComfyJson<Record<string, unknown>>(res, {
    url,
    expectShape: (v) => !!v && typeof v === "object" && !Array.isArray(v),
    shapeHint: "the /api/workflow_templates index (an object keyed by source)",
  });
  const groups = Object.keys(index);
  const total = Object.values(index).reduce<number>(
    (n, v) => n + (Array.isArray(v) ? v.length : 0),
    0,
  );
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            source_count: groups.length,
            template_count: total,
            // #1454 — the counts above describe what the SERVER registers, not what is
            // installed. Said on every listing, not only an empty one: the reporter's
            // had 4 sources and 53 templates, and the pack they wanted was still absent.
            index_scope: templateIndexScopeNote(),
            templates: index,
          },
          null,
          2,
        ),
      },
    ],
  };
}

/** action:"check_runtime" */
async function checkRuntimeAction(args: {
  pack?: string;
  graph?: string | Record<string, unknown>;
}): Promise<ToolText> {
  traceToolCall("list_packs", { action: "check_runtime", pack: args.pack });
  let graph: unknown;
  let bundledLocalPack = false;
  // NOT a per-action requiredness guard: `pack` and `graph` were BOTH optional in
  // the retired runtime-check tool's own schema, and it answered its own
  // "provide either" error. This branch — truthiness on `pack`, `!= null` on
  // `graph` — is that tool's pre-existing behaviour, carried over verbatim.
  // Rewriting it as absence-checks would move `pack: ""` from the graph branch to
  // the pack branch, which is a behaviour change, not a surface change.
  if (args.pack) {
    const wfFile = resolvePackWorkflowFile(args.pack);
    if (!wfFile) {
      const known = enumeratePacks().map((p) => p.name);
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `No pack named "${args.pack}" with a ready workflow. Available packs: ${known.join(", ") || "(none bundled)"}.`,
          },
        ],
      };
    }
    graph = JSON.parse(readFileSync(wfFile, "utf8"));
    // Bundled packs are guaranteed local/free (action:"list" contract). Trust
    // that so an uninstalled custom node doesn't read back as "unknown" and
    // wrongly demand a paid-credits confirmation (#464).
    bundledLocalPack = true;
  } else if (args.graph != null) {
    graph = typeof args.graph === "string" ? JSON.parse(args.graph) : args.graph;
  } else {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: "Provide either `pack` (a bundled pack name) or `graph` (a workflow JSON).",
        },
      ],
    };
  }

  // Cheap, server-independent class_type extraction first — so we always
  // return SOMETHING useful even if the live /object_info is unreachable.
  const classTypes = extractWorkflowClassTypes(graph);
  try {
    const runtime = await checkWorkflowRuntime(graph, undefined, { bundledLocalPack });
    // NAME THE PROVIDER (codex P2). "billed by that provider" is unactionable — the reader
    // cannot check a balance they cannot name, and a user who goes looking at their Comfy
    // credits, finds them untouched, and concludes the warning was wrong is exactly the
    // failure this whole verdict exists to prevent. When only the credential signal fired
    // we genuinely do not know WHO bills, and it says that instead of inventing a name.
    const billedBy = runtime.externalProviders?.length
      ? runtime.externalProviders.join(" / ")
      : "the service it authenticates to";
    const guidance =
      runtime.runtime === "local"
        ? "Local-GPU / free — every node runs on the user's own GPU, no paid credits."
        : runtime.runtime === "unknown"
          ? "UNKNOWN — some nodes aren't in this server's /object_info (uninstalled custom nodes, or possibly hosted API/partner nodes). Cannot confirm it's free. Treat as POSSIBLY PAID: ASK the user (free local GPU vs paid api credits) before building or loading it; prefer a local pack."
          : // #1483 — NAME WHICH KIND OF PAID NODE WAS FOUND. A third-party service node
            // (fal.ai and friends) is billed by that vendor on their own account, not out
            // of Comfy api credits, so telling the reader to weigh "paid api credits" sends
            // them to check the wrong balance — and a reader who finds their Comfy credits
            // untouched may conclude the warning was wrong and proceed.
            (runtime.externalApiNodes?.length
              ? runtime.apiNodes.length
                ? `This workflow uses BOTH hosted Comfy API nodes (PAID api credits) and third-party service nodes billed by ${billedBy}: ${runtime.externalApiNodes.join(", ")}. `
                : `This workflow calls a PAID THIRD-PARTY SERVICE — ${runtime.externalApiNodes.join(", ")} — billed by ${billedBy} on the user's own account with them (NOT Comfy api credits), so it is NOT free even though every node is installed locally. `
              : "This workflow uses hosted API nodes that consume PAID api credits. ") +
            "ASK the user (free local GPU vs paid credits) BEFORE building or loading it; prefer a local pack unless they opt in.";
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ...runtime, guidance }, null, 2),
        },
      ],
    };
  } catch (probeErr) {
    // The classification failed. We can't authoritatively classify, but we
    // still surface the node list so the agent can reason — AND we must not
    // misattribute the cause. A server that answered with an HTML page was
    // REACHED; calling that "could not reach the server" (#828) sends the
    // user to check that ComfyUI is running when the real problem is a
    // proxy or a sign-in gate in front of it.
    // A diagnosed non-JSON response is the clearest case. But a RAW
    // markup-parse failure also proves the server answered with something
    // that is not JSON, even when the follow-up probe was inconclusive —
    // filing that under "unavailable" loses the #828 diagnosis and sends
    // the user to check that ComfyUI is running (codex gate, round 6).
    // The message is redacted either way: it quotes the body it choked on.
    const diagnosed = isNonJsonResponseError(probeErr);
    const nonJson = diagnosed || looksLikeHtmlParsedAsJson(probeErr);
    const detail = redactErrorMessage(probeErr);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              runtime: "unknown",
              usesApiNodes: null,
              classTypes,
              reason: nonJson ? "non_json_response" : "object_info_unavailable",
              note: nonJson
                ? `Could not classify the nodes: the ComfyUI server was reached but /object_info did not return JSON. ${detail}${diagnosed ? "" : " (The response could not be re-probed, so what answered is not identified.)"} Until that is fixed the runtime is genuinely UNDETERMINED — treat this workflow as POSSIBLY paid and ask the user before spending credits.`
                : `Could not classify the nodes: /object_info was unavailable (${detail}). API-node detection needs a reachable ComfyUI. If unsure, treat ad-hoc workflows as POSSIBLY paid and ask the user before spending credits.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }
}

/** action:"extract_deps" (READ-ONLY) */
async function extractDepsAction(input: string | Record<string, unknown>): Promise<ToolText> {
  const workflow = parseWorkflow(input);
  const result = await extractWorkflowDependencies(workflow, defaultWorkflowDepsDeps());

  const lines: string[] = [];
  lines.push(`## Workflow dependencies (${result.classTypes.length} node type(s))`, "");

  if (result.requiredPacks.length === 0) {
    lines.push("All node types are core/built-in ComfyUI nodes. No custom node packs required.");
  } else {
    lines.push(`### Required custom node packs (${result.requiredPacks.length})`);
    for (const pack of result.requiredPacks) {
      const missing = result.missingPacks.includes(pack);
      lines.push(`- ${pack}${missing ? "  — **NOT INSTALLED**" : "  — installed"}`);
    }
    lines.push("");
  }

  if (result.missingPacks.length > 0) {
    lines.push(
      `### Missing packs (${result.missingPacks.length})`,
      ...result.missingPacks.map((p) => `- ${p}`),
      "",
      'Run `list_packs (action:"install_deps")` to install them on the connected ComfyUI via ComfyUI-Manager.',
      "",
    );
  }

  if (result.unresolved.length > 0) {
    // #1136 — extract_deps has its OWN signal: it never calls fetchManagerList,
    // so catalogue_unavailable is not its fact. Its `unresolved` comes from the
    // MAPPINGS endpoint, whose failure was previously caught, logged at warn and
    // discarded -- we held the exception and asserted absence anyway.
    if (result.mappings_unavailable) lines.push(result.mappings_unavailable, "");
    // panel#890 — rendered at every site the stronger caveats are, or `unresolved`
    // still reads as "does not exist" wherever this one was forgotten.
    if (result.catalogue_currency_unverified)
      lines.push(result.catalogue_currency_unverified, "");
    lines.push(
      `### Unresolved node types (${result.unresolved.length})`,
      "These class_types are neither installed nor known to ComfyUI-Manager:",
      ...result.unresolved.map((c) => `- ${c}`),
      "",
    );
  }

  lines.push("### Per-node mapping");
  for (const dep of result.dependencies) {
    const where = dep.builtin
      ? "built-in"
      : dep.pack
        ? `${dep.pack} (${dep.installed ? "installed" : "missing"})`
        : dep.installed
          ? "installed, pack unknown"
          : "UNRESOLVED";
    lines.push(`- \`${dep.class_type}\` → ${where}`);
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

/** action:"install_deps" — THE ONLY MUTATING ACTION on this tool. */
async function installDepsAction(input: string | Record<string, unknown>): Promise<ToolText> {
  const workflow = parseWorkflow(input);
  const result = await installWorkflowDependencies(workflow, defaultWorkflowDepsDeps());

  const lines: string[] = [];
  if (result.installed.length > 0) {
    lines.push(
      `## Queued ${result.installed.length} node pack(s) for install`,
      ...result.installed.map((p) => `- ${p}`),
      "",
      "ComfyUI-Manager is processing the install queue. A ComfyUI restart is typically " +
        "required before the new nodes become available.",
      "",
    );
  } else {
    lines.push("## No packs needed installation", "");
  }

  if (result.alreadyInstalled.length > 0) {
    lines.push(
      `### Already installed (${result.alreadyInstalled.length})`,
      ...result.alreadyInstalled.map((p) => `- ${p}`),
      "",
    );
  }

  if (result.unresolved.length > 0) {
    // #1136 — say it BEFORE the list. A reader who has already read
    // "not found in ComfyUI-Manager" has drawn the conclusion.
    if (result.catalogue_unavailable) lines.push(result.catalogue_unavailable, "");
    // panel#890 (codex round 4) — the install reply can carry the analysis's mappings
    // failure now, and a caveat that is set but never rendered is the same hole one
    // layer down.
    if (result.mappings_unavailable) lines.push(result.mappings_unavailable, "");
    if (result.catalogue_currency_unverified)
      lines.push(result.catalogue_currency_unverified, "");
    lines.push(
      `### Could not resolve (${result.unresolved.length})`,
      "Not found in ComfyUI-Manager — install manually:",
      ...result.unresolved.map((p) => `- ${p}`),
      "",
    );
  }

  if (result.queue) {
    const q = result.queue;
    lines.push(
      "### Manager queue status",
      `- total: ${q.total_count ?? "?"}, done: ${q.done_count ?? "?"}, ` +
        `in progress: ${q.in_progress_count ?? "?"}, processing: ${q.is_processing ?? "?"}`,
    );
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

/** action:"skill_list" */
function listSkillsAction(): ToolText {
  traceToolCall("list_packs", { action: "skill_list" });
  const skills = enumerateSkills();
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ count: skills.length, skills }, null, 2),
      },
    ],
  };
}

/** action:"skill_read" */
function readSkillAction(rawName: string): ToolText {
  traceToolCall("list_packs", { action: "skill_read", name: rawName });
  const name = rawName.trim();
  if (!SAFE_NAME.test(name)) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Invalid skill name "${rawName}". Use a plain skill directory name (letters, digits, dot, dash, underscore) from list_packs (action:"skill_list").`,
        },
      ],
    };
  }
  // Must resolve to an existing skill dir (defense in depth alongside the regex).
  const dir = join(skillsDir(), name);
  const resolvedRoot = skillsDir();
  if (!dir.startsWith(resolvedRoot) || !existsSync(dir) || !statSync(dir).isDirectory()) {
    const known = enumerateSkills().map((s) => s.name);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `No skill named "${name}". Available skills: ${known.join(", ") || "(none bundled)"}.`,
        },
      ],
    };
  }
  const text = readSkillFile(name);
  if (text == null) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `Skill "${name}" has no readable SKILL.md.` }],
    };
  }
  return { content: [{ type: "text" as const, text }] };
}

/** action:"generate_skill". Returns `structuredContent` alongside the markdown,
 *  exactly as the retired tool did — the return shape is part of the contract. */
async function generateSkillAction(args: {
  source: string;
  install_in?: string;
  refresh?: boolean;
}): Promise<ToolText & { structuredContent: Record<string, unknown> }> {
  const result = await generateSkillCached(args.source, { refresh: args.refresh });
  const markdown = result.markdown;
  const structuredContent = {
    cache_hit: result.cacheHit,
    cache_key: result.safeKey,
    cache_dir: result.cacheDir,
    version: result.metadata.version,
  };

  // Optionally write to disk
  if (args.install_in) {
    const dir = args.install_in;
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "SKILL.md");
    await writeFile(filePath, markdown, "utf-8");
    return {
      content: [
        {
          type: "text" as const,
          text: `Skill file written to ${filePath}\n\n${markdown}`,
        },
      ],
      structuredContent,
    };
  }

  return {
    content: [{ type: "text" as const, text: markdown }],
    structuredContent,
  };
}
