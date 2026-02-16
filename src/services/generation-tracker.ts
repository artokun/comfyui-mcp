import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { FileHasher, type FileHashResult } from "./file-hasher.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerationEntry {
  modelFamily: string;
  modelHash: string;
  modelName: string | null;
  presetName: string | null;
  sampler: string;
  scheduler: string;
  steps: number;
  cfg: number;
  denoise: number;
  shift: number | null;
  width: number;
  height: number;
  loraHash: string | null;
  loraName: string | null;
  loraStrength: number | null;
  loraCivitaiId: number | null;
  negPromptHash: string | null;
}

export interface TopSetting {
  settingsHash: string;
  modelFamily: string;
  modelHash: string;
  modelName: string | null;
  presetName: string | null;
  sampler: string;
  scheduler: string;
  steps: number;
  cfg: number;
  denoise: number;
  shift: number | null;
  loraHash: string | null;
  loraName: string | null;
  loraStrength: number | null;
  reuseCount: number;
  createdAt: string;
}

export interface GenerationStats {
  totalGenerations: number;
  uniqueCombos: number;
  modelBreakdown: Array<{ modelFamily: string; count: number }>;
  topSettings: TopSetting[];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS generations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  settings_hash   TEXT    NOT NULL,
  model_family    TEXT    NOT NULL,
  model_hash      TEXT    NOT NULL,
  model_name      TEXT,
  preset_name     TEXT,
  sampler         TEXT    NOT NULL,
  scheduler       TEXT    NOT NULL,
  steps           INTEGER NOT NULL,
  cfg             REAL    NOT NULL,
  denoise         REAL    DEFAULT 1.0,
  shift           REAL,
  width           INTEGER NOT NULL,
  height          INTEGER NOT NULL,
  lora_hash       TEXT,
  lora_name       TEXT,
  lora_strength   REAL,
  lora_civitai_id INTEGER,
  reuse_count     INTEGER NOT NULL DEFAULT 1,
  neg_prompt_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_gen_settings_hash ON generations(settings_hash);
CREATE INDEX IF NOT EXISTS idx_gen_model_family  ON generations(model_family);
CREATE INDEX IF NOT EXISTS idx_gen_model_hash    ON generations(model_hash);
CREATE INDEX IF NOT EXISTS idx_gen_lora_hash     ON generations(lora_hash);
CREATE INDEX IF NOT EXISTS idx_gen_lora_civitai  ON generations(lora_civitai_id);
CREATE INDEX IF NOT EXISTS idx_gen_created       ON generations(created_at);
`;

// ---------------------------------------------------------------------------
// Settings hash computation
// ---------------------------------------------------------------------------

/**
 * Compute the settings fingerprint. This determines what counts as "the same combo".
 * Resolution, display names, and preset names are intentionally excluded.
 */
function computeSettingsHash(entry: GenerationEntry): string {
  const canonical: Record<string, unknown> = {
    cfg: entry.cfg,
    denoise: entry.denoise,
    model_family: entry.modelFamily,
    model_hash: entry.modelHash,
    sampler: entry.sampler,
    scheduler: entry.scheduler,
    steps: entry.steps,
  };

  // Only include optional fields if they have values
  if (entry.shift != null) canonical.shift = entry.shift;
  if (entry.loraHash) canonical.lora_hash = entry.loraHash;
  if (entry.loraStrength != null && entry.loraHash) canonical.lora_strength = entry.loraStrength;

  // Sort keys for deterministic output
  const sorted = Object.keys(canonical)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = canonical[key];
      return acc;
    }, {});

  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

// ---------------------------------------------------------------------------
// GenerationTracker class
// ---------------------------------------------------------------------------

export class GenerationTracker {
  private db: Database.Database;
  public readonly fileHasher: FileHasher;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? this.defaultDbPath();

    // Ensure parent directory exists
    const dir = join(resolvedPath, "..");
    mkdirSync(dir, { recursive: true });

    this.db = new BetterSqlite3(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(INIT_SQL);

    this.fileHasher = new FileHasher(this.db);

    logger.info(`Generation tracker DB: ${resolvedPath}`);
  }

  private defaultDbPath(): string {
    if (config.comfyuiPath) {
      return join(config.comfyuiPath, "comfyui-mcp", "generations.db");
    }
    // Fallback: next to the MCP server package
    return join(process.cwd(), "generations.db");
  }

  /**
   * Log a generation. If the same settings_hash already exists,
   * increments reuse_count and updates timestamp instead of inserting.
   */
  logGeneration(entry: GenerationEntry): { settingsHash: string; reuseCount: number } {
    const settingsHash = computeSettingsHash(entry);

    const existing = this.db
      .prepare(`SELECT id, reuse_count FROM generations WHERE settings_hash = ?`)
      .get(settingsHash) as { id: number; reuse_count: number } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE generations
           SET reuse_count = reuse_count + 1,
               created_at = datetime('now'),
               width = ?,
               height = ?
           WHERE id = ?`,
        )
        .run(entry.width, entry.height, existing.id);

      const newCount = existing.reuse_count + 1;
      logger.info(
        `Generation logged (reuse #${newCount}): ${entry.modelFamily} / ${entry.sampler}/${entry.scheduler} / ${entry.steps} steps`,
      );
      return { settingsHash, reuseCount: newCount };
    }

    this.db
      .prepare(
        `INSERT INTO generations (
           settings_hash, model_family, model_hash, model_name, preset_name,
           sampler, scheduler, steps, cfg, denoise, shift,
           width, height,
           lora_hash, lora_name, lora_strength, lora_civitai_id,
           neg_prompt_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        settingsHash,
        entry.modelFamily,
        entry.modelHash,
        entry.modelName,
        entry.presetName,
        entry.sampler,
        entry.scheduler,
        entry.steps,
        entry.cfg,
        entry.denoise,
        entry.shift,
        entry.width,
        entry.height,
        entry.loraHash,
        entry.loraName,
        entry.loraStrength,
        entry.loraCivitaiId,
        entry.negPromptHash,
      );

    logger.info(
      `Generation logged (new): ${entry.modelFamily} / ${entry.sampler}/${entry.scheduler} / ${entry.steps} steps`,
    );
    return { settingsHash, reuseCount: 1 };
  }

  /**
   * Get top settings for a model family, ordered by reuse count.
   */
  suggestSettings(
    modelFamily: string,
    limit = 10,
  ): TopSetting[] {
    const rows = this.db
      .prepare(
        `SELECT settings_hash, model_family, model_hash, model_name, preset_name,
                sampler, scheduler, steps, cfg, denoise, shift,
                lora_hash, lora_name, lora_strength, reuse_count, created_at
         FROM generations
         WHERE model_family = ?
         ORDER BY reuse_count DESC, created_at DESC
         LIMIT ?`,
      )
      .all(modelFamily, limit) as Array<Record<string, unknown>>;

    return rows.map(mapRowToTopSetting);
  }

  /**
   * Get top settings for a specific LoRA hash.
   */
  suggestSettingsForLora(
    loraHash: string,
    limit = 10,
  ): TopSetting[] {
    const rows = this.db
      .prepare(
        `SELECT settings_hash, model_family, model_hash, model_name, preset_name,
                sampler, scheduler, steps, cfg, denoise, shift,
                lora_hash, lora_name, lora_strength, reuse_count, created_at
         FROM generations
         WHERE lora_hash = ?
         ORDER BY reuse_count DESC, created_at DESC
         LIMIT ?`,
      )
      .all(loraHash, limit) as Array<Record<string, unknown>>;

    return rows.map(mapRowToTopSetting);
  }

  /**
   * Search generations by model or LoRA name (substring match).
   */
  searchByName(
    query: string,
    limit = 20,
  ): TopSetting[] {
    const pattern = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT settings_hash, model_family, model_hash, model_name, preset_name,
                sampler, scheduler, steps, cfg, denoise, shift,
                lora_hash, lora_name, lora_strength, reuse_count, created_at
         FROM generations
         WHERE model_name LIKE ? OR lora_name LIKE ?
         ORDER BY reuse_count DESC, created_at DESC
         LIMIT ?`,
      )
      .all(pattern, pattern, limit) as Array<Record<string, unknown>>;

    return rows.map(mapRowToTopSetting);
  }

  /**
   * Get overall generation statistics.
   */
  getStats(modelFamily?: string): GenerationStats {
    const whereClause = modelFamily ? `WHERE model_family = ?` : "";
    const params = modelFamily ? [modelFamily] : [];

    const totalRow = this.db
      .prepare(`SELECT COALESCE(SUM(reuse_count), 0) AS total FROM generations ${whereClause}`)
      .get(...params) as { total: number };

    const uniqueRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM generations ${whereClause}`)
      .get(...params) as { cnt: number };

    const breakdownRows = this.db
      .prepare(
        `SELECT model_family, COALESCE(SUM(reuse_count), 0) AS total
         FROM generations
         GROUP BY model_family
         ORDER BY total DESC`,
      )
      .all() as Array<{ model_family: string; total: number }>;

    const topRows = this.db
      .prepare(
        `SELECT settings_hash, model_family, model_hash, model_name, preset_name,
                sampler, scheduler, steps, cfg, denoise, shift,
                lora_hash, lora_name, lora_strength, reuse_count, created_at
         FROM generations ${whereClause}
         ORDER BY reuse_count DESC, created_at DESC
         LIMIT 5`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    return {
      totalGenerations: totalRow.total,
      uniqueCombos: uniqueRow.cnt,
      modelBreakdown: breakdownRows.map((r) => ({
        modelFamily: r.model_family,
        count: r.total,
      })),
      topSettings: topRows.map(mapRowToTopSetting),
    };
  }

  /**
   * Get shareable entries (only those with public LoRAs or no LoRA).
   */
  getShareableEntries(): TopSetting[] {
    const rows = this.db
      .prepare(
        `SELECT settings_hash, model_family, model_hash, model_name, preset_name,
                sampler, scheduler, steps, cfg, denoise, shift,
                lora_hash, lora_name, lora_strength, reuse_count, created_at
         FROM generations
         WHERE lora_hash IS NULL OR lora_civitai_id IS NOT NULL
         ORDER BY reuse_count DESC`,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map(mapRowToTopSetting);
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapRowToTopSetting(row: Record<string, unknown>): TopSetting {
  return {
    settingsHash: row.settings_hash as string,
    modelFamily: row.model_family as string,
    modelHash: row.model_hash as string,
    modelName: row.model_name as string | null,
    presetName: row.preset_name as string | null,
    sampler: row.sampler as string,
    scheduler: row.scheduler as string,
    steps: row.steps as number,
    cfg: row.cfg as number,
    denoise: row.denoise as number,
    shift: row.shift as number | null,
    loraHash: row.lora_hash as string | null,
    loraName: row.lora_name as string | null,
    loraStrength: row.lora_strength as number | null,
    reuseCount: row.reuse_count as number,
    createdAt: row.created_at as string,
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _tracker: GenerationTracker | null = null;

export function getTracker(): GenerationTracker {
  if (!_tracker) {
    _tracker = new GenerationTracker();
  }
  return _tracker;
}
