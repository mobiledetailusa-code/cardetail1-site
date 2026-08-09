'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');

const ROOT = path.join(__dirname, '..');

describe('production stabilization — portal P0 reliability', () => {
  it('postServiceState omits clock-poison fields from sync hash payload', () => {
    const { postServiceState } = require('../netlify/lib/post-service-experience');
    const state = postServiceState({
      id: 'CD1-X',
      jobStatus: 'completed_paid',
      completedAt: '2026-08-07T10:00:00.000Z',
    });
    assert.equal(Object.prototype.hasOwnProperty.call(state.serviceIssue || {}, 'msRemaining'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(state, 'serverTime'), false);
  });

  it('selectUpcoming prefers open-balance sibling over settled-paid nearer date', () => {
    const { selectUpcoming } = require('../netlify/functions/customer-portal-data').__test;
    const now = Date.parse('2026-08-08T12:00:00.000Z');
    const paidOld = {
      id: 'CD1-PAID',
      status: 'Confirmed',
      jobStatus: 'confirmed',
      preferredDate: '2026-08-01',
      confirmedDate: '2026-08-01',
      remainingCents: 0,
      settledCents: 26000,
      paymentWorkflowStatus: 'payment_succeeded',
      updatedAt: '2026-08-01T10:00:00.000Z',
    };
    const unpaid = {
      id: 'CD1-DUE',
      status: 'Confirmed',
      jobStatus: 'confirmed',
      preferredDate: '2026-08-20',
      confirmedDate: '2026-08-20',
      remainingCents: 17500,
      amountDueApproved: 175,
      paymentWorkflowStatus: 'due',
      updatedAt: '2026-08-08T10:00:00.000Z',
    };
    assert.equal(selectUpcoming([paidOld, unpaid], { now }).id, 'CD1-DUE');
  });

  it('selectUpcoming keeps the next appointment ahead of an old unpaid invoice', () => {
    const { selectUpcoming } = require('../netlify/functions/customer-portal-data').__test;
    const now = Date.parse('2026-08-08T12:00:00.000Z');
    // Both carry an open balance; the date horizon must decide.
    const staleUnpaid = {
      id: 'CD1-OLD',
      status: 'Confirmed',
      jobStatus: 'confirmed',
      preferredDate: '2020-01-10',
      confirmedDate: '2020-01-10',
      remainingCents: 26000,
      amountDueApproved: 260,
      paymentWorkflowStatus: 'due',
    };
    const nextUp = {
      id: 'CD1-NEXT',
      status: 'Confirmed',
      jobStatus: 'confirmed',
      preferredDate: '2026-09-20',
      confirmedDate: '2026-09-20',
      remainingCents: 26000,
      amountDueApproved: 260,
      paymentWorkflowStatus: 'due',
    };
    assert.equal(selectUpcoming([staleUnpaid, nextUp], { now }).id, 'CD1-NEXT');
    // Repeated reads are stable.
    assert.equal(selectUpcoming([nextUp, staleUnpaid], { now }).id, 'CD1-NEXT');
  });

  it('my-garage pins focus after pay and silences idle Updating…', () => {
    const js = fs.readFileSync(path.join(ROOT, 'assets/my-garage.js'), 'utf8');
    // The pin only ever stores the opaque server ref — a raw booking id is
    // rejected as invalid_focus and would clear the pin on the next poll.
    assert.match(js, /function pinCurrentAppointment\(\)/);
    assert.match(js, /if \(isOpaqueFocusRef\(ref\)\) state\.appointmentFocusRef = ref;/);
    assert.equal((js.match(/pinCurrentAppointment\(\);/g) || []).length, 2);
    assert.match(js, /if \(portalHasPendingState\(\)\) el\.textContent = 'Updating…'/);
    assert.doesNotMatch(js, /Confirmed by your bank/);
  });
});
