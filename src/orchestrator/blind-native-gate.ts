/**
 * Blind gate for the Claude backend's NATIVE tools (the issue #90 promise,
 * extended to the SDK subprocess).
 *
 * The MCP-side gate (src/tools/index.ts, COMFYUI_MCP_BLIND) scrubs image blocks
 * from every comfyui tool result — but the Claude Agent SDK runs the full
 * claude_code preset under bypassPermissions, so the model ALSO holds native
 * Read and WebFetch. Native Read on a PNG (or a PDF page, or a notebook's cell
 * outputs) delivers rendered pixels to the model without any MCP tool in the
 * path, which silently voids the "the agent NEVER receives image pixels"
 * promise. Reproduced live: Blind ON, the agent read a LoadImage input file
 * with native Read and described the photo in detail.
 *
 * Enforcement is a PreToolUse hook (mechanical — a deny the model cannot route
 * around), not a prompt. The hook reads the isBlind() predicate at CALL time,
 * so a mid-session Blind toggle binds the very next tool call — it does not
 * wait for the coalesced at-idle agent respawn the env gate needs.
 *
 * Coverage is the pixel-DELIVERY channels only: Read (renders raster images,
 * PDFs, .ipynb outputs) and WebFetch (can hand back image content — including
 * ComfyUI's own /view endpoint). Bash & friends return text; a model cannot
 * recover pixels from base64 text, so they stay open. Renaming a file does not
 * help: Read denial sniffs magic bytes as well as extensions.
 */

import { openSync, readSync, closeSync } from "node:fs";

/** Extensions native Read would render as pixels (raster formats), plus the
 *  two container formats whose Read output embeds rendered images (PDF pages,
 *  notebook cell outputs). SVG is excluded: Read returns its source text. */
const PIXEL_READ_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff",
  "avif", "heic", "heif", "ico", "pdf", "ipynb",
]);

/** Extensions that mark a URL as image content for WebFetch. */
const PIXEL_URL_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "avif", "heic", "heif", "ico",
]);

const extensionOf = (path: string): string => {
  const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

/** True when the file's leading bytes are a known raster/PDF signature — the
 *  defense against `cp photo.png notes.txt` extension games. Unreadable or
 *  short files sniff false: if the harness can't read it, it can't render it. */
export function sniffsAsPixels(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const head = Buffer.alloc(16);
    const n = readSync(fd, head, 0, 16, 0);
    if (n < 4) return false;
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true; // PNG
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true; // JPEG
    if (head.toString("latin1", 0, 4) === "GIF8") return true; // GIF87a/89a
    if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return true;
    if (head[0] === 0x42 && head[1] === 0x4d) return true; // BMP
    if (head.toString("latin1", 0, 4) === "II*\0" || head.toString("latin1", 0, 4) === "MM\0*") return true; // TIFF
    if (head.toString("latin1", 0, 4) === "%PDF") return true;
    if (n >= 12 && head.toString("latin1", 4, 8) === "ftyp") return true; // AVIF/HEIC/HEIF box
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export interface NativePixelVerdict {
  deny: boolean;
  /** What was blocked, for the deny reason ("image file …", "image URL …"). */
  what?: string;
}

/** Decide whether one native tool call would deliver pixels. Pure over its
 *  inputs apart from the Read magic-byte sniff. Unknown tools and malformed
 *  inputs allow: the MCP scrub and the message-path withholding still stand,
 *  and a gate that blocks ordinary text work teaches users to turn Blind off. */
export function evaluateNativePixelTool(toolName: string, toolInput: unknown): NativePixelVerdict {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  if (toolName === "Read") {
    const filePath = typeof input.file_path === "string" ? input.file_path : "";
    if (!filePath) return { deny: false };
    if (PIXEL_READ_EXTENSIONS.has(extensionOf(filePath)) || sniffsAsPixels(filePath)) {
      return { deny: true, what: `image/document file ${filePath}` };
    }
    return { deny: false };
  }
  if (toolName === "WebFetch") {
    const url = typeof input.url === "string" ? input.url : "";
    if (!url) return { deny: false };
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return { deny: false };
    }
    // ComfyUI serves every input/output/temp image through /view (and the
    // /api/view alias) — the exact endpoint the original #90 leak used.
    if (pathname === "/view" || pathname.endsWith("/api/view")) return { deny: true, what: `ComfyUI /view URL` };
    if (PIXEL_URL_EXTENSIONS.has(extensionOf(pathname))) return { deny: true, what: `image URL ${url}` };
    return { deny: false };
  }
  return { deny: false };
}

/** The SDK PreToolUse hook. Kept dependency-free of SDK types (structurally
 *  compatible with HookCallback) so the SDK stays a lazy import. */
export function makeBlindNativeHook(isBlind?: () => boolean) {
  return async (input: unknown): Promise<Record<string, unknown>> => {
    if (!isBlind?.()) return {};
    const call = (input ?? {}) as { hook_event_name?: string; tool_name?: string; tool_input?: unknown };
    if (call.hook_event_name !== "PreToolUse" || !call.tool_name) return {};
    const verdict = evaluateNativePixelTool(call.tool_name, call.tool_input);
    if (!verdict.deny) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Blind mode: ${verdict.what ?? "image content"} withheld. The user's Blind setting means ` +
          "you NEVER receive image pixels — through any tool, native ones included. Work from " +
          "filenames/metadata, and tell the user to inspect the image themselves if it matters.",
      },
    };
  };
}
