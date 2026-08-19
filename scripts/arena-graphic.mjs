#!/usr/bin/env node
// Render the LLM Arena leaderboard as share/docs-ready SVGs (light + dark).
//
//   node scripts/arena-graphic.mjs [path/to/arena-results.json]
//
// Emits arena-leaderboard-light.svg and arena-leaderboard-dark.svg next to the
// results file. Palette validated with the dataviz six-checks (CVD ΔE ≥ 41,
// dark-surface contrast ≥ 3:1); tier identity is never color-alone — every row
// names its tier in ink.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { graphicAxisHint } from "./arena-report.mjs";

const resultsPath = process.argv[2] ?? join(process.cwd(), "arena-results", "arena-results.json");
const data = JSON.parse(readFileSync(resultsPath, "utf8"));
const rows = data.leaderboard ?? [];
const maxScore = rows[0]?.max ?? 20;

const MODES = {
  light: {
    surface: "#fcfcfb",
    inkPrimary: "#0b0b0b",
    inkSecondary: "#52514e",
    inkMuted: "#898781",
    grid: "#e1e0d9",
    baseline: "#c3c2b7",
    track: "#f0efec",
    tier: { SoTA: "#2a78d6", "B-tier": "#1baf7a", local: "#eda100" },
  },
  dark: {
    surface: "#1a1a19",
    inkPrimary: "#ffffff",
    inkSecondary: "#c3c2b7",
    inkMuted: "#898781",
    grid: "#2c2c2a",
    baseline: "#383835",
    track: "#232322",
    tier: { SoTA: "#3987e5", "B-tier": "#199e70", local: "#c98500" },
  },
};

const FONT = `system-ui, -apple-system, 'Segoe UI', sans-serif`;
const W = 860;
const PAD = 28;
const HEADER_H = 92;
const ROW_H = 34;
const BAR_H = 14;
const LABEL_W = 250; // model name + tier text
const VALUE_W = 90; // right column: score (+ range)
const FOOTER_H = 64;
const plotW = W - PAD * 2 - LABEL_W - VALUE_W;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function render(mode) {
  const c = MODES[mode];
  const H = HEADER_H + rows.length * ROW_H + FOOTER_H;
  const plotX = PAD + LABEL_W;
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`,
    `<rect width="${W}" height="${H}" rx="12" fill="${c.surface}"/>`,
    `<text x="${PAD}" y="${PAD + 10}" font-size="19" font-weight="700" fill="${c.inkPrimary}">ComfyUI LLM Arena</text>`,
    `<text x="${PAD}" y="${PAD + 32}" font-size="12.5" fill="${c.inkSecondary}">${rows.length} models · ${data.scenarios?.length ?? 10} real ComfyUI tasks over MCP · every score verified against the server, not the model's claims</text>`,
  );
  // legend (tier chips + names)
  let lx = PAD;
  for (const [tier, color] of Object.entries(c.tier)) {
    parts.push(
      `<rect x="${lx}" y="${PAD + 44}" width="10" height="10" rx="2" fill="${color}"/>`,
      `<text x="${lx + 15}" y="${PAD + 53}" font-size="11.5" fill="${c.inkSecondary}">${tier}</text>`,
    );
    lx += 15 + tier.length * 6.6 + 22;
  }
  // gridlines + scale ticks
  for (const tick of [0, 5, 10, 15, 20]) {
    const x = plotX + (tick / maxScore) * plotW;
    parts.push(
      `<line x1="${x}" y1="${HEADER_H - 6}" x2="${x}" y2="${HEADER_H + rows.length * ROW_H}" stroke="${tick === 0 ? c.baseline : c.grid}" stroke-width="1"/>`,
      `<text x="${x}" y="${HEADER_H + rows.length * ROW_H + 16}" font-size="10.5" fill="${c.inkMuted}" text-anchor="middle" font-variant-numeric="tabular-nums">${tick}</text>`,
    );
  }
  // rows
  rows.forEach((m, i) => {
    const y = HEADER_H + i * ROW_H;
    const cy = y + ROW_H / 2;
    const color = c.tier[m.tier] ?? c.inkMuted;
    const w = Math.max(2, (m.total / m.max) * plotW);
    const runs = m.runs?.totals;
    const range = runs && runs.length > 1 ? `${Math.min(...runs)}–${Math.max(...runs)}` : null;
    const name = m.model.length > 34 ? `${m.model.slice(0, 33)}…` : m.model;
    const hint = graphicAxisHint(m);
    const sub = hint ? `${m.tier ?? "local"} · ${hint}` : (m.tier ?? "local");
    parts.push(
      `<text x="${PAD}" y="${cy - 1}" font-size="12.5" font-weight="600" fill="${c.inkPrimary}">${esc(name)}</text>`,
      `<text x="${PAD}" y="${cy + 12}" font-size="10" fill="${c.inkSecondary}">${esc(sub)}</text>`,
      // track + bar: thin mark, 4px rounded DATA end only (square baseline end)
      `<rect x="${plotX}" y="${cy - BAR_H / 2}" width="${plotW}" height="${BAR_H}" fill="${c.track}"/>`,
      `<path d="M ${plotX} ${cy - BAR_H / 2} H ${plotX + w - 4} a 4 4 0 0 1 4 4 v ${BAR_H - 8} a 4 4 0 0 1 -4 4 H ${plotX} Z" fill="${color}"/>`,
      `<text x="${plotX + plotW + 12}" y="${cy + 4}" font-size="13" font-weight="700" fill="${c.inkPrimary}" font-variant-numeric="tabular-nums">${m.total}/${m.max}</text>`,
    );
    if (range) {
      parts.push(
        `<text x="${plotX + plotW + 12}" y="${cy + 16}" font-size="9.5" fill="${c.inkMuted}" font-variant-numeric="tabular-nums">best of ${runs.length} (${range})</text>`,
      );
    }
  });
  const fy = HEADER_H + rows.length * ROW_H + 38;
  parts.push(
    `<text x="${PAD}" y="${fy}" font-size="10.5" fill="${c.inkMuted}">${esc(data.gpu ?? "")} · temperature 0 · scenarios: ${esc((data.scenarios ?? []).map((s) => s.id).join(" · "))}</text>`,
    `<text x="${PAD}" y="${fy + 15}" font-size="10.5" fill="${c.inkMuted}">Reproduce with your own models: npm run arena — github.com/artokun/comfyui-mcp</text>`,
    `</svg>`,
  );
  return parts.join("\n");
}

const outDir = dirname(resultsPath);
for (const mode of ["light", "dark"]) {
  const file = join(outDir, `arena-leaderboard-${mode}.svg`);
  writeFileSync(file, render(mode));
  console.log(`wrote ${file}`);
}
