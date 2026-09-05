// #2889 — CodexBackend.listModels() hid gpt-6-astra whenever the account
// catalog also contained any gpt-5.6* id. The picker must keep Astra (and
// still hide pre-5.6 ids) and must not clamp liveCatalog, which answers
// "can this account run X".

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelChoice } from "../../orchestrator/agent-backend.js";

vi.mock("../../utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type BackendModule = typeof import("../../orchestrator/codex-backend.js");
type Backend = InstanceType<BackendModule["CodexBackend"]> & {
  liveCatalog: ModelChoice[] | null;
};

let CodexBackend: BackendModule["CodexBackend"];

beforeAll(async () => {
  vi.resetModules();
  ({ CodexBackend } = await import("../../orchestrator/codex-backend.js"));
});

type CatalogRow = {
  id?: string;
  model?: string;
  displayName?: string;
  hidden?: boolean;
  deprecated?: boolean;
  upgrade?: string | { id?: string; model?: string } | null;
  upgradeInfo?: { model?: string } | null;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
};

const MIXED_NO_SIGNAL: CatalogRow[] = [
  { id: "gpt-6-astra", displayName: "GPT-6 Astra", hidden: false },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", hidden: false },
  { id: "gpt-5.6-terra", hidden: false },
  { id: "gpt-5.6-luna", hidden: false },
  { id: "gpt-5.5", hidden: false },
  { id: "gpt-5.4-mini", hidden: false },
  { id: "gpt-5.5-codex", hidden: false },
];

function backendWithList(data: CatalogRow[] | "throw"): Backend {
  const client = {
    request: vi.fn(async (method: string) => {
      if (method !== "model/list") throw new Error(`unexpected request: ${method}`);
      if (data === "throw") throw new Error("model/list unavailable");
      return { data };
    }),
  };
  const backend = new CodexBackend({ model: "gpt-6-astra" }) as Backend;
  Object.assign(backend, { client });
  return backend;
}

describe("CodexBackend.listModels picker (#2889)", () => {
  it("keeps gpt-6-astra beside GPT-5.6 and hides pre-5.6 ids when the catalog has no deprecation signal", async () => {
    const backend = backendWithList(MIXED_NO_SIGNAL);
    const ids = (await backend.listModels()).map((m) => m.id);
    expect(ids).toContain("gpt-6-astra");
    expect(ids).toContain("gpt-5.6-sol");
    expect(ids).toContain("gpt-5.6-terra");
    expect(ids).toContain("gpt-5.6-luna");
    expect(ids).not.toContain("gpt-5.5");
    expect(ids).not.toContain("gpt-5.4-mini");
    expect(ids).not.toContain("gpt-5.5-codex");
  });

  it("keeps the full account catalog on liveCatalog so an Astra pin still clamps", async () => {
    const backend = backendWithList(MIXED_NO_SIGNAL);
    await backend.listModels();
    const live = backend.liveCatalog?.map((m) => m.id) ?? [];
    expect(live).toContain("gpt-6-astra");
    expect(live).toContain("gpt-5.6-sol");
    expect(live).toContain("gpt-5.5");
  });

  it("prefers catalog deprecated/upgrade over the gpt-5.6 prefix so a future current model is not dropped", async () => {
    const backend = backendWithList([
      { id: "gpt-6-astra", hidden: false },
      { id: "gpt-5.6-sol", hidden: false },
      { id: "gpt-7-foo", hidden: false },
      { id: "gpt-5.5", hidden: false, upgrade: "gpt-5.6-sol" },
      { id: "gpt-5.4-mini", hidden: false, deprecated: true },
      { id: "gpt-5.2", hidden: false, upgradeInfo: { model: "gpt-5.6-sol" } },
    ]);
    const ids = (await backend.listModels()).map((m) => m.id);
    expect(ids).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-7-foo"]);
  });

  it("returns the full catalog when the account has no current-family entry (older plan)", async () => {
    const backend = backendWithList([
      { id: "gpt-5.5", hidden: false },
      { id: "gpt-5.4-mini", hidden: false },
    ]);
    const ids = (await backend.listModels()).map((m) => m.id);
    expect(ids).toEqual(["gpt-5.5", "gpt-5.4-mini"]);
  });

  it("still omits hidden rows, including a hidden Astra", async () => {
    const backend = backendWithList([
      { id: "gpt-6-astra", hidden: true },
      { id: "gpt-5.6-sol", hidden: false },
      { id: "gpt-5.5", hidden: false },
    ]);
    const ids = (await backend.listModels()).map((m) => m.id);
    expect(ids).toEqual(["gpt-5.6-sol"]);
  });

  it("falls back to the static family when model/list is unavailable", async () => {
    const backend = backendWithList("throw");
    const ids = (await backend.listModels()).map((m) => m.id);
    expect(ids).toContain("gpt-5.6-sol");
    expect(ids).toContain("gpt-5.5");
    expect(ids).not.toContain("gpt-6-astra");
  });
});
