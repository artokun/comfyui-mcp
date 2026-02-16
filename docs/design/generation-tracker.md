# Generation Tracker & Community Settings

## Overview

A local SQLite database that tracks every generation's settings, counts reuse,
and optionally shares anonymized public-LoRA settings to a Cloudflare backend.
The MCP server queries the local DB to suggest "what worked before" when building
new workflows, and can also fetch community-aggregated settings.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  ComfyUI MCP Server                                        │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ Workflow      │───▶│ Generation   │───▶│ Settings     │  │
│  │ Executor      │    │ Tracker      │    │ Advisor      │  │
│  │ (existing)    │    │ (new)        │    │ (new)        │  │
│  └──────────────┘    └──────┬───────┘    └──────┬───────┘  │
│                             │                    │          │
│                      ┌──────▼───────┐     ┌─────▼────────┐ │
│                      │ SQLite DB    │     │ Community    │  │
│                      │ (local)      │     │ API Client   │  │
│                      │ better-      │     │ (optional)   │  │
│                      │ sqlite3      │     └─────┬────────┘ │
│                      └──────────────┘           │          │
└─────────────────────────────────────────────────┼──────────┘
                                                  │
                                          ┌───────▼─────────┐
                                          │ Cloudflare      │
                                          │ Workers + D1    │
                                          │ (community API) │
                                          └─────────────────┘
```

---

## Local Database: `generations.db`

Location: `<comfyui_path>/comfyui-mcp/generations.db`
(Lives alongside the user's ComfyUI data, gitignored.)

### Schema

```sql
-- Core generation log
CREATE TABLE generations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),

  -- Settings fingerprint (SHA256 of canonical JSON of tracked fields)
  settings_hash TEXT    NOT NULL,

  -- Model identification (by content hash, not filename)
  model_family  TEXT    NOT NULL,  -- 'qwen_image', 'sdxl', 'flux', etc.
  model_hash    TEXT    NOT NULL,  -- AutoV2 (first 10 chars of SHA256) of checkpoint/unet
  model_name    TEXT,              -- checkpoint/unet filename (for full-text search, not part of hash)
  preset_name   TEXT,              -- from model-settings.json, or 'custom'

  -- Sampler settings
  sampler       TEXT    NOT NULL,
  scheduler     TEXT    NOT NULL,
  steps         INTEGER NOT NULL,
  cfg           REAL    NOT NULL,
  denoise       REAL    DEFAULT 1.0,
  shift         REAL,              -- auraflow_shift for Qwen

  -- Resolution (tracked per-generation, NOT part of settings_hash)
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,

  -- LoRA (nullable — not all gens use LoRAs)
  lora_hash     TEXT,              -- AutoV2 of LoRA file (content-addressed)
  lora_name     TEXT,              -- LoRA filename (for full-text search, not part of hash)
  lora_strength REAL,
  lora_civitai_id    INTEGER,      -- NULL = private/unknown, populated after hash lookup

  -- Satisfaction signal
  -- Implicit: if the user runs the same settings_hash again, we increment reuse_count
  -- Explicit: user can thumbs-up/down via MCP tool (future)
  reuse_count   INTEGER NOT NULL DEFAULT 1,

  -- Negative prompt hash (for dedup, not stored in full)
  neg_prompt_hash TEXT
);

-- Fast lookups
CREATE INDEX idx_gen_settings_hash ON generations(settings_hash);
CREATE INDEX idx_gen_model_family  ON generations(model_family);
CREATE INDEX idx_gen_model_hash    ON generations(model_hash);
CREATE INDEX idx_gen_lora_hash     ON generations(lora_hash);
CREATE INDEX idx_gen_lora_civitai  ON generations(lora_civitai_id);
CREATE INDEX idx_gen_created       ON generations(created_at);

