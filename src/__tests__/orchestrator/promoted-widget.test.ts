// #1655 — a widget the panel lists as promoted must be settable.
//
// The panel's graph_set_widget can refuse:
//
//   Cannot set widget on subgraph node 78: "width" is not a promoted widget
//   on this subgraph (promoted: width, height, seed, …)
//
// That is a listing-vs-lookup contradiction (widgets[] vs host inputs), not a
// genuine miss. panel_set_widget must resolve the displayed name to the unique
// inner widget and write it there, then leave the subgraph.
//
// These tests drive the SHIPPED handler (and the parse/resolve helpers it uses).
// A first-write success stays successful for safe or unprovable mappings. A genuine
// miss (name not in the listed set) is never retried. An ambiguous or truncated inner
// mapping is never guessed.

import { describe, expect, it } from "vitest";

import {
  buildPanelToolDefs,
  makePanelToolCtx,
  type PanelToolCtx,
  type ToolResult,
} from "../../orchestrator/panel-tools.js";
import {
  isContradictoryPromotedWidgetRefusal,
  matchListedName,
  parseAmbiguousPromotedWidgetRefusal,
  parseContradictoryPromotedWidgetRefusal,
  parseLinkDrivenPromotedWriteWarning,
  parseSubgraphScopeRefusal,
  promotedInnerWidgetIsLinkDriven,
  resolveInnerPromotedTarget,
  validatePromotedSubgraphEnvelope,
} from "../../orchestrator/promoted-widget.js";
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";

const TAB = "wf:krea2";

const CONTRADICTORY =
  `Cannot set widget on subgraph node 78: "width" is not a promoted widget on this subgraph ` +
  `(promoted: width, height, seed, control_after_generate, steps, cfg, sampler_name, scheduler, denoise, batch_size).`;

const STACK_DATA_CONTRADICTORY =
  `Cannot set widget on subgraph node 78: "stack_data" is not a promoted widget on this subgraph ` +
  `(promoted: stack_data).`;

const AMBIGUOUS =
  `promoted widget "text" is ambiguous - 2 promoted inputs match; refusing to guess.`;

const SCOPE_REFUSAL =
  `No node with id 188 in the current graph. Node 188 lives INSIDE a subgraph — ` +
  `"New Subgraph" (node 190) — and the write applies there. ` +
  `Enter it (panel_enter_subgraph(190)), then retry.`;

const SUBGRAPH = {
  subgraph_of: { node_id: 78, title: "Krea2" },
  instance_widgets: { width: 1920, height: 1080, seed: 1, steps: 20 },
  node_count: 2,
  nodes: [
    { id: 76, type: "EmptyLatentImage", widgets: { width: 1920, height: 1080, batch_size: 1 } },
    { id: 75, type: "KSampler", widgets: { seed: 1, steps: 20, cfg: 1, sampler_name: "euler" } },
  ],
};

const DEFINITIVE_NON_PROMOTED_SUBGRAPH = new Error(
  "Node 78 (OrdinaryNode) is not a subgraph",
);

type Outcome = "contradict" | "ok" | "fail";

function bridge(opts: {
  firstWrite?: Outcome;
  remappedWrite?: Outcome;
  innerWrite?: Outcome;
  subgraph?: Record<string, unknown> | Error;
  /** #2393: successive graph_get_subgraph replies, used to model a witness
   * that is incomplete immediately after an official template load. */
  subgraphSequence?: Array<Record<string, unknown> | Error>;
  /** #2478: replace the ordinary node after the definitive refresh, so a raw
   * write would falsely succeed unless the handler carries the type fence. */
  ordinaryNodeTypeAfterRefresh?: string;
  /** #2478: replace the ordinary node object after the definitive refresh
   * without changing its id or type. The receiver must fence this incarnation
   * change with the opaque identity witness. */
  ordinaryNodeIdentityAfterRefresh?: string;
  /** #2478: publish the preflight node row used by the ordinary recovery path. */
  preflightNodeIdentity?: string;
  preflightNodeType?: string;
  preflightNodeIsSubgraph?: boolean;
  /** #2401: change the routing or panel connection identity after the async
   * ordinary-node scope probe has produced its result, before the caller can
   * take the fast path. `"gone"` drops a previously usable fingerprint. */
  scopeProbeIdentityChange?: "tab" | "connection" | "gone";
  /** #2551: the panel answers graph reads, but tab_session_id is never published
   * so panelConnectionIdentity stays unusable both before and after the probe. */
  unusableConnectionIdentity?: boolean;
  /** #2409: the same, one exit lower — change identity after the async
   * graph_get_subgraph read, before the definitive-non-subgraph exit returns. */
  subgraphReadIdentityChange?: "tab" | "connection";
  nestedSubgraph?: Record<string, unknown> | Error;
  enterFails?: boolean;
  exitFails?: boolean;
  ambiguous?: boolean;
  scopeLost?: boolean;
  promotedDetail?: Record<string, unknown>;
  stackDataIdentity?: Record<string, unknown>;
  stackDataInnerIdentity?: Record<string, unknown> | null;
  /** #2299: graph_query detail keyed by the id the call asked for, so the outer
   *  probe (which cannot prove the dynamic-combo shape) and the post-enter inner
   *  probe (which can) return different rows. */
  detailById?: Record<string, unknown>;
  /** #2305: the contradictory refusal the FIRST write throws, for a promoted
   *  widget that is not #2299's `model.prompt`. Wins over the default above so
   *  the recovery resolves the name under test. */
  firstWriteError?: string;
  /** #2314: make the first subgraph read unavailable so a recovery test can
   *  continue into the existing post-refusal retry branch. */
  preflightSubgraph?: Record<string, unknown> | Error;
  recoveryPreflightSubgraph?: Record<string, unknown> | Error;
  /** #2314: graph_get_subgraph cannot resolve the outer wrapper after entry;
   * post-entry fences must use a current-graph query of the captured inner id. */
  postEnterGraphQueryById?: Record<string, Record<string, unknown> | Error>;
  objectInfoRefusal?: boolean;
  refreshNodes?: Record<string, unknown>;
  remappedWriteError?: string;
  reconnectBeforeWrite?: boolean;
  tabRebindBeforeWrite?: boolean;
  authoritativeScopeRead?: boolean;
  ownerNavigationAfterFinalQuery?: boolean;
  /** Navigation after MCP's final synchronous callback but before the panel
   * receiver evaluates the expected_scope envelope. */
  receiverNavigationAfterMcpFence?: boolean;
  /** #2314 P1: emulate an old receiver that does not atomically enforce the
   * stable graph identity carried by expected_scope. */
  scopeGraphIdentityFence?: boolean;
  /** #2314 P1: emulate a current receiver that publishes the recursive
   * renamed-promotion terminal witness. */
  promotedTerminalWitnesses?: boolean;
  /** Re-hello the same socket with a changed node-identity write capability
   * while a promoted write is between its mapping read and final dispatch. */
  identityFenceChange?: "upgrade" | "withdraw";
  /** Live inner-node identity used by the production-shaped recovery receiver. */
  innerNodeIdentity?: string;
  /** Replace that same inner node after MCP's final callback, before receiver apply. */
  innerNodeIdentityAfterMcpFence?: string;
  /** #2478: leave inner node identities absent so the current-capability path
   * proves it refuses an incomplete identity-bearing envelope. */
  omitInnerNodeIdentity?: boolean;
  /** #2314 final-rail race: relink the parent input after MCP's last
   * synchronous callback but before the receiver applies graph_set_widget. */
  parentRailRelinkAfterMcpFence?: boolean;
  /** Whether the fake receiver enforces the final parent-rail witness. */
  promotedParentRailFence?: boolean;
  /** #2488: inner graph_set_widget succeeds with the panel's link-driven warning. */
  innerWriteLinkDriven?: boolean;
  /** Receiver navigation to another graph with the SAME owner/workflow and
   * colliding inner ids. Only graph_identity may distinguish this target. */
  receiverGraphIdentityCollisionAfterMcpFence?: boolean;
  /** A parent/subgraph scope cached before graph_enter_subgraph. The child
   * graph token must not be compared against this pre-entry graph. */
  preEntryScopeRead?: {
    known: true;
    scope: "root" | "subgraph";
    ownerNodeId: string | null;
    workflowUuid?: string;
    graphIdentity?: string;
  };
  omitWorkflowUuid?: boolean;
  workflowUuid?: string;
  /** Leave graph_query without a viewing witness so the scope is genuinely unknown. */
  omitViewing?: boolean;
  /** The outer node id used by the current fake viewing scope. */
  ownerNodeId?: number;
  /** #2394: begin the fake panel inside a subgraph for active-view scope tests. */
  startInSubgraph?: boolean;
  /** panel#1859 — a real pre-0.15.101 panel build. It publishes no
   * `graph_identity` anywhere (neither on `viewing` nor on `subgraph_of`) and
   * its hello advertises `enforces_expected_node_type_at_write` but none of the
   * #2314 scope capabilities. Verified against `v0.15.85:web/js/…`, where the
   * reply is literally `subgraph_of: { node_id, title }`. */
  legacyPanelBuild?: { version?: string };
  /** panel#1859 — the tab drops (or becomes ambiguous) between the mapping read
   * and the fence check, so `resolveTarget` throws and every capability reads
   * `false` without that being a fact about the panel build. */
  receiverUnresolvable?: boolean;
}) {
  const calls: Array<Record<string, unknown>> = [];
  const bridgeRetryBudgets: Array<number | undefined> = [];
  let writes = 0;
  let mutations = 0;
  let subgraphReads = 0;
  let ordinaryNodeType = "OrdinaryNode";
  let ordinaryNodeIdentity = opts.preflightNodeIdentity ?? "node:78:original";
  let postEnterGraphQueries = 0;
  let authoritativeScopeReads = 0;
  let inSubgraph = opts.startInSubgraph === true;
  const workflowUuid = opts.workflowUuid ?? "workflow-a";
  let currentOwnerNodeId = opts.ownerNodeId ?? 78;
  const targetGraphIdentity = "graph:workflow-a-container-a";
  let currentGraphIdentity = inSubgraph ? targetGraphIdentity : "graph:workflow-a-root";
  let connectionIdentity: { generation: number; tabSessionId: string } | undefined =
    opts.unusableConnectionIdentity === true
      ? undefined
      : { generation: 1, tabSessionId: "browser-tab-a" };
  let identityFenceCapability = opts.identityFenceChange === "upgrade" ? false : true;
  let identityFenceChangeApplied = false;
  let liveInnerNodeIdentity = opts.innerNodeIdentity;
  let observedPromotedScope: {
    known: true;
    scope: "root" | "subgraph";
    ownerNodeId: string | null;
    workflowUuid?: string;
    graphIdentity?: string;
  } | { known: false; reason: string } = {
    known: false,
    reason: "no current panel graph-scope witness has been observed",
  };
  const beforeWrite = { mutate: undefined as (() => void) | undefined };
  const afterScopeProbe = { mutate: undefined as (() => void) | undefined };
  const afterSubgraphRead = { mutate: undefined as (() => void) | undefined };
  const legacyBuild = opts.legacyPanelBuild !== undefined;
  const currentViewing = () => ({
    scope: inSubgraph ? "subgraph" : "root",
    ...(inSubgraph ? { owner_node_id: currentOwnerNodeId } : {}),
    ...(legacyBuild ? {} : { graph_identity: currentGraphIdentity }),
    ...(opts.omitWorkflowUuid ? {} : { workflow_uuid: workflowUuid }),
  });
  const withCurrentViewing = (value: Record<string, unknown>): Record<string, unknown> => {
    let result = opts.omitViewing
      ? value
      : Object.prototype.hasOwnProperty.call(value, "viewing")
        ? value
        : { ...value, viewing: currentViewing() };
    if (
      !legacyBuild &&
      identityFenceCapability &&
      opts.omitInnerNodeIdentity !== true &&
      Array.isArray(result.nodes)
    ) {
      // Current panel projections publish an opaque per-object identity for every
      // inner node. Keep explicit malformed/replacement identities untouched, but
      // give older fixtures the same current-build shape so the harness exercises
      // the paired identity-forwarding contract instead of capability skew.
      result = {
        ...result,
        nodes: result.nodes.map((raw) => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
          const node = raw as Record<string, unknown>;
          if (!Object.prototype.hasOwnProperty.call(node, "id") || Object.prototype.hasOwnProperty.call(node, "node_identity")) {
            return raw;
          }
          return { ...node, node_identity: `node-incarnation:test:${String(node.id)}` };
        }),
      };
    }
    const rawOwnerEnvelope = result.subgraph_of;
    if (rawOwnerEnvelope && typeof rawOwnerEnvelope === "object" && !Array.isArray(rawOwnerEnvelope)) {
      const owner = rawOwnerEnvelope as Record<string, unknown>;
      if (!legacyBuild && !Object.prototype.hasOwnProperty.call(owner, "graph_identity")) {
        result = { ...result, subgraph_of: { ...owner, graph_identity: targetGraphIdentity } };
      }
    }
    const rawViewing = result.viewing;
    if (rawViewing && typeof rawViewing === "object" && !Array.isArray(rawViewing)) {
      const viewingValue = rawViewing as Record<string, unknown>;
      if (!legacyBuild && !Object.prototype.hasOwnProperty.call(viewingValue, "graph_identity")) {
        result = { ...result, viewing: { ...viewingValue, graph_identity: currentGraphIdentity } };
      }
    }
    const viewing = result.viewing;
    if (viewing && typeof viewing === "object" && !Array.isArray(viewing)) {
      const identity = viewing as Record<string, unknown>;
      const rawOwner = identity.owner_node_id;
      const rawWorkflowUuid = identity.workflow_uuid;
      const rawGraphIdentity = identity.graph_identity;
      if (
        (identity.scope === "root" || identity.scope === "subgraph") &&
        (rawOwner === undefined || rawOwner === null || typeof rawOwner === "number" || typeof rawOwner === "string") &&
        (rawWorkflowUuid === undefined || typeof rawWorkflowUuid === "string") &&
        (rawGraphIdentity === undefined || typeof rawGraphIdentity === "string")
      ) {
        observedPromotedScope = {
          known: true,
          scope: identity.scope,
          ownerNodeId: rawOwner == null ? null : String(rawOwner),
          ...(rawWorkflowUuid !== undefined ? { workflowUuid: rawWorkflowUuid } : {}),
          ...(rawGraphIdentity !== undefined ? { graphIdentity: rawGraphIdentity } : {}),
        };
      } else {
        observedPromotedScope = {
          known: false,
          reason: "the panel returned malformed current-view metadata",
        };
      }
    }
    return result;
  };
  const afterGraphQuery = (value: Record<string, unknown>, wantId: string | null) => {
    const result = withCurrentViewing(value);
    if (
      inSubgraph &&
      wantId &&
      opts.ownerNavigationAfterFinalQuery &&
      postEnterGraphQueries++ === 2
    ) {
      // The final mapping query answered for owner A. Navigation happens before
      // the handler's fresh authoritative scope read, leaving the cache stale.
      currentOwnerNodeId = 79;
    }
    return result;
  };
  const b = {
    send: async (
      cmd: Record<string, unknown>,
      sendOpts?: { beforeDispatch?: () => void; maxReconnectRetries?: number },
    ) => {
      if (cmd.cmd === "graph_get_subgraph") {
        bridgeRetryBudgets.push(sendOpts?.maxReconnectRetries);
      }
      if (cmd.cmd === "graph_set_widget" && sendOpts?.beforeDispatch) {
        const mutation = beforeWrite.mutate;
        beforeWrite.mutate = undefined;
        if (opts.receiverNavigationAfterMcpFence) {
          // The MCP callback is the last synchronous server-side check. The
          // browser can navigate after it returns and before the receiver
          // handler applies the frame; this is the architectural race the
          // expected_scope envelope must fence.
          sendOpts.beforeDispatch();
          if (opts.receiverGraphIdentityCollisionAfterMcpFence) {
            currentOwnerNodeId = 78;
            currentGraphIdentity = "graph:workflow-a-container-b";
          } else {
            currentOwnerNodeId = 79;
          }
          mutation?.();
        } else {
          mutation?.();
          sendOpts.beforeDispatch();
        }
        if (
          opts.innerNodeIdentityAfterMcpFence !== undefined &&
          String(cmd.node_id) === "76"
        ) {
          liveInnerNodeIdentity = opts.innerNodeIdentityAfterMcpFence;
        }
        if (opts.parentRailRelinkAfterMcpFence) {
          // The final MCP callback has already returned. A live panel relation
          // can change in this window; the expected_scope parent_rail must be
          // the thing that makes the receiver refuse before mutation.
          (b as { liveParentRailWidget?: string }).liveParentRailWidget = "relinked_quality_prompt";
        }
      }
      calls.push({ ...cmd });
      if (cmd.cmd === "graph_set_widget") {
        const expectedScope = cmd.expected_scope;
        if (expectedScope !== undefined) {
          if (!expectedScope || typeof expectedScope !== "object" || Array.isArray(expectedScope)) {
            throw new Error("graph_set_widget expected_scope must be a structured subgraph witness");
          }
          const expected = expectedScope as Record<string, unknown>;
          const actualOwner = inSubgraph ? String(currentOwnerNodeId) : null;
          const expectedScopeKind = expected.scope ?? "subgraph";
          const scopeMatches =
            expectedScopeKind === "root"
              ? !inSubgraph &&
                String(expected.owner_node_id) === String(opts.ownerNodeId ?? 78) &&
                expected.graph_identity === currentGraphIdentity
              : expectedScopeKind === "subgraph" &&
                String(expected.owner_node_id) === actualOwner &&
                expected.graph_identity === currentGraphIdentity;
          if (
            !scopeMatches ||
            (expected.workflow_uuid !== undefined && expected.workflow_uuid !== workflowUuid) ||
            (expectedScopeKind !== "root" && expected.scope !== "subgraph")
          ) {
            throw new Error("graph_set_widget promoted receiver changed before dispatch: Nothing was applied.");
          }
          if (
            expectedScope &&
            typeof expectedScope === "object" &&
            !Array.isArray(expectedScope) &&
            Object.prototype.hasOwnProperty.call(expectedScope, "parent_rail") &&
            opts.promotedParentRailFence !== false &&
            (b as { liveParentRailWidget?: string }).liveParentRailWidget !== undefined &&
            ((expectedScope.parent_rail as Record<string, unknown>)?.widget !==
              (b as { liveParentRailWidget?: string }).liveParentRailWidget)
          ) {
            throw new Error("graph_set_widget promoted parent rail changed before dispatch: Nothing was applied.");
          }
        }
        if (
          opts.ordinaryNodeTypeAfterRefresh !== undefined &&
          cmd.expected_node_type !== undefined &&
          String(cmd.node_id) === "78" &&
          cmd.expected_node_type !== ordinaryNodeType
        ) {
          throw new Error("graph_set_widget expected node type changed before dispatch: Nothing was applied.");
        }
        if (
          cmd.expected_node_identity !== undefined &&
          String(cmd.node_id) === "78" &&
          cmd.expected_node_identity !== ordinaryNodeIdentity
        ) {
          throw new Error("graph_set_widget expected node identity changed before dispatch: Nothing was applied.");
        }
        if (
          cmd.expected_node_identity !== undefined &&
          String(cmd.node_id) === "76" &&
          liveInnerNodeIdentity !== undefined &&
          cmd.expected_node_identity !== liveInnerNodeIdentity
        ) {
          throw new Error("graph_set_widget inner node identity changed before dispatch: Nothing was applied.");
        }
        writes += 1;
        if (writes === 1 && opts.ambiguous) throw new Error(AMBIGUOUS);
        if (writes === 1 && opts.scopeLost) throw new Error(SCOPE_REFUSAL);
        if (writes === 1 && opts.stackDataIdentity && opts.firstWrite !== "ok") {
          throw new Error(STACK_DATA_CONTRADICTORY);
        }
        if (writes === 1 && opts.objectInfoRefusal) {
          throw new Error("no usable /object_info was available for this widget write");
        }
        if (writes === 1 && opts.firstWriteError) throw new Error(opts.firstWriteError);
        if (writes === 2 && opts.remappedWriteError) throw new Error(opts.remappedWriteError);
        if (
          writes === 1 &&
          opts.detailById &&
          opts.firstWrite !== "ok" &&
          !opts.firstWriteError
        ) {
          throw new Error(DYNAMIC_CHILD_CONTRADICTORY);
        }
        const outerId = String(opts.ownerNodeId ?? 78);
        const which =
          writes === 1
            ? (opts.firstWrite ?? "contradict")
            : opts.scopeLost
              ? (opts.innerWrite ?? "ok")
            : String(cmd.node_id) !== outerId
              ? (opts.innerWrite ?? "ok")
              : (opts.remappedWrite ?? "contradict");
        if (which === "contradict") throw new Error(CONTRADICTORY);
        if (which === "fail") throw new Error("inner write rejected");
        mutations += 1;
        const applied = { set: { node_id: cmd.node_id, widget: cmd.widget, value: cmd.value } };
        if (
          opts.innerWriteLinkDriven &&
          String(cmd.node_id) !== String(opts.ownerNodeId ?? 78)
        ) {
          return {
            ...applied,
            warning:
              `The write SUCCEEDED and was verified, but it will NOT change the render: ` +
              `widget "${String(cmd.widget)}" on inner node is link-driven. ` +
              `Set the widget on the ENCLOSING subgraph node instead.`,
          };
        }
        return applied;
      }
      if (cmd.cmd === "graph_get_subgraph") {
        subgraphReads += 1;
        // #2409 — this read is the await the definitive-non-subgraph exit returns
        // across. Rebind here so that exit sees a receiver that moved under it.
        if (opts.subgraphReadIdentityChange === "connection") {
          connectionIdentity = { generation: 2, tabSessionId: "browser-tab-a" };
        }
        const subgraphMutation = afterSubgraphRead.mutate;
        afterSubgraphRead.mutate = undefined;
        subgraphMutation?.();
        if (subgraphReads === 1 && opts.preflightSubgraph !== undefined) {
          if (opts.preflightSubgraph instanceof Error) throw opts.preflightSubgraph;
          return withCurrentViewing(opts.preflightSubgraph);
        }
        if (subgraphReads === 2 && opts.recoveryPreflightSubgraph !== undefined) {
          if (opts.recoveryPreflightSubgraph instanceof Error) throw opts.recoveryPreflightSubgraph;
          return withCurrentViewing(opts.recoveryPreflightSubgraph);
        }
        if (opts.subgraphSequence && opts.subgraphSequence.length > 0) {
          const selected = opts.subgraphSequence[Math.min(subgraphReads - 1, opts.subgraphSequence.length - 1)];
          if (selected instanceof Error) {
            if (subgraphReads === 2 && opts.ordinaryNodeTypeAfterRefresh !== undefined) {
              ordinaryNodeType = opts.ordinaryNodeTypeAfterRefresh;
            }
            if (subgraphReads === 2 && opts.ordinaryNodeIdentityAfterRefresh !== undefined) {
              ordinaryNodeIdentity = opts.ordinaryNodeIdentityAfterRefresh;
            }
            throw selected;
          }
          return withCurrentViewing(selected);
        }
        if (inSubgraph) {
          if (opts.nestedSubgraph instanceof Error) throw opts.nestedSubgraph;
          if (opts.nestedSubgraph) return withCurrentViewing(opts.nestedSubgraph);
          if (String(cmd.node_id) !== String(currentOwnerNodeId)) {
            throw new Error(`Node ${cmd.node_id} (OrdinaryNode) is not a subgraph`);
          }
          throw new Error("No node with id 78 in the current graph");
        }
        if (opts.subgraph instanceof Error) throw opts.subgraph;
        const subgraph = opts.subgraph ?? SUBGRAPH;
        return subgraph instanceof Error ? subgraph : withCurrentViewing(subgraph);
      }
      if (cmd.cmd === "graph_enter_subgraph") {
      if (opts.enterFails) throw new Error("could not enter subgraph 78");
        if (opts.identityFenceChange && !identityFenceChangeApplied) {
          identityFenceChangeApplied = true;
          identityFenceCapability = opts.identityFenceChange === "upgrade";
        }
        inSubgraph = true;
        currentGraphIdentity = targetGraphIdentity;
        return { scope: "subgraph", node_id: cmd.node_id };
      }
      if (cmd.cmd === "graph_exit_subgraph") {
        if (opts.exitFails) throw new Error("could not confirm exit");
        inSubgraph = false;
        currentGraphIdentity = "graph:workflow-a-root";
        return { scope: "root" };
      }
      if (cmd.cmd === "graph_query") {
        const wantId = Array.isArray(cmd.ids) && cmd.ids.length ? String(cmd.ids[0]) : null;
        const returnGraphQuery = (value: Record<string, unknown>, id: string | null) => {
          const result = afterGraphQuery(value, id);
          if (cmd.fields === "detail" && cmd.max_chars === undefined) {
            if (opts.scopeProbeIdentityChange === "connection") {
              connectionIdentity = { generation: 2, tabSessionId: "browser-tab-a" };
            } else if (opts.scopeProbeIdentityChange === "gone") {
              connectionIdentity = undefined;
            }
            const mutation = afterScopeProbe.mutate;
            afterScopeProbe.mutate = undefined;
            mutation?.();
          }
          return result;
        };
        const postEnter =
          inSubgraph && wantId ? opts.postEnterGraphQueryById?.[wantId] : undefined;
        if (postEnter !== undefined) {
          if (postEnter instanceof Error) throw postEnter;
          return returnGraphQuery(postEnter, wantId);
        }
        if (opts.detailById && wantId && opts.detailById[wantId] !== undefined) {
          return returnGraphQuery(opts.detailById[wantId], wantId);
        }
        if (opts.preflightNodeIdentity !== undefined && wantId === "78") {
          return returnGraphQuery(
            {
              nodes: [
                {
                  id: 78,
                  type: opts.preflightNodeType ?? "PromotedContainer",
                  is_subgraph: opts.preflightNodeIsSubgraph ?? true,
                  node_identity: opts.preflightNodeIdentity,
                },
              ],
            },
            wantId,
          );
        }
        if (opts.stackDataIdentity && !inSubgraph) return returnGraphQuery(opts.stackDataIdentity, wantId);
        if (opts.stackDataIdentity && inSubgraph) {
          return returnGraphQuery(
            opts.stackDataInnerIdentity ?? { nodes: [{ id: 76, type: "OtherLoraLoader" }] },
            wantId,
          );
        }
        if (inSubgraph && wantId) {
          const subgraph = opts.subgraph && !(opts.subgraph instanceof Error) ? opts.subgraph : SUBGRAPH;
          const nodes = Array.isArray(subgraph.nodes) ? subgraph.nodes : [];
          const node = nodes.find((candidate) =>
            candidate && typeof candidate === "object" && String(candidate.id) === wantId,
          );
          if (node && typeof node.type === "string") {
            const nodeIdentity =
              opts.omitInnerNodeIdentity !== true
                ? liveInnerNodeIdentity ??
                  (!legacyBuild && identityFenceCapability
                    ? `node-incarnation:test:${String(node.id)}`
                    : undefined)
                : undefined;
            return returnGraphQuery(
              {
                nodes: [
                  {
                    id: node.id,
                    type: node.type,
                    ...(nodeIdentity !== undefined ? { node_identity: nodeIdentity } : {}),
                  },
                ],
              },
              wantId,
            );
          }
        }
        return returnGraphQuery(
          opts.promotedDetail ?? {
            nodes: [
              {
                id: 190,
                inputs: [
                  { slot: 0, name: "text" },
                  { slot: 1, name: "text_1", label: "text" },
                ],
              },
            ],
          },
          wantId,
        );
      }
      if (cmd.cmd === "refresh_nodes") return opts.refreshNodes ?? { refreshed: true };
      return { ok: true };
    },
    push: () => 1,
    canReach: () => true,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    tabCanMutateGraph: () => true,
    tabConnectionIdentity: () => connectionIdentity,
    promotedScopeFor: () =>
      !inSubgraph && opts.preEntryScopeRead
        ? opts.preEntryScopeRead
        : observedPromotedScope,
    ...(opts.authoritativeScopeRead
      ? {
          readPromotedScope: async () => {
            // This is the test seam for UiBridge.readPromotedScope: unlike the
            // cached getter above, it samples the live current view after the
            // race navigation has happened.
            authoritativeScopeReads += 1;
            const ownerNodeId = inSubgraph ? String(currentOwnerNodeId) : null;
            const liveWitness = {
              known: true,
              scope: inSubgraph ? "subgraph" : "root",
              ownerNodeId,
              ...(opts.omitWorkflowUuid ? {} : { workflowUuid }),
              graphIdentity: currentGraphIdentity,
            };
            // Keep the cached reply as a separate value. The live result is
            // the witness the final callback must carry forward.
            return liveWitness;
          },
        }
      : {}),
    // v0.15.85's hello DOES advertise this one, which is why a legacy build
    // reaches the scope checks at all instead of stopping at the node-type fence.
    tabExpectedNodeTypeFenceCapability: () => true,
    tabExpectedNodeIdentityFenceCapability: () => !legacyBuild && identityFenceCapability,
    tabExpectedScopeGraphIdentityFenceCapability: () =>
      opts.scopeGraphIdentityFence === true || (!legacyBuild && opts.scopeGraphIdentityFence !== false),
    tabPromotedTerminalWitnessCapability: () =>
      !legacyBuild && opts.promotedTerminalWitnesses === true,
    tabPromotedParentRailFenceCapability: () =>
      legacyBuild ? false : (opts.promotedParentRailFence ?? opts.promotedTerminalWitnesses === true),
    // panel#1859 / codex gate — a fence capability answers `false` both for "not
    // advertised" and for "resolveTarget threw". Only a resolvable receiver lets
    // a refusal blame the panel BUILD.
    tabReceiverResolvable: () => opts.receiverUnresolvable !== true,
    advertisedPanelVersion: () =>
      opts.legacyPanelBuild?.version !== undefined ? { version: opts.legacyPanelBuild.version } : {},
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    workflowUuidFor: () => ({ known: true, uuid: workflowUuid }),
  } as unknown as PanelToolCtx["bridge"];
  if (opts.reconnectBeforeWrite) {
    beforeWrite.mutate = () => {
      // The same browser tab returns after a reconnect: its session id is
      // stable, but the connection generation advances.
      connectionIdentity = { generation: 2, tabSessionId: "browser-tab-a" };
    };
  } else if (opts.tabRebindBeforeWrite) {
    beforeWrite.mutate = () => {
      // A second browser tab for the same workflow keeps the workflow route
      // but has a different receiver session.
      connectionIdentity = { generation: 1, tabSessionId: "browser-tab-b" };
    };
  } else if (opts.receiverNavigationAfterMcpFence) {
    beforeWrite.mutate = () => {
      // The live graph_query and MCP-side callback both saw owner A. Navigation
      // to owner B happens only at the receiver boundary; no returned witness
      // object is mutated because production navigation cannot do that.
      currentOwnerNodeId = 79;
    };
  }
  return {
    b,
    calls,
    beforeWrite,
    get authoritativeScopeReads() {
      return authoritativeScopeReads;
    },
    get postEnterGraphQueries() {
      return postEnterGraphQueries;
    },
    afterScopeProbe,
    afterSubgraphRead,
    get writesApplied() {
      return writes;
    },
    get mutations() {
      return mutations;
    },
    get bridgeRetryBudgets() {
      return bridgeRetryBudgets;
    },
  };
}

