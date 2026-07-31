import { createHash, randomBytes } from "node:crypto";
import { ValidationError } from "../../utils/errors.js";
import { isAzureBlobUrl, downloadAzureBlobToFile, uploadAzureBlobFile } from "./azure-blob.js";
import { uploadHfFile } from "./hf.js";
import { isHttpUrl, uploadHttpFile } from "./http.js";
import { downloadS3ToFile, isS3Url, uploadS3File } from "./s3.js";
import type {
  CloudStorageAuth,
  StorageUploadResult,
  StorageUploadSource,
} from "./types.js";

export type UploadDestination =
  | { s3: { bucket: string; prefix?: string; async?: boolean } }
  | { azure: { container: string; blob_prefix?: string } }
  | { http: { url: string } }
  | { hf: { repo: string; repo_type?: "model" | "dataset" | "space"; path?: string } };

export function supportsCloudDownload(url: string): boolean {
  return isS3Url(url) || isAzureBlobUrl(url);
}

/**
 * A short, stable discriminator for the EFFECTIVE cloud principal/endpoint that
 * WOULD serve `url` right now — the explicit `auth` MERGED with the same
 * environment fallbacks the real downloaders use (s3.ts makeS3Client,
 * azure-blob.ts blobServiceClientFromEnv). Folded into the download cache identity
 * (#467 P1-B) so a cache entry populated under one principal/endpoint can NEVER be
 * served later under different or absent credentials (cross-principal leak): if the
 * effective principal changes, the cache identity changes → cache miss → re-fetch.
 *
 * Secrets are hashed here and never leave this module in the clear. Empty string
 * for a non-cloud URL (the caller omits it from the identity).
 */
/** Per-process nonce folded into the S3 identity when the principal is AMBIENT
 *  (resolved by the AWS SDK's default chain, not observable here) — so such a cache
 *  entry is never REUSED ACROSS PROCESS RESTARTS under a possibly-different
 *  principal (#467 P1-B). Regenerated each process start. */
const AMBIENT_CLOUD_NONCE = randomBytes(12).toString("hex");

export function cloudPrincipalKey(url: string, auth: CloudStorageAuth = {}): string {
  let raw: string | undefined;
  if (isS3Url(url)) {
    const s3 = auth.s3;
    // makeS3Client sets config.endpoint = auth.endpoint ?? AWS_S3_ENDPOINT; when
    // that's unset the AWS SDK still resolves an endpoint from AWS_ENDPOINT_URL_S3 /
    // AWS_ENDPOINT_URL — fold ALL of them so changing the effective S3 service behind
    // one s3:// URL never reuses the prior endpoint's cache entry (#467 P1-B).
    const endpoint = [
      s3?.endpoint ?? process.env.AWS_S3_ENDPOINT ?? "",
      process.env.AWS_ENDPOINT_URL_S3 ?? "",
      process.env.AWS_ENDPOINT_URL ?? "",
    ].join("|");
    const region = s3?.region ?? process.env.AWS_REGION ?? "";
    const accessKeyId = s3?.access_key_id ?? process.env.AWS_ACCESS_KEY_ID ?? "";
    const secretAccessKey = s3?.secret_access_key ?? process.env.AWS_SECRET_ACCESS_KEY ?? "";
    const sessionToken = s3?.session_token ?? process.env.AWS_SESSION_TOKEN ?? "";
    // When an explicit/env access-key PAIR is present the principal is fully
    // observable → hash it and safely reuse the cache across restarts. Otherwise the
    // SDK resolves an AMBIENT identity (shared profiles, AWS_PROFILE, web-identity/
    // role, ECS/EC2 metadata) that ISN'T observable here — fold the profile-selecting
    // env vars AND a per-process nonce so the entry is never reused across processes
    // under a possibly-different principal. (Within a process the same ambient
    // identity → same nonce → cache hits remain safe. Instance-role rotation
    // mid-process isn't distinguished — accepted, as the SDK caches creds similarly.)
    const explicitPair = Boolean(
      (s3?.access_key_id ?? process.env.AWS_ACCESS_KEY_ID) &&
        (s3?.secret_access_key ?? process.env.AWS_SECRET_ACCESS_KEY),
    );
    const ambient = explicitPair
      ? ""
      : [
          "ambient",
          process.env.AWS_PROFILE ?? "",
          process.env.AWS_ROLE_ARN ?? "",
          process.env.AWS_WEB_IDENTITY_TOKEN_FILE ?? "",
          process.env.AWS_SHARED_CREDENTIALS_FILE ?? "",
          process.env.AWS_CONFIG_FILE ?? "",
          process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ?? "",
          process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ?? "",
          AMBIENT_CLOUD_NONCE,
        ].join("\n");
    raw = `s3\n${endpoint}\n${region}\n${accessKeyId}\n${secretAccessKey}\n${sessionToken}\n${ambient}`;
  } else if (isAzureBlobUrl(url)) {
    // Azure download uses env creds (connection string, else account+key), else
    // anonymous — no hidden ambient chain like AWS, so no nonce needed. The blob host
    // already encodes the account (part of `url`); this is the env credential material.
    const conn = process.env.AZURE_STORAGE_CONNECTION_STRING ?? "";
    const account = process.env.AZURE_STORAGE_ACCOUNT ?? "";
    const key = process.env.AZURE_STORAGE_KEY ?? "";
    raw = `azure\n${conn}\n${account}\n${key}`;
  }
  return raw ? createHash("sha256").update(raw).digest("hex").slice(0, 16) : "";
}

export async function downloadCloudUrlToFile(
  url: string,
  targetPath: string,
  auth: CloudStorageAuth = {},
  signal?: AbortSignal,
): Promise<void> {
  if (isS3Url(url)) {
    await downloadS3ToFile(url, targetPath, auth.s3, signal);
    return;
  }
  if (isAzureBlobUrl(url)) {
    await downloadAzureBlobToFile(url, targetPath, signal);
    return;
  }
  throw new ValidationError(
    "Unsupported cloud storage download URL. Expected s3://bucket/key or an Azure Blob URL.",
  );
}

export async function uploadToStorage(
  source: StorageUploadSource,
  destination: UploadDestination,
  auth: CloudStorageAuth = {},
): Promise<StorageUploadResult> {
  const keys = Object.keys(destination);
  if (keys.length !== 1) {
    throw new ValidationError("Provide exactly one upload destination: s3, azure, http, or hf.");
  }

  if ("s3" in destination) {
    return uploadS3File(source, destination.s3, auth.s3);
  }
  if ("azure" in destination) {
    return uploadAzureBlobFile(source, destination.azure);
  }
  if ("http" in destination) {
    if (!isHttpUrl(destination.http.url)) {
      throw new ValidationError("http.url must start with http:// or https://.");
    }
    return uploadHttpFile(source, destination.http);
  }
  if ("hf" in destination) {
    return uploadHfFile(source, destination.hf);
  }

  throw new ValidationError("Unsupported upload destination. Expected s3, azure, http, or hf.");
}

export type {
  CloudStorageAuth,
  S3Auth,
  StorageUploadResult,
  StorageUploadSource,
} from "./types.js";

