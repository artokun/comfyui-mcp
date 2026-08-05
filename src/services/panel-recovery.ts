// NEVER LEAVE THE CALLER WITH ONLY A TOOL THEY CANNOT INVOKE. (#774, #784)
//
// When the bridge refuses a graph WRITE because the connected panel is too old
// to fence the command against the active workflow (#718), the refusal has
// always ended with "Run install_panel(action:'update')". In a local session
// with a resolvable ComfyUI that is exactly right. In the two sessions that
// filed #774 and #784 it is a dead end:
//
//  - REMOTE/CLOUD (#774): install_panel is deliberately local-only. It answers
//    `decision: "not-applicable"` and changes nothing, because the panel lives
//    on someone else's filesystem. panel_update_node then refuses too — it
//    cannot verify an on-disk move (#639/#641) — and points BACK at
//    install_panel. Two tools, one circle, no way out.
//
//  - EMBEDDED PANEL SESSION (#784): the sidebar surface is the disjoint
//    `panel_*` tool set. install_panel was never in it, so the recommendation
//    named a tool that was not merely unhelpful but absent.
//
// A hard version gate is only defensible while its escape hatch works. So the
// recovery text is built HERE, from the session's actual context, under two
// rules:
//
//  1. Where install_panel provably CANNOT do the job — remote, cloud, or a
//     local install we have positively determined does not exist — it is not
//     named at all. The text gives the commands to run on the ComfyUI host.
//
//  2. Where it can, it is named AND the host-side commands are given as the
//     alternative, because whether install_panel is actually in the caller's
//     advertised tool set is a property of the client's surface, not of this
//     process, and is therefore not knowable from here. Offering both costs a
//     sentence and removes the only way this message can dead-end.
//
// Note what is deliberately NOT done: nothing here weakens the write gate. The
// panel still cannot make an unfenced write. This module only fixes the remedy.
//
// It is the SINGLE source of that advice — the bridge refusal, the install_panel
// status note, the sync assessment and panel_update_node's refusal all render
// it, so they cannot drift apart and contradict each other.

import { isLocalMode, isRemoteMode } from "../config.js";
import { lastPanelBaseResolution, panelBaseSync } from "./panel-workspace.js";

/** Upstream source of truth for the panel pack — the manual-recovery clone URL. */
export const PANEL_REPO_URL = "https://github.com/artokun/comfyui-mcp-panel.git";

/** Canonical custom_nodes directory name for the panel pack. */
export const PANEL_DIR_NAME = "comfyui-agent-panel";

/** Why install_panel provably cannot perform the update in this session. */
export type PanelRecoveryBlocker =
  /** A non-loopback COMFYUI_URL — the pack is on the remote host's disk. */
  | "remote"
  /** Comfy Cloud — there is no custom_nodes we can touch at all. */
  | "cloud"
  /** Local, but we RESOLVED that there is no ComfyUI root to act on. */
  | "no-local-workspace";

export interface PanelRecoveryContext {
  /**
   * False ONLY when we have positively established that install_panel cannot
   * act here. "We haven't checked yet" resolves to true — recommending a tool
   * that turns out to be a no-op is a much smaller failure than withholding the
   * one remedy that would have worked.
   */
  installPanelUsable: boolean;
  /** Set whenever `installPanelUsable` is false. */
  blocker?: PanelRecoveryBlocker;
  /** Resolved ComfyUI root, when known — used to make the commands concrete. */
  comfyuiPath?: string;
}

/**
 * Resolve the recovery context from the live deployment mode.
 *
 * Deliberately tolerant of a mode helper that cannot be read: this function's
 * only job is to compose an error message, and an error message must never be
 * the thing that throws. An unreadable mode resolves to "local" — the branch
 * that names install_panel AND carries the host-side commands, so the caller is
 * still left with something to do either way.
 */
