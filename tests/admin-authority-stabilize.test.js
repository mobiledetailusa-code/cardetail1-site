'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');

const ROOT = path.join(__dirname, '..');

describe('Admin authority stabilize — cash parse + close when paid', () => {
  const {
    parseStrictCashDollarsToCents,
    resolveAdminCashSettlement,
    closeJobWhenPaid,
  } = require('../netlify/lib/admin-booking-mutations');

  it('rejects NaN-like and bare $ without digits', () => {
    assert.equal(parseStrictCashDollarsToCents('NaN').ok, false);
    assert.equal(parseStrictCashDollarsToCents('$NaN').ok, false);
    assert.equal(parseStrictCashDollarsToCents('abc').ok, false);
  });

  it('accepts exact dollar strings and omit-amount settles remaining', () => {
    const booking = {
      id: 'CD1-TEST',
      ledger: { approvedCents: 26000, settledCents: 0, creditedCents: 0 },
      approvedFinalAmount: 260,
      amountPaid: 0,
    };
    const omitted = resolveAdminCashSettlement(booking, {});
    assert.equal(omitted.ok, true);
    assert.equal(omitted.amountCents, 26000);

    const exact = resolveAdminCashSettlement(booking, { amount: '260.00' });
    assert.equal(exact.ok, true);
    assert.equal(exact.amountCents, 26000);
  });

  it('closeJobWhenPaid requires settled balance and does not invent money', () => {
    const unpaid = closeJobWhenPaid({
      id: 'CD1-U',
      jobStatus: 'confirmed',
      amountPaid: 0,
      remainingCents: 10000,
    });
    assert.equal(unpaid.ok, false);
    assert.equal(unpaid.error, 'balance_remaining');

    const paid = closeJobWhenPaid({
      id: 'CD1-P',
      jobStatus: 'completed_pending_payment',
      paymentWorkflowStatus: 'payment_succeeded',
      amountPaid: 260,
      remainingCents: 0,
      settledCents: 26000,
    });
    assert.equal(paid.ok, true);
    assert.equal(paid.booking.jobStatus, 'completed_paid');
  });
});

describe('Admin authority stabilize — selectUpcoming multi-booking priority', () => {
  const {
    selectUpcoming,
    hasOpenPayableBalance,
    isSettledPaidHero,
  } = require('../netlify/functions/customer-portal-data').__test;

  const now = Date.parse('2026-08-08T12:00:00.000Z');

  it('prefers open-balance sibling over older settled-paid hero', () => {
    const paidOld = {
      id: 'CD1-PAID',
      status: 'Confirmed',
      jobStatus: 'confirmed',
      preferredDate: '2026-08-01',
      confirmedDate: '2026-08-01',
      remainingCents: 0,
      settledCents: 26000,
      amountPaid: 260,
      paymentWorkflowStatus: 'payment_succeeded',
      updatedAt: '2026-08-01T10:00:00.000Z',
    };
    const unpaidNewer = {
      id: 'CD1-DUE',
      status: 'Confirmed',
      jobStatus: 'confirmed',
      preferredDate: '2026-08-20',
      confirmedDate: '2026-08-20',
      remainingCents: 17500,
      settledCents: 0,
      amountDueApproved: 175,
      paymentWorkflowStatus: 'due',
      updatedAt: '2026-08-08T10:00:00.000Z',
    };
    assert.equal(isSettledPaidHero(paidOld), true);
    assert.equal(hasOpenPayableBalance(unpaidNewer), true);
    const hero = selectUpcoming([paidOld, unpaidNewer], { now });
    assert.equal(hero.id, 'CD1-DUE');
  });

  it('still returns settled-paid when it is the only active booking', () => {
    const paidOnly = {
      id: 'CD1-ONLY',
      status: 'Confirmed',
      jobStatus: 'confirmed',
      preferredDate: '2026-08-10',
      remainingCents: 0,
      settledCents: 10000,
      paymentWorkflowStatus: 'cash_paid',
    };
    assert.equal(selectUpcoming([paidOnly], { now }).id, 'CD1-ONLY');
  });
});

describe('Admin authority stabilize — clock-poison + UI seams', () => {
  it('postServiceState omits msRemaining and nested serverTime', () => {
    const { postServiceState } = require('../netlify/lib/post-service-experience');
    const state = postServiceState({
      id: 'CD1-X',
      jobStatus: 'completed_paid',
      completedAt: '2026-08-07T10:00:00.000Z',
    });
    assert.equal(Object.prototype.hasOwnProperty.call(state.serviceIssue || {}, 'msRemaining'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(state, 'serverTime'), false);
    assert.ok(Number.isFinite(state.serviceIssue.hoursRemaining));
  });

  it('admin-ops wires cash parse, close when paid, create-from-booking, and authority tabs', () => {
    const html = fs.readFileSync(path.join(ROOT, 'admin-ops.html'), 'utf8');
    assert.match(html, /function parseCashAmountInput/);
    assert.match(html, /function formatActionError/);
    assert.match(html, /close_job/);
    assert.match(html, /dCreateFromBooking/);
    assert.match(html, /dCashAmt/);
    assert.match(html, /\['resolve','Resolve'\]/);
    assert.doesNotMatch(html, /Confirmed by your bank/);
  });

  it('my-garage pins focus after pay and silences idle Updating…', () => {
    const js = fs.readFileSync(path.join(ROOT, 'assets/my-garage.js'), 'utf8');
    assert.match(js, /appointmentFocusRef = state\.booking\.appointmentPublicRef/);
    assert.match(js, /if \(portalHasPendingState\(\)\) el\.textContent = 'Updating…'/);
    assert.doesNotMatch(js, /Confirmed by your bank/);
  });
});
