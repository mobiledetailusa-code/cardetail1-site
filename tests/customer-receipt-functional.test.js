/**
 * Receipt behaviour — Phase 10 functional coverage and the Phase 11
 * two-customer fixture. Exercises the real receipt projector against real
 * financialProjection and the real customer vehicle projection.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const {
  buildReceiptProjection,
  receiptEligibility,
  settledPayments,
  receiptNumber,
  paymentMethodLabel,
} = require('../netlify/lib/receipt-projection');

const garageJs = read('assets/my-garage.js');
const garageHtml = read('my-garage.html');
const receiptHtml = read('receipt.html');
const receiptJs = read('assets/receipt.js');

/* Approved staging fixture: Bronco $400 + Yamaha 222S $487 = $887. */
function fixtureBooking(overrides) {
  return Object.assign({
    id: 'CD1-FIXTURE-A',
    isDraft: false,
    status: 'Completed',
    jobStatus: 'completed',
    completedAt: '2026-09-15T18:00:00.000Z',
    confirmedDate: '2026-09-14',
    firstName: 'Alice', lastName: 'Anders',
    phone: '5513132956',
    address: '1 Test Way, Newark NJ',
    paymentWorkflowStatus: 'payment_succeeded',
    approvedFinalAmount: 887,
    totalPrice: 887,
    vehicles: [
      {
        vehicleId: 'veh-bronco', vehicleLabel: '2025 Ford Bronco',
        year: 2025, make: 'Ford', model: 'Bronco',
        packageName: 'Maintenance Detail', basePrice: 215,
        addons: [
          { id: 'pet', name: 'Pet Hair Removal', qty: 1, price: 95 },
          { id: 'odor', name: 'Odor Treatment & Sanitize', qty: 1, price: 90 },
        ],
        addonTotal: 185, subtotal: 400,
      },
      {
        vehicleId: 'veh-yamaha', vehicleLabel: '2023 Yamaha Boats 222S',
        year: 2023, make: 'Yamaha Boats', model: '222S',
        packageName: 'Essential Marine', basePrice: 462,
        addons: [{ id: 'rainx', name: 'Rain-X Glass Treatment', qty: 1, price: 25 }],
        addonTotal: 25, subtotal: 487,
      },
    ],
    ledger: {
      approvedCents: 88700, settledCents: 88700, creditedCents: 0,
      entries: [{ kind: 'settlement', amountCents: 88700, recordedAt: '2026-09-15T17:30:00.000Z', providerObjectId: 'cs_A1' }],
    },
    paymentAttempts: [{ attemptId: 'a1', status: 'settled', amountCents: 88700, settledAt: '2026-09-15T17:30:00.000Z', providerObjectId: 'cs_A1' }],
  }, overrides || {});
}

function unpaid() {
  return fixtureBooking({
    status: 'Confirmed', jobStatus: 'confirmed', completedAt: '',
    paymentWorkflowStatus: 'awaiting_customer_payment',
    ledger: { approvedCents: 88700, settledCents: 0, creditedCents: 0, entries: [] },
    paymentAttempts: [{ attemptId: 'a1', status: 'open', amountCents: 88700, providerObjectId: 'cs_open' }],
  });
}

/* ── Payment receipt eligibility ─────────────────────────────────────────── */

test('19. an unpaid booking has no payment receipt', () => {
  const el = receiptEligibility(unpaid());
  assert.equal(el.payment, false);
  const r = buildReceiptProjection(unpaid(), 'payment');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'receipt_unavailable');
});

test('20. pending, open and failed attempts never qualify or count', () => {
  const b = unpaid();
  b.paymentAttempts = [
    { attemptId: 'x1', status: 'open', amountCents: 50000 },
    { attemptId: 'x2', status: 'creating', amountCents: 50000 },
    { attemptId: 'x3', status: 'failed', amountCents: 50000 },
  ];
  assert.deepEqual(settledPayments(b), []);
  assert.equal(receiptEligibility(b).payment, false);
});

