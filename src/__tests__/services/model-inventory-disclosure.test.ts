import { describe, expect, it, vi } from "vitest";
import {
  getModelInventoryDisclosure,
  isReadableComboValueRefusal,
} from "../../services/model-inventory-disclosure.js";

const REFUSAL =
  `Error: Value "models\\video\\minimax_h3_video_vae_int8_convrot.safetensors" is ` +
  `not a valid option for combo widget "vae_name". Its option list WAS read ` +
  `successfully and holds 22 options, none of them this value.`;

describe("model inventory disclosure (#2414)", () => {
  it("discloses a live /models hit without claiming /object_info availability", async () => {
    const listCategory = vi.fn(async (category: string, options?: { timeoutMs?: number }) => {
      expect(category).toBe("vae");
      expect(options?.timeoutMs).toBe(2000);
      return ["models/video/minimax_h3_video_vae_int8_convrot.safetensors"];
    });

    const note = await getModelInventoryDisclosure(
      "vae_name",
      "models\\video\\minimax_h3_video_vae_int8_convrot.safetensors",
      REFUSAL,
      listCategory,
    );

    expect(note).toContain("/models/vae");
    expect(note).toContain("/object_info");
    expect(note).toContain("does not establish");
    expect(note).toContain("Nothing was written");
    expect(note).not.toContain("filesystem");
    expect(note).not.toContain("available to load");
  });

  it("stays silent when the live listing is absent, inconclusive, or does not contain the value", async () => {
    for (const listing of [[], undefined]) {
      await expect(
        getModelInventoryDisclosure("vae_name", "missing.safetensors", REFUSAL, async () => listing),
      ).resolves.toBeNull();
    }
    await expect(
      getModelInventoryDisclosure(
        "vae_name",
        "present.safetensors",
        REFUSAL,
        async () => {
          throw new Error("endpoint unavailable");
        },
      ),
    ).resolves.toBeNull();
  });

  it("does not classify unreadable combos or ambiguous widget names as a cache mismatch", async () => {
    expect(isReadableComboValueRefusal(REFUSAL)).toBe(true);
    expect(isReadableComboValueRefusal('The combo "vae_name" has an EMPTY option list')).toBe(false);
    expect(isReadableComboValueRefusal("The value is not in this combo's current option list")).toBe(
      false,
    );

    const listCategory = vi.fn(async () => ["model.safetensors"]);
    await expect(
      getModelInventoryDisclosure(
        "vae_name",
        "model.safetensors",
        'The combo "vae_name" has an EMPTY option list',
        listCategory,
      ),
    ).resolves.toBeNull();
    await expect(
      getModelInventoryDisclosure("model_name", "model.safetensors", REFUSAL, listCategory),
    ).resolves.toBeNull();
    await expect(
      getModelInventoryDisclosure("toString", "model.safetensors", REFUSAL, listCategory),
    ).resolves.toBeNull();
    expect(listCategory).not.toHaveBeenCalled();
  });

  it("stays silent for empty or non-string widget/value inputs", async () => {
    const listCategory = vi.fn(async () => ["present.safetensors"]);
    await expect(
      getModelInventoryDisclosure("", "present.safetensors", REFUSAL, listCategory),
    ).resolves.toBeNull();
    await expect(
      getModelInventoryDisclosure("vae_name", "", REFUSAL, listCategory),
    ).resolves.toBeNull();
    await expect(
      getModelInventoryDisclosure(undefined, "present.safetensors", REFUSAL, listCategory),
    ).resolves.toBeNull();
    await expect(
      getModelInventoryDisclosure("vae_name", undefined, REFUSAL, listCategory),
    ).resolves.toBeNull();
    expect(listCategory).not.toHaveBeenCalled();
  });

  it("matches a live listing by normalized path and ignores non-string entries", async () => {
    const listCategory = vi.fn(async (category: string) => {
      expect(category).toBe("checkpoints");
      return [12, "./models\\video\\present.safetensors"] as unknown as string[];
    });

    const note = await getModelInventoryDisclosure(
      "ckpt_name",
      "models/video/present.safetensors",
      REFUSAL.replace("vae_name", "ckpt_name"),
      listCategory,
    );

    expect(note).toContain("/models/checkpoints");
    expect(note).toContain("models/video/present.safetensors");
    expect(note).toContain("Nothing was written");
  });
});
