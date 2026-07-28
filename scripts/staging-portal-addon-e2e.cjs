'use strict';

/**
 * Staging Customer Portal add-on authenticated E2E (API, synthetic booking).
 */

const https = require('https');
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const BASE = 'https://cardetail1-staging.netlify.app';
const SITE = '982e6338-4a4a-432e-855b-db532b994391';
const PROD = 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const r = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        ...headers,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function carVehicle(vehicleId, packageId = 'full') {
  return {
    vehicleId,
    category: 'cars',
    cat: 'cars',
    tierKey: 'small',
    packageId,
    pkgId: packageId,
    pkgName: packageId,
    addOnIds: [],
    addons: [],
  };
}

async function loadBooking(store, id) {
  return store.get(id, { type: 'json' });
}

async function main() {
  const token = String(process.env.NETLIFY_AUTH_TOKEN || '').trim();
  const siteID = String(process.env.NETLIFY_SITE_ID || '').trim();
  assert(token && siteID, 'missing_blobs_creds');
  assert(siteID === SITE && siteID !== PROD, 'staging_site_required');

  const store = getStore({ name: 'cd1-bookings', siteID, token });
  const phone = '5515550199';
  const id = `CD1-AUDITE2E${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  const now = new Date().toISOString();
  const vehicles = [carVehicle('v_a1', 'full'), carVehicle('v_a2', 'full')];
  const booking = {
    id,
    bookingId: id,
    bookingVersion: 1,
    quoteVersion: 1,
    schemaVersion: 1,
    status: 'Confirmed',
    jobStatus: 'confirmed',
    appointmentStatus: 'confirmed',
    paymentStatus: 'due',
    paymentWorkflowStatus: 'awaiting_customer_payment',
    firstName: 'Audit',
    lastName: 'Addon',
    phone,
    email: 'audit-addon@example.test',
    preferredDate: '2026-08-12',
    preferredTime: '10:00 AM',
    zipCode: '07102',
    travelFeeAmount: 0,
    packageId: 'full',
    packId: 'full',
    category: 'cars',
    service: { vehicles: vehicles.map((v) => ({ ...v })) },
    vehicles: vehicles.map((v) => ({ ...v })),
    vehicleId: 'v_a1',
    ledger: { currency: 'usd', settledCents: 0, approvedCents: 28500, creditedCents: 0, entries: [] },
    approvedFinalAmount: 285,
    totalPrice: 285,
    amountPaid: 0,
    createdAt: now,
    updatedAt: now,
    eventLog: [],
    changeRequests: [],
    isDraft: false,
    kind: 'booking',
  };
  await store.setJSON(id, booking);
  await sleep(2000);

  const results = { bookingId: id, phoneFingerprint: phone.slice(-4) };

  const data = await req('POST', '/.netlify/functions/customer-portal-data', {
    body: { bookingId: id, phone },
  });
  results.portalData = {
    status: data.status,
    ok: !!(data.json && data.json.ok),
    hasCatalog: !!(data.json && data.json.catalog),
    hasTimeline: Array.isArray(data.json?.timeline),
    blobs502: /MissingBlobsEnvironmentError/i.test(data.text || ''),
  };
  assert(data.status !== 502, 'portal_data_blobs_502');
  assert(data.json?.ok, `portal_data_failed:${data.status}:${data.text.slice(0, 160)}`);
  await sleep(6000);

  const add1 = await req('POST', '/.netlify/functions/submit-customer-action', {
    body: {
      bookingId: id,
      phone,
      action: 'addon_request',
      vehicleId: 'v_a1',
      addonIds: ['rainx'],
      expectedBookingVersion: 1,
      price: 9999,
      total: 9999,
    },
  });
  results.singleVehicle = {
    status: add1.status,
    ok: !!(add1.json && add1.json.ok),
    error: add1.json?.error || null,
    changeRequestId: add1.json?.changeRequestId ? 'present' : null,
    pendingApproval: add1.json?.pendingApproval,
    blobs502: /MissingBlobsEnvironmentError/i.test(add1.text || ''),
    bodySnippet: add1.text.slice(0, 180),
  };
  await sleep(6000);

  const after = await loadBooking(store, id);
  const ver = Math.round(Number(after?.bookingVersion) || 1);
  const dup = await req('POST', '/.netlify/functions/submit-customer-action', {
    body: {
      bookingId: id,
      phone,
      action: 'addon_request',
      vehicleId: 'v_a1',
      addonIds: ['rainx'],
      expectedBookingVersion: ver,
    },
  });
  results.duplicate = {
    status: dup.status,
    ok: dup.json?.ok,
    noop: !!dup.json?.noop,
    error: dup.json?.error || null,
    reason: dup.json?.reason || null,
  };
  await sleep(6000);

  const stale = await req('POST', '/.netlify/functions/submit-customer-action', {
    body: {
      bookingId: id,
      phone,
      action: 'addon_request',
      vehicleId: 'v_a1',
      addonIds: ['odor'],
      expectedBookingVersion: 0,
    },
  });
  results.stale = {
    status: stale.status,
    error: stale.json?.error || null,
    ok: stale.status === 409 && stale.json?.error === 'stale_appointment_version',
  };
  await sleep(6000);

  const cur = await loadBooking(store, id);
  const ver2 = Math.round(Number(cur?.bookingVersion) || 1);
  const missingVehicle = await req('POST', '/.netlify/functions/submit-customer-action', {
    body: {
      bookingId: id,
      phone,
      action: 'addon_request',
      addonIds: ['odor'],
      expectedBookingVersion: ver2,
    },
  });
  results.multiVehicleMissing = {
    status: missingVehicle.status,
    error: missingVehicle.json?.error || missingVehicle.json?.legacyError || null,
  };
  await sleep(6000);

  const addOther = await req('POST', '/.netlify/functions/submit-customer-action', {
    body: {
      bookingId: id,
      phone,
      action: 'addon_request',
      vehicleId: 'v_a2',
      addonIds: ['odor'],
      expectedBookingVersion: ver2,
    },
  });
  results.multiVehicleValid = {
    status: addOther.status,
    ok: !!(addOther.json && addOther.json.ok),
    error: addOther.json?.error || null,
  };
  await sleep(6000);

  const cur3 = await loadBooking(store, id);
  const ver3 = Math.round(Number(cur3?.bookingVersion) || 1);
  const invalid = await req('POST', '/.netlify/functions/submit-customer-action', {
    body: {
      bookingId: id,
      phone,
      action: 'addon_request',
      vehicleId: 'v_a1',
      addonIds: ['not_a_real_addon_xyz'],
      expectedBookingVersion: ver3,
    },
  });
  results.invalidAddon = {
    status: invalid.status,
    error: invalid.json?.error || null,
    ok: invalid.json?.error === 'addon_not_found',
  };
  await sleep(6000);

  // incompatible: engine on maint
  const maintVehicles = [carVehicle('v_a1', 'maint'), carVehicle('v_a2', 'full')];
  cur3.service = { vehicles: maintVehicles };
  cur3.vehicles = maintVehicles;
  cur3.packageId = 'maint';
  cur3.packId = 'maint';
  cur3.bookingVersion = ver3;
  await store.setJSON(id, cur3);
  await sleep(1500);
  const incompat = await req('POST', '/.netlify/functions/submit-customer-action', {
    body: {
      bookingId: id,
      phone,
      action: 'addon_request',
      vehicleId: 'v_a1',
      addonIds: ['engine'],
      expectedBookingVersion: ver3,
    },
  });
  results.incompatible = {
    status: incompat.status,
    error: incompat.json?.error || null,
    ok: incompat.json?.error === 'addon_not_compatible',
    bodySnippet: incompat.text.slice(0, 180),
  };
  await sleep(6000);

  const paidId = `CD1-AUDITPAID${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  const paidVehicle = carVehicle('v_p1', 'full');
  const paid = {
    ...booking,
    id: paidId,
    bookingId: paidId,
    bookingVersion: 1,
    service: { vehicles: [{ ...paidVehicle }] },
    vehicles: [{ ...paidVehicle }],
    vehicleId: 'v_p1',
    ledger: {
      currency: 'usd',
      settledCents: 28500,
      approvedCents: 28500,
      creditedCents: 0,
      entries: [{ kind: 'settlement', amountCents: 28500, providerObjectId: 'pi_seed_audit', recordedAt: now }],
    },
    amountPaid: 285,
    paymentStatus: 'paid',
    paymentWorkflowStatus: 'payment_succeeded',
    status: 'Paid',
  };
  await store.setJSON(paidId, paid);
  await sleep(1500);
  const paidAdd = await req('POST', '/.netlify/functions/submit-customer-action', {
    body: {
      bookingId: paidId,
      phone,
      action: 'addon_request',
      vehicleId: 'v_p1',
      addonIds: ['rainx'],
      expectedBookingVersion: 1,
    },
  });
  results.paidAdditive = {
    status: paidAdd.status,
    ok: !!(paidAdd.json && paidAdd.json.ok),
    error: paidAdd.json?.error || null,
    bodySnippet: paidAdd.text.slice(0, 180),
  };
  await sleep(6000);
  const paidAfter = await loadBooking(store, paidId);
  const paidVer = Math.round(Number(paidAfter?.bookingVersion) || 1);
  const paidRemove = await req('POST', '/.netlify/functions/submit-customer-action', {
    body: {
      bookingId: paidId,
      phone,
      action: 'addon_remove_request',
      vehicleId: 'v_p1',
      addonIds: ['rainx'],
      expectedBookingVersion: paidVer,
    },
  });
  results.paidRemoveDenied = {
    status: paidRemove.status,
    error: paidRemove.json?.error || null,
    denied: paidRemove.status >= 400 || paidRemove.json?.ok === false,
  };

  try { await store.delete(id); } catch { /* ignore */ }
  try { await store.delete(paidId); } catch { /* ignore */ }
  results.cleanup = true;

  const ok = results.portalData.ok
    && !results.portalData.blobs502
    && results.singleVehicle.ok
    && !results.singleVehicle.blobs502
    && (results.duplicate.noop || results.duplicate.error === 'addon_already_requested' || results.duplicate.ok)
    && results.stale.ok
    && results.invalidAddon.ok
    && results.incompatible.ok
    && results.multiVehicleValid.ok;

  console.log(JSON.stringify({ ok, results }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 240) }));
  process.exit(1);
});
