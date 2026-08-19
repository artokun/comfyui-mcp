---
name: comfyui-node-registry
description: Authoring & publishing ComfyUI custom nodes to the Comfy Registry — node structure, pyproject.toml spec, comfy-cli publishing, and CI
---

# Authoring & Publishing ComfyUI Custom Nodes

This skill covers writing a ComfyUI custom node pack and publishing it to the **Comfy Registry** (registry.comfy.org), the public catalog that powers ComfyUI-Manager. For *using* existing nodes in workflows, see the `comfyui-core` skill instead.

## Minimal Node Pack Structure

A node pack is a Python package placed under `ComfyUI/custom_nodes/<name>/`. The package `__init__.py` must export `NODE_CLASS_MAPPINGS` and `NODE_DISPLAY_NAME_MAPPINGS`; `WEB_DIRECTORY` is optional (only if the pack ships frontend JS).

```
ComfyUI/custom_nodes/my-node-pack/
├── __init__.py          # exports the mappings ComfyUI scans for
├── nodes.py             # node class definitions
├── pyproject.toml       # registry metadata (required to publish)
├── requirements.txt     # optional Python deps
├── .comfyignore         # optional — exclude files from the published archive
├── LICENSE
├── README.md
└── web/js/              # optional frontend extension (see WEB_DIRECTORY)
```

### `__init__.py`

```python
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# Optional: serve frontend JS/CSS from this folder (path relative to __init__.py)
WEB_DIRECTORY = "./web/js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
```

### A minimal node class (`nodes.py`)

```python
class ImageSelector:
    CATEGORY = "example"          # menu path where the node appears

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "mode": (["brightest", "reddest", "greenest", "bluest"],),
            },
            "optional": {
                "threshold": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
                "count": ("INT", {"default": 1, "min": 1, "max": 64}),
                "label": ("STRING", {"default": "", "multiline": False}),
            },
        }

    RETURN_TYPES = ("IMAGE",)        # tuple of output data types
    RETURN_NAMES = ("image",)        # optional friendly output names
    FUNCTION = "choose_image"        # name of the method ComfyUI calls
    OUTPUT_NODE = False              # True for terminal nodes (e.g. SaveImage)

    def choose_image(self, images, mode, threshold=0.5, count=1, label=""):
        import torch
        brightness = [torch.mean(img.flatten()).item() for img in images]
        best = brightness.index(max(brightness))
        return (images[best].unsqueeze(0),)   # MUST return a tuple


NODE_CLASS_MAPPINGS = {
    "ImageSelector": ImageSelector,        # globally unique class_type key
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImageSelector": "Image Selector",     # label shown in the UI
}
```

### Node class contract

| Member | Required | Purpose |
|--------|----------|---------|
| `INPUT_TYPES` | yes | `@classmethod` returning `{"required": {...}, "optional": {...}}`. Each input is `(TYPE,)` or `(TYPE, {opts})`. |
| `RETURN_TYPES` | yes | Tuple of output type strings (e.g. `("IMAGE", "MASK")`). Single output still needs a trailing comma. |
| `FUNCTION` | yes | String name of the method to execute. |
| `CATEGORY` | yes | Menu path string for the Add Node menu. |
| `RETURN_NAMES` | no | Friendly names for outputs (defaults to lowercased types). |
| `OUTPUT_NODE` | no | `True` marks a terminal node that produces a result (save/preview). |

**Input type widgets** — the options dict drives the UI widget:
- `("INT", {"default": 0, "min": 0, "max": 100, "step": 1})`
- `("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.1})`
- `("STRING", {"default": "", "multiline": True})`
- `(["a", "b", "c"],)` — a literal list becomes a dropdown
- `("IMAGE",)`, `("LATENT",)`, `("MODEL",)` etc. — typed connections (no widget)

The executing method **must return a tuple** matching `RETURN_TYPES`, even for a single output (`return (result,)`).

## `pyproject.toml` — Registry Metadata

Required to publish. `comfy node init` scaffolds this file. See `references/pyproject.toml` for a fully-commented example.

```toml
[project]
name = "my-node-pack"                          # unique & IMMUTABLE; lowercase, <100 chars, no "ComfyUI" prefix
description = "What this node pack does"
version = "1.0.0"                              # semantic version X.Y.Z — bump to publish a new version
license = { file = "LICENSE" }                 # or { text = "MIT License" }
requires-python = ">=3.10"
dependencies = [
    "comfyui-frontend-package<=1.21.6",        # optional — pin frontend if you ship UI
]
classifiers = [
    "Operating System :: OS Independent",
]

[project.urls]
Repository = "https://github.com/you/my-node-pack"   # REQUIRED — must be a valid repo URL
Documentation = "https://github.com/you/my-node-pack/wiki"
"Bug Tracker" = "https://github.com/you/my-node-pack/issues"

[tool.comfy]
PublisherId = "your-publisher-id"              # the id after @ on your registry profile
DisplayName = "My Node Pack"                   # human-friendly name in the registry
Icon = "https://raw.githubusercontent.com/you/my-node-pack/main/icon.png"   # square, max 400x400px
requires-comfyui = ">=1.0.0"                   # optional ComfyUI version constraint
```

### Field rules (verified against the live spec)

