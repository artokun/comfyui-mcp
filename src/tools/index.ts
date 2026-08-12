import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWorkflowExecuteTools } from "./workflow-execute.js";
import { registerSystemStatsTools } from "./system-stats.js";
import { registerWorkflowVisualizeTools } from "./workflow-visualize.js";
import { registerWorkflowComposeTools } from "./workflow-compose.js";
import { registerQueueManagementTools } from "./queue-management.js";
import { registerBatchTools } from "./batches.js";
import { registerRegistrySearchTools } from "./registry-search.js";
import { registerModelManagementTools } from "./model-management.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerRunpodTools } from "./runpod.js";
import { registerWorkflowLibraryTools } from "./workflow-library.js";
import { registerProcessControlTools } from "./process-control.js";
import { registerImageManagementTools } from "./image-management.js";
import { registerMemoryManagementTools } from "./memory-management.js";
import { registerAutoloadedWorkflows } from "./workflow-autoload.js";
import { registerDefaultsTools } from "./defaults.js";
import { registerGenerateImageTool } from "./generate-image.js";
import { registerNodeSnapshotsTools } from "./node-snapshots.js";
import { registerNodeBisectTools } from "./node-bisect.js";
import { registerNodeManagementTools } from "./node-management.js";
import { registerReportIssueTools } from "./report-issue.js";
import { registerNodePackTools } from "./node-pack.js";
import { registerInstallComfyUITools } from "./install-comfyui.js";
import { registerWorkspaceEnvTools } from "./workspace-env.js";
import { registerApiNodesTools } from "./api-nodes.js";
import { registerManifestTools } from "./manifest.js";
import { registerModelExplorerTools } from "./model-explorer.js";
// 0.50.0 slice 15: the image-convert / color-analysis / storage-upload
// registrars are gone — their three tools became actions on `get_image` and
// `upload_image` (registerImageManagementTools). The SERVICES they called are
// untouched and now imported there.
import { registerSkillsAccessTools } from "./skills-access.js";
import { registerCalculateTools } from "./calculate.js";
import { registerComfyCliTools } from "./comfy-cli.js";
import { registerTrainTools } from "./train.js";
import { registerAppsTools } from "./apps.js";
import { DefaultsManager } from "../services/defaults-manager.js";
import { ToolCatalog } from "./catalog.js";
import { registerCompactTools } from "./compact.js";
import { logger } from "../utils/logger.js";
import { resolveToolSurfacePolicy, withToolSurfaceFilter } from "./tool-surface-filter.js";

/**
 * Every static tool group, in registration order (order is observable in
 * tools/list, so it must not change), tagged with the category used by the
 * compact tool mode's list_tools manifest.
 */
const TOOL_GROUPS: ReadonlyArray<readonly [category: string, register: (server: McpServer) => void]> = [
  ["comfy-cli", registerComfyCliTools],
  ["workflows", registerWorkflowExecuteTools],
  ["workflows", registerSystemStatsTools],
  ["workflow-authoring", registerWorkflowVisualizeTools],
  ["workflow-authoring", registerWorkflowComposeTools],
  ["workflows", registerQueueManagementTools],
  ["custom-nodes", registerRegistrySearchTools],
  ["models", registerModelManagementTools],
  // (0.50.0 slice 9: the skill-generator group's single tool folded into
  // `list_packs` action:"generate_skill", registered by registerSkillsAccessTools
  // further down — the survivor keeps its own slot.)
  ["diagnostics", registerDiagnosticsTools],
  ["runpod", registerRunpodTools],
  ["workflow-authoring", registerWorkflowLibraryTools],
  ["server", registerProcessControlTools],
  ["images-assets", registerImageManagementTools],
  ["server", registerMemoryManagementTools],
  ["skills-config", registerDefaultsTools],
  // 0.50.0 slice 16 folded eight sibling generation tools into `generate_image`
  // and four observability tools into `get_history`, so the groups that used to
  // register them are gone from this list (their handlers live on as action
  // functions imported by the survivors). `generate_image` keeps this slot.
  ["generation", registerGenerateImageTool],
  ["custom-nodes", registerNodeSnapshotsTools],
  ["custom-nodes", registerNodeBisectTools],
  ["custom-nodes", registerNodeManagementTools],
  ["diagnostics", registerReportIssueTools],
  // (0.50.0 slice 9: the workflow-deps group's two tools folded into `list_packs`
  // actions "extract_deps"/"install_deps" — same note as skill-generator above.)
  ["server", registerInstallComfyUITools],
  ["models", registerModelExplorerTools],
  ["server", registerWorkspaceEnvTools],
  ["generation", registerApiNodesTools],
  ["custom-nodes", registerNodePackTools],
  ["models", registerManifestTools],
  ["skills-config", registerSkillsAccessTools],
  ["diagnostics", registerCalculateTools],
  // registerComfyUISettingsTools used to sit here. 0.50.0 slice 7 folded its two
  // tools into `get_defaults` as action:"get_ui"/"set_ui", so the group is gone
  // rather than empty — every surviving name keeps its position, which is what
  // registry-surface.test.ts pins.
  //
  // registerNodeDevTools sat here too, until 0.50.0 slice 12 folded its six
  // tools into `node_pack` — registered at the slot its family’s first member
  // (the scaffold tool) held, further up.
  ["training", registerTrainTools],
  ["apps", registerAppsTools],
  // Appended (not inserted next to queue-management) because tools/list order
  // is observable and must not shift for existing tools.
  ["workflows", registerBatchTools],
];

