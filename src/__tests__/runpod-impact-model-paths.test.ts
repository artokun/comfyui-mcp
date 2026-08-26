// #2302 — the RunPod image's extra_model_paths.yaml mapped ~25 model categories onto the
// /workspace network volume but omitted the four that ComfyUI-Impact-Pack and
// ComfyUI-Impact-Subpack register for THEMSELVES at import time. Those categories therefore
// resolved only to the in-image /opt/ComfyUI/models/<cat>, so a FaceDetailer user's YOLO and
// SAM weights were written to the ephemeral image layer: the download reported success, the
// node resolved, and the file was silently gone after the next pod rebuild.
//
// This file is a DATA pin, not a behaviour test — the yaml is baked into a Docker image and
// consumed by ComfyUI's python, so nothing in this package ever executes it. What a test CAN
// do is hold the two facts that made the bug possible:
//
//   1. the four keys are present, and mapped relative to base_path (delete either and the
//      first describe below goes red);
//   2. post_start.sh's cold-volume `mkdir -p` list still covers every category the yaml maps.
//      That list is a SECOND copy of the same category set — its own comment says it exists
//      for "the model category subfolders that extra_model_paths.yaml maps" — and a fix that
//      updated only the yaml would leave the two silently out of step. Checking parity by
//      parsing both files catches the whole drift class, not just this instance of it.
//
// Deliberately directional: the assertion is yaml ⊆ post_start.sh. A category the yaml maps
// but the volume never gets a directory for is the defect; an extra directory in the shell
// list is harmless, and pinning exact equality would make an unrelated addition fail here.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const yamlSrc = readFileSync(
  new URL("../../docker/runpod/extra_model_paths.yaml", import.meta.url),
  "utf-8",
);
const postStartSrc = readFileSync(
  new URL("../../docker/runpod/post_start.sh", import.meta.url),
  "utf-8",
);
const readmeSrc = readFileSync(new URL("../../docker/runpod/README.md", import.meta.url), "utf-8");

const block = (parseYaml(yamlSrc) as Record<string, Record<string, unknown>>)
  .comfyui_mcp_volume;

/**
 * Every directory the yaml maps, expressed relative to `<base_path>/models` — i.e. exactly
 * the `sub` values post_start.sh iterates. Multi-line block scalars (`text_encoders` maps
 * both text_encoders/ and clip/) contribute one entry per line.
 */
const mappedSubdirs = (): string[] => {
  const dirs: string[] = [];
  for (const [key, value] of Object.entries(block)) {
    if (key === "base_path" || key === "is_default") continue;
    for (const line of String(value).split("\n")) {
      const entry = line.trim();
      if (entry === "") continue;
      // base_path only applies to RELATIVE values; an absolute one would silently escape
      // the volume, which is the same class of failure as omitting the key entirely.
      expect(entry.startsWith("models/"), `${key} -> ${entry}`).toBe(true);
      dirs.push(entry.slice("models/".length).replace(/\/$/, ""));
    }
  }
  return dirs;
};

