import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, constants as fsConstants } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ModelError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { redactUrlForLogs } from "./download-auth.js";
import { reportDownloadProgress, type DownloadProgress } from "./download-progress.js";
import type { ResumeReporter } from "./download-resume-diag.js";
import {
  abortableDelay,
  backoffDelayMs,
  classifyDownloadFailure,
  downloadRetryPolicy,
} from "./download-retry.js";
import {
  cloudPrincipalKey,
  downloadCloudUrlToFile,
  supportsCloudDownload,
  type CloudStorageAuth,
} from "./storage/index.js";

const DEFAULT_CACHE_DIR = join(homedir(), ".comfyui-mcp", "cache");
const HASH_CHARS = 32;
const MAX_HTTP_REDIRECTS = 5;
const inflight = new Map<string, Promise<string>>();

/** Best-effort remove — never throws (rm may be stubbed in tests, or the file
 *  may already be gone). Used on the integrity-failure cleanup paths. */
async function safeRm(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    /* best effort */
  }
}

/** Remove `path`, returning true iff it is confirmed gone. Unlike `safeRm` this
 *  LOGS a removal failure (EPERM/EACCES/…) instead of swallowing it silently — a
 *  left-behind rejected artifact (a poisoned partial / cache entry) must at least be
 *  visible, since a later cache-hit or resume could otherwise re-hit it (#473 P1). */
async function rmOrLog(path: string, logUrl: string): Promise<boolean> {
  try {
    await rm(path, { force: true });
    return true;
  } catch (err) {
    logger.warn(
      `Failed to remove a rejected download artifact "${path}" — a retry may re-hit it; ` +
        `delete it manually if the same rejection repeats.`,
      { url: logUrl, error: err instanceof Error ? err.message : String(err) },
    );
    return false;
  }
}

/** Remove `path`; if removal fails, NEUTRALIZE it by truncating to 0 bytes. Returns
 *  true iff the path ends up removed OR emptied. A 0-byte partial is treated as fresh
 *  (not resumed) and a 0-byte cache/sidecar entry carries no resumable state, so
 *  zeroing is as safe as deleting. Logs (error) only when it can do NEITHER (#473 P1). */
async function rmOrTruncate(path: string, logUrl: string): Promise<boolean> {
  if (await rmOrLog(path, logUrl)) return true;
  try {
    await writeFile(path, "");
    return true;
  } catch (err) {
    logger.error(
      `Could not remove OR truncate a rejected download artifact "${path}"; a retry may re-serve ` +
        `or resume it. Delete this file manually.`,
      { url: logUrl, error: err instanceof Error ? err.message : String(err) },
    );
    return false;
  }
}

/** Discard a payload that was REJECTED as a non-model (HTML/JSON auth/error) body.
 *  Neutralizes BOTH the payload file AND its resume sidecar (remove, else truncate to
 *  0). A resume requires a NONZERO partial AND a valid (nonempty) sidecar, so zeroing
 *  or removing EITHER makes a retry decline the resume and restart clean — the
 *  guarantee holds as long as at least one of the two can be neutralized, not only
 *  when the partial itself can be deleted (#473 P1). A hard failure to neutralize is
 *  surfaced via the log inside rmOrTruncate. */
async function discardRejectedPayload(
  path: string,
  sidecarPath: string | undefined,
  logUrl: string,
): Promise<boolean> {
  const neutralized = await rmOrTruncate(path, logUrl);
  if (sidecarPath) await rmOrTruncate(sidecarPath, logUrl);
  return neutralized;
}

/** Drop a tiny "this partial was rejected as a non-model body" MARKER next to a
 *  resumable partial. Best-effort. It is the cleanup-INDEPENDENT signal that lets a
 *  later attempt refuse to resume even when the rejection was based ONLY on the
 *  response Content-Type (gone by retry) and both removal and truncation of the
 *  partial+sidecar failed — a case body-magic alone can't re-derive (#473 P1). */
