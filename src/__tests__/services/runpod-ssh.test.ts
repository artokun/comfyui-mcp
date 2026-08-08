import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSshTrainingInvocation,
  decodePodContainerName,
  encodePodContainerName,
  findUnsafeArchiveType,
  podJobPaths,
  podSshEndpoint,
  stopSshTraining,
  sshProcessRunning,
  validateArchiveEntryNames,
  POD_TRAINING_ROOT,
} from "../../services/runpod-ssh.js";
import type { RunpodPod } from "../../services/runpod-client.js";

function podWithPorts(ports: Array<Partial<{ ip: string; isIpPublic: boolean; privatePort: number; publicPort: number; type: string }>>): RunpodPod {
  return {
    id: "pod123",
    name: "test",
    desiredStatus: "RUNNING",
    costPerHr: 0.3,
    machine: { gpuDisplayName: "RTX 4090" },
    runtime: {
      uptimeInSeconds: 60,
      ports: ports.map((p) => ({
        ip: p.ip ?? "",
        isIpPublic: p.isIpPublic ?? true,
        privatePort: p.privatePort ?? 22,
        publicPort: p.publicPort ?? 22222,
        type: p.type ?? "tcp",
      })),
      gpus: null,
    },
  };
}

describe("podSshEndpoint", () => {
  it("resolves privatePort 22/tcp to the public ip:port", () => {
    const ep = podSshEndpoint(podWithPorts([{ ip: "203.0.113.10", privatePort: 22, publicPort: 23456, type: "tcp" }]));
    expect(ep).toEqual({ userHost: "root@203.0.113.10", port: 23456 });
  });

  it("ignores http ports and non-22 tcp", () => {
    expect(podSshEndpoint(podWithPorts([{ ip: "1.2.3.4", privatePort: 8188, type: "http" }]))).toBeNull();
    expect(podSshEndpoint(podWithPorts([{ ip: "1.2.3.4", privatePort: 3000, type: "tcp" }]))).toBeNull();
  });

  it("null without runtime (stopped/booting pod)", () => {
    expect(podSshEndpoint({ ...podWithPorts([]), runtime: null })).toBeNull();
  });
});

describe("pod container-name encoding", () => {
  it("round-trips", () => {
    const name = encodePodContainerName({ userHost: "root@203.0.113.10", port: 23456 });
    expect(name).toBe("pod|root@203.0.113.10|23456");
    expect(decodePodContainerName(name)).toEqual({ userHost: "root@203.0.113.10", port: 23456 });
  });

  it("rejects non-pod names", () => {
    expect(decodePodContainerName("comfyui-train-t123")).toBeNull();
    expect(decodePodContainerName("pod|noport")).toBeNull();
    expect(decodePodContainerName("pod|host|abc")).toBeNull();
  });
});

describe("podJobPaths", () => {
  it("lays out the job under the persistent volume", () => {
    const p = podJobPaths("t123", "my_lora");
    expect(p.jobDir).toBe(`${POD_TRAINING_ROOT}/jobs/t123`);
    expect(p.configPath).toBe(`${POD_TRAINING_ROOT}/jobs/t123/config.yml`);
    expect(p.datasetDir).toBe(`${POD_TRAINING_ROOT}/datasets/my_lora`);
    expect(p.outputDir).toBe(`${POD_TRAINING_ROOT}/jobs/t123/output`);
    expect(p.hfCacheDir).toBe(`${POD_TRAINING_ROOT}/hf-cache`);
    expect(p.lorasDir).toBe("/workspace/models/loras");
  });
});

describe("stop/probe on non-pod names", () => {
  it("stopSshTraining rejects a non-pod name honestly", async () => {
    const r = await stopSshTraining("comfyui-train-t123");
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("not_pod");
  });

  it("sshProcessRunning returns null for non-pod names", async () => {
    expect(await sshProcessRunning("comfyui-train-t123")).toBeNull();
  });
});

