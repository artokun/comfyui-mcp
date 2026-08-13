import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DEAD_NAMES, MAX_TOOLS, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated image/asset surface (0.50.0 slice 15): twelve tools folded
 * into `get_image` (7 actions) + `upload_image` (5). Proves the consolidation
 * did not change behaviour — every action calls the identical service function
 * the old tool called, with the same arguments and the same content block — and
 * that the flat-enum shape actually EXPOSES its parameters (the
 * discriminated-union trap renders zero params).
 *
 * The weight is concentrated on the DISPATCH TABLES, and deliberately so: this
 * family is the one where a mis-wired action puts BYTES IN THE WRONG PLACE
 * rather than merely returning the wrong answer. action:"stage" copies a
 * server-side output into ComfyUI's INPUT directory, action:"image"/"video"/
 * "audio" put a LOCAL file into that same input directory, and action:"output"
 * ships a generated output OFF the machine to a cloud bucket. A cross-wire
 * between any two of those succeeds, reports success, and silently writes
 * somewhere the caller never named — which no "did it work?" assertion would
 * catch. So each action is pinned to exactly one service, in BOTH directions.
 */
const listOutputImagesMock = vi.fn();
const getOutputImageMock = vi.fn();
const uploadImageAutoMock = vi.fn();
const uploadVideoAutoMock = vi.fn();
const uploadAudioAutoMock = vi.fn();
const stageOutputAsInputMock = vi.fn();
/** Where the listing came from. Mutable so a test can pick local vs remote. */
let listSourceMock: { directory?: string; basis: "local-scan" | "server-history" } = {
  directory: "C:\\Comfy\\output",
  basis: "local-scan",
};
vi.mock("../../services/image-management.js", () => ({
  extractWorkflowFromImage: vi.fn(),
  listOutputImages: (...a: unknown[]) => listOutputImagesMock(...a),
  listOutputMedia: async (...a: unknown[]) => ({
    images: await listOutputImagesMock(...a),
    // #953: the BASIS is per-test now — a remote target answers from /history,
    // and that listing is incomplete in a way a local scan is not.
    source: listSourceMock,
  }),
  getOutputImage: (...a: unknown[]) => getOutputImageMock(...a),
  uploadImageAuto: (...a: unknown[]) => uploadImageAutoMock(...a),
  uploadVideoAuto: (...a: unknown[]) => uploadVideoAutoMock(...a),
  uploadAudioAuto: (...a: unknown[]) => uploadAudioAutoMock(...a),
  stageOutputAsInput: (...a: unknown[]) => stageOutputAsInputMock(...a),
}));

const viewAssetImageMock = vi.fn();
vi.mock("../../services/view-image.js", () => ({
  viewAssetImage: (...a: unknown[]) => viewAssetImageMock(...a),
}));

const convertImageMock = vi.fn();
vi.mock("../../services/image-convert.js", () => ({
  convertImage: (...a: unknown[]) => convertImageMock(...a),
}));

const analyzeColorMock = vi.fn();
vi.mock("../../services/color-analysis.js", () => ({
  analyzeColor: (...a: unknown[]) => analyzeColorMock(...a),
}));

const uploadOutputMock = vi.fn();
vi.mock("../../services/storage-upload.js", () => ({
  uploadOutput: (...a: unknown[]) => uploadOutputMock(...a),
}));

const registryListMock = vi.fn();
const registryGetMock = vi.fn();
vi.mock("../../services/asset-registry.js", () => ({
  AssetRegistry: {
    list: (...a: unknown[]) => registryListMock(...a),
    get: (...a: unknown[]) => registryGetMock(...a),
  },
}));

const reconcileMock = vi.fn();
vi.mock("../../services/asset-reconcile.js", () => ({
  reconcileAssetsFromHistory: (...a: unknown[]) => reconcileMock(...a),
}));

// action:"get" writes the fetched bytes to disk; never touch the real one.
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) };
});

import { registerImageManagementTools } from "../../tools/image-management.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
};
type Handler = (args: Record<string, any>) => Promise<ToolResult>;
interface Registered {
  name: string;
  shape: z.ZodRawShape;
  handler: Handler;
}

function registered(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    tool: (name: string, _desc: string, shape: z.ZodRawShape, handler: Handler) => {
      tools.push({ name, shape, handler });
    },
  };
  registerImageManagementTools(server as never);
  return tools;
}

