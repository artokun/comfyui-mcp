// Where does THE PANEL live? (#766, #769)
//
// Every other filesystem-backed tool asks `resolveEffectiveComfyUIBase()` — a
// SYNCHRONOUS reader of COMFYUI_PATH / the saved default workspace. That is the
// right answer for "where do models go", but it is the WRONG question for the
// sidebar panel, because the panel is not a file the user reads: it is a web
// extension that the RUNNING ComfyUI serves to the browser tab. The only
// custom_nodes that can possibly matter is the one belonging to the server this
// orchestrator is actually talking to.
//
// Two real deployments broke because those two answers differ:
//
//  - #766 (Comfy Desktop dual-path). Desktop launches ComfyUI out of its own
//    program directory but passes `--base-directory <Documents\ComfyUI>`, and
//    ComfyUI derives custom_nodes/ from THAT. The configured workspace pointed
//    at the program directory, so install_comfyui(action:'panel') reported `installed: false`
//    while a perfectly good 0.11.x panel sat in the Documents tree — and any
//    install would have landed in a custom_nodes the server never reads.
//
//  - #769 (no configured workspace at all). `install_comfyui (action:"environment")` already resolves
//    the live root from the serving process and reports it as the local
//    workspace, but install_comfyui(action:'panel') asked the sync resolver, got nothing, and
//    refused with "no local ComfyUI (COMFYUI_PATH) is configured" about an
//    install it had just been told the path to.
//
// So: resolve LIVE-FIRST, exactly like `resolveInstallInterpreter` does for the
// interpreter — the running server's own launch argv is the ground truth, and a
// configured path is the fallback, not the other way round. Two guard rails keep
// that honest:
//
//  1. A live-derived base is only ACCEPTED when it actually contains a
//     `custom_nodes` directory. Otherwise we would confidently point the panel
//     tooling at a tree that has none and report a false "not installed".
//  2. Nothing here is a guess. If the server is unreachable, or its argv yields
//     no resolvable root, we fall straight back to the configured base and SAY
//     which one we used (`source`), so a wrong answer is diagnosable instead of
//     silent.
//
// Remote/cloud mode resolves to nothing at all: the live root is a path on
// SOMEONE ELSE'S filesystem and must never be handed to a local `join()`.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  getComfyUIBaseUrl,
  getComfyuiTargetGeneration,
  isLocalMode,
} from "../config.js";
import { parsePyproject } from "./node-authoring.js";
import { parseBaseDirFromArgv } from "./output-dir.js";
import {
  getLiveServerSnapshot,
  liveRootFromArgv,
  resolveEffectiveComfyUIBase,
  resolveLocalWorkspaceBase,
} from "./workspace-env.js";

/** How the panel's ComfyUI base was resolved — reported so it is diagnosable. */
export type PanelBaseSource =
  /** The running server's `--base-directory` (Comfy Desktop dual-path, #766). */
  | "live-base-directory"
  /** The running server's own install root, from its launch argv (#769). */
  | "live-argv-root"
  /** COMFYUI_PATH or the saved default workspace. */
  | "configured"
  /** Remote/cloud, or nothing resolvable. */
  | "none";

export interface PanelBaseResolution {
  /** The custom_nodes PARENT. undefined ⇒ panel management is not applicable. */
  base?: string;
  source: PanelBaseSource;
  /**
   * What the ordinary sync resolver would have said. Present whenever it
   * DISAGREES with `base` — the #766 signal, worth surfacing to the user.
   */
  overriddenConfiguredBase?: string;
  /**
   * True when `/system_stats` could not be reached, so the running server had
   * NO say in this answer. It matters because the fallback is the configured
   * path — and on a Comfy Desktop split install that is precisely the tree the
   * server does NOT read (#766). A transient probe failure therefore looks
   * identical to "there is no split", which is fine for a read but not for a
   * destructive write: see the corroboration gate in panel-installer.
   */
  liveProbeFailed?: boolean;
  /**
   * True when the server WAS reached but no live root could be derived from
   * what it reported: no `--base-directory`, and its argv yielded no absolute
   * install root holding custom_nodes (argv absent, no positional main.py, or
   * a RELATIVE main.py with no reported cwd — the common `python main.py` /
   * portable-launcher shape). Distinct from liveProbeFailed: "start ComfyUI"
   * is a dead remedy here because ComfyUI is already running (#890/#916).
   */
  liveRootUnderivable?: boolean;
  /**
   * The live root that was skipped because its `custom_nodes` could NOT BE READ
   * — a permission error, an IO error, a share that went away — as distinct from
   * one that provably has none (#796).
   *
   * Both used to end here identically, and the difference decides what the
   * fallback means: falling back to the CONFIGURED tree after disproving the
   * live one is a conclusion, while doing it after failing to read the live one
   * is a guess wearing the same clothes. On a Desktop split install the
   * configured tree is exactly the one the server does not read, so a caller
   * about to write needs to know which of the two it is standing on.
   */
  liveRootUnreadable?: string;
}

