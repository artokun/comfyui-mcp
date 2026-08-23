/**
 * Turn the app-server's provider error payload into a useful, scrubbed panel
 * diagnostic (#2112).
 *
 * Codex has emitted both a plain `Bad Request` message and a JSON string such
 * as `{\"detail\":\"Bad Request\"}`. Forwarding either verbatim leaves the
 * user unable to distinguish an oversized context/tool history from an invalid
 * request or a transient provider rejection. Keep the extraction deliberately
 * narrow: provider error objects may contain request content, so only the
 * documented diagnostic-shaped fields are copied into the user-facing text.
 */

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  try {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
  } catch {
    return null;
  }
}

function readValue(value: unknown, ...keys: string[]): unknown {
  const obj = record(value);
  if (!obj) return undefined;
  for (const key of keys) {
    try {
      if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    } catch {
      // A hostile provider-shaped object must never break error reporting.
    }
  }
  return undefined;
}

function readRawString(value: unknown, ...keys: string[]): string | undefined {
  const candidate = readValue(value, ...keys);
  return typeof candidate === "string" ? candidate : undefined;
}

function readString(value: unknown, ...keys: string[]): string | undefined {
  const candidate = readRawString(value, ...keys);
  return candidate?.trim() || undefined;
}

function readNumber(value: unknown, ...keys: string[]): number | undefined {
  const candidate = readValue(value, ...keys);
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === "string" && /^\d{3}$/.test(candidate.trim())) return Number(candidate.trim());
  return undefined;
}

function firstString(sources: readonly unknown[], ...keys: string[]): string | undefined {
  for (const source of sources) {
    const value = readString(source, ...keys);
    if (value) return value;
  }
  return undefined;
}

function firstNumber(sources: readonly unknown[], ...keys: string[]): number | undefined {
  for (const source of sources) {
    const value = readNumber(source, ...keys);
    if (value !== undefined) return value;
  }
  return undefined;
}

function safeLabel(value: string | undefined, max = 120): string | undefined {
  if (!value) return undefined;
  const oneLine = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!oneLine) return undefined;
  // These fields are identifiers, not prose. Reject anything outside the
  // provider's ordinary request-id/code alphabet instead of reflecting an
  // attacker-controlled payload into the panel.
  if (!/^[A-Za-z0-9._:/-]+$/.test(oneLine)) return undefined;
  return oneLine.slice(0, max);
}

function parseMessageEnvelope(message: unknown): UnknownRecord | null {
  if (typeof message !== "string") return record(message);
  const trimmed = message.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    return record(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function hasBadRequestMessage(value: unknown): boolean {
  const message = readString(value, "message", "detail");
  return typeof message === "string" && /^bad request$/i.test(message);
}

/**
 * Format a terminal Codex app-server error.
 *
 * Non-400 errors retain their existing message exactly. A generic 400 gets a
 * bounded explanation and retry/session guidance, while any safe structured
 * fields are included without dumping the provider payload into the panel.
 */
export function formatCodexTurnError(error: unknown): string {
  const root = record(error);
  // Keep the old non-400 behavior: an explicitly empty message stays empty,
  // while an absent message falls back to the generic label.
  const message = readRawString(error, "message") ?? (typeof error === "string" ? error : undefined);
  const envelope = parseMessageEnvelope(message) ?? root;
  const nestedSources = [
    record(readValue(root, "data")),
    record(readValue(root, "details")),
    record(readValue(envelope, "data")),
    record(readValue(envelope, "details")),
  ];
  const sources = [root, envelope, ...nestedSources];
  const status = firstNumber(sources, "status", "statusCode", "httpStatus");
  const codeCandidates = sources.map((source) => readValue(source, "code", "error_code", "errorCode"));
  // A JSON-RPC transport code (for example -32600) can sit on the root error
  // while the provider's actionable code is nested in `error.data`. Prefer a
  // non-empty string diagnostic before falling back to a numeric marker.
  const rawCode =
    codeCandidates.find((value) => typeof value === "string" && value.trim()) ??
    codeCandidates.find((value) => typeof value === "number" && Number.isFinite(value));
  const code = safeLabel(typeof rawCode === "string" ? rawCode.trim() : undefined);
  const numericCode =
    typeof rawCode === "number" && Number.isFinite(rawCode)
      ? rawCode
      : typeof rawCode === "string" && /^\d{3}$/.test(rawCode.trim())
        ? Number(rawCode.trim())
        : undefined;
  const type = safeLabel(firstString(sources, "type", "error_type", "errorType"));
  const requestId = safeLabel(firstString(sources, "request_id", "requestId"));
  const is400 =
    status === 400 ||
    numericCode === 400 ||
    (typeof message === "string" && /^bad request(?:\b|:)/i.test(message.trim())) ||
    hasBadRequestMessage(root) ||
    hasBadRequestMessage(envelope);

  if (!is400) return message !== undefined ? message : "Codex error";

  const fields = [
    code && `code=${code}`,
    type && `type=${type}`,
    requestId && `request_id=${requestId}`,
  ].filter(Boolean);
  const metadata = fields.length ? ` (${fields.join(", ")})` : "";
  const missing = [!code && "error code", !requestId && "request id"].filter(Boolean).join(" or ");
  const missingText = missing ? ` The provider returned no ${missing}.` : "";
  return (
    `Codex rejected this request with HTTP 400 Bad Request${metadata}.` +
    `${missingText} Possible causes include an oversized context or tool history, an invalid request ` +
    `payload, an unsupported model parameter, or a transient provider rejection. Retry once; if it ` +
    `repeats, start a new session or switch models, and check the orchestrator terminal for the raw diagnostic.`
  );
}
