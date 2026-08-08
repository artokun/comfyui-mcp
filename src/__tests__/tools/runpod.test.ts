import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated RunPod surface (0.50.0 slice 8): eleven tools folded into
 * `runpod` (8 actions) + `runpod_watch` (3). Proves the consolidation did not
 * change behaviour — every action calls the identical runpod-client /
 * runpod-watch function the old tool called, with the same arguments and the
 * same content block — and that the flat-enum shape actually EXPOSES its
 * parameters (the discriminated-union trap renders zero params).
 *
 * The extra weight here versus the other slices is deliberate: `create` and
 * `start` SPEND REAL MONEY and `stop` can kill a running render, so a
 * mis-wired action is not a wrong string, it is a bill or a lost job. The
 * "exactly one mutating service per action" table below is the assertion that
 * pins that, in both directions — stop can never reach createPod, and create
 * can never reach stopPod.
 *
 * Mock the RunPod client so the tools are tested in isolation. Pure helpers
 * (port check, URL/link builders, the port constant) keep their real behavior;
 * the network calls are stubbed.
 */
const getPodMock = vi.fn();
const listPodsMock = vi.fn();
const resumePodMock = vi.fn();
const stopPodMock = vi.fn();
const createPodMock = vi.fn();
vi.mock("../../services/runpod-client.js", () => ({
  getPod: (...a: unknown[]) => getPodMock(...a),
  listPods: (...a: unknown[]) => listPodsMock(...a),
  resumePod: (...a: unknown[]) => resumePodMock(...a),
  stopPod: (...a: unknown[]) => stopPodMock(...a),
  createPod: (...a: unknown[]) => createPodMock(...a),
  RUNPOD_COMFYUI_PORT: 3000,
  RUNPOD_DEFAULT_GPU_TYPES: ["NVIDIA GeForce RTX 4090", "NVIDIA RTX A5000", "NVIDIA A40"],
  comfyuiPortExposed: (pod: { runtime?: { ports?: Array<{ privatePort: number; type: string }> } }) =>
    (pod.runtime?.ports ?? []).some((p) => p.privatePort === 3000 && p.type === "http"),
  runpodProxyUrl: (id: string, port = 3000) => `https://${id}-${port}.proxy.runpod.net`,
  runpodDeployLink: () => "https://console.runpod.io/deploy?template=bnqtkvcer3&ref=dkx71w9b",
  GPU_CLI_CREDIT: "Pod control inspired by gpu-cli.sh (https://gpu-cli.sh) — a cloud-GPU CLI worth checking out.",
}));

// runpod tools also import the watcher singleton — stub it with a controllable
// fake so we can assert watch/unwatch and the "was this pod connected?" branch.
const watcherState = { watched: null as string | null };
const watchMock = vi.fn((id: string) => { watcherState.watched = id; });
const unwatchMock = vi.fn(() => { watcherState.watched = null; });
vi.mock("../../services/runpod-watch.js", () => ({
  getRunpodWatcher: () => ({
    watch: (id: string) => watchMock(id),
    unwatch: () => unwatchMock(),
    watchedPodId: () => watcherState.watched,
    clearConnectFailed: () => {},
  }),
}));

const setComfyuiTargetMock = vi.fn(() => true);
// Mutable active-target URL for the stop handler's targetingThisPod check.
let mockBaseUrl = "http://127.0.0.1:8188";
vi.mock("../../config.js", () => ({
  setComfyuiTarget: (...a: unknown[]) => setComfyuiTargetMock(...a),
  getLocalComfyuiUrl: () => "http://127.0.0.1:3000",
  getComfyUIBaseUrl: () => mockBaseUrl,
}));
const resetClientMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({ resetClient: () => resetClientMock() }));

import { registerRunpodTools } from "../../tools/runpod.js";

