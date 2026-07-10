#!/usr/bin/env node
// npm-publish-style release of the RunPod template image to Docker Hub.
//
//   npm run runpod:release              # minor bump:  1.6 -> 1.7
//   npm run runpod:release -- major     # major bump:  1.6 -> 2.0
//   npm run runpod:release -- 2.3       # explicit tag
//
// Like `npm publish`, nothing reaches the registry unverified. The flow:
//
//   1. VERSION  — resolve the next tag from what Docker Hub actually serves
//                 (two-part MAJOR.MINOR scheme; hub is the source of truth,
//                 not local docker tags).
//   2. BUILD    — fat image (extras + spotcheck). The extras donor defaults to
//                 the PREVIOUS release (it carries the same three artifacts),
//                 so no 63 GB aitrepreneur pull; the panel clone layer is
//                 cache-busted to the panel repo's current main SHA. The build
//                 itself ends in the Dockerfile §9.5 integrity gate.
//   3. GATE     — docker/runpod/deploy-dockerhub.sh runs test_image.sh (static
//                 + boot suite: fresh volume, redeploy persistence, ENOSPC
//                 self-heal). Any failure aborts before anything is pushed.
//   4. PUBLISH  — push :<version> + :latest, then verify_image_remote.py
//                 checks what the registry ACTUALLY serves.
//   5. TEMPLATE — pin the RunPod template to the new VERSION tag via the
//                 GraphQL API (RUNPOD_API_KEY env or .env). NOT runpodctl:
//                 its `template update` sends a registry-credentials field
//                 that RunPod rejects for PUBLIC templates ("public templates
//                 cannot have Registry Credentials", verified 2026-07 on
//                 runpodctl 2.6.1). Pods must pull by version tag: RunPod
//                 hosts cache per-tag, so a template left on :latest can
//                 silently serve a stale build.
//
// Env knobs: RUNPOD_DONOR (extras donor image; set to aitrepreneur/comfyui:2.3.5
// for a from-scratch bootstrap), RUNPOD_TEMPLATE_ID (default bnqtkvcer3),
// RUNPOD_API_KEY (or .env), SKIP_TEMPLATE=1 to stop after publishing.
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = "artokun/comfyui-mcp-runpod";
const TEMPLATE_ID = process.env.RUNPOD_TEMPLATE_ID || "bnqtkvcer3";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CTX = join(ROOT, "docker", "runpod");
const DONOR = process.env.RUNPOD_DONOR || `${REPO}:latest`;

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
const capture = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();

// ---- 1. VERSION -------------------------------------------------------------
const arg = process.argv[2] || "minor";
if (!/^\d+\.\d+$/.test(arg) && !["major", "minor", "patch"].includes(arg)) {
  console.error(`usage: npm run runpod:release [-- major|minor|<X.Y>] (got "${arg}")`);
  process.exit(1);
}

const hubTags = await (async () => {
  const res = await fetch(
    `https://hub.docker.com/v2/repositories/${REPO}/tags?page_size=100`,
  );
  if (!res.ok) throw new Error(`Docker Hub tag list failed: ${res.status}`);
  return (await res.json()).results.map((t) => t.name);
})();
const versions = hubTags
  .map((t) => /^(\d+)\.(\d+)$/.exec(t))
  .filter(Boolean)
  .map((m) => [Number(m[1]), Number(m[2])])
  .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const cur = versions.at(-1) ?? [1, 0];

let tag;
if (/^\d+\.\d+$/.test(arg)) {
  if (hubTags.includes(arg)) {
    console.error(`refusing: ${REPO}:${arg} already exists on Docker Hub`);
    process.exit(1);
  }
  tag = arg;
} else if (arg === "major") {
  tag = `${cur[0] + 1}.0`;
} else {
  tag = `${cur[0]}.${cur[1] + 1}`; // minor (and patch alias — two-part scheme)
}
console.log(`current hub release: ${cur.join(".")}  ->  releasing: ${tag}`);

