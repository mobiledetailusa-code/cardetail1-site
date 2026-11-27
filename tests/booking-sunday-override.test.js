'use strict';

/**
 * Regression suite for explicitly opened Sundays (and the rest of the weekend
 * matrix). Customers picking an admin-opened Sunday were blocked by an
 * unconditional `day === 0` rejection in the booking UI even though the
 * server, the public snapshot and the browser availability client all said
 * the date was open. Operational availability must be the only authority.
 *
 * The DOM tests wire the real pieces together: server projection →
 * booking-availability-client.js → index.html inline schedule helpers →
 * booking-conversion-ux.js, with fetch answered from the server library.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const availability = require('../netlify/lib/operational-availability');

// jsdom objects come from another realm; compare their JSON shape.
const eq = (actual, expected, msg) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, msg);

const {
  validateBookingSchedule,
  slotsForDate,
  findNearbyOpenings,
  projectPublicAvailability,
  resolveActiveWeekendMode,
} = availability;

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (_) { JSDOM = null; }

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const BOOKING_PAGES = [
  'index.html',
  'bergen-county-hub.html',
  'hudson-county-hub.html',
  'essex-county-hub.html',
  'passaic-county-hub.html',
  'ny-metro-hub.html',
  'connecticut-hub.html',
  'pennsylvania-hub.html',
  'new-jersey-hub.html',
  'newark-mobile-detailing.html',
  'trenton-mobile-detailing.html',
  'westchester-mobile-detailing.html',
  'template-city.html',
];

// 10:00 AM America/New_York on Wednesday 2026-11-25.
const NOW = new Date('2026-11-25T15:00:00.000Z');
const WEEKEND = ['8:00 AM', '10:00 AM'];
const WEEKDAY = ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM'];

const D = {
  openSat: '2026-11-28',
  openSun: '2026-11-29',
  weekday: '2026-11-30',
  closedSat: '2026-12-05',
  closedSun: '2026-12-06',
  plainSat: '2026-12-12',
  plainSun: '2026-12-13',
  holiday: '2026-12-25',
  past: '2026-11-24',
};

function config(overrides = {}) {
  return {
    version: 1,
    businessTimezone: 'America/New_York',
    weekendMode: 'supervised',
    supervisedEffectiveDate: '2026-11-24',
    dateOverrides: {
      [D.openSat]: { enabled: true, capacity: 1, arrivalWindows: WEEKEND },
      [D.openSun]: { enabled: true, capacity: 1, arrivalWindows: WEEKEND },
      [D.closedSat]: { enabled: false, capacity: 1 },
      [D.closedSun]: { enabled: false, capacity: 1 },
      [D.holiday]: { enabled: true, capacity: 1, arrivalWindows: WEEKEND },
    },
    ...overrides,
  };
}

const legacyConfig = () => config({ weekendMode: 'legacy', supervisedEffectiveDate: null });

// ─── Server: authority for what is bookable ───────────────────────────────

test('server: supervised mode accepts opened weekends and rejects everything else', () => {
  const cfg = config();
  const ok = (d, t) => validateBookingSchedule(d, t, { config: cfg, now: NOW });
  assert.equal(ok(D.openSun, '8:00 AM').ok, true);
  assert.equal(ok(D.openSun, '10:00 AM').ok, true);
  assert.equal(ok(D.openSun, '12:00 PM').error, 'booking_time_unavailable');
  assert.equal(ok(D.openSat, '10:00 AM').ok, true);
  assert.equal(ok(D.weekday, '2:00 PM').ok, true);
  for (const d of [D.closedSun, D.closedSat, D.plainSun, D.plainSat]) {
    assert.equal(ok(d, '8:00 AM').error, 'booking_date_unavailable', d);
  }
  assert.equal(ok(D.holiday, '8:00 AM').error, 'booking_date_unavailable', 'holiday beats an enabled override');
  assert.equal(ok(D.past, '8:00 AM').error, 'booking_date_unavailable');
});

test('server: legacy mode keeps Saturdays open and Sundays closed unless overridden', () => {
  const cfg = legacyConfig();
  const ok = (d, t) => validateBookingSchedule(d, t, { config: cfg, now: NOW });
  assert.equal(ok(D.openSun, '8:00 AM').ok, true, 'override wins in legacy mode too');
  assert.equal(ok(D.plainSat, '8:00 AM').ok, true);
  assert.equal(ok(D.plainSun, '8:00 AM').error, 'booking_date_unavailable');
  assert.equal(ok(D.closedSat, '8:00 AM').error, 'booking_date_unavailable');
  assert.equal(ok(D.closedSun, '8:00 AM').error, 'booking_date_unavailable');
});

test('server: supervised activation boundary uses the business-timezone date', () => {
  const at = (iso) => new Date(iso);
  const cfg = config({ supervisedEffectiveDate: '2026-11-25' });
  // 23:30 New York on 11-24 → still legacy.
  assert.equal(resolveActiveWeekendMode(cfg, at('2026-11-25T04:30:00Z')).mode, 'legacy');
  // 00:30 New York on 11-25 → supervised.
  assert.equal(resolveActiveWeekendMode(cfg, at('2026-11-25T05:30:00Z')).mode, 'supervised');
  // Day before the effective date keeps legacy rules (plain Saturday open).
  const before = config({ supervisedEffectiveDate: '2026-11-26' });
  assert.equal(resolveActiveWeekendMode(before, NOW).mode, 'legacy');
  eq(slotsForDate(D.plainSat, before, NOW), WEEKEND);
  // Production shape on 2026-11-25: supervised, effective 2026-12-27 → legacy today.
  const prod = config({ supervisedEffectiveDate: '2026-12-27' });
  const snap = projectPublicAvailability(prod, { now: NOW });
  assert.equal(snap.weekendMode, 'legacy');
  assert.equal(snap.supervisedActivated, false);
  assert.equal(resolveActiveWeekendMode(prod, new Date('2026-12-27T15:00:00Z')).mode, 'supervised');
});

test('server: fully booked windows drop out of nearby openings on an opened Sunday', () => {
  const cfg = config();
  const all = findNearbyOpenings(D.openSun, cfg, { now: NOW, limit: 4 });
  eq(all.slice(0, 2).map((o) => o.preferredTime), WEEKEND);
  assert.ok(all.every((o) => o.preferredDate !== D.closedSun));
  const booked = findNearbyOpenings(D.openSun, cfg, {
    now: NOW, limit: 4, occupancy: { [`${D.openSun}|8:00 AM`]: 1 },
  });
  assert.equal(booked[0].preferredDate, D.openSun);
  assert.equal(booked[0].preferredTime, '10:00 AM');
});

// ─── Static guard: the unconditional Sunday rejection must not return ─────

test('no booking UI path rejects a date by weekday alone', () => {
  const ux = read('assets/booking-conversion-ux.js');
  assert.doesNotMatch(ux, /p\.day === 0\)/);
  assert.doesNotMatch(ux, /ap\.day === 0\)/);
  assert.match(ux, /if \(!slotsForIso\(iso\)\.length\) return \{ ok: false, message: DATE_UNAVAILABLE_MSG \}/);
  for (const page of BOOKING_PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /if\(p\.day===0\)\{bkShowScheduleMsg/, page);
    assert.doesNotMatch(html, /if\(p\.day===0\)return\{ok:false/, page);
    assert.doesNotMatch(html, /if\(ap\.day===0\)return/, page);
    // The only remaining weekday rule is the legacy inventory inside bkSlotsFor.
    assert.equal((html.match(/day===0/g) || []).length, 1, page);
    assert.match(html, /function bkSlotsFor\(iso\)\{[^}]*if\(p\.day===0\)return\[\];/, page);
    assert.match(html, /if\(!bkSlotsFor\(iso\)\.length\)return\{ok:false,message:'Unavailable — please choose another date\.'\};/, page);
    assert.match(html, /assets\/booking-availability-client\.js/, page);
    assert.match(html, /assets\/booking-conversion-ux\.js/, page);
  }
});

// ─── Inline fallback on all 13 pages (shared asset not loaded) ────────────

function inlineScheduleBlock(html) {
  const lines = html.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('const BK_SLOTS='));
  const end = lines.findIndex((l, i) => i > start && l.startsWith('function bkValidateScheduleSelection('));
  assert.ok(start >= 0 && end > start, 'inline schedule helpers present');
  return lines.slice(start, end + 1).join('\n');
}

function mountInline(page) {
  const block = inlineScheduleBlock(read(page));
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      <input id="f-date"><select id="f-time"><option value=""></option></select>
      <input id="f-arrival-window"><input type="checkbox" id="f-has-alternate">
      <input id="f-alt-date"><input id="f-alt-arrival-window"><div id="f-schedule-msg"></div>
      <script>${block}\nwindow.bkEarliestBookable = function () { return '2026-11-25'; };</script>
    </body></html>`,
    { runScripts: 'dangerously', url: 'https://example.com/' },
  );
  const { window } = dom;
  const doc = window.document;
  function pick(date, opts = {}) {
    doc.getElementById('f-date').value = date;
    doc.getElementById('f-arrival-window').value = 'anytime';
    doc.getElementById('f-has-alternate').checked = !!opts.altDate;
    doc.getElementById('f-alt-date').value = opts.altDate || '';
    doc.getElementById('f-alt-arrival-window').value = opts.altDate ? 'anytime' : '';
    window.bkRefreshTimeSlots();
    const time = doc.getElementById('f-time');
    if (!time.value) {
      const first = [...time.options].find((o) => o.value);
      if (first) time.value = first.value;
    }
    return {
      result: window.bkValidateScheduleSelection(),
      msg: doc.getElementById('f-schedule-msg').textContent,
    };
  }
  return { window, doc, pick };
}

if (JSDOM) {
  for (const page of BOOKING_PAGES) {
    test(`inline fallback (${page}): availability decides, not the weekday`, () => {
      const { window, pick } = mountInline(page);

      // No snapshot → legacy inventory: fail closed on Sundays, open Saturdays/weekdays.
      const sun = pick(D.openSun);
      eq(sun.result, { ok: false, message: 'Unavailable — please choose another date.' });
      assert.equal(sun.msg, 'Unavailable — please choose another date.');
      assert.equal(pick(D.plainSat).result.ok, true);
      assert.equal(pick(D.weekday).result.ok, true);
      assert.match(pick(D.holiday).result.message, /Closed for the holiday/);
      assert.match(pick(D.past).result.message, /today or a later open day/);

      // When the availability inventory opens the Sunday, nothing else blocks it.
      const legacySlots = window.bkSlotsFor;
      window.bkSlotsFor = (iso) => (iso === D.openSun ? WEEKEND.slice() : legacySlots(iso));
      const opened = pick(D.openSun);
      eq(opened.result, { ok: true });
      assert.equal(opened.msg, '');
      // And a closed Saturday is refused by the same availability rule.
      window.bkSlotsFor = (iso) => (iso === D.closedSat ? [] : legacySlots(iso));
      eq(pick(D.closedSat).result, { ok: false, message: 'Unavailable — please choose another date.' });
    });
  }

  test('inline fallback (index.html): alternate Sunday follows bkSlotsFor', () => {
    const { window, pick } = mountInline('index.html');
    const legacySlots = window.bkSlotsFor;
    assert.equal(pick(D.weekday, { altDate: D.openSun }).result.message, 'Alternate date is unavailable. Please choose another day.');
    window.bkSlotsFor = (iso) => (iso === D.openSun ? WEEKEND.slice() : legacySlots(iso));
    eq(pick(D.weekday, { altDate: D.openSun }).result, { ok: true });
  });
}

// ─── Full stack in the DOM: server → client → inline helpers → UX asset ───

const SLOT_TO_WINDOW = {
  '8:00 AM': '08:00-11:00',
  '10:00 AM': '10:00-13:00',
  '12:00 PM': '12:00-15:00',
  '2:00 PM': '14:00-17:00',
  '4:00 PM': '16:00-19:00',
};

function extractBs4(html) {
  const a = html.indexOf('id="bs4"');
  const b = html.indexOf('id="bs5"', a);
  return a >= 0 ? html.slice(a, b > a ? b : a + 8000) : '';
}

async function mountStack(cfg, opts = {}) {
  const page = read(opts.page || 'index.html');
  const form = extractBs4(page);
  const inline = inlineScheduleBlock(page);
  const clientSrc = read('assets/booking-availability-client.js');
  const uxSrc = read('assets/booking-conversion-ux.js');
  const calls = [];
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><div ${form}</div><div id="f-schedule-msg"></div>
     <script>${inline}</script>
     <script>${clientSrc}</script>
     <script>${uxSrc}</script></body></html>`,
    {
      runScripts: 'dangerously',
      url: 'https://example.com/',
      pretendToBeVisual: true,
      beforeParse(window) {
        window.alert = () => {};
        window.innerWidth = 1440;
        window.fetch = async (url) => {
          const u = new URL(url, 'https://example.com/');
          const action = u.searchParams.get('action') || 'snapshot';
          calls.push(action);
          const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
          if (action === 'snapshot') {
            if (opts.outage && opts.outage.on) return json({ ok: false, error: 'availability_unavailable' }, 503);
            if (opts.snapshotStatus) return json({ ok: false }, opts.snapshotStatus);
            return json(projectPublicAvailability(cfg, { now: NOW }));
          }
          if (action === 'selection') return json(opts.selection ? opts.selection(u.searchParams) : { ok: false });
          if (action === 'nearby') {
            const openings = findNearbyOpenings(u.searchParams.get('fromDate'), cfg, {
              now: NOW, limit: Number(u.searchParams.get('limit')) || 6, occupancy: opts.occupancy || {},
            }).map((o) => ({ ...o, preferredArrivalWindow: SLOT_TO_WINDOW[o.preferredTime] }));
            return json({ ok: true, openings });
          }
          return json({ ok: false }, 400);
        };
      },
    },
  );
  const { window } = dom;
  const doc = window.document;
  await window.BkConversion.init();
  if (opts.ceramicMinutes) {
    window.CD1CeramicBooking = { appointmentMinutes: () => opts.ceramicMinutes };
  }
  const change = (el) => el.dispatchEvent(new window.Event('change', { bubbles: true }));
  function choose(date, win) {
    const dateEl = doc.getElementById('f-date');
    dateEl.value = date;
    change(dateEl);
    window.bkRefreshTimeSlots();
    const anytime = doc.getElementById('f-arrival-mode-anytime');
    const specific = doc.getElementById('f-arrival-mode-specific');
    if (win === 'anytime') {
      anytime.checked = true;
      change(anytime);
    } else {
      specific.checked = true;
      change(specific);
      const sel = doc.getElementById('f-arrival-window-select');
      sel.value = win;
      change(sel);
      if (sel.value !== win) doc.getElementById('f-arrival-window').value = win;
    }
    return window.bkValidateScheduleSelection();
  }
  function setAlternate(date, win) {
    const check = doc.getElementById('f-has-alternate');
    check.checked = true;
    change(check);
    const altDate = doc.getElementById('f-alt-date');
    altDate.value = date;
    change(altDate);
    const anytime = doc.getElementById('f-alt-arrival-mode-anytime');
    anytime.checked = true;
    change(anytime);
    if (win !== 'anytime') doc.getElementById('f-alt-arrival-window').value = win;
  }
  return { window, doc, choose, setAlternate, calls, scheduleMsg: () => doc.getElementById('f-schedule-msg').textContent };
}

if (JSDOM) {
  test('stack: opened Sunday advances with "Any time" and with each operational window', async () => {
    const s = await mountStack(config());
    assert.equal(s.window.BkAvailability.loaded, true);
    eq(s.window.bkSlotsFor(D.openSun), WEEKEND);
    eq(s.choose(D.openSun, 'anytime'), { ok: true });
    assert.equal(s.doc.getElementById('f-time').value, '8:00 AM');
    eq(s.choose(D.openSun, '08:00-11:00'), { ok: true });
    eq(s.choose(D.openSun, '09:00-12:00'), { ok: true });
    assert.equal(s.doc.getElementById('f-time').value, '10:00 AM');
    eq(s.choose(D.openSun, '10:00-13:00'), { ok: true });
    const late = s.choose(D.openSun, '12:00-15:00');
    assert.equal(late.ok, false);
    assert.doesNotMatch(late.message, /choose another date/, 'window miss is not a closed date');
  });

  test('stack: weekend matrix under active supervised mode', async () => {
    const s = await mountStack(config());
    const closed = { ok: false, message: 'Unavailable — please choose another date.' };
    eq(s.choose(D.openSat, 'anytime'), { ok: true });
    eq(s.choose(D.weekday, '14:00-17:00'), { ok: true });
    for (const d of [D.closedSun, D.closedSat, D.plainSun, D.plainSat]) {
      eq(s.choose(d, 'anytime'), closed, d);
      assert.equal(s.doc.getElementById('f-time').value, '', d);
    }
    s.window.bkRefreshTimeSlots();
    assert.equal(s.scheduleMsg(), 'Unavailable — please choose another date.');
    assert.match(s.choose(D.holiday, 'anytime').message, /Closed for the holiday/);
    assert.match(s.choose(D.past, 'anytime').message, /today or a later open day/);
  });

  test('stack: legacy mode keeps plain Saturdays open and plain Sundays closed', async () => {
    const s = await mountStack(legacyConfig());
    assert.equal(s.window.BkAvailability.mode(), 'legacy');
    eq(s.choose(D.openSun, 'anytime'), { ok: true });
    eq(s.choose(D.plainSat, '08:00-11:00'), { ok: true });
    assert.equal(s.choose(D.plainSun, 'anytime').ok, false);
    // Disabled overrides are not published in the public snapshot, so the
    // browser cannot pre-reject a closed Saturday in legacy mode; the server
    // (selection/validate/submit) is the authority that refuses it.
    assert.equal(
      validateBookingSchedule(D.closedSat, '8:00 AM', { config: legacyConfig(), now: NOW }).error,
      'booking_date_unavailable',
    );
  });

  test('stack: alternate date follows operational availability', async () => {
    const s = await mountStack(config());
    s.choose(D.weekday, 'anytime');
    s.setAlternate(D.openSun, 'anytime');
    eq(s.window.bkValidateScheduleSelection(), { ok: true });
    s.setAlternate(D.plainSun, 'anytime');
    assert.equal(s.window.bkValidateScheduleSelection().message, 'Alternate date is unavailable. Please choose another day.');
    s.setAlternate(D.closedSat, 'anytime');
    assert.equal(s.window.bkValidateScheduleSelection().message, 'Alternate date is unavailable. Please choose another day.');
    // Opened Sunday as primary with a weekday alternate.
    s.choose(D.openSun, 'anytime');
    s.setAlternate(D.weekday, 'anytime');
    eq(s.window.bkValidateScheduleSelection(), { ok: true });
  });

  test('stack: invalid arrival window is rejected on an opened Sunday', async () => {
    const s = await mountStack(config());
    s.choose(D.openSun, '08:00-11:00');
    s.doc.getElementById('f-arrival-window').value = '07:00-10:00';
    assert.equal(s.window.bkValidateScheduleSelection().message, 'Please select a valid arrival window.');
  });

  test('stack: ceramic coating duration still gates late weekend windows', async () => {
    const s = await mountStack(config(), { ceramicMinutes: 720 });
    eq(s.choose(D.openSun, '08:00-11:00'), { ok: true });
    const late = s.choose(D.openSun, '10:00-13:00');
    assert.equal(late.ok, false);
    assert.match(late.message, /too late for this Ceramic Coating appointment/);
  });

  test('stack: a window reported taken by the server blocks progression', async () => {
    const s = await mountStack(config(), {
      selection: () => ({ ok: true, available: false, error: 'booking_slot_unavailable' }),
    });
    s.choose(D.openSun, '08:00-11:00');
    await new Promise((r) => setTimeout(r, 20));
    const r = s.window.bkValidateScheduleSelection();
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.message, /choose another date/);
  });

  test('stack: nearby recovery can land on an opened Sunday and continue', async () => {
    const s = await mountStack(config(), { occupancy: { [`${D.openSat}|8:00 AM`]: 1, [`${D.openSat}|10:00 AM`]: 1 } });
    s.choose(D.openSat, 'anytime');
    s.doc.getElementById('bk-slot-recovery').classList.add('open');
    s.doc.querySelector('#bk-slot-recovery button[data-act="nearby"]').dispatchEvent(new s.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    const first = s.doc.querySelector('#bk-nearby-list button[data-date]');
    assert.ok(first, 'nearby opening rendered');
    assert.equal(first.getAttribute('data-date'), D.openSun);
    first.dispatchEvent(new s.window.Event('click', { bubbles: true }));
    assert.equal(s.doc.getElementById('f-date').value, D.openSun);
    eq(s.window.bkValidateScheduleSelection(), { ok: true });
  });

  test('stack: snapshot failure fails closed — no date is offered, recovery is shown', async () => {
    // Availability V2 Phase 1: an unreadable schedule never becomes the legacy
    // calendar (that used to reopen Saturdays the owner had closed).
    const s = await mountStack(config(), { snapshotStatus: 502 });
    assert.equal(s.window.BkAvailability.loaded, false);
    assert.equal(s.window.BkAvailability.status, 'unavailable');
    for (const d of [D.openSun, D.plainSat, D.weekday]) {
      const r = s.choose(d, 'anytime');
      assert.equal(r.ok, false, d);
      assert.match(r.message, /Live scheduling is temporarily unavailable/);
    }
    assert.ok(s.doc.getElementById('bk-availability-status'), 'recovery panel rendered');
    assert.ok(s.doc.getElementById('bk-availability-retry'), 'retry button rendered');
  });
}

// ─── Availability V2 Phase 1: client consistency on all 13 booking pages ──

if (JSDOM) {
  const v2Config = () => config({
    weekendMode: 'legacy',
    supervisedEffectiveDate: null,
    dateOverrides: {
      [D.closedSat]: { enabled: false, capacity: 1 },
      '2026-12-24': { enabled: true, holidayOpening: true, capacity: 1, arrivalWindows: ['8:00 AM', '10:00 AM'] },
      [D.holiday]: { enabled: true, capacity: 1, arrivalWindows: WEEKEND },
    },
  });

  for (const page of BOOKING_PAGES) {
    test(`v2 ${page}: known closed dates are never offered; an authorized holiday opening is`, async () => {
      const s = await mountStack(v2Config(), { page });
      assert.equal(s.window.BkAvailability.status, 'available');
      // Explicit closure: rejected by the browser before any server round-trip.
      eq(s.window.bkSlotsFor(D.closedSat), []);
      assert.equal(s.choose(D.closedSat, 'anytime').ok, false);
      // Plain Saturday in legacy mode stays open.
      eq(s.choose(D.plainSat, 'anytime'), { ok: true });
      // Authorized holiday opening beats the page's static holiday list.
      eq(s.window.bkSlotsFor('2026-12-24'), ['8:00 AM', '10:00 AM']);
      eq(s.choose('2026-12-24', 'anytime'), { ok: true });
      // A plain override on Christmas does not open it.
      const xmas = s.choose(D.holiday, 'anytime');
      assert.equal(xmas.ok, false);
      // Alternate date follows the same rules.
      s.choose(D.weekday, 'anytime');
      s.setAlternate(D.closedSat, 'anytime');
      assert.equal(s.window.bkValidateScheduleSelection().ok, false);
      s.setAlternate('2026-12-24', 'anytime');
      eq(s.window.bkValidateScheduleSelection(), { ok: true });
    });
  }

  test('v2 stack: an unreadable schedule blocks every date until "Try again" succeeds', async () => {
    const outage = { on: true };
    const s = await mountStack(v2Config(), { outage });
    assert.equal(s.window.BkAvailability.status, 'unavailable');
    const blocked = s.choose(D.weekday, 'anytime');
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /Live scheduling is temporarily unavailable/);
    const panel = s.doc.getElementById('bk-availability-status');
    assert.ok(panel);
    assert.match(panel.textContent, /Live scheduling is temporarily unavailable/);
    assert.match(panel.textContent, /\(551\) 389-3986/);
    outage.on = false;
    s.doc.getElementById('bk-availability-retry').dispatchEvent(new s.window.Event('click', { bubbles: true }));
    for (let i = 0; i < 50 && s.window.BkAvailability.status !== 'available'; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(s.window.BkAvailability.status, 'available');
    assert.equal(s.doc.getElementById('bk-availability-status'), null, 'panel removed after recovery');
    eq(s.choose(D.weekday, 'anytime'), { ok: true });
  });

  test('v2 stack: a server selection reporting unavailable schedule blocks progression', async () => {
    const s = await mountStack(v2Config(), {
      selection: () => ({ ok: false, error: 'availability_unavailable', userMessage: 'Live scheduling is temporarily unavailable.' }),
    });
    s.choose(D.weekday, 'anytime');
    await new Promise((r) => setTimeout(r, 20));
    assert.match(s.scheduleMsg(), /Live scheduling is temporarily unavailable/);
  });
}