/**
 * Did the RUNNING SERVER actually choose this root?
 *
 * "Reachable" is not the same thing and must never stand in for it. A
 * `/system_stats` response with absent or unparseable argv proves only that
 * something answered — it says nothing about whether COMFYUI_PATH is the tree
 * that server reads. On a Comfy Desktop split install those differ, so a
 * configured base is a plausible READ but never authority for a destructive
 * write, nor for certifying which panel the browser is loading.
 *
 * Only the two live-derived sources qualify.
 */
export function isLiveDerivedBase(
  resolution: PanelBaseResolution | undefined,
): boolean {
  return (
    resolution?.source === "live-base-directory" ||
    resolution?.source === "live-argv-root"
  );
}

/**
 * Does this candidate root hold a `custom_nodes` directory — THREE answers (#796).
 *
 * `statSync` throws for two entirely different reasons and this returned `false`
 * for both. ENOENT/ENOTDIR is a real answer: nothing is there. EACCES, EPERM,
 * EIO, EBUSY and a dead UNC share are NOT — they mean the question could not be
 * asked. This file already knows that hazard; `safeExists` a few hundred lines
 * down avoids UNC paths precisely because "a dead network share can block
 * existsSync for seconds".
 *
 * Folding them mattered here because of what the caller does next: an unreadable
 * LIVE root is skipped, the resolution falls back to the CONFIGURED path, and
 * the panel installer then operates on a different tree — while the caller's own
 * comment says the point is to accept only a base we can PROVE holds
 * custom_nodes. A base we could not read is not disproof.
 */
type CustomNodesState = "present" | "absent" | "unknown";

function customNodesState(base: string): CustomNodesState {
  try {
    return statSync(join(base, "custom_nodes")).isDirectory() ? "present" : "absent";
  } catch (err) {
    // Only these two prove absence. Everything else — permissions, IO, a share
    // that went away — is an unanswered question, not a negative answer.
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unknown";
  }
}

/**
 * Resolve the ComfyUI root whose `custom_nodes` serves the panel, preferring the
 * LIVE server over any configured path. Never throws; returns `source: "none"`
 * when nothing local is resolvable.
 */
export async function resolvePanelBase(): Promise<PanelBaseResolution> {
  // Remote/cloud: the serving filesystem is not ours. Do not fall back to a
  // configured local path — that dir is not the panel the browser loads.
  if (!isLocalMode()) return { source: "none" };

  const configured = resolveEffectiveComfyUIBase();
  const snapshot = await getLiveServerSnapshot();
  /** #796 — a live candidate whose custom_nodes could not be READ (permissions,
   *  IO, a dead share), as opposed to one that provably lacks it. */
  let liveRootUnreadable: string | undefined;
  if (snapshot.reachable) {
    // `--base-directory` FIRST: when ComfyUI is launched with it, that flag —
    // not the main.py location — is the root it derives custom_nodes/ from.
    const candidates: Array<[string | undefined, PanelBaseSource]> = [
      [parseBaseDirFromArgv(snapshot.argv, snapshot.cwd), "live-base-directory"],
      [liveRootFromArgv(snapshot.argv, snapshot.cwd), "live-argv-root"],
    ];
    for (const [candidate, source] of candidates) {
      // Only accept a live base we can PROVE holds custom_nodes. An argv root
      // without one is not the tree the panel lives in, and pointing the
      // installer at it would manufacture a false "not installed".
      if (!candidate) continue;
      const state = customNodesState(candidate);
      if (state === "unknown") {
        // #796 — STILL SKIPPED: "we could not read it" is not the proof this
        // branch requires, and loosening a guard on an unread directory is the
        // wrong direction. But it is not disproof either, so it is recorded
        // instead of vanishing — the fallback below otherwise hands the caller a
        // CONFIGURED tree while silently implying the live one was disqualified
        // on the evidence.
        liveRootUnreadable ??= candidate;
        continue;
      }
      if (state === "absent") continue;
      return {
        base: candidate,
        source,
        overriddenConfiguredBase:
          configured && configured !== candidate ? configured : undefined,
      };
    }
  }

  const liveProbeFailed = !snapshot.reachable;
  // Reached but nothing derivable: tell callers apart from "could not ask" —
  // the remedy for each is different (#916).
  const liveRootUnderivable = snapshot.reachable;
  if (configured) {
    return {
      base: configured,
      source: "configured",
      liveProbeFailed,
      liveRootUnderivable,
      liveRootUnreadable,
    };
  }
  return { source: "none", liveProbeFailed, liveRootUnderivable, liveRootUnreadable };
}

