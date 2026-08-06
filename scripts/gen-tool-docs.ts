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
  readdirSync,
  existsSync,
  mkdtempSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
// zod 4 ships JSON Schema conversion natively (z.toJSONSchema) — no zod-to-json-schema.
import { registerAllTools } from "../src/tools/index.js";
import { TOOL_DOC_EXAMPLES, type ToolDocEntry } from "./tool-doc-examples.js";

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
    description: "High-level text-to-image, audio, video and 3D generation, conditioned image variants, and the two post-processing passes — all nine actions of one tool since 0.50.0 slice 16.",
    tools: [
      "generate_image",
    ],
  },
  {
    group: "Workflow Execution",
    slug: "workflow-execution",
    icon: "play",
    description: "Enqueue workflows — one at a time, from a named template, or as a batch — and inspect the queue, jobs, history, and system stats.",
    tools: [
      // 0.50.0 slice 16 folded the re-run, run-from-URL and template
      // entrypoints into `enqueue_workflow`, and the diagnosis + local
      // settings-history views into `get_history`.
      "enqueue_workflow", "get_system_stats", "queue", "get_history",
      "calculate",
      // Batch execution: submit many prompts under one batch_id, then poll/await it.
      "batch",
    ],
  },
  {
    group: "Workflow Authoring",
    slug: "workflow-authoring",
    icon: "pen-ruler",
    description: "Build, modify, validate, and visualize ComfyUI workflows.",
    // 0.50.0 slice 14: create_workflow absorbed modify/validate/node_info and
    // visualize_workflow absorbed the hierarchical, mermaid and DSL conversions,
    // so this group is two entries rather than nine. query/prompt_director moved
    // to Workflow Library with the rest of get_workflow's read actions.
    tools: ["create_workflow", "visualize_workflow"],
  },
  {
    group: "Workflow Library",
    slug: "workflow-library",
    icon: "folder-open",
    description: "Save, load, strip/slice, analyze, and extract workflows.",
    tools: ["get_workflow", "save_workflow"],
  },
  {
    group: "Assets & Images",
    slug: "assets-images",
    icon: "images",
    description: "View, convert, and upload generated images; analyze colors; stage outputs as inputs; upload media inputs; browse outputs.",
    tools: [
      // 0.50.0 slice 15 folded twelve names into these two: `get_image` is the
      // read/inspect half (get, view, list_outputs, convert, plus the colour
      // measure and the asset-registry reads) and `upload_image` the write half
      // (image, video, audio, stage, output).
      "get_image", "upload_image",
    ],
  },
  {
    group: "Models",
    slug: "models",
    icon: "box",
    description: "Search (HuggingFace + CivitAI), download, list, and remove models; resolve a workflow's missing models with VRAM-aware candidates; manage embeddings and VRAM.",
    tools: [
      // 0.50.0 slice 11 folded fourteen model tools into two: download_model
      // (8 actions) and list_local_models (6). Both survivors keep their names,
      // so this list simply shrinks.
      "download_model", "list_local_models",
      "clear_vram",
      "model_metadata",
    ],
  },
  {
    group: "Custom Nodes",
    slug: "custom-nodes",
    icon: "puzzle",
    description: "Discover, install, update, snapshot, bisect, scaffold, and publish custom node packs.",
    tools: [
      // 0.50.0 slice 12 folded twenty names into these three: registry
      // discovery into `search_custom_nodes`, Manager lifecycle into
      // `install_custom_node`, the author loop into `node_pack`.
      "search_custom_nodes", "install_custom_node", "node_pack",
      "node_snapshot", "bisect",
    ],
  },
  {
    group: "API Nodes",
    slug: "api-nodes",
    icon: "cloud",
    description: "Discover and run hosted partner / API nodes (comfy.org).",
    tools: ["list_api_nodes"],
  },
  {
    group: "Install & Environment",
    slug: "install-environment",
    icon: "wrench",
    description: "Install/update ComfyUI and the sidebar panel, self-update the MCP server, apply a setup manifest, manage workspaces, inspect the environment, configure ComfyUI-Manager, report issues.",
    tools: [
      "install_comfyui",
      "apply_manifest", "workspace",
      "report_issue",
    ],
  },
  {
    group: "Process Control",
    slug: "process-control",
    icon: "power",
    description: "Start, stop, and restart the ComfyUI process.",
    tools: ["restart_comfyui"],
  },
  {
    group: "Defaults, Stats & Skills",
    slug: "defaults-stats-skills",
    icon: "sliders",
    description: "Generation defaults, ComfyUI frontend UI settings, and skill generation. (History-based suggestions and stats moved onto get_history in 0.50.0 slice 16.)",
    tools: [
      "get_defaults",
    ],
  },
  {
    group: "RunPod (cloud GPU)",
    slug: "runpod",
    icon: "server",
    description: "Deploy, connect, monitor, and stop RunPod cloud GPU pods, and switch rendering between your local rig and a pod — the tools behind the panel/mobile RunPod control panel.",
    // 0.50.0 slice 8 folded the eleven runpod_* tools into these two.
    tools: ["runpod", "runpod_watch"],
  },
  {
    group: "LoRA Training",
    slug: "training",
    icon: "graduation-cap",
    description: "Train character LoRAs (FLUX.1-dev) via ostris ai-toolkit — locally in a GPU Docker image or on a rented RunPod pod — with a crash-safe job registry and streamed progress.",
    // 0.50.0 slice 10 folded eighteen train_* tools into three, split by
    // work-domain: the datasets a run consumes, the jobs that consume them, and
    // the trainer machinery itself.
    tools: ["train_prepare_dataset", "train_start", "train_doctor"],
  },
  {
    group: "Apps (micro-apps)",
    slug: "apps",
    icon: "layout-grid",
    description: "List, inspect, and run the panel's micro-apps — named, one-click workflow apps with exposed inputs — for canvas-less clients (mobile).",
    tools: ["apps"],
  },
  {
    group: "comfy-cli",
    slug: "comfy-cli",
    icon: "terminal",
    description: "Drive the official comfy-cli — managed server lifecycle, jobs, loaded-node search, workflow validation/execution, uploads/downloads, model discovery, and official agent skills.",
    tools: ["comfy_cli"],
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
    // One tool since 0.50.0 slice 9: the nine knowledge tools folded into
    // `list_packs`, whose nine actions this page documents by hand.
    tools: ["list_packs"],
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
  // Keep MDX happy: collapse INLINE whitespace per line but preserve line breaks —
  // a newline-separated list in a tool description must stay a list in the docs,
  // not render as one long paragraph — and escape characters MDX would parse as
  // JSX — angle brackets (e.g. "<COMFYUI_PATH>") and curly braces (expressions).
  const map: Record<string, string> = { "<": "&lt;", ">": "&gt;", "{": "&#123;", "}": "&#125;" };
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/[<>{}]/g, (m) => map[m]);
}

