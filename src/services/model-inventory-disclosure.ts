import {
  liveCategoryListing,
  type LiveCategoryListingOptions,
} from "./model-resolver.js";

/** Only widget names whose model directory is unambiguous in current ComfyUI APIs. */
const MODEL_CATEGORY_BY_WIDGET: Readonly<Record<string, string>> = Object.freeze({
  ckpt_name: "checkpoints",
  lora_name: "loras",
  vae_name: "vae",
  unet_name: "diffusion_models",
  diffusion_model: "diffusion_models",
  control_net_name: "controlnet",
  controlnet_name: "controlnet",
  clip_name: "text_encoders",
  clip_name1: "text_encoders",
  clip_name2: "text_encoders",
  clip_name3: "text_encoders",
  clip_name4: "text_encoders",
  style_model_name: "style_models",
  embedding_name: "embeddings",
  gligen_name: "gligen",
  hypernetwork_name: "hypernetworks",
});

const MODEL_INVENTORY_DISCLOSURE_TIMEOUT_MS = 2000;

export type ModelInventoryDisclosureProbe = (
  widget: unknown,
  value: unknown,
  refusalText: string,
) => Promise<string | null>;

type CategoryListing = (
  category: string,
  options?: LiveCategoryListingOptions,
) => Promise<string[] | undefined>;

function normalizeInventoryEntry(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "");
}

/**
 * Current panel_set_widget refusals distinguish a real, readable combo list
 * from an empty/unreadable list. Only the former can establish this mismatch.
 */
export function isReadableComboValueRefusal(refusalText: unknown): boolean {
  if (typeof refusalText !== "string") return false;
  return (
    /not a valid option for combo widget/i.test(refusalText) &&
    /option list was read successfully/i.test(refusalText) &&
    /none of them this value/i.test(refusalText)
  );
}

/**
 * Compare the panel's strict combo refusal with the connected ComfyUI's live
 * `/models/<category>` listing. `undefined` is deliberately inconclusive: an
 * unavailable or non-enumerable endpoint must never become a mismatch claim.
 */
export async function getModelInventoryDisclosure(
  widget: unknown,
  value: unknown,
  refusalText: string,
  listCategory: CategoryListing = (category, options) =>
    liveCategoryListing(category, options),
): Promise<string | null> {
  if (!isReadableComboValueRefusal(refusalText)) return null;
  if (typeof widget !== "string") return null;
  if (typeof value !== "string" || value.length === 0) return null;

  const category = Object.prototype.hasOwnProperty.call(MODEL_CATEGORY_BY_WIDGET, widget)
    ? MODEL_CATEGORY_BY_WIDGET[widget]
    : undefined;
  if (!category) return null;

  let listing: string[] | undefined;
  try {
    listing = await listCategory(category, {
      timeoutMs: MODEL_INVENTORY_DISCLOSURE_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  if (!listing) return null;

  const normalizedValue = normalizeInventoryEntry(value);
  if (
    !listing.some(
      (entry) =>
        typeof entry === "string" && normalizeInventoryEntry(entry) === normalizedValue,
    )
  ) {
    return null;
  }

  return (
    `\n\nModel inventory disclosure: the connected ComfyUI's "/models/${category}" ` +
    `listing includes "${value}", but the panel's refreshed "/object_info" combo ` +
    `did not. These are different server surfaces: "/models" visibility does not ` +
    `establish "/object_info" availability, and the panel cannot make the server ` +
    `rescan its model filename cache. Nothing was written. This comparison assumes ` +
    `the MCP and panel target the same ComfyUI instance; verify that if they may differ. ` +
    `Restart ComfyUI, or use a server-side cache-refresh mechanism provided by your ` +
    `ComfyUI build. After "/object_info" includes the value, call panel_refresh_nodes ` +
    `and retry.`
  );
}
