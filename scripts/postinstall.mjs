#!/usr/bin/env node

/**
 * Post-install script for comfyui-mcp.
 *
 * Copies model-settings.user.jsonc from the example template if the user
 * doesn't already have one — same pattern as .env.example → .env.
 */

import { existsSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const example = resolve(root, "model-settings.user.jsonc.example");
const target = resolve(root, "model-settings.user.jsonc");

if (!existsSync(target)) {
  if (existsSync(example)) {
    copyFileSync(example, target);
    console.log(
      "✔ Created model-settings.user.jsonc from example template. Edit it to add your personal presets."
    );
  }
} else {
  // User file already exists — don't touch it
}