async function setWidget(
  args: { node_id: number | string; widget: string; value: number | string },
  opts: Parameters<typeof bridge>[0] = {},
) {
  const harness = bridge(opts);
  const { b, calls, beforeWrite, afterScopeProbe, afterSubgraphRead } = harness;
  const ctx = makePanelToolCtx(b, TAB, new WorkflowTargetStore());
  if (opts.scopeProbeIdentityChange === "tab") {
    afterScopeProbe.mutate = () => {
      ctx.tabId = `${TAB}:rebound`;
    };
  }
  if (opts.subgraphReadIdentityChange === "tab") {
    afterSubgraphRead.mutate = () => {
      ctx.tabId = `${TAB}:rebound`;
    };
  }
  const def = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
  if (!def) throw new Error("panel_set_widget is not registered");
  const res: ToolResult = await def.handler(args as never, ctx);
  return {
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
    calls,
    authoritativeScopeReads: harness.authoritativeScopeReads,
    postEnterGraphQueries: harness.postEnterGraphQueries,
    writesApplied: harness.writesApplied,
    mutations: harness.mutations,
    bridgeRetryBudgets: harness.bridgeRetryBudgets,
  };
}

// #2299 — a COMFY_DYNAMICCOMBO_V3 child promoted out of a subgraph. The write is
// refused as "not promoted", recovery enters the subgraph and retries on the INNER
// node — a node no pre-write guard ever probed.
const DYNAMIC_CHILD_CONTRADICTORY =
  `Cannot set widget on subgraph node 78: "model.prompt" is not a promoted widget on this subgraph ` +
  `(promoted: model.prompt).`;

const DYNAMIC_SUBGRAPH = {
  subgraph_of: { node_id: 78, title: "H3" },
  instance_widgets: { "model.prompt": "" },
  node_count: 1,
  nodes: [
    {
      id: 76,
      type: "MinimaxHailuo03TextToVideoNode",
      widgets: { model: "text-to-video", "model.prompt": "" },
      inputs: [
        { name: "model", type: "COMFY_DYNAMICCOMBO_V3" },
        { name: "model.prompt", type: "STRING" },
      ],
    },
  ],
};

// Only the INNER node carries both halves of the shape. The container exposes the
// promoted child but not the `model` parent, so id 190 here stands in for an outer
// probe that cannot prove it and must fall open.
const DYNAMIC_DETAIL_BY_ID = {
  "78": { nodes: [{ id: 190, inputs: [{ slot: 0, name: "model.prompt" }] }] },
  "76": {
    nodes: [
      {
        id: 76,
        type: "MinimaxHailuo03TextToVideoNode",
        widgets: { model: "text-to-video", "model.prompt": "" },
        inputs: [
          { name: "model", type: "COMFY_DYNAMICCOMBO_V3" },
          { name: "model.prompt", type: "STRING" },
        ],
      },
    ],
  },
};

describe("panel_set_widget promoted inner dynamic-combo child (#2299)", () => {
  it("refuses the inner write instead of reporting a false success", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "model.prompt", value: "a long prompt" },
      {
        firstWrite: "contradict",
        firstWriteError: DYNAMIC_CHILD_CONTRADICTORY,
        subgraph: DYNAMIC_SUBGRAPH,
        detailById: DYNAMIC_DETAIL_BY_ID,
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
      },
    );
    expect(isError).toBe(true);
    expect(text).toContain("dynamic-combo");
    expect(text).toContain("No inner graph_set_widget was dispatched");
    // The recovery entered the subgraph and left it again...
    expect(calls.some((c) => c.cmd === "graph_enter_subgraph")).toBe(true);
    expect(calls.some((c) => c.cmd === "graph_exit_subgraph")).toBe(true);
    // ...and the INNER node was never written. Only the outer attempt happened.
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes.every((c) => String(c.node_id) !== "76")).toBe(true);
  });

  it("still applies a promoted inner write when the inner node is NOT a dynamic combo", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 78, widget: "model.prompt", value: "a long prompt" },
      {
        firstWrite: "contradict",
        firstWriteError: DYNAMIC_CHILD_CONTRADICTORY,
        innerWrite: "ok",
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        subgraph: {
          ...DYNAMIC_SUBGRAPH,
          nodes: [
            {
              id: 76,
              type: "OrdinaryNode",
              widgets: { "model.prompt": "" },
              inputs: [
                { name: "model", type: "STRING" },
                { name: "model.prompt", type: "STRING" },
              ],
            },
          ],
        },
        detailById: {
          "78": DYNAMIC_DETAIL_BY_ID["78"],
          // Same dotted name, ordinary STRING parent — not the #2299 shape.
          "76": {
            nodes: [
              {
                id: 76,
                type: "OrdinaryNode",
                widgets: { "model.prompt": "" },
                inputs: [
                  { name: "model", type: "STRING" },
                  { name: "model.prompt", type: "STRING" },
                ],
              },
            ],
          },
        },
      },
    );
    expect(isError).toBe(false);
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes.some((c) => String(c.node_id) === "76")).toBe(true);
  });
});

// #2305 — an LC123 regional-canvas prompt widget promoted out of a subgraph. The
// outer #1658 guard probed the CONTAINER, which is never one of the regional-canvas
// types, so it fell open; the write is refused as "not promoted", and recovery
// retries on the INNER node — the node whose custom JS owns the prompt.
const ANIMA_CONTRADICTORY =
  `Cannot set widget on subgraph node 78: "quality_prompt" is not a promoted widget on this ` +
  `subgraph (promoted: quality_prompt, scene_prompt).`;

const ANIMA_SUBGRAPH = {
  subgraph_of: { node_id: 78, title: "Regional" },
  instance_widgets: { quality_prompt: "", scene_prompt: "" },
  node_count: 1,
  nodes: [
    {
      id: 76,
      type: "AnimaRegionalCanvasInline",
      widgets: { quality_prompt: "", scene_prompt: "" },
    },
  ],
};

/** The outer probe sees the container's own type and must fall open; only the
 *  inner row names a regional-canvas node. */
const ANIMA_IDENTITY_BY_ID = {
  "78": { nodes: [{ id: 78, type: "SubgraphNode" }] },
  "76": { nodes: [{ id: 76, type: "AnimaRegionalCanvasInline" }] },
};

describe("panel_set_widget promoted inner LC123 regional prompt (#2305)", () => {
  it("refuses the inner write instead of reporting a false success", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece, best quality" },
      {
        firstWrite: "contradict",
        firstWriteError: ANIMA_CONTRADICTORY,
        subgraph: ANIMA_SUBGRAPH,
        detailById: ANIMA_IDENTITY_BY_ID,
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
      },
    );
    expect(isError).toBe(true);
    expect(text).toContain("LC123 regional-canvas prompt");
    // The real #1658 refusal body, not a lookalike message.
    expect(text).toContain("AnimaRegionalCanvasInline");
    expect(text).toContain("animaPrompts");
    expect(text).toContain("No inner graph_set_widget was dispatched");
    // The recovery entered the subgraph and left it again...
    expect(calls.some((c) => c.cmd === "graph_enter_subgraph")).toBe(true);
    expect(calls.some((c) => c.cmd === "graph_exit_subgraph")).toBe(true);
    // ...the guard was re-probed against the INNER id, not the container...
    expect(
      calls.some(
        (c) =>
          c.cmd === "graph_query" &&
          Array.isArray(c.ids) &&
          String((c.ids as unknown[])[0]) === "76",
      ),
    ).toBe(true);
    // ...and the INNER node was never written. Only the outer attempt happened.
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes.every((c) => String(c.node_id) !== "76")).toBe(true);
  });

  it("still applies a promoted inner write when the inner node is NOT a regional canvas", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece, best quality" },
      {
        firstWrite: "contradict",
        firstWriteError: ANIMA_CONTRADICTORY,
        innerWrite: "ok",
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        subgraph: {
          ...ANIMA_SUBGRAPH,
          nodes: [
            { id: 76, type: "PrimitiveStringMultiline", widgets: { quality_prompt: "" } },
          ],
        },
        detailById: {
          "78": ANIMA_IDENTITY_BY_ID["78"],
          // Same widget name, ordinary node — not the #1658 shape.
          "76": { nodes: [{ id: 76, type: "PrimitiveStringMultiline" }] },
        },
      },
    );
    expect(isError).toBe(false);
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes.some((c) => String(c.node_id) === "76")).toBe(true);
  });
});

