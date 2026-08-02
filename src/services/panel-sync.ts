// Node-pack auto-sync: decide whether the installed sidebar panel pack
// (comfyui-agent-panel) is behind what THIS orchestrator build needs, and — when
// it is, and only when the user has not pinned it — run the sync through the
// hardened, verified install_panel path.
//
// WHY THIS EXISTS. The orchestrator ships on npm; the panel ships on the Comfy
// Registry. Updating one does not update the other, so users end up running a
// new orchestrator against an old panel. The failures that produces are
// confusing and hard to diagnose (a bridge command the panel simply doesn't
// implement), which is exactly the report we got from the community.
//
// TWO RULES GOVERN EVERYTHING HERE:
//
//  1. NEVER REPORT A SYNC THAT DID NOT HAPPEN. This feature sits on top of the
//     #639/#641 fabricate-success fixes, so it inherits their discipline: the
//     mutation runs through `runPanelAction`, which fails closed unless the pack
//     provably MOVED on disk, and the version we report afterwards is RE-READ
//     from disk, never the version we intended to install.
//
//  2. NEVER MOVE A PINNED USER. A pin is a promise. `evaluatePanelSync` refuses
//     to recommend a sync while a pin is in force, `performPanelSync` refuses to
//     execute one, and `runPanelAction` itself refuses at the choke point. Every
//     "can't tell" (an unreadable pin, an unreadable installed version, a shadow
//     copy) resolves to "don't touch it", never to "probably fine".

import {
  panelStatus,
  runPanelAction,
  runPanelActionInner,
  withPanelOpLock,
  defaultDeps,
  type PanelInstallerDeps,
  type PanelStatus,
} from "./panel-installer.js";
import {
  describePanelPin,
  PANEL_PIN_ENV_VAR,
  type PanelPinState,
} from "./panel-settings.js";
import { requiredPanelVersion as requiredBridgePanelVersion, SEMVER_RE } from "./ui-bridge.js";
import { compareSemver, detectInstallMode } from "./self-update.js";

export { requiredBridgePanelVersion as requiredPanelVersion };

/*
 * Version screening. `compareSemver` returns 0 for anything it cannot parse, so
 * an unscreened "nightly" / "dev" / "" would compare EQUAL to the required
 * version and be reported as up to date — a silent wrong answer. We reuse the
 * project's CANONICAL strict SemVer 2.0.0 grammar (ui-bridge's SEMVER_RE) rather
 * than a hand-rolled approximation: a looser local regex admitted `01.11.28`
 * (leading zero) and `0.11.28+.` (empty build identifier), which compareSemver
 * then read as satisfying 0.11.28.
 *
 * ONE DELIBERATE DEVIATION from the spec grammar: that regex allows an optional
 * leading `v` (`v0.11.28`). We KEEP it rather than reject it. A `v`-prefixed
 * version is unambiguous, `compareSemver` parses it correctly, and the panel's
 * pyproject version is the source here — so rejecting it would call a perfectly
 * meaningful version "unknown" and refuse a sync the user actually wants. The
 * screen is about telling a real version from `nightly`/`dev`/garbage, and `v`
 * does not blur that line.
 */

function isComparableVersion(v: string | undefined): v is string {
  return typeof v === "string" && SEMVER_RE.test(v.trim());
}

/**
 * What a just-written persisted pin actually achieved. Writing the settings file
 * is not the same as being pinned: `COMFYUI_MCP_PANEL_PIN` takes precedence, so
 * the saved pin can be inert. Reporting the write as protection without checking
 * would tell a user they are safe when they are not.
 */
export type PinWriteOutcome =
  /** The pin we saved is the one in force. */
  | "active"
  /** An env pin wins: the panel IS pinned, but at the env pin's version. */
  | "env-overrides-with-pin"
  /** A concurrent write replaced ours: pinned from settings, at another version. */
  | "superseded"
  /** `COMFYUI_MCP_PANEL_PIN=off` (or similar): nothing is pinned at all. */
  | "not-in-force";

/**
 * Classify what a pin WRITE achieved, given the pin state resolved immediately
 * afterwards. `savedVersion` is required so a concurrent write that replaced
 * ours is reported as `superseded` rather than as our pin being active — the
 * response must describe the pin that is really in force, not the one we asked
 * for.
 */
