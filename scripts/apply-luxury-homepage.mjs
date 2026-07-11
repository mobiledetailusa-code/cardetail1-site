import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const luxuryRoot = `:root{
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

const indexPath = path.join(root, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');

html = html.replace(
  /:root\{\s*--bg0:#f4f6f9[\s\S]*?--rx:20px;\s*\}/,
  luxuryRoot
);

html = html.replace('<body>', '<body class="luxury-surface">');

html = html.replace(
  /<section class="hero">\s*<div class="hero-inner">/,
  `<section class="hero hero--luxury hero--home luxury-hero-glow">
  <div class="hero-bg-desktop" aria-hidden="true"></div>
  <div class="hero-bg-mobile" aria-hidden="true"></div>
  <div class="hero-inner">`
);

if (!html.includes('luxury-theme.css')) {
  html = html.replace(
    '<link rel="stylesheet" href="assets/public-surface-contrast.css">',
    `<link rel="stylesheet" href="assets/public-surface-contrast.css">
<link rel="stylesheet" href="assets/hub-styles.css">
<link rel="stylesheet" href="assets/luxury-theme.css">`
  );
}

fs.writeFileSync(indexPath, html);
console.log('luxury theme applied: index.html');

// Point state hubs at luxury-theme.css (rename from hub-luxury-theme.css)
const hubs = [
  'new-jersey-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
];

for (const file of hubs) {
  const filePath = path.join(root, file);
  let hub = fs.readFileSync(filePath, 'utf8');
  hub = hub.replace(/hub-luxury-theme\.css/g, 'luxury-theme.css');
  if (!hub.includes('class="luxury-surface"')) {
    hub = hub.replace('<body>', '<body class="luxury-surface">');
  }
  hub = hub.replace(
    /class="hero (hero--(?:nj|ny|ct|pa)) (hub-(?:nj|ny|ct|pa)) hero--contrast"/g,
    'class="hero $1 $2 hero--contrast hero--luxury luxury-hero-glow"'
  );
  fs.writeFileSync(filePath, hub);
  console.log(`updated stylesheet ref: ${file}`);
}
