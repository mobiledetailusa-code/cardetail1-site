// Conversion-funnel trust copy (P1).
//
// The booking flow is a *request*: submitting does not confirm an appointment,
// and nothing is charged today. Pay online later requires saving a
// card; card/cash at service do not. Public copy used to promise the opposite
// ("card holds your slot" / "Lock Your Slot").
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
  .filter((file) => read(file).includes('id="bk-ov"'));

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

test('the request-only contract keeps $0 today and requires a card only for Pay online later', () => {
  for (const page of bookingPages) {
    const html = read(page);
    assert.match(
      html,
      /No payment is collected when you submit this booking request\./i,
      `${page} lost the no-charge-today request copy`,
    );
    assert.match(
      html,
      /Choose Pay online later to save a card securely \(nothing charged today\)\./,
      `${page} lost the Pay online later help copy`,
    );
    assert.match(
      html,
      /id="pc-online"[^>]*>\s*<span>Pay online later<\/span>\s*<\/button>/,
      `${page} lost the Pay online later choice (without Recommended badge)`,
    );
    assert.doesNotMatch(
      html,
      /bk-pay-rec-badge/,
      `${page} still shows a Recommended badge on payment choices`,
    );
    assert.doesNotMatch(
      html,
      /recommended payment method|Pay online later \(recommended\)|Recommended: Pay online/i,
      `${page} still recommends a payment method in copy`,
    );
    assert.match(
      html,
      /this request does not confirm an appointment/i,
      `${page} lost the "a request is not a confirmed appointment" policy bullet`,
    );
    // The pre-existing honest statements must survive.
    assert.match(html, /Charged today/, `${page} lost the charged-today row`);
    assert.match(html, /still nothing charged today/, `${page} lost the nothing-charged-today confirm row`);
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
    /hero-zip-btn-lbl">Check Price &amp; Availability<\/span>/,
    'index hero ZIP CTA is not the discovery CTA',
  );
  assert.match(
    read('index.html'),
    /function onHeroZipSubmit\(\)\{[\s\S]*?openBooking\(null\)/,
    'index hero ZIP submit must open the booking flow',
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

test('the advance notice matches same-day availability + lead time', () => {
  const lib = read('netlify/lib/operational-availability.js');
  const declared = /const MIN_ADVANCE_DAYS = (\d+);/.exec(lib);
  assert.ok(declared, 'MIN_ADVANCE_DAYS not found');
  const days = Number(declared[1]);
  const lead = /const SAME_DAY_LEAD_MINUTES = (\d+);/.exec(lib);
  assert.ok(lead, 'SAME_DAY_LEAD_MINUTES not found');
  assert.equal(Number(lead[1]), 120);

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
    if (!html.includes('bk-advance-notice')) continue;
    if (days === 0) {
      assert.match(
        html,
        /Same-day appointments may be available\. Remaining slots open with about 2 hours' notice\./,
        `${page} same-day advance notice missing`,
      );
      assert.doesNotMatch(html, /typically \d+ days out/);
    } else {
      assert.match(
        html,
        new RegExp(`Next available appointments are typically ${days} days out\\.`),
        `${page} advance notice contradicts MIN_ADVANCE_DAYS=${days}`,
      );
    }
  }
});

// ── D2. Hero trust line: verifiable signals only ─────────────────────────────

test('the fabricated vehicle counter is gone from every public page', () => {
  for (const file of publicSources) {
    const src = read(file);
    assert.doesNotMatch(src, /initTrustedStatsCounter/, `${file} still has the counter`);
    assert.doesNotMatch(src, /cd1_page_visits/, `${file} still reads the visit counter`);
    assert.doesNotMatch(src, /trust-row--stats"/, `${file} still renders the stats band`);
    assert.doesNotMatch(src, /Vehicles detailed/, `${file} still claims a vehicle count`);
  }
});

test('the hero trust line carries only claims that can be checked', () => {
  const index = read('index.html');
  assert.match(index, /class="hero-trust-line"/, 'hero trust line missing');

  const line = /<ul class="hero-trust-line"[\s\S]*?<\/ul>/.exec(index);
  assert.ok(line, 'could not isolate the hero trust line');
  const html = line[0];

  for (const claim of ['5+ Years Experience', 'Owner-Operated', 'Mobile Detailing', 'Same-day available']) {
    assert.ok(html.includes(claim), `hero trust line lost "${claim}"`);
  }
  assert.doesNotMatch(html, /5\.0 Google|9 reviews/);

  // Transparent highlight chips — not opaque cards.
  assert.match(html, /class="hero-trust-chip"/);
  assert.match(index, /hero-trust-chip\{[^}]*background:rgba\(255,255,255,\.08\)/);

  // Nothing derived from a counter, a visit count or an invented total.
  assert.doesNotMatch(html, /\d+(\.\d+)?k\+/, 'hero trust line shows a k+ style count');
  assert.doesNotMatch(html, /detailed|vehicles/i, 'hero trust line claims a vehicle tally');

  assert.match(index, /id="reviews"/, 'the reviews anchor target is missing');
  assert.match(index, /The person you book is the person who shows up\./);
});

test('homepage hero no longer leads with interior/exterior water-power subcopy', () => {
  const index = read('index.html');
  const hero = /<section class="hero"[\s\S]*?<\/section>/.exec(index);
  assert.ok(hero, 'homepage hero missing');
  assert.doesNotMatch(hero[0], /We bring the water and power/);
  assert.doesNotMatch(hero[0], /Interior, exterior and full detailing/);
});

test('the hero repeats the same request-first promise as the review step', () => {
  const index = read('index.html');
  assert.match(index, /class="hero-assure"/);
  assert.match(index, /No payment today/);
  assert.match(index, /Request first, pay later/);
  assert.match(index, /Charged today/); // Step 5 financial summary
});

test('homepage hero highlights public Call or text for a quote CTA', () => {
  const index = read('index.html');
  const hero = /<section class="hero"[\s\S]*?<\/section>/.exec(index);
  assert.ok(hero, 'homepage hero missing');
  assert.match(hero[0], /Call or text for a quote/);
  assert.match(hero[0], /class="hero-quote-call-number"[^>]*href="tel:\+15513893986"/);
  assert.match(hero[0], /\(551\) 389-3986/);
  assert.match(hero[0], /href="sms:\+15513893986"/);
  assert.doesNotMatch(hero[0], /hero-tel-mobile/);
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

// ── F. Optional SMS: no unconditional "we'll text you" on booking surfaces ────

test('booking surfaces do not unconditionally promise SMS booking updates', () => {
  const forbidden = /we(?:['’]ll| will)? text you(?! if you opted in)|then text you|then text or call|Appointment updates by text|Booking confirmed by text|confirming by text|confirmed by text|via text or your local dashboard|>Text confirmation</i;
  for (const page of bookingPages) {
    assert.doesNotMatch(read(page), forbidden, `${page} still promises SMS regardless of consent`);
  }
  assert.doesNotMatch(
    read('scripts/apply-state-hub-theme.mjs'),
    forbidden,
    'hub theme generator still promises SMS regardless of consent',
  );
  assert.doesNotMatch(
    read('scripts/patch-hub-seo-audit.mjs'),
    /confirming by text|we'll text you|Appointment updates by text/i,
    'hub SEO patch still promises SMS regardless of consent',
  );
});

test('review, confirm, and success copy keep SMS opt-in-only', () => {
  for (const page of bookingPages) {
    const html = read(page);
    assert.match(
      html,
      /We'll review your request and notify you when the appointment is confirmed\. If you opted in for SMS, updates may be sent by text\./,
      `${page} lost the success-step SMS qualifier`,
    );
    assert.match(
      html,
      /If you opted in for SMS, updates may be sent by text\./,
      `${page} lost the opt-in SMS qualifier`,
    );
    assert.match(
      html,
      /Reply STOP to opt out or HELP for help/,
      `${page} lost legitimate STOP/HELP disclosure`,
    );
  }
});

test('homepage contact copy does not promise SMS to every visitor', () => {
  const index = read('index.html');
  assert.match(index, /We'll contact you with updates — SMS only if you opted in/);
  assert.match(index, /Booking reviewed before confirmation/);
  assert.doesNotMatch(index, /Appointment updates by text/);
  assert.doesNotMatch(index, /Booking confirmed by text/);
});
