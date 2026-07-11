#!/usr/bin/env node
/**
 * Extract city groups from fleet-branch Cidades Atendidas sections and emit
 * service-area-accordion HTML for state hubs.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const root = path.resolve(__dirname, '..');
const fleetBranch = 'ux-remove-fleet-from-booking';

const stateHubs = [
  { file: 'new-jersey-hub.html', fleet: true },
  { file: 'ny-metro-hub.html', fleet: true },
  { file: 'connecticut-hub.html', fleet: true },
  { file: 'pennsylvania-hub.html', fleet: false },
];

function readFleet(file) {
  return execSync(`git show ${fleetBranch}:${file}`, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

function slugToName(slug) {
  return slug
    .replace(/-county$/, ' County')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/New York City/i, 'New York City');
}

function parseFleetSection(html) {
  const counties = [];
  const blockRe =
    /<details[^>]*>[\s\S]*?<h3[^>]*id="([^"]+)"[^>]*>([^<]+)\s*<span[^>]*>\((\d+) cidades\)<\/span>[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const id = m[1];
    const name = m[2].trim();
    const links = [];
    const linkRe = /<a class="cd1-cidades-atendidas__link" href="([^"]+)">([^<]+)<\/a>/g;
    let lm;
    while ((lm = linkRe.exec(m[4])) !== null) {
      links.push({ href: lm[1], text: lm[2].trim() });
    }
    counties.push({ id, name, count: links.length || Number(m[3]), links });
  }
  return counties;
}

function renderAccordion(counties) {
  const items = counties
    .map((county) => {
      const links = county.links
        .map(
          (l) =>
            `          <li><a href="${l.href}">${l.text}</a></li>`
        )
        .join('\n');
      return `      <details class="service-area-accordion" id="${county.id}">
        <summary>
          <span class="service-area-name">${county.name}</span>
          <span class="service-area-count">${county.count} cities</span>
          <span class="service-area-chevron" aria-hidden="true"></span>
        </summary>
        <div class="service-area-content">
          <ul class="service-area-links">
${links}
          </ul>
        </div>
      </details>`;
    })
    .join('\n');

  return `<section class="service-area-section" id="service-areas" aria-labelledby="service-areas-heading">
  <div class="service-area-inner">
    <div class="service-area-intro">
      <div class="service-area-eyebrow">Service Areas</div>
      <h2 class="service-area-heading" id="service-areas-heading">Find Mobile Detailing Near You</h2>
      <p class="service-area-copy">Select your region to view cities and local service pages.</p>
    </div>
    <div class="service-area-accordion-group" data-single-open>
${items}
    </div>
  </div>
</section>`;
}

function paCounties() {
  const cities = [
    { href: '/pennsylvania-hub.html#eastern-pennsylvania', text: 'Philadelphia' },
    { href: '/pennsylvania-hub.html#eastern-pennsylvania', text: 'Allentown' },
    { href: '/pennsylvania-hub.html#eastern-pennsylvania', text: 'King of Prussia' },
    { href: '/pennsylvania-hub.html#eastern-pennsylvania', text: 'Scranton' },
  ];
  return [
    {
      id: 'eastern-pennsylvania',
      name: 'Eastern Pennsylvania',
      count: cities.length,
      links: cities,
    },
  ];
}

function injectSection(html, section) {
  const marker = '\n<!-- FOOTER -->';
  if (!html.includes(marker)) throw new Error('Footer marker not found');
  if (html.includes('service-area-section')) return html;
  return html.replace(marker, `\n${section}\n${marker}`);
}

function addAssets(html) {
  let out = html;
  if (!out.includes('service-area-accordion.css')) {
    out = out.replace(
      '<link rel="stylesheet" href="assets/hub-styles.css">',
      '<link rel="stylesheet" href="assets/hub-styles.css">\n<link rel="stylesheet" href="assets/service-area-accordion.css">'
    );
  }
  if (!out.includes('service-area-accordion.js')) {
    out = out.replace('</body>', '<script src="assets/service-area-accordion.js" defer></script>\n</body>');
  }
  return out;
}

function addHeroContrast(html) {
  return html
    .replace(/<section class="hero (hero--[a-z]{2}) (hub-[a-z]{2})">/g, '<section class="hero $1 $2 hero--contrast">')
    .replace(/<section class="hero (hero--[a-z]{2}) (hub-[a-z]{2}) hero--contrast hero--contrast">/g, '<section class="hero $1 $2 hero--contrast">');
}

for (const hub of stateHubs) {
  const filePath = path.join(root, hub.file);
  let html = fs.readFileSync(filePath, 'utf8');
  const counties = hub.fleet
    ? parseFleetSection(readFleet(hub.file))
    : paCounties();
  if (!counties.length) {
    console.warn(`No counties parsed for ${hub.file}`);
    continue;
  }
  html = injectSection(html, renderAccordion(counties));
  html = addAssets(html);
  html = addHeroContrast(html);
  fs.writeFileSync(filePath, html);
  console.log(`${hub.file}: ${counties.length} accordion groups, ${counties.reduce((n, c) => n + c.links.length, 0)} city links`);
}