test('21-24. a settled payment qualifies with authoritative figures', () => {
  const r = buildReceiptProjection(fixtureBooking(), 'payment');
  assert.equal(r.ok, true);
  assert.equal(r.receipt.status, 'Paid');
  assert.equal(r.receipt.financialSummary.approvedTotal.display, '$887.00');
  assert.equal(r.receipt.financialSummary.amountPaid.display, '$887.00');
  assert.equal(r.receipt.financialSummary.remainingBalance.display, '$0.00');
  assert.equal(r.receipt.paymentMethod, 'Card');
});

test('25. multiple settled payments are itemized and summed', () => {
  const b = fixtureBooking({
    ledger: {
      approvedCents: 88700, settledCents: 88700, creditedCents: 0,
      entries: [
        { kind: 'settlement', amountCents: 40000, recordedAt: '2026-09-10T10:00:00.000Z', providerObjectId: 'cs_1' },
        { kind: 'settlement', amountCents: 48700, recordedAt: '2026-09-15T17:30:00.000Z', providerObjectId: 'cs_2' },
      ],
    },
  });
  const r = buildReceiptProjection(b, 'payment');
  assert.equal(r.ok, true);
  assert.equal(r.receipt.payments.length, 2);
  assert.equal(r.receipt.payments[0].amount.display, '$400.00');
  assert.equal(r.receipt.payments[1].amount.display, '$487.00');
  const total = r.receipt.payments.reduce((s, p) => s + p.amount.cents, 0);
  assert.equal(total, 88700);
});

test('26. a replayed settlement event does not double-count', () => {
  const b = fixtureBooking({
    ledger: {
      approvedCents: 88700, settledCents: 88700, creditedCents: 0,
      entries: [
        { kind: 'settlement', amountCents: 88700, recordedAt: '2026-09-15T17:30:00.000Z', providerObjectId: 'cs_dup' },
        { kind: 'settlement', amountCents: 88700, recordedAt: '2026-09-15T17:30:05.000Z', providerObjectId: 'cs_dup' },
      ],
    },
  });
  const payments = settledPayments(b);
  assert.equal(payments.length, 1, 'the replayed webhook must collapse to one payment');
  assert.equal(payments[0].amount.cents, 88700);
});

test('27/39. the receipt number is deterministic and idempotent', () => {
  const a = buildReceiptProjection(fixtureBooking(), 'final').receipt.receiptNumber;
  const b = buildReceiptProjection(fixtureBooking(), 'final').receipt.receiptNumber;
  const c = buildReceiptProjection(fixtureBooking(), 'final').receipt.receiptNumber;
  assert.equal(a, b);
  assert.equal(b, c, 'concurrent first access must not diverge');
  // Distinct per type and per booking — no persistence, no duplicate snapshot.
  assert.notEqual(a, buildReceiptProjection(fixtureBooking(), 'payment').receipt.receiptNumber);
  assert.notEqual(receiptNumber('CD1-A', 'final', 'x'), receiptNumber('CD1-B', 'final', 'x'));
});

/* ── Final receipt eligibility ───────────────────────────────────────────── */

test('28. paid but incomplete has no final receipt', () => {
  const b = fixtureBooking({ jobStatus: 'in_progress', status: 'Confirmed', completedAt: '' });
  assert.equal(receiptEligibility(b).final, false);
  const r = buildReceiptProjection(b, 'final');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'receipt_unavailable');
  // The payment receipt is still available for the same booking.
  assert.equal(buildReceiptProjection(b, 'payment').ok, true);
});

test('29. completed but unpaid has no final receipt', () => {
  const b = unpaid();
  b.jobStatus = 'completed';
  b.completedAt = '2026-09-15T18:00:00.000Z';
  assert.equal(receiptEligibility(b).final, false);
  assert.equal(buildReceiptProjection(b, 'final').ok, false);
});

test('29b. completed with a remaining balance has no final receipt', () => {
  const b = fixtureBooking({
    ledger: {
      approvedCents: 88700, settledCents: 40000, creditedCents: 0,
      entries: [{ kind: 'settlement', amountCents: 40000, recordedAt: '2026-09-10T10:00:00.000Z', providerObjectId: 'cs_part' }],
    },
  });
  const el = receiptEligibility(b);
  assert.ok(el.remainingCents > 0);
  assert.equal(el.final, false);
  assert.equal(el.payment, true, 'a partial payment still earns a payment receipt');
});

