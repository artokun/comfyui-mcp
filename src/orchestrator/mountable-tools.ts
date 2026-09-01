/**
 * Mountable tool groups — tools that exist on the MCP surface only while the panel pane
 * that gives them meaning is open.
 *
 * A tool that refuses is still a tool the model can see, reason about and keep retrying.
 * ABSENT means it never learns the capability exists until the moment it does — the same
 * argument `tool-surface-filter.ts` makes for the operator's deny list, applied here to a
 * surface that comes and goes with a pane. The Director's canvas tools are the first group:
 * with no Director pane open there is no graph for them to act on, so they are not there.
 *
 * MECHANISM
 * ---------
 * The MCP SDK already does the hard part. `McpServer.registerTool()` returns a
 * `RegisteredTool` whose `enable()` / `disable()` flip its visibility in `tools/list` AND
 * emit `notifications/tools/list_changed` (guarded by `isConnected()`, so a closed session is
 * a silent no-op). Every one of those handles was being dropped on the floor; this module
 * keeps them, grouped, so a pane opening anywhere can flip a whole group at once.
 *
 * Handles are per SERVER INSTANCE — the panel MCP creates one server per (tab, session) — so
 * the registry tracks every live handle for a group and applies the group's mounted state to
 * each. A session registers its handles on creation and disposes them on close; a handle
 * from a session that has already gone is unreachable and dropped.
 *
 * SCOPE
 * -----
 * Mounted state is CONVERSATION-scoped, never tab-scoped: "the Director pane is open in some
 * tab" mounts the group everywhere. Keying it on a tab id would violate the orchestrator-
 * scoped session invariant in `session-scope.ts`. The presence bookkeeping that decides
 * open/closed lives in `services/panel-pane-state.ts`; this module only knows about handles.
 */

import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

/** A group of tools that mount together. One per panel module that contributes tools. */
export type MountGroup = "director";

export const MOUNT_GROUPS: readonly MountGroup[] = ["director"];

class MountRegistry {
  private readonly handles = new Map<MountGroup, Set<RegisteredTool>>();
  private readonly mounted = new Map<MountGroup, boolean>();

  /**
   * Track a freshly registered tool under a group and apply the group's CURRENT state to it
   * immediately — a session created while the pane is closed must come up with the group
   * hidden, not visible until the next flip. Returns an untrack function for session close.
   */
  track(group: MountGroup, tool: RegisteredTool): () => void {
    let set = this.handles.get(group);
    if (!set) {
      set = new Set();
      this.handles.set(group, set);
    }
    set.add(tool);
    this.apply(tool, this.isMounted(group));
    return () => {
      set?.delete(tool);
    };
  }

  isMounted(group: MountGroup): boolean {
    return this.mounted.get(group) ?? false;
  }

  /** Flip a group. Idempotent: flipping to the state it is already in touches nothing. */
  setMounted(group: MountGroup, open: boolean): void {
    if (this.isMounted(group) === open) return;
    this.mounted.set(group, open);
    for (const tool of this.handles.get(group) ?? []) this.apply(tool, open);
  }

  /** How many live handles a group has — for diagnostics and tests. */
  size(group: MountGroup): number {
    return this.handles.get(group)?.size ?? 0;
  }

  private apply(tool: RegisteredTool, open: boolean): void {
    try {
      if (open) tool.enable();
      else tool.disable();
    } catch {
      // A handle whose server has gone away cannot be flipped and does not need to be.
    }
  }
}

export const mountRegistry = new MountRegistry();
