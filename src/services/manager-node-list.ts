import { dispatchOutcomeOf } from "./ui-bridge.js";
import { isManagerTransportFetchFailure } from "./manager-node-search.js";
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

export const HOST_HTTP_TRANSPORT_NOTE =
  "Listed from ComfyUI-Manager HTTP because the panel's browser request to Manager " +
  "installed-packs did not complete. Live canvas reads still work; this is a " +
  "panel-origin transport failure, not a Manager outage.";

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
  const host = textFromUnknown(hostErr) || "host Manager HTTP failed";
  if (isManagerTransportFetchFailure(tabErr)) {
    const panel = textFromUnknown(tabErr) || "panel Manager request did not complete";
    return (
      `nodes_list reached the panel tab, but the panel's ComfyUI-Manager request ` +
      `did not complete, and the host Manager HTTP pack listing also failed. ` +
      `Panel: ${panel} Host: ${host} ` +
      `This is not a Manager outage inferred from a transport-only fetch failure.`
    );
  }
  const tab = textFromUnknown(tabErr) || "panel tab was not connected";
  return (
    `nodes_list could not be dispatched to this session's panel tab, and the host ` +
    `Manager HTTP pack listing also failed. Tab: ${tab} Host: ${host} ` +
    `This is not a Manager outage inferred from tab loss alone.`
  );
}

function shouldHostList(value: unknown): boolean {
  return isPanelTabDispatchFailure(value) || isManagerTransportFetchFailure(value);
}

function hostListNote(panelErr: unknown): string {
  return isManagerTransportFetchFailure(panelErr) ? HOST_HTTP_TRANSPORT_NOTE : HOST_HTTP_LIST_NOTE;
}

function resolveListInstalled(fn?: ListInstalledFn): ListInstalledFn {
  return fn ?? listInstalledOverride ?? listInstalledNodes;
}

/**
 * Panel `nodes_list` first. On pre-dispatch tab loss, or when the live tab's
 * Manager fetch never completed (`Failed to fetch` wrap), serve the pack
 * listing from host Manager HTTP (`listInstalledNodes`) instead of dying as a
 * dispatch-only or transport-only error. A live tab's Manager/object_info
 * result is passed through unchanged.
 */
export async function listPanelNodes<T>(opts: {
  panelList: () => Promise<T>;
  listInstalled?: ListInstalledFn;
}): Promise<
  | { via: "panel"; value: T }
  | { via: "fallback"; value: ListedNodesHostResult }
  | { via: "failed"; message: string }
> {
  const runHost = async (panelErr: unknown) => {
    try {
      const nodes = await resolveListInstalled(opts.listInstalled)();
      return {
        via: "fallback" as const,
        value: {
          installed: installedNodesToPanelMap(nodes),
          source: "host_http" as const,
          note: hostListNote(panelErr),
        },
      };
    } catch (hostErr) {
      return { via: "failed" as const, message: dualCauseListFailure(panelErr, hostErr) };
    }
  };

  try {
    const value = await opts.panelList();
    if (!shouldHostList(value)) return { via: "panel", value };
    return await runHost(value);
  } catch (err) {
    if (!shouldHostList(err)) throw err;
    return await runHost(err);
  }
}
