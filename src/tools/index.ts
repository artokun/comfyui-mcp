import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWorkflowExecuteTools } from "./workflow-execute.js";
import { registerWorkflowVisualizeTools } from "./workflow-visualize.js";
import { registerWorkflowComposeTools } from "./workflow-compose.js";
import { registerWorkflowValidateTools } from "./workflow-validate.js";
import { registerQueueManagementTools } from "./queue-management.js";
import { registerRegistrySearchTools } from "./registry-search.js";
import { registerModelManagementTools } from "./model-management.js";
import { registerSkillGeneratorTools } from "./skill-generator.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerWorkflowLibraryTools } from "./workflow-library.js";
import { registerProcessControlTools } from "./process-control.js";
import { registerImageManagementTools } from "./image-management.js";
import { registerMemoryManagementTools } from "./memory-management.js";
import { registerGenerationTrackerTools } from "./generation-tracker.js";

export function registerAllTools(server: McpServer): void {
  registerWorkflowExecuteTools(server);
  registerWorkflowVisualizeTools(server);
  registerWorkflowComposeTools(server);
  registerWorkflowValidateTools(server);
  registerQueueManagementTools(server);
  registerRegistrySearchTools(server);
  registerModelManagementTools(server);
  registerSkillGeneratorTools(server);
  registerDiagnosticsTools(server);
  registerWorkflowLibraryTools(server);
  registerProcessControlTools(server);
  registerImageManagementTools(server);
  registerMemoryManagementTools(server);
  registerGenerationTrackerTools(server);
}
