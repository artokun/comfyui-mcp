import { dispatchOutcomeOf } from "./ui-bridge.js";
import { listInstalledNodes, type InstalledNode } from "./node-management.js";

export type ListInstalledFn = () => Promise<InstalledNode[]>;

/** Panel `listedNodesResult` pack record: Manager's installed map inverted. */
export interface ListedNodePack {
  ver?: string;
  cnr_id?: string;
  aux_id?: string;
  enabled?: boolean;
}

export interface ListedNodesHostResult {
  installed: Record<string, ListedNodePack>;
  source: "host_http";
  note: string;
}

export const HOST_HTTP_LIST_NOTE =
  "Listed from ComfyUI-Manager HTTP because this session's panel tab was not connected. " +
  "This is the host pack inventory, not a Manager outage.";

let listInstalledOverride: ListInstalledFn | undefined;

/** Test seam — restore with `undefined` in afterEach. */
export function setListInstalledNodesForTests(fn: ListInstalledFn | undefined): void {
  listInstalledOverride = fn;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (!value || typeof value !== "object") return "";
  if ("message" in value && typeof value.message === "string") return value.message;
  if ("content" in value && Array.isArray(value.content)) {
    return value.content
      .map((c) =>
        c && typeof c === "object" && "text" in c && typeof c.text === "string" ? c.text : "",
      )
      .join("\n");
  }
  return "";
}

function isErrorShaped(value: unknown): boolean {
  return Boolean(
    value && typeof value === "object" && "isError" in value && value.isError === true,
  );
}

/**
 * Pre-dispatch tab loss: typed `dispatchOutcomeOf === false`, or the
 * callOnce wrapper / bridge text the reporter saw when Connected: none.
 */
export function isPanelTabDispatchFailure(value: unknown): boolean {
  const outcome = dispatchOutcomeOf(value);
  if (outcome === true) return false;
  if (outcome === false) return true;
  const text = textFromUnknown(value);
  const looksLikeDispatch =
    /could not be dispatched[\s\S]{0,240}panel tab/i.test(text) ||
    /no connected tab/i.test(text) ||
    /Connected:\s*none/i.test(text);
  if (!looksLikeDispatch) return false;
  if (value instanceof Error) return true;
  if (isErrorShaped(value)) return true;
  return typeof value === "string";
}

/** Invert `InstalledNode[]` back to the panel map keyed by module. */
export function installedNodesToPanelMap(
  nodes: InstalledNode[],
): Record<string, ListedNodePack> {
  const installed: Record<string, ListedNodePack> = {};
  for (const n of nodes) {
    const pack: ListedNodePack = {};
    if (n.version !== undefined) pack.ver = n.version;
    if (n.cnrId) pack.cnr_id = n.cnrId;
    if (n.auxId) pack.aux_id = n.auxId;
    if (n.enabled !== undefined) pack.enabled = n.enabled;
    installed[n.module] = pack;
  }
  return installed;
}

export function dualCauseListFailure(tabErr: unknown, hostErr: unknown): string {
  const tab = textFromUnknown(tabErr) || "panel tab was not connected";
  const host = textFromUnknown(hostErr) || "host Manager HTTP failed";
  return (
    `nodes_list could not be dispatched to this session's panel tab, and the host ` +
    `Manager HTTP pack listing also failed. Tab: ${tab} Host: ${host} ` +
    `This is not a Manager outage inferred from tab loss alone.`
  );
}

function resolveListInstalled(fn?: ListInstalledFn): ListInstalledFn {
  return fn ?? listInstalledOverride ?? listInstalledNodes;
}

/**
 * Panel `nodes_list` first. On pre-dispatch tab loss, serve the pack listing
 * from host Manager HTTP (`listInstalledNodes`) instead of dying as a
 * dispatch-only error. A live tab's Manager/object_info result is passed
 * through unchanged.
 */
export async function listPanelNodes<T>(opts: {
  panelList: () => Promise<T>;
  listInstalled?: ListInstalledFn;
}): Promise<
  | { via: "panel"; value: T }
  | { via: "fallback"; value: ListedNodesHostResult }
  | { via: "failed"; message: string }
> {
  const runHost = async (tabErr: unknown) => {
    try {
      const nodes = await resolveListInstalled(opts.listInstalled)();
      return {
        via: "fallback" as const,
        value: {
          installed: installedNodesToPanelMap(nodes),
          source: "host_http" as const,
          note: HOST_HTTP_LIST_NOTE,
        },
      };
    } catch (hostErr) {
      return { via: "failed" as const, message: dualCauseListFailure(tabErr, hostErr) };
    }
  };

  try {
    const value = await opts.panelList();
    if (!isPanelTabDispatchFailure(value)) return { via: "panel", value };
    return await runHost(value);
  } catch (err) {
    if (!isPanelTabDispatchFailure(err)) throw err;
    return await runHost(err);
  }
}
