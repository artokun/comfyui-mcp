// Node-pack auto-sync: decide whether the installed sidebar panel pack
// (comfyui-agent-panel) is behind what THIS orchestrator build needs, and — when
// it is, and only when the user has not pinned it — run the sync through the
// hardened, verified install_comfyui(action:'panel') path.
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
  assertPinnedTarget,
  panelStatus,
  pinPanelBase,
  runPanelAction,
  runPanelActionInner,
  withPanelOpLock,
  defaultDeps,
  type PanelInstallerDeps,
  type PanelStatus,
} from "./panel-installer.js";
import { reclaimAbandonedPanelLock } from "./panel-pin-guard.js";
import {
  describePanelPin,
  PANEL_PIN_ENV_VAR,
  type PanelPinState,
} from "./panel-settings.js";
import { requiredPanelVersion as requiredBridgePanelVersion, SEMVER_RE } from "./ui-bridge.js";
import { describeInstallPanelAction } from "./panel-recovery.js";
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
 * How to clear a pin, phrased for THIS session. These summaries are pushed
 * straight into the embedded panel chat on every hello, and that surface does
 * not carry install_comfyui(action:'panel') (#784) — naming it there is the same dead end the
 * bridge refusal had.
 */
const UNPIN_INSTRUCTION = (): string =>
  describeInstallPanelAction(
    "unpin",
    "removing the pin on the ComfyUI host (its ~/.comfyui-mcp/panel-settings.json, " +
      "or the COMFYUI_MCP_PANEL_PIN variable there) and restarting the orchestrator " +
      "running on that machine",
  );

/**
 * The one thing an `up-to-date` verdict was missing.
 *
 * "Nothing to do" is true and, to a user whose graph writes are being refused
 * for a too-old panel, completely useless — it is the last step of the loop that
 * made #771/#784 feel unfixable. The reason both can be true at once is that the
 * write gate reads what the browser TAB advertised, and the panel's module URLs
 * carry no cache-busting key: a tab holding the pre-0.11.35 copy of the file
 * that builds the `hello` announces the old capability set while the pack on
 * disk is current. So the honest completion of "nothing to do" is "…and if
 * writes are still refused, the tab is the stale part".
 *
 * Phrased conditionally on purpose: this function cannot see the tab's
 * handshake, so it must not assert that a skew IS happening. The bridge refusal
 * (which sees both) makes the definite call. (Cache-busting itself is
 * #584 / panel #596 and is not addressed here.)
 */
const STALE_BUNDLE_HINT =
  ` If graph WRITES are still being refused for a too-old panel, the install is not ` +
  `the problem — the open ComfyUI browser tab is running a CACHED older copy of the ` +
  `panel's JavaScript, and the capability check reads what the tab announced. ` +
  `Hard-refresh that tab with a cache-bypassing reload (Ctrl+Shift+R, or Cmd+Shift+R ` +
  // NOT "updating the pack will report nothing to do" — that was true only while
  // this verdict was believed to mean "you are on the newest panel". An update
  // CAN pull a newer panel (see FLOOR_IS_NOT_LATEST, #806); what it cannot do is
  // fix a stale TAB. Say the thing that stays true in both worlds.
  `on macOS). Updating the pack may pull a newer panel, but no update of any kind ` +
  `replaces the JavaScript an already-open tab is running.`;

/** Where a human can read the newest published panel version. Deliberately the
 *  pack's `pyproject.toml` and NOT the repo's GitHub releases: the panel ships to
 *  the Comfy Registry on a pyproject version change, and its releases page lags
 *  or omits versions entirely, so "latest release" is the wrong answer. */
const PANEL_PYPROJECT_URL =
  "https://github.com/artokun/comfyui-mcp-panel/blob/main/pyproject.toml";

/**
 * The sentence a floor check owes the reader (#806).
 *
 * Clearing the floor and being current are different claims, and the gap between
 * them is where a real user's bug lived for days. `PANEL_VERSION` is the Manager
 * channel name ("nightly"), not a version number, so this file cannot close that
 * gap by itself: the honest move is not to guess a latest version, it is to STOP
 * IMPLYING ONE — name what was compared, say the comparison's limit out loud, and
 * point at the two things that do move the user (the update action, and the file
 * where the real latest is published).
 *
 * #1983 — a caller CAN now close it, by resolving the published version and
 * passing `latestVersion`. `latestKnown` then drops the "does not know the newest
 * published panel" clause, because on that call it is no longer true. When no
 * lookup was made this text is unchanged, which is still the state on the hello
 * auto-sync path.
 *
 * A function, not a constant: the update instruction depends on whether
 * install_comfyui(action:'panel') can act in THIS session.
 */
const FLOOR_IS_NOT_LATEST = (latestKnown = false): string =>
  ` NOTE — that is a FLOOR check, not a latest-version check. It compares your panel ` +
  `against the MINIMUM this orchestrator requires; ` +
  // #1983 — the caller can now resolve the newest published panel and hand it
  // in. When it did, "it does not know the newest published panel" is no longer
  // true and must not be said: the concrete comparison follows in LATEST CHECK.
  (latestKnown ? `` : `it does not know the newest published panel, and `) +
  `most panel fixes ship WITHOUT raising the floor. So a newer panel carrying ` +
  `fixes you are missing can exist while this still reads "meets the minimum". ` +
  (latestKnown
    ? `That is what the LATEST CHECK below answers.`
    : `The newest version is published in the pack's pyproject.toml (${PANEL_PYPROJECT_URL}); ` +
      `to pull it, run ${describeInstallPanelAction("update", "the update on the ComfyUI host")}.`);

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
  /**
   * The installed panel CLEARS THE FLOOR this orchestrator requires.
   *
   * #806 — this was `up-to-date`, which answers a question nothing here asks.
   * The comparison is against `requiredPanelVersion()`, the MINIMUM this build
   * needs. Whether a NEWER panel is published is a separate field (`behindLatest`,
   * #1983) that only the callers which actually looked it up can fill in. A
   * user on 0.11.36 with 0.11.38 published, whose bug was fixed in 0.11.37, was
   * told "up-to-date" and stopped looking. Most panel fixes never raise the
   * floor, so the population this verdict most misleads is exactly the one that
   * most needs an update.
   *
   * `behind: false` on this decision therefore means "not below the floor", NOT
   * "current".
   */
  | "meets-floor"
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
   *
   * #1983 — this is the FLOOR answer and nothing else. `false` means "not below
   * the minimum this orchestrator needs", NOT "on the newest published panel".
   * That second question is `behindLatest`.
   */
  behind: boolean;
  /**
   * #1983 — the newest PUBLISHED panel, when the caller resolved one. Absent
   * when no lookup was made, when it failed, or when the answer was not a
   * comparable version.
   */
  latestPublishedVersion?: string;
  /**
   * #1983 — is a newer panel PUBLISHED than the one installed? A different
   * question from `behind`, and answered separately on purpose:
   *
   *  - `true`  → a newer published panel exists. STALE, not unsupported: this
   *              is advisory and blocks nothing.
   *  - `false` → we compared against the newest published panel and you are on
   *              it. Only ever set when that comparison really happened.
   *  - `null`  → UNKNOWN. No lookup was made, the lookup failed, or the versions
   *              are not comparable. `null` and not `undefined` because this
   *              object is JSON.stringify'd to the agent and `undefined` keys
   *              are DROPPED — the can't-tell state would vanish off the wire
   *              and read as "not behind", which is the exact lie #1983 is
   *              about. Same reasoning as `PanelSyncResult.stillBehind`.
   */
  behindLatest: boolean | null;
  /** Plain-language explanation for the user. */
  summary: string;
}

