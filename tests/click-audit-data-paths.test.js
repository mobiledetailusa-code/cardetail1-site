'use strict';

/**
 * Click / link / send audit — regression guards for the defects found while
 * walking every Admin Ops + My Garage + Receipt control path.
 *
 * Scope: wiring honesty (no silent success, no dead CTAs that look live,
 * no auth gaps on limited sessions, no env coupling that blinds money ops).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const adminJs = read('assets/admin-ops.js');
const garageJs = read('assets/my-garage.js');
const receiptJs = read('assets/receipt.js');
const prismaJs = read('netlify/lib/prisma.js');
const adminHtml = read('admin-ops.html');
const garageHtml = read('my-garage.html');
const receiptHtml = read('receipt.html');

describe('click audit — Admin session / links / requests', () => {
  it('ensureAdminSession fails closed on network errors', () => {
    const fn = adminJs.slice(adminJs.indexOf('async function ensureAdminSession()'));
    const body = fn.slice(0, fn.indexOf('\n  async function api('));
    const catchIdx = body.indexOf('catch');
    assert.ok(catchIdx > 0, 'has catch');
    const catchBody = body.slice(catchIdx);
    assert.match(catchBody, /Could not verify Admin session/);
    assert.match(catchBody, /return false/);
    assert.doesNotMatch(catchBody, /return true/);
  });

  it('generate_customer_link surfaces empty URL and thrown errors', () => {
    assert.match(adminJs, /Completion link was empty/);
    assert.match(adminJs, /My Garage link was empty/);
    assert.match(adminJs, /Completion link failed:/);
    assert.match(adminJs, /My Garage link failed:/);
    assert.doesNotMatch(
      adminJs.slice(adminJs.indexOf("linkType:'completion'"), adminJs.indexOf("linkType:'my_garage'") + 400),
      /catch\s*\(\s*e\s*\)\s*\{\s*\}/
    );
  });

  it('Approved/Declined request filters do not keep open job CRs', () => {
    assert.match(adminJs, /function filterMergedRequestsForStatus/);
    const fn = adminJs.slice(adminJs.indexOf('function filterMergedRequestsForStatus'));
    const body = fn.slice(0, fn.indexOf('\n  function requestsEmptyCopy'));
    assert.match(body, /st === 'applied' \|\| st === 'approved'/);
    assert.match(body, /st === 'rejected' \|\| st === 'declined'/);
    assert.match(adminJs, /filterMergedRequestsForStatus\(mergeRequestsWithJobs/);
  });

  it('manual pay reference Save button is usable when unpaid', () => {
    assert.match(adminJs, /id="dSetPayLink"[^>]*>Save manual reference/);
    assert.doesNotMatch(adminJs, /id="dSetPayLink"[^>]*\bhidden\b/);
    assert.match(adminJs, /action:'set_payment_link'/);
  });
});

describe('click audit — receipt limited auth + garage honesty', () => {
  it('receipt POST includes phone from query or matching garage session', () => {
    assert.match(receiptJs, /sessionStorage\.getItem\('cd1_garage_phone'\)/);
    assert.match(receiptJs, /sessionStorage\.getItem\('cd1_garage_id'\)/);
    assert.match(receiptJs, /payload\.phone = phone/);
  });

  it('last vehicle offers Cancel appointment instead of fake remove', () => {
    assert.match(garageJs, /Cancel appointment/);
    assert.match(garageJs, /Last vehicle cannot be removed/);
    assert.doesNotMatch(
      garageJs.slice(garageJs.indexOf('function renderVehicleActionsHtml'), garageJs.indexOf('function renderVehicleBreakdownHtml')),
      /data-last-vehicle="1"/
    );
  });

  it('hosted Checkout fallback no longer calls retired customer-portal-pay', () => {
    const fn = garageJs.slice(garageJs.indexOf('async function startHostedCheckoutFallback()'));
    const body = fn.slice(0, fn.indexOf('\n  async function saveSmsConsent'));
    const codeOnly = body.replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(codeOnly, /customer-portal-pay|post\(/);
    assert.match(body, /Card payment could not start/);
  });

  it('paid invoice copy says Admin review, not permanently closed', () => {
    assert.match(garageJs, /Package and vehicle changes go through Admin review/);
    assert.doesNotMatch(garageJs, /Package and vehicle changes stay closed/);
  });

  it('broken magic action token shows an error instead of silent fall-through', () => {
    assert.match(garageJs, /This appointment link could not be opened/);
  });
});

describe('click audit — Prisma client vs booking mirror env', () => {
  it('PRISMA_BOOKING_MIRROR does not gate tryGetPrisma', () => {
    const fn = prismaJs.slice(prismaJs.indexOf('function tryGetPrisma()'));
    const body = fn.slice(0, fn.indexOf('\nfunction getPrisma'));
    const codeOnly = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(codeOnly, /PRISMA_BOOKING_MIRROR/);
    assert.match(codeOnly, /prismaConfigured\(\)/);
    assert.match(prismaJs, /booking-prisma-mirror/);
  });
});

describe('click audit — cache bust on touched assets', () => {
  it('HTML loads click-audit asset versions', () => {
    assert.match(adminHtml, /admin-ops\.js\?v=20260809-click-audit/);
    assert.match(garageHtml, /my-garage\.js\?v=20260809-click-audit/);
    assert.match(receiptHtml, /receipt\.js\?v=20260809-click-audit/);
  });
});
