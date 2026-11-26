// Review preservation, attribution, crawlable rendering and import safety.
// The snapshot fixture is the 2026-11-17 baseline (master 625eb830). It must not
// be edited to make a test pass: a failure here means a historical review changed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const reviews = require('../assets/customer-reviews.js');
const SNAPSHOT = JSON.parse(read('tests/fixtures/reviews-snapshot-2026-11-17.json'));
const { JSDOM } = (() => {
  try { return { JSDOM: require('jsdom').JSDOM }; } catch { return { JSDOM: null }; }
})();

const stored = () => [...reviews.googleReviews(), ...reviews.thumbtackReviews(), ...reviews.legacyReviews()];
const importMod = () => import(pathToFileURL(path.join(root, 'scripts/review-import-preview.mjs')).href);
const renderMod = () => import(pathToFileURL(path.join(root, 'scripts/render-reviews-page.mjs')).href);
const PUBLIC_PAGES = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
const GOOGLE_PROFILE = 'https://www.google.com/maps?cid=9369648502260133938';
const THUMBTACK_PROFILE = 'https://www.thumbtack.com/nj/palisades-park/mobile-auto-detailing-services/cardetail1/service/568247975711367170';

// ── 1–3, 5–6: preservation ────────────────────────────────────────────────
test('snapshot holds the 25 historical reviews: 12 Google, 6 Thumbtack, 7 legacy', () => {
  assert.equal(SNAPSHOT.reviews.length, 25);
  assert.deepEqual(SNAPSHOT.counts, { google: 12, thumbtack: 6, legacy: 7, total: 25 });
  assert.equal(new Set(SNAPSHOT.reviews.map((r) => r.id)).size, 25, 'snapshot ids are unique');
});

test('every historical review still exists with identical id, name, text, rating, date and fields', () => {
  const byId = new Map(stored().map((r) => [r.id, r]));
  for (const snap of SNAPSHOT.reviews) {
    const cur = byId.get(snap.id);
    assert.ok(cur, `review ${snap.id} (${snap.name}) was deleted`);
    const { sourceLabel, ...fields } = snap;
    for (const [key, value] of Object.entries(fields)) {
      assert.deepEqual(cur[key], value, `${snap.id}.${key} changed`);
    }
    assert.deepEqual(Object.keys(cur).sort(), Object.keys(fields).sort(), `${snap.id}: fields added to or removed from the record`);
  }
});

test('the displayed source label of every historical review is unchanged', () => {
  for (const snap of SNAPSHOT.reviews) {
    const cur = stored().find((r) => r.id === snap.id);
    assert.equal(reviews.sourceLabel(cur), snap.sourceLabel, `${snap.id} label`);
  }
  assert.ok(SNAPSHOT.reviews.filter((r) => r.source === 'legacy').every((r) => r.sourceLabel === 'Customer'));
});

test('group counts and order are unchanged', () => {
  assert.equal(reviews.googleReviews().length, 12);
  assert.equal(reviews.thumbtackReviews().length, 6);
  assert.equal(reviews.legacyReviews().length, 7);
  assert.deepEqual(stored().map((r) => r.id), SNAPSHOT.reviews.map((r) => r.id));
});

test('ratings are integers 1–5 and dates are present', () => {
  for (const r of stored()) {
    assert.ok(Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5, `${r.id} rating`);
    assert.ok(String(r.date || '').trim(), `${r.id} date`);
  }
});

// ── 4: duplicates ─────────────────────────────────────────────────────────
test('no two stored reviews share a body; the carousel shows all 25', () => {
  const bodies = stored().map((r) => r.text.toLowerCase().replace(/\s+/g, ' ').trim());
  assert.equal(new Set(bodies).size, 25);
  reviews.applyPortalItems([]);
  assert.equal(reviews.mixed().length, 25);
});