const SAFE_ANIMA_SUBGRAPH = {
  subgraph_of: { node_id: 78, title: "Container" },
  node_count: 1,
  nodes: [{ id: 76, type: "PrimitiveStringMultiline", widgets: { quality_prompt: "old" } }],
};

const SAFE_ANIMA_IDENTITY_BY_ID = {
  "78": ANIMA_IDENTITY_BY_ID["78"],
  "76": { nodes: [{ id: 76, type: "PrimitiveStringMultiline" }] },
};

const CURRENT_SAFE_PROMOTED_SUBGRAPH = {
  ...SAFE_ANIMA_SUBGRAPH,
  promoted_terminals: [
    {
      widget: "quality_prompt",
      parent_rail: { authoritative: true, widget: "quality_prompt" },
      immediate_node_id: 76,
      immediate_widget: "quality_prompt",
      terminal_node_id: 76,
      terminal_node_type: "PrimitiveStringMultiline",
      terminal_widget: "quality_prompt",
      terminal_inputs: [],
      chain_depth: 0,
    },
  ],
};

const QWEN_EDIT_PROMOTED_SUBGRAPH = {
  subgraph_of: { node_id: 170, title: "Qwen Image Edit 2511 INT8" },
  node_count: 1,
  nodes: [
    {
      id: 168,
      type: "PrimitiveBoolean",
      widgets: { value: false },
      inputs: [{ name: "value", type: "BOOLEAN" }],
    },
  ],
  promoted_terminals: [
    {
      widget: "enable_turbo_mode",
      parent_rail: { authoritative: true, widget: "enable_turbo_mode" },
      immediate_node_id: 168,
      immediate_widget: "value",
      terminal_node_id: 168,
      terminal_node_type: "PrimitiveBoolean",
      terminal_widget: "value",
      terminal_inputs: [{ name: "value", type: "BOOLEAN" }],
      chain_depth: 0,
    },
  ],
};

const QWEN_EDIT_INCOMPLETE_PROMOTED_SUBGRAPH = {
  ...QWEN_EDIT_PROMOTED_SUBGRAPH,
  promoted_terminals: [
    {
      widget: "enable_turbo_mode",
      error: "promoted terminal _subgraphSlot is not resolved yet",
    },
  ],
};

/** #2393 recurrence — official-template COMBO `unet_name` on a root SubgraphNode.
 * The own-entry is incomplete (parent rail is a name-only stub) and the live
 * immediate ids can point at the WRONG inner node after input-count drift.
 * Query maps through input-rail output 6 to UNETLoader 37. */
const UNet_COMBO_TEMPLATE_SUBGRAPH = {
  subgraph_of: { node_id: 472, title: "Official Template" },
  node_count: 2,
  nodes: [
    {
      id: 37,
      type: "UNETLoader",
      widgets: { unet_name: "model.safetensors", weight_dtype: "default" },
      inputs: [
        { slot: 0, name: "unet_name", type: "COMBO", connected_from: { node_id: -10, output_slot: 6 } },
        { slot: 1, name: "weight_dtype", type: "COMBO" },
      ],
    },
    {
      id: 38,
      type: "CLIPLoader",
      widgets: { clip_name: "clip.safetensors" },
      inputs: [
        { slot: 0, name: "clip_name", type: "COMBO", connected_from: { node_id: -10, output_slot: 7 } },
      ],
    },
  ],
  promoted_terminals: [
    {
      widget: "unet_name",
      immediate_node_id: 99,
      immediate_widget: "value",
      error: "the promoted parent rail was missing, externally linked, or not authoritative",
    },
    {
      widget: "lora_name",
      error:
        "properties.proxyWidgets named a promoted relation that had no live node.widgets/_subgraphSlot projection",
    },
  ],
};

const UNet_COMBO_TEMPLATE_DETAIL = {
  text:
    '1 match(es) of 1 in scope (viewing: 1 nodes)\n' +
    '{"id":472,"type":"SubgraphNode","is_subgraph":true}',
};

/** #2488 — inner PrimitiveInt.length exposed as host frame_counts. The inner
 * widget is link-driven; the durable store is the enclosing SubgraphNode. */
const FRAME_COUNTS_PROMOTED_SUBGRAPH = {
  subgraph_of: { node_id: 78, title: "Clip pack" },
  node_count: 1,
  nodes: [
    {
      id: 12,
      type: "PrimitiveInt",
      widgets: { length: 81 },
      inputs: [{ name: "length", type: "INT" }],
    },
  ],
  promoted_terminals: [
    {
      widget: "frame_counts",
      parent_rail: { authoritative: true, widget: "frame_counts" },
      immediate_node_id: 12,
      immediate_widget: "length",
      terminal_node_id: 12,
      terminal_node_type: "PrimitiveInt",
      terminal_widget: "length",
      terminal_inputs: [{ name: "length", type: "INT" }],
      chain_depth: 0,
    },
  ],
};

describe("panel_set_widget promoted subgraph input routing (#2488)", () => {
  const hostDetail = {
    text:
      '1 match(es) of 1 in scope (viewing: 1 nodes)\n' +
      '{"id":78,"type":"SubgraphNode","is_subgraph":true}',
  };

  it.each(["frame_counts", "length"] as const)(
    "writes the host rail first when the caller addresses the SubgraphNode as %s",
    async (widget) => {
      const { text, isError, calls, mutations } = await setWidget(
        { node_id: 78, widget, value: 49 },
        {
          firstWrite: "ok",
          promotedTerminalWitnesses: true,
          promotedDetail: hostDetail,
          subgraph: FRAME_COUNTS_PROMOTED_SUBGRAPH,
        },
      );

      expect(isError).toBe(false);
      expect(mutations).toBe(1);
      expect(calls.filter((call) => call.cmd === "graph_enter_subgraph")).toHaveLength(0);
      expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
        expect.objectContaining({ node_id: 78, widget: "frame_counts", value: 49 }),
      ]);
      expect(text).toMatch(/enclosing subgraph node 78 widget "frame_counts"/);
      expect(text).toMatch(/inner mapping node 12 "length"/);
      expect(text).not.toMatch(/validated promoted inner widget/);
    },
  );

  it("writes the host rail when the inner PrimitiveInt keeps the same widget name", async () => {
    const sameName = {
      ...FRAME_COUNTS_PROMOTED_SUBGRAPH,
      promoted_terminals: [
        {
          ...FRAME_COUNTS_PROMOTED_SUBGRAPH.promoted_terminals[0],
          widget: "length",
          parent_rail: { authoritative: true, widget: "length" },
        },
      ],
    };
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 78, widget: "length", value: 49 },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        promotedDetail: hostDetail,
        subgraph: sameName,
      },
    );

    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({ node_id: 78, widget: "length", value: 49 }),
    ]);
    expect(calls.map((call) => call.cmd)).not.toContain("graph_enter_subgraph");
    expect(text).toMatch(/enclosing subgraph node 78 widget "length"/);
  });

  it("refuses the host write when the root graph changes after the MCP fence", async () => {
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 78, widget: "frame_counts", value: 49 },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        promotedDetail: hostDetail,
        subgraph: FRAME_COUNTS_PROMOTED_SUBGRAPH,
        receiverNavigationAfterMcpFence: true,
        receiverGraphIdentityCollisionAfterMcpFence: true,
      },
    );

    expect(isError).toBe(true);
    expect(mutations).toBe(0);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(1);
    expect(calls.find((call) => call.cmd === "graph_set_widget")).toEqual(
      expect.objectContaining({
        expected_scope: expect.objectContaining({ scope: "root", graph_identity: "graph:workflow-a-root" }),
      }),
    );
    expect(text).toMatch(/promoted receiver changed|Nothing was applied/);
  });

  it("does not report a link-driven inner fallback as a durable write", async () => {
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 78, widget: "frame_counts", value: 49 },
      {
        firstWriteError:
          `Cannot set widget on subgraph node 78: "frame_counts" is not a promoted widget ` +
          `on this subgraph (promoted: frame_counts).`,
        promotedTerminalWitnesses: true,
        promotedDetail: hostDetail,
        subgraph: FRAME_COUNTS_PROMOTED_SUBGRAPH,
        innerWriteLinkDriven: true,
      },
    );

    expect(isError).toBe(true);
    expect(mutations).toBe(0);
    expect(calls.filter((call) => call.cmd === "graph_enter_subgraph")).toHaveLength(0);
    expect(
      calls.some((call) => call.cmd === "graph_set_widget" && Number(call.node_id) === 12),
    ).toBe(false);
    expect(text).toMatch(/enclosing subgraph widget on node 78/);
    expect(text).not.toMatch(/Applied via the validated promoted inner widget/);
  });
});

/** #2500 — inner PrimitiveInt.value is a live input driven by the promoted
 * duration/fps rail. Without a parent-rail witness, #2488 host-first would
 * skip and the inner write would succeed while leaving the container at 5s. */
const DURATION_PROMOTED_SUBGRAPH = {
  subgraph_of: { node_id: 42, title: "First-Last-Frame to Video (LTX-2.3)" },
  node_count: 1,
  nodes: [
    {
      id: 198,
      type: "PrimitiveInt",
      widgets: { value: 5 },
      inputs: [{ name: "value", type: "INT" }],
    },
  ],
  promoted_terminals: [
    {
      widget: "value_2",
      parent_rail: { authoritative: true, widget: "value_2" },
      immediate_node_id: 198,
      immediate_widget: "value",
      terminal_node_id: 198,
      terminal_node_type: "PrimitiveInt",
      terminal_widget: "value",
      terminal_inputs: [{ name: "value", type: "INT" }],
      chain_depth: 0,
    },
  ],
};

describe("panel_set_widget promoted Primitive value misroute (#2500)", () => {
  const hostDetail = {
    text:
      '1 match(es) of 1 in scope (viewing: 1 nodes)\n' +
      '{"id":42,"type":"SubgraphNode","is_subgraph":true}',
  };

  it("writes duration/value_2 on the enclosing subgraph when the inner value input is link-driven", async () => {
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 42, widget: "value_2", value: 4 },
      {
        ownerNodeId: 42,
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        promotedDetail: hostDetail,
        subgraph: DURATION_PROMOTED_SUBGRAPH,
      },
    );

    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(calls.filter((call) => call.cmd === "graph_enter_subgraph")).toHaveLength(0);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({ node_id: 42, widget: "value_2", value: 4 }),
    ]);
    expect(calls.some((call) => Number(call.node_id) === 198)).toBe(false);
    expect(text).toMatch(/enclosing subgraph node 42 widget "value_2"/);
    expect(text).not.toMatch(/will NOT change the render|Set the enclosing subgraph node/);
  });

  it("does not misroute a contradictory host write onto a link-driven Primitive value inner", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 42, widget: "value_2", value: 4 },
      {
        ownerNodeId: 42,
        firstWriteError:
          `Cannot set widget on subgraph node 42: "value_2" is not a promoted widget ` +
          `on this subgraph (promoted: value_2).`,
        promotedTerminalWitnesses: true,
        promotedDetail: hostDetail,
        subgraph: DURATION_PROMOTED_SUBGRAPH,
        innerWriteLinkDriven: true,
      },
    );

    expect(isError).toBe(true);
    expect(calls.filter((call) => call.cmd === "graph_enter_subgraph")).toHaveLength(0);
    expect(
      calls.some((call) => call.cmd === "graph_set_widget" && Number(call.node_id) === 198),
    ).toBe(false);
    expect(text).not.toMatch(/Applied via the validated promoted inner widget/);
  });
});

/** #2533 — Krea-2 Turbo promoted STRING (`value`, labelled `prompt`). Both
 * caller names must resolve to the same inner PrimitiveString.value, and the
 * enclosing subgraph widget is the durable store. */
const KREA_PROMPT_PROMOTED_SUBGRAPH = {
  subgraph_of: { node_id: 12, title: "Text to Image (Krea-2 Turbo)" },
  node_count: 1,
  nodes: [
    {
      id: 131,
      type: "PrimitiveString",
      widgets: { value: "a cat" },
      inputs: [{ name: "value", type: "STRING" }],
    },
  ],
  promoted_terminals: [
    {
      widget: "prompt",
      parent_rail: { authoritative: true, widget: "value" },
      immediate_node_id: 131,
      immediate_widget: "value",
      terminal_node_id: 131,
      terminal_node_type: "PrimitiveString",
      terminal_widget: "value",
      terminal_inputs: [{ name: "value", type: "STRING" }],
      chain_depth: 0,
    },
  ],
};

/** #2533 — MiniMax audio_minimax_music_3. Root container 37 has authoritative
 * unet_name/clip_name rails; the inners are ordinary COMBO widgets that are
 * live inputs, not Primitive* value. */
const MINIMAX_MUSIC_PROMOTED_SUBGRAPH = {
  subgraph_of: { node_id: 37, title: "audio_minimax_music_3" },
  node_count: 2,
  nodes: [
    {
      id: 6,
      type: "UNETLoader",
      widgets: { unet_name: "music_fp16.safetensors", weight_dtype: "default" },
      inputs: [
        { name: "unet_name", type: "COMBO" },
        { name: "weight_dtype", type: "COMBO" },
      ],
    },
    {
      id: 8,
      type: "CLIPLoader",
      widgets: { clip_name: "clip_fp16.safetensors", type: "stable_diffusion" },
      inputs: [
        { name: "clip_name", type: "COMBO" },
        { name: "type", type: "COMBO" },
      ],
    },
  ],
  promoted_terminals: [
    {
      widget: "unet_name",
      parent_rail: { authoritative: true, widget: "unet_name" },
      immediate_node_id: 6,
      immediate_widget: "unet_name",
      terminal_node_id: 6,
      terminal_node_type: "UNETLoader",
      terminal_widget: "unet_name",
      terminal_inputs: [
        { name: "unet_name", type: "COMBO" },
        { name: "weight_dtype", type: "COMBO" },
      ],
      chain_depth: 0,
    },
    {
      widget: "clip_name",
      parent_rail: { authoritative: true, widget: "clip_name" },
      immediate_node_id: 8,
      immediate_widget: "clip_name",
      terminal_node_id: 8,
      terminal_node_type: "CLIPLoader",
      terminal_widget: "clip_name",
      terminal_inputs: [
        { name: "clip_name", type: "COMBO" },
        { name: "type", type: "COMBO" },
      ],
      chain_depth: 0,
    },
  ],
};

describe("panel_set_widget promoted STRING prompt/value (#2533)", () => {
  const hostDetail = {
    text:
      '1 match(es) of 1 in scope (viewing: 1 nodes)\n' +
      '{"id":12,"type":"SubgraphNode","is_subgraph":true}',
  };

  it.each(["prompt", "value"] as const)(
    "writes the enclosing subgraph when the labelled STRING is addressed as %s",
    async (widget) => {
      const { text, isError, calls, mutations } = await setWidget(
        { node_id: 12, widget, value: "a red bicycle at dusk" },
        {
          ownerNodeId: 12,
          firstWrite: "ok",
          promotedTerminalWitnesses: true,
          promotedDetail: hostDetail,
          subgraph: KREA_PROMPT_PROMOTED_SUBGRAPH,
        },
      );

      expect(isError).toBe(false);
      expect(mutations).toBe(1);
      expect(calls.filter((call) => call.cmd === "graph_enter_subgraph")).toHaveLength(0);
      expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
        expect.objectContaining({ node_id: 12, widget: "value", value: "a red bicycle at dusk" }),
      ]);
      expect(calls.some((call) => Number(call.node_id) === 131)).toBe(false);
      expect(text).toMatch(/enclosing subgraph node 12 widget "value"/);
      expect(text).not.toMatch(/will NOT change the render|The container was not written/);
    },
  );
});

describe("panel_set_widget promoted MiniMax unet_name/clip_name (#2533)", () => {
  const hostDetail = {
    text:
      '1 match(es) of 1 in scope (viewing: 1 nodes)\n' +
      '{"id":37,"type":"SubgraphNode","is_subgraph":true}',
  };

  it("writes unet_name on the enclosing container instead of inner UNETLoader 6", async () => {
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 37, widget: "unet_name", value: "music_fp8.safetensors" },
      {
        ownerNodeId: 37,
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        promotedDetail: hostDetail,
        subgraph: MINIMAX_MUSIC_PROMOTED_SUBGRAPH,
        innerWriteLinkDriven: true,
      },
    );

    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(calls.filter((call) => call.cmd === "graph_enter_subgraph")).toHaveLength(0);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({ node_id: 37, widget: "unet_name", value: "music_fp8.safetensors" }),
    ]);
    expect(calls.some((call) => Number(call.node_id) === 6)).toBe(false);
    expect(text).toMatch(/enclosing subgraph node 37 widget "unet_name"/);
    expect(text).not.toMatch(/will NOT change the render|The container was not written/);
  });

  it("writes clip_name on the enclosing container instead of inner CLIPLoader 8", async () => {
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 37, widget: "clip_name", value: "clip_fp8.safetensors" },
      {
        ownerNodeId: 37,
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        promotedDetail: hostDetail,
        subgraph: MINIMAX_MUSIC_PROMOTED_SUBGRAPH,
        innerWriteLinkDriven: true,
      },
    );

    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(calls.filter((call) => call.cmd === "graph_enter_subgraph")).toHaveLength(0);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({ node_id: 37, widget: "clip_name", value: "clip_fp8.safetensors" }),
    ]);
    expect(calls.some((call) => Number(call.node_id) === 8)).toBe(false);
    expect(text).toMatch(/enclosing subgraph node 37 widget "clip_name"/);
    expect(text).not.toMatch(/will NOT change the render|The container was not written/);
  });
});

describe("panel_set_widget coordinated promoted-widget fixes (#2393, #2394)", () => {
  it("refreshes one incomplete post-template terminal witness before the guarded inner write (#2393)", async () => {
    const { isError, calls, mutations } = await setWidget(
      { node_id: 170, widget: "enable_turbo_mode", value: true },
      {
        ownerNodeId: 170,
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        promotedDetail: {
          text:
            '1 match(es) of 1 in scope (viewing: 1 nodes)\n' +
            '{"id":170,"type":"SubgraphNode","is_subgraph":true}',
        },
        subgraph: QWEN_EDIT_PROMOTED_SUBGRAPH,
        subgraphSequence: [
          QWEN_EDIT_INCOMPLETE_PROMOTED_SUBGRAPH,
          QWEN_EDIT_PROMOTED_SUBGRAPH,
        ],
      },
    );

    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(calls.filter((call) => call.cmd === "graph_get_subgraph")).toHaveLength(2);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({ node_id: 170, widget: "enable_turbo_mode", value: true }),
    ]);
    expect(calls.map((call) => call.cmd)).not.toContain("graph_enter_subgraph");
  });

  it("allows a missing root-level Power Lora Loader lora_N row without entering promoted mapping (#2394)", async () => {
    const value = '{"on":true,"lora":"turbo.safetensors","strength":1,"strengthTwo":null}';
    const { isError, calls, mutations } = await setWidget(
      { node_id: 82, widget: "lora_1", value },
      {
        ownerNodeId: 82,
        firstWrite: "ok",
        // If the classifier regresses to graph_get_subgraph first, this is the
        // refusal observed for a fresh root loader rather than a safe write.
        subgraph: new Error("Node 82 (Power Lora Loader (rgthree)) is not a subgraph"),
        promotedDetail: {
          text:
            '1 match(es) of 1 in scope (viewing: 1 nodes)\n' +
            '{"id":82,"type":"Power Lora Loader (rgthree)","is_subgraph":false}',
        },
      },
    );

    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(calls.filter((call) => call.cmd === "graph_get_subgraph")).toHaveLength(0);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({ node_id: 82, widget: "lora_1", value }),
    ]);
  });

  it("does not use the root-only lora_N shortcut from an active subgraph (#2394)", async () => {
    const value = '{"on":true,"lora":"turbo.safetensors","strength":1,"strengthTwo":null}';
    const { isError, calls, mutations } = await setWidget(
      { node_id: 82, widget: "lora_1", value },
      {
        ownerNodeId: 78,
        startInSubgraph: true,
        firstWrite: "ok",
        // The target is ordinary, but the active viewing scope is a subgraph.
        promotedDetail: {
          text:
            '1 match(es) of 1 in scope (viewing: 1 nodes)\n' +
            '{"id":82,"type":"Power Lora Loader (rgthree)","is_subgraph":false}',
        },
        subgraph: new Error("Node 82 (Power Lora Loader (rgthree)) is not a subgraph"),
      },
    );

    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(calls.filter((call) => call.cmd === "graph_get_subgraph")).toHaveLength(1);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({ node_id: 82, widget: "lora_1", value }),
    ]);
  });
});

