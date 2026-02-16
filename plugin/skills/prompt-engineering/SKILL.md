---
name: prompt-engineering
description: ComfyUI prompt engineering knowledge — CLIP text encoding syntax, weight modifiers, model-specific prompting strategies, and best practices
globs:
  - "**/*.json"
---

# ComfyUI Prompt Engineering

## CLIP Text Encoding Fundamentals

ComfyUI uses CLIP (Contrastive Language-Image Pre-training) text encoders to convert text prompts into conditioning tensors. The `CLIPTextEncode` node takes a text string and a CLIP model, producing a `CONDITIONING` output for the KSampler.

### Token Limit

CLIP processes text in **77-token chunks**. Each word is typically 1-3 tokens. Prompts exceeding 77 tokens are silently truncated unless you use the BREAK token or a multi-clip encoding node.

## Weight Syntax

### Emphasis (Attention Weights)

Adjust how strongly the model attends to specific words or phrases:

| Syntax | Effect | Equivalent Weight |
|--------|--------|-------------------|
| `(word:1.3)` | Increase emphasis by 30% | Explicit weight 1.3 |
| `(word:0.7)` | Decrease emphasis by 30% | Explicit weight 0.7 |
| `(word)` | Slight increase | `(word:1.1)` |
| `((word))` | Moderate increase | `(word:1.21)` — 1.1^2 |
| `(((word)))` | Strong increase | `(word:1.331)` — 1.1^3 |
| `[word]` | Slight decrease | `(word:0.9091)` — 1/1.1 |
| `[[word]]` | Moderate decrease | `(word:0.8264)` — 1/1.1^2 |

### Weight Rules

- **Valid range**: 0.0 to 2.0 (going beyond 1.5 often causes artifacts)
- **Default weight**: 1.0 for unmodified tokens
- **Nesting stacks multiplicatively**: `((word))` = 1.1 * 1.1 = `(word:1.21)`
- **Phrases**: `(red sports car:1.3)` applies weight to the entire phrase
- **Mixing**: `(detailed face:1.4), (blurry background:0.6)` — combine in one prompt

### Examples

```
a (beautiful:1.3) woman with (flowing red hair:1.2), wearing a blue dress, (sharp focus:1.1)
```

```
(masterpiece:1.4), (best quality:1.3), a knight in (ornate armor:1.2), standing on a cliff, (dramatic lighting:1.1), cinematic
```

## BREAK Token

The `BREAK` keyword forces CLIP to end the current 77-token chunk and start processing subsequent text in a new chunk. This is critical for long prompts.

### When to Use BREAK

- Prompt exceeds ~60 words (approaching the 77-token limit)
- You want to separate conceptually distinct parts of the prompt
- Certain details are being ignored (they may be past the 77-token cutoff)

### BREAK Example

```
masterpiece, best quality, a beautiful Japanese garden with cherry blossoms,
stone lanterns, koi pond, traditional wooden bridge, morning mist
BREAK
highly detailed, 8k uhd, photorealistic, volumetric lighting,
depth of field, golden hour, award-winning photography
```

Each chunk is encoded independently and then concatenated as conditioning, ensuring all tokens are processed.

## Embeddings / Textual Inversions

Embeddings (textual inversions) are pre-trained token sets that encode complex concepts into a single trigger word.

### Syntax

```
embedding:easynegative
embedding:badhandv4
embedding:bad-image-v2-39000
```

### Usage in Prompts

- Place embedding triggers directly in the prompt text
- Most commonly used in **negative prompts** to improve quality
- The embedding `.safetensors` or `.pt` file must be in `models/embeddings/`

### Common Negative Embeddings

| Embedding | Best For | Description |
|-----------|----------|-------------|
| `easynegative` | SD 1.5 | General quality improvement |
| `badhandv4` | SD 1.5 | Fixes hand deformities |
| `bad-image-v2-39000` | SD 1.5 | Reduces artifacts |
| `negativeXL_D` | SDXL | SDXL-specific negative embedding |
| `ac_neg1` | SDXL | Alternative SDXL negative |

### Example with Embeddings

