import { createReadStream } from "node:fs";
import { ModelError } from "../../utils/errors.js";
import { redactUrlForLogs } from "../download-auth.js";
import type { StorageUploadResult, StorageUploadSource } from "./types.js";

export function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

function redactedRedirectLocation(location: string, baseUrl: string): string {
  try {
    return redactUrlForLogs(new URL(location, baseUrl).toString());
  } catch {
    return "[INVALID_REDIRECT_LOCATION]";
  }
}

export async function uploadHttpFile(
  source: StorageUploadSource,
  destination: { url: string },
): Promise<StorageUploadResult> {
  const init: RequestInit & { duplex?: "half" } = {
    method: "PUT",
    redirect: "manual",
    headers: source.contentType ? { "Content-Type": source.contentType } : undefined,
    body: source.path ? createReadStream(source.path) : source.data,
  };
  if (source.path) init.duplex = "half";

  const response = await fetch(destination.url, init);
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    throw new ModelError(`HTTP upload redirect rejected: ${response.status} ${response.statusText}`, {
      url: redactUrlForLogs(destination.url),
      status: response.status,
      location: location ? redactedRedirectLocation(location, destination.url) : undefined,
    });
  }
  if (!response.ok) {
    throw new ModelError(`HTTP upload failed: ${response.status} ${response.statusText}`, {
      url: redactUrlForLogs(destination.url),
      status: response.status,
    });
  }
  return { provider: "http", url: redactUrlForLogs(destination.url) };
}
