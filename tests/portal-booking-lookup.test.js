/**
 * Customer lookup must find bookings Admin can see (Blob key ≠ payload.id).
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

function createMemoryStore(map = {}) {
  const data = { ...map };
  return {
    async get(key, opts) {
      const v = data[key];
      if (v == null) return null;
      return opts && opts.type === 'json' ? v : v;
    },
    async getWithMetadata(key, opts) {
      const v = await this.get(key, opts);
      if (v == null) return null;
      return { data: v, etag: 't' };
    },
    async setJSON(key, value) {
      data[key] = value;
      return { modified: true };
    },
    async list() {
      return { blobs: Object.keys(data).map((key) => ({ key })) };
    },
  };
}

describe('portal booking lookup vs admin list', () => {
  let setOpsStoreOverride;

  beforeEach(() => {
    ({ setOpsStoreOverride } = require('../netlify/lib/ops-db'));
  });

  afterEach(() => {
    setOpsStoreOverride(null);
  });

  it('getBooking finds record when Blob key differs from payload.id', async () => {
    const store = createMemoryStore({
      // Legacy / mismatched key — Admin list shows payload.id CD1-REAL
      'legacy-key-123': {
        id: 'CD1-REAL',
        bookingId: 'CD1-REAL',
        isDraft: false,
        status: 'Pending Review',
        jobStatus: 'pending_review',
        bookingVersion: 1,
        phone: '5513132956',
        firstName: 'Ada',
      },
    });
    setOpsStoreOverride(store);
    const { getBooking } = require('../netlify/lib/ops-db');
    const found = await getBooking('CD1-REAL');
    assert.ok(found);
    assert.equal(found.id, 'CD1-REAL');
    assert.equal(found.phone, '5513132956');
  });

  it('authorizeBookingAccess opens mismatched-key booking with matching phone', async () => {
    const store = createMemoryStore({
      'odd-key': {
        id: 'CD1-ODD',
        isDraft: false,
        status: 'Pending Review',
        jobStatus: 'pending_review',
        bookingVersion: 1,
        phone: '(551) 313-2956',
      },
    });
    setOpsStoreOverride(store);
    delete require.cache[require.resolve('../netlify/lib/booking-customer-auth')];
    delete require.cache[require.resolve('../netlify/lib/ops-db')];
    const { setOpsStoreOverride: setAgain } = require('../netlify/lib/ops-db');
    setAgain(store);
    const { authorizeBookingAccess } = require('../netlify/lib/booking-customer-auth');
    const auth = await authorizeBookingAccess(
      { headers: {} },
      { bookingId: 'CD1-ODD', phone: '5513132956' }
    );
    assert.equal(auth.ok, true);
    assert.equal(auth.booking.id, 'CD1-ODD');
  });

  it('phonesMatchForPortal accepts last-10 when formatting differs', () => {
    const { phonesMatchForPortal } = require('../netlify/lib/phone-auth');
    assert.equal(phonesMatchForPortal('5513132956', '+1 (551) 313-2956'), true);
    assert.equal(phonesMatchForPortal('15513132956', '5513132956'), true);
    assert.equal(phonesMatchForPortal('5513132956', '2015550100'), false);
  });
});