type Handler = (args: Record<string, any>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

interface Registered {
  name: string;
  shape: z.ZodRawShape;
  handler: Handler;
}

function registered(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    // The SDK's `tool()` is overloaded: the callback is the LAST argument, and an
    // optional annotations object (#1106) sits before it. Resolve by TYPE the way the
    // real SDK does, so adding annotations to a tool cannot break this fake.
    tool: (name: string, _desc: string, shape: z.ZodRawShape, ...rest: unknown[]) => {
      const handler = rest.find((a) => typeof a === "function") as Handler;
      tools.push({ name, shape, handler });
    },
  };
  registerRunpodTools(server as never);
  return tools;
}

/** The pod lifecycle + host switch is now ONE tool (0.50.0 slice 8). */
function runpod(): Handler {
  const tools = registered();
  expect(tools[0].name).toBe("runpod");
  return tools[0].handler;
}

/** The live-status + diagnosis surface is the other. */
function runpodWatch(): Handler {
  const tools = registered();
  expect(tools[1].name).toBe("runpod_watch");
  return tools[1].handler;
}

const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

const runningPod = (over: Record<string, unknown> = {}) => ({
  id: "pod123",
  name: "my-comfy",
  desiredStatus: "RUNNING",
  costPerHr: 0.44,
  machine: { gpuDisplayName: "RTX 4090" },
  runtime: {
    uptimeInSeconds: 3720,
    ports: [{ ip: "1.2.3.4", isIpPublic: true, privatePort: 3000, publicPort: 3000, type: "http" }],
    gpus: [{ id: "g0", gpuUtilPercent: 12, memoryUtilPercent: 30 }],
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  watcherState.watched = null;
  mockBaseUrl = "http://127.0.0.1:8188";
  setComfyuiTargetMock.mockReturnValue(true);
  // default probe: ComfyUI answers
  global.fetch = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch;
});

describe("runpod registration", () => {
  it("registers exactly two tools, `runpod` then `runpod_watch` (11→2)", () => {
    const tools = registered();
    expect(tools.map((t) => t.name)).toEqual(["runpod", "runpod_watch"]);
  });

  // The whole reason for the flat-enum shape rule: a z.discriminatedUnion renders
  // as ZERO parameters, hiding every input from the model.
  it("`runpod` exposes a visible flat `action` enum with every per-action parameter", () => {
    const [{ shape }] = registered();
    // io: "input" — the conversion options the MCP SDK itself uses
    // (sdk/server/zod-json-schema-compat.js, asserted by docs-schema-parity.test.ts),
    // so this is the schema a client is actually given.
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action",
      "cloud_type",
      "connect",
      "deadman",
      "gpu_count",
      "gpu_type",
      "name",
      "pod_id",
    ]);
    expect(json.properties?.action.enum?.sort()).toEqual([
      "connect",
      "create",
      "deploy_link",
      "list",
      "start",
      "status",
      "stop",
      "use_local",
    ]);
    // Only `action` can be required — the rest are per-action, enforced in the handler.
    expect(json.required).toEqual(["action"]);
  });

  it("`runpod_watch` exposes a visible flat `action` enum, `action` the only required field", () => {
    const { shape } = registered()[1];
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual(["action", "pod_id"]);
    expect(json.properties?.action.enum?.sort()).toEqual(["troubleshoot", "unwatch", "watch"]);
    expect(json.required).toEqual(["action"]);
  });

  // The VALUE constraints the old per-tool schemas carried must survive the fold —
  // gpu_count is the one that would silently let a caller ask for 0 or 99 GPUs.
  it("keeps gpu_count's integer 1..8 bound and cloud_type's enum at the zod layer", () => {
    const { shape } = registered()[0];
    expect(() => (shape.gpu_count as z.ZodTypeAny).parse(0)).toThrow();
    expect(() => (shape.gpu_count as z.ZodTypeAny).parse(9)).toThrow();
    expect(() => (shape.gpu_count as z.ZodTypeAny).parse(2.5)).toThrow();
    expect((shape.gpu_count as z.ZodTypeAny).parse(2)).toBe(2);
    expect(() => (shape.cloud_type as z.ZodTypeAny).parse("CHEAP")).toThrow();
    expect((shape.cloud_type as z.ZodTypeAny).parse("SECURE")).toBe("SECURE");
  });

  it("an unknown action returns a clear error result on both tools", async () => {
    const a = await runpod()({ action: "terminate" });
    expect(a.isError).toBe(true);
    expect(text(a)).toMatch(/unknown runpod action/i);
    expect(text(a)).toMatch(/deploy_link/);
    // …and it reached no service at all: an unrecognised action must not fall
    // through into a billable one.
    expect(createPodMock).not.toHaveBeenCalled();
    expect(resumePodMock).not.toHaveBeenCalled();
    expect(stopPodMock).not.toHaveBeenCalled();

    const b = await runpodWatch()({ action: "stop" });
    expect(b.isError).toBe(true);
    expect(text(b)).toMatch(/unknown runpod_watch action/i);
    expect(text(b)).toMatch(/troubleshoot/);
  });
});

