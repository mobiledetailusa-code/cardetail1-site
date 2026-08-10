'use strict';

/**
 * The portal splits owned appointments into Upcoming and History with
 * appointmentIsPast. That test used to read the operational status only, so an
 * appointment that was served but never closed out — left at Pending review or
 * Confirmed — stayed in Upcoming forever and the customer's list grew without
 * bound. Service date decides too.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'my-garage.js'),
  'utf8'
);

/** Source of one function declaration, by brace matching from its own header. */
function extractFn(name) {
  const at = SRC.indexOf('function ' + name + '(');
  assert.ok(at > -1, name + ' not found');
  let depth = 0;
  for (let i = SRC.indexOf('{', at); i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) return SRC.slice(at, i + 1);
    }
  }
  throw new Error('unbalanced ' + name);
}

/** Lift the classifier out of the IIFE so it can be exercised directly. */
function classifier() {
  const ctx = { ACTIONABLE_JOB_STATUSES: ['completed_pending_payment', 'awaiting_customer_action'] };
  vm.createContext(ctx);
  const src = ['appointmentNeedsAttention', 'todayIso', 'appointmentDatePassed', 'appointmentIsPast']
    .map(extractFn)
    .join('\n');
  vm.runInContext(
    src
    + '\nthis.appointmentIsPast = appointmentIsPast;'
    + 'this.appointmentDatePassed = appointmentDatePassed;'
    + 'this.todayIso = todayIso;',
    ctx
  );
  return ctx;
}

function dayOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

describe('appointment date classification', () => {
  const w = classifier();

  it('reads today as the local calendar day', () => {
    assert.match(w.todayIso(), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(w.todayIso(), dayOffset(0));
  });

  it('archives a served appointment that was never closed out', () => {
    const stale = { status: 'Pending Review', preferredDate: dayOffset(-120) };
    assert.equal(w.appointmentIsPast(stale), true, 'a March booking is not upcoming in August');
  });

  it('keeps today and future appointments upcoming', () => {
    assert.equal(w.appointmentIsPast({ status: 'Confirmed', preferredDate: dayOffset(0) }), false);
    assert.equal(w.appointmentIsPast({ status: 'Confirmed', preferredDate: dayOffset(7) }), false);
  });

  it('prefers the confirmed date over the requested one', () => {
    assert.equal(w.appointmentDatePassed({ preferredDate: dayOffset(-30), confirmedDate: dayOffset(5) }), false);
    assert.equal(w.appointmentDatePassed({ preferredDate: dayOffset(5), confirmedDate: dayOffset(-30) }), true);
  });

  it('never archives an appointment still waiting on the customer', () => {
    const actionable = {
      status: 'Confirmed',
      preferredDate: dayOffset(-10),
      jobStatus: 'completed_pending_payment',
    };
    assert.equal(w.appointmentIsPast(actionable), false, 'an unpaid past job must stay in front of the customer');

    const approval = {
      status: 'Confirmed',
      preferredDate: dayOffset(-10),
      customerApprovalStatus: 'pending',
    };
    assert.equal(w.appointmentIsPast(approval), false);
  });

  it('leaves an undated or malformed appointment alone', () => {
    assert.equal(w.appointmentDatePassed({}), false);
    assert.equal(w.appointmentDatePassed({ preferredDate: '' }), false);
    assert.equal(w.appointmentDatePassed({ preferredDate: 'next Tuesday' }), false);
    assert.equal(w.appointmentIsPast({ status: 'Pending Review' }), false);
  });

  it('still archives on status alone, date aside', () => {
    assert.equal(w.appointmentIsPast({ status: 'Paid', preferredDate: dayOffset(30) }), true);
    assert.equal(w.appointmentIsPast({ status: 'Cancelled', preferredDate: dayOffset(30) }), true);
    assert.equal(w.appointmentIsPast({ paymentStatus: 'paid', preferredDate: dayOffset(30) }), true);
  });
});
