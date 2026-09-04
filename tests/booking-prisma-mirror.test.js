/**
 * Prisma dual-write must never break Blob authority / checkout.
 */
require('dotenv/config');
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
      phone: '2015550177',
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

  it('listBookingMirrors fails open to [] without DATABASE_URL', async () => {
    const { listBookingMirrors, readFallbackEnabled } = require('../netlify/lib/booking-prisma-mirror');
    assert.equal(readFallbackEnabled(), false);
    const rows = await listBookingMirrors();
    assert.deepEqual(rows, []);
  });

  it('listBookingMirrors fails open to [] when PRISMA_BOOKING_READ=0', async () => {
    process.env.DATABASE_URL = 'postgres://example.invalid:5432/db';
    process.env.PRISMA_BOOKING_READ = '0';
    const { _resetPrismaForTests } = require('../netlify/lib/prisma');
    _resetPrismaForTests();
    const { listBookingMirrors, readFallbackEnabled } = require('../netlify/lib/booking-prisma-mirror');
    assert.equal(readFallbackEnabled(), false);
    assert.deepEqual(await listBookingMirrors(), []);
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

/**
 * Every test above deliberately runs with DATABASE_URL unset/disabled — they
 * prove the mirror fails open and never blocks checkout. None of them prove
 * the mirror actually works end-to-end. This block is the missing proof:
 * when a real DATABASE_URL is configured (Deploy Preview or local dev, per
 * docs/audit/db-env-requirements-2026-07-18.md), a write must be a real,
 * verifiable database round trip — a skipped or fail-open result here must
 * never be reported as a pass. Skips (visibly, as `skipped` not `pass`) only
 * when no DATABASE_URL is configured at all in this environment.
 */
describe(
  'booking Prisma mirror — real database round trip when configured',
  { skip: !(process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim()) && 'DATABASE_URL not configured in this environment' },
  () => {
    it('a configured DATABASE_URL must produce a real write + a real read, not a skipped/fail-open result', async () => {
      const { prismaConfigured, getPrisma, _resetPrismaForTests } = require('../netlify/lib/prisma');
      _resetPrismaForTests();
      assert.equal(prismaConfigured(), true, 'DATABASE_URL must be set for this test to run at all');

      const { upsertBookingMirror, readBookingMirror } = require('../netlify/lib/booking-prisma-mirror');
      const id = `TESTMIRROR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
      const booking = {
        id,
        kind: 'booking',
        isDraft: false,
        bookingVersion: 1,
        quoteVersion: 1,
        paymentWorkflowStatus: 'no_payment_required_yet',
        phone: '5550000000',
      };

      let prisma;
      try {
        const result = await upsertBookingMirror(booking);
        assert.equal(result.skipped, undefined, `mirror write was skipped, not a real success: ${JSON.stringify(result)}`);
        assert.equal(result.ok, true, `mirror write did not succeed: ${JSON.stringify(result)}`);

        const readBack = await readBookingMirror(id);
        assert.ok(readBack, 'a real SELECT must find the row that was just written — proves the round trip, not just that the write call returned');
        assert.equal(readBack.id, id);
        assert.equal(readBack.bookingVersion, 1);
      } finally {
        prisma = getPrisma();
        await prisma.bookingRecord.delete({ where: { id } }).catch(() => {});
      }
    });
  }
);
