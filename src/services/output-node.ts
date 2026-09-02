/**
 * #2529 — terminal-output classification from live `/object_info` `output_node`.
 *
 * ComfyUI's backend executes any class with `OUTPUT_NODE = True`. The panel's
 * run-to-node guard keys `node.constructor.nodeData.output_node` instead, which
 * is missing on some custom frontend classes (VHS_VideoCombine) even when the
 * backend metadata is true. Classify from object_info — never a name list.
 */

import type { ObjectInfo, UiWorkflow, WorkflowJSON } from "../comfyui/types.js";
import { enqueuePrompt, peekObjectInfoCache } from "../comfyui/client.js";
import { convertUiToApi, isUiFormat } from "./workflow-converter.js";

export const NOT_OUTPUT_NODE_RE =
  /node\s+(\d+)\s+\(([^)]+)\)\s+is not an output node/i;

export type NotOutputNodeRefusal = {
  nodeId: number;
  classType: string;
};

export type ToolResultLike = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

type GraphCall = (
  cmd: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<ToolResultLike>;

type ScopedEnqueueResult = {
  prompt_id: string;
  queue_remaining?: number;
  rejectedOutputs?: string;
};

let objectInfoOverride: ObjectInfo | null | undefined;
let enqueueScopedOutputNodeOverride:
  | ((
      workflow: WorkflowJSON,
      targets: string[],
    ) => Promise<{ prompt_id: string }>)
  | null = null;

/** Test seam: overlay / recovery object_info without a live ComfyUI. */
export function setOutputNodeObjectInfoForTests(
  info: ObjectInfo | null | undefined,
): void {
  objectInfoOverride = info;
}

/** Test seam: HTTP `/prompt` fallback without posting to a real ComfyUI. */
export function setEnqueueScopedOutputNodeForTests(
  fn:
    | ((
        workflow: WorkflowJSON,
        targets: string[],
      ) => Promise<{ prompt_id: string }>)
    | null,
): void {
  enqueueScopedOutputNodeOverride = fn;
}

export function outputNodeObjectInfoNow(): ObjectInfo | null {
  if (objectInfoOverride !== undefined) return objectInfoOverride;
  return peekObjectInfoCache();
}

export function isOutputNodeType(
  classType: string,
  objectInfo: ObjectInfo | null | undefined,
): boolean {
  if (!classType || !objectInfo) return false;
  return objectInfo[classType]?.output_node === true;
}

export function toolResultText(res: ToolResultLike): string {
  return (res.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function parseToolResultJson(
  res: ToolResultLike,
): Record<string, unknown> | null {
  const text = res.content.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

export function parseNotOutputNodeRefusal(
  source: string | ToolResultLike,
): NotOutputNodeRefusal | null {
  const text = typeof source === "string" ? source : toolResultText(source);
  const m = text.match(NOT_OUTPUT_NODE_RE);
  if (!m) return null;
  const nodeId = Number(m[1]);
  const classType = m[2]?.trim() ?? "";
  if (!Number.isInteger(nodeId) || !classType) return null;
  return { nodeId, classType };
}

function nodeClassType(node: Record<string, unknown>): string | null {
  if (typeof node.type === "string" && node.type) return node.type;
  if (typeof node.class_type === "string" && node.class_type) return node.class_type;
  return null;
}

function stampNode(node: Record<string, unknown>, objectInfo: ObjectInfo): void {
  const classType = nodeClassType(node);
  if (!classType) return;
  if (isOutputNodeType(classType, objectInfo)) node.is_output = true;
}

function stampValue(value: unknown, objectInfo: ObjectInfo, depth: number): void {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) stampValue(item, objectInfo, depth + 1);
    return;
  }
  const rec = asRecord(value);
  if (!rec) return;
  stampNode(rec, objectInfo);
  for (const nested of Object.values(rec)) stampValue(nested, objectInfo, depth + 1);
}

function stampJsonLines(text: string, objectInfo: ObjectInfo): string {
  const lines = text.split("\n");
  let changed = false;
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return line;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const rec = asRecord(parsed);
      if (!rec) return line;
      const before = rec.is_output;
      stampNode(rec, objectInfo);
      if (rec.is_output === before) return line;
      changed = true;
      return JSON.stringify(rec);
    } catch {
      return line;
    }
  });
  return changed ? out.join("\n") : text;
}

/**
 * Add `is_output:true` on live-graph rows whose class has `output_node:true`
 * in object_info. Does not invent `is_output:false`.
 */
export function stampOutputNodeFlags(
  payload: Record<string, unknown>,
  objectInfo: ObjectInfo | null | undefined,
): Record<string, unknown> {
  if (!objectInfo) return payload;
  stampValue(payload, objectInfo, 0);
  if (typeof payload.text === "string") {
    payload.text = stampJsonLines(payload.text, objectInfo);
  }
  return payload;
}

export function stampOutputNodeFlagsOnToolResult<T extends ToolResultLike>(
  res: T,
  objectInfo: ObjectInfo | null | undefined,
): T {
  if (!objectInfo || res.isError) return res;
  const payload = parseToolResultJson(res);
  if (!payload) return res;
  const stamped = stampOutputNodeFlags(payload, objectInfo);
  const idx = res.content.findIndex((c) => c.type === "text");
  if (idx < 0) return res;
  return {
    ...res,
    content: res.content.map((c, i) =>
      i === idx && c.type === "text"
        ? { ...c, text: JSON.stringify(stamped, null, 2) }
        : c,
    ),
  };
}

