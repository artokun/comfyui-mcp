import { Readable } from "node:stream";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirror how the product builds the output dir (resolve against
// config.comfyuiPath) so realpath mock keys match on Windows as well as POSIX.
const OUTPUT_DIR = resolve("/comfy", "output");
const outPath = (...segments: string[]): string => resolve(OUTPUT_DIR, ...segments);

const awsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  destroy: vi.fn(),
  S3Client: vi.fn(),
  GetObjectCommand: vi.fn(),
  PutObjectCommand: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => {
  class GetObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
      awsMocks.GetObjectCommand(input);
    }
  }
  class PutObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
      awsMocks.PutObjectCommand(input);
    }
  }
  // vitest 4 invokes mocked constructors via `new`, which only works on a
  // function with a [[Construct]] slot — arrow-function .mockImplementation
  // values throw. Use a `function` declaration so `new S3Client(...)` works.
  awsMocks.S3Client.mockImplementation(function (this: unknown, config: unknown) {
    return {
      config,
      send: awsMocks.send,
      destroy: awsMocks.destroy,
    };
  });
  return {
    GetObjectCommand,
    PutObjectCommand,
    S3Client: awsMocks.S3Client,
  };
});

const azureMocks = vi.hoisted(() => ({
  download: vi.fn(),
  uploadData: vi.fn(),
  uploadStream: vi.fn(),
  BlobClient: vi.fn(),
  fromConnectionString: vi.fn(),
}));

vi.mock("@azure/storage-blob", () => {
  class BlobClient {
    url: string;
    constructor(url: string) {
      this.url = url;
      azureMocks.BlobClient(url);
    }
    download() {
      return azureMocks.download();
    }
  }

  class BlobServiceClient {
    static fromConnectionString(connectionString: string) {
      azureMocks.fromConnectionString(connectionString);
      return new BlobServiceClient("https://acct.blob.core.windows.net");
    }
    url: string;
    constructor(url: string) {
      this.url = url;
    }
    getContainerClient(container: string) {
      return {
        getBlobClient: (blob: string) => new BlobClient(`${this.url}/${container}/${blob}`),
        getBlockBlobClient: (blob: string) => ({
          url: `${this.url}/${container}/${blob}`,
          uploadData: azureMocks.uploadData,
          uploadStream: azureMocks.uploadStream,
        }),
      };
    }
  }

  class StorageSharedKeyCredential {
    constructor(_account: string, _key: string) {}
  }

  return { BlobClient, BlobServiceClient, StorageSharedKeyCredential };
});

const fsMocks = vi.hoisted(() => ({
  createReadStream: vi.fn(),
  createWriteStream: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const stream = await vi.importActual<typeof import("node:stream")>("node:stream");
  return {
    createReadStream: fsMocks.createReadStream.mockImplementation(() => stream.Readable.from("file-body")),
    createWriteStream: fsMocks.createWriteStream.mockImplementation(
      () => new stream.Writable({ write(_chunk, _enc, cb) { cb(); } }),
    ),
  };
});

const fsPromisesMocks = vi.hoisted(() => ({
  copyFile: vi.fn(),
  link: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  rename: vi.fn(),
  realpath: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
  mkdtemp: vi.fn(),
  utimes: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  copyFile: fsPromisesMocks.copyFile,
  link: fsPromisesMocks.link,
  mkdir: fsPromisesMocks.mkdir,
  readdir: fsPromisesMocks.readdir,
  rename: fsPromisesMocks.rename,
  realpath: fsPromisesMocks.realpath,
  rm: fsPromisesMocks.rm,
  stat: fsPromisesMocks.stat,
  mkdtemp: fsPromisesMocks.mkdtemp,
  utimes: fsPromisesMocks.utimes,
  writeFile: fsPromisesMocks.writeFile,
}));

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: loggerMocks,
}));

vi.mock("../../config.js", () => ({
  config: {
    comfyuiPath: "/comfy",
    huggingfaceToken: undefined,
    civitaiApiToken: undefined,
  },
}));

const getOutputImageMock = vi.fn();
vi.mock("../../services/image-management.js", () => ({
  getOutputImage: (...a: unknown[]) => getOutputImageMock(...a),
}));

import { AssetRegistry } from "../../services/asset-registry.js";
import { downloadUrlToFile } from "../../services/download-cache.js";
import { uploadOutput } from "../../services/storage-upload.js";
import { uploadToStorage } from "../../services/storage/index.js";
import type { WorkflowJSON } from "../../comfyui/types.js";