export interface EvaluateOptions {
  /** Override for tests; defaults to the running package's version. */
  orchestratorVersion?: string;
  /** Override for tests; defaults to the derived requirement. */
  requiredVersion?: string;
  /**
   * #1983 — the newest PUBLISHED panel, resolved by the caller.
   *
   * This function stays synchronous and pure: the registry lookup lives in the
   * already-async caller (`panelAction`), which hands the answer in. Three
   * states, and they are NOT interchangeable:
   *
   *  - a version string → the probe resolved; compare against it.
   *  - `null`           → the probe RAN and could not determine the latest. Say
   *                       so; never report "not behind" on a failed lookup.
   *  - `undefined`      → no probe was made on this path (hello auto-sync, the
   *                       sync re-check). The floor note keeps saying the latest
   *                       is not known here, which on those paths is true.
   */
  latestVersion?: string | null;
}

/**
 * Pure decision function over a `PanelStatus` snapshot. No I/O, no mutation —
 * every branch is directly testable, which is the point: this is the logic that
 * decides whether we are allowed to touch a user's install.
 *
 * #1983 — TWO comparisons, never folded into one. `behind` answers "is this
 * panel below the FLOOR this orchestrator needs" (too old to work with);
 * `behindLatest` answers "is a newer panel PUBLISHED" (merely stale). A
 * below-floor panel is unsupported and gets a sync decision; a stale one is
 * advisory and changes no decision at all. Collapsing them either way is the
 * defect: reporting a 16-versions-behind panel as `behind:false` (#1983), or
 * turning "a newer one exists" into a refusal.
 */