function renderParam(name: string, schema: JsonSchema, required: boolean): string {
  const attrs = [`path="${name}"`, `type="${typeLabel(schema)}"`];
  if (required) attrs.push("required");
  if (schema.default !== undefined) {
    attrs.push(`default="${String(schema.default).replace(/"/g, "&quot;")}"`);
  }
  const body: string[] = [];
  if (schema.description) body.push(esc(schema.description));
  if (schema.enum) {
    // The `action` field gets its options rendered as the CALL FORM rather than
    // bare values. Two reasons, and the first is the reader's: on the 0.50.0
    // surface `action` is the only required field on most tools, so `action:"get"`
    // is the thing to copy, where a bare `get` still has to be assembled. The
    // second is mechanical — several folds reused a retired TOOL name as an
    // action name, and a bare option value in generated prose is then
    // indistinguishable from an instruction to call a tool that 404s. The call
    // form says which it is, in the one syntax the dead-name gate recognises
    // repo-wide. Any other enum field keeps the plain value list.
    const opt = (e: unknown) => (name === "action" ? `\`action:"${String(e)}"\`` : `\`${String(e)}\``);
    body.push(`Options: ${schema.enum.map(opt).join(", ")}.`);
  }
  return `<ParamField ${attrs.join(" ")}>\n  ${body.join(" ") || "—"}\n</ParamField>`;
}

