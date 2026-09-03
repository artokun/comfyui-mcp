import { PANEL_IMAGE_RELAY_MAX_BYTES } from "../services/panel-image-relay.js";

/** One byte ceiling for every raw ComfyUI /view response, including Cloud. */
export const MAX_VIEW_RESPONSE_BYTES = PANEL_IMAGE_RELAY_MAX_BYTES;

/**
 * Ceiling for a ComfyUI history document before it reaches JSON.parse().
 * History repeats prompt graphs and output metadata for completed jobs, so it
 * can grow much faster than the prompt-scoped responses used by most callers.
 */
export const MAX_HISTORY_RESPONSE_BYTES = 16 * 1024 * 1024;

export type BoundedResponseErrorKind = "too-large" | "timeout";

/** A bounded body read failed for a known, actionable reason. */
export class BoundedResponseError extends Error {
  constructor(
    public readonly kind: BoundedResponseErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "BoundedResponseError";
  }
}

function readChunkWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("The response read timed out"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(signal.reason ?? new Error("The response read timed out"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Read a raw response without ever accumulating more than the caller's
 * ceiling. A missing body is an empty response; it is never handed to an
 * unbounded arrayBuffer() fallback.
 */
export async function readResponseBodyBounded(
  res: Response,
  timeoutMs: number,
  maxBytes = MAX_VIEW_RESPONSE_BYTES,
  externalSignal?: AbortSignal,
): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await res.body?.cancel();
    } catch {
      // The size refusal is the useful error even if the producer is already gone.
    }
    throw new BoundedResponseError(
      "too-large",
      `The response exceeds the ${maxBytes} byte safety limit.`,
    );
  }
  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const signal = externalSignal ?? AbortSignal.timeout(timeoutMs);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let result: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
      try {
        result = await readChunkWithAbort(reader, signal);
      } catch (error) {
        if (signal.aborted) {
          throw new BoundedResponseError("timeout", "The response read timed out.");
        }
        throw error;
      }
      const { done, value } = result;
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel("ComfyUI /view response exceeded the safety limit");
        } catch {
          // The size refusal is the useful error even if the producer is already gone.
        }
        throw new BoundedResponseError(
          "too-large",
          `The response exceeds the ${maxBytes} byte safety limit.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
