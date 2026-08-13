// Conversion-funnel trust copy (P1).
//
// The booking flow is a *request*: submitting does not confirm an appointment,
// and the card is saved (not charged) so the request can be processed. Public
// copy used to promise the opposite ("card holds your slot" / "Lock Your Slot").
// These tests pin the honest wording so the contradiction cannot come back —
// including through scripts/apply-state-hub-theme.mjs, which regenerates hubs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

/** Every public page that renders the 6-step booking modal. */
const bookingPages = fs
  .readdirSync(root)
  .filter((file) => file.endsWith('.html'))
  .filter((file) => read(file).includes('Before saving your card, please note:'));

/** Every public HTML page plus the hub generator. */
const publicSources = [
  ...fs.readdirSync(root).filter((f) => f.endsWith('.html')),
  'scripts/apply-state-hub-theme.mjs',
];

test('booking pages are discovered (guards the selector itself)', () => {
  assert.equal(bookingPages.length, 13, 'expected 13 pages carrying the booking modal');
});

// ── A. No page promises the card reserves the slot ────────────────────────────

test('no public source promises the card holds or locks a slot', () => {
  for (const file of publicSources) {
    const src = read(file);
    assert.doesNotMatch(src, /holds? your slot/i, `${file} still promises the card holds a slot`);
    assert.doesNotMatch(src, /Lock Your Slot/i, `${file} still promises to lock a slot`);
    assert.doesNotMatch(
      src,
      /required to secure the booking\./i,
      `${file} still says the card secures the booking`,
    );
  }
});

test('the request-only contract stays stated where the card is asked for', () => {
  for (const page of bookingPages) {
    const html = read(page);
    assert.match(
      html,
      /A card on file is still required to submit the booking request\./,
      `${page} lost the request-only payment-preference copy`,
    );
    assert.match(
      html,
      /<div class="card-gate-title">Save Your Card<\/div>/,
      `${page} lost the neutral card-gate title`,
    );
    // Two equivalent honest wordings ship across the page families: the state
    // hubs/index carry the "does not confirm" bullet, the county/city pages
    // carry the stronger "Booking review" bullet. Either satisfies the contract.
    assert.match(
      html,
      /It does not confirm the appointment; we text you once it is confirmed\.|Submitting a request does not guarantee an appointment\./,
      `${page} lost the "a request is not a confirmed appointment" policy bullet`,
    );
    // The pre-existing honest statements must survive.
    assert.match(html, /Charged today/, `${page} lost the charged-today row`);
    assert.match(html, /booking request only/, `${page} lost the request-only confirm row`);
  }
});

test('terms and public copy agree that a request is not an appointment', () => {
  assert.match(read('terms-conditions.html'), /does not guarantee an appointment/i);
  assert.match(read('index.html'), /This sends a booking request/);
});

// ── B. Water / power is planning info, not a prerequisite ─────────────────────

test('water and power questions are optional and contradict nothing', () => {
  for (const page of bookingPages) {
    const html = read(page);
    assert.match(html, /<div class="fl">Water access — Optional<\/div>/, `${page} water label`);
    assert.match(html, /<div class="fl">Electricity access — Optional<\/div>/, `${page} power label`);
    assert.match(
      html,
      /<strong>We bring our own water and power<\/strong>/,
      `${page} lost the bring-our-own reassurance`,
    );
    // Operations still consume these — the fields themselves must not disappear.
    assert.match(html, /id="f-water"/, `${page} lost the water field`);
    assert.match(html, /id="f-electric"/, `${page} lost the electricity field`);
  }
});

test('water and power values still reach the submitted booking payload', () => {
  const index = read('index.html');
  assert.match(index, /waterAvailable: document\.getElementById\('f-water'\)/);
  assert.match(index, /electricityAvailable: document\.getElementById\('f-electric'\)/);
});

test('neither utility field is required to advance past the contact step', () => {
  const index = read('index.html');
  const required = /const req = \[([^\]]*)\]/.exec(index);
  assert.ok(required, 'could not find the required-field list in bkContinueFromContact');
  assert.doesNotMatch(required[1], /f-water|f-electric/);
});

// ── C. CTA hierarchy: discovery at cold entry, booking still reachable ────────

test('cold-traffic entry points use discovery language', () => {
  assert.match(
    read('index.html'),
    /onclick="openBooking\(null\)">Check Price &amp; Availability<\/button>/,
    'index hero CTA is not the discovery CTA',
  );
  for (const page of bookingPages) {
    const html = read(page);
    assert.doesNotMatch(
      html,
      /<a class="nav-cta[^>]*>Book Now<\/a>/,
      `${page} nav CTA still says Book Now`,
    );
    assert.doesNotMatch(
      html,
      /<button class="msc-book[^>]*>Book Now<\/button>/,
      `${page} sticky CTA still says Book Now`,
    );
  }
});

test('the ZIP button no longer claims to book', () => {
  for (const page of publicSources) {
    assert.doesNotMatch(
      read(page),
      /class="hero-zip-btn"[^>]*>BOOK NOW</,
      `${page} ZIP button still labelled BOOK NOW`,
    );
  }
});

test('discovery CTAs still open the same booking flow', () => {
  for (const page of bookingPages) {
    const html = read(page);
    assert.match(html, /class="nav-cta[^"]*"[^>]*onclick="openBooking\(null\)"|class="nav-cta" href="index\.html"/,
      `${page} nav CTA lost its booking entry point`);
    assert.match(html, /function openBooking\(/, `${page} lost openBooking()`);
  }
});

test('in-context CTAs keep booking intent (the hierarchy has two levels)', () => {
  const index = read('index.html');
  assert.match(index, />Book Your Detail<\/button>/, 'index lost its lower-funnel booking CTA');
});

// ── D. Availability copy must track the enforced scheduling rule ──────────────

test('the "days out" notice matches the enforced minimum advance', () => {
  const lib = read('netlify/lib/operational-availability.js');
  const declared = /const MIN_ADVANCE_DAYS = (\d+);/.exec(lib);
  assert.ok(declared, 'MIN_ADVANCE_DAYS not found');
  const days = Number(declared[1]);

  const index = read('index.html');
  const clientLead = /d\.setDate\(d\.getDate\(\)\+(\d+)\);return bkToIso\(d\)/.exec(index);
  assert.ok(clientLead, 'bkEarliestBookable lead time not found');
  assert.equal(
    Number(clientLead[1]),
    days,
    'client date floor drifted from the server MIN_ADVANCE_DAYS',
  );

  for (const page of bookingPages) {
    const html = read(page);
    if (!html.includes('Next available appointments are typically')) continue;
    assert.match(
      html,
      new RegExp(`Next available appointments are typically ${days} days out\\.`),
      `${page} advance notice contradicts MIN_ADVANCE_DAYS=${days}`,
    );
  }
});

// ── E. Customer / Admin separation ───────────────────────────────────────────

test('the staff credential form never paints first on a customer page', () => {
  for (const page of bookingPages) {
    const html = read(page);
    if (!html.includes('id="login-staff"')) continue;
    assert.match(
      html,
      /<div id="login-staff" style="display:none">/,
      `${page} can paint the admin login form before setLoginRole() runs`,
    );
  }
});

test('openLogin always opens on the customer role', () => {
  const index = read('index.html');
  assert.match(index, /function openLogin\(\)\{[\s\S]*?setLoginRole\('customer'\);[\s\S]*?\}/);
});