| Field | Section | Notes |
|-------|---------|-------|
| `name` | `[project]` | **Unique and immutable** once published. <100 chars; alphanumeric + `-` `_` `.`; no consecutive special chars; can't start with a number/special char; case-insensitive. Don't prefix with "ComfyUI". |
| `version` | `[project]` | **Semantic** `X.Y.Z` — X breaking, Y backwards-compatible feature, Z bug fix. Each value is published **once** and is immutable. |
| `description` | `[project]` | Short summary (recommended). |
| `license` | `[project]` | `{ file = "LICENSE" }` or `{ text = "MIT License" }`. |
| `requires-python` | `[project]` | e.g. `">=3.10"` (recommended). |
| `dependencies` | `[project]` | PEP 508 requirement strings; can pin `comfyui-frontend-package`. |
| `Repository` | `[project.urls]` | **Required** — valid GitHub repo URL. |
| `PublisherId` | `[tool.comfy]` | **Required** — your publisher id (after the `@` on your profile). |
| `DisplayName` | `[tool.comfy]` | Friendly registry name (optional). |
| `Icon` | `[tool.comfy]` | URL to a **square** image, **max 400×400px**; SVG/PNG/JPG/GIF. |
| `Banner` | `[tool.comfy]` | URL to a **21:9** banner image; SVG/PNG/JPG/GIF (optional). |
| `requires-comfyui` | `[tool.comfy]` | ComfyUI version range using `< > <= >= ~= !=` (optional). |
| `includes` | `[tool.comfy]` | Array forcing extra folders into the published archive. |

### Controlling the published archive

- **`.comfyignore`** — uses `.gitignore` syntax; files listed are **excluded** from the published archive. Use it to drop tests, examples, large assets, and dev files.
- **`[tool.comfy].includes`** — the inverse: force-includes folders that would otherwise be skipped (e.g. a bundled `web/dist`).

## Registry Setup (one-time)

1. Go to **registry.comfy.org** and create a **publisher**.
2. Your **Publisher ID** is the value after the `@` on your profile page. It is **globally unique and cannot be changed** — use it for `PublisherId` in `pyproject.toml`.
3. In the publisher's section, **create an API key**. Name it and **save it somewhere safe — if you lose it you must create a new one** (it is not recoverable).

## CLI Publishing Flow

Install comfy-cli (requires Python 3.10+; a virtualenv is recommended):

```bash
pip install comfy-cli
```

| Command | What it does |
|---------|--------------|
| `comfy node init` | Scaffolds `pyproject.toml` with registry metadata in the current node pack folder. Fill in the required fields (esp. `PublisherId` and `Repository`). |
| `comfy node publish` | Validates and uploads the current version to the registry. **Prompts for your API key.** Prints the registry URL on success. |

**Version immutability:** once a `version` is published it **cannot be modified or overwritten**. To ship changes, bump `version` and publish again. To pull a bad version, **deprecate it on the website** (More Actions > Deprecate), which prompts users to upgrade rather than deleting it.

## CI Publishing (GitHub Actions)

Automate publishing on every version bump. Add the API key as a repo secret named **`REGISTRY_ACCESS_TOKEN`** (Settings > Secrets and variables > Actions), then create `.github/workflows/publish_action.yml`:

```yaml
name: Publish to Comfy registry
on:
  workflow_dispatch:
  push:
    branches:
      - main
    paths:
      - "pyproject.toml"

jobs:
  publish-node:
    name: Publish Custom Node to registry
    runs-on: ubuntu-latest
    steps:
      - name: Check out code
        uses: actions/checkout@v4
      - name: Publish Custom Node
        uses: Comfy-Org/publish-node-action@main
        with:
          personal_access_token: ${{ secrets.REGISTRY_ACCESS_TOKEN }}
```

- Triggers on **push to `main`** but only when **`pyproject.toml`** changes (i.e. when you bump `version`). `workflow_dispatch` allows manual runs.
- If your default branch isn't `main`, update the `branches:` list.
- The action reads the version from `pyproject.toml` and publishes it — so the typical flow is: bump `version`, commit, push to `main`, done.

## Optional Frontend Extension

If your pack adds custom UI (widgets, sidebar tabs, menu items), set `WEB_DIRECTORY` in `__init__.py` and ship JS there. New frontend extensions should target the modern **`@comfyorg/extension-api`** rather than poking at legacy globals; pull in `@comfyorg/comfyui-frontend-types` for TypeScript types (`npm install -D @comfyorg/comfyui-frontend-types`). For the full frontend authoring workflow (`defineExtension`/`defineNode`/`defineWidget` and the `defineSidebarTab`/`defineCommand`/`defineSetting` shell APIs), see the sibling **`comfyui-frontend-extensions`** skill.

## Common Mistakes

1. **Forgetting the return tuple** — the `FUNCTION` method must `return (value,)`, not `return value`, even for one output.
2. **Single-element `RETURN_TYPES` without a comma** — `("IMAGE")` is a string, not a tuple. Write `("IMAGE",)`.
3. **`INPUT_TYPES` not a `@classmethod`** — ComfyUI calls it on the class; missing the decorator breaks node loading.
4. **Trying to overwrite a published version** — versions are immutable. Bump `version` instead; deprecate bad ones on the website.
5. **Renaming `name` after publishing** — it's immutable and globally unique. Pick a good name (no "ComfyUI" prefix) up front.
6. **Missing `[project.urls].Repository`** — it's required; publishing fails without a valid repo URL.
7. **Wrong `PublisherId`** — use the id after the `@` on your profile, not your display name.
8. **Oversized icon** — must be square and ≤ 400×400px; larger images are rejected.
9. **Renaming class keys in `NODE_CLASS_MAPPINGS`** — the key is the `class_type` stored in workflow JSON. Changing it breaks every saved workflow that used the node.
10. **Committing the API key** — store it as the `REGISTRY_ACCESS_TOKEN` secret; never in `pyproject.toml` or the repo.

## Sources

- **Official:** Comfy Registry at https://registry.comfy.org and comfy-cli publishing docs used by `comfy node publish`.
- **Empirical:** field-rule notes verified against the live spec; common-mistakes list is from observed publish failures.