describe("HF token never touches argv (#263 security)", () => {
  const EP = { userHost: "root@203.0.113.10", port: 23456 };

  it("the token travels via stdin — absent from args AND the remote command", () => {
    const token = "hf_SECRET_token_ABC123xyz";
    const inv = buildSshTrainingInvocation({
      ep: EP,
      remoteConfigPath: "/workspace/training/jobs/t1/config.yml",
      hfCacheDir: "/workspace/training/hf-cache",
      hfToken: token,
    });
    expect(inv.args.join(" ")).not.toContain(token);
    expect(inv.remote).not.toContain(token);
    expect(inv.args.join(" ")).not.toContain("HF_TOKEN=");
    // The remote shell reads it from stdin into the env instead.
    expect(inv.remote).toContain("IFS= read -r HF_TOKEN; export HF_TOKEN;");
    expect(inv.stdinPayload).toBe(`${token}\n`);
  });

  it("no token → no stdin payload and no read prefix", () => {
    const inv = buildSshTrainingInvocation({ ep: EP, remoteConfigPath: "/workspace/training/jobs/t1/config.yml" });
    expect(inv.stdinPayload).toBeNull();
    expect(inv.remote).not.toContain("read -r HF_TOKEN");
    expect(inv.remote).toContain("./venv/bin/python run.py /workspace/training/jobs/t1/config.yml");
  });

  it("newlines are stripped from the token (can't smuggle extra stdin lines)", () => {
    const inv = buildSshTrainingInvocation({
      ep: EP,
      remoteConfigPath: "/workspace/training/jobs/t1/config.yml",
      hfToken: "hf_abc\nrm -rf /\n",
    });
    expect(inv.stdinPayload).toBe("hf_abcrm -rf /\n");
  });
});

describe("pod archive validation (#263 correctness)", () => {
  it("rejects symlink and hardlink entries from a -tv listing", () => {
    const clean = [
      "-rw-r--r--  0 root root 172000000 Jul 20 12:00 ./pod_lora.safetensors",
      "drwxr-xr-x  0 root root         0 Jul 20 12:00 ./samples/",
      "-rw-r--r--  0 root root      4096 Jul 20 12:00 ./samples/s1.png",
    ].join("\n");
    expect(findUnsafeArchiveType(clean)).toBeNull();
    expect(
      findUnsafeArchiveType("lrwxrwxrwx  0 root root 0 Jul 20 12:00 ./pod_lora.safetensors -> /etc/passwd"),
    ).toMatch(/unsafe archive entry \(type 'l'\)/);
    expect(
      findUnsafeArchiveType("hrw-r--r--  0 root root 0 Jul 20 12:00 ./evil link to ../../seed"),
    ).toMatch(/unsafe archive entry \(type 'h'\)/);
  });

  it("rejects traversal, absolute, drive-letter, and backslash entry names", () => {
    expect(validateArchiveEntryNames(["./pod_lora.safetensors", "samples/s1.png", "./samples/"])).toBeNull();
    expect(validateArchiveEntryNames(["../../../root/.ssh/authorized_keys"])).toMatch(/path traversal/);
    expect(validateArchiveEntryNames(["./ok.png", "./nested/../../evil"])).toMatch(/path traversal/);
    expect(validateArchiveEntryNames(["/etc/passwd"])).toMatch(/absolute path/);
    expect(validateArchiveEntryNames(["C:/Windows/win.ini"])).toMatch(/absolute path/);
    expect(validateArchiveEntryNames(["a\\..\\b"])).toMatch(/backslash/);
  });
});

describe("#796 a hash that could not be COMPUTED is not a hash that DIFFERED", () => {
  // Both fail closed, which is right — but they send the reader to different
  // places. "sha256 mismatch" on a multi-GB pod transfer means re-pull it, and
  // doing that over an unreadable file or an OOM is expensive and useless. The
  // old code caught the hash failure into "" and compared that, so every failure
  // to CHECK was reported as a proven mismatch.
  const SRC = readFileSync(join(__dirname, "..", "..", "services", "runpod-ssh.ts"), "utf8");

  it("no longer collapses a hashing failure into an empty string", () => {
    expect(SRC).not.toMatch(/const got = await sha256File\(p\)\.catch\(\(\) => ""\)/);
  });

  it("reports the failure to check, and says the file may be fine", () => {
    expect(SRC).toMatch(/could NOT hash \$\{rel\}/);
    // Asserted as two phrases, each within ONE string literal: the sentence is
    // spelled across a `+` in the source, so a single regex over the raw file
    // tests the line breaks rather than the message.
    expect(SRC).toMatch(/The file may be fine/);
    expect(SRC).toMatch(/not a proven mismatch/);
    // The underlying reason is carried, so the reader can act on it.
    expect(SRC).toMatch(/hashError \?\? "no reason reported"/);
  });

  it("still refuses — nothing is promoted on an unverified file", () => {
    const i = SRC.indexOf("could NOT hash");
    const before = SRC.slice(Math.max(0, i - 400), i);
    expect(before).toMatch(/return failCleanup\(/);
    // …and a genuine mismatch keeps its own distinct message.
    expect(SRC).toMatch(/verification failed: sha256 mismatch on \$\{rel\}/);
  });
});
