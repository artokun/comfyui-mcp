import { createReadStream } from "node:fs";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type {
  S3Client,
  S3ClientConfig,
} from "@aws-sdk/client-s3";
import { ModelError, ValidationError } from "../../utils/errors.js";
import { requireOptionalDep } from "../../utils/optional-dep.js";
import { redactUrlForLogs } from "../download-auth.js";
import type { S3Auth, StorageUploadResult, StorageUploadSource } from "./types.js";
import { bodyToReadable, safeErrorDetails, withPrefix } from "./utils.js";

type AwsModule = typeof import("@aws-sdk/client-s3");

async function loadAwsS3(): Promise<AwsModule> {
  return requireOptionalDep<AwsModule>("@aws-sdk/client-s3", {
    feature: "S3 uploads/downloads",
    installHint: "npm install @aws-sdk/client-s3",
  });
}

export function isS3Url(url: string): boolean {
  return url.startsWith("s3://");
}

export function parseS3Url(url: string): { bucket: string; key: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError("Invalid S3 URL. Expected s3://bucket/key.");
  }
  if (parsed.protocol !== "s3:" || !parsed.hostname || parsed.pathname.length <= 1) {
    throw new ValidationError("Invalid S3 URL. Expected s3://bucket/key.");
  }
  return { bucket: parsed.hostname, key: decodeURIComponent(parsed.pathname.slice(1)) };
}

async function makeS3Client(auth?: S3Auth): Promise<S3Client> {
  const { S3Client } = await loadAwsS3();
  const endpoint = auth?.endpoint ?? process.env.AWS_S3_ENDPOINT;
  const region = auth?.region ?? process.env.AWS_REGION ?? (endpoint ? "auto" : undefined);
  const config: S3ClientConfig = {
    region,
    endpoint,
    forcePathStyle: Boolean(endpoint),
  };

  const accessKeyId = auth?.access_key_id ?? process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = auth?.secret_access_key ?? process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = auth?.session_token ?? process.env.AWS_SESSION_TOKEN;
  if (accessKeyId && secretAccessKey) {
    config.credentials = { accessKeyId, secretAccessKey, sessionToken };
  }

  return new S3Client(config);
}

export async function downloadS3ToFile(
  url: string,
  targetPath: string,
  auth?: S3Auth,
  signal?: AbortSignal,
): Promise<void> {
  const { bucket, key } = parseS3Url(url);
  const { GetObjectCommand } = await loadAwsS3();
  const client = await makeS3Client(auth);
  try {
    // Thread the abort signal into BOTH the SDK request and the write pipeline so a
    // cancel_download (#515) aborts the S3 transfer promptly instead of running to
    // completion. The streamUrlToFile cloud branch also guards before/after as a
    // backstop, so a cancelled transfer is never finalized even if the SDK ignores it.
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: signal,
    });
    if (!response.Body) {
      throw new ModelError("S3 download response has no body", { url: redactUrlForLogs(url) });
    }
    await pipeline(bodyToReadable(response.Body), createWriteStream(targetPath), { signal });
    // #343 edge: the S3 stream can end early (dropped connection) and pipeline()
    // still resolves, leaving a truncated file. S3 tells us the authoritative
    // object size in ContentLength — verify the bytes on disk match before this
    // download can ever be reported as successful.
    const expected = typeof response.ContentLength === "number" ? response.ContentLength : 0;
    if (expected > 0) {
      const actual = (await stat(targetPath)).size;
      if (actual < expected) {
        throw new ModelError(
          `S3 download truncated: wrote ${actual} of ${expected} bytes — the stream ended early. Not complete; retry.`,
          { url: redactUrlForLogs(url) },
        );
      }
    }
  } catch (err) {
    if (err instanceof ModelError || err instanceof ValidationError) throw err;
    throw new ModelError("S3 download failed", {
      url: redactUrlForLogs(url),
      ...safeErrorDetails(err),
    });
  } finally {
    client.destroy();
  }
}

export async function uploadS3File(
  source: StorageUploadSource,
  destination: { bucket: string; prefix?: string },
  auth?: S3Auth,
): Promise<StorageUploadResult> {
  const key = withPrefix(destination.prefix, source.filename);
  const { PutObjectCommand } = await loadAwsS3();
  const client = await makeS3Client(auth);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: destination.bucket,
        Key: key,
        Body: source.path ? createReadStream(source.path) : source.data,
        ContentType: source.contentType,
      }),
    );
    return { provider: "s3", url: `s3://${destination.bucket}/${key}` };
  } catch (err) {
    throw new ModelError("S3 upload failed", {
      url: `s3://${destination.bucket}/${key}`,
      ...safeErrorDetails(err),
    });
  } finally {
    client.destroy();
  }
}