function objectInfoFromReply(reply: unknown): ObjectInfo | null {
  const rec = asRecord(reply);
  if (!rec) return null;
  const info = rec.object_info ?? rec;
  const map = asRecord(info);
  if (!map) return null;
  for (const def of Object.values(map)) {
    const node = asRecord(def);
    if (node && ("input" in node || "output" in node || "output_node" in node)) {
      return map as ObjectInfo;
    }
  }
  return null;
}

async function fetchPanelObjectInfo(call: GraphCall): Promise<ObjectInfo | null> {
  if (objectInfoOverride !== undefined) return objectInfoOverride;
  try {
    const reply = await call({ cmd: "graph_get_object_info" }, 90_000);
    if (reply.isError) return null;
    return objectInfoFromReply(parseToolResultJson(reply));
  } catch {
    return null;
  }
}

function uiWorkflowFromSerialize(payload: Record<string, unknown> | null): UiWorkflow | null {
  if (!payload) return null;
  const inner = payload.workflow ?? payload;
  return isUiFormat(inner) ? inner : null;
}

async function enqueueConvertedScopedRun(
  toNodeId: number,
  classType: string,
  objectInfo: ObjectInfo,
  call: GraphCall,
): Promise<ScopedEnqueueResult | null> {
  const targetId = String(toNodeId);
  const targets = [targetId];
  if (enqueueScopedOutputNodeOverride) {
    return enqueueScopedOutputNodeOverride(
      { [targetId]: { class_type: classType, inputs: {} } },
      targets,
    );
  }
  const serialized = await call({ cmd: "graph_serialize" }, 8000);
  if (serialized.isError) return null;
  const ui = uiWorkflowFromSerialize(parseToolResultJson(serialized));
  if (!ui) return null;
  const converted = convertUiToApi(ui, objectInfo);
  if (!converted.workflow[targetId]) return null;
  return enqueuePrompt(converted.workflow, undefined, {
    partialExecutionTargets: targets,
  });
}

function queuedToolResult(
  enqueued: ScopedEnqueueResult,
  toNodeId: number,
  classType: string,
): ToolResultLike {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            queued: true,
            prompt_id: enqueued.prompt_id,
            to_node_id: toNodeId,
            ran_to_node: toNodeId,
            output_node_source: "object_info",
            output_node_class: classType,
            ...(enqueued.queue_remaining === undefined
              ? {}
              : { queue_remaining: enqueued.queue_remaining }),
            ...(enqueued.rejectedOutputs
              ? { rejected_outputs: enqueued.rejectedOutputs }
              : {}),
          },
          null,
          2,
        ),
      },
    ],
  };
}

/**
 * When the panel refuses a scoped run as "not an output node", consult live
 * object_info. If that class is `output_node:true`, retry graph_run (newer
 * panels can honor `output_node:true`) and fall back to `/prompt` with
 * `partial_execution_targets` — the field ComfyUI itself uses for run-to-node.
 */
export async function recoverOutputNodeScopedRun(opts: {
  toNodeId: number;
  res: ToolResultLike;
  rejection: ToolResultLike;
  batchCount?: number;
  call: GraphCall;
}): Promise<ToolResultLike | null> {
  const parsed =
    parseNotOutputNodeRefusal(opts.rejection) ??
    parseNotOutputNodeRefusal(opts.res);
  if (!parsed || parsed.nodeId !== opts.toNodeId) return null;

  const objectInfo = await fetchPanelObjectInfo(opts.call);
  if (!isOutputNodeType(parsed.classType, objectInfo) || !objectInfo) return null;

  let retry: ToolResultLike;
  try {
    retry = await opts.call(
      {
        cmd: "graph_run",
        batch_count: opts.batchCount,
        to_node_id: opts.toNodeId,
        output_node: true,
      },
      20_000,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text:
            `Error: panel_run's OUTPUT_NODE recovery retry for ${parsed.classType} ` +
            `failed before a reply could be read; its outcome is UNKNOWN and it may ` +
            `have queued a render. Check queue (action:"list") or get_history before ` +
            `re-submitting. (${message})`,
        },
      ],
      isError: true,
    };
  }
  const retryParsed = parseToolResultJson(retry);
  if (
    !retry.isError &&
    retryParsed?.queued !== false &&
    (retryParsed?.queued === true || typeof retryParsed?.prompt_id === "string")
  ) {
    return retry;
  }
  if (!parseNotOutputNodeRefusal(retry)) {
    // A different failure (validation, transport) — surface it rather than
    // enqueueing a second prompt.
    return retry;
  }

  try {
    const enqueued = await enqueueConvertedScopedRun(
      opts.toNodeId,
      parsed.classType,
      objectInfo,
      opts.call,
    );
    if (!enqueued?.prompt_id) return null;
    return queuedToolResult(enqueued, opts.toNodeId, parsed.classType);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text:
            `Error: panel_run recovered ${parsed.classType} as an OUTPUT_NODE from ` +
            `the connected panel's object_info, but the direct /prompt fallback failed: ` +
            `${message}`,
        },
      ],
      isError: true,
    };
  }
}