-- File hash cache (avoid re-hashing large .safetensors files)
-- Covers both models (checkpoints, unets) and LoRAs.
-- Keyed on filename + size + mtime — if any change, re-hash.
CREATE TABLE file_hashes (
  filename      TEXT    PRIMARY KEY,  -- basename of the file
  file_path     TEXT    NOT NULL,     -- full path (local only, never shared)
  file_size     INTEGER NOT NULL,
  file_mtime    TEXT    NOT NULL,
  sha256        TEXT    NOT NULL,
  autov2        TEXT    NOT NULL,     -- sha256[:10].toUpperCase()
  file_type     TEXT    NOT NULL,     -- 'checkpoint' | 'unet' | 'lora' | 'vae'
  civitai_id    INTEGER,              -- NULL = not found / not checked
  civitai_name  TEXT,
  civitai_model_id INTEGER,           -- parent model ID on CivitAI
  checked_at    TEXT                  -- last time we queried CivitAI
);
```

### Settings Hash

The `settings_hash` is a SHA256 of a canonical JSON string containing only
the **settings identity fields**, sorted alphabetically. This is what defines
"the same combo" — resolution is intentionally excluded because the same
sampler/steps/CFG combo works across resolutions and we want those to count
together.

Models and LoRAs are identified by their **AutoV2 content hash** (first 10 chars
of SHA256), not filenames. This means renamed files, different quantizations of
the same weights, or the same model downloaded from different sources all map to
the same identity.

```json
{
  "cfg": 4.0,
  "denoise": 1.0,
  "lora_hash": "A1B2C3D4E5",
  "lora_strength": 1.0,
  "model_family": "qwen_image",
  "model_hash": "F6G7H8I9J0",
  "sampler": "euler",
  "scheduler": "simple",
  "shift": 3.1,
  "steps": 4
}
```

**Excluded from hash** (tracked per-row but not part of the fingerprint):
- `width`, `height` — resolution is a per-generation choice
- `model_name`, `lora_name` — display names, not identity
- `preset_name` — informational only
- `neg_prompt_hash` — prompt content is never part of settings identity

When a generation runs with an already-seen `settings_hash`, we UPDATE
`reuse_count += 1` and `created_at` to the latest timestamp instead of inserting
a duplicate row. This keeps the DB compact and gives us a natural popularity signal.

---

## File Identification Flow

All models (checkpoints, UNETs) and LoRAs go through the same hashing pipeline.
The `file_hashes` table caches results so we only compute SHA256 once per file version.

```
1. Workflow references a file → extract filename + resolve full path
2. stat() the file → get size + mtime
3. Check file_hashes table (by filename + size + mtime)
   ├─ Cache hit  → use cached autov2 / civitai_id
   └─ Cache miss →
       a. Compute SHA256 of the .safetensors file
       b. Derive AutoV2 = sha256[:10].toUpperCase()
       c. Query CivitAI: GET /api/v1/model-versions/by-hash/{autov2}
          ├─ Found  → store civitai_id, civitai_name, civitai_model_id
          └─ Not found → civitai_id = NULL (private/unknown)
       d. INSERT into file_hashes cache
4. Use autov2 as model_hash / lora_hash in the generations row
5. Use civitai_id for LoRA privacy filtering
```

**Privacy rule**: Only generations where `lora_civitai_id IS NOT NULL` (or no LoRA)
are eligible for community sharing. Private LoRAs never leave the machine.

**Hashing note**: SHA256 of large safetensors files (2-12GB) takes 5-20 seconds.
We run this in a worker thread and cache aggressively. The cache invalidates only
when file size or mtime changes (renamed files keep their hash).

---

## Settings Advisor (MCP Hook)

When building a new workflow, the MCP server queries the local DB:

```sql
-- "What worked well for this model?"
-- Groups by settings_hash (resolution-agnostic), shows most popular combos
SELECT sampler, scheduler, steps, cfg, shift, denoise,
       lora_hash, lora_name, lora_strength,
       model_hash, model_name,
       reuse_count, preset_name
FROM generations
WHERE model_family = ?
ORDER BY reuse_count DESC, created_at DESC
LIMIT 10;

-- "What worked well for this specific LoRA?"
SELECT sampler, scheduler, steps, cfg, shift, denoise,
       model_hash, model_name, reuse_count