describe("panel_set_widget definitive-non-subgraph exit fence (#2409)", () => {
  const value = '{"on":true,"lora":"turbo.safetensors","strength":1,"strengthTwo":null}';
  const ordinaryRootDetail = {
    text:
      '1 match(es) of 1 in scope (viewing: 1 nodes)\n' +
      '{"id":82,"type":"Power Lora Loader (rgthree)","is_subgraph":false}',
  };

  // The scope probe cannot take the fast path here (the active view is a subgraph),
  // so the write reaches graph_get_subgraph and leaves through the definitive
  // non-subgraph exit — the one #2405 did not fence.
  const conservative = {
    firstWrite: "ok" as const,
    ownerNodeId: 78,
    startInSubgraph: true,
    promotedDetail: ordinaryRootDetail,
    subgraph: new Error("Node 82 (Power Lora Loader (rgthree)) is not a subgraph"),
  };

  it.each(["tab", "connection"] as const)(
    "refuses the definitive non-subgraph exit when the %s identity changes after the subgraph read",
    async (identity) => {
      const { text, isError, writesApplied, mutations } = await setWidget(
        { node_id: 82, widget: "lora_1", value },
        { ...conservative, subgraphReadIdentityChange: identity },
      );

      expect(isError).toBe(true);
      expect(text).toMatch(/after the subgraph read/);
      expect(writesApplied).toBe(0);
      expect(mutations).toBe(0);
    },
  );

  it("still writes through that exit when the binding is stable", async () => {
    const { isError, writesApplied, mutations } = await setWidget(
      { node_id: 82, widget: "lora_1", value },
      conservative,
    );

    expect(isError).toBe(false);
    expect(writesApplied).toBe(1);
    expect(mutations).toBe(1);
  });
});

describe("panel_set_widget ordinary-node scope probe fence (#2401)", () => {
  const value = '{"on":true,"lora":"turbo.safetensors","strength":1,"strengthTwo":null}';
  const ordinaryRootDetail = {
    text:
      '1 match(es) of 1 in scope (viewing: 1 nodes)\n' +
      '{"id":82,"type":"Power Lora Loader (rgthree)","is_subgraph":false}',
  };

  it.each(["tab", "connection"] as const)(
    "refuses the ordinary fast path when the %s identity changes after the scope probe",
    async (identity) => {
      const { text, isError, calls, writesApplied, mutations } = await setWidget(
        { node_id: 82, widget: "lora_1", value },
        {
          firstWrite: "ok",
          promotedDetail: ordinaryRootDetail,
          scopeProbeIdentityChange: identity,
        },
      );

      expect(isError).toBe(true);
      expect(text).toMatch(/after the scope probe/);
      expect(calls.map((call) => call.cmd)).toEqual(["graph_query"]);
      expect(writesApplied).toBe(0);
      expect(mutations).toBe(0);
    },
  );

  it("keeps a stable ordinary root on the fast path", async () => {
    const { isError, calls, writesApplied, mutations } = await setWidget(
      { node_id: 82, widget: "lora_1", value },
      { firstWrite: "ok", promotedDetail: ordinaryRootDetail },
    );

    expect(isError).toBe(false);
    expect(calls.map((call) => call.cmd)).toEqual(["graph_query", "graph_set_widget"]);
    expect(writesApplied).toBe(1);
    expect(mutations).toBe(1);
  });

  it("keeps an ordinary node in an active subgraph on the conservative path", async () => {
    const { isError, calls, writesApplied, mutations } = await setWidget(
      { node_id: 82, widget: "lora_1", value },
      {
        firstWrite: "ok",
        ownerNodeId: 78,
        startInSubgraph: true,
        promotedDetail: ordinaryRootDetail,
        subgraph: new Error("Node 82 (Power Lora Loader (rgthree)) is not a subgraph"),
      },
    );

    expect(isError).toBe(false);
    expect(calls.map((call) => call.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
    ]);
    expect(writesApplied).toBe(1);
    expect(mutations).toBe(1);
  });

  it("keeps an unknown scope off the ordinary fast path", async () => {
    const { text, isError, calls, writesApplied, mutations } = await setWidget(
      { node_id: 82, widget: "lora_1", value },
      {
        firstWrite: "ok",
        omitViewing: true,
        promotedDetail: { nodes: [{ id: 82, type: "Power Lora Loader (rgthree)" }] },
        subgraph: new Error("graph_get_subgraph unavailable"),
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/could not determine whether the addressed node is a promoted container/);
    expect(calls.map((call) => call.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_get_subgraph",
    ]);
    expect(writesApplied).toBe(0);
    expect(mutations).toBe(0);
  });
});

describe("panel_set_widget root-scope write after a root graph read (#2518)", () => {
  const STRING_CONCAT_ID = 53;
  const ROOT_GRAPH_IDENTITY = "graph:workflow-a-root";
  const stalePromotedEnvelope = {
    subgraph_of: { node_id: STRING_CONCAT_ID, title: "stale-subgraph" },
    instance_widgets: { string_a: "old" },
    node_count: 1,
    nodes: [{ id: 99, type: "PrimitiveStringMultiline", widgets: { value: "old" } }],
  };

  it("writes a truncated root StringConcatenate widget without the promoted-subgraph path", async () => {
    const { text, isError, calls, writesApplied, mutations } = await setWidget(
      { node_id: STRING_CONCAT_ID, widget: "string_a", value: "hello" },
      {
        firstWrite: "ok",
        unusableConnectionIdentity: true,
        subgraph: stalePromotedEnvelope,
        promotedDetail: {
          truncated: true,
          viewing: {
            scope: "root",
            graph_identity: ROOT_GRAPH_IDENTITY,
            workflow_uuid: "workflow-a",
          },
          nodes: [
            {
              id: STRING_CONCAT_ID,
              type: "StringConcatenate",
              is_subgraph: false,
              widgets: { string_a: "old", string_b: "world", delimiter: " " },
            },
          ],
        },
      },
    );

    expect(isError).toBe(false);
    expect(text).not.toMatch(/refused the promoted/);
    expect(text).not.toMatch(/panel connection identity was unavailable/);
    expect(calls.filter((call) => call.cmd === "graph_get_subgraph")).toHaveLength(0);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({
        node_id: STRING_CONCAT_ID,
        widget: "string_a",
        value: "hello",
      }),
    ]);
    expect(writesApplied).toBe(1);
    expect(mutations).toBe(1);
  });

  it("still maps a root subgraph container through the promoted path", async () => {
    const { isError, calls, writesApplied, mutations } = await setWidget(
      { node_id: 78, widget: "width", value: 1920 },
      {
        firstWrite: "ok",
        promotedDetail: {
          truncated: false,
          nodes: [{ id: 78, type: "Krea2", is_subgraph: true, widgets: { width: 1024 } }],
        },
      },
    );

    expect(isError).toBe(false);
    expect(calls.filter((call) => call.cmd === "graph_get_subgraph").length).toBeGreaterThan(0);
    expect(writesApplied).toBe(1);
    expect(mutations).toBe(1);
  });
});

describe("panel_set_widget ordinary-root write with missing connection identity (#2551)", () => {
  const promotedLookingOrdinaryRoots = [
    {
      name: "PrimitiveFloat.value",
      node_id: 132,
      type: "PrimitiveFloat",
      widget: "value",
      value: 0.65,
      inputs: [{ name: "value", type: "FLOAT", widget: { name: "value" } }],
      widgets: { value: 1 },
    },
    {
      name: "DenoResolutionSetup.ratio_preset",
      node_id: 145,
      type: "DenoResolutionSetup",
      widget: "ratio_preset",
      value: "16:9",
      inputs: [
        { name: "ratio_preset", type: "COMBO", widget: { name: "ratio_preset" } },
        { name: "megapixels", type: "FLOAT", widget: { name: "megapixels" } },
      ],
      widgets: { ratio_preset: "1:1", megapixels: 1 },
    },
    {
      name: "PrimitiveStringMultiline.value",
      node_id: 196,
      type: "PrimitiveStringMultiline",
      widget: "value",
      value: "a prompt",
      inputs: [{ name: "value", type: "STRING", widget: { name: "value" } }],
      widgets: { value: "" },
    },
  ] as const;

  it.each(promotedLookingOrdinaryRoots)(
    "writes $name on the ordinary path when the connection identity is missing",
    async ({ node_id, type, widget, value, inputs, widgets }) => {
      const { text, isError, calls, writesApplied, mutations } = await setWidget(
        { node_id, widget, value },
        {
          firstWrite: "ok",
          unusableConnectionIdentity: true,
          promotedDetail: {
            nodes: [{ id: node_id, type, is_subgraph: false, inputs: [...inputs], widgets }],
          },
        },
      );

      expect(isError).toBe(false);
      expect(text).not.toMatch(/panel connection identity was unavailable/);
      expect(calls.map((call) => call.cmd)).toEqual(["graph_query", "graph_set_widget"]);
      expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
        expect.objectContaining({ node_id, widget, value }),
      ]);
      expect(writesApplied).toBe(1);
      expect(mutations).toBe(1);
    },
  );

  it("still refuses the ordinary fast path when a usable identity disappears after the scope probe", async () => {
    const { text, isError, calls, writesApplied, mutations } = await setWidget(
      { node_id: 132, widget: "value", value: 0.65 },
      {
        firstWrite: "ok",
        scopeProbeIdentityChange: "gone",
        promotedDetail: {
          nodes: [
            {
              id: 132,
              type: "PrimitiveFloat",
              is_subgraph: false,
              inputs: [{ name: "value", type: "FLOAT", widget: { name: "value" } }],
              widgets: { value: 1 },
            },
          ],
        },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/panel tab or connection changed after the scope probe/);
    expect(calls.map((call) => call.cmd)).toEqual(["graph_query"]);
    expect(writesApplied).toBe(0);
    expect(mutations).toBe(0);
  });
});

/** The outer read lists only B. The receiver's terminal witness proves that
 * B's own promoted rail continues to the concrete endpoint, so MCP can apply
 * the three known-bad guards to the node the panel will actually mutate. */
function nestedTerminalSubgraph(
  widget: string,
  terminal: { nodeId: number; nodeType: string; inputs: Array<Record<string, string>> },
) {
  return {
    subgraph_of: { node_id: 78, title: "Nested container" },
    node_count: 1,
    nodes: [
      {
        id: 188,
        type: "SubgraphB",
        is_subgraph: true,
        widgets: { [widget]: "old" },
      },
    ],
    promoted_terminals: [
      {
        widget,
        parent_rail: { authoritative: true, widget },
        immediate_node_id: 188,
        immediate_widget: widget,
        terminal_node_id: terminal.nodeId,
        terminal_node_type: terminal.nodeType,
        terminal_widget: widget,
        terminal_inputs: terminal.inputs,
        chain_depth: 1,
      },
    ],
  };
}

const NESTED_TERMINAL_CASES = [
  {
    name: "Anima regional prompt",
    widget: "quality_prompt",
    value: "masterpiece",
    subgraph: nestedTerminalSubgraph("quality_prompt", {
      nodeId: 2768,
      nodeType: "AnimaRegionalCanvasInline",
      inputs: [],
    }),
    firstWriteError: ANIMA_CONTRADICTORY,
    message: /animaPrompts/,
  },
  {
    name: "dynamic-combo STRING child",
    widget: "model.prompt",
    value: "a long prompt",
    subgraph: nestedTerminalSubgraph("model.prompt", {
      nodeId: 2769,
      nodeType: "NestedConcreteNode",
      inputs: [
        { name: "model", type: "COMFY_DYNAMICCOMBO_V3" },
        { name: "model.prompt", type: "STRING" },
      ],
    }),
    firstWriteError: DYNAMIC_CHILD_CONTRADICTORY,
    message: /dynamic-combo (?:sub-widget|child)/,
  },
  {
    name: "DaSiWa stack",
    widget: "stack_data",
    value: "NEW",
    subgraph: nestedTerminalSubgraph("stack_data", {
      nodeId: 2770,
      nodeType: "DaSiWa_LTX2LoraLoader",
      inputs: [],
    }),
    firstWriteError: STACK_DATA_CONTRADICTORY,
    message: /DaSiWa_LTX2LoraLoader/,
  },
] as const;

const NESTED_SAFE_SUBGRAPH = nestedTerminalSubgraph("quality_prompt", {
  nodeId: 2768,
  nodeType: "PrimitiveStringMultiline",
  inputs: [],
});
const NESTED_SAFE_INNER_SUBGRAPH = {
  subgraph_of: { node_id: 188, title: "Nested B" },
  node_count: 1,
  nodes: [{ id: 2768, type: "PrimitiveStringMultiline", widgets: { quality_prompt: "old" } }],
  promoted_terminals: [
    {
      widget: "quality_prompt",
      parent_rail: { authoritative: true, widget: "quality_prompt" },
      immediate_node_id: 2768,
      immediate_widget: "quality_prompt",
      terminal_node_id: 2768,
      terminal_node_type: "PrimitiveStringMultiline",
      terminal_widget: "quality_prompt",
      terminal_inputs: [],
      chain_depth: 0,
    },
  ],
};

describe("panel_set_widget nested promoted terminal guards (#2314)", () => {
  it("rechecks a safe A-to-B-to-concrete endpoint after entry and before dispatch", async () => {
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWrite: "ok",
        subgraph: NESTED_SAFE_SUBGRAPH,
        nestedSubgraph: NESTED_SAFE_INNER_SUBGRAPH,
      },
    );
    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(text).toMatch(/validated promoted inner widget/);
    expect(calls.filter((c) => c.cmd === "graph_get_subgraph")).toHaveLength(4);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({ node_id: 188, widget: "quality_prompt" }),
    ]);
  });

  it.each(NESTED_TERMINAL_CASES)("refuses the nested terminal before a successful write", async ({
    widget,
    value,
    subgraph,
    message,
  }) => {
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 78, widget, value },
      { firstWrite: "ok", subgraph },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(message);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
    expect(mutations).toBe(0);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");
  });

  it.each(NESTED_TERMINAL_CASES)("refuses the nested terminal on the legacy recovery path", async ({
    widget,
    value,
    subgraph,
    firstWriteError,
    message,
  }) => {
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 78, widget, value },
      {
        firstWrite: "contradict",
        firstWriteError,
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        subgraph,
      },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(message);
    expect(mutations).toBe(0);
    // Legacy recovery may have made its one contradictory outer attempt before
    // the terminal witness was read; it must never dispatch the inner/container
    // success path, and the simulated bridge records zero actual mutations.
    expect(calls.filter((c) => c.cmd === "graph_set_widget").length).toBeLessThanOrEqual(1);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");
    expect(text).toMatch(/No inner graph_set_widget was dispatched|not retried|not applied|Do not retry|No graph_set_widget was dispatched/i);
  });
});

