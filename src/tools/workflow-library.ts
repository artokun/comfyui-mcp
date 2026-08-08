import { z } from "zod";
import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkflowJSON } from "../comfyui/types.js";
import { getClient, getObjectInfo, backfillObjectInfo } from "../comfyui/client.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import {
  isUiFormat,
  isApiFormat,
  convertUiToApi,
  convertApiToUi,
  collectNodeTypes,
} from "../services/workflow-converter.js";
import { sliceWorkflow } from "../services/workflow-slicer.js";
import {
  queryApiGraph,
  LIMIT_CEILING,
  MAX_CHARS_CEILING,
  MAX_CHARS_FLOOR,
} from "../services/graph-query.js";
import { listWorkflowLibraryKeys } from "../services/userdata-library.js";
import { detectSections } from "../services/workflow-sections.js";
import {
  generateOverview,
  generateSectionDetail,
  listSections,
  generateSummary,
} from "../services/hierarchical-mermaid.js";
import { convertToMermaid } from "../services/mermaid-converter.js";
import { analyzeGraphHealth } from "../services/workflow-health.js";
import { extractWorkflowFromImage } from "../services/image-management.js";
import { promptDirectorInspectAction } from "./prompt-director.js";
import { lockWorkflowAction, verifyWorkflowLockAction } from "./workflow-lock.js";

/** One text content block, the shape every action in this file returns. */
type TextResult = { content: Array<{ type: "text"; text: string }> };

/**
 * The exactly-one-of `path` / `filename` / `graph` source resolution shared,
 * byte for byte, by the three retired tools that became get_workflow's strip,
 * slice and query actions — including both of their error strings. Factored out
 * when they folded into `get_workflow` (0.50.0 slice 14) so the three copies
 * cannot drift; the messages are unchanged from all three.
 */
async function loadRawFromSource(
  path: string | undefined,
  filename: string | undefined,
  graph: Record<string, unknown> | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const provided = [path, filename, graph].filter((v) => v != null).length;
  if (provided !== 1) {
    throw new ValidationError("Provide exactly one of: path, filename, or graph.");
  }
  if (graph) return graph;
  if (path) return JSON.parse(await readFile(path, "utf8"));
  const client = getClient();
  const encoded = encodeURIComponent(`workflows/${filename}`);
  const res = await client.fetchApi(`/api/userdata/${encoded}`);
  if (!res.ok) {
    throw new ValidationError(`Workflow not found in library: ${filename} (${res.status})`);
  }
  return await res.json();
}

/**
 * The eight workflow-LIBRARY read tools and the three WRITE/PROVENANCE tools
 * collapsed into two action-parameterized tools (0.50.0 surface consolidation,
 * slice 14): `get_workflow` with eight read actions (get, list, strip, slice,
 * from_image, analyze, query, prompt_director) and `save_workflow` with three
 * write/provenance actions (save, lock, verify_lock). Both are survivors and
 * keep their registration slots; the retired names and their replacements are
 * the ledger's business (DEAD_NAMES in src/tools/vocabulary.ts).
 *
 * TWO tools rather than one eleven-action grab-bag because the halves have
 * different blast radii, and the call_tool whitelist depends on that split:
 * every `get_workflow` action is READ-ONLY, while `save_workflow` WRITES into
 * the user's saved-workflow library — hand-authored graphs that are expensive
 * to recreate, and `action:"save"` overwrites a same-filename workflow without
 * confirmation. No read action can reach a write path, which the dispatch tests
 * pin explicitly.
 *
 * `get_workflow` is at EIGHT actions, the RFC's cap, with ZERO headroom
 * (controversy #7). A ninth workflow-reading verb does not go here — it forces
 * the split this comment is the warning for.
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required, so per-action presence is
 * enforced in the handler, which NAMES the missing field. The guards test
 * ABSENCE, not falsiness: `filename: ""` passed z.string() before this
 * consolidation and reached the userdata fetch, which answers with its own
 * not-found error, and still does.
 *
 * ONE ENUM WIDENED, with the halves kept apart: `format` meant ui|api on the
 * file read and api|raw on the strip tool. A single field carries the union
 * ui|api|raw and each branch REFUSES the member its own tool never accepted,
 * naming the valid ones — rather than silently aliasing "raw" onto "ui", which
 * would answer a question the caller did not ask.
 */