export function classifyPinWrite(
  resolved: PanelPinState,
  savedVersion: string,
): PinWriteOutcome {
  if (!resolved.pinned) return "not-in-force";
  if (resolved.source === "env") return "env-overrides-with-pin";
  return resolved.version === savedVersion ? "active" : "superseded";
}

export type PanelSyncDecision =
  /** Behind, nothing pinned, nothing ambiguous → sync is safe to run. */
  | "sync"
  /** Behind, but the user pinned the panel → WARN ONLY. Never sync. */
  | "pinned-warn"
  /** The installed panel already meets what this orchestrator needs. */
  | "up-to-date"
  /** Something must be fixed by a human first (shadow copy, unreadable pin). */
  | "blocked"
  /** Can't read a comparable installed version → don't guess, don't touch. */
  | "unknown"
  /** Symlinked dev checkout — managed by its owner, never by us. */
  | "dev-install"
  /** Remote/cloud, or no local ComfyUI: panel sync doesn't apply here. */
  | "not-applicable";

export interface PanelSyncAssessment {
  decision: PanelSyncDecision;
  /** Highest panel version this orchestrator build is known to require. */
  requiredPanelVersion: string;
  /** On-disk panel version; undefined when absent or unreadable. */
  installedVersion?: string;
  /** This orchestrator's own npm version, when it can be read. */
  orchestratorVersion?: string;
  /** The active pin (see panel-settings). */
  pin: PanelPinState;
  /**
   * True only when we PROVED the panel is older than `requiredPanelVersion` (a
   * comparable installed version below it, or a confirmed absent pack). An
   * unreadable version is never "behind".
   */
  behind: boolean;
  /** Plain-language explanation for the user. */
  summary: string;
}

export interface EvaluateOptions {
  /** Override for tests; defaults to the running package's version. */
  orchestratorVersion?: string;
  /** Override for tests; defaults to the derived requirement. */
  requiredVersion?: string;
}

/**
 * Pure decision function over a `PanelStatus` snapshot. No I/O, no mutation —
 * every branch is directly testable, which is the point: this is the logic that
 * decides whether we are allowed to touch a user's install.
 */