const fetchMock = vi.fn();

function registerAsset(filename = "result.png"): string {
  const wf: WorkflowJSON = {
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "x" } },
  };
  const [record] = AssetRegistry.register({
    promptId: "p1",
    workflow: wf,
    outputs: [
      {
        node_id: "9",
        images: [{ filename, subfolder: "", type: "output", url: "u" }],
      },
    ],
  });
  return record.assetId;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  awsMocks.send.mockReset();
  awsMocks.destroy.mockReset();
  awsMocks.S3Client.mockClear();
  awsMocks.GetObjectCommand.mockClear();
  awsMocks.PutObjectCommand.mockClear();
  azureMocks.download.mockReset();
  azureMocks.uploadData.mockReset();
  azureMocks.uploadStream.mockReset();
  azureMocks.BlobClient.mockClear();
  azureMocks.fromConnectionString.mockClear();
  fsMocks.createReadStream.mockClear();
  fsMocks.createWriteStream.mockClear();
  fsPromisesMocks.copyFile.mockReset();
  fsPromisesMocks.link.mockReset();
  fsPromisesMocks.mkdir.mockReset();
  fsPromisesMocks.readdir.mockReset();
  fsPromisesMocks.rename.mockReset();
  fsPromisesMocks.realpath.mockReset();
  fsPromisesMocks.rm.mockReset();
  fsPromisesMocks.stat.mockReset();
  fsPromisesMocks.mkdtemp.mockReset();
  fsPromisesMocks.utimes.mockReset();
  fsPromisesMocks.writeFile.mockReset();
  execFileMock.mockReset();
  loggerMocks.info.mockReset();
  loggerMocks.warn.mockReset();
  loggerMocks.error.mockReset();
  loggerMocks.debug.mockReset();
  getOutputImageMock.mockReset();
  AssetRegistry.configure({ ttlMs: 60_000, now: Date.now });
  AssetRegistry.clear();
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_REGION;
  delete process.env.AWS_S3_ENDPOINT;
  delete process.env.AZURE_STORAGE_CONNECTION_STRING;
  delete process.env.AZURE_STORAGE_ACCOUNT;
  delete process.env.AZURE_STORAGE_KEY;
});

