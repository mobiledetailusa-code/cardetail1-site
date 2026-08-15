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
// Three properties this file is responsible for, each proved by a test that fails
// when the property is removed:
//
//   1. DISCOVERY is DOM-structural and recursive. A page is a booking surface when
//      it renders an ELEMENT with the booking id — not when its bytes happen to
//      contain that string. Quoting style is irrelevant; comments, <script> text
//      and <template> content classify nothing. Delegation is likewise read from
//      real <script src> elements, not from raw text.
//
//   2. COPY assertions are ANCHORED to a specific element. Aggregate text
//      containment could be satisfied by a hidden decoy carrying the old wording
//      while the real element drifted; an anchor cannot. See $anchoredText in the
//      manifest for why computed visibility is deliberately NOT the filter.
//
//   3. STEP ORDER is read from the physical DOM. Enumerating the manifest and
//      looking each id up by getElementById would pass a physical reorder, because
//      the lookup imposes the manifest's own order on the result.
//
// This file never writes inside the checkout. Synthetic publish roots are built
// under fs.mkdtempSync, so concurrent runs never share a path.
//
// Presentation only. Nothing here reads or asserts a price, total, fee, ledger
// entry, Stripe object, persisted record or transaction outcome.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const canonical = JSON.parse(read('tests/fixtures/booking-copy.canonical.json'));
const { authoritative: AUTH_PAGES, fallbackPublic, fallbackTemplate } = canonical.surfaces;
const FALLBACK_PAGES = [...fallbackPublic, ...fallbackTemplate];
const { bookingRootId, bridgeScript, scanExcludedDirs, stepTabContainer, stepTabSelector } =
  canonical.surfaceRules;

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
 * Every .html served from a publish root, at any depth, as POSIX-relative paths.
 * Excludes dot-directories and the role-based directories listed in the manifest.
 */
function listPublishedHtml(publishRoot, excluded, dir = publishRoot, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      if (excluded.includes(relPath)) continue;
      out.push(...listPublishedHtml(publishRoot, excluded, path.join(dir, entry.name), relPath));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(relPath);
    }
  }
  return out;
}

/**
 * DOM-structural role of one page.
 *
 * `isSurface` is true only when the parsed document really contains an element
 * with the booking id. A commented-out modal, a modal inside <script> text and a
 * modal inside <template> all parse to something that is not an element in the
 * document, so none of them classify. Quoting style never reaches this decision
 * because the parser has already resolved it.
 *
 * `delegates` is read from real <script src> elements for the same reason: the
 * bridge path mentioned in a comment or in a string literal is not a script tag.
 */
function pageRole(html) {
  const doc = new JSDOM(html).window.document;
  const isSurface = !!doc.getElementById(bookingRootId);
  const delegates = [...doc.querySelectorAll('script[src]')].some((s) => {
    const src = s.getAttribute('src') || '';
    return src === bridgeScript || src.endsWith(`/${bridgeScript}`) || src.split('/').pop() === bridgeScript.split('/').pop();
  });
  return { isSurface, delegates };
}

/**
 * Structural classification of every booking surface under a publish root.
 * Both the root and the manifest are injected so this runs against a synthetic
 * tree without the real checkout ever being written to.
 */
function classifyBookingSurfaces(publishRoot, manifest, excluded = scanExcludedDirs) {
  const { authoritative = [], fallbackPublic: fbPublic = [], fallbackTemplate: fbTemplate = [] } = manifest;
  const pages = listPublishedHtml(publishRoot, excluded);

  // Cheap prefilter: a document cannot contain an element with this id unless the
  // id appears in the bytes at all. It is a superset — every candidate is then
  // confirmed by parsing, so nothing is classified on a raw match.
  const candidates = pages.filter((f) => fs.readFileSync(path.join(publishRoot, f), 'utf8').includes(bookingRootId));

  const surfaces = [];
  const roles = new Map();
  for (const page of candidates) {
    const role = pageRole(fs.readFileSync(path.join(publishRoot, page), 'utf8'));
    if (!role.isSurface) continue;
    surfaces.push(page);
    roles.set(page, role);
  }

  const declared = [...authoritative, ...fbPublic, ...fbTemplate];
  const unclassified = surfaces.filter((f) => !declared.includes(f));
  const missing = declared.filter((f) => !surfaces.includes(f));

  // Roles must be disjoint — a page may not be authoritative and fallback at once.
  const overlapping = declared.filter((f, i) => declared.indexOf(f) !== i);

  const misclassified = [];
  for (const page of surfaces) {
    if (unclassified.includes(page)) continue;
    const { delegates } = roles.get(page);
    const expected = delegates ? 'fallback' : 'authoritative';
    const actual = authoritative.includes(page) ? 'authoritative' : 'fallback';
    if (actual !== expected) {
      misclassified.push(
        `${page} is classified ${actual} but ${delegates ? 'loads' : 'does not load'} ${bridgeScript} as a <script src>, so it is ${expected}`,
      );
    }
  }

  return { pages, surfaces, unclassified, missing, overlapping, misclassified, roles };
}