/** The READ/INSPECT half. */
function getImage(): Handler {
  const tools = registered();
  expect(tools[0].name).toBe("get_image");
  return tools[0].handler;
}

/** The WRITE half. */
function uploadImage(): Handler {
  const tools = registered();
  expect(tools[1].name).toBe("upload_image");
  return tools[1].handler;
}

const text = (res: ToolResult) => res.content.map((c) => c.text ?? "").join(" ");

beforeEach(() => {
  vi.clearAllMocks();
  getOutputImageMock.mockResolvedValue({ base64: "aGk=", mimeType: "image/png" });
  listOutputImagesMock.mockResolvedValue([]);
  viewAssetImageMock.mockResolvedValue({ content: [{ type: "text", text: "viewed" }] });
  convertImageMock.mockResolvedValue({ content: [{ type: "text", text: "converted" }] });
  analyzeColorMock.mockResolvedValue({ content: [{ type: "text", text: "measured" }] });
  uploadOutputMock.mockResolvedValue({ source: { filename: "a.png" }, uploads: [] });
  uploadImageAutoMock.mockResolvedValue({ filename: "in.png" });
  uploadVideoAutoMock.mockResolvedValue({ filename: "in.mp4" });
  uploadAudioAutoMock.mockResolvedValue({ filename: "in.wav" });
  stageOutputAsInputMock.mockResolvedValue({
    filename: "staged.png",
    subfolder: "",
    type: "input",
    kind: "image",
  });
  registryListMock.mockReturnValue([]);
  registryGetMock.mockReturnValue(undefined);
  reconcileMock.mockResolvedValue(undefined);
});

