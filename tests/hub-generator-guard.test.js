// scripts/generate-hub-pages.js must not be able to destroy the live hub pages.
//
// It rebuilds six hub pages from template-city.html. The template and the live
// pages diverged long ago, so on an unmodified checkout the previous version
// rewrote all six — 645–2,281 changed lines each, ~7,000 in total — and exited
// 0. It was also emitting BROKEN pages: three of its substitutions no longer
// match the template, including the one that injects initHubZipFromQuery, and a
// plain String.replace that matches nothing is a silent no-op.
//
// Three guards, each proved here:
//   1. dry run by default — writing needs --write
//   2. a write that would remove content from an existing page is refused
//   3. a substitution matching nothing is a hard error, so a half-customised
//      page can never be produced, not even with --force
//
// Everything runs in a temp directory. The checkout is never written to.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const GENERATOR = 'scripts/generate-hub-pages.js';
const HUB = 'bergen-county-hub.html';

const run = (dir, ...args) =>
  spawnSync(process.execPath, [GENERATOR, ...args], { cwd: dir, encoding: 'utf8' });

/** A synthetic publish root whose template still satisfies every substitution. */
function sandbox({ template = healthyTemplate(), files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd1-hubgen-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, GENERATOR), path.join(dir, GENERATOR));
  fs.writeFileSync(path.join(dir, 'template-city.html'), template);
  for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body);
  return dir;
}

/** Carries every anchor the generator substitutes on. */
function healthyTemplate() {
  return [
    '<!--',
    '  CITY LANDING PAGE TEMPLATE — replace tokens per city:',
    '-->',
    '<link rel="canonical" href="https://cardetail1.com/">',
    '<meta property="og:url" content="https://cardetail1.com/">',
    '<title>Mobile Detailing in {CITY_NAME} | Cardetail1</title>',
    `<a class="nav-brand-img" href="#" onclick="window.scrollTo({top:0,behavior:'smooth'});return false;" aria-label="Cardetail1 Home">`,
    '<a class="btn-primary" style="font-size:15px;padding:18px 36px;margin-bottom:8px" onclick="openBooking(null)">Book Mobile Detailing →</a>',
    '<div class="hero-badge">📍 Serving {CITY_NAME} &amp; Surrounding Areas | Fully Mobile Service</div>',
    '<div class="foot-areas">Serving Bergen County · Hudson County · Manhattan · Long Island · Fairfield CT · and surrounding areas</div>',
    '      <div class="foot-col">',
    '        <h4>Contact</h4>',
    '<script>',
    'renderReviews();',
    "renderLocationCarousel('default');",
    '</script>',
    'UNIQUE-LIVE-CONTENT-MARKER',
  ].join('\n');
}

// ── Guard 3: the template as it stands today ────────────────────────────────

test('the real template no longer satisfies the generator, and that is a hard error', () => {
  const r = run(root);
  assert.notEqual(r.status, 0, 'the generator must refuse to run against the drifted template');
  assert.match(r.stderr, /matched nothing in template-city\.html/);
  // The genuinely drifted substitution. Deliberately not asserting a COUNT or a
  // full list: an earlier version did, and it passed on a CRLF checkout while
  // failing in CI, because two multi-line substitutions miss only when the
  // template carries CRLF. The generator now normalises on read, so this is the
  // one real miss on every platform.
  assert.match(r.stderr, /footer service areas/, 'the report must name the drifted substitution');
});