const REPO_MANIFEST = { authoritative: AUTH_PAGES, fallbackPublic, fallbackTemplate };

/** Classifying the real checkout parses every candidate page; do it once. */
let repoClassificationCache = null;
const repoClassification = () => (repoClassificationCache ??= classifyBookingSurfaces(root, REPO_MANIFEST));

/** Build a throwaway publish root. Unique per call, so concurrent runs never collide. */
function makeSyntheticRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd1-drift-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return dir;
}

// ── Anchored copy assertions ─────────────────────────────────────────────────

/** Parse a page once; return the booking-modal DOM and its customer-visible text. */
function bookingSurface(html) {
  const doc = new JSDOM(html).window.document;
  const modal = doc.getElementById(bookingRootId);
  assert.ok(modal, `page renders no element with id ${bookingRootId}`);
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

/** Step tabs as they physically appear in the document, in DOM order. */
function renderedSteps(doc) {
  const container = doc.getElementById(stepTabContainer);
  assert.ok(container, `step container #${stepTabContainer} is not rendered`);
  return [...container.querySelectorAll(stepTabSelector)].map((tab) => {
    const clean = stripNonVisible(tab.cloneNode(true), doc);
    return { id: tab.id, label: norm(clean.textContent).replace(/^\d+\s*/, '') };
  });
}

const authoritativePage = AUTH_PAGES[0];
const authoritativeHtml = read(authoritativePage);
const authoritative = bookingSurface(authoritativeHtml);

// ── Surface discovery ────────────────────────────────────────────────────────

test('every booking surface in the repo is classified, none can slip through', () => {
  const { unclassified, missing, overlapping, misclassified } = repoClassification();

  assert.deepEqual(
    unclassified,
    [],
    `these pages render an element with id ${bookingRootId} but are not in the manifest: ${unclassified.join(', ')}`,
  );
  assert.deepEqual(missing, [], `manifest lists surfaces that no longer render the booking root: ${missing.join(', ')}`);
  assert.deepEqual(overlapping, [], `these pages are declared under more than one role: ${overlapping.join(', ')}`);
  assert.deepEqual(misclassified, [], `booking surfaces are classified against their delegation:\n  ${misclassified.join('\n  ')}`);
});

test('the three surface roles stay distinct and account for every surface', () => {
  const { surfaces, roles } = repoClassification();

  const sets = { authoritative: AUTH_PAGES, fallbackPublic, fallbackTemplate };
  for (const [a, b] of [['authoritative', 'fallbackPublic'], ['authoritative', 'fallbackTemplate'], ['fallbackPublic', 'fallbackTemplate']]) {
    const shared = sets[a].filter((f) => sets[b].includes(f));
    assert.deepEqual(shared, [], `${a} and ${b} both claim: ${shared.join(', ')}`);
  }

  assert.deepEqual(
    [...surfaces].sort(),
    [...AUTH_PAGES, ...fallbackPublic, ...fallbackTemplate].sort(),
    'the union of the three roles must be exactly the set of discovered booking surfaces',
  );

  // The role split is not decorative: authoritative renders the modal customers
  // use, both fallback roles delegate away from it.
  for (const page of AUTH_PAGES) assert.equal(roles.get(page).delegates, false, `${page} is authoritative but delegates`);
  for (const page of FALLBACK_PAGES) assert.equal(roles.get(page).delegates, true, `${page} is fallback but does not delegate`);
  assert.ok(fallbackTemplate.length > 0, 'the template role exists and must not be folded into fallbackPublic');
});

test('discovery is DOM-structural: quoting is irrelevant, comments and scripts classify nothing', () => {
  const modal = `<div class="booking-modal-ov" id="${bookingRootId}">Book</div>`;
  const bridgeTag = `<script src="${bridgeScript}" defer></script>`;
  const dir = makeSyntheticRoot({
    // Single-quoted id — must be discovered exactly like the double-quoted form.
    'index.html': `<!doctype html><html><body><div class='booking-modal-ov' id='${bookingRootId}'>Book</div></body></html>`,
    'hub.html': `<!doctype html><html><body>${modal}${bridgeTag}</body></html>`,
    // The booking root appears only inside a comment / script text / template.
    'commented.html': `<!doctype html><html><body><!-- ${modal} --></body></html>`,
    'scripted.html': `<!doctype html><html><body><script>var t = ${JSON.stringify(modal)};</script></body></html>`,
    'templated.html': `<!doctype html><html><body><template>${modal}</template></body></html>`,
    // Renders the modal, but the bridge is only mentioned in a comment and in a
    // string. It does NOT delegate, so it is authoritative, not fallback.
    'fake-fallback.html': `<!doctype html><html><body>${modal}<!-- ${bridgeScript} --><script>var s="${bridgeScript}";</script></body></html>`,
  });
  try {
    const declaredWrong = { authoritative: ['index.html'], fallbackPublic: ['hub.html', 'fake-fallback.html'], fallbackTemplate: [] };
    const r = classifyBookingSurfaces(dir, declaredWrong, []);

    assert.deepEqual(
      [...r.surfaces].sort(),
      ['fake-fallback.html', 'hub.html', 'index.html'],
      'only pages rendering a real element may be surfaces — a single-quoted id must count, and comment/script/template occurrences must not',
    );
    assert.equal(r.roles.get('index.html').delegates, false, "single-quoted page must parse and must not appear to delegate");
    assert.equal(r.roles.get('hub.html').delegates, true, 'a real <script src> must classify as delegating');
    assert.equal(
      r.roles.get('fake-fallback.html').delegates,
      false,
      'the bridge path in a comment or a string literal must not classify a page as fallback',
    );
    assert.deepEqual(
      r.misclassified,
      [
        `fake-fallback.html is classified fallback but does not load ${bridgeScript} as a <script src>, so it is authoritative`,
      ],
      'a page that renders the modal without delegating is customer-visible and must be reported when declared fallback',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery descends into subdirectories and reports a nested unregistered surface', () => {
  // netlify.toml publishes ".", so a page at any depth is served.
  // 1. The real checkout is reached recursively — read-only, nothing is written.
  const { pages } = repoClassification();
  assert.ok(
    pages.some((p) => p.includes('/')),
    'discovery found no nested .html at all — either the walk stopped at the root or scanExcludedDirs is swallowing served directories',
  );

  // 2. A nested, unregistered authoritative surface must be reported by path.
  const dir = makeSyntheticRoot({
    'index.html': `<!doctype html><html><body><div id="${bookingRootId}">Book</div></body></html>`,
    'cities/boston-hub.html': `<!doctype html><html><body><div id="${bookingRootId}">Book</div></body></html>`,
  });
  try {
    const r = classifyBookingSurfaces(dir, { authoritative: ['index.html'] }, []);
    assert.ok(r.surfaces.includes('cities/boston-hub.html'), 'a nested page rendering the booking root was not discovered');
    assert.deepEqual(
      r.unclassified,
      ['cities/boston-hub.html'],
      'a nested booking page absent from the manifest must be reported as unclassified',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Authoritative customer-visible contract ──────────────────────────────────

test('the authoritative flow renders exactly six steps in physical DOM order', () => {
  const declared = /const BK_VISIBLE_STEPS = (\d+);/.exec(authoritativeHtml);
  assert.ok(declared, `${canonical.authoritative.stepsConstant} not found`);
  assert.equal(
    Number(declared[1]),
    canonical.authoritative.steps.length,
    'the step constant disagrees with the manifest step list',
  );

  // Read the tabs as they physically appear. Looking each id up from the manifest
  // would impose the manifest's order on the result and pass a physical reorder.
  const rendered = renderedSteps(authoritative.doc);
  assert.deepEqual(
    rendered,
    canonical.authoritative.steps.map((s) => ({ id: s.tabId, label: s.label })),
    'booking step ids, labels or their physical DOM order drifted from the manifest',
  );
  assert.equal(rendered.length, canonical.authoritative.steps.length, 'the flow must render exactly the manifest steps, no more, no fewer');
});

test('a physical reorder of two step tabs is detected', () => {
  // Swap the whole tab elements for steps 3 and 4 — labels and numbers travel with
  // them, so every per-id lookup still agrees. Only DOM order changes.
  const steps = canonical.authoritative.steps;
  const [a, b] = [steps[2], steps[3]];
  const tabRe = (id) => new RegExp(`<div class="bpt[^"]*" id="${id}">.*?</span></div>`, 's');
  const [reA, reB] = [tabRe(a.tabId), tabRe(b.tabId)];
  const tabA = reA.exec(authoritativeHtml);
  const tabB = reB.exec(authoritativeHtml);
  assert.ok(tabA && tabB, 'precondition: both step tabs were located in the source');

  const mutated = authoritativeHtml.replace(reA, '@@A@@').replace(reB, tabA[0]).replace('@@A@@', tabB[0]);
  const rendered = renderedSteps(new JSDOM(mutated).window.document);

  assert.deepEqual(
    rendered.map((s) => s.id),
    [steps[0].tabId, steps[1].tabId, b.tabId, a.tabId, steps[4].tabId, steps[5].tabId],
    'precondition: the mutation really swapped the two tabs in the DOM',
  );
  assert.notDeepEqual(
    rendered,
    steps.map((s) => ({ id: s.tabId, label: s.label })),
    'a physical step reorder must not compare equal to the manifest order',
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

test('hidden, script and comment decoys cannot satisfy an anchored assertion', () => {
  const entry = canonical.authoritative.anchoredText.find((e) => e.id === 'card-mandatory');
  const original = entry.texts[0];
  const open = `<div class="booking-modal-ov" id="${bookingRootId}">`;

  const decoys = {
    'display:none element': `<div style="display:none">${original}</div>`,
    'hidden attribute': `<div hidden>${original}</div>`,
    '<script> text': `<script type="text/plain">${original}</script>`,
    'HTML comment': `<!-- ${original} -->`,
    '<template> content': `<template><div class="fl">${original}</div></template>`,
  };

  for (const [label, decoy] of Object.entries(decoys)) {
    const mutated = authoritativeHtml.replace(original, 'Card on File Optional').replace(open, open + decoy);
    assert.ok(mutated !== authoritativeHtml, `precondition: the ${label} mutation applied`);

    const surface = bookingSurface(mutated);
    const drifted = anchoredDrift(surface.modal, canonical.authoritative.anchoredText);
    assert.ok(
      drifted.some((d) => d.startsWith(`[${entry.id}]`)),
      `a ${label} decoy masked drift on [${entry.id}]:\n  ${drifted.join('\n  ')}`,
    );
  }
});

test('booking entry CTA semantics hold on the authoritative page', () => {
  const doc = new JSDOM(authoritativeHtml).window.document;
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

test('the authoritative zero-charge promise is rendered as a zero amount plus its label', () => {
  // Presentation invariant. The fixture stores NO amount and NO currency: it names
  // the elements and requires that the value renders numerically zero. That keeps
  // the "nothing is charged today" promise pinned without this file ever asserting
  // a price, which would move commercial authority into a copy fixture.
  const entry = canonical.zeroChargePromise;
  const doc = new JSDOM(authoritativeHtml).window.document;
  stripNonVisible(doc.body, doc);

  const items = [...doc.querySelectorAll(entry.anchor)];
  assert.equal(items.length, 1, `[${entry.id}] ${entry.anchor} must resolve to exactly one element, found ${items.length}`);

  const value = norm(items[0].querySelector(entry.valueSelector)?.textContent);
  const label = norm(items[0].querySelector(entry.labelSelector)?.textContent);

  const digits = value.replace(/[^0-9.]/g, '');
  assert.ok(digits.length > 0, `[${entry.id}] the value "${value}" carries no amount at all — ${entry.why}`);
  assert.equal(Number(digits), 0, `[${entry.id}] the promised amount must render as zero, got "${value}" — ${entry.why}`);
  assert.match(value, new RegExp(entry.valueMustMatch, 'i'), `[${entry.id}] the value must still say when: "${value}"`);
  assert.equal(label, entry.label, `[${entry.id}] the saved-vs-charged label drifted — ${entry.why}`);
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
    read(`assets/${bridgeScript.split('/').pop()}`),
    /four-step/i,
    'the booking bridge header still documents a four-step flow',
  );
});

// ── The manifest may never acquire authority ─────────────────────────────────

test('the manifest stays presentation-only', () => {
  const payload = [
    ...canonical.authoritative.elements.map((e) => e.text),
    ...canonical.authoritative.anchoredText.flatMap((e) => e.texts),
    ...canonical.authoritative.entryCta.discovery.map((e) => e.text),
    ...canonical.forbidden.map((e) => e.pattern),
    canonical.zeroChargePromise.label,
    canonical.zeroChargePromise.valueMustMatch,
  ].join('\n');

  assert.doesNotMatch(payload, /\$\d/, 'a canonical string carries a currency amount — pricing authority must not move here');
  assert.doesNotMatch(payload, /\d+[.,]\d{2}\b/, 'a canonical string carries a decimal money value');
  for (const token of ['bookingVersion', 'quoteVersion', 'paymentIntent', 'setupIntent', 'ledger', 'stripeCustomerId', 'draftSaveToken']) {
    assert.ok(!payload.includes(token), `a canonical string references ${token} — this manifest must not carry transaction authority`);
  }
});
