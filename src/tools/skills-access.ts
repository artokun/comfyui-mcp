import { z } from "zod";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parse as parseYaml } from "yaml";
import { errorToToolResult } from "../utils/errors.js";
import { getComfyUIApiHost, getComfyUIProtocol } from "../config.js";
import { checkWorkflowRuntime, extractWorkflowClassTypes } from "../services/api-nodes.js";

// Optional, opt-in observability hook for the knowledge-parity smoke test: when
// COMFYUI_MCP_TOOL_TRACE points at a file, each of these tools appends a JSONL
// record of its invocation. No-op in normal operation (env unset). This is the
// only way an out-of-process harness can prove the agent actually CALLED
// list_skills/read_skill/read_pack_workflow on the headless comfyui stdio MCP,
// since those calls don't traverse the panel bridge.
function traceToolCall(tool: string, args: Record<string, unknown>): void {
  const path = process.env.COMFYUI_MCP_TOOL_TRACE;
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify({ tool, args, ts: Date.now() })}\n`);
  } catch {
    // tracing is best-effort and must never affect the tool's result
  }
}

// SKILL ACCESS — Codex↔Claude knowledge parity for the panel agent.
//
// Claude loads ALL plugin skills natively (the panel orchestrator passes
// plugins:[{type:"local",path:pluginPath}], skills:"all"), so it knows the
// per-family expertise (e.g. krea2-txt2img) and the installer-packs system out of
// the box. Codex has NO skill mechanism. These tools expose the SAME bundled
// knowledge through the comfyui MCP that BOTH backends (and any MCP client) share,
// so Codex can discover and read a model family's skill on demand and prefer a
// ready pack over hand-building a generic graph from scratch.
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
 *  separators, or oddities. Both tools validate the caller-supplied name against
 *  this AND against an actually-existing directory before reading anything. */
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
function enumeratePacks(): Array<Record<string, unknown>> {
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
      // default is local/free. (Use check_workflow_runtime to verify a graph.)
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
 *  null when the pack or its workflow is missing. Shared by read_pack_workflow
 *  and check_workflow_runtime so they resolve the file identically. */
function resolvePackWorkflowFile(packName: string): string | null {
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

export function registerSkillsAccessTools(server: McpServer): void {
  server.tool(
    "list_skills",
    "List the bundled ComfyUI model-family + workflow skills shipped with comfyui-mcp (name + description for each). These encode per-family expertise (e.g. krea2-txt2img: native krea2 CLIPLoader, Qwen3-VL encoder, 8-step turbo settings) and the installer-packs system. Call this BEFORE hand-building a <model-family> workflow from scratch — if a matching skill exists, read its full guidance with read_skill(name) and prefer a ready installer pack (see list_packs) over a generic graph. Claude loads these natively; this tool gives the SAME knowledge to any MCP client (e.g. the Codex backend).",
    {},
    async () => {
      try {
        traceToolCall("list_skills", {});
        const skills = enumerateSkills();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ count: skills.length, skills }, null, 2),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "read_skill",
    "Return the full body of a bundled skill's SKILL.md by name (discover names with list_skills). Gives you the family's complete expertise on demand — model slots, node graph, recommended settings, and gotchas — so you can build the right workflow instead of guessing. Names are validated (no path traversal) and must match an existing skill directory.",
    {
      name: z
        .string()
        .min(1)
        .describe("The skill name (a directory under plugin/skills/, e.g. 'krea2-txt2img'). Get valid names from list_skills."),
    },
    async (args) => {
      try {
        traceToolCall("read_skill", { name: args.name });
        const name = args.name.trim();
        if (!SAFE_NAME.test(name)) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Invalid skill name "${args.name}". Use a plain skill directory name (letters, digits, dot, dash, underscore) from list_skills.`,
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
            content: [
              { type: "text" as const, text: `Skill "${name}" has no readable SKILL.md.` },
            ],
          };
        }
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "list_packs",
    "List the bundled installer packs under packs/ — one-command setups for a model family: custom nodes + model weights (manifest.yaml) PLUS a ready workflow.json graph. Each entry reports its family/kind, its runtime (these packs are LOCAL-GPU / FREE — they run on the user's own GPU and never spend paid API credits), whether it has a ready workflow + manifest, and the manifest path for apply_manifest. When asked to 'set up / build a <model-family> workflow', PREFER applying the matching pack (apply_manifest --path <manifest_path>) and loading its ready workflow (panel_load_workflow pack:<name>) over building a generic graph from scratch. Read the ready graph with read_pack_workflow(name). To check whether some OTHER (non-pack) workflow uses paid API nodes, use check_workflow_runtime.",
    {},
    async () => {
      try {
        traceToolCall("list_packs", {});
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
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "list_workflow_templates",
    "List the OFFICIAL ComfyUI workflow templates available on the connected ComfyUI (the comfyui-workflow-templates package + any custom-node-provided templates), grouped by source. Hits the live server's /api/workflow_templates index. When asked to 'set up / build a <model-family> workflow', check here for a matching official starter template AFTER checking the bundled skills + installer packs (list_skills / list_packs). NOTE: this lists what's available; loading a template onto the canvas is done in the ComfyUI frontend's Templates browser (the panel agent cannot load a template graph headlessly yet) — surface the matching template name to the user.",
    {},
    async () => {
      try {
        traceToolCall("list_workflow_templates", {});
        const base = `${getComfyUIProtocol()}://${getComfyUIApiHost()}`;
        const res = await fetch(`${base}/api/workflow_templates`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `ComfyUI returned ${res.status} for /api/workflow_templates. Is the server running and recent enough to expose workflow templates?`,
              },
            ],
          };
        }
        const index = (await res.json()) as Record<string, unknown>;
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
                { source_count: groups.length, template_count: total, templates: index },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "read_pack_workflow",
    "Return a bundled pack's ready workflow.json graph by pack name (discover names + which packs have a workflow with list_packs). This is the EXPERT graph for that model family — use it as the source of truth when setting up the family on the user's canvas: recreate it node-by-node with the panel_* tools (panel_add_node / panel_connect / panel_set_widget) so it lands on their live canvas, or enqueue it headlessly. Prefer this over inventing a graph from scratch. Names are validated (no path traversal) and must match an existing pack directory.",
    {
      name: z
        .string()
        .min(1)
        .describe("The pack name (a directory under packs/, e.g. 'krea2-txt2img'). Get valid names from list_packs."),
    },
    async (args) => {
      try {
        traceToolCall("read_pack_workflow", { name: args.name });
        const name = args.name.trim();
        if (!SAFE_NAME.test(name)) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Invalid pack name "${args.name}". Use a plain pack directory name from list_packs.`,
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
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "check_workflow_runtime",
    "Determine whether a workflow runs on the user's OWN GPU (LOCAL — free) or uses hosted API NODES (PAID api credits). Pass `pack` (a bundled pack name — always local/free) OR `graph` (a UI or API/prompt workflow JSON, as object or string). It scans the workflow's node class_types against the connected ComfyUI's API-node set (the same signal list_api_nodes uses) and returns { runtime: 'local'|'api'|'mixed'|'unknown', usesApiNodes, apiNodes[], unknownNodes[] } — 'unknown' means some nodes couldn't be classified (could be paid), so treat it (and 'api'/'mixed') as POSSIBLY PAID; only 'local' is confirmed free. ALWAYS call this before building OR loading a non-pack/ad-hoc workflow so you can ASK the user before spending paid API credits — never silently use API nodes.",
    {
      pack: z
        .string()
        .optional()
        .describe("A bundled pack name (from list_packs). Packs are local/free; this confirms it from the actual graph."),
      graph: z
        .union([z.string(), z.record(z.string(), z.unknown())])
        .optional()
        .describe("A workflow graph to classify (UI or API/prompt format), as an object or a JSON string. Use this for ad-hoc/generated workflows."),
    },
    async (args) => {
      try {
        traceToolCall("check_workflow_runtime", { pack: args.pack });
        let graph: unknown;
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
          const runtime = await checkWorkflowRuntime(graph);
          const guidance =
            runtime.runtime === "local"
              ? "Local-GPU / free — every node runs on the user's own GPU, no paid credits."
              : runtime.runtime === "unknown"
                ? "UNKNOWN — some nodes aren't in this server's /object_info (uninstalled custom nodes, or possibly hosted API/partner nodes). Cannot confirm it's free. Treat as POSSIBLY PAID: ASK the user (free local GPU vs paid api credits) before building or loading it; prefer a local pack."
                : "This workflow uses hosted API nodes that consume PAID api credits. ASK the user (free local GPU vs paid api credits) BEFORE building or loading it; prefer a local pack unless they opt in.";
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ ...runtime, guidance }, null, 2),
              },
            ],
          };
        } catch (probeErr) {
          // No live server (or /object_info failed): we can't authoritatively
          // classify, but still surface the node list so the agent can reason.
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    runtime: "unknown",
                    usesApiNodes: null,
                    classTypes,
                    note: `Could not reach the ComfyUI server to classify nodes (${(probeErr as Error).message}). API-node detection needs a running ComfyUI. If unsure, treat ad-hoc workflows as POSSIBLY paid and ask the user before spending credits.`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