test('cross-platform reviewers are detected but never merged', async () => {
  const { nameKey } = await importMod();
  const g = reviews.googleReviews();
  const t = reviews.thumbtackReviews();
  const pairs = [];
  for (const a of g) for (const b of t) if (nameKey(a.name) === nameKey(b.name)) pairs.push(`${a.id}|${b.id}`);
  assert.deepEqual(pairs.sort(), ['g-carol-gladis|tt-carol-g', 'g-kasey-wasserbeck|tt-kasey-w']);
  for (const id of ['g-carol-gladis', 'tt-carol-g', 'g-kasey-wasserbeck', 'tt-kasey-w']) {
    assert.ok(reviews.mixed().some((r) => r.id === id), `${id} still displayed`);
  }
});

// ── metadata and attribution ──────────────────────────────────────────────
test('metadata is evidence-based: profile links, documented dates, unknowns stay null', () => {
  for (const r of stored()) {
    const m = reviews.reviewMetadata(r);
    if (r.source === 'google') {
      assert.equal(m.sourceUrl, GOOGLE_PROFILE);
      assert.equal(m.sourceUrlKind, 'profile');
      assert.equal(m.verification, 'public-listing-snapshot');
      assert.match(m.capturedAt, /^2026-0[89]-\d{2}$/);
    } else if (r.source === 'thumbtack') {
      assert.equal(m.sourceUrl, THUMBTACK_PROFILE);
      assert.equal(m.capturedAt, '2026-09-26');
    } else {
      assert.equal(m.sourceUrl, null, `${r.id} must not get an invented source URL`);
      assert.equal(m.sourceUrlKind, null);
      assert.equal(m.capturedAt, null, `${r.id} has no recorded capture date`);
      assert.equal(m.verification, 'unverified');
      assert.equal(m.relationship, 'unknown');
    }
    assert.ok(!/review\?|\/reviews\/\d|g\.page/.test(String(m.sourceUrl)), `${r.id}: no fabricated per-review URL`);
  }
});

test('the five attribution categories exist; no record is reclassified yet', () => {
  assert.deepEqual(reviews.SOURCE_TYPES, ['cardetail1', 'google', 'thumbtack', 'partner', 'legacy']);
  assert.equal(reviews.sourceLabel({ source: 'partner' }), 'Professional Service Feedback');
  assert.equal(reviews.sourceLabel({ source: 'cardetail1' }), 'Verified Cardetail1 customer');
  assert.equal(stored().filter((r) => r.source === 'partner').length, 0);
});

test('owner attribution questions are flagged on the records, not resolved by code', () => {
  const flags = (id) => reviews.reviewMetadata(stored().find((r) => r.id === id)).flags.join(' ');
  assert.match(flags('legacy-david-johnson'), /Jeanne Anderson/);
  assert.match(flags('legacy-craig-bitman'), /Cardetail1/);
  assert.match(flags('g-lauren-murphy'), /owner confirmation/);
});

test('the Google review-request link is not used as the profile link', () => {
  assert.notEqual(reviews.SOURCE_PROFILES.google.url, reviews.GOOGLE_REVIEW_URL);
  assert.equal(reviews.SOURCE_PROFILES.google.url, GOOGLE_PROFILE);
  assert.equal(reviews.SOURCE_PROFILES.thumbtack.url, THUMBTACK_PROFILE);
});

// ── 7: initial HTML ───────────────────────────────────────────────────────
test('reviews.html carries all 25 cards in the initial HTML, in carousel order', () => {
  const html = read('reviews.html');
  const ids = [...html.matchAll(/<article class="rv-card rv-card--full" data-review-id="([^"]+)"/g)].map((m) => m[1]);
  reviews.applyPortalItems([]);
  assert.deepEqual(ids, reviews.mixed().map((r) => r.id));
  for (const r of stored()) {
    const escaped = r.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    assert.ok(html.includes(escaped), `${r.id} text missing from initial HTML`);
  }
});

test('reviews.html pre-render is current (render --check)', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/render-reviews-page.mjs'), '--check'], { stdio: 'pipe' });
});

test('render is deterministic and refuses to overwrite hand-written grid content', async () => {
  const { renderPage, loadReviews } = await renderMod();
  const api = loadReviews();
  const once = renderPage(read('reviews.html'), api);
  assert.equal(renderPage(once, api), once);
  assert.throws(() => renderPage('<div class="rv-grid" id="rv-grid"><p>hand</p></div><div class="rv-page-actions">', api), /hand-written/);
});

