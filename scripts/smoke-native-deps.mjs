#!/usr/bin/env node
// Run on the exact minimum supported Node release, not the latest Node 22.
// A successful import alone does not load better-sqlite3's native binding.
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import sharp from "sharp";

assert.ok(Number(process.versions.napi) >= 10, "Native SQLite requires Node-API 10");
const db = new Database(":memory:");
try {
  db.exec("CREATE TABLE probe (value TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO probe (value) VALUES (?)");
  db.transaction(() => {
    insert.run("native dependency smoke");
  })();
  assert.deepEqual(db.prepare("SELECT value FROM probe").all(), [
    { value: "native dependency smoke" },
  ]);
} finally {
  db.close();
}

const png = await sharp({
  create: { width: 8, height: 6, channels: 4, background: "red" },
}).png().toBuffer();
const resized = await sharp(png).resize(4, 3).webp().toBuffer();
const metadata = await sharp(resized).metadata();
assert.equal(metadata.format, "webp");
assert.equal(metadata.width, 4);
assert.equal(metadata.height, 3);
console.log(`Native SQLite and sharp smoke passed on Node ${process.version}`);