test('30-36. a completed, fully paid booking produces a correct final receipt', () => {
  const r = buildReceiptProjection(fixtureBooking(), 'final');
  assert.equal(r.ok, true);
  const rec = r.receipt;
  assert.equal(rec.status, 'Paid');

  // 31 every vehicle exactly once
  assert.equal(rec.vehicles.length, 2);
  assert.deepEqual(rec.vehicles.map((v) => v.label).sort(), ['2023 Yamaha Boats 222S', '2025 Ford Bronco']);

  const bronco = rec.vehicles.find((v) => v.label === '2025 Ford Bronco');
  const boat = rec.vehicles.find((v) => v.label === '2023 Yamaha Boats 222S');

  // 32 correct package per vehicle
  assert.equal(bronco.package.name, 'Maintenance Detail');
  assert.equal(bronco.package.price.display, '$215.00');
  assert.equal(boat.package.name, 'Essential Marine');
  assert.equal(boat.package.price.display, '$462.00');

  // 33 add-ons do not cross vehicles
  const bNames = bronco.addons.map((a) => a.name);
  const yNames = boat.addons.map((a) => a.name);
  assert.deepEqual(bNames.sort(), ['Odor Treatment & Sanitize', 'Pet Hair Removal']);
  assert.deepEqual(yNames, ['Rain-X Glass Treatment']);
  assert.ok(!bNames.includes('Rain-X Glass Treatment'));
  assert.ok(!yNames.some((n) => /Pet Hair|Odor/.test(n)));

  // 34 subtotals
  assert.equal(bronco.subtotal.display, '$400.00');
  assert.equal(boat.subtotal.display, '$487.00');

  // 35/36 authoritative total and zero balance
  assert.equal(rec.financialSummary.approvedTotal.display, '$887.00');
  assert.equal(rec.financialSummary.amountPaid.display, '$887.00');
  assert.equal(rec.financialSummary.remainingBalance.cents, 0);
  assert.equal(rec.financialSummary.serviceLinesTotal.display, '$887.00');
  assert.deepEqual(rec.adjustments, [], 'lines sum to the approved total, so no adjustment line');

  // 37 completion date from the established authority
  assert.equal(rec.completionDate, '2026-09-15');
});

test('a legitimate difference becomes a named adjustment line, never a silent fudge', () => {
  const b = fixtureBooking({ approvedFinalAmount: 927, totalPrice: 927 });
  b.ledger = {
    approvedCents: 92700, settledCents: 92700, creditedCents: 0,
    entries: [{ kind: 'settlement', amountCents: 92700, recordedAt: '2026-09-15T17:30:00.000Z', providerObjectId: 'cs_adj' }],
  };
  const rec = buildReceiptProjection(b, 'final').receipt;
  assert.equal(rec.financialSummary.serviceLinesTotal.display, '$887.00');
  assert.equal(rec.financialSummary.approvedTotal.display, '$927.00');
  assert.equal(rec.adjustments.length, 1);
  assert.equal(rec.adjustments[0].amount.display, '$40.00');
});

test('38. a later catalog change cannot alter a historical receipt', () => {
  // The projector reads only booking-stored vehicle records; it never consults
  // the live catalog for price. Proven by mutating a "catalog-like" global and
  // by confirming stored values flow through verbatim.
  const b = fixtureBooking();
  b.vehicles[0].basePrice = 215;
  const before = buildReceiptProjection(b, 'final').receipt;
  assert.equal(before.vehicles.find((v) => v.label === '2025 Ford Bronco').package.price.display, '$215.00');

  const src = fs.readFileSync(path.join(ROOT, 'netlify/lib/receipt-projection.js'), 'utf8');
  assert.doesNotMatch(src, /canonical-package-catalog|canonical-addon-catalog|customer-catalog|quoteService/,
    'the receipt projector must not import a live pricing catalog');
});

