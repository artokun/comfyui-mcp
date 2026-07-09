// Full LM Studio model/server lifecycle for the panel orchestrator — the
// LM Studio sibling of ollama-vram.ts, so the provider is hands-off:
//
//   * server AUTO-START  (no "run `lms server start` yourself" step)
//   * unload during ComfyUI renders (single-GPU VRAM handoff, like #154)
//   * unload stale models on model SWITCH (JIT loads the new one on demand)
//   * unload everything when the tab switches to a DIFFERENT provider
//   * warm (JIT-load) the active model so the first post-render chat is fast
//
// Surfaces used: LM Studio's native REST (`/api/v0/models` reports per-model
// `state: "loaded"`) for reads, and the `lms` CLI (the supported programmatic
// control surface; located via backend-readiness.lmstudioCliPath even when
// PATH lacks it) for load/unload/server start.
//
// Everything is BEST-EFFORT: any failure is logged and swallowed — lifecycle
// management must never break a turn or a render.

import { execFile } from "node:child_process";
import { logger } from "../utils/logger.js";
import { lmstudioCliPath } from "../orchestrator/backend-readiness.js";

export const DEFAULT_LMSTUDIO_HOST = "http://127.0.0.1:1234/v1";

/** The REST root (strip a trailing /v1 — /api/v0 hangs off the server root). */
function serverRoot(host: string): string {
  return host.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** True when the host is this machine — we only manage LOCAL VRAM/lifecycle
 *  (never unload models on someone's remote LM Studio box). */
export function isLocalLmstudio(host: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(host);
}

function lms(args: string[], timeoutMs = 20000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const cli = lmstudioCliPath();
    if (!cli) return resolve({ ok: false, out: "lms CLI not found" });
    execFile(cli, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout ?? ""}${stderr ?? ""}`.trim() });
    });
  });
}

/** Is the server answering? (native REST /api/v0/models — also our readiness probe) */
export async function lmstudioServerUp(host: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverRoot(host)}/api/v0/models`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Start LM Studio's local server headlessly via the CLI, then wait for it to
 *  answer (the CLI returns before the port is fully live). Returns true when
 *  the endpoint is reachable afterwards. */
export async function startLmstudioServer(host: string): Promise<boolean> {
  if (await lmstudioServerUp(host)) return true;
  const port = /:(\d+)/.exec(host)?.[1];
  logger.info(`[lmstudio] server not reachable — attempting \`lms server start\`…`);
  const r = await lms(["server", "start", ...(port ? ["--port", port] : [])], 30000);
  if (!r.ok) {
    logger.warn(`[lmstudio] lms server start failed: ${r.out.slice(0, 200)}`);
    return false;
  }
  for (let i = 0; i < 10; i++) {
    if (await lmstudioServerUp(host)) {
      logger.info(`[lmstudio] server started on ${host}`);
      return true;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  logger.warn(`[lmstudio] server start reported ok but ${host} still not answering`);
  return false;
}

interface V0Model {
  id?: string;
  state?: string;
  type?: string;
}

/** Model ids currently LOADED in VRAM (native /api/v0/models state field);
 *  embeddings excluded — unloading those breaks nothing but wastes a call. */
export async function loadedLmstudioModels(host: string): Promise<string[]> {
  try {
    const res = await fetch(`${serverRoot(host)}/api/v0/models`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: V0Model[] };
    return (body.data ?? [])
      .filter((m) => m.state === "loaded" && m.type !== "embeddings")
      .map((m) => m.id ?? "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Unload every loaded LLM (optionally sparing one — used on model switch so
 *  the outgoing model frees its VRAM while the incoming one JIT-loads). */
export async function unloadAllLmstudio(host: string, except?: string): Promise<string[]> {
  if (!isLocalLmstudio(host)) return [];
  const loaded = (await loadedLmstudioModels(host)).filter((m) => m !== except);
  if (loaded.length === 0) return [];
  if (!except) {
    const r = await lms(["unload", "--all"]);
    if (!r.ok) logger.debug(`[lmstudio] unload --all failed: ${r.out.slice(0, 160)}`);
  } else {
    for (const m of loaded) {
      const r = await lms(["unload", m]);
      if (!r.ok) logger.debug(`[lmstudio] unload ${m} failed: ${r.out.slice(0, 160)}`);
    }
  }
  logger.info(`[lmstudio] unloaded ${loaded.length} model(s) to free VRAM: ${loaded.join(", ")}`);
  return loaded;
}

/** Warm a model back into VRAM (a 1-token completion triggers the JIT load) so
 *  the agent answers instantly once a render finishes. */
export async function warmLmstudio(host: string, model: string): Promise<boolean> {
  if (!model || !isLocalLmstudio(host)) return false;
  try {
    const res = await fetch(`${host.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ok" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(120000), // cold JIT load of a big model takes a while
    });
    if (res.ok) {
      logger.info(`[lmstudio] warmed ${model} back into VRAM`);
      return true;
    }
  } catch (err) {
    logger.debug(
      `[lmstudio] warm ${model} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return false;
}
