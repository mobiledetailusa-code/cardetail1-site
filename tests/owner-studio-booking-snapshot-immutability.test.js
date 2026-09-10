'use strict';

/**
 * Stage 6 release gate — priced booking history is immutable.
 *
 * `bookingCatalogSnapshot` records which catalog priced a booking. It is the reason
 * publishing a new catalog cannot retroactively change what a customer agreed to
 * pay, so no mutation path may overwrite or drop it.
 *
 * The write side (stamping the snapshot at quote time) needs the published-catalog
 * read path, which does not exist yet — Owner Studio ids are `pkg_*` while the
 * storefront still quotes in legacy keys. These tests cover the half that does not
 * depend on it: once a snapshot exists, it survives everything.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeAggregate, buildNextAggregate } = require('../netlify/lib/booking-aggregate');
const {
  buildBookingCatalogSnapshot,
  resolveBookingCommercial,
} = require('../netlify/lib/owner-studio/booking-snapshot');

function snapshot(over = {}) {
  return buildBookingCatalogSnapshot(Object.assign({
    packageId: 'pkg_full_detail',
    packageName: 'Full Detail',
    publishedCatalogReleaseId: 'rel_abc123',
    basePriceCents: 24000,
    approvedTotalCents: 24000,
    currency: 'usd',
    createdAt: '2026-08-01T00:00:00.000Z',
  }, over));
}

function booking(over = {}) {
  return Object.assign({
    id: 'bk_1',
    kind: 'booking',
    bookingVersion: 3,
    totalPrice: 240,
    ledger: { currency: 'usd', approvedCents: 24000, settledCents: 0, creditedCents: 0, pendingCents: 0, entries: [] },
  }, over);
}

describe('a booking catalog snapshot survives normalization', () => {
  it('is carried through normalizeAggregate unchanged', () => {
    const snap = snapshot();
    const { ok, aggregate } = normalizeAggregate(booking({ bookingCatalogSnapshot: snap }));
    assert.equal(ok, true);
    assert.deepEqual(aggregate.bookingCatalogSnapshot, snap);
  });

  it('is absent, not invented, on a legacy booking', () => {
    const { aggregate } = normalizeAggregate(booking());
    assert.equal('bookingCatalogSnapshot' in aggregate, false);
  });
});

describe('no mutation can rewrite priced history', () => {
  it('survives an unrelated patch', () => {
    const snap = snapshot();
    const next = buildNextAggregate(booking({ bookingCatalogSnapshot: snap }), { totalPrice: 999 });
    assert.deepEqual(next.bookingCatalogSnapshot, snap);
    assert.equal(next.totalPrice, 999, 'the patch itself still applies');
  });

  /**
   * The guard that matters. A mutation path that includes its own snapshot — an
   * admin edit, an add-on change, a replayed webhook — must not be able to restate
   * what the booking was priced at.
   */
  it('ignores a patch that tries to replace the snapshot', () => {
    const original = snapshot();
    const forged = snapshot({ approvedTotalCents: 100, publishedCatalogReleaseId: 'rel_attacker' });
    const next = buildNextAggregate(
      booking({ bookingCatalogSnapshot: original }),
      { bookingCatalogSnapshot: forged },
    );
    assert.deepEqual(next.bookingCatalogSnapshot, original, 'the original snapshot wins');
    assert.equal(next.bookingCatalogSnapshot.approvedTotalCents, 24000);
    assert.equal(next.bookingCatalogSnapshot.publishedCatalogReleaseId, 'rel_abc123');
  });

  it('cannot be dropped by a patch setting it undefined', () => {
    const snap = snapshot();
    const next = buildNextAggregate(
      booking({ bookingCatalogSnapshot: snap }),
      { bookingCatalogSnapshot: undefined },
    );
    assert.deepEqual(next.bookingCatalogSnapshot, snap);
  });

  it('survives a ledger mutation — the case a repricing would take', () => {
    const snap = snapshot();
    const next = buildNextAggregate(booking({ bookingCatalogSnapshot: snap }), {
      ledger: { currency: 'usd', approvedCents: 30000, settledCents: 0, creditedCents: 0, pendingCents: 0, entries: [] },
    });
    assert.deepEqual(next.bookingCatalogSnapshot, snap,
      'the ledger may move; what the booking was originally priced at may not');
  });

  it('survives repeated mutations', () => {
    const snap = snapshot();
    let b = booking({ bookingCatalogSnapshot: snap });
    for (let i = 0; i < 5; i++) b = buildNextAggregate(b, { totalPrice: 100 + i });
    assert.deepEqual(b.bookingCatalogSnapshot, snap);
    assert.equal(b.bookingVersion, 8, 'versions still advance');
  });

  it('does not fabricate a snapshot on a booking that never had one', () => {
    const next = buildNextAggregate(booking(), { totalPrice: 500 });
    assert.equal(next.bookingCatalogSnapshot, undefined);
  });
});

describe('reads prefer the snapshot over live catalog', () => {
  it('resolves commercial fields from the snapshot when present', () => {
    const out = resolveBookingCommercial(booking({ bookingCatalogSnapshot: snapshot() }));
    assert.equal(out.source, 'bookingCatalogSnapshot');
    assert.equal(out.approvedTotalCents, 24000);
    assert.equal(out.releaseId, 'rel_abc123');
  });

  it('falls back to the aggregate for a legacy booking', () => {
    const out = resolveBookingCommercial(booking({ package: 'Full Detail' }));
    assert.equal(out.source, 'legacy-aggregate');
    assert.equal(out.approvedTotalCents, 24000);
    assert.equal(out.releaseId, null);
  });

  /**
   * The whole point: the ledger moving must not change what the snapshot reports.
   * A published catalog change reaches new quotes, never a priced booking.
   */
  it('reports the priced amount even after the ledger moves', () => {
    const b = booking({ bookingCatalogSnapshot: snapshot() });
    const moved = buildNextAggregate(b, {
      ledger: { currency: 'usd', approvedCents: 99900, settledCents: 0, creditedCents: 0, pendingCents: 0, entries: [] },
    });
    assert.equal(resolveBookingCommercial(moved).approvedTotalCents, 24000);
  });
});