// Most examples can be derived from JSON Schema required fields. Flat action
// schemas deliberately keep action-specific required fields optional in that
// schema (the MCP SDK does not render discriminated unions correctly), so they
// need a complete, valid representative call here instead of an unusable
// action-only skeleton.
const EXAMPLE_ARG_OVERRIDES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  model_metadata: {
    action: "read",
    category: "loras",
    name: "my_model.safetensors",
  },
  workspace: {
    action: "set_default",
    path: "/opt/ComfyUI",
  },
  // 0.50.0 slice 10. Without these the generated skeletons are `{"action": …}`
  // alone, which every one of these tools rejects with a missing-field error —
  // an example a reader copies and watches fail. train_doctor needs no override:
  // its default action:"doctor" takes no other parameters and is a valid call.
  train_prepare_dataset: {
    action: "prepare",
    name: "aria_character",
    items: [{ path: "/photos/aria_01.png", caption: "ohwx person, side profile, window light" }],
    defaultCaption: "ohwx person",
  },
  train_start: {
    action: "start",
    name: "aria_character",
    datasetPath: "/home/me/.comfyui-mcp/training/datasets/aria_character",
    trigger: "ohwx person",
  },
};

function exampleArgs(toolName: string, jsonSchema: JsonSchema): Record<string, unknown> {
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
  return { ...out, ...EXAMPLE_ARG_OVERRIDES[toolName] };
}

function firstSentence(desc: string): string {
  const m = desc.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : desc).trim();
}

/**
 * Validate every curated example in scripts/tool-doc-examples.ts against the
 * tool's REAL zod schema, and fail generation if any of them is wrong.
 *
 * This exists because a documented call that does not typecheck is worse than no
 * example at all: a reader copies it, it 400s, and they conclude the tool is
 * broken. Prose cannot be unit-tested, so this is where examples get tested.
 *
 * Three distinct failures, each caught deliberately:
 *
 * 1. A key for a tool that no longer exists. During the consolidation tools are
 *    being renamed and folded together; an example still keyed by a retired name
 *    must become a loud failure, not a silently-ignored map entry.
 *
 * 2. A field that is not in the schema. zod objects STRIP unknown keys by
 *    default, so `safeParse` alone happily accepts `{"filenmae": "x"}` and
 *    reports success — the misspelling would ship. Hence the explicit key check
 *    against the JSON Schema's properties, before parsing.
 *
 * 3. A field with the wrong type or a missing required one. That is what
 *    `safeParse` is for, run against the same shape the MCP SDK advertises.
 */
