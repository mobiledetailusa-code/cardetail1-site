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
// Properties this file is responsible for. Each is proved by a mutation that makes
// it fail, not by the suite being green:
//
//   1. DISCOVERY is pure DOM. EVERY published .html is parsed — there is no byte
//      prefilter, because any textual shortcut produces false negatives on valid
//      HTML (`id="bk&#x2d;ov"` is the same element as `id="bk-ov"` after parsing).
//
//   2. DELEGATION is path-semantic. The bridge <script src> must resolve, relative
//      to the page's own location, to the exact publish-root path the public-page
//      contract specifies. A same-basename script in another directory does not
//      qualify, and neither does the path in a comment or a string.
//
//   3. ROLES are LIVE, not declared. Public fallback pages must be in sitemap.xml
//      and must not be the generator's template; the template must be the
//      generator's input and must not be in sitemap.xml. Swapping the two fails.
//
//   4. ORDER is deterministic. Directory traversal and every diagnostic list are
//      sorted, and paths are normalised to POSIX, so results do not depend on the
//      filesystem's enumeration order or on the host OS separator.
//
//   5. COPY assertions are ANCHORED and carry an explicit STRUCTURAL VISIBILITY
//      contract. See $visibility in the manifest for exactly what that does and
//      does not cover — it is not browser computed style.
//
//   6. STEP ORDER is read from the physical DOM, not by looking each id up in
//      manifest order, which would impose the manifest's own order on the result.
//
//   7. SYMLINKS are rejected when encountered in the publish tree. The scanner
//      never follows them or silently treats their target as a canonical page;
//      deploy identity must remain an authored, publish-root-relative path.
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
const {
  bookingRootId, bridgePath, scanExcludedDirs, stepTabContainer, stepTabSelector, roleEvidence,
} = canonical.surfaceRules;

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
/** Native separators to POSIX, so classification never depends on the host OS. */
const toPosix = (p) => p.split(path.sep).join('/');
const sorted = (list) => [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// ── Publish-root discovery ───────────────────────────────────────────────────

/**
 * Every .html served from a publish root, at any depth, as POSIX-relative paths.
 * Directory entries are sorted so traversal order is identical on every
 * filesystem; excludes dot-directories and the role-based directories in the
 * manifest, matched against the path relative to the publish root.
 */
function listPublishedHtml(publishRoot, excluded, dir = publishRoot, rel = '') {
  const out = [];
  const entries = [...fs.readdirSync(dir, { withFileTypes: true })].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink())) continue;
    if (excluded.includes(relPath)) continue;
    rejectPublishedSymlink(entry, relPath);
    if (entry.isDirectory()) {
      out.push(...listPublishedHtml(publishRoot, excluded, path.join(dir, entry.name), relPath));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      out.push(toPosix(relPath));
    }
  }
  return sorted(out);
}

/**
 * A deployed page must have one canonical authored path. Following a symlink can
 * escape the publish tree; ignoring one can omit a deployable surface. Rejecting
 * it makes both the boundary and the diagnostic explicit on every platform.
 */
function rejectPublishedSymlink(entry, relPath) {
  if (entry.isSymbolicLink()) {
    throw new Error(`published-tree symlink is not allowed: ${toPosix(relPath)}`);
  }
}

/**
 * Resolve a script's src to a publish-root-relative POSIX path, the way a browser
 * loading `pageRel` would. Returns null for anything that cannot be a local
 * publish-root asset (absolute URL, protocol-relative, or an escape above root).
 */