// ── Blind content mode (panel issue #90) ────────────────────────────────────
// When COMFYUI_MCP_BLIND=1 (set on the tool-server spawn by the orchestrator
// for tabs whose panel Blind toggle is ON), NO tool may deliver image pixels
// to the model. Enforced MECHANICALLY at the single registration boundary both
// tool paths share — the live McpServer and the compact-mode ToolCatalog both
// receive handlers wrapped here — so the guarantee holds for every current and
// future image-returning tool (get_image's fetch/view/convert/colour-measure
// actions, generate_image, get_image, ...) without per-tool opt-ins. It
// wraps the RESULT, so folding several image-returning tools into one name
// (0.50.0 slice 15) changes nothing here: the wrapper never reads a tool name
// or an action.
const blindMode = (): boolean => process.env.COMFYUI_MCP_BLIND === "1";

function scrubImageBlocks(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as { content?: Array<Record<string, unknown>> };
  if (!Array.isArray(r.content)) return result;
  let scrubbed = 0;
  const content = r.content.map((block) => {
    if (!block || block.type !== "image") return block;
    scrubbed++;
    const bytes = typeof block.data === "string" ? Math.round((block.data.length * 3) / 4) : 0;
    const size = bytes ? `${Math.max(1, Math.round(bytes / 1024))} KB, ` : "";
    return {
      type: "text" as const,
      text:
        `[Blind mode: image withheld (${size}${String(block.mimeType ?? "image")}). ` +
        "The user's Blind setting means you NEVER receive image pixels — work from " +
        "filenames/metadata, and tell the user to inspect the image themselves if it matters.]",
    };
  });
  if (!scrubbed) return result;
  return { ...r, content };
}

/** Wrap a registrar so every tool handler enforces Blind mode on its RESULT.
 *  Works for both the live McpServer and ToolCatalog.asRegistrar() (the compact
 *  call_tool router) — each captures/registers the wrapped handler. */
function withBlindImageGate(server: McpServer): McpServer {
  const orig = (server as unknown as { tool: (...args: unknown[]) => unknown }).tool.bind(server);
  const tool = (...args: unknown[]): unknown => {
    const handler = args[args.length - 1];
    if (typeof handler === "function") {
      const wrapped = async (...hargs: unknown[]) => {
        const result = await (handler as (...a: unknown[]) => unknown)(...hargs);
        return blindMode() ? scrubImageBlocks(result) : result;
      };
      return orig(...args.slice(0, -1), wrapped);
    }
    return orig(...args);
  };
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "tool") return tool;
      return Reflect.get(target, prop, receiver);
    },
  }) as McpServer;
}

export async function registerAllTools(server: McpServer): Promise<void> {
  // Hydrate persisted defaults before any tool registration so subsequent
  // tools can consult DefaultsManager.apply() against a fully-resolved view.
  await DefaultsManager.load();
  // #873 — the operator's tool-surface policy, applied in the SAME position as the
  // blind-image gate. collectToolCatalog() applies it too, which is what stops the
  // compact `call_tool` facade being a way around it.
  const policy = resolveToolSurfacePolicy();
  const filtered: string[] = [];
  const gated = withToolSurfaceFilter(withBlindImageGate(server), policy, (n) => filtered.push(n));
  for (const [, register] of TOOL_GROUPS) register(gated);
  await registerAutoloadedWorkflows(gated);
  if (policy.active) {
    // Logged, never pushed to the model: the point is that it does not learn these
    // exist. The OPERATOR needs to see it, and a silent filter is how a misconfigured
    // allow list becomes an afternoon of "why can't it render".
    logger.info(
      `[tools] surface restricted by policy${policy.preset ? ` (preset "${policy.preset}")` : ""} — ` +
        `${filtered.length} tool(s) withheld` +
        (filtered.length ? `: ${filtered.slice(0, 12).join(", ")}${filtered.length > 12 ? ", …" : ""}` : "") +
        (policy.actionAllow.length
          ? `; ${policy.actionAllow.length} exact tool action(s) allowed`
          : ""),
    );
  }
}

