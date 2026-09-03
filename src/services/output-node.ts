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
  prompt_ids?: string[];
  queue_remaining?: number;
  rejectedOutputs?: string;
};

type ScopedEnqueueOutcome =
  | { result: ScopedEnqueueResult }
  | { refusal: string }
  | null;

type ScopedEnqueueOverride = (
  workflow: WorkflowJSON,
  targets: string[],
  batchCount: number,
) => Promise<ScopedEnqueueResult>;

let objectInfoOverride: ObjectInfo | null | undefined;
let enqueueScopedOutputNodeOverride:
  | ScopedEnqueueOverride
  | null = null;

/** Test seam: overlay / recovery object_info without a live ComfyUI. */
export function setOutputNodeObjectInfoForTests(
  info: ObjectInfo | null | undefined,
): void {
  objectInfoOverride = info;
}

/** Test seam: HTTP `/prompt` fallback without posting to a real ComfyUI. */
export function setEnqueueScopedOutputNodeForTests(
  fn: ScopedEnqueueOverride | null,
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

function nodeClassType(node: unknown): string | null {
  const record = asRecord(node);
  if (!record) return null;
  if (typeof record.type === "string" && record.type) return record.type;
  if (typeof record.class_type === "string" && record.class_type) return record.class_type;
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

function containsUnstampedNode(value: unknown, depth = 0): boolean {
  if (depth > 8 || value == null) return false;
  if (Array.isArray(value)) return value.some((item) => containsUnstampedNode(item, depth + 1));
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return false;
    try {
      return containsUnstampedNode(JSON.parse(trimmed) as unknown, depth + 1);
    } catch {
      return false;
    }
  }
  const record = asRecord(value);
  if (!record) return false;
  if (nodeClassType(record) && !("is_output" in record)) return true;
  return Object.values(record).some((nested) => containsUnstampedNode(nested, depth + 1));
}

/** Use the fresh headless cache, or refresh the panel only when its reply has
 * node rows whose output classification is absent. */
export async function outputNodeObjectInfoForPanel(
  call: GraphCall,
  source?: ToolResultLike,
): Promise<ObjectInfo | null> {
  if (!source || source.isError || !containsUnstampedNode(parseToolResultJson(source))) return null;
  return outputNodeObjectInfoNow() ?? fetchPanelObjectInfo(call);
}

function uiWorkflowFromSerialize(payload: Record<string, unknown> | null): UiWorkflow | null {
  if (!payload) return null;
  const inner = payload.workflow ?? payload;
  return isUiFormat(inner) ? inner : null;
}

function workflowUuidFromUi(ui: UiWorkflow): string | null {
  const extra = asRecord(ui.extra);
  const metadata = asRecord(extra?.comfyui_mcp);
  const uuid = metadata?.workflow_uuid;
  return typeof uuid === "string" && uuid.length > 0 ? uuid : null;
}

function scopedFallbackRefusal(reason: string): { refusal: string } {
  return { refusal: reason };
}

function rootScopedFallbackWitness(
  payload: Record<string, unknown> | null,
  ui: UiWorkflow,
  toNodeId: number,
  classType: string,
): { targetId: string } | { refusal: string } {
  const viewing = asRecord(payload?.viewing);
  if (viewing?.scope === "subgraph") {
    return scopedFallbackRefusal(
      `the panel reports the target is in a subgraph, but its exact colon-qualified ` +
        `NodeExecutionId is not exposed to MCP; the panel retry must perform this nested run`,
    );
  }
  if (viewing?.scope !== "root") {
    return scopedFallbackRefusal(
      `the panel did not provide a root viewing-scope witness, so the workflow target is ` +
        `unproven`,
    );
  }

  const panelUuid = viewing.workflow_uuid;
  const serializedUuid = workflowUuidFromUi(ui);
  if (
    typeof panelUuid !== "string" ||
    panelUuid.length === 0 ||
    serializedUuid === null ||
    panelUuid !== serializedUuid
  ) {
    return scopedFallbackRefusal(
      `the panel graph and serialized workflow did not carry the same workflow identity; ` +
        `no fallback prompt was sent`,
    );
  }

  const targetId = String(toNodeId);
  const rootNode = ui.nodes.find(
    (node) => String(node.id) === targetId && nodeClassType(node) === classType,
  );
  if (!rootNode) {
    return scopedFallbackRefusal(
      `node ${targetId} is not present as the requested class on the serialized root ` +
        `graph; an exact scoped target could not be proven`,
    );
  }

  const queriedNodes = payload?.nodes;
  if (
    !Array.isArray(queriedNodes) ||
    !queriedNodes.some((raw) => {
      const node = asRecord(raw);
      return node !== null && String(node.id) === targetId && nodeClassType(node) === classType;
    })
  ) {
    return scopedFallbackRefusal(
      `the panel's current root query did not return node ${targetId} as ` +
        `${classType}; the target may have moved or changed`,
    );
  }
  return { targetId };
}

function normalizedBatchCount(batchCount: number | undefined): number {
  if (typeof batchCount !== "number" || !Number.isFinite(batchCount)) return 1;
  return Math.max(1, Math.min(100, Math.floor(batchCount)));
}

async function enqueueConvertedScopedRun(
  toNodeId: number,
  classType: string,
  objectInfo: ObjectInfo,
  call: GraphCall,
  batchCount: number | undefined,
  directFallbackAllowed: boolean,
): Promise<ScopedEnqueueOutcome> {
  if (!directFallbackAllowed) {
    return scopedFallbackRefusal(
      `the panel's server-observed origin was not proven to be the configured ComfyUI ` +
        `target; direct /prompt fallback is disabled to prevent cross-instance queueing`,
    );
  }

  const serialized = await call({ cmd: "graph_serialize" }, 8000);
  if (serialized.isError) return null;
  const ui = uiWorkflowFromSerialize(parseToolResultJson(serialized));
  if (!ui) return null;
  const queried = await call(
    { cmd: "graph_query", ids: [toNodeId], fields: "detail", limit: 1 },
    8000,
  );
  if (queried.isError) return null;
  const witness = rootScopedFallbackWitness(
    parseToolResultJson(queried),
    ui,
    toNodeId,
    classType,
  );
  if ("refusal" in witness) return witness;

  const targets = [witness.targetId];
  const converted = convertUiToApi(ui, objectInfo);
  if (!converted.workflow[witness.targetId]) {
    return scopedFallbackRefusal(
      `the converted workflow did not contain root target ${witness.targetId}; ` +
        `no unscoped prompt was sent`,
    );
  }

  const count = normalizedBatchCount(batchCount);
  if (enqueueScopedOutputNodeOverride) {
    return {
      result: await enqueueScopedOutputNodeOverride(converted.workflow, targets, count),
    };
  }

  const results: ScopedEnqueueResult[] = [];
  try {
    for (let i = 0; i < count; i += 1) {
      results.push(
        await enqueuePrompt(converted.workflow, undefined, {
          partialExecutionTargets: targets,
        }),
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${message} Direct scoped fallback had already accepted ${results.length} of ` +
        `${count} requested batch run(s); do not blindly re-submit before checking ` +
        `queue/history.`,
    );
  }

  return {
    result: {
      prompt_id: results[0].prompt_id,
      ...(results.length > 1
        ? { prompt_ids: results.map((entry) => entry.prompt_id) }
        : {}),
      queue_remaining: results.at(-1)?.queue_remaining,
      ...(results.some((entry) => entry.rejectedOutputs)
        ? {
            rejectedOutputs: results
              .map((entry) => entry.rejectedOutputs)
              .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
              .join("\n"),
          }
        : {}),
    },
  };
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
            ...(enqueued.prompt_ids && enqueued.prompt_ids.length > 1
              ? { prompt_ids: enqueued.prompt_ids }
              : {}),
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
  directFallbackAllowed?: boolean;
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
      opts.batchCount,
      opts.directFallbackAllowed === true,
    );
    if (!enqueued) return null;
    if ("refusal" in enqueued) {
      return {
        content: [
          {
            type: "text",
            text:
              `Error: panel_run recognized ${parsed.classType} as an OUTPUT_NODE from ` +
              `the connected panel's object_info, but refused the direct /prompt fallback: ` +
              `${enqueued.refusal}. No fallback prompt was sent.`,
          },
        ],
        isError: true,
      };
    }
    if (!enqueued.result?.prompt_id) return null;
    return queuedToolResult(enqueued.result, opts.toNodeId, parsed.classType);
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
