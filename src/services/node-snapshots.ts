import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, getComfyUIBaseUrl } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { NodeSnapshotError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// ComfyUI-Manager snapshot HTTP API
//
// Confirmed endpoints (Comfy-Org/ComfyUI-Manager, glob/manager_server.py):
//   GET  /snapshot/getlist      -> { items: string[] }   (names without .json)
//   POST /snapshot/save         -> 200 (filename {date}_snapshot.json, no name arg)
//   POST /snapshot/restore      -> 200, body { target: <name> }
//   GET  /snapshot/get_current  -> snapshot state JSON
//
// The HTTP API works against remote instances (--comfyui-url). Naming a
// snapshot is only possible via the file fallback (writes get_current output
// to the Manager snapshots dir), which requires a local config.comfyuiPath.
// ---------------------------------------------------------------------------

export interface SaveSnapshotResult {
  name: string;
  method: "http" | "file";
  message: string;
  unsupported?: boolean;
}

export interface RestoreSnapshotResult {
  name: string;
  message: string;
  unsupported?: boolean;
}

export interface ListSnapshotsResult {
  snapshots: string[];
  unsupported?: boolean;
  message?: string;
}

// Shown when this ComfyUI-Manager build doesn't expose the /snapshot/* HTTP
// API at all (common on the bundled ComfyUI Desktop Manager): every snapshot
// endpoint 404s. Report it as an unsupported-capability result, not a crash.
const SNAPSHOTS_UNSUPPORTED_MESSAGE =
  "Node snapshots aren't supported on this ComfyUI-Manager build — its HTTP API " +
  "doesn't expose the /snapshot/* endpoints (common on the bundled ComfyUI Desktop " +
  "Manager). Update ComfyUI-Manager to a build that supports snapshots, or manage " +
  "snapshots from the ComfyUI-Manager UI / comfy-cli instead.";

/**
 * True when an error indicates the Manager build simply lacks the snapshot
 * endpoint (404), as opposed to a transient/server-side failure (e.g. 500) or
 * a network error, which should still surface.
 */
function isSnapshotEndpointUnsupported(err: unknown): boolean {
  if (!(err instanceof NodeSnapshotError)) return false;
  const status = (err.details as { status?: number } | undefined)?.status;
  return status === 404 || status === 405 || status === 501;
}

function managerBaseUrl(): string {
  return getComfyUIBaseUrl();
}

/**
 * Fetch a ComfyUI-Manager endpoint. Throws NodeSnapshotError on non-2xx or
 * network failure so callers can route through errorToToolResult.
 */
async function managerFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${managerBaseUrl()}${path}`;
  logger.debug("Manager API request", { url, method: init?.method ?? "GET" });

  let res: Response;
  try {
    res = await comfyuiFetch(url, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new NodeSnapshotError(
      `Failed to reach ComfyUI-Manager at ${url}: ${msg}. ` +
        `Is ComfyUI running with ComfyUI-Manager installed?`,
      { url },
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new NodeSnapshotError(
      `ComfyUI-Manager API ${res.status} ${res.statusText} for ${path}`,
      { url, status: res.status, body },
    );
  }
  return res;
}

/**
 * Candidate ComfyUI-Manager snapshot directories under a local install,
 * newest layout first. Mirrors manager_migration.get_manager_path().
 */
function snapshotDirCandidates(comfyuiPath: string): string[] {
  return [
    join(comfyuiPath, "user", "__manager", "snapshots"),
    join(comfyuiPath, "user", "default", "ComfyUI-Manager", "snapshots"),
    join(comfyuiPath, "custom_nodes", "ComfyUI-Manager", "snapshots"),
  ];
}

/**
 * Resolve the directory to write a named snapshot into. Prefers an existing
 * Manager snapshots dir; otherwise falls back to the newest-layout path
 * (created on write).
 */
function resolveSnapshotWriteDir(comfyuiPath: string): string {
  const candidates = snapshotDirCandidates(comfyuiPath);
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0];
}

/**
 * Serialize a JSON-ish value to YAML. Scalars are always double-quoted (valid,
 * if verbose, YAML), which sidesteps any need to decide when keys/values like
 * git URLs require quoting.
 */
function toYaml(value: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return (
      "\n" +
      value
        .map((item) => {
          const rendered = toYaml(item, indent + 1);
          // A nested block (object/array) renders on following indented lines.
          return rendered.startsWith("\n")
            ? `${pad}-${rendered}`
            : `${pad}- ${rendered}`;
        })
        .join("\n")
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  return (
    "\n" +
    entries
      .map(([k, v]) => {
        const rendered = toYaml(v, indent + 1);
        return rendered.startsWith("\n")
          ? `${pad}${JSON.stringify(k)}:${rendered}`
          : `${pad}${JSON.stringify(k)}: ${rendered}`;
      })
      .join("\n")
  );
}

/**
 * Render a snapshot as a comfy-cli/cm-cli-compatible YAML document. The CLI
 * wraps the snapshot body under a top-level `custom_nodes:` key (restore reads
 * `info['custom_nodes']` for .yaml files), so we must match that contract.
 */
function snapshotToYaml(snapshot: unknown): string {
  return `custom_nodes:${toYaml(snapshot, 1)}\n`;
}

/** GET /snapshot/getlist — raw fetch + parse; throws on any non-2xx. */
async function fetchSnapshotList(): Promise<string[]> {
  const res = await managerFetch("/snapshot/getlist");
  const data = (await res.json()) as { items?: unknown };
  return Array.isArray(data.items)
    ? data.items.filter((x): x is string => typeof x === "string")
    : [];
}

/** GET /snapshot/getlist */
export async function listNodeSnapshots(): Promise<ListSnapshotsResult> {
  try {
    const items = await fetchSnapshotList();
    logger.info(`Listed ${items.length} node snapshot(s)`);
    return { snapshots: items };
  } catch (err) {
    if (isSnapshotEndpointUnsupported(err)) {
      logger.info("Snapshot listing unsupported on this ComfyUI-Manager build");
      return { snapshots: [], unsupported: true, message: SNAPSHOTS_UNSUPPORTED_MESSAGE };
    }
    throw err;
  }
}

/**
 * Save a snapshot of the current custom-node + version state.
 *
 * - No name: POST /snapshot/save (Manager names it {date}_snapshot). Works
 *   remotely. We diff getlist before/after to report the created name.
 * - Named: fetch GET /snapshot/get_current and write <name>.json into the
 *   local Manager snapshots dir. Requires config.comfyuiPath (errors clearly
 *   in remote --comfyui-url mode).
 */
export async function saveNodeSnapshot(
  name?: string,
): Promise<SaveSnapshotResult> {
  const trimmed = name?.trim();

  if (!trimmed) {
    // HTTP-only path — Manager assigns a timestamped name.
    try {
      const before = new Set(await fetchSnapshotList());
      await managerFetch("/snapshot/save", { method: "POST" });
      const after = await fetchSnapshotList();
      const created = after.find((n) => !before.has(n));
      const resolved = created ?? after[0] ?? "(unknown)";
      return {
        name: resolved,
        method: "http",
        message: `Saved snapshot "${resolved}" via ComfyUI-Manager.`,
      };
    } catch (err) {
      if (isSnapshotEndpointUnsupported(err)) {
        logger.info("Snapshot save unsupported on this ComfyUI-Manager build");
        return {
          name: "",
          method: "http",
          message: SNAPSHOTS_UNSUPPORTED_MESSAGE,
          unsupported: true,
        };
      }
      throw err;
    }
  }

  // Named snapshot — requires a local install to write the file.
  validateSnapshotName(trimmed);
  if (!config.comfyuiPath) {
    throw new NodeSnapshotError(
      "Saving a named snapshot requires a local ComfyUI install path, which " +
        "is unavailable in remote (--comfyui-url) mode. Omit the name to let " +
        "ComfyUI-Manager assign a timestamped snapshot instead.",
    );
  }

  // Capture current state from the running instance via the Manager API.
  let res: Response;
  try {
    res = await managerFetch("/snapshot/get_current");
  } catch (err) {
    if (isSnapshotEndpointUnsupported(err)) {
      logger.info("Snapshot capture unsupported on this ComfyUI-Manager build");
      return {
        name: trimmed,
        method: "file",
        message: SNAPSHOTS_UNSUPPORTED_MESSAGE,
        unsupported: true,
      };
    }
    throw err;
  }
  const snapshot = await res.json();

  // Honor the comfy-cli contract: the file FORMAT is chosen by extension.
  // `.json` → bare object (4-space indent, as save_snapshot_with_postfix does);
  // `.yaml`/`.yml` → the snapshot wrapped under a `custom_nodes:` key. A name
  // without a recognized extension defaults to `.json` (never double-appended).
  const lower = trimmed.toLowerCase();
  const isYaml = lower.endsWith(".yaml") || lower.endsWith(".yml");
  const isJson = lower.endsWith(".json");
  const fileName = isYaml || isJson ? trimmed : `${trimmed}.json`;

  const dir = resolveSnapshotWriteDir(config.comfyuiPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, fileName);
  const contents = isYaml
    ? snapshotToYaml(snapshot)
    : JSON.stringify(snapshot, null, 4);
  writeFileSync(filePath, contents, "utf-8");
  logger.info(`Wrote named node snapshot to ${filePath}`);

  return {
    name: fileName,
    method: "file",
    message: `Saved snapshot "${fileName}" to ${filePath}.`,
  };
}

/** POST /snapshot/restore with { target } */
export async function restoreNodeSnapshot(
  name: string,
): Promise<RestoreSnapshotResult> {
  const trimmed = name?.trim();
  if (!trimmed) {
    throw new NodeSnapshotError("Snapshot name is required to restore.");
  }

  // The Manager stores names without the .json suffix; tolerate either.
  const target = trimmed.endsWith(".json") ? trimmed.slice(0, -5) : trimmed;

  try {
    await managerFetch("/snapshot/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    });
  } catch (err) {
    if (isSnapshotEndpointUnsupported(err)) {
      logger.info("Snapshot restore unsupported on this ComfyUI-Manager build");
      return { name: target, message: SNAPSHOTS_UNSUPPORTED_MESSAGE, unsupported: true };
    }
    throw err;
  }

  logger.info(`Requested restore of node snapshot "${target}"`);
  return {
    name: target,
    message:
      `Restore of snapshot "${target}" requested. ComfyUI-Manager applies ` +
      `custom-node changes on the next ComfyUI restart.`,
  };
}

/**
 * Reject names that would escape the snapshots directory or produce an
 * invalid filename.
 */
function validateSnapshotName(name: string): void {
  if (
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    name.includes("\0")
  ) {
    throw new NodeSnapshotError(
      `Invalid snapshot name "${name}": must not contain path separators or "..".`,
    );
  }
}
