import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  symlinkSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";

/** Configure only a fresh/default official ACP profile using installed packages.
 * No package download, custom DSH plugin, credential copy, or Web profile edit.
 */
export function prepareDshAcpProfile(home: string): boolean {
  const directory = join(home, "profiles/acp"),
    file = join(directory, "package.json");
  const before = existsSync(file) ? readFileSync(file) : undefined;
  const profile = before
    ? JSON.parse(before.toString())
    : {
        name: "dsh-profile-acp",
        private: true,
        dependencies: {},
        dsh: {
          profile: {
            bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"],
            patchReload: "startup",
          },
        },
      };
  if (
    Object.keys(profile.dependencies ?? {}).length ||
    JSON.stringify(profile.dsh?.profile?.bundles) !==
      JSON.stringify(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"])
  )
    return false;
  const reference = ["web", "tui"]
    .map((p) => join(home, "profiles", p, "package.json"))
    .find((p) => existsSync(p));
  if (!reference) return false;
  const resolve = createRequire(reference);
  const referencePackage = JSON.parse(readFileSync(reference, "utf8"));
  const names = [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-acp-app",
    "@deepseek-ai/dsh-acp",
  ];
  if (referencePackage.dsh?.profile?.bundles?.includes("dsh-mnemon"))
    names.push("dsh-mnemon");
  const targets = names.map((name) => ({
    name,
    target: dirname(realpathSync(resolve.resolve(name + "/package.json"))),
  }));
  for (const { name, target } of targets) {
    const link = join(directory, "node_modules", name);
    if (existsSync(link) && realpathSync(link) !== target)
      throw new Error(
        "Existing DSH ACP dependencies differ; configure that profile explicitly before connecting",
      );
  }
  const data =
    process.env.COMFYUI_MCP_DATA_DIR || join(homedir(), ".comfyui-mcp");
  const backup = join(
    data,
    "dsh-profile-backups",
    createHash("sha256").update(home).digest("hex").slice(0, 16),
  );
  mkdirSync(backup, { recursive: true });
  if (before && !existsSync(join(backup, "package.before.json")))
    writeFileSync(join(backup, "package.before.json"), before, { mode: 0o600 });
  const created: string[] = [];
  try {
    for (const { name, target } of targets) {
      const link = join(directory, "node_modules", name);
      mkdirSync(dirname(link), { recursive: true });
      if (!existsSync(link)) {
        symlinkSync(
          target,
          link,
          process.platform === "win32" ? "junction" : "dir",
        );
        created.push(link);
      }
      profile.dependencies ??= {};
      profile.dependencies[name] = "link:" + target;
    }
    if (names.includes("dsh-mnemon"))
      profile.dsh.profile.bundles.push("dsh-mnemon");
    const pending = file + "." + randomUUID() + ".tmp";
    writeFileSync(pending, JSON.stringify(profile, null, 2) + "\n");
    renameSync(pending, file);
    return true;
  } catch (error) {
    for (const link of created) unlinkSync(link);
    throw error;
  }
}
