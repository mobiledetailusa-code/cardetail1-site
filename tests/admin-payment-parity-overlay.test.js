'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  overlayAdminJobMoneyFromProjection,
  projectJobForAdmin,
} = require('../netlify/lib/ops-workflow');
const { buildPaymentCompatibilityPatch } = require('../netlify/lib/db/operational-payment');

describe('admin payment parity — Postgres overlay', () => {
  it('overlays paid Postgres projection onto a stale unpaid Blob job', () => {
    const stale = projectJobForAdmin({
      id: 'CD1-PARITY-1',
      jobStatus: 'completed_pending_payment',
      paymentWorkflowStatus: 'awaiting_customer_payment',
      paymentStatus: 'due',
      approvedFinalAmount: 200,
      ledger: { approvedCents: 20000, settledCents: 0, refundedCents: 0, currency: 'usd' },
    });
    assert.ok(stale.remainingCents > 0);

    const overlaid = overlayAdminJobMoneyFromProjection(stale, {
      approvedCents: 20000,
      settledCents: 20000,
      remainingCents: 0,
      paymentStatus: 'paid',
      authority: 'postgres',
    });
    assert.equal(overlaid.remainingCents, 0);
    assert.equal(overlaid.invoicePaid, true);
    assert.equal(overlaid.paymentWorkflowStatus, 'payment_succeeded');
    assert.equal(overlaid.jobStatus, 'completed_paid');
    assert.equal(overlaid._moneyAuthority, 'postgres');
  });

  it('compatibility patch advances completed_pending_payment when paid', () => {
    const base = {
      id: 'CD1-PARITY-2',
      jobStatus: 'completed_pending_payment',
      paymentStatus: 'due',
      paymentWorkflowStatus: 'awaiting_customer_payment',
      ledger: { approvedCents: 15000, settledCents: 0, refundedCents: 0, currency: 'usd' },
    };
    const patch = buildPaymentCompatibilityPatch(base, {
      quoteVersion: 1,
      approvedCents: 15000,
      settledCents: 15000,
      refundedCents: 0,
      remainingCents: 0,
      paymentStatus: 'paid',
      paidAt: '2026-09-02T12:00:00.000Z',
    });
    assert.equal(patch.jobStatus, 'completed_paid');
    assert.equal(patch.balanceDue, 0);
    assert.equal(patch.paymentWorkflowStatus, 'payment_succeeded');
  });

  it('compatibility patch does not reopen completed_paid when balance returns', () => {
    const base = {
      id: 'CD1-PARITY-3',
      jobStatus: 'completed_paid',
      status: 'Closed',
      paymentStatus: 'paid',
      paymentWorkflowStatus: 'payment_succeeded',
      ledger: { approvedCents: 5000, settledCents: 5000, refundedCents: 0, currency: 'usd' },
    };
    const patch = buildPaymentCompatibilityPatch(base, {
      quoteVersion: 2,
      approvedCents: 8000,
      settledCents: 5000,
      refundedCents: 0,
      remainingCents: 3000,
      paymentStatus: 'due',
    });
    assert.equal(patch.jobStatus, undefined);
    assert.equal(patch.paymentStatus, 'due');
    assert.equal(patch.balanceDue, 30);
  });

  it('get_job repairs stale Blob money from Postgres and overlays response', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/admin-ops-jobs.js'), 'utf8');
    const slice = src.slice(src.indexOf("action === 'get_job'"), src.indexOf("action === 'get_job'") + 4500);
    assert.match(slice, /overlayAdminJobMoneyFromProjection/);
    assert.match(slice, /syncBlobCompatibilityFromProjection/);
    assert.match(slice, /moneyRepaired/);
  });

  it('approve_completion skips pending payment when already settled', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/admin-ops-jobs.js'), 'utf8');
    const slice = src.slice(src.indexOf("action === 'approve_completion'"), src.indexOf("action === 'approve_completion'") + 3500);
    assert.match(slice, /alreadyPaid \? 'completed_paid' : 'completed_pending_payment'/);
    assert.match(slice, /if \(!alreadyPaid\)/);
  });

  it('on-site settle repairs Blob when Postgres already paid', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'netlify/lib/db/operational-payment.js'),
      'utf8'
    );
    assert.match(src, /repaired: true/);
    assert.match(src, /already_paid/);
    assert.match(src, /needsSyncBefore \|\| needsJobClose/);
  });

  it('Admin UI treats already_paid as sync/refresh instead of a hard failure', () => {
    const html = fs.readFileSync(path.join(ROOT, 'admin-ops.html'), 'utf8');
    const slice = html.slice(html.indexOf('async function jobAction'), html.indexOf('async function jobAction') + 2200);
    assert.match(slice, /already_paid/);
    assert.match(slice, /Payment already recorded/);
    assert.match(slice, /openDrawer\(bookingId\)/);
  });