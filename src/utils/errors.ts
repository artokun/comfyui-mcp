import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export class ComfyUIError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ComfyUIError";
  }

  toToolResult(): CallToolResult {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: this.code,
            message: this.message,
            details: this.details,
          }),
        },
      ],
    };
  }
}

export class ConnectionError extends ComfyUIError {
  constructor(message: string) {
    super(message, "CONNECTION_ERROR");
    this.name = "ConnectionError";
  }
}

export class WorkflowExecutionError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "WORKFLOW_EXECUTION_ERROR", details);
    this.name = "WorkflowExecutionError";
  }
}

export class ValidationError extends ComfyUIError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

export class RegistryError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "REGISTRY_ERROR", details);
    this.name = "RegistryError";
  }
}

export class ModelError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "MODEL_ERROR", details);
    this.name = "ModelError";
  }
}

export function errorToToolResult(err: unknown): CallToolResult {
  if (err instanceof ComfyUIError) return err.toToolResult();
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}
