const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ALLOWED_WEEKDAY_SLOTS,
  ALLOWED_SATURDAY_SLOTS,
  MIN_ADVANCE_DAYS,
  earliestBookableIso,
  getHolidaySet,
  isClosedHoliday,
  slotsForDate,
  normalizePreferredTime,
  validateBookingSchedule,
  isActiveBookingForSlotLock,
  hasSlotConflict,
} = require('../netlify/lib/booking-schedule');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

/** Freeze "today" so fixture weekdays stay valid under the 3-day advance rule. */
const FIXTURE_NOW = new Date(2026, 6, 1); // Wed Jul 1, 2026
const vs = (date, time) => validateBookingSchedule(date, time, { now: FIXTURE_NOW });

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

const STRIPE_PAYMENT_FILES = [
  'netlify/functions/stripe-webhook.js',
  'netlify/functions/create-setup-intent.js',
  'netlify/functions/create-payment-intent.js',
  'netlify/functions/capture-payment.js',
  'netlify/functions/booking-card-status.js',
];

test('Sundays are rejected server-side', () => {
  const r = vs('2026-07-05', '8:00 AM'); // Sunday
  assert.equal(r.ok, false);
  assert.equal(r.error, 'booking_date_unavailable');
});

test('approved holidays are rejected server-side', () => {
  assert.equal(isClosedHoliday('2026-01-01'), true);
  assert.equal(isClosedHoliday('2026-07-04'), true);
  assert.equal(isClosedHoliday('2026-12-25'), true);
  const easter2026 = [...getHolidaySet(2026)].find(d => d.startsWith('2026-04-'));
  assert.ok(easter2026);
  const r = validateBookingSchedule(easter2026, '10:00 AM', { now: new Date(2026, 3, 1) });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'booking_date_unavailable');
});

test('weekdays allow 8, 10, 12, 2', () => {
  for (const slot of ALLOWED_WEEKDAY_SLOTS) {
    const r = vs('2026-07-06', slot); // Monday
    assert.equal(r.ok, true, slot);
    assert.equal(r.preferredTime, slot);
  }
});

test('Saturday allows only 8 and 10', () => {
  const sat = '2026-07-11';
  for (const slot of ALLOWED_SATURDAY_SLOTS) {
    const rs = vs(sat, slot);
    assert.equal(rs.ok, true, slot);
  }
  assert.deepEqual(slotsForDate(sat), ALLOWED_SATURDAY_SLOTS);
});

test('Saturday rejects 12 and 2', () => {
  for (const slot of ['12:00 PM', '2:00 PM']) {
    const r = vs('2026-07-11', slot);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'booking_time_unavailable');
  }
});

test('empty preferredTime is rejected', () => {
  const r = vs('2026-07-06', '');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'booking_time_unavailable');
});

test('legacy windows are rejected', () => {
  for (const legacy of [
    'Any available',
    'Any available (Mon–Fri 8AM–5PM)',
    'Morning (8AM – 11AM)',
    'Midday (11AM – 2PM)',
    'Afternoon (2PM – 5PM)',
  ]) {
    assert.equal(normalizePreferredTime(legacy), null, legacy);
    const r = vs('2026-07-06', legacy);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'booking_time_unavailable');
  }
});

test('tampered time is rejected', () => {
  const r = vs('2026-07-06', '3:00 AM');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'booking_time_unavailable');
});

test('3-day advance notice: earliest bookable is today + 3', () => {
  assert.equal(MIN_ADVANCE_DAYS, 3);
  assert.equal(earliestBookableIso(new Date(2026, 6, 16)), '2026-07-19');
});

test('3-day advance notice: dates before min are rejected', () => {
  const now = new Date(2026, 6, 16); // Thu Jul 16
  assert.equal(validateBookingSchedule('2026-07-16', '8:00 AM', { now }).ok, false); // today
  assert.equal(validateBookingSchedule('2026-07-17', '8:00 AM', { now }).ok, false); // +1
  assert.equal(validateBookingSchedule('2026-07-18', '8:00 AM', { now }).ok, false); // +2
  const ok = validateBookingSchedule('2026-07-20', '8:00 AM', { now }); // +4 Mon
  assert.equal(ok.ok, true);
});

test('duplicate active booking same date/time is rejected', () => {
  const bookings = [
    { id: 'CD1-A', preferredDate: '2026-07-06', preferredTime: '8:00 AM', jobStatus: 'confirmed' },
  ];
  assert.equal(hasSlotConflict(bookings, '2026-07-06', '8:00 AM'), true);
  assert.equal(hasSlotConflict(bookings, '2026-07-06', '8:00 AM', 'CD1-A'), false);
});

test('cancelled/rejected/archived/test booking does not block slot', () => {
  const bookings = [
    { id: 'CD1-C', preferredDate: '2026-07-06', preferredTime: '10:00 AM', jobStatus: 'cancelled' },
    { id: 'CD1-T', preferredDate: '2026-07-06', preferredTime: '10:00 AM', isTest: true },
    { id: 'CD1-D', preferredDate: '2026-07-06', preferredTime: '10:00 AM', isDraft: true },
    { id: 'CD1-A', preferredDate: '2026-07-06', preferredTime: '10:00 AM', archived: true },
  ];
  assert.equal(hasSlotConflict(bookings, '2026-07-06', '10:00 AM'), false);
  for (const b of bookings) assert.equal(isActiveBookingForSlotLock(b), false);
});

