import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { join, basename, isAbsolute, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listOutputImages,
  listOutputMedia,
  getOutputImage,
  uploadImageAuto,
  uploadVideoAuto,
  uploadAudioAuto,
  stageOutputAsInput,
} from "../services/image-management.js";
import { AssetRegistry } from "../services/asset-registry.js";
import { reconcileAssetsFromHistory } from "../services/asset-reconcile.js";
import { viewAssetImage } from "../services/view-image.js";
import { convertImage } from "../services/image-convert.js";
import { boundInlineImage } from "../services/inline-preview.js";
import { analyzeColor } from "../services/color-analysis.js";
import { uploadOutput } from "../services/storage-upload.js";
import type { UploadOutputOptions } from "../services/storage-upload.js";
import { errorToToolResult } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/**
 * Where get_image action:"get" writes when the caller names no directory (#768).
 *
 * It used to be `process.cwd()`, which is not a location this process chose — it is
 * whatever directory the MCP client happened to launch us from. On Windows that is
 * routinely `C:\Windows\System32`, and the write died with EPERM *after* the image had
 * already been fetched. The schema had always DOCUMENTED `/tmp/comfyui-images/`; the
 * string existed nowhere in the code, and `/tmp` is not a real directory on Windows
 * anyway. `os.tmpdir()` is the platform-correct, process-writable spelling of the same
 * promise (`%LOCALAPPDATA%\Temp` on Windows, `/tmp` on Linux, `$TMPDIR` on macOS).
 *
 * Computed per call rather than at module load so a test (or a caller) that repoints
 * TMPDIR/TEMP is honoured instead of being silently pinned to the value at import time.
 *
 * `os.tmpdir()` returns %TEMP%/%TMP%/$TMPDIR verbatim, and nothing guarantees those are
 * usable as a launch-independent base. Merely `resolve()`-ing a bad one would anchor it
 * to the MCP process's cwd and land us straight back in System32, so an unqualified
 * tmpdir is not used at all: `os.homedir()` is always fully qualified and always writable
 * by us, and the whole point of this function is to name a directory that does not depend
 * on where we were launched.
 */
export function defaultImageSaveDir(): string {
  const tmp = tmpdir();
  return resolve(isFullyQualified(tmp) ? tmp : homedir(), "comfyui-images");
}

/**
 * Is this path independent of the process's current directory — INCLUDING its drive?
 *
 * `path.isAbsolute` is not that test on Windows. It answers true for `\Temp`, which is
 * DRIVE-RELATIVE: `resolve("\\Temp", …)` picks up whatever drive the cwd happens to be
 * on, so `TEMP=\Windows\System32` reproduces the very failure #768 is about on a
 * C:-launched process. Only a drive-qualified path (`C:\…`) or a UNC path
 * (`\\server\share\…`) is genuinely launch-independent.
 */
function isFullyQualified(p: string | undefined): boolean {
  if (!p) return false;
  if (process.platform !== "win32") return isAbsolute(p);
  return /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
}

/**
 * Turn the caller's `save_dir` into an ABSOLUTE destination directory.
 *
 * Omitted → the documented default. A relative value keeps its historical meaning
 * (resolved against this process's cwd — the issue asked for explicit `save_dir`
 * behaviour to be left alone) but is resolved EAGERLY, so every path this tool reports
 * back is absolute. A bare relative `savePath` echoed to an agent is unreadable
 * evidence: it names a different file depending on who reads it.
 */
/**
 * A Windows path whose final location depends on state this process did not state.
 * Two spellings, and they are unresolved differently:
 *
 *   `\out`, `/out`  — rooted but drive-less. `isAbsolute` says true; `resolve()` supplies
 *                     the CURRENT drive, so it lands on C: or D: by where we launched.
 *   `C:out`, `D:out` — drive-qualified but rooted-less. `isAbsolute` says FALSE, so it
 *                     used to be described as "resolved against this process's working
 *                     directory" — which is not what happens: Windows keeps a working
 *                     directory PER DRIVE, and `resolve()` uses the named drive's, which
 *                     need not be ours at all. The old message named the wrong base.
 *
 * Neither is refused. Both are legal Windows spellings the caller typed, and refusing a
 * real request is its own bug — the hazard is silence, not the path. They are DISCLOSED:
 * the returned `Saved to:` line is always fully qualified, and a failure message says the
 * missing piece came from process state rather than from the argument.
 */
function isDriveRelative(p: string): boolean {
  if (process.platform !== "win32") return false;
  return /^[\\/](?![\\/])/.test(p) || /^[a-zA-Z]:(?![\\/])/.test(p);
}

export function resolveImageSaveDir(saveDir: string | undefined): string {
  const raw = saveDir?.trim();
  if (!raw) return defaultImageSaveDir();
  return isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
}

// The four cloud destinations action:"output" accepts, unchanged from the
// retired cloud-upload tool — same object keys, same min-length/url/enum
// constraints, so a caller's `destination` payload is byte-identical.
const s3DestinationSchema = z.object({
  bucket: z.string().min(1).describe("Destination S3 bucket"),
  prefix: z.string().optional().describe("Optional object key prefix"),
  async: z
    .boolean()
    .optional()
    .describe("Accepted for API compatibility; uploads complete before the tool returns."),
});

const azureDestinationSchema = z.object({
  container: z.string().min(1).describe("Destination Azure Blob container"),
  blob_prefix: z.string().optional().describe("Optional blob name prefix"),
});

const httpDestinationSchema = z.object({
  url: z.string().url().describe("HTTP(S) URL to PUT the output file to"),
});

const hfDestinationSchema = z.object({
  repo: z.string().min(1).describe("HuggingFace repo in owner/name format"),
  repo_type: z.enum(["model", "dataset", "space"]).optional().describe("Repo type; defaults to model"),
  path: z.string().optional().describe("Optional path prefix inside the repo"),
});

