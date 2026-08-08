#!/usr/bin/env node
/**
 * Print ONE version's section from CHANGELOG.md — the body for that version's
 * GitHub Release.
 *
 * Why this exists: the release workflow used `generate_release_notes: true` and
 * nothing else, which asks GitHub to synthesise "What's Changed" from a previous
 * release IT picks. With releases cut back-to-back (and prereleases interleaved)
 * that base is frequently far older than the previous version, so a release whose
 * changelog entry is a single line shipped ~13,600 characters listing every PR
 * across many versions. The reader cannot tell what actually changed in the thing
 * they just installed, which is the only question a release page has to answer.
 *
 * CHANGELOG.md is already curated per version (Keep a Changelog), so it is the
 * honest source: it says what changed, in our words, for exactly this version.
 *
 * Usage:  node scripts/changelog-section.mjs 0.50.31 [--file CHANGELOG.md]
 * Exits non-zero (and prints nothing to stdout) when the section is absent, so a
 * caller can fall back rather than publish an empty release body.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const fileFlag = args.indexOf("--file");
const file = fileFlag >= 0 ? args[fileFlag + 1] : "CHANGELOG.md";
const raw = args.find((a) => !a.startsWith("--") && a !== file);
if (!raw) {
  console.error("usage: changelog-section.mjs <version> [--file CHANGELOG.md]");
  process.exit(2);
}
// Accept `v0.50.31` and `0.50.31` alike — the workflow has the tag, humans have
// the version, and getting this wrong publishes an empty release body.
const version = raw.replace(/^v/, "");

const md = readFileSync(file, "utf8");
const lines = md.split(/\r?\n/);

// Keep a Changelog heading: `## [0.50.31] - 2026-08-07`. Match the version
// inside brackets exactly, so 0.50.3 never matches 0.50.31's heading.
const isVersionHeading = (line) => /^##\s+\[/.test(line);
const headingVersion = (line) => {
  const m = line.match(/^##\s+\[([^\]]+)\]/);
  return m ? m[1].trim() : null;
};

let start = -1;
for (let i = 0; i < lines.length; i += 1) {
  if (isVersionHeading(lines[i]) && headingVersion(lines[i]) === version) {
    start = i;
    break;
  }
}
if (start === -1) {
  console.error(`changelog-section: no section for ${version} in ${file}`);
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (isVersionHeading(lines[i])) {
    end = i;
    break;
  }
}

// Drop the heading itself — the GitHub Release is already titled with the tag,
// so repeating "## [0.50.31] - date" in the body is noise.
const body = lines
  .slice(start + 1, end)
  .join("\n")
  .replace(/^\s*\n+/, "")
  .replace(/\s+$/, "");

if (!body) {
  console.error(`changelog-section: section for ${version} is empty in ${file}`);
  process.exit(1);
}

process.stdout.write(body + "\n");
