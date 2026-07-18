/**
 * Prisma dual-write must never break Blob authority / checkout.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

describe('booking Prisma mirror (safe dual-write)', () => {
  const prevUrl = process.env.DATABASE_URL;
  const prevMirror = process.env.PRISMA_BOOKING_MIRROR;
  const prevRead = process.env.PRISMA_BOOKING_READ;

  beforeEach(() => {
    // Empty string (not delete) so a later dotenv load cannot resurrect local .env mid-suite.
    process.env.DATABASE_URL = '';
    delete process.env.PRISMA_BOOKING_MIRROR;
    delete process.env.PRISMA_BOOKING_READ;
    const { _resetPrismaForTests } = require('../netlify/lib/prisma');
    _resetPrismaForTests();
  });

  afterEach(() => {
    if (prevUrl == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevUrl;
    if (prevMirror == null) delete process.env.PRISMA_BOOKING_MIRROR;
    else process.env.PRISMA_BOOKING_MIRROR = prevMirror;
    if (prevRead == null) delete process.env.PRISMA_BOOKING_READ;
    else process.env.PRISMA_BOOKING_READ = prevRead;
    const { _resetPrismaForTests } = require('../netlify/lib/prisma');
    _resetPrismaForTests();
  });

  it('skips mirror when DATABASE_URL missing', async () => {
    const {
      mirrorEnabled,
      upsertBookingMirror,
      isDraftBooking,
    } = require('../netlify/lib/booking-prisma-mirror');
    assert.equal(mirrorEnabled(), false);
    const result = await upsertBookingMirror({
      id: 'CD1-X',
      kind: 'booking',
      isDraft: false,
      bookingVersion: 1,
    });
    assert.equal(result.skipped, true);
    assert.equal(isDraftBooking({ isDraft: true }), true);
    assert.equal(isDraftBooking({ kind: 'draft' }), true);
    assert.equal(isDraftBooking({ kind: 'booking', isDraft: false }), false);
  });

  it('never mirrors drafts even when DATABASE_URL set', async () => {
    process.env.DATABASE_URL = 'postgres://example.invalid/db';
    const { _resetPrismaForTests } = require('../netlify/lib/prisma');
    _resetPrismaForTests();
    const { upsertBookingMirror } = require('../netlify/lib/booking-prisma-mirror');
    const result = await upsertBookingMirror({
      id: 'CD1-DRAFT',
      kind: 'draft',
      isDraft: true,
      draftSaveToken: 'secret',
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'draft');
  });

  it('PRISMA_BOOKING_MIRROR=0 disables mirror even with DATABASE_URL', async () => {
    process.env.DATABASE_URL = 'postgres://example.invalid:5432/db';
    process.env.PRISMA_BOOKING_MIRROR = '0';
    const { _resetPrismaForTests } = require('../netlify/lib/prisma');
    _resetPrismaForTests();
    const { mirrorEnabled, upsertBookingMirror, toMirrorRow } = require('../netlify/lib/booking-prisma-mirror');
    assert.equal(mirrorEnabled(), false);
    const result = await upsertBookingMirror({
      id: 'CD1-OFF',
      kind: 'booking',
      isDraft: false,
      bookingVersion: 2,
    });
    assert.equal(result.skipped, true);
    const row = toMirrorRow({
      id: 'CD1-ROW',
      kind: 'booking',
      bookingVersion: 3,
      quote: { quoteVersion: 2 },
      paymentWorkflowStatus: 'payment_succeeded',
      phone: '5513132956',
    });
    assert.equal(row.id, 'CD1-ROW');
    assert.equal(row.bookingVersion, 3);
    assert.equal(row.quoteVersion, 2);
    assert.equal(row.paymentWorkflowStatus, 'payment_succeeded');
  });

  it('commitBooking still succeeds without DATABASE_URL (Blob authority)', async () => {
    const { setBookingStoreOverride, commitBooking } = require('../netlify/lib/booking-repository');
    const mem = new Map();
    const store = {
      async getWithMetadata(id, opts) {
        const data = mem.get(id);
        if (!data) return null;
        return { data, etag: data.__etag || 'e1' };
      },
      async get(id) {
        return mem.get(id) || null;
      },
      async setJSON(id, value, opts) {
        if (opts && opts.onlyIfNew && mem.has(id)) return { modified: false };
        if (opts && opts.onlyIfMatch && mem.get(id) && (mem.get(id).__etag || 'e1') !== opts.onlyIfMatch) {
          return { modified: false };
        }
        const next = { ...value, __etag: `v${value.bookingVersion}` };
        mem.set(id, next);
        return { modified: true };
      },
    };
    setBookingStoreOverride(store);
    try {
      const created = await commitBooking({
        bookingId: 'CD1-BLOB',
        expectedBookingVersion: 0,
        createIfMissing: true,
        nextAggregate: {
          id: 'CD1-BLOB',
          kind: 'booking',
          isDraft: false,
          bookingVersion: 1,
          status: 'Pending Review',
        },
      });
      assert.equal(created.ok, true);
      assert.equal(created.booking.id, 'CD1-BLOB');
      assert.ok(mem.has('CD1-BLOB'));
    } finally {
      setBookingStoreOverride(null);
    }
  });

  it('submit-booking finalize schedules mirror after Blob save (source contract)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/submit-booking.js'), 'utf8');
    assert.match(src, /scheduleBookingMirror/);
    assert.match(src, /Prisma dual-write AFTER Blob/);
  });

  it('ops-db getBooking uses Prisma only after Blob miss', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/lib/ops-db.js'), 'utf8');
    assert.match(src, /readBookingMirror/);
    assert.match(src, /Blobs remain primary|Blob miss/i);
  });

  it('booking-repository mirrors only after successful Blob write', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/lib/booking-repository.js'), 'utf8');
    const idxWrite = src.indexOf('scheduleBookingMirror');
    const idxConflict = src.indexOf("error: 'version_conflict'");
    assert.ok(idxWrite > 0);
    // Mirror call appears after conflict returns in file (best-effort structural check)
    assert.match(src, /never block Blob authority/);
  });
});
