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
  /**
   * Set when the ComfyUI server IS reachable (answered /system_stats) but its
   * listening socket could not be mapped to a local PID — so callers surface a
   * precise diagnostic instead of a flat "no process" message (issue #449).
   */
  reachableButNoPid?: boolean;

  /**
   * Set when the server that answered could NOT be bound to the process we would
   * act on — the instance behind the port changed while it was being identified
   * (#776). Callers must surface the diagnostic and touch nothing: killing on an
   * identity we could not confirm is exactly the wrong-instance hazard.
   */
  identityAmbiguous?: boolean;

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
 * Unwrap the `cause` chain of an error thrown by `fetch()` itself — a
 * network-layer failure, not an HTTP status.
 *
 * undici surfaces every one of these as `TypeError: fetch failed`, a message
 * that says nothing: not the host, not the port, not whether it was DNS, a
 * refused connection, a timeout, or a bad certificate. The actionable detail is
 * one level down on `.cause`, as an Error carrying a `code` (ENOTFOUND,
 * ECONNREFUSED, ECONNRESET, UND_ERR_CONNECT_TIMEOUT, ERR_TLS_CERT_ALTNAME_INVALID…).
 *
 * The returned message always BEGINS with the original text, so existing
 * transient-error matchers that look for /fetch failed/ keep matching.
 */
export function describeFetchFailure(err: unknown): { message: string; code?: string } {
  const parts: string[] = [];
  let code: string | undefined;
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string" && !code) code = c;
    const label = typeof c === "string" ? `${cur.message} (${c})` : cur.message;
    if (label && !parts.includes(label)) parts.push(label);
    cur = (cur as { cause?: unknown }).cause;
  }
  if (parts.length === 0) parts.push(String(err));
  return { message: parts.join(": "), code };
}

/** True for the opaque undici network failure whose detail lives on `.cause`. */
export function isBareFetchFailure(err: unknown): boolean {
  return err instanceof Error && /^fetch failed$/i.test(err.message.trim());
}

/** The host of `url`, or undefined if it will not parse. Never throws. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Say UNREACHABLE, and say which host (#1136).
 *
 * A `fetch()` that never completed is not a result. When the answer it would
 * have carried is a LIST, the difference matters enormously: an empty list reads
 * as "nothing matched", so the reader concludes the thing they are looking for
 * does not exist and goes on trying variations of a query that can never
 * succeed. That is what happened to a user behind a national filter, who was
 * told to search ComfyUI Manager and reported 我这边搜不到任何内容 — "I can't
 * find anything when I search". Three rounds of advice were spent before anyone
 * suspected the door itself could not open.
 *
 * So the message states three things the bare error does not:
 *   - the HOST, so someone behind a filter recognises their own situation;
 *   - that NOTHING WAS SEARCHED, so absence was never established;
 *   - that a blocked network is a common cause, since the user who most needs
 *     this cannot be expected to infer it from `ENOTFOUND`.
 *
 * `what` names the operation as a noun phrase — "the custom-node search".
 * `opts.remedy` adds a host-specific escape hatch where one exists (HuggingFace
 * has HF_ENDPOINT; the ComfyUI Registry has none).
 *
 * A timeout is called a timeout: the host may well be reachable and merely slow,
 * and telling a user their network is blocked when it is not is its own wrong
 * answer. The underlying detail is kept at the end so nothing is lost.
 */
export function unreachableHostMessage(
  err: unknown,
  url: string,
  what: string,
  opts?: { remedy?: string },
): { message: string; code?: string } {
  const { message: detail, code } = describeFetchFailure(err);
  const host = hostOf(url);
  const named = host ?? "the remote host";
  const timedOut =
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "ETIMEDOUT" ||
    (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"));

  return {
    code,
    message:
      (timedOut
        ? `${named} did not respond in time, so ${what} did not complete. `
        : `Could not reach ${named}, so ${what} did not run. `) +
      `This is NOT an empty result — nothing was queried, so nothing follows about whether ` +
      `what you asked for exists. ` +
      (timedOut
        ? `Retry; if it keeps timing out, the host may be throttled or filtered on this network.`
        : `${named} is commonly blocked by corporate, campus and national network filters — ` +
          `if other sites work but this one never does, that is the likely cause, and a VPN, ` +
          `proxy or different network is what changes it.`) +
      (opts?.remedy ? ` ${opts.remedy}` : "") +
      ` (${detail})`,
  };
}

export function errorToToolResult(err: unknown): CallToolResult {
  if (err instanceof ComfyUIError) return err.toToolResult();
  // A bare "fetch failed" reaching a tool result tells the reader nothing and
  // has repeatedly been read as "ComfyUI is broken" when it was a wrong port or
  // a stale target (#952, #954, #411). Expand the cause chain; the original
  // message stays at the front so nothing matching on it changes.
  const message = isBareFetchFailure(err)
    ? describeFetchFailure(err).message
    : err instanceof Error
      ? err.message
      : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}