describe("panel_set_widget promoted container success guards (#2314)", () => {
  it.each([
    [
      "Anima regional prompt",
      "quality_prompt",
      "masterpiece",
      ANIMA_SUBGRAPH,
      ANIMA_IDENTITY_BY_ID,
      undefined,
      /animaPrompts/,
    ],
    [
      "dynamic-combo STRING child",
      "model.prompt",
      "a long prompt",
      DYNAMIC_SUBGRAPH,
      DYNAMIC_DETAIL_BY_ID,
      undefined,
      /dynamic-combo (?:sub-widget|child)/,
    ],
    [
      "DaSiWa stack",
      "stack_data",
      "NEW",
      {
        subgraph_of: { node_id: 78, title: "Container" },
        node_count: 1,
        nodes: [{ id: 76, type: "DaSiWa_LTX2LoraLoader", widgets: { stack_data: "old" } }],
      },
      undefined,
      {
        stackDataIdentity: { nodes: [{ id: 78, type: "OtherLoraLoader" }] },
        stackDataInnerIdentity: { nodes: [{ id: 76, type: "DaSiWa_LTX2LoraLoader" }] },
      },
      /DaSiWa_LTX2LoraLoader/,
    ],
  ] as const)("refuses %s before a successful container write", async (
    _name,
    widget,
    value,
    subgraph,
    probe,
    stack,
    message,
  ) => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget, value },
      {
        firstWrite: "ok",
        subgraph,
        ...(probe ? { detailById: probe } : {}),
        ...(stack ?? {}),
      },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(message);
    expect(calls.map((c) => c.cmd)).toContain("graph_get_subgraph");
    if (widget === "stack_data") {
      expect(calls.map((c) => c.cmd)).toContain("graph_enter_subgraph");
      expect(calls.map((c) => c.cmd)).toContain("graph_exit_subgraph");
    }
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it.each([
    ["Anima regional prompt", "quality_prompt", SAFE_ANIMA_SUBGRAPH, SAFE_ANIMA_IDENTITY_BY_ID],
    [
      "dynamic-combo STRING child",
      "model.prompt",
      {
        ...DYNAMIC_SUBGRAPH,
        nodes: [
          {
            id: 76,
            type: "OrdinaryNode",
            widgets: { "model.prompt": "old" },
            inputs: [
              { name: "model", type: "STRING" },
              { name: "model.prompt", type: "STRING" },
            ],
          },
        ],
      },
      {
        "78": DYNAMIC_DETAIL_BY_ID["78"],
        "76": {
          nodes: [
            {
              id: 76,
              type: "OrdinaryNode",
              widgets: { "model.prompt": "old" },
              inputs: [
                { name: "model", type: "STRING" },
                { name: "model.prompt", type: "STRING" },
              ],
            },
          ],
        },
      },
    ],
    [
      "DaSiWa stack",
      "stack_data",
      {
        subgraph_of: { node_id: 78, title: "Container" },
        node_count: 1,
        nodes: [{ id: 76, type: "OtherLoraLoader", widgets: { stack_data: "old" } }],
      },
      undefined,
    ],
  ] as const)("keeps a safe %s promoted write successful via the inner node", async (
    _name,
    widget,
    subgraph,
    probe,
  ) => {
    const stack = widget === "stack_data"
      ? {
          stackDataIdentity: { nodes: [{ id: 78, type: "OtherLoraLoader" }] },
          stackDataInnerIdentity: { nodes: [{ id: 76, type: "OtherLoraLoader" }] },
        }
      : {};
    const { isError, calls } = await setWidget(
      { node_id: 78, widget, value: "NEW" },
      {
        firstWrite: "ok",
        subgraph,
        ...(probe ? { detailById: probe } : {}),
        ...stack,
      },
    );
    expect(isError).toBe(false);
    expect(calls.some((c) => c.cmd === "graph_get_subgraph")).toBe(true);
    expect(calls.map((c) => c.cmd)).toContain("graph_enter_subgraph");
    expect(calls.map((c) => c.cmd)).toContain("graph_exit_subgraph");
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ node_id: 76, widget });
  });

  it("refuses after one indeterminate graph_get_subgraph refresh before any container write", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: new Error("graph_get_subgraph unavailable"),
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/could not determine whether the addressed node is a promoted container/);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_query",
      "graph_query",
      "graph_get_subgraph",
      "graph_get_subgraph",
    ]);
  });

  // panel#1869 — the panel's own `[canvas-root-divergence]` diagnosis, which the
  // promoted-container wording used to swallow. These are the two remedy variants
  // `getGraphCtx()` actually emits, copied from the panel's refuseDivergence().
  const DIVERGENCE_ROOT_VARIANT =
    "[canvas-root-divergence] The canvas you are looking at (31 node(s)) and the panel's bound " +
    "root graph (0 node(s)) are two DIFFERENT graphs, so this command was NOT applied — the panel " +
    "cannot tell which one it was meant for, and picking either could edit a graph you are not " +
    "looking at. This usually follows a ComfyUI backend restart without a page reload. Save or " +
    "export the canvas you want to keep, then reload the ComfyUI page (a panel-only reload does " +
    "not rebuild this binding).";
  const DIVERGENCE_SUBGRAPH_VARIANT =
    "[canvas-root-divergence] The canvas you are looking at (4 node(s)) and the panel's bound " +
    "root graph (12 node(s)) are two DIFFERENT graphs, so this command was NOT applied. Leave the " +
    "open subgraph on the ComfyUI canvas (its breadcrumb, or double-click out) to get back to a " +
    "graph the panel can identify; if that does not clear it, save or export anything you need " +
    "from this view and reload the ComfyUI page.";

  it("relays the panel's divergence diagnosis instead of the promoted-container wording", async () => {
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: new Error(DIVERGENCE_ROOT_VARIANT),
      },
    );

    // Still fail-closed: the guard is untouched and nothing was written.
    expect(isError).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_query", "graph_query", "graph_get_subgraph"]);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_set_widget");
    expect(mutations).toBe(0);

    // The panel's cause AND its remedy survive to the caller.
    expect(text).toContain("[canvas-root-divergence]");
    expect(text).toContain("are two DIFFERENT graphs");
    expect(text).toContain("reload the ComfyUI page (a panel-only reload does not rebuild this binding)");

    // The two things panel#1869 was actually about: the wrong cause, and the
    // remedy the reporter followed into a loop with no exit.
    expect(text).not.toContain("could not determine whether the addressed node is a promoted container");
    expect(text).not.toContain("retry only after the panel binding and subgraph mapping are stable");
    expect(text).not.toMatch(/Retry only after the panel binding and subgraph mapping are stable/i);

    // And it rules out what the reporter tried next.
    expect(text).toContain("panel_open_workflow");
  });

  it("relays the SUBGRAPH-stranded remedy too, rather than a hardcoded one", async () => {
    const { text, isError, mutations } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: new Error(DIVERGENCE_SUBGRAPH_VARIANT),
      },
    );

    expect(isError).toBe(true);
    expect(mutations).toBe(0);
    // The root-restart remedy must NOT appear for a subgraph-stranded canvas:
    // that is the failure mode of naming a remedy here instead of relaying one.
    expect(text).toContain("Leave the open subgraph on the ComfyUI canvas");
    expect(text).not.toContain("This usually follows a ComfyUI backend restart");
  });

  it("leaves every NON-diagnosed indeterminate read on its original wording after one refresh", async () => {
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: new Error("graph_get_subgraph unavailable"),
      },
    );

    expect(isError).toBe(true);
    expect(mutations).toBe(0);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_query",
      "graph_query",
      "graph_get_subgraph",
      "graph_get_subgraph",
    ]);
    // The refusal wording remains unchanged: a transport failure IS transient,
    // so "retry once stable" is honest advice after the bounded refresh fails.
    expect(text).toContain("could not determine whether the addressed node is a promoted container");
    expect(text).toContain("retry only after the panel binding and subgraph mapping are stable");
    expect(text).not.toContain("[canvas-root-divergence]");
  });

  it("keeps a definitive non-promoted write valid", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: new Error("Node 78 (OrdinaryNode) is not a subgraph"),
      },
    );

    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_query",
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
    ]);
  });

  it("fails closed before the outer write when a current panel omits its witness array", async () => {
    const missingWitness: Record<string, unknown> = { ...CURRENT_SAFE_PROMOTED_SUBGRAPH };
    delete missingWitness.promoted_terminals;
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "renamed_alias", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: {
          ...missingWitness,
          nodes: [{ id: 76, type: "PrimitiveStringMultiline", widgets: { quality_prompt: "old" } }],
        },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/omitted the witness array/);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("fails closed before any write for an ambiguous current terminal alias", async () => {
    const entry = CURRENT_SAFE_PROMOTED_SUBGRAPH.promoted_terminals[0];
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: { ...CURRENT_SAFE_PROMOTED_SUBGRAPH, promoted_terminals: [entry, { ...entry }] },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/ambiguous|missing, stale, or unresolved/);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("fails closed before any write for a malformed current terminal witness", async () => {
    const entry = CURRENT_SAFE_PROMOTED_SUBGRAPH.promoted_terminals[0];
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: { ...CURRENT_SAFE_PROMOTED_SUBGRAPH, promoted_terminals: [{ ...entry, terminal_inputs: "bad" }] },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/malformed, stale, or incomplete ownership envelope/);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("fails closed before any write when the current alias loses its _subgraphSlot proof", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: {
          ...CURRENT_SAFE_PROMOTED_SUBGRAPH,
          promoted_terminals: [
            {
              widget: "quality_prompt",
              error: "_subgraphSlot missing or unresolved",
            },
          ],
        },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/incomplete or unresolved|missing, ambiguous, stale, or unresolved/);
    expect(calls.filter((call) => call.cmd === "graph_get_subgraph")).toHaveLength(2);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it.each([
    [
      "missing parent-rail authority",
      { ...CURRENT_SAFE_PROMOTED_SUBGRAPH.promoted_terminals[0], parent_rail: undefined },
    ],
    [
      "externally-linked parent rail",
      {
        ...CURRENT_SAFE_PROMOTED_SUBGRAPH.promoted_terminals[0],
        parent_rail: { authoritative: false, widget: "quality_prompt" },
      },
    ],
    [
      "producer refusal for an externally-linked parent rail",
      {
        widget: "quality_prompt",
        immediate_node_id: 76,
        immediate_widget: "quality_prompt",
        error: "the promoted parent rail was missing, externally linked, or not authoritative",
      },
    ],
  ])("never authorizes an inner write with %s", async (_name, entry) => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: { ...CURRENT_SAFE_PROMOTED_SUBGRAPH, promoted_terminals: [entry] },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/parent rail|malformed|incomplete|unresolved/i);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("does not treat an unrelated witness error as proof that this alias is ordinary", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "ordinary", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: {
          ...CURRENT_SAFE_PROMOTED_SUBGRAPH,
          promoted_terminals: [
            ...CURRENT_SAFE_PROMOTED_SUBGRAPH.promoted_terminals,
            { widget: "<proxyWidgets>", error: "proxyWidgets could not be enumerated" },
          ],
        },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/witness was incomplete or unresolved/);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("keeps a current-panel ordinary subgraph widget on the original outer path", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 78, widget: "ordinary", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: {
          subgraph_of: { node_id: 78, title: "Ordinary container" },
          node_count: 1,
          nodes: [{ id: 76, type: "PrimitiveStringMultiline", widgets: { ordinary: "old" } }],
          promoted_terminals: [],
        },
      },
    );

    expect(isError).toBe(false);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({ node_id: 78, widget: "ordinary" }),
    ]);
  });

  it("keeps the legacy ordinary path only after a definitive non-subgraph response", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 78, widget: "ordinary", value: "new" },
      { firstWrite: "ok", subgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH },
    );

    expect(isError).toBe(false);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({ node_id: 78, widget: "ordinary" }),
    ]);
  });

  it("preserves the legacy same-name promoted mapping without authorizing an outer fallback", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWrite: "ok",
        subgraph: {
          ...SAFE_ANIMA_SUBGRAPH,
          nodes: [{ id: 76, type: "PrimitiveStringMultiline", widgets: { quality_prompt: "old" } }],
        },
      },
    );

    expect(isError).toBe(false);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({ node_id: 76, widget: "quality_prompt" }),
    ]);
  });

  it.each([
    ["renamed Anima alias", "quality_alias", "AnimaRegionalCanvasInline", { quality_prompt: "old" }],
    ["renamed dynamic alias", "dynamic_alias", "DynamicOwner", { model: "owner", "model.prompt": "old" }],
    ["renamed DaSiWa alias", "stack_alias", "DaSiWa_LTX2LoraLoader", { stack_data: "old" }],
    ["renamed dotted alias", "model.renamed", "DynamicOwner", { model: "owner", "model.prompt": "old" }],
  ] as const)("fails closed for a capability-skewed %s instead of writing the outer container", async (
    _name,
    widget,
    type,
    widgets,
  ) => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget, value: "new" },
      {
        firstWrite: "ok",
        // A partial/old receiver may even return an empty witness array. It is
        // not authoritative when hello did not advertise the complete witness
        // capability, so the renamed relation must still refuse.
        subgraph: {
          ...SAFE_ANIMA_SUBGRAPH,
          nodes: [{ id: 76, type, widgets }],
          promoted_terminals: [],
        },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/legacy receiver could not prove|No graph_set_widget was dispatched/);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("does not ignore an ambiguous unadvertised witness and revive a legacy write", async () => {
    const entry = CURRENT_SAFE_PROMOTED_SUBGRAPH.promoted_terminals[0];
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWrite: "ok",
        subgraph: {
          ...SAFE_ANIMA_SUBGRAPH,
          nodes: [{ id: 76, type: "PrimitiveStringMultiline", widgets: { quality_prompt: "old" } }],
          promoted_terminals: [entry, { ...entry }],
        },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/witness was ambiguous|No graph_set_widget was dispatched/);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("does not compare the child graph token with a parent view before entering it", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: CURRENT_SAFE_PROMOTED_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        preEntryScopeRead: {
          known: true,
          scope: "subgraph",
          ownerNodeId: "500",
          workflowUuid: "workflow-a",
          graphIdentity: "graph:workflow-a-parent",
        },
      },
    );

    expect(isError).toBe(false);
    expect(calls.map((call) => call.cmd)).toContain("graph_enter_subgraph");
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({ node_id: 76, widget: "quality_prompt" }),
    ]);
  });

  it("fails closed when the current terminal witness relinks before dispatch", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        preflightSubgraph: CURRENT_SAFE_PROMOTED_SUBGRAPH,
        subgraph: {
          ...CURRENT_SAFE_PROMOTED_SUBGRAPH,
          promoted_terminals: [
            {
              ...CURRENT_SAFE_PROMOTED_SUBGRAPH.promoted_terminals[0],
              terminal_node_id: 99,
            },
          ],
        },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/mapping changed or became unverifiable/);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("fails closed when the live parent rail relinks before dispatch", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        preflightSubgraph: CURRENT_SAFE_PROMOTED_SUBGRAPH,
        subgraph: {
          ...CURRENT_SAFE_PROMOTED_SUBGRAPH,
          promoted_terminals: [
            {
              ...CURRENT_SAFE_PROMOTED_SUBGRAPH.promoted_terminals[0],
              parent_rail: { authoritative: true, widget: "relinked_quality_prompt" },
            },
          ],
        },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/mapping changed or became unverifiable/);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("binds parent-rail authority into final graph_set_widget after graph_enter_subgraph", async () => {
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        parentRailRelinkAfterMcpFence: true,
        subgraph: CURRENT_SAFE_PROMOTED_SUBGRAPH,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/parent rail changed before dispatch/);
    expect(mutations).toBe(0);
    expect(calls.map((call) => call.cmd)).toContain("graph_enter_subgraph");
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({
        node_id: 76,
        widget: "quality_prompt",
        expected_scope: expect.objectContaining({
          promoted_widget: "quality_prompt",
          parent_rail: { authoritative: true, widget: "quality_prompt" },
        }),
      }),
    ]);
  });

  it("refuses a promoted mapping for an old receiver without the graph-identity fence", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        scopeGraphIdentityFence: false,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/does not advertise the atomic promoted graph-identity write fence/);
    // panel#1859 — a capability the hello did not advertise is a build fact, so
    // the refusal names the floor and the update rather than asking for a retry.
    expect(text).toContain("0.15.101");
    expect(text).not.toMatch(/retry only after the panel binding and subgraph mapping are stable/);
    // #2365 — the safety guarantee stays on every promoted refusal, so the caller
    // knows nothing partial or wrong-target happened.
    expect(text).toMatch(/No graph_set_widget was dispatched/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");
    expect(calls.map((c) => c.cmd)).not.toContain("graph_exit_subgraph");
  });

  it("always states no write was dispatched — property of every promoted-write refusal", async () => {
    // #2365's SAFETY-CRITICAL property, kept: every promoted-write refusal must
    // guarantee that no graph_set_widget reached the graph, whichever remedy the
    // message carries. What changed is the second branch. #2365 labelled the
    // parent-rail refusal "non-capability" and pinned it to the retry wording,
    // but it is a capability shortfall in exactly the same sense as the first —
    // a hello either advertises the fence or it does not — so pinning the retry
    // advice there regression-locked the defect panel#1859 is about. The genuine
    // transient is a third case, and it is covered below.

    // Branch 1: capability shortfall (enforces_expected_scope_graph_identity_at_write)
    const capabilityShortfall = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        scopeGraphIdentityFence: false,
      },
    );
    expect(capabilityShortfall.isError).toBe(true);
    expect(capabilityShortfall.text).toMatch(/No graph_set_widget was dispatched/);
    expect(capabilityShortfall.text).toContain("0.15.101");

    // Branch 2: a DIFFERENT capability shortfall (the final parent-rail fence).
    // Same guarantee, and the same build-skew remedy rather than a retry.
    const parentRailShortfall = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        promotedParentRailFence: false,
        subgraph: CURRENT_SAFE_PROMOTED_SUBGRAPH,
      },
    );
    expect(parentRailShortfall.isError).toBe(true);
    expect(parentRailShortfall.text).toMatch(/No graph_set_widget was dispatched/);
    expect(parentRailShortfall.text).toContain("0.15.101");
    expect(parentRailShortfall.text).not.toMatch(/binding and subgraph mapping are stable/);

    // Branch 3: a genuinely TRANSIENT refusal — a malformed envelope from a
    // current panel. Same guarantee, and this is the one a retry can clear.
    const transient = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: { ...SAFE_ANIMA_SUBGRAPH, node_count: 2 },
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
      },
    );
    expect(transient.isError).toBe(true);
    expect(transient.text).toMatch(/No graph_set_widget was dispatched/);
    expect(transient.text).toMatch(/binding and subgraph mapping are stable/);
    expect(transient.text).not.toContain("0.15.101");
  });

  it("refuses a promoted mapping for a receiver without the final parent-rail fence", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        promotedParentRailFence: false,
        subgraph: CURRENT_SAFE_PROMOTED_SUBGRAPH,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/does not advertise the atomic promoted parent-rail write fence/);
    expect(text).toContain("0.15.101");
    expect(text).not.toMatch(/retry only after the panel binding and subgraph mapping are stable/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");
  });

  it("refuses when the promotion relinks after classification", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        // The first read classified a safe inner node; the confirmation read
        // observes a relink to the known-bad regional-canvas node.
        preflightSubgraph: SAFE_ANIMA_SUBGRAPH,
        subgraph: ANIMA_SUBGRAPH,
        detailById: ANIMA_IDENTITY_BY_ID,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/mapping changed or became unverifiable|inner node type changed/);
    expect(calls.filter((c) => c.cmd === "graph_get_subgraph")).toHaveLength(2);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");
  });

  it.each([
    ["stale owner", { ...SAFE_ANIMA_SUBGRAPH, subgraph_of: { node_id: 79 } }],
    ["wrong node count", { ...SAFE_ANIMA_SUBGRAPH, node_count: 2 }],
    ["malformed viewing identity", { ...SAFE_ANIMA_SUBGRAPH, viewing: null }],
    [
      "malformed viewing workflow identity",
      { ...SAFE_ANIMA_SUBGRAPH, viewing: { scope: "subgraph", owner_node_id: 78, workflow_uuid: 42 } },
    ],
    [
      "malformed viewing graph identity",
      { ...SAFE_ANIMA_SUBGRAPH, viewing: { scope: "subgraph", owner_node_id: 78, graph_identity: "" } },
    ],
    [
      "malformed target graph identity",
      { ...SAFE_ANIMA_SUBGRAPH, subgraph_of: { node_id: 78, graph_identity: "" } },
    ],
  ])("refuses a %s envelope before writing the container", async (_name, subgraph) => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      { firstWrite: "ok", subgraph },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/malformed, stale, or incomplete ownership envelope/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("refuses a same-session subgraph-owner collision even when inner id and type collide", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        postEnterGraphQueryById: {
          "76": {
            viewing: {
              scope: "subgraph",
              owner_node_id: 79,
              workflow_uuid: "workflow-a",
              graph_identity: "graph:workflow-a-container-a",
            },
            nodes: [{ id: 76, type: "PrimitiveStringMultiline" }],
          },
        },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/current graph scope changed|inner receiver changed|unverifiable/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
    expect(calls).toEqual(expect.arrayContaining([{ cmd: "graph_enter_subgraph", node_id: 78 }]));
  });

  it("refuses a same-session workflow collision with the same owner, inner id, and type", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        postEnterGraphQueryById: {
          "76": {
            viewing: {
              scope: "subgraph",
              owner_node_id: 78,
              workflow_uuid: "workflow-b",
              graph_identity: "graph:workflow-a-container-a",
            },
            nodes: [{ id: 76, type: "PrimitiveStringMultiline" }],
          },
        },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/current graph scope changed|inner receiver changed|unverifiable/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("refuses owner A to owner B navigation after the final query at the authoritative write fence", async () => {
    const { text, isError, calls, authoritativeScopeReads, postEnterGraphQueries } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        authoritativeScopeRead: true,
        ownerNavigationAfterFinalQuery: true,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/current subgraph owner changed|unverifiable/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
    expect(authoritativeScopeReads).toBe(1);
    expect(postEnterGraphQueries).toBe(3);
  });

  it("uses the live scope witness at the normal final dispatch fence", async () => {
    const { text, isError, calls, authoritativeScopeReads, writesApplied } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        authoritativeScopeRead: true,
        receiverNavigationAfterMcpFence: true,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/promoted receiver changed|Nothing was applied/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
    expect(writesApplied).toBe(0);
    expect(authoritativeScopeReads).toBe(1);
  });

  it("refuses a normal write when a same-id receiver graph changes after the MCP fence", async () => {
    const { text, isError, calls, writesApplied } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        authoritativeScopeRead: true,
        receiverNavigationAfterMcpFence: true,
        receiverGraphIdentityCollisionAfterMcpFence: true,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/promoted receiver changed|Nothing was applied/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
    expect(calls.find((c) => c.cmd === "graph_set_widget")).toMatchObject({
      expected_scope: {
        scope: "subgraph",
        owner_node_id: "78",
        workflow_uuid: "workflow-a",
        graph_identity: "graph:workflow-a-container-a",
      },
    });
    expect(writesApplied).toBe(0);
  });

  it("keeps a valid same-owner write when workflow_uuid is unavailable", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        authoritativeScopeRead: true,
        omitWorkflowUuid: true,
      },
    );

    expect(isError).toBe(false);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
    expect(calls.find((c) => c.cmd === "graph_set_widget")).toMatchObject({
      node_id: 76,
      widget: "quality_prompt",
    });
  });

  it("refuses when the bound panel reconnects before the inner dispatch", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        reconnectBeforeWrite: true,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/session or connection changed|No graph_set_widget was dispatched/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
    expect(calls).toEqual(expect.arrayContaining([{ cmd: "graph_exit_subgraph" }]));
  });

  it("refuses when the same-workflow panel tab is rebound before the inner dispatch", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        tabRebindBeforeWrite: true,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/session or connection changed|No graph_set_widget was dispatched/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
    expect(calls).toEqual(expect.arrayContaining([{ cmd: "graph_exit_subgraph" }]));
  });

  it("re-runs the guards for a case-only remapped container widget", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "Quality_Prompt", value: "masterpiece" },
      {
        firstWrite: "contradict",
        firstWriteError: ANIMA_CONTRADICTORY,
        remappedWriteError: ANIMA_CONTRADICTORY,
        subgraph: ANIMA_SUBGRAPH,
        detailById: ANIMA_IDENTITY_BY_ID,
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
      },
    );

    expect(isError).toBe(true);
    expect(text).toContain("animaPrompts");
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ node_id: 78, widget: "Quality_Prompt" });
  });

  it("routes a successful case-only remapped retry through the inner plan", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "Quality_Prompt", value: "masterpiece" },
      {
        firstWrite: "contradict",
        firstWriteError: ANIMA_CONTRADICTORY,
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
      },
    );

    expect(isError).toBe(false);
    expect(text).toMatch(/validated promoted inner widget/);
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ node_id: 78, widget: "Quality_Prompt" });
    expect(writes[1]).toMatchObject({ node_id: 76, widget: "quality_prompt" });
    expect(calls.filter((c) => c.cmd === "graph_set_widget" && c.node_id === 78)).toHaveLength(1);
  });

  it("keeps a current-child ordinary write after re-entering its panel route", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 188, widget: "quality_prompt", value: "masterpiece" },
      {
        scopeLost: true,
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        subgraph: new Error("outer wrapper is unavailable after navigation"),
        postEnterGraphQueryById: {
          "188": new Error("the current child graph could not be classified after entry"),
        },
      },
    );

    expect(isError).toBe(false);
    expect(text).toMatch(/route was re-entered and the write was retried once/);
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes).toHaveLength(2);
    expect(calls.map((c) => c.cmd)).toContain("graph_enter_subgraph");
  });

  it("refuses legacy recovery navigation after the live read before inner dispatch", async () => {
    const { text, isError, calls, authoritativeScopeReads, writesApplied } = await setWidget(
      { node_id: 78, widget: "Quality_Prompt", value: "masterpiece" },
      {
        firstWrite: "contradict",
        firstWriteError: ANIMA_CONTRADICTORY,
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        authoritativeScopeRead: true,
        receiverNavigationAfterMcpFence: true,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/promoted receiver changed|Nothing was applied/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(2);
    expect(writesApplied).toBe(1);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")[1]).toMatchObject({
      expected_scope: {
        scope: "subgraph",
        owner_node_id: "78",
        workflow_uuid: "workflow-a",
        graph_identity: "graph:workflow-a-container-a",
      },
    });
    expect(authoritativeScopeReads).toBe(1);
  });

  it("refuses a legacy retry when a same-id receiver graph changes after the MCP fence", async () => {
    const { text, isError, calls, writesApplied } = await setWidget(
      { node_id: 78, widget: "Quality_Prompt", value: "masterpiece" },
      {
        firstWrite: "contradict",
        firstWriteError: ANIMA_CONTRADICTORY,
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        authoritativeScopeRead: true,
        receiverNavigationAfterMcpFence: true,
        receiverGraphIdentityCollisionAfterMcpFence: true,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/promoted receiver changed|Nothing was applied/);
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({
      node_id: 76,
      expected_scope: {
        scope: "subgraph",
        owner_node_id: "78",
        workflow_uuid: "workflow-a",
        graph_identity: "graph:workflow-a-container-a",
      },
    });
    // The outer contradictory attempt is the only receiver-side application;
    // the remapped inner write is refused by graph identity before apply.
    expect(writesApplied).toBe(1);
  });

  it("routes a successful object-info retry through the promoted inner guards", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWriteError: "no usable /object_info was available for this widget write",
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        refreshNodes: { refreshed: true },
      },
    );

    expect(isError).toBe(false);
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ node_id: 78, widget: "quality_prompt" });
    expect(writes[1]).toMatchObject({ node_id: 76, widget: "quality_prompt" });
  });

  it("refuses a known-bad Anima write on an object-info retry", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWriteError: "no usable /object_info was available for this widget write",
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        subgraph: ANIMA_SUBGRAPH,
        detailById: ANIMA_IDENTITY_BY_ID,
        refreshNodes: { refreshed: true },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/animaPrompts/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
  });

  it("refuses a known-bad dynamic child on a scope retry", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 188, widget: "model.prompt", value: "a long prompt" },
      {
        scopeLost: true,
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        subgraph: new Error("outer wrapper is unavailable after navigation"),
        detailById: {
          "188": {
            nodes: [
              {
                id: 188,
                type: "OrdinaryNode",
                widgets: { "model.prompt": "" },
                inputs: [
                  { name: "model.prompt", type: "STRING" },
                ],
              },
            ],
          },
        },
        postEnterGraphQueryById: {
          "188": {
            nodes: [
              {
                id: 188,
                type: "MinimaxHailuo03TextToVideoNode",
                widgets: { model: "text-to-video", "model.prompt": "" },
                inputs: [
                  { name: "model", type: "COMFY_DYNAMICCOMBO_V3" },
                  { name: "model.prompt", type: "STRING" },
                ],
              },
            ],
          },
        },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/dynamic-combo|could not determine whether the addressed node is a promoted container/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
  });

  it("refuses a known-bad DaSiWa write on a case-remap retry", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "Stack_Data", value: "NEW" },
      {
        firstWriteError: STACK_DATA_CONTRADICTORY,
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        subgraph: {
          subgraph_of: { node_id: 78, title: "Container" },
          node_count: 1,
          nodes: [{ id: 76, type: "DaSiWa_LTX2LoraLoader", widgets: { stack_data: "old" } }],
        },
        stackDataIdentity: { nodes: [{ id: 78, type: "OtherLoraLoader" }] },
        stackDataInnerIdentity: { nodes: [{ id: 76, type: "DaSiWa_LTX2LoraLoader" }] },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/DaSiWa_LTX2LoraLoader/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
  });

  it("refuses a promoted retry when the mapping relinks after enter", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWriteError: ANIMA_CONTRADICTORY,
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        subgraph: SAFE_ANIMA_SUBGRAPH,
        postEnterGraphQueryById: { "76": ANIMA_IDENTITY_BY_ID["76"] },
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/mapping changed or became unverifiable|type changed after entering|captured promoted inner receiver/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
  });

  it("refuses the legacy recovery when its post-enter mapping relinks", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWriteError: ANIMA_CONTRADICTORY,
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        recoveryPreflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        subgraph: SAFE_ANIMA_SUBGRAPH,
        postEnterGraphQueryById: { "76": ANIMA_IDENTITY_BY_ID["76"] },
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/mapping changed or became unverifiable|type changed after entering|captured promoted inner receiver/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
  });

});