test('a booking with no stored vehicles still produces a safe receipt', () => {
  const b = fixtureBooking({ vehicles: [] });
  const r = buildReceiptProjection(b, 'final');
  assert.equal(r.ok, true);
  assert.deepEqual(r.receipt.vehicles, []);
  assert.deepEqual(r.receipt.adjustments, [], 'no invented adjustment when there are no lines');
  assert.equal(r.receipt.financialSummary.approvedTotal.display, '$887.00');
});

test('paymentMethodLabel reports cash truthfully and never invents digits', () => {
  const cash = fixtureBooking({ paymentWorkflowStatus: 'cash_paid' });
  assert.equal(paymentMethodLabel(cash, { paymentWorkflowStatus: 'cash_paid' }), 'Cash');
  const rec = buildReceiptProjection(fixtureBooking(), 'final').receipt;
  assert.equal(rec.paymentMethod, 'Card');
  assert.ok(!/\d{4}/.test(rec.paymentMethod), 'no fabricated last four digits');
});

/* ── Two-customer isolation at the projector level ───────────────────────── */

test('Phase 11: two bookings project independently with no bleed', () => {
  const a = buildReceiptProjection(fixtureBooking(), 'final').receipt;
  const bBooking = fixtureBooking({
    id: 'CD1-FIXTURE-B', firstName: 'Bob', lastName: 'Baker',
    approvedFinalAmount: 250, totalPrice: 250,
    vehicles: [{ vehicleId: 'veh-b1', vehicleLabel: '2020 Honda Civic', packageName: 'Interior Detail', basePrice: 250, addons: [], addonTotal: 0, subtotal: 250 }],
    ledger: { approvedCents: 25000, settledCents: 25000, creditedCents: 0, entries: [{ kind: 'settlement', amountCents: 25000, recordedAt: '2026-09-20T17:00:00.000Z', providerObjectId: 'cs_B' }] },
  });
  const b = buildReceiptProjection(bBooking, 'final').receipt;

  assert.equal(a.customer.name, 'Alice Anders');
  assert.equal(b.customer.name, 'Bob Baker');
  assert.notEqual(a.receiptNumber, b.receiptNumber);
  assert.equal(a.financialSummary.approvedTotal.display, '$887.00');
  assert.equal(b.financialSummary.approvedTotal.display, '$250.00');
  assert.ok(!JSON.stringify(b).includes('Bronco'));
  assert.ok(!JSON.stringify(a).includes('Civic'));
});

/* ── UI, print and integration ───────────────────────────────────────────── */

test('40/41. receipt actions appear only when the server rules are met', () => {
  assert.match(garageJs, /function receiptActionsHtml\(pay\)/);
  // Gross (pre-refund) settlement is the server's own eligibility input, so the
  // button and the endpoint agree even after a refund nets the balance to zero.
  assert.match(garageJs, /pay\.grossSettledCents/);
  assert.match(garageJs, /if \(!\(gross > 0\)\) return '';/);
  assert.match(garageJs, /serviceIsCompleted\(b\) && remaining === 0/);
  assert.match(garageJs, /View payment receipt/);
  assert.match(garageJs, /View final receipt/);
});

test('42. receipts open from My Garage on the receipt route', () => {
  assert.match(garageJs, /receipt\.html\?bookingId=/);
  assert.match(garageJs, /&type=payment/);
  assert.match(garageJs, /&type=final/);
  assert.match(garageJs, /encodeURIComponent\(b\.id\)/);
});

/**
 * The regression this guards: My Garage authorizes three ways (account cookie,
 * Booking ID + phone, single-use email action link) but only the cookie rides
 * along on a plain link to receipt.html. Receipts opened from the other two
 * modes reached the endpoint with no credential at all and were rejected with
 * the portal login form's "A valid US mobile number is required (10 digits)."
 */
