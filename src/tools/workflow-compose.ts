import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ComfyUINodeDef, WorkflowJSON } from "../comfyui/types.js";
import {
  createWorkflow,
  modifyWorkflow,
  TEMPLATE_NAMES,
  type ModifyOperation,
} from "../services/workflow-composer.js";
import { getObjectInfo, backfillObjectInfo, resetObjectInfoCache } from "../comfyui/client.js";
import { validateWorkflowAction } from "./workflow-validate.js";
import { errorToToolResult, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

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

const operationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_input"),
    node_id: z.string(),
    input_name: z.string(),
    value: z.any(),
  }),
  z.object({
    op: z.literal("add_node"),
    class_type: z.string(),
    inputs: z.record(z.string(), z.any()).optional(),
    id: z.string().optional(),
  }),
  z.object({
    op: z.literal("remove_node"),
    node_id: z.string(),
  }),
  z.object({
    op: z.literal("connect"),
    source_id: z.string(),
    output_index: z.number(),
    target_id: z.string(),
    input_name: z.string(),
  }),
  z.object({
    op: z.literal("insert_between"),
    source_id: z.string(),
    output_index: z.number(),
    target_id: z.string(),
    input_name: z.string(),
    new_class_type: z.string(),
    new_inputs: z.record(z.string(), z.any()).optional(),
  }),
]);

/**
 * The four workflow-AUTHORING tools collapsed into one action-parameterized
 * `create_workflow` tool (0.50.0 surface consolidation, slice 14): create,
 * modify, validate and node_info. `create_workflow` is the survivor and keeps
 * its registration slot; the three retired names and their replacements are the
 * ledger's business (DEAD_NAMES in src/tools/vocabulary.ts).
 *
 * One work-domain: authoring a graph, and the schema lookup you make WHILE
 * authoring it. `node_info` belongs here rather than under a diagnostics tool
 * because its callers are the ones about to `create`/`modify` — the description
 * of the node you are wiring.
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required — `template` is required
 * for create, `workflow` for modify/validate, `operations` for modify, and none
 * of them for node_info. Every VALUE constraint stays at the zod layer
 * (`template` keeps its TEMPLATE_NAMES enum, `operations` its per-op
 * discriminated union, and the defaults that shipped — params {}, health true,
 * verbose/refresh false — are unchanged), and per-action PRESENCE is enforced in
 * the handler, which NAMES the missing field. The guards test ABSENCE, not
 * falsiness: `workflow: ""` passed the old z.union before and reached
 * parseWorkflow's own "Invalid JSON string" error, and still does.
 *
 * Each branch calls the identical function the old tool called, with the same
 * arguments, and returns the identical content block. `validate` lives in
 * workflow-validate.ts, which no longer registers a tool of its own.
 */
