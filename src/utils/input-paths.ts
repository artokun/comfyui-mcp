import { ValidationError } from "./errors.js";

// ASCII control characters (incl. NUL) are never valid in a ComfyUI filename or
// output prefix and are a classic smuggling vector.
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

/**
 * Validate a user-supplied input-media filename (the `image` arg wired into a
 * LoadImage node). It must be a single path segment that lives in ComfyUI's
 * input dir — no separators, no traversal, no absolute/drive paths, no control
 * chars. Throws ValidationError on any violation.
 */
export function assertSafeInputFilename(value: string, label = "image"): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${label} is required.`);
  }
  if (CONTROL_CHARS_RE.test(value)) {
    throw new ValidationError(`${label} must not contain control characters or NUL bytes.`);
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new ValidationError(
      `Invalid ${label} "${value}": must be a single filename in ComfyUI's input dir, ` +
        "without path separators (upload it first with upload_image).",
    );
  }
  if (value === "." || value === ".." || value.includes("..")) {
    throw new ValidationError(`Invalid ${label} "${value}": '..' / traversal is not allowed.`);
  }
  if (/^[A-Za-z]:/.test(value)) {
    throw new ValidationError(`Invalid ${label} "${value}": absolute / drive paths are not allowed.`);
  }
}

/**
 * Validate a SaveImage/SaveVideo `filename_prefix`. ComfyUI allows a
 * forward-slash-joined relative subpath (e.g. "video/ltx-2.3"), so separators
 * are permitted, but absolute paths, backslashes, drive prefixes, ".." segments,
 * and control chars are rejected. Throws ValidationError on any violation.
 */
export function assertSafeFilenamePrefix(value: string, label = "filename_prefix"): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${label} must be a non-empty string when provided.`);
  }
  if (CONTROL_CHARS_RE.test(value)) {
    throw new ValidationError(`${label} must not contain control characters or NUL bytes.`);
  }
  if (value.includes("\\")) {
    throw new ValidationError(`Invalid ${label} "${value}": use forward slashes, not backslashes.`);
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new ValidationError(
      `Invalid ${label} "${value}": must be relative to ComfyUI's output dir, not absolute.`,
    );
  }
  if (value.split("/").some((seg) => seg === "..")) {
    throw new ValidationError(`Invalid ${label} "${value}": '..' segments are not allowed.`);
  }
}
