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
// Copy assertions are ANCHORED to a specific element rather than matched against
// the modal's aggregate text. Aggregate containment could be satisfied by a hidden
// decoy carrying the old wording while the real element drifted; an anchor cannot.
// See $anchoredText in the manifest for why computed visibility is deliberately
// NOT used as the filter.
//
// Surface discovery walks the publish root RECURSIVELY. netlify.toml sets
// publish = ".", so a page at any depth is served; a root-only scan let a nested
// booking page ship outside the guard.
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
const { bookingRootSelector, fallbackMarker, scanExcludedDirs } = canonical.surfaceRules;

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

// ── Publish-root discovery ───────────────────────────────────────────────────

/**
 * Every .html served from the publish root, at any depth, as POSIX-relative paths.
 * Excludes dot-directories and the role-based directories listed in the manifest.
 */
function listPublishedHtml(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      if (scanExcludedDirs.includes(relPath)) continue;
      out.push(...listPublishedHtml(path.join(dir, entry.name), relPath));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(relPath);
    }
  }
  return out;
}

/**
 * Structural classification of every booking surface under a publish root.
 * A page owning the booking root IS a booking surface, regardless of which
 * strings it happens to contain.
 */
function classifyBookingSurfaces(publishRoot) {
  const rootAttr = `id="${bookingRootSelector.slice(1)}"`;
  const pages = listPublishedHtml(publishRoot);
  const surfaces = pages.filter((f) => fs.readFileSync(path.join(publishRoot, f), 'utf8').includes(rootAttr));
  const classified = [...AUTH_PAGES, ...FALLBACK_PAGES];

  const unclassified = surfaces.filter((f) => !classified.includes(f));
  const missing = classified.filter((f) => !surfaces.includes(f));

  const misclassified = [];
  for (const page of surfaces) {
    if (unclassified.includes(page)) continue;
    // A page that owns the booking root and does NOT delegate is customer-visible,
    // so it must be authoritative.
    const delegates = fs.readFileSync(path.join(publishRoot, page), 'utf8').includes(fallbackMarker);
    const expected = delegates ? 'fallback' : 'authoritative';
    const actual = AUTH_PAGES.includes(page) ? 'authoritative' : 'fallback';
    if (actual !== expected) {
      misclassified.push(
        `${page} is classified ${actual} but ${delegates ? 'loads' : 'does not load'} ${fallbackMarker}, so it is ${expected}`,
      );
    }
  }

  return { pages, surfaces, unclassified, missing, misclassified };
}

// ── Anchored copy assertions ─────────────────────────────────────────────────

/** Parse a page once; return the booking-modal DOM and its customer-visible text. */
function bookingSurface(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const modal = doc.querySelector(bookingRootSelector);
  assert.ok(modal, `page has no ${bookingRootSelector} booking root`);
  const clean = stripNonVisible(modal.cloneNode(true), doc);
  return { doc, modal: clean, text: norm(clean.textContent) };
}

/**
 * Compare each anchored entry against the elements its anchor resolves to.
 * The element count must equal the expected text count, so an extra element that
 * matches the anchor (a decoy) fails just as loudly as drifted wording.
 */
function anchoredDrift(modal, entries) {
  const drifted = [];
  for (const entry of entries) {
    const found = [...modal.querySelectorAll(entry.anchor)].map((el) => norm(el.textContent));
    if (found.length !== entry.texts.length) {
      drifted.push(
        `[${entry.id}] ${entry.anchor}\n    expected ${entry.texts.length} element(s), found ${found.length}` +
          `\n    found   : ${JSON.stringify(found)}\n    why     : ${entry.why}`,
      );
      continue;
    }
    entry.texts.forEach((expected, i) => {
      const actual = found[i];
      const ok = entry.match === 'exact' ? actual === norm(expected) : actual.includes(norm(expected));
      if (!ok) {
        drifted.push(
          `[${entry.id}] ${entry.anchor} (element ${i + 1} of ${found.length}, match=${entry.match})` +
            `\n    expected: ${expected}\n    actual  : ${actual}\n    why     : ${entry.why}`,
        );
      }
    });
  }
  return drifted;
}

