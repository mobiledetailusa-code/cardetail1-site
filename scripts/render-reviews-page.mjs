#!/usr/bin/env node
/**
 * Pre-render the static review cards and the official source links into
 * reviews.html, so the page carries its reviews without running JavaScript.
 *
 * The cards come from assets/customer-reviews.js: the same data, the same order
 * (mixed()) and the same markup (cardHtml with full: true) that the page's
 * script paints at runtime. On load, CD1CustomerReviews.mount() replaces the
 * #rv-grid contents with identical cards, so nothing is duplicated and nothing
 * shifts. First-party reviews from /.netlify/functions/public-reviews are not
 * pre-rendered; the script adds them at runtime exactly as before.
 *
 * Only two marked regions of reviews.html are written. No network access.
 *
 *   node scripts/render-reviews-page.mjs          # write reviews.html
 *   node scripts/render-reviews-page.mjs --check  # exit 1 if reviews.html drifts
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const checkOnly = process.argv.includes('--check');
const PAGE = path.join(root, 'reviews.html');

const CARDS_START = '<!-- generated:review-cards (scripts/render-reviews-page.mjs) -->';
const CARDS_END = '<!-- /generated:review-cards -->';
const SOURCES_START = '<!-- generated:review-sources (scripts/render-reviews-page.mjs) -->';
const SOURCES_END = '<!-- /generated:review-sources -->';

/** Load the review module in isolation, so no first-party items are mixed in. */
export function loadReviews() {
  const require = createRequire(import.meta.url);
  const file = path.join(root, 'assets/customer-reviews.js');
  delete require.cache[require.resolve(file)];
  return require(file);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderCards(api) {
  const list = api.mixed();
  return list.map((review) => api.cardHtml(review, { full: true })).join('\n    ');
}

export function renderSources(api) {
  const links = ['google', 'thumbtack'].map((key) => {
    const p = api.SOURCE_PROFILES[key];
    return `<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.label)}<span class="rv-vh"> (opens in a new tab)</span></a>`;
  });
  return `<p class="rv-page-lead rv-page-sources">Read every review on the official listings: ${links.join(' · ')}</p>`;
}

/** Return reviews.html with both regions rendered. Throws if an anchor is missing. */
export function renderPage(src, api) {
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  let out = src.replace(/\r\n/g, '\n');

  const gridOpen = '<div class="rv-grid" id="rv-grid">';
  const g = out.indexOf(gridOpen);
  if (g < 0) throw new Error('reviews.html: #rv-grid not found');
  const bodyStart = g + gridOpen.length;
  let gEnd;
  if (out.startsWith(CARDS_START, out.indexOf('<', bodyStart))) {
    // Already rendered: the grid closes right after the end marker.
    const m = out.indexOf(CARDS_END, bodyStart);
    if (m < 0) throw new Error('reviews.html: review-cards region is not closed');
    gEnd = out.indexOf('</div>', m + CARDS_END.length);
  } else {
    gEnd = out.indexOf('</div>', bodyStart);
    if (out.slice(bodyStart, gEnd).trim()) {
      throw new Error('reviews.html: #rv-grid has hand-written content; refusing to overwrite it');
    }
  }
  if (gEnd < 0) throw new Error('reviews.html: #rv-grid is not closed');
  const cards = `\n    ${CARDS_START}\n    ${renderCards(api)}\n    ${CARDS_END}\n  `;
  out = out.slice(0, g + gridOpen.length) + cards + out.slice(gEnd);

  const sources = `${SOURCES_START}\n  ${renderSources(api)}\n  ${SOURCES_END}`;
  const s0 = out.indexOf(SOURCES_START);
  if (s0 >= 0) {
    const s1 = out.indexOf(SOURCES_END, s0);
    if (s1 < 0) throw new Error('reviews.html: review-sources region is not closed');
    out = out.slice(0, s0) + sources + out.slice(s1 + SOURCES_END.length);
  } else {
    const anchor = '\n  <div class="rv-page-actions">';
    if (!out.includes(anchor)) throw new Error('reviews.html: .rv-page-actions anchor not found');
    out = out.replace(anchor, `\n  ${sources}\n${anchor}`);
  }
  return nl === '\r\n' ? out.replace(/\n/g, '\r\n') : out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const api = loadReviews();
  const current = fs.readFileSync(PAGE, 'utf8');
  const next = renderPage(current, api);
  if (checkOnly) {
    if (next !== current) {
      console.error('reviews.html drifted from assets/customer-reviews.js. Run: node scripts/render-reviews-page.mjs');
      process.exit(1);
    }
    console.log(`reviews.html: ${api.mixed().length} pre-rendered cards match assets/customer-reviews.js`);
  } else {
    fs.writeFileSync(PAGE, next);
    console.log(next === current ? 'reviews.html: unchanged' : `reviews.html: rendered ${api.mixed().length} cards and source links`);
  }
}
