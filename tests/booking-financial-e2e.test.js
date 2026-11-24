'use strict';

// End-to-end money check for car bookings, from each booking page to the
// stored booking, with synthetic data and in-memory stores (no network, no
// payment, no production data).
//
// For every one of the 13 pages that carry the car booking, each scenario is
// driven through the page's own code (state, add-on cards, quantity stepper,
// package / vehicle / ZIP changes, buildBookingPayload) and then submitted to
// the real submit-booking handler (draft, then finalize). The test compares:
//   A card prices            B summary total ("Estimated total")
//   C total the page sends   D server total on the draft
//   E total accepted         F stored totalPrice / approvedFinalAmount / balanceDue
//   G customer portal view   H stored line items the charge path reads
// All in exact cents.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, ResourceLoader, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SUBMIT_PATH = require.resolve('../netlify/functions/submit-booking');
const { setSlotIndexStoreOverride } = require('../netlify/lib/slot-index');
const { projectBookingForCustomer } = require('../netlify/lib/ops-schema');
const { projectQuickOpsBooking } = require('../netlify/lib/admin-quick-ops-view');

const PAGES = [
  'index.html', 'bergen-county-hub.html', 'connecticut-hub.html', 'essex-county-hub.html',
  'hudson-county-hub.html', 'new-jersey-hub.html', 'newark-mobile-detailing.html',
  'ny-metro-hub.html', 'passaic-county-hub.html', 'pennsylvania-hub.html', 'template-city.html',
  'trenton-mobile-detailing.html', 'westchester-mobile-detailing.html',
];

const VEHICLES = {
  camry: { make: 'Toyota', model: 'Camry', tier: 'small' },
  rav4: { make: 'Toyota', model: 'RAV4', tier: 'suv2' },
  highlander: { make: 'Toyota', model: 'Highlander', tier: 'suv3' },
  f150: { make: 'Ford', model: 'F-150', tier: 'truck' },
};

// Each step runs in order through the page. `expect` is the server-side total
// worked out by hand from the catalog, so every number below is checked twice.
const SCENARIOS = [
  {
    name: 'Interior + Headlight, RAV4, 07601',
    steps: [['zip', '07601'], ['vehicle', 'rav4'], ['pkg', 'interior'], ['add', 'headlight']],
    expect: { service: 225 + 90, travel: 0 },
  },
  {
    name: 'Full + Super Interior + Pet Hair + Polymer, RAV4, ZIP changed 07601 -> 10001',
    steps: [['zip', '07601'], ['vehicle', 'rav4'], ['pkg', 'full'], ['add', 'superint'], ['add', 'pethair'], ['add', 'polymer'], ['zip', '10001']],
    expect: { service: 285 + 125 + 95 + 25, travel: 35 },
  },
  {
    name: 'Maintenance + Floor Mats x2 (stepper), Camry, 08608',
    steps: [['zip', '08608'], ['vehicle', 'camry'], ['pkg', 'maint'], ['add', 'floormats'], ['qty', 'floormats', 1]],
    expect: { service: 160 + 2 * 20, travel: 30 },
  },
  {
    name: 'Wash + Carnauba + Engine + Clay, then Clay removed, Highlander, 10001',
    steps: [['zip', '10001'], ['vehicle', 'highlander'], ['pkg', 'wash'], ['add', 'wax1yr'], ['add', 'engine'], ['add', 'claybar'], ['remove', 'claybar']],
    expect: { service: 165 + 75 + 45, travel: 35 },
  },
  {
    name: 'Package change Full -> Refresh drops old add-ons, then Headlight, F-150, 19103',
    steps: [['zip', '19103'], ['vehicle', 'f150'], ['pkg', 'full'], ['add', 'superint'], ['pkg', 'refresh'], ['add', 'headlight']],
    expect: { service: 420 + 90, travel: 60 },
  },
  {
    name: 'Vehicle change Camry -> Highlander keeps Interior + Headlight and reprices the base, 07030',
    steps: [['zip', '07030'], ['vehicle', 'camry'], ['pkg', 'interior'], ['add', 'headlight'], ['vehicle', 'highlander']],
    expect: { service: 255 + 90, travel: 0 },
  },
];

