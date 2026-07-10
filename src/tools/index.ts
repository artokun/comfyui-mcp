import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWorkflowExecuteTools } from "./workflow-execute.js";
import { registerWorkflowVisualizeTools } from "./workflow-visualize.js";
import { registerWorkflowComposeTools } from "./workflow-compose.js";
import { registerWorkflowValidateTools } from "./workflow-validate.js";
import { registerQueueManagementTools } from "./queue-management.js";
import { registerRegistrySearchTools } from "./registry-search.js";
import { registerModelManagementTools } from "./model-management.js";
import { registerModelExtrasTools } from "./model-extras.js";
import { registerExtraPathsTools } from "./extra-paths.js";
import { registerSkillGeneratorTools } from "./skill-generator.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
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
import { registerInstallComfyUITools } from "./install-comfyui.js";
import { registerUpdateComfyUITools } from "./update-comfyui.js";
import { registerWorkspaceEnvTools } from "./workspace-env.js";
import { registerApiNodesTools } from "./api-nodes.js";
import { registerManagerConfigTools } from "./manager-config.js";
import { registerManifestTools } from "./manifest.js";
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
import { DefaultsManager } from "../services/defaults-manager.js";
import { ToolCatalog } from "./catalog.js";

/**
 * Every static tool group, in registration order (order is observable in
 * tools/list, so it must not change), tagged with the category used by the
 * compact tool mode's list_tools manifest.
 */
const TOOL_GROUPS: ReadonlyArray<readonly [category: string, register: (server: McpServer) => void]> = [
  ["workflows", registerWorkflowExecuteTools],
  ["workflow-authoring", registerWorkflowVisualizeTools],
  ["workflow-authoring", registerWorkflowComposeTools],
  ["workflow-authoring", registerWorkflowValidateTools],
  ["workflows", registerQueueManagementTools],
  ["custom-nodes", registerRegistrySearchTools],
  ["models", registerModelManagementTools],
  ["skills-config", registerSkillGeneratorTools],
  ["diagnostics", registerDiagnosticsTools],
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
  ["server", registerInstallComfyUITools],
  ["server", registerUpdateComfyUITools],
  ["models", registerModelExtrasTools],
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
];

export async function registerAllTools(server: McpServer): Promise<void> {
  // Hydrate persisted defaults before any tool registration so subsequent
  // tools can consult DefaultsManager.apply() against a fully-resolved view.
  await DefaultsManager.load();
  for (const [, register] of TOOL_GROUPS) register(server);
  await registerAutoloadedWorkflows(server);
}

/**
 * Run the same registration pass against a capturing ToolCatalog instead of a
 * live server. Used by the compact tool mode (small/local LLMs): the catalog
 * backs the list_tools / describe_tool / call_tool meta-tools.
 */
export async function collectToolCatalog(): Promise<ToolCatalog> {
  await DefaultsManager.load();
  const catalog = new ToolCatalog();
  const registrar = catalog.asRegistrar();
  for (const [category, register] of TOOL_GROUPS) {
    catalog.setCategory(category);
    register(registrar);
  }
  catalog.setCategory("saved-workflows");
  await registerAutoloadedWorkflows(registrar);
  return catalog;
}
