import { Client } from "@stable-canvas/comfyui-client";
import { config, getComfyUIApiHost } from "../config.js";
import { logger } from "../utils/logger.js";
import { ConnectionError } from "../utils/errors.js";
import type { ObjectInfo, SystemStats, QueueStatus } from "./types.js";

let clientInstance: Client | null = null;

export function getClient(): Client {
  if (!clientInstance) {
    clientInstance = new Client({
      api_host: getComfyUIApiHost(),
      // Node 22+ provides global WebSocket
    });
    logger.info("ComfyUI client created", {
      host: getComfyUIApiHost(),
    });
  }
  return clientInstance;
}

export async function connectClient(): Promise<Client> {
  const client = getClient();
  try {
    await client.connect();
    logger.info("Connected to ComfyUI via WebSocket");
    return client;
  } catch (err) {
    throw new ConnectionError(
      `Failed to connect to ComfyUI at ${getComfyUIApiHost()}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export async function getSystemStats(): Promise<SystemStats> {
  const client = getClient();
  const stats = await client.getSystemStats();
  return stats as unknown as SystemStats;
}

export async function getObjectInfo(): Promise<ObjectInfo> {
  const client = getClient();
  const info = await client.getNodeDefs();
  return info as unknown as ObjectInfo;
}

export async function getQueue(): Promise<QueueStatus> {
  const client = getClient();
  const queue = await client.getQueue();
  return queue as unknown as QueueStatus;
}

export async function interrupt(): Promise<void> {
  const client = getClient();
  await client.interrupt();
}

export async function getSamplers(): Promise<string[]> {
  const client = getClient();
  return client.getSamplers();
}

export async function getSchedulers(): Promise<string[]> {
  const client = getClient();
  return client.getSchedulers();
}

export async function getCheckpoints(): Promise<string[]> {
  const client = getClient();
  return client.getSDModels();
}

export async function getLoRAs(): Promise<string[]> {
  const client = getClient();
  return client.getLoRAs();
}

export async function getVAEs(): Promise<string[]> {
  const client = getClient();
  return client.getVAEs();
}

export async function getUpscaleModels(): Promise<string[]> {
  const client = getClient();
  return client.getUpscaleModels();
}

export function getComfyUIPath(): string | undefined {
  return config.comfyuiPath;
}