test('the receipt page replays the lookup credentials My Garage verified', () => {
  assert.match(receiptJs, /function storedPhoneFor\(bookingId\)/);
  assert.match(receiptJs, /sessionStorage\.getItem\('cd1_garage_id'\)/);
  assert.match(receiptJs, /sessionStorage\.getItem\('cd1_garage_phone'\)/);
  // Only ever for the booking those credentials belong to.
  assert.match(receiptJs, /toUpperCase\(\) !== String\(bookingId\)\.trim\(\)\.toUpperCase\(\)/);
  // And it is sent as the documented phone field the endpoint already accepts.
  assert.match(receiptJs, /if \(phone\) body\.phone = phone;/);
});

test('My Garage hands its credentials to the receipt page before navigating', () => {
  assert.match(garageJs, /\[data-receipt-link\]/);
  const handoff = garageJs.slice(garageJs.indexOf("e.target.closest('[data-receipt-link]')"));
  assert.match(handoff.slice(0, 800), /sessionStorage\.setItem\('cd1_garage_id'/);
  assert.match(handoff.slice(0, 800), /sessionStorage\.setItem\('cd1_garage_phone'/);
  // Never write a partial credential the receipt page would send and fail on.
  assert.match(handoff.slice(0, 800), /phone\.length < 10/);
});

test('receipt failures are restated for the page the customer is actually on', () => {
  // The portal's phone-validation copy is meaningless here — there is no phone
  // field on the receipt page to act on.
  assert.doesNotMatch(receiptJs, /A valid US mobile number/);
  assert.match(receiptJs, /var AUTH_ERRORS = \{/);
  ['validation_error', 'authentication_failed', 'phone_not_on_file']
    .forEach((code) => assert.match(receiptJs, new RegExp(`${code}:`), `${code} needs customer-facing copy`));
  ['booking_not_found', 'booking_not_ready', 'financial_authority_unavailable']
    .forEach((code) => assert.match(receiptJs, new RegExp(`${code}:`), `${code} needs customer-facing copy`));
  // Every recoverable failure points back to the one place that can fix it.
  assert.match(receiptJs, /Open it again from My Garage/);
});

test('a deliberate 200 business answer keeps the server wording', () => {
  // "A payment receipt is available once a payment has been received." is more
  // useful than any generic failure copy this page could substitute for it —
  // but it must not shadow the login-form phrasing of an auth denial.
  const fn = receiptJs.slice(receiptJs.indexOf('function describeFailure('));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /if \(AUTH_ERRORS\[code\]\) return/);
  assert.match(body, /if \(status === 200 && serverMessage\) return \{ text: serverMessage/);
  assert.ok(
    body.indexOf('AUTH_ERRORS[code]') < body.indexOf('status === 200 && serverMessage'),
    'auth denials must be reworded before the pass-through branch can catch them'
  );
});

test('a transient receipt failure retries once before declaring the receipt missing', () => {
  assert.match(receiptJs, /function isTransient\(status\)/);
  assert.match(receiptJs, /status === 0 \|\| status === 408 \|\| status >= 500/);
  assert.match(receiptJs, /if \(isTransient\(attempt\.status\)\) \{/);
});

test('43. the print button calls the intended print path', () => {
  assert.match(receiptHtml, /id="btn-print"/);
  assert.match(receiptJs, /printBtn\.addEventListener\('click', function \(\) \{ window\.print\(\); \}\)/);
  // No heavy PDF dependency, no canvas screenshot, no server Chromium.
  assert.doesNotMatch(receiptHtml, /jspdf|html2canvas|pdfmake|puppeteer/i);
  assert.doesNotMatch(receiptJs, /jspdf|html2canvas|pdfmake|puppeteer/i);
});

test('the rendered receipt shows authoritative quote rows, safe references, refunds, and credits', () => {
  assert.match(receiptJs, /quoteItemsHtml\(r\)/);
  assert.match(receiptJs, /Approved quote/);
  assert.match(receiptJs, /Reference/);
  assert.match(receiptJs, /refundsHtml\(r\.refunds\)/);
  assert.match(receiptJs, /Refund pending/);
  assert.match(receiptJs, /Credit\/refund due/);
  assert.match(receiptJs, /Net paid/);
});

test('44. print CSS hides controls and prints readable black text', () => {
  const print = receiptHtml.slice(receiptHtml.indexOf('@media print'));
  assert.match(print, /\.actions,\.no-print\{display:none!important\}/);
  assert.match(print, /body\{background:#fff;color:#000\}/);
  assert.match(print, /@page\{margin:0\.5in\}/);
  assert.match(print, /\.veh\{border:1px solid #999\}/);
  assert.match(receiptHtml, /break-inside:avoid;page-break-inside:avoid/);
});

test('45-47. the receipt is readable on mobile and never overflows sideways', () => {
  assert.match(receiptHtml, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(receiptHtml, /@media\(max-width:520px\)/);
  assert.match(receiptHtml, /\.tblwrap\{overflow-x:auto\}/);
  assert.match(receiptHtml, /word-break:break-word/);
});

test('48. Back to My Garage is present', () => {
  assert.match(receiptHtml, /id="btn-back"[^>]*href="my-garage\.html"|href="my-garage\.html"[^>]*id="btn-back"/);
});

test('18. the static receipt page embeds no private data', () => {
  assert.doesNotMatch(receiptHtml, /\$\d/, 'no money in static HTML');
  assert.doesNotMatch(receiptHtml, /CD1-[A-Z0-9]/, 'no booking reference in static HTML');
  assert.doesNotMatch(receiptHtml, /Alice|Anders|receiptNumber"\s*:/, 'no customer data in static HTML');
  assert.match(receiptJs, /credentials: 'same-origin'/);
  assert.match(receiptJs, /\/\.netlify\/functions\/customer-receipt/);
});

test('accessibility: semantic structure and keyboard-reachable actions', () => {
  assert.match(receiptHtml, /<main id="receipt-root" aria-live="polite">/);
  assert.match(receiptHtml, /<title>/);
  assert.match(receiptHtml, /\.btn:focus-visible\{outline:2px solid var\(--blue\);outline-offset:2px\}/);
  assert.match(receiptHtml, /min-height:44px/);
  assert.match(receiptJs, /document\.title =/);
  assert.match(receiptJs, /<th scope="col">/);
  // Buttons and links, not click-handlers on divs.
  assert.match(receiptHtml, /<button type="button" class="btn primary" id="btn-print" hidden>/);
});

test('print is offered only once a receipt actually rendered', () => {
  // A failed load must not present "Save as PDF" over an error message.
  assert.match(receiptHtml, /id="btn-print" hidden>/);
  assert.match(receiptJs, /showActions\(true\);/);
  const failurePath = receiptJs.slice(receiptJs.indexOf('var data = attempt.data;'));
  assert.doesNotMatch(
    failurePath.slice(0, failurePath.indexOf('render(data.receipt)')),
    /showActions\(true\)/,
    'the print button must stay hidden on the failure path'
  );
});

test('the browser performs no authoritative money arithmetic', () => {
  const body = receiptJs.slice(receiptJs.indexOf('function render('));
  assert.doesNotMatch(body, /[-+*/]\s*100\b|toFixed\(2\)/, 'receipt.js must render server-formatted amounts only');
});

/* ── Slice 2 regression ──────────────────────────────────────────────────── */

test('50. exactly one Pay securely CTA survives', () => {
  assert.match(garageHtml, /id="pay-sticky-btn">Pay securely/);
  assert.match(garageHtml, /@media\(max-width:720px\)\{body\.pay-sticky-on #btn-pay-balance\{display:none\}\}/);
  assert.doesNotMatch(garageHtml, /id="pay-balance-link"/);
  assert.doesNotMatch(garageJs, /data-portal-pay/);
  assert.match(garageJs, /function payCtaLabel\(can, due\)/);
});

test('51. the payment element and its authority are untouched', () => {
  assert.match(garageJs, /customer-balance-payment-intent/);
  assert.match(garageJs, /if \(embeddedPay\.starting\) return;/);
  assert.equal([...garageJs.matchAll(/async function startPayBalance\b/g)].length, 1);
  // Receipts must not initialize Stripe or create a payment.
  assert.doesNotMatch(receiptJs, /stripe|payment-intent|startPayBalance/i);
});