export function evaluatePanelSync(
  status: PanelStatus,
  opts: EvaluateOptions = {},
): PanelSyncAssessment {
  const required = opts.requiredVersion ?? requiredBridgePanelVersion();
  const orchestratorVersion =
    opts.orchestratorVersion ?? detectInstallMode().currentVersion ?? undefined;
  // A PanelStatus without a `pin` is a caller that predates the pin (or built
  // the object by hand). Absence of the field is not evidence of absence of a
  // pin, so it resolves to indeterminate-pinned, not to unpinned.
  const pin: PanelPinState =
    status.pin && typeof status.pin === "object"
      ? status.pin
      : { pinned: true, source: "settings", indeterminate: true };

  const base = {
    requiredPanelVersion: required,
    installedVersion: status.installedVersion,
    orchestratorVersion,
    pin,
  };
  const orch = orchestratorVersion ? `comfyui-mcp ${orchestratorVersion}` : "this orchestrator";

  // The skill PROMISES visible drift when a user sits on a pinned version —
  // that warning is owed in every state, including the early-return ones
  // (remote / dev install), not only on paths that could act.
  const driftNote = (() => {
    if (!pin.pinned || pin.indeterminate) return "";
    if (!status.installedVersion || !isComparableVersion(status.installedVersion)) return "";
    if (compareSemver(status.installedVersion, required) >= 0) return "";
    return (
      ` NOTE: the panel is ${describePanelPin(pin)} and BEHIND what ${orch} ` +
        `expects (${status.installedVersion} < ${required}) — left untouched; ` +
        `unpin with install_panel(action='unpin') to close the gap.`
    );
  })();

  if (!status.applicable) {
    return {
      ...base,
      decision: "not-applicable",
      behind: false,
      summary:
        `Panel sync does not apply here: ${status.note || "no local ComfyUI is configured"}. ` +
        `The panel pack is managed on the machine that runs ComfyUI.` +
        driftNote,
    };
  }

  // A symlinked dev checkout belongs to whoever made it. Check this BEFORE the
  // pin: "we don't touch dev installs" is the stronger, older promise, and
  // telling a developer to unpin would be wrong advice.
  if (status.isDevSymlink) {
    return {
      ...base,
      decision: "dev-install",
      behind: false,
      summary:
        `The panel at ${status.dir ?? "custom_nodes"} is a dev symlink — update it ` +
        `through its own git checkout. Nothing here will modify it.` +
        driftNote,
    };
  }

  // Can't prove the scan saw everything → "absent" is unreliable (#639). A
  // sync that installs blind here could clobber a NEWER panel the enumeration
  // simply missed, exactly the loss the installer's own unreliable-scan guard
  // refuses. Can't-tell → don't touch.
  if (status.scanReliable === false) {
    return {
      ...base,
      decision: "blocked",
      behind: false,
      summary:
        `custom_nodes could not be enumerated, so whether the panel is present is ` +
        `UNRELIABLE — nothing will be changed (a blind install could clobber an ` +
        `existing, possibly newer, panel). Re-run once custom_nodes is readable.` +
        driftNote,
    };
  }

  // Can't prove there is no pin → behave as if there is one.
  if (pin.indeterminate) {
    return {
      ...base,
      decision: "blocked",
      behind: false,
      summary:
        `Cannot determine whether the panel is version-pinned (${describePanelPin(pin)}), ` +
        `so nothing will be changed. Fix or remove the settings file, or set ` +
        `${PANEL_PIN_ENV_VAR}=off, then re-check.`,
    };
  }

  // The shadow scan itself failed → `shadows: []` means "we didn't find any",
  // NOT "there are none". Reading an empty array as an all-clear would let a
  // served backup copy sit behind a "synced" claim, so an incomplete scan is
  // blocked exactly like a found shadow.
  if (status.shadowInspectFailed) {
    return {
      ...base,
      decision: "blocked",
      behind: false,
      summary:
        `Could not enumerate custom_nodes to check for shadow copies of the panel, so ` +
        `it cannot be confirmed that the panel in the browser is the one on disk. NOT ` +
        `syncing on an unverified install. Check custom_nodes is readable (a stray ` +
        `".comfyui-agent-panel.bak-*" there would shadow the real panel), then re-check.` +
        driftNote,
    };
  }

  // A shadow copy means the SERVED panel is not the one on disk, so neither the
  // "you are behind" reading nor any post-sync version claim would be true.
  if (status.shadows.length > 0) {
    const names = status.shadows.map((s) => `"${s.name}"`).join(", ");
    return {
      ...base,
      decision: "blocked",
      behind: false,
      summary:
        `A shadow copy of the panel is present in custom_nodes (${names}). ComfyUI ` +
        `serves it too, and a dot-prefixed dir wins by sort order, so the browser may ` +
        `be loading it instead of the real panel — the installed version below cannot ` +
        `be trusted. Move the shadow copy OUT of custom_nodes and hard-refresh the ` +
        `ComfyUI tab before syncing anything.` +
        driftNote,
    };
  }

  if (!status.installed) {
    // Not installed at all. That is definitionally behind, but a pin still wins:
    // installing the nightly channel would land some version other than the
    // pinned one.
    if (pin.pinned) {
      return {
        ...base,
        decision: "pinned-warn",
        behind: true,
        summary:
          `The panel pack is not installed, and ${orch} needs panel ${required}+. ` +
          `You are ${describePanelPin(pin)}, so nothing will be installed automatically. ` +
          `Clear the pin (install_panel(action='unpin')) to let the sync install it.`,
      };
    }
    return {
      ...base,
      decision: "sync",
      behind: true,
      summary:
        `The panel pack is not installed and ${orch} needs panel ${required}+. ` +
        `Syncing will install it, then ComfyUI must be restarted.`,
    };
  }

  if (!isComparableVersion(status.installedVersion)) {
    const cannotCompare =
      `The panel is installed at ${status.dir ?? "custom_nodes"} but its version ` +
      `(${status.installedVersion ?? "unreadable"}) is not a comparable version ` +
      `number, so it cannot be compared against the ${required} this orchestrator ` +
      `needs.`;
    // A pin outranks "we can't tell". Reporting `unknown` here would send the
    // agent off to suggest a deliberate update that the mutation guard is going
    // to refuse anyway — and would skip the warning the user is owed.
    if (pin.pinned) {
      return {
        ...base,
        decision: "pinned-warn",
        behind: false,
        summary:
          `${cannotCompare} You are also ${describePanelPin(pin)}, so nothing will ` +
          `be changed either way. Clear the pin (install_panel(action='unpin')) ` +
          `first if you want to move the panel at all.`,
      };
    }
    return {
      ...base,
      decision: "unknown",
      behind: false,
      summary:
        `${cannotCompare} NOT syncing on a guess — check the pack's pyproject.toml, ` +
        `or run install_panel(action='update') deliberately.`,
    };
  }

  const behind = compareSemver(status.installedVersion, required) < 0;

  if (pin.pinned) {
    if (!behind) {
      return {
        ...base,
        decision: "up-to-date",
        behind: false,
        summary:
          `Panel ${status.installedVersion} already meets what ${orch} needs ` +
          `(${required}+). You are ${describePanelPin(pin)}; nothing to do.`,
      };
    }
    // THE WARN CASE. Say what exists, say they're pinned, change nothing.
    return {
      ...base,
      decision: "pinned-warn",
      behind: true,
      summary:
        `Heads up: ${orch} expects panel ${required}+, and you are on panel ` +
        `${status.installedVersion} — a newer panel that matches your orchestrator ` +
        `exists. You are ${describePanelPin(pin)}, so NOTHING has been changed and ` +
        `nothing will be. If you want the newer panel, clear the pin first ` +
        `(install_panel(action='unpin')` +
        (pin.source === "env"
          ? `, though this pin comes from ${PANEL_PIN_ENV_VAR} and must be unset in ` +
            `the environment`
          : ``) +
        `) and then sync.`,
    };
  }

  if (!behind) {
    return {
      ...base,
      decision: "up-to-date",
      behind: false,
      summary:
        `Panel ${status.installedVersion} already meets what ${orch} needs ` +
        `(${required}+). Nothing to do.`,
    };
  }

  return {
    ...base,
    decision: "sync",
    behind: true,
    summary:
      `Panel ${status.installedVersion} is older than the ${required}+ that ${orch} ` +
      `needs. Syncing will pull the latest panel via ComfyUI-Manager; ComfyUI must ` +
      `be restarted afterwards.`,
  };
}

