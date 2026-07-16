#!/usr/bin/env node
/**
 * Sync PRICING.rvs + LENGTH_PRICING.rvs blocks from index.html to booking pages.
 * Idempotent: second run produces zero diff.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const TARGETS = [
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

function extractRvsPricingBlock(html) {
  const start = html.search(/\n  rvs:\s*\{/);
  if (start < 0) throw new Error('PRICING.rvs block not found');
  // Find matching close before powersports:
  const after = html.slice(start);
  const endRel = after.search(/\n  powersports:\s*\{/);
  if (endRel < 0) throw new Error('powersports marker not found after rvs');
  return after.slice(0, endRel);
}

function extractRvsLengthBlock(html) {
  const marker = html.match(/\n  rvs:\s*\{\s*\n\s*min:\s*12,\s*max:\s*45/);
  if (!marker) throw new Error('LENGTH_PRICING.rvs block not found');
  const start = marker.index;
  const after = html.slice(start);
  const endRel = after.search(/\n  fleet:\s*\{/);
  if (endRel < 0) throw new Error('fleet marker not found after LENGTH rvs');
  return after.slice(0, endRel);
}

function replaceRvsPricing(html, block) {
  const start = html.search(/\n  rvs:\s*\{/);
  if (start < 0) throw new Error('target missing PRICING.rvs');
  const after = html.slice(start);
  const endRel = after.search(/\n  powersports:\s*\{/);
  if (endRel < 0) throw new Error('target missing powersports after rvs');
  return html.slice(0, start) + block + html.slice(start + endRel);
}

function replaceRvsLength(html, block) {
  const marker = html.match(/\n  rvs:\s*\{\s*\n\s*min:\s*12,\s*max:\s*45/);
  if (!marker) throw new Error('target missing LENGTH_PRICING.rvs');
  const start = marker.index;
  const after = html.slice(start);
  const endRel = after.search(/\n  fleet:\s*\{/);
  if (endRel < 0) throw new Error('target missing fleet after LENGTH rvs');
  return html.slice(0, start) + block + html.slice(start + endRel);
}

async function main() {
  const index = await readFile(join(ROOT, 'index.html'), 'utf8');
  const pricingBlock = extractRvsPricingBlock(index);
  const lengthBlock = extractRvsLengthBlock(index);
  let changed = 0;
  for (const file of TARGETS) {
    const path = join(ROOT, file);
    let html = await readFile(path, 'utf8');
    const orig = html;
    html = replaceRvsPricing(html, pricingBlock);
    html = replaceRvsLength(html, lengthBlock);
    if (html !== orig) {
      await writeFile(path, html);
      changed += 1;
      console.log('updated', file);
    } else {
      console.log('unchanged', file);
    }
  }
  console.log(`sync-rv-pricing-blocks: ${changed} file(s) changed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