/** The asset-registry record fields every asset-shaped response has always echoed. */
function summarizeRecord(record: ReturnType<typeof AssetRegistry.get>) {
  if (!record) return null;
  return {
    asset_id: record.assetId,
    prompt_id: record.promptId,
    node_id: record.nodeId,
    filename: record.filename,
    subfolder: record.subfolder,
    type: record.type,
    url: record.url,
    source: record.source,
    created_at: new Date(record.createdAt).toISOString(),
    created_at_source: record.createdAtSource,
  };
}

/**
 * The twelve image/asset tools collapsed into TWO action-parameterized tools
 * (0.50.0 surface consolidation, slice 15):
 *
 *   `get_image`    — the READ/INSPECT surface: fetch, view, browse, re-encode,
 *                    measure colour, and read asset provenance (7 actions)
 *   `upload_image` — the WRITE surface: put bytes somewhere ComfyUI (or cloud
 *                    storage) can read them (5 actions)
 *
 * TWO tools rather than one twelve-action grab-bag because the halves have
 * opposite directions of travel and different blast radii: everything on
 * `get_image` reads (its one write is the local save of bytes it just fetched),
 * while every action on `upload_image` puts a file somewhere — ComfyUI's input/
 * directory or a cloud bucket. The orchestrator's call_tool whitelist depends on
 * that split: `get_image` is whitelisted for canvas-less clients (action-SCOPED,
 * see CALL_TOOL_ACTION_WHITELIST in src/orchestrator/call-tool-admission.ts) and
 * `upload_image` is not whitelisted at all — exactly as before the fold.
 *
 * Both survivors keep their registration slots (get_image, then upload_image),
 * so tools/list order is unchanged for every name that still exists.
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required. `filename` is required for
 * action:"get" but optional for action:"analyze_color" and meaningless for
 * action:"list_assets"; `asset_id` is required for "view"/"asset_metadata" and
 * optional for "convert"/action:"analyze_color"; `format` is required for
 * "convert" and optional
 * for "list_outputs". The handler enforces per-action PRESENCE and names the
 * missing field — the one deliberate behavioural difference a flat enum permits.
 * Guards test ABSENCE, never falsiness: `filename: ""` passed z.string() before
 * this consolidation and reached the service, which answers with its own
 * not-found/validation error, and it still does.
 *
 * WHERE THE BYTES GO: `stage` copies a generated OUTPUT back into ComfyUI's
 * INPUT directory, image/video/audio upload a LOCAL file into that same input
 * directory, and `output` ships a generated output OFF the machine to S3 / Azure
 * / an HTTP PUT / HuggingFace. A cross-wired action would put a file somewhere
 * the caller did not ask for without failing, so upload-image.test.ts pins each
 * action to exactly one service in BOTH directions.
 */
/**
 * The action vocabularies, declared once each.
 *
 * The zod enum and the unreachable-default error both read from these, so the
 * message a caller gets for a bad action can never drift from the list the
 * schema actually accepts — and neither list has to spell the actions twice.
 */
// prettier-ignore — one line so each member follows `[` or `,`, which is the
// shape the dead-name gate licenses for a declared action literal.
const GET_IMAGE_ACTIONS = ["get", "view", "list_outputs", "convert", "analyze_color", "list_assets", "asset_metadata"] as const;

const UPLOAD_IMAGE_ACTIONS = ["image", "video", "audio", "output", "stage"] as const;

