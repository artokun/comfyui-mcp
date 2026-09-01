import { AssetRegistry } from "./asset-registry.js";
import { getOutputImage } from "./image-management.js";
import { boundInlineImage, previewCaveats } from "./inline-preview.js";

export interface ViewImageResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  /**
   * True when the inline budget actually BIT — a preview was built, or the image could not
   * be reduced and nothing was inlined. False when the asset went out untouched.
   *
   * The caller needs this to decide whether to explain a shared batch budget: saying
   * "BATCH LIMIT" about an image that no budget touched teaches a reader to skip the
   * sentence on the call where it is load-bearing.
   */
  bounded: boolean;
}

export interface ViewAssetImageOptions {
  /**
   * Ceiling on the base64 payload returned inline. Defaults to the #1495 budget.
   *
   * A THUNK, not a number, and the type says so on purpose. Under #2692 the ceiling depends
   * on how many sibling fetches are in flight, and the siblings of a batch are still being
   * admitted while this call downloads — so a number computed at the call site is read at
   * the moment the batch is at its NARROWEST. Measured with an eager number: nine
   * concurrent views came to 1,884,132 bytes against a 900,000-byte aggregate, because the
   * first arrival priced itself for a batch of one. Resolved here, after the fetch, all nine
   * price themselves for nine.
   */
  budgetBytes?: () => number;
  /** Ceiling on the preview's longest side in pixels. */
  maxDimension?: number;
}

const SUPPORTED_IMAGE_MIME_PREFIX = "image/";

/**
 * Fetch a registered asset's bytes and return them as an MCP image content
 * block so the agent can see the actual image. Throws on missing/expired
 * assets and on non-image mime types (audio/video are not viewable inline).
 *
 * #2692 — THE #1495 BOUND WAS MISSING HERE. `get_image action:"get"` has capped its
 * inline payload since #1495; this action, the successor to the retired `view_image`,
 * inlined whatever it fetched at full encoded size. The two actions differ in where the
 * pixels come from, not in what the transport can carry, so the same image that #1495
 * made viewable through `action:"get"` still blew the frame when viewed through here.
 *
 * There is no saved file to fall back on. `action:"get"` writes to disk first and can
 * offer the full-resolution path when it refuses; this action only ever inlines, so a
 * refusal has to hand back a route rather than a location — which is why the refusal text
 * below names `action:"get"` instead of a path.
 */
export async function viewAssetImage(
  assetId: string,
  opts: ViewAssetImageOptions = {},
): Promise<ViewImageResult> {
  const record = AssetRegistry.get(assetId);
  if (!record) {
    throw new Error(
      `No asset found for id "${assetId}". It may have expired or never been registered.`,
    );
  }

  const validType = record.type === "output" || record.type === "input" || record.type === "temp";
  const fetchType: "output" | "input" | "temp" = validType
    ? (record.type as "output" | "input" | "temp")
    : "output";

  const { base64, mimeType } = await getOutputImage(
    record.filename,
    fetchType,
    record.subfolder,
  );

  if (!mimeType.startsWith(SUPPORTED_IMAGE_MIME_PREFIX)) {
    throw new Error(
      `Asset "${assetId}" is not an image (mime: ${mimeType}). get_image (action:"view") only supports PNG/JPEG/WebP.`,
    );
  }

  const bounded = await boundInlineImage(base64, mimeType, {
    budgetBytes: opts.budgetBytes?.(),
    maxDimension: opts.maxDimension,
  });

  if (bounded.refused) {
    // Nothing is inlined, and unlike action:"get" there is no local copy — so the reply
    // must not imply one exists. It names the two routes that still work and states that
    // the render itself is intact, because the reporter on #1495 re-ran a workflow to
    // recover from exactly this shape of failure.
    return {
      content: [
        {
          type: "text",
          text:
            `Asset ${assetId} — ${record.filename} (${mimeType}). NOT rendered inline: ` +
            `${bounded.refused.reason}. Nothing was written locally either — this action ` +
            `only inlines. Use get_image (action:"get", filename:"${record.filename}"` +
            (record.subfolder ? `, subfolder:"${record.subfolder}"` : "") +
            `) to save the full-resolution file to disk, or retry with a smaller ` +
            `max_preview_dimension. The output is intact on the ComfyUI server; do NOT ` +
            `re-run the render.`,
        },
      ],
      bounded: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        // The SOURCE mime stays in the header line — it is what the asset is. When a
        // preview was built, the caveats say the inline block is a PNG re-encode, so the
        // two do not contradict each other.
        text:
          `Asset ${assetId} — ${record.filename} (${mimeType})` +
          (bounded.preview
            ? previewCaveats(bounded.preview) +
              `fetch the full-resolution file with get_image (action:"get", ` +
              `filename:"${record.filename}"` +
              (record.subfolder ? `, subfolder:"${record.subfolder}"` : "") +
              `), which writes it to disk.`
            : ""),
      },
      {
        type: "image",
        data: bounded.base64,
        mimeType: bounded.mimeType,
      },
    ],
    bounded: bounded.preview !== null,
  };
}