function resolveScriptPath(src, pageRel) {
  const clean = String(src || '').split('#')[0].split('?')[0].trim();
  if (!clean) return null;
  if (clean.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null;
  const joined = clean.startsWith('/')
    ? clean.slice(1)
    : path.posix.join(path.posix.dirname(pageRel), clean);
  const resolved = path.posix.normalize(joined);
  return resolved.startsWith('../') ? null : resolved;
}

/**
 * DOM role of one page. Both halves read the parsed document.
 *
 * `isSurface`  — the document really contains an element with the booking id.
 *                Entity-encoded and single-quoted forms are the same element once
 *                parsed; a modal in a comment, in <script> text or in <template>
 *                is not an element in the document and classifies nothing.
 * `delegates`  — a real <script src> resolves to the contracted bridge path.
 *                Same basename in another directory does not qualify.
 */
function pageRole(html, pageRel) {
  const doc = new JSDOM(html).window.document;
  const scripts = [...doc.querySelectorAll('script[src]')]
    .map((s) => resolveScriptPath(s.getAttribute('src'), pageRel))
    .filter(Boolean);
  return {
    isSurface: !!doc.getElementById(bookingRootId),
    delegates: scripts.includes(bridgePath),
    scripts,
  };
}

/**
 * Structural classification of every booking surface under a publish root.
 * Root and manifest are injected, so this runs against a synthetic tree without
 * the real checkout ever being written to.
 */
function classifyBookingSurfaces(publishRoot, manifest, excluded = scanExcludedDirs) {
  const { authoritative = [], fallbackPublic: fbPublic = [], fallbackTemplate: fbTemplate = [] } = manifest;
  const pages = listPublishedHtml(publishRoot, excluded);

  // No prefilter: every published page is parsed. A textual shortcut would miss
  // DOM-equivalent encodings of the booking id.
  const surfaces = [];
  const roles = new Map();
  for (const page of pages) {
    const role = pageRole(fs.readFileSync(path.join(publishRoot, ...page.split('/')), 'utf8'), page);
    if (!role.isSurface) continue;
    surfaces.push(page);
    roles.set(page, role);
  }

  const declared = [...authoritative, ...fbPublic, ...fbTemplate];
  const unclassified = sorted(surfaces.filter((f) => !declared.includes(f)));
  const missing = sorted(declared.filter((f) => !surfaces.includes(f)));
  const overlapping = sorted(declared.filter((f, i) => declared.indexOf(f) !== i));

  const misclassified = [];
  for (const page of surfaces) {
    if (unclassified.includes(page)) continue;
    const { delegates } = roles.get(page);
    const expected = delegates ? 'fallback' : 'authoritative';
    const actual = authoritative.includes(page) ? 'authoritative' : 'fallback';
    if (actual !== expected) {
      misclassified.push(
        `${page} is classified ${actual} but ${delegates ? 'loads' : 'does not load'} ${bridgePath} as a resolved <script src>, so it is ${expected}`,
      );
    }
  }

  return { pages, surfaces: sorted(surfaces), unclassified, missing, overlapping, misclassified: sorted(misclassified), roles };
}

const REPO_MANIFEST = { authoritative: AUTH_PAGES, fallbackPublic, fallbackTemplate };

/** Classifying the real checkout parses every published page; do it once. */
let repoClassificationCache = null;
const repoClassification = () => (repoClassificationCache ??= classifyBookingSurfaces(root, REPO_MANIFEST));

/** Build a throwaway publish root. Unique per call, so concurrent runs never collide. */
function makeSyntheticRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd1-drift-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return dir;
}

// ── Live role evidence ───────────────────────────────────────────────────────