export function registerImageManagementTools(server: McpServer): void {
  // ── get_image (7 actions) ────────────────────────────────────────────────
  server.tool(
    "get_image",
    "Fetch, browse and inspect ComfyUI images and registered assets. Driven by the `action` parameter:\n" +
      '- action:"get" — Fetch a generated image from ComfyUI by FILENAME and return it as an inline image. Video/audio outputs (e.g. a VHS_VideoCombine .mp4) are saved to save_dir with their original extension instead of being rendered inline. Works with remote ComfyUI instances — does not require COMFYUI_PATH. Use get_history (action:"list") first to obtain the filename.\n' +
      '- action:"view" — Fetch a registered asset\'s bytes by ASSET ID and return them as an inline image so the agent can see the result. Use this after a render completes (asset_id is included in the completion notification) to inspect, critique, or compare generated images. Only supports image mime types (PNG/JPEG/WebP); audio/video assets must be saved to disk via action:"get".\n' +
      '- action:"list_outputs" — List recently generated image AND video files from ComfyUI\'s output/ directory, newest-first, with each file\'s kind (\'image\' | \'video\'), subfolder, size, and modification time. Covers stills (.png/.jpg/.jpeg/.bmp) and video/animation outputs (.mp4/.webm/.mov/.mkv/.m4v/.avi/.gif/.webp). LOCAL ComfyUI (COMFYUI_PATH set): a RECURSIVE filesystem scan of output/ — includes subfolders like video/ that VHS/SaveVideo write to, and reports size + modification time. REMOTE ComfyUI: derives the list from /history over HTTP instead (size/modified are unavailable and omitted). It does NOT return the media bytes themselves — fetch those with action:"get". USE THIS TO CONFIRM A VIDEO RENDER (e.g. VHS_VideoCombine / LTX / WAN output) when get_history (action:"list") shows the prompt done but lists no output: VHS-style video nodes write the file but often do NOT register in ComfyUI\'s /history, so the local filesystem scan is the reliable way to verify the .mp4 exists — then chain it with upload_image (action:"stage"). THAT GUARANTEE IS LOCAL-ONLY AND INVERTS ON A REMOTE TARGET: with no disk to scan, this falls back to the very /history that omits those videos, so a REMOTE listing can neither confirm nor deny a VHS video render, and absence from it is NOT evidence the file is missing. Check a specific filename with action:"get" or upload_image (action:"stage") instead — both read /view, straight from the output directory. Every remote result says so in its own text. Read-only.\n' +
      '- action:"convert" — Re-encode a generated image to PNG, JPEG, or WebP and return it inline as an image content block. Source can be a registered asset_id or a path under the local ComfyUI output directory. Optionally writes the converted image back under the output directory and reports source/output size plus bytes saved.\n' +
      '- action:"analyze_color" — Measure the color of a rendered image (not by eye): returns black/white points, contrast (luma std), saturation, per-channel means + cast, and clipping — plus heuristic flags (washedOut, lowContrast, liftedBlacks, dimHighlights, lowSaturation, colorCast) and a one-line verdict. Source = asset_id, a ComfyUI output ref (filename/subfolder/type), or an image path. Pass reference_path to shot-match against a known-good frame (target−reference deltas). Set histogram:true to also get an overlaid R/G/B/luma histogram PNG. Use this to diagnose \'washed out\' objectively and decide a color fix; for a video, extract a frame to PNG first.\n' +
      '- action:"list_assets" — List recently generated assets, newest-first. Each call first reconciles ComfyUI\'s /history, so outputs are listed even when this session did not watch the render complete (e.g. queued via panel_run, by an earlier session, or before a server restart) — those are tagged source:\'history-reconcile\', versus source:\'watched\' for renders this server saw finish. Returns count + assets (asset_id, prompt_id, filename, url, source, created_at). The registry is ephemeral and clears on server restart; records expire after COMFYUI_ASSET_TTL_HOURS (default 24h), and only the most recent completed runs are reconciled — use get_history (action:\"list\") / action:"get" by filename for anything older.\n' +
      '- action:"asset_metadata" — Get full provenance for a registered asset including the workflow snapshot that produced it. Use this to inspect the parameters that generated an image before calling generate_image (action:"regenerate") with overrides.',
    {
      action: z
        .enum(GET_IMAGE_ACTIONS)
        .describe(
          'Which image/asset operation to perform. "get" requires `filename`; "view" and "asset_metadata" require `asset_id`; "convert" requires `format` plus exactly one of `asset_id`/`path`; action:"analyze_color" takes one source (`asset_id`, `filename`, or `path`); "list_outputs" and action:"list_assets" take no required parameters.',
        ),
      filename: z
        .string()
        .optional()
        .describe(
          'Output image filename, e.g. PulID_Klein_00001_.png. REQUIRED for action:"get". OPTIONAL for action:"analyze_color", where it is one of the three ways to name a source (pair it with subfolder/type).',
        ),
      asset_id: z
        .string()
        .optional()
        .describe(
          'Asset id returned by action:"list_assets" or job completion. REQUIRED for actions "view" and "asset_metadata". OPTIONAL for "convert" (provide exactly one of asset_id or path) and action:"analyze_color" (one of asset_id, filename, or path).',
        ),
      type: z
        .enum(["output", "input", "temp"])
        .optional()
        .describe(
          'ComfyUI directory the file lives in: output (default), input, or temp. Used by action:"get" and by action:"analyze_color" when the source is a `filename`.',
        ),
      subfolder: z
        .string()
        .optional()
        .describe(
          'Subfolder within the directory, if any (default empty). Used by action:"get" and by action:"analyze_color" when the source is a `filename`.',
        ),
      save_dir: z
        .string()
        .optional()
        .describe(
          'action:"get" — absolute local directory to save the file in. Defaults to a ' +
            "'comfyui-images' folder inside the platform temp directory " +
            "(os.tmpdir()), which is created if missing. A RELATIVE value is " +
            "resolved against this MCP process's working directory, which is the " +
            "client's choice and may not be writable. On Windows a drive-less path " +
            "like \\out is resolved against this process's CURRENT DRIVE, not a drive " +
            "you chose. Prefer a fully-qualified path (C:\\... or \\\\server\\share); " +
            "the returned 'Saved to:' line always names the resolved absolute path.",
        ),
      max_preview_bytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'action:"get" — ceiling on the base64 payload returned INLINE (default ~16MB). ' +
            "The file saved to disk is never affected. Lower it when your client rejects " +
            "or truncates large tool results; the reply says when it downscaled and by how much.",
        ),
      max_preview_dimension: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'action:"get" — ceiling on the inline preview\'s longest side in pixels ' +
            "(default 4096). Applies even when the byte budget is satisfied, since some " +
            "consumers reject by dimension — but only for an image this server can decode; " +
            "an undecodable one under the byte budget is passed through as-is. Does not " +
            "affect the saved file.",
        ),
      path: z
        .string()
        .optional()
        .describe(
          'A source image path. action:"convert" — a path under COMFYUI_PATH/output (provide exactly one of asset_id or path). action:"analyze_color" — an absolute image path, or a path under the ComfyUI output dir (videos: extract a frame to PNG first).',
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'action:"list_outputs" — max media files to return, 1..100 (default 20). action:"list_assets" — max records to return (default: all, no upper bound).',
        ),
      pattern: z
        .string()
        .optional()
        .describe('action:"list_outputs" — filter by filename pattern (case-insensitive substring match).'),
      format: z
        .enum(["markdown", "json", "png", "jpeg", "webp"])
        .optional()
        .describe(
          'Two unrelated meanings, one per action — the enum is the union of both and each action accepts only its own half. action:"list_outputs" — RESPONSE SHAPE: "markdown" (default, human/agent-readable) or "json" ({images:[{filename,subfolder,kind,size,modified}]} — for app clients building pick grids). action:"convert" — REQUIRED target encoded image format: "png", "jpeg" or "webp".',
        ),
      quality: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('action:"convert" — encoder quality, 1-100. Applies where supported by the selected format.'),
      progressive: z.boolean().optional().describe('action:"convert" — JPEG only: write a progressive JPEG.'),
      lossless: z.boolean().optional().describe('action:"convert" — WebP only: write lossless WebP.'),
      effort: z
        .number()
        .int()
        .min(0)
        .max(6)
        .optional()
        .describe('action:"convert" — WebP only: encoder effort, 0-6.'),
      out_path: z
        .string()
        .optional()
        .describe(
          'action:"convert" — optional output path under COMFYUI_PATH/output where the converted image should be written.',
        ),
      reference_path: z
        .string()
        .optional()
        .describe(
          'action:"analyze_color" — optional reference image to shot-match against; returns target−reference deltas for contrast, black/white points, saturation, and per-channel means.',
        ),
      histogram: z
        .boolean()
        .optional()
        .describe(
          'action:"analyze_color" — also return an overlaid R/G/B/luma histogram PNG for visual confirmation (default false).',
        ),
      since: z
        .string()
        .datetime()
        .optional()
        .describe('action:"list_assets" — ISO timestamp; only return assets created at or after this time.'),
    },
    async (args) => {
      try {
        const json = (value: unknown) => ({
          content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
        });

        // `filename`/`asset_id`/`format` cannot be schema-required in a flat
        // shape, so the handler enforces per-action presence and names the
        // missing field — the same information the old per-tool schemas gave.
        //
        // ABSENCE only, never falsiness: `filename: ""` and `asset_id: ""`
        // passed z.string() before this consolidation and reached the service,
        // which answers with its own not-found/validation error. A `!filename`
        // guard would swallow that path and substitute generic text instead.
        const requireField = (value: string | undefined, action: string, field: string, what: string): string => {
          if (value === undefined) {
            throw new Error(`get_image action:"${action}" requires \`${field}\` — ${what}.`);
          }
          return value;
        };

        switch (args.action) {
          // ── GET (fetch by filename over /view, save to disk) ───────────────
          case "get": {
            const filename = requireField(
              args.filename,
              "get",
              "filename",
              'the output filename to fetch (from get_history or action:"list_outputs")',
            );
            const { base64, mimeType } = await getOutputImage(
              filename,
              args.type ?? "output",
              args.subfolder ?? "",
              // #1373 — the input dir legitimately holds workflow .json files.
              { allowMedia: true, allowJson: true },
            );

            // The bytes are already in hand at this point. Saving them is a SEPARATE
            // operation that can fail on its own (EPERM/EACCES/ENOSPC/read-only volume),
            // and its failure says nothing about the fetch. Reporting the whole call as an
            // error there threw away a successfully retrieved image and invited a retry of
            // the fetch that could never fix the disk problem (#768) — so the save is
            // isolated and its outcome is DISCLOSED rather than allowed to fail the tool.
            //
            // RESOLUTION is inside the guarded region, not before it: `resolveImageSaveDir`
            // calls `process.cwd()` for a relative save_dir, and cwd itself throws ENOENT
            // when the launch directory has been deleted underneath us. Left outside, that
            // throw would reach the outer catch and discard the fetched image — the same
            // loss this block exists to prevent, one line earlier.
            //
            // `explicitDir` is the TRIMMED value actually used for resolution, so the
            // message can never describe a whitespace-only save_dir as a directory the
            // caller named (resolveImageSaveDir treats it as omitted).
            const explicitDir = args.save_dir?.trim() || undefined;
            const localFilename = basename(filename);
            let savePath: string | undefined;
            let saveError: string | undefined;
            try {
              const saveDir = resolveImageSaveDir(args.save_dir);
              savePath = join(saveDir, localFilename);
              await mkdir(saveDir, { recursive: true });
              await writeFile(savePath, Buffer.from(base64, "base64"));
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              // A default destination we can still NAME, even if resolution itself failed —
              // never a remedy the caller cannot act on.
              let fallbackDefault: string | undefined;
              try {
                fallbackDefault = defaultImageSaveDir();
              } catch {
                fallbackDefault = undefined;
              }
              saveError =
                `NOT SAVED. The image was fetched from ComfyUI successfully, but ` +
                (savePath
                  ? `writing it to ${savePath} failed: ${detail}. `
                  : `this process could not even work out where to put it: ${detail}. `) +
                (explicitDir
                  ? `The destination came from the save_dir argument you passed ` +
                    `("${explicitDir}")` +
                    // Drive-relative is checked FIRST: `C:out` is not `isAbsolute`, so the
                    // generic relative branch would have claimed it resolved against this
                    // process's working directory, when Windows actually uses the named
                    // DRIVE's own working directory. Naming the wrong base is the same
                    // defect as naming the wrong cause.
                    (isDriveRelative(explicitDir)
                      ? ` — a DRIVE-RELATIVE save_dir, so the part you did not give (the ` +
                        `drive, or that drive's current directory) came from this process's ` +
                        `state, not from your argument`
                      : !isAbsolute(explicitDir)
                        ? ` — a RELATIVE save_dir, resolved against this process's working directory`
                        : "") +
                    `. Retry with an absolute save_dir you can write to` +
                    (fallbackDefault ? `, or omit save_dir to use the default ${fallbackDefault}.` : ".")
                  : `That is the default destination${fallbackDefault ? ` (${fallbackDefault})` : ""}. ` +
                    `Retry with an explicit absolute save_dir you can write to.`) +
                ` Do NOT re-run the render — the output already exists on the server.`;
            }

            // Only images render inline; video/audio are save-to-disk only (#663).
            if (!mimeType.toLowerCase().startsWith("image/")) {
              // Nothing can be handed back inline for media, so an unsaved fetch really did
              // deliver nothing — but the message still names the exact destination and a
              // remedy that works from here, instead of a bare EPERM.
              if (saveError) {
                return {
                  content: [{ type: "text" as const, text: `${saveError} (${mimeType})` }],
                  isError: true,
                };
              }
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Saved to: ${savePath} (${mimeType}; not rendered inline)`,
                  },
                ],
              };
            }

            // #1495 — BOUND THE INLINE PAYLOAD. An 8504×17008 render encoded to ~267 MB and
            // blew the caller's 64 MB IPC frame, so a perfectly good output could not be
            // looked at. The saved file above is untouched; only what goes on the wire is
            // capped.
            const bounded = await boundInlineImage(base64, mimeType, {
              budgetBytes: args.max_preview_bytes,
              maxDimension: args.max_preview_dimension,
            });

            // Could not be reduced: say so and keep the saved path, rather than emitting a
            // payload that will fail in transport — where the error names a byte count and
            // not the image, which is how the reporter ended up debugging their own
            // workflow instead of this tool.
            // The disk claim is conditional on the save actually having happened (codex).
            // Telling someone their full-resolution file is "on disk — open it directly"
            // after an EACCES save is the same class of defect as the inline failure this
            // whole change is about: a confident sentence about something nobody checked.
            const savedOnDisk = !saveError && savePath;
            if (bounded.refused) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      (saveError ? `${saveError} ` : `Saved to: ${savePath}. `) +
                      `NOT rendered inline: ${bounded.refused.reason}. ` +
                      (savedOnDisk
                        ? `The full-resolution file is on disk and unaffected — open it ` +
                          `directly, or re-run get_image with a smaller max_preview_dimension.`
                        : `NOTHING was written locally either, so this image is not available ` +
                          `here at all — fix the save destination above and retry, or re-run ` +
                          `get_image with a smaller max_preview_dimension. The output is still ` +
                          `intact on the ComfyUI server; do NOT re-run the render.`),
                  },
                ],
              };
            }

            // A silently downscaled image is a worse failure than the one being fixed: an
            // agent reads fine detail off it and reports confidently. So the preview
            // ANNOUNCES itself, with the true dimensions and where the real file is.
            const previewNote = bounded.preview
              ? ` PREVIEW ONLY: the inline image was downscaled to ` +
                `${bounded.preview.width}×${bounded.preview.height} because the original ` +
                `(${bounded.preview.originalWidth}×${bounded.preview.originalHeight}, ` +
                `~${Math.round(bounded.preview.originalEncodedBytes / 1_048_576)} MB encoded) ` +
                `exceeds what can be sent inline.` +
                // Every way the preview differs from the source gets said, not just the
                // resize (codex). An agent that is told "downscaled" and hands back a
                // verdict on a video's motion, or on 16-bit banding, was misled by an
                // accurate-but-incomplete sentence.
                (bounded.preview.sourceMayBeAnimated
                  ? ` The source format can hold ANIMATION and this preview is a single still ` +
                    `PNG — if it was animated you are seeing ONE frame, so do not judge motion, ` +
                    `timing, or any later frame from it.`
                  : "") +
                (bounded.preview.recoded
                  ? ` It was also re-encoded to 8-bit RGB PNG, so colour depth and colour space ` +
                    `differ from the source — do not judge banding or colour accuracy from it.`
                  : "") +
                ` Do NOT judge fine detail, small text, or pixel-level artefacts from it — ` +
                (savedOnDisk
                  ? `read the full-resolution file at the path above for that.`
                  : `and note the full-resolution file was NOT saved locally (see above), so ` +
                    `re-fetch it once the save destination is fixed.`)
              : "";

            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    (saveError
                      ? `${saveError} The image itself is returned inline below.`
                      : `Saved to: ${savePath}`) + previewNote,
                },
                {
                  type: "image" as const,
                  data: bounded.base64,
                  mimeType: bounded.mimeType,
                },
              ],
            };
          }

          // ── VIEW (inline a registered asset's pixels) ──────────────────────
          case "view": {
            const assetId = requireField(
              args.asset_id,
              "view",
              "asset_id",
              'the registered asset to inline (from action:"list_assets" or a job completion)',
            );
            const result = await viewAssetImage(assetId);
            return {
              content: result.content.map((block) =>
                block.type === "image"
                  ? { type: "image" as const, data: block.data, mimeType: block.mimeType }
                  : { type: "text" as const, text: block.text },
              ),
            };
          }

          // ── LIST_OUTPUTS (browse output/ — the video-render check) ─────────
          case "list_outputs": {
            // The retired output-listing tool's schema carried `.int().min(1).max(100)`
            // while action:"list_assets" carried `.int().positive()` with no ceiling.
            // A single zod field cannot express both: the intersection would
            // REFUSE an action:"list_assets" limit of 500 that was legal before (a false
            // refusal), and the union alone would let a list_outputs caller ask
            // for 5000 entries and blow the context. So the shared field keeps
            // the loosest zod constraint both agreed on (positive integer) and
            // the 100 ceiling is re-applied HERE, for the one action that had it.
            // The refusal is preserved; only its source moved from the schema
            // layer to the handler, which is the same trade rule 3 already makes
            // for presence.
            if (args.limit !== undefined && args.limit > 100) {
              throw new Error(
                `get_image action:"list_outputs" accepts \`limit\` 1..100 (got ${args.limit}). ` +
                  'Use action:"list_assets" for an unbounded listing of registered assets.',
              );
            }
            // `format` is the union of two unrelated enums (see the schema note),
            // so each action refuses the other's values by name rather than
            // silently treating an encoder format as a response shape.
            if (args.format !== undefined && args.format !== "markdown" && args.format !== "json") {
              throw new Error(
                `get_image action:"list_outputs" accepts \`format\` "markdown" or "json" (got "${args.format}"). ` +
                  '"png"/"jpeg"/"webp" are encoder formats for action:"convert".',
              );
            }
            const { images, source } = await listOutputMedia({
              limit: args.limit,
              pattern: args.pattern,
            });
            // Say WHERE these came from (#899). The tool resolved it a moment
            // ago; withholding it forces callers to reconstruct the path, and the
            // natural reconstruction — the workspace path from install_comfyui (action:"environment") —
            // is wrong on any install launched with --output-directory. Naming the
            // basis matters as much as the path: "scanned this directory" and
            // "read the server's history" are different claims, and only one is
            // about disk.
            // #953 — naming the source was not enough. "What the server remembers
            // this session" reads as a STALENESS caveat, and the reporter's files
            // were never in /history at all: VHS-style video nodes write the file
            // without registering an output entry, so those videos are absent from
            // this listing by construction, not by age. They had 30+ ProRes masters
            // under output/slot/, saw a confident 12-file listing that omitted every
            // one, concluded the directory was empty and wrote that into a handover
            // document. The files were fetchable by name the whole time.
            //
            // So the history branch states the OMISSION as a property of the source,
            // and names the check that does work on a remote target.
            const whereFrom =
              source.basis === "local-scan"
                ? `Read from \`${source.directory}\` (scanned on disk).`
                : "Read from ComfyUI's generation history over HTTP — NOT from disk. This listing is " +
                  "INCOMPLETE BY CONSTRUCTION: VHS_VideoCombine and similar video nodes write their " +
                  "file without registering an output entry, so those videos never appear here even " +
                  "though they are on disk, and a server restart clears the history besides. Absence " +
                  "from this list is NOT evidence the file is missing. To check a specific file, fetch " +
                  'it by name with action:"get" or upload_image (action:"stage") — both read the server\'s ' +
                  "/view endpoint, which serves straight from the output directory.";
            if (args.format === "json") {
              // Machine-readable form for app clients (the mobile dataset picker):
              // same entries, no prose. Thumbs render client-side via /view URLs.
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      // Machine-readable counterpart of the prose: the entries are
                      // meaningless to a client that cannot say which directory
                      // they are relative to (#899).
                      source: source.basis,
                      ...(source.directory ? { directory: source.directory } : {}),
                      images: images.map((img) => ({
                        filename: img.filename,
                        subfolder: img.subfolder,
                        kind: img.kind,
                        ...(img.size > 0 ? { size: img.size } : {}),
                        ...(img.modified ? { modified: img.modified } : {}),
                      })),
                    }),
                  },
                ],
              };
            }
            if (images.length === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    // NAMING THE SOURCE MATTERS MOST HERE. "Nothing found"
                    // invites the reader to conclude their file does not exist,
                    // and whether that holds depends entirely on where we looked.
                    text:
                      (args.pattern
                        ? `No output media (images or videos) found matching "${args.pattern}".`
                        : "No output media (images or videos) found.") + ` ${whereFrom}`,
                  },
                ],
              };
            }
            const lines = images.map((img, i) => {
              const loc = img.subfolder ? `${img.subfolder}/${img.filename}` : img.filename;
              const sub = img.subfolder ? ` _(subfolder: ${img.subfolder})_` : "";
              // Size/modified are only available on the local filesystem scan; the
              // remote (history-derived) path leaves them as 0 / "" — omit them then.
              const sizePart = img.size > 0 ? ` (${(img.size / 1024 / 1024).toFixed(1)} MB)` : "";
              const datePart = img.modified
                ? ` — ${new Date(img.modified).toLocaleString()}`
                : "";
              return `${i + 1}. **${loc}** [${img.kind}]${sizePart}${datePart}${sub}`;
            });
            const videoCount = images.filter((img) => img.kind === "video").length;
            const summary =
              videoCount > 0
                ? `Found ${images.length} media file(s) (${videoCount} video):`
                : `Found ${images.length} media file(s):`;
            return {
              content: [
                {
                  type: "text" as const,
                  text: `${summary} ${whereFrom}\n\n${lines.join("\n")}`,
                },
              ],
            };
          }

          // ── CONVERT (re-encode; may WRITE under the output dir) ────────────
          case "convert": {
            const format = requireField(
              args.format,
              "convert",
              "format",
              'the target encoding — "png", "jpeg" or "webp"',
            );
            if (format !== "png" && format !== "jpeg" && format !== "webp") {
              throw new Error(
                `get_image action:"convert" accepts \`format\` "png", "jpeg" or "webp" (got "${format}"). ` +
                  '"markdown"/"json" are response shapes for action:"list_outputs".',
              );
            }
            const result = await convertImage({
              asset_id: args.asset_id,
              path: args.path,
              format,
              quality: args.quality,
              progressive: args.progressive,
              lossless: args.lossless,
              effort: args.effort,
              out_path: args.out_path,
            });
            return {
              content: result.content.map((block) =>
                block.type === "image"
                  ? { type: "image" as const, data: block.data, mimeType: block.mimeType }
                  : { type: "text" as const, text: block.text },
              ),
            };
          }

          // ── ANALYZE_COLOR (objective scopes/stats, optional histogram) ─────
          case "analyze_color": {
            const result = await analyzeColor({
              asset_id: args.asset_id,
              path: args.path,
              filename: args.filename,
              subfolder: args.subfolder,
              type: args.type,
              reference_path: args.reference_path,
              histogram: args.histogram,
            });
            return {
              content: result.content.map((block) =>
                block.type === "image"
                  ? { type: "image" as const, data: block.data, mimeType: block.mimeType }
                  : { type: "text" as const, text: block.text },
              ),
            };
          }

          // ── LIST_ASSETS (registry + on-demand history reconcile) ───────────
          case "list_assets": {
            const since = args.since ? Date.parse(args.since) : undefined;
            // Close the #751 gap: outputs whose completion this process didn't
            // watch (panel_run dispatches, earlier sessions, pre-restart runs)
            // register from history on demand. Best-effort — the registry still
            // answers when ComfyUI is unreachable.
            let note: string | undefined;
            try {
              await reconcileAssetsFromHistory();
            } catch (reconcileErr) {
              const message =
                reconcileErr instanceof Error
                  ? reconcileErr.message
                  : String(reconcileErr);
              logger.warn('get_image action:"list_assets" history reconcile failed', { error: message });
              // Truthful degradation: previously reconciled records stay listed
              // (they name real outputs) — the note must not claim watched-only.
              note =
                `Could not refresh from ComfyUI history (${message}); results may be stale — ` +
                "they still include assets reconciled from history earlier, and very recent completions may be missing.";
            }
            const records = AssetRegistry.list({ limit: args.limit, since });
            if (records.length === 0 && note === undefined) {
              note =
                "No assets found — nothing completed under this server's watch and no recent successfully completed outputs in ComfyUI history. " +
                'Use get_history to inspect past runs and get_image action:"get" to fetch an output by filename.';
            }
            return json({
              count: records.length,
              assets: records.map(summarizeRecord),
              ...(note !== undefined ? { note } : {}),
            });
          }

          // ── ASSET_METADATA (provenance + the workflow that produced it) ────
          case "asset_metadata": {
            const assetId = requireField(
              args.asset_id,
              "asset_metadata",
              "asset_id",
              'the registered asset whose provenance you want (from action:"list_assets" or a job completion)',
            );
            const record = AssetRegistry.get(assetId);
            if (!record) {
              return errorToToolResult(
                new Error(
                  `No asset found for id "${assetId}". It may have expired or never been registered.`,
                ),
              );
            }
            return json({
              ...summarizeRecord(record),
              workflow: record.workflow,
            });
          }

          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown get_image action "${String(exhaustive)}". Expected one of: ${GET_IMAGE_ACTIONS.join(", ")}.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // ── upload_image (5 actions) ─────────────────────────────────────────────
  // HTTP-only for the media uploads (works for both local and remote ComfyUI
  // via /upload/image). The previous filesystem fallback was deceptive when
  // COMFYUI_PATH auto-detected an unrelated local install — files would land in
  // the wrong tree and the tool reported success while the remote ComfyUI never
  // received them. Originally diagnosed by João Lucas
  // (github.com/joaolvivas) in joaolvivas/comfyui-mcp-byjlucas@089180ad
  // (2026-05-12).
  //
  // action:"stage" is the correct, dir-agnostic way to pipe one pipeline
  // stage's output into the next stage's loader. It fetches the output via
  // /view and re-registers it as an input via /upload/image — never touches the
  // filesystem, so it works with custom --input-directory / --output-directory.
  const MEDIA_UPLOADS = {
    image: {
      fn: uploadImageAuto,
      nodeHint: "as the `image` input in LoadImage nodes",
    },
    video: {
      fn: uploadVideoAuto,
      nodeHint: "as the video file input in VHS_LoadVideo (or similar) nodes",
    },
    audio: {
      fn: uploadAudioAuto,
      nodeHint: "as the audio input in LoadAudio (or similar) nodes",
    },
  } as const;

  server.tool(
    "upload_image",
    "Put a file where ComfyUI (or cloud storage) can read it. Driven by the `action` parameter:\n" +
      '- action:"image" — Upload a local image file to the connected ComfyUI\'s input/ directory via the HTTP /upload/image endpoint so it can be referenced in LoadImage nodes. Works for both local and remote ComfyUI. Returns the stored filename.\n' +
      '- action:"video" — Upload a local video file (.mp4, .mov, .webm, .avi, .mkv, .m4v) to the connected ComfyUI\'s input/ directory via the HTTP /upload/image endpoint for use in video-loading nodes such as VHS_LoadVideo (ComfyUI-VideoHelperSuite). Works for both local and remote ComfyUI. Returns the stored filename.\n' +
      '- action:"audio" — Upload a local audio file (.wav, .mp3, .flac, .ogg, .m4a, .aac) to the connected ComfyUI\'s input/ directory via the HTTP /upload/image endpoint for use in audio-conditioned workflows (e.g. LoadAudio). Works for both local and remote ComfyUI. Returns the stored filename.\n' +
      '- action:"stage" — Stage an EXISTING ComfyUI output (or temp/preview) as an INPUT so the next stage\'s loader (LoadImage / VHS_LoadVideo / LoadAudio) can read it. This is the CORRECT way to chain a multi-stage pipeline (e.g. Krea2 image → LTX video → WAN extend): it fetches the output\'s bytes from the server via /view and re-registers them as an input via /upload/image — the same endpoints get_image and the uploads above use. Because it goes entirely through the server API, it works even when ComfyUI was launched with a CUSTOM input/output directory. Do NOT instead copy the output file or guess a filesystem `input/` path — the server\'s input dir may be custom and it will reject the file ("Invalid image file"), wasting the render. Pass an existing output reference ({ filename, subfolder?, type? }); the media kind (image/video/audio) is inferred from the extension unless you set `kind`. Returns the registered input { filename, subfolder, type: "input", kind } — drop the returned `filename` straight into the loader\'s image/video/audio widget.\n' +
      '- action:"output" — Upload a generated ComfyUI output to CLOUD storage (this is the only action that sends bytes off the machine). Source can be asset_id or a local path under COMFYUI_PATH/output. Destination can be S3, Azure Blob, HTTP PUT, or HuggingFace via the hf CLI.',
    {
      action: z
        .enum(UPLOAD_IMAGE_ACTIONS)
        .describe(
          'What to upload and where. "image"/"video"/"audio" send a LOCAL file (`source_path`) to ComfyUI\'s input/ directory; "stage" re-registers an EXISTING server-side output (`filename`) as an input; "output" ships a generated output to cloud storage (`destination`).',
        ),
      source_path: z
        .string()
        .optional()
        .describe(
          'Absolute path to the local file to upload. REQUIRED for actions "image", "video" and "audio".',
        ),
      // NOTE the deliberate meaning split, kept because a fold must not rename
      // the arguments a service is called with: for "image"/"video"/"audio"
      // `filename` is the DESTINATION name in ComfyUI's input/ directory
      // (uploadImageAuto's second argument), while for "stage" it names the
      // SOURCE output being re-registered (stageOutputAsInput's `filename`),
      // whose destination override is the separate `as_filename`. Both spellings
      // predate this consolidation.
      filename: z
        .string()
        .optional()
        .describe(
          'Two meanings, one per action. actions "image"/"video"/"audio" — OPTIONAL override for the filename in ComfyUI\'s input/ directory (auto-detected from source_path if omitted). action:"stage" — REQUIRED filename of the EXISTING output/temp asset to re-register (from get_history or get_image action:"list_outputs"), e.g. LTX_video_00001.mp4; its destination name override is `as_filename`, not this field.',
        ),
      subfolder: z
        .string()
        .optional()
        .describe('action:"stage" — subfolder the source asset currently lives in, if any.'),
      type: z
        .enum(["output", "temp"])
        .optional()
        .describe(
          'action:"stage" — source directory the asset lives in: output (default) or temp (previews).',
        ),
      kind: z
        .enum(["image", "video", "audio"])
        .optional()
        .describe(
          'action:"stage" — force the media kind instead of inferring it from the file extension.',
        ),
      as_filename: z
        .string()
        .optional()
        .describe(
          'action:"stage" — override the filename it is registered under in the input/ directory (defaults to the source filename).',
        ),
      asset_id: z
        .string()
        .optional()
        .describe(
          'action:"output" — registered asset id from a completed job. Provide exactly one of asset_id or path.',
        ),
      path: z
        .string()
        .optional()
        .describe(
          'action:"output" — path to a generated output under COMFYUI_PATH/output. Provide exactly one of asset_id or path.',
        ),
      destination: z
        .object({
          s3: s3DestinationSchema.optional(),
          azure: azureDestinationSchema.optional(),
          http: httpDestinationSchema.optional(),
          hf: hfDestinationSchema.optional(),
        })
        .optional()
        .describe('action:"output" — REQUIRED. Exactly one upload destination.'),
    },
    async (args) => {
      try {
        // Same absence-not-falsiness contract as get_image above: `source_path: ""`
        // and `filename: ""` passed z.string() before this consolidation and
        // reached the service, which answers with its own validation error.
        const requireField = (value: string | undefined, action: string, field: string, what: string): string => {
          if (value === undefined) {
            throw new Error(`upload_image action:"${action}" requires \`${field}\` — ${what}.`);
          }
          return value;
        };

        switch (args.action) {
          // ── LOCAL FILE → ComfyUI's input/ directory ────────────────────────
          case "image":
          case "video":
          case "audio": {
            const { fn, nodeHint } = MEDIA_UPLOADS[args.action];
            const sourcePath = requireField(
              args.source_path,
              args.action,
              "source_path",
              "the absolute path of the local file to upload",
            );
            const result = await fn(sourcePath, args.filename);
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Uploaded via HTTP.\n\nFilename: ${result.filename}\n\n` +
                    `Use "${result.filename}" ${nodeHint}.`,
                },
              ],
            };
          }

          // ── SERVER-SIDE OUTPUT → ComfyUI's input/ directory ────────────────
          case "stage": {
            const filename = requireField(
              args.filename,
              "stage",
              "filename",
              'the existing output/temp asset to re-register as an input (from get_history or get_image action:"list_outputs")',
            );
            const staged = await stageOutputAsInput({
              filename,
              subfolder: args.subfolder,
              type: args.type ?? "output",
              kind: args.kind,
              asFilename: args.as_filename,
            });
            const loaderHint =
              staged.kind === "video"
                ? "the video file input in VHS_LoadVideo (or similar)"
                : staged.kind === "audio"
                  ? "the audio input in LoadAudio (or similar)"
                  : "the `image` input in LoadImage";
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Staged ${staged.kind} output as input via the server API.\n\n` +
                    `Input filename: ${staged.filename}\n` +
                    `subfolder: ${staged.subfolder || "(none)"}\n` +
                    `type: ${staged.type}\n\n` +
                    `Use "${staged.filename}" as ${loaderHint}.\n\n` +
                    `NOTE: the open ComfyUI tab's loader dropdown was populated at page-load, ` +
                    `so this just-registered input is not in it yet — call panel_refresh_nodes ` +
                    `first (it re-pulls /object_info so the new file becomes selectable), THEN ` +
                    `panel_set_widget the loader's widget to "${staged.filename}". ` +
                    `(panel_set_widget also self-refreshes on a rejected value, so a single ` +
                    `retry after panel_refresh_nodes will always accept it.)`,
                },
              ],
            };
          }

          // ── GENERATED OUTPUT → cloud storage (off this machine) ────────────
          case "output": {
            if (args.destination === undefined) {
              throw new Error(
                'upload_image action:"output" requires `destination` — exactly one of s3, azure, http or hf.',
              );
            }
            const result = await uploadOutput({
              asset_id: args.asset_id,
              path: args.path,
              destination: args.destination,
            } as UploadOutputOptions);
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          default: {
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown upload_image action "${String(exhaustive)}". Expected one of: ${UPLOAD_IMAGE_ACTIONS.join(", ")}.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // The retired PNG-workflow-metadata tool registered here; 0.50.0 slice 14
  // folded it into get_workflow (action:"from_image"), where the other workflow
  // reads live. The extractor itself is untouched in
  // src/services/image-management.ts.
}