/*
 * The resolution is async (it reads /system_stats), but `PanelInstallerDeps
 * .comfyuiPath` is synchronous and is consulted from several places inside one
 * operation (detection, the shadow scan, the post-op re-read). Those MUST all
 * see the same answer — a base that changed halfway through would make the
 * "did the pack move?" proof compare two different directories.
 *
 * So the async resolution is primed ONCE at the top of each panel operation and
 * cached; the sync accessor serves that cache. The cache is keyed on the ComFYUI
 * TARGET URL, so retargeting the orchestrator at a different server can never
 * serve the previous one's base — and it expires on a short TTL so a restarted
 * server with new launch flags is picked up without a retarget.
 */
const PANEL_BASE_TTL_MS = 60_000;

let cached:
  | { at: number; target: string; generation: number; resolution: PanelBaseResolution }
  | undefined;

/**
 * How many times the cache has been deliberately CLEARED (#1222).
 *
 * The in-flight guard below compares `cached` by reference to catch "a newer
 * write landed while we were probing". That comparison has one blind spot, and
 * it is the one that bites: a probe which STARTS with an empty cache records
 * `undefined`, a clear leaves it `undefined`, and the two compare equal — so the
 * clear is invisible and the stale probe writes its pre-clear answer in
 * afterwards.
 *
 * A clear is an EVENT, not a value, so counting it is what makes it observable.
 * `undefined → undefined` is indistinguishable by reference and unmistakable by
 * count.
 */
let clearEpoch = 0;

/**
 * Forget the resolved base, countably (#1222).
 *
 * The one way to clear it deliberately. A bare `cached = undefined` at a fourth
 * call site would reintroduce the whole bug silently — the clear would happen and
 * an in-flight probe would put its pre-clear answer straight back — so the count
 * lives with the assignment rather than next to it.
 *
 * NOT used by the retarget bail inside `primePanelBase`. That one is discarding
 * its OWN answer because the target moved, and the target/generation checks
 * already stop anyone acting on it. Bumping there would additionally stop a
 * CONCURRENT probe against the new target from caching a result that is
 * perfectly good — which costs a re-probe rather than correctness, so it is a
 * deliberate scope line and not a safety one. Stated that way because it is not
 * pinned by a test: mutating it to bump changes no observable answer, only how
 * often the next caller re-resolves, and a test asserting that would be pinning
 * a performance detail as though it were a contract.
 */
function forgetResolvedBase(): void {
  cached = undefined;
  clearEpoch += 1;
}

/** Cache key: which ComfyUI this resolution describes. Never throws. */
function targetKey(): string {
  try {
    return getComfyUIBaseUrl();
  } catch {
    return "";
  }
}

/**
 * The target GENERATION — config.ts bumps it on every successful retarget,
 * INCLUDING a round trip back to the same URL, which a URL comparison cannot
 * see. It is the only signal that catches the orchestrator's hello handler
 * kicking off the panel sync BEFORE its retarget completes: an observation
 * recorded in that window belongs to the outgoing target, and the generation
 * moves underneath it.
 *
 * Defensive because a partially-mocked config (several test suites stub only
 * the handful of exports they use) must not turn this into a crash. A constant
 * fallback is safe: record and compare both see it, so it degrades to the URL
 * check rather than to a wrong match.
 */
export function panelTargetGeneration(): number {
  return targetGeneration();
}

function targetGeneration(): number {
  try {
    return getComfyuiTargetGeneration();
  } catch {
    return -1;
  }
}

