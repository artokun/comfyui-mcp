import type { Client } from "@stable-canvas/comfyui-client";
import { logger } from "../utils/logger.js";
import type { JobProgress } from "./types.js";

export interface ExecutionCallbacks {
  onProgress?: (progress: JobProgress) => void;
  onComplete?: (promptId: string) => void;
  onError?: (promptId: string, error: string) => void;
}

export function attachExecutionListeners(
  client: Client,
  promptId: string,
  callbacks: ExecutionCallbacks,
): () => void {
  const unsubscribers: Array<() => void> = [];

  if (callbacks.onProgress) {
    const unsub = client.on("progress", (data) => {
      if (data.prompt_id === promptId) {
        callbacks.onProgress!({
          value: data.value,
          max: data.max,
          node: data.node,
          prompt_id: data.prompt_id,
        });
      }
    });
    unsubscribers.push(unsub);
  }

  if (callbacks.onComplete) {
    const unsub = client.on("execution_success", (data) => {
      if (data.prompt_id === promptId) {
        logger.info(`Execution completed: ${promptId}`);
        callbacks.onComplete!(promptId);
      }
    });
    unsubscribers.push(unsub);
  }

  if (callbacks.onError) {
    const unsub = client.on("execution_error", (data) => {
      if (data.prompt_id === promptId) {
        logger.error(`Execution error: ${promptId}`, data.exception_message);
        callbacks.onError!(promptId, data.exception_message);
      }
    });
    unsubscribers.push(unsub);
  }

  return () => {
    for (const unsub of unsubscribers) unsub();
  };
}
