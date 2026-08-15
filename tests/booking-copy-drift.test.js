// Booking copy drift guard.
//
// The booking modal is physically duplicated across index.html and 12 hub/city
// compatibility pages. Nothing forces those copies to agree, so a sentence fixed
// on one page can survive unfixed on the other twelve — that is exactly how the
// "card holds your slot" contradiction spread.
//
// This test pins every canonical customer-facing booking string to every surface
// that renders it, and fails with the exact page + string id that drifted.
//
// It asserts PRESENTATION ONLY. It does not read or assert any price, total, fee,
// booking state, payment state or confirmation semantics — those live in the
// catalog, the Postgres ledger and the Blob CAS store, and this manifest must
// never become a second source of truth for them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const canonical = JSON.parse(read('tests/fixtures/booking-copy.canonical.json'));
const surfaces = [...canonical.surfaces.authoritative, ...canonical.surfaces.compatibility];

/** Lists every surface missing `text`, so one failure names them all. */
function missingFrom(text) {
  return surfaces.filter((page) => !read(page).includes(text));
}

test('the manifest describes the surfaces that actually exist', () => {
  for (const page of surfaces) {
    assert.ok(
      fs.existsSync(path.join(root, page)),
      `manifest lists ${page}, which is not in the repo — update tests/fixtures/booking-copy.canonical.json`,
    );
  }
  // Any page carrying the card gate must be covered by the manifest, or a new
  // booking surface could ship without ever being drift-checked.
  const carriers = fs
    .readdirSync(root)
    .filter((f) => f.endsWith('.html'))
    .filter((f) => read(f).includes('card-gate-title'));
  const uncovered = carriers.filter((f) => !surfaces.includes(f));
  assert.deepEqual(
    uncovered,
    [],
    `these pages render the card gate but are not in the manifest: ${uncovered.join(', ')}`,
  );
});

test('every canonical booking string is identical on every surface', () => {
  const drifted = [];
  for (const entry of canonical.required) {
    const missing = missingFrom(entry.text);
    if (missing.length) drifted.push({ id: entry.id, missing, text: entry.text, why: entry.why });
  }

  if (drifted.length) {
    const detail = drifted
      .map(
        (d) =>
          `\n  [${d.id}] missing from ${d.missing.length}/${surfaces.length} surfaces:` +
          `\n    pages   : ${d.missing.join(', ')}` +
          `\n    expected: ${d.text}` +
          `\n    why     : ${d.why}`,
      )
      .join('\n');
    assert.fail(`booking copy drifted across surfaces:${detail}\n`);
  }
});

test('no surface reintroduces a contradiction that was already removed', () => {
  const violations = [];
  for (const entry of canonical.forbidden) {
    const re = new RegExp(entry.pattern, entry.flags || '');
    for (const page of surfaces) {
      if (re.test(read(page))) violations.push(`[${entry.id}] ${page} — ${entry.why}`);
    }
    // The hub generator regenerates compatibility pages from index.html, so a
    // contradiction living there would come straight back.
    if (re.test(read('scripts/apply-state-hub-theme.mjs'))) {
      violations.push(`[${entry.id}] scripts/apply-state-hub-theme.mjs — ${entry.why}`);
    }
  }
  assert.deepEqual(violations, [], `forbidden copy present:\n  ${violations.join('\n  ')}`);
});

test('documentation and code agree on how many steps the flow has', () => {
  const index = read('index.html');
  const declared = /const BK_VISIBLE_STEPS = (\d+);/.exec(index);
  assert.ok(declared, `${canonical.flowShape.stepsConstant} not found in index.html`);
  assert.equal(
    Number(declared[1]),
    canonical.flowShape.visibleSteps,
    'index.html renders a different number of steps than the manifest records',
  );

  // The bridge header used to claim a four-step modal.
  const bridge = read('assets/hub-booking-bridge.js');
  assert.doesNotMatch(
    bridge,
    /four-step/i,
    'assets/hub-booking-bridge.js still documents a four-step flow',
  );
});

test('the manifest stays presentation-only', () => {
  // Check the DATA, not the prose: the $purpose block legitimately names the
  // ledger and the state stores in order to say they do not belong here.
  const payload = [
    ...canonical.required.map((e) => e.text),
    ...canonical.forbidden.map((e) => e.pattern),
  ].join('\n');

  assert.doesNotMatch(
    payload,
    /\$\d/,
    'a canonical string carries a currency amount — pricing authority must not move into this manifest',
  );
  for (const token of ['bookingVersion', 'quoteVersion', 'paymentIntent', 'ledger', 'stripeCustomerId']) {
    assert.ok(
      !payload.includes(token),
      `a canonical string references ${token} — this manifest must not carry transaction authority`,
    );
  }
});
