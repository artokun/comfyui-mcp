# ComfyUI MCP — documentation

[Mintlify](https://mintlify.com) docs for `comfyui-mcp`. Config lives in `docs.json`.

## Local preview

```bash
cd docs
npx mint dev        # http://localhost:3000
```

## The Tool Reference is generated

The pages under `tools/` and the **Tool Reference** navigation tab are generated from the
**live MCP tool schemas** — do not edit them by hand. After changing tools, run from the repo
root:

```bash
npm run docs:gen
```

then commit the result. The generator (`scripts/gen-tool-docs.ts`) boots the MCP server with a
capturing mock, reads each tool's name/description/zod schema, and emits one MDX page per
category plus the matching `navigation` tab in `docs.json`.

## Images / examples

The generated **tool reference** pages carry no screenshots — a placeholder image per tool is
noise, not clarity. Narrative pages may still use a `<Frame>` with `images/placeholder.svg`;
drop a real image under `images/` and update the `src` when available.
Example payloads in the tool reference are generated skeletons (the "Example coming soon" note).

Video goes in `videos/` with a poster still in `images/`, as the home hero does. **Mintlify
refuses any file over 20 MB**, so re-encode a raw screen capture before committing it — the
hero's 76s 1080p source was 130 MB and lands at ~5.5 MB with
`-an -c:v libx264 -crf 20 -movflags +faststart` (its audio track was digital silence, so
dropping it also lets the clip autoplay). Keep `+faststart` — without it the browser must
download the whole file before the first frame paints.

## Deploy

Hosted by Mintlify via its GitHub app — it auto-deploys on push to the default branch (and
creates preview deployments for PRs).