const authoritativePage = AUTH_PAGES[0];
const authoritativeHtml = read(authoritativePage);
const authoritative = bookingSurface(authoritativeHtml);

// ── Surface discovery ────────────────────────────────────────────────────────

test('every booking surface in the repo is classified, none can slip through', () => {
  const { unclassified, missing, misclassified } = classifyBookingSurfaces(root);

  assert.deepEqual(
    unclassified,
    [],
    `these pages render ${bookingRootSelector} but are not in the manifest: ${unclassified.join(', ')}`,
  );
  assert.deepEqual(missing, [], `manifest lists surfaces that no longer render the booking root: ${missing.join(', ')}`);
  assert.deepEqual(misclassified, [], `booking surfaces are classified against their delegation:\n  ${misclassified.join('\n  ')}`);
});

test('surface discovery descends into subdirectories of the publish root', () => {
  // netlify.toml publishes ".", so a page at any depth is served. Two independent
  // proofs that the scan is recursive rather than a root-level readdir.
  const { pages } = classifyBookingSurfaces(root);

  // 1. It really reaches nested HTML in this repo as it stands today.
  const nested = pages.filter((p) => p.includes('/'));
  assert.ok(
    nested.length > 0,
    'discovery found no nested .html at all — either the walk stopped at the root or scanExcludedDirs is swallowing served directories',
  );

  // 2. M9 — a nested, unclassified booking page must be reported. Written into the
  //    real publish root so this exercises the same walk the guard uses, and removed
  //    again in `finally` whether or not the assertions hold.
  const dir = path.join(root, 'cities');
  const file = path.join(dir, 'boston-hub.html');
  assert.ok(!fs.existsSync(dir), 'cities/ already exists — refusing to overwrite it in a test');
  try {
    fs.mkdirSync(dir);
    fs.writeFileSync(file, `<!doctype html><html><body><div class="booking-modal-ov" id="bk-ov">Book</div></body></html>`);

    const { surfaces, unclassified } = classifyBookingSurfaces(root);
    assert.ok(surfaces.includes('cities/boston-hub.html'), 'a nested page owning the booking root was not discovered');
    assert.deepEqual(
      unclassified,
      ['cities/boston-hub.html'],
      'a nested booking page that is absent from the manifest must be reported as unclassified',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Authoritative customer-visible contract ──────────────────────────────────

test('the authoritative flow renders six steps, in order, with the canonical labels', () => {
  const { doc } = authoritative;
  const declared = /const BK_VISIBLE_STEPS = (\d+);/.exec(authoritativeHtml);
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

test('canonical sentences render on their own anchored element, not just somewhere in the modal', () => {
  const drifted = anchoredDrift(authoritative.modal, canonical.authoritative.anchoredText);
  assert.deepEqual(
    drifted,
    [],
    `anchored booking copy drifted on ${authoritativePage}` +
      ` (comments, <script> and <template> content do not count, and an unexpected extra match is drift too):\n  ${drifted.join('\n  ')}`,
  );
});

test('a hidden decoy cannot satisfy an anchored assertion while the real element drifts', () => {
  // M7b. Drift the canonical element, then plant the original wording in a
  // display:none decoy elsewhere inside #bk-ov. Under whole-modal containment this
  // passed; anchored, it must fail and name the entry.
  const entry = canonical.authoritative.anchoredText.find((e) => e.id === 'card-mandatory');
  const original = entry.texts[0];

  const mutated = authoritativeHtml
    .replace(original, 'Card on File Optional')
    .replace(
      `<div class="booking-modal-ov" id="${bookingRootSelector.slice(1)}">`,
      `<div class="booking-modal-ov" id="${bookingRootSelector.slice(1)}"><div style="display:none">${original}</div>`,
    );
  assert.ok(mutated !== authoritativeHtml, 'the mutation did not apply — the fixture text no longer matches the page');

  const surface = bookingSurface(mutated);
  assert.ok(
    surface.text.includes(original),
    'precondition: the decoy is present in the modal text, which is exactly what used to make this pass',
  );

  const drifted = anchoredDrift(surface.modal, canonical.authoritative.anchoredText);
  assert.ok(
    drifted.some((d) => d.startsWith(`[${entry.id}]`)),
    `the hidden decoy masked drift on [${entry.id}] — anchoring failed to detect it:\n  ${drifted.join('\n  ')}`,
  );
});

test('booking entry CTA semantics hold on the authoritative page', () => {
  const dom = new JSDOM(authoritativeHtml);
  const doc = dom.window.document;
  stripNonVisible(doc.body, doc);

  for (const entry of canonical.authoritative.entryCta.discovery) {
    const el = doc.querySelector(entry.selector);
    assert.ok(el, `[${entry.id}] ${entry.selector} not rendered — ${entry.why}`);
    assert.equal(norm(el.textContent), entry.text, `[${entry.id}] entry CTA drifted — ${entry.why}`);
  }

  for (const entry of canonical.authoritative.entryCta.forbiddenOnEntry) {
    assert.doesNotMatch(authoritativeHtml, new RegExp(entry.pattern), `[${entry.id}] ${entry.why}`);
  }
});

test('the hero states the zero-charge promise, without this file pinning the amount', () => {
  // The hero carries a literal currency string next to this label. The amount is
  // the catalog's authority and is deliberately absent from the manifest; the
  // PROMISE beside it is what must not drift.
  const entry = canonical.zeroChargeSemantics;
  const dom = new JSDOM(authoritativeHtml);
  const doc = dom.window.document;
  stripNonVisible(doc.body, doc);

  const found = [...doc.querySelectorAll(entry.anchor)].map((el) => norm(el.textContent));
  assert.deepEqual(
    found,
    [entry.text],
    `[${entry.id}] ${entry.anchor} — the hero saved-vs-charged promise drifted. ${entry.why}`,
  );
});

// ── Fallback compatibility parity ────────────────────────────────────────────

test('the legacy fallback modal does not contradict the authoritative surface', () => {
  const byId = new Map(
    canonical.authoritative.anchoredText
      .map((e) => [e.id, e.texts[0]])
      .concat(canonical.authoritative.elements.map((e) => [e.id, e.text])),
  );
  const drifted = [];

  for (const page of FALLBACK_PAGES) {
    // The fallback is hidden markup; a raw containment check is the right level
    // here. It is explicitly NOT accepted as evidence for any authoritative
    // assertion — those run against the anchored DOM of index.html only.
    const raw = read(page);
    for (const id of canonical.fallbackParity.ids) {
      const text = byId.get(id);
      assert.ok(text, `fallbackParity references unknown id ${id}`);
      if (!raw.includes(text)) drifted.push(`[${id}] missing from fallback surface ${page}`);
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
    ...canonical.authoritative.anchoredText.flatMap((e) => e.texts),
    ...canonical.authoritative.entryCta.discovery.map((e) => e.text),
    ...canonical.forbidden.map((e) => e.pattern),
    canonical.zeroChargeSemantics.text,
  ].join('\n');

  assert.doesNotMatch(payload, /\$\d/, 'a canonical string carries a currency amount — pricing authority must not move here');
  for (const token of ['bookingVersion', 'quoteVersion', 'paymentIntent', 'setupIntent', 'ledger', 'stripeCustomerId', 'draftSaveToken']) {
    assert.ok(!payload.includes(token), `a canonical string references ${token} — this manifest must not carry transaction authority`);
  }
});
