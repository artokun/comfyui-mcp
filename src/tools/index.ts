import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWorkflowExecuteTools } from "./workflow-execute.js";
import { registerWorkflowVisualizeTools } from "./workflow-visualize.js";
import { registerWorkflowComposeTools } from "./workflow-compose.js";
import { registerWorkflowValidateTools } from "./workflow-validate.js";
import { registerQueueManagementTools } from "./queue-management.js";
import { registerBatchTools } from "./batches.js";
import { registerRegistrySearchTools } from "./registry-search.js";
import { registerModelManagementTools } from "./model-management.js";
import { registerModelExtrasTools } from "./model-extras.js";
import { registerExtraPathsTools } from "./extra-paths.js";
import { registerSkillGeneratorTools } from "./skill-generator.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerRunpodTools } from "./runpod.js";
import { registerWorkflowLibraryTools } from "./workflow-library.js";
import { registerWorkflowUrlTools } from "./workflow-url.js";
import { registerProcessControlTools } from "./process-control.js";
import { registerImageManagementTools } from "./image-management.js";
import { registerMemoryManagementTools } from "./memory-management.js";
import { registerGenerationTrackerTools } from "./generation-tracker.js";
import { registerAssetTools } from "./assets.js";
import { registerAutoloadedWorkflows } from "./workflow-autoload.js";
import { registerDefaultsTools } from "./defaults.js";
import { registerGenerateImageTool } from "./generate-image.js";
import { registerGenerateAudioTool } from "./generate-audio.js";
import { registerGenerate3dTools } from "./generate-3d.js";
import { registerGenerateVideoTool } from "./generate-video.js";
import { registerRemoveBackgroundTool } from "./remove-background.js";
import { registerUpscaleImageTool } from "./upscale-image.js";
import { registerConditionedGenerationTools } from "./generate-conditioned.js";
import { registerWorkflowDslTools } from "./workflow-dsl.js";
import { registerNodeSnapshotsTools } from "./node-snapshots.js";
import { registerNodeBisectTools } from "./node-bisect.js";
import { registerNodeManagementTools } from "./node-management.js";
import { registerReportIssueTools } from "./report-issue.js";
import { registerNodeAuthoringTools } from "./node-authoring.js";
import { registerNodeVerifyTools } from "./node-verify.js";
import { registerWorkflowDepsTools } from "./workflow-deps.js";
import { registerMissingModelTools } from "./missing-models.js";
import { registerInstallComfyUITools } from "./install-comfyui.js";
import { registerUpdateComfyUITools } from "./update-comfyui.js";
import { registerWorkspaceEnvTools } from "./workspace-env.js";
import { registerApiNodesTools } from "./api-nodes.js";
import { registerManagerConfigTools } from "./manager-config.js";
import { registerManifestTools } from "./manifest.js";
import { registerModelExplorerTools } from "./model-explorer.js";
import { registerPromptDirectorTools } from "./prompt-director.js";
import { registerImageConvertTools } from "./image-convert.js";
import { registerColorAnalysisTools } from "./color-analysis.js";
import { registerStorageUploadTools } from "./storage-upload.js";
import { registerHealthCheckTools } from "./health-check.js";
import { registerWorkflowLockTools } from "./workflow-lock.js";
import { registerSkillsAccessTools } from "./skills-access.js";
import { registerInstallPanelTools } from "./install-panel.js";
import { registerSelfUpdateTools } from "./self-update.js";
import { registerCalculateTools } from "./calculate.js";
import { registerComfyUISettingsTools } from "./comfyui-settings.js";
import { registerNodeDevTools } from "./node-dev.js";
import { registerComfyCliTools } from "./comfy-cli.js";
import { registerTrainTools } from "./train.js";
import { registerAppsTools } from "./apps.js";
import { registerTemplateSchemaTools } from "./template-schema.js";
import { registerRunTemplateTools } from "./run-template.js";
import { DefaultsManager } from "../services/defaults-manager.js";
import { ToolCatalog } from "./catalog.js";
import { registerCompactTools } from "./compact.js";
import { logger } from "../utils/logger.js";

