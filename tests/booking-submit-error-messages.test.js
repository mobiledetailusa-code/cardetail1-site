'use strict';

/**
 * Submit error copy must match what actually happened server-side.
 *
 * Before: price_mismatch, invalid_pricing, out_of_service_area, zip/phone
 * validation, booking_store_failed (500) and code-less 5xx all collapsed into
 * "Your booking request was not submitted… Please try again." For a price
 * mismatch that instruction cannot work (the page's stale total is resent).
 *
 * These tests also pin the protections the copy relies on: one draft, no
 * duplicate finalize, in-flight guard, button re-enabled, ambiguous network
 * failures never claimed as "not submitted".
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Review = require('../assets/booking-review-runtime.js');

function harness(finalizeResponder) {
  const alerts = [];
  const calls = [];
  const btn = { classList: { add() {}, remove() {} }, disabled: false };
  const els = { 'terms-ok': { checked: true }, 'sub-btn': btn, 'bk-pay-pref-err': { hidden: true, textContent: '' } };
  const win = {
    OS_PREVIEW_ACTIVE: false,
    BACKEND_BASE: '/.netlify/functions',
    location: { hostname: 'localhost' },
    document: { getElementById: (id) => els[id] || null, querySelectorAll: () => [] },
    ST: { payMethod: 'cash_onsite', draftRegistered: false, bookingPersisted: false, submitInFlight: false, lastPersistedBooking: null },
    alert: (msg) => alerts.push(String(msg)),
    bookingRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    buildBookingPayload: () => ({
      firstName: 'Test',
      phone: '2015550100',
      zipCode: '07650',
      totalPrice: 250,
      paymentMethodPreference: win.ST.payMethod,
      paymentMethod: win.ST.payMethod,
      draftBookingId: win.ST.bookingId || undefined,
      draftSaveToken: win.ST.draftSaveToken || undefined,
    }),
    captureDraftSaveResponse(d) {
      win.ST.bookingId = d.id;
      win.ST.draftRegistered = true;
      win.ST.draftSaveToken = d.draftSaveToken;
    },
    saveLocalBooking() {},
    bkGoTo() {},
    fetch: async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      if (body.isDraft) {
        return { ok: true, status: 200, json: async () => ({ ok: true, id: 'CD1-DRAFT', draftSaveToken: 'tok', bookingVersion: 1 }) };
      }
      return finalizeResponder(calls.filter((c) => !c.isDraft).length, body);
    },
  };
  win.window = win;
  return { win, alerts, calls, btn, finalizes: () => calls.filter((c) => !c.isDraft) };
}

async function run(h) {
  const saved = { fetch: global.fetch, alert: global.alert, document: global.document, ST: global.ST };
  global.fetch = h.win.fetch;
  global.alert = h.win.alert;
  global.document = h.win.document;
  global.ST = h.win.ST;
  try {
    return await Review.submit(h.win);
  } finally {
    Object.assign(global, saved);
  }
}

const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });

function assertRejectedCleanly(h, result) {
  assert.equal(result.ok, false);
  assert.equal(h.win.ST.bookingPersisted, false);
  assert.equal(h.win.ST.submitInFlight, false, 'in-flight guard released');
  assert.equal(h.btn.disabled, false, 'submit button usable again');
  assert.equal(h.calls.filter((c) => c.isDraft).length, 1, 'exactly one draft');
  assert.equal(h.win.ST.bookingId, 'CD1-DRAFT', 'draft id kept so a retry is idempotent');
}

describe('booking submit error messages', () => {
  it('price_mismatch tells the customer to refresh and review the total, without auto-retry', async () => {
    const h = harness(() => reply(400, { ok: false, error: 'price_mismatch' }));
    const result = await run(h);
    assertRejectedCleanly(h, result);
    assert.equal(result.code, 'price_mismatch');
    assert.equal(h.finalizes().length, 1, 'a stale total is not resent automatically');
    assert.equal(h.alerts.length, 1);
    assert.match(h.alerts[0], /price has changed/i);
    assert.match(h.alerts[0], /refresh the page and review your updated total/i);
    assert.doesNotMatch(h.alerts[0], /Please try again\.$/);
  });

  for (const [code, re] of [
    ['invalid_pricing', /reselect your vehicle and package/],
    ['out_of_service_area', /outside our online booking area/],
    ['invalid_phone', /valid phone number/],
    ['zip_required', /5-digit ZIP/],
  ]) {
    it(`400 ${code} gets a specific instruction`, async () => {
      const h = harness(() => reply(400, { ok: false, error: code }));
      const result = await run(h);
      assertRejectedCleanly(h, result);
      assert.equal(h.alerts.length, 1);
      assert.match(h.alerts[0], re);
    });
  }

  it('409 slot conflict keeps its existing choose-another-slot copy', async () => {
    const h = harness(() => reply(409, { ok: false, error: 'booking_slot_unavailable' }));
    const result = await run(h);
    assertRejectedCleanly(h, result);
    assert.match(h.alerts[0], /Choose another slot/i);
  });

  it('500 booking_store_failed (bookingCreated:false) says not submitted and safe to retry', async () => {
    const h = harness(() => reply(500, { ok: false, bookingCreated: false, error: 'booking_store_failed' }));
    const result = await run(h);
    assertRejectedCleanly(h, result);
    assert.match(h.alerts[0], /couldn't save your request right now, so it was not submitted/);
    assert.match(h.alerts[0], /try again in a moment/);
  });

  it('code-less 500 does not claim "not submitted"', async () => {
    const h = harness(() => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } }));
    const result = await run(h);
    assertRejectedCleanly(h, result);
    assert.equal(result.code, 'booking_submit_failed_500');
    assert.match(h.alerts[0], /couldn't complete your request right now/);
    assert.doesNotMatch(h.alerts[0], /not submitted/);
  });

  for (const [label, message] of [['network failure', 'Failed to fetch'], ['timeout (Safari)', 'The request timed out.']]) {
    it(`${label} after the draft is ambiguous: one reconcile retry, then "check before submitting again"`, async () => {
      const h = harness(() => { throw new TypeError(message); });
      const result = await run(h);
      assert.equal(result.ok, false);
      assert.equal(result.kind, 'ambiguous');
      assert.equal(h.finalizes().length, 2, 'single reconcile retry with the same draft id');
      assert.ok(h.finalizes().every((c) => c.draftBookingId === 'CD1-DRAFT'));
      assert.match(h.alerts[0], /could not confirm whether your booking request was received/i);
      assert.doesNotMatch(h.alerts[0], /not submitted/);
      assert.equal(h.win.ST.submitInFlight, false);
    });
  }

  it('success after a delay persists once and shows no error', async () => {
    const h = harness(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return reply(200, { ok: true, bookingCreated: true, id: 'CD1-OK', approvedFinalAmount: 250 });
    });
    h.win.showSuccess = () => {};
    const result = await run(h);
    assert.equal(result.ok, true);
    assert.equal(h.alerts.length, 0);
    assert.equal(h.finalizes().length, 1);
    assert.equal(h.win.ST.bookingPersisted, true);
  });

  it('double click while in flight sends no second request', async () => {
    let release;
    const h = harness(() => new Promise((r) => { release = () => r(reply(200, { ok: true, bookingCreated: true, id: 'CD1-OK' })); }));
    const saved = { fetch: global.fetch, alert: global.alert, document: global.document, ST: global.ST };
    Object.assign(global, { fetch: h.win.fetch, alert: h.win.alert, document: h.win.document, ST: h.win.ST });
    try {
      const first = Review.submit(h.win);
      await new Promise((r) => setTimeout(r, 10));
      const second = await Review.submit(h.win);
      assert.equal(second.kind, 'in_flight');
      release();
      const done = await first;
      assert.equal(done.ok, true);
      assert.equal(h.finalizes().length, 1);
      assert.equal(h.calls.filter((c) => c.isDraft).length, 1);
    } finally {
      Object.assign(global, saved);
    }
  });

  it('server userMessage still wins over local copy', () => {
    assert.equal(Review.notSubmittedMessage('price_mismatch', 'Server says hi'), 'Server says hi');
  });
});