describe("cloud storage downloads", () => {
  it("dispatches s3:// downloads through the S3 provider", async () => {
    awsMocks.send.mockResolvedValueOnce({ Body: Readable.from("s3-data") });

    await downloadUrlToFile(
      "s3://models/checkpoints/a.safetensors",
      "/tmp/a.safetensors",
      {},
      "s3://models/checkpoints/a.safetensors",
      {
        s3: {
          type: "s3",
          access_key_id: "AKIA_TEST",
          secret_access_key: "secret",
          region: "us-east-1",
        },
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(awsMocks.S3Client).toHaveBeenCalledWith(expect.objectContaining({
      region: "us-east-1",
      credentials: expect.objectContaining({ accessKeyId: "AKIA_TEST" }),
    }));
    expect(awsMocks.GetObjectCommand).toHaveBeenCalledWith({
      Bucket: "models",
      Key: "checkpoints/a.safetensors",
    });
    expect(fsMocks.createWriteStream).toHaveBeenCalledWith("/tmp/a.safetensors");
  });

  it("dispatches Azure Blob downloads through the Azure provider", async () => {
    azureMocks.download.mockResolvedValueOnce({
      readableStreamBody: Readable.from("azure-data"),
    });

    await downloadUrlToFile(
      "https://acct.blob.core.windows.net/container/path/model.safetensors?sig=secret",
      "/tmp/model.safetensors",
      {},
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(azureMocks.BlobClient).toHaveBeenCalledWith(
      "https://acct.blob.core.windows.net/container/path/model.safetensors?sig=secret",
    );
    expect(fsMocks.createWriteStream).toHaveBeenCalledWith("/tmp/model.safetensors");
  });

  it("rejects Azure downloads when configured env account does not match the URL account", async () => {
    process.env.AZURE_STORAGE_ACCOUNT = "accta";
    process.env.AZURE_STORAGE_KEY = "key";

    await expect(
      downloadUrlToFile(
        "https://acctb.blob.core.windows.net/container/path/model.safetensors",
        "/tmp/model.safetensors",
        {},
      ),
    ).rejects.toThrow(/account must match/i);

    expect(azureMocks.download).not.toHaveBeenCalled();
  });

  it("does not replay download auth headers across cross-origin redirects", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", {
        status: 302,
        statusText: "Found",
        headers: { Location: "https://other.example.com/model.safetensors" },
      }))
      .mockResolvedValueOnce(new Response("model-data", { status: 200, statusText: "OK" }));

    await downloadUrlToFile(
      "https://source.example.com/model.safetensors",
      "/tmp/model.safetensors",
      { Authorization: "Bearer secret" },
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://source.example.com/model.safetensors",
      expect.objectContaining({
        headers: { Authorization: "Bearer secret" },
        redirect: "manual",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://other.example.com/model.safetensors",
      expect.objectContaining({
        headers: {},
        redirect: "manual",
      }),
    );
  });
});

describe("cloud storage uploads", () => {
  it("uploads to HTTP destinations with PUT", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200, statusText: "OK" }));

    const result = await uploadToStorage(
      { data: Buffer.from("image"), filename: "image.png", contentType: "image/png" },
      { http: { url: "https://uploads.example.com/image.png" } },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://uploads.example.com/image.png",
      expect.objectContaining({
        method: "PUT",
        redirect: "manual",
        headers: { "Content-Type": "image/png" },
        body: Buffer.from("image"),
      }),
    );
    expect(result).toEqual({ provider: "http", url: "https://uploads.example.com/image.png" });
  });

  it("rejects HTTP upload redirects", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", {
      status: 302,
      statusText: "Found",
      headers: { Location: "https://other.example.com/image.png" },
    }));

    await expect(
      uploadToStorage(
        { data: Buffer.from("image"), filename: "image.png", contentType: "image/png" },
        { http: { url: "https://uploads.example.com/image.png" } },
      ),
    ).rejects.toThrow(/redirect rejected/i);
  });

  it("uploads to S3 destinations", async () => {
    awsMocks.send.mockResolvedValueOnce({});

    const result = await uploadToStorage(
      { data: Buffer.from("image"), filename: "image.png", contentType: "image/png" },
      { s3: { bucket: "out", prefix: "runs/1" } },
    );

    expect(awsMocks.PutObjectCommand).toHaveBeenCalledWith(expect.objectContaining({
      Bucket: "out",
      Key: "runs/1/image.png",
      Body: Buffer.from("image"),
      ContentType: "image/png",
    }));
    expect(result).toEqual({ provider: "s3", url: "s3://out/runs/1/image.png" });
  });

  it("rejects source paths that escape the ComfyUI output directory after realpath", async () => {
    fsPromisesMocks.realpath.mockImplementation((path: string) => {
      if (path === OUTPUT_DIR) return Promise.resolve(OUTPUT_DIR);
      if (path === outPath("link", "secret.png")) return Promise.resolve("/tmp/secret.png");
      return Promise.resolve(path);
    });

    await expect(
      uploadOutput({
        path: "link/secret.png",
        destination: { http: { url: "https://uploads.example.com/secret.png" } },
      }),
    ).rejects.toThrow(/output directory/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fsPromisesMocks.stat).not.toHaveBeenCalled();
  });

  it("redacts signed URL query secrets in upload logs", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200, statusText: "OK" }));
    const assetId = registerAsset();
    getOutputImageMock.mockResolvedValueOnce({
      base64: Buffer.from("image").toString("base64"),
      mimeType: "image/png",
      filename: "image.png",
    });
    await uploadOutput({
      asset_id: assetId,
      destination: {
        http: {
          url: "https://uploads.example.com/image.png?X-Amz-Signature=supersecret&ok=1",
        },
      },
    });

    const logText = JSON.stringify(loggerMocks.info.mock.calls);
    expect(logText).not.toContain("supersecret");
    expect(logText).toContain("X-Amz-Signature=%5BREDACTED%5D");
  });

  it("rejects unknown upload destinations clearly", async () => {
    await expect(
      uploadToStorage(
        { data: Buffer.from("x"), filename: "x.bin" },
        { ftp: { url: "ftp://example.com/x.bin" } } as never,
      ),
    ).rejects.toThrow(/unsupported upload destination/i);
  });

  it("rejects HuggingFace remote path segments that look like CLI options", async () => {
    await expect(
      uploadToStorage(
        { data: Buffer.from("x"), filename: "x.bin" },
        { hf: { repo: "owner/name", path: "-evil" } },
      ),
    ).rejects.toThrow(/cannot start with '-'/i);

    expect(execFileMock).not.toHaveBeenCalled();
  });
});
