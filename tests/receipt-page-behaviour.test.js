/**
 * Receipt page behaviour, booted under jsdom against the real receipt.html and
 * assets/receipt.js with only the network stubbed.
 *
 * The regression these guard is the one customers actually hit: My Garage
 * authorizes three different ways — an account cookie session, a booking-scoped
 * lookup (Booking ID + phone), and a single-use email action link — but only the
 * cookie rides along on a plain link to receipt.html. A receipt opened from
 * either of the other two modes therefore reached customer-receipt with no
 * credential at all, fell through to the phone branch of authorizeBookingAccess
 * and was rejected with the My Garage login form's copy:
 *
 *   "A valid US mobile number is required (10 digits)."
 *
 * rendered under a large "Print / Save as PDF" button, on a page with no phone
 * field to act on. From the customer's side that reads as "the receipt is
 * generated inconsistently, or not at all".
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
const receiptHtml = read('receipt.html');
const receiptJs = read('assets/receipt.js');

const RECEIPT = {
  receiptType: 'payment',
  receiptNumber: 'PR-CD1-X-ABC',
  bookingReference: 'CD1-X',
  status: 'Paid',
  business: { name: 'Detailing Zone L.L.C.', phone: '551-313-2956', site: 'cardetail1.com' },
  customer: { name: 'Test Customer' },
  financialSummary: {
    approvedTotal: { display: '$255.00' },
    amountPaid: { display: '$255.00' },
    remainingBalance: { display: '$0.00' },
  },
  vehicles: [],
  payments: [],
  refunds: [],
};

const okResponse = (receipt) => async () => ({ status: 200, json: async () => ({ ok: true, receipt }) });

/**
 * Boot the page with the script detached from the markup so it can be evaluated
 * after the stubbed fetch and sessionStorage are in place.
 */
async function bootReceiptPage({ search, session, respond }) {
  const dom = new JSDOM(receiptHtml.replace(/<script src="assets\/receipt\.js"><\/script>/, ''), {
    url: `https://cardetail1.com/receipt.html${search}`,
    runScripts: 'outside-only',
  });
  const win = dom.window;
  const sent = [];
  win.fetch = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    return respond(sent.length);
  };
  Object.entries(session || {}).forEach(([k, v]) => win.sessionStorage.setItem(k, v));
  win.eval(receiptJs);
  // Long enough to cover the one transient retry (1200ms) plus its second trip.
  await new Promise((resolve) => setTimeout(resolve, 2600));
  return {
    sent,
    text: win.document.getElementById('receipt-root').textContent.trim(),
    printHidden: win.document.getElementById('btn-print').hidden,
  };
}

const jsdomTest = JSDOM ? test : test.skip;

jsdomTest('a booking-and-phone portal session renders its receipt', async () => {
  const { sent, text, printHidden } = await bootReceiptPage({
    search: '?bookingId=CD1-X&type=payment',
    session: { cd1_garage_id: 'CD1-X', cd1_garage_phone: '5513132956' },
    respond: okResponse(RECEIPT),
  });
  assert.equal(sent[0].body.phone, '5513132956', 'the verified lookup phone must travel with the request');
  assert.equal(sent[0].body.bookingId, 'CD1-X');
  assert.equal(sent[0].body.receiptType, 'payment');
  assert.match(text, /PR-CD1-X-ABC/);
  assert.equal(printHidden, false, 'print is offered once a receipt exists');
});

jsdomTest('stored credentials are never replayed for a different booking', async () => {
  const { sent } = await bootReceiptPage({
    search: '?bookingId=CD1-OTHER&type=payment',
    session: { cd1_garage_id: 'CD1-X', cd1_garage_phone: '5513132956' },
    respond: okResponse(RECEIPT),
  });
  assert.equal(sent[0].body.phone, undefined, 'one booking\'s phone must not authorize another');
});

jsdomTest('an account-cookie session still works with nothing stored', async () => {
  const { sent, printHidden } = await bootReceiptPage({
    search: '?bookingId=CD1-X&type=payment',
    respond: okResponse(RECEIPT),
  });
  assert.equal(sent[0].body.phone, undefined, 'the cookie is the credential here');
  assert.equal(printHidden, false);
});

jsdomTest('the login-form phone denial is reworded and print stays hidden', async () => {
  const { text, printHidden } = await bootReceiptPage({
    search: '?bookingId=CD1-X&type=payment',
    respond: async () => ({
      status: 400,
      json: async () => ({
        ok: false,
        error: 'validation_error',
        message: 'A valid US mobile number is required (10 digits).',
      }),
    }),
  });
  assert.doesNotMatch(text, /valid US mobile number/, 'login-form copy must not reach this page');
  assert.match(text, /missing the sign-in details/);
  assert.match(text, /Open it again from My Garage/, 'the customer needs a way forward');
  assert.equal(printHidden, true, 'never offer to save an error message as a PDF');
});

jsdomTest('a deliberate 200 eligibility answer keeps the server wording', async () => {
  const { text, printHidden } = await bootReceiptPage({
    search: '?bookingId=CD1-X&type=final',
    respond: async () => ({
      status: 200,
      json: async () => ({
        ok: false,
        error: 'receipt_unavailable',
        message: 'The final receipt is available once the service is completed and the balance is paid in full.',
      }),
    }),
  });
  assert.match(text, /once the service is completed and the balance is paid in full/);
  assert.equal(printHidden, true);
});

jsdomTest('a transient failure retries once instead of claiming no receipt exists', async () => {
  const { sent, text, printHidden } = await bootReceiptPage({
    search: '?bookingId=CD1-X&type=payment',
    respond: async (attempt) => (attempt === 1
      ? { status: 500, json: async () => ({ ok: false, error: 'receipt_unavailable' }) }
      : { status: 200, json: async () => ({ ok: true, receipt: RECEIPT }) }),
  });
  assert.equal(sent.length, 2, 'exactly one retry — not a loop');
  assert.match(text, /PR-CD1-X-ABC/, 'the second attempt renders the receipt');
  assert.equal(printHidden, false);
});

jsdomTest('a receipt opened without a booking says so without calling the API', async () => {
  const { sent, text, printHidden } = await bootReceiptPage({
    search: '',
    respond: okResponse(RECEIPT),
  });
  assert.equal(sent.length, 0);
  assert.match(text, /No booking was specified/);
  assert.match(text, /Open your receipt from My Garage/);
  assert.equal(printHidden, true);
});