describe("image/asset registration", () => {
  it("registers exactly get_image then upload_image (12→2)", () => {
    // Registration order is observable in tools/list and pinned by
    // registry-surface.test.ts — the survivors keep their slots. The
    // PNG-metadata tool that used to register third left this file in 0.50.0
    // slice 14 (it is get_workflow action:"from_image" now).
    expect(registered().map((t) => t.name)).toEqual(["get_image", "upload_image"]);
  });

  // The whole reason for the flat-enum shape rule: a z.discriminatedUnion renders
  // as ZERO parameters, hiding every input from the model.
  it("`get_image` exposes a visible flat `action` enum with every per-action parameter", () => {
    const [{ shape }] = registered();
    // io: "input" — the conversion options the MCP SDK itself uses
    // (sdk/server/zod-json-schema-compat.js, asserted by docs-schema-parity.test.ts),
    // so this is the schema a client is actually given.
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action",
      "asset_id",
      "effort",
      "filename",
      "format",
      "histogram",
      "limit",
      "lossless",
      // #1495 — the two knobs on the inline preview budget. Listed here on purpose: this
      // assertion is the surface gate, so a parameter cannot appear without someone
      // deciding it should.
      "max_preview_bytes",
      "max_preview_dimension",
      "out_path",
      "path",
      "pattern",
      "progressive",
      "quality",
      "reference_path",
      "save_dir",
      "since",
      "subfolder",
      "type",
    ]);
    // prettier-ignore — same reason as GET_IMAGE_ACTIONS in the tool: an action
    // literal is licensed only where it follows `[` or `,` on its own line.
    expect(json.properties?.action.enum?.slice().sort()).toEqual(["analyze_color", "asset_metadata", "convert", "get", "list_assets", "list_outputs", "view"]);
    // Only `action` can be required — the rest are per-action, enforced in the handler.
    expect(json.required).toEqual(["action"]);
  });

  it("`upload_image` exposes a visible flat `action` enum, `action` the only required field", () => {
    const { shape } = registered()[1];
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action",
      "as_filename",
      "asset_id",
      "destination",
      "filename",
      "kind",
      "path",
      "source_path",
      "subfolder",
      "type",
    ]);
    expect(json.properties?.action.enum?.slice().sort()).toEqual([
      "audio",
      "image",
      "output",
      "stage",
      "video",
    ]);
    expect(json.required).toEqual(["action"]);
  });

  // The VALUE constraints the old per-tool schemas carried must survive the fold.
  it("keeps the encoder bounds, the enums and the ISO-timestamp check at the zod layer", () => {
    const { shape } = registered()[0];
    expect(() => (shape.quality as z.ZodTypeAny).parse(0)).toThrow();
    expect(() => (shape.quality as z.ZodTypeAny).parse(101)).toThrow();
    expect((shape.quality as z.ZodTypeAny).parse(85)).toBe(85);
    expect(() => (shape.effort as z.ZodTypeAny).parse(7)).toThrow();
    expect(() => (shape.effort as z.ZodTypeAny).parse(-1)).toThrow();
    expect((shape.effort as z.ZodTypeAny).parse(6)).toBe(6);
    expect(() => (shape.limit as z.ZodTypeAny).parse(0)).toThrow();
    expect(() => (shape.limit as z.ZodTypeAny).parse(2.5)).toThrow();
    // …and NO ceiling at the zod layer: the asset listing never had one, so
    // re-adding .max(100) here to match the output listing would be a false
    // refusal for every action:"list_assets" caller asking for more than 100 records.
    // The 100 bound lives in the list_outputs branch of the handler instead.
    expect((shape.limit as z.ZodTypeAny).parse(500)).toBe(500);
    // The format enum must carry BOTH halves of the union; narrowing it to one
    // action's values would make the other action's legal values unreachable.
    for (const f of ["markdown", "json", "png", "jpeg", "webp"]) {
      expect((shape.format as z.ZodTypeAny).parse(f), f).toBe(f);
    }
    expect(() => (shape.type as z.ZodTypeAny).parse("elsewhere")).toThrow();
    expect(() => (shape.format as z.ZodTypeAny).parse("tiff")).toThrow();
    expect(() => (shape.since as z.ZodTypeAny).parse("last tuesday")).toThrow();
    expect((shape.since as z.ZodTypeAny).parse("2026-08-05T00:00:00.000Z")).toBe(
      "2026-08-05T00:00:00.000Z",
    );

    const up = registered()[1].shape;
    expect(() => (up.type as z.ZodTypeAny).parse("input")).toThrow(); // stage reads output|temp only
    expect(() => (up.kind as z.ZodTypeAny).parse("mesh")).toThrow();
    // The cloud destination keeps its own object constraints.
    expect(() => (up.destination as z.ZodTypeAny).parse({ s3: { bucket: "" } })).toThrow();
    expect(() => (up.destination as z.ZodTypeAny).parse({ http: { url: "not-a-url" } })).toThrow();
    expect((up.destination as z.ZodTypeAny).parse({ s3: { bucket: "b", prefix: "p" } })).toEqual({
      s3: { bucket: "b", prefix: "p" },
    });
  });

  it("an unknown action returns a clear error result on both tools, reaching no service", async () => {
    const a = await getImage()({ action: "delete" });
    expect(a.isError).toBe(true);
    expect(text(a)).toMatch(/unknown get_image action/i);
    expect(text(a)).toMatch(/asset_metadata/);
    expect(getOutputImageMock).not.toHaveBeenCalled();
    expect(convertImageMock).not.toHaveBeenCalled();

    const b = await uploadImage()({ action: "delete" });
    expect(b.isError).toBe(true);
    expect(text(b)).toMatch(/unknown upload_image action/i);
    expect(text(b)).toMatch(/stage/);
    expect(uploadImageAutoMock).not.toHaveBeenCalled();
    expect(stageOutputAsInputMock).not.toHaveBeenCalled();
    expect(uploadOutputMock).not.toHaveBeenCalled();
  });
});

