'use strict';

/**
 * P0 — My Garage history must survive polling.
 *
 * Boots the real my-garage.html + assets/my-garage.js under jsdom and drives
 * the real loadAccount() path with a scripted fetch, so the assertions cover
 * API response → normalization → merge → DOM, not a reimplementation of it.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { JSDOM } = (() => {
  try { return { JSDOM: require('jsdom').JSDOM }; }
  catch { return { JSDOM: null }; }
})();

const ROOT = path.resolve(__dirname, '..');
const garageHtml = fs.readFileSync(path.join(ROOT, 'my-garage.html'), 'utf8');
const garageJs = fs.readFileSync(path.join(ROOT, 'assets/my-garage.js'), 'utf8');

const ACCOUNT = 'acct_alpha';
const OTHER_ACCOUNT = 'acct_beta';

const CURRENT = {
  id: 'CD1-CURRENT',
  appointmentPublicRef: 'aptr_currentcurrentcurrent',
  status: 'Confirmed',
  customerStatus: 'Confirmed',
  jobStatus: 'confirmed',
  preferredDate: '2026-09-14',
  confirmedDate: '2026-09-14',
  service: 'Signature Detail',
  package: 'Signature Detail',
  address: '1 Test Way, Newark NJ',
  approvedFinalAmount: 400,
  totalPrice: 400,
  amountDueApproved: 400,
  remainingCents: 40000,
  bookingVersion: 3,
  quoteVersion: 1,
  vehicles: [],
};

const HISTORY_A = {
  id: 'CD1-PAST-A',
  appointmentPublicRef: 'aptr_pastpastpastpastA',
  status: 'Paid',
  customerStatus: 'Paid',
  jobStatus: 'completed_paid',
  paymentWorkflowStatus: 'payment_succeeded',
  paymentStatus: 'paid',
  preferredDate: '2026-05-02',
  confirmedDate: '2026-05-02',
  service: 'Maintenance Detail',
  package: 'Maintenance Detail',
  approvedFinalAmount: 215,
  totalPrice: 215,
  amountPaid: 215,
  remainingCents: 0,
  settledCents: 21500,
  vehicles: [],
};

const HISTORY_B = {
  ...HISTORY_A,
  id: 'CD1-PAST-B',
  appointmentPublicRef: 'aptr_pastpastpastpastB',
  preferredDate: '2026-03-11',
  confirmedDate: '2026-03-11',
  service: 'Essential Detail',
  package: 'Essential Detail',
};

const FOREIGN = {
  ...HISTORY_A,
  id: 'CD1-FOREIGN',
  appointmentPublicRef: 'aptr_foreignforeignforeign',
  service: 'Someone Else Detail',
  package: 'Someone Else Detail',
};

const PAYMENT_DUE = {
  state: 'due',
  paymentStatus: 'due',
  canPay: true,
  canCreatePayLink: true,
  amountDueApproved: 400,
  approvedCents: 40000,
  settledCents: 0,
  remainingCents: 40000,
  bookingVersion: 3,
  quoteVersion: 1,
  authority: 'postgres',
};

let syncSeed = 0;
function accountPayload(overrides) {
  syncSeed += 1;
  return {
    ok: true,
    notModified: false,
    scope: 'account',
    customerAccountId: ACCOUNT,
    customer: null,
    bookings: [CURRENT, HISTORY_A, HISTORY_B],
    bookingsComplete: true,
    upcoming: CURRENT,
    focusedAppointment: null,
    focusError: null,
    payment: PAYMENT_DUE,
    catalog: { packages: [], addons: [], addonsByCategory: {} },
    packageCatalog: { source: 'booking-price-catalog', vehicles: [], packageCatalogByVehicle: {} },
    packageCatalogByVehicle: {},
    changeRequests: [],
    postService: null,
    priceAdjustments: null,
    postServiceByBooking: {},
    sections: { appointments: true, history: true, maintenancePlans: false, payments: true, communicationPreferences: false },
    syncVersion: 'sync_v1_seed' + syncSeed,
    serverTime: '2026-08-08T12:00:00.000Z',
    ...overrides,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Boot the portal against a single settable customer-portal-data response.
 * Boot may issue its own hydration read, so tests set the response they want
 * immediately before each explicit loadAccount() rather than relying on a queue.
 */