FROM generations
WHERE lora_hash = ?
ORDER BY reuse_count DESC
LIMIT 10;
```

The advisor returns the top settings to the LLM as context, letting it
suggest proven combos to the user. Combined with model-settings.json presets,
this creates a feedback loop: defaults → user experiments → local tracking →
better suggestions.

---

## NPM Scripts

### `npm run generations:review`

Interactive CLI that shows what would be shared:

```
$ npm run generations:review

=== Generation Settings Ready to Share ===

  Model Family     Sampler/Sched      Steps  CFG   LoRA                          Uses
  ─────────────    ────────────────   ─────  ────  ────────────────────────────   ────
  qwen_image       euler/simple       4      1.0   Lightning-4steps (CivitAI)    47
  qwen_image       euler_a/beta       50     4.0   (none)                        12
  sdxl             dpmpp_2m/karras    25     6.5   (none)                        8
  illustrious      euler_a/simple     22     4.5   (none)                        5

  4 entries (private LoRAs excluded)

  Share these with the community? [y/N]
```

### `npm run generations:stats`

Local-only stats view:

```
$ npm run generations:stats

  Total generations tracked: 234
  Unique setting combos: 18
  Most used: qwen_image / euler/simple / 4 steps (47 uses)
  Models: qwen_image (142), sdxl (52), illustrious (28), flux (12)
```

---

## Community Backend (Cloudflare)

### Stack

- **Cloudflare Workers** — API endpoints (free tier: 100k req/day)
- **Cloudflare D1** — SQLite-compatible edge database (free tier: 5M reads/day, 100k writes/day)
- **Rate limiting** — Cloudflare's built-in rate limiting rules

### Endpoints

#### `POST /api/v1/settings/submit`

Submit anonymized generation settings.

```json
// Request
{
  "client_version": "0.2.0",
  "entries": [
    {
      "settings_hash": "abc123...",
      "model_family": "qwen_image",
      "model_hash": "F6G7H8I9J0",
      "model_name": "qwen_image_2512_fp8_e4m3fn.safetensors",
      "model_civitai_id": 789012,
      "sampler": "euler",
      "scheduler": "simple",
      "steps": 4,
      "cfg": 1.0,
      "denoise": 1.0,
      "shift": 3.1,
      "lora_hash": "A1B2C3D4E5",
      "lora_name": "Qwen-Image-Lightning-4steps-V1.0.safetensors",
      "lora_civitai_id": 123456,
      "lora_strength": 1.0,
      "reuse_count": 47
    }
  ]
}

// Response
{ "accepted": 1, "thank_you": true }
```

**What is sent**: content hashes (AutoV2), CivitAI IDs, sampler params, reuse counts.

**What is NOT sent**: prompts, negative prompts, image data, filenames, file paths,
resolutions, private LoRA/model hashes (no CivitAI match), usernames, IP-derived
location, timestamps.

#### `GET /api/v1/settings/search`

Query community-aggregated settings.

```
GET /api/v1/settings/search?model_family=qwen_image&lora_civitai_id=123456

// Response
{
  "results": [
    {
      "model_family": "qwen_image",
      "model_hash": "F6G7H8I9J0",
      "model_name": "qwen_image_2512_fp8_e4m3fn.safetensors",
      "model_civitai_id": 789012,
      "sampler": "euler",
      "scheduler": "simple",
      "steps": 4,
      "cfg": 1.0,
      "denoise": 1.0,
      "shift": 3.1,
      "lora_hash": "A1B2C3D4E5",
      "lora_name": "Qwen-Image-Lightning-4steps-V1.0.safetensors",
      "lora_civitai_id": 123456,
      "lora_strength": 1.0,
      "total_uses": 1247,
      "unique_users": 89,
      "avg_reuse": 14.0
    }
  ],
  "total": 1,
  "cache_ttl": 3600
}
```

Searchable by: `model_family`, `model_hash`, `model_civitai_id`, `model_name`,
`lora_hash`, `lora_civitai_id`, `lora_name`, `sampler`, `scheduler`.
All filters are AND-combined. Name fields support `LIKE` / substring matching
(e.g. `?model_name=copax` matches "CopaxTimelessV11.safetensors").

Rate limit: 60 req/min per IP.

#### `GET /api/v1/settings/popular`

Top settings across all users, filterable.

```
GET /api/v1/settings/popular?model_family=sdxl&limit=10

