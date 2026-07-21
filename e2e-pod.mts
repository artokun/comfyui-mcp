// E2E driver for P4: create a pod, wait RUNNING, report SSH endpoint + id.
// Usage: npx tsx e2e-pod.mts create | status <id> | wait <id> | stop <id> | list
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// config.ts normally loads this; the driver bypasses it.
for (const line of readFileSync(join(homedir(), ".comfyui-mcp", ".env"), "utf-8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import { createPod, getPod, resumePod, stopPod, listPods } from "./src/services/runpod-client.js";
import { podSshEndpoint } from "./src/services/runpod-ssh.js";

const [, , cmd, arg] = process.argv;

function show(pod: unknown) {
  console.log(JSON.stringify(pod, null, 2));
}

if (cmd === "create") {
  console.log("deploying pod (4090 → A5000 → A40, COMMUNITY)…");
  const pod = await createPod({ name: "p4-training-e2e", cloudType: "COMMUNITY" });
  console.log("created:");
  show({ id: pod.id, name: pod.name, status: pod.desiredStatus, cost: pod.costPerHr, gpu: pod.machine?.gpuDisplayName });
} else if (cmd === "status") {
  const pod = await getPod(arg!);
  if (!pod) { console.log("no such pod"); process.exit(1); }
  const ep = podSshEndpoint(pod);
  show({ id: pod.id, status: pod.desiredStatus, hasRuntime: !!pod.runtime, ssh: ep });
} else if (cmd === "wait") {
  const id = arg!;
  for (let i = 0; i < 60; i++) {
    const pod = await getPod(id);
    if (pod?.desiredStatus === "RUNNING" && pod.runtime) {
      const ep = podSshEndpoint(pod);
      console.log("RUNNING:");
      show({ id: pod.id, ssh: ep });
      process.exit(0);
    }
    console.log(`waiting… (${pod?.desiredStatus ?? "?"}, runtime=${!!pod?.runtime})`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log("timed out waiting for RUNNING");
  process.exit(1);
} else if (cmd === "stop") {
  const r = await stopPod(arg!);
  show(r);
} else if (cmd === "list") {
  const pods = await listPods();
  show(pods.map((p) => ({ id: p.id, name: p.name, status: p.desiredStatus, cost: p.costPerHr })));
} else {
  console.log("usage: create | status <id> | wait <id> | stop <id> | list");
  process.exit(1);
}
