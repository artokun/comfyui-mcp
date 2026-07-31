import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type {
  BlobClient,
  BlobServiceClient,
} from "@azure/storage-blob";
import { ModelError, ValidationError } from "../../utils/errors.js";
import { requireOptionalDep } from "../../utils/optional-dep.js";
import { redactUrlForLogs } from "../download-auth.js";
import type { StorageUploadResult, StorageUploadSource } from "./types.js";
import { safeErrorDetails, withPrefix } from "./utils.js";

const AZURE_BLOB_HOST_SUFFIX = ".blob.core.windows.net";
const AZURE_ACCOUNT_RE = /^[a-z0-9]{3,24}$/;

type AzureModule = typeof import("@azure/storage-blob");

async function loadAzure(): Promise<AzureModule> {
  return requireOptionalDep<AzureModule>("@azure/storage-blob", {
    feature: "Azure Blob storage uploads/downloads",
    installHint: "npm install @azure/storage-blob",
  });
}

export function isAzureBlobUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && accountFromBlobHost(parsed.hostname) !== undefined;
  } catch {
    return false;
  }
}

function hasQuery(url: string): boolean {
  try {
    return new URL(url).search.length > 1;
  } catch {
    return false;
  }
}

function accountFromBlobHost(hostname: string): string | undefined {
  if (!hostname.endsWith(AZURE_BLOB_HOST_SUFFIX)) return undefined;
  const account = hostname.slice(0, -AZURE_BLOB_HOST_SUFFIX.length);
  return AZURE_ACCOUNT_RE.test(account) ? account : undefined;
}

function accountFromConnectionString(connectionString: string): string | undefined {
  const account = /(?:^|;)AccountName=([^;]+)/i.exec(connectionString)?.[1];
  if (account) return account.toLowerCase();

  const endpoint = /(?:^|;)BlobEndpoint=([^;]+)/i.exec(connectionString)?.[1];
  if (!endpoint) return undefined;
  try {
    return accountFromBlobHost(new URL(endpoint).hostname);
  } catch {
    return undefined;
  }
}

async function blobServiceClientFromEnv(): Promise<
  { account?: string; client: BlobServiceClient } | undefined
> {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (connectionString) {
    const { BlobServiceClient } = await loadAzure();
    return {
      account: accountFromConnectionString(connectionString),
      client: BlobServiceClient.fromConnectionString(connectionString),
    };
  }

  const account = process.env.AZURE_STORAGE_ACCOUNT;
  const key = process.env.AZURE_STORAGE_KEY;
  if (account && key) {
    const { BlobServiceClient, StorageSharedKeyCredential } = await loadAzure();
    const normalizedAccount = account.toLowerCase();
    return {
      account: normalizedAccount,
      client: new BlobServiceClient(
        `https://${normalizedAccount}.blob.core.windows.net`,
        new StorageSharedKeyCredential(normalizedAccount, key),
      ),
    };
  }

  return undefined;
}

function parseAzureBlobUrl(url: string): { account: string; container: string; blob: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError("Invalid Azure Blob URL.");
  }
  const account = accountFromBlobHost(parsed.hostname);
  if (parsed.protocol !== "https:" || !account) {
    throw new ValidationError(
      "Invalid Azure Blob URL. Expected https://<account>.blob.core.windows.net/<container>/<blob>.",
    );
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new ValidationError(
      "Invalid Azure Blob URL. Expected https://<account>.blob.core.windows.net/<container>/<blob>.",
    );
  }
  return { account, container: parts[0], blob: parts.slice(1).join("/") };
}

async function blobClientForDownload(url: string): Promise<BlobClient> {
  const parsed = parseAzureBlobUrl(url);
  const { BlobClient } = await loadAzure();
  if (hasQuery(url)) {
    return new BlobClient(url);
  }

  const envClient = await blobServiceClientFromEnv();
  if (envClient) {
    if (!envClient.account || envClient.account !== parsed.account) {
      throw new ValidationError("Azure Blob URL account must match configured Azure storage account.");
    }
    return envClient.client.getContainerClient(parsed.container).getBlobClient(parsed.blob);
  }
  return new BlobClient(url);
}

async function blobServiceClientForUpload(): Promise<BlobServiceClient> {
  const envClient = await blobServiceClientFromEnv();
  if (!envClient) {
    throw new ValidationError(
      "Azure upload requires AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT plus AZURE_STORAGE_KEY.",
    );
  }
  return envClient.client;
}

export async function downloadAzureBlobToFile(
  url: string,
  targetPath: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    // Thread the abort signal into BOTH the SDK download and the write pipeline so a
    // cancel_download (#515) aborts the Azure transfer; the streamUrlToFile cloud
    // branch also guards before/after so a cancelled transfer is never finalized.
    const response = await (await blobClientForDownload(url)).download(undefined, undefined, {
      abortSignal: signal,
    });
    if (!response.readableStreamBody) {
      throw new ModelError("Azure Blob download response has no body", {
        url: redactUrlForLogs(url),
      });
    }
    await pipeline(response.readableStreamBody, createWriteStream(targetPath), { signal });
    // #343 edge: verify the written size against the blob's authoritative
    // contentLength so an early-ending stream can't be reported as a complete
    // download (silent truncation).
    const expected = typeof response.contentLength === "number" ? response.contentLength : 0;
    if (expected > 0) {
      const actual = (await stat(targetPath)).size;
      if (actual < expected) {
        throw new ModelError(
          `Azure Blob download truncated: wrote ${actual} of ${expected} bytes — the stream ended early. Not complete; retry.`,
          { url: redactUrlForLogs(url) },
        );
      }
    }
  } catch (err) {
    if (err instanceof ModelError || err instanceof ValidationError) throw err;
    throw new ModelError("Azure Blob download failed", {
      url: redactUrlForLogs(url),
      ...safeErrorDetails(err),
    });
  }
}

export async function uploadAzureBlobFile(
  source: StorageUploadSource,
  destination: { container: string; blob_prefix?: string },
): Promise<StorageUploadResult> {
  const blobName = withPrefix(destination.blob_prefix, source.filename);
  try {
    const serviceClient = await blobServiceClientForUpload();
    const blockBlobClient = serviceClient
      .getContainerClient(destination.container)
      .getBlockBlobClient(blobName);
    const options = source.contentType
      ? { blobHTTPHeaders: { blobContentType: source.contentType } }
      : undefined;
    if (source.path) {
      await blockBlobClient.uploadStream(createReadStream(source.path), undefined, undefined, options);
    } else {
      await blockBlobClient.uploadData(source.data ?? Buffer.alloc(0), options);
    }
    return { provider: "azure", url: redactUrlForLogs(blockBlobClient.url) };
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ModelError("Azure Blob upload failed", safeErrorDetails(err));
  }
}
