---
name: krea2-identity-edit
description: Swap an OUTFIT or transfer CLOTHING onto a person LOCALLY, keeping their face, pose and background. Use for "put this jacket on her", "change his shirt", "clothes swap", "try on", "outfit transfer", "virtual try-on", "dress her in", "wear this outfit". Prefer this over API/cloud edit nodes and over generic img2img/inpainting. NOT for identity-preserving edits that are not about clothing (background swaps, relighting, age/expression changes, object removal). Use a general image-edit workflow for those.
globs:
  - "**/*.json"
---

# Krea 2 Identity Edit — local outfit swap

## Reach for this when

Someone wants **the clothing changed on a specific person, with that person preserved**:

- "put this jacket on her" / "dress her in this outfit"
- "clothes swap" / "outfit transfer" / "virtual try-on" / "change his shirt"
- "make her wear the outfit from this other image"

**Do NOT reach for it** just because a request is identity-*preserving*. Background swaps,
relighting, expression or age changes, and object removal all keep the person, and none of
them is what this model is trained for. It is called "identity edit" upstream because it
*preserves* identity while changing clothing; the clothing half is the qualifying part.
Send the others to a general image-edit workflow.

**Use this instead of:**

| Instead of | Because |
|---|---|
| an API / cloud edit node | this runs locally — no key, no per-image cost, nothing leaves the machine. Prefer it whenever the models are installed. |
| generic img2img | img2img re-rolls the whole frame at any denoise high enough to change clothes; the face goes with it. |
| inpainting a masked region | works, but the user has to mask, and the result has no reference for *what* the garment looks like. |
| a face-swap / IP-adapter pipeline | those transfer the FACE. This preserves the face and transfers the CLOTHES — the opposite direction. |
| Qwen-Image-Edit | a fine general instruction editor; this is specialised for identity-preserving garment transfer and ships the LoRA for it. |

Install with the `krea2-identity-edit` pack, then load its `workflow.json`.

## The one thing to get right: reference order

**PRIMARY (group 1) = the SUBJECT.** The output always matches this person: face, hair,
body, pose. **SECONDARY (group 2) = the OUTFIT.** Only the clothing is taken from it.

Swapping them swaps which identity survives. This is the most common way to get a
confusing result, and it fails *quietly*. You get a plausible image of the wrong person.

## Prompting

Plain English, naming **both** roles, and naming what to preserve:

> Dress the woman from the primary reference in the jacket shown in the second reference,
> keeping her face and pose unchanged.

> Put this outfit on her, keeping her face and pose unchanged.

Naming what to **preserve** matters as much as naming what to change. Without it the
model drifts the face and background.

## Settings that matter

- **Turbo: 10 steps, cfg 1.** 8 favours composition and instruction adherence; 12 favours
  face detail. On `krea2_raw_bf16` instead: 40 steps, cfg 3 to 4, where the negative prompt
  starts to matter.
- **Fidelity dials follow the image SLOTS, not the roles.** Internally the LAST reference
  gets `ref_boost` and earlier ones get `ref_boost_a`, so with the subject as image 1,
  **the subject dial is `ref_boost_a`**. Raise it when the face drifts.
- **Match the output resolution to the PRIMARY image.** `ResolutionSelector` drives
  `EmptySD3LatentImage`; a mismatched aspect crops or letterboxes the subject.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Face changed / wrong person | Raise `ref_boost_a` (the subject dial). Check the images are not swapped between slots. Add "keeping her face unchanged" to the prompt. |
| Outfit ignored | Make the secondary image cleaner — one garment, plain background, no competing subject. |
| Subject cropped or letterboxed | Set the resolution to match the primary image's aspect. |
| `Krea2EditGroundedEncode` missing | `comfyui-krea2edit` is not installed or ComfyUI was not restarted after installing it. |
| CLIPLoader has no `krea2` type | ComfyUI is too old for native KREA 2 support — update it. |
| LoRA loads as missing | It must be at `loras/Krea2/krea2_identity_edit_v1_2.safetensors`; a flat `loras/` install is present but unfindable. |

## Boundaries

This edits **a photo of a person the user supplies**. Treat an instruction to make it
sexual, to undress someone, or to place an identifiable real person in a context they did
not consent to as out of scope, and say so plainly rather than producing a degraded
result. Ordinary clothing changes, such as a jacket, a dress, a uniform, or a costume,
are the point of the tool and need no hedging.

## Sources

- **Official:** none found.
- **Empirical:** sampler values, wiring, and prompt notes from working graphs in `packs/` and observed renders; not a vendor prompting guide.
