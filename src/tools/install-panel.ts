import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  panelStatus,
  repairInterruptedPanelSwap,
  runPanelAction,
  withPanelOpLock,
} from "../services/panel-installer.js";
import {
  classifyPinWrite,
  evaluatePanelSync,
  performPanelSync,
  requiredPanelVersion,
} from "../services/panel-sync.js";
import {
  clearPanelVersionPin,
  describePanelPin,
  getPanelPinState,
  PANEL_PIN_ENV_VAR,
  setPanelVersionPin,
} from "../services/panel-settings.js";
import { activePanelPendingOps, reclaimAbandonedPanelLock } from "../services/panel-pin-guard.js";
import { cancelPanelPendingOps } from "../services/panel-pending-cancel.js";

function json(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

/** The sidebar-panel operations, unchanged from the retired `install_comfyui(action:'panel')`
 *  tool's own `action` enum (0.50.0 slice 13). It moved to `panel_action`
 *  because the folded tool's own `action` selects the family member — two
 *  fields cannot share one name in a flat schema. */
export const PANEL_ACTIONS = [
  "status",
  "install",
  "update",
  "reinstall",
  "sync",
  "pin",
  "unpin",
  "unlock",
] as const;

export type PanelAction = (typeof PANEL_ACTIONS)[number];

/**
 * `install_comfyui (action:"panel")` — everything the retired `install_comfyui(action:'panel')`
 * tool did, selected by `panel_action` (0.50.0 slice 13). Every panel-installer
 * / panel-sync / panel-settings call below, its arguments, its locking and its
 * JSON return shape are byte-for-byte what the standalone tool did.
 */
export async function panelAction(
  action: PanelAction,
  version: string | undefined,
  reason: string | undefined,
): Promise<CallToolResult> {
  if (action === "status") {
    // A crash between the swap's two renames leaves custom_nodes with NO
    // panel. Repair it here — asking "what's going on?" is exactly when a
    // user hits that state, and requiring them to know to run a MUTATION
    // to get their panel back is not a recovery path. Takes the op lock
    // itself and no-ops when there is nothing to repair.
    const repaired = await repairInterruptedPanelSwap();
    const status = await panelStatus();
    return json({
      ...status,
      note: repaired ? `${status.note}${repaired}` : status.note,
      sync: evaluatePanelSync(status),
    });
  }

  if (action === "sync") {
    return json(await performPanelSync());
  }

  if (action === "pin") {
    const target = (version ?? "").trim();
    if (!target) {
      // Refuse rather than guess a version for them — a pin the user did
      // not choose is worse than no pin.
      throw new Error(
        "install_comfyui(action:'panel', panel_action:'pin') needs a `version` (e.g. '0.11.20'). Run " +
          "install_comfyui(action:'panel', panel_action:'status') and pass its installedVersion to pin " +
          "where you are now.",
      );
    }
    // Serialized with panel mutations: a pin must not commit halfway
    // through an in-flight install/update (see withPanelOpLock). The
    // RESOLVED state is read INSIDE the same critical section — reading it
    // after releasing the lock let a concurrent pin/unpin land in between,
    // so the response could describe a pin that was no longer the real one.
    // The pending-op read is inside too: a marker recorded by an update-all
    // or snapshot restore (both hold this lock while recording) must be
    // seen by the very pin write that follows them — and so must its
    // CANCELLATION (#689): each marker is dealt with here, in the same
    // critical section, before the pin result is reported.
    const { pin, resolved, pending, cancels } = await withPanelOpLock(async () => {
      const written = setPanelVersionPin(target, reason);
      const ops = activePanelPendingOps();
      return {
        pin: written,
        resolved: getPanelPinState(),
        pending: ops,
        cancels: ops.length > 0 ? await cancelPanelPendingOps(ops) : [],
      };
    });
    // What actually governs is NOT necessarily what we just wrote:
    // COMFYUI_MCP_PANEL_PIN takes precedence (so the saved pin can be inert,
    // or the panel left unpinned outright by `=off`), and a concurrent write
    // may have superseded ours. Reporting the write as protection without
    // checking is the fabricated-success failure this feature exists to
    // prevent, so each outcome is named distinctly.
    const outcome = classifyPinWrite(resolved, pin.version);
    // A pin written during a pending update-all / snapshot-restore window
    // now CANCELS what it provably can (#689): each op's report says what
    // happened — cancelled (with before/after pending counts), already
    // drained (nothing left to cancel; the panel may ALREADY have moved),
    // already running (in-flight work CANNOT be cancelled), or
    // could-not-verify — and the marker is cleared only for the first two.
    // What remains (residue) keeps the warning below. WARN rather than
    // refuse for the residue: the pin is valid and governs every FUTURE
    // operation — refusing it would leave the user LESS protected against
    // the next sync, to punish them for a race they could not see.
    const residue = pending.filter((_, i) => !cancels[i]?.markerCleared);
    const pendingWarning = residue.length
      ? ` WARNING — ${
          residue.length === 1
            ? "a panel-affecting operation is"
            : `${residue.length} panel-affecting operations are`
        } still pending and may move the panel AFTER this pin: ` +
        `${residue.map((op) => op.detail).join("; ")}. The pin governs every ` +
        `install/update/reinstall/sync from now on, but it cannot stop work ` +
        `already running — check install_comfyui(action:'panel', panel_action:'status') once it has landed.`
      : "";
    const cancelNote = cancels.length
      ? ` Pending-op handling: ${cancels.map((c) => c.detail).join(" ")}`
      : "";
    // panelStatus is advisory here (it only supplies installedVersion for
    // the message); the authoritative pin is `resolved`, captured above.
    const status = await panelStatus();
    return json({
      action: "pin",
      pin: resolved,
      outcome,
      /** Is the pin we just SAVED the one actually in force? */
      active: outcome === "active",
      requestedVersion: pin.version,
      installedVersion: status.installedVersion,
      requiredPanelVersion: requiredPanelVersion(),
      /** Panel-affecting operations already handed to ComfyUI-Manager that
       *  may STILL land out-of-band — the residue after cancellation
       *  (#689): what was provably cancelled or proven drained is absent. */
      pendingPanelOps: residue.length ? residue : undefined,
      /** One report per pending op found at pin time (#689): what was
       *  attempted, the before/after pending counts, and the outcome —
       *  cancelled / already-drained / partially-cancelled /
       *  already-running / could-not-verify / cannot-cancel-remote. */
      pendingOpCancellations: cancels.length
        ? cancels.map((c) => ({
            kind: c.op.kind,
            outcome: c.outcome,
            markerCleared: c.markerCleared,
            ...(c.pendingBefore !== undefined
              ? {
                  pendingBefore: c.pendingBefore,
                  pendingAfter: c.pendingAfter,
                  inProgress: c.inProgress,
                }
              : {}),
            detail: c.detail,
          }))
        : undefined,
      // A pin records intent; it does NOT move the panel. Saying so
      // prevents "pinned to 0.11.20" being read as "now on 0.11.20".
      note:
        outcome === "active"
          ? `Pinned to ${pin.version}. This records intent only — it does NOT change ` +
            `what is installed (currently ${status.installedVersion ?? "unknown"}). ` +
            `install/update/reinstall/sync and the on-load auto-install will now ` +
            `refuse until the pin is cleared with install_comfyui(action:'panel', panel_action:'unpin').` +
            pendingWarning +
            cancelNote
          : outcome === "env-overrides-with-pin"
            ? `Saved a pin at ${pin.version}, but it is NOT the pin in force: the ` +
              `${PANEL_PIN_ENV_VAR} environment variable takes precedence and the ` +
              `panel is ${describePanelPin(resolved)}. The panel IS protected — ` +
              `just at the env pin's version, not yours. Unset ${PANEL_PIN_ENV_VAR} ` +
              `and restart the orchestrator for the saved ${pin.version} to govern.` +
              pendingWarning +
              cancelNote
            : outcome === "superseded"
              ? `Saved a pin at ${pin.version}, but another pin was written at the ` +
                `same time and won: the panel is ${describePanelPin(resolved)}. The ` +
                `panel IS pinned, just not at ${pin.version} — re-run the pin if you ` +
                `meant yours to stand.` +
                pendingWarning +
                cancelNote
              : `WARNING — the pin was saved to disk but is NOT IN FORCE, and the ` +
                `panel is NOT protected: ${PANEL_PIN_ENV_VAR} is set to an explicit ` +
                `"no pin" value, which overrides the saved pin. ` +
                `install/update/reinstall/sync will still proceed. Unset ` +
                `${PANEL_PIN_ENV_VAR} in the environment / ~/.comfyui-mcp/.env and ` +
                `restart the orchestrator for the saved pin to take effect.` +
                pendingWarning +
                cancelNote,
    });
  }

  if (action === "unpin") {
    // Same critical section as the pin path: the post-state is captured
    // WITH the write, so a concurrent pin can't be misreported as ours.
    const { removed, after } = await withPanelOpLock(async () => {
      const gone = clearPanelVersionPin();
      return { removed: gone, after: getPanelPinState() };
    });
    return json({
      action: "unpin",
      removed: removed ?? null,
      pin: after,
      note: after.pinned
        ? after.source === "env"
          ? `The persisted pin was ${removed ? "removed" : "already absent"}, but a ` +
            `pin is STILL in force via the ${PANEL_PIN_ENV_VAR} environment variable. ` +
            `Unset ${PANEL_PIN_ENV_VAR} (or set it to 'off') in the environment / ` +
            `~/.comfyui-mcp/.env and restart the orchestrator before syncing.`
          : `The persisted pin was ${removed ? "removed" : "already absent"}, but the ` +
            `panel is pinned again: ${describePanelPin(after)}. Something wrote a new ` +
            `pin at the same time — re-run unpin if you still want it cleared.`
        : removed
          ? `Pin removed (was ${removed.version}). install_comfyui(action:'panel', panel_action:'sync') can ` +
            `now proceed.`
          : `No pin was set; nothing to clear. install_comfyui(action:'panel', panel_action:'sync') can ` +
            `proceed.`,
    });
  }

  if (action === "unlock") {
    // Recovery for the wedge from #760: a crashed/killed orchestrator
    // leaves panel-op.lock behind and the acquire path deliberately never
    // auto-reclaims it (#779). This is the explicit recovery the timeout
    // message names — it re-verifies the lock is provably abandoned (old
    // AND its recorded owner is dead) before deleting anything, and says
    // exactly what it observed when it refuses. It does NOT take the lock
    // itself: a wedged lock is the very case this exists for.
    return json({ action: "unlock", ...reclaimAbandonedPanelLock() });
  }

  return json(await runPanelAction(action));
}