export function registerWorkflowLibraryTools(server: McpServer): void {
  server.tool(
    "get_workflow",
    "Return, list, summarize or query a SAVED workflow FILE — files on disk, named from the library or given as a path/JSON — NOT the graph open on the user's canvas (that is panel_graph_outline). Every action here is READ-ONLY; saving and locking are save_workflow. Driven by the `action` parameter:\n" +
      '- action:"get" — the full JSON of one saved workflow FILE named from the library. Defaults to converted API format; pass format:\'ui\' for the raw on-disk UI JSON. Use action:"analyze" instead if you just need to UNDERSTAND the workflow — it returns a structured summary without flooding context with JSON. Use action:"get" only when you need the actual JSON for enqueue_workflow, create_workflow (action:"modify"), or save_workflow.\n' +
      '- action:"list" — the workflows saved in the connected ComfyUI server\'s user library (the same ones visible in the ComfyUI web UI), INCLUDING the ones filed in subfolders. Requires a running ComfyUI server. Takes no other parameters. Returns a numbered list of library names, each relative to the library root — a workflow in a folder appears as \'VIDEO/MiniMaxH3/clip.json\', and that whole string is what `filename` takes. It never reports an absence it did not establish: a listing it could not read says so, and an EMPTY listing says the library could not be CONFIRMED empty (an answer with no names in it cannot show whether it covered subfolders) and tells you to check the ComfyUI sidebar rather than recreate anything.\n' +
      '- action:"strip" — strip a workflow to a clean, flat API graph, resolving Get/Set buses, Reroutes, subgraph definitions, and bypassed/muted nodes into real connections (the \'de-getter-setter\' pass). Unlike action:"get" this reads from ANY server-side file path on disk (not just the workflow library), so it loads ad-hoc / expert workflow files that action:"list" and panel_open_workflow can\'t resolve. Provide exactly one of: path, filename, or graph. Returns conversion warnings, a node-type summary, and the stripped graph (much smaller than the raw UI JSON).\n' +
      '- action:"slice" — slice ONE pipeline out of a toggle-template workflow, the kind built with rgthree \'Fast Groups Bypasser/Muter\' where one graph holds many pipelines and only one is active at a time. Seeds from the output/SaveImage nodes in the named `groups`, takes their backward dependency closure (through real links AND virtual Set/Get buses), un-bypasses the kept nodes (and the internals of any subgraph defs they use), and returns a STANDALONE, activated UI graph carrying only the subgraph defs it uses. Pair with action:"strip" afterward to flatten the Set/Get buses into real connections.\n' +
      '- action:"from_image" — extract embedded ComfyUI workflow metadata from a PNG file. ComfyUI stores the full workflow (API format) and prompt data in PNG tEXt chunks. Use this to reverse-engineer how any ComfyUI image was generated.\n' +
      '- action:"analyze" — SUMMARIZE a saved workflow file named from the library: sections, node settings, connections, and data flow. Returns a concise text summary (not raw JSON) optimized for AI reasoning. Prefer this over action:"get" unless you need the raw JSON for enqueue_workflow or create_workflow (action:"modify").\n' +
      "- action:\"query\" — filter, traverse, project, and aggregate over a saved workflow's nodes WITHOUT dumping the whole JSON (the missing middle between action:\"analyze\"'s fixed summary and action:\"get\"'s full dump; on 100+-node graphs this is the ONLY context-safe way to answer questions like 'which KSamplers run cfg>7', 'what feeds node 42', 'count nodes by type'). Provide exactly one of path/filename/graph, then combine: `types`, `title`, `where` widget predicates ANDed ('cfg>7', 'steps<=20', 'sampler_name=euler', 'text~sunset' — ops = != >= <= > < ~contains), `ids`, `upstream_of`/`downstream_of` + `depth`, `fields`, `group_by`, `limit`, `max_chars`. Output is TOKEN-BOUNDED and, when it truncates, the tail names WHICH of the two caps fired and the exact parameter to raise — read it and retry rather than concluding the graph can't be read. For the LIVE canvas this is panel_query_graph instead.\n" +
      '- action:"prompt_director" — read Prompt Director\'s latest sanitized RUNTIME state after its nodes execute: each node id, node kind, resolved Model Explorer model/LoRA context, structured edit plan, source analysis, exact final prompt, warnings, or Result Critic verdict. Secrets and image tensors are redacted. Pair it with a live panel graph audit: graph inspection explains wiring and widget state, while this explains what the nodes actually resolved and compiled. Pass `node_id` to inspect one executed Prompt Director node.',
    {
      action: z
        .enum(["get", "list", "strip", "slice", "from_image", "analyze", "query", "prompt_director"])
        .describe(
          'Which read to perform. "list" and "prompt_director" take no required parameters; ' +
            '"get" and "analyze" require `filename`; "strip", "slice" and "query" require exactly one of ' +
            '`path`/`filename`/`graph` (and "slice" also requires `groups`); "from_image" requires `image_path`.',
        ),
      filename: z
        .string()
        .optional()
        .describe(
          'Workflow library name, exactly as action:"list" reports it. A workflow filed in a folder ' +
            "keeps its folder in the name ('VIDEO/MiniMaxH3/clip.json') and that whole string goes here. " +
            'REQUIRED for action:"get" and action:"analyze"; one of the three sources for "strip", "slice" and "query".',
        ),
      format: z
        .enum(["ui", "api", "raw"])
        .optional()
        .default("api")
        .describe(
          'action:"get" — \'api\' (default, recommended) converts to compact API format with named inputs, ' +
            "connection references, and _meta.mode flags for muted/bypassed nodes; 'ui' returns the raw UI " +
            "format with layout positions and links arrays. " +
            'action:"strip" — \'api\' (default) strips to the flat resolved graph; \'raw\' returns the file/graph ' +
            "unchanged. Each action accepts only its own two values (this field is the union of what the two " +
            "tools it replaces accepted) and refuses the third rather than guessing at an alias.",
        ),
      path: z
        .string()
        .optional()
        .describe(
          'action:"strip" / "slice" / "query" — Absolute server-side path to a workflow .json on disk (e.g. ' +
            "C:\\\\Users\\\\you\\\\ComfyUI\\\\user\\\\default\\\\workflows\\\\pusa_extend.json). Read directly from disk — no library lookup.",
        ),
      graph: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          'action:"strip" / "slice" / "query" — Inline workflow JSON (UI format for "strip"/"slice"; UI or API for "query"), as an alternative to path/filename.',
        ),
      groups: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          'action:"slice" (REQUIRED) — Group-title substrings (case-insensitive) whose output nodes seed the slice — CSV string or ' +
            "array, e.g. 'TEXT TO IMAGE,TXT' or ['extend','sampler']. Shared post-proc is pulled in via the closure.",
        ),
      image_path: z
        .string()
        .optional()
        .describe('action:"from_image" (REQUIRED) — Absolute path to a ComfyUI-generated PNG file'),
      view: z
        .enum(["summary", "overview", "detail", "list", "flat", "health"])
        .optional()
        .default("summary")
        .describe(
          'action:"analyze" — summary (default): structured text with sections, node IDs, key settings, virtual wires, ' +
            "and full connection graph — best for AI understanding. " +
            "overview: mermaid diagram showing sections as summary nodes with cross-section data flow. " +
            "detail: mermaid diagram for one section (requires section parameter). " +
            "list: text listing of all sections with data flow summary. " +
            "flat: single mermaid flowchart of the entire workflow (best for small workflows). " +
            "health: graph-health heuristics (disconnected nodes, duplicate model loads, orphaned branches, muted/bypassed).",
        ),
      section: z
        .string()
        .optional()
        .describe(
          'action:"analyze" — Section name for detail view. Use view=\'list\' first to see available section names.',
        ),
      node_id: z
        .string()
        .optional()
        .describe(
          'action:"prompt_director" — Optional ComfyUI node id; omit to list all recent Prompt Director runtime states.',
        ),
      types: z
        .array(z.string())
        .optional()
        .describe('action:"query" — Keep nodes whose class_type contains ANY of these (case-insensitive).'),
      title: z.string().optional().describe('action:"query" — Keep nodes whose title contains this.'),
      where: z
        .array(z.string())
        .optional()
        .describe('action:"query" — Widget predicates, ANDed: \'cfg>7\', \'sampler_name=euler\', \'text~sunset\'.'),
      ids: z
        .array(z.union([z.string(), z.number()]))
        .optional()
        .describe('action:"query" — Keep exactly these node ids.'),
      upstream_of: z
        .union([z.string(), z.number()])
        .optional()
        .describe('action:"query" — Scope to the dependency closure FEEDING this node id.'),
      downstream_of: z
        .union([z.string(), z.number()])
        .optional()
        .describe('action:"query" — Scope to the nodes CONSUMING this node id\'s outputs.'),
      depth: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('action:"query" — Max hops from the traversal seed (seed=0). Absent = full closure.'),
      fields: z
        .enum(["ids", "compact", "detail"])
        .optional()
        .describe('action:"query" — Projection: compact one-liners (default), bare ids, or detail JSON rows.'),
      group_by: z
        .enum(["type"])
        .optional()
        .describe('action:"query" — Aggregate: counts per class_type instead of listing.'),
      // #809: the ceilings come from the engine's own clamps, so a hint that quotes a
      // ceiling can never disagree with what the schema accepts or the runtime enforces.
      limit: z
        .number()
        .int()
        .min(1)
        .max(LIMIT_CEILING)
        .optional()
        .describe(`action:"query" — Max nodes listed (default 40, max ${LIMIT_CEILING}).`),
      max_chars: z
        .number()
        .int()
        .min(MAX_CHARS_FLOOR)
        .max(MAX_CHARS_CEILING)
        .optional()
        .describe(
          `action:"query" — Output character bound (default 12000, max ${MAX_CHARS_CEILING}). Raise this — not \`limit\` — when the truncation tail says the char budget cut the result.`,
        ),
    },
    async (args) => {
      try {
        const requireFilename = (action: string, what: string): string => {
          if (args.filename === undefined) {
            throw new Error(`get_workflow action:"${action}" requires \`filename\` — ${what}.`);
          }
          return args.filename;
        };

        switch (args.action) {
          case "get":
            return await getWorkflowAction(
              requireFilename("get", "the workflow library name to read"),
              requireFormat(args.format, "get", ["ui", "api"]),
            );
          case "list":
            return await listWorkflowsAction();
          case "strip":
            return await stripWorkflowAction(
              args.path,
              args.filename,
              args.graph,
              requireFormat(args.format, "strip", ["api", "raw"]),
            );
          case "slice": {
            if (args.groups === undefined) {
              throw new Error(
                'get_workflow action:"slice" requires `groups` — the group-title substring(s) whose output nodes seed the slice.',
              );
            }
            return await sliceWorkflowAction(args.path, args.filename, args.graph, args.groups);
          }
          case "from_image": {
            if (args.image_path === undefined) {
              throw new Error(
                'get_workflow action:"from_image" requires `image_path` — the absolute path to a ComfyUI-generated PNG.',
              );
            }
            return await workflowFromImageAction(args.image_path);
          }
          case "analyze":
            return await analyzeWorkflowAction(
              requireFilename("analyze", "the workflow library name to summarize"),
              args.view,
              args.section,
            );
          case "query": {
            const { action, filename, path, graph, format, image_path, view, section, node_id, ...query } =
              args;
            void action;
            void format;
            void image_path;
            void view;
            void section;
            void node_id;
            return await queryWorkflowAction(path, filename, graph, query);
          }
          case "prompt_director":
            return await promptDirectorInspectAction(args.node_id);
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown get_workflow action "${String(exhaustive)}". Expected one of: get, list, strip, slice, from_image, analyze, query, prompt_director.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "save_workflow",
    "WRITE to the ComfyUI user library: persist a workflow, or capture/verify its provenance lock. This is the only tool here that writes — reading is get_workflow. Driven by the `action` parameter:\n" +
      "- action:\"save\" — Save a workflow JSON to the connected ComfyUI server's user library so it appears in the ComfyUI web UI. Requires a running ComfyUI server; this writes to that server's userdata and OVERWRITES any existing file with the same filename without confirmation. Web-UI-format JSON ({ nodes: [], links: [] }) is saved as-is and is the preferred input — when re-saving an existing workflow, load it with get_workflow (action:\"get\", format='ui') and modify THAT. API-format graphs ({ '1': { class_type, inputs } }) are AUTO-CONVERTED to Web UI format with a generated layout so the saved file always opens in the ComfyUI canvas (the canvas cannot open raw API format). Returns a confirmation message (noting the conversion and any warnings), or the HTTP status and error text on failure.\n" +
      '- action:"lock" — Capture a provenance lock for a saved workflow so it can be exactly reproduced later. Walks the workflow\'s model loaders (CheckpointLoaderSimple, UNETLoader, VAELoader, LoraLoader, ControlNetLoader, etc.), SHA-256s every referenced model file, records the git commit currently checked out for every custom node pack the workflow\'s class_types come from, and captures ComfyUI\'s reported version. WRITES `<filename>.lock.json` next to the workflow in ComfyUI\'s user library. Requires a local install (COMFYUI_PATH) — SHA-256 needs raw file bytes and pack commits come from `custom_nodes/*/.git/HEAD`. Pair with action:"verify_lock" later to detect drift.\n' +
      '- action:"verify_lock" — Compare a saved workflow\'s lock file against the current state of the local install and report drift. Loads `<filename>.lock.json`, re-computes a current lock from the same workflow, and diffs: which models have a different SHA-256, which custom node packs are on a different commit, whether ComfyUI\'s version changed. Use before re-running an important workflow days or weeks later to confirm it\'ll behave the same. Requires a local install (COMFYUI_PATH). Read-only; returns a structured drift report (empty arrays everywhere mean perfect parity).',
    {
      action: z
        .enum(["save", "lock", "verify_lock"])
        .describe(
          'Which write/provenance operation to perform. All three require `filename`; "save" also requires `workflow`.',
        ),
      filename: z
        .string()
        .optional()
        .describe(
          "Workflow filename in the ComfyUI user library (e.g. 'my_workflow.json'). REQUIRED for every action. " +
            'For action:"save" this OVERWRITES an existing file of the same name; for "lock"/"verify_lock" the lock ' +
            "is read/written as '<filename>.lock.json' alongside it.",
        ),
      workflow: z
        .record(z.string(), z.any())
        .optional()
        .describe(
          'action:"save" (REQUIRED) — Workflow JSON to save. Web UI format ({ nodes: [], links: [] }) is stored verbatim; API format ({ \'1\': { class_type, inputs } }) is auto-converted to Web UI format (generated layout) so it stays openable in ComfyUI\'s canvas. Not validated against the server before saving.',
        ),
    },
    async (args) => {
      try {
        // `filename` is required by all three actions but cannot be schema-required
        // in a flat shape. ABSENCE only: `filename: ""` passed z.string() before and
        // reached the userdata POST/GET, which answers for itself.
        if (args.filename === undefined) {
          throw new Error(
            `save_workflow action:"${args.action}" requires \`filename\` — the workflow library name to write.`,
          );
        }
        switch (args.action) {
          case "save": {
            if (args.workflow === undefined) {
              throw new Error(
                'save_workflow action:"save" requires `workflow` — the workflow JSON to write.',
              );
            }
            return await saveWorkflowAction(args.filename, args.workflow);
          }
          case "lock":
            return await lockWorkflowAction(args.filename);
          case "verify_lock":
            return await verifyWorkflowLockAction(args.filename);
          default: {
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown save_workflow action "${String(exhaustive)}". Expected one of: save, lock, verify_lock.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}

/**
 * `format` carried two DIFFERENT enums before the fold — ui|api on the file read
 * that became action:"get", api|raw on the tool that became action:"strip" — so
 * the shared field is their union and each action rejects the member its own
 * tool never took. The refusal names the valid values; aliasing 'raw' onto 'ui'
 * (they are close, not equal) would answer a question the caller did not ask.
 */
function requireFormat<T extends string>(
  format: string | undefined,
  action: string,
  allowed: readonly T[],
): T {
  // `undefined` is the schema default "api", which both halves accept. The zod
  // layer normally supplies it, so this only matters for a caller that reaches
  // the handler without it — where refusing "undefined" would break every
  // default-format read rather than answering it.
  if (format === undefined) format = "api";
  if (!(allowed as readonly string[]).includes(format)) {
    throw new Error(
      `get_workflow action:"${action}" does not accept format:"${format}" — use ${allowed
        .map((f) => `"${f}"`)
        .join(" or ")}.`,
    );
  }
  return format as T;
}

/** `get_workflow (action:"list")` — the body of the retired library-listing tool. */
async function listWorkflowsAction(): Promise<TextResult> {
        // #810: the listing is RECURSIVE. Users organize the library into folders in
        // the web UI, and a shallow read reported six visible workflows as none.
        const listing = await listWorkflowLibraryKeys();

        if (!listing.ok) {
          // "Could not determine" must never be rendered as "determined there are
          // none" (#810). `absent` is the closest thing to a determined negative —
          // ComfyUI 404s the listing when the directory is not there — but it proves
          // the directory is missing NOW, not that nothing was ever saved, and not
          // that the request reached that handler at all. So it is reported as the
          // observation it is, with the one alternative explanation that would send
          // someone to recreate a workflow they still have.
          if (listing.kind === "absent") {
            return {
              content: [
                {
                  type: "text",
                  text:
                    // The status is the observation; "the directory is not there" is an
                    // INFERENCE from it, and a 404 from a proxy or a mismatched base path
                    // makes the same inference false (codex gate). State the one, offer
                    // the other as what it usually means, and keep them apart.
                    `No workflows to list: ${listing.detail} — the answer it gives for a directory it does ` +
                    `not have, usually because nothing has been saved into that library yet, in which case ` +
                    `save one from the ComfyUI web UI or with save_workflow. That status is all this call ` +
                    `observed, not a verdict on your library: the same 404 comes back when the server is ` +
                    `running with a different --user-directory, and when this call reached something other ` +
                    `than that ComfyUI's userdata API. If you expected workflows here, check the ComfyUI ` +
                    `sidebar first — do NOT recreate them on this result.`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text:
                  `Could NOT read the workflow library — ${listing.detail}. This is NOT "the library is ` +
                  `empty": workflows may well be saved on this server and this call cannot see them, so ` +
                  `do not create or overwrite one on the strength of this result. Check that the ComfyUI ` +
                  `server is up and reachable, then retry.`,
              },
            ],
          };
        }

        const files = [...listing.keys].sort((a, b) => a.localeCompare(b));
        // Entries the listing carried that this build could not turn into a name. Each
        // one is a workflow that EXISTS and is missing below, so it is stated rather
        // than dropped — and a listing of nothing BUT those is not an empty library.
        const unreadable =
          listing.unreadable > 0
            ? ` ${listing.unreadable} further entry(ies) came back in a shape this build does not recognise ` +
              `and could not be named, so this list may be short — read the ComfyUI sidebar for those.`
            : "";

        if (files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  listing.unreadable > 0
                    ? `Could NOT read the workflow library: the connected ComfyUI answered with ${listing.unreadable} ` +
                      `entry(ies) in a shape this build does not recognise, and none it could name. This is NOT ` +
                      `"the library is empty" — do not create or overwrite a workflow on the strength of it.`
                    : // An EMPTY list is the one answer that carries no evidence about its own
                      // coverage (independent gate P0). `recurse=true` says what was REQUESTED;
                      // a proxy, a shim or a handler that ignores it returns the top-level list,
                      // and with no names there is no separator to prove otherwise. So this is
                      // UNDETERMINED, not "none" — which is #810 itself, moved one layer out —
                      // and it is worded as the open question it is, with the check that
                      // settles it. Verdict headline deliberately withheld.
                      "Could NOT confirm the workflow library is empty: the connected ComfyUI answered the " +
                      "recursive listing with an empty list. That is what an empty library returns — and " +
                      "also what a responder that ignored `recurse` returns for a library whose workflows " +
                      "all live in folders. An empty answer carries no name to tell those apart, so this " +
                      "call cannot. CHECK THE COMFYUI SIDEBAR: if it lists workflows, this call is not " +
                      "reaching that ComfyUI (check the URL/port) and they are still there — do not " +
                      "recreate them. If it lists none, the library is genuinely empty; save one from the " +
                      "web UI or with save_workflow.",
              },
            ],
          };
        }

        // Deliberately UNCAPPED. For a listing, coverage IS the content: a name cut
        // off the end reads to the caller as "that workflow does not exist", which is
        // the very defect #810 is about, and one short line per file is a far cheaper
        // failure than sending someone to recreate a workflow they already have.
        const text = files
          .map((f, i) => `${i + 1}. ${f}`)
          .join("\n");

        // "Subfolders included" is a claim about the ANSWER, and asking for
        // `recurse=true` only proves what was requested (codex gate). A name carrying a
        // folder is the listing PROVING it recursed, so on that reply the claim is
        // observed rather than assumed. With every name at the root there is no such
        // proof — the usual reason is a flat library, and the message says which reading
        // to trust and how to tell, instead of asserting coverage it cannot see. The
        // predicate is the listing's own `recursionProven`, so this branch and the empty
        // one above cannot come to different conclusions from the same evidence.
        const coverage = listing.recursionProven
          ? " Subfolders ARE included: the names carrying one are this listing proving it recursed."
          : " Every name here sits at the library root, which this listing cannot tell apart from a" +
            " subfolder read that did not happen: the usual reading is that the library has no workflow" +
            " subfolders, and the other one is that something besides that ComfyUI's userdata API answered." +
            " If its sidebar DOES show folders, it is the second — check the URL/port.";

        return {
          content: [
            {
              type: "text",
              text:
                `Found ${files.length} workflow(s) — each name below is what get_workflow ` +
                `(action:"get" / "analyze" / "query") takes as \`filename\`.${coverage}${unreadable}\n\n${text}`,
            },
          ],
        };
}

/** `get_workflow (action:"get")` — the body of the surviving get_workflow tool. */
async function getWorkflowAction(filename: string, format: "ui" | "api"): Promise<TextResult> {
        const client = getClient();
        const encoded = encodeURIComponent(`workflows/${filename}`);
        const res = await client.fetchApi(
          `/api/userdata/${encoded}`,
        );

        if (!res.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Workflow not found: ${filename} (${res.status})`,
              },
            ],
          };
        }

        const raw = await res.json();

        // If API format requested and workflow is in UI format, convert
        if (format === "api" && isUiFormat(raw)) {
          const bulk = await getObjectInfo();
          // Backfill node types missing from the bulk /object_info (e.g.
          // controlnet_aux's DWPreprocessor) so the converter doesn't skip them.
          const objectInfo = await backfillObjectInfo(bulk, collectNodeTypes(raw));
          const { workflow, warnings } = convertUiToApi(raw, objectInfo);

          // Return the JSON workflow as the primary/first content block so
          // consumers that read the first text result always receive the graph
          // (not Markdown). Conversion warnings are appended as a separate
          // trailing block and never replace or precede the JSON (#494).
          const content: Array<{ type: "text"; text: string }> = [
            {
              type: "text",
              text: JSON.stringify(workflow, null, 2),
            },
          ];
          if (warnings.length > 0) {
            content.push({
              type: "text",
              text: `**Conversion warnings (${warnings.length}):**\n${warnings.map((w) => `- ${w}`).join("\n")}`,
            });
          }
          return { content };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(raw, null, 2),
            },
          ],
        };
}

/** `get_workflow (action:"strip")` — the body of the retired de-getter-setter tool. */
async function stripWorkflowAction(
  path: string | undefined,
  filename: string | undefined,
  graph: Record<string, unknown> | undefined,
  format: "api" | "raw",
): Promise<TextResult> {
        const raw = await loadRawFromSource(path, filename, graph);

        if (format === "raw" || !isUiFormat(raw)) {
          return { content: [{ type: "text", text: JSON.stringify(raw, null, 2) }] };
        }

        const bulk = await getObjectInfo();
        const objectInfo = await backfillObjectInfo(bulk, collectNodeTypes(raw));
        const { workflow, warnings } = convertUiToApi(raw, objectInfo);

        const hist: Record<string, number> = {};
        for (const node of Object.values(workflow)) {
          const t = (node as { class_type?: string }).class_type ?? "?";
          hist[t] = (hist[t] ?? 0) + 1;
        }
        const summary = Object.entries(hist)
          .sort((a, b) => b[1] - a[1])
          .map(([t, c]) => `${c}× ${t}`)
          .join(", ");

        return {
          content: [
            {
              type: "text",
              text:
                `Stripped to ${Object.keys(workflow).length} nodes` +
                (warnings.length ? ` · ⚠ ${warnings.length} conversion note(s)` : "") +
                `\nNode types: ${summary}` +
                // #361: these are the places the stripped graph does NOT match
                // the source (a dropped virtual link, a substituted widget
                // value). Label them as differences, not as background noise.
                (warnings.length
                  ? `\nThe stripped graph DIFFERS from the source workflow where listed below — read these before running or rebuilding from it:\n${warnings
                      .map((w) => `- ${w}`)
                      .join("\n")}`
                  : ""),
            },
            { type: "text", text: JSON.stringify(workflow, null, 2) },
          ],
        };
}

/** `get_workflow (action:"query")` — the body of the retired graph-query tool. */
async function queryWorkflowAction(
  path: string | undefined,
  filename: string | undefined,
  graph: Record<string, unknown> | undefined,
  query: Parameters<typeof queryApiGraph>[1],
): Promise<TextResult> {
        const raw = await loadRawFromSource(path, filename, graph);
        let api = raw;
        const notes: string[] = [];
        if (isUiFormat(raw)) {
          const bulk = await getObjectInfo();
          const objectInfo = await backfillObjectInfo(bulk, collectNodeTypes(raw));
          const converted = convertUiToApi(raw, objectInfo);
          api = converted.workflow;
          if (converted.warnings.length)
            notes.push(
              `${converted.warnings.length} conversion warning(s) — see get_workflow (action:"strip") for details`,
            );
        } else if (!isApiFormat(raw)) {
          throw new ValidationError("Not a recognizable workflow (neither UI nor API format).");
        }
        const result = queryApiGraph(api, query);
        return {
          content: [
            { type: "text", text: result.text + (notes.length ? `\n(${notes.join("; ")})` : "") },
          ],
        };
}

/** `get_workflow (action:"slice")` — the body of the retired pipeline-slicing tool. */
async function sliceWorkflowAction(
  path: string | undefined,
  filename: string | undefined,
  graph: Record<string, unknown> | undefined,
  groups: string | string[],
): Promise<TextResult> {
        const raw = await loadRawFromSource(path, filename, graph);

        const groupList = Array.isArray(groups) ? groups : String(groups).split(",");
        const { workflow, stats } = sliceWorkflow(raw, groupList);

        const flags =
          stats.badLinks || stats.orphanGets
            ? ` · ⚠ bad_links=${stats.badLinks} orphan_gets=${stats.orphanGets}`
            : "";
        return {
          content: [
            {
              type: "text",
              text:
                `Sliced ${stats.nodes} nodes (un-bypassed ${stats.unbypassed}), ${stats.links} links, ` +
                `${stats.subgraphs} subgraph def(s) · seeds=${stats.seeds}${flags}`,
            },
            { type: "text", text: JSON.stringify(workflow, null, 2) },
          ],
        };
}

/**
 * `save_workflow (action:"save")` — the body of the surviving save_workflow
 * tool. The one WRITE on this surface that a canvas-less client can reach; see
 * the action scope in src/orchestrator/call-tool-admission.ts.
 */
async function saveWorkflowAction(
  filename: string,
  workflowArg: Record<string, unknown>,
): Promise<TextResult> {
        const args = { filename, workflow: workflowArg };
        const client = getClient();
        const encoded = encodeURIComponent(`workflows/${args.filename}`);

        // API-format graphs can't be opened by the canvas — the #1 way agents
        // strand users with workflows that "exist" in the library yet load
        // blank. Auto-convert them to UI format with a generated layout; fall
        // back to a verbatim save (with the loud warning) only if conversion
        // itself fails.
        let toSave: unknown = args.workflow;
        let note = "";
        if (!isUiFormat(args.workflow) && isApiFormat(args.workflow)) {
          try {
            const apiGraph = args.workflow as WorkflowJSON;
            const bulk = await getObjectInfo();
            const objectInfo = await backfillObjectInfo(
              bulk,
              Object.values(apiGraph).map((n) => n.class_type),
            );
            const { workflow: ui, warnings } = convertApiToUi(apiGraph, objectInfo);
            toSave = ui;
            note =
              `\n\nℹ️ Input was API format — auto-converted to Web UI format (generated layout) ` +
              `so it opens in the ComfyUI canvas.`;
            if (warnings.length > 0) {
              note += `\nConversion warnings (${warnings.length}):\n${warnings.map((w) => `- ${w}`).join("\n")}`;
            }
          } catch (convErr) {
            note =
              `\n\n⚠️ Input was API format and auto-conversion to Web UI format failed ` +
              `(${convErr instanceof Error ? convErr.message : String(convErr)}) — saved verbatim. ` +
              `The ComfyUI canvas CANNOT open or edit this file. If it is meant to be reopened in ` +
              `the UI, rebuild it in Web UI format ({ nodes: [], links: [] }) — e.g. load the ` +
              `on-canvas graph or an existing file via get_workflow (action:"get", format="ui"), apply your ` +
              `changes to that, and save again.`;
          }
        } else if (!isUiFormat(args.workflow)) {
          note =
            `\n\n⚠️ This JSON is neither Web UI format ({ nodes: [], links: [] }) nor API format ` +
            `({ '1': { class_type, inputs } }) — saved verbatim, but the ComfyUI canvas likely ` +
            `cannot open it.`;
        }

        const res = await client.fetchApi(
          `/api/userdata/${encoded}`,
          {
            method: "POST",
            body: JSON.stringify(toSave),
          },
        );

        if (!res.ok) {
          // unknown-ok: "" is interpolated into an ERROR MESSAGE and nothing else — the
          // HTTP status is reported either way, so an unreadable body costs detail in the
          // text, never a wrong conclusion. Verified there is no branch on this value.
          const errText = await res.text().catch(() => "");
          return {
            content: [
              {
                type: "text",
                text: `Failed to save workflow: ${res.status} ${res.statusText}${errText ? `\n${errText}` : ""}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Workflow saved as "${args.filename}" in the ComfyUI user library.${note}`,
            },
          ],
        };
}

/** Load and convert a workflow from the library (shared by action:"analyze"). */
async function loadWorkflowApi(filename: string): Promise<{ workflow: WorkflowJSON; warnings: string[] }> {
  const client = getClient();
  const encoded = encodeURIComponent(`workflows/${filename}`);
  const res = await client.fetchApi(`/api/userdata/${encoded}`);

  if (!res.ok) {
    throw new ValidationError(`Workflow not found: ${filename} (${res.status})`);
  }

  const raw = await res.json();
  const objectInfo = await getObjectInfo();

  if (isUiFormat(raw)) {
    return convertUiToApi(raw, objectInfo);
  }

  // Already API format
  return { workflow: raw as WorkflowJSON, warnings: [] };
}

/** `get_workflow (action:"analyze")` — the body of the retired workflow-summary tool. */
async function analyzeWorkflowAction(
  filename: string,
  view: "summary" | "overview" | "detail" | "list" | "flat" | "health",
  section: string | undefined,
): Promise<TextResult> {
        logger.info(`Analyzing workflow: ${filename} (view=${view})`);
        const { workflow, warnings } = await loadWorkflowApi(filename);
        const objectInfo = await getObjectInfo();

        const nodeCount = Object.keys(workflow).length;
        if (nodeCount === 0) {
          throw new ValidationError("Workflow contains no nodes");
        }

        const content: Array<{ type: "text"; text: string }> = [];

        // Prepend warnings if any
        if (warnings.length > 0) {
          content.push({
            type: "text",
            text: `**Conversion warnings (${warnings.length}):**\n${warnings.map((w) => `- ${w}`).join("\n")}`,
          });
        }

        if (view === "flat") {
          // Simple mermaid flowchart — good for small workflows
          const mermaid = convertToMermaid(workflow, { showValues: true, direction: "LR" });
          content.push({ type: "text", text: `\`\`\`mermaid\n${mermaid}\n\`\`\`` });
          return { content };
        }

        if (view === "health") {
          const health = analyzeGraphHealth(workflow, objectInfo);
          const lines: string[] = ["### Graph health", `- ${health.summary}`];
          if (health.findings.length === 0) {
            lines.push("- No health issues found.");
          } else {
            for (const f of health.findings) {
              const tag = f.heuristic ? `${f.severity}, heuristic` : f.severity;
              lines.push(`- [${tag}] ${f.detail}`);
            }
          }
          content.push({ type: "text", text: lines.join("\n") });
          return { content };
        }

        // All other views need section detection
        const detection = detectSections(workflow, objectInfo);
        const { sections, virtualEdges, nodeToSection, getSetNodeIds } = detection;

        if (view === "summary") {
          const text = generateSummary(
            workflow, sections, objectInfo, virtualEdges, nodeToSection, getSetNodeIds,
          );
          content.push({ type: "text", text });
          return { content };
        }

        if (view === "list") {
          const text = listSections(workflow, sections);
          content.push({ type: "text", text });
          return { content };
        }

        if (view === "detail") {
          if (!section) {
            const available = [...sections.keys()].join(", ");
            throw new ValidationError(
              `section parameter is required for detail view. Available sections: ${available}`,
            );
          }
          const mermaid = generateSectionDetail(workflow, sections, section, {
            showValues: true,
            direction: "LR",
          });
          content.push({ type: "text", text: `\`\`\`mermaid\n${mermaid}\n\`\`\`` });
          return { content };
        }

        // overview
        const mermaid = generateOverview(workflow, sections, { direction: "TB" });
        content.push({ type: "text", text: `\`\`\`mermaid\n${mermaid}\n\`\`\`` });
        return { content };
}

/**
 * `get_workflow (action:"from_image")` — the body of the retired PNG-metadata
 * extraction tool, verbatim. It moved out of image-management.ts
 * because the ANSWER is a workflow, not an image: the caller is reverse-
 * engineering a graph, and every other way to reach one is an action here.
 */
async function workflowFromImageAction(imagePath: string): Promise<TextResult> {
  const result = await extractWorkflowFromImage(imagePath);
  const sections: string[] = [];
  if (result.prompt) {
    sections.push(
      "## API Format (prompt)\n\nThis is the executable workflow format:\n```json\n" +
        JSON.stringify(result.prompt, null, 2) +
        "\n```",
    );
  }
  if (result.workflow) {
    sections.push(
      "## UI Format (workflow)\n\nThis is the ComfyUI web UI format with layout data:\n```json\n" +
        JSON.stringify(result.workflow, null, 2) +
        "\n```",
    );
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `# Workflow extracted from ${imagePath}\n\n${sections.join("\n\n")}`,
      },
    ],
  };
}
