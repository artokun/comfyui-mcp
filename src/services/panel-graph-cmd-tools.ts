/**
 * Tool ↔ bridge-command correspondence used by agent-facing refusals.
 *
 * Two maps, one reverse index. The forward maps are NOT injective (graph_load
 * is dispatched by two tools), so the reverse index omits ambiguous commands
 * rather than guessing — a confidently wrong tool name is the defect this
 * module exists to prevent (#1933, #1935).
 *
 * Lives here, not in panel-tools.ts, so ui-bridge can name tools in its own
 * refusals without a circular import (panel-tools already imports ui-bridge).
 */

/**
 * #694 — the MUTATING panel tools that accept retry_of, keyed to the bridge
 * command each dispatches. Covers every command the bridge fences to a workflow
 * (GRAPH_CMD_EFFECT "targeted" — see requiresWorkflowStampEnforcement) plus the
 * four workflow mutators (workflow_save / workflow_save_as / workflow_rename /
 * workflow_close). Navigation/creation (workflow_open / workflow_new) and the
 * tools whose descriptions declare them view/read-only (panel_find_nodes,
 * panel_canvas, panel_screenshot, panel_list_subgraphs) are excluded: a read must
 * never mint or carry a retry token — its retry could be answered from the ledger
 * with a STALE outcome (codex gate).
 *
 * Four UI-STATE commands are admitted on purpose (graph_select_nodes,
 * graph_enter/exit_subgraph, graph_copy_nodes): they change selection, subgraph
 * scope or clipboard idempotently, so a deduped retry is a no-op. THIS MAP — not
 * the workflow fence — is what decides whether a token is minted and whether a
 * caller-supplied one reaches the wire, so those four keep behaving exactly as
 * they did before #778 reclassified them as `inert` for the fence. The two
 * questions are related but not the same, and answering one with the other is
 * the defect #778 is about.
 *
 * EXPLICIT MAP, mirroring the RETRY_SAFE_CMDS / MUTATING_GRAPH_EDIT_CMDS
 * maintenance model — keep in sync when mutating tools are added. Exported for
 * the #694 surface-integrity test.
 */
export const RETRY_TOKEN_CMD_BY_TOOL: Readonly<Record<string, string>> = {
  panel_add_node: "graph_add_node",
  panel_edit_node: "graph_edit_node",
  panel_remove_node: "graph_remove_node",
  panel_clear: "graph_clear",
  panel_flatten_workflow: "graph_load",
  panel_load_workflow: "graph_load",
  panel_connect: "graph_connect",
  panel_disconnect: "graph_disconnect",
  // Idempotent: inputs/outputs/default_mode are absolute values, so a deduped
  // retry writes the same metadata again rather than doubling anything.
  panel_configure_app_mode: "graph_configure_app_mode",
  panel_set_widget: "graph_set_widget",
  panel_remove_widget: "graph_remove_widget",
  panel_set_property: "graph_set_node_property",
  panel_move_node: "graph_move_node",
  panel_resize_node: "graph_resize_node",
  panel_auto_layout: "graph_auto_layout",
  panel_run: "graph_run",
  panel_save_workflow: "workflow_save", // workflow_save_as when `name` is given
  panel_rename_workflow: "workflow_rename",
  panel_close_workflow: "workflow_close",
  panel_select_nodes: "graph_select_nodes",
  panel_create_subgraph: "graph_create_subgraph",
  panel_subgraph_group: "graph_subgraph_group",
  panel_copy_nodes: "graph_copy_nodes",
  panel_paste_nodes: "graph_paste_nodes",
  panel_save_subgraph: "graph_save_subgraph",
  panel_add_subgraph: "graph_add_subgraph",
  panel_create_group: "graph_create_group",
  panel_move_group: "graph_move_group",
  panel_edit_group: "graph_edit_group",
  panel_remove_group: "graph_remove_group",
  panel_set_node_title: "graph_set_title",
  panel_set_node_collapsed: "graph_set_node_collapsed",
  panel_set_node_mode: "graph_set_node_mode",
  panel_set_node_color: "graph_set_node_color",
  panel_enter_subgraph: "graph_enter_subgraph",
  panel_exit_subgraph: "graph_exit_subgraph",
  panel_move_rail: "graph_move_rail",
  panel_promote_widget: "graph_promote_widget",
  panel_expose_subgraph_output: "graph_expose_subgraph_output",
  panel_expose_subgraph_input: "graph_expose_subgraph_input",
  panel_unexpose_subgraph_output: "graph_unexpose_subgraph_output",
  panel_unexpose_subgraph_input: "graph_unexpose_subgraph_input",
  panel_unpack_subgraph: "graph_unpack_subgraph",
  panel_update_node: "graph_update_node",
};

