'use strict';

/**
 * Production sequence this guards against: finalize wrote the booking, then the
 * function died before responding. The customer saw a failure for an
 * appointment that exists, booked again, and the slot lock did not stop them —
 * it fails open, so an errored or timed-out store scan reads as "every slot
 * free". Two identical appointments reached Admin.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PRISMA_PATH = require.resolve('../netlify/lib/prisma');
let fakePrisma = null;

require.cache[PRISMA_PATH] = {
  id: PRISMA_PATH,
  filename: PRISMA_PATH,
  loaded: true,
  exports: {
    prismaConfigured: () => !!fakePrisma,
    tryGetPrisma: () => fakePrisma,
    getPrisma: () => fakePrisma,
  },
};

const { findDuplicateBooking } = require('../netlify/lib/booking-history');
const { setOpsStoreOverride } = require('../netlify/lib/ops-db');

const DATE = '2026-09-15';
const TIME = '10:00 AM';
const PHONE = '(201) 555-0147';

const EXISTING = {
  id: 'CD1-FIRST',
  phone: PHONE,
  email: 'customer@example.com',
  status: 'Pending Review',
  finalizedAt: '2026-08-10T18:00:00.000Z',
  preferredDate: DATE,
  preferredTime: TIME,
};

function mirrorReturning(rows) {
  return { $queryRaw: () => Promise.resolve(rows.map((payload) => ({ payload }))) };
}

beforeEach(() => {
  fakePrisma = null;
  delete process.env.OFFER_HISTORY_FAST_LOOKUP;
  delete process.env.PRISMA_BOOKING_READ;
  process.env.DATABASE_URL = 'postgres://stub/stub';
  setOpsStoreOverride(null);
});

afterEach(() => {
  setOpsStoreOverride(null);
  delete process.env.DATABASE_URL;
});

describe('findDuplicateBooking', () => {
  it('finds the appointment the customer already holds for that slot', async () => {
    fakePrisma = mirrorReturning([EXISTING]);
    const dupe = await findDuplicateBooking({
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'CD1-SECOND',
    });
    assert.equal(dupe && dupe.id, 'CD1-FIRST');
  });

  it('matches on normalized phone, not on formatting', async () => {
    fakePrisma = mirrorReturning([EXISTING]);
    const dupe = await findDuplicateBooking({
      phone: '+1 201 555 0147', preferredDate: DATE, preferredTime: TIME, excludeId: 'CD1-SECOND',
    });
    assert.equal(dupe && dupe.id, 'CD1-FIRST');
  });

  it('never reports the draft being finalized as its own duplicate', async () => {
    fakePrisma = mirrorReturning([EXISTING]);
    const dupe = await findDuplicateBooking({
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'CD1-FIRST',
    });
    assert.equal(dupe, null);
  });

  it('leaves a different day or a different slot alone', async () => {
    fakePrisma = mirrorReturning([EXISTING]);
    assert.equal(await findDuplicateBooking({
      phone: PHONE, preferredDate: '2026-09-16', preferredTime: TIME, excludeId: 'X',
    }), null);
    assert.equal(await findDuplicateBooking({
      phone: PHONE, preferredDate: DATE, preferredTime: '8:00 AM', excludeId: 'X',
    }), null);
  });

  it('ignores a cancelled appointment — that slot is genuinely free again', async () => {
    fakePrisma = mirrorReturning([{ ...EXISTING, status: 'Cancelled' }]);
    const dupe = await findDuplicateBooking({
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'X',
    });
    assert.equal(dupe, null);
  });

  it('honours the confirmed slot when Admin moved the appointment', async () => {
    fakePrisma = mirrorReturning([{
      ...EXISTING, preferredDate: '2026-09-01', preferredTime: '8:00 AM',
      confirmedDate: DATE, confirmedTime: TIME,
    }]);
    const dupe = await findDuplicateBooking({
      phone: PHONE, preferredDate: DATE, preferredTime: TIME, excludeId: 'X',
    });
    assert.equal(dupe && dupe.id, 'CD1-FIRST');
  });

  it('answers null rather than guessing when it cannot identify the customer', async () => {
    fakePrisma = mirrorReturning([EXISTING]);
    assert.equal(await findDuplicateBooking({
      preferredDate: DATE, preferredTime: TIME,
    }), null);
  });

  it('answers null for an unusable date or time', async () => {
    fakePrisma = mirrorReturning([EXISTING]);
    assert.equal(await findDuplicateBooking({ phone: PHONE, preferredDate: '', preferredTime: TIME }), null);
    assert.equal(await findDuplicateBooking({ phone: PHONE, preferredDate: DATE, preferredTime: '25:00' }), null);
  });
});

describe('finalize wiring', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'netlify', 'functions', 'submit-booking.js'),
    'utf8'
  );

  it('checks for the duplicate before writing the booking', () => {
    const check = src.indexOf('findDuplicateBooking(');
    const write = src.indexOf('await store.setJSON(rawDraftId, b)');
    assert.ok(check > -1 && write > check, 'the guard must run before the write');
  });

  it('answers with the existing booking instead of an error', () => {
    const block = src.slice(src.indexOf('if (duplicate) {'), src.indexOf('let stored = { saved: false }'));
    assert.match(block, /ok: true/);
    assert.match(block, /duplicateSuppressed: true/);
    assert.match(block, /id: duplicate\.id/);
    assert.doesNotMatch(block, /statusCode: 4\d\d/);
  });

  it('cannot block a booking when the lookup itself fails', () => {
    const block = src.slice(src.indexOf('const duplicate = await findDuplicateBooking'), src.indexOf('if (duplicate) {'));
    assert.match(block, /\.catch\(\(\) => null\)/, 'a lookup failure must not reject the booking');
  });

  it('logs a ref, never the booking id', () => {
    const block = src.slice(src.indexOf('duplicate suppressed'), src.indexOf('let stored = { saved: false }'));
    assert.match(block, /bookingRef/);
    assert.doesNotMatch(block, /id: duplicate\.id,\s*\n\s*preferredDate/);
  });
});
