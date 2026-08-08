import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getComfyUIBaseUrl } from "../config.js";
import { comfyuiFetch } from "../comfyui/fetch.js";
import { resolveEffectiveComfyUIBase, resolveLocalMutationTarget } from "./workspace-env.js";
import {
  recordPanelPendingOp,
  SNAPSHOT_RESTORE_PENDING_MS,
  withPanelPinGuard,
} from "./panel-pin-guard.js";
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
// to the Manager snapshots dir), which requires a resolvable local install
// root (resolveEffectiveComfyUIBase: COMFYUI_PATH, else the saved default
// workspace — never in remote mode).
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
  "snapshots from the ComfyUI-Manager UI / comfy-cli instead. When neither is " +
  "available there is still a rollback path: before changing anything, copy the " +
  "pack directories under custom_nodes somewhere safe (or move them into a " +
  "custom_nodes/.disabled folder) and record what moved — restore is moving them " +
  "back.";

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
 *
 * `base` pins the target for this call (the ManagerFetchOptions.base
 * convention): callers that record a pending-op marker must pass the SAME
 * base they recorded, so marker and request can never name different servers
 * (#689 round 3).
 */
async function managerFetch(
  path: string,
  init?: RequestInit,
  base = managerBaseUrl(),
): Promise<Response> {
  const url = `${base}${path}`;
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
    // unknown-ok: "" is interpolated into an ERROR MESSAGE and nothing else — the
    // HTTP status is reported either way, so an unreadable body costs detail in the
    // text, never a wrong conclusion. Verified there is no branch on this value.
    const body = await res.text().catch(() => "");
    throw new NodeSnapshotError(
      `ComfyUI-Manager API ${res.status} ${res.statusText} for ${path}`,
      { url, status: res.status, body },
    );
  }
  return res;
}

/**
 * Candidate ComfyUI-Manager FILES directories under a local install, newest
 * layout first. Mirrors manager_migration.get_manager_path() (user/__manager
 * when ComfyUI has the system-user API, user/default/ComfyUI-Manager
 * otherwise) plus the legacy git-clone layout, which keeps everything inside
 * the extension dir.
 */
function managerFilesDirCandidates(comfyuiPath: string): string[] {
  return [
    join(comfyuiPath, "user", "__manager"),
    join(comfyuiPath, "user", "default", "ComfyUI-Manager"),
    join(comfyuiPath, "custom_nodes", "ComfyUI-Manager"),
  ];
}

/**
 * Candidate ComfyUI-Manager snapshot directories under a local install,
 * newest layout first.
 */
function snapshotDirCandidates(comfyuiPath: string): string[] {
  return managerFilesDirCandidates(comfyuiPath).map((dir) => join(dir, "snapshots"));
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
 *   local Manager snapshots dir. Requires a resolvable local install root
 *   (resolveEffectiveComfyUIBase); errors clearly when there is none.
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

  // Named snapshot — requires a local install to write the file. Resolve the
  // install root through the SAME resolver install_comfyui (action:"environment") / list_local_models action:"list_paths" /
  // the comfy-cli wrapper use (#775): config.comfyuiPath, then the saved default
  // workspace — never a bare "comfyuiPath unset ⇒ remote" conclusion, which
  // misclassified a local install connected via --comfyui-url as remote.
  validateSnapshotName(trimmed);
  // A named save WRITES a file into the install tree, so it must know WHICH
  // install — and in remote mode a stale local COMFYUI_PATH would send that write
  // to an unrelated tree while the snapshot content came from the remote server
  // (codex gate P0). Refuse instead of guessing.
  const target = resolveLocalMutationTarget();
  if (target.refusal) {
    throw new NodeSnapshotError(
      `Saving a named snapshot requires a local ComfyUI install, and ${target.refusal} ` +
        "Omit the name to let ComfyUI-Manager assign a timestamped one on the server itself.",
    );
  }
  const comfyuiBase: string | undefined = target.base;
  if (!comfyuiBase) {
    throw new NodeSnapshotError(
      "Saving a named snapshot requires a local ComfyUI install path, and none is " +
        "available: COMFYUI_PATH is unset, no default workspace is saved (set one with " +
        "the workspace tool, action 'set_default'), or the session targets a genuinely " +
        "remote ComfyUI. Omit the name to let ComfyUI-Manager assign a timestamped " +
        "snapshot instead — that works remotely.",
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

  const dir = resolveSnapshotWriteDir(comfyuiBase);
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

  // PIN GUARD. A snapshot records every pack's commit and restoring reverts them
  // ALL, so this moves the sidebar panel exactly like an "update all" would —
  // another door that never passes through install_comfyui(action:'panel'). It is inherently bulk
  // (there is no restore-everything-except-one-pack), so a pin refuses it
  // outright and the message explains the two real options. The check and the
  // restore request are atomic under the panel mutation lock (withPanelPinGuard);
  // the Manager then applies the restore on its own schedule (the message below
  // says "requested", never "restored").
  return withPanelPinGuard("restore a node snapshot over", "all", async () => {
    // The Manager stores names without the .json suffix; tolerate either.
    const target = trimmed.endsWith(".json") ? trimmed.slice(0, -5) : trimmed;

    // Pin the target ONCE and use it for BOTH the marker and the request: a
    // retarget between the record and the POST must never leave the marker
    // naming server A while the restore is scheduled on server B — a later
    // pin-write cancellation trusts the marker's base (#689 round 3).
    const base = managerBaseUrl();

    // Persist and VERIFY the warning marker BEFORE requesting the deferred
    // restore. A pin written after Manager receives the request cannot stop the
    // next-restart apply; refusing when the marker cannot be made durable is the
    // only way to avoid reporting such a pin as protective. Keep the marker on a
    // request failure because a transport error cannot prove Manager did not
    // receive it. The base is recorded so the pin-write cancellation path aims
    // at the host the restore is actually scheduled on (#689).
    recordPanelPendingOp(
      "snapshot-restore",
      `a snapshot restore ("${target}") may have been requested and reverts EVERY pack to ` +
        `its snapshot commit — the sidebar panel included — at the next ComfyUI ` +
        `restart`,
      SNAPSHOT_RESTORE_PENDING_MS,
      { base },
    );

    try {
      await managerFetch(
        "/snapshot/restore",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target }),
        },
        base,
      );
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
  });
}

