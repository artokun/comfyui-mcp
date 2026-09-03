/**
 * #2778 — `panel_connect` can refuse an exposed subgraph INT rail onto another
 * INT widget input (`Scene Seed` → LocalWildcardText.seed) while the same rail
 * already feeds KSampler.seed / FaceDetailer.seed.
 *
 * The panel reports "INT is not compatible with INT". The live rail socket still
 * carries the object_info widget spec (`["INT", { min, max, step }]`) or its
 * `Array.toString()` form `INT,[object Object]`. Shared slot-compat treated that
 * array as a COMBO, so a scalar INT looked like a different type.
 *
 * Normalize both socket types, then retry once with explicit slots when they
 * rank as compatible. A real MODEL→CLIP (or COMBO vs INT) refusal is left alone.
 */

import { canonicalConnectNodeId, type ConnectArgs, type GraphCall, type ToolResultLike } from "./connect-live-graph.js";
import { isTypeCompatible } from "./slot-compat.js";

const CONNECT_REFUSED_RE = /connect refused/i;
const QUOTED_RE =
  /subgraph input "([^"]+)" \(([^)]+)\) is not compatible with node (\S+) input "([^"]+)" \(([^)]+)\)/i;
const BARE_RE =
  /subgraph input ([^(]+?) \(([^)]+)\) is not compatible with node (\S+) input ([^(]+?) \(([^)]+)\)/i;

const DETAIL_MAX_CHARS = 60000;
const DETAIL_TIMEOUT_MS = 8000;

export type SubgraphInputTypeRefusal = {
  railName: string;
  railType: string;
  nodeId: string;
  inputName: string;
  inputType: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toolText(res: ToolResultLike): string {
  return res.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

function parseJsonPayload(res: ToolResultLike): Record<string, unknown> | null {
  if (res.isError) return null;
  const text = res.content.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

export function subgraphInputTypeRefusal(text: string): SubgraphInputTypeRefusal | null {
  if (!CONNECT_REFUSED_RE.test(text)) return null;
  const quoted = QUOTED_RE.exec(text);
  if (quoted) {
    return {
      railName: quoted[1] ?? "",
      railType: quoted[2] ?? "",
      nodeId: quoted[3] ?? "",
      inputName: quoted[4] ?? "",
      inputType: quoted[5] ?? "",
    };
  }
  const bare = BARE_RE.exec(text);
  if (!bare) return null;
  return {
    railName: (bare[1] ?? "").trim(),
    railType: bare[2] ?? "",
    nodeId: bare[3] ?? "",
    inputName: (bare[4] ?? "").trim(),
    inputType: bare[5] ?? "",
  };
}

export function railSocketTypesCompatible(output: unknown, input: unknown): boolean {
  return isTypeCompatible(output, input);
}

function collectDetailRows(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.nodes)) return payload.nodes;
  if (typeof payload.text !== "string") return [];
  const rows: unknown[] = [];
  for (const line of payload.text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* compact/ids lines are not node rows */
    }
  }
  return rows;
}

function liveSlotType(slots: unknown, name: string) {
  if (!Array.isArray(slots)) return undefined;
  const want = name.toLowerCase();
  for (const entry of slots) {
    const rec = asRecord(entry);
    if (!rec) continue;
    if (typeof rec.name === "string" && rec.name.toLowerCase() === want) return rec.type;
  }
  return undefined;
}

function liveTargetInputType(payload: unknown, nodeId: unknown, inputName: string) {
  const rec = asRecord(payload);
  if (!rec) return undefined;
  const want = canonicalConnectNodeId(nodeId);
  if (!want) return undefined;
  for (const row of collectDetailRows(rec)) {
    const node = asRecord(row);
    if (!node || canonicalConnectNodeId(node.id) !== want) continue;
    return liveSlotType(node.inputs, inputName);
  }
  return undefined;
}

function liveRailOutputType(payload: unknown, railName: string) {
  const rec = asRecord(payload);
  const rails = asRecord(rec?.rails);
  const input = asRecord(rails?.input);
  return liveSlotType(input?.provides_outputs, railName);
}

export function resolveRailSlotRetry(
  refusal: SubgraphInputTypeRefusal,
  args: ConnectArgs,
  livePayload?: unknown,
): ConnectArgs | null {
  let railType: unknown = refusal.railType;
  let inputType: unknown = refusal.inputType;
  if (livePayload !== undefined) {
    const liveRail = liveRailOutputType(livePayload, refusal.railName);
    const liveInput = liveTargetInputType(livePayload, args.to_node_id, refusal.inputName);
    if (liveRail !== undefined) railType = liveRail;
    if (liveInput !== undefined) inputType = liveInput;
  }
  if (!railSocketTypesCompatible(railType, inputType)) return null;
  return {
    from_node_id: args.from_node_id,
    from_output: args.from_output ?? refusal.railName,
    to_node_id: args.to_node_id,
    to_input: args.to_input ?? refusal.inputName,
    auto_match: false,
  };
}

function connectCommand(args: ConnectArgs): Record<string, unknown> {
  return {
    cmd: "graph_connect",
    from_node_id: args.from_node_id,
    from_output: args.from_output,
    to_node_id: args.to_node_id,
    to_input: args.to_input,
    auto_match: args.auto_match,
  };
}

function retriedNote(): string {
  return (
    `Retried panel_connect after normalizing the exposed subgraph rail socket type ` +
    `so INT widget constraints are not a COMBO (artokun/comfyui-mcp#2778).`
  );
}

function withNote<T extends ToolResultLike>(res: T, note: string | null): T {
  if (!note) return res;
  return { ...res, content: [...res.content, { type: "text", text: note }] };
}

/**
 * After a failed graph_connect, retry once when the refusal is a subgraph input
 * rail whose socket type is compatible with the target input once widget-spec
 * arrays are normalized to the declared scalar (INT→INT).
 */
export async function retryRailSlotConnect<T extends ToolResultLike>(
  args: ConnectArgs,
  first: T,
  call: GraphCall<T>,
  timeoutMs?: number,
): Promise<T> {
  if (!first.isError) return first;

  const refusal = subgraphInputTypeRefusal(toolText(first));
  if (!refusal) return first;
  if (!railSocketTypesCompatible(refusal.railType, refusal.inputType)) return first;

  const toId = canonicalConnectNodeId(args.to_node_id);
  let livePayload: unknown;
  if (toId) {
    const live = await call(
      {
        cmd: "graph_query",
        ids: [args.to_node_id ?? toId],
        fields: "detail",
        limit: 1,
        max_chars: DETAIL_MAX_CHARS,
      },
      DETAIL_TIMEOUT_MS,
    );
    livePayload = parseJsonPayload(live) ?? undefined;
  }

  const retryArgs = resolveRailSlotRetry(refusal, args, livePayload);
  if (!retryArgs) return first;

  const retry = await call(connectCommand(retryArgs), timeoutMs);
  if (!retry.isError) return withNote(retry, retriedNote());
  return retry;
}