export function evaluatePanelSync(
  status: PanelStatus,
  opts: EvaluateOptions = {},
): PanelSyncAssessment {
  const latest = compareAgainstLatest(status, opts.latestVersion);
  const floor = evaluateAgainstFloor(status, opts, latest.latestPublishedVersion !== undefined);
  return {
    ...floor,
    latestPublishedVersion: latest.latestPublishedVersion,
    behindLatest: latest.behindLatest,
    summary: floor.summary + latestNote(status, latest, opts.latestVersion),
  };
}

interface LatestComparison {
  latestPublishedVersion?: string;
  behindLatest: boolean | null;
  /** Why the answer is `null`, so the summary can say the true reason. */
  unknownBecause?: "no-latest" | "untrusted-install" | "incomparable" | "not-applicable";
}

/**
 * The LATEST comparison, kept away from the floor one on purpose.
 *
 * Every "can't tell" resolves to `null` — the module's own rule. `false` here
 * is a claim ("I compared you against the newest published panel and you are on
 * it") and may only be returned when that comparison actually happened.
 */
function compareAgainstLatest(
  status: PanelStatus,
  latestVersion: string | null | undefined,
): LatestComparison {
  const latest =
    typeof latestVersion === "string" && isComparableVersion(latestVersion)
      ? latestVersion.trim()
      : undefined;
  if (!latest) return { behindLatest: null, unknownBecause: "no-latest" };
  // No panel of ours here at all (remote / cloud / no local ComfyUI): there is
  // nothing on this machine for the published version to be newer THAN.
  if (!status.applicable) {
    return { latestPublishedVersion: latest, behindLatest: null, unknownBecause: "not-applicable" };
  }
  // The states where THIS FILE already refuses to make a version claim, because
  // `installedVersion` does not describe what is really being served: an
  // unreliable custom_nodes enumeration, a failed shadow scan, or a shadow copy
  // that ComfyUI may be loading instead. Comparing an untrusted version against
  // the newest published one would launder that same untrusted number into a
  // fresh confident claim (`blocked` + "you are 16 behind"), which is the defect
  // in a new costume. Can't tell → don't answer.
  if (
    status.scanReliable === false ||
    status.shadowInspectFailed === true ||
    (status.shadows?.length ?? 0) > 0
  ) {
    return {
      latestPublishedVersion: latest,
      behindLatest: null,
      unknownBecause: "untrusted-install",
    };
  }
  if (!status.installed) {
    // Same discipline as `behind`: a PROVEN absence is definitionally behind
    // anything published; an unproven one is a failed observation.
    return status.absenceProven === false
      ? { latestPublishedVersion: latest, behindLatest: null, unknownBecause: "untrusted-install" }
      : { latestPublishedVersion: latest, behindLatest: true };
  }
  if (!isComparableVersion(status.installedVersion)) {
    return { latestPublishedVersion: latest, behindLatest: null, unknownBecause: "incomparable" };
  }
  return {
    latestPublishedVersion: latest,
    behindLatest: compareSemver(status.installedVersion, latest) < 0,
  };
}

/**
 * The pin as `evaluatePanelSync` reads it. Shared so the verdict and the latest
 * advisory cannot disagree about whether a pin is in force — a MISSING pin field
 * resolves to indeterminate-PINNED, and an advisory that read it as unpinned
 * would send that user at an update the pin guard is going to refuse.
 */
function resolvePin(status: PanelStatus): PanelPinState {
  return status.pin && typeof status.pin === "object"
    ? status.pin
    : { pinned: true, source: "settings", indeterminate: true };
}