// Response — same shape as search, ordered by total_uses DESC
```

### D1 Schema (Cloudflare)

```sql
CREATE TABLE community_settings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  settings_hash    TEXT    NOT NULL UNIQUE,

  -- Identity (hashes for dedup, names for full-text search)
  model_family     TEXT    NOT NULL,
  model_hash       TEXT    NOT NULL,     -- AutoV2 of checkpoint/unet
  model_name       TEXT,                 -- e.g. "qwen_image_2512_fp8_e4m3fn.safetensors"
  model_civitai_id INTEGER,              -- CivitAI model version ID
  lora_hash        TEXT,                 -- AutoV2 of LoRA (NULL if none)
  lora_name        TEXT,                 -- e.g. "Qwen-Image-Lightning-4steps-V1.0.safetensors"
  lora_civitai_id  INTEGER,              -- CivitAI model version ID
  lora_strength    REAL,

  -- Settings
  sampler          TEXT    NOT NULL,
  scheduler        TEXT    NOT NULL,
  steps            INTEGER NOT NULL,
  cfg              REAL    NOT NULL,
  denoise          REAL,
  shift            REAL,

  -- Aggregates
  total_uses       INTEGER NOT NULL DEFAULT 0,
  unique_users     INTEGER NOT NULL DEFAULT 0,
  first_seen       TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_cs_model      ON community_settings(model_family);
CREATE INDEX idx_cs_model_hash ON community_settings(model_hash);
CREATE INDEX idx_cs_lora_hash  ON community_settings(lora_hash);
CREATE INDEX idx_cs_lora_civ   ON community_settings(lora_civitai_id);
CREATE INDEX idx_cs_popular    ON community_settings(total_uses DESC);
```

On submit, the worker does an UPSERT keyed on `settings_hash`:
- If new: INSERT with `total_uses = reuse_count`, `unique_users = 1`
- If exists: `total_uses += reuse_count`, `unique_users += 1`

---

## MCP Tools (New)

### `generation_log`
Called automatically when `enqueue_workflow` is invoked.
Extracts settings from the executed workflow and logs to SQLite.
Not exposed to the user — internal hook.

### `suggest_settings`
```
Input:  { model_family: "qwen_image", use_case?: "portrait" | "landscape" | ... }
Output: Top local + community settings for the given model, ranked by reuse.
```

### `generation_stats`
```
Input:  { model_family?: string }
Output: Local generation statistics summary.
```

---

## Implementation Order

### Phase 1: Local tracking (no network)
1. Add `better-sqlite3` dependency
2. Create `src/services/generation-tracker.ts` — DB init, log, query
3. Create `src/services/lora-identifier.ts` — SHA256 hashing + cache
4. Hook into workflow executor — log after successful run
5. Add `suggest_settings` MCP tool
6. Add `npm run generations:stats` script

### Phase 2: CivitAI identification
7. Add CivitAI hash lookup in lora-identifier
8. Cache results in `lora_hashes` table
9. Filter shareable vs private in generation log

### Phase 3: Community sharing
10. Stand up Cloudflare Worker + D1
11. Add `npm run generations:review` script (preview + confirm)
12. Add submit endpoint client in MCP server
13. Add `search_community_settings` MCP tool
14. Rate limiting + privacy review

---

## Privacy Guarantees

1. **Opt-in only** — Nothing is shared without explicit `npm run generations:review` confirmation
2. **No prompts** — Text prompts and negative prompts are never stored in shareable form
3. **No images** — No generated images or thumbnails
4. **No private LoRAs** — Only LoRAs with a verified CivitAI hash are included
5. **No PII** — No usernames, paths, IPs stored server-side (Cloudflare Workers don't log by default)
6. **Local-first** — The local DB works fully offline; community features are additive
7. **Reviewable** — Users see exactly what will be sent before confirming
8. **No tracking** — No analytics cookies, no device fingerprinting, no session tracking