function cachedResolution(): PanelBaseResolution | undefined {
  if (!cached) return undefined;
  if (cached.target !== targetKey()) return undefined;
  // The URL is not enough here either. setComfyuiTarget bumps the generation
  // even for a round trip back to the SAME address, which is exactly what a
  // ComfyUI restart onto a different --base-directory looks like from outside:
  // same URL, different custom_nodes. A cache that survived that would freeze
  // the OLD root into a status read or — far worse — into a mutation, which
  // would then verify its own work in a tree nobody is serving.
  if (cached.generation !== targetGeneration()) return undefined;
  if (Date.now() - cached.at > PANEL_BASE_TTL_MS) return undefined;
  return cached.resolution;
}

/**
 * Resolve and cache the panel's ComfyUI base. Call at the START of any panel
 * operation, before the first `deps.comfyuiPath()`, so every read within that
 * operation agrees. Never throws.
 */
export async function primePanelBase(
  opts: { force?: boolean } = {},
): Promise<PanelBaseResolution> {
  const fresh = opts.force ? undefined : cachedResolution();
  if (fresh) return fresh;

  // CAPTURE THE IDENTITY BEFORE THE AWAIT, never after.
  //
  // The probe is a network round trip, and the orchestrator can retarget during
  // it — its hello handler starts the panel sync and then retargets. Stamping
  // the result with values read AFTERWARDS would label tree A's answer with
  // target B, which is worse than having no answer: every downstream check
  // (the swap's corroboration, the stale-bundle proof, the mid-op generation
  // guard) compares against that label and would agree with itself all the way
  // to a wrong-tree mutation reported as success.
  const atTarget = targetKey();
  const atGeneration = targetGeneration();
  // The cache entry as the probe STARTS. A probe that lands after another
  // writer refreshed (or deliberately seeded) the cache must not overwrite
  // that newer entry with its older answer — the in-flight `void
  // primePanelBase()` a refusal fires in the background did exactly that to a
  // base seeded after it started (#879 test isolation surfaced it).
  const cacheAtStart = cached;
  // #1222 — and the CLEAR COUNT, because the reference comparison above cannot
  // see a clear that leaves the cache as empty as it found it.
  const clearEpochAtStart = clearEpoch;

  let resolution: PanelBaseResolution;
  try {
    resolution = await resolvePanelBase();
  } catch {
    // A failed probe must not break panel management — fall back to the
    // ordinary sync answer rather than reporting "no local ComfyUI".
    // Asks the LOCAL-MACHINE question explicitly, having already established the mode
    // on the line itself. Same answer as the target-scoped resolver, but the two are
    // different questions and #490 is what happens when one stands in for the other.
    const configured = isLocalMode() ? resolveLocalWorkspaceBase() : undefined;
    resolution = configured
      ? { base: configured, source: "configured" }
      : { source: "none" };
  }

  // The target moved while we were asking. This answer describes the PREVIOUS
  // ComfyUI, so it is not cached and not returned as a resolution anyone may
  // act on — callers see "nothing resolved" and fail closed, and the next
  // prime (against the settled target) answers properly.
  if (targetKey() !== atTarget || targetGeneration() !== atGeneration) {
    cached = undefined;
    return { source: "none" };
  }

  // A NEWER cache write landed while we were asking (a later prime settled, a
  // test seed, a cache reset). Same rule as the retarget guard above: a probe
  // that STARTED earlier holds older information, so it must not clobber the
  // newer write — the fire-and-forget prime a capability refusal kicks off (see
  // resolveStaleBundleSkew) can settle seconds later, mid-way through someone
  // else's operation.
  //
  // MERGE NOTE (#884 branch × main): both sides fixed this independently and
  // agreed the newer write must win in the CACHE. They differed on what the
  // caller gets back — main returned this probe's older answer, this branch
  // serves the newer cached one. Kept the branch's shape because the other
  // leaves the caller holding a value the cache has already superseded, which
  // is the same "two sources of truth" split the guard exists to close. The
  // expiry fallback preserves main's behavior exactly when the newer entry has
  // already aged out.
  if (cached !== cacheAtStart) {
    return cachedResolution() ?? resolution;
  }

  // #1222 — the cache was deliberately CLEARED while this probe was in flight.
  // Same rule as above and the same reason: this answer predates the clear, so
  // writing it would silently undo an explicit "forget what you knew". The
  // reference check misses it whenever the cache was already empty when the
  // probe started, which is the common case — a refusal fires the background
  // prime precisely because nothing was primed yet.
  //
  // The ANSWER is still returned: this caller asked and this is what the probe
  // found. Only the shared cache is left alone, so the next caller re-resolves
  // rather than inheriting a resolution someone asked to be forgotten.
  if (clearEpoch !== clearEpochAtStart) {
    return resolution;
  }

  cached = { at: Date.now(), target: atTarget, generation: atGeneration, resolution };
  return resolution;
}