function validateExamples(byName: Map<string, CapturedTool>): void {
  const problems: string[] = [];

  for (const [toolName, entry] of Object.entries(TOOL_DOC_EXAMPLES)) {
    const tool = byName.get(toolName);
    if (!tool) {
      problems.push(
        `${toolName}: no such tool is registered — it was probably renamed or ` +
          `consolidated. Update or remove its entry in scripts/tool-doc-examples.ts.`,
      );
      continue;
    }
    const schema = z.object(tool.shape);
    const json = z.toJSONSchema(schema, { reused: "inline", io: "input" }) as unknown as JsonSchema;
    const known = new Set(Object.keys(json.properties ?? {}));

    entry.examples.forEach((ex, i) => {
      const where = `${toolName} example #${i + 1} ("${ex.ask}")`;
      const unknownKeys = Object.keys(ex.args).filter((k) => !known.has(k));
      if (unknownKeys.length > 0) {
        problems.push(
          `${where}: field(s) ${unknownKeys.map((k) => `\`${k}\``).join(", ")} ` +
            `do not exist on this tool. Known fields: ${[...known].join(", ") || "(none)"}.`,
        );
        // Still parse below: a typo'd key is stripped, so the parse would pass
        // and hide any OTHER problem in the same example.
      }
      const parsed = schema.safeParse(ex.args);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
          .join("; ");
        problems.push(`${where}: does not satisfy the tool's schema — ${detail}`);
      }
    });
  }

  if (problems.length > 0) {
    throw new Error(
      `[gen-tool-docs] ${problems.length} documented example(s) do not match the live tool ` +
        `schemas:\n  ${problems.join("\n  ")}\n` +
        `Fix the example in scripts/tool-doc-examples.ts — do NOT relax this check. ` +
        `An example that does not typecheck will be copied by a reader and will fail.`,
    );
  }
}

/** Render the curated examples for one tool, or the generated skeleton if it has none. */
function renderExamples(t: CapturedTool, json: JsonSchema, entry?: ToolDocEntry): string[] {
  const lines: string[] = [];

  if (!entry || entry.examples.length === 0) {
    lines.push("### Example", "");
    lines.push(
      "<Note>No worked example yet — the call below is a skeleton generated from the " +
        "required parameters. Real examples live in `scripts/tool-doc-examples.ts`; " +
        "contributions welcome.</Note>",
      "",
    );
    lines.push(
      "```json",
      JSON.stringify({ tool: t.name, arguments: exampleArgs(t.name, json) }, null, 2),
      "```",
      "",
    );
    return lines;
  }

  lines.push(entry.examples.length === 1 ? "### Example" : "### Examples", "");
  for (const ex of entry.examples) {
    // The ASK comes first on purpose. The audience for this page mostly does not
    // type JSON at anything — they say a sentence to an agent and it makes the
    // call. Leading with the sentence shows which request reaches this tool;
    // leading with the JSON implies a calling convention they will never use.
    lines.push(`**You say:** ${esc(ex.ask)}`, "");
    lines.push(
      "```json",
      JSON.stringify({ tool: t.name, arguments: ex.args }, null, 2),
      "```",
      "",
    );
    if (ex.argsNote) lines.push(`<Note>${esc(ex.argsNote)}</Note>`, "");
    lines.push(`**You get back:** ${esc(ex.returns)}`, "");
    if (ex.caution) lines.push(`<Warning>${esc(ex.caution)}</Warning>`, "");
  }
  return lines;
}

