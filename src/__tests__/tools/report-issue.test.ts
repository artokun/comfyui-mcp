import { describe, it, expect, vi, afterEach, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRepo, buildIssueUrl, isOurRepo, submitAndPoll, registerReportIssueTools, REPORT_UA, WORKER_MAX_BODY_LEN } from "../../tools/report-issue.js";

const noSleep = async () => {};

function res(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Capture the registered report_issue handler by faking the McpServer.tool API.
type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
function getReportIssueHandler(): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, h: ToolHandler) => {
      handler = h;
    },
  };
  registerReportIssueTools(fakeServer as any);
  if (!handler) throw new Error("report_issue handler not registered");
  return handler;
}
async function callTool(args: Record<string, unknown>) {
  const out = await getReportIssueHandler()(args);
  const text = out.content[0].text;
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    // error paths return a plain-text message, not JSON
  }
  return { isError: out.isError, text, json };
}

describe("normalizeRepo / buildIssueUrl / isOurRepo", () => {
  it("normalizes assorted repo inputs", () => {
    expect(normalizeRepo(undefined)).toBe("artokun/comfyui-mcp");
    expect(normalizeRepo("https://github.com/foo/bar.git")).toBe("foo/bar");
    expect(normalizeRepo(" owner/name/ ")).toBe("owner/name");
    expect(() => normalizeRepo("nope")).toThrow();
  });

  it("recognizes our repos only, case-insensitively", () => {
    expect(isOurRepo("artokun/comfyui-mcp")).toBe(true);
    expect(isOurRepo("artokun/comfyui-mcp-panel")).toBe(true);
    expect(isOurRepo("Artokun/comfyui-mcp")).toBe(true);
    expect(isOurRepo("ARTOKUN/ComfyUI-MCP-Panel")).toBe(true);
    expect(isOurRepo("artokun/other")).toBe(false);
    expect(isOurRepo("someone/comfyui-mcp")).toBe(false);
  });

  it("builds a prefilled new-issue URL with labels", () => {
    const u = new URL(buildIssueUrl("a/b", "T", "B", ["x", "y"]));
    expect(u.pathname).toBe("/a/b/issues/new");
    expect(u.searchParams.get("title")).toBe("T");
    expect(u.searchParams.get("labels")).toBe("x,y");
  });
});