export function panelRecoveryContext(): PanelRecoveryContext {
  const local = (() => {
    try {
      return isLocalMode();
    } catch {
      return true;
    }
  })();
  if (!local) {
    // Not local. `isRemoteMode()` distinguishes a non-loopback COMFYUI_URL from
    // Comfy Cloud (an API key), which get different host-side advice.
    const remote = (() => {
      try {
        return isRemoteMode();
      } catch {
        return true;
      }
    })();
    return { installPanelUsable: false, blocker: remote ? "remote" : "cloud" };
  }
  // Local. Only a RESOLVED "there is no local ComfyUI" counts as a blocker —
  // an unprimed cache means we have not looked, not that there is nothing
  // there, and must not suppress the tool that would have fixed it.
  const resolution = (() => {
    try {
      return lastPanelBaseResolution();
    } catch {
      return undefined;
    }
  })();
  if (resolution && !resolution.base) {
    return { installPanelUsable: false, blocker: "no-local-workspace" };
  }
  let comfyuiPath: string | undefined;
  try {
    comfyuiPath = panelBaseSync();
  } catch {
    comfyuiPath = undefined; // the commands fall back to a <ComfyUI> placeholder
  }
  return { installPanelUsable: true, comfyuiPath };
}

/**
 * Name an install_panel action ONLY where install_panel can be invoked.
 *
 * The bridge refusal was the loudest instance of the #774/#784 dead end, but it
 * was never the only one: the sync assessment, the pin notes, the auto-sync
 * failure message and the interrupted-swap guidance all named install_panel
 * unconditionally, and the embedded `panel_*` surface — the very surface those
 * messages are pushed to — does not carry it. Every one of them routes through
 * here so the instruction is a real one wherever it is rendered.
 */
export function describeInstallPanelAction(
  action: "status" | "sync" | "update" | "install" | "unpin",
  /** What to say instead when install_panel cannot be invoked here. */
  hostSide: string,
  ctx: PanelRecoveryContext = panelRecoveryContext(),
): string {
  return ctx.installPanelUsable ? `install_panel(action='${action}')` : hostSide;
}

function blockerPhrase(blocker: PanelRecoveryBlocker | undefined): string {
  switch (blocker) {
    case "remote":
      return (
        "this session targets a REMOTE ComfyUI, so the panel pack is on that host's " +
        "disk and no tool here can move it"
      );
    case "cloud":
      return (
        "this session targets Comfy Cloud, which has no custom_nodes this " +
        "orchestrator can write"
      );
    case "no-local-workspace":
      return "no local ComfyUI install could be resolved from here";
    default:
      return "install_panel cannot perform the update from here";
  }
}

/**
 * The manual, host-side update. Written as a real command sequence because the
 * caller may be an agent with no ability to ask a human to "use the Manager UI".
 *
 * IT MUST WORK FROM WHICHEVER STATE THE CALLER IS ACTUALLY IN, and this function
 * cannot see which one that is — the refusal that renders it knows the tab did
 * not advertise the fence, not what is on the host's disk. So it enumerates the
 * three real states and lets the reader match, instead of asserting one:
 *
 *   (a) a git checkout — fast-forward;
 *   (b) a Comfy Registry zip install with no `.git` — nothing to pull, so the
 *       directory has to be REPLACED (#771);
 *   (c) NOT THERE AT ALL (#819) — ComfyUI-Manager 3.x can report its install
 *       queue drained without ever creating the pack, so a user who "installed
 *       the panel" can still have an empty custom_nodes. Both (a) and (b) fail
 *       in that state — `git -C <dir> pull` and `mv <dir> …` need a directory
 *       that exists — which left the one instruction we gave them dead. A fresh
 *       clone is the command that moves them, and it was missing.
 *
 * The BACKUP LEAVES custom_nodes on purpose. ComfyUI serves every directory
 * under custom_nodes as a web extension — including dot-prefixed ones — so a
 * copy parked next to the panel would shadow it in the browser and the update
 * would look like it did nothing (#641). Moving it to a sibling of custom_nodes
 * is the difference between a fix and a confusing non-fix.
 */