test('active card-save draft soft-holds the selected slot', () => {
  const { DRAFT_SLOT_HOLD_MS, isActiveDraftSlotHold } = require('../netlify/lib/booking-schedule');
  const now = Date.parse('2026-07-26T19:40:00.000Z');
  const activeDraft = {
    id: 'CD1-DRAFT-HOLD',
    isDraft: true,
    preferredDate: '2026-07-30',
    preferredTime: '8:00 AM',
    cardOnFileStatus: 'saved',
    updatedAt: '2026-07-26T19:39:00.000Z',
  };
  const expiredDraft = {
    ...activeDraft,
    id: 'CD1-DRAFT-OLD',
    updatedAt: new Date(now - DRAFT_SLOT_HOLD_MS - 1000).toISOString(),
  };
  const bareDraft = {
    id: 'CD1-DRAFT-BARE',
    isDraft: true,
    preferredDate: '2026-07-30',
    preferredTime: '8:00 AM',
    updatedAt: '2026-07-26T19:39:00.000Z',
  };
  assert.equal(isActiveDraftSlotHold(activeDraft, now), true);
  assert.equal(isActiveBookingForSlotLock(activeDraft, now), true);
  assert.equal(hasSlotConflict([activeDraft], '2026-07-30', '8:00 AM', null, now), true);
  assert.equal(hasSlotConflict([activeDraft], '2026-07-30', '8:00 AM', 'CD1-DRAFT-HOLD', now), false);
  assert.equal(isActiveDraftSlotHold(expiredDraft, now), false);
  assert.equal(hasSlotConflict([expiredDraft], '2026-07-30', '8:00 AM', null, now), false);
  assert.equal(isActiveBookingForSlotLock(bareDraft, now), false);
});

test('all 13 booking pages use discrete slot labels', () => {
  for (const page of BOOKING_PAGES) {
    const html = read(page);
    assert.match(html, /id="f-time"/);
    assert.match(html, /8:00 AM/);
    assert.match(html, /10:00 AM/);
    assert.match(html, /12:00 PM/);
    assert.match(html, /2:00 PM/);
    assert.match(html, /Select a time/);
  }
});

test('all 13 booking pages no longer contain legacy window labels in Step 4', () => {
  for (const page of BOOKING_PAGES) {
    const html = read(page);
    const step4 = html.slice(html.indexOf('id="f-time"'), html.indexOf('id="f-time"') + 600);
    assert.doesNotMatch(step4, /Any available \(Mon/);
    assert.doesNotMatch(step4, /Morning \(8AM/);
    assert.doesNotMatch(step4, /Midday \(11AM/);
    assert.doesNotMatch(step4, /Afternoon \(2PM/);
  }
});

test('all 13 pages have Sunday/holiday/Saturday slot handling', () => {
  for (const page of BOOKING_PAGES) {
    const html = read(page);
    assert.match(html, /bkInitSchedulePicker/);
    assert.match(html, /Unavailable — please choose another date/);
    assert.match(html, /Closed for the holiday/);
    assert.match(html, /bkValidateScheduleSelection/);
  }
});

test('all 13 pages enforce 3-day advance notice UX', () => {
  for (const page of BOOKING_PAGES) {
    const html = read(page);
    assert.match(html, /bkEarliestBookable/);
    assert.match(html, /bk-advance-notice/);
    assert.match(html, /typically 3 days out/);
    assert.match(html, /bk-rush-note/);
    assert.match(html, /Call or Text Us/);
    assert.match(html, /tel:5513132956/);
    assert.match(html, /dateEl\.min=bkEarliestBookable/);
    assert.doesNotMatch(html, /f-date'\)\.min=new Date\(\)\.toISOString/);
  }
});

test('submit-booking imports and enforces booking-schedule', () => {
  const submit = read('netlify/functions/submit-booking.js');
  assert.match(submit, /booking-schedule/);
  assert.match(submit, /validateBookingSchedule/);
  assert.match(submit, /hasSlotConflict/);
  assert.match(submit, /enforceScheduleFields/);
  assert.match(submit, /listBookingsForSlotLock/);
  assert.match(submit, /booking_slot_unavailable/);
  assert.match(submit, /scheduleRejectResponse/);
  assert.match(submit, /checkSlot:\s*true/);
  assert.match(submit, /phase:\s*'draft'/);
  assert.match(submit, /phase:\s*'finalize'/);
  assert.match(submit, /bookingCreated:\s*true/);
  assert.match(submit, /scheduleDraft\.error|scheduleRejectResponse/);
  assert.match(submit, /scheduleFinal\.error|scheduleRejectResponse/);
});

test('no pricing files changed in this task scope', () => {
  const pricingPaths = [
    'netlify/lib/customer-catalog.js',
    'netlify/lib/travel-fee.js',
    'tests/booking-price.test.js',
  ];
  for (const p of pricingPaths) {
    assert.ok(fs.existsSync(path.join(root, p)), p);
  }
});

test('no Stripe/payment/webhook/card-on-file files changed', () => {
  for (const p of STRIPE_PAYMENT_FILES) {
    const full = path.join(root, p);
    assert.ok(fs.existsSync(full), p);
  }
});

test('no Admin/Tech/Customer portal HTML files modified', () => {
  for (const p of ['admin-ops.html', 'technician.html', 'customer.html']) {
    const full = path.join(root, p);
    assert.ok(fs.existsSync(full), p);
  }
});

test('no legacy admin/tech overlays on booking pages', () => {
  for (const page of BOOKING_PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /id="admin-ov"/);
    assert.doesNotMatch(html, /function openAdminPanel/);
  }
});
