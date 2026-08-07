/**
 * Payments & Receipts panel legibility, booted under jsdom against the real
 * my-garage.html + assets/my-garage.js.
 *
 * The reported symptom: a card was authorized in person, and afterwards the
 * portal showed invoice status "processing" with Total approved $255.00,
 * Amount paid $0.00, Amount due $255.00 and nothing else. Every one of those
 * figures was correct — an authorization creates a payment attempt, not a
 * settlement — but with no statement of the attempt on screen the panel is
 * indistinguishable from one where the payment never happened, and "processing"
 * is projection vocabulary rather than an answer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = (() => {
  try { return { JSDOM: require('jsdom').JSDOM }; }
  catch { return { JSDOM: null }; }
})();

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const garageHtml = read('my-garage.html');
const garageJs = read('assets/my-garage.js');

function bootPortal(booking, payment) {
  const dom = new JSDOM(garageHtml.replace(/<script src="[^"]*"><\/script>/g, ''), {
    url: 'https://cardetail1.com/my-garage.html',
    runScripts: 'outside-only',
  });
  const win = dom.window;
  win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) });
  win.eval(garageJs);
  win.cd1MyGarage.state.booking = booking;
  win.cd1MyGarage.state.bookings = [booking];
  win.cd1MyGarage.renderDashboard({ payment });
  return win.document.getElementById('payments-panel').textContent;
}

const jsdomTest = JSDOM ? test : test.skip;

jsdomTest('an in-person card authorization is stated, not left as a silent $0.00', () => {
  const text = bootPortal(
    { id: 'CD1-X', status: 'Pending Review', phone: '5513132956' },
    {
      state: 'processing',
      approvedCents: 25500,
      settledCents: 0,
      remainingCents: 25500,
      amountDueApproved: 255,
      paymentAttemptStatus: 'open',
      canPay: true,
    }
  );
  assert.match(text, /Payment processing/, 'the raw state word is replaced by a sentence');
  assert.match(text, /Your card was authorized/, 'says what "processing" actually means');
  assert.match(text, /Card authorization in progress/, 'the attempt itself appears on screen');
  // The correct figures are still shown — this adds context, it does not restate money.
  assert.match(text, /\$255\.00/);
  assert.match(text, /\$0\.00/);
});

jsdomTest('a settled payment is itemized with its date and reference', () => {
  const text = bootPortal(
    { id: 'CD1-Y', status: 'Completed', jobStatus: 'completed_paid', completedAt: '2026-08-01T12:00:00Z' },
    {
      state: 'paid',
      approvedCents: 25500,
      settledCents: 25500,
      grossSettledCents: 25500,
      remainingCents: 0,
      paidAt: '2026-08-01T12:34:00Z',
      stripeReference: 'pi_3AbCdEfGhIjK',
    }
  );
  assert.match(text, /Paid in full/);
  assert.match(text, /\$255\.00 received/);
  assert.match(text, /2026-08-01/);
  assert.match(text, /View payment receipt/);
  assert.match(text, /View final receipt/, 'completed with a zero balance earns the final receipt');
});

jsdomTest('a fully refunded booking still offers the receipt the server would serve', () => {
  // receiptEligibility keys on gross (pre-refund) settlement, so hiding the
  // button on net settlement alone contradicted the endpoint.
  const text = bootPortal(
    { id: 'CD1-Z', status: 'Completed', jobStatus: 'completed_paid' },
    {
      state: 'refunded',
      approvedCents: 25500,
      settledCents: 0,
      grossSettledCents: 25500,
      refundedCents: 25500,
      remainingCents: 0,
    }
  );
  assert.match(text, /Refunded/);
  assert.match(text, /\$255\.00 refunded/);
  assert.match(text, /View payment receipt/);
});

jsdomTest('a declined card says so and says what to do next', () => {
  const text = bootPortal(
    { id: 'CD1-D', status: 'Confirmed' },
    {
      state: 'failed',
      approvedCents: 25500,
      settledCents: 0,
      remainingCents: 25500,
      amountDueApproved: 255,
      paymentAttemptStatus: 'failed',
      canPay: true,
    }
  );
  assert.match(text, /Payment did not go through/);
  assert.match(text, /A card attempt was declined/);
  assert.match(text, /No charge was made/);
});

jsdomTest('a booking with no payment activity shows no activity block', () => {
  const text = bootPortal(
    { id: 'CD1-N', status: 'Pending Review' },
    { state: 'not_due', approvedCents: 25500, settledCents: 0, remainingCents: 25500 }
  );
  assert.match(text, /No balance due yet/);
  assert.doesNotMatch(text, /Payment activity/, 'an empty trail is not a card');
});