export interface PanelSyncResult {
  /** True ONLY when the pack provably moved on disk and we re-read the result. */
  synced: boolean;
  /** The decision that was acted on (re-evaluated at execution time). */
  decision: PanelSyncDecision;
  /** On-disk version before the op, when it was readable. */
  previousVersion?: string;
  /**
   * The version RE-READ from disk after the op — the actual outcome, not the
   * intended one. Only ever set when `synced` is true.
   */
  verifiedVersion?: string;
  /** Highest panel version this orchestrator build needs. */
  requiredPanelVersion: string;
  /**
   * TRI-STATE, and `null` rather than `undefined` ON PURPOSE: this object is
   * JSON.stringify'd to the agent, and `undefined` keys are DROPPED — the
   * "we couldn't check" state would vanish from the wire and read as absent.
   *  - `true`  → the sync landed but the result is STILL below what the
   *              orchestrator needs. The sync happened; the mismatch did not go
   *              away, and the user must be told.
   *  - `false` → the sync landed and the result PROVABLY meets the requirement.
   *  - `null`  → the sync landed but the resulting version is not a comparable
   *              version number (e.g. "nightly"), so whether the requirement is
   *              met is UNKNOWN. It must not collapse to `false`: "we couldn't
   *              check" is not "you're fine".
   */
  stillBehind?: boolean | null;
  /** True when ComfyUI must be restarted to load what just landed. */
  restartRequired?: boolean;
  message: string;
}

export interface PerformSyncOptions {
  deps?: PanelInstallerDeps;
  orchestratorVersion?: string;
  requiredVersion?: string;
}

/**
 * Run the sync, honouring every guard.
 *
 * Contract, in order:
 *  - Re-evaluate the decision NOW (never act on a snapshot handed in from
 *    earlier — the pin may have been set in between).
 *  - Any decision other than `sync` returns `synced: false` WITHOUT queueing a
 *    mutation. In particular `pinned-warn` returns the warning and stops; this
 *    is a policy refusal, not an error.
 *  - `sync` delegates to `runPanelAction`, which THROWS unless the pack provably
 *    moved on disk (#639) and no shadow copy is serving (#641). That throw
 *    propagates: a verification failure is an explicit failure, never a
 *    downgraded "sync completed with warnings".
 *  - On success the installed version is RE-READ from disk and reported. If the
 *    re-read cannot confirm a version, we throw rather than claim a version we
 *    did not observe.
 */
