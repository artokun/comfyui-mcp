import { ValidationError } from "../utils/errors.js";

/**
 * Split an upload target into ComfyUI's two fields (#946).
 *
 * `filename` is the caller's whole intent — "clip.mp4" or "assets/clip.mp4" —
 * while ComfyUI's /upload/image wants a bare filename plus a separate
 * `subfolder`. Backslashes count as separators too: a caller on Windows
 * naturally writes "assets\clip.mp4".
 *
 * Traversal is REFUSED rather than sanitised. Silently rewriting "../../x.png"
 * into something safe would upload to a place the caller did not name and then
 * report the name they asked for — a wrong answer dressed as a right one. The
 * caller gets told instead.
 *
 * Lives in its own module because BOTH upload clients need it: client.ts (the
 * self-hosted /upload/image) and cloud-client.ts (the cloud twin) — and
 * cloud-client cannot import from client.ts without a circular import. The
 * one time this rule reached only one twin, the other kept the original #946
 * defect.
 */
export function splitUploadTarget(filename: string): { subfolder: string; name: string } {
  // A TRAILING separator has to be caught before the empty segments are filtered
  // out: "assets/" would otherwise leave ["assets"], and the directory would be
  // adopted as the filename — an upload to a name the caller never wrote.
  const endsInSeparator = /[/\\]\s*$/.test(filename);
  const parts = filename.split(/[/\\]+/).filter((p) => p !== "" && p !== ".");
  const name = endsInSeparator ? "" : (parts.pop() ?? "");
  if (name === "" || name === "..") {
    throw new ValidationError(
      `"${filename}" does not name a file to upload — it ends in a path separator or a "..". ` +
        `Pass a filename, optionally prefixed with a subfolder (e.g. "assets/clip.mp4").`,
    );
  }
  if (parts.some((p) => p === "..")) {
    throw new ValidationError(
      `"${filename}" walks outside ComfyUI's input directory with "..". ` +
        `A subfolder prefix may only go downwards (e.g. "assets/clip.mp4").`,
    );
  }
  return { subfolder: parts.join("/"), name };
}

/**
 * The upload body as something `new Blob([...])` accepts.
 *
 * `Buffer` is `Buffer<ArrayBufferLike>`, and `ArrayBufferLike` admits
 * `SharedArrayBuffer`, which `BlobPart` excludes — so `new Blob([data])` stops
 * compiling the moment @types/node reaches 26, even though every value we pass
 * is fine at runtime. Node only hands back a SharedArrayBuffer-backed Buffer if
 * you give it one, and neither upload path does.
 *
 * A VIEW, not a copy. These bodies are whole images and videos; `new
 * Uint8Array(data)` would satisfy the compiler by duplicating every byte.
 *
 * Same twin rule as splitUploadTarget above — both upload clients call it, and
 * cloud-client cannot import from client.ts.
 */
export function uploadBody(data: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
}
