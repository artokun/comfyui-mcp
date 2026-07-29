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

export class ProcessControlError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "PROCESS_CONTROL_ERROR", details);
    this.name = "ProcessControlError";
  }
}

export class RemoteModeError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "REMOTE_MODE_ERROR", details);
    this.name = "RemoteModeError";
  }
}

export class NodeSnapshotError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "NODE_SNAPSHOT_ERROR", details);
    this.name = "NodeSnapshotError";
  }
}

export class NodeBisectError extends ComfyUIError {
  constructor(message: string, details?: unknown) {
    super(message, "NODE_BISECT_ERROR", details);
    this.name = "NodeBisectError";
  }
}

/**
 * Coerce an arbitrary value into readable chat/prompt text WITHOUT ever falling
 * back to JavaScript's `Object.prototype.toString` (the source of the infamous
 * `[object Object]` bubbles — issues #176/#175/#168). A structured backend
 * failure, ComfyUI execution error, or panel payload must render as something a
 * human/model can read, never as `[object Object]`.
 *
 * Order of preference:
 *  - a string passes through untouched;
 *  - a nullish value becomes the caller's fallback;
 *  - an `Error` uses its `.message`;
 *  - an object with a string `message` / `error` / `text` / `detail` field uses it;
 *  - anything else is JSON-serialized (with a guard for cycles / BigInt).
 */
export function toReadableText(value: unknown, fallback = "unknown error"): string {
  if (typeof value === "string") return value;
  if (value == null) return fallback;
  if (typeof value !== "object") return String(value);
  if (value instanceof Error) return value.message || fallback;
  const rec = value as Record<string, unknown>;
  for (const key of ["message", "error", "text", "detail"] as const) {
    const field = rec[key];
    if (typeof field === "string" && field.trim()) return field;
  }
  try {
    const json = JSON.stringify(value);
    // `JSON.stringify` returns undefined for a bare function/symbol.
    return json && json !== "{}" ? json : fallback;
  } catch {
    return fallback;
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