/**
 * Default (non-compact) registration WITH the compact facade layered on top.
 *
 * #616 — reconnect resilience: a code-execution MCP client (the SDK's
 * `exec_main.mjs` harness that exposes each tool as a callable
 * `tools.mcp__comfyui__<tool>`) snapshots the tool surface from a `tools/list`.
 * After the user restarts ComfyUI and the panel session resumes, that snapshot
 * can go stale — a previously-bound direct tool is briefly absent from the
 * refreshed surface, and calling the cached binding throws
 * `TypeError: tools.install_comfyui (action:"environment") is not a function` BEFORE
 * dispatch. Layering the facade (`list_tools` / `describe_tool` / `call_tool`)
 * onto the full direct surface guarantees EVERY advertised surface — compact or
 * full — carries a STABLE `call_tool` escape hatch, so such a client can always
 * route a missing direct tool through `call_tool({ name, args })` instead of
 * dead-ending. The direct tools and the facade are registered in ONE atomic
 * pass here, before the transport is connected, so a resumed turn never sees a
 * half-built catalog (facade-only) missing the direct tools.
 *
 * The facade adds only 3 tools to the surface and reuses the SAME underlying
 * handlers (via collectToolCatalog), so there is no divergence between a direct
 * call and its `call_tool` route. Opt out with COMFYUI_MCP_NO_FACADE=1 (env) or
 * `{ facade: false }`.
 */
export async function registerFullTools(
  server: McpServer,
  opts: { facade?: boolean } = {},
): Promise<void> {
  await registerAllTools(server);
  const facade = opts.facade ?? process.env.COMFYUI_MCP_NO_FACADE !== "1";
  if (facade) {
    // Capture the same registration into a catalog; call_tool dispatches to these
    // handlers, so the facade route is behaviorally identical to a direct call.
    // Built and registered in-sequence with the direct surface above and BEFORE
    // server.connect(), so the whole snapshot is atomic (no half-built tools/list).
    //
    // NOTE: this is a SECOND filesystem discovery of autoloaded workflows. In the
    // (sub-millisecond) window between the two passes a workflow could be added or
    // removed; the divergence self-heals on the next spawn — call_tool routes
    // through THIS catalog (internally consistent), and at worst a just-removed
    // workflow stays directly listed but unreachable via call_tool, or a just-added
    // one is reachable via call_tool before it appears in the direct list. Neither
    // drops an established tool. The one race that could otherwise CRASH startup —
    // a reserved-name workflow present in pass 1 (registered live) but gone from
    // pass 2's catalog, so `skip` misses it and the facade double-registers — is
    // caught inside registerCompactTools (it swallows a duplicate-name throw).
    const catalog = await collectToolCatalog();
    // Collision guard (fast path): if a user's autoloaded workflow is literally
    // named after a facade meta-tool, registerAllTools already claimed that name on
    // the live server. Skip the colliding meta(s) cleanly (no error noise) and keep
    // the direct tool + the rest of the facade. registerCompactTools's try/catch
    // still backstops any collision this snapshot-based check misses. (#616 / codex P1)
    const reserved = ["list_tools", "describe_tool", "call_tool"] as const;
    const skip = new Set(reserved.filter((name) => catalog.get(name)));
    if (skip.size > 0) {
      logger.warn(
        `[tools] facade meta-tool name(s) already claimed by a direct tool — not layering the facade for: ${[...skip].join(", ")}. ` +
          `Rename the conflicting workflow file(s) to expose the full facade.`,
      );
    }
    registerCompactTools(server, catalog, { skip });
  }
}

/**
 * Run the same registration pass against a capturing ToolCatalog instead of a
 * live server. Used by the compact tool mode (small/local LLMs): the catalog
 * backs the list_tools / describe_tool / call_tool meta-tools.
 */
export async function collectToolCatalog(): Promise<ToolCatalog> {
  await DefaultsManager.load();
  const catalog = new ToolCatalog();
  // #873 — THE LOAD-BEARING HALF. `call_tool` dispatches through this catalog and
  // `list_tools` is built from it, so filtering here is what makes the policy a boundary
  // rather than a suggestion: a denied tool is neither listed nor reachable by name.
  // Filtering only the direct registration above would leave the facade as a clean
  // bypass, which is precisely what the report calls out.
  const registrar = withToolSurfaceFilter(
    withBlindImageGate(catalog.asRegistrar()),
    resolveToolSurfacePolicy(),
  );
  for (const [category, register] of TOOL_GROUPS) {
    catalog.setCategory(category);
    register(registrar);
  }
  catalog.setCategory("saved-workflows");
  await registerAutoloadedWorkflows(registrar);
  return catalog;
}
