import { it, expect, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { prepareDshAcpProfile } from "../../orchestrator/dsh-profile.js";
const roots: string[] = [];
function root() {
  const p = mkdtempSync(join(tmpdir(), "dsh-profile-"));
  roots.push(p);
  vi.stubEnv("COMFYUI_MCP_DATA_DIR", join(p, "mcp-data"));
  return p;
}
function put(p: string, v: unknown) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v));
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
it("links existing official components and memory without copying credentials", () => {
  const home = root(),
    web = join(home, "profiles/web");
  put(join(web, "package.json"), {
    dsh: { profile: { bundles: ["dsh-mnemon"] } },
  });
  for (const name of [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-acp-app",
    "@deepseek-ai/dsh-acp",
    "dsh-mnemon",
  ])
    put(join(web, "node_modules", name, "package.json"), {
      name,
      version: "1.0.0",
    });
  put(join(home, ".credentials.yaml"), { private: "fixture-secret" });
  expect(prepareDshAcpProfile(home)).toBe(true);
  const file = join(home, "profiles/acp/package.json"),
    text = readFileSync(file, "utf8");
  expect(JSON.parse(text).dsh.profile.bundles).toContain("dsh-mnemon");
  expect(text).not.toContain("fixture-secret");
  expect(readFileSync(join(home, ".credentials.yaml"), "utf8")).toContain(
    "fixture-secret",
  );
  expect(prepareDshAcpProfile(home)).toBe(false);
});
it("does not overwrite a user-customized ACP profile", () => {
  const home = root(),
    file = join(home, "profiles/acp/package.json");
  const value = {
    dependencies: { custom: "1.0.0" },
    dsh: { profile: { bundles: ["custom"] } },
  };
  put(file, value);
  expect(prepareDshAcpProfile(home)).toBe(false);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(value);
});
it("does not create a profile when no existing reference profile is available", () => {
  const home = root();
  expect(prepareDshAcpProfile(home)).toBe(false);
  expect(existsSync(join(home, "profiles/acp"))).toBe(false);
});
