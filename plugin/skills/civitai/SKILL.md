---
name: civitai
description: Discover Civitai models with the BUILT-IN search_civitai_models tool and install/generate them locally — find a checkpoint/LoRA/embedding on Civitai, download it into ComfyUI, and use its trigger words. Optionally pair the official Civitai MCP for community features (images browsing, posting, collections).
---

# Civitai + comfyui-mcp

comfyui-mcp has **native Civitai search built in** — `search_civitai_models` —
plus the local half of the loop: download, wire, queue, tag. The full flow
(find → install → generate) needs no other server, no API key, and works on
EVERY backend, including small local models behind the compact router.

## The built-in flow (default path)

```
search_civitai_models({ query, types: ["LORA"], base_models: ["Flux.1 D"] })
        │                    each hit: model_id · model_version_id · trigger words
        ▼
download_civitai_model({ model_version_id, target_subfolder: "loras" })
        │
        ▼
list_local_models  →  panel_add_node loader / generate_image   # use it
```

- **ALWAYS filter `base_models`** when the user's checkpoint family is known —
  a Flux LoRA will not load on an SDXL checkpoint (see `model-compatibility`).
  CivitAI labels: `Flux.1 D`, `SDXL 1.0`, `SD 1.5`, `Pony`, `Illustrious`,
  `Wan Video`.
- `target_subfolder` must match the model type: `checkpoints`, `loras`, `vae`,
  `controlnet`, `embeddings`, `upscale_models`, …
- Results are **SFW-only by default** (`nsfw: true` to opt in).
- Each hit carries **trigger words** — put them in the prompt after installing.
- Prefer `model_version_id` over `model_id` — a Civitai page can list several
  versions and the user usually means a specific one.

**API key (optional).** Search needs none. `CIVITAI_API_TOKEN` (from
civitai.com/user/account) unlocks **gated/early-access downloads** and gated
search results — set it once (panel Settings › "Set CivitAI token…" or env).

## Recipes

**"Find me a good anime LoRA for Flux and install it"**
1. `search_civitai_models({ query: "anime style", types: ["LORA"], base_models: ["Flux.1 D"] })`.
2. Present the top 3–5 with name, creator, base model, downloads, and the
   version id. Let the user pick.
3. `download_civitai_model({ model_version_id, target_subfolder: "loras" })`.
4. In the panel: `panel_add_node` a `LoraLoader`, `panel_set_widget` the
   `lora_name`, wire it between checkpoint and sampler — and use the hit's
   trigger words in the prompt. Headless: `generate_image` / build the workflow.

**"Download this Civitai page for me"** (user pastes a URL)
- Parse the `modelVersionId` from the URL if present; otherwise pass the model
  id from the URL to `download_civitai_model` (it resolves the latest version).
  A raw `civitai.com/api/download/...` URL also works via `download_model`
  with `CIVITAI_API_TOKEN` set.

## Optional: the official Civitai MCP (community surface)

For features beyond search→install — browsing example **images** and their
generation params, collections, posting, reviews, bounties — pair the official
remote server (no longer auto-bundled; add it once):

```bash
claude mcp add --transport http civitai https://mcp.civitai.com/mcp \
  --header "Authorization: Bearer YOUR_CIVITAI_API_KEY"
```

Then `mcp__civitai__*` tools appear alongside comfyui-mcp's. Its discovery
results hand off identically (`modelVersions[].id` → `download_civitai_model`).

**Boundaries:** that server also exposes **write/social** tools (post,
comment, review, DM, follow). Those publish on the user's behalf — surface
what you're about to post and get an explicit yes first. This skill is about
discovery → local install → generation; don't post or message without being
asked.

## See also

- `model-registry` — curated direct download URLs (HF + Civitai notes)
- `model-compatibility` — base-model / VAE / CLIP pairing (why a LoRA won't load)
- `prompt-engineering` — Civitai image params are a prompt goldmine