// current panel main SHA (cache-busts the panel clone layer; no local clone needed)
const panelSha = capture(
  "git ls-remote https://github.com/artokun/comfyui-mcp-panel.git refs/heads/main",
).split(/\s+/)[0];
if (!/^[0-9a-f]{40}$/.test(panelSha)) {
  console.error("could not resolve panel main SHA");
  process.exit(1);
}

// ---- 2. BUILD (fat: extras + spotcheck; donor = previous release) -----------
console.log(`building ${REPO}:build — panel @ ${panelSha.slice(0, 8)}, extras donor: ${DONOR}`);
run("docker", [
  "build",
  "--build-arg", `PANEL_CACHEBUST=${panelSha}`,
  "--build-arg", `RUNPOD_SRC_IMAGE=${DONOR}`,
  "--build-arg", "INCLUDE_RUNPOD_EXTRAS=1",
  "--build-arg", "BAKE_SPOTCHECK_MODEL=1",
  "-t", `${REPO}:build`,
  CTX,
]);

// ---- 3+4. GATE, PUBLISH, VERIFY (deploy-dockerhub.sh refuses unverified pushes)
run("bash", [join(CTX, "deploy-dockerhub.sh"), tag, `${REPO}:build`]);

// ---- 5. TEMPLATE — pin the RunPod template to the immutable version tag -----
if (process.env.SKIP_TEMPLATE === "1") {
  console.log(`SKIP_TEMPLATE=1 — remember to point the template at ${REPO}:${tag}`);
  process.exit(0);
}
const image = `${REPO}:${tag}`;
// saveTemplate needs the full field set, so fetch-and-echo everything except
// imageName. (runpodctl deliberately not used here — see the header note.)
let key = process.env.RUNPOD_API_KEY;
// .env is untracked and lives only in the PRIMARY checkout — when this script
// runs from a .claude/worktrees/* worktree, ROOT/.env doesn't exist and the
// template pin used to silently downgrade to "update manually" (issue #145).
// Probe ROOT first, then the primary checkout via the shared git common dir.
if (!key) {
  const envCandidates = [join(ROOT, ".env")];
  try {
    const commonDir = capture("git rev-parse --git-common-dir"); // <primary>/.git (absolute in worktrees)
    const primary = join(commonDir, "..");
    if (primary !== ROOT) envCandidates.push(join(primary, ".env"));
  } catch {
    // not a git checkout (tarball run) — ROOT/.env stays the only candidate
  }
  for (const p of envCandidates) {
    if (!existsSync(p)) continue;
    key = /^RUNPOD_API_KEY=(.+)$/m.exec(readFileSync(p, "utf8"))?.[1]?.trim();
    if (key) break;
  }
}
if (!key) {
  console.error(`released ${image}, but RUNPOD_API_KEY is not set — update the template manually:`);
  console.error(`  console.runpod.io -> Templates -> ${TEMPLATE_ID} -> Container Image -> ${image}`);
  process.exit(1);
}
const gql = async (query, variables) => {
  const res = await fetch(`https://api.runpod.io/graphql?api_key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
};
const { podTemplates } = await gql(
  "query { podTemplates { id name imageName containerDiskInGb volumeInGb volumeMountPath ports dockerArgs env { key value } readme } }",
);
const t = podTemplates.find((x) => x.id === TEMPLATE_ID);
if (!t) throw new Error(`template ${TEMPLATE_ID} not found on this account`);
await gql(
  "mutation Save($input: SaveTemplateInput!) { saveTemplate(input: $input) { id imageName } }",
  { input: { ...t, imageName: image } },
);
console.log(`template ${TEMPLATE_ID} -> ${image} (via GraphQL)`);

console.log(`\nreleased ${image} (+ :latest), registry-verified, template pinned.`);
console.log("New pods pull the pinned version tag — stale host caches of :latest can no longer bite.");