Positive: `a portrait of a woman, masterpiece, best quality`
Negative: `embedding:easynegative, embedding:badhandv4, worst quality, low quality`

## Model-Specific Prompting

### SD 1.5

**Negative prompt: IMPORTANT — SD 1.5 is very sensitive to negatives.**

Positive prompt structure:
```
(masterpiece:1.2), (best quality:1.2), subject description, details, style tags
```

Recommended negative prompt:
```
worst quality, low quality, normal quality, lowres, watermark, signature,
text, jpeg artifacts, blurry, bad anatomy, bad hands, extra fingers,
missing fingers, extra limbs, deformed, disfigured, mutation, ugly
```

Key notes:
- Quality tags like `masterpiece, best quality` significantly affect output
- Responds well to danbooru-style tags: `1girl, long hair, blue eyes, school uniform`
- Embedding-based negatives (`easynegative`) are very effective
- Keep prompts concise — 77 token limit per chunk

### SDXL (1.0 / Turbo / Lightning)

**Negative prompt: Moderate importance — SDXL is less sensitive to negatives than SD 1.5.**

Positive prompt structure:
```
subject description with natural language, detailed description of scene and style
```

Recommended negative prompt:
```
blurry, low quality, deformed, ugly, bad anatomy, disfigured, poorly drawn face,
mutation, mutated, extra limbs, watermark, text
```

Key notes:
- SDXL understands natural language better than tag-based prompts
- Dual CLIP encoders (CLIP-L + CLIP-G) — use `CLIPTextEncodeSDXL` for separate control
- `CLIPTextEncodeSDXL` has separate `text_g` (global description) and `text_l` (local details) fields
- Supports longer prompts natively (two 77-token chunks via dual CLIP)
- Quality tags are less critical but still helpful
- **SDXL Turbo**: 1-4 steps, CFG 1.0-2.0, minimal negative prompt needed
- **SDXL Lightning**: 4-8 steps, CFG 1.0-2.0, often works with empty negative

### Flux (Flux.1 schnell / dev)

**Negative prompt: NOT USED — Flux operates at CFG=1.0 with no negative conditioning.**

Positive prompt structure:
```
Detailed natural language description. Flux excels with descriptive sentences
rather than comma-separated tags. Describe the scene as if writing a paragraph.
```

Key notes:
- **CFG must be 1.0** — higher values cause artifacts
- **No negative prompt** — connect nothing or empty string to negative conditioning
- T5-XXL encoder understands complex sentences and spatial relationships
- Flux handles compositional prompts better than SD models
- Longer prompts (200+ tokens) work well thanks to T5 encoder
- Prompt structure: describe the scene naturally, like a caption
- Schnell: 4 steps, simple scheduler
- Dev: 20-50 steps, sgm_uniform scheduler

### Flux Prompt Example

```
A serene Japanese garden in autumn. A stone path leads through a grove of maple
trees with bright red and orange leaves. A small wooden bridge crosses a koi pond
where golden fish swim beneath the surface. Morning mist rises from the water,
and soft sunlight filters through the canopy. The scene is photorealistic with
warm, natural lighting and shallow depth of field.
```

### SD3 / SD3.5

**Negative prompt: Minimal — SD3 needs very little negative guidance.**

Positive prompt structure:
```
Natural language description, supports very long detailed prompts thanks to T5-XXL
```

Key notes:
- Triple CLIP architecture: CLIP-L + CLIP-G + T5-XXL
- Supports much longer prompts than SD 1.5 or SDXL
- Natural language works better than tag-based prompting
- CFG 4-7 (lower than SD 1.5)
- Minimal negatives needed — `low quality, blurry` is usually sufficient
- Use `CLIPTextEncodeSD3` node for model-specific encoding if available

## Prompt Structure Best Practices

### Recommended Order

