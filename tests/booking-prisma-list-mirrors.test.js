'use strict';

/**
 * Admin Jobs list path: one Postgres findMany instead of hydrating every blob.
 * Fail-open must never throw, and drafts stay out of the list.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const PRISMA_PATH = require.resolve('../netlify/lib/prisma');
const MIRROR_PATH = require.resolve('../netlify/lib/booking-prisma-mirror');

let fakePrisma = null;
let findManyImpl = async () => [];
let prevPrisma;
let prevMirror;
let prevUrl;
let prevMirrorFlag;
let prevRead;

function installFakePrisma() {
  require.cache[PRISMA_PATH] = {
    id: PRISMA_PATH,
    filename: PRISMA_PATH,
    loaded: true,
    exports: {
      prismaConfigured: () => !!fakePrisma,
      tryGetPrisma: () => fakePrisma,
      getPrisma: () => fakePrisma,
      _resetPrismaForTests() { fakePrisma = null; },
    },
  };
  delete require.cache[MIRROR_PATH];
}

describe('listBookingMirrors (Admin Jobs list)', () => {
  beforeEach(() => {
    prevUrl = process.env.DATABASE_URL;
    prevMirrorFlag = process.env.PRISMA_BOOKING_MIRROR;
    prevRead = process.env.PRISMA_BOOKING_READ;
    prevPrisma = require.cache[PRISMA_PATH];
    prevMirror = require.cache[MIRROR_PATH];
    process.env.DATABASE_URL = 'postgres://example.invalid:5432/db';
    delete process.env.PRISMA_BOOKING_MIRROR;
    delete process.env.PRISMA_BOOKING_READ;
    fakePrisma = {
      bookingRecord: {
        findMany: (...args) => findManyImpl(...args),
      },
    };
    findManyImpl = async () => [];
    installFakePrisma();
  });

  afterEach(() => {
    if (prevUrl == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevUrl;
    if (prevMirrorFlag == null) delete process.env.PRISMA_BOOKING_MIRROR;
    else process.env.PRISMA_BOOKING_MIRROR = prevMirrorFlag;
    if (prevRead == null) delete process.env.PRISMA_BOOKING_READ;
    else process.env.PRISMA_BOOKING_READ = prevRead;
    if (prevPrisma) require.cache[PRISMA_PATH] = prevPrisma;
    else delete require.cache[PRISMA_PATH];
    if (prevMirror) require.cache[MIRROR_PATH] = prevMirror;
    else delete require.cache[MIRROR_PATH];
  });

  it('returns payloads, skips drafts, and fills missing id from the row key', async () => {
    findManyImpl = async ({ where, orderBy }) => {
      assert.deepEqual(where, { NOT: { kind: 'draft' } });
      assert.deepEqual(orderBy, { updatedAt: 'desc' });
      return [
        { id: 'CD1-A', payload: { id: 'CD1-A', kind: 'booking', firstName: 'Ada' } },
        { id: 'CD1-DRAFT', payload: { id: 'CD1-DRAFT', kind: 'draft', isDraft: true } },
        { id: 'CD1-EMPTY', payload: null },
        { id: 'CD1-B', payload: { kind: 'booking', firstName: 'Grace' } },
      ];
    };
    const { listBookingMirrors } = require('../netlify/lib/booking-prisma-mirror');
    const rows = await listBookingMirrors();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, 'CD1-A');
    assert.equal(rows[1].id, 'CD1-B');
    assert.equal(rows[1].firstName, 'Grace');
  });

  it('fails open to [] when findMany throws', async () => {
    findManyImpl = async () => {
      throw new Error('postgres_down');
    };
    const { listBookingMirrors } = require('../netlify/lib/booking-prisma-mirror');
    assert.deepEqual(await listBookingMirrors(), []);
  });

  it('fails open to [] when Prisma client is missing', async () => {
    fakePrisma = null;
    const { listBookingMirrors } = require('../netlify/lib/booking-prisma-mirror');
    assert.deepEqual(await listBookingMirrors(), []);
  });
});
