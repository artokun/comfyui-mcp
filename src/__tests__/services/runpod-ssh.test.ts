import { describe, expect, it } from "vitest";
import {
  decodePodContainerName,
  encodePodContainerName,
  podJobPaths,
  podSshEndpoint,
  stopSshTraining,
  sshProcessRunning,
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