export function manualPanelUpdateCommands(comfyuiPath?: string): string {
  const root = comfyuiPath ?? "<ComfyUI>";
  return (
    `cd "${root}/custom_nodes", then run the ONE case that matches what is there. ` +
    `(1) ${PANEL_DIR_NAME} is a git checkout — fast-forward it: ` +
    `git -C ${PANEL_DIR_NAME} pull --ff-only. ` +
    `(2) ${PANEL_DIR_NAME} exists but has NO .git (a Comfy Registry zip install, so there ` +
    `is nothing to pull) — replace it: ` +
    `git clone --depth 1 ${PANEL_REPO_URL} ../.agent-panel-new && ` +
    `mkdir -p ../custom_nodes_backup && ` +
    `mv ${PANEL_DIR_NAME} ../custom_nodes_backup/ && ` +
    `mv ../.agent-panel-new ${PANEL_DIR_NAME}. ` +
    `(3) ${PANEL_DIR_NAME} is NOT PRESENT — a stale ComfyUI-Manager 3.x reports its queue ` +
    `drained without creating the pack (#819), so "already installed" can mean an empty ` +
    `custom_nodes; install it outright: ` +
    `git clone --depth 1 ${PANEL_REPO_URL} ${PANEL_DIR_NAME}. ` +
    `In case (2), keep the old copy OUT of custom_nodes — ComfyUI serves every directory ` +
    `in there, so a leftover copy would shadow the new panel in the browser`
  );
}

/**
 * The case where the INSTALL is fine and the BROWSER TAB is not.
 *
 * The panel's module URLs carry no version or cache-busting key, and the
 * capability the write gate checks is advertised from exactly one served file
 * (js/lib/session-rebind.js), which is also where the `hello` payload is built.
 * A tab holding that file from before 0.11.35 therefore announces the OLD
 * capability set — and an old or missing version — while the pack on disk is
 * current. Verified on a live rig: an up-to-date panel does advertise both
 * capabilities, and resource timing shows no versioned module URLs at all.
 *
 * Told to "run install_panel(action:'update')", such a user gets "nothing to
 * update" — true, and completely useless, because nothing is wrong with their
 * install. The fix is a cache-bypassing reload of the tab, and saying so is the
 * whole remedy. (The cache-busting itself is #584 / panel #596 and is not
 * addressed here; this only makes the diagnosis and the guidance correct.)
 */
export interface PanelBundleSkew {
  /** Version READ FROM DISK, already proven to satisfy the requirement. */
  diskVersion: string;
  /** What the tab advertised in its hello; undefined when it carried none. */
  handshakeVersion?: string;
  /** The floor this orchestrator requires, for the message. */
  requiredVersion: string;
}

/** The trailing "and then" every variant shares. */
const RESTART_AND_REFRESH =
  `restart ComfyUI, then hard-refresh the ComfyUI browser tab (Ctrl+Shift+R) so it ` +
  `loads the updated bundle — a restart alone leaves the tab running its cached old ` +
  `panel JS; rebinding cannot add the missing capability`;

/**
 * WHY "install_panel does not exist" is usually wrong, and what to do about it.
 *
 * #812 and #823 both report the same dead end: an error names install_panel, the
 * agent searches its tool list, finds nothing, and concludes the remedy is
 * impossible. In almost every one of those sessions the tool was there —
 * COMPACT TOOL MODE IS THE DEFAULT (#667). It registers exactly three meta-tools
 * and leaves the other ~200, install_panel among them, reachable only through
 * `call_tool`. A tool-name search cannot see it; `call_tool` can run it.
 *
 * Saying so is the difference between a remedy the caller can execute from where
 * they are and one that reads as "this is impossible". The host-side commands
 * still follow, for the surfaces where neither route exists (the embedded
 * `panel_*` sidebar set, #784).
 */
const COMPACT_ROUTER_FALLBACK = (action: string): string =>
  `If install_panel is not in this session's tool list, it is probably not missing — ` +
  `compact tool mode is the DEFAULT and exposes only list_tools / describe_tool / ` +
  `call_tool, with every other tool reachable through them. Try ` +
  `call_tool {"name": "install_panel", "args": {"action": "${action}"}} before concluding ` +
  `it is unavailable.`;