describe("submitAndPoll — async triage contract", () => {
  it("sends X-Triage-Async + reporter_versions on submit", async () => {
    let sentHeaders: Record<string, string> = {};
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentHeaders = init.headers as Record<string, string>;
      sentBody = JSON.parse(init.body as string);
      return res({ state: "CLOSED", payload: { issue: { number: 1, url: "https://gh/1" }, agent_message: "done" }, url: "https://gh/1", number: 1 });
    }) as unknown as typeof fetch;
    await submitAndPoll({
      workerUrl: "https://w",
      clientKey: "k",
      repoName: "comfyui-mcp",
      title: "t",
      body: "b",
      reporterVersions: { mcp: "0.48.10", panel: "0.11.0" },
      fetchImpl,
      sleep: noSleep,
    });
    expect(sentHeaders["X-Triage-Async"]).toBe("1");
    expect(sentHeaders["X-Client-Key"]).toBe("k");
    expect(sentBody.reporter_versions).toEqual({ mcp: "0.48.10", panel: "0.11.0" });
  });

  it("CLOSED payload → kind:closed with the flattened rich result", async () => {
    const fetchImpl = (async () =>
      res({
        state: "CLOSED",
        payload: {
          classification: "duplicate_closed",
          action_taken: "advised_upgrade",
          issue: { number: 505, url: "https://gh/505", state: "closed" },
          fixed_in_version: "0.48.19",
          fix_pr_url: "https://gh/pull/507",
          recommend_upgrade: true,
          agent_message: "upgrade to 0.48.21",
          possible_duplicate: false,
        },
      })) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep });
    expect(out.kind).toBe("closed");
    if (out.kind !== "closed") throw new Error("expected closed");
    expect(out.result).toMatchObject({
      url: "https://gh/505",
      number: 505,
      classification: "duplicate_closed",
      action_taken: "advised_upgrade",
      fixed_in_version: "0.48.19",
      fix_pr_url: "https://gh/pull/507",
      recommend_upgrade: true,
      agent_message: "upgrade to 0.48.21",
    });
  });

  it("returns the version-ack from submit on every outcome", async () => {
    const fetchImpl = (async () =>
      res({
        job_id: "ja",
        state: "PENDING",
        status: "PENDING",
        versions: { mcp: { reporter: "0.48.10", latest: "0.48.21", up_to_date: false } },
        up_to_date: false,
        upgrade_hint: "comfyui-mcp is behind (0.48.10 → 0.48.21)",
      })) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, maxPolls: 1, pollDelayMs: 0 });
    expect(out.kind).toBe("pending"); // still PENDING at budget
    expect(out.ack.up_to_date).toBe(false);
    expect(out.ack.upgrade_hint).toContain("behind");
  });

  it("legacy SYNC fixture: { ok, url, number } (no lifecycle field) → closed inline, no poll", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return res({ ok: true, url: "https://gh/3", number: 3 });
    }) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep });
    expect(out.kind).toBe("closed");
    if (out.kind !== "closed") throw new Error("expected closed");
    expect(out.result).toMatchObject({ url: "https://gh/3", number: 3 });
    expect(calls).toBe(1); // submit only — never polled
  });

  it("polls /status until CLOSED when the submit is PENDING", async () => {
    const calls: string[] = [];
    let polls = 0;
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url === "https://w") return res({ job_id: "j2", state: "PENDING", status: "PENDING" });
      polls++;
      if (polls < 3) return res({ state: "INVESTIGATING", status: "queued" });
      return res({ state: "CLOSED", payload: { issue: { number: 22, url: "https://gh/22" }, deduped: true, agent_message: "filed" }, url: "https://gh/22", number: 22 });
    }) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, pollDelayMs: 0 });
    expect(out.kind).toBe("closed");
    if (out.kind !== "closed") throw new Error("expected closed");
    expect(out.result).toMatchObject({ url: "https://gh/22", number: 22, deduped: true });
    expect(calls.filter((c) => c.includes("/status/j2")).length).toBe(3);
  });

  it("throws on a non-OK submit so the caller can fall back", async () => {
    const fetchImpl = (async () => res({ error: "unauthorized" }, 401)) as unknown as typeof fetch;
    await expect(
      submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/401/);
  });

  it("a 2xx submit whose body STALLS → pending (worker took it) — does NOT throw/prefill", async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => ({
      ok: true, // 2xx = accepted
      json: () =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    })) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, timeoutMs: 10 });
    expect(out.kind).toBe("pending"); // NOT a throw → the tool won't prefill
  });

  it("a 2xx submit with no job_id and no inline result → pending (accepted, cannot poll, no prefill)", async () => {
    const fetchImpl = (async () => res({ ok: true, versions: {}, up_to_date: true })) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep });
    expect(out.kind).toBe("pending");
  });

  it("CLOSED unfiled_needs_manual (agent_message but NO issue) → unfiled (not a false success)", async () => {
    const fetchImpl = (async () =>
      res({ state: "CLOSED", payload: { action_taken: "unfiled_needs_manual", issue: null, agent_message: "filing failed" } })) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep });
    expect(out.kind).toBe("unfiled"); // agent_message alone must NOT count as filed
  });

  it("a terminal job ERROR without an issue → kind:unfiled (worker gave up, caller prefills)", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "https://w") return res({ job_id: "j3", state: "PENDING", status: "PENDING" });
      return res({ status: "error", error: "GitHub API error" });
    }) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, pollDelayMs: 0 });
    expect(out.kind).toBe("unfiled");
  });

  it("still running at the budget → kind:pending (NOT prefill — worker finishes async)", async () => {
    const fetchImpl = (async (url: string) => {
      if (url === "https://w") return res({ job_id: "j4", state: "PENDING", status: "PENDING" });
      return res({ state: "INVESTIGATING", status: "queued" });
    }) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, pollDelayMs: 0, maxPolls: 3 });
    expect(out.kind).toBe("pending");
    if (out.kind !== "pending") throw new Error("expected pending");
    expect(out.job_id).toBe("j4");
  });

  it("a transient POLL transport error does NOT end the job — keeps polling, then pending", async () => {
    let polls = 0;
    const fetchImpl = (async (url: string) => {
      if (url === "https://w") return res({ job_id: "j5", state: "PENDING", status: "PENDING" });
      polls++;
      return res({ error: "boom" }, 503); // every poll a transport error
    }) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, pollDelayMs: 0, maxPolls: 3 });
    expect(out.kind).toBe("pending"); // transient errors did not throw
    expect(polls).toBe(3); // it kept trying
  });

  it("a network failure BEFORE any 2xx (fetch rejects) → throws so the caller prefills", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("timeout: a POLL whose .json() stalls is transient → keeps polling → pending", async () => {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (url === "https://w") return res({ job_id: "j6", state: "PENDING", status: "PENDING" });
      return {
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      };
    }) as unknown as typeof fetch;
    const out = await submitAndPoll({ workerUrl: "https://w", clientKey: "k", repoName: "comfyui-mcp", title: "t", body: "b", fetchImpl, sleep: noSleep, pollDelayMs: 0, timeoutMs: 10, maxPolls: 2 });
    expect(out.kind).toBe("pending");
  });
});

describe("report_issue tool (registered handler) — ARCHIVED", () => {
  // The project is no longer maintained and its trackers are closed. The tool stays
  // registered so older prompts get an answer, but it must file nothing, contact
  // nothing, and hand out no prefilled link to a tracker that refuses new issues.
  const fetchCalls: unknown[] = [];
  beforeEach(() => {
    fetchCalls.length = 0;
    vi.stubGlobal("fetch", async (...a: unknown[]) => {
      fetchCalls.push(a);
      throw new Error("must not be reached");
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("our repo → archived notice, nothing filed, NO network", async () => {
    const { json } = await callTool({ title: "t", body: "b", repo: "artokun/comfyui-mcp", mcp_version: "0.52.0" });
    expect(json.archived).toBe(true);
    expect(json.filed).toBe(false);
    expect(json.url).toBeUndefined();
    expect(String(json.note)).toMatch(/no longer maintained/);
    expect(String(json.note)).toMatch(/docs\.comfy\.org\/agent-tools/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("third-party repo → the same archived notice, no prefilled URL", async () => {
    const { json } = await callTool({ title: "t", body: "b", repo: "someone/their-node" });
    expect(json.archived).toBe(true);
    expect(json.filed).toBe(false);
    expect(json.repo).toBe("someone/their-node");
    expect(json.url).toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
  });

  it("points at every official surface", async () => {
    const { json } = await callTool({ title: "t", body: "b" });
    const official = json.official as Record<string, string>;
    expect(official.docs).toBe("https://docs.comfy.org/agent-tools");
    expect(official.comfy_mcp).toBe("https://comfy.org/mcp/");
    expect(official.repo).toBe("https://github.com/Comfy-Org/comfy-mcp");
  });
});