test('mounting the page script replaces the pre-rendered cards with identical ones (no duplicates)', () => {
  assert.ok(JSDOM, 'jsdom is required');
  const dom = new JSDOM(read('reviews.html'), { runScripts: 'outside-only', url: 'https://cardetail1.com/reviews' });
  const doc = dom.window.document;
  const before = [...doc.querySelectorAll('#rv-grid > article')].map((a) => a.outerHTML);
  assert.equal(before.length, 25);
  reviews.applyPortalItems([]);
  reviews.mount(doc, { fetch: false });
  const after = [...doc.querySelectorAll('#rv-grid > article')].map((a) => a.outerHTML);
  assert.deepEqual(after, before);
  assert.equal(doc.querySelectorAll('[data-review-id]').length - doc.querySelectorAll('#rv-overlay [data-review-id]').length, 25);
});

test('first-party reviews still appear at runtime above the static ones', () => {
  const dom = new JSDOM(read('reviews.html'), { runScripts: 'outside-only', url: 'https://cardetail1.com/reviews' });
  const doc = dom.window.document;
  reviews.mount(doc, { fetch: false });
  reviews.applyPortalItems([{ id: 'fp-test', name: 'Test Customer', rating: 5, text: 'Great job on the interior today.', createdAt: '2026-11-17T00:00:00Z' }]);
  const cards = [...doc.querySelectorAll('#rv-grid > article')];
  assert.equal(cards.length, 26);
  assert.equal(cards[0].getAttribute('data-source'), 'cardetail1');
  reviews.applyPortalItems([]);
});

test('pre-rendered cards expose no private fields', () => {
  const grid = read('reviews.html').split('generated:review-cards')[1];
  assert.doesNotMatch(grid, /@|\btel:|\(\d{3}\)\s?\d{3}-\d{4}|booking[_-]?id|createdAt/i);
});

// ── accessibility and source links ────────────────────────────────────────
test('pre-rendered cards keep star labels; source links are descriptive and safe', () => {
  const html = read('reviews.html');
  assert.equal((html.match(/class="rv-stars" aria-label="5 out of 5 stars"/g) || []).length, 25);
  const region = html.split('generated:review-sources')[1];
  assert.ok(region.includes(`href="${GOOGLE_PROFILE}"`));
  assert.ok(region.includes(`href="${THUMBTACK_PROFILE.replace(/&/g, '&amp;')}"`));
  assert.match(region, /Cardetail1 on Google Maps<span class="rv-vh"> \(opens in a new tab\)<\/span>/);
  assert.match(region, /Cardetail1 on Thumbtack<span class="rv-vh"> \(opens in a new tab\)<\/span>/);
  assert.equal((region.match(/rel="noopener noreferrer"/g) || []).length, 2);
  assert.match(html, /href="https:\/\/g\.page\/r\/CTJwfJerrQeCEAI\/review"[^>]*>Leave a Google Review</, 'leave-a-review link kept');
});

test('no Review or AggregateRating structured data anywhere', () => {
  for (const f of PUBLIC_PAGES) {
    assert.doesNotMatch(read(f), /"@type":\s*"(?:Review|AggregateRating)"|"aggregateRating"/, f);
  }
});

// ── badge ─────────────────────────────────────────────────────────────────
test('"Neighbor-rated" is gone from every page and the template; neutral wording replaces it', () => {
  for (const f of PUBLIC_PAGES) assert.doesNotMatch(read(f), /Neighbor-rated/, f);
  const fixed = ['bergen-county-hub', 'essex-county-hub', 'hudson-county-hub', 'passaic-county-hub',
    'newark-mobile-detailing', 'trenton-mobile-detailing', 'westchester-mobile-detailing', 'template-city'];
  for (const stem of fixed) assert.match(read(`${stem}.html`), /<span>Owner-operated mobile detailing<\/span>/, stem);
});