/**
 * The primed base, or — when nothing has been primed in this window — the
 * ordinary sync answer. Deliberately falls back rather than returning
 * undefined: an unprimed caller must keep the pre-#766 behaviour, never lose
 * a workspace it used to see.
 */
export function panelBaseSync(): string | undefined {
  const fresh = cachedResolution();
  if (fresh) return fresh.base;
  if (!isLocalMode()) return undefined;
  // Mode established on the line above → the remaining question is purely "where is the
  // local install?", so ask that one by name.
  return resolveLocalWorkspaceBase();
}

/** The resolution behind `panelBaseSync()`, for reporting. undefined ⇒ unprimed. */
export function lastPanelBaseResolution(): PanelBaseResolution | undefined {
  return cachedResolution();
}

/**
 * Test hook — drop the cache so the next prime re-resolves.
 *
 * Bumps the clear epoch (#1222) so a probe already in flight cannot land its
 * pre-clear answer afterwards. Without that, this hook cleared the cache and an
 * unawaited background prime — the one a capability refusal fires — repopulated
 * it seconds later, inside whichever test happened to be running. That produced
 * three flakes whose only symptom was the wrong remedy WORDING, which reads
 * exactly like a real regression.
 */
export function __resetPanelBaseCache(): void {
  diskObservation = undefined;
  forgetResolvedBase();
}

/**
 * Test hook — seed a resolved base without probing a live server. Defaults to a
 * LIVE-DERIVED source, because that is what an ordinary serving install
 * produces and it is what the corroboration gates require; pass
 * `source: "configured"` to exercise the uncorroborated branches.
 */
export function __setPanelBaseForTests(
  base: string | undefined,
  source: PanelBaseSource = "live-argv-root",
): void {
  cached = {
    at: Date.now(),
    target: targetKey(),
    generation: targetGeneration(),
    resolution: base ? { base, source } : { source: "none" },
  };
}

// ---------------------------------------------------------------------------
// What is actually ON DISK — so a stale BROWSER BUNDLE can be told apart from a
// stale INSTALL.
//
// The panel's module URLs carry no version or cache-busting key, and the
// capability advertisement lives in exactly one served file (js/lib/
// session-rebind.js) which also builds the `hello` payload. So a browser tab
// holding that file from before 0.11.35 sends an OLD capability set — and an
// old or absent version — while the pack ON DISK is perfectly current. The
// write gate then correctly refuses, the user runs install_comfyui(action:'panel')(action:
// 'update'), and it correctly finds nothing to do, because nothing is wrong
// with the install. That is the loop that feels unfixable.
//
// The two facts needed to name it are already in hand and already collected at
// the same moment: the orchestrator runs the panel sync on EVERY hello, which
// reads the installed version off disk, while the same hello carries the tab's
// advertised version. All that was missing was somewhere to put the first one
// so the refusal builder can see it. This is that place.
//
// It is deliberately an OBSERVATION, not a claim: it records only what a real
// on-disk read returned and when. A caller that finds it absent or stale must
// fall back to the ordinary guidance rather than guess — telling a user their
// install is fine when it is not would send them round the loop again.
// ---------------------------------------------------------------------------

export interface PanelDiskObservation {
  /** Version read from the pack's pyproject.toml at observation time. */
  version: string;
  /** WHERE it was read from. This is the durable part — see below. */
  dir?: string;
  /** When (epoch ms). */
  at: number;
  /** Which ComfyUI it describes. An observation does not survive a retarget. */
  target: string;
  /** Target generation at record time — catches a same-URL retarget too. */
  generation: number;
  /**
   * The resolved ComfyUI ROOT it describes. The URL alone is not enough: the
   * server can restart at the same address with a different `--base-directory`,
   * which is a different custom_nodes and therefore a different panel.
   */
  base?: string;
}

/**
 * How long an observation's POINTER stays usable. The version it carries is
 * never trusted on age alone — see `verifiedPanelDiskVersion`.
 */
const DISK_OBSERVATION_TTL_MS = 30 * 60_000;

/** pyproject `[project].name` that identifies the panel pack. Kept as a literal
 *  rather than imported from panel-installer, which imports this module. */
const PANEL_PROJECT_NAME = "comfyui-agent-panel";

let diskObservation: PanelDiskObservation | undefined;