describe("get_image: each action reaches exactly one service", () => {
  const services = () => ({
    getOutputImage: getOutputImageMock,
    viewAssetImage: viewAssetImageMock,
    listOutputImages: listOutputImagesMock,
    convertImage: convertImageMock,
    analyzeColor: analyzeColorMock,
  });

  /** action → the ONE service it may reach (null = registry-only, no service). */
  const expected: Array<[string, Record<string, unknown>, keyof ReturnType<typeof services> | null]> = [
    ["get", { filename: "a.png" }, "getOutputImage"],
    ["view", { asset_id: "a_1" }, "viewAssetImage"],
    ["list_outputs", {}, "listOutputImages"],
    ["convert", { asset_id: "a_1", format: "webp" }, "convertImage"],
    ["analyze_color", { filename: "a.png" }, "analyzeColor"],
    ["list_assets", {}, null],
    ["asset_metadata", { asset_id: "a_1" }, null],
  ];

  for (const [action, args, only] of expected) {
    it(`action:"${action}" calls ${only ?? "no image service"} and nothing else`, async () => {
      await getImage()({ action, ...args });
      for (const [name, mock] of Object.entries(services())) {
        if (name === only) expect(mock, name).toHaveBeenCalledTimes(1);
        else expect(mock, name).not.toHaveBeenCalled();
      }
    });
  }

  it('action:"get" forwards filename/type/subfolder and the allowMedia flag unchanged', async () => {
    await getImage()({ action: "get", filename: "p.png", type: "temp", subfolder: "sub" });
    expect(getOutputImageMock).toHaveBeenCalledWith("p.png", "temp", "sub", {
      allowMedia: true,
      // #1373 — the input dir legitimately holds workflow .json files.
      allowJson: true,
    });
  });

  it('action:"get" still defaults type/subfolder in the handler, not the schema', async () => {
    // Dropping the schema-level .default() keeps `type`/`subfolder` undefined for
    // the OTHER actions that share them; the get branch supplies the same
    // defaults it always did.
    await getImage()({ action: "get", filename: "p.png" });
    expect(getOutputImageMock).toHaveBeenCalledWith("p.png", "output", "", {
      allowMedia: true,
      allowJson: true,
    });
  });

  it('action:"convert" forwards exactly the encoder options the retired converter took', async () => {
    await getImage()({
      action: "convert",
      asset_id: "a_123",
      format: "webp",
      quality: 70,
      lossless: false,
      effort: 5,
      out_path: "small.webp",
    });
    expect(convertImageMock).toHaveBeenCalledWith({
      asset_id: "a_123",
      path: undefined,
      format: "webp",
      quality: 70,
      progressive: undefined,
      lossless: false,
      effort: 5,
      out_path: "small.webp",
    });
  });

  it('action:"analyze_color" forwards its source triple and leaves unset fields undefined', async () => {
    await getImage()({ action: "analyze_color", path: "frame.png", reference_path: "ref.jpg" });
    expect(analyzeColorMock).toHaveBeenCalledWith({
      asset_id: undefined,
      path: "frame.png",
      filename: undefined,
      subfolder: undefined,
      type: undefined,
      reference_path: "ref.jpg",
      histogram: undefined,
    });
  });

  it('action:"list_assets" reconciles history first, then reads the registry with limit/since', async () => {
    await getImage()({ action: "list_assets", limit: 3, since: "2026-08-05T00:00:00.000Z" });
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(registryListMock).toHaveBeenCalledWith({
      limit: 3,
      since: Date.parse("2026-08-05T00:00:00.000Z"),
    });
  });

  it('action:"asset_metadata" reads the registry and never reconciles', async () => {
    registryGetMock.mockReturnValue({
      assetId: "a_1",
      promptId: "p",
      nodeId: "9",
      filename: "f.png",
      subfolder: "",
      type: "output",
      url: "u",
      source: "watched",
      createdAt: 0,
      createdAtSource: "watched",
      workflow: { "3": {} },
    });
    const res = await getImage()({ action: "asset_metadata", asset_id: "a_1" });
    expect(registryGetMock).toHaveBeenCalledWith("a_1");
    expect(reconcileMock).not.toHaveBeenCalled();
    const parsed = JSON.parse(text(res)) as { asset_id: string; workflow: unknown };
    expect(parsed.asset_id).toBe("a_1");
    expect(parsed.workflow).toEqual({ "3": {} });
  });

  it("returns the identical inline content blocks the retired tools returned", async () => {
    viewAssetImageMock.mockResolvedValue({
      content: [
        { type: "text", text: "asset a_1" },
        { type: "image", data: "cGl4", mimeType: "image/png" },
      ],
    });
    const res = await getImage()({ action: "view", asset_id: "a_1" });
    expect(res.content).toEqual([
      { type: "text", text: "asset a_1" },
      { type: "image", data: "cGl4", mimeType: "image/png" },
    ]);
  });
});