// ── city pages ────────────────────────────────────────────────────────────
test('city pages show the same two Google quotes, sourced from the dataset', () => {
  const src = read('scripts/generate-bergen-city-pages.mjs');
  assert.match(src, /CITY_REVIEW_IDS = \['g-john-daquila', 'g-gerard-baltazar'\]/);
  assert.doesNotMatch(src, /White BMW 760|Truly impressive work/, 'no second copy of the review text');
  const g = reviews.googleReviews();
  for (const f of PUBLIC_PAGES.filter((p) => /^(palisades-park|fort-lee|paramus|hackensack|englewood|teaneck|ridgewood|edgewater|franklin-lakes|mahwah|tenafly)-mobile-detailing\.html$/.test(p))) {
    const html = read(f);
    assert.equal((html.match(/<article class="city-review">/g) || []).length, 2, f);
    for (const id of ['g-john-daquila', 'g-gerard-baltazar']) {
      const r = g.find((x) => x.id === id);
      assert.ok(html.includes(r.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')), `${f}: ${id} text`);
      assert.ok(html.includes(`${r.name} · Google review`), `${f}: ${id} name`);
    }
  }
  execFileSync(process.execPath, [path.join(root, 'scripts/generate-bergen-city-pages.mjs'), '--check'], { stdio: 'pipe' });
});

// ── imports ───────────────────────────────────────────────────────────────
const AUTH = { platform: 'google', method: 'owner-export', reuseConfirmed: true, confirmedBy: 'owner', confirmedAt: '2026-11-20' };

test('import preview: exact duplicate, cross-platform match, new, invalid, rating-only', async () => {
  const { previewImport, existingReviews } = await importMod();
  const existing = existingReviews(root);
  const lauren = existing.find((r) => r.id === 'g-lauren-murphy');
  const p = previewImport({ authorization: AUTH, reviews: [
    { platform: 'google', name: 'Lauren Murphy', rating: 5, text: lauren.text.toUpperCase(), date: 'Sep 2026' },
    { platform: 'google', name: 'Jackie Brown', rating: 5, text: 'Wonderful job, totally new car feel.', date: '2026-10-01' },
    { platform: 'google', name: 'New Person', rating: 5, text: 'Came to my office lot and did a great job.', date: '2026-10-02', sourceUrl: GOOGLE_PROFILE },
    { platform: 'google', name: '', rating: 7, text: 'x', date: 'yesterday' },
    { platform: 'google', name: 'Quiet Customer', rating: 5, text: '', date: '2026-10-03' },
    { platform: 'google', name: 'Lauren Murphy', rating: 5, text: 'Edited version of my review.', date: 'Oct 2026' },
  ] }, existing);
  assert.deepEqual(p.results.map((r) => r.status),
    ['duplicate', 'eligible-check-cross-platform', 'eligible', 'invalid', 'rating-only', 'review-manually']);
  assert.equal(p.results[1].matches[0].id, 'tt-jackie-b');
  assert.equal(p.results[2].proposedId, 'g-new-person');
});

test('import preview: an export without reuse confirmation is not eligible', async () => {
  const { previewImport, existingReviews } = await importMod();
  const p = previewImport({ authorization: { ...AUTH, reuseConfirmed: false }, reviews: [
    { platform: 'google', name: 'New Person', rating: 5, text: 'Came to my office lot and did a great job.', date: '2026-10-02' },
  ] }, existingReviews(root));
  assert.equal(p.authorized, false);
  assert.equal(p.results[0].status, 'needs-authorization');
  assert.equal(p.results[0].proposedId, undefined);
});

test('import preview rejects unofficial source URLs and never writes the dataset', async () => {
  const { previewImport, existingReviews } = await importMod();
  const before = read('assets/customer-reviews.js');
  const p = previewImport({ authorization: AUTH, reviews: [
    { platform: 'google', name: 'Someone', rating: 5, text: 'Nice work overall here.', date: '2026-10-02', sourceUrl: 'http://example.com/review/1' },
  ] }, existingReviews(root));
  assert.equal(p.results[0].status, 'invalid');
  assert.match(p.results[0].problems.join(' '), /official https URL/);
  assert.equal(read('assets/customer-reviews.js'), before);
  assert.doesNotMatch(read('scripts/review-import-preview.mjs'), /writeFileSync\([^)]*customer-reviews|fetch\(|https?\.get\(/);
});
