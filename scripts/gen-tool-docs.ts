/**
 * Self-documenting tool reference generator.
 *
 * Boots the real MCP server with a capturing mock, reads every registered
 * tool's name + description + zod input schema, and emits Mintlify MDX pages
 * (grouped by category) plus the matching `navigation` tab in docs/docs.json.
 *
 * Run:  npm run docs:gen   (which sets COMFYUI_URL so config.ts skips its
 * network port-probe at import time).
 *
 * Re-run any time tools change — the Tool Reference stays in sync with code.
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
// zod 4 ships JSON Schema conversion natively (z.toJSONSchema) — no zod-to-json-schema.
import { registerAllTools } from "../src/tools/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const docsRoot = join(repoRoot, "docs");
const toolsDir = join(docsRoot, "tools");
const docsJsonPath = join(docsRoot, "docs.json");

// ---------------------------------------------------------------------------
// Capture registered tools via a mock McpServer.
// ---------------------------------------------------------------------------

interface CapturedTool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
}

const captured: CapturedTool[] = [];

const mockServer = {
  // The codebase registers tools as tool(name, description, zodShape, handler).
  tool(name: string, a?: unknown, b?: unknown, _c?: unknown) {
    if (typeof a === "string" && b && typeof b === "object") {
      captured.push({ name, description: a, shape: b as z.ZodRawShape });
    } else if (typeof a === "string") {
      captured.push({ name, description: a, shape: {} });
    } else if (a && typeof a === "object") {
      captured.push({ name, description: "", shape: a as z.ZodRawShape });
    } else {
      captured.push({ name, description: "", shape: {} });
    }
    // Return a RegisteredTool-like stub.
    return { update() {}, remove() {}, enable() {}, disable() {} };
  },
};

// ---------------------------------------------------------------------------
// Category grouping (ordered). Each category becomes one MDX reference page.
// ---------------------------------------------------------------------------

const CATEGORIES: Array<{
  group: string;
  slug: string;
  icon: string;
  description: string;
  tools: string[];
}> = [
  {
    group: "Image & Audio Generation",
    slug: "image-generation",
    icon: "image",
    description: "High-level text-to-image and text-to-audio generation, plus conditioned image variants.",
    tools: [
      "generate_image",
      "generate_with_controlnet",
      "generate_with_ip_adapter",
      "regenerate",
      "generate_audio",
      "generate_video",
    ],
  },
  {
    group: "Workflow Execution",
    slug: "workflow-execution",
    icon: "play",
    description: "Enqueue workflows and inspect the queue, jobs, history, and system stats.",
    tools: [
      "enqueue_workflow", "rerun_generation", "get_system_stats", "get_queue", "get_job_status",
      "get_queued_workflow", "move_queued_job", "edit_queued_job",
      "cancel_job", "cancel_queued_job", "clear_queue", "get_history", "get_logs",
      "health_check", "calculate",
    ],
  },
  {
    group: "Workflow Authoring",
    slug: "workflow-authoring",
    icon: "pen-ruler",
    description: "Build, modify, validate, and visualize ComfyUI workflows.",
    tools: [
      "create_workflow", "modify_workflow", "validate_workflow", "get_node_info",
      "workflow_to_dsl", "dsl_to_workflow", "visualize_workflow",
      "visualize_workflow_hierarchical", "mermaid_to_workflow",
    ],
  },
  {
    group: "Workflow Library",
    slug: "workflow-library",
    icon: "folder-open",
    description: "Save, load, strip/slice, analyze, and extract workflows.",
    tools: ["list_workflows", "get_workflow", "run_workflow_url", "strip_workflow", "slice_workflow", "save_workflow", "analyze_workflow", "workflow_from_image", "lock_workflow", "verify_workflow_lock"],
  },
  {
    group: "Assets & Images",
    slug: "assets-images",
    icon: "images",
    description: "View, convert, and upload generated images; analyze colors; stage outputs as inputs; upload media inputs; browse outputs.",
    tools: [
      "view_image", "get_image", "convert_image", "analyze_color",
      "remove_background", "upscale_image",
      "stage_output_as_input", "upload_output",
      "upload_image", "upload_video", "upload_audio",
      "list_output_images", "list_assets", "get_asset_metadata",
    ],
  },
  {
    group: "Models",
    slug: "models",
    icon: "box",
    description: "Search, download, list, and remove models; manage embeddings and VRAM.",
    tools: [
      "search_models", "download_model", "download_civitai_model", "list_local_models",
      "remove_model", "list_extra_paths", "add_extra_path", "remove_extra_path",
      "get_embeddings", "clear_vram",
    ],
  },
  {
    group: "Custom Nodes",
    slug: "custom-nodes",
    icon: "puzzle",
    description: "Discover, install, update, snapshot, bisect, scaffold, and publish custom node packs.",
    tools: [
      "search_custom_nodes", "get_node_pack_details", "install_custom_node",
      "update_custom_node", "reinstall_custom_node", "fix_custom_node",
      "list_installed_nodes", "sync_node_dependencies", "extract_workflow_dependencies",
      "install_workflow_dependencies", "save_node_snapshot", "restore_node_snapshot",
      "list_node_snapshots", "bisect_start", "bisect_good", "bisect_bad",
      "bisect_reset", "bisect_status", "scaffold_custom_node", "verify_custom_node", "publish_custom_node",
      "list_node_pack_files", "read_node_file", "search_node_packs", "write_node_file",
      "apply_node_patch", "node_pack_git",
    ],
  },
  {
    group: "API Nodes",
    slug: "api-nodes",
    icon: "cloud",
    description: "Discover and run hosted partner / API nodes (comfy.org).",
    tools: ["list_api_nodes", "get_api_node_schema", "generate_with_api_node"],
  },
  {
    group: "Install & Environment",
    slug: "install-environment",
    icon: "wrench",
    description: "Install/update ComfyUI and the sidebar panel, self-update the MCP server, apply a setup manifest, manage workspaces, inspect the environment, configure ComfyUI-Manager, report issues.",
    tools: [
      "install_comfyui", "update_comfyui", "update_all", "install_panel", "self_update",
      "apply_manifest", "get_workspace", "set_default_workspace", "list_workspaces",
      "get_environment", "configure_manager", "report_issue",
    ],
  },
  {
    group: "Process Control",
    slug: "process-control",
    icon: "power",
    description: "Start, stop, and restart the ComfyUI process.",
    tools: ["start_comfyui", "stop_comfyui", "restart_comfyui"],
  },
  {
    group: "Defaults, Stats & Skills",
    slug: "defaults-stats-skills",
    icon: "sliders",
    description: "Generation defaults, ComfyUI frontend UI settings, history-based suggestions, and skill generation.",
    tools: [
      "get_defaults", "set_defaults", "get_comfyui_settings", "set_comfyui_setting",
      "suggest_settings", "generation_stats", "generate_node_skill",
    ],
  },
];

// Hand-written reference pages (custom prose, NOT generated from the tool schemas).
// docs:gen appends them to the nav and treats their tools as "covered" (so they
// don't trip the uncategorized warning), but NEVER overwrites their .mdx. Use this
// for narrative pages that document a set of tools more richly than the generated
// skeletons — e.g. skills-knowledge, which explains the skills/packs/templates +
// cost-guardrail tools together.
const HAND_WRITTEN_PAGES: Array<{ slug: string; tools: string[] }> = [
  {
    slug: "skills-knowledge",
    tools: [
      "list_skills",
      "read_skill",
      "list_packs",
      "read_pack_workflow",
      "list_workflow_templates",
      "check_workflow_runtime",
    ],
  },
];

// ---------------------------------------------------------------------------
// JSON Schema → MDX rendering helpers
// ---------------------------------------------------------------------------

type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

function typeLabel(s: JsonSchema): string {
  if (s.enum) return "enum";
  if (s.anyOf || s.oneOf) {
    const parts = (s.anyOf ?? s.oneOf ?? []).map(typeLabel);
    return [...new Set(parts)].join(" | ") || "union";
  }
  if (s.type === "array") return `${s.items ? typeLabel(s.items) : "any"}[]`;
  if (Array.isArray(s.type)) return s.type.filter((t) => t !== "null").join(" | ");
  return s.type ?? "any";
}

function esc(text: string): string {
  // Keep MDX happy: collapse whitespace and escape characters MDX would parse as
  // JSX — angle brackets (e.g. "<COMFYUI_PATH>") and curly braces (expressions).
  const map: Record<string, string> = { "<": "&lt;", ">": "&gt;", "{": "&#123;", "}": "&#125;" };
  return text.replace(/\s+/g, " ").replace(/[<>{}]/g, (m) => map[m]).trim();
}

function renderParam(name: string, schema: JsonSchema, required: boolean): string {
  const attrs = [`path="${name}"`, `type="${typeLabel(schema)}"`];
  if (required) attrs.push("required");
  if (schema.default !== undefined) {
    attrs.push(`default="${String(schema.default).replace(/"/g, "&quot;")}"`);
  }
  const body: string[] = [];
  if (schema.description) body.push(esc(schema.description));
  if (schema.enum) body.push(`Options: ${schema.enum.map((e) => `\`${String(e)}\``).join(", ")}.`);
  return `<ParamField ${attrs.join(" ")}>\n  ${body.join(" ") || "—"}\n</ParamField>`;
}

function exampleArgs(jsonSchema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = jsonSchema.properties ?? {};
  const required = new Set(jsonSchema.required ?? []);
  for (const [name, s] of Object.entries(props)) {
    if (!required.has(name)) continue;
    if (s.enum) out[name] = s.enum[0];
    else if (typeLabel(s).startsWith("string") || typeLabel(s) === "enum") out[name] = `<${name}>`;
    else if (s.type === "number" || s.type === "integer") out[name] = 0;
    else if (s.type === "boolean") out[name] = true;
    else if (s.type === "array") out[name] = [];
    else out[name] = `<${name}>`;
  }
  return out;
}

function firstSentence(desc: string): string {
  const m = desc.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : desc).trim();
}

function renderTool(t: CapturedTool): string {
  const json = z.toJSONSchema(z.object(t.shape), {
    reused: "inline",
  }) as unknown as JsonSchema;
  const props = json.properties ?? {};
  const required = new Set(json.required ?? []);
  const paramNames = Object.keys(props);

  const lines: string[] = [];
  lines.push(`## ${t.name}`, "");
  lines.push(esc(t.description), "");

  if (paramNames.length > 0) {
    lines.push("### Parameters", "");
    for (const name of paramNames) {
      lines.push(renderParam(name, props[name], required.has(name)));
    }
    lines.push("");
  } else {
    lines.push("<Note>This tool takes no parameters.</Note>", "");
  }

  lines.push("### Example", "");
  lines.push("<Note>Example coming soon — the call below is a generated skeleton.</Note>", "");
  const args = exampleArgs(json);
  lines.push("```json", JSON.stringify({ tool: t.name, arguments: args }, null, 2), "```", "");
  lines.push("---", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Don't let a developer's local autoloaded workflows (COMFYUI_WORKFLOWS_DIR
  // or ~/.comfyui-mcp/workflows) register and overwrite built-in tool docs —
  // point autoload at an empty temp dir so only built-in tools are captured.
  process.env.COMFYUI_WORKFLOWS_DIR = mkdtempSync(
    join(tmpdir(), "comfyui-mcp-docs-"),
  );

  await registerAllTools(mockServer as never);

  const byName = new Map(captured.map((t) => [t.name, t]));
  const mapped = new Set<string>();
  mkdirSync(toolsDir, { recursive: true });

  const navPages: string[] = [];

  for (const cat of CATEGORIES) {
    const present = cat.tools.filter((n) => byName.has(n));
    present.forEach((n) => mapped.add(n));
    if (present.length === 0) continue;

    const page: string[] = [];
    page.push("---");
    page.push(`title: "${cat.group}"`);
    page.push(`description: "${cat.description}"`);
    page.push(`icon: "${cat.icon}"`);
    page.push("---");
    page.push("");
    page.push(`<Info>${present.length} tool${present.length === 1 ? "" : "s"}. Generated from the live MCP tool schemas — do not edit by hand; run \`npm run docs:gen\`.</Info>`);
    page.push("");
    for (const name of present) page.push(renderTool(byName.get(name)!));

    writeFileSync(join(toolsDir, `${cat.slug}.mdx`), page.join("\n"));
    navPages.push(`tools/${cat.slug}`);
  }

  // Append hand-written reference pages to the nav and mark their tools as covered
  // (so they don't trip the warning). Their .mdx is hand-maintained, never written.
  for (const hw of HAND_WRITTEN_PAGES) {
    hw.tools.forEach((n) => mapped.add(n));
    if (existsSync(join(toolsDir, `${hw.slug}.mdx`))) {
      navPages.push(`tools/${hw.slug}`);
    } else {
      console.warn(`[gen-tool-docs] hand-written page missing: docs/tools/${hw.slug}.mdx`);
    }
  }

  // Warn about any tool not assigned to a category.
  const unmapped = captured.map((t) => t.name).filter((n) => !mapped.has(n));
  if (unmapped.length > 0) {
    console.warn(`[gen-tool-docs] WARNING: ${unmapped.length} tool(s) not in any category:`, unmapped.join(", "));
  }

  // Splice the generated "Tools" tab into docs.json (preserve everything else).
  if (existsSync(docsJsonPath)) {
    const docsJson = JSON.parse(readFileSync(docsJsonPath, "utf-8"));
    // Fail loudly rather than silently reshape navigation into something
    // Mintlify can't read if the config schema ever changes.
    if (docsJson.navigation && !Array.isArray(docsJson.navigation.tabs)) {
      throw new Error(
        "docs.json navigation.tabs is not an array — aborting so we don't corrupt the config.",
      );
    }
    const tabs: Array<{ tab: string; groups?: unknown[] }> = docsJson.navigation?.tabs ?? [];
    const toolsTab = {
      tab: "Tool Reference",
      groups: [{ group: "Tools", pages: navPages }],
    };
    const idx = tabs.findIndex((t) => t.tab === "Tool Reference");
    if (idx >= 0) tabs[idx] = toolsTab;
    else tabs.push(toolsTab);
    docsJson.navigation = { ...docsJson.navigation, tabs };
    // Write atomically (temp + rename) so a crash mid-write can't leave a
    // half-written docs.json.
    const tmp = `${docsJsonPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(docsJson, null, 2) + "\n");
    renameSync(tmp, docsJsonPath);
  }

  console.log(
    `[gen-tool-docs] wrote ${navPages.length} reference pages covering ${mapped.size}/${captured.length} tools.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