test('substitution matching does not depend on the checkout line endings', () => {
  // The failure mode the normalisation closes: a multi-line literal silently
  // no-ops on CRLF, so the page ships without its footer block or ZIP prefill.
  const crlf = healthyTemplate().replace(/\n/g, '\r\n');
  const dir = sandbox({ template: crlf });
  try {
    const r = run(dir, '--write', `--only=${HUB}`);
    assert.equal(r.status, 0, `a CRLF template must generate identically:\n${r.stdout}${r.stderr}`);
    const html = fs.readFileSync(path.join(dir, HUB), 'utf8');
    assert.match(html, /Quick Links/, 'the multi-line footer substitution must apply on a CRLF template');
    assert.match(html, /initHubZipFromQuery/, 'the multi-line ZIP substitution must apply on a CRLF template');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--write --force cannot produce a half-customised page', () => {
  const before = fs.readFileSync(path.join(root, HUB), 'utf8');
  const r = run(root, '--write', '--force');
  assert.notEqual(r.status, 0, 'forcing must not bypass a broken template');
  assert.equal(
    fs.readFileSync(path.join(root, HUB), 'utf8'), before,
    'the live hub page must be byte-identical after a forced run against a drifted template',
  );
});

// ── Guard 1: dry run by default ──────────────────────────────────────────────

test('a healthy template still writes nothing without --write', () => {
  const dir = sandbox();
  try {
    const r = run(dir, `--only=${HUB}`);
    assert.equal(r.status, 0, `dry run should succeed:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /Dry run\. Nothing was written/);
    assert.equal(fs.existsSync(path.join(dir, HUB)), false, 'dry run must not create the page');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--write creates a page that does not exist yet — the legitimate use', () => {
  const dir = sandbox();
  try {
    const r = run(dir, '--write', `--only=${HUB}`);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.ok(fs.existsSync(path.join(dir, HUB)), 'adding a new city must still work');
    const html = fs.readFileSync(path.join(dir, HUB), 'utf8');
    assert.match(html, /Bergen County/, 'the city name must be interpolated');
    assert.match(html, /initHubZipFromQuery/, 'the ZIP initialiser must be injected');
    assert.match(html, /Quick Links/, 'the footer block must be injected');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Guard 2: never silently destroy a diverged page ─────────────────────────

test('a write that would remove content from an existing page is refused', () => {
  const dir = sandbox();
  try {
    run(dir, '--write', `--only=${HUB}`);
    // Simulate the real situation: the live page gained content the template
    // does not have.
    const live = fs.readFileSync(path.join(dir, HUB), 'utf8') +
      '\n<div class="state-hub-theme">hand-authored content the template never had</div>\n';
    fs.writeFileSync(path.join(dir, HUB), live);

    const r = run(dir, '--write', `--only=${HUB}`);
    assert.equal(r.status, 1, 'regenerating over diverged content must fail');
    assert.match(r.stderr, /REFUSED/);
    assert.match(r.stderr, /would remove \d+ line\(s\)/);
    assert.equal(
      fs.readFileSync(path.join(dir, HUB), 'utf8'), live,
      'the diverged page must be left byte-identical',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--force overwrites a diverged page, but only after reporting what is lost', () => {
  // The escape hatch must exist and must be explicit — otherwise the guard just
  // moves the hazard to "delete the guard".
  const dir = sandbox();
  try {
    run(dir, '--write', `--only=${HUB}`);
    const generated = fs.readFileSync(path.join(dir, HUB), 'utf8');
    fs.writeFileSync(path.join(dir, HUB), `${generated}\n<div>diverged</div>\n`);

    const r = run(dir, '--write', '--force', `--only=${HUB}`);
    assert.match(r.stderr, /REFUSED/, '--force must still report what it is discarding');
    assert.match(r.stderr, /overwriting .* anyway/);
    assert.equal(r.status, 0);
    assert.equal(fs.readFileSync(path.join(dir, HUB), 'utf8'), generated, '--force must actually overwrite');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unchanged page is reported as such and not rewritten', () => {
  const dir = sandbox();
  try {
    run(dir, '--write', `--only=${HUB}`);
    const before = fs.statSync(path.join(dir, HUB)).mtimeMs;
    const r = run(dir, '--write', `--only=${HUB}`);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[same\]/);
    assert.equal(fs.statSync(path.join(dir, HUB)).mtimeMs, before, 'an identical page must not be rewritten');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a drifted synthetic template is caught the same way as the real one', () => {
  // Guard 3 in isolation, so the first test is not the only thing proving it.
  const dir = sandbox({ template: healthyTemplate().replace("renderLocationCarousel('default');", '') });
  try {
    const r = run(dir, '--write', `--only=${HUB}`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ZIP-from-query initialiser/);
    assert.equal(fs.existsSync(path.join(dir, HUB)), false, 'nothing may be written when a substitution is broken');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
