import { z } from "zod";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve, join } from "path";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

// Resolve .env from the package root, not process.cwd()
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, "..");
dotenv.config({ path: resolve(packageRoot, ".env") });

/**
 * Auto-detect ComfyUI installation directories.
 * Checks common locations on macOS, Linux, and Windows.
 * Returns all found paths sorted by preference.
 */
function detectComfyUIPaths(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  // macOS: ComfyUI Desktop app stores data here
  candidates.push(join(home, "Documents", "ComfyUI"));

  // macOS: Application Support
  candidates.push(join(home, "Library", "Application Support", "ComfyUI"));

  // Common manual install locations
  candidates.push(join(home, "ComfyUI"));
  candidates.push(join(home, "code", "ComfyUI"));
  candidates.push(join(home, "projects", "ComfyUI"));
  candidates.push(join(home, "src", "ComfyUI"));

  // Linux common paths
  candidates.push("/opt/ComfyUI");
  candidates.push(join(home, ".local", "share", "ComfyUI"));

  // Windows common paths
  candidates.push(join(home, "AppData", "Local", "ComfyUI"));
  candidates.push(join(home, "Desktop", "ComfyUI"));

  // Windows: ComfyUI Desktop app installs here
  candidates.push(
    join(home, "AppData", "Local", "Programs", "ComfyUI", "resources", "ComfyUI"),
  );

  // Scan ~/Documents and ~/My Documents for any ComfyUI-named directories
  const documentsDirs = [
    join(home, "Documents"),
    join(home, "My Documents"),
  ];
  for (const dir of documentsDirs) {
    try {
      if (!existsSync(dir)) continue;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.toLowerCase().includes("comfyui")) {
          const fullPath = join(dir, entry.name);
          if (!candidates.includes(fullPath)) {
            candidates.push(fullPath);
          }
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  // Filter to paths that exist and look like actual ComfyUI installations
  // (must have a models/ or custom_nodes/ subdirectory, or be a known install path)
  return candidates.filter((p) => {
    if (!existsSync(p)) return false;
    // Known install paths are trusted without marker check
    if (!p.includes("Documents")) return true;
    // For scanned directories, verify it's a real ComfyUI install
    return existsSync(join(p, "models")) || existsSync(join(p, "custom_nodes"));
  });
}

/**
 * Resolve the ComfyUI path, with auto-detection fallback.
 * Priority: COMFYUI_PATH env var > auto-detected paths.
 * Logs a warning if multiple installations found.
 */
function resolveComfyUIPath(envPath?: string): string | undefined {
  if (envPath) return envPath;

  const detected = detectComfyUIPaths();
  if (detected.length === 0) return undefined;

  if (detected.length > 1) {
    console.error(
      `[comfyui-mcp] Multiple ComfyUI installations detected:\n` +
        detected.map((p, i) => `  ${i + 1}. ${p}`).join("\n") +
        `\nUsing: ${detected[0]}\n` +
        `Set COMFYUI_PATH to override.`,
    );
  }

  return detected[0];
}

/**
 * Auto-detect which port ComfyUI is running on.
 * Tries common ports: 8000 (Desktop app default), 8188 (repo/CLI default).
 * Returns the first port that responds, or the default if none found.
 */
async function detectComfyUIPort(host: string): Promise<number> {
  const ports = [8188, 8000];

  for (const port of ports) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(`http://${host}:${port}/system_stats`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        console.error(`[comfyui-mcp] Found ComfyUI on port ${port}`);
        return port;
      }
    } catch {
      // Port not responding, try next
    }
  }

  console.error(
    `[comfyui-mcp] ComfyUI not detected on ports ${ports.join(", ")}. Defaulting to 8188.`,
  );
  return 8188;
}

const configSchema = z.object({
  comfyuiHost: z.string().default("127.0.0.1"),
  comfyuiPort: z.coerce.number().int().positive().optional(),
  comfyuiPath: z.string().optional(),
  huggingfaceToken: z.string().optional(),
  githubToken: z.string().optional(),
  civitaiApiToken: z.string().optional(),
});

export type Config = z.infer<typeof configSchema> & { resolvedPort: number };

const parsedConfig = configSchema.parse({
  comfyuiHost: process.env.COMFYUI_HOST,
  comfyuiPort: process.env.COMFYUI_PORT || undefined,
  comfyuiPath: resolveComfyUIPath(process.env.COMFYUI_PATH),
  huggingfaceToken: process.env.HUGGINGFACE_TOKEN,
  githubToken: process.env.GITHUB_TOKEN,
  civitaiApiToken: process.env.CIVITAI_API_TOKEN,
});

// Resolve port: explicit env var wins, otherwise auto-detect
const resolvedPort = parsedConfig.comfyuiPort
  ?? await detectComfyUIPort(parsedConfig.comfyuiHost);

export const config: Config = { ...parsedConfig, resolvedPort };

export function getComfyUIApiHost(): string {
  return `${config.comfyuiHost}:${config.resolvedPort}`;
}