describe("promotedInnerWidgetIsLinkDriven (#2500)", () => {
  it("detects a PrimitiveInt whose value widget is a live input", () => {
    expect(
      promotedInnerWidgetIsLinkDriven(
        {
          id: 198,
          type: "PrimitiveInt",
          widgets: { value: 5 },
          inputs: [{ name: "value", type: "INT" }],
        },
        "value",
      ),
    ).toBe(true);
  });

  it("detects the same shape from the terminal witness when the inner row omits inputs", () => {
    expect(
      promotedInnerWidgetIsLinkDriven(
        { id: 198, type: "PrimitiveInt", widgets: { value: 5 } },
        "value",
        {
          nodeId: 198,
          nodeType: "PrimitiveInt",
          widget: "value",
          inputs: [{ name: "value", type: "INT" }],
          chainDepth: 0,
        },
      ),
    ).toBe(true);
  });

  it("does not treat an unconverted inner widget as link-driven", () => {
    expect(
      promotedInnerWidgetIsLinkDriven(
        { id: 76, type: "PrimitiveStringMultiline", widgets: { quality_prompt: "old" } },
        "quality_prompt",
        {
          nodeId: 76,
          nodeType: "PrimitiveStringMultiline",
          widget: "quality_prompt",
          inputs: [],
          chainDepth: 0,
        },
      ),
    ).toBe(false);
  });

  it("does not treat a converted ordinary-node child as this Primitive shape", () => {
    expect(
      promotedInnerWidgetIsLinkDriven(
        {
          id: 76,
          type: "MinimaxHailuo03TextToVideoNode",
          widgets: { "model.prompt": "" },
          inputs: [
            { name: "model", type: "COMFY_DYNAMICCOMBO_V3" },
            { name: "model.prompt", type: "STRING" },
          ],
        },
        "model.prompt",
      ),
    ).toBe(false);
  });

  it("detects a PrimitiveString whose value widget is a live STRING input (#2533)", () => {
    expect(
      promotedInnerWidgetIsLinkDriven(
        {
          id: 131,
          type: "PrimitiveString",
          widgets: { value: "a cat" },
          inputs: [{ name: "value", type: "STRING" }],
        },
        "value",
      ),
    ).toBe(true);
  });

  it("detects a UNETLoader unet_name live input only when the parent rail is authoritative (#2533)", () => {
    const inner = {
      id: 6,
      type: "UNETLoader",
      widgets: { unet_name: "music_fp16.safetensors", weight_dtype: "default" },
      inputs: [
        { name: "unet_name", type: "COMBO" },
        { name: "weight_dtype", type: "COMBO" },
      ],
    };
    const terminal = {
      nodeId: 6,
      nodeType: "UNETLoader",
      widget: "unet_name",
      inputs: [
        { name: "unet_name", type: "COMBO" },
        { name: "weight_dtype", type: "COMBO" },
      ],
      chainDepth: 0,
    };
    expect(promotedInnerWidgetIsLinkDriven(inner, "unet_name", terminal)).toBe(false);
    expect(
      promotedInnerWidgetIsLinkDriven(inner, "unet_name", terminal, {
        authoritative: true as const,
        widget: "unet_name",
      }),
    ).toBe(true);
  });

  it("detects a CLIPLoader clip_name live input only when the parent rail is authoritative (#2533)", () => {
    const inner = {
      id: 8,
      type: "CLIPLoader",
      widgets: { clip_name: "clip_fp16.safetensors" },
      inputs: [{ name: "clip_name", type: "COMBO" }],
    };
    expect(promotedInnerWidgetIsLinkDriven(inner, "clip_name")).toBe(false);
    expect(
      promotedInnerWidgetIsLinkDriven(inner, "clip_name", undefined, {
        authoritative: true as const,
        widget: "clip_name",
      }),
    ).toBe(true);
  });
});

describe("parseContradictoryPromotedWidgetRefusal", () => {
  it("the reporter's error is contradictory — width is listed as promoted", () => {
    const parsed = parseContradictoryPromotedWidgetRefusal(CONTRADICTORY, "width");
    expect(parsed).toEqual({
      nodeId: "78",
      widget: "width",
      listed: [
        "width",
        "height",
        "seed",
        "control_after_generate",
        "steps",
        "cfg",
        "sampler_name",
        "scheduler",
        "denoise",
        "batch_size",
      ],
    });
    expect(isContradictoryPromotedWidgetRefusal(CONTRADICTORY, "width")).toBe(true);
  });

  it("a genuine miss (name NOT in the listed set) is not contradictory", () => {
    const text =
      `Cannot set widget on subgraph node 78: "foo" is not a promoted widget on this subgraph ` +
      `(promoted: width, height, seed).`;
    expect(parseContradictoryPromotedWidgetRefusal(text, "foo")).toBeNull();
    expect(isContradictoryPromotedWidgetRefusal(text, "foo")).toBe(false);
  });

  it("promoted: none is never contradictory", () => {
    const text =
      `Cannot set widget on subgraph node 78: "width" is not a promoted widget on this subgraph ` +
      `(promoted: none).`;
    expect(parseContradictoryPromotedWidgetRefusal(text, "width")).toBeNull();
  });

  it("an unrelated failure is never contradictory", () => {
    expect(
      parseContradictoryPromotedWidgetRefusal("No node with id 78 in the current graph", "width"),
    ).toBeNull();
  });

  it("a unique case-insensitive listed name still matches", () => {
    expect(matchListedName("Width", ["width", "height"])).toBe("width");
    const parsed = parseContradictoryPromotedWidgetRefusal(CONTRADICTORY, "Width");
    expect(parsed?.widget).toBe("width");
  });

  it("parses the promoted name/label ambiguity without selecting a target", () => {
    expect(parseAmbiguousPromotedWidgetRefusal(AMBIGUOUS, "text", 190)).toEqual({
      nodeId: "190",
      widget: "text",
      matches: 2,
    });
    expect(parseAmbiguousPromotedWidgetRefusal(AMBIGUOUS, "steps")).toBeNull();
  });

  it("parses only the panel-provided enter route from a lost-scope refusal", () => {
    expect(parseSubgraphScopeRefusal(SCOPE_REFUSAL, 188)).toEqual({
      nodeId: "188",
      enterPath: ["190"],
    });
    expect(parseSubgraphScopeRefusal(SCOPE_REFUSAL, 189)).toBeNull();
    expect(parseSubgraphScopeRefusal("No node with id 188 in the current graph", 188)).toBeNull();
  });

  it("parses the panel's link-driven inner-write warning (#2488)", () => {
    const text =
      `The write SUCCEEDED and was verified, but it will NOT change the render: ` +
      `widget "length" on inner node is link-driven. Set the widget on the ENCLOSING subgraph node instead.`;
    expect(parseLinkDrivenPromotedWriteWarning(text)).toEqual({ widget: "length" });
    expect(parseLinkDrivenPromotedWriteWarning("inner write rejected")).toBeNull();
  });
});

describe("resolveInnerPromotedTarget", () => {
  it("maps width to the unique EmptyLatentImage inner node", () => {
    expect(resolveInnerPromotedTarget(SUBGRAPH, "width", 78)).toEqual({
      innerNodeId: 76,
      widget: "width",
    });
  });

  it("maps seed to the unique KSampler inner node", () => {
    expect(resolveInnerPromotedTarget(SUBGRAPH, "seed", 78)).toEqual({
      innerNodeId: 75,
      widget: "seed",
    });
  });

  it("refuses to guess when two inners share the widget name", () => {
    const ambiguous = {
      ...SUBGRAPH,
      nodes: [
        { id: 76, widgets: { width: 1920 } },
        { id: 99, widgets: { width: 512 } },
      ],
    };
    expect(resolveInnerPromotedTarget(ambiguous, "width", 78)).toBeNull();
  });

  it("refuses to guess from a truncated inner list", () => {
    expect(resolveInnerPromotedTarget({ ...SUBGRAPH, truncated: true }, "width", 78)).toBeNull();
  });

  it("returns null when no inner node owns the widget", () => {
    expect(resolveInnerPromotedTarget(SUBGRAPH, "denoise", 78)).toBeNull();
  });

  it("retains a validated terminal concrete witness for a nested promotion", () => {
    const nested = {
      ...SUBGRAPH,
      nodes: [{ id: 188, type: "SubgraphB", is_subgraph: true, widgets: { width: 1920 } }, SUBGRAPH.nodes[1]],
      promoted_terminals: [
        {
          widget: "width",
          parent_rail: { authoritative: true, widget: "width" },
          immediate_node_id: 188,
          immediate_widget: "width",
          terminal_node_id: 2768,
          terminal_node_type: "KSampler",
          terminal_widget: "steps",
          terminal_inputs: [{ name: "steps", type: "INT" }],
          chain_depth: 1,
        },
      ],
    };
    expect(resolveInnerPromotedTarget(nested, "width", 78)).toEqual({
      innerNodeId: 188,
      widget: "width",
      parentRail: { authoritative: true, widget: "width" },
      terminal: {
        nodeId: 2768,
        nodeType: "KSampler",
        widget: "steps",
        inputs: [{ name: "steps", type: "INT" }],
        chainDepth: 1,
      },
    });
  });

  it("maps either the displayed host alias or the inner widget name to the same promotion (#2488)", () => {
    const viaLabel = resolveInnerPromotedTarget(FRAME_COUNTS_PROMOTED_SUBGRAPH, "frame_counts", 78);
    const viaInner = resolveInnerPromotedTarget(FRAME_COUNTS_PROMOTED_SUBGRAPH, "length", 78);
    expect(viaLabel).toEqual({
      innerNodeId: 12,
      widget: "length",
      parentRail: { authoritative: true, widget: "frame_counts" },
      terminal: {
        nodeId: 12,
        nodeType: "PrimitiveInt",
        widget: "length",
        inputs: [{ name: "length", type: "INT" }],
        chainDepth: 0,
      },
    });
    expect(viaInner).toEqual(viaLabel);
  });

  it("resolves renamed outer and immediate aliases from the terminal witness", () => {
    const renamed = {
      ...SUBGRAPH,
      nodes: [
        { id: 188, type: "SubgraphB", is_subgraph: true, widgets: { prompt_b: "old" } },
        SUBGRAPH.nodes[1],
      ],
      promoted_terminals: [
        {
          widget: "prompt_alias",
          parent_rail: { authoritative: true, widget: "prompt_b" },
          immediate_node_id: 188,
          immediate_widget: "prompt_b",
          terminal_node_id: 2768,
          terminal_node_type: "AnimaRegionalCanvasInline",
          terminal_widget: "quality_prompt",
          terminal_inputs: [{ name: "quality_prompt", type: "STRING" }],
          chain_depth: 1,
        },
      ],
    };
    expect(resolveInnerPromotedTarget(renamed, "prompt_alias", 78)).toEqual({
      innerNodeId: 188,
      widget: "prompt_b",
      parentRail: { authoritative: true, widget: "prompt_b" },
      terminal: {
        nodeId: 2768,
        nodeType: "AnimaRegionalCanvasInline",
        widget: "quality_prompt",
        inputs: [{ name: "quality_prompt", type: "STRING" }],
        chainDepth: 1,
      },
    });
  });

  it.each([
    ["malformed terminal shape", { terminal_node_id: 2768, terminal_node_type: "KSampler", terminal_widget: "steps", chain_depth: 1 }],
    ["depth-limited terminal", { terminal_node_id: 2768, terminal_node_type: "KSampler", terminal_widget: "steps", terminal_inputs: [], chain_depth: 17 }],
  ])("rejects a %s nested terminal envelope", (_name, terminal) => {
    const nested = {
      ...SUBGRAPH,
      nodes: [{ id: 188, type: "SubgraphB", is_subgraph: true, widgets: { width: 1920 } }, SUBGRAPH.nodes[1]],
      promoted_terminals: [
        {
          widget: "width",
          immediate_node_id: 188,
          immediate_widget: "width",
          ...terminal,
        },
      ],
    };
    expect(validatePromotedSubgraphEnvelope(nested, 78)).toBeNull();
    expect(resolveInnerPromotedTarget(nested, "width", 78)).toBeNull();
  });

  it("accepts an explicit unresolved terminal marker but never resolves it", () => {
    const nested = {
      ...SUBGRAPH,
      nodes: [{ id: 188, type: "SubgraphB", is_subgraph: true, widgets: { width: 1920 } }, SUBGRAPH.nodes[1]],
      promoted_terminals: [
        {
          widget: "width",
          immediate_node_id: 188,
          immediate_widget: "width",
          error: "promotion chain is cyclic",
        },
      ],
    };
    expect(validatePromotedSubgraphEnvelope(nested, 78)).not.toBeNull();
    expect(resolveInnerPromotedTarget(nested, "width", 78)).toBeNull();
  });

  it("rejects an envelope owned by a different outer node", () => {
    expect(
      validatePromotedSubgraphEnvelope(
        { ...SUBGRAPH, subgraph_of: { node_id: 79, title: "stale" } },
        78,
      ),
    ).toBeNull();
    expect(
      resolveInnerPromotedTarget(
        { ...SUBGRAPH, subgraph_of: { node_id: 79, title: "stale" } },
        "width",
        78,
      ),
    ).toBeNull();
  });

  it.each([
    ["missing subgraph_of", { ...SUBGRAPH, subgraph_of: undefined }],
    ["wrong node_count", { ...SUBGRAPH, node_count: 1 }],
    ["non-integer node_count", { ...SUBGRAPH, node_count: "2" }],
    ["truncated envelope", { ...SUBGRAPH, truncated: true }],
    ["malformed inner node id", { ...SUBGRAPH, nodes: [{ ...SUBGRAPH.nodes[0], id: "not-a-node" }, SUBGRAPH.nodes[1]] }],
  ])("rejects a %s instead of trusting its inner mapping", (_name, malformed) => {
    expect(validatePromotedSubgraphEnvelope(malformed, 78)).toBeNull();
    expect(resolveInnerPromotedTarget(malformed, "width", 78)).toBeNull();
  });
});