/**
 * THE MONEY TABLE.
 *
 * RunPod is real infrastructure on a real card. `create` deploys a billing pod,
 * `start` resumes billing on a stopped one, and `stop` releases the GPU out from
 * under whatever is rendering. Folding eight tools into one `action` string puts
 * all three behind a single dispatch, so the dispatch itself is now the thing
 * that must be pinned: not just "stop calls stopPod" but "stop calls ONLY
 * stopPod", for every action, in both directions.
 */
describe("action dispatch reaches exactly one billing-relevant service", () => {
  const mutating = () => ({
    createPod: createPodMock,
    resumePod: resumePodMock,
    stopPod: stopPodMock,
  });

  /** action → the ONE mutating service it may reach (null = none of them). */
  const expected: Array<[string, Record<string, unknown>, keyof ReturnType<typeof mutating> | null]> = [
    ["create", {}, "createPod"],
    ["start", { pod_id: "pod123" }, "resumePod"],
    ["stop", { pod_id: "pod123" }, "stopPod"],
    ["status", { pod_id: "pod123" }, null],
    ["list", {}, null],
    ["connect", { pod_id: "pod123" }, null],
    ["use_local", {}, null],
    ["deploy_link", {}, null],
  ];

  beforeEach(() => {
    createPodMock.mockResolvedValue({ id: "newpod", name: "comfyui-mcp", costPerHr: null, machine: null, runtime: null });
    resumePodMock.mockResolvedValue({ id: "pod123", desiredStatus: "RUNNING" });
    stopPodMock.mockResolvedValue({ id: "pod123", desiredStatus: "EXITED" });
    getPodMock.mockResolvedValue(runningPod());
    listPodsMock.mockResolvedValue([runningPod()]);
  });

  for (const [action, args, allowed] of expected) {
    it(`action:"${action}" calls ${allowed ?? "no create/start/stop service"} and nothing else that bills`, async () => {
      await runpod()({ action, ...args });
      for (const [name, mock] of Object.entries(mutating())) {
        if (name === allowed) expect(mock, `${action} → ${name}`).toHaveBeenCalledTimes(1);
        else expect(mock, `${action} must NOT reach ${name}`).not.toHaveBeenCalled();
      }
    });
  }

  // None of the watch actions may touch the pod's power state at all — that is
  // the entire reason the family was split across two tools rather than folded
  // into one twelve-action grab-bag.
  for (const [action, args] of [
    ["watch", { pod_id: "pod123" }],
    ["unwatch", {}],
    ["troubleshoot", { pod_id: "pod123" }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`runpod_watch action:"${action}" reaches no create/start/stop service`, async () => {
      getPodMock.mockResolvedValue(runningPod());
      await runpodWatch()({ action, ...args });
      expect(createPodMock).not.toHaveBeenCalled();
      expect(resumePodMock).not.toHaveBeenCalled();
      expect(stopPodMock).not.toHaveBeenCalled();
    });
  }
});

describe("runpod actions call the same services with the same arguments", () => {
  it('action:"status" summarizes a running pod incl. the ComfyUI proxy URL', async () => {
    getPodMock.mockResolvedValue(runningPod());
    const t = text(await runpod()({ action: "status", pod_id: "pod123" }));
    expect(getPodMock).toHaveBeenCalledWith("pod123");
    expect(t).toContain("pod123");
    expect(t).toContain("RUNNING");
    expect(t).toContain("RTX 4090");
    expect(t).toContain("https://pod123-3000.proxy.runpod.net");
    expect(t).toContain("$0.440/hr");
  });

  it('action:"status" omits null GPU telemetry instead of printing null% (nullable leaves, #269 r2)', async () => {
    getPodMock.mockResolvedValue(runningPod({
      runtime: {
        uptimeInSeconds: 60,
        ports: [{ ip: "1.2.3.4", isIpPublic: true, privatePort: 3000, publicPort: 3000, type: "http" }],
        gpus: [{ id: null, gpuUtilPercent: null, memoryUtilPercent: null }],
      },
    }));
    const t = text(await runpod()({ action: "status", pod_id: "pod123" }));
    expect(t).not.toContain("null%");
  });

  it('action:"status" reports cleanly when the pod doesn\'t exist', async () => {
    getPodMock.mockResolvedValue(null);
    const t = text(await runpod()({ action: "status", pod_id: "ghost" }));
    expect(t).toContain("No pod");
    expect(t).toContain('deploy_link');
  });

  it('action:"list" lists pods', async () => {
    listPodsMock.mockResolvedValue([runningPod(), runningPod({ id: "pod999", desiredStatus: "EXITED", name: "idle" })]);
    const t = text(await runpod()({ action: "list" }));
    expect(t).toContain("2 pod(s)");
    expect(t).toContain("pod999");
    expect(t).toContain("EXITED");
  });

  it('action:"list" points to the referral deploy link when there are no pods', async () => {
    listPodsMock.mockResolvedValue([]);
    const t = text(await runpod()({ action: "list" }));
    expect(t).toContain("No pods");
    expect(t).toContain('deploy_link');
  });

  it('action:"start" resumes with the requested gpu_count', async () => {
    resumePodMock.mockResolvedValue({ id: "pod123", desiredStatus: "RUNNING" });
    const t = text(await runpod()({ action: "start", pod_id: "pod123", gpu_count: 2 }));
    expect(resumePodMock).toHaveBeenCalledWith("pod123", 2);
    expect(t).toContain("Started");
    expect(t).toContain("RUNNING");
  });

  it('action:"start" defaults gpu_count to 1', async () => {
    resumePodMock.mockResolvedValue({ id: "pod123", desiredStatus: "RUNNING" });
    await runpod()({ action: "start", pod_id: "pod123" });
    expect(resumePodMock).toHaveBeenCalledWith("pod123", 1);
  });

  it('action:"stop" stops a pod', async () => {
    stopPodMock.mockResolvedValue({ id: "pod123", desiredStatus: "EXITED" });
    const t = text(await runpod()({ action: "stop", pod_id: "pod123" }));
    expect(stopPodMock).toHaveBeenCalledWith("pod123");
    expect(t).toContain("Stopped");
    expect(t).toContain("EXITED");
  });

  it('action:"stop" falls back to local ComfyUI when stopping the CONNECTED pod (the swap)', async () => {
    watcherState.watched = "pod123"; // we were connected to it
    mockBaseUrl = "https://pod123-3000.proxy.runpod.net"; // active target IS the pod
    stopPodMock.mockResolvedValue({ id: "pod123", desiredStatus: "EXITED" });
    const t = text(await runpod()({ action: "stop", pod_id: "pod123" }));
    expect(unwatchMock).toHaveBeenCalled();
    expect(setComfyuiTargetMock).toHaveBeenCalledWith("http://127.0.0.1:3000");
    expect(resetClientMock).toHaveBeenCalled();
    expect(t).toContain("switched back to local");
  });

  it('action:"stop" does NOT retarget when stopping a pod we weren\'t connected to', async () => {
    watcherState.watched = "otherpod";
    mockBaseUrl = "http://127.0.0.1:8188"; // active target is local, not the pod
    stopPodMock.mockResolvedValue({ id: "pod123", desiredStatus: "EXITED" });
    await runpod()({ action: "stop", pod_id: "pod123" });
    expect(setComfyuiTargetMock).not.toHaveBeenCalled();
  });

  it('action:"create" deploys our template and watches the new pod', async () => {
    createPodMock.mockResolvedValue({ id: "newpod", name: "comfyui-mcp", costPerHr: 0.44, machine: { gpuDisplayName: "RTX 4090" }, runtime: null });
    const t = text(await runpod()({ action: "create" }));
    expect(createPodMock).toHaveBeenCalledWith({
      name: undefined,
      gpuTypeIds: undefined,
      cloudType: undefined,
      deadman: undefined,
    });
    expect(watchMock).toHaveBeenCalledWith("newpod");
    expect(t).toContain("newpod");
    expect(t).toContain("RTX 4090");
    expect(t).toContain("$0.440/hr");
    expect(t).toContain('connect');
  });

  it('action:"create" passes a specific gpu_type through as a single-element preference', async () => {
    createPodMock.mockResolvedValue({ id: "p", name: "x", costPerHr: null, machine: null, runtime: null });
    await runpod()({ action: "create", name: "mine", gpu_type: "NVIDIA A40", cloud_type: "SECURE", deadman: false });
    expect(createPodMock).toHaveBeenCalledWith({
      name: "mine",
      gpuTypeIds: ["NVIDIA A40"],
      cloudType: "SECURE",
      deadman: false,
    });
  });

  it('action:"create" surfaces a no-capacity deploy failure', async () => {
    createPodMock.mockRejectedValue(new Error("Could not deploy a pod on any of [RTX 4090]"));
    const res = await runpod()({ action: "create" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Could not deploy");
  });

  it('action:"use_local" retargets to local and unwatches the pod without stopping it', async () => {
    watcherState.watched = "pod123";
    const t = text(await runpod()({ action: "use_local" }));
    expect(unwatchMock).toHaveBeenCalled();
    expect(setComfyuiTargetMock).toHaveBeenCalledWith("http://127.0.0.1:3000");
    expect(resetClientMock).toHaveBeenCalled();
    expect(t).toContain("local ComfyUI");
    expect(t).toContain("still running"); // reminds you the pod bills until stopped
  });

  it('action:"connect" retargets comfyui-mcp when the pod is healthy', async () => {
    getPodMock.mockResolvedValue(runningPod());
    const t = text(await runpod()({ action: "connect", pod_id: "pod123" }));
    expect(setComfyuiTargetMock).toHaveBeenCalledWith("https://pod123-3000.proxy.runpod.net");
    expect(resetClientMock).toHaveBeenCalled();
    expect(watchMock).toHaveBeenCalledWith("pod123");
    expect(t).toContain("Connected");
  });

  it('action:"connect" refuses to connect a stopped pod', async () => {
    getPodMock.mockResolvedValue(runningPod({ desiredStatus: "EXITED", runtime: null }));
    const t = text(await runpod()({ action: "connect", pod_id: "pod123" }));
    expect(t).toContain("not RUNNING");
    expect(setComfyuiTargetMock).not.toHaveBeenCalled();
  });

  it("action:\"connect\" doesn't retarget if ComfyUI isn't answering yet", async () => {
    getPodMock.mockResolvedValue(runningPod());
    global.fetch = vi.fn(async () => ({ ok: false, status: 502 })) as unknown as typeof fetch;
    const t = text(await runpod()({ action: "connect", pod_id: "pod123" }));
    expect(t).toContain("isn't answering");
    expect(setComfyuiTargetMock).not.toHaveBeenCalled();
  });

  it('action:"deploy_link" returns the referral deploy link', async () => {
    const t = text(await runpod()({ action: "deploy_link" }));
    expect(t).toContain("console.runpod.io/deploy?template=bnqtkvcer3&ref=dkx71w9b");
  });
});

describe("runpod_watch actions call the same services with the same arguments", () => {
  it('action:"watch" validates the pod exists, then watches it', async () => {
    getPodMock.mockResolvedValue(runningPod());
    const t = text(await runpodWatch()({ action: "watch", pod_id: "pod123" }));
    expect(getPodMock).toHaveBeenCalledWith("pod123");
    expect(watchMock).toHaveBeenCalledWith("pod123");
    expect(t).toContain("broadcasting live status");
  });

  it('action:"watch" refuses a pod that is not on the account, and does not watch it', async () => {
    getPodMock.mockResolvedValue(null);
    const t = text(await runpodWatch()({ action: "watch", pod_id: "ghost" }));
    expect(t).toContain("No pod");
    expect(watchMock).not.toHaveBeenCalled();
  });

  it('action:"unwatch" clears the watched pod and says it is still running', async () => {
    watcherState.watched = "pod123";
    const t = text(await runpodWatch()({ action: "unwatch" }));
    expect(unwatchMock).toHaveBeenCalled();
    expect(t).toContain("Stopped watching pod");
    expect(t).toContain("still running");
  });

  it('action:"unwatch" with nothing watched says so', async () => {
    const t = text(await runpodWatch()({ action: "unwatch" }));
    expect(t).toContain("No pod was being watched");
  });

  it('action:"troubleshoot" tells you to start a stopped pod', async () => {
    getPodMock.mockResolvedValue(runningPod({ desiredStatus: "EXITED", runtime: null }));
    const t = text(await runpodWatch()({ action: "troubleshoot", pod_id: "pod123" }));
    expect(t).toContain("not RUNNING");
    expect(t).toContain('start');
  });

  it('action:"troubleshoot" flags a still-booting pod (RUNNING, no runtime)', async () => {
    getPodMock.mockResolvedValue(runningPod({ runtime: null }));
    const t = text(await runpodWatch()({ action: "troubleshoot", pod_id: "pod123" }));
    expect(t).toContain("still booting");
  });

  it('action:"troubleshoot" flags an unexposed ComfyUI port', async () => {
    getPodMock.mockResolvedValue(runningPod({ runtime: { uptimeInSeconds: 60, ports: [{ privatePort: 22, type: "tcp" }], gpus: [] } }));
    const t = text(await runpodWatch()({ action: "troubleshoot", pod_id: "pod123" }));
    expect(t).toContain("not exposed");
    // RunPod fronts ComfyUI with nginx on 3000 (ComfyUI itself on 3001 inside) —
    // NOT 8188. Pinned because "fixing" it to 8188 is the tempting wrong move.
    expect(t).toContain("3000");
  });

  it('action:"troubleshoot" flags exposed-but-not-answering ComfyUI', async () => {
    getPodMock.mockResolvedValue(runningPod());
    global.fetch = vi.fn(async () => ({ ok: false, status: 502 })) as unknown as typeof fetch;
    const t = text(await runpodWatch()({ action: "troubleshoot", pod_id: "pod123" }));
    expect(t).toContain("did not answer");
  });

  it('action:"troubleshoot" reports healthy when ComfyUI answers', async () => {
    getPodMock.mockResolvedValue(runningPod());
    const t = text(await runpodWatch()({ action: "troubleshoot", pod_id: "pod123" }));
    expect(t).toContain("healthy");
    expect(t).toContain('connect');
  });
});

describe("per-action presence guards (the flat shape cannot schema-require pod_id)", () => {
  it("pod_id-less start/stop/status/connect name the missing field and call nothing", async () => {
    for (const action of ["start", "stop", "status", "connect"]) {
      const res = await runpod()({ action });
      expect(res.isError, action).toBe(true);
      expect(text(res)).toContain(`runpod action:"${action}" requires \`pod_id\``);
    }
    // Nothing billable — and nothing at all — was reached.
    for (const mock of [createPodMock, resumePodMock, stopPodMock, getPodMock, listPodsMock]) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it("pod_id-less watch/troubleshoot name the missing field and call nothing", async () => {
    for (const action of ["watch", "troubleshoot"]) {
      const res = await runpodWatch()({ action });
      expect(res.isError, action).toBe(true);
      expect(text(res)).toContain(`runpod_watch action:"${action}" requires \`pod_id\``);
    }
    expect(getPodMock).not.toHaveBeenCalled();
    expect(watchMock).not.toHaveBeenCalled();
  });

  // The guard tests ABSENCE, not falsiness: an empty pod_id passed z.string()
  // before this consolidation and reached the service, which answers with its own
  // not-found error. A `!pod_id` guard would swallow that path and substitute
  // generic text for RunPod's own answer.
  it("an explicitly empty pod_id still reaches the service, as before", async () => {
    getPodMock.mockResolvedValue(null);
    await runpod()({ action: "status", pod_id: "" });
    expect(getPodMock).toHaveBeenCalledWith("");

    getPodMock.mockClear();
    await runpodWatch()({ action: "troubleshoot", pod_id: "" });
    expect(getPodMock).toHaveBeenCalledWith("");
  });

  // Same rule one layer down: `gpu_count ?? 1` must stay a nullish coalesce. With
  // `||` a caller's 0 would silently become 1 — the schema's .min(1) is what
  // rejects 0, and the handler must not quietly rewrite it into a valid request.
  it("gpu_count:0 is forwarded, not silently defaulted to 1", async () => {
    resumePodMock.mockResolvedValue({ id: "pod123", desiredStatus: "RUNNING" });
    await runpod()({ action: "start", pod_id: "pod123", gpu_count: 0 });
    expect(resumePodMock).toHaveBeenCalledWith("pod123", 0);
  });
});

describe("the ten retired RunPod names", () => {
  const folded: Array<[string, string]> = [
    ["runpod_pod_create", 'runpod (action:"create")'],
    ["runpod_pod_start", 'runpod (action:"start")'],
    ["runpod_pod_stop", 'runpod (action:"stop")'],
    ["runpod_pod_status", 'runpod (action:"status")'],
    ["runpod_list_pods", 'runpod (action:"list")'],
    ["runpod_pod_connect", 'runpod (action:"connect")'],
    ["runpod_use_local", 'runpod (action:"use_local")'],
    ["runpod_deploy_link", 'runpod (action:"deploy_link")'],
    ["runpod_unwatch", 'runpod_watch (action:"unwatch")'],
    ["runpod_pod_troubleshoot", 'runpod_watch (action:"troubleshoot")'],
  ];

  it("each old name is in DEAD_NAMES with the action that replaced it", () => {
    for (const [name, replacement] of folded) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.50.0");
      expect(entry!.replacement).toBe(replacement);
    }
  });

  it("no old name is still in the live ledger, and both survivors are", () => {
    for (const [name] of folded) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("runpod");
    expect(TOOL_NAMES as readonly string[]).toContain("runpod_watch");
  });

  // runpod_watch SURVIVES the fold, so it must NOT be declared dead — a name in
  // both lists makes call_tool answer a live tool with "removed in 0.50.0".
  it("runpod_watch is not declared dead", () => {
    expect(DEAD_NAMES.find((d) => d.name === "runpod_watch")).toBeUndefined();
  });
});