export async function performPanelSync(
  opts: PerformSyncOptions = {},
): Promise<PanelSyncResult> {
  const deps = opts.deps ?? defaultDeps;
  // The status read, the DECISION, and the mutation all run inside the op
  // lock: a decision made outside could go stale before the lock is acquired,
  // and a newer panel installed in that gap would be blindly overwritten by
  // the stale decision (codex gate). runPanelAction's own wrapper would lock
  // only the mutation half, so this calls the inner action directly.
  return withPanelOpLock(async () => {
    const before = await panelStatus(deps);
    const assessment = evaluatePanelSync(before, {
      orchestratorVersion: opts.orchestratorVersion,
      requiredVersion: opts.requiredVersion,
    });

    if (assessment.decision !== "sync") {
      return {
        synced: false,
        decision: assessment.decision,
        previousVersion: before.installedVersion,
        requiredPanelVersion: assessment.requiredPanelVersion,
        message: assessment.summary,
      };
    }

    // `update` refreshes an existing pack; `install` is for a pack that isn't
    // there. Both go through the same verified path and both fail closed.
    const action = before.installed ? "update" : "install";
    const result = await runPanelActionInner(action, deps);

    // Re-read from disk. `runPanelAction` already proved movement, but the version
    // we hand back to the user must be one we OBSERVED after the fact, not the one
    // the installer intended or reported.
    const after = await panelStatus(deps);
    if (!after.installed || !after.installedVersion) {
      throw new Error(
        `Panel ${action} reported success, but re-reading the pack afterwards could ` +
          `not confirm an installed version${after.dir ? ` at ${after.dir}` : ""}. NOT ` +
          `reporting a completed sync. Check custom_nodes and re-run ` +
          `install_panel(action='status').`,
      );
    }
    if (after.shadows.length > 0) {
      throw new Error(
        `Panel ${action} applied on disk, but ${after.shadows.length} shadow copy/copies ` +
          `(${after.shadows.map((s) => `"${s.name}"`).join(", ")}) are still served from ` +
          `custom_nodes, so the browser may keep loading the OLD panel. NOT reporting a ` +
          `completed sync: move them out of custom_nodes and hard-refresh the ComfyUI tab.`,
      );
    }
    // A shadow scan that could not RUN is not a clean scan. `shadows: []` from a
    // failed enumeration would otherwise read as an all-clear here exactly as it
    // did in the pre-mutation assessment — the same fail-open, one step later.
    if (after.shadowInspectFailed) {
      throw new Error(
        `Panel ${action} applied on disk (now ${after.installedVersion}), but custom_nodes ` +
          `could not be enumerated afterwards to check for shadow copies, so it cannot be ` +
          `confirmed that the browser will load THIS panel rather than a stray ` +
          `".comfyui-agent-panel.bak-*". NOT reporting a completed sync — re-run ` +
          `install_panel(action='status') once custom_nodes is readable.`,
      );
    }

    // Tri-state: `null` when the landed version can't be compared at all.
    const stillBehind: boolean | null = isComparableVersion(after.installedVersion)
      ? compareSemver(after.installedVersion, assessment.requiredPanelVersion) < 0
      : null;

    const gapNote =
      stillBehind === true
        ? `NOTE: that is still below the ${assessment.requiredPanelVersion} this ` +
          `orchestrator expects — the update applied but did not close the gap. `
        : stillBehind === null
          ? `NOTE: "${after.installedVersion}" is not a comparable version number, so ` +
            `whether it meets the ${assessment.requiredPanelVersion} this orchestrator ` +
            `expects could NOT be confirmed — the update applied, the version match did ` +
            `not. `
          : ``;

    return {
      synced: true,
      decision: "sync",
      previousVersion: result.previousVersion ?? before.installedVersion,
      verifiedVersion: after.installedVersion,
      requiredPanelVersion: assessment.requiredPanelVersion,
      stillBehind,
      restartRequired: true,
      message:
        `Panel synced: verified on disk as ${after.installedVersion}` +
        (result.previousVersion ? ` (was ${result.previousVersion})` : ``) +
        `. ` +
        gapNote +
        `RESTART ComfyUI to load it.`,
    };
  });
}