describe("panel_set_widget promoted-subgraph recovery (#1655)", () => {
  it("refuses a renamed nested terminal before the first container write (#2314 P1)", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "prompt_alias", value: "unsafe" },
      {
        promotedTerminalWitnesses: true,
        subgraph: {
          ...SUBGRAPH,
          nodes: [
            { id: 188, type: "SubgraphB", is_subgraph: true, widgets: { prompt_b: "old" } },
            SUBGRAPH.nodes[1],
          ],
          promoted_terminals: [
            {
              widget: "prompt_alias",
              parent_rail: { authoritative: true, widget: "prompt_b" },
              immediate_node_id: 188,
              immediate_widget: "prompt_b",
              terminal_node_id: 2768,
              terminal_node_type: "AnimaRegionalCanvasInline",
              terminal_widget: "quality_prompt",
              terminal_inputs: [{ name: "quality_prompt", type: "STRING" }],
              chain_depth: 1,
            },
          ],
        },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/AnimaRegionalCanvasInline/);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("does not carry the outer node-type fence into a promoted inner retry (#2107)", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "stack_data", value: "NEW" },
      {
        stackDataIdentity: { nodes: [{ id: 78, type: "OtherLoraLoader" }] },
        subgraph: {
          subgraph_of: { node_id: 78, title: "OtherLoraLoader" },
          node_count: 1,
          nodes: [{ id: 76, type: "OtherLoraLoader", widgets: { stack_data: "old" } }],
        },
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
      },
    );

    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_query",
      "graph_query",
      "graph_get_subgraph",
      "graph_query",
      "graph_set_widget",
      "graph_query",
      "graph_get_subgraph",
      "graph_get_subgraph",
      "graph_enter_subgraph",
      "graph_query",
      "graph_query",
      "graph_query",
      "graph_set_widget",
      "graph_exit_subgraph",
    ]);
    expect(calls[4]).toMatchObject({ expected_node_type: "OtherLoraLoader" });
    expect(calls[12]).toMatchObject({ expected_node_type: "OtherLoraLoader" });
    expect(text).toMatch(/validated promoted inner widget/);
  });

  it("refuses a promoted inner retry when the post-enter identity is stale", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "stack_data", value: "NEW" },
      {
        stackDataIdentity: { nodes: [{ id: 78, type: "OtherLoraLoader" }] },
        stackDataInnerIdentity: { nodes: [{ id: 99, type: "OtherLoraLoader" }] },
        subgraph: {
          subgraph_of: { node_id: 78, title: "OtherLoraLoader" },
          node_count: 1,
          nodes: [{ id: 76, type: "OtherLoraLoader", widgets: { stack_data: "old" } }],
        },
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
      },
    );

    expect(isError).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_query",
      "graph_query",
      "graph_get_subgraph",
      "graph_query",
      "graph_set_widget",
      "graph_query",
      "graph_get_subgraph",
      "graph_get_subgraph",
      "graph_enter_subgraph",
      "graph_query",
      "graph_exit_subgraph",
    ]);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
    expect(text).toMatch(/different node_id|captured promoted inner receiver|No inner graph_set_widget/);
  });

  it("refuses a promoted inner DaSiWa stack write without a second mutation", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "stack_data", value: "NEW" },
      {
        stackDataIdentity: { nodes: [{ id: 78, type: "OtherLoraLoader" }] },
        stackDataInnerIdentity: { nodes: [{ id: 76, type: "DaSiWa_LTX2LoraLoader" }] },
        subgraph: {
          subgraph_of: { node_id: 78, title: "OtherLoraLoader" },
          node_count: 1,
          nodes: [{ id: 76, type: "DaSiWa_LTX2LoraLoader", widgets: { stack_data: "old" } }],
        },
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
      },
    );

    expect(isError).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_query",
      "graph_query",
      "graph_get_subgraph",
      "graph_query",
      "graph_set_widget",
      "graph_query",
      "graph_get_subgraph",
      "graph_get_subgraph",
      "graph_enter_subgraph",
      "graph_query",
      "graph_query",
      "graph_exit_subgraph",
    ]);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
    expect(text).toMatch(/cannot set "stack_data" on DaSiWa_LTX2LoraLoader/);
    expect(text).toMatch(/No inner graph_set_widget was dispatched/);
  });

  it("reports ambiguous promoted name/label candidates without a second write (#2015)", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 190, widget: "text", value: "hello" },
      {
        ambiguous: true,
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        promotedDetail: {
          nodes: [
            {
              id: 190,
              inputs: [
                { slot: 1, name: "text" },
                { slot: 2, name: "text_1", label: "text" },
              ],
            },
          ],
        },
      },
    );

    expect(isError).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_query", "graph_get_subgraph", "graph_set_widget", "graph_query"]);
    expect(text).toMatch(/slot:1, name:"text", label:null/);
    expect(text).toMatch(/slot:2, name:"text_1", label:"text"/);
    expect(text).toMatch(/no second write was attempted/i);
  });

  it("re-enters the panel-provided scope and retries the inner write once (#2015)", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 188, widget: "text", value: "hello" },
      { scopeLost: true, preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH },
    );

    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
      "graph_enter_subgraph",
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
    ]);
    expect(calls[3]).toMatchObject({ node_id: "190" });
    expect(calls[6]).toMatchObject({ node_id: 188, widget: "text", value: "hello" });
    expect(text).toMatch(/route was re-entered and the write was retried once/i);
  });

  it("uses the captured inner target after navigation when the outer id is unavailable", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "width", value: 1024 },
      { preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH },
    );

    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
      "graph_query",
      "graph_get_subgraph",
      "graph_get_subgraph",
      "graph_enter_subgraph",
      "graph_query",
      "graph_query",
      "graph_set_widget",
      "graph_exit_subgraph",
    ]);
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes[0]).toMatchObject({ node_id: 78, widget: "width", value: 1024 });
    expect(writes[1]).toMatchObject({ node_id: 76, widget: "width", value: 1024 });
    // Production seam: the outer wrapper is queried only before entry. Both
    // post-entry fences query the captured inner receiver in the current graph.
    expect(calls.filter((c) => c.cmd === "graph_get_subgraph")).toHaveLength(3);
    expect(
      calls.filter(
        (c) =>
          c.cmd === "graph_query" &&
          Array.isArray(c.ids) &&
          String((c.ids as unknown[])[0]) === "76",
      ),
    ).toHaveLength(2);
    expect(text).toMatch(/validated promoted inner widget: node 76 "width"/);
    expect(text).not.toMatch(/is not a promoted widget/);
  });

  it("a healthy write is untouched — one call, no enter", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 3, widget: "steps", value: 20 },
      { firstWrite: "ok", preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH },
    );
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_query", "graph_get_subgraph", "graph_set_widget"]);
  });

  it("a genuine miss is never retried", async () => {
    const { b, calls } = bridge({ firstWrite: "ok" });
    const failing = {
      ...(b as object),
      send: async (cmd: Record<string, unknown>) => {
        calls.push({ ...cmd });
        throw new Error(
          `Cannot set widget on subgraph node 78: "foo" is not a promoted widget on this subgraph ` +
            `(promoted: width, height, seed).`,
        );
      },
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(failing, TAB, new WorkflowTargetStore());
    const def = buildPanelToolDefs().find((d) => d.name === "panel_set_widget");
    if (!def) throw new Error("panel_set_widget is not registered");
    const res = await def.handler({ node_id: 78, widget: "foo", value: 1 } as never, ctx);

    expect(res.isError).toBe(true);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
    expect(calls.map((c) => c.cmd)).toContain("graph_get_subgraph");
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");
  });

  it("an UNRELATED failure is never retried", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 78, widget: "width", value: 1024 },
      { firstWrite: "fail", preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH },
    );
    expect(isError).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["graph_query", "graph_get_subgraph", "graph_set_widget"]);
  });

  it("an ambiguous inner mapping is not guessed", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "width", value: 1024 },
      {
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        subgraph: {
          subgraph_of: { node_id: 78, title: "Container" },
          node_count: 2,
          nodes: [
            { id: 76, widgets: { width: 1920 } },
            { id: 99, widgets: { width: 512 } },
          ],
        },
      },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/is not a promoted widget/);
    expect(text).toMatch(/ambiguously to 2 inner nodes|did not uniquely identify/);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
      "graph_query",
      "graph_get_subgraph",
    ]);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");
  });

  it("a truncated subgraph read is not treated as unique", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "width", value: 1024 },
      { subgraph: { ...SUBGRAPH, truncated: true } },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/malformed, stale, or incomplete ownership envelope/);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");
  });

  it("a failed subgraph read keeps the original refusal", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "width", value: 1024 },
      {
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        subgraph: new Error("Node 78 is not a subgraph"),
      },
    );
    expect(isError).toBe(true);
    expect(text).toMatch(/is not a promoted widget/);
    expect(text).toMatch(/graph_get_subgraph FAILED/);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
      "graph_query",
      "graph_get_subgraph",
      "graph_get_subgraph",
    ]);
  });

  it("always exits after a successful inner write, and discloses an exit failure", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "width", value: 1024 },
      { exitFails: true, preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH },
    );
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toContain("graph_exit_subgraph");
    expect(text).toMatch(/validated promoted inner widget/);
    expect(text).toMatch(/panel_exit_subgraph then FAILED/);
    expect(text).toMatch(/call panel_exit_subgraph/);
  });

  it("exits even when the inner write fails, and keeps the original refusal", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "width", value: 1024 },
      { innerWrite: "fail", preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH },
    );
    expect(isError).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
      "graph_query",
      "graph_get_subgraph",
      "graph_get_subgraph",
      "graph_enter_subgraph",
      "graph_query",
      "graph_query",
      "graph_set_widget",
      "graph_exit_subgraph",
    ]);
    expect(text).toMatch(/is not a promoted widget/);
    expect(text).toMatch(/Tried the promoted inner mapping node 76 "width"/);
    expect(text).toMatch(/inner write rejected/);
  });

  it("retries the listed spelling on the wrapper when only the case differed", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "Width", value: 1024 },
      { remappedWrite: "ok", preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH },
    );
    expect(isError).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual([
      "graph_query",
      "graph_get_subgraph",
      "graph_set_widget",
      "graph_query",
      "graph_get_subgraph",
      "graph_get_subgraph",
      "graph_enter_subgraph",
      "graph_query",
      "graph_query",
      "graph_set_widget",
      "graph_exit_subgraph",
    ]);
    const writes = calls.filter((c) => c.cmd === "graph_set_widget");
    expect(writes[0]).toMatchObject({ widget: "Width" });
    expect(writes[1]).toMatchObject({ node_id: 76, widget: "width", value: 1024 });
    expect(text).not.toMatch(/is not a promoted widget/);
  });
});

/**
 * panel#1859 — mcp 0.52.129 shipped the #2314 promoted-write fence twenty
 * minutes BEFORE panel 0.15.101 shipped the `graph_identity` the fence reads.
 * Anyone on an older panel therefore hit a permanent refusal whose own advice
 * ("retry only after the panel binding and subgraph mapping are stable") can
 * never reach the condition: the reporter retried five times, re-issued
 * panel_set_workflow_target, and hard-refreshed the tab, and the bundle stayed
 * at 0.15.85 through all of it.
 *
 * The refusal is CORRECT — a pre-0.15.101 panel cannot enforce the fence, so
 * loosening it would reopen #2314. What these tests pin is that the message
 * names the build skew, the version floor, and a remedy that exists.
 */
describe("panel_set_widget promoted write against a pre-#2314 panel build (panel#1859)", () => {
  const LEGACY = { version: "0.15.85" } as const;

  it("names the build skew, the floor, and the update instead of prescribing a retry", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        legacyPanelBuild: LEGACY,
      },
    );

    expect(isError).toBe(true);
    // Nothing was written, and the subgraph was never entered.
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");

    // The cause is the panel build, stated as such.
    expect(text).toMatch(/panel build/i);
    // The advertised version and the floor that fixes it are both named.
    expect(text).toContain("0.15.85");
    expect(text).toContain("0.15.101");
    // The remedy that actually clears it.
    expect(text).toMatch(/hard-refresh/i);
    // …and the three things the reporter already tried are ruled OUT, rather
    // than being what the message asks for.
    expect(text).toMatch(/panel_enter_subgraph/);
    expect(text).not.toMatch(/retry only after the panel binding and subgraph mapping are stable/);
  });

  it("still names the floor when the panel never advertised its version", async () => {
    const { text, isError } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        legacyPanelBuild: {},
      },
    );

    expect(isError).toBe(true);
    expect(text).toContain("0.15.101");
    expect(text).not.toMatch(/retry only after the panel binding and subgraph mapping are stable/);
  });

  it("an UNRESOLVABLE receiver is not blamed on the panel build (codex gate)", async () => {
    // The gate's P1 on the first round of this change. Every fence capability
    // answers `false` when UiBridge's resolveTarget throws, so a tab that drops
    // between the mapping read and the fence check looks identical to a
    // pre-0.15.101 bundle. Calling that a BUILD skew — in a message that goes
    // out of its way to say retrying cannot help — sends someone whose tab just
    // needs to reconnect off to update their panel instead. Fail-closed on the
    // WRITE, honest about which fact we actually have.
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        legacyPanelBuild: { version: "0.15.85" },
        receiverUnresolvable: true,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/could not be resolved while its promoted-write fence capabilities were read/);
    expect(text).toMatch(/not decidable from here/);
    // No build claim, no version, no update instruction.
    expect(text).not.toMatch(/BUILD skew/);
    expect(text).not.toContain("0.15.101");
    expect(text).not.toContain("0.15.85");
    expect(text).not.toMatch(/HARD-REFRESH/i);
    // The write is still refused — this only changes the wording.
    expect(text).toMatch(/No graph_set_widget was dispatched/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
    expect(calls.map((c) => c.cmd)).not.toContain("graph_enter_subgraph");
  });

  it("a receiver that DID advertise the fence but omits the identity keeps the retry advice", async () => {
    // The narrow case the build-skew message must not swallow: the hello claims
    // the fence, so an absent identity is an inconsistent reply rather than an
    // old bundle, and retrying is a legitimate thing to ask for.
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: SAFE_ANIMA_SUBGRAPH,
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
        // Everything a legacy build implies EXCEPT the capability: the hello
        // advertises the fence while the payload still omits graph_identity.
        legacyPanelBuild: { version: "0.15.85" },
        scopeGraphIdentityFence: true,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/did not publish a verifiable workflow and viewing-scope identity/);
    expect(text).toMatch(/retry only after the panel binding and subgraph mapping are stable/);
    expect(text).not.toContain("0.15.101");
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("leaves the transient refusals on a CURRENT panel saying retry", async () => {
    // Same handler, same fixture, current build: a malformed envelope is a
    // genuine transient and must keep the retry advice it has always had.
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        subgraph: { ...SAFE_ANIMA_SUBGRAPH, node_count: 2 },
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/retry only after the panel binding and subgraph mapping are stable/);
    expect(text).not.toContain("0.15.101");
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
  });
});

/**
 * #2393 — the promoted-terminal witness veto was WHOLE-ARRAY.
 *
 * `promotedTerminalEvidenceError` refused a write when ANY entry in
 * `promoted_terminals` repeated a widget name or carried an error, even when the
 * alias being written had its own complete, error-free entry. The official
 * Qwen-Image-Edit-2511 INT8 template hits that on every promoted write to
 * subgraph node 170, and it is structural rather than transient:
 *
 *   - node 170's proxyWidgets carries ["151","prompt"] AND ["149","prompt"] —
 *     two inner nodes whose inner widget is named `prompt` — while exactly one
 *     host input (`prompt`/`positive_prompt`) claims that alias. The panel's
 *     `promotedHostAliasRecords` binds the first relation onto the existing
 *     unbound record and APPENDS a record for the second, and
 *     `promotedTerminalWitnesses` publishes one entry per record with no
 *     de-duplication. The array therefore always repeats `prompt`.
 *   - node 170 also names `lora_name`, `seed` and `control_after_generate` in
 *     proxyWidgets with no matching host input, which adds error entries.
 *
 * Neither depends on timing, so re-reading `graph_get_subgraph` returns the
 * identical array — the write has to be decided on the requested alias's own
 * evidence or it can never succeed.
 *
 * The fixtures below use `quality_prompt` as the requested alias because that is
 * what this file's shared subgraph harness resolves; the SHAPE (one clean entry
 * for the requested alias, damage on a different alias) is node 170's.
 */
describe("#2393 promoted-terminal witness is judged on the requested alias", () => {
  const ownEntry = CURRENT_SAFE_PROMOTED_SUBGRAPH.promoted_terminals[0];
  const withTerminals = (promoted_terminals: unknown[]) => ({
    ...CURRENT_SAFE_PROMOTED_SUBGRAPH,
    promoted_terminals,
  });

  it("writes when a DIFFERENT alias is duplicated (node 170's two `prompt` relations)", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: withTerminals([
          ownEntry,
          { ...ownEntry, widget: "prompt" },
          { ...ownEntry, widget: "prompt" },
        ]),
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
      },
    );

    expect(isError).toBe(false);
    expect(calls.filter((c) => c.cmd === "graph_set_widget").length).toBeGreaterThan(0);
  });

  it("writes when a DIFFERENT alias carries an error (node 170's `control_after_generate`)", async () => {
    const { isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: withTerminals([
          ownEntry,
          {
            widget: "control_after_generate",
            error:
              "properties.proxyWidgets named a promoted relation that had no live " +
              "node.widgets/_subgraphSlot projection",
          },
        ]),
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
      },
    );

    expect(isError).toBe(false);
    expect(calls.filter((c) => c.cmd === "graph_set_widget").length).toBeGreaterThan(0);
  });

  it("still refuses when the REQUESTED alias is the duplicated one", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: withTerminals([ownEntry, { ...ownEntry }]),
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/witness was ambiguous/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("still refuses when the REQUESTED alias's own entry carries the error", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: withTerminals([
          { widget: "quality_prompt", error: "the immediate promotion was unresolved" },
        ]),
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/witness was incomplete or unresolved/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("still refuses a MISS against a damaged array — the P0 the whole-array rule protected", async () => {
    // `ordinary` is absent from the witness. Absence is read as "not promoted,
    // write it outer", and only a WHOLE array can prove that absence is real —
    // so an unrelated error must still veto here, exactly as before. This is the
    // control for the two allow-cases above: same damage, different question.
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "ordinary", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: withTerminals([
          ownEntry,
          { widget: "control_after_generate", error: "no live projection" },
        ]),
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/witness was incomplete or unresolved/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("still refuses a MISS against a duplicated array", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "ordinary", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: withTerminals([
          ownEntry,
          { ...ownEntry, widget: "prompt" },
          { ...ownEntry, widget: "prompt" },
        ]),
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/witness was ambiguous/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
  });

  // Structural damage must not become writable just because the requested alias
  // reads clean. It does not — but the refusal comes from FURTHER UP than the
  // narrowed check: `parsePromotedTerminalEntries` returns null for a non-record
  // entry or an empty widget name, so `validatePromotedSubgraphEnvelope` rejects
  // the whole envelope before `promotedTerminalEvidenceError` is ever reached.
  // These two pin the OBSERVED refusal rather than the one the narrowed function
  // would have produced, so they stay true if that ordering is ever revisited.
  // (The structural pass inside `promotedTerminalEvidenceError` is retained as
  // defence in depth for direct callers; on this path it is unreachable, and
  // these tests deliberately do not claim otherwise.)
  it("refuses on STRUCTURAL damage even though the requested alias looks clean", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: withTerminals([ownEntry, "not-an-object"]),
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/malformed, stale, or incomplete ownership envelope/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
  });

  it("refuses when an entry has no usable widget name, requested alias notwithstanding", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "masterpiece" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: withTerminals([ownEntry, { widget: "" }]),
        detailById: SAFE_ANIMA_IDENTITY_BY_ID,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/malformed, stale, or incomplete ownership envelope/);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
  });
});