async function writePoisonMarker(markerPath: string, logUrl: string): Promise<void> {
  try {
    await writeFile(markerPath, "rejected-non-model-payload");
  } catch (err) {
    logger.warn(`Could not write a poison marker "${markerPath}" for a rejected partial`, {
      url: logUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Path of the Content-Type sidecar beside a finalized CACHE file. A hidden dotfile
 *  (so LRU/readdir scans skip it) that records the response Content-Type, letting a
 *  later cache-HIT / coalesced caller re-run the #473 model-payload check WITH the
 *  original Content-Type instead of only body magic — closing the reuse gap where a
 *  Content-Type-only-flaggable body (its bytes don't sniff as text) could otherwise
 *  finalize as a model on a subsequent request. */
function cacheCtSidecar(cacheFilePath: string): string {
  return join(dirname(cacheFilePath), `.${basename(cacheFilePath)}.ct`);
}

/** True when a Content-Type is one the #473 gate would reject for a binary-model
 *  destination (an HTML page or a JSON document). Kept in lockstep with the
 *  Content-Type belt in detectNonModelPayload. */
function isRejectableContentType(contentType: string): boolean {
  return (
    /text\/html|application\/xhtml/i.test(contentType) || /(^|[/+])json\b/i.test(contentType)
  );
}

/** Reconcile the Content-Type sidecar beside a freshly-finalized cache file. Writes it
 *  ONLY for the reject-worthy shapes (text/html, application/json) — persisting every
 *  octet-stream/text-plain type would add a useless sidecar per cache entry, and only
 *  an HTML/JSON label can flag a body that body-magic alone would miss on reuse. For a
 *  NON-reject-worthy (e.g. octet-stream) fill it REMOVES any pre-existing sidecar: a
 *  clean model landing under a cache key that a prior HTML response had tagged
 *  `text/html` must not inherit that stale tag and be wrongly rejected on reuse (#473 —
 *  a false-positive against a legitimate model). */
async function writeCacheContentType(cacheFilePath: string, contentType: string): Promise<void> {
  const sidecar = cacheCtSidecar(cacheFilePath);
  if (!contentType || !isRejectableContentType(contentType)) {
    // Clear any stale sidecar so it can't attach to these clean bytes. Even if this
    // rm fails, the SIZE stamp below makes a stale sidecar self-invalidate on read.
    await rm(sidecar, { force: true }).catch(() => undefined);
    return;
  }
  try {
    // Stamp a fingerprint of the payload (size + a hash of its sniff head) alongside
    // the Content-Type. On read we honor the type only when that fingerprint still
    // matches the cache file — so a stale sidecar left behind after a clean re-fill
    // (different bytes ⇒ different head/size) is ignored and can NEVER reject a
    // legitimate model, regardless of whether the clearing rm above succeeded, AND
    // even in the astronomically-unlikely case where the replacement model has the
    // exact same byte LENGTH as the prior page (the head hash still differs) (#473 —
    // robust against the swallowed-delete false-positive).
    await writeFile(sidecar, `${contentType}\n${await payloadFingerprint(cacheFilePath)}`);
  } catch (err) {
    // Best effort — reuse falls back to body-magic-only validation, which still
    // catches every well-formed HTML/JSON page (only a synthetic body that sniffs
    // binary yet carries a text Content-Type would evade). Surface it rather than
    // swallow so the degraded reuse check is at least visible (#473).
    logger.warn(
      `Could not persist the Content-Type for a cached download at "${cacheFilePath}"; ` +
        `cache-reuse validation falls back to body magic only.`,
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
}

/** Read the persisted Content-Type for a cache file, or "" when absent/unreadable OR
 *  STALE. The sidecar stamps the payload size it was written for; if that size no
 *  longer matches the cache file on disk the sidecar describes DIFFERENT (since
 *  replaced) bytes and is ignored — so a leftover `text/html` tag can't reject a
 *  legitimate model that later re-filled the same cache slot (#473). */
async function readCacheContentType(cacheFilePath: string): Promise<string> {
  try {
    const raw = await readFile(cacheCtSidecar(cacheFilePath), "utf-8");
    const nl = raw.indexOf("\n");
    if (nl < 0) return ""; // no fingerprint (unexpected) → don't trust it
    const contentType = raw.slice(0, nl).trim();
    const stamped = raw.slice(nl + 1).trim();
    if (!contentType || !stamped) return "";
    const current = await payloadFingerprint(cacheFilePath);
    // Only honor the tag when it was stamped for the bytes currently on disk. A
    // mismatch (stale sidecar over re-filled bytes, or an unreadable head) yields "",
    // falling back to body magic — this can only ADD safety, never reject a real model.
    return stamped === current ? contentType : "";
  } catch {
    return "";
  }
}

/** A cheap content fingerprint of a cache file: its size plus a short hash of its
 *  sniff head. Distinguishes a re-filled cache slot from the bytes a Content-Type
 *  sidecar was written for — even at an identical byte length — without hashing a
 *  multi-GB payload in full. "" when the head can't be read (caller treats a
 *  mismatch as "don't trust the sidecar"). */
async function payloadFingerprint(cacheFilePath: string): Promise<string> {
  const size = await fileSizeOrUndefined(cacheFilePath);
  const head = await readHead(cacheFilePath);
  if (head === undefined) return "";
  const headHash = createHash("sha256").update(head).digest("hex").slice(0, 16);
  return `${size ?? ""}:${headHash}`;
}

/** On-disk size, or undefined when it can't be determined (fs layer stubbed in
 *  tests, or a stat hiccup) — callers must not block a download over a missing
 *  number, only over a number that proves corruption. */
async function fileSizeOrUndefined(path: string): Promise<number | undefined> {
  try {
    const st = await stat(path);
    return typeof st?.size === "number" ? st.size : undefined;
  } catch {
    return undefined;
  }
}

/** Destination extensions whose bytes MUST be a binary model payload — never an
 *  HTML page or a JSON document. A download that lands under one of these but whose
 *  body is actually an auth-challenge / error page is the #473 false-success class:
 *  a login HTML or `{"error":...}` JSON saved as `.safetensors`, reported as a green
 *  success, then failing at load time ("header too large"). Extensions NOT in this
 *  set (e.g. `.json`, `.yaml`, `.txt`, config sidecars) are left unvalidated so a
 *  legitimate text/JSON download is never rejected. */
// Superset of every BINARY model format the repo recognizes as a downloadable
// weight file — kept in sync with the recognizers in missing-models.ts (MODEL_EXTS)
// and workflow-converter.ts (the model-file regex). Intentionally EXCLUDES the
// textual formats those recognizers also allow (`.yaml`, `.json`): those legitimately
// contain text, so validating them as binary would reject a valid download.
const MODEL_BINARY_EXTS = new Set([
  ".safetensors",
  ".safetensor",
  ".sft",
  ".ckpt",
  ".pt",
  ".pt2",
  ".pth",
  ".bin",
  ".gguf",
  ".onnx",
  ".vae",
  ".pkl",
  ".npz",
  ".msgpack",
]);

/** How many leading bytes to sniff for a payload's shape. Enough to see an HTML
 *  doctype/tag or a JSON error envelope's opening structure without reading a
 *  multi-GB model in full. */
const PAYLOAD_SNIFF_BYTES = 512;

/** Read the first `n` bytes of a file WITHOUT loading the whole thing (models are
 *  multi-GB) — used to sniff a completed download's shape. Best-effort: returns
 *  undefined if the file can't be opened/read (never blocks a download over a read
 *  hiccup — the size gate has already run). */
async function readHead(path: string, n = PAYLOAD_SNIFF_BYTES): Promise<Buffer | undefined> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(path, "r");
    const buf = Buffer.alloc(n);
    // Loop: a single read() can return fewer bytes than requested even when more
    // are available; fill up to n (or EOF) so a short first read can't truncate the
    // sniff window and hide an HTML/JSON body after byte ~1.
    let off = 0;
    while (off < n) {
      const { bytesRead } = await fh.read(buf, off, n - off, off);
      if (bytesRead === 0) break; // EOF
      off += bytesRead;
    }
    return buf.subarray(0, off);
  } catch {
    return undefined;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** True when a run of bytes reads as a valid UTF-8 TEXT document (what an HTML page
 *  or JSON error IS) rather than binary model bytes. This is a real UTF-8 validation,
 *  not "any high byte counts as text": each non-ASCII byte must be a well-formed
 *  UTF-8 lead followed by valid continuation bytes, and NUL / C0 control bytes
 *  (except the text whitespace controls TAB/LF/VT/FF/CR) hard-fail. Random binary that happens to start with `<`/`{`/`[`
 *  almost immediately hits an invalid UTF-8 lead byte (0x80–0xC1 and 0xF5–0xFF — ~26%
 *  of all byte values) or a control byte, so it is correctly kept binary; a safetensors
 *  whose LE header length is 60 (0x3C='<') is followed by NUL padding and fails at once.
 *  A multibyte sequence truncated by the end of the sniff window is accepted (we only
 *  sampled a prefix), never treated as invalid. */
function looksLikeText(slice: Buffer): boolean {
  const n = slice.length;
  if (n === 0) return false;
  let i = 0;
  while (i < n) {
    const b = slice[i];
    if (b < 0x80) {
      // ASCII: printable + the standard text whitespace controls TAB(0x09) LF(0x0a)
      // VT(0x0b) FF(0x0c) CR(0x0d). A form-feed / vertical-tab is valid HTML/XML
      // whitespace, so a real login page like `<html>\f<body>…` MUST still read as
      // text (else it slips through as "binary" and finalizes as a model — #473
      // P0-1). Any OTHER C0 control (NUL etc.) ⇒ not text.
      if ((b >= 0x09 && b <= 0x0d) || (b >= 0x20 && b <= 0x7e)) {
        i += 1;
        continue;
      }
      return false;
    }
    // Multibyte lead byte → determine the sequence length; invalid leads reject.
    let len: number;
    if (b >= 0xc2 && b <= 0xdf) len = 2;
    else if (b >= 0xe0 && b <= 0xef) len = 3;
    else if (b >= 0xf0 && b <= 0xf4) len = 4;
    else return false; // 0x80–0xC1 (bare continuation / overlong) or 0xF5–0xFF
    // Strict continuation ranges reject overlong / surrogate / out-of-range forms:
    //   E0 → A0..BF (else overlong), ED → 80..9F (else surrogate),
    //   F0 → 90..BF (else overlong), F4 → 80..8F (else > U+10FFFF).
    const lo = b === 0xe0 ? 0xa0 : b === 0xf0 ? 0x90 : 0x80;
    const hi = b === 0xed ? 0x9f : b === 0xf4 ? 0x8f : 0xbf;
    // Validate EVERY continuation byte that is PRESENT, even when the sequence is
    // truncated by the sniff window: an already-visible byte that violates its range
    // (e.g. `E0 80` — E0 requires A0..BF) proves the run is NOT valid UTF-8 and must
    // reject, rather than being waved through as "truncated". Only a genuinely
    // cut-off sequence — where we simply ran out of bytes before an INVALID one — is
    // accepted (we only sampled a prefix). This closes a boundary false-positive that
    // would misclassify a raw `.bin` as text/HTML (#473 P0-2 sniff-edge).
    for (let k = 1; k < len; k += 1) {
      if (i + k >= n) return true; // ran out of bytes with everything valid so far
      const cont = slice[i + k];
      const clo = k === 1 ? lo : 0x80;
      const chi = k === 1 ? hi : 0xbf;
      if (cont < clo || cont > chi) return false; // present-but-invalid continuation
    }
    i += len;
  }
  return true;
}

/** Classify a sniffed payload head as an HTML page, a JSON document, or opaque
 *  binary. Skips a UTF-8 BOM and leading ASCII whitespace, then requires the run
 *  that follows to read as TEXT before declaring html/json — so a binary model that
 *  merely starts with byte `<`/`{`/`[` (e.g. a safetensors whose LE header length is
 *  60=0x3C or 91=0x5B, followed by NUL padding) is correctly kept as "binary":
 *   - leading `<` + text ⇒ "html"
 *   - leading `{`/`[` + text ⇒ "json"
 *   - anything else ⇒ "binary" (a real model payload). */
/** Classify an already-DECODED text string (used for UTF-16 bodies): skips leading
 *  whitespace, then a `<` ⇒ html / `{`|`[` ⇒ json when the run that follows is clean
 *  text (no NUL / C0 control). A binary payload that merely decoded to a leading
 *  `<`/`{` (e.g. a safetensors whose UTF-16 decode yields `<` then U+0000) fails the
 *  text check and stays binary. */
function classifyDecodedText(s: string): "html" | "json" | "binary" {
  let j = 0;
  // Skip leading text whitespace INCLUDING VT/FF (\v \f) — an auth page can begin with
  // a form-feed before the `<`/`{` (`\f<!DOCTYPE html>`); if we stopped at it the char
  // scrutinized would be the control byte, not the tag, and the page would misclassify
  // as binary (#473 P0-1).
  while (j < s.length) {
    const cp = s.charCodeAt(j);
    if (cp === 0x20 || (cp >= 0x09 && cp <= 0x0d)) j += 1;
    else break;
  }
  if (j >= s.length) return "binary";
  const ch = s[j];
  // Require the WHOLE decoded run (not just the first 64 chars) to be clean text
  // before declaring html/json: a binary payload that merely decoded to a leading
  // `<`/`{` but then hits control/replacement chars must stay binary (#473 P0-2).
  const rest = s.slice(j);
  const isText = (() => {
    for (const c of rest) {
      const cp = c.codePointAt(0)!;
      if (cp >= 0x09 && cp <= 0x0d) continue; // TAB/LF/VT/FF/CR — text whitespace
      if (cp < 0x20 || cp === 0xfffd) return false; // NUL/C0 control or replacement char
    }
    return true;
  })();
  if (ch === "<") return isText ? "html" : "binary";
  if (ch === "{" || ch === "[") return isText ? "json" : "binary";
  return "binary";
}

function classifyPayload(buf: Buffer): "html" | "json" | "binary" {
  // A UTF-16 BOM (FF FE = LE, FE FF = BE) marks a text document — an HTML/JSON auth
  // page can be served UTF-16 (e.g. `text/html; charset=utf-16`, bytes FF FE 3C 00).
  // Decode and classify as text so it isn't mistaken for binary. A binary model that
  // coincidentally starts with a BOM byte pair decodes to control chars → stays binary.
  if (
    buf.length >= 2 &&
    ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
  ) {
    try {
      const label = buf[0] === 0xff ? "utf-16le" : "utf-16be";
      // Trim bytes the sniff window cut mid-code-unit BEFORE decoding, so a truncation
      // artifact doesn't decode to U+FFFD and make a valid UTF-16 page look binary:
      //  (1) an odd trailing byte (a half code unit), and (2) a trailing UNPAIRED high
      //  surrogate (0xD800–0xDBFF) whose low half fell outside the window — e.g. an
      //  emoji split across the 512-byte boundary. A mid-document U+FFFD (genuine
      //  binary) is still caught by classifyDecodedText (#473 P0-1 sniff-edge).
      let end = buf.length - (buf.length % 2);
      if (end >= 2) {
        const hi = label === "utf-16le" ? buf[end - 1] : buf[end - 2];
        const loB = label === "utf-16le" ? buf[end - 2] : buf[end - 1];
        const lastUnit = (hi << 8) | loB;
        if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 2; // drop lone high surrogate
      }
      return classifyDecodedText(new TextDecoder(label).decode(buf.subarray(0, end)));
    } catch {
      return "binary";
    }
  }
  let i = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3; // UTF-8 BOM
  // Skip leading text whitespace INCLUDING VT(0x0b)/FF(0x0c) — a login page may open
  // with a form-feed before the `<` (`\f<!DOCTYPE html>`). Stopping at that control
  // byte would scrutinize it instead of the tag and misclassify the page as binary
  // (#473 P0-1).
  while (
    i < buf.length &&
    (buf[i] === 0x20 || (buf[i] >= 0x09 && buf[i] <= 0x0d))
  ) {
    i += 1;
  }
  if (i >= buf.length) return "binary";
  const c = buf[i];
  // Require the WHOLE sniffed run — the entire remaining head, not just the first 64
  // bytes — to read as valid text before declaring html/json. A raw binary whose head
  // merely STARTS with `<`/`{`/`[` but turns to non-text bytes further in (e.g. a .bin
  // that begins `<AAA…` then has NUL/high bytes) must be ACCEPTED as a model, not
  // rejected on a one-byte lead over a tiny window (#473 P0-2). A genuine HTML/JSON
  // auth page is text throughout the sniff window, so it still classifies correctly.
  const rest = buf.subarray(i);
  if (c === 0x3c) return looksLikeText(rest) ? "html" : "binary"; // '<'
  if (c === 0x7b || c === 0x5b) return looksLikeText(rest) ? "json" : "binary"; // '{' or '['
  return "binary";
}

/** Given a completed download's sniffed head + Content-Type, decide whether the
 *  bytes are an auth/error page masquerading as a model file (#473). Returns the
 *  offending kind, or null when the payload is an acceptable model binary (or the
 *  destination isn't a model-binary extension, so this validation doesn't apply).
 *
 *  Two independent signals, EITHER of which rejects:
 *   1. Body magic — an HTML page's leading `<` (over a whole-window text run) and a
 *      JSON error's leading `{`/`[` are present regardless of how the server labels
 *      the response, so body magic catches an auth/error page even when mislabeled
 *      `application/octet-stream`. (fetch() transparently decompresses gzip/br, so a
 *      compressed error page still sniffs as its decoded HTML/JSON here.)
 *   2. Content-Type — a `text/html`/`application/xhtml` or `application/json` label
 *      on a binary-model destination is itself proof of an auth/error document, so it
 *      rejects EVEN when the body failed to sniff as text (a stray control byte, an
 *      exotic charset, or a truncating proxy — #473 P0-1). Real model hosts never
 *      label a weight file text/html or application/json, so this can't reject a
 *      legitimate binary (whose Content-Type is octet-stream or similar). */
function detectNonModelPayload(
  head: Buffer | undefined,
  contentType: string,
  modelExt: string,
): "html" | "json" | null {
  if (!modelExt || !MODEL_BINARY_EXTS.has(modelExt.toLowerCase())) return null;
  const kind = head ? classifyPayload(head) : "binary";
  if (kind === "html") return "html";
  if (kind === "json") return "json";
  // Content-Type is AUTHORITATIVE for the two textual auth/error shapes. A server
  // that LABELS a response `text/html`/`application/xhtml` or `application/json` for
  // a binary-model destination is serving a login/auth or API-error document, never
  // a weight file — so reject it EVEN when the body itself failed to sniff as text
  // (a stray control byte, an exotic charset, or a truncating proxy could otherwise
  // let a genuine HTML/JSON page slip through as "binary" — #473 P0-1). Real model
  // hosts serve weights as application/octet-stream (or similar), never as text/html
  // or application/json, so this can't reject a legitimate binary. (The body-magic
  // checks above already caught the common octet-stream-mislabeled auth page.)
  if (/text\/html|application\/xhtml/i.test(contentType)) return "html";
  if (/(^|[/+])json\b/i.test(contentType)) return "json";
  return null;
}

/** Actionable error for a rejected auth/error payload (#473). Names the concrete
 *  failure (an HTML page / JSON error saved as a model) and, for CivitAI, the exact
 *  fix (set/refresh the API token) — because a 200-with-auth-challenge is precisely
 *  what CivitAI returns for a missing/invalid key or a gated model, and Manager /
 *  a bare fetch would otherwise save that page under the `.safetensors` name. */
function nonModelPayloadError(
  kind: "html" | "json",
  url: string,
  logUrl: string,
): ModelError {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* logUrl is used for reporting; host is only for the CivitAI hint */
  }
  const isCivitai = /(^|\.)civitai\.com$/i.test(host);
  const what =
    kind === "html"
      ? "an HTML page (an authentication/login or error page)"
      : "a JSON document (an API error or auth challenge)";
  const civitaiHint = isCivitai
    ? " CivitAI returns an auth challenge like this when no valid token is sent — set or refresh " +
      "CIVITAI_API_TOKEN (panel Settings › “Set CivitAI token…”, or the env var; create one at " +
      "civitai.com/user/account) and retry. Note: on a REMOTE ComfyUI target the token is NOT " +
      "forwarded to ComfyUI-Manager, so a locally-set token does not fix a remote Manager download."
    : "";
  return new ModelError(
    `Download rejected: the server returned ${what}, not a model file, but the destination is a ` +
      `binary model file. Refusing to save it as a model (it would land as a corrupt file under a ` +
      `false success and fail at load time, e.g. "header too large").${civitaiHint}`,
    { url: logUrl },
  );
}

/** Validate that a COMPLETED file at `targetPath` is a real model payload — not an
 *  HTML/JSON auth/error page — when the destination is a binary-model extension
 *  (#473). FAILS CLOSED: an offending payload OR an unreadable-for-sniffing file (we
 *  can't confirm it) throws, after `onReject` cleans up, so a corrupt file is never
 *  finalized under a success. A no-op for non-model destinations. `contentType` is a
 *  secondary signal (empty on cache-hit/cloud paths, where only the bytes are known). */
async function assertModelPayloadOrThrow(opts: {
  targetPath: string;
  modelExt: string;
  contentType: string;
  url: string;
  logUrl: string;
  onReject?: () => Promise<void>;
  /** Defaults to TRUE for every finalize path (HTTP, cache-hit, cloud S3/Azure): an
   *  unreadable/empty sniff head leaves the payload UNVERIFIED and is REJECTED —
   *  cannot verify ⇒ do not finalize (#473 P0-3). (A genuinely 0-byte download is
   *  already rejected upstream by assertComplete / the cache-hit 0-byte guard, so
   *  fail-closed here only trips on a nonzero file we couldn't read.) The flag is kept
   *  as a seam for callers/tests that need best-effort behavior, but no production
   *  path passes false. */
  failClosed?: boolean;
}): Promise<void> {
  const { targetPath, modelExt, contentType, url, logUrl, failClosed = true } = opts;
  if (!modelExt || !MODEL_BINARY_EXTS.has(modelExt.toLowerCase())) return;
  const head = await readHead(targetPath);
  // An unreadable OR unexpectedly-empty head (a non-empty file that read 0 bytes
  // under an fs race) leaves the payload UNVERIFIED. On the fail-closed paths refuse
  // to finalize it rather than trust it (#473/#467); on the best-effort cloud path,
  // skip. (A genuinely 0-byte download is already rejected upstream by assertComplete
  // / the cache-hit 0-byte guard.)
  if (head === undefined || head.length === 0) {
    if (!failClosed) return;
    await opts.onReject?.();
    throw new ModelError(
      `Download could not be verified: the completed file could not be read to confirm it is a ` +
        `model payload (and not an HTML/JSON auth/error page). Not finalizing it as a model; retry.`,
      { url: logUrl },
    );
  }
  const kind = detectNonModelPayload(head, contentType, modelExt);
  if (!kind) return;
  await opts.onReject?.();
  throw nonModelPayloadError(kind, url, logUrl);
}

/** Verdict from a pre-dispatch probe of what a server-side (ComfyUI-Manager) fetch
 *  will land — see {@link probeRemoteModelPayload}. */
export interface RemotePayloadProbe {
  /** "non-model": a DEFINITIVE auth/error payload — the caller MUST refuse to dispatch.
   *  "model": the first bytes look like real model binary — safe to dispatch.
   *  "inconclusive": ANY uncertainty (network error/timeout, a non-auth error status,
   *  an unsniffable body, or a non-model-binary destination) — the caller must NOT
   *  refuse, so the probe can never block a download that might be legitimate. */
  verdict: "non-model" | "model" | "inconclusive";
  /** The offending shape when a body/Content-Type signal drove a "non-model" verdict.
   *  Absent for a bare 401 with no classifiable body. */
  kind?: "html" | "json";
  /** The probe response status, when a response was received. */
  status?: number;
}

/** Ceiling on the pre-dispatch probe. Kept short: it reads only the sniff window and a
 *  hung probe must never wedge a download — on timeout it returns "inconclusive" and
 *  the dispatch proceeds exactly as it does today. */
const REMOTE_PROBE_TIMEOUT_MS = 12_000;

/** Read up to `n` bytes from a fetch Response body, then cancel the stream so a
 *  multi-GB file is NEVER drained by the probe. Returns the bytes read (may be shorter
 *  than `n`), or undefined when there is no readable body. */
async function readResponseHead(res: Response, n: number): Promise<Buffer | undefined> {
  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    // No stream (e.g. a minimal stubbed Response) — fall back to a bounded buffer read.
    try {
      const ab = await res.arrayBuffer();
      const buf = Buffer.from(ab);
      return buf.length ? buf.subarray(0, n) : undefined;
    } catch {
      return undefined;
    }
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < n) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        // Cap what we buffer to the sniff window: a server that ignores Range and streams
        // a large first chunk must not make us hold it all in memory (we only need n bytes).
        const take = value.length > n - total ? value.subarray(0, n - total) : value;
        chunks.push(Buffer.from(take));
        total += take.length;
      }
    }
  } catch {
    // A partial read is fine — classification runs on whatever prefix we got.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return total === 0 ? undefined : Buffer.concat(chunks).subarray(0, n);
}

/** The raw shape of one probe fetch — used to compare an unauthenticated fetch against
 *  a credentialed one (the flip test). */
interface PayloadSniff {
  /** A response was received (the fetch itself did not throw/timeout). */
  ok: boolean;
  status?: number;
  /** Body/Content-Type classification via the #473 classifier: an auth/error page shape. */
  kind: "html" | "json" | null;
  /** A SUCCESS (2xx) response whose first bytes are real model binary (not html/json). */
  isModelBinary: boolean;
}

const PROBE_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Parse an origin, or null when the URL is unparseable (treated as a DIFFERENT origin —
 *  i.e. auth is stripped, the safe default). */
function safeOrigin(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

/**
 * One bounded, Range-limited probe of `url`, classified with the SAME #473 classifier the
 * local finalize gate uses. Never throws — a network error/timeout/abort yields
 * `{ ok: false }`. `signal` is the caller-composed abort+timeout (owned by the caller so a
 * single budget bounds BOTH probes).
 *
 * CREDENTIAL SAFETY (do not regress): redirects are followed MANUALLY (never
 * `redirect: "follow"`, which re-sends arbitrary custom auth headers like `X-API-Key`
 * across origins). `authHeaders` — which can include ANY caller header — are sent ONLY to
 * the ORIGINAL target origin; the FIRST time a redirect leaves that origin, ALL auth
 * headers are dropped for the rest of the chain (only `Range` is retained), mirroring the
 * local downloader. A caller credential is therefore never sent to any host but the one the
 * caller addressed.
 */
async function sniffPayloadShape(
  url: string,
  modelExt: string,
  authHeaders: Record<string, string> | undefined,
  signal: AbortSignal,
): Promise<PayloadSniff> {
  const rangeHeader = { Range: `bytes=0-${PAYLOAD_SNIFF_BYTES - 1}` };
  const hasAuth = !!authHeaders && Object.keys(authHeaders).length > 0;
  const originalOrigin = safeOrigin(url);
  let currentUrl = url;
  let authStripped = false; // once we leave the original origin, never re-send auth
  for (let hop = 0; hop <= MAX_HTTP_REDIRECTS; hop++) {
    const sendAuth = hasAuth && !authStripped;
    let res: Response;
    try {
      res = await fetch(currentUrl, {
        // Manual redirects (see CREDENTIAL SAFETY above) — never "follow". Range-limit to
        // the sniff window so a multi-GB model is never pulled.
        redirect: "manual",
        headers: sendAuth ? { ...rangeHeader, ...authHeaders } : rangeHeader,
        signal,
      });
    } catch {
      return { ok: false, kind: null, isModelBinary: false };
    }
    if (!res || typeof res.status !== "number") return { ok: false, kind: null, isModelBinary: false };
    const location =
      typeof res.headers?.get === "function" ? res.headers.get("location") : null;
    if (PROBE_REDIRECT_STATUSES.has(res.status) && location) {
      // Drain the (usually empty) redirect body so the socket is released.
      try {
        await (res.body as ReadableStream | null | undefined)?.cancel?.();
      } catch {
        /* ignore */
      }
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        return { ok: false, kind: null, isModelBinary: false };
      }
      // Cross-origin relative to the ORIGINAL target (or an unparseable next URL) → strip
      // ALL auth for the remainder of the chain. Never send a caller credential elsewhere.
      if (safeOrigin(nextUrl) !== originalOrigin) authStripped = true;
      currentUrl = nextUrl;
      continue;
    }
    // Terminal (non-redirect) response → classify its first bytes.
    const status = res.status;
    const contentType =
      (typeof res.headers?.get === "function" ? res.headers.get("content-type") : "") ?? "";
    let head: Buffer | undefined;
    try {
      head = await readResponseHead(res, PAYLOAD_SNIFF_BYTES);
    } catch {
      head = undefined;
    }
    const kind = detectNonModelPayload(head, contentType, modelExt);
    const isSuccess = status === 200 || status === 206;
    const isModelBinary = isSuccess && !kind && !!head && head.length > 0;
    return { ok: true, status, kind, isModelBinary };
  }
  // Redirect limit exceeded — treat as unresolvable (inconclusive).
  return { ok: false, kind: null, isModelBinary: false };
}

/**
 * PREDICT what a server-side ComfyUI-Manager fetch of `url` will land, WITHOUT
 * downloading the whole file, so a REMOTE dispatch can fail loudly BEFORE Manager
 * saves an auth/login/error page under a `.safetensors` name and reports success
 * (#473 remote residual — the local finalize gate above can't run on the remote path,
 * where the MCP never sees the bytes and has no way to sniff or delete the landed file).
 *
 * The MCP probes from a DIFFERENT network vantage than the ComfyUI host, so a raw
 * "unauthenticated fetch returned HTML" is NOT proof the host would land HTML — a
 * location-specific WAF/geo interstitial could hit the MCP while the host gets a real
 * model. To avoid ever blocking a download that could succeed, this gate refuses ONLY on
 * a signal that is provably AUTH-based and therefore IP-INDEPENDENT: a credential FLIP.
 *
 *   1. Probe UNAUTHENTICATED — exactly what Manager's server-side fetch does. If that
 *      already returns real model binary, the URL is public → dispatch (verdict "model").
 *   2. Otherwise (auth page / 401 / non-2xx / empty), fetch the SAME url WITH the
 *      credential the LOCAL path would apply (`opts.authHeaders` — the CivitAI/HF token or
 *      explicit auth that Manager can NEVER receive). If THAT returns real model binary,
 *      the credential — not the vantage point — is what unlocks it: the URL is
 *      AUTHENTICATION-GATED and Manager (tokenless) WILL land the auth/error page →
 *      verdict "non-model" (block). This is exactly the reported bug (a local token that
 *      is not forwarded to a remote Manager).
 *   3. Any other outcome — no credential to test, the credential did not flip it (an
 *      invalid token, or a location interstitial that ignores the header), or a network
 *      error — is "inconclusive": we cannot PROVE auth-gating, so we never hard-block.
 *
 * Because a block requires the credential to flip the SAME url from non-model to model,
 * it can never refuse a download that would have succeeded via Manager (a public model
 * returns binary on the first, unauthenticated probe; a location interstitial does not
 * flip on a bearer header). Not applicable to a non-model-binary destination (returns
 * "inconclusive"), matching the local gate.
 */
export async function probeRemoteModelPayload(
  url: string,
  modelExt: string | undefined,
  signal?: AbortSignal,
  opts?: {
    /** The auth HEADERS the LOCAL download path would apply for this url (explicit auth,
     *  or the auto HF/CivitAI host-token). The flip test uses them to prove auth-gating;
     *  Manager itself can never receive them. */
    authHeaders?: Record<string, string>;
  },
): Promise<RemotePayloadProbe> {
  if (!modelExt || !MODEL_BINARY_EXTS.has(modelExt.toLowerCase())) {
    return { verdict: "inconclusive" };
  }
  // ONE shared abort budget for BOTH probes (they run sequentially): compose the caller's
  // abort with a single hard timeout MANUALLY (never AbortSignal.any — unavailable on older
  // runtimes), so the TOTAL probe time is bounded by REMOTE_PROBE_TIMEOUT_MS, not 2x, and a
  // stalled probe can never hang the dispatch. Unref'd (never keeps the process alive),
  // cleared in `finally`.
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort();
  const timer = setTimeout(() => controller.abort(), REMOTE_PROBE_TIMEOUT_MS);
  if (typeof (timer as { unref?: unknown }).unref === "function") timer.unref();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  try {
    // (1) Unauthenticated probe — what Manager will actually do.
    const unauth = await sniffPayloadShape(url, modelExt, undefined, controller.signal);
    if (!unauth.ok) return { verdict: "inconclusive" };
    if (unauth.isModelBinary) return { verdict: "model", status: unauth.status };

    // (2) The unauthenticated fetch did NOT yield a clean model. Only warn on a credential
    // FLIP, and ONLY when the unauth response is a CLEAR auth page — an HTML/JSON body
    // (`kind` set) on a NON-transient status. A transient 429/5xx (or an ambiguous empty /
    // bare-status response) is NOT proof of gating: a public URL that momentarily 503s and
    // then serves the model on the credentialed retry must NOT cry wolf. Those stay
    // inconclusive.
    const status = unauth.status ?? 0;
    const transient = status === 429 || (status >= 500 && status <= 599);
    const clearAuthPage = (unauth.kind === "html" || unauth.kind === "json") && !transient;
    const authHeaders = opts?.authHeaders;
    if (clearAuthPage && authHeaders && Object.keys(authHeaders).length > 0) {
      const authed = await sniffPayloadShape(url, modelExt, authHeaders, controller.signal);
      if (authed.ok && authed.isModelBinary) {
        // The credential turns the SAME url from a clear auth page into a real model →
        // AUTH-GATED, and the credential is what unlocks it. Manager, which can't carry it,
        // will land the auth/error page. Report the UNAUTHENTICATED body shape (what Manager
        // sees). This is a WARNING signal for the caller — never a refusal.
        return { verdict: "non-model", kind: unauth.kind ?? undefined, status: unauth.status };
      }
    }
    // (3) No clear auth page, no credential, no flip, or a network/transient outcome — we
    // cannot prove auth-gating, so stay inconclusive (never warn, never block).
    return { verdict: "inconclusive", status: unauth.status };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onCallerAbort);
  }
}

/** POSITIVELY true only when `path` is confirmed discarded — it no longer exists
 *  (stat throws ENOENT) or exists but is empty (size 0). A non-ENOENT stat error
 *  (a transient fs hiccup) or a still-present non-empty file returns false, so a
 *  swallowed removal failure is never mistaken for a completed discard (#467). */
async function partialConfirmedDiscarded(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return typeof st?.size === "number" && st.size === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT";
  }
}

/**
 * Extract the useful diagnostic bits from an error thrown by `fetch()` itself
 * (a network-layer failure, not an HTTP status). undici surfaces these as
 * `TypeError: fetch failed` whose real reason lives on `.cause` (an Error with
 * a `code`/`errno` such as ENOTFOUND, ECONNRESET, UND_ERR_CONNECT_TIMEOUT, or
 * a TLS `ERR_TLS_CERT_ALTNAME_INVALID`). The top-level message is the useless
 * generic "fetch failed" (issue #411) — the actionable detail is one level
 * down, so unwrap the cause chain into a single readable string.
 */
function describeFetchError(err: unknown): { message: string; code?: string } {
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

/**
 * Fetch that converts a network-layer failure into a ModelError carrying the
 * unwrapped `cause` — so a Hugging Face Xet / CAS host that fails DNS, TLS, a
 * connect timeout, or a proxy reset reports WHY instead of a bare "fetch
 * failed" (issue #411). HTTP responses (any status) pass straight through; only
 * a thrown fetch is wrapped. The ModelError is rethrown as-is by downloadWithCache
 * (it never masks a ModelError), so the actionable cause reaches the tool result.
 */
async function fetchOrThrow(
  url: string,
  init: RequestInit,
  logUrl: string,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const { message, code } = describeFetchError(err);
    throw new ModelError(
      `Download request to the model host failed at the network layer: ${message}. ` +
        `This is a connectivity/TLS/proxy failure reaching the file host (for Hugging Face ` +
        `this is often the Xet/CAS CDN, e.g. cas-bridge.xethub.hf.co) — not an HTTP error. ` +
        `Check DNS/connectivity to the host, any corporate proxy or firewall, and system time/TLS certs; ` +
        `set HF_ENDPOINT to a reachable mirror if huggingface.co is blocked in your region, then retry.`,
      { url: logUrl, code, cause: message },
    );
  }
}

export const downloadCacheFs = {
  copyFile,
  link,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  utimes,
};

/** Identifies a download for the panel progress tray (id = stable key, name =
 *  the friendly file name). Absent for internal/cache-only callers. */
export interface ProgressMeta {
  id: string;
  name: string;
  /** Attempt generation/epoch (panel#489): the epoch-ms this download attempt began.
   *  Stamped onto every progress row so the orchestrator can drop a late terminal row
   *  from a SUPERSEDED attempt (a same-URL retry reuses the deterministic id). */
  attempt?: number;
}

export interface DownloadCacheOptions {
  url: string;
  headers: Record<string, string>;
  targetPath: string;
  logUrl?: string;
  storageAuth?: CloudStorageAuth;
  progress?: ProgressMeta;
  /** Sink for this download's resume decision, reported to the CALLER (the job)
   *  so it stores the outcome on itself — never in a shared keyed map that could
   *  misattribute it to another job (#467). Not called on a coalesced/cache-hit
   *  path (no physical resume happened). */
  onResume?: ResumeReporter;
  /** Per-download abort signal (#515), threaded into the fetch + stream pipeline so
   *  cancel_download aborts exactly this transfer. On abort the partial is left on
   *  disk (resumable) and is NEVER renamed to the destination — no false-complete. */
  signal?: AbortSignal;
  /** Fired SYNCHRONOUSLY the instant the completed, validated file is renamed into its
   *  destination (#515). The job commits "done" here — BEFORE any later await (LRU
   *  eviction, stat) — so there is NO window where the file exists at the destination
   *  yet the job still reads "downloading" and a cancel could falsely mark it cancelled.
   *  Not fired for the remote Manager path (no local rename); that commits done when
   *  downloadModel returns. */
  onLanded?: (targetPath: string) => void;
}

export interface DownloadCacheResult {
  targetPath: string;
  usedCache: boolean;
  cachePath?: string;
  materializedBy?: "hardlink" | "copy";
}

function cacheDir(): string {
  return resolve(process.env.COMFYUI_DOWNLOAD_CACHE_DIR || DEFAULT_CACHE_DIR);
}

function cacheSizeLimitBytes(): number {
  const raw = Number(process.env.COMFYUI_LRU_CACHE_SIZE_GB ?? "0");
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw * 1024 * 1024 * 1024;
}

/** Representation-affecting request headers, folded into the cache identity so a
 *  same-URL fetch carrying DIFFERENT auth/headers (two users' Bearer tokens, a
 *  Cookie/API-key, or ANY custom header like `X-Custom-Auth` that selects a
 *  user-scoped or gated representation) can NEVER share a cache entry / in-flight
 *  stream and install the wrong bytes (#467 P1-2). Query-param auth already
 *  varies the URL itself (applyDownloadAuth folds it in), so this covers the
 *  header case the URL can't. Hashes EVERY caller-supplied header (an allowlist
 *  would silently miss custom auth headers) — these are the request headers built
 *  from the caller's auth/config, NOT the volatile hop headers (Range/If-Range),
 *  which are added later inside streamUrlToFile and never reach here. Empty ⇒ no
 *  header line is added to the identity (the URL still carries the v2 namespace). */
function representationKey(headers: Record<string, string>): string {
  const relevant = Object.keys(headers)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((k) => `${k.toLowerCase()}=${headers[k]}`)
    .join("\n");
  return relevant ? createHash("sha256").update(relevant).digest("hex").slice(0, 12) : "";
}

/** Cache-identity namespace. Bumped when the identity SCHEME changes so entries
 *  from an older scheme can never be served under the new one. Critically this
 *  fixes a cross-auth leak (#467 P1-C): the PRE-header-aware code cached
 *  header-authenticated downloads under the BARE URL, so without a namespace a
 *  post-upgrade UNAUTHENTICATED caller (also bare-URL) could be served bytes that
 *  were cached earlier under someone's auth. We can't tell a legacy entry's
 *  provenance, so ALL new identities — authed AND unauthed — are prefixed, which
 *  orphans every legacy `sha256(url)` entry (a one-time re-download; orphans age
 *  out via LRU when COMFYUI_LRU_CACHE_SIZE_GB is set, else are inert on disk). */
const CACHE_NS = "v2";

function cacheIdentity(
  url: string,
  headers: Record<string, string>,
  storageAuth?: CloudStorageAuth,
): string {
  const repr = representationKey(headers);
  // The EFFECTIVE cloud principal (explicit storageAuth MERGED with env creds/
  // endpoint/region), not just explicit storageAuth — so an env-authenticated cloud
  // entry can't be served later under different/absent creds (#467 P1-B).
  const cloud = supportsCloudDownload(url) ? cloudPrincipalKey(url, storageAuth) : "";
  // Namespaced for BOTH authed and unauthed so neither can collide with a legacy
  // bare-URL entry of unknown auth provenance (#467 P1-C). Representation-affecting
  // HTTP headers AND cloud credentials each add a line so different auth can never
  // share bytes (#467 P1-2). Empty discriminators are omitted, so unauthenticated
  // public downloads stay stable under the v2 namespace.
  let id = `${CACHE_NS}\n${url}`;
  if (repr) id += `\n${repr}`;
  if (cloud) id += `\ncloud:${cloud}`;
  return id;
}

function cachePathForUrl(
  url: string,
  headers: Record<string, string> = {},
  storageAuth?: CloudStorageAuth,
): string {
  const hash = createHash("sha256")
    .update(cacheIdentity(url, headers, storageAuth))
    .digest("hex")
    .slice(0, HASH_CHARS);
  let extension = "";
  try {
    extension = extname(basename(new URL(url).pathname));
  } catch {
    // Callers validate URLs before reaching this layer; keep the cache helper
    // defensive so fallback direct downloads can still surface the real error.
  }
  return join(cacheDir(), `${hash}${extension}`);
}

async function touch(path: string): Promise<void> {
  const now = new Date();
  await downloadCacheFs.utimes(path, now, now);
}

/** A parsed resume sidecar: the change-detection validator (ETag / X-Linked-Etag /
 *  Last-Modified) and, when the first attempt knew it, the AUTHORITATIVE full-file
 *  size. The size lets a later resume reject a 206 whose Content-Range total
 *  DISAGREES with what the original response declared — a server that understates
 *  the total on resume (e.g. `bytes 4-7/8` for a file first seen as 4096) can no
 *  longer finalize a short prefix as complete (#467). */
interface ResumeSidecar {
  validator: string;
  total?: number;
  /** True IFF `validator` is a CONTENT-ADDRESSED X-Linked-Etag (HF's LFS/Xet object
   *  hash) — the ONLY validator kind whose value is safe to (a) compare across
   *  redirect hops with lenient normalization and (b) trust as PROOF that a
   *  cross-origin CAS 206 is byte-identical to the partial. A plain ETag /
   *  Last-Modified (or a legacy sidecar without this marker) carries no content
   *  guarantee, so it must NEVER be normalize-compared against a resolve hop's
   *  X-Linked-Etag (different validator namespaces could coincidentally normalize
   *  equal and splice a genuinely-changed object onto the stale prefix — #467
   *  false-negative). */
  contentHash?: boolean;
}

/** Sidecar line 3 marker tagging the validator as a content-addressed X-Linked-Etag
 *  (see {@link ResumeSidecar.contentHash}). Kept on its OWN line — NEVER folded into
 *  the line-1 value — so it can never be confused with, or collide against, a real
 *  validator whose text happens to start with the marker (a value-prefix scheme
 *  mis-tags such a legacy value as a content hash — #467 provenance false-positive).
 *  A sidecar without a line-3 marker (every legacy sidecar, and every plain
 *  ETag/Last-Modified capture) reads back as contentHash:false. */
const CONTENT_HASH_SIDECAR_MARKER = "xet";

/** Read the resume sidecar (line 1 = validator, optional line 2 = total, optional
 *  line 3 = content-hash provenance marker) or null. Best-effort: a missing/unreadable
 *  sidecar just means "resume without an If-Range guard" — never fatal. Backward
 *  compatible with pre-total single-line sidecars and with legacy sidecars (no line 3
 *  ⇒ contentHash:false). The validator on line 1 is used VERBATIM — no prefix is
 *  stripped — so a value can never be mis-parsed as carrying provenance. */
async function readValidatorSidecar(path: string): Promise<ResumeSidecar | null> {
  try {
    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n");
    const validator = (lines[0] ?? "").trim();
    if (validator.length === 0) return null;
    const total = lines.length > 1 ? Number(lines[1].trim()) : NaN;
    // Provenance is on its OWN line (index 2), never derived from the value text.
    const contentHash = (lines[2] ?? "").trim() === CONTENT_HASH_SIDECAR_MARKER;
    const base: ResumeSidecar =
      Number.isFinite(total) && total > 0 ? { validator, total } : { validator };
    if (contentHash) base.contentHash = true;
    return base;
  } catch {
    return null;
  }
}

/** Persist the resume validator (+ authoritative total when known) next to a
 *  .partial. Best-effort — a failure here only costs the change-detection guard on
 *  a later resume. Line 1 is the header value VERBATIM, line 2 the optional total,
 *  line 3 the `xet` marker when the value is a content-addressed X-Linked-Etag (so a
 *  later resume knows it is safe to normalize-compare / trust for a cross-origin
 *  append). When a content hash has no known total, line 2 is left EMPTY so the
 *  marker always lands on line 3. */
async function writeValidatorSidecar(
  path: string,
  value: string,
  total?: number,
  contentHash = false,
): Promise<void> {
  try {
    const totalLine = typeof total === "number" && total > 0 ? String(total) : "";
    let body = value;
    if (contentHash) body = `${value}\n${totalLine}\n${CONTENT_HASH_SIDECAR_MARKER}`;
    else if (totalLine) body = `${value}\n${totalLine}`;
    await writeFile(path, body, "utf-8");
  } catch {
    /* best effort */
  }
}

/** The strongest resume validator a response can offer, preferring Hugging
 *  Face's content-addressed `X-Linked-Etag` (the LFS/Xet object hash — carried
 *  on the huggingface.co/resolve 302, NOT on the CAS CDN's final 200) over a
 *  plain ETag, falling back to Last-Modified. Capturing X-Linked-Etag from the
 *  redirect is what lets HF Xet downloads persist a sidecar at all (#467): the
 *  final CAS response returns neither ETag nor Last-Modified, so without this a
 *  Xet partial could NEVER be safely resumed. */
function extractValidator(res: Response): string | null {
  return (
    res.headers.get("x-linked-etag") ||
    res.headers.get("etag") ||
    res.headers.get("last-modified")
  );
}

/** Normalize an entity-tag / X-Linked-Etag for a STABLE content comparison across
 *  redirect hops. HF's `resolve` 302 carries the content-addressed X-Linked-Etag
 *  (the LFS/Xet object hash), but the CAS CDN — and even different CDN nodes — can
 *  quote it, weak-prefix it (`W/`), case-vary a hex hash, or pad whitespace, so a
 *  RAW string compare false-positives "changed" on an unchanged, content-addressed
 *  object and then deletes the valid partial (the #467 recurrence). Strips a leading
 *  weak `W/`, one layer of surrounding double-quotes, and surrounding whitespace,
 *  then case-folds a PURE-HEX value (HF's X-Linked-Etag is a hex object hash).
 *  Returns null for an absent/empty value so a MISSING validator is never mistaken
 *  for either a match or a difference. */
function normalizeEtag(value: string | null | undefined): string | null {
  if (value == null) return null;
  let s = value.trim();
  if (/^W\//i.test(s)) s = s.slice(2).trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  if (s.length === 0) return null;
  // Case-fold only a pure-hex token (HF's content hash) — an opaque non-hex ETag
  // may be case-sensitive, so leave it untouched.
  if (/^[0-9a-f]+$/i.test(s)) s = s.toLowerCase();
  return s;
}

async function streamUrlToFile(
  url: string,
  targetPath: string,
  headers: Record<string, string>,
  logUrl = redactUrlForLogs(url),
  storageAuth: CloudStorageAuth = {},
  resumeFromBytes = 0,
  progress?: ProgressMeta,
  resumable = false,
  /** Sink for THIS physical download's resume decision, threaded from the job so
   *  the outcome is stored on that job — never in a shared keyed map that could
   *  misattribute it to another job (#467). Absent for internal/direct callers. */
  onResume?: ResumeReporter,
  /** Extension of the FINAL destination (e.g. ".safetensors"), NOT of the .partial
   *  we stream into. When it's a binary-model extension the completed payload is
   *  validated as a real model — an HTML/JSON auth/error body is rejected rather
   *  than finalized as a corrupt model under a false success (#473). Empty ⇒ no
   *  payload validation (unknown/non-model destination). */
  modelExt = "",
  /** Per-download abort signal (#515): passed to fetch AND the write pipeline so a
   *  cancel aborts the in-flight transfer promptly; the partial is left on disk. */
  signal?: AbortSignal,
  /** Called with the byte count of every chunk that reaches disk (#470). Feeds the
   *  caller's STALL watchdog: a transfer that stops delivering bytes entirely is
   *  abandoned and retried (resuming), instead of sitting "in flight" for half an
   *  hour. Fires regardless of whether a progress tray is attached — the watchdog
   *  must bound the attempt on the plain (non-panel) path too. */
  onBytes?: (delta: number) => void,
  /** When true, a failed attempt does NOT publish a terminal `error` progress row —
   *  the CALLER will, once it has decided the download is really over (#470).
   *
   *  This matters more than it looks. The orchestrator treats the first terminal
   *  row as the download's OUTCOME and wakes the tab's agent with it (#547). An
   *  attempt that is about to be retried is not an outcome, so emitting `error`
   *  there tells the agent the download FAILED while it is in fact still running —
   *  and the agent's natural response (re-issue) is precisely the second-writer
   *  hazard the download machinery exists to prevent. */
  deferErrorRow = false,
  /** Last-moment re-verification, awaited IMMEDIATELY before this function first
   *  touches the file — before the restart truncation and before the append stream
   *  opens. Throwing from it aborts the write.
   *
   *  It exists to close a TOCTOU on the SHARED staged file: the resume offset and
   *  the validator are read, then a request is issued, and only then do we write.
   *  Another process writing the same `.partial` in that gap (it is keyed by the
   *  download's representation, so a second process running the same download
   *  shares it) could truncate and re-stage a different upstream object, and our
   *  append would land a valid-LOOKING file whose prefix and suffix come from
   *  different objects. Re-checking here shrinks that window from "the whole
   *  request round-trip" to the few instructions before the open. */
  beforeWrite?: () => Promise<void>,
): Promise<string> {
  // Fail fast if we were cancelled before any bytes moved — no request, no partial.
  if (signal?.aborted) throw new DOMException("The download was cancelled.", "AbortError");
  if (supportsCloudDownload(url)) {
    // INTERFERENCE RE-CHECK FIRST (see `beforeWrite`). This branch is the most
    // destructive one in the function: a cloud transfer cannot range-resume, so it
    // TRUNCATES the staged file and re-downloads in full. Under the retry loop that
    // makes a later attempt a destructive writer — if another process staged real
    // progress into this shared file while we were backing off, truncating would
    // throw away multi-gigabyte work that is not ours. Refuse before touching it.
    if (beforeWrite) await beforeWrite();
    // …and re-check the cancel, because that hook AWAITS. A cancel that lands
    // during it would otherwise be noticed only AFTER the truncate below, which
    // erases the resumable partial a cancel is supposed to leave behind.
    if (signal?.aborted) throw new DOMException("The download was cancelled.", "AbortError");
    // Cloud downloaders (S3/Azure) don't range-resume — they overwrite the target.
    // If a partial exists it's being discarded; surface that (#467) instead of a
    // silent restart. Truncate it OURSELVES first and CONFIRM (throw on failure)
    // BEFORE reporting discarded:true — the cloud SDKs validate the request/body
    // before opening their write stream, so reporting pre-download could otherwise
    // claim a discard that a later auth/network failure never performed (P1-1).
    if (resumable && resumeFromBytes > 0) {
      try {
        await writeFile(targetPath, "");
      } catch (err) {
        throw new ModelError(
          `Download restart failed: could not truncate the stale ${resumeFromBytes}-byte partial ` +
            `before a cloud re-download. Retry (a fresh attempt restarts from 0).`,
          { url: logUrl, cause: err instanceof Error ? err.message : String(err) },
        );
      }
      logger.warn(
        `Discarded a ${resumeFromBytes}-byte partial download and restarting from 0: cloud ` +
          `downloads (S3/Azure) don't support byte-range resume, so the partial was overwritten — ` +
          `re-downloading in full.`,
        { url: logUrl, discardedBytes: resumeFromBytes },
      );
      onResume?.({ outcome: "declined:full-response", discardedBytes: resumeFromBytes, discarded: true });
    }
    await downloadCloudUrlToFile(url, targetPath, storageAuth, signal);
    // INTEGRITY BACKSTOP (#515): the S3/Azure SDKs may not honor the abort promptly
    // (or at all), so a cancel that arrived mid-transfer could let the cloud download
    // run to completion. If we were cancelled, throw BEFORE the size/payload checks
    // and the caller's rename/materialize — so a cancelled cloud transfer is NEVER
    // finalized as a complete file (the partial is left in the cache dir, unrenamed).
    if (signal?.aborted) throw new DOMException("The download was cancelled.", "AbortError");
    // #343 edge: the S3/Azure path bypasses the HTTP size gate below. The cloud
    // downloaders verify their own Content-Length (truncation), but a stream
    // that yielded ZERO bytes can still resolve cleanly — backstop it here so a
    // 0-byte cloud object can never be reported as a successful download.
    const actual = await fileSizeOrUndefined(targetPath);
    if (actual === 0) {
      await safeRm(targetPath);
      throw new ModelError(
        "Download produced a 0-byte file — the cloud source (S3/Azure) sent no data. Removed it; retry.",
        { url: logUrl },
      );
    }
    // A cloud (S3/Azure) object can also be an error document — e.g. an XML
    // AccessDenied body saved under a `.safetensors` name. No HTTP Content-Type is
    // available here, so sniff the body alone (an XML/HTML error starts with `<`).
    await assertModelPayloadOrThrow({
      targetPath,
      modelExt,
      contentType: "",
      url,
      logUrl,
      onReject: async () => {
        await discardRejectedPayload(targetPath, undefined, logUrl);
      },
      // FAIL CLOSED, same as the HTTP path: a cloud (S3/Azure) object can be an XML/
      // HTML AccessDenied body saved under a `.safetensors` name, and if we CAN'T
      // sniff the completed file (a transient open/read failure) we must NOT finalize
      // it — cannot verify ⇒ do not finalize (#473 P0-3). Previously this was a
      // best-effort skip, which let an unsniffable auth/error body get renamed in.
      failClosed: true,
    });
    return ""; // cloud (S3/Azure) has no HTTP Content-Type to persist
  }

  // Resumable downloads: when a partial file exists at targetPath we ask the
  // server for the remaining bytes via Range. If the server returns 206 with
  // matching Content-Range we append; if it returns 200 (range unsupported,
  // or the file changed upstream) we truncate and restart. Idea from
  // josephoibrahim/comfy-cozy.
  //
  // #343 edge: a plain Range resume is unsafe if the upstream file CHANGED
  // between the two calls — we would append fresh bytes onto a stale prefix and
  // the size check could still pass, producing a corrupt file. Guard it with a
  // conditional resume: we persist the first response's validator (ETag, else
  // Last-Modified) in a sidecar next to the .partial and replay it as `If-Range`
  // on resume. Per RFC 9110 the server then returns 206 (append) ONLY if the
  // resource is byte-for-byte unchanged, otherwise 200 with the full body (which
  // our append-vs-truncate logic below restarts cleanly). Belt-and-braces, we
  // also validate the 206 Content-Range starts exactly at our resume offset.
  const validatorSidecar = `${targetPath}.etag`;
  let currentUrl = url;
  let currentHeaders = headers;
  // How many bytes we will actually attempt to resume from. A resume is only
  // SAFE when we can prove the upstream file is unchanged, which requires the
  // validator (ETag/Last-Modified) we persisted on the first attempt. Without a
  // sidecar — a stale partial from a pre-fix build, or a server that sent no
  // validator — we cannot detect a changed file, so we must NOT append: fall
  // back to a clean restart (Range omitted, the "w" flag truncates the partial).
  let effectiveResume = resumeFromBytes;
  // Did we actually ask the server to resume (Range + If-Range)? Used after the
  // response to distinguish a taken resume (206) from an If-Range MISS (200 =
  // upstream changed) so we can surface WHY the partial was discarded (#467).
  let requestedResume = false;
  // Set when a partial existed but no sidecar validator did, so we declined to
  // resume. The discard is only REPORTED once we actually truncate it (after a
  // successful response), so a fetch/redirect/status failure before then can't
  // falsely claim the partial was discarded (#467 codex round 4).
  let resumeDeclinedNoValidator = false;
  // The persisted content-addressed validator we are resuming AGAINST — kept so
  // we can re-compare it to the value the resolve redirect reports NOW, and
  // refuse the append ourselves if they differ (belt-and-braces on top of the
  // origin's If-Range: we never trust a CAS 206 whose upstream object changed).
  let priorValidator: string | null = null;
  // Whether `priorValidator` is a CONTENT-ADDRESSED X-Linked-Etag (vs a plain
  // ETag/Last-Modified or a legacy sidecar). Only a content hash may be
  // normalize-compared against a resolve hop's X-Linked-Etag or trusted to prove a
  // cross-origin 206 unchanged — a plain validator from a DIFFERENT namespace could
  // otherwise coincidentally normalize equal and splice a changed object onto the
  // stale prefix (#467 false-negative). See ResumeSidecar.contentHash.
  let priorIsContentHash = false;
  // The authoritative full-file size the ORIGINAL response declared (persisted in
  // the sidecar), if known — a resume 206 whose Content-Range total DISAGREES with
  // this is a server understating the size, and must be refused (#467).
  let priorTotal: number | undefined;
  if (resumeFromBytes > 0) {
    const sidecar = resumable ? await readValidatorSidecar(validatorSidecar) : null;
    priorValidator = sidecar?.validator ?? null;
    priorIsContentHash = sidecar?.contentHash === true;
    priorTotal = sidecar?.total;
    if (priorValidator) {
      currentHeaders = {
        ...currentHeaders,
        Range: `bytes=${resumeFromBytes}-`,
        "If-Range": priorValidator,
      };
      requestedResume = true;
    } else {
      // No trustworthy validator → we will discard the un-verifiable partial and
      // restart (the deliberate #343 safety fallback). This USED to be silent: a
      // multi-GB HF Xet partial (whose CAS CDN sent no ETag/Last-Modified, so no
      // sidecar was ever written) got thrown away and re-downloaded from 0 with
      // no log and no signal (#467). Defer the log/diagnostic until we actually
      // truncate (below), so a pre-write failure can't falsely report a discard.
      //
      // DO NOT "recover" this case by PROBING the URL for an identity and resuming
      // on it — that is a SILENT-CORRUPTION path and was rejected (#467, corruption
      // class). A validator fetched NOW identifies the CURRENT object, not the object
      // this sidecar-less partial was written against; there is NO recorded write-time
      // identity to bind the OLD bytes, so a same-size re-upload (or a same-head/tail
      // replacement whose unsampled middle differs) would append fresh bytes onto a
      // stale prefix and finalize a corrupt model under a green success. Head/tail
      // byte-sampling is likewise necessary-but-not-sufficient (the middle is
      // unverifiable without re-downloading it). The ONLY safe resume is one whose
      // whole-object identity was recorded at WRITE time — i.e. the sidecar route
      // above, which HF Xet DOES take now that the X-Linked-Etag from the resolve
      // redirect is persisted on the first attempt. A genuinely sidecar-less/legacy
      // partial must therefore RESTART (never-silent), which is exactly what happens.
      effectiveResume = 0;
      if (resumable) resumeDeclinedNoValidator = true;
    }
  }
  // The content-addressed validator captured from the resolve REDIRECT (HF's
  // 302 carries X-Linked-Etag — the file's LFS/Xet content hash — even though
  // the final CAS 200 carries no validator). Strictly X-Linked-Etag: a generic
  // ETag/Last-Modified on a 3xx describes the redirect/pointer resource, NOT the
  // target file, so it must never be promoted to the file's validator. Used
  // both as the sidecar fallback (so Xet downloads become resumable) AND as the
  // resume-time change check below (#467).
  let redirectValidator: string | null = null;
  // Set if ANY hop in the redirect chain reports a content-addressed X-Linked-Etag
  // that DIFFERS from the validator the partial was written against — proof the
  // upstream object changed, even if a later/earlier hop happens to match. Closes
  // the multi-hop hole where only the first (or last) value is inspected (#467).
  let sawChangedRedirectValidator = false;
  // Did the bytes ultimately come from a DIFFERENT origin than we requested (HF
  // resolve → CAS CDN)? A cross-origin 206 can't lean on the requesting origin's
  // If-Range — the CDN may honor a stale Range and 206 a CHANGED object — so a
  // cross-origin resume append MUST independently prove the content is unchanged
  // via the content-addressed X-Linked-Etag (#467/#343).
  let crossOriginRedirect = false;
  // The AUTHORITATIVE full-file size Hugging Face declares on the resolve redirect
  // (X-Linked-Size — the true LFS/Xet object size), captured because the final CAS
  // 200's Content-Length can UNDERSTATE it (a truncating proxy/CDN). Used as the
  // expected total so a short body fails verification instead of finalizing as
  // complete — the fresh-download analogue of the resume total cross-check (#467).
  let redirectSize: number | undefined;
  let res: Response;
  for (let redirectCount = 0; ; redirectCount += 1) {
    res = await fetchOrThrow(
      currentUrl,
      { headers: currentHeaders, redirect: "manual", signal },
      currentUrl === url ? logUrl : redactUrlForLogs(currentUrl),
    );
    if (res.status < 300 || res.status >= 400) break;

    // Capture the content-addressed resume validator off the redirect itself.
    // HF's resolve URL 302s to the CAS CDN and carries X-Linked-Etag (the LFS/Xet
    // object hash) on the 302; the final CAS 200 carries NO validator. Without
    // this, Xet downloads never persisted a sidecar and could never resume (#467).
    // ONLY X-Linked-Etag — a generic ETag on a 3xx is the pointer's, not the file's.
    // Keep the LAST value seen (nearest the final object) for the sidecar/match,
    // AND flag if ANY hop's value contradicts the persisted validator on a resume.
    const hopValidator = res.headers.get("x-linked-etag");
    if (hopValidator) {
      redirectValidator = hopValidator;
      // Compare the NORMALIZED content hashes (strip quotes / `W/` / case /
      // whitespace) so a hop that merely re-quotes or re-cases the SAME object hash
      // is not misread as a change (#467). Only compare when the prior validator is
      // ITSELF a content-addressed X-Linked-Etag — comparing a plain ETag against a
      // resolve hop's X-Linked-Etag is a namespace error that could false-match OR
      // false-differ (#467 false-negative). Only a genuinely different normalized
      // content hash flags a change.
      if (
        requestedResume &&
        priorValidator &&
        priorIsContentHash &&
        normalizeEtag(hopValidator) !== normalizeEtag(priorValidator)
      ) {
        sawChangedRedirectValidator = true;
      }
    }
    // Capture the authoritative object size the redirect declares (last non-empty).
    const hopSize = Number(res.headers.get("x-linked-size"));
    if (Number.isFinite(hopSize) && hopSize > 0) redirectSize = hopSize;

    if (redirectCount >= MAX_HTTP_REDIRECTS) {
      throw new ModelError(
        `Download redirect limit exceeded (${MAX_HTTP_REDIRECTS}) — the model host kept ` +
          `redirecting (Hugging Face routes resolve URLs through the Xet/CAS CDN; a loop ` +
          `here usually means a broken mirror or a proxy rewriting the redirect chain).`,
        {
          url: redactUrlForLogs(currentUrl),
          status: res.status,
        },
      );
    }

    const location = res.headers.get("location");
    if (!location) {
      // A 3xx with no Location can't be followed. HF's Xet/CAS flow ALWAYS
      // includes a Location on its resolve redirect, so a missing one means a
      // proxy stripped it or the host mis-responded — say so instead of the
      // confusing "Download failed: 302 Found" the !res.ok path would emit.
      throw new ModelError(
        `Download failed: the model host returned a ${res.status} redirect with no ` +
          `Location header, so it can't be followed. For Hugging Face this usually means a ` +
          `proxy stripped the redirect to the Xet/CAS CDN — check any corporate proxy, or ` +
          `set HF_ENDPOINT to a reachable mirror and retry.`,
        { url: redactUrlForLogs(currentUrl), status: res.status },
      );
    }

    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new ModelError(
        `Download failed: the model host returned a ${res.status} redirect to an invalid ` +
          `Location ("${location}"). The redirect chain can't be followed — retry, or set ` +
          `HF_ENDPOINT to a reachable mirror if this is a Hugging Face URL.`,
        {
          url: redactUrlForLogs(currentUrl),
          status: res.status,
        },
      );
    }
    // Drop credential-bearing headers (Authorization etc.) when the redirect
    // crosses origins. HF's resolve URL 302s to a *pre-signed* Xet/CAS URL on a
    // different host (e.g. cas-bridge.xethub.hf.co) that needs no auth — and
    // forwarding our HF Bearer token to a third-party CDN would leak it. This
    // matches how huggingface_hub follows the CAS redirect. BUT keep Range /
    // If-Range: they are not credentials, and the pre-signed CAS URL supports
    // byte-range requests — dropping them meant a resume's Range never reached
    // the CDN, so HF Xet resumes always fell back to a full re-download (#467).
    const sameOrigin = new URL(nextUrl).origin === new URL(currentUrl).origin;
    currentUrl = nextUrl;
    if (!sameOrigin) {
      crossOriginRedirect = true;
      const preserved: Record<string, string> = {};
      if (currentHeaders.Range) preserved.Range = currentHeaders.Range;
      if (currentHeaders["If-Range"]) preserved["If-Range"] = currentHeaders["If-Range"];
      currentHeaders = preserved;
    }
  }

  if (!res.ok) {
    // Civitai requires an account token for ALL downloads (401 keyless, 403
    // for gated/early-access) — a raw status code leaves agents flailing
    // through retries (live E2E), so name the fix.
    const civitaiAuthHint =
      (res.status === 401 || res.status === 403) && /(^|\.)civitai\.com$/i.test(new URL(currentUrl).hostname)
        ? " — CivitAI requires an API token for downloads. Set CIVITAI_API_TOKEN (panel Settings › “Set CivitAI token…”, or the env var; create one at civitai.com/user/account) and retry. Do NOT retry other model ids — they will all fail the same way until a token is set."
        : "";
    throw new ModelError(
      `Download failed: ${res.status} ${res.statusText}${civitaiAuthHint}`,
      { url: currentUrl === url ? logUrl : redactUrlForLogs(currentUrl), status: res.status },
    );
  }

  if (!res.body) {
    throw new ModelError("Download response has no body", { url: logUrl });
  }

  // #467/#343 belt-and-braces on a 206 RESUME APPEND. A same-origin 206 is safe:
  // the very server that evaluated our If-Range is the one serving the bytes, so
  // a 206 already proves the resource is unchanged. A CROSS-ORIGIN 206 (HF resolve
  // → CAS CDN) cannot lean on that — the CDN may honor a stale Range and 206 a
  // CHANGED object regardless of the origin's If-Range — so we must independently
  // prove the object is unchanged via the content-addressed X-Linked-Etag: it MUST
  // be present AND equal the validator the partial was written against. We check
  // BOTH the values captured off the 3xx redirects AND the FINAL response's own
  // X-Linked-Etag — a matching redirect followed by a final CDN 206 carrying a
  // DIFFERENT content hash must NOT slip through (#467 P0-2). We refuse any 206
  // whose observed validators PROVE a change (present but different), cross-origin
  // or not. Only 206s are gated — a 200 is a full body and restarts cleanly below.
  // On refusal, drop the partial + sidecar so a retry is a clean full download.
  if (requestedResume && res.status === 206) {
    // Compare NORMALIZED content-addressed hashes only (strip quotes / `W/` / case /
    // whitespace), from the SAME authoritative hop the partial's validator was
    // captured on — so an unchanged, content-addressed object can NEVER read as
    // "changed" on a cross-hop quoting/case difference (the #467 recurrence).
    // priorNorm is non-null ONLY when the stored validator is a content-addressed
    // X-Linked-Etag: a plain ETag/Last-Modified must never be normalize-compared
    // against a resolve hop's X-Linked-Etag (different namespaces could coincidentally
    // normalize equal and let a genuinely-changed object append — #467 false-negative).
    const priorNorm = priorIsContentHash ? normalizeEtag(priorValidator) : null;
    const redirectNorm = normalizeEtag(redirectValidator);
    // The final response's OWN content-addressed validator (the CAS 206 usually
    // omits it, but when present it describes exactly THESE bytes — authoritative).
    const finalNorm = normalizeEtag(res.headers.get("x-linked-etag"));
    // A change is PROVEN only when an OBSERVED content hash genuinely DIFFERS from
    // the content hash the partial was written against. A hop that carries NO
    // X-Linked-Etag (finalNorm/redirectNorm === null), or a prior that is not a
    // content hash (priorNorm === null), proves nothing — absence must never be read
    // as a change (that false-positive, comparing the resolve hash to a per-hop CAS
    // ETag, is exactly what deleted valid partials in #467).
    const provenChange =
      sawChangedRedirectValidator ||
      (priorNorm !== null && redirectNorm !== null && redirectNorm !== priorNorm) ||
      (priorNorm !== null && finalNorm !== null && finalNorm !== priorNorm);
    // The content hash that best binds THESE bytes (final response, else nearest
    // redirect). A cross-origin resume can't lean on the requesting origin's
    // If-Range, so it may append ONLY when a CONTENT-ADDRESSED prior hash is PROVEN
    // unchanged by an OBSERVED content hash of these bytes. Anything less — a plain/
    // legacy prior (priorNorm null), or no observable content hash (boundNorm null),
    // or a mismatch — is UNVERIFIABLE and must restart, never append (#467/#630).
    const boundNorm = finalNorm ?? redirectNorm;
    const provenUnchangedCrossOrigin =
      priorNorm !== null && boundNorm !== null && boundNorm === priorNorm;
    const unprovenCrossOrigin = crossOriginRedirect && !provenUnchangedCrossOrigin;
    if (provenChange || unprovenCrossOrigin) {
      // provenChange = an OBSERVED hash truly differs; unprovenCrossOrigin = no
      // content hash to prove it either way — report each honestly.
      const why = provenChange
        ? "the upstream now reports a DIFFERENT content-addressed object (X-Linked-Etag changed" +
          (priorNorm !== null && finalNorm !== null && finalNorm !== priorNorm
            ? " on the final response"
            : " on a redirect hop") +
          ")"
        : "the resume crossed origins to a CDN that returned no content-addressed validator, so an unchanged upstream can't be proven";
      // Release the 206 slice's socket before we re-request the full body.
      try {
        await (res.body as ReadableStream | null | undefined)?.cancel?.();
      } catch {
        /* best effort */
      }
      // Do NOT delete the partial and throw. That was the core #467 harm: on a
      // MISREAD cross-hop header it discarded a valid multi-GB partial AND forced the
      // caller to issue a SECOND identical call before the download would even start.
      // Instead RESTART the download IN THIS SAME CALL by re-requesting from byte 0:
      // the resumable-restart path below truncates+overwrites the un-appendable
      // prefix with the fresh full 200, so ONE call completes. The #630/#343 safety
      // invariant is preserved — we never APPEND bytes we could not prove belong to
      // this object; we re-download instead of splicing.
      onResume?.({
        outcome: provenChange ? "declined:etag-changed" : "declined:unverifiable",
        discardedBytes: resumeFromBytes,
        discarded: true,
      });
      logger.warn(
        `Not appending a 206 for a ${resumeFromBytes}-byte partial; restarting the download from 0 in ` +
          `the same call: ${why} — appending would risk corrupting the file (#343/#467).`,
        { url: logUrl, discardedBytes: resumeFromBytes },
      );
      return await streamUrlToFile(
        url,
        targetPath,
        headers,
        logUrl,
        storageAuth,
        0, // restart from byte 0 — no Range, forces a clean full download this call
        progress,
        resumable,
        onResume,
        modelExt,
        signal,
        onBytes,
        deferErrorRow,
        beforeWrite,
      );
    }
  }

  // LAST-MOMENT INTERFERENCE RE-CHECK (see `beforeWrite`). Placed HERE — before the
  // integrity refusals below — because those refusals DELETE the staged file and
  // its sidecar. "Refusing our own bad response" must not become "deleting someone
  // else's good partial": if another writer re-staged this file while our request
  // was in flight, that file is no longer ours to clean up. Everything above this
  // line only READ the file or talked to the server; everything below MUTATES it,
  // so this is the true first-touch boundary.
  //
  // The 206-refusal path above returns by RECURSING with a clean restart and does
  // not touch the file on its way there, so the recursive call runs this check
  // itself — the boundary holds on that path too.
  if (beforeWrite) await beforeWrite();
  // …and re-check the cancel, because that hook AWAITS. Every path below either
  // deletes or truncates the staged file, so a cancel that landed during the hook
  // must stop HERE — a cancelled download is promised a resumable partial, and
  // erasing it on the way out would be exactly the data loss the promise denies.
  if (signal?.aborted) throw new DOMException("The download was cancelled.", "AbortError");

  // A 206 to a request we did NOT range (a FRESH download, or a no-validator
  // decline — effectiveResume === 0, no Range sent) is UNSOLICITED and unsafe: its
  // body is only a partial slice, but the "w"/Content-Length path below would
  // finalize that short prefix as a complete file (e.g. `bytes 0-1023/4096` with
  // Content-Length 1024 → a 1 KiB file renamed into cache as the whole 4096-byte
  // model). Refuse it — a no-Range request must be answered with 200 (#467 P0).
  if (res.status === 206 && effectiveResume === 0) {
    await safeRm(targetPath);
    if (resumable) await safeRm(validatorSidecar);
    const cleared = await partialConfirmedDiscarded(targetPath);
    throw new ModelError(
      `Download failed: the server returned "206 Partial Content" to a request that sent NO Range ` +
        `header. An unsolicited partial response can't be finalized as a complete file (it would ` +
        `silently truncate the model). ${cleared ? "Removed any partial; retry." : "Could not remove the partial — delete it manually and retry."}`,
      { url: logUrl, status: res.status },
    );
  }

  // Decide append vs truncate based on the response. We only append when we
  // actually asked for a range (effectiveResume > 0, i.e. we had a validator)
  // AND the server honoured it with a 206. Any other 2xx (typically 200) means
  // the server is sending the full file — exactly what If-Range yields when the
  // upstream file changed — so we overwrite and restart, which is correct.
  const appendMode = effectiveResume > 0 && res.status === 206;

  // The authoritative full-file size, taken from a 206's Content-Range total.
  // Used as the truncation target so a SHORT 206 (a server that satisfies only
  // part of the requested range — RFC 9110 §15.3.7) can't slip through.
  let rangeTotal: number | undefined;
  if (appendMode) {
    // #343 edge: a 206 MUST fully prove where it resumes AND how big the whole
    // file is. Parse Content-Range strictly as `bytes <start>-<end>/<total>` and
    // reject unless: start === our resume offset, end >= start, total is known
    // and consistent (end === total-1, i.e. the range runs to the end of the
    // representation). A missing/malformed/partial range (e.g. `bytes 4-7/1000`
    // returning only 4 of the remaining bytes, or `bytes 4-3/3`, or unanchored
    // garbage) would otherwise let a truncated file be finalized as complete or
    // be appended at the wrong offset. Drop the partial + validator so a retry
    // starts clean rather than compounding the corruption.
    const contentRange = res.headers.get("content-range");
    // Range-unit name is case-insensitive (RFC 9110 §14.1) — accept "Bytes"/"BYTES".
    const m = contentRange ? /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(contentRange.trim()) : null;
    const start = m ? Number(m[1]) : NaN;
    const end = m ? Number(m[2]) : NaN;
    const total = m ? Number(m[3]) : NaN;
    const valid =
      m !== null &&
      start === effectiveResume &&
      end >= start &&
      total > end &&
      end === total - 1;
    if (!valid) {
      await safeRm(targetPath);
      await safeRm(validatorSidecar);
      throw new ModelError(
        `Download resume rejected: a 206 for byte ${effectiveResume}+ must carry a complete, ` +
          `consistent Content-Range "bytes ${effectiveResume}-<end>/<total>" reaching the end of ` +
          `the file, but the server sent ${contentRange ? `"${contentRange}"` : "no Content-Range"}. ` +
          `Refusing to append (would corrupt or truncate the file). Removed the partial; retry.`,
        { url: logUrl, status: res.status },
      );
    }
    // Cross-check the 206's total against the AUTHORITATIVE size the ORIGINAL
    // response declared (persisted in the sidecar). A server that understates the
    // total on resume — e.g. `bytes 4-7/8` for a file first seen as 4096 — would
    // otherwise let a short prefix finalize as "complete" (#467). Refuse the
    // mismatch (also catches a partial we already have that exceeds the new total).
    if (priorTotal !== undefined && total !== priorTotal) {
      await safeRm(targetPath);
      await safeRm(validatorSidecar);
      throw new ModelError(
        `Download resume rejected: the server now reports a total size of ${total} bytes, but the ` +
          `original download recorded ${priorTotal}. The upstream size changed — appending would ` +
          `corrupt or truncate the file. Refusing to append; retry from a clean restart.`,
        { url: logUrl, status: res.status },
      );
    }
    rangeTotal = total;
  }

  const flags = appendMode ? "a" : "w";

  // On a fresh/full write (restart) of a resumable target, make the validator
  // and the on-disk bytes failure-atomic: first drop any stale sidecar AND the
  // stale partial (so a crash here leaves NO validator → the next attempt has no
  // sidecar and safely restarts), THEN persist the new validator so that once we
  // begin writing, a truncated partial is already paired with a MATCHING
  // validator. On a 206 append the existing sidecar already matches — leave it.
  if (resumable && !appendMode) {
    // Neutralize any stale sidecar with CONFIRMATION (remove, else truncate to 0 so it
    // carries no resumable validator), then EXPLICITLY truncate the stale partial to
    // zero and verify that truncation SUCCEEDED before we either (a) pair a new
    // validator with the file or (b) report the discard. Doing the truncation
    // ourselves (create-or-truncate to 0) — rather than relying on the lazy "w"
    // stream open below — lets us confirm the old prefix is gone up front. The
    // ordering is the #343 safety invariant: a new validator must NEVER be paired
    // with un-truncated stale bytes (a later If-Range 206 would then append fresh
    // bytes onto a stale prefix and silently corrupt the file). If truncation
    // fails, we write NO validator (a retry sees no sidecar → safe restart) and
    // report nothing (the discard didn't actually happen).
    //
    // #467 P0c: a mere safeRm here SWALLOWS a removal failure — leaving a stale
    // (possibly content-hash-tagged `xet`) sidecar that a later swallowed new-write
    // failure would pair with the FRESH bytes we're about to stream, so a subsequent
    // cross-origin re-serve of the OLD object would append OLD bytes onto the NEW
    // prefix (silent corruption). Require the old sidecar to be provably GONE or
    // EMPTY (rmOrTruncate) BEFORE we truncate the partial. If it can be neither
    // removed nor emptied, FAIL NOW — before touching the partial — so the old
    // sidecar+old partial remain a CONSISTENT resumable pair rather than a stale
    // validator paired with new bytes. (An emptied 0-byte sidecar reads back as "no
    // validator", so even a later failed new-write forces a safe full restart, never
    // a stale-flag resume.)
    if (!(await rmOrTruncate(validatorSidecar, logUrl))) {
      throw new ModelError(
        `Download restart failed: could not remove or empty the stale resume-validator sidecar, so a ` +
          `fresh download could pair new bytes with a stale validator (risking corruption on a later ` +
          `resume). Left the ${resumeFromBytes}-byte partial and its sidecar intact; retry.`,
        { url: logUrl },
      );
    }
    // If we can't truncate the stale partial, FAIL rather than fall through to the
    // "w" open below: a partial-truncate failure that the later "w" open then
    // silently fixed would perform the discard WITHOUT reporting it (#467). By
    // throwing here we guarantee the discard is either reported (truncation
    // succeeded) or the download errors (never a silent discard). The sidecar was
    // already removed, so a retry sees no validator → safe restart (#343).
    try {
      await writeFile(targetPath, "");
    } catch (err) {
      throw new ModelError(
        `Download restart failed: could not truncate the stale ${resumeFromBytes}-byte partial to ` +
          `re-download it. Removed its validator; retry (a fresh attempt restarts from 0).`,
        { url: logUrl, cause: err instanceof Error ? err.message : String(err) },
      );
    }
    if (resumeFromBytes > 0 && requestedResume) {
      // Asked to resume (had a validator, sent Range+If-Range) but got a full 200
      // — the upstream changed OR the host doesn't support range resume. The
      // partial is now truncated and the file is being re-downloaded in full.
      logger.warn(
        `Discarded a ${resumeFromBytes}-byte partial download and restarting from 0: the server ` +
          `answered the If-Range resume request with a full ${res.status} instead of a 206 — the ` +
          `upstream file changed, or the host doesn't support resuming — so re-downloading in full.`,
        { url: logUrl, discardedBytes: resumeFromBytes },
      );
      onResume?.({ outcome: "declined:full-response", discardedBytes: resumeFromBytes, discarded: true });
    } else if (resumeFromBytes > 0 && resumeDeclinedNoValidator) {
      // A partial existed but no sidecar validator did, so we never even sent a
      // Range — a safe resume couldn't be verified (common on HF's Xet/CAS CDN,
      // which omits ETag/Last-Modified on the body). Truncated + re-download full.
      logger.warn(
        `Discarded a ${resumeFromBytes}-byte partial download and restarting from 0: no ` +
          `ETag/Last-Modified validator was ever persisted for it, so a safe resume can't be ` +
          `verified (common on Hugging Face's Xet/CAS CDN, which omits both headers on the file ` +
          `body). This is the safety-first behavior — an unverifiable resume risks a corrupt file ` +
          `(#343). Future downloads capture the validator from the resolve redirect so they CAN resume.`,
        { url: logUrl, discardedBytes: resumeFromBytes },
      );
      onResume?.({ outcome: "declined:no-validator", discardedBytes: resumeFromBytes, discarded: true });
    }
    // The file is now confirmed truncated (we threw otherwise), so a new validator
    // can never pair with a stale prefix (#343). PREFER the content-addressed
    // X-Linked-Etag captured off the resolve redirect over the final response's own
    // validator: HF's `resolve` 302 carries the true LFS/Xet object hash, while the
    // final CAS 200 may carry only a per-node/per-request `etag`/`last-modified`.
    // The resume change-check reads the resolve hop's X-Linked-Etag, so capturing
    // THAT same hop's value here makes capture-time and check-time compare
    // like-for-like — otherwise an unchanged object false-reads as "changed on a
    // redirect hop" and the valid partial is deleted (the #467 recurrence). Fall
    // back to the final response's validator only when no X-Linked-Etag was seen (a
    // plain non-HF origin, where If-Range works against that origin's own ETag).
    // Persist the AUTHORITATIVE full-file size (this restart response is a full 200,
    // so its Content-Length IS the total) so a later resume can reject a 206 that
    // understates it (#467).
    const finalXLinkedEtag = res.headers.get("x-linked-etag");
    const validator = redirectValidator || extractValidator(res);
    // Tag the sidecar's provenance: the value is a CONTENT-ADDRESSED X-Linked-Etag ONLY
    // when the CHOSEN validator is itself a NON-EMPTY X-Linked-Etag (from the resolve
    // redirect — always non-empty, it's captured under `if (hopValidator)` — or the
    // final response's own). An EMPTY/whitespace `x-linked-etag` header makes
    // extractValidator fall back to a plain ETag/Last-Modified; that fallback is NOT a
    // content hash and must NOT be flagged as one (#467 P0a — a mistagged plain value
    // could later normalize-match a DIFFERENT object's X-Linked-Etag and append onto a
    // stale prefix). Comparing against the actually-chosen `validator` also guarantees
    // the flag describes the value we persist, not merely a header that was present.
    const isNonEmpty = (v: string | null): boolean => v !== null && v.trim().length > 0;
    const validatorIsContentHash =
      !!validator &&
      ((redirectValidator !== null && validator === redirectValidator) ||
        (isNonEmpty(finalXLinkedEtag) && validator === finalXLinkedEtag));
    // Authoritative total: the GREATER of Content-Length and HF's X-Linked-Size, so
    // a later resume cross-checks against the TRUE size, not an understated one (#467).
    const fullTotal =
      Math.max(Number(res.headers.get("content-length")) || 0, redirectSize ?? 0) || undefined;
    if (validator)
      await writeValidatorSidecar(validatorSidecar, validator, fullTotal, validatorIsContentHash);
  } else if (appendMode) {
    // A resume was actually taken (validated 206 append). Record it so
    // download_status can report the partial was reused, not discarded (#467).
    onResume?.({ outcome: "resumed", discardedBytes: 0, discarded: false });
  }

  const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  const fileStream = createWriteStream(targetPath, { flags });

  // Truncation/verification target = the true full-file size. For a validated 206
  // that is the Content-Range total (NOT content-length, which is only the
  // remaining slice and would mask a short 206). For a fresh/restart 200 it is the
  // GREATER of the response's Content-Length and Hugging Face's authoritative
  // X-Linked-Size — so a CDN that UNDERSTATES Content-Length can't finalize a short
  // body as complete (assertComplete then requires the full X-Linked-Size) (#467).
  const lengthHeader = Number(res.headers.get("content-length") || 0);
  const fresh200Total = Math.max(lengthHeader > 0 ? lengthHeader : 0, redirectSize ?? 0);
  const expectedTotal = appendMode ? (rangeTotal ?? 0) : fresh200Total;

  // A pipeline() can resolve on a stream that ended EARLY (server dropped the
  // connection, proxy cut it, disk edge case) — leaving a 0-byte or truncated
  // file that would otherwise be reported as a successful download (#343: silent
  // model corruption). Verify the written size before we ever return success.
  const assertComplete = async (): Promise<void> => {
    let actual: number | undefined;
    try {
      const st = await stat(targetPath);
      actual = typeof st?.size === "number" ? st.size : undefined;
    } catch {
      actual = undefined;
    }
    // Couldn't read the written size. FAIL CLOSED when we have an authoritative
    // expected total to check against (#467 P1-B): a transient stat failure must
    // NOT let an early/oversized body be finalized (renamed into cache) as a
    // success — that is exactly the silent-corruption class #343 guards. Keep the
    // partial on disk (it may still be range-resumable) and error instead. Only
    // when NO expected total is known (server sent no Content-Length/Content-Range)
    // do we return — there is nothing to verify against, so a missing size can't
    // prove corruption and mustn't block the download.
    if (actual === undefined) {
      if (expectedTotal > 0) {
        throw new ModelError(
          `Download could not be verified: expected ${expectedTotal} bytes but the written file size ` +
            `couldn't be read — not finalizing (the file may be incomplete). Retry.`,
          { url: logUrl },
        );
      }
      return;
    }
    if (actual === 0) {
      // Nothing landed — remove it (and its validator sidecar) so it can't
      // masquerade as a real file / poison a resume with a validator that has
      // no matching bytes. Best-effort: never let cleanup throw here.
      await safeRm(targetPath);
      if (resumable) await safeRm(validatorSidecar);
      throw new ModelError(
        "Download produced a 0-byte file — the source sent no data. Removed it; retry.",
        { url: logUrl },
      );
    }
    if (expectedTotal > 0 && actual < expectedTotal) {
      // Truncated. Keep the partial on disk so a later call can range-resume it,
      // but do NOT report this as a completed download.
      //
      // `retryable` is the CONTRACT the retry loop reads (#470): the bytes on disk
      // are a valid prefix of THIS object (their validator sidecar was written
      // against it), so another attempt resumes rather than restarts. Stated as a
      // flag rather than inferred from this sentence, which is prose and will be
      // reworded. It is a claim about the PARTIAL, not about the server: the resume
      // still has to re-prove object identity via If-Range/X-Linked-Etag on the next
      // attempt, exactly as a fresh call would.
      throw new ModelError(
        `Download truncated: wrote ${actual} of ${expectedTotal} bytes — the stream ended early. Not complete; retry to resume.`,
        { url: logUrl, retryable: true },
      );
    }
    if (expectedTotal > 0 && actual > expectedTotal) {
      // OVERSIZED — the server streamed MORE than the authoritative size (a 206
      // Content-Range total, or a 200 Content-Length). A validated resume that
      // claims `bytes 4-7/8` but streams extra bytes would otherwise finalize a
      // corrupt file with no error (#467 P0-1). This is NOT resumable — the bytes
      // on disk are wrong — so remove the partial + validator and fail; a retry
      // starts clean rather than range-resuming a corrupt prefix.
      await safeRm(targetPath);
      if (resumable) await safeRm(validatorSidecar);
      throw new ModelError(
        `Download oversized: wrote ${actual} bytes but the file is only ${expectedTotal} — the ` +
          `response sent more data than its declared size (corrupt or misbehaving server). Removed ` +
          `the bad file; retry.`,
        { url: logUrl },
      );
    }
  };

  // Reject a completed body that is an HTML/JSON auth/error page rather than a
  // model file (#473). Runs AFTER assertComplete (size is right) but BEFORE the
  // .partial is renamed into place / the sidecar is dropped — a plausibly-sized
  // login page or `{"error":...}` would otherwise pass the size gate and finalize
  // as a corrupt model under a green success. Removes the bad partial + sidecar so
  // a retry starts clean, and surfaces an actionable (CivitAI-aware) error.
  // The response Content-Type — used now for the stream-time check AND returned to
  // the cache layer so it can persist it beside the cache file. A later cache-HIT /
  // coalesced caller re-validates with contentType "" (the header is long gone), so
  // without persisting it a body that only a Content-Type could flag (e.g. an
  // HTML/JSON page whose bytes don't sniff as text) could slip through on reuse (#473).
  const responseContentType = res.headers.get("content-type") || "";
  const assertModelPayload = (): Promise<void> =>
    assertModelPayloadOrThrow({
      targetPath,
      modelExt,
      contentType: responseContentType,
      url,
      logUrl,
      // Remove the rejected partial + its resume sidecar, and if removal fails,
      // NEUTRALIZE the partial (truncate to 0) so a retry can't resume onto the
      // poisoned HTML/JSON prefix (#473 P1). safeRm alone would swallow an EPERM and
      // leave a resumable poisoned partial behind. When resumable, ALSO drop a poison
      // marker so a content-type-only rejection (whose body may sniff as binary on
      // retry) still can't be resumed even if neutralization failed.
      onReject: async () => {
        await discardRejectedPayload(targetPath, resumable ? validatorSidecar : undefined, logUrl);
        if (resumable) await writePoisonMarker(`${targetPath}.rejected`, logUrl);
      },
    });

  // No progress tray AND no stall watchdog (internal/cache caller, not under the
  // panel) → straight pipe, nothing to count.
  if (!progress && !onBytes) {
    await pipeline(nodeStream, fileStream, { signal });
    await assertComplete();
    await assertModelPayload();
    // Complete: the validator sidecar is only needed to guard a resume, so drop it.
    if (resumable) await safeRm(validatorSidecar);
    return responseContentType;
  }

  // Tally bytes as they flow: report throughput to the panel tray (when a tray row
  // was requested) and feed the caller's stall watchdog (#470). The counter now runs
  // whenever EITHER sink is present — the watchdog must be able to bound a wedged
  // attempt even with no panel attached, which is where #470's 30-minute silent
  // stall was observed.
  const total = expectedTotal;
  let downloaded = appendMode ? effectiveResume : 0;
  let windowStart = Date.now();
  let windowBytes = downloaded;
  let bytesPerSec = 0;
  const emit = (status: DownloadProgress["status"], force = false) =>
    progress
      ? reportDownloadProgress(
          { id: progress.id, name: progress.name, attempt: progress.attempt, downloaded, total, bytes_per_sec: bytesPerSec, status },
          force,
        )
      : undefined;
  emit("downloading", true); // show the row immediately, even before the first chunk
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      downloaded += chunk.length;
      // Feed the watchdog FIRST and unconditionally — before the 400 ms throughput
      // window gate — so a trickle that never fills a window still counts as
      // liveness. Gating it would let a slow-but-alive transfer be killed as stalled.
      onBytes?.(chunk.length);
      const now = Date.now();
      const dt = now - windowStart;
      if (dt >= 400) {
        bytesPerSec = ((downloaded - windowBytes) * 1000) / dt;
        windowStart = now;
        windowBytes = downloaded;
        emit("downloading");
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(nodeStream, counter, fileStream, { signal });
    await assertComplete();
    await assertModelPayload();
    if (resumable) await safeRm(validatorSidecar);
    bytesPerSec = 0;
    emit("done", true);
    return responseContentType;
  } catch (err) {
    // On a user cancel (#515) the abort left a resumable .partial on disk. Do NOT emit
    // an "error" row for it, and do NOT clear the row here: this cache layer has no
    // registry context, and a coalesced sibling may share this progress row. The JOB
    // layer (finalizeCancelled) clears it registry-aware. Only a genuine failure emits
    // — and, under a retrying caller, only once that caller has given up
    // (deferErrorRow), so an attempt that is about to be retried never publishes an
    // outcome the agent would act on (#470).
    if (!signal?.aborted && !deferErrorRow) emit("error", true);
    throw err;
  }
}

async function downloadIntoCache(
  url: string,
  headers: Record<string, string>,
  logUrl?: string,
  storageAuth: CloudStorageAuth = {},
  progress?: ProgressMeta,
  onResume?: ResumeReporter,
  modelExt = "",
  signal?: AbortSignal,
): Promise<string> {
  // Representation-aware identity (#467): a same-URL download with different HTTP
  // auth headers OR different cloud (S3/Azure) credentials gets its OWN cache file,
  // partial and in-flight slot — never coalesced onto another caller's stream.
  const target = cachePathForUrl(url, headers, storageAuth);
  const key = target;

  const existing = inflight.get(key);
  // A job COALESCING onto an in-flight physical download gets no resume decision
  // of its own — the decision is reported to the job that actually runs the
  // stream (#467). This is inherent to the callback model: onResume is not passed
  // to the shared promise, so a coalesced caller simply awaits the same result.
  //
  // CANCEL SEMANTICS across coalescing (#515): two DIFFERENT-destination jobs for the
  // same URL+auth are distinct jobs (distinct AbortControllers) but share ONE physical
  // stream here (the first caller's, keyed by cache identity). This shared stream binds
  // the FIRST caller's signal. Integrity is preserved in every case:
  //  - Cancelling the stream OWNER aborts the shared stream; the other (uncancelled)
  //    caller's promise rejects, and since ITS signal is not aborted, downloadWithCache
  //    falls back to a fresh direct download and still completes correctly.
  //  - Cancelling a COALESCED caller does not abort the shared stream (it keeps running
  //    for the owner), but that caller's own commit guard (its aborted signal, checked
  //    in downloadModel before the done row / return) refuses to finalize — so it is
  //    never reported as complete.
  // The deliberate trade-off is prompt stream-abort for the common SOLE-caller case at
  // the cost of a rare redundant re-download when a shared owner is cancelled; no caller
  // can ever false-complete or be corrupted by another's cancel.
  if (existing) return existing;

  const promise = (async () => {
    await downloadCacheFs.mkdir(cacheDir(), { recursive: true });

    try {
      const info = await downloadCacheFs.stat(target);
      if (info.isFile()) {
        // #343 edge: never serve a 0-byte cache entry as a hit. One could exist
        // from an interrupted rename, an older build without the size gate, or
        // external tampering — treat it as a miss and re-download rather than
        // materializing an empty file that reports success.
        if (info.size === 0) {
          await downloadCacheFs.rm(target, { force: true }).catch(() => undefined);
          // Drop its stale Content-Type sidecar too — it now describes nothing.
          await downloadCacheFs.rm(cacheCtSidecar(target), { force: true }).catch(() => undefined);
        } else {
          await touch(target);
          // Cache hit ⇒ no resume/discard this attempt; onResume is never called,
          // so the job's resume field stays empty (nothing to surface).
          return target;
        }
      }
    } catch {
      // Cache miss.
    }

    // Deterministic .partial filename so a crashed/interrupted download
    // resumes from the byte it left off on the next call, rather than
    // restarting from zero. (See streamUrlToFile for the Range + flags
    // handshake.) Cleanup on terminal failure stays unchanged.
    const partial = join(cacheDir(), `.${basename(target)}.partial`);
    const rejectedMarker = `${partial}.rejected`;

    /**
     * The byte offset THIS attempt may resume from, re-derived from disk every
     * time (#470). Re-deriving is the point: after an interrupted attempt the
     * `.partial` is larger than it was, so the next attempt picks up where the
     * last one actually stopped rather than where this call originally started.
     *
     * It returns only a CANDIDATE offset. Nothing here proves the bytes belong to
     * the requested object — that proof is `streamUrlToFile`'s job (the `.etag`
     * validator sidecar recorded at WRITE time, replayed as `If-Range`, plus the
     * content-addressed X-Linked-Etag cross-check for cross-origin 206s, #343/#467).
     * A partial with no recorded write-time identity is NOT resumed; it restarts.
     */
    const resumeOffsetFromDisk = async (): Promise<number> => {
      let resumeFromBytes = 0;
      try {
        const existing = await downloadCacheFs.stat(partial);
        if (existing.isFile() && existing.size > 0) {
          resumeFromBytes = existing.size;
          logger.info("Resuming partial download", {
            url: logUrl,
            bytes: resumeFromBytes,
          });
        }
      } catch {
        // No partial — fresh download.
      }

      // #473 P1 — poison MARKER guard (cleanup- AND content-type-independent). A prior
      // attempt that REJECTED this download (even solely on the response Content-Type,
      // which is gone now) drops a `.rejected` marker next to the partial. If it's
      // present, the leftover partial is poison regardless of what its bytes sniff as —
      // never resume onto it. Discard everything and restart from 0.
      let markerPresent = false;
      try {
        markerPresent = (await downloadCacheFs.stat(rejectedMarker)).isFile();
      } catch {
        /* no marker */
      }
      if (markerPresent) {
        if (resumeFromBytes > 0) {
          logger.warn(
            `Discarding a previously-rejected (${resumeFromBytes}-byte) partial before resume: a ` +
              `poison marker from an earlier non-model rejection is present — restarting from 0 (#473).`,
            { url: logUrl, bytes: resumeFromBytes },
          );
        }
        const neutralized = await discardRejectedPayload(
          partial,
          `${partial}.etag`,
          logUrl ?? redactUrlForLogs(url),
        );
        // Keep the marker if the partial could NOT be neutralized (rm AND truncate both
        // failed), so a still-poisoned leftover stays flagged for the next attempt.
        // resumeFromBytes = 0 forces this attempt to re-download fresh ("w" truncates the
        // leftover), so the poison is cleared here regardless.
        if (neutralized) await safeRm(rejectedMarker);
        resumeFromBytes = 0;
      }

      // #473 P1 — cleanup-INDEPENDENT poison guard (body-magic). A prior attempt may have REJECTED
      // this download as an HTML/JSON auth/error body and then been UNABLE to remove or
      // truncate the leftover .partial (a denied rm AND a denied truncate). Re-inspect
      // the partial's HEAD here, before deciding to resume: if it is itself a non-model
      // (HTML/JSON) body for a binary-model destination, it is poison — NEVER resume
      // onto it. Reset to a fresh download (resumeFromBytes = 0 ⇒ no Range ⇒ the "w"
      // open truncates the poisoned bytes) and best-effort discard the sidecar, so the
      // invariant "a rejected leftover can't be treated as resumable" holds even when
      // both cleanup mechanisms failed. A legitimate in-progress partial sniffs as
      // binary (null) and resumes normally.
      if (resumeFromBytes > 0 && modelExt) {
        const partialHead = await readHead(partial);
        if (detectNonModelPayload(partialHead, "", modelExt)) {
          logger.warn(
            `Discarding a previously-rejected non-model (${resumeFromBytes}-byte) partial before ` +
              `resume: its head is an HTML/JSON auth/error body, not a model — restarting from 0 so ` +
              `the poisoned bytes can't be resumed onto (#473).`,
            { url: logUrl, bytes: resumeFromBytes },
          );
          await discardRejectedPayload(partial, `${partial}.etag`, logUrl ?? redactUrlForLogs(url));
          resumeFromBytes = 0;
        }
      }

      return resumeFromBytes;
    };

    /** Only ever removes an EMPTY partial — a non-empty one is the resume
     *  candidate and is deliberately preserved on every failure path (#470's
     *  governing harm: never destroy progress you cannot re-fetch cheaply). */
    const dropEmptyPartial = async (): Promise<void> => {
      try {
        const remaining = await downloadCacheFs.stat(partial);
        if (remaining.size === 0) {
          await downloadCacheFs.rm(partial, { force: true }).catch(() => undefined);
          // The validator sidecar is only meaningful alongside a resumable
          // partial — drop it too so a later attempt doesn't If-Range against a
          // file that no longer exists.
          await downloadCacheFs.rm(`${partial}.etag`, { force: true }).catch(() => undefined);
        }
      } catch {
        // Partial gone — nothing to clean.
      }
    };

    // ── #470: bounded retry with backoff, resuming each time ──────────────────
    //
    // A transfer that cannot survive an interruption will eventually be killed by
    // one. The `.partial` + `.etag` machinery already made an interrupted transfer
    // RESUMABLE; what was missing is anything that resumes it WITHOUT a human
    // re-issuing the call. This loop is that.
    //
    // Every attempt re-derives its offset from disk and goes through the SAME
    // identity proof a cold call does — there is no "we already checked" shortcut,
    // so a retry can never splice bytes from a different object.
    const retry = downloadRetryPolicy();
    // THE STALL WATCHDOG IS HTTP-ONLY. A cloud (S3/Azure) transfer is performed by
    // the vendor SDK, which writes the file itself and reports no per-chunk
    // progress here — so `onBytes` never fires and a perfectly healthy multi-GB
    // cloud download would look stalled from its first second. Aborting it would be
    // catastrophic rather than merely wasteful: the cloud path cannot range-resume,
    // so every "retry" TRUNCATES the partial and starts over, and a transfer longer
    // than the stall window could never finish. No byte signal ⇒ no watchdog.
    const stallTimeoutMs = supportsCloudDownload(url) ? 0 : retry.stallTimeoutMs;

    /** The partial's size as it stands, distinguishing ABSENT (0 — knowably
     *  nothing) from UNREADABLE (undefined — genuinely unknown). Collapsing the
     *  two would either invent progress that is not there or report a knowable
     *  absence as a mystery. */
    const partialSize = async (): Promise<number | undefined> => {
      try {
        const st = await downloadCacheFs.stat(partial);
        return st.isFile() ? st.size : 0;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        return code === "ENOENT" || code === "ENOTDIR" ? 0 : undefined;
      }
    };

    /** The `.etag` sidecar's exact contents, or "" when it is absent/unreadable.
     *  Read alongside the size because SIZE ALONE cannot catch the dangerous
     *  interference: another writer that truncates and re-stages a DIFFERENT
     *  upstream object to the same length would look unchanged. It cannot do that
     *  without writing that object's validator here, so the sidecar is the part of
     *  the snapshot that actually detects a swapped object. */
    const sidecarBytes = async (): Promise<string | undefined> => {
      try {
        return await readFile(`${partial}.etag`, "utf-8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        // ABSENT is knowable ("" — no validator was ever recorded); anything else
        // (EACCES, EIO, …) means we could not find out, and undefined says so.
        // Collapsing the two would let "I cannot read it" be reported as "the host
        // never sent one", and would let an unknown state pass an equality check.
        return code === "ENOENT" || code === "ENOTDIR" ? "" : undefined;
      }
    };

    /** The one refusal used by both interference checks (between attempts, and at
     *  the last instant before a write), so they cannot drift apart in wording or
     *  in what they promise. It NEVER deletes or truncates anything: the bytes it
     *  is refusing to touch belong to the other download. */
    const interferenceError = (why: string, when: string): ModelError =>
      new ModelError(
        `Download stopped: another download is writing the same staged file, or this attempt cannot ` +
          `establish that it is not (${why} ${when}). Writing now could interleave two transfers into ` +
          `one file, or throw away another download's progress. Nothing was deleted — anything on disk ` +
          `is intact. Check download_status; if another download of this file is running, wait for it ` +
          `and then re-issue this one (it will reuse the completed file rather than re-fetching it).`,
        { url: logUrl, retryable: false },
      );

    /**
     * Compare the staged file's state against what we recorded, and REFUSE unless
     * they are provably identical.
     *
     * Fails CLOSED on an unreadable stat or sidecar. "I could not read it" is not
     * "it is unchanged" — treating it as such is how a retry ends up truncating a
     * file it does not own, which on the cloud path is unrecoverable
     * multi-gigabyte loss. Unknown ownership must stop the write, not switch the
     * detector off.
     */
    const assertStillOurs = async (
      expectedSize: number | undefined,
      expectedSidecar: string | undefined,
      when: string,
      /** Require the size to be KNOWN on both sides, not merely unchanged.
       *
       *  True only across a retry boundary, and that asymmetry is the point. Once
       *  we have left bytes on disk and gone quiet for a backoff, "I cannot read
       *  the staged file" is exactly the state in which assuming it is still ours
       *  and truncating it destroys another writer's work — so it must refuse.
       *  Within a single attempt there is no such history: an unreadable file was
       *  unreadable before we started, which is a pre-existing condition the older
       *  guards diagnose far more precisely (#467 P1-B's "could not be verified",
       *  #467 P0c's stale-sidecar refusal). Refusing there would replace an
       *  accurate diagnosis with a wrong one and block first attempts that never
       *  had anything to own. */
      strict: boolean,
    ): Promise<void> => {
      const nowSize = await partialSize();
      const nowSidecar = await sidecarBytes();
      // `partialSize` reports a missing file as a definite 0, so `undefined` means
      // the file is THERE but unreadable.
      if (strict && (expectedSize === undefined || nowSize === undefined)) {
        throw interferenceError("the staged file's size could not be read", when);
      }
      if (nowSize !== expectedSize) {
        throw interferenceError(
          `it went from ${expectedSize ?? "an unreadable size"} to ${nowSize ?? "an unreadable size"} bytes`,
          when,
        );
      }
      // The SIDECAR gets the same strict treatment across a retry boundary, and for
      // the same reason as the size: an unreadable validator is not a matching one.
      // It matters specifically because readValidatorSidecar() reads "unreadable"
      // as "no validator", which sends the attempt down the 200-restart path — and
      // that path TRUNCATES the staged file. So an unknown validator plus a
      // same-size replacement by another writer would destroy their partial.
      if (strict && (expectedSidecar === undefined || nowSidecar === undefined)) {
        throw interferenceError("the staged file's resume validator could not be read", when);
      }
      // WITHIN one attempt it is only compared for CHANGE. A sidecar that was
      // ALREADY unreadable a moment ago is a stable pre-existing condition (a
      // blocked path, a stale directory), not evidence of another writer, and it
      // has its own better-targeted guard downstream (#467 P0c refuses to pair new
      // bytes with a sidecar it cannot neutralize). Refusing here would replace
      // that precise diagnosis with a wrong one. `undefined !== undefined` is
      // false, so this compares equal only when genuinely unchanged, and still
      // catches readable-then-not.
      if (nowSidecar !== expectedSidecar) {
        throw interferenceError(
          "its resume validator changed, so a DIFFERENT upstream object has been staged there",
          when,
        );
      }
    };

    /** What WE left the partial (and its validator) at when our previous attempt
     *  ended. `sizeWeLeft` stays NULL before the first retry — there is nothing to
     *  compare against yet. That is deliberately distinct from `undefined`, which
     *  means "we tried to read it and could not" and must REFUSE rather than skip. */
    let sizeWeLeft: number | undefined | null = null;
    let sidecarWeLeft: string | undefined = "";

    for (let attempt = 1; ; attempt += 1) {
      // A cancel between attempts stops here — never consumed by a retry.
      if (signal?.aborted) throw new DOMException("The download was cancelled.", "AbortError");

      // ── ANOTHER WRITER OWNS THIS PARTIAL ──────────────────────────────────
      //
      // The `.partial` is keyed by the download's representation (url + auth
      // headers), so a SECOND PROCESS running the same download shares this exact
      // file. The job registry's cross-process dedup is best-effort by design
      // (#529): two processes that start at the same instant can both run writers.
      //
      // Before this loop existed that cost, at worst, a duplicate transfer — a
      // failed attempt simply ended. A retry changes the shape: we go quiet for a
      // backoff and then come BACK and append. If another writer moved the file
      // while we waited, appending would interleave two streams into one file.
      //
      // Nothing WE do touches the partial (or its `.etag`) between our own
      // attempts, so ANY change to either is proof that someone else is writing
      // it. Detect that and stop rather than compete: the other writer is
      // producing a valid file, and the honest, non-destructive move is to leave it
      // alone. (We deliberately do NOT delete or truncate anything here — those
      // bytes are the other download's.)
      //
      // WHAT THIS DOES AND DOES NOT BUY — stated precisely, because it is easy to
      // over-claim here. It is a DETECTOR, not a lock. It covers the window in
      // which this loop is idle (the backoff), and a second check immediately
      // before any write (`beforeWrite`, passed below) covers the window between
      // reading the file's state and acting on it. Together they close the
      // interference this retry loop ADDS over a single-shot download.
      //
      // What remains OPEN is pre-existing and not closable by observation: two
      // processes streaming into this shared file at genuinely overlapping times.
      // A snapshot cannot exclude a writer that acts between our last check and our
      // own write, and no ordering of checks can. Closing it needs real write
      // exclusion on the staged file (an owned claim held for the download's
      // lifetime), which is a larger change than this cluster and applies equally
      // to the non-retry path. It is NOT made worse here, and it is deliberately
      // left for a follow-up rather than half-solved with a lease whose stale-claim
      // and crash-cleanup behaviour (#529's objection) could destroy live partials.
      if (sizeWeLeft !== null) {
        // STRICT: we left bytes here and went quiet, so unknown state must refuse.
        await assertStillOurs(sizeWeLeft, sidecarWeLeft, "while this attempt was backing off", true);
      }

      const resumeFromBytes = await resumeOffsetFromDisk();

      // The state THIS attempt based its resume decision on. Re-verified at the
      // last instant before any write (see `beforeWrite`), so the decision and the
      // action are checked against the same file rather than merely assumed to
      // describe it. Taken AFTER resumeOffsetFromDisk because that call may itself
      // discard a poisoned partial.
      const decidedSize = await partialSize();
      const decidedSidecar = await sidecarBytes();

      // Per-attempt abort, fed by TWO independent sources: the caller's cancel
      // (forwarded) and our stall watchdog. They are kept distinguishable — the
      // caller's `signal` is still consulted directly below — because a cancel must
      // never be retried into a completion, while a stall must always be.
      const attemptCtl = new AbortController();
      const forwardCancel = (): void => attemptCtl.abort();
      // An `abort` listener added to an ALREADY-aborted signal never fires, so
      // forward the existing state explicitly rather than registering a listener
      // that can never run — otherwise an attempt could start with a live signal
      // for a download the caller has already cancelled.
      if (signal?.aborted) attemptCtl.abort();
      else signal?.addEventListener("abort", forwardCancel, { once: true });
      let stalled = false;
      let lastByteAt = Date.now();
      const stallTicker =
        stallTimeoutMs > 0
          ? setInterval(
              () => {
                if (Date.now() - lastByteAt >= stallTimeoutMs) {
                  stalled = true;
                  attemptCtl.abort();
                }
              },
              Math.min(5_000, Math.max(500, Math.floor(stallTimeoutMs / 4))),
            )
          : undefined;
      if (stallTicker && typeof stallTicker.unref === "function") stallTicker.unref();

      try {
        const contentType = await streamUrlToFile(
          url,
          partial,
          headers,
          logUrl,
          storageAuth,
          resumeFromBytes,
          progress,
          true, // resumable: cache partials use the .partial + If-Range resume handshake
          onResume,
          modelExt,
          attemptCtl.signal,
          () => {
            lastByteAt = Date.now();
          },
          // WE decide when this download is over, so no attempt publishes a
          // terminal "error" row on our behalf (#470 / #547).
          true,
          // Re-verify, immediately before the first write, that the staged file is
          // still the one this attempt reasoned about.
          async () => {
            // Change-detection only: within one attempt an unreadable file was
            // already unreadable, and the older guards diagnose that better.
            await assertStillOurs(
              decidedSize,
              decidedSidecar,
              "while this attempt was requesting it",
              false,
            );
          },
        );
        await downloadCacheFs.rename(partial, target);
        await touch(target);
        // Persist the response Content-Type beside the cache file so a later cache-HIT /
        // coalesced caller re-validates with it (#473 reuse gap).
        await writeCacheContentType(target, contentType);
        // Clean any stale poison marker now that a CLEAN payload finalized under this
        // key — the partial is gone (renamed) and the bytes passed validation.
        await safeRm(rejectedMarker);
        return target;
      } catch (err) {
        // THE CALLER CANCELLED. Checked before anything else and never classified:
        // a cancel is a decision, not a failure, and retrying it would resurrect a
        // transfer the user stopped. The partial is left for a later resume.
        if (signal?.aborted) {
          await dropEmptyPartial();
          throw err;
        }

        const cls = stalled
          ? {
              retryable: true,
              reason: `no bytes arrived for ${Math.round(stallTimeoutMs / 1000)}s (the connection wedged without closing)`,
            }
          : classifyDownloadFailure(err);

        if (!cls.retryable || attempt >= retry.maxAttempts) {
          await dropEmptyPartial();
          // NOTE: no terminal "error" row is published here. downloadModel already
          // emits exactly one when this whole call throws (model-resolver.ts), which
          // is precisely the moment the download is genuinely over. Withholding the
          // per-attempt rows (deferErrorRow) therefore removes the FALSE failures
          // without removing the real one — and without double-reporting it.
          // Only ANNOTATE when retries actually happened and the cause was transient
          // — an auth/gating failure must keep its own actionable message intact.
          if (attempt > 1 && cls.retryable) {
            // `partialSize` separates ABSENT (0) from UNREADABLE (undefined), so a
            // knowable "there is nothing to resume" is never dressed up as a
            // mystery, and a genuine mystery is never asserted as a fact.
            const kept = await partialSize();
            // Whether those bytes are actually RESUMABLE, which is not the same
            // question as whether they exist. A resume requires the write-time
            // validator; without one the prefix has no recorded identity and the
            // next call deliberately restarts from zero (#343/#467). Promising
            // "re-issuing resumes from there" in that case is a remedy the caller
            // cannot act on — the bytes are real but they will be re-fetched.
            // THREE states, not two: a validator was recorded, none was (the host
            // sent none), or we could not find out. The last must not be reported
            // as either of the first two — claiming "the host never sent one" when
            // the sidecar merely could not be read is a definite verdict drawn from
            // an absence of evidence.
            const sidecar = await sidecarBytes();
            const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(2);
            const partialNote =
              kept === undefined
                ? `The partial download's size could NOT be read, so how much progress survived is unknown — check the download cache before assuming either way.`
                : kept > 0
                  ? sidecar === undefined
                    ? `${gb(kept)} GB of partial data is on disk, but its resume-validator sidecar could not be read, so whether a re-issue can RESUME those bytes or must re-download them could not be determined here. Re-issue and watch download_status, which reports the resume decision the next attempt actually makes.`
                    : sidecar.trim().length > 0
                      ? `${gb(kept)} GB of partial data is preserved on disk; re-issuing the SAME download resumes from there (it is not re-fetched) provided the host still serves the same object.`
                      : `${gb(kept)} GB of partial data is on disk, but the host never sent an ETag/Last-Modified validator for it, so there is no recorded proof of WHICH object those bytes belong to. A re-issue will therefore restart from the beginning rather than resume — appending to a prefix of unknown provenance is how a model gets silently corrupted (#343/#467).`
                  : `No partial data survived, so a re-issue restarts from the beginning.`;
            throw new ModelError(
              `Download failed after ${attempt} attempts (the last ${attempt - 1} were automatic retries with backoff): ` +
                `${err instanceof Error ? err.message : String(err)} — ${cls.reason}. ${partialNote}`,
              { url: logUrl, attempts: attempt, retryable: false },
            );
          }
          throw err;
        }

        const delay = backoffDelayMs(attempt, retry);
        logger.warn(
          `Download attempt ${attempt}/${retry.maxAttempts} failed and will be retried in ` +
            `${Math.round(delay / 1000)}s: ${cls.reason}. The partial file is kept and the retry ` +
            `resumes from it (re-proving the object's identity first, #467).`,
          {
            url: logUrl,
            attempt,
            bytesBeforeAttempt: resumeFromBytes,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        // Record where WE left the partial, so the next attempt can tell "nobody
        // touched it" from "another writer moved it" (the interference check at the
        // top of the loop). Taken AFTER the attempt has fully unwound, so it
        // reflects the final on-disk state this attempt produced.
        sizeWeLeft = await partialSize();
        sidecarWeLeft = await sidecarBytes();
        // Backoff before re-requesting. #470 observed a 403 from an INSTANT
        // re-request after an aborted connection — the wait is part of the fix,
        // not politeness. It wakes early if the caller cancels.
        await abortableDelay(delay, signal);
      } finally {
        if (stallTicker) clearInterval(stallTicker);
        signal?.removeEventListener("abort", forwardCancel);
      }
    }
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

/** A cryptographically-random, unguessable temp path next to `base`. NOT a
 *  predictable pid+counter name (#467 P1-A): a predictable name can collide with a
 *  temp left by a crashed attempt or a reused PID, and — if that leftover is still
 *  hardlinked to a cache inode — a non-exclusive create would truncate it and
 *  corrupt that cache entry. Random + exclusive-create makes a collision effectively
 *  impossible AND detectable (EEXIST), so we never write over a pre-existing file. */
function randomTempPath(base: string, tag: string): string {
  return `${base}.${tag}-${randomBytes(12).toString("hex")}.tmp`;
}

/** Reserve an unguessable temp path by creating it EXCLUSIVELY (O_EXCL via the "wx"
 *  flag), retrying on the astronomically-unlikely EEXIST. Guarantees the returned
 *  path is a FRESH standalone inode — so a subsequent "w" open (streamUrlToFile /
 *  the S3/Azure downloaders truncate) writes to our own new file and can NEVER
 *  follow a pre-existing hardlink into a cache inode (#467 P1-A). */
async function reserveExclusiveTemp(base: string, tag: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const p = randomTempPath(base, tag);
    try {
      await writeFile(p, "", { flag: "wx" });
      return p;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST" && attempt < MATERIALIZE_TEMP_ATTEMPTS) {
        continue;
      }
      throw err;
    }
  }
}

/** True for a hardlink error that means "hardlinks aren't usable here" — the ONLY
 *  case where copy-fallback is legitimate. NOT EEXIST (a name collision — retry a
 *  new name; copy-falling-back there is what truncates a stale hardlinked temp and
 *  poisons a cache inode, #467 P1-A) and NOT other errors (propagate). */
function isHardlinkUnsupported(code: unknown): boolean {
  // ONLY genuine "hardlinks aren't usable here" codes: cross-device (EXDEV), the FS
  // doesn't support links (ENOSYS/EPERM — some Windows/network FS). NOT EACCES — an
  // ACL denial is a real permission error that must propagate, not silently copy
  // (#467 P2).
  return code === "EXDEV" || code === "EPERM" || code === "ENOSYS";
}

/** Rename `tmp` over `targetPath`. On POSIX, rename atomically replaces an existing
 *  destination. Windows can't rename OVER an existing file and returns EPERM/EACCES/
 *  EEXIST — ONLY then do we move the destination ASIDE and swap. Any OTHER rename
 *  error (ENOENT, EIO, EXDEV, …) must NOT touch a valid existing destination (#467):
 *  clean our temp and propagate. */
async function renameTempOverDestination(
  tmp: string,
  targetPath: string,
  /** Fired SYNCHRONOUSLY the instant the destination rename succeeds — BEFORE any
   *  further await (e.g. Windows backup cleanup) — so the job can commit "done" with no
   *  window where the file is at its destination yet the job still reads "downloading"
   *  and a cancel could falsely mark it cancelled (#515). */
  onLanded?: (targetPath: string) => void,
  /** Abort signal (#515). Checked before the atomic replace AND (Windows path) after the
   *  destination is moved aside but before the swap — so a cancel that lands during the
   *  backup move restores the original and bails instead of swapping the temp in. */
  signal?: AbortSignal,
): Promise<void> {
  // Cancelled before the swap — leave the destination untouched (the temp is cleaned up).
  if (signal?.aborted) {
    await downloadCacheFs.rm(tmp, { force: true }).catch(() => undefined);
    throw new DOMException("The download was cancelled.", "AbortError");
  }
  try {
    await downloadCacheFs.rename(tmp, targetPath);
    onLanded?.(targetPath); // landed (POSIX atomic replace) — commit done before returning
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const windowsOverwrite =
      process.platform === "win32" &&
      (code === "EPERM" || code === "EACCES" || code === "EEXIST");
    if (!windowsOverwrite) {
      await downloadCacheFs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    // Windows: move the existing destination ASIDE to a backup, then swap the temp
    // in. On ANY swap failure, RESTORE the backup so a valid destination is never
    // lost. If even the restore fails, the original is INTACT at `backup` — surface
    // that path in the error so it's recoverable, never silently stranded (#467).
    const backup = `${targetPath}.bak-${randomBytes(9).toString("hex")}.tmp`;
    let backedUp = false;
    try {
      await downloadCacheFs.rename(targetPath, backup);
      backedUp = true;
    } catch {
      /* destination may not exist — nothing to move aside */
    }
    // A cancel that landed WHILE we moved the old destination aside must NOT swap the
    // temp in — restore the original and bail, so a cancelled download never lands its
    // file over the destination (#515). The temp is cleaned up.
    if (signal?.aborted) {
      await downloadCacheFs.rm(tmp, { force: true }).catch(() => undefined);
      if (backedUp) {
        const restored = await downloadCacheFs
          .rename(backup, targetPath)
          .then(() => true)
          .catch(() => false);
        if (!restored) {
          throw new ModelError(
            `Download cancelled but the previous file could not be restored — it is PRESERVED at ` +
              `"${backup}"; move it back to "${targetPath}" manually.`,
            { url: targetPath },
          );
        }
      }
      throw new DOMException("The download was cancelled.", "AbortError");
    }
    try {
      await downloadCacheFs.rename(tmp, targetPath);
      // Swapped in — the file is at its destination. Commit done NOW, before the backup
      // cleanup await, so a cancel during that await can't falsely mark a landed file
      // cancelled (#515).
      onLanded?.(targetPath);
      if (backedUp) await downloadCacheFs.rm(backup, { force: true }).catch(() => undefined);
    } catch (e) {
      await downloadCacheFs.rm(tmp, { force: true }).catch(() => undefined);
      if (backedUp) {
        const restored = await downloadCacheFs
          .rename(backup, targetPath)
          .then(() => true)
          .catch(() => false);
        if (!restored) {
          throw new ModelError(
            `Download could not be finalized and the destination could not be restored — your ` +
              `previous file is PRESERVED at "${backup}"; move it back to "${targetPath}" manually. ` +
              `Cause: ${e instanceof Error ? e.message : String(e)}`,
            { url: targetPath },
          );
        }
      }
      throw e;
    }
  }
}

const MATERIALIZE_TEMP_ATTEMPTS = 5;

async function materializeCacheFile(
  cachePath: string,
  targetPath: string,
  signal?: AbortSignal,
  onLanded?: (targetPath: string) => void,
): Promise<"hardlink" | "copy"> {
  if (resolve(cachePath) === resolve(targetPath)) {
    // The download streamed directly to the destination (cache === target) — it is
    // already on disk; commit "done" synchronously (#515).
    onLanded?.(targetPath);
    return "hardlink";
  }

  // Materialize ATOMICALLY into an UNGUESSABLE, EXCLUSIVELY-created temp, then
  // rename over targetPath — never write directly at targetPath, and never reuse a
  // possibly-stale temp name (#467 P1-A). Two jobs materializing DIFFERENT
  // representations to the SAME path can race; building each in its own random temp
  // (a hardlink to, or an EXCLUSIVE copy of, our OWN cache inode) keeps every cache
  // inode read-only here and makes the final swap atomic (last-writer-wins on the
  // destination only, never a cache entry).
  for (let attempt = 1; ; attempt++) {
    const tmp = randomTempPath(targetPath, "mat");
    let mode: "hardlink" | "copy";
    try {
      await downloadCacheFs.link(cachePath, tmp);
      mode = "hardlink";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // Name collision → pick a fresh random name (never copy-fall-back onto a
      // possibly-stale, possibly-cache-hardlinked temp).
      if (code === "EEXIST") {
        if (attempt >= MATERIALIZE_TEMP_ATTEMPTS) throw err;
        continue;
      }
      // Only fall back to copy when hardlinks genuinely aren't usable here.
      if (!isHardlinkUnsupported(code)) throw err;
      try {
        // EXCLUSIVE copy: fail (EEXIST) rather than truncate a pre-existing file.
        await downloadCacheFs.copyFile(cachePath, tmp, fsConstants.COPYFILE_EXCL);
      } catch (e) {
        const ecode = (e as NodeJS.ErrnoException)?.code;
        await downloadCacheFs.rm(tmp, { force: true }).catch(() => undefined);
        if (ecode === "EEXIST" && attempt < MATERIALIZE_TEMP_ATTEMPTS) continue;
        throw e;
      }
      mode = "copy";
    }
    // FINAL CANCEL GUARD (#515): the temp is built but NOT yet swapped in. If this
    // caller was cancelled, remove the temp and bail WITHOUT replacing the destination
    // — so a cancelled download never lands its target even if the abort arrived during
    // materialization. (The cache entry itself is untouched — the temp was our own.)
    if (signal?.aborted) {
      await downloadCacheFs.rm(tmp, { force: true }).catch(() => undefined);
      throw new DOMException("The download was cancelled.", "AbortError");
    }
    // onLanded fires INSIDE renameTempOverDestination the instant the destination rename
    // succeeds (before any Windows backup cleanup await), closing the landed→return
    // window entirely; the signal lets it also abort the Windows swap after the backup
    // move (#515).
    await renameTempOverDestination(tmp, targetPath, onLanded, signal);
    return mode;
  }
}

async function evictLruIfNeeded(): Promise<void> {
  const limit = cacheSizeLimitBytes();
  if (limit <= 0) return;

  const dir = cacheDir();
  const entries = await downloadCacheFs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map(async (entry) => {
        const path = join(dir, entry.name);
        const info = await downloadCacheFs.stat(path);
        return {
          path,
          size: info.size,
          time: Math.max(info.atimeMs, info.mtimeMs),
        };
      }),
  );

  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= limit) return;

  files.sort((a, b) => a.time - b.time);
  for (const file of files) {
    await downloadCacheFs.rm(file.path, { force: true });
    // Evict the Content-Type sidecar with its cache file so it can't outlive it.
    await downloadCacheFs.rm(cacheCtSidecar(file.path), { force: true }).catch(() => undefined);
    total -= file.size;
    if (total <= limit) break;
  }
}

export async function downloadUrlToFile(
  url: string,
  targetPath: string,
  headers: Record<string, string>,
  logUrl?: string,
  storageAuth: CloudStorageAuth = {},
  progress?: ProgressMeta,
  modelExt = extname(targetPath),
  signal?: AbortSignal,
  /** See streamUrlToFile: when true the caller owns the terminal "error" row. The
   *  cache-unavailable fallback in downloadWithCache passes true because
   *  downloadModel already publishes exactly one row when the whole call throws;
   *  emitting here as well would write that outcome twice (#470/#547). */
  deferErrorRow = false,
): Promise<void> {
  await streamUrlToFile(
    url,
    targetPath,
    headers,
    logUrl,
    storageAuth,
    0,
    progress,
    false,
    undefined,
    modelExt,
    signal,
    undefined,
    deferErrorRow,
  );
}

export async function downloadWithCache(
  options: DownloadCacheOptions,
): Promise<DownloadCacheResult> {
  const logUrl = options.logUrl ?? redactUrlForLogs(options.url);
  // The FINAL destination extension drives model-payload validation (#473). Derived
  // from the real targetPath here — NOT from the .partial / random temp we actually
  // stream into (those carry `.partial`/`.tmp`) — and threaded down so the completed
  // body is checked against what the destination IS (a `.safetensors` etc.).
  const modelExt = extname(options.targetPath);
  try {
    const cachePath = await downloadIntoCache(
      options.url,
      options.headers,
      logUrl,
      options.storageAuth,
      options.progress,
      options.onResume,
      modelExt,
      options.signal,
    );
    // CANCEL GUARD (#515): a COALESCED caller (or a CACHE HIT) reaches here without
    // ever streaming — it awaited another job's shared physical download. If THIS
    // caller was cancelled meanwhile, it must NOT materialize its destination: bail
    // BEFORE validation/materialization so a cancelled download never lands a completed
    // file at its models path (which we'd then misreport as "cancelled, partial left").
    if (options.signal?.aborted) throw new DOMException("The download was cancelled.", "AbortError");
    // Validate the CACHE FILE itself before materializing it to this destination —
    // this is the authoritative per-caller gate (#473). It covers four cases the
    // stream-time check can't: (1) a CACHE HIT that skipped streaming entirely,
    // (2) a COALESCED caller whose .safetensors destination consumed a stream that
    // ran under a different (e.g. non-model) caller's modelExt, (3) a legacy cache
    // entry poisoned before this fix, and (4) a body that ONLY the Content-Type could
    // flag (its bytes don't sniff as text). The live Content-Type header is gone by
    // now, so we recover it from the `.ct` sidecar persisted at download time —
    // otherwise a Content-Type-only-flaggable body could finalize as a model on reuse.
    const cachedContentType = await readCacheContentType(cachePath);
    await assertModelPayloadOrThrow({
      targetPath: cachePath,
      modelExt,
      contentType: cachedContentType,
      url: options.url,
      logUrl,
      // Drop the poisoned cache entry (+ its Content-Type sidecar) so a retry
      // re-downloads clean rather than re-serving the same bad bytes on every call.
      // Truncate-to-0 fallback if rm fails (a 0-byte cache entry is treated as a
      // miss), and log if even that fails, so a poisoned cache entry can't silently
      // re-poison cache hits (#473 P1).
      onReject: async () => {
        const neutralized = await discardRejectedPayload(cachePath, undefined, logUrl);
        // Only drop the Content-Type sidecar once the poisoned cache file is actually
        // gone/emptied. If the cache file SURVIVED (rm AND truncate both failed), KEEP
        // the `.ct` so the NEXT caller can still reject it by its persisted
        // Content-Type — deleting the evidence would let a Content-Type-only poison be
        // re-served as a model on a later cache hit (#473 P1).
        if (neutralized) await safeRm(cacheCtSidecar(cachePath));
      },
    });
    const materializedBy = await materializeCacheFile(
      cachePath,
      options.targetPath,
      options.signal,
      options.onLanded,
    );
    await evictLruIfNeeded();
    return {
      targetPath: options.targetPath,
      usedCache: true,
      cachePath,
      materializedBy,
    };
  } catch (err) {
    if (err instanceof ModelError) throw err;
    // A user cancel (#515) aborted the transfer — do NOT fall back to a direct
    // download (it would immediately re-abort). Propagate so the job records a
    // clean cancellation; the resumable .partial is left in the cache dir.
    if (options.signal?.aborted) throw err;
    logger.warn("Download cache unavailable; falling back to direct download", {
      url: logUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    // Download to an EXCLUSIVELY-created, unguessable temp then rename over the
    // destination — NEVER stream "w" directly at targetPath (#467). If a concurrent
    // materialize already hardlinked targetPath to a cache inode, a direct "w" open
    // would follow that hardlink and overwrite the OTHER representation's cache
    // entry with these bytes (poison). Reserving the temp with O_EXCL guarantees a
    // fresh standalone inode, so the downloader's "w"/truncate can never follow a
    // pre-existing hardlink; rename only swaps the directory entry. A failed stream
    // leaves the destination untouched.
    const tmp = await reserveExclusiveTemp(options.targetPath, "dl");
    try {
      await downloadUrlToFile(
        options.url,
        tmp,
        options.headers,
        logUrl,
        options.storageAuth,
        options.progress,
        modelExt,
        options.signal,
        // downloadModel emits the single terminal "error" row when this whole call
        // throws; this fallback stream must not emit a second one for the same
        // failure (#470/#547).
        true,
      );
      // PRE-RENAME CANCEL GUARD (#515), mirroring the cache-path materialize guard: a
      // cancel that arrived during the post-stream validation lets the stream return
      // normally, but we must NOT swap the temp into the destination — bail so a
      // cancelled download never lands its target here either. (An abort DURING the
      // un-interruptible rename lands a complete, validated file → the job reports done,
      // consistent with the invariant.) The temp is removed by the catch below.
      if (options.signal?.aborted) throw new DOMException("The download was cancelled.", "AbortError");
      // onLanded fires inside renameTempOverDestination at the successful rename (before
      // any backup-cleanup await) — commits "done" with no landed→return window; the
      // signal also aborts the Windows swap after the backup move (#515).
      await renameTempOverDestination(tmp, options.targetPath, options.onLanded, options.signal);
    } catch (e) {
      await downloadCacheFs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    return { targetPath: options.targetPath, usedCache: false };
  }
}