describe("the RunPod image maps Impact Pack's model categories onto the volume (#2302)", () => {
  it("keeps the volume the DEFAULT target for every mapped category", () => {
    // Without both of these the whole file is decorative: base_path is what makes the
    // relative values land on the network volume, and is_default is what puts them at the
    // FRONT of each category's folder list, ahead of the in-image /opt/ComfyUI/models/<cat>.
    expect(block.base_path).toBe("/workspace");
    expect(block.is_default).toBe(true);
  });

  it("maps the four categories Impact Pack / Impact Subpack register themselves", () => {
    // Subpack registers ultralytics, ultralytics_bbox and ultralytics_segm; Pack registers
    // sams (SAMLoader, which feeds FaceDetailer's sam_model_opt). The bbox case and the sam
    // case are hit back to back by the same user, so all four belong together.
    expect(block.ultralytics).toBe("models/ultralytics/");
    expect(block.ultralytics_bbox).toBe("models/ultralytics/bbox/");
    expect(block.ultralytics_segm).toBe("models/ultralytics/segm/");
    expect(block.sams).toBe("models/sams/");
  });

  it("pre-creates every mapped category on a cold volume", () => {
    const loop = postStartSrc.match(/for sub in ([\s\S]*?); do/);
    // If post_start.sh's loop is ever restructured this must fail loudly rather than
    // silently assert nothing — an unparsed list would otherwise read as full coverage.
    expect(loop, "post_start.sh no longer has a parsable `for sub in ...; do` list").not.toBe(
      null,
    );

    const created = new Set(
      (loop as RegExpMatchArray)[1]
        .replace(/\\\s*\n/g, " ")
        .trim()
        .split(/\s+/)
        .filter((s) => s !== ""),
    );
    expect(created.size).toBeGreaterThan(20);

    const missing = mappedSubdirs().filter((dir) => !created.has(dir));
    expect(missing, "extra_model_paths.yaml maps these, post_start.sh never mkdirs them").toEqual(
      [],
    );
  });

  it("points the node packs' OWN installers at the volume too", () => {
    // The yaml adds SEARCH paths; it does not move `folder_paths.models_dir`, and that is
    // what both packs' install.py resolve their download directory from. Impact Subpack's
    // has no folder_paths fallback at all (install.py:15-17), so with COMFYUI_MODEL_PATH
    // unset it writes face_yolov8m.pt to the image layer no matter what this yaml maps —
    // every mapping above can be correct and the file still dies on the next rebuild.
    const exported = postStartSrc.search(/^export COMFYUI_MODEL_PATH="\$\{MODELS_DIR\}"\r?$/m);
    expect(exported, "post_start.sh must export COMFYUI_MODEL_PATH at top level").toBeGreaterThan(
      -1,
    );

    // Ordering IS the mechanism, so assert on it rather than on the line's existence:
    // MODELS_DIR must already be set, and the export must happen before ComfyUI launches,
    // since Manager runs pack installers as children of that process and they inherit it.
    const modelsDir = postStartSrc.search(/^MODELS_DIR=/m);
    const launch = postStartSrc.search(/^nohup .*main\.py/m);
    expect(modelsDir, "MODELS_DIR assignment not found").toBeGreaterThan(-1);
    expect(launch, "ComfyUI launch line not found").toBeGreaterThan(-1);
    expect(modelsDir).toBeLessThan(exported);
    expect(exported).toBeLessThan(launch);
  });

  it("makes ComfyUI Manager's explicit save_path writes use the volume root", () => {
    // managerModelDestination() deliberately sends a relative `save_path` for nested
    // destinations and categories without a Manager type-map entry. Manager resolves
    // those relative paths under folder_paths.models_dir, which is NOT changed by
    // extra_model_paths.yaml's is_default flag. The launch flag is therefore the
    // production proof that e.g. `diffusers/foo` cannot fall back to /opt/ComfyUI/models.
    const modelsFlag = postStartSrc.search(
      /^\s+--models-directory "\$\{MODELS_DIR\}"\r?$/m,
    );
    expect(modelsFlag, "ComfyUI must launch with the persistent models root").toBeGreaterThan(-1);

    const argsStart = postStartSrc.search(/^ARGS=\(/m);
    const extraFlag = postStartSrc.indexOf("--extra-model-paths-config");
    const launch = postStartSrc.search(/^nohup .*main\.py/m);
    expect(argsStart).toBeGreaterThan(-1);
    expect(extraFlag).toBeGreaterThan(-1);
    expect(launch).toBeGreaterThan(-1);
    expect(argsStart).toBeLessThan(modelsFlag);
    expect(modelsFlag).toBeLessThan(launch);
    expect(extraFlag).toBeLessThan(launch);
  });

  it("documents the same category set it ships", () => {
    // README.md embeds a full copy of the yaml under "Model paths". That copy is what a
    // maintainer reads when adding the NEXT category, so a stale one does not just mislead —
    // it reproduces this bug. Compare key sets, not text: the README annotates its copy with
    // inline comments and those must stay free to change.
    const fenced = readmeSrc.match(/```yaml\r?\n(comfyui_mcp_volume:[\s\S]*?)```/);
    expect(fenced, "README.md no longer embeds a ```yaml comfyui_mcp_volume block").not.toBe(null);

    const documented = (
      parseYaml((fenced as RegExpMatchArray)[1]) as Record<string, Record<string, unknown>>
    ).comfyui_mcp_volume;
    expect(Object.keys(documented).sort()).toEqual(Object.keys(block).sort());
  });
});