/**
 * The sentence the latest comparison owes the reader — appended to every
 * verdict, because the defect showed up on `dev-install` just as readily as on
 * `meets-floor` (#1983's own reproduction landed on the dev branch).
 *
 * Deliberately ADVISORY in every wording: being behind the newest published
 * panel blocks nothing, refuses nothing and changes no decision above it.
 */
function latestNote(
  status: PanelStatus,
  latest: LatestComparison,
  requested: string | null | undefined,
): string {
  // Nothing was asked on this path — FLOOR_IS_NOT_LATEST already says the
  // latest is unknown here, and inventing a second sentence about a lookup that
  // never ran would be noise.
  if (requested === undefined) return "";
  const published = latest.latestPublishedVersion;
  if (!published) {
    return (
      // "did not answer USABLY" covers both shapes: no answer at all, and an
      // answer that is not a version we can compare (a "nightly" pyproject, a
      // body from the wrong pack). Saying "did not answer" would be wrong in the
      // second case, which is the same species of small lie as the rest of this.
      ` LATEST CHECK: the newest published panel could not be determined just now ` +
      `(the version lookup did not answer usably). Only the FLOOR comparison above was made — ` +
      `this is NOT evidence that you are on the newest panel. Check by hand at ` +
      `${PANEL_PYPROJECT_URL}, or re-run this once the network is back.`
    );
  }
  if (latest.behindLatest === null) {
    const why =
      latest.unknownBecause === "untrusted-install"
        ? `what is actually installed here could not be established (see above), so it cannot ` +
          `be compared against it`
        : latest.unknownBecause === "not-applicable"
          ? `no panel of this orchestrator's is managed on this machine, so there is nothing ` +
            `here for it to be newer than`
          : `the installed version (${status.installedVersion ?? "unreadable"}) is not a ` +
            `comparable version number, so it cannot be compared against it`;
    return ` LATEST CHECK: the newest published panel is ${published}, but ${why} — whether you are behind it is UNKNOWN.`;
  }
  if (latest.behindLatest === false) {
    // `false` was established as "NOT OLDER than the newest published panel",
    // and that includes being AHEAD of it — which a dev checkout tracking the
    // panel repo's main routinely is, and which is exactly the install shape
    // #1983 reproduced on. Saying "you are on it" there asserts a version
    // EQUALITY nothing here proved: it names a version the reader is not
    // running. That is the same unearned claim, one size smaller, that this
    // whole comparison exists to delete — so the two cases get two sentences.
    return isComparableVersion(status.installedVersion) &&
      compareSemver(status.installedVersion, published) > 0
      ? ` LATEST CHECK: your panel (${status.installedVersion}) is NEWER than the newest ` +
          `published one (${published}), so there is nothing to pull.`
      : ` LATEST CHECK: ${published} is the newest published panel, and you are on it.`;
  }
  const from = status.installedVersion ? `${status.installedVersion} → ` : "";
  const pinned = resolvePin(status).pinned;
  /*
   * THE REMEDY TABLE — exhaustive on purpose.
   *
   * WHICH remedy is named is not cosmetic: a remedy that cannot succeed from
   * the state it is printed in is a bug (#771/#784, #1933), not a wording nit.
   * Two dead-end remedies have now been found in this one sentence — dev
   * symlinks and pins pointed at an update that refuses them, then an ABSENT
   * pack pointed at the same one — so every state that can reach here is
   * enumerated rather than falling through a default. Absence is the case
   * where the VERB changes entirely rather than merely being inapplicable,
   * which is exactly how it slipped past the first pass.
   *
   * Only `behindLatest === true` reaches this, which narrows it to:
   *
   *   dev symlink        → nothing here. The dev-install verdict above already
   *                        says "update it through its own git checkout", and
   *                        nothing in this process may touch that install.
   *   NOT INSTALLED,     → SYNC, never update. `runPanelActionCore` rethrows
   *   unpinned             the Manager's "not installed" for action:"update"
   *                        once the on-disk scan agrees the pack is absent —
   *                        there is genuinely nothing to update — while
   *                        `performPanelSync` picks `install` when
   *                        `before.installed` is false. The verdict above says
   *                        "Syncing will install it", so naming the same verb
   *                        keeps the reply speaking with one voice.
   *   NOT INSTALLED,     → clear the pin. Installing the nightly channel would
   *   pinned               land some version other than the pinned one, so the
   *                        pin is genuinely the first step (the `pinned-warn`
   *                        verdict says the same).
   *   installed, pinned  → clear the pin.
   *   installed, plain   → update. The one state that verb actually works in.
   */
  const remedy = status.isDevSymlink
    ? ``
    : pinned
      ? ` You are pinned, so moving onto it means clearing the pin first (${UNPIN_INSTRUCTION()}).`
      : status.installed
        ? ` To pull it, run ${describeInstallPanelAction("update", "the update on the ComfyUI host")}.`
        : ` To install it, run ${describeInstallPanelAction("sync", "the panel sync on the ComfyUI host")}.`;
  // An absent pack has no version for a published one to be "newer" THAN, so
  // the behind-latest framing is wrong here even though `behindLatest` is
  // correctly true: say what an install would land instead.
  if (!status.installed) {
    return (
      ` LATEST CHECK: the newest published panel is ${published} — that is what installing ` +
      `here would land. Nothing is blocked by this and nothing has been changed.${remedy}`
    );
  }
  return (
    ` LATEST CHECK: a NEWER panel is published (${from}${published}). Nothing is blocked ` +
    `by this and nothing has been changed — it is an advisory.${remedy}`
  );
}