/** Record a version READ FROM DISK. Called by panelStatus, never guessed. */
export function recordPanelDiskObservation(
  version: string,
  dir?: string,
  base?: string,
): void {
  diskObservation = {
    version,
    dir,
    at: Date.now(),
    target: targetKey(),
    generation: targetGeneration(),
    base: base ?? panelBaseSync(),
  };
}

/** Forget the on-disk observation — the pack is not there (or was removed). */
export function clearPanelDiskObservation(): void {
  diskObservation = undefined;
  // Drop the resolved base with it. A hello is also the moment ComfyUI may have
  // restarted with different launch flags — and therefore a different
  // custom_nodes — so keeping the previous root cached would let the very next
  // operation freeze the wrong tree.
  //
  // #1222 — through `forgetResolvedBase`, because an in-flight probe that
  // started BEFORE this hello would otherwise write the pre-restart root back in
  // a moment later, which is precisely the freezing this exists to prevent. That
  // is a PRODUCTION path, not only a test one: the clear runs on every hello.
  forgetResolvedBase();
}

/**
 * The last on-disk read, if it still describes THIS ComfyUI and is recent.
 *
 * The target check matters more than the clock. The orchestrator kicks off the
 * panel sync on a hello and retargets ComfyUI in the same handler, so an
 * observation can be recorded a moment before the target changes — and a
 * version read from the OLD machine's disk must never be presented as evidence
 * about the new one.
 */
export function lastPanelDiskObservation(): PanelDiskObservation | undefined {
  if (!diskObservation) return undefined;
  if (diskObservation.target !== targetKey()) return undefined;
  // A URL match is not enough. The orchestrator starts the panel sync and
  // retargets in the same hello handler, so an observation can be recorded
  // against the OUTGOING target and still share a URL with the incoming one;
  // the generation moves on every retarget, including a round trip back to the
  // same address, and catches exactly that.
  if (diskObservation.generation !== targetGeneration()) return undefined;
  if (Date.now() - diskObservation.at > DISK_OBSERVATION_TTL_MS) return undefined;
  return diskObservation;
}

/**
 * The panel's on-disk version RIGHT NOW, re-read from the directory the last
 * observation pointed at — or undefined if that cannot be confirmed.
 *
 * The recorded version is deliberately NOT returned. It is a fact about the
 * past, and the one conclusion it feeds — "your install is fine, the browser
 * tab is the stale part" — is exactly the conclusion that must never be wrong:
 * telling someone whose install is genuinely behind to hard-refresh sends them
 * back into the loop this whole change exists to break. So the observation
 * supplies only the WHERE (which needs the async scan), and the version is read
 * fresh and cheaply at the moment of use. A pack that was removed, downgraded,
 * or replaced by something else since the scan therefore yields undefined and
 * the caller falls back to ordinary update guidance.
 */
export function verifiedPanelDiskVersion(): string | undefined {
  const observed = lastPanelDiskObservation();
  if (!observed?.dir) return undefined;

  // The observation must still describe the tree the LIVE server is serving
  // from. A restart at the same address with a different `--base-directory` is
  // a different custom_nodes and therefore a different panel, and re-reading
  // the OLD directory would then certify a version nobody is running. Only a
  // FRESHLY resolved base counts: an expired cache falls back to the
  // configured path, which is exactly the disagreement (#766) this whole change
  // exists to fix, so it must not be accepted as a match. No fresh resolution ⇒
  // no claim.
  const resolution = cachedResolution();
  if (!resolution?.base || !observed.base || resolution.base !== observed.base) {
    return undefined;
  }
  // And the RUNNING SERVER must have chosen that tree. A configured fallback
  // only proves something answered on the URL, not that COMFYUI_PATH is what it
  // serves — and on a split install it is not. Certifying "your install is
  // fine, hard-refresh" off a dormant copy is the exact wrong direction.
  if (!isLiveDerivedBase(resolution)) return undefined;
  // And the pack must live UNDER that base — never a path left over from a tree
  // we are no longer looking at.
  if (!observed.dir.startsWith(resolution.base)) return undefined;

  try {
    const raw = readFileSync(join(observed.dir, "pyproject.toml"), "utf-8");
    const parsed = parsePyproject(raw);
    // Still the panel, and still has a version. Anything else is not proof.
    if (parsed.projectName !== PANEL_PROJECT_NAME) return undefined;
    return parsed.version;
  } catch {
    return undefined;
  }
}
