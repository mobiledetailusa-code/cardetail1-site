// Booking copy drift guard.
//
// The booking modal is physically duplicated across index.html and 12 hub/city
// files, and nothing compared the copies — that is how the "card holds your slot"
// contradiction spread and why fixing it took 13 hand edits.
//
// Two surface classes are kept strictly apart:
//
//   AUTHORITATIVE  index.html — the customer-visible booking UI. Assertions run
//                  against the PARSED DOM of #bk-ov with <script>, <style>,
//                  <template>, <noscript> and comment nodes removed, so a comment,
//                  a script template or hidden legacy markup can never satisfy a
//                  customer-visible assertion.
//
//   FALLBACK       the legacy inline modal on the hub/city files. It is hidden at
//                  runtime by assets/hub-booking-bridge.js. It gets compatibility
//                  parity assertions only and is never treated as the primary
//                  customer-visible source.
//
// Presentation only. Nothing here reads or asserts a price, total, fee, ledger
// entry, Stripe object, persisted record or transaction outcome.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const canonical = JSON.parse(read('tests/fixtures/booking-copy.canonical.json'));
const { authoritative: AUTH_PAGES, fallbackPublic, fallbackTemplate } = canonical.surfaces;
const FALLBACK_PAGES = [...fallbackPublic, ...fallbackTemplate];
const { bookingRootSelector, fallbackMarker } = canonical.surfaceRules;

const NON_VISIBLE = 'script, style, template, noscript';

/** Strip everything a customer cannot read, including comment nodes. */
function stripNonVisible(node, doc) {
  node.querySelectorAll(NON_VISIBLE).forEach((el) => el.remove());
  const walker = doc.createTreeWalker(node, 128 /* SHOW_COMMENT */);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.parentNode && c.parentNode.removeChild(c));
  return node;
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Parse a page once; return the booking-modal DOM and its customer-visible text. */
function bookingSurface(page) {
  const dom = new JSDOM(read(page));
  const doc = dom.window.document;
  const modal = doc.querySelector(bookingRootSelector);
  assert.ok(modal, `${page} has no ${bookingRootSelector} booking root`);
  const clean = stripNonVisible(modal.cloneNode(true), doc);
  return { doc, modal: clean, text: norm(clean.textContent) };
}

const authoritativePage = AUTH_PAGES[0];
const authoritative = bookingSurface(authoritativePage);

// ── Surface discovery ────────────────────────────────────────────────────────

test('every booking surface in the repo is classified, none can slip through', () => {
  const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));

  // Structural detection: a page owning the booking root IS a booking surface,
  // regardless of which strings it happens to contain.
  const surfaces = pages.filter((f) => read(f).includes(`id="${bookingRootSelector.slice(1)}"`));

  const classified = [...AUTH_PAGES, ...FALLBACK_PAGES];
  const unclassified = surfaces.filter((f) => !classified.includes(f));
  assert.deepEqual(
    unclassified,
    [],
    `these pages render ${bookingRootSelector} but are not in the manifest: ${unclassified.join(', ')}`,
  );

  const missing = classified.filter((f) => !surfaces.includes(f));
  assert.deepEqual(missing, [], `manifest lists surfaces that no longer render the booking root: ${missing.join(', ')}`);

  // A page that owns the booking root and does NOT delegate is customer-visible,
  // so it must be authoritative. This is what catches a new booking page.
  for (const page of surfaces) {
    const delegates = read(page).includes(fallbackMarker);
    const expected = delegates ? 'fallback' : 'authoritative';
    const actual = AUTH_PAGES.includes(page) ? 'authoritative' : 'fallback';
    assert.equal(
      actual,
      expected,
      `${page} is classified ${actual} but ${delegates ? 'loads' : 'does not load'} ${fallbackMarker}, so it is ${expected}`,
    );
  }
});

// ── Authoritative customer-visible contract ──────────────────────────────────

test('the authoritative flow renders six steps, in order, with the canonical labels', () => {
  const { doc } = authoritative;
  const declared = /const BK_VISIBLE_STEPS = (\d+);/.exec(read(authoritativePage));
  assert.ok(declared, `${canonical.authoritative.stepsConstant} not found`);
  assert.equal(
    Number(declared[1]),
    canonical.authoritative.steps.length,
    'the step constant disagrees with the manifest step list',
  );

  const rendered = canonical.authoritative.steps.map((step) => {
    const tab = doc.getElementById(step.tabId);
    assert.ok(tab, `step tab #${step.tabId} is not rendered on ${authoritativePage}`);
    stripNonVisible(tab, doc);
    // The tab shows its number then its label; compare on the label only.
    return norm(tab.textContent).replace(/^\d+\s*/, '');
  });

  assert.deepEqual(
    rendered,
    canonical.authoritative.steps.map((s) => s.label),
    'booking step labels or their order drifted from the manifest',
  );
});

