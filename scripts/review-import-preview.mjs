#!/usr/bin/env node
/**
 * Preview an owner-authorized batch of Google or Thumbtack reviews against the
 * stored dataset (assets/customer-reviews.js). Read-only: it never edits the
 * dataset, never fetches anything, and never scrapes. Accepting a review stays
 * a manual, reviewed change to assets/customer-reviews.js.
 *
 *   node scripts/review-import-preview.mjs <batch.json> [--out report.md]
 *
 * Batch format (one platform per batch):
 * {
 *   "authorization": {
 *     "platform": "google" | "thumbtack",
 *     "method": "owner-export" | "owner-api",   // how the owner obtained the data
 *     "reuseConfirmed": true,                     // owner confirmed the platform allows republishing it
 *     "confirmedBy": "owner",
 *     "confirmedAt": "2026-11-20"
 *   },
 *   "reviews": [
 *     { "platform": "google", "platformReviewId": "optional", "name": "…",
 *       "rating": 5, "text": "exact text, unedited", "date": "2026-10-04",
 *       "sourceUrl": "optional official URL" }
 *   ]
 * }
 *
 * An export alone is not permission to republish: without reuseConfirmed the
 * candidates are reported as needing authorization.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const PLATFORMS = ['google', 'thumbtack'];
const METHODS = ['owner-export', 'owner-api'];
const URL_HOSTS = {
  google: [/^(www\.)?google\.com$/, /^maps\.google\.com$/, /^maps\.app\.goo\.gl$/, /^g\.page$/],
  thumbtack: [/^(www\.)?thumbtack\.com$/],
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Case- and whitespace-insensitive body, the same rule the carousel uses to dedupe. */
export function normalizeBody(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function words(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9']+/g, ' ').trim().split(' ').filter(Boolean));
}

function jaccard(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let i = 0;
  for (const w of A) if (B.has(w)) i += 1;
  return i / (A.size + B.size - i);
}

/** "Kasey Wasserbeck" and "Kasey W." share the key "kasey w". */
export function nameKey(name) {
  const parts = String(name || '').toLowerCase().replace(/[^a-z\s.]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const last = parts.length > 1 ? parts[parts.length - 1].replace(/\./g, '').charAt(0) : '';
  return `${parts[0].replace(/\./g, '')} ${last}`.trim();
}

function parseDate(value) {
  const s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return s;
  const m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(?:(\d{1,2}),\s*)?(\d{4})$/);
  if (m && MONTHS.includes(m[1].toLowerCase())) return s;
  return null;
}

function hostAllowed(platform, url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (URL_HOSTS[platform] || []).some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Problems with one candidate's identity and content. Empty means valid. */
export function validateCandidate(c, authPlatform) {
  const problems = [];
  if (!PLATFORMS.includes(c.platform)) problems.push(`platform must be one of ${PLATFORMS.join(', ')}`);
  else if (authPlatform && c.platform !== authPlatform) problems.push(`platform ${c.platform} does not match the authorization (${authPlatform})`);
  if (typeof c.name !== 'string' || !c.name.trim()) problems.push('name is required');
  else if (c.name.length > 100) problems.push('name is longer than 100 characters');
  if (!Number.isInteger(c.rating) || c.rating < 1 || c.rating > 5) problems.push('rating must be an integer from 1 to 5');
  if (typeof c.text !== 'string') problems.push('text must be a string (use "" for a rating-only review)');
  if (!parseDate(c.date)) problems.push('date must be YYYY-MM-DD or a platform form such as "Sep 26, 2026" or "Sep 2026"');
  if (c.sourceUrl != null && !hostAllowed(c.platform, c.sourceUrl)) problems.push('sourceUrl is not an official https URL for this platform');
  return problems;
}

/**
 * Classify each candidate against the existing records. Pure: no I/O.
 * existing: [{ id, name, text, source, date }]
 */
export function previewImport(batch, existing) {
  const auth = (batch && batch.authorization) || {};
  const authProblems = [];
  if (!PLATFORMS.includes(auth.platform)) authProblems.push('authorization.platform must be google or thumbtack');
  if (!METHODS.includes(auth.method)) authProblems.push(`authorization.method must be one of ${METHODS.join(', ')}`);
  if (auth.reuseConfirmed !== true) authProblems.push('authorization.reuseConfirmed is not true: republishing has not been confirmed');
  if (!auth.confirmedBy || !parseDate(auth.confirmedAt)) authProblems.push('authorization needs confirmedBy and a confirmedAt date');
  const authorized = authProblems.length === 0;

  const taken = new Set(existing.map((r) => r.id));
  const seenInBatch = new Map();
  const results = (Array.isArray(batch && batch.reviews) ? batch.reviews : []).map((c, index) => {
    const problems = validateCandidate(c || {}, auth.platform);
    const out = { index, name: c && c.name, platform: c && c.platform, date: c && c.date, status: null, matches: [], problems };
    if (problems.length) { out.status = 'invalid'; return out; }

    const body = normalizeBody(c.text);
    const key = nameKey(c.name);
    for (const r of existing) {
      const sameText = body && normalizeBody(r.text) === body;
      if (r.source === c.platform) {
        if (sameText) out.matches.push({ id: r.id, kind: 'exact-duplicate' });
        else if (nameKey(r.name) === key) out.matches.push({ id: r.id, kind: 'same-platform-same-reviewer', similarity: Number(jaccard(r.text, c.text).toFixed(2)) });
      } else if (sameText || nameKey(r.name) === key || jaccard(r.text, c.text) >= 0.6) {
        out.matches.push({ id: r.id, kind: 'possible-cross-platform-duplicate', source: r.source, similarity: Number(jaccard(r.text, c.text).toFixed(2)) });
      }
    }
    const batchKey = `${c.platform}|${body || key}`;
    if (seenInBatch.has(batchKey)) out.matches.push({ index: seenInBatch.get(batchKey), kind: 'duplicate-within-batch' });
    else seenInBatch.set(batchKey, index);

    if (out.matches.some((m) => m.kind === 'exact-duplicate' || m.kind === 'duplicate-within-batch')) out.status = 'duplicate';
    else if (out.matches.some((m) => m.kind === 'same-platform-same-reviewer')) out.status = 'review-manually';
    else if (!body) out.status = 'rating-only';
    else if (!authorized) out.status = 'needs-authorization';
    else out.status = out.matches.length ? 'eligible-check-cross-platform' : 'eligible';

    if (out.status.startsWith('eligible')) {
      const prefix = c.platform === 'google' ? 'g' : 'tt';
      let id = `${prefix}-${slug(c.name)}`;
      for (let n = 2; taken.has(id); n += 1) id = `${prefix}-${slug(c.name)}-${n}`;
      taken.add(id);
      out.proposedId = id;
    }
    return out;
  });

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return { authorized, authProblems, counts, results };
}

export function reportMarkdown(preview, label) {
  const lines = [`# Review import preview: ${label}`, '', 'Nothing was added. Accepting a review is a manual, reviewed edit to assets/customer-reviews.js.', ''];
  lines.push(`Authorization: ${preview.authorized ? 'confirmed' : 'NOT confirmed'}`);
  for (const p of preview.authProblems) lines.push(`- ${p}`);
  lines.push('', '| # | Name | Platform | Date | Status | Matches / problems | Proposed id |', '|---|---|---|---|---|---|---|');
  for (const r of preview.results) {
    const notes = r.problems.length ? r.problems.join('; ')
      : r.matches.map((m) => `${m.kind} ${m.id || `#${m.index}`}${m.similarity != null ? ` (${m.similarity})` : ''}`).join('; ');
    lines.push(`| ${r.index} | ${r.name || ''} | ${r.platform || ''} | ${r.date || ''} | ${r.status} | ${notes} | ${r.proposedId || ''} |`);
  }
  lines.push('', `Totals: ${Object.entries(preview.counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  return lines.join('\n') + '\n';
}

export function existingReviews(root) {
  const require = createRequire(import.meta.url);
  const api = require(path.join(root, 'assets/customer-reviews.js'));
  return [...api.googleReviews(), ...api.thumbtackReviews(), ...api.legacyReviews()];
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const root = path.resolve(import.meta.dirname, '..');
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/review-import-preview.mjs <batch.json> [--out report.md]'); process.exit(2); }
  let batch;
  try { batch = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`cannot read ${file}: ${e.message}`); process.exit(2); }
  const preview = previewImport(batch, existingReviews(root));
  const md = reportMarkdown(preview, path.basename(file));
  const outIdx = process.argv.indexOf('--out');
  if (outIdx > 0 && process.argv[outIdx + 1]) fs.writeFileSync(process.argv[outIdx + 1], md);
  else process.stdout.write(md);
}
