/**
 * Which panel panes are open, and therefore which tool groups are mounted.
 *
 * The panel pushes `{ type: "agent_event", kind: "pane_state", module, open }` on every
 * open, tab switch and close of its side panel, and re-announces on reconnect so a fresh
 * socket cannot leave the orchestrator holding a stale picture. Presence is recorded PER TAB
 * — a pane can be open in two browser tabs at once — but the decision it feeds is
 * conversation-wide: a group is mounted while ANY tab has its pane open. That is the
 * orchestrator-scoped session invariant (`session-scope.ts`) applied to tool visibility:
 * tab ids route frames, they never scope the agent.
 *
 * A tab that goes away without a close frame (browser crash, laptop lid) is retired through
 * the bridge's tab-gone listener, so a mounted group cannot be stranded pointing at nothing.
 */

import { MOUNT_GROUPS, mountRegistry, type MountGroup } from "../orchestrator/mountable-tools.js";

export type PaneModule = MountGroup;

const KNOWN: ReadonlySet<string> = new Set(MOUNT_GROUPS);

class PanePresence {
  private readonly byTab = new Map<string, Set<PaneModule>>();

  /** Record one tab's report and recompute every group. Unknown modules are ignored. */
  set(tabId: string, module: string, open: boolean): boolean {
    if (!KNOWN.has(module)) return false;
    const m = module as PaneModule;
    let set = this.byTab.get(tabId);
    if (open) {
      if (!set) {
        set = new Set();
        this.byTab.set(tabId, set);
      }
      set.add(m);
    } else if (set) {
      set.delete(m);
      if (set.size === 0) this.byTab.delete(tabId);
    }
    this.recompute();
    return true;
  }

  /** The tab is gone: whatever it had open is no longer open anywhere it can be reached. */
  tabGone(tabId: string): void {
    if (this.byTab.delete(tabId)) this.recompute();
  }

  isOpen(module: PaneModule): boolean {
    for (const set of this.byTab.values()) if (set.has(module)) return true;
    return false;
  }

  /** Every tab that has a given pane open. */
  tabsWith(module: PaneModule): string[] {
    const out: string[] = [];
    for (const [tab, set] of this.byTab) if (set.has(module)) out.push(tab);
    return out;
  }

  snapshot(): Record<PaneModule, { open: boolean; tabs: string[]; mounted: boolean }> {
    const out = {} as Record<PaneModule, { open: boolean; tabs: string[]; mounted: boolean }>;
    for (const g of MOUNT_GROUPS) out[g] = { open: this.isOpen(g), tabs: this.tabsWith(g), mounted: mountRegistry.isMounted(g) };
    return out;
  }

  /** Test seam. */
  reset(): void {
    this.byTab.clear();
    this.recompute();
  }

  private recompute(): void {
    for (const g of MOUNT_GROUPS) mountRegistry.setMounted(g, this.isOpen(g));
  }
}

export const panePresence = new PanePresence();
