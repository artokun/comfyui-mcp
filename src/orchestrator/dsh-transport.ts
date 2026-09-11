import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type InitializeResponse,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import {
  dshMemoryOverlays,
  rememberDshInstallation,
  type DshInstallation,
} from "./dsh-discovery.js";
import { readFile } from "node:fs/promises";
import { prepareDshAcpProfile } from "./dsh-profile.js";

export function dshRoute(
  model?: string,
): { provider: string; model: string } | undefined {
  if (!model) return;
  let value: unknown;
  try {
    value = JSON.parse(model);
  } catch {
    throw new Error("DSH model must be an advertised provider/model ID");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((x) => typeof x !== "string" || !x.trim())
  )
    throw new Error("DSH model must be an advertised provider/model ID");
  return { provider: value[0], model: value[1] };
}

/** Standard ACP only. No custom DSH plugin, socket, or private protocol fields. */
export class OfficialDshConnection {
  readonly rpc: ClientSideConnection;
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<unknown>;
  info?: InitializeResponse;
  onUpdate?: (event: SessionNotification) => void;
  private closing?: Promise<void>;
  private stopped = false;
  private constructor(
    installation: DshInstallation,
    args: string[],
    private patchDir?: string,
    permission?: (
      request: RequestPermissionRequest,
      signal: AbortSignal,
    ) => Promise<RequestPermissionResponse>,
  ) {
    const env = { ...process.env, DSH_HOME: installation.home };
    for (const key of Object.keys(env))
      if (key.startsWith("DSH_COMFYUI_") || key.startsWith("DSH_BRIDGE_"))
        delete env[key as keyof typeof env];
    this.child = spawn(installation.command, [...installation.args, ...args], {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    // Consume diagnostics so a verbose child cannot block ACP stdout. Do not
    // forward account data, provider bodies, or profile contents to the panel.
    this.child.stderr.resume();
    this.exited = once(this.child, "exit")
      .then(() => {
        this.stopped = true;
      })
      .catch(() => {
        this.stopped = true;
      });
    this.rpc = new ClientSideConnection(
      () => ({
        sessionUpdate: async (event) => {
          this.onUpdate?.(event);
        },
        requestPermission: async (request) =>
          permission
            ? permission(request, this.rpc.signal)
            : { outcome: { outcome: "cancelled" } },
      }),
      ndJsonStream(
        Writable.toWeb(this.child.stdin),
        Readable.toWeb(this.child.stdout),
      ),
    );
  }
  static async open(
    installation: DshInstallation,
    model?: string,
    permission?: (
      request: RequestPermissionRequest,
      signal: AbortSignal,
    ) => Promise<RequestPermissionResponse>,
    signal?: AbortSignal,
    catalogOnly = false,
  ) {
    prepareDshAcpProfile(installation.home);
    const args = ["--profile", "acp"];
    const memoryOverlays = dshMemoryOverlays(installation.home);
    for (const overlay of memoryOverlays) args.push("--patch", overlay);
    let directory: string | undefined;
    const route = dshRoute(model ?? installation.defaultModel);
    {
      directory = await mkdtemp(join(tmpdir(), "comfyui-dsh-"));
      const patch = join(directory, "route.yml");
      // A per-process configuration overlay for the official ACP row. It adds
      // no plugin and is owned/removed by ComfyUI MCP, not installed into DSH.
      const rows: unknown[] = [
        {
          id: "acp",
          inject: ["acpAppStartup", "settings"],
          ...(route ? { config: route } : {}),
        },
      ];
      let hasMemory = memoryOverlays.length > 0;
      try {
        hasMemory ||=
          JSON.parse(
            await readFile(
              join(installation.home, "profiles/acp/package.json"),
              "utf8",
            ),
          ).dsh?.profile?.bundles?.includes("dsh-mnemon") === true;
      } catch {}
      if (catalogOnly && hasMemory)
        rows.push({ id: "mnemon-bundle", disabled: true });
      await writeFile(patch, JSON.stringify(rows), { mode: 0o600 });
      args.push("--patch", patch);
    }
    const client = new OfficialDshConnection(
      installation,
      args,
      directory,
      permission,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      signal?.throwIfAborted();
      client.info = await Promise.race([
        client.rpc.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "comfyui-mcp", version: "0.52.202" },
          clientCapabilities: {},
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("DSH ACP initialization timed out")),
            30000,
          );
        }),
        new Promise<never>((_, reject) => {
          onAbort = () => {
            void client.close();
            reject(new Error("DSH startup cancelled"));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      if (!client.info.agentCapabilities?.sessionCapabilities?.resume)
        throw new Error("Installed DSH does not advertise ACP session resume");
      rememberDshInstallation(installation);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.onUpdate = undefined;
      if (!this.stopped && !this.child.killed) this.child.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!this.stopped && this.child.pid) {
        if (process.platform === "win32")
          spawnSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], {
            windowsHide: true,
          });
        else
          try {
            process.kill(-this.child.pid, "SIGKILL");
          } catch {
            this.child.kill("SIGKILL");
          }
        await this.exited;
      }
      if (this.patchDir) {
        await unlink(join(this.patchDir, "route.yml")).catch(() => {});
        await rmdir(this.patchDir).catch(() => {});
      }
    })());
  }
}