1. **Quality modifiers** (if SD 1.5/SDXL): `masterpiece, best quality, highly detailed`
2. **Subject**: `a young woman, a cyberpunk cityscape, a golden retriever`
3. **Subject details**: `with long flowing red hair, wearing a white dress`
4. **Action/pose**: `standing in a field, looking at the camera, running`
5. **Environment**: `in a sunlit meadow, at night in a neon-lit street`
6. **Composition**: `close-up portrait, full body shot, wide angle`
7. **Lighting**: `dramatic lighting, soft natural light, studio lighting, golden hour`
8. **Style/medium**: `oil painting, photograph, digital art, watercolor, anime`
9. **Technical quality**: `8k, uhd, photorealistic, sharp focus, depth of field`

### Quality Boosters

These tokens generally improve output quality across SD 1.5 and SDXL:

```
masterpiece, best quality, highly detailed, 8k, photorealistic,
ultra-detailed, sharp focus, professional, award-winning
```

For photorealism specifically:
```
photorealistic, hyperrealistic, RAW photo, DSLR, 8k uhd,
film grain, Fujifilm XT3, sharp focus, natural lighting
```

For anime/illustration:
```
masterpiece, best quality, highly detailed, anime,
beautiful detailed eyes, detailed face, illustration
```

## LoRA Trigger Words

LoRA (Low-Rank Adaptation) models are fine-tuned on specific concepts and require their **trigger words** to activate the learned concept.

### Rules

- Trigger words are **specific to each LoRA** — check the LoRA's model page for its triggers
- Place trigger words in the prompt naturally: `a photo of ohwx woman in a garden` (where `ohwx` is the trigger)
- Some LoRAs use style triggers: `in the style of pixar3d`
- Multiple LoRAs can be stacked, but each needs its own trigger word in the prompt
- LoRA strength (in the `LoraLoader` node) interacts with prompt weight — usually keep one at default

### Common Patterns

```
# Character LoRA
a photo of sks person, wearing casual clothes, in a park

# Style LoRA
a landscape painting, autumn forest, in the style of impressionism, masterpiece

# Concept LoRA
a character wearing mecha_armor, standing in a battlefield, detailed
```

## Wildcards and Dynamic Prompts

If **ComfyUI-Impact-Pack** or a wildcard node pack is installed, you can use dynamic prompt syntax:

### Wildcard Syntax

```
a {red|blue|green|yellow} car parked on a {sunny|rainy|snowy} street
```

Each `{option1|option2|option3}` randomly selects one option per generation.

### Wildcard Files

Wildcard `.txt` files (one option per line) can be referenced:
```
a __haircolor__ haired woman wearing a __clothing__ in __location__
```

Where `haircolor.txt`, `clothing.txt`, and `location.txt` are in the wildcards directory.

## CLIPTextEncode Variants

| Node | Use Case | Notes |
|------|----------|-------|
| `CLIPTextEncode` | Standard single-CLIP encoding | Works with all models |
| `CLIPTextEncodeSDXL` | SDXL dual-CLIP with separate G/L fields | Better SDXL control |
| `CLIPTextEncodeSD3` | SD3 triple-CLIP encoding | For SD3/SD3.5 models |
| `CLIPTextEncodeFlux` | Flux T5-based encoding | For Flux models |
| `ConditioningCombine` | Merge two conditionings | Stack different prompt aspects |
| `ConditioningSetArea` | Regional prompting | Apply conditioning to specific image areas |
| `ConditioningSetMask` | Mask-based conditioning | Apply prompt only where mask is active |

## Common Prompting Mistakes

1. **Using negative prompts with Flux**: Flux ignores negatives and CFG > 1 causes artifacts
2. **Tag-based prompts for Flux/SD3**: These models prefer natural language descriptions
3. **Exceeding 77 tokens without BREAK**: Tokens past the limit are silently dropped
4. **Weight > 1.5**: Causes color bleeding, artifacts, and distortion
5. **Conflicting terms**: `(bright:1.3) (dark:1.3)` confuses the model
6. **Embedding without file**: Using `embedding:name` without the `.safetensors` file installed causes errors
7. **Wrong LoRA trigger words**: The prompt must contain the exact trigger word(s) for the LoRA to activate
8. **Quality tags in Flux prompts**: `masterpiece, best quality` are meaningless for Flux — describe quality naturally