/**
 * #1935 — the READ / view-only tools that agent-facing refusals may advertise,
 * keyed to the bridge command each dispatches.
 *
 * Separate from RETRY_TOKEN_CMD_BY_TOOL on purpose: a read must never mint a
 * retry token (that map's own doc). The instance-mismatch refusal in ui-bridge
 * still has to NAME these, and the mapping is NOT the `panel_` prefix
 * mechanically applied — `graph_query`'s tool is `panel_query_graph`, not
 * `panel_graph_query`.
 *
 * `graph_get_state` is omitted: it is an internal pre-0.8.2 fallback
 * (panel_strip_workflow reconstruction), not a registered tool. Naming it would
 * send the agent to an "unknown tool" the same way the bare bridge commands did.
 */
export const GRAPH_READ_CMD_BY_TOOL: Readonly<Record<string, string>> = {
  panel_graph_outline: "graph_outline",
  panel_query_graph: "graph_query",
  panel_get_errors: "graph_get_errors",
  panel_find_nodes: "graph_find_nodes",
  panel_list_subgraphs: "graph_list_subgraphs",
  panel_screenshot: "graph_screenshot",
  panel_canvas: "graph_canvas",
};

/**
 * #1933 — the READ TOOLS the QUEUE BUSY refusal advertises, by their REGISTERED
 * tool name.
 *
 * They must be tool names, not the `graph_outline` / `graph_query` /
 * `graph_get_errors` bridge commands they dispatch: this string is the whole
 * recovery contract for a fenced write, and an agent that follows it calls what
 * it is told to call. A bridge command is not callable, so the advice returned
 * "unknown tool" — a hard failure mid-degraded-state that the agent cannot
 * diagnose, and from which it can only conclude that reads are unavailable
 * during a render, which is precisely the state panel#1489 fixed and this
 * sentence exists to advertise (reported from the field in
 * artokun/comfyui-mcp-panel#1549).
 *
 * Written out (not derived by prefixing `panel_`) because `graph_query`'s tool
 * is `panel_query_graph`. `graph-read-during-render.test.ts` asserts every one
 * of them is in `buildPanelToolDefs()` — the registry the caller actually
 * dispatches against. That test is what stops this list from drifting again:
 * the old literal was green for the whole of its life with all three names
 * wrong, because the assertion matched `/graph_outline/`, which a wrong name
 * and a right one both satisfy.
 *
 * #1935 reuses this same list in the workflow-instance-stamp refusal's
 * refused/unknown branches, rather than a third hand-written name list.
 */
export const QUEUE_BUSY_READ_TOOLS: readonly string[] = [
  "panel_graph_outline",
  "panel_query_graph",
  "panel_get_errors",
];

/**
 * #1933/#1935 — the reverse of RETRY_TOKEN_CMD_BY_TOOL ∪ GRAPH_READ_CMD_BY_TOOL:
 * which TOOL does a caller reach this bridge command through?
 *
 * An agent-facing message written below the tool layer can only see `cmd.cmd`;
 * `PanelToolCtx.call` takes a command object and no tool identity, so by the
 * time a pre-dispatch refusal is worded the tool name is genuinely gone. This
 * recovers it from the maps that already maintain the correspondence, rather
 * than adding another hand-written list that can drift out of step with the
 * first.
 *
 * IT REFUSES TO GUESS. The forward maps are not injective — `graph_load` is
 * dispatched by both `panel_load_workflow` and `panel_flatten_workflow` — and
 * naming one of two possible tools is a confidently wrong answer, which is worse
 * than declining to name one. Ambiguous commands are therefore OMITTED, and
 * callers must handle `undefined`.
 *
 * Coverage of mutations is not assumed either: every `targeted` GRAPH_CMD_EFFECT
 * command except `graph_run` is a value of the retry map, so the queue-busy
 * fence resolves a tool for everything it can refuse except `graph_load`.
 * `graph-read-during-render.test.ts` pins both halves — the resolution and the
 * refusal to guess. Reads resolve through GRAPH_READ_CMD_BY_TOOL; `graph_get_state`
 * is intentionally absent (no callable tool).
 */
export const PANEL_TOOL_BY_GRAPH_CMD: ReadonlyMap<string, string> = (() => {
  const claims = new Map<string, string[]>();
  for (const map of [RETRY_TOKEN_CMD_BY_TOOL, GRAPH_READ_CMD_BY_TOOL]) {
    for (const [tool, cmd] of Object.entries(map)) {
      const prior = claims.get(cmd);
      if (prior) prior.push(tool);
      else claims.set(cmd, [tool]);
    }
  }
  const unique = new Map<string, string>();
  for (const [cmd, tools] of claims) if (tools.length === 1) unique.set(cmd, tools[0]!);
  return unique;
})();

/** #1933/#1935 — the registered tool a bridge command is reached through, or
 *  `undefined` when no tool, or more than one tool, claims it. */
export function panelToolForGraphCmd(cmd: string): string | undefined {
  return PANEL_TOOL_BY_GRAPH_CMD.get(cmd);
}