/**
 * The deferred-restore file Manager's POST /snapshot/restore leaves behind:
 * nothing happens at request time beyond copying the chosen snapshot to
 * `<manager files>/startup-scripts/restore-snapshot.json`, and
 * prestartup_script.py applies it at the next ComfyUI start only
 * `if os.path.exists(...)`, then deletes it. Deleting the file before that
 * restart is therefore a PROVABLE cancel, and its absence proves nothing is
 * scheduled. (Verified against Comfy-Org/ComfyUI-Manager main AND the
 * manager-v4 pip package — both use the same path.)
 */
const RESTORE_SNAPSHOT_FILE = join("startup-scripts", "restore-snapshot.json");

export interface CancelSnapshotRestoreResult {
  outcome:
    | "cancelled" // the deferred-restore file was found and is now gone
    | "not-scheduled" // no deferred-restore file exists anywhere — nothing to cancel
    | "remote" // no local install path: the file lives on the ComfyUI host
    | "failed"; // a delete was attempted and failed
  /** The restore file(s) deleted (outcome "cancelled"). */
  deletedPaths: string[];
  /** Every location checked (local mode only). */
  checkedPaths: string[];
  /** Human-facing explanation for the pin-write report. */
  detail: string;
}

/**
 * Cancel a DEFERRED snapshot restore by deleting Manager's deferred-restore
 * file before the next ComfyUI restart consumes it (#689).
 *
 * Local installs only: in remote mode the file lives on the ComfyUI host,
 * which this process cannot reach — reported truthfully as "cannot cancel",
 * never as a cancel. Every candidate Manager files dir is checked (a stale
 * copy in a legacy layout is deleted too: Manager's prestartup reads exactly
 * one of these, and leaving any of them in place risks the restore running).
 */
export function cancelPendingSnapshotRestore(): CancelSnapshotRestoreResult {
  // Same resolver as a named save (#775): the saved default workspace counts as
  // a local install path — a bare comfyuiPath check misclassified exactly that
  // session as "remote".
  // Cancelling DELETES the pending-restore file. Same hazard as the save: in
  // remote mode a stale local path would delete an unrelated install's pending
  // restore (codex gate P0).
  const cancelTarget = resolveLocalMutationTarget();
  if (cancelTarget.refusal) {
    return {
      outcome: "remote",
      deletedPaths: [],
      checkedPaths: [],
      detail: `cannot cancel — ${cancelTarget.refusal} Nothing was deleted.`,
    };
  }
  const comfyuiBase: string | undefined = cancelTarget.base;
  if (!comfyuiBase) {
    return {
      outcome: "remote",
      deletedPaths: [],
      checkedPaths: [],
      detail:
        "cannot cancel — no local install path (COMFYUI_PATH unset, no saved " +
        "default workspace, or a genuinely remote target): the deferred restore file " +
        "(<ComfyUI>/user/**/startup-scripts/restore-snapshot.json) lives on the " +
        "ComfyUI host and this orchestrator has no local install path to delete " +
        "it through. Delete it on the host BEFORE the next ComfyUI restart, or " +
        "the restore will run.",
    };
  }
  const checkedPaths = managerFilesDirCandidates(comfyuiBase).map((dir) =>
    join(dir, RESTORE_SNAPSHOT_FILE),
  );
  const found = checkedPaths.filter((p) => existsSync(p));
  if (found.length === 0) {
    return {
      outcome: "not-scheduled",
      deletedPaths: [],
      checkedPaths,
      detail:
        "no deferred restore file exists in any ComfyUI-Manager files dir, so " +
        "there was NOTHING left to cancel — the restore already ran at a ComfyUI " +
        "restart (or was never scheduled). The panel may ALREADY have been " +
        "reverted to its snapshot commit — check install_comfyui(action:'panel', panel_action:'status').",
    };
  }
  const deletedPaths: string[] = [];
  for (const p of found) {
    try {
      rmSync(p, { force: true });
    } catch (err) {
      return {
        outcome: "failed",
        deletedPaths,
        checkedPaths,
        detail:
          `could not delete the deferred restore file at ${p}: ${
            err instanceof Error ? err.message : String(err)
          }. The restore may still run at the next ComfyUI restart — delete that ` +
          `file on the ComfyUI host manually.`,
      };
    }
    // Verify gone rather than trusting the syscall — the whole point is proof.
    if (!existsSync(p)) deletedPaths.push(p);
  }
  if (deletedPaths.length !== found.length) {
    const surviving = found.filter((p) => !deletedPaths.includes(p));
    return {
      outcome: "failed",
      deletedPaths,
      checkedPaths,
      detail:
        `the deferred restore file still exists after deletion was attempted ` +
        `(${surviving.join(", ")}). The restore may still run at the next ` +
        `ComfyUI restart — delete it on the ComfyUI host manually.`,
    };
  }
  return {
    outcome: "cancelled",
    deletedPaths,
    checkedPaths,
    detail:
      `deleted the deferred restore file (${deletedPaths.join(", ")}) — the ` +
      `snapshot restore will NOT run at the next ComfyUI restart.`,
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