describe("upload_image: each action writes to exactly one destination", () => {
  const services = () => ({
    uploadImageAuto: uploadImageAutoMock,
    uploadVideoAuto: uploadVideoAutoMock,
    uploadAudioAuto: uploadAudioAutoMock,
    stageOutputAsInput: stageOutputAsInputMock,
    uploadOutput: uploadOutputMock,
  });

  const expected: Array<[string, Record<string, unknown>, keyof ReturnType<typeof services>]> = [
    ["image", { source_path: "/tmp/a.png" }, "uploadImageAuto"],
    ["video", { source_path: "/tmp/a.mp4" }, "uploadVideoAuto"],
    ["audio", { source_path: "/tmp/a.wav" }, "uploadAudioAuto"],
    ["stage", { filename: "out_00001_.png" }, "stageOutputAsInput"],
    ["output", { path: "out_00001_.png", destination: { s3: { bucket: "b" } } }, "uploadOutput"],
  ];

  for (const [action, args, only] of expected) {
    it(`action:"${action}" calls ${only} and NO other write path`, async () => {
      await uploadImage()({ action, ...args });
      for (const [name, mock] of Object.entries(services())) {
        if (name === only) expect(mock, name).toHaveBeenCalledTimes(1);
        else expect(mock, name).not.toHaveBeenCalled();
      }
    });
  }

  it('action:"image"/"video"/"audio" forward (source_path, filename) positionally, unchanged', async () => {
    await uploadImage()({ action: "image", source_path: "/tmp/a.png", filename: "renamed.png" });
    expect(uploadImageAutoMock).toHaveBeenCalledWith("/tmp/a.png", "renamed.png");
    await uploadImage()({ action: "video", source_path: "/tmp/a.mp4" });
    expect(uploadVideoAutoMock).toHaveBeenCalledWith("/tmp/a.mp4", undefined);
    await uploadImage()({ action: "audio", source_path: "/tmp/a.wav" });
    expect(uploadAudioAutoMock).toHaveBeenCalledWith("/tmp/a.wav", undefined);
  });

  it('action:"stage" maps filename→source ref and as_filename→destination override', async () => {
    // The one genuinely confusable pair on this tool: `filename` names the
    // SOURCE output for stage (where it names the DESTINATION for the media
    // uploads), and `as_filename` is stage's destination override.
    await uploadImage()({
      action: "stage",
      filename: "out_00001_.mp4",
      subfolder: "video",
      type: "temp",
      kind: "video",
      as_filename: "next_stage_input.mp4",
    });
    expect(stageOutputAsInputMock).toHaveBeenCalledWith({
      filename: "out_00001_.mp4",
      subfolder: "video",
      type: "temp",
      kind: "video",
      asFilename: "next_stage_input.mp4",
    });
  });

  it('action:"stage" defaults type to "output" in the handler', async () => {
    await uploadImage()({ action: "stage", filename: "out_00001_.png" });
    expect(stageOutputAsInputMock).toHaveBeenCalledWith({
      filename: "out_00001_.png",
      subfolder: undefined,
      type: "output",
      kind: undefined,
      asFilename: undefined,
    });
  });

  it('action:"output" forwards asset_id/path/destination to the cloud uploader only', async () => {
    const destination = { hf: { repo: "me/models", repo_type: "model" as const } };
    await uploadImage()({ action: "output", asset_id: "a_1", destination });
    expect(uploadOutputMock).toHaveBeenCalledWith({
      asset_id: "a_1",
      path: undefined,
      destination,
    });
  });

  it("a local upload never touches the staging path, and staging never uploads a local file", async () => {
    // Stated as its own case because this is the cross-wire that would put a
    // file in the wrong directory while reporting success.
    await uploadImage()({ action: "image", source_path: "/tmp/a.png" });
    expect(stageOutputAsInputMock).not.toHaveBeenCalled();
    vi.clearAllMocks();
    stageOutputAsInputMock.mockResolvedValue({
      filename: "s.png",
      subfolder: "",
      type: "input",
      kind: "image",
    });
    await uploadImage()({ action: "stage", filename: "out.png" });
    expect(uploadImageAutoMock).not.toHaveBeenCalled();
    expect(uploadVideoAutoMock).not.toHaveBeenCalled();
    expect(uploadAudioAutoMock).not.toHaveBeenCalled();
    expect(uploadOutputMock).not.toHaveBeenCalled();
  });
});

