'use strict';

/**
 * Technician tip at payment — UI presets + server clamp + ledger partition.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const {
  SUGGESTED_TIP_PERCENTS,
  resolveTechnicianTip,
  suggestedTipOptions,
} = require('../netlify/lib/technician-tip');

const garageJs = read('assets/my-garage.js');
const garageHtml = read('my-garage.html');
const intentFn = read('netlify/functions/customer-balance-payment-intent.js');
const authority = read('netlify/lib/db/payment-authority-service.js');
const adminJs = read('assets/admin-ops.js');

describe('technician tip helpers', () => {
  it('suggests 15 / 18 / 20 percent of balance', () => {
    assert.deepEqual(SUGGESTED_TIP_PERCENTS, [15, 18, 20]);
    const opts = suggestedTipOptions(20000);
    assert.equal(opts[0].tipCents, 3000);
    assert.equal(opts[1].tipCents, 3600);
    assert.equal(opts[2].tipCents, 4000);
  });

  it('resolves percent and cents, and rejects oversized tips', () => {
    const ok = resolveTechnicianTip({ balanceCents: 10000, tipPercent: 18 });
    assert.equal(ok.ok, true);
    assert.equal(ok.tipCents, 1800);
    assert.equal(ok.chargeCents, 11800);

    const custom = resolveTechnicianTip({ balanceCents: 10000, tipCents: 500 });
    assert.equal(custom.ok, true);
    assert.equal(custom.chargeCents, 10500);

    const none = resolveTechnicianTip({ balanceCents: 10000, tipCents: 0 });
    assert.equal(none.chargeCents, 10000);

    const tooHigh = resolveTechnicianTip({ balanceCents: 10000, tipPercent: 50 });
    assert.equal(tooHigh.ok, false);
  });
});

describe('technician tip wiring', () => {
  it('My Garage exposes tip buttons and sends tipCents with the PaymentIntent', () => {
    assert.match(garageHtml, /id="tech-tip-panel"/);
    assert.match(garageHtml, /id="tech-tip-row"/);
    assert.match(garageJs, /SUGGESTED_TIP_PERCENTS/);
    assert.match(garageJs, /tipCents:\s*tipCents/);
    assert.match(garageJs, /Add a tip for your technician|Technician tip/);
    assert.match(garageJs, /data-tip-mode/);
  });

  it('payment intent endpoint accepts tip and returns tip breakdown', () => {
    assert.match(intentFn, /tipCents:\s*p\.tipCents/);
    assert.match(intentFn, /tipOptions:\s*suggestedTipOptions/);
    assert.match(intentFn, /balanceCents:\s*prepared\.balanceCents/);
  });

  it('authority charges balance+tip and settles tip as fee ledger', () => {
    assert.match(authority, /metadata\[tipCents\]/);
    assert.match(authority, /metadata\[balanceCents\]/);
    assert.match(authority, /cancelActiveAttemptsForTipChange/);
    assert.match(authority, /kind:\s*'fee'/);
    assert.match(authority, /tip_\$\{paymentIntent\.id\}|tip_/);
    assert.match(authority, /amountCents:\s*balanceCents/);
  });

  it('Admin price adjust uses dollars and shows technician tip', () => {
    assert.match(adminJs, /Amount \(\$\)/);
    assert.match(adminJs, /Math\.round\(dollars \* 100\)/);
    assert.match(adminJs, /Technician tip/);
  });

  it('Create appointment uses a modal form instead of prompt()', () => {
    assert.match(read('admin-ops.html'), /id="createApptModal"/);
    assert.match(adminJs, /openCreateApptModal/);
    assert.match(adminJs, /action:'create_appointment'/);
    assert.doesNotMatch(
      adminJs.slice(adminJs.indexOf('function openCreateApptModal'), adminJs.indexOf('function renderAdminSyncState')),
      /prompt\(/
    );
  });

  it('assets are cache-busted for tip release', () => {
    assert.match(garageHtml, /my-garage\.js\?v=20260809-tech-tip/);
    assert.match(read('admin-ops.html'), /admin-ops\.js\?v=20260809-tech-tip/);
  });
});