function renderTool(t: CapturedTool): string {
  // `io: "input"` matches what the MCP SDK advertises to clients
  // (sdk/server/zod-json-schema-compat.js defaults pipeStrategy to 'input').
  //
  // Omitting it meant OUTPUT semantics, under which a field with `.default()` is
  // always present and therefore listed as required. So every defaulted parameter was
  // documented as REQUIRED while the real tools/list schema said optional — 25
  // parameters across 18 tools, e.g. comfy_cli.detail, declared
  // `.optional().default("env")` and rendered `required default="env"`. A reader
  // supplying every "required" field is doing needless work; a model reading it may
  // refuse to call the tool without them. The docs-freshness gate stayed green
  // throughout because it faithfully regenerated the same wrong answer.
  const json = z.toJSONSchema(z.object(t.shape), {
    reused: "inline",
    io: "input",
  }) as unknown as JsonSchema;
  const props = json.properties ?? {};
  const required = new Set(json.required ?? []);
  const paramNames = Object.keys(props);

  const entry = TOOL_DOC_EXAMPLES[t.name];

  const lines: string[] = [];
  lines.push(`## ${t.name}`, "");
  lines.push(esc(t.description), "");

  // The gloss is ADDITIVE. The description above is written for model dispatch —
  // it disambiguates this tool from its neighbours in the terms a model needs,
  // which is why it talks about context cost and about which tool NOT to pick.
  // Rewriting it for readability measurably degrades tool choice (#557/#654), so
  // a human-facing sentence goes here, next to it, instead of over it.
  if (entry?.gloss) {
    lines.push(`<Tip>**In plain terms:** ${esc(entry.gloss)}</Tip>`, "");
  }

  if (paramNames.length > 0) {
    lines.push("### Parameters", "");
    for (const name of paramNames) {
      lines.push(renderParam(name, props[name], required.has(name)));
    }
    lines.push("");
  } else {
    lines.push("<Note>This tool takes no parameters.</Note>", "");
  }

  lines.push(...renderExamples(t, json, entry));
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

  // Before ANY page is rendered — a bad example must abort the run, not be
  // written into 16 files and then reported.
  validateExamples(byName);

  const mapped = new Set<string>();
  mkdirSync(toolsDir, { recursive: true });

  const navPages: string[] = [];
  // Pages are BUFFERED, not written as they are rendered, so the fatal checks
  // below run before anything touches docs/. Writing inside the loop meant an
  // unmapped-tool throw left the tree half-regenerated: some pages updated, some
  // not, and a `git diff` that mixes the real change with debris from a failed
  // run. Generation is now all-or-nothing with respect to those checks.
  const pending: Array<{ path: string; content: string }> = [];

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
    // Every page carries this. The JSON below is what the AGENT sends; readers
    // arriving from a search result were being shown a calling convention they
    // will never type, with nothing on the page to say so.
    page.push(
      "<Tip>**You don't type these calls.** Ask your agent for what you want in " +
        "ordinary English — it chooses the tool and fills in the arguments. The JSON " +
        "on this page is what it sends. New here? Start with " +
        "[Using the tools](/using-tools).</Tip>",
    );
    page.push("");
    for (const name of present) page.push(renderTool(byName.get(name)!));

    pending.push({ path: join(toolsDir, `${cat.slug}.mdx`), content: page.join("\n") });
    navPages.push(`tools/${cat.slug}`);
  }

  // Append hand-written reference pages to the nav. Their .mdx is hand-maintained,
  // never written here.
  //
  // Existence is checked BEFORE their tools count as covered. The old order marked
  // them mapped unconditionally and only warned about a missing page, so every tool
  // on a hand-written page that did not exist was exempted from the fatal check
  // below while having no documentation at all — a hole shaped exactly like the one
  // that check was added to close.
  const missingHandWritten: string[] = [];
  for (const hw of HAND_WRITTEN_PAGES) {
    if (existsSync(join(toolsDir, `${hw.slug}.mdx`))) {
      hw.tools.forEach((n) => mapped.add(n));
      navPages.push(`tools/${hw.slug}`);
    } else {
      missingHandWritten.push(`docs/tools/${hw.slug}.mdx (${hw.tools.length} tool(s))`);
    }
  }
  if (missingHandWritten.length > 0) {
    throw new Error(
      `[gen-tool-docs] ${missingHandWritten.length} hand-written page(s) are referenced by ` +
        `HAND_WRITTEN_PAGES but do not exist, so their tools would be undocumented AND the nav ` +
        `would link nowhere:\n  ${missingHandWritten.join("\n  ")}\n` +
        `Create the page, or move those tools into a generated CATEGORIES entry.`,
    );
  }

  // FATAL, not a warning: an unmapped tool is silently absent from the published
  // Tool Reference, and a warning in a passing build is a warning nobody reads —
  // that is how 18 tools (all the batch/template tools and most of train_*) went
  // undocumented. Failing here means adding a tool forces a docs decision, and
  // during the 181 -> 29 consolidation it means a consolidated tool cannot land
  // without its reference page.
  //
  // Do NOT "fix" a failure here by bulk-adding names to a category you haven't
  // read — that recreates the warning with extra steps. Put the tool where a
  // reader would look for it, or add it to HAND_WRITTEN_PAGES.
  const unmapped = captured.map((t) => t.name).filter((n) => !mapped.has(n));
  if (unmapped.length > 0) {
    throw new Error(
      `[gen-tool-docs] ${unmapped.length} tool(s) are not in any CATEGORIES entry or HAND_WRITTEN_PAGES, ` +
        `so they would be missing from the Tool Reference:\n  ${unmapped.join("\n  ")}\n` +
        `Assign each one in scripts/gen-tool-docs.ts.`,
    );
  }

  // An .mdx in docs/tools/ that no longer belongs to any category or hand-written
  // page is still PUBLISHED — it just falls out of the nav, so it documents a
  // surface nobody can navigate to and nothing regenerates. Phase 5 restructures
  // every category, which is exactly when orphans appear. Reported, never deleted:
  // removing a file the author may have hand-written is not this script's call.
  // Derived from the pages actually GENERATED this run, not from every declared
  // CATEGORY. A category whose tools have all been removed hits the `continue`
  // above, so no page is written for it — but listing it as "expected" anyway kept
  // its now-stale page permanently exempt: still published, still unreachable from
  // the nav, and never regenerated. Phase 5 empties categories wholesale, so this
  // is the common case, not an edge one.
  const expectedPages = new Set([
    ...pending.map((w) => basename(w.path)),
    ...HAND_WRITTEN_PAGES.map((h) => `${h.slug}.mdx`),
  ]);
  const orphans = readdirSync(toolsDir)
    .filter((f) => f.endsWith(".mdx") && !expectedPages.has(f))
    .sort();
  if (orphans.length > 0) {
    throw new Error(
      `[gen-tool-docs] ${orphans.length} page(s) in docs/tools/ belong to no CATEGORIES entry ` +
        `or HAND_WRITTEN_PAGES, so they are published but unreachable from the nav:\n  ` +
        `${orphans.join("\n  ")}\n` +
        `Delete them, or add the owning entry back to scripts/gen-tool-docs.ts.`,
    );
  }

  // docs.json's SHAPE is validated before any page is written. Buffering the pages
  // was only half the fix: the generator still wrote all 16 of them and then threw
  // on a malformed navigation.tabs, leaving exactly the partial-regeneration debris
  // the buffering was introduced to prevent.
  let docsJson: { navigation?: { tabs?: unknown } } | undefined;
  if (existsSync(docsJsonPath)) {
    docsJson = JSON.parse(readFileSync(docsJsonPath, "utf-8"));
    const tabsValue = docsJson!.navigation?.tabs;
    if (docsJson!.navigation && !Array.isArray(tabsValue)) {
      throw new Error(
        "docs.json navigation.tabs is not an array — aborting so we don't corrupt the config.",
      );
    }
    // Each ENTRY is validated too, not just the container. `{"tabs":[null]}` satisfied
    // Array.isArray, so all 16 pages were written and the code then threw dereferencing
    // `t.tab` — leaving exactly the partial-regeneration debris this pre-write check was
    // introduced to prevent. A shape check that stops at the outer type is not a shape
    // check.
    if (Array.isArray(tabsValue)) {
      const bad = tabsValue.findIndex(
        (t) => !t || typeof t !== "object" || typeof (t as { tab?: unknown }).tab !== "string",
      );
      if (bad >= 0) {
        throw new Error(
          `docs.json navigation.tabs[${bad}] is not an object with a string "tab" — ` +
            `aborting before any page is written.`,
        );
      }
    }
  }

  // Every check passed — now the tree may change.
  for (const { path, content } of pending) writeFileSync(path, content);

  // Splice the generated "Tools" tab into docs.json (preserve everything else).
  if (docsJson) {
    // Shape already validated above, before any page was written.
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