describe("#2393 promoted COMBO unet_name after official template load", () => {
  it("maps the unique rail-backed UNETLoader, not the drifted immediate id", () => {
    expect(resolveInnerPromotedTarget(UNet_COMBO_TEMPLATE_SUBGRAPH, "unet_name", 472)).toEqual({
      innerNodeId: 37,
      widget: "unet_name",
      terminal: {
        nodeId: 37,
        nodeType: "UNETLoader",
        widget: "unet_name",
        inputs: [
          { name: "unet_name", type: "COMBO" },
          { name: "weight_dtype", type: "COMBO" },
        ],
        chainDepth: 0,
      },
    });
  });

  it("still refuses when two inner UNETLoaders are rail-backed on the same alias", () => {
    const ambiguous = {
      ...UNet_COMBO_TEMPLATE_SUBGRAPH,
      node_count: 3,
      nodes: [
        ...UNet_COMBO_TEMPLATE_SUBGRAPH.nodes,
        {
          id: 39,
          type: "UNETLoader",
          widgets: { unet_name: "other.safetensors" },
          inputs: [
            { slot: 0, name: "unet_name", type: "COMBO", connected_from: { node_id: -10, output_slot: 8 } },
          ],
        },
      ],
    };
    expect(resolveInnerPromotedTarget(ambiguous, "unet_name", 472)).toBeNull();
  });

  it("writes the rail-backed inner COMBO instead of refusing the incomplete own-entry", async () => {
    const { isError, calls, mutations } = await setWidget(
      { node_id: 472, widget: "unet_name", value: "model.safetensors" },
      {
        ownerNodeId: 472,
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        promotedDetail: UNet_COMBO_TEMPLATE_DETAIL,
        subgraph: UNet_COMBO_TEMPLATE_SUBGRAPH,
      },
    );

    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({ node_id: 37, widget: "unet_name", value: "model.safetensors" }),
    ]);
    const write = calls.find((call) => call.cmd === "graph_set_widget");
    const scope = write?.expected_scope as Record<string, unknown> | undefined;
    expect(scope?.parent_rail).toBeUndefined();
    expect(scope?.terminal).toEqual(
      expect.objectContaining({ node_id: 37, type: "UNETLoader", widget: "unet_name" }),
    );
    expect(calls.some((call) => call.cmd === "graph_set_widget" && call.node_id === 99)).toBe(false);
  });

  it("still refuses the incomplete own-entry when the inner COMBO is not rail-backed", async () => {
    const { text, isError, calls } = await setWidget(
      { node_id: 472, widget: "unet_name", value: "model.safetensors" },
      {
        ownerNodeId: 472,
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        promotedDetail: UNet_COMBO_TEMPLATE_DETAIL,
        subgraph: {
          ...UNet_COMBO_TEMPLATE_SUBGRAPH,
          nodes: [
            {
              id: 37,
              type: "UNETLoader",
              widgets: { unet_name: "model.safetensors" },
              inputs: [{ slot: 0, name: "unet_name", type: "COMBO" }],
            },
            UNet_COMBO_TEMPLATE_SUBGRAPH.nodes[1],
          ],
        },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/witness was incomplete or unresolved/);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
  });
});

describe("panel_set_widget transient promoted-subgraph read (#2478)", () => {
  const transientRead = new Error("graph_get_subgraph temporarily unavailable during panel binding");

  it("refreshes one indeterminate read before applying the validated promoted write", async () => {
    const { isError, calls, writesApplied, mutations } = await setWidget(
      { node_id: 78, widget: "steps", value: 8 },
      {
        firstWrite: "ok",
        subgraphSequence: [transientRead, SUBGRAPH],
      },
    );

    expect(isError).toBe(false);
    expect(writesApplied).toBe(1);
    expect(mutations).toBe(1);
    // The shipped handler performs the initial read, exactly one transient
    // refresh, and the pre-entry mapping confirmation before the inner write.
    expect(calls.filter((call) => call.cmd === "graph_get_subgraph")).toHaveLength(3);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({ node_id: 75, widget: "steps", value: 8 }),
    ]);
  });

  it("still refuses when the one refresh remains indeterminate", async () => {
    const { isError, text, calls, writesApplied, mutations } = await setWidget(
      { node_id: 78, widget: "steps", value: 8 },
      {
        firstWrite: "ok",
        subgraphSequence: [transientRead, transientRead],
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/could not determine whether the addressed node is a promoted container/);
    expect(calls.filter((call) => call.cmd === "graph_get_subgraph")).toHaveLength(2);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
    expect(writesApplied).toBe(0);
    expect(mutations).toBe(0);
  });

  it("fences a definitive ordinary refresh before the raw write", async () => {
    const { isError, calls, mutations, bridgeRetryBudgets } = await setWidget(
      { node_id: 78, widget: "steps", value: 8 },
      {
        firstWrite: "ok",
        preflightNodeIdentity: "node:78:original",
        preflightNodeType: "PromotedContainer",
        preflightNodeIsSubgraph: true,
        subgraphSequence: [
          transientRead,
          new Error("Node 78 (OrdinaryNode) is not a subgraph"),
        ],
      },
    );

    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(bridgeRetryBudgets.slice(0, 2)).toEqual([0, 0]);
    expect(calls.filter((call) => call.cmd === "graph_get_subgraph")).toHaveLength(2);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({
        node_id: 78,
        widget: "steps",
        expected_node_type: "OrdinaryNode",
        expected_node_identity: "node:78:original",
      }),
    ]);
  });

  it("refuses instead of falsely succeeding when the ordinary node is replaced", async () => {
    const { isError, text, calls, writesApplied, mutations, bridgeRetryBudgets } = await setWidget(
      { node_id: 78, widget: "steps", value: 8 },
      {
        firstWrite: "ok",
        ordinaryNodeTypeAfterRefresh: "ReplacementNode",
        preflightNodeIdentity: "node:78:original",
        preflightNodeType: "PromotedContainer",
        preflightNodeIsSubgraph: true,
        subgraphSequence: [
          transientRead,
          new Error("Node 78 (OrdinaryNode) is not a subgraph"),
        ],
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/expected node type changed before dispatch/);
    expect(calls.filter((call) => call.cmd === "graph_get_subgraph")).toHaveLength(2);
    expect(bridgeRetryBudgets).toEqual([0, 0]);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(1);
    expect(writesApplied).toBe(0);
    expect(mutations).toBe(0);
  });

  it("refuses a same-type same-id replacement using the node identity fence", async () => {
    const { isError, text, calls, writesApplied, mutations, bridgeRetryBudgets } = await setWidget(
      { node_id: 78, widget: "steps", value: 8 },
      {
        firstWrite: "ok",
        preflightNodeIdentity: "node:78:original",
        preflightNodeType: "PromotedContainer",
        preflightNodeIsSubgraph: true,
        ordinaryNodeIdentityAfterRefresh: "node:78:replacement",
        subgraphSequence: [
          transientRead,
          new Error("Node 78 (OrdinaryNode) is not a subgraph"),
        ],
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/expected node identity changed before dispatch/);
    expect(calls.filter((call) => call.cmd === "graph_get_subgraph")).toHaveLength(2);
    expect(bridgeRetryBudgets).toEqual([0, 0]);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(1);
    expect(writesApplied).toBe(0);
    expect(mutations).toBe(0);
  });

  it.each([
    "Panel tab tmp:panel is not open",
    "socket hang up",
    "WebSocket connection closed",
    "no connected tab for the requested panel",
    "genuinely gone",
    "Failed to fetch",
    "Panel not reachable",
    "ECONNRESET",
    "premature close",
    "other side closed",
    "ECONNABORTED",
    "EPIPE",
    'the panel is switching/refreshing "workflow-a" right now, so "graph_get_subgraph" was NOT applied — nothing changed',
  ])("refreshes known transient refusal %s", async (message) => {
    const { isError, calls, mutations, bridgeRetryBudgets } = await setWidget(
      { node_id: 78, widget: "steps", value: 8 },
      {
        firstWrite: "ok",
        subgraphSequence: [new Error(message), SUBGRAPH],
      },
    );

    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(calls.filter((call) => call.cmd === "graph_get_subgraph")).toHaveLength(3);
    expect(bridgeRetryBudgets.slice(0, 2)).toEqual([0, 0]);
  });

  it("does not spend the refresh on a permanent application error", async () => {
    const { isError, text, calls, mutations, bridgeRetryBudgets } = await setWidget(
      { node_id: 78, widget: "steps", value: 8 },
      {
        firstWrite: "ok",
        subgraph: new Error("graph_get_subgraph rejected a malformed response"),
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/could not determine whether the addressed node is a promoted container/);
    expect(calls.filter((call) => call.cmd === "graph_get_subgraph")).toHaveLength(1);
    expect(bridgeRetryBudgets).toEqual([0]);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
    expect(mutations).toBe(0);
  });
});

describe("panel_set_widget promoted inner identity forwarding (#2478)", () => {
  const originalIdentity = "node-incarnation:inner-original";
  const replacementIdentity = "node-incarnation:inner-replacement";
  const currentEnvelope = (nodeIdentity: unknown) => ({
    ...CURRENT_SAFE_PROMOTED_SUBGRAPH,
    nodes: [
      {
        ...CURRENT_SAFE_PROMOTED_SUBGRAPH.nodes[0],
        node_identity: nodeIdentity,
      },
    ],
  });
  // This is the actual one-ID compact graph_query envelope emitted by the
  // Panel: the human-readable compact line is accompanied by the bounded,
  // identity-bearing structured witness. Keep the response shape here in sync
  // with browser_tests/unit/graph-query-detail-budget.test.mjs so this test
  // exercises the producer/consumer contract rather than a bare nodes array.
  const innerCompactResponse = (nodeIdentity: unknown) => ({
    truncated: false,
    truncated_by: null,
    text:
      "1 match(es) of 1 in scope (viewing: 2 nodes)\n" +
      "#76 PrimitiveStringMultiline · quality_prompt=new",
    nodes: [
      {
        id: 76,
        type: "PrimitiveStringMultiline",
        node_identity: nodeIdentity,
        is_subgraph: false,
      },
    ],
  });

  it("forwards the immediate inner identity on the guarded write", async () => {
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: currentEnvelope(originalIdentity),
        postEnterGraphQueryById: { "76": innerCompactResponse(originalIdentity) },
      },
    );

    expect(isError).toBe(false);
    expect(text).toMatch(/applied|quality_prompt/);
    expect(mutations).toBe(1);
    expect(calls.filter((call) => call.cmd === "graph_query" && call.ids?.[0] === 76)).toContainEqual(
      expect.objectContaining({
        fields: "compact",
        limit: 1,
        max_chars: 2048,
      }),
    );
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({
        node_id: 76,
        widget: "quality_prompt",
        expected_node_identity: originalIdentity,
      }),
    ]);
  });

  it("refuses a legacy compact text row that omits the current node identity", async () => {
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: currentEnvelope(originalIdentity),
        postEnterGraphQueryById: {
          "76": {
            text: "1 match(es) of 1 in scope (viewing: 1 nodes)\n#76 PrimitiveStringMultiline",
          },
        },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/identity|changed or became unverifiable/);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
    expect(mutations).toBe(0);
  });

  it("refuses a same-ID same-type inner replacement before dispatch", async () => {
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: currentEnvelope(originalIdentity),
        postEnterGraphQueryById: { "76": innerCompactResponse(replacementIdentity) },
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/identity|changed or became unverifiable|Nothing was applied/);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
    expect(mutations).toBe(0);
  });

  it("refuses a current-capability envelope that omits the inner identity", async () => {
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        omitInnerNodeIdentity: true,
        subgraph: currentEnvelope(undefined),
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/trustworthy immediate inner-node identity fence/);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
    expect(mutations).toBe(0);
  });

  it("refuses a witness-less promoted target after a same-socket capability upgrade", async () => {
    // The fake receiver keeps its connection identity unchanged while an
    // anonymous same-socket re-hello upgrades only the node-identity fence.
    // The target was captured from the legacy, witness-less capability state;
    // that upgrade must not authorize a later fenced write retroactively.
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWrite: "ok",
        identityFenceChange: "upgrade",
        subgraph: SAFE_ANIMA_SUBGRAPH,
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/node-identity write fence changed|No graph_set_widget was dispatched/);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
    expect(mutations).toBe(0);
  });

  it("carries the captured identity through contradictory-refusal recovery", async () => {
    const originalIdentity = "node-incarnation:recovery-original";
    const replacementIdentity = "node-incarnation:recovery-replacement";
    const recoverySubgraph = {
      ...SAFE_ANIMA_SUBGRAPH,
      nodes: [
        {
          ...SAFE_ANIMA_SUBGRAPH.nodes[0],
          node_identity: originalIdentity,
        },
      ],
    };
    const recoveryInnerQuery = {
      nodes: [
        {
          id: 76,
          type: "PrimitiveStringMultiline",
          node_identity: originalIdentity,
        },
      ],
    };
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWriteError: ANIMA_CONTRADICTORY,
        preflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        // Keep the second prepare on the legacy path; the following recovery
        // graph_get_subgraph is the envelope used by the fallback write.
        recoveryPreflightSubgraph: DEFINITIVE_NON_PROMOTED_SUBGRAPH,
        subgraph: recoverySubgraph,
        innerNodeIdentity: originalIdentity,
        innerNodeIdentityAfterMcpFence: replacementIdentity,
        postEnterGraphQueryById: { "76": recoveryInnerQuery },
      },
    );

    const writes = calls.filter((call) => call.cmd === "graph_set_widget");
    expect(isError).toBe(true);
    expect(mutations).toBe(0);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toMatchObject({
      node_id: 76,
      widget: "quality_prompt",
      expected_node_type: "PrimitiveStringMultiline",
      expected_node_identity: originalIdentity,
    });
    expect(text).toMatch(/inner node identity changed|Nothing was applied/);
  });

  it("refuses a malformed inner identity rather than treating it as a legacy omission", async () => {
    const { text, isError, calls, mutations } = await setWidget(
      { node_id: 78, widget: "quality_prompt", value: "new" },
      {
        firstWrite: "ok",
        promotedTerminalWitnesses: true,
        subgraph: currentEnvelope(42),
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/malformed, stale, or incomplete ownership envelope/);
    expect(calls.filter((call) => call.cmd === "graph_set_widget")).toHaveLength(0);
    expect(mutations).toBe(0);
  });
});

// #2394 (follow-up) — the definitive-read classifier matched the panel's own
// `Node <id> (<type>) is not a subgraph` message with a `\([^)]*\)` body, which
// stops at the FIRST `)`. rgthree names every node `… (rgthree)`, so the message
// for the reported node never matched, the read was downgraded to indeterminate,
// and the ordinary write was refused.
//
// PR #2399 added a root-scope shortcut that returns before graph_get_subgraph is
// ever called, which hides this for a root node on a panel new enough to classify
// (>= 0.15.101). It does NOT cover the two paths below, where the classifier is
// still the only thing standing between an ordinary node and a false refusal.
describe("definitive non-promoted read tolerates a parenthesised node type (#2394)", () => {
  const RGTHREE_VALUE =
    '{"on":false,"lora":"Detailer-KREA2.safetensors","strength":0.3,"strengthTwo":null}';

  it("writes a root-level rgthree lora_N row when the scope probe cannot classify", async () => {
    // A panel older than 0.15.101 emits no `is_subgraph`, so the #2399 shortcut
    // reads indeterminate and correctly falls through to graph_get_subgraph.
    // From there the classifier is the only remaining gate.
    const { isError, text, mutations, calls } = await setWidget(
      { node_id: 82, widget: "lora_1", value: RGTHREE_VALUE },
      {
        firstWrite: "ok",
        subgraph: new Error("Node 82 (Power Lora Loader (rgthree)) is not a subgraph"),
      },
    );

    expect(text).not.toMatch(/could not determine whether the addressed node is a promoted container/);
    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({ node_id: 82, widget: "lora_1", value: RGTHREE_VALUE }),
    ]);
  });

  it("writes an ordinary rgthree node from inside a subgraph", async () => {
    // The #2399 shortcut is deliberately root-only, so an ordinary rgthree node
    // reached while viewing a subgraph still goes through graph_get_subgraph.
    const { isError, text, mutations, calls } = await setWidget(
      { node_id: 82, widget: "lora_1", value: RGTHREE_VALUE },
      {
        ownerNodeId: 78,
        startInSubgraph: true,
        firstWrite: "ok",
        nestedSubgraph: new Error("Node 82 (Power Lora Loader (rgthree)) is not a subgraph"),
        promotedDetail: {
          text:
            '1 match(es) of 1 in scope (viewing: 1 nodes)\n' +
            '{"id":82,"type":"Power Lora Loader (rgthree)","is_subgraph":false}',
        },
      },
    );

    expect(text).not.toMatch(/could not determine whether the addressed node is a promoted container/);
    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toEqual([
      expect.objectContaining({ node_id: 82, widget: "lora_1", value: RGTHREE_VALUE }),
    ]);
  });

  // CONTROLS — these must hold BEFORE and AFTER the classifier change, or the two
  // pins above would be satisfied by simply authorizing every failed read.
  it("still refuses a genuinely indeterminate read", async () => {
    const { isError, text, mutations, calls } = await setWidget(
      { node_id: 82, widget: "lora_1", value: RGTHREE_VALUE },
      {
        firstWrite: "ok",
        subgraph: new Error("websocket disconnected before graph_get_subgraph replied"),
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/could not determine whether the addressed node is a promoted container/);
    expect(mutations).toBe(0);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(0);
  });

  // codex gate — the first cut of this fix used `.*`, which does NOT cross a
  // newline, while the `[^)]*` body it replaced DID. A node type carrying a
  // newline therefore matched before the fix and would have stopped matching
  // after it: a regression smuggled in by a widening change. The balanced body
  // keeps this case working.
  it("still classifies a node type containing a newline", async () => {
    const { isError, text, mutations, calls } = await setWidget(
      { node_id: 82, widget: "lora_1", value: RGTHREE_VALUE },
      {
        firstWrite: "ok",
        subgraph: new Error("Node 82 (Power Lora Loader\n(rgthree)) is not a subgraph"),
      },
    );

    expect(text).not.toMatch(/could not determine whether the addressed node is a promoted container/);
    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
  });

  // codex gate, round 2 — the balanced body ALONE rejected an unmatched `(`,
  // which the original `[^)]*` accepted by stopping at the first `)`. That would
  // have traded one false refusal for another, so the original branch stays in
  // the union and this pins the accept set as a strict superset.
  it("still classifies a node type containing an unmatched open paren", async () => {
    const { isError, text, mutations, calls } = await setWidget(
      { node_id: 82, widget: "lora_1", value: RGTHREE_VALUE },
      {
        firstWrite: "ok",
        subgraph: new Error("Node 82 (Power (rgthree) is not a subgraph"),
      },
    );

    expect(text).not.toMatch(/could not determine whether the addressed node is a promoted container/);
    expect(isError).toBe(false);
    expect(mutations).toBe(1);
    expect(calls.filter((c) => c.cmd === "graph_set_widget")).toHaveLength(1);
  });

  it("still refuses when the message names a promoted container rather than a plain node", async () => {
    // Shape-adjacent but NOT the definitive message: it must not be admitted just
    // because it carries parentheses and the word subgraph.
    const { isError, text, mutations } = await setWidget(
      { node_id: 82, widget: "lora_1", value: RGTHREE_VALUE },
      {
        firstWrite: "ok",
        subgraph: new Error(
          "Cannot read node 82 (Power Lora Loader (rgthree)) because the subgraph is not loaded",
        ),
      },
    );

    expect(isError).toBe(true);
    expect(text).toMatch(/could not determine whether the addressed node is a promoted container/);
    expect(mutations).toBe(0);
  });
});
