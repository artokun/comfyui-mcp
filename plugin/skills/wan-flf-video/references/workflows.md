# WAN 2.2 FLF — complete API-JSON workflow

Bulky copy-paste material split out of [`../SKILL.md`](../SKILL.md). Read that
first for the dual Hi-Lo architecture, model pairs and sampler settings; come here
when you need the full graph to build from.

## Contents

- [Complete Workflow: Native FLF (Remix NSFW + Lightning)](#complete-workflow-native-flf-remix-nsfw--lightning): the full dual Hi-Lo two-pass graph

## Complete Workflow: Native FLF (Remix NSFW + Lightning)

```json
{
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp16_v2.1.safetensors", "weight_dtype": "default" }, "_meta": { "title": "UNET HighNoise" }},
  "2": { "class_type": "UNETLoader", "inputs": { "unet_name": "Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp16_v2.1.safetensors", "weight_dtype": "default" }, "_meta": { "title": "UNET LowNoise" }},
  "3": { "class_type": "CLIPLoaderGGUF", "inputs": { "clip_name": "nsfw_wan_umt5-xxl_bf16_fixed.safetensors", "type": "wan" }},
  "4": { "class_type": "CLIPVisionLoader", "inputs": { "clip_name": "clip_vision_h.safetensors" }},
  "5": { "class_type": "VAELoader", "inputs": { "vae_name": "wan_2.1_vae.safetensors" }},
  "6": { "class_type": "LoadImage", "inputs": { "image": "<start_image.png>" }, "_meta": { "title": "Start Frame" }},
  "7": { "class_type": "LoadImage", "inputs": { "image": "<end_image.png>" }, "_meta": { "title": "End Frame" }},
  "8": { "class_type": "ModelSamplingSD3", "inputs": { "model": ["1", 0], "shift": 5 }, "_meta": { "title": "Hi Shift" }},
  "9": { "class_type": "ModelSamplingSD3", "inputs": { "model": ["2", 0], "shift": 5 }, "_meta": { "title": "Lo Shift" }},
  "10": { "class_type": "Lora Loader Stack (rgthree)", "inputs": {
    "model": ["8", 0], "clip": ["3", 0],
    "lora_01": "None", "strength_01": 1, "lora_02": "None", "strength_02": 1,
    "lora_03": "None", "strength_03": 1, "lora_04": "None", "strength_04": 1
  }, "_meta": { "title": "Hi Common" }},
  "11": { "class_type": "Lora Loader Stack (rgthree)", "inputs": {
    "model": ["10", 0], "clip": ["10", 1],
    "lora_01": "None", "strength_01": 1, "lora_02": "None", "strength_02": 1,
    "lora_03": "None", "strength_03": 1, "lora_04": "None", "strength_04": 1
  }, "_meta": { "title": "Hi Lora" }},
  "12": { "class_type": "Lora Loader Stack (rgthree)", "inputs": {
    "model": ["9", 0], "clip": ["3", 0],
    "lora_01": "None", "strength_01": 1, "lora_02": "None", "strength_02": 1,
    "lora_03": "None", "strength_03": 1, "lora_04": "None", "strength_04": 1
  }, "_meta": { "title": "Low Common" }},
  "13": { "class_type": "Lora Loader Stack (rgthree)", "inputs": {
    "model": ["12", 0], "clip": ["12", 1],
    "lora_01": "None", "strength_01": 1, "lora_02": "None", "strength_02": 1,
    "lora_03": "None", "strength_03": 1, "lora_04": "None", "strength_04": 1
  }, "_meta": { "title": "Low Lora" }},
  "14": { "class_type": "ImageResizeKJv2", "inputs": {
    "image": ["6", 0], "width": 480, "height": 720,
    "upscale_method": "nearest-exact", "keep_proportion": "crop",
    "pad_color": "0, 0, 0", "crop_position": "center", "divisible_by": 2
  }, "_meta": { "title": "Resize Start" }},
  "15": { "class_type": "ImageResizeKJv2", "inputs": {
    "image": ["7", 0], "width": ["14", 1], "height": ["14", 2],
    "upscale_method": "nearest-exact", "keep_proportion": "crop",
    "pad_color": "0, 0, 0", "crop_position": "center", "divisible_by": 2
  }, "_meta": { "title": "Resize End" }},
  "16": { "class_type": "CLIPVisionEncode", "inputs": { "clip_vision": ["4", 0], "image": ["14", 0], "crop": "center" }},
  "17": { "class_type": "CLIPVisionEncode", "inputs": { "clip_vision": ["4", 0], "image": ["15", 0], "crop": "center" }},
  "18": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["11", 1], "text": "<positive prompt>" }, "_meta": { "title": "Positive" }},
  "19": { "class_type": "CLIPTextEncode", "inputs": { "clip": ["11", 1], "text": "The tones are vibrant, overexposed, static, details are unclear, subtitles, style, work, painting, image, still, overall grayish, worst quality, low quality, JPEG compression artifacts, ugly, incomplete, extra fingers, poorly drawn hands, poorly drawn faces, deformed, disfigured, distorted limbs, merged fingers, motionless image, cluttered background, three legs, many people in the background, walking backwards" }, "_meta": { "title": "Negative" }},
  "20": { "class_type": "WanFirstLastFrameToVideo", "inputs": {
    "positive": ["18", 0], "negative": ["19", 0], "vae": ["5", 0],
    "clip_vision_start_image": ["16", 0], "clip_vision_end_image": ["17", 0],
    "start_image": ["14", 0], "end_image": ["15", 0],
    "width": ["15", 1], "height": ["15", 2], "length": 81, "batch_size": 1
  }},
  "21": { "class_type": "KSamplerAdvanced", "inputs": {
    "model": ["11", 0], "positive": ["20", 0], "negative": ["20", 1], "latent_image": ["20", 2],
    "add_noise": "enable", "noise_seed": 0, "steps": 4, "cfg": 1,
    "sampler_name": "uni_pc", "scheduler": "beta",
    "start_at_step": 0, "end_at_step": 2, "return_with_leftover_noise": "enable"
  }, "_meta": { "title": "Hi Pass" }},
  "22": { "class_type": "KSamplerAdvanced", "inputs": {
    "model": ["13", 0], "positive": ["20", 0], "negative": ["20", 1], "latent_image": ["21", 0],
    "add_noise": "disable", "noise_seed": 0, "steps": 4, "cfg": 1,
    "sampler_name": "uni_pc", "scheduler": "beta",
    "start_at_step": 2, "end_at_step": 4, "return_with_leftover_noise": "disable"
  }, "_meta": { "title": "Lo Pass" }},
  "23": { "class_type": "VAEDecode", "inputs": { "samples": ["22", 0], "vae": ["5", 0] }},
  "24": { "class_type": "VHS_VideoCombine", "inputs": {
    "images": ["23", 0], "frame_rate": 16, "loop_count": 0,
    "filename_prefix": "wan_flf", "format": "video/h264-mp4",
    "pingpong": false, "save_output": true,
    "pix_fmt": "yuv420p", "crf": 19, "save_metadata": true, "trim_to_audio": false
  }}
}
```
