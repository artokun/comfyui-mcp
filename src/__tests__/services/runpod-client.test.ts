import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createPod,
  isProvablyNotCreatedError,
  runpodDeployLink,
  runpodProxyUrl,
  comfyuiPortExposed,
  RUNPOD_DEFAULT_GPU_TYPES,
  type RunpodPod,
} from "../../services/runpod-client.js";

// createPod loops over GPU types until one deploys. Mock fetch to control which
// attempt succeeds; assert the fallback + the referral link / proxy helpers.
let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.RUNPOD_API_KEY;
  process.env.RUNPOD_API_KEY = "rp-test-key";
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.RUNPOD_API_KEY;
  else process.env.RUNPOD_API_KEY = savedKey;
  vi.restoreAllMocks();
});

function gqlResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

type GqlBody = { query: string; variables: Record<string, unknown> };

/** Mock fetch with a per-request handler keyed on the GraphQL body. The handler
 *  may throw to simulate a network failure. Returns counters for assertions. */
function mockGql(handler: (body: GqlBody, callIndex: number) => unknown) {
  const counts = { total: 0, deploys: 0, lists: 0, inits: [] as RequestInit[] };
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse((init as { body: string }).body) as GqlBody;
    const i = counts.total++;
    if (body.query.includes("podFindAndDeployOnDemand")) counts.deploys++;
    if (body.query.includes("myself")) counts.lists++;
    counts.inits.push(init as RequestInit);
    return gqlResponse(handler(body, i));
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { counts, fetchMock };
}

const emptyList = { data: { myself: { pods: [] } } };
const listOf = (pods: unknown[]) => ({ data: { myself: { pods } } });
const deployed = (id: string, gpu = "RTX 4090") => ({
  data: { podFindAndDeployOnDemand: { id, name: "comfyui-mcp", desiredStatus: "RUNNING", costPerHr: 0.44, machine: { gpuDisplayName: gpu } } },
});

describe("runpod-client helpers", () => {
  it("builds the referral deploy link with our template + ref code", () => {
    expect(runpodDeployLink()).toBe("https://console.runpod.io/deploy?template=bnqtkvcer3&ref=dkx71w9b");
  });
  it("builds the pod proxy URL for ComfyUI's port", () => {
    expect(runpodProxyUrl("abc123")).toBe("https://abc123-3000.proxy.runpod.net");
  });
  it("detects an exposed ComfyUI http port", () => {
    const pod = { runtime: { ports: [{ privatePort: 3000, type: "http" }] } } as unknown as RunpodPod;
    expect(comfyuiPortExposed(pod)).toBe(true);
    expect(comfyuiPortExposed({ runtime: { ports: [{ privatePort: 22, type: "tcp" }] } } as unknown as RunpodPod)).toBe(false);
  });
});

