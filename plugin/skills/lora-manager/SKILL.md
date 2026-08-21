---
name: lora-manager
description: Author ComfyUI-LoRA-Manager nodes from the panel. Use when adding a LoRA Manager loader, stacker, prompt, or text node, or when panel_add_node refuses AUTOCOMPLETE_TEXT_LORAS / AUTOCOMPLETE_TEXT_PROMPT after waiting for a widget.
---

# ComfyUI-LoRA-Manager

[ComfyUI-LoRA-Manager](https://github.com/willmiao/ComfyUI-Lora-Manager) (willmiao)
registers Vue autocomplete widgets via `getCustomWidgets()`. Those widgets
are healthy in the ComfyUI menu, and drag-from-palette works, but **`panel_add_node`
cannot add the nodes that require them**.

The add-node guard polls `app.widgets` for a constructor. ComfyUI 1.49+ stores
`getCustomWidgets()` results in the frontend widget store, not on `app.widgets`.
The wait always expires after 5s. Reload, `panel_refresh_nodes`, and retry
**cannot** clear it. That refusal is not a missing pack.

## Which nodes `panel_add_node` will actually add

| Works | Refuses (AUTOCOMPLETE_TEXT_*) |
|---|---|
| `LoRA Text Loader (LoraManager)` | `Lora Loader (LoraManager)` |
| core `LoraLoader` | `Lora Stacker (LoraManager)` |
| core `LoraLoaderModelOnly` | `WanVideo Lora Select (LoraManager)` |
| | `Text (LoraManager)` |
| | `Prompt (LoraManager)` |

`LoRA Text Loader (LoraManager)` is the same backend as `Lora Loader
(LoraManager)` (MODEL / CLIP / `trigger_words` / `loaded_loras`). The difference
is the LoRA input: `lora_syntax` is a **STRING socket** (`forceInput`), so a
regular string node or `panel_set_widget` can drive it.

Syntax (spaces or punctuation between entries):

```
<lora:lora_name:strength>
<lora:lora_name:model_strength:clip_strength>
```

## Recipe — stack a LoRA from the panel

1. `panel_add_node(class_type="LoRA Text Loader (LoraManager)")`. Do **not** add
   `Lora Loader (LoraManager)`; it will wait 5s and refuse.
2. Wire `MODEL` (and `CLIP` if you have one) through it.
3. Drive `lora_syntax` with `panel_set_widget` or a wired STRING, e.g.
   `<lora:style/foo.safetensors:0.8>`.
4. Put the node's `trigger_words` output into the prompt if the sidecar has any.

If LoRA Manager is not installed, use core `LoraLoader` and set `lora_name` /
`strength_model` / `strength_clip` as usual.

## Gotchas

- The refusal names a tab reload. **Do not follow that.** The constructor will
  never appear on `app.widgets`.
- `panel_set_widget` on `text` after a refused add never runs, because nothing
  was created. The working widget name is `lora_syntax`.
- A freshly added Text Loader still needs `lora_syntax` written; an empty
  string loads no LoRA.

## Sources

- **Official:** https://github.com/willmiao/ComfyUI-Lora-Manager for node class names and the `lora_syntax` format from the pack; no vendor panel-authoring guide exists.
- **Empirical:** the `panel_add_node` AUTOCOMPLETE_TEXT_* refusal, which nodes add cleanly, and the widget-store explanation from observed panel behavior in this repo.