function upcomingMonday() {
  const d = new Date();
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  utc.setUTCDate(utc.getUTCDate() + 14);
  utc.setUTCDate(utc.getUTCDate() + ((8 - utc.getUTCDay()) % 7));
  return utc.toISOString().slice(0, 10);
}
const DATE = upcomingMonday();

class LocalLoader extends ResourceLoader {
  fetch(url) {
    const u = new URL(url);
    if (u.hostname !== 'localhost') return Promise.resolve(Buffer.from(''));
    const file = path.join(ROOT, decodeURIComponent(u.pathname).replace(/^\/+/, ''));
    if (!/\.js$/.test(file) || !fs.existsSync(file)) return Promise.resolve(Buffer.from(''));
    return Promise.resolve(fs.readFileSync(file));
  }
}

function loadPage(file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost/' + file,
    runScripts: 'dangerously',
    resources: new LocalLoader(),
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      w.fetch = () => Promise.resolve({ ok: false, status: 503, json: async () => ({}), text: async () => '' });
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      w.scrollTo = () => {};
      w.HTMLElement.prototype.scrollIntoView = function () {};
    },
  });
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(dom.window); } };
    dom.window.addEventListener('load', () => setTimeout(finish, 50));
    setTimeout(finish, 20000);
  });
}

function card(w, id) {
  return w.document.querySelector('#addon-grid .addon[data-id="' + id + '"]');
}

function runStep(w, step) {
  const [kind, a, b] = step;
  if (kind === 'zip') {
    const input = w.document.getElementById('bk-zip');
    if (input) input.value = a;
    w.eval(`applyTravelForZip(${JSON.stringify(a)}); updateTotal();`);
  } else if (kind === 'vehicle') {
    const v = VEHICLES[a];
    w.eval(`(function(){
      ST.cat='cars'; ST.make=${JSON.stringify(v.make)}; ST.model=${JSON.stringify(v.model)}; ST.year=2022;
      ST.vehicleLabel=${JSON.stringify('2022 ' + v.make + ' ' + v.model)};
      ST.tierKey=${JSON.stringify(v.tier)}; ST.tier=PRICING.cars.tiers[${JSON.stringify(v.tier)}];
      if(ST.pkg){ setBasePrice(); window.renderAddons(); recalcAddonTotal(); updateTotal(); }
    })()`);
  } else if (kind === 'pkg') {
    w.eval(`(function(){
      var changed = ST.pkgId !== ${JSON.stringify(a)};
      ST.pkgId=${JSON.stringify(a)}; ST.pkg=PRICING.cars.packages.find(function(p){return p.id===${JSON.stringify(a)};});
      if(changed){ ST._addonKey=''; ST.addons=[]; ST.addonTotal=0; }
      setBasePrice(); window.renderAddons(); updateTotal();
    })()`);
  } else if (kind === 'add' || kind === 'remove') {
    const c = card(w, a);
    assert.ok(c, `card ${a} exists`);
    const selected = c.classList.contains('sel');
    if ((kind === 'add') !== selected) w.eval('toggleAddon')(c);
  } else if (kind === 'qty') {
    w.eval(`addonQty(${JSON.stringify(a)}, ${Number(b)})`);
  }
}

function fillContact(w, i) {
  const set = (id, v) => { const el = w.document.getElementById(id); if (el) el.value = v; };
  set('f-first', 'Probe');
  set('f-last', 'Synthetic');
  set('f-phone', `201555${String(1000 + i).slice(-4)}`);
  set('f-email', `probe-${i}@example.com`);
  set('f-addr', '100 Test St');
  set('f-date', DATE);
  set('f-time', '10:00 AM');
  const terms = w.document.getElementById('terms-ok');
  if (terms) terms.checked = true;
  w.eval("ST.payMethod='cash_onsite'");
}

