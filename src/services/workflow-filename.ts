import { ValidationError } from "../utils/errors.js";

const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
const PERCENT_ESCAPE_RE = /%[0-9a-f]{2}/i;
const ENCODED_SEPARATOR_RE = /%(?:2f|5c)/i;
const MAX_PERCENT_DECODE_PASSES = 8;

function decodeWorkflowFilenameForValidation(filename: string): string {
  let decoded = filename;

  for (let pass = 0; pass <= MAX_PERCENT_DECODE_PASSES; pass++) {
    // ComfyUI's userdata route can decode the path after the request URL has
    // already been decoded once by the HTTP framework. Inspect every layer so
    // a caller cannot smuggle a separator through as `%252f`/`%255c`.
    if (ENCODED_SEPARATOR_RE.test(decoded)) {
      throw new ValidationError(
        `Invalid workflow filename "${filename}": percent-encoded path separators are not allowed.`,
      );
    }
    if (!PERCENT_ESCAPE_RE.test(decoded)) return decoded;

    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new ValidationError(
        `Invalid workflow filename "${filename}": malformed percent-encoding is not allowed.`,
      );
    }
    if (next === decoded) return decoded;
    decoded = next;
  }

  throw new ValidationError(
    `Invalid workflow filename "${filename}": too many layers of percent-encoding.`,
  );
}

/**
 * Return the canonical filename used by the ComfyUI workflow library.
 *
 * The library only exposes JSON workflows in its browser, recursive listing,
 * and autoload paths. A caller may omit the extension, but the name sent to
 * ComfyUI must still end in `.json`. The original spelling and case are kept
 * so existing names such as `VIDEO/Clip.JSON` remain addressable.
 */
export function normalizeWorkflowFilename(filename: string): string {
  if (typeof filename !== "string" || filename.trim().length === 0) {
    throw new ValidationError("Workflow filename must be a non-empty library-relative path.");
  }
  const decoded = decodeWorkflowFilenameForValidation(filename);
  if (CONTROL_CHARS_RE.test(decoded)) {
    throw new ValidationError("Workflow filename must not contain control characters or NUL bytes.");
  }
  if (decoded.includes("\\")) {
    throw new ValidationError(
      `Invalid workflow filename "${filename}": use forward slashes, not backslashes.`,
    );
  }
  if (decoded.startsWith("/") || /^[A-Za-z]:/.test(decoded) || decoded.includes(":")) {
    throw new ValidationError(
      `Invalid workflow filename "${filename}": it must be relative to ComfyUI's workflows directory.`,
    );
  }
  const segments = decoded.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new ValidationError(
      `Invalid workflow filename "${filename}": empty, ".", and ".." path segments are not allowed.`,
    );
  }

  return filename.toLowerCase().endsWith(".json") ? filename : `${filename}.json`;
}