describe("runpodGql auth + timeout", () => {
  it("sends the API key as an Authorization: Bearer header, NEVER in the URL", async () => {
    const fetchMock = vi.fn(async () => gqlResponse(emptyList));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { listPods } = await import("../../services/runpod-client.js");
    await listPods();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).not.toContain("api_key");
    expect(String(url)).not.toContain("rp-test-key");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer rp-test-key");
    // Hung-network protection: every request carries an abort signal.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("createPod (GPU fallback + billing safety)", () => {
  it("returns the pod on the FIRST GPU type that has capacity", async () => {
    const { counts } = mockGql((b) => (b.query.includes("myself") ? emptyList : deployed("pod1")));
    const pod = await createPod();
    expect(pod.id).toBe("pod1");
    expect(pod.runtime).toBeNull(); // deploy returns no runtime yet
    expect(counts.deploys).toBe(1); // first GPU succeeded → no fallback
  });

  it("falls through to the NEXT GPU when RunPod explicitly reports no capacity", async () => {
    let deployCall = 0;
    const { counts } = mockGql((b) => {
      if (b.query.includes("myself")) return emptyList;
      deployCall++;
      if (deployCall === 1) return { errors: [{ message: "no instances available" }] };
      return deployed("pod2", "RTX A5000");
    });
    const pod = await createPod();
    expect(pod.id).toBe("pod2");
    expect(counts.deploys).toBe(2);
  });

  it("throws a descriptive error listing every GPU tried when all lack capacity", async () => {
    const { counts } = mockGql((b) =>
      b.query.includes("myself") ? emptyList : { errors: [{ message: "no capacity" }] },
    );
    await expect(createPod({ gpuTypeIds: ["GPU-A", "GPU-B"] })).rejects.toThrow(/GPU-A[\s\S]*GPU-B/);
    // 2 GPU types × 2 cloud types (COMMUNITY then SECURE) = 4 deploy attempts.
    expect(counts.deploys).toBe(4);
  });

  it("pins the cloud type when one is given (no SECURE fallback)", async () => {
    const { counts } = mockGql((b) =>
      b.query.includes("myself") ? emptyList : { errors: [{ message: "no capacity" }] },
    );
    await expect(createPod({ gpuTypeIds: ["GPU-A"], cloudType: "SECURE" })).rejects.toThrow(/SECURE\/GPU-A/);
    expect(counts.deploys).toBe(1);
  });

  it("sends our template id + community cloud + the ComfyUI port in the deploy input", async () => {
    const { fetchMock } = mockGql((b) => (b.query.includes("myself") ? emptyList : deployed("p", "A40")));
    await createPod({ gpuTypeIds: ["NVIDIA A40"] });
    const deployCall = fetchMock.mock.calls
      .map((c) => JSON.parse((c[1] as { body: string }).body))
      .find((b) => b.query.includes("podFindAndDeployOnDemand"));
    expect(deployCall.variables.input.templateId).toBe("bnqtkvcer3");
    expect(deployCall.variables.input.cloudType).toBe("COMMUNITY");
    expect(deployCall.variables.input.gpuTypeId).toBe("NVIDIA A40");
    expect(deployCall.variables.input.ports).toBe("3000/http,22/tcp");
  });

  it("has sane default GPU types (24GB+ cards)", () => {
    expect(RUNPOD_DEFAULT_GPU_TYPES.length).toBeGreaterThan(0);
    expect(RUNPOD_DEFAULT_GPU_TYPES).toContain("NVIDIA GeForce RTX 4090");
  });

  // ── billing safety: a lost create response must NEVER create a second pod ──

  it("an AMBIGUOUS deploy failure where the pod actually EXISTS returns the existing pod (no second create)", async () => {
    // Sequence: list-before → [], deploy → network drop AFTER the pod was
    // created server-side, reconcile-list → the new pod appears.
    let deployAttempts = 0;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init as { body: string }).body) as GqlBody;
      if (body.query.includes("podFindAndDeployOnDemand")) {
        deployAttempts++;
        throw new Error("socket hang up"); // response lost — pod fate unknown
      }
      // list-before is call 1 (empty); reconcile list returns the created pod.
      return gqlResponse(
        deployAttempts === 0 ? emptyList : listOf([{ id: "ghost-pod", name: "comfyui-mcp", desiredStatus: "RUNNING", costPerHr: 0.44, machine: null, runtime: null }]),
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const pod = await createPod({ gpuTypeIds: ["GPU-A", "GPU-B"] });
    expect(pod.id).toBe("ghost-pod"); // reconciled, not re-created
    expect(deployAttempts).toBe(1); // NEVER retried the billed mutation
  });

  it("an AMBIGUOUS deploy failure with NO pod found fails WITHOUT trying more GPU types", async () => {
    let deployAttempts = 0;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init as { body: string }).body) as GqlBody;
      if (body.query.includes("podFindAndDeployOnDemand")) {
        deployAttempts++;
        throw new Error("socket hang up");
      }
      return gqlResponse(emptyList);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(createPod({ gpuTypeIds: ["GPU-A", "GPU-B"] })).rejects.toThrow(/could not be confirmed|NOT retrying/i);
    expect(deployAttempts).toBe(1); // ambiguous → stop; do NOT try GPU-B or SECURE
  });

  it("an AMBIGUOUS failure with MULTIPLE new same-named pods fails closed (concurrent-create race)", async () => {
    // Pod NAME is not unique: a concurrent createPod for the same default name
    // races this one, so >1 new same-named pod may appear. We must NOT guess
    // which is ours (a wrong guess could auto-stop someone else's pod) → throw.
    // list-before must be empty so BOTH pods count as "new"; first call is the snapshot.
    let call = 0;
    global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init as { body: string }).body) as GqlBody;
      if (body.query.includes("podFindAndDeployOnDemand")) throw new Error("socket hang up");
      const i = call++;
      return gqlResponse(
        i === 0
          ? emptyList
          : listOf([
              { id: "pod-a", name: "comfyui-mcp", desiredStatus: "RUNNING", costPerHr: 0.44, machine: null, runtime: null },
              { id: "pod-b", name: "comfyui-mcp", desiredStatus: "RUNNING", costPerHr: 0.44, machine: null, runtime: null },
            ]),
      );
    }) as unknown as typeof fetch;
    await expect(createPod({ gpuTypeIds: ["GPU-A"] })).rejects.toThrow(/concurrent create|2 new pods|can't be determined/i);
  });

  it("reconciliation ignores same-named pods that existed BEFORE the call", async () => {
    // A pre-existing "comfyui-mcp" pod must not be mistaken for the one this
    // call may have created.
    const preExisting = { id: "old-pod", name: "comfyui-mcp", desiredStatus: "EXITED", costPerHr: 0, machine: null, runtime: null };
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init as { body: string }).body) as GqlBody;
      if (body.query.includes("podFindAndDeployOnDemand")) throw new Error("socket hang up");
      return gqlResponse(listOf([preExisting])); // same list before and after
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(createPod({ gpuTypeIds: ["GPU-A"] })).rejects.toThrow(/could not be confirmed|NOT retrying/i);
  });

  it("classifies errors: capacity/quota are provably-not-created; network/HTTP are not", () => {
    expect(isProvablyNotCreatedError(new Error("There are no longer any instances available with the requested specifications."))).toBe(true);
    expect(isProvablyNotCreatedError(new Error("no capacity"))).toBe(true);
    expect(isProvablyNotCreatedError(new Error("quota exceeded"))).toBe(true);
    expect(isProvablyNotCreatedError(new Error("socket hang up"))).toBe(false);
    expect(isProvablyNotCreatedError(new Error("RunPod API HTTP 500"))).toBe(false);
    expect(isProvablyNotCreatedError(new Error("RunPod API request timed out after 10s"))).toBe(false);
    // CONSERVATIVE: an unrelated error that merely contains the words "there are
    // no" (e.g. a vague server message) must NOT be treated as safe-to-retry.
    expect(isProvablyNotCreatedError(new Error("there are no response details available"))).toBe(false);
    expect(isProvablyNotCreatedError(new Error("Internal error: there are no results"))).toBe(false);
    // CONSERVATIVE: "no capacity INFORMATION … status is unknown" is AMBIGUOUS —
    // it must NOT match the capacity-rejection pattern (that would trigger a
    // billed retry of a possibly-landed create).
    expect(
      isProvablyNotCreatedError(
        new Error("RunPod response contained no capacity information, so creation status is unknown."),
      ),
    ).toBe(false);
    expect(isProvablyNotCreatedError(new Error("insufficient capacity details returned"))).toBe(false);
    // Still TRUE for the real rejection phrasings.
    expect(isProvablyNotCreatedError(new Error("no capacity available for this GPU"))).toBe(true);
    expect(isProvablyNotCreatedError(new Error("insufficient capacity"))).toBe(true);
  });
});
