import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// watchRemoteModelLanding (#143): remote (Manager-dispatched) model downloads
// run server-side, so the tray watcher polls /models/<category> — the file is
// listed only once the download COMPLETES — writing indeterminate rows
// meanwhile and a terminal done/error row at the end.

const PROGRESS_DIR = mkdtempSync(join(tmpdir(), "cmcp-tray-"));
process.env.COMFYUI_MCP_PROGRESS_DIR = PROGRESS_DIR;

const fetchMock = vi.fn();
vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: (...args: unknown[]) => fetchMock(...args),
}));

const { watchRemoteModelLanding } = await import("../../services/node-management.js");

function trayRows(): Array<Record<string, unknown>> {
  return readdirSync(PROGRESS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(PROGRESS_DIR, f), "utf8")));
}

function listingResponse(names: string[]): Response {
  return { ok: true, json: async () => names } as unknown as Response;
}

describe("watchRemoteModelLanding", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(PROGRESS_DIR, { recursive: true, force: true });
  });

  it("writes downloading immediately, then done once the file is listed", async () => {
    fetchMock
      .mockResolvedValueOnce(listingResponse([])) // poll 1: not landed yet
      .mockResolvedValueOnce(listingResponse(["big_model.safetensors"])); // poll 2: landed
    watchRemoteModelLanding("diffusion_models", "big_model.safetensors", "https://x/m");

    let rows = trayRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "big_model.safetensors", status: "downloading", total: 0 });

    await vi.advanceTimersByTimeAsync(5_100); // poll 1 → still downloading (heartbeat)
    rows = trayRows();
    expect(rows[0].status).toBe("downloading");

    await vi.advanceTimersByTimeAsync(5_100); // poll 2 → listed → done
    rows = trayRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("done");

    await vi.advanceTimersByTimeAsync(20_000); // watcher stopped — no further fetches
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/models/diffusion_models");
  });

  it("matches files listed under a subfolder path", async () => {
    fetchMock.mockResolvedValue(listingResponse(["sub/dir/big_model.safetensors"]));
    watchRemoteModelLanding("loras", "big_model.safetensors", "https://x/n");
    await vi.advanceTimersByTimeAsync(5_100);
    expect(trayRows()[0].status).toBe("done");
  });

  it("keeps heartbeating through fetch failures instead of erroring", async () => {
    fetchMock.mockRejectedValue(new Error("mid-reboot"));
    watchRemoteModelLanding("vae", "v.safetensors", "https://x/v");
    await vi.advanceTimersByTimeAsync(16_000);
    expect(trayRows()[0].status).toBe("downloading");
  });

  // Fake-advancing 4h steps ~2,880 async poll iterations — wall-clock sits right
  // at vitest's default 5s on a loaded machine, so give it explicit headroom.
  it("writes a terminal error row when the file never lands within the timeout", { timeout: 20_000 }, async () => {
    fetchMock.mockResolvedValue(listingResponse([]));
    watchRemoteModelLanding("checkpoints", "never.safetensors", "https://x/never");
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 + 10_000);
    const rows = trayRows();
    expect(rows[0].status).toBe("error");
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000); // stopped after the terminal row
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
});