describe("per-action requiredness is enforced in the handler and NAMES the field", () => {
  it("get_image names the missing field for every action that has one", async () => {
    const h = getImage();
    const missing = [
      ["get", {}, "filename"],
      ["view", {}, "asset_id"],
      ["asset_metadata", {}, "asset_id"],
      ["convert", { asset_id: "a" }, "format"],
    ] as const;
    for (const [action, args, field] of missing) {
      const res = await h({ action, ...args });
      expect(res.isError, action).toBe(true);
      expect(text(res), action).toContain(`get_image action:"${action}" requires \`${field}\``);
    }
    // …and none of them reached a service.
    expect(getOutputImageMock).not.toHaveBeenCalled();
    expect(viewAssetImageMock).not.toHaveBeenCalled();
    expect(convertImageMock).not.toHaveBeenCalled();
    expect(registryGetMock).not.toHaveBeenCalled();
  });

  it("upload_image names the missing field for every action", async () => {
    const h = uploadImage();
    const missing = [
      ["image", {}, "source_path"],
      ["video", {}, "source_path"],
      ["audio", {}, "source_path"],
      ["stage", {}, "filename"],
      ["output", { path: "p" }, "destination"],
    ] as const;
    for (const [action, args, field] of missing) {
      const res = await h({ action, ...args });
      expect(res.isError, action).toBe(true);
      expect(text(res), action).toContain(`upload_image action:"${action}" requires \`${field}\``);
    }
    expect(uploadImageAutoMock).not.toHaveBeenCalled();
    expect(uploadVideoAutoMock).not.toHaveBeenCalled();
    expect(uploadAudioAutoMock).not.toHaveBeenCalled();
    expect(stageOutputAsInputMock).not.toHaveBeenCalled();
    expect(uploadOutputMock).not.toHaveBeenCalled();
  });
});

describe("guards test ABSENCE, never falsiness", () => {
  // Every one of these values passed z.string() before the consolidation and
  // reached the service, which answers with its OWN not-found/validation error.
  // A `!x` guard would swallow that path and substitute generic text.
  it('get_image action:"get" forwards an empty filename to the service', async () => {
    await getImage()({ action: "get", filename: "" });
    expect(getOutputImageMock).toHaveBeenCalledWith("", "output", "", {
      allowMedia: true,
      allowJson: true,
    });
  });

  it('get_image action:"view"/"asset_metadata" forward an empty asset_id', async () => {
    await getImage()({ action: "view", asset_id: "" });
    expect(viewAssetImageMock).toHaveBeenCalledWith("");
    await getImage()({ action: "asset_metadata", asset_id: "" });
    expect(registryGetMock).toHaveBeenCalledWith("");
  });

  it("upload_image forwards an empty source_path / stage filename", async () => {
    await uploadImage()({ action: "image", source_path: "" });
    expect(uploadImageAutoMock).toHaveBeenCalledWith("", undefined);
    await uploadImage()({ action: "stage", filename: "" });
    expect(stageOutputAsInputMock).toHaveBeenCalledWith({
      filename: "",
      subfolder: undefined,
      type: "output",
      kind: undefined,
      asFilename: undefined,
    });
  });

  it('get_image action:"list_assets" forwards a since of the epoch (0), not "no filter"', async () => {
    await getImage()({ action: "list_assets", since: "1970-01-01T00:00:00.000Z" });
    expect(registryListMock).toHaveBeenCalledWith({ limit: undefined, since: 0 });
  });
});