function dollars(text) {
  const m = String(text || '').replace(/,/g, '').match(/\$([0-9]+(?:\.[0-9]{1,2})?)/);
  return m ? Number(m[1]) : null;
}
const cents = (v) => Math.round(Number(v) * 100);

// ── server harness (same pattern as booking-submit-incident.test.js) ──
function createMemoryStore() {
  const data = new Map();
  return {
    data,
    async get(key, opts = {}) {
      if (!data.has(key)) return null;
      const raw = data.get(key);
      return opts.type === 'json' ? JSON.parse(raw) : raw;
    },
    async setJSON(key, value) { data.set(key, JSON.stringify(value)); },
    async delete(key) { data.delete(key); },
    async list({ prefix } = {}) {
      return { blobs: [...data.keys()].filter((k) => !prefix || String(k).startsWith(prefix)).map((key) => ({ key })) };
    },
    records() {
      const out = [];
      for (const raw of data.values()) {
        try { const v = JSON.parse(raw); if (v && v.id) out.push(v); } catch { /* markers */ }
      }
      return out;
    },
  };
}

let submitBooking;
let bookings;
let ipSeq = 10;
function freshStores() {
  bookings = createMemoryStore();
  submitBooking.__test.setBlobsStoreOverride(async () => bookings);
  setSlotIndexStoreOverride(createMemoryStore());
}
async function post(body) {
  ipSeq += 1;
  const res = await submitBooking.handler({
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': `198.51.100.${ipSeq % 250}` },
    body: JSON.stringify(body),
  });
  let parsed = {};
  try { parsed = JSON.parse(res.body); } catch { parsed = {}; }
  return { status: res.statusCode, body: parsed };
}
async function submitDraftAndFinalize(payload) {
  const draftBody = { ...JSON.parse(JSON.stringify(payload)), isDraft: true };
  delete draftBody.draftBookingId;
  delete draftBody.draftSaveToken;
  const draft = await post(draftBody);
  if (draft.status !== 200) return { draft };
  const fin = await post({ ...draftBody, isDraft: false, draftBookingId: draft.body.id, draftSaveToken: draft.body.draftSaveToken, acceptedBookingPolicy: true });
  const saved = fin.status === 200 ? bookings.records().find((r) => r.id === fin.body.id) : null;
  return { draft, fin, saved };
}

const ENV_KEYS = ['DRAFT_TOKEN_SECRET', 'CONTEXT', 'NETLIFY_DEV'];
const savedEnv = {};
const RESULTS = {};

before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.DRAFT_TOKEN_SECRET = 'e'.repeat(32);
  process.env.CONTEXT = 'dev';
  process.env.NETLIFY_DEV = 'true';
  delete require.cache[SUBMIT_PATH];
  submitBooking = require('../netlify/functions/submit-booking');

  let n = 0;
  for (const file of PAGES) {
    const w = await loadPage(file);
    RESULTS[file] = {};
    for (const s of SCENARIOS) {
      n += 1;
      w.eval("ST.vehicles=[]; ST.addons=[]; ST.addonTotal=0; ST.pkgId=''; ST.pkg=null; ST._addonKey='';");
      for (const step of s.steps) runStep(w, step);
      fillContact(w, n);
      const selected = Array.from(w.document.querySelectorAll('#addon-grid .addon.sel')).map((c) => ({
        id: c.getAttribute('data-id'),
        cardPrice: Number(c.getAttribute('data-price')),
      }));
      const summary = dollars((w.document.getElementById('ah-total') || {}).textContent);
      const payload = JSON.parse(w.eval('JSON.stringify(buildBookingPayload())'));
      // Scheduling is not under test: use a slot the scheduler always accepts.
      Object.assign(payload, { preferredDate: DATE, preferredTime: '8:00 AM', preferredArrivalWindow: 'anytime', scheduleFlexibility: 'exact' });
      freshStores();
      const r = await submitDraftAndFinalize(payload);
      RESULTS[file][s.name] = { selected, summary, payload, ...r };
    }
    w.close();
  }
});