/**
 * The recovery sentence for a panel that is too old for the write gate. Names
 * install_panel only where install_panel can really do it, and ALWAYS carries a
 * host-side command sequence so the caller is never left without a next step.
 */
export function describePanelUpdateRecovery(
  ctx: PanelRecoveryContext = panelRecoveryContext(),
  skew?: PanelBundleSkew,
): string {
  // STALE BUNDLE FIRST. When the caller has PROVEN the pack on disk already
  // satisfies the requirement, no update of any kind is the answer — not
  // install_panel, not a host-side git pull. Sending this user to either is
  // what makes the loop feel unfixable, so this branch outranks both.
  if (skew) {
    return (
      `Do NOT update the panel — the pack ON DISK is already ${skew.diskVersion}, which ` +
      `meets the ${skew.requiredVersion}+ this MCP requires. This BROWSER TAB is running ` +
      `an older cached copy of the panel's JavaScript ` +
      `(it advertised ${skew.handshakeVersion ? `${skew.handshakeVersion}` : "no version"}), ` +
      `and the capability check reads what the TAB announced. The panel's module URLs ` +
      `carry no cache-busting key, so an ordinary reload can serve the stale file again: ` +
      `HARD-REFRESH this ComfyUI tab with a cache-bypassing reload (Ctrl+Shift+R, or ` +
      `Cmd+Shift+R on macOS; if that does not take, open DevTools and use ` +
      `right-click reload → "Empty Cache and Hard Reload"). ` +
      // Only name the tool where naming it is useful. In a remote/cloud session
      // it is not callable at all, so "it would report nothing to do" is a
      // pointless mention of an absent tool; say the plain thing instead.
      (ctx.installPanelUsable
        ? `Running install_panel(action:'update') here will correctly report nothing ` +
          `to do — the install is not the problem.`
        : `No update of any kind will help — the install is not the problem.`)
    );
  }

  if (ctx.installPanelUsable) {
    return (
      `Run install_panel(action:'update'). ${COMPACT_ROUTER_FALLBACK("update")} ` +
      `If neither route exists on this surface, update the pack on the ComfyUI host: ` +
      // No trailing period: every caller of this function appends its own
      // sentence break, and adding one here rendered ".." to the user.
      `${manualPanelUpdateCommands(ctx.comfyuiPath)}. Then ${RESTART_AND_REFRESH}`
    );
  }
  return (
    `Update the panel ON THE COMFYUI HOST — ${blockerPhrase(ctx.blocker)}. On the host ` +
    `run: ${manualPanelUpdateCommands(ctx.comfyuiPath)}. Then ${RESTART_AND_REFRESH}`
  );
}

/**
 * The same advice as a redirect for tools that REFUSE to manage the panel
 * themselves (panel_update_node, fix_custom_node). Those refusals used to end
 * with a flat "Use install_panel instead", which is the #774/#784 dead end in
 * miniature.
 */
export function describePanelManagementRedirect(
  ctx: PanelRecoveryContext = panelRecoveryContext(),
): string {
  if (ctx.installPanelUsable) {
    return (
      `Use install_panel instead: install_panel(action='sync') brings the panel in line ` +
      `with this orchestrator and re-reads the installed version from disk, and ` +
      `action='status' reports it. ${COMPACT_ROUTER_FALLBACK("sync")} ` +
      `If neither route exists on this surface, update the pack on the ComfyUI host ` +
      `instead: ${manualPanelUpdateCommands(ctx.comfyuiPath)}.`
    );
  }
  return (
    `install_panel cannot help here either — ${blockerPhrase(ctx.blocker)}. Update the ` +
    `panel ON THE COMFYUI HOST: ${manualPanelUpdateCommands(ctx.comfyuiPath)}. Then ` +
    `restart ComfyUI and hard-refresh the ComfyUI browser tab (Ctrl+Shift+R).`
  );
}