export function registerWorkflowComposeTools(server: McpServer): void {
  server.tool(
    "create_workflow",
    "Author and check ComfyUI workflow JSON. Driven by the `action` parameter:\n" +
      `- action:"create" — Create a ready-to-run API-format workflow from a built-in template (${TEMPLATE_NAMES.join(", ")}). Pure local generation — does not contact ComfyUI and has no side effects. Returns the complete workflow JSON; pass it to action:"validate" or enqueue_workflow. Unsupplied \`params\` fall back to template defaults, so the result may reference checkpoints/models that must exist on your ComfyUI server before it will execute.\n` +
      '- action:"modify" — Apply modification `operations` to an existing workflow. Supports: set_input, add_node, remove_node, connect, insert_between. Returns the modified workflow JSON and IDs of any newly added nodes.\n' +
      '- action:"validate" — Validate a workflow WITHOUT executing it. Checks for missing node types, broken connections, invalid output indices, missing models, and other issues. Returns a list of errors and warnings.\n' +
      '- action:"node_info" — Query a running ComfyUI server\'s /object_info endpoint for installed node type definitions. Requires a reachable ComfyUI instance; results reflect that server\'s installed custom nodes. Use the `node_type` filter to inspect a specific node before composing or modifying a workflow. Default response is a STRUCTURAL summary: input/output names and type tags, with enum (dropdown) inputs collapsed to a value count — safe for context even on Loader nodes whose model dropdowns embed the entire local model list (hundreds of KB raw). Pass verbose=true (20 or fewer matches) for the complete raw definitions including every dropdown value. When more than 20 node types match, returns only a name/category list and asks you to narrow the filter.',
    {
      action: z
        .enum(["create", "modify", "validate", "node_info"])
        .describe(
          'Which authoring operation to perform. "create" requires `template` (optional `params`); ' +
            '"modify" requires `workflow` + `operations`; "validate" requires `workflow` (optional `health`); ' +
            '"node_info" takes no required parameters (optional `node_type`, `verbose`, `refresh`).',
        ),
      template: z
        .enum(TEMPLATE_NAMES as [string, ...string[]])
        .optional()
        // Interpolated, not hand-listed. The hand-written version said "txt2img, img2img,
        // upscale, or inpaint" long after the set grew to ten, and it reads as exhaustive —
        // so an agent never tried the six it did not name. The enum above is already built
        // from TEMPLATE_NAMES; the prose now comes from the same source.
        .describe(
          `action:"create" (REQUIRED) — Template name, one of: ${TEMPLATE_NAMES.join(", ")}`,
        ),
      params: z
        .record(z.string(), z.any())
        .optional()
        .default({})
        .describe(
          'action:"create" — Template parameters; recognized keys depend on the template. txt2img: checkpoint, positive_prompt, negative_prompt, width, height, steps, cfg, seed, sampler_name, scheduler. img2img/inpaint add image_path (and mask_path for inpaint) and denoise. upscale adds upscale_model. Unknown keys are ignored; omitted keys use template defaults.',
        ),
      workflow: z
        .union([z.string(), z.record(z.string(), z.any())])
        .optional()
        .describe(
          'ComfyUI workflow JSON (as a JSON string or object). REQUIRED for action:"modify" and action:"validate". action:"validate" accepts API format or a saved UI export (nodes[]/links[]).',
        ),
      operations: z
        .array(operationSchema)
        .optional()
        .describe(
          'action:"modify" (REQUIRED) — Array of operations to apply in order. Each has an \'op\' field: set_input, add_node, remove_node, connect, or insert_between',
        ),
      health: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'action:"validate" — Include graph-health heuristics (disconnected nodes, duplicate model loads, orphaned branches, muted/bypassed nodes) as info/warning issues plus a structured health section. Never affects `valid`.',
        ),
      node_type: z
        .string()
        .optional()
        .describe(
          'action:"node_info" — Filter by node class_type name (case-insensitive substring match). Omit to list all available nodes.',
        ),
      verbose: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'action:"node_info" — If true, return the full raw /object_info definitions including enum dropdown ' +
            "values (model lists etc.) — can be hundreds of KB per Loader node, so only use " +
            "it when you need the actual enum values (e.g. exact model filenames) and the " +
            "filter matches few nodes. Default false: structural summary with enum value counts.",
        ),
      refresh: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'action:"node_info" — If true, discard the memoized /object_info snapshot and refetch live from the ' +
            "connected server before answering. Use after the ComfyUI server was restarted " +
            "EXTERNALLY (systemd/service manager) or new model files were added out-of-band — " +
            "the cache is otherwise only invalidated by MCP-managed restarts, so loader " +
            "dropdowns (model lists) would remain stale for the rest of the session (#499).",
        ),
    },
    async (args) => {
      try {
        // `template`/`workflow`/`operations` cannot be schema-required in a flat
        // shape, so the handler enforces per-action presence and NAMES the missing
        // field — the same information the old per-tool schemas gave a caller.
        //
        // ABSENCE only, never falsiness: `workflow: ""` passed z.union([z.string(),
        // …]) before this consolidation and reached parseWorkflow, which answers
        // with its own "Invalid JSON string" error. A `!workflow` guard would
        // swallow that path and substitute generic text.
        const requireWorkflow = (action: string, what: string): unknown => {
          if (args.workflow === undefined) {
            throw new Error(`create_workflow action:"${action}" requires \`workflow\` — ${what}.`);
          }
          return args.workflow;
        };

        switch (args.action) {
          case "create": {
            if (args.template === undefined) {
              throw new Error(
                `create_workflow action:"create" requires \`template\` — one of: ${TEMPLATE_NAMES.join(", ")}.`,
              );
            }
            logger.info("Creating workflow", { template: args.template, params: args.params });
            const workflow = createWorkflow(args.template, args.params);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(workflow, null, 2),
                },
              ],
            };
          }
          case "modify": {
            const input = requireWorkflow("modify", "the workflow JSON to modify");
            if (args.operations === undefined) {
              throw new Error(
                'create_workflow action:"modify" requires `operations` — an array of set_input / add_node / remove_node / connect / insert_between ops.',
              );
            }
            logger.info("Modifying workflow", { opCount: args.operations.length });
            const parsed = parseWorkflow(input);
            const result = modifyWorkflow(parsed, args.operations as ModifyOperation[]);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      workflow: result.workflow,
                      added_node_ids: result.added_ids,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          case "validate":
            return await validateWorkflowAction({
              workflow: requireWorkflow("validate", "the workflow JSON to check"),
              health: args.health,
            });
          case "node_info":
            return await nodeInfoAction(args.node_type, args.verbose, args.refresh);
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown create_workflow action "${String(exhaustive)}". Expected one of: create, modify, validate, node_info.`,
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
 * `create_workflow (action:"node_info")` — the body of the retired
 * node-schema lookup tool, verbatim. Same cache reset, same getObjectInfo /
 * backfillObjectInfo calls, same >20 / verbose / summary branches.
 */
async function nodeInfoAction(
  node_type: string | undefined,
  verbose: boolean | undefined,
  refresh: boolean | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  logger.info("Getting node info", { filter: node_type, verbose, refresh });
  // #499: an external (non-MCP) restart or an out-of-band model install
  // leaves the memoized /object_info snapshot stale, silently serving
  // pre-restart loader dropdowns. `refresh` forces a fresh live fetch so
  // newly installed model files show up in the returned combos.
  if (refresh) resetObjectInfoCache();
  let info = await getObjectInfo();

  let entries = Object.entries(info);
  if (node_type) {
    const lower = node_type.toLowerCase();
    entries = entries.filter(([name]) => name.toLowerCase().includes(lower));

    // Some nodes register individually (`/object_info/<Type>` returns a
    // schema) but are absent from the bulk `/object_info` payload — seen
    // with controlnet_aux's DWPreprocessor and with V3-API packs like
    // comfyui-qwenmultiangle whose nodes the live canvas and panel
    // recognize but the bulk query omits (#357). When the substring
    // filter finds nothing, try backfilling the exact type by its own
    // endpoint before reporting it missing.
    if (entries.length === 0) {
      info = await backfillObjectInfo(info, [node_type]);
      entries = Object.entries(info).filter(([name]) =>
        name.toLowerCase().includes(lower),
      );
    }
  }

  if (entries.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: node_type
            ? `No nodes found matching "${node_type}"`
            : "No node definitions returned from ComfyUI",
        },
      ],
    };
  }

  // For large result sets, return just names + descriptions
  if (entries.length > 20) {
    const summary = entries.map(([name, def]) => ({
      name,
      display_name: def.display_name,
      category: def.category,
      description: def.description || "",
    }));
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              count: summary.length,
              nodes: summary,
              hint: "Use a more specific node_type filter to see full definitions with inputs/outputs",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  // verbose=true restores the pre-summary behavior: full raw definitions
  // (only reachable at <=20 matches, same threshold as before).
  if (verbose) {
    const result = Object.fromEntries(entries);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  // Default: structural summary. Keeps input/output names and type tags but
  // collapses enum dropdowns to a value count — Loader nodes embed the entire
  // local model list in their dropdowns, so a raw dump can be 100s of KB.
  const summary = entries.map(([name, def]) => summarizeNodeDef(name, def));
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            count: summary.length,
            nodes: summary,
            hint: "Structural summary (enum dropdown values collapsed to counts). Pass verbose=true for full definitions including dropdown values.",
          },
          null,
          2,
        ),
      },
    ],
  };
}

// ── node_info structural summary ─────────────────────────────────────────────
// Summary-by-default (with verbose opt-out) originally contributed by
// @joaolvivas in `joaolvivas/comfyui-mcp-byjlucas@de82ecd` and reimplemented
// here with thanks — the motivating case was Loader nodes (UNETLoader,
// CheckpointLoaderSimple, LoraLoader, …) whose model dropdowns embed the full
// local model list, producing multi-hundred-KB /object_info dumps per node.

/** Collapse one input-spec map to `{ name: typeTag }`, dropping enum value lists. */
function summarizeInputSpecs(
  specs: Record<string, unknown> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(specs ?? {}).map(([inputName, spec]) => {
      // Spec shape is [typeOrEnumValues, options?]; enum inputs carry the full
      // value array in slot 0 — that array is what makes Loader nodes huge.
      if (Array.isArray(spec)) {
        const first = spec[0];
        if (Array.isArray(first)) {
          return [inputName, `enum(${first.length} values)`];
        }
        return [inputName, String(first)];
      }
      return [inputName, typeof spec];
    }),
  );
}

/** Structural summary of a node definition: names + type tags, no dropdown values. */
export function summarizeNodeDef(
  name: string,
  def: ComfyUINodeDef,
): Record<string, unknown> {
  return {
    name,
    display_name: def.display_name,
    category: def.category,
    description: def.description || "",
    input_required: summarizeInputSpecs(def.input?.required),
    input_optional: summarizeInputSpecs(def.input?.optional),
    output_types: def.output ?? [],
    output_names: def.output_name ?? [],
  };
}