/**
 * The FLOOR half — the original decision body, unchanged in behaviour. It knows
 * whether a latest version was resolved only so its own note stops claiming the
 * newest panel is unknown when the caller just looked it up.
 */
function evaluateAgainstFloor(
  status: PanelStatus,
  opts: EvaluateOptions,
  latestKnown: boolean,
): Omit<PanelSyncAssessment, "behindLatest" | "latestPublishedVersion"> {
  const required = opts.requiredVersion ?? requiredBridgePanelVersion();
  const orchestratorVersion =
    opts.orchestratorVersion ?? detectInstallMode().currentVersion ?? undefined;
  // A PanelStatus without a `pin` is a caller that predates the pin (or built
  // the object by hand). Absence of the field is not evidence of absence of a
  // pin, so it resolves to indeterminate-pinned, not to unpinned.
  const pin: PanelPinState = resolvePin(status);

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
  // Proven-behind is a VERSION fact, independent of whether we are allowed to
  // act on it. Kept separate from `driftNote` (which is about a PIN) so a branch
  // that declines to touch the install still reports the drift honestly.
  const provenBehind =
    !!status.installedVersion &&
    isComparableVersion(status.installedVersion) &&
    compareSemver(status.installedVersion, required) < 0;
  const driftNote = (() => {
    if (!pin.pinned || pin.indeterminate) return "";
    if (!status.installedVersion || !isComparableVersion(status.installedVersion)) return "";
    if (compareSemver(status.installedVersion, required) >= 0) return "";
    return (
      ` NOTE: the panel is ${describePanelPin(pin)} and BEHIND what ${orch} ` +
        `expects (${status.installedVersion} < ${required}) — left untouched; ` +
        `close the gap by ${UNPIN_INSTRUCTION()}.`
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
      // A dev checkout is one we never TOUCH — that is not a reason to report it
      // as current. `behind` is documented as "we PROVED the panel is older than
      // requiredPanelVersion", and a comparable dev version below the floor is
      // exactly that proof. Hardcoding false here made a 0.15.3 checkout under a
      // 0.15.11 floor indistinguishable from an up-to-date one, so a panel
      // carrying already-fixed bugs read as healthy in every status call.
      behind: provenBehind,
      summary:
        `The panel at ${status.dir ?? "custom_nodes"} is a dev symlink — update it ` +
        `through its own git checkout. Nothing here will modify it.` +
        (provenBehind
          ? ` NOTE: it is BEHIND what ${orch} expects ` +
            `(${status.installedVersion} < ${required}) — pull its checkout to close the gap.`
          : "") +
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
    // #766 — "not installed" is only actionable when the absence is PROVEN.
    // When the ComfyUI root came from configuration rather than from the running
    // server, a perfectly good panel may be sitting in the tree that is actually
    // served, and installing would drop a second copy into a custom_nodes
    // nothing loads — the user then sees no panel and no error. Refuse to act on
    // an unproven absence, exactly as we refuse on an unreliable scan above.
    if (status.absenceProven === false) {
      return {
        ...base,
        decision: "blocked",
        behind: false,
        summary:
          `No panel was found in ${status.comfyuiPath ?? "custom_nodes"}, but that root ` +
          `was NOT confirmed by the running ComfyUI — so this is not a proven absence ` +
          `and nothing will be installed. On a split install (Comfy Desktop's ` +
          `--base-directory, #766) the panel lives in a different tree and installing ` +
          `here would land in a custom_nodes that is never loaded. Make sure ComfyUI is ` +
          `running and reachable so its own install root can be read, or check ` +
          `install_comfyui (action:"environment")'s local.workspace_path, then re-check.` +
          driftNote,
      };
    }
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
          `Clear the pin (${UNPIN_INSTRUCTION()}) to let the sync install it.`,
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
          `be changed either way. Clear the pin (${UNPIN_INSTRUCTION()}) ` +
          `first if you want to move the panel at all.`,
      };
    }
    return {
      ...base,
      decision: "unknown",
      behind: false,
      summary:
        `${cannotCompare} NOT syncing on a guess — check the pack's pyproject.toml, ` +
        `or run ${describeInstallPanelAction("update", "the update on the ComfyUI host")} ` +
        `deliberately.`,
    };
  }

  const behind = compareSemver(status.installedVersion, required) < 0;

  if (pin.pinned) {
    if (!behind) {
      return {
        ...base,
        decision: "meets-floor",
        behind: false,
        summary:
          `Panel ${status.installedVersion} meets the minimum ${orch} needs ` +
          `(${required}+). You are ${describePanelPin(pin)}; nothing will be changed.` +
          // The pinned reader gets the same honesty, with the step that actually
          // applies to them: an update is gated behind clearing the pin, so
          // sending them straight at install_comfyui(action:'panel', panel_action:'update') would be the
          // dead-end shape this cluster exists to remove.
          ` NOTE — that is a FLOOR check, not a latest-version check: a newer panel with ` +
          `fixes you are missing can exist while this still reads "meets the minimum", ` +
          `because most panel fixes do not raise the floor. The newest version is published ` +
          `in the pack's pyproject.toml (${PANEL_PYPROJECT_URL}). To move onto it you must ` +
          `first clear the pin (${UNPIN_INSTRUCTION()}).`,
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
        `(${UNPIN_INSTRUCTION()}` +
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
      decision: "meets-floor",
      behind: false,
      summary:
        `Panel ${status.installedVersion} meets the minimum ${orch} needs ` +
        `(${required}+), so nothing will be synced.${FLOOR_IS_NOT_LATEST(latestKnown)}${STALE_BUNDLE_HINT}`,
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
 * #888 — the authoritative re-check behind the hello auto-sync FAILURE path.
 *
 * The sync's own pre-scan runs inside the reconnect/retarget window, where the
 * base it freezes can describe the tree ComfyUI is ABOUT to be retargeted away
 * from (or a tree read before a just-restarted server named its real root). A
 * failure minted from that scan — "the pack is not present in custom_nodes" —
 * can therefore be stale the moment it is thrown, while an immediate
 * install_comfyui(action:'panel', panel_action:'status') shows the panel
 * installed and compatible.
 * Pushing that detail to the user as-is warns about a state that does not exist.
 *
 * So before the failure is surfaced, the caller re-asks the ONE question the
 * whole sync exists to answer, against a FRESHLY resolved base: does the panel
 * on disk meet this orchestrator's floor? A proven `meets-floor` verdict means
 * the sync's goal is already met and the failure's warning would be false.
 *
 * Returns the fresh assessment, or null when the re-scan itself could not run
 * (base unresolvable, disk unreadable, …). A "can't tell" NEVER counts as
 * proof the warning was false — the caller keeps the original warning then.
 *
 * Note on the narrow opposite case: if the failed sync DID move the pack and
 * only its verification threw, a meets-floor re-scan means the update landed
 * and the floor is met — the warning's "no update was claimed" is equally
 * false, so suppressing is still the truthful outcome. The stale-RUNNING-panel
 * restart guidance that case loses is carried by the write gate's own refusal
 * (it reads what the tab advertises and names the skew), so the user is not
 * left without a path.
 */
export async function reassessPanelAfterSyncFailure(
  opts: PerformSyncOptions = {},
): Promise<PanelSyncAssessment | null> {
  const deps = opts.deps ?? defaultDeps;
  try {
    // Same fresh, frozen base resolution the sync itself used — forced, because
    // a hello can mean ComfyUI just restarted onto a different tree, and a cached
    // base is precisely how the stale reading this re-check exists to catch was
    // minted. panelStatus is a pure read and holds no lock, so this can run right
    // behind the failed sync without contending with the op lock it released.
    const pinnedDeps = await pinPanelBase(deps, { force: true });
    const status = await panelStatus(pinnedDeps);
    return evaluatePanelSync(status, {
      orchestratorVersion: opts.orchestratorVersion,
      requiredVersion: opts.requiredVersion,
    });
  } catch {
    // Every guard is itself an operation that can fail. A failed re-check is
    // "could not determine", never "determined fine" — report nothing.
    return null;
  }
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
  // #1828 / #1953 — hello auto-sync is unattended. An abandoned panel-op.lock
  // (recorded owner provably dead — including a fresh one left by a
  // self-restart) used to fail it every session for days, while the timeout
  // named panel_action:'unlock' as the recovery nobody was there to run.
  // Reclaim uses that same verified path (owner re-checked dead, rename-aside
  // + byte compare); a live or reuse-ambiguous lock still refuses and acquire
  // waits/times out as before. Explicit panel_action:'sync' shares this
  // function, so it unblocks the same way.
  reclaimAbandonedPanelLock();
  // The status read, the DECISION, and the mutation all run inside the op
  // lock: a decision made outside could go stale before the lock is acquired,
  // and a newer panel installed in that gap would be blindly overwritten by
  // the stale decision (codex gate). runPanelAction's own wrapper would lock
  // only the mutation half, so this calls the inner action directly.
  return withPanelOpLock(async () => {
    // Freeze the ComfyUI base for the WHOLE sync, not per-call. This function
    // makes three separate reads of the install — the pre-decision status, the
    // mutation's own pre/post detection, and the post-status re-read — and the
    // honesty of every claim it makes depends on all three describing the same
    // directory. Pinning inside each callee is not enough: the live-base cache
    // has a short TTL and a Manager operation can outlive it, so two calls could
    // resolve different trees (see pinPanelBase).
    // A sync is what the orchestrator runs on every panel HELLO, which is also
    // the signal that ComfyUI may have just restarted — possibly with different
    // launch flags, and therefore a different custom_nodes. Force a fresh
    // resolution rather than serving a cached base that could describe the
    // previous process. (pinPanelBase only probes for the REAL dep set; an
    // injected one has already declared where ComfyUI is.)
    const pinnedDeps = await pinPanelBase(deps, { force: true });
    const before = await panelStatus(pinnedDeps);
    const assessment = evaluatePanelSync(before, {
      orchestratorVersion: opts.orchestratorVersion,
      requiredVersion: opts.requiredVersion,
    });

    if (assessment.decision !== "sync") {
      // EVERY return path, not just the one that mutated. This verdict was
      // computed from a status read of the FROZEN tree, and a retarget can land
      // while that read is awaited — handing target A's "already meets what this
      // orchestrator needs" to a tab that now belongs to B, which may be far
      // behind. A non-mutating answer about the wrong install is still a wrong
      // answer, and this one gets pushed straight into the panel chat.
      assertPinnedTarget(pinnedDeps, "sync", `before reporting "${assessment.decision}"`);
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
    const result = await runPanelActionInner(action, pinnedDeps);

    // Re-read from disk. `runPanelAction` already proved movement, but the version
    // we hand back to the user must be one we OBSERVED after the fact, not the one
    // the installer intended or reported.
    const after = await panelStatus(pinnedDeps);
    if (!after.installed || !after.installedVersion) {
      throw new Error(
        `Panel ${action} reported success, but re-reading the pack afterwards could ` +
          `not confirm an installed version${after.dir ? ` at ${after.dir}` : ""}. NOT ` +
          `reporting a completed sync. Check custom_nodes and re-run ` +
          `${describeInstallPanelAction("status", "re-checking the pack on the ComfyUI host")}.`,
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
          `${describeInstallPanelAction("status", "a re-check on the ComfyUI host")} once custom_nodes is readable.`,
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

    // The action checked the frozen target before IT returned, but this
    // function then does another awaited status read and publishes its own
    // success — which the orchestrator pushes straight into the panel chat. A
    // retarget in that last gap would announce a verified sync of tree A to a
    // tab that now belongs to B. Re-assert before the claim leaves here.
    assertPinnedTarget(pinnedDeps, "sync", "before reporting a completed sync");
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
