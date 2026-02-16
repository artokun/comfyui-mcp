import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";

export interface FileHashResult {
  filename: string;
  filePath: string;
  sha256: string;
  autov2: string;
  fileType: string;
  civitaiId: number | null;
  civitaiName: string | null;
  civitaiModelId: number | null;
}

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS file_hashes (
  filename         TEXT    PRIMARY KEY,
  file_path        TEXT    NOT NULL,
  file_size        INTEGER NOT NULL,
  file_mtime       TEXT    NOT NULL,
  sha256           TEXT    NOT NULL,
  autov2           TEXT    NOT NULL,
  file_type        TEXT    NOT NULL,
  civitai_id       INTEGER,
  civitai_name     TEXT,
  civitai_model_id INTEGER,
  checked_at       TEXT
);
`;

export class FileHasher {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(INIT_SQL);
  }

  /**
   * Get or compute the hash for a file. Uses cache if file hasn't changed.
   */
  async getHash(filePath: string, fileType: string): Promise<FileHashResult> {
    const filename = basename(filePath);
    const info = await stat(filePath);
    const fileSize = info.size;
    const fileMtime = info.mtime.toISOString();

    // Check cache
    const cached = this.db
      .prepare(
        `SELECT * FROM file_hashes WHERE filename = ? AND file_size = ? AND file_mtime = ?`,
      )
      .get(filename, fileSize, fileMtime) as Record<string, unknown> | undefined;

    if (cached) {
      return {
        filename,
        filePath,
        sha256: cached.sha256 as string,
        autov2: cached.autov2 as string,
        fileType: cached.file_type as string,
        civitaiId: cached.civitai_id as number | null,
        civitaiName: cached.civitai_name as string | null,
        civitaiModelId: cached.civitai_model_id as number | null,
      };
    }

    // Compute SHA256
    logger.info(`Hashing ${filename} (${(fileSize / 1024 / 1024).toFixed(0)} MB)...`);
    const sha256 = await computeSHA256(filePath);
    const autov2 = sha256.slice(0, 10).toUpperCase();
    logger.info(`Hash complete: ${filename} → ${autov2}`);

    // Upsert into cache
    this.db
      .prepare(
        `INSERT INTO file_hashes (filename, file_path, file_size, file_mtime, sha256, autov2, file_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(filename) DO UPDATE SET
           file_path = excluded.file_path,
           file_size = excluded.file_size,
           file_mtime = excluded.file_mtime,
           sha256 = excluded.sha256,
           autov2 = excluded.autov2,
           file_type = excluded.file_type`,
      )
      .run(filename, filePath, fileSize, fileMtime, sha256, autov2, fileType);

    return {
      filename,
      filePath,
      sha256,
      autov2,
      fileType,
      civitaiId: null,
      civitaiName: null,
      civitaiModelId: null,
    };
  }

  /**
   * Update CivitAI metadata for a cached file hash.
   */
  updateCivitaiInfo(
    filename: string,
    civitaiId: number | null,
    civitaiName: string | null,
    civitaiModelId: number | null,
  ): void {
    this.db
      .prepare(
        `UPDATE file_hashes
         SET civitai_id = ?, civitai_name = ?, civitai_model_id = ?, checked_at = datetime('now')
         WHERE filename = ?`,
      )
      .run(civitaiId, civitaiName, civitaiModelId, filename);
  }

  /**
   * Look up a cached hash by filename (no recomputation).
   */
  getCached(filename: string): FileHashResult | null {
    const row = this.db
      .prepare(`SELECT * FROM file_hashes WHERE filename = ?`)
      .get(filename) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      filename: row.filename as string,
      filePath: row.file_path as string,
      sha256: row.sha256 as string,
      autov2: row.autov2 as string,
      fileType: row.file_type as string,
      civitaiId: row.civitai_id as number | null,
      civitaiName: row.civitai_name as string | null,
      civitaiModelId: row.civitai_model_id as number | null,
    };
  }

  /**
   * Check if a file needs CivitAI lookup (no civitai check recorded).
   */
  needsCivitaiCheck(filename: string): boolean {
    const row = this.db
      .prepare(`SELECT checked_at FROM file_hashes WHERE filename = ?`)
      .get(filename) as { checked_at: string | null } | undefined;
    return !row || row.checked_at === null;
  }
}

/**
 * Stream-based SHA256 for large files. Doesn't load the whole file into memory.
 */
function computeSHA256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