/** Publish-root-relative paths that sitemap.xml actually advertises. */
function sitemapPaths() {
  const locs = [...read(roleEvidence.sitemap).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  return locs.map((loc) => {
    const pathname = /^[a-z][a-z0-9+.-]*:/i.test(loc) ? new URL(loc).pathname : loc;
    const rel = pathname.replace(/^\/+/, '');
    return rel === '' ? roleEvidence.rootDocument : rel;
  });
}

/** The file the hub generator actually reads as its template. Read-only. */
function generatorTemplate() {
  const src = read(roleEvidence.templateConsumer);
  const m = /readFileSync\(\s*path\.join\(\s*root\s*,\s*['"]([^'"]+)['"]\s*\)/.exec(src);
  assert.ok(m, `could not determine the template input of ${roleEvidence.templateConsumer}`);
  return m[1];
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
 * Structural hidden markers on an element or any ancestor up to `stopAt`.
 *
 * This is the ONLY visibility model this suite has. It covers markers that are
 * legible in the markup itself. It does NOT evaluate computed style, so
 * visibility driven by an external stylesheet or by a class remains a
 * browser-preview concern — see $visibility in the manifest.
 */
function structuralHiddenMarkers(el, stopAt) {
  const hits = [];
  for (let n = el; n && n !== stopAt.parentNode; n = n.parentElement) {
    const style = n.getAttribute('style') || '';
    const where = n === el ? 'self' : `ancestor <${n.tagName.toLowerCase()}${n.id ? ` id="${n.id}"` : ''}>`;
    if (n.hasAttribute('hidden')) hits.push(`${where} [hidden]`);
    if (n.getAttribute('aria-hidden') === 'true') hits.push(`${where} aria-hidden="true"`);
    if (/display\s*:\s*none/i.test(style)) hits.push(`${where} inline display:none`);
    if (/visibility\s*:\s*hidden/i.test(style)) hits.push(`${where} inline visibility:hidden`);
  }
  return hits;
}

/**
 * Compare each anchored entry against the elements its anchor resolves to, and
 * enforce its structural-visibility contract. The element count must equal the
 * expected text count, so an extra element matching the anchor (a decoy) fails
 * just as loudly as drifted wording.
 */
function anchoredDrift(modal, entries, doc) {
  const drifted = [];
  for (const entry of entries) {
    const els = [...modal.querySelectorAll(entry.anchor)];
    const found = els.map((el) => norm(el.textContent));
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

    // Structural visibility. Absent `visibility` means: every element must be free
    // of structural hidden markers.
    const exempt = entry.visibility?.exemptIndices ?? [];
    const hiddenIdx = [];
    els.forEach((el, i) => {
      const marks = structuralHiddenMarkers(el, modal);
      if (marks.length === 0) return;
      hiddenIdx.push(i);
      if (!exempt.includes(i)) {
        drifted.push(
          `[${entry.id}] ${entry.anchor} (element ${i + 1} of ${els.length}) is structurally hidden: ${marks.join(', ')}` +
            `\n    required authoritative copy must not be satisfied by hidden markup` +
            `\n    why     : ${entry.why}`,
        );
      }
    });

    // An exemption that is no longer needed is stale and must be removed, so the
    // fixture stays an accurate record of what is progressively disclosed.
    if (JSON.stringify(sorted(exempt.map(String))) !== JSON.stringify(sorted(hiddenIdx.map(String)))) {
      drifted.push(
        `[${entry.id}] declared visibility exemptions ${JSON.stringify(exempt)} do not match the elements that are actually hidden ${JSON.stringify(hiddenIdx)}`,
      );
    }
    // Every exemption must name a control that really exists, so a progressive
    // disclosure cannot be claimed for something nothing can reveal.
    if (exempt.length > 0 && doc) {
      const revealedBy = entry.visibility?.revealedBy;
      assert.ok(revealedBy, `[${entry.id}] declares visibility exemptions but no revealedBy control`);
      assert.ok(
        doc.querySelector(revealedBy),
        `[${entry.id}] revealedBy control ${revealedBy} is not rendered, so the exemption is unjustified`,
      );
    }
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

test('discovery parses every published page — no textual prefilter, so encodings cannot hide a surface', () => {
  const { pages, surfaces } = repoClassification();

  // Determinism: the walk is sorted and POSIX-normalised.
  assert.deepEqual(pages, sorted(pages), 'published page list must be sorted');
  assert.deepEqual(surfaces, sorted(surfaces), 'surface list must be sorted');
  assert.ok(!pages.some((p) => p.includes('\\')), 'paths must be POSIX-normalised, not native-separator');

  // A DOM-equivalent encoding of the booking id is the same element after parsing
  // and must classify identically to the plain and single-quoted forms.
  const body = (idAttr) => `<!doctype html><html><body><div class="booking-modal-ov" ${idAttr}>Book</div></body></html>`;
  const dir = makeSyntheticRoot({
    'plain.html': body(`id="${bookingRootId}"`),
    'single-quoted.html': body(`id='${bookingRootId}'`),
    'entity-encoded.html': body('id="bk&#x2d;ov"'),
    'decimal-entity.html': body('id="bk&#45;ov"'),
  });
  try {
    const r = classifyBookingSurfaces(dir, {}, []);
    assert.deepEqual(
      r.surfaces,
      ['decimal-entity.html', 'entity-encoded.html', 'plain.html', 'single-quoted.html'],
      'every DOM-equivalent spelling of the booking id must be discovered identically — a byte prefilter would miss the entity forms',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('delegation is path-semantic: basename alone never proves it', () => {
  const modal = `<div class="booking-modal-ov" id="${bookingRootId}">Book</div>`;
  const base = bridgePath.split('/').pop();
  const dir = makeSyntheticRoot({
    // Correct contract path, and equivalent spellings of it.
    'exact.html': `<html><body>${modal}<script src="${bridgePath}"></script></body></html>`,
    'dot-slash.html': `<html><body>${modal}<script src="./${bridgePath}"></script></body></html>`,
    'root-absolute.html': `<html><body>${modal}<script src="/${bridgePath}"></script></body></html>`,
    'query-string.html': `<html><body>${modal}<script src="${bridgePath}?v=3"></script></body></html>`,
    // Same basename, wrong directory — must NOT qualify.
    'wrong-dir.html': `<html><body>${modal}<script src="js/${base}"></script></body></html>`,
    'vendor-dir.html': `<html><body>${modal}<script src="vendor/assets/${base}"></script></body></html>`,
    'off-site.html': `<html><body>${modal}<script src="https://cdn.example.com/${bridgePath}"></script></body></html>`,
    // The path only as text — must NOT qualify.
    'commented.html': `<html><body>${modal}<!-- <script src="${bridgePath}"></script> --></body></html>`,
    'stringified.html': `<html><body>${modal}<script>var s = "${bridgePath}";</script></body></html>`,
    // Nested page: a relative src must resolve against the page's own directory.
    'deep/nested.html': `<html><body>${modal}<script src="../${bridgePath}"></script></body></html>`,
    'deep/wrong-relative.html': `<html><body>${modal}<script src="${bridgePath}"></script></body></html>`,
  });
  try {
    const r = classifyBookingSurfaces(dir, {}, []);
    const delegates = (p) => r.roles.get(p).delegates;

    for (const page of ['exact.html', 'dot-slash.html', 'root-absolute.html', 'query-string.html', 'deep/nested.html']) {
      assert.equal(delegates(page), true, `${page} loads the contracted bridge path and must delegate`);
    }
    for (const page of ['wrong-dir.html', 'vendor-dir.html', 'off-site.html', 'commented.html', 'stringified.html', 'deep/wrong-relative.html']) {
      assert.equal(delegates(page), false, `${page} must NOT count as delegating — it does not resolve to ${bridgePath}`);
    }
    // deep/wrong-relative.html resolves to deep/assets/... , proving resolution is
    // relative to the page, not a bare basename or substring match.
    assert.deepEqual(r.roles.get('deep/wrong-relative.html').scripts, [`deep/${bridgePath}`]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery descends into subdirectories and reports a nested unregistered surface', () => {
  const { pages } = repoClassification();
  assert.ok(
    pages.some((p) => p.includes('/')),
    'discovery found no nested .html at all — either the walk stopped at the root or scanExcludedDirs is swallowing served directories',
  );

  const dir = makeSyntheticRoot({
    'index.html': `<!doctype html><html><body><div id="${bookingRootId}">Book</div></body></html>`,
    'cities/boston-hub.html': `<!doctype html><html><body><div id="${bookingRootId}">Book</div></body></html>`,
  });
  try {
    const r = classifyBookingSurfaces(dir, { authoritative: ['index.html'] }, []);
    assert.deepEqual(
      r.unclassified,
      ['cities/boston-hub.html'],
      'a nested booking page absent from the manifest must be reported as unclassified, by POSIX path',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('published-tree symlinks are rejected rather than followed or silently ignored', () => {
  const symlinkEntry = { isSymbolicLink: () => true };
  assert.throws(
    () => rejectPublishedSymlink(symlinkEntry, path.join('cities', 'linked-booking.html')),
    /published-tree symlink is not allowed: cities\/linked-booking\.html/,
  );
});

// ── Roles are live, not declared ─────────────────────────────────────────────

test('public and template roles are proved against sitemap.xml and the generator, not just declared', () => {
  const advertised = sitemapPaths();
  const templateInput = generatorTemplate();

  // Authoritative and every public fallback are advertised to customers.
  for (const page of AUTH_PAGES) {
    assert.ok(advertised.includes(page), `${page} is authoritative but ${roleEvidence.sitemap} does not advertise it`);
  }
  for (const page of fallbackPublic) {
    assert.ok(
      advertised.includes(page),
      `${page} is declared a PUBLIC fallback surface but ${roleEvidence.sitemap} does not advertise it — it is not public`,
    );
    assert.notEqual(
      page, templateInput,
      `${page} is declared public but is the template ${roleEvidence.templateConsumer} generates from`,
    );
  }

  // The template is the generator's input and is deliberately not advertised.
  for (const page of fallbackTemplate) {
    assert.equal(
      page, templateInput,
      `${page} is declared a TEMPLATE but ${roleEvidence.templateConsumer} does not generate from it`,
    );
    assert.ok(
      !advertised.includes(page),
      `${page} is declared a template but ${roleEvidence.sitemap} advertises it as a public page`,
    );
  }

  assert.equal(fallbackTemplate.length, 1, 'exactly one template is expected; a second would need its own evidence');
});

test('the three surface roles stay distinct and account for every surface', () => {
  const { surfaces, roles } = repoClassification();

  const sets = { authoritative: AUTH_PAGES, fallbackPublic, fallbackTemplate };
  for (const [a, b] of [['authoritative', 'fallbackPublic'], ['authoritative', 'fallbackTemplate'], ['fallbackPublic', 'fallbackTemplate']]) {
    const shared = sets[a].filter((f) => sets[b].includes(f));
    assert.deepEqual(shared, [], `${a} and ${b} both claim: ${shared.join(', ')}`);
  }

  assert.deepEqual(
    surfaces,
    sorted([...AUTH_PAGES, ...fallbackPublic, ...fallbackTemplate]),
    'the union of the three roles must be exactly the set of discovered booking surfaces',
  );

  for (const page of AUTH_PAGES) assert.equal(roles.get(page).delegates, false, `${page} is authoritative but delegates`);
  for (const page of FALLBACK_PAGES) assert.equal(roles.get(page).delegates, true, `${page} is fallback but does not delegate`);
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

  const rendered = renderedSteps(authoritative.doc);
  assert.deepEqual(
    rendered,
    canonical.authoritative.steps.map((s) => ({ id: s.tabId, label: s.label })),
    'booking step ids, labels or their physical DOM order drifted from the manifest',
  );
});

test('a physical reorder of two step tabs is detected', () => {
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

test('canonical sentences render on their own anchored, structurally visible element', () => {
  const drifted = anchoredDrift(authoritative.modal, canonical.authoritative.anchoredText, authoritative.doc);
  assert.deepEqual(
    drifted,
    [],
    `anchored booking copy drifted on ${authoritativePage}` +
      ` (comments, <script> and <template> content do not count; an unexpected extra match and undeclared hidden markup are drift too):\n  ${drifted.join('\n  ')}`,
  );
});

test('required authoritative copy cannot be satisfied by structurally hidden markup', () => {
  // Each shape is applied to the real anchored element of a required entry.
  const entry = canonical.authoritative.anchoredText.find((e) => e.id === 'request-first-badge');
  const original = `<div class="pay-badge">${entry.texts[0]}</div>`;
  assert.ok(authoritativeHtml.includes(original), 'precondition: the required anchored element was located verbatim');

  const shapes = {
    'hidden attribute': `<div class="pay-badge" hidden>${entry.texts[0]}</div>`,
    'aria-hidden="true"': `<div class="pay-badge" aria-hidden="true">${entry.texts[0]}</div>`,
    'inline display:none': `<div class="pay-badge" style="display:none">${entry.texts[0]}</div>`,
    'inline visibility:hidden': `<div class="pay-badge" style="visibility:hidden">${entry.texts[0]}</div>`,
  };

  for (const [label, replacement] of Object.entries(shapes)) {
    const surface = bookingSurface(authoritativeHtml.replace(original, replacement));
    const drifted = anchoredDrift(surface.modal, [entry], surface.doc);
    assert.ok(
      drifted.some((d) => d.includes('structurally hidden')),
      `[${entry.id}] hidden via ${label} was accepted as required customer-visible copy:\n  ${drifted.join('\n  ')}`,
    );
  }
});

test('hidden, script and comment decoys cannot satisfy an anchored assertion', () => {
  const entry = canonical.authoritative.anchoredText.find((e) => e.id === 'request-first-badge');
  const original = entry.texts[0];
  const open = `<div class="booking-modal-ov" id="${bookingRootId}">`;

  const decoys = {
    'display:none element': `<div style="display:none">${original}</div>`,
    'hidden attribute': `<div hidden>${original}</div>`,
    '<script> text': `<script type="text/plain">${original}</script>`,
    'HTML comment': `<!-- ${original} -->`,
    '<template> content': `<template><div class="pay-badge">${original}</div></template>`,
  };

  for (const [label, decoy] of Object.entries(decoys)) {
    const mutated = authoritativeHtml.replace(original, 'Request now and pay today').replace(open, open + decoy);
    assert.ok(mutated !== authoritativeHtml, `precondition: the ${label} mutation applied`);
    const surface = bookingSurface(mutated);
    const drifted = anchoredDrift(surface.modal, canonical.authoritative.anchoredText, surface.doc);
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
  const entry = canonical.zeroChargePromise;
  const doc = new JSDOM(authoritativeHtml).window.document;
  stripNonVisible(doc.body, doc);

  const items = [...doc.querySelectorAll(entry.anchor)];
  assert.equal(items.length, 1, `[${entry.id}] ${entry.anchor} must resolve to exactly one element, found ${items.length}`);
  assert.deepEqual(
    structuralHiddenMarkers(items[0], doc.body), [],
    `[${entry.id}] the promise must not be structurally hidden`,
  );

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
    sorted(drifted),
    [],
    `the hidden fallback modal drifted from the authoritative copy:\n  ${sorted(drifted).join('\n  ')}\n` +
      'If the bridge ever fails to execute this markup becomes visible, so it must not contradict index.html.',
  );
});

// ── Contradictions, everywhere ───────────────────────────────────────────────

test('no surface reintroduces a contradiction that was already removed', () => {
  const scanned = sorted([...AUTH_PAGES, ...FALLBACK_PAGES, 'scripts/apply-state-hub-theme.mjs']);
  const violations = [];
  for (const entry of canonical.forbidden) {
    const re = new RegExp(entry.pattern, entry.flags || '');
    for (const file of scanned) {
      if (re.test(read(file))) violations.push(`[${entry.id}] ${file} — ${entry.why}`);
    }
  }
  assert.deepEqual(sorted(violations), [], `forbidden copy present:\n  ${sorted(violations).join('\n  ')}`);
});

test('documentation and code agree on how many steps the flow has', () => {
  assert.doesNotMatch(
    read(bridgePath),
    /four-step/i,
    `${bridgePath} still documents a four-step flow`,
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