describe("the two shared fields whose old schemas disagreed", () => {
  // `limit` was .int().min(1).max(100) on the output listing and .int().positive()
  // with NO ceiling on the asset listing. One zod field cannot express both, so
  // the ceiling moved into the handler for the one action that had it — the
  // refusal is preserved in both directions.
  it('refuses limit > 100 for action:"list_outputs", naming the bound', async () => {
    const res = await getImage()({ action: "list_outputs", limit: 101 });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('get_image action:"list_outputs" accepts `limit` 1..100');
    expect(listOutputImagesMock).not.toHaveBeenCalled();
  });

  it('still ACCEPTS limit > 100 for action:"list_assets", which never had a ceiling', async () => {
    await getImage()({ action: "list_assets", limit: 500 });
    expect(registryListMock).toHaveBeenCalledWith({ limit: 500, since: undefined });
  });

  it('accepts limit exactly 100 for action:"list_outputs"', async () => {
    await getImage()({ action: "list_outputs", limit: 100 });
    expect(listOutputImagesMock).toHaveBeenCalledWith({ limit: 100, pattern: undefined });
  });

  // `format` is the union of two unrelated enums: a response shape for the
  // listing and a target encoding for the conversion. Each action refuses the
  // other's values by name rather than silently reinterpreting them.
  it('refuses an encoder format on action:"list_outputs"', async () => {
    const res = await getImage()({ action: "list_outputs", format: "png" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('accepts `format` "markdown" or "json"');
    expect(listOutputImagesMock).not.toHaveBeenCalled();
  });

  it('refuses a response shape on action:"convert"', async () => {
    const res = await getImage()({ action: "convert", asset_id: "a", format: "json" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('accepts `format` "png", "jpeg" or "webp"');
    expect(convertImageMock).not.toHaveBeenCalled();
  });
});

describe('action:"list_outputs" keeps the mobile dataset picker\'s contract', () => {
  const sample = [
    {
      filename: "a.png",
      path: "/out/a.png",
      size: 1024,
      modified: "2026-07-22T00:00:00.000Z",
      subfolder: "",
      kind: "image",
    },
    {
      filename: "b.mp4",
      path: "/out/video/b.mp4",
      size: 2048,
      modified: "2026-07-21T00:00:00.000Z",
      subfolder: "video",
      kind: "video",
    },
  ];

  it("default (markdown) keeps the human/agent-readable list", async () => {
    listOutputImagesMock.mockResolvedValue(sample);
    const t = text(await getImage()({ action: "list_outputs", limit: 5 }));
    expect(t).toContain("Found 2 media file(s) (1 video):");
    expect(t).toContain("**video/b.mp4** [video]");
  });

  // #953 — the listing was already labelled with its source (#899), but the
  // history wording described STALENESS ("what the server remembers this
  // session"). The reporter's files were never in /history at all: VHS-style
  // video nodes write the file without registering an output entry, so those
  // videos are absent by construction. They saw a confident 12-file listing that
  // omitted 30+ ProRes masters, concluded the directory was empty, and wrote
  // that into a handover document. The files were fetchable by name throughout.
  describe("#953: a history-derived listing says it is incomplete BY CONSTRUCTION", () => {
    const remote = () => {
      listSourceMock = { basis: "server-history" };
    };
    const local = () => {
      listSourceMock = { directory: "C:\\Comfy\\output", basis: "local-scan" };
    };
    afterEach(local);

    it("warns on a POPULATED remote listing — the shape that misled the reporter", async () => {
      remote();
      listOutputImagesMock.mockResolvedValue(sample);
      const t = text(await getImage()({ action: "list_outputs", limit: 5 }));
      // The results are still returned…
      expect(t).toContain("Found 2 media file(s)");
      // …and the caveat rides with them.
      expect(t).toMatch(/INCOMPLETE BY CONSTRUCTION/);
      expect(t).toMatch(/VHS_VideoCombine/);
      expect(t).toMatch(/never appear here even though they are on disk/);
    });

    it("says absence is not evidence, and names a check that works remotely", async () => {
      remote();
      listOutputImagesMock.mockResolvedValue([]);
      const t = text(await getImage()({ action: "list_outputs" }));
      expect(t).toMatch(/NOT evidence the file is missing/);
      // /view serves from the output dir, so a by-name fetch sees what /history cannot.
      expect(t).toMatch(/action:"get"/);
      expect(t).toMatch(/stage_output_as_input|upload_image/);
      expect(t).toMatch(/\/view/);
    });

    // The local scan really does read the directory, so it must NOT inherit this
    // hedge — that would make a trustworthy answer look doubtful.
    it("says none of it on a local scan", async () => {
      local();
      listOutputImagesMock.mockResolvedValue(sample);
      const t = text(await getImage()({ action: "list_outputs", limit: 5 }));
      expect(t).toContain("scanned on disk");
      expect(t).not.toMatch(/INCOMPLETE BY CONSTRUCTION/);
      expect(t).not.toMatch(/NOT evidence/);
    });

    it("the json shape still reports the basis for app clients", async () => {
      remote();
      listOutputImagesMock.mockResolvedValue(sample);
      const t = text(await getImage()({ action: "list_outputs", format: "json" }));
      expect(JSON.parse(t).source).toBe("server-history");
    });
  });

  it("format:json returns a machine-readable array (no prose)", async () => {
    listOutputImagesMock.mockResolvedValue(sample);
    const t = text(await getImage()({ action: "list_outputs", limit: 5, format: "json" }));
    const parsed = JSON.parse(t) as { images: Array<Record<string, unknown>> };
    expect(parsed.images).toHaveLength(2);
    expect(parsed.images[0]).toEqual({
      filename: "a.png",
      subfolder: "",
      kind: "image",
      size: 1024,
      modified: "2026-07-22T00:00:00.000Z",
    });
    expect(parsed.images[1]).toMatchObject({ filename: "b.mp4", subfolder: "video", kind: "video" });
  });

  it("format:json with no matches returns an empty array (not a prose message)", async () => {
    listOutputImagesMock.mockResolvedValue([]);
    const t = text(await getImage()({ action: "list_outputs", format: "json" }));
    // The fixture path is properly escaped now: "C:\Comfy\output" in a JS string
    // is `C:Comfyoutput` (\C and \o are not escapes), so the old fixture asserted
    // a Windows path that contained no separators at all.
    expect(JSON.parse(t)).toEqual({ images: [], source: "local-scan", directory: "C:\\Comfy\\output" });
  });

  it("format:json omits size/modified when the scan can't provide them (remote/history path)", async () => {
    listOutputImagesMock.mockResolvedValue([
      { filename: "r.png", path: "", size: 0, modified: "", subfolder: "", kind: "image" },
    ]);
    const t = text(await getImage()({ action: "list_outputs", format: "json" }));
    const parsed = JSON.parse(t) as { images: Array<Record<string, unknown>> };
    expect(parsed.images[0]).toEqual({ filename: "r.png", subfolder: "", kind: "image" });
  });

  it("names the directory in the MARKDOWN listing, so a caller never has to guess it (#899)", async () => {
    // The live failure this fixes: the tool returned bare filenames, an agent
    // reconstructed the path from get_environment's workspace, and that guess is
    // wrong on any install launched with --output-directory — silently, because
    // the filenames look plausible against it.
    listOutputImagesMock.mockResolvedValue([
      { filename: "a.png", path: "", size: 1024, modified: "", subfolder: "", kind: "image" },
    ]);
    const t = text(await getImage()({ action: "list_outputs" }));
    expect(t).toContain("C:\\Comfy\\output");
    expect(t).toContain("scanned on disk");
  });

  it("the empty-markdown message still names the pattern that matched nothing", async () => {
    listOutputImagesMock.mockResolvedValue([]);
    const t = text(await getImage()({ action: "list_outputs", pattern: "fox" }));
    expect(t).toContain('No output media (images or videos) found matching "fox".');
    // …and says WHERE it looked: "nothing found" invites the reader to conclude
    // the file does not exist, which only holds if the directory was right.
    expect(t).toMatch(/scanned on disk/);
  });
});

describe("the ledger", () => {
  const RETIRED: ReadonlyArray<[string, string]> = [
    ["view_image", 'get_image (action:"view")'],
    ["list_output_images", 'get_image (action:"list_outputs")'],
    ["convert_image", 'get_image (action:"convert")'],
    ["analyze_color", 'get_image (action:"analyze_color")'],
    ["list_assets", 'get_image (action:"list_assets")'],
    ["get_asset_metadata", 'get_image (action:"asset_metadata")'],
    ["upload_video", 'upload_image (action:"video")'],
    ["upload_audio", 'upload_image (action:"audio")'],
    ["upload_output", 'upload_image (action:"output")'],
    ["stage_output_as_input", 'upload_image (action:"stage")'],
  ];

  it("declares all ten retired names dead, with the folded call form as the replacement", () => {
    for (const [name, replacement] of RETIRED) {
      const dead = DEAD_NAMES.find((d) => d.name === name);
      expect(dead, name).toBeDefined();
      expect(dead!.since, name).toBe("0.50.0");
      expect(dead!.replacement, name).toBe(replacement);
    }
  });

  it("keeps both survivors registered and every retired name out of the ledger", () => {
    expect(TOOL_NAMES).toContain("get_image");
    expect(TOOL_NAMES).toContain("upload_image");
    for (const [name] of RETIRED) expect(TOOL_NAMES, name).not.toContain(name);
    expect(MAX_TOOLS).toBe(TOOL_NAMES.length);
  });

  it("keeps the surviving names in their original relative order", () => {
    const idx = (n: string) => (TOOL_NAMES as readonly string[]).indexOf(n);
    expect(idx("get_image")).toBeLessThan(idx("upload_image"));
    // The name that used to anchor the far end of this check was retired by
    // 0.50.0 slice 16 (it folded into generate_image), so the anchor moves to
    // the next surviving name after it. The property is unchanged: slice 15's
    // survivors keep their positions relative to the tools around them.
    expect(idx("upload_image")).toBeLessThan(idx("clear_vram"));
  });
});