test('canonical elements render with the canonical text on the authoritative surface', () => {
  const drifted = [];
  for (const entry of canonical.authoritative.elements) {
    const el = authoritative.modal.querySelector(entry.selector);
    if (!el) { drifted.push(`[${entry.id}] ${entry.selector} not rendered — ${entry.why}`); continue; }
    const actual = norm(el.textContent);
    if (actual !== entry.text) {
      drifted.push(`[${entry.id}] ${entry.selector}\n    expected: ${entry.text}\n    actual  : ${actual}\n    why     : ${entry.why}`);
    }
  }
  assert.deepEqual(drifted, [], `authoritative element copy drifted:\n  ${drifted.join('\n  ')}`);
});

test('canonical sentences are customer-visible on the authoritative surface', () => {
  const missing = canonical.authoritative.visibleText
    .filter((entry) => !authoritative.text.includes(norm(entry.text)))
    .map((entry) => `[${entry.id}]\n    expected: ${entry.text}\n    why     : ${entry.why}`);

  assert.deepEqual(
    missing,
    [],
    `these sentences are absent from the customer-visible booking DOM of ${authoritativePage}` +
      ` (comments, <script> and <template> content do not count):\n  ${missing.join('\n  ')}`,
  );
});

test('booking entry CTA semantics hold on the authoritative page', () => {
  const dom = new JSDOM(read(authoritativePage));
  const doc = dom.window.document;
  stripNonVisible(doc.body, doc);

  for (const entry of canonical.authoritative.entryCta.discovery) {
    const el = doc.querySelector(entry.selector);
    assert.ok(el, `[${entry.id}] ${entry.selector} not rendered — ${entry.why}`);
    assert.equal(norm(el.textContent), entry.text, `[${entry.id}] entry CTA drifted — ${entry.why}`);
  }

  const raw = read(authoritativePage);
  for (const entry of canonical.authoritative.entryCta.forbiddenOnEntry) {
    assert.doesNotMatch(raw, new RegExp(entry.pattern), `[${entry.id}] ${entry.why}`);
  }
});

// ── Fallback compatibility parity ────────────────────────────────────────────

test('the legacy fallback modal does not contradict the authoritative surface', () => {
  const byId = new Map(canonical.authoritative.visibleText.concat(canonical.authoritative.elements).map((e) => [e.id, e]));
  const drifted = [];

  for (const page of FALLBACK_PAGES) {
    // The fallback is hidden markup; a raw containment check is the right level
    // here. It is explicitly NOT accepted as evidence for any authoritative
    // assertion — those run against the parsed DOM of index.html only.
    const raw = read(page);
    for (const id of canonical.fallbackParity.ids) {
      const entry = byId.get(id);
      assert.ok(entry, `fallbackParity references unknown id ${id}`);
      if (!raw.includes(entry.text)) drifted.push(`[${id}] missing from fallback surface ${page}`);
    }
  }

  assert.deepEqual(
    drifted,
    [],
    `the hidden fallback modal drifted from the authoritative copy:\n  ${drifted.join('\n  ')}\n` +
      'If the bridge ever fails to execute this markup becomes visible, so it must not contradict index.html.',
  );
});

test('every fallback surface actually delegates to the authoritative page', () => {
  for (const page of FALLBACK_PAGES) {
    assert.ok(
      read(page).includes(fallbackMarker),
      `${page} is classified as fallback but does not load ${fallbackMarker}`,
    );
  }
});

// ── Contradictions, everywhere ───────────────────────────────────────────────

test('no surface reintroduces a contradiction that was already removed', () => {
  const scanned = [...AUTH_PAGES, ...FALLBACK_PAGES, 'scripts/apply-state-hub-theme.mjs'];
  const violations = [];
  for (const entry of canonical.forbidden) {
    const re = new RegExp(entry.pattern, entry.flags || '');
    for (const file of scanned) {
      if (re.test(read(file))) violations.push(`[${entry.id}] ${file} — ${entry.why}`);
    }
  }
  assert.deepEqual(violations, [], `forbidden copy present:\n  ${violations.join('\n  ')}`);
});

test('documentation and code agree on how many steps the flow has', () => {
  assert.doesNotMatch(
    read('assets/hub-booking-bridge.js'),
    /four-step/i,
    'assets/hub-booking-bridge.js still documents a four-step flow',
  );
});

// ── The manifest may never acquire authority ─────────────────────────────────

test('the manifest stays presentation-only', () => {
  const payload = [
    ...canonical.authoritative.elements.map((e) => e.text),
    ...canonical.authoritative.visibleText.map((e) => e.text),
    ...canonical.authoritative.entryCta.discovery.map((e) => e.text),
    ...canonical.forbidden.map((e) => e.pattern),
  ].join('\n');

  assert.doesNotMatch(payload, /\$\d/, 'a canonical string carries a currency amount — pricing authority must not move here');
  for (const token of ['bookingVersion', 'quoteVersion', 'paymentIntent', 'setupIntent', 'ledger', 'stripeCustomerId', 'draftSaveToken']) {
    assert.ok(!payload.includes(token), `a canonical string references ${token} — this manifest must not carry transaction authority`);
  }
});
