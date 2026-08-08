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

/* ── Current-appointment legibility ──────────────────────────────────────────
 *
 * A customer's print of the portal showed eleven scheduling rows on one
 * appointment, of which four restated a value already on screen: Status
 * repeated the card kicker, Service repeated the card title (from the identical
 * expression), Preferred date repeated Date while unconfirmed, and "Confirmed
 * date / window" repeated Date + Arrival window as "— · Pending confirmation".
 */

function bootAppointment(booking, payment) {
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
  const doc = win.document;
  return {
    labels: [...doc.querySelectorAll('#upcoming-panel .meta-grid dt')].map((d) => d.textContent),
    panel: doc.getElementById('upcoming-panel').textContent,
    totals: doc.querySelector('.booking-financial-summary').textContent,
    history: doc.getElementById('history-list').textContent,
    doc,
    win,
  };
}

const PENDING = {
  id: 'CD1-M',
  status: 'Pending Review',
  customerStatus: 'Pending Review',
  service: 'Premium Full Detail',
  package: 'Premium Full Detail',
  preferredDate: '2026-08-14',
  preferredArrivalWindow: 'anytime',
  address: '168 OAKWOOD AVE APT 1',
  travelFeeAmount: 15,
  scheduleFlexibility: 'exact',
  totalPrice: 255,
  approvedFinalAmount: 255,
  vehicles: [{
    vehicleId: 'v1', vehicleLabel: '2017 McLaren 720S',
    packageName: 'Premium Full Detail', basePrice: 240, addons: [], subtotal: 240,
  }],
};

const PENDING_PAYMENT = {
  state: 'processing', approvedCents: 25500, settledCents: 0, remainingCents: 25500,
  amountDueApproved: 255, approvedTotal: 255, paymentAttemptStatus: 'open', canPay: true,
};

jsdomTest('the appointment card states each fact once', () => {
  const { labels, panel } = bootAppointment(PENDING, PENDING_PAYMENT);
  assert.ok(!labels.includes('Status'), 'the kicker already carries the status');
  assert.ok(!labels.includes('Service'), 'the card title already carries the service');
  assert.ok(!labels.includes('Confirmed date / window'), 'Date + Arrival window already carry this');
  assert.ok(!labels.includes('Preferred date'), 'identical to Date until a date is confirmed');
  // Removing the repeats must not remove the facts.
  assert.match(panel, /Pending Review/);
  assert.match(panel, /Premium Full Detail/);
  assert.match(panel, /168 OAKWOOD AVE APT 1/);
  assert.match(panel, /2026-08-14/);
  ['Date', 'Arrival window', 'Location'].forEach((l) => assert.ok(labels.includes(l), `${l} kept`));
});

jsdomTest('a preferred date is shown once it differs from the confirmed one', () => {
  const { labels, panel } = bootAppointment(
    { ...PENDING, confirmedDate: '2026-08-16', confirmedTimeWindow: '8am – 10am' },
    PENDING_PAYMENT
  );
  assert.ok(labels.includes('Preferred date'), 'now a distinct fact worth its own row');
  assert.match(panel, /2026-08-14/, 'what was asked for');
  assert.match(panel, /2026-08-16/, 'what was scheduled');
});

jsdomTest('travel fee sits with the total it is part of', () => {
  const { totals, labels } = bootAppointment(PENDING, PENDING_PAYMENT);
  assert.match(totals, /Travel fee/);
  assert.match(totals, /\$15\.00/);
  assert.match(totals, /Approved total/);
  assert.match(totals, /\$255\.00/);
  // It must appear before the total, not after it.
  assert.ok(totals.indexOf('Travel fee') < totals.indexOf('Approved total'));
  // And exactly once — not left behind in the scheduling rows too.
  assert.equal(labels.filter((l) => l === 'Travel fee').length, 1);
});

jsdomTest('a cancelled appointment labels the figure it shows', () => {
  const cancelled = {
    id: 'CD1-C', status: 'Cancelled', service: 'Premium Full Detail',
    preferredDate: '2026-08-10', totalPrice: 3175, appointmentPublicRef: 'aptr_c',
    vehicleYear: 2026, vehicleMake: 'Acura', vehicleModel: 'MDX',
  };
  const dom = new JSDOM(garageHtml.replace(/<script src="[^"]*"><\/script>/g, ''), {
    url: 'https://cardetail1.com/my-garage.html', runScripts: 'outside-only',
  });
  dom.window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) });
  dom.window.eval(garageJs);
  dom.window.cd1MyGarage.state.booking = PENDING;
  dom.window.cd1MyGarage.state.bookings = [PENDING, cancelled];
  dom.window.cd1MyGarage.renderDashboard({ payment: PENDING_PAYMENT });
  const history = dom.window.document.getElementById('history-list').textContent;

  assert.match(history, /2026 Acura MDX/);
  assert.match(history, /Quoted \$3175\.00/, 'says which figure this is');
  assert.doesNotMatch(history, /Cancelled · \$3175\.00/, 'a bare price here reads as a charge');
  // The row has no settlement data, so it must not claim one either way.
  assert.doesNotMatch(history, /not charged|refunded|paid/i);
});

jsdomTest('a background poll does not announce itself in the portal header', () => {
  const fn = garageJs.slice(garageJs.indexOf('function portalSyncState('));
  assert.match(fn.slice(0, 800), /if \(info\.reason === 'poll'\) return;/);
  const cfg = garageJs.slice(garageJs.indexOf("controllerKey: 'my-garage'"));
  const stable = Number((cfg.match(/stablePollMs: (\d+)/) || [])[1]);
  const active = Number((cfg.match(/activePollMs: (\d+)/) || [])[1]);
  assert.ok(stable >= 15000, `an idle portal polled every ${stable}ms reads as self-reloading`);
  assert.ok(active <= 3000, 'a settling payment must still refresh quickly');
});
