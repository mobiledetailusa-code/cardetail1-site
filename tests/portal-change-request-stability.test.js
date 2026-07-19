/**
 * Portal change-request stability: proposal-only submit, idempotent approve, no hub kick-out.
 */
require('dotenv/config');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prismaConfigured } = require('../netlify/lib/prisma');
const dbConfigured = prismaConfigured();

const ROOT = path.join(__dirname, '..');

function createMemoryStore(seed = {}) {
  const data = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const etags = new Map();
  for (const [k] of data) etags.set(k, `etag-${k}-0`);
  return {
    async get(key) {
      if (!data.has(key)) return null;
      return JSON.parse(JSON.stringify(data.get(key)));
    },
    async getWithMetadata(key) {
      if (!data.has(key)) return null;
      return {
        data: JSON.parse(JSON.stringify(data.get(key))),
        etag: etags.get(key) || null,
      };
    },
    async setJSON(key, value, opts = {}) {
      if (opts.onlyIfMatch) {
        const current = etags.get(key);
        if (!current || current !== opts.onlyIfMatch) return { modified: false };
      }
      data.set(key, JSON.parse(JSON.stringify(value)));
      etags.set(key, `etag-${key}-${Date.now()}-${Math.random()}`);
      return { modified: true };
    },
    async list() {
      return { blobs: [...data.keys()].map((key) => ({ key })) };
    },
  };
}

describe('portal change request stability', () => {
  let setBookingStoreOverride;

  beforeEach(() => {
    ({ setBookingStoreOverride } = require('../netlify/lib/booking-repository'));
  });

  afterEach(() => {
    setBookingStoreOverride(null);
  });

  it('addon submit is proposal-only; approve after version bump still applies', async () => {
    // Hard requirement: approve path uses Postgres createAdjustment (Stage 1).
    // Must fail (not skip) when DATABASE_URL is absent.
    assert.equal(dbConfigured, true, 'DATABASE_URL/DIRECT_URL required for addon approve financial path');
    const {
      submitChangeRequestCommand,
      decideChangeRequestCommand,
    } = require('../netlify/lib/booking-commands');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');
    const bookingId = `CD1-ADDON-${Date.now().toString(36)}`;

    const store = createMemoryStore({
      [bookingId]: {
        id: bookingId,
        bookingVersion: 3,
        schemaVersion: 1,
        quoteVersion: 1,
        status: 'Confirmed',
        appointmentStatus: 'confirmed',
        jobStatus: 'confirmed',
        zipCode: '07102',
        travelFeeAmount: 0,
        approvedFinalAmount: 315,
        amountPaid: 0,
        ledger: { approvedCents: 31500, settledCents: 0, creditedCents: 0, entries: [] },
        vehicles: [{
          vehicleId: 'veh_1',
          cat: 'cars',
          category: 'cars',
          tierKey: 'suv3',
          packageId: 'full',
          pkgId: 'full',
          addons: [],
          addOnIds: [],
        }],
        changeRequests: [],
      },
    });
    setBookingStoreOverride(store);

    const submitted = await submitChangeRequestCommand({
      bookingId,
      expectedBookingVersion: 3,
      requestType: 'addon_request',
      target: { vehicleId: 'veh_1' },
      delta: { addOnIdsToAdd: ['odor'], addonIds: ['odor'] },
    });
    assert.equal(submitted.ok, true, submitted.error || 'submit failed');
    // Live service must NOT already include the add-on before approve
    const mid = await getBookingRecord(bookingId);
    const midVeh = (mid.booking.service && mid.booking.service.vehicles && mid.booking.service.vehicles[0])
      || (mid.booking.vehicles && mid.booking.vehicles[0])
      || {};
    const midIds = midVeh.addOnIds || (midVeh.addons || []).map((a) => a.id);
    assert.equal((midIds || []).includes('odor'), false);

    // Simulate another write bumping version (admin note / webhook / etc.)
    mid.booking.bookingVersion = Number(mid.booking.bookingVersion) + 1;
    await store.setJSON(bookingId, mid.booking);

    const decided = await decideChangeRequestCommand({
      bookingId,
      requestId: submitted.changeRequest.requestId,
      decision: 'approve',
      acceptRequote: true,
    });
    assert.equal(decided.ok, true, `${decided.error || 'decide failed'} ${decided.reason || ''}`);
    const final = await getBookingRecord(bookingId);
    assert.equal(final.booking.changeRequests.some((r) => r.status === 'applied'), true);
  });

  it('approve idempotent when add-on already on booking (legacy submit-applied path)', async () => {
    // Hard requirement: decide path hits applyAddonFinancialMutation / Postgres.
    // Must fail (not skip) when DATABASE_URL is absent.
    assert.equal(dbConfigured, true, 'DATABASE_URL/DIRECT_URL required for addon approve financial path');
    const { decideChangeRequestCommand } = require('../netlify/lib/booking-commands');
    const { getBookingRecord } = require('../netlify/lib/booking-repository');
    const bookingId = `CD1-LEGACY-${Date.now().toString(36)}`;

    const store = createMemoryStore({
      [bookingId]: {
        id: bookingId,
        bookingVersion: 5,
        quoteVersion: 2,
        status: 'Confirmed',
        appointmentStatus: 'confirmed',
        jobStatus: 'confirmed',
        zipCode: '07102',
        travelFeeAmount: 0,
        ledger: { approvedCents: 34000, settledCents: 0, creditedCents: 0, entries: [] },
        vehicles: [{
          vehicleId: 'veh_1',
          category: 'cars',
          packageId: 'full',
          addOnIds: ['odor'],
          addons: [{ id: 'odor' }],
        }],
        changeRequests: [{
          requestId: 'cr_legacy_1',
          id: 'cr_legacy_1',
          type: 'addon_request',
          requestType: 'addon_request',
          status: 'pending',
          baseBookingVersion: 3,
          embeddedBookingVersion: 4,
          target: { vehicleId: 'veh_1' },
          delta: { addOnIdsToAdd: ['odor'], addonIds: ['odor'] },
          quoteVersion: 2,
          proposedApprovedCents: 34000,
        }],
      },
    });
    setBookingStoreOverride(store);

    const decided = await decideChangeRequestCommand({
      bookingId,
      requestId: 'cr_legacy_1',
      decision: 'approve',
    });
    assert.equal(decided.ok, true, `${decided.error || 'decide failed'} ${decided.reason || ''}`);
    const final = await getBookingRecord(bookingId);
    assert.equal(final.booking.changeRequests[0].status, 'applied');
  });

  it('my-garage soft reload does not hard-logout and package modal is not RV-only by default', () => {
    const js = fs.readFileSync(path.join(ROOT, 'assets/my-garage.js'), 'utf8');
    assert.match(js, /soft && !hardAuth/);
    assert.match(js, /inferCategoryFromPackageId/);
    assert.match(js, /normalizePackageCategory/);
    assert.match(js, /Pause polling while a change modal is open/);
    assert.match(js, /Only stamp length categories/);
  });
});