async function bootAccountPortal(initial) {
  let current = initial;
  const requests = [];
  const dom = new JSDOM(garageHtml, {
    url: 'https://example.test/my-garage.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.scrollTo = () => {};
  window.alert = () => {};
  if (!window.Element.prototype.scrollIntoView) window.Element.prototype.scrollIntoView = () => {};
  window.fetch = async (url, init) => {
    const fn = String(url).split('/').pop();
    const body = init && init.body ? JSON.parse(init.body) : {};
    requests.push({ fn, body });
    if (fn === 'customer-portal-data') {
      return { ok: true, status: 200, json: async () => current, headers: { get: () => null } };
    }
    if (fn === 'customer-portal-auth') {
      return { ok: true, status: 200, json: async () => ({ ok: true, authenticated: true }), headers: { get: () => null } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }), headers: { get: () => null } };
  };
  vm.runInContext(garageJs, dom.getInternalVMContext());
  await flush();
  const api = window.cd1MyGarage;
  api.state.scope = 'account';
  api.state.session = true;
  const serve = (payload) => { current = payload; };
  return { window, doc: window.document, api, requests, serve };
}

function historyIds(doc) {
  return [...doc.querySelectorAll('#history-list [data-appt-ref]')]
    .map((el) => el.getAttribute('data-appt-ref'));
}

function historyRowCount(doc) {
  return doc.querySelectorAll('#history-list li').length;
}

describe('P0 — customer portal history survives polling', { skip: JSDOM ? false : 'jsdom unavailable' }, () => {
  it('1. initial account load renders current appointment and history', async () => {
    const { doc, api } = await bootAccountPortal(accountPayload());
    assert.equal(await api.loadAccount({ managePhase: false }), true);

    assert.equal(api.state.booking.id, 'CD1-CURRENT');
    assert.equal(api.state.bookings.length, 3);
    assert.equal(historyRowCount(doc), 2);
    assert.deepEqual(historyIds(doc).sort(), [HISTORY_A, HISTORY_B].map((b) => b.appointmentPublicRef).sort());
    assert.equal(doc.getElementById('history-section').hidden, false);
    assert.match(doc.getElementById('upcoming-panel').textContent, /Signature Detail/);
  });

  it('2. a poll returning the same data preserves history', async () => {
    const { doc, api, serve } = await bootAccountPortal(accountPayload());
    await api.loadAccount({ managePhase: false });
    const before = historyIds(doc).sort();

    serve(accountPayload());
    await api.loadAccount({ managePhase: false });

    assert.deepEqual(historyIds(doc).sort(), before);
    assert.equal(api.state.bookings.length, 3);
    assert.equal(api.state.booking.id, 'CD1-CURRENT');
  });

  it('3. a partial poll (ownership source degraded) preserves valid history', async () => {
    const { doc, api, serve } = await bootAccountPortal(accountPayload());
    await api.loadAccount({ managePhase: false });
    assert.equal(historyRowCount(doc), 2);

    serve(accountPayload({ bookings: [CURRENT], bookingsComplete: false }));
    await api.loadAccount({ managePhase: false });

    assert.equal(historyRowCount(doc), 2, 'history must not be dropped by a partial payload');
    assert.deepEqual(historyIds(doc).sort(), [HISTORY_A, HISTORY_B].map((b) => b.appointmentPublicRef).sort());
    assert.equal(api.state.bookings.length, 3);
  });

  it('4. an empty transient poll does not erase history', async () => {
    const { doc, api, serve } = await bootAccountPortal(accountPayload());
    await api.loadAccount({ managePhase: false });

    serve(accountPayload({ bookings: [], bookingsComplete: false, upcoming: null, payment: null }));
    await api.loadAccount({ managePhase: false });

    assert.equal(historyRowCount(doc), 2, 'empty payload must not clear rendered history');
    assert.equal(api.state.bookings.length, 3);
    // A degraded snapshot must not be cached as the sync cursor.
    assert.equal(api.state.syncVersion, '');
  });

  it('5. the current booking stays current across a degraded poll', async () => {
    const { doc, api, serve } = await bootAccountPortal(accountPayload());
    await api.loadAccount({ managePhase: false });
    serve(accountPayload({ bookings: [], bookingsComplete: false, upcoming: null, payment: null }));
    await api.loadAccount({ managePhase: false });

    assert.equal(api.state.booking.id, 'CD1-CURRENT');
    assert.match(doc.getElementById('upcoming-panel').textContent, /Signature Detail/);
    // The last good money projection survives a payload that described no booking.
    assert.equal(api.state.payment.remainingCents, 40000);
  });

  it('6. customer isolation — a different account never merges into the cache', async () => {
    const { doc, api, serve } = await bootAccountPortal(accountPayload());
    await api.loadAccount({ managePhase: false });
    serve(accountPayload({
      customerAccountId: OTHER_ACCOUNT,
      bookings: [FOREIGN],
      bookingsComplete: false,
      upcoming: FOREIGN,
    }));
    await api.loadAccount({ managePhase: false });

    const ids = api.state.bookings.map((b) => b.id);
    assert.deepEqual(ids, ['CD1-FOREIGN']);
    assert.equal(ids.includes('CD1-CURRENT'), false, 'previous account bookings must not survive');
    assert.equal(historyIds(doc).includes(HISTORY_A.appointmentPublicRef), false);
  });

  it('7. a complete payload still applies a real removal', async () => {
    const { doc, api, serve } = await bootAccountPortal(accountPayload());
    await api.loadAccount({ managePhase: false });
    assert.equal(historyRowCount(doc), 2);

    serve(accountPayload({ bookings: [CURRENT, HISTORY_A], bookingsComplete: true }));
    await api.loadAccount({ managePhase: false });

    assert.equal(historyRowCount(doc), 1, 'authoritative removals must still apply');
    assert.deepEqual(historyIds(doc), [HISTORY_A.appointmentPublicRef]);
  });

  it('7b. a complete empty payload clears revoked/unauthorized bookings', async () => {
    const { doc, api, serve } = await bootAccountPortal(accountPayload());
    await api.loadAccount({ managePhase: false });
    assert.equal(api.state.bookings.length, 3);

    serve(accountPayload({
      bookings: [],
      bookingsComplete: true,
      upcoming: null,
      payment: null,
    }));
    await api.loadAccount({ managePhase: false });

    assert.equal(api.state.bookings.length, 0, 'authoritative empty must replace cache');
    assert.equal(historyRowCount(doc), 0);
    assert.equal(doc.getElementById('history-section').hidden, true);
  });

  it('8. only the opaque focus ref is ever sent as the appointment parameter', async () => {
    const { api, requests } = await bootAccountPortal(accountPayload());
    api.state.appointmentFocusRef = 'CD1-CURRENT';
    await api.loadAccount({ managePhase: false });

    const portalCalls = requests.filter((r) => r.fn === 'customer-portal-data');
    assert.ok(portalCalls.length > 0);
    for (const call of portalCalls) {
      if (call.body.appointment != null) {
        assert.match(call.body.appointment, /^aptr_/);
      }
    }
    assert.equal(portalCalls.some((c) => c.body.appointment === 'CD1-CURRENT'), false);
  });
});

describe('P0 — portal data marks a degraded ownership read', () => {
  it('exposes bookingsComplete on the account payload contract', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/customer-portal-data.js'), 'utf8');
    assert.match(src, /bookingsComplete: ownershipComplete/);
    // Both Postgres ownership sources must record their own degradation.
    assert.equal((src.match(/ownershipComplete = false/g) || []).length, 2);
  });

  it('client merges rather than replaces when the payload is incomplete', () => {
    assert.match(garageJs, /function mergePortalBookings\(/);
    assert.match(garageJs, /state\.bookings = mergePortalBookings\(/);
    assert.doesNotMatch(garageJs, /state\.bookings = r\.data\.bookings \|\| \[\];/);
  });
});
