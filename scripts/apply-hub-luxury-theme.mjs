import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const hubs = [
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
];

const oldRoot = `/* === STATE HUB LIGHT THEME (synced from homepage) === */
:root{
  --bg0:#f4f6f9;--bg1:#ffffff;--bg2:#eef2f7;--bg3:#e4eaf2;--bg4:#d8e0ea;
  --ink:#1e293b;--ink-soft:#475569;
  --dark:#17212f;--dark-soft:#243044;
  --blue:#2563eb;--blue-hover:#1d4ed8;--bdim:rgba(37,99,235,.08);--bbr:rgba(37,99,235,.22);
  --white:#ffffff;--mu:#64748b;--tx:#334155;
  --gr:#16a34a;--grdim:rgba(22,163,74,.10);--grbr:rgba(22,163,74,.28);
  --am:#d97706;--amdim:rgba(217,119,6,.10);--ambr:rgba(217,119,6,.28);
  --rd:#dc2626;--rddim:rgba(220,38,38,.10);
  --gold:#ca8a04;
  --line:rgba(15,23,42,.08);--line-strong:rgba(15,23,42,.14);
  --shadow-sm:0 1px 3px rgba(15,23,42,.06);--shadow-md:0 8px 24px rgba(15,23,42,.08);
  --fd:'Bebas Neue',sans-serif;--fb:'DM Sans',sans-serif;
  --r:16px;--rs:12px;--rx:20px;
}`;

const newRoot = `/* === STATE HUB LUXURY THEME — Midnight Slate & Champagne === */
:root{
  --bg0:#12181f;--bg1:#1a222c;--bg2:#222c38;--bg3:#2a3544;--bg4:#323f50;
  --ink:#ece8e1;--ink-soft:#9aa8b8;
  --dark:#0a0e14;--dark-soft:#12181f;
  --blue:#4d8fd9;--blue-hover:#3a7bc8;--bdim:rgba(77,143,217,.12);--bbr:rgba(77,143,217,.28);
  --white:#ece8e1;--mu:#8b97a8;--tx:#c8d0da;
  --gr:#34c759;--grdim:rgba(52,199,89,.12);--grbr:rgba(52,199,89,.28);
  --am:#d4a054;--amdim:rgba(212,160,84,.12);--ambr:rgba(212,160,84,.28);
  --rd:#ef4444;--rddim:rgba(239,68,68,.12);
  --gold:#c4a574;--gold-dim:rgba(196,165,116,.12);--gold-br:rgba(196,165,116,.28);
  --line:rgba(196,165,116,.1);--line-strong:rgba(196,165,116,.18);
  --shadow-sm:0 2px 8px rgba(0,0,0,.22);--shadow-md:0 12px 32px rgba(0,0,0,.32);
  --fd:'Bebas Neue',sans-serif;--fb:'DM Sans',sans-serif;
  --r:16px;--rs:12px;--rx:20px;
}`;

const oldHeroLine =
  '.hero--nj,.hero--ny,.hero--ct,.hero--pa,.hub-nj,.hub-ny,.hub-ct,.hub-pa{background:transparent!important;min-height:60vh!important;padding:88px 20px 48px!important;border-bottom:1px solid var(--line)!important;text-align:center!important;position:relative!important;overflow:hidden!important}';

const newHeroLine =
  '.hero--nj,.hero--ny,.hero--ct,.hero--pa,.hub-nj,.hub-ny,.hub-ct,.hub-pa{background:#12181f!important;min-height:60vh!important;padding:88px 20px 48px!important;border-bottom:1px solid rgba(196,165,116,.12)!important;text-align:center!important;position:relative!important;overflow:hidden!important}';

const luxuryLink =
  '<link rel="stylesheet" href="assets/hub-luxury-theme.css">';

for (const file of hubs) {
  const filePath = path.join(root, file);
  let html = fs.readFileSync(filePath, 'utf8');
  html = html.replace(
    /\/\* === STATE HUB LIGHT THEME[\s\S]*?:root\{[\s\S]*?--rx:20px;\s*\}/,
    newRoot
  );
  html = html.replace(oldHeroLine, newHeroLine);
  if (!html.includes('hub-luxury-theme.css')) {
    html = html.replace(
      '<link rel="stylesheet" href="assets/service-area-accordion.css">',
      `<link rel="stylesheet" href="assets/service-area-accordion.css">\n${luxuryLink}`
    );
    if (!html.includes('hub-luxury-theme.css')) {
      html = html.replace(
        '<link rel="stylesheet" href="assets/hub-styles.css">',
        `<link rel="stylesheet" href="assets/hub-styles.css">\n${luxuryLink}`
      );
    }
  }
  if (!html.includes('STATE HUB LUXURY THEME')) {
    console.warn(`skip ${file}: root block not replaced`);
    continue;
  }
  fs.writeFileSync(filePath, html);
  console.log(`luxury theme applied: ${file}`);
}