/**
 * Every static tool group, in registration order (order is observable in
 * tools/list, so it must not change), tagged with the category used by the
 * compact tool mode's list_tools manifest.
 */
const TOOL_GROUPS: ReadonlyArray<readonly [category: string, register: (server: McpServer) => void]> = [
  ["comfy-cli", registerComfyCliTools],
  ["workflows", registerWorkflowExecuteTools],
  ["workflow-authoring", registerWorkflowVisualizeTools],
  ["workflow-authoring", registerWorkflowComposeTools],
  ["workflow-authoring", registerWorkflowValidateTools],
  ["workflows", registerQueueManagementTools],
  ["custom-nodes", registerRegistrySearchTools],
  ["models", registerModelManagementTools],
  ["skills-config", registerSkillGeneratorTools],
  ["diagnostics", registerDiagnosticsTools],
  ["runpod", registerRunpodTools],
  ["workflow-authoring", registerWorkflowLibraryTools],
  ["workflows", registerWorkflowUrlTools],
  ["server", registerProcessControlTools],
  ["images-assets", registerImageManagementTools],
  ["server", registerMemoryManagementTools],
  ["generation", registerGenerationTrackerTools],
  ["images-assets", registerAssetTools],
  ["skills-config", registerDefaultsTools],
  ["generation", registerGenerateImageTool],
  ["generation", registerGenerateAudioTool],
  ["generation", registerGenerate3dTools],
  ["generation", registerGenerateVideoTool],
  ["generation", registerRemoveBackgroundTool],
  ["generation", registerUpscaleImageTool],
  ["generation", registerConditionedGenerationTools],
  ["workflow-authoring", registerWorkflowDslTools],
  ["custom-nodes", registerNodeSnapshotsTools],
  ["custom-nodes", registerNodeBisectTools],
  ["custom-nodes", registerNodeManagementTools],
  ["diagnostics", registerReportIssueTools],
  ["workflows", registerWorkflowDepsTools],
  ["models", registerMissingModelTools],
  ["server", registerInstallComfyUITools],
  ["server", registerUpdateComfyUITools],
  ["models", registerModelExtrasTools],
  ["models", registerModelExplorerTools],
  ["workflow-authoring", registerPromptDirectorTools],
  ["models", registerExtraPathsTools],
  ["server", registerWorkspaceEnvTools],
  ["generation", registerApiNodesTools],
  ["server", registerManagerConfigTools],
  ["custom-nodes", registerNodeAuthoringTools],
  ["custom-nodes", registerNodeVerifyTools],
  ["models", registerManifestTools],
  ["images-assets", registerImageConvertTools],
  ["images-assets", registerColorAnalysisTools],
  ["images-assets", registerStorageUploadTools],
  ["diagnostics", registerHealthCheckTools],
  ["workflow-authoring", registerWorkflowLockTools],
  ["skills-config", registerSkillsAccessTools],
  ["server", registerInstallPanelTools],
  ["server", registerSelfUpdateTools],
  ["diagnostics", registerCalculateTools],
  ["server", registerComfyUISettingsTools],
  ["custom-nodes", registerNodeDevTools],
  ["training", registerTrainTools],
  ["apps", registerAppsTools],
  ["workflows", registerTemplateSchemaTools],
  ["workflows", registerRunTemplateTools],
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
// future image-returning tool (get_image, view_image, convert_image, color
// analysis previews, ...) without per-tool opt-ins.
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
  const gated = withBlindImageGate(server);
  for (const [, register] of TOOL_GROUPS) register(gated);
  await registerAutoloadedWorkflows(gated);
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
 * `TypeError: tools.mcp__comfyui__get_environment is not a function` BEFORE
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
  const registrar = withBlindImageGate(catalog.asRegistrar());
  for (const [category, register] of TOOL_GROUPS) {
    catalog.setCategory(category);
    register(registrar);
  }
  catalog.setCategory("saved-workflows");
  await registerAutoloadedWorkflows(registrar);
  return catalog;
}