after(() => {
  try { submitBooking.__test.setBlobsStoreOverride(null); } catch { /* ignore */ }
  setSlotIndexStoreOverride(null);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

for (const s of SCENARIOS) {
  test(`A-H match in cents on all 13 pages: ${s.name}`, () => {
    const expectedTotal = s.expect.service + s.expect.travel;
    for (const file of PAGES) {
      const r = RESULTS[file][s.name];
      const tag = `${file} | ${s.name}`;
      // A. card prices are the catalog prices of the selected add-ons
      const catalog = require('../netlify/lib/booking-price-catalog').PRICING.cars.addons;
      for (const sel of r.selected) {
        assert.equal(cents(sel.cardPrice), cents(catalog.find((a) => a.id === sel.id).price), `${tag} A ${sel.id}`);
      }
      // B. summary on screen
      assert.equal(cents(r.summary), cents(expectedTotal), `${tag} B summary`);
      // C. total the page sends
      assert.equal(cents(r.payload.totalPrice), cents(expectedTotal), `${tag} C payload`);
      assert.equal(cents(r.payload.travelFeeAmount), cents(s.expect.travel), `${tag} C travel`);
      // D/E. server recomputation on draft and finalize
      assert.equal(r.draft.status, 200, `${tag} D draft ${JSON.stringify(r.draft.body)}`);
      assert.equal(r.fin.status, 200, `${tag} E finalize ${JSON.stringify(r.fin.body)}`);
      // F. stored booking
      const b = r.saved;
      assert.ok(b, `${tag} F stored`);
      assert.equal(cents(b.totalPrice), cents(expectedTotal), `${tag} F totalPrice`);
      assert.equal(cents(b.travelFeeAmount), cents(s.expect.travel), `${tag} F travel`);
      assert.equal(cents(b.approvedFinalAmount), cents(expectedTotal), `${tag} F approvedFinalAmount`);
      // Non-ceramic bookings leave balanceDue unset at submit; when set it must equal the total.
      if (b.balanceDue != null) assert.equal(cents(b.balanceDue), cents(expectedTotal), `${tag} F balanceDue`);
      assert.equal(cents(b.amountPaid || 0), 0, `${tag} F nothing charged`);
      // H. stored line items (what the charge and portal paths read)
      const v = b.vehicles[0];
      const lines = (v.addons || []).reduce((sum, a) => sum + cents(a.price) * (a.qty || 1), 0);
      assert.equal(cents(v.basePrice) + lines, cents(s.expect.service), `${tag} H lines`);
      for (const a of v.addons || []) {
        assert.equal(cents(a.price), cents(catalog.find((c) => c.id === a.id).price), `${tag} H ${a.id} unit price`);
      }
      assert.equal(new Set((v.addons || []).map((a) => a.id)).size, (v.addons || []).length, `${tag} H no duplicate line`);
      // G. customer portal and admin projections of the same booking
      const garage = projectBookingForCustomer(b);
      const admin = projectQuickOpsBooking(b);
      assert.equal(garage.approvedCents, cents(expectedTotal), `${tag} G portal approvedCents`);
      assert.equal(garage.remainingCents, cents(expectedTotal), `${tag} G portal remainingCents`);
      assert.equal(cents(garage.amountDueApproved), cents(expectedTotal), `${tag} G portal amount due`);
      assert.equal(admin.money.approvedCents, cents(expectedTotal), `${tag} G admin approvedCents`);
      assert.equal(admin.money.remainingCents, cents(expectedTotal), `${tag} G admin remainingCents`);
    }
  });
}

test('the browser cannot set the price: tampered totals, line prices, sizes and blocked add-ons', async () => {
  const base = RESULTS['index.html'][SCENARIOS[0].name].payload;
  // With PostgreSQL present (CI), slot occupancy outlives the in-memory
  // stores, so each probe gets its own customer and its own day.
  let probe = 0;
  const tamper = async (mutate) => {
    probe += 1;
    const p = JSON.parse(JSON.stringify(base));
    const day = new Date(`${DATE}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 7 * probe);
    Object.assign(p, {
      phone: `2015557${String(100 + probe).slice(-3)}`,
      email: `tamper-${probe}@example.com`,
      preferredDate: day.toISOString().slice(0, 10),
    });
    mutate(p);
    freshStores();
    return submitDraftAndFinalize(p);
  };
  // Total lowered by $5: refused.
  let r = await tamper((p) => { p.totalPrice -= 5; p.total_price = p.totalPrice; });
  assert.equal(r.draft.status, 200, 'drafts skip the mismatch check');
  assert.equal(r.fin.status, 400);
  assert.equal(r.fin.body.error, 'price_mismatch');
  // Add-on line price lowered to $1 with the same total: stored at the catalog price.
  r = await tamper((p) => { p.vehicles[0].addons[0].price = 1; p.vehicles[0].addonTotal = 1; });
  assert.equal(r.fin.status, 200, JSON.stringify(r.fin && r.fin.body));
  assert.equal(r.saved.vehicles[0].addons[0].price, 90);
  assert.equal(r.saved.totalPrice, 315);
  // Any difference in cents is refused: what the customer saw is what is recorded.
  for (const off of [314.5, 314.99, 315.01, 316]) {
    r = await tamper((p) => { p.totalPrice = off; });
    assert.equal(r.fin.status, 400, `total ${off}`);
    assert.equal(r.fin.body.error, 'price_mismatch', `total ${off}`);
  }
  // Floating-point noise below a cent is the same amount and is accepted.
  r = await tamper((p) => { p.totalPrice = 315.0000001; });
  assert.equal(r.fin.status, 200);
  assert.equal(cents(r.saved.totalPrice), cents(315));
  assert.equal(cents(r.saved.approvedFinalAmount), cents(315));
  // Smaller size claimed for a RAV4: refused.
  r = await tamper((p) => { p.vehicles[0].tierKey = 'small'; p.totalPrice = 290; });
  assert.equal(r.draft.status, 400);
  assert.equal(r.draft.body.error, 'tier_mismatch');
  // Add-ons the rules refuse, sent straight to the API.
  for (const [pkg, id] of [['maint', 'mold'], ['full', 'engine'], ['refresh', 'engine'], ['refresh', 'wax1yr'], ['interior', 'polymer'], ['full', 'trashcans'], ['full', 'engine_bay']]) {
    r = await tamper((p) => { p.vehicles[0].pkgId = pkg; p.vehicles[0].addons = [{ id, price: 0 }]; p.totalPrice = 0; });
    assert.equal(r.draft.status, 400, `${pkg} ${id}`);
    assert.equal(r.draft.body.error, 'addon_not_available', `${pkg} ${id}`);
  }
  // The same add-on sent twice would be priced twice: a new booking refuses it.
  r = await tamper((p) => { p.vehicles[0].addons = [{ id: 'headlight' }, { id: 'headlight' }]; p.totalPrice = 0; });
  assert.equal(r.draft.status, 400);
  assert.equal(r.draft.body.error, 'duplicate_addon');
  // Per-unit items go as one line with qty, which is accepted and priced per unit.
  r = await tamper((p) => { p.vehicles[0].pkgId = 'maint'; p.vehicles[0].tierKey = 'suv2'; p.vehicles[0].addons = [{ id: 'floormats', qty: 3 }]; p.totalPrice = 195 + 60; });
  assert.equal(r.fin.status, 200, JSON.stringify(r.fin && r.fin.body));
  assert.equal(cents(r.saved.totalPrice), cents(255));
});

test('stored bookings are priced as before: a repeated line on an old booking keeps its price', () => {
  const { computeBookingServiceSubtotal } = require('../netlify/lib/booking-price-catalog');
  const old = computeBookingServiceSubtotal({
    zipCode: '07601',
    createdAt: '2026-10-01T12:00:00Z',
    vehicles: [{ cat: 'cars', pkgId: 'interior', tierKey: 'suv2', addons: [{ id: 'headlight' }, { id: 'headlight' }] }],
  });
  assert.equal(old.ok, true);
  assert.equal(old.serviceSubtotal, 225 + 90 + 90, 'repricing never rewrites what an old booking carries');
});
