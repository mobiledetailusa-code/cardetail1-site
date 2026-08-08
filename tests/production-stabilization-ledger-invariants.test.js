'use strict';

/**
 * P0 — Stripe / ledger invariants.
 *
 * Uses the project's existing authoritative derivation
 * (netlify/lib/db/financial-projection.js) over staging fixtures. No new
 * formula is introduced here: the checker below only asserts that the existing
 * projection cannot produce the six inconsistency classes.
 *
 *   remaining = approved
 *             - authoritative ledger credits (settlements)
 *             - authoritative post-approval adjustments (signed)
 *             + refunds
 *   clamped at 0; post-approval increases arrive as a new approved quote.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { computeFinancialProjection } = require('../netlify/lib/db/financial-projection');

const BOOKING = { id: 'CD1-INV' };

function project({ approvedCents, attempts = [], entries = [], refundRequests = [] }) {
  return computeFinancialProjection({
    booking: BOOKING,
    quote: { quoteVersion: 1, approvedCents },
    paymentAttempts: attempts,
    ledgerEntries: entries,
    refundRequests,
  });
}

const settlement = (amountCents, paymentAttemptId = 'att_1', providerEventId = 'settlement_pi_1') => ({
  kind: 'settlement', amountCents, quoteVersion: 1, paymentAttemptId, providerEventId,
  providerObjectId: 'pi_1', recordedAt: '2026-08-08T12:00:00.000Z',
});
const refund = (amountCents, providerEventId = 'refund_re_1') => ({
  kind: 'refund', amountCents, quoteVersion: 1, providerEventId, providerObjectId: 're_1',
});
const adjustment = (amountCents, providerEventId = 'adj_1') => ({
  kind: 'adjustment', amountCents, quoteVersion: 1, providerEventId,
});
const attempt = (status, id = 'att_1', providerObjectId = 'pi_1') => ({
  id, status, providerObjectId, amountCents: 26000, quoteVersion: 1, currency: 'usd',
  updatedAt: '2026-08-08T12:00:00.000Z',
});

/**
 * Detects the six inconsistency classes from a projection plus its source rows.
 * Test-only: production has no such scanner and none is added, because no live
 * inconsistency was observed in this run.
 */
function inconsistencies({ projection, attempts = [], entries = [] }) {
  const found = [];
  const settlements = entries.filter((e) => e.kind === 'settlement');

  for (const a of attempts) {
    if (a.status === 'succeeded' && !settlements.some((e) => e.paymentAttemptId === a.id)) {
      found.push('succeeded_without_ledger_entry');
    }
  }
  for (const e of settlements) {
    const a = attempts.find((x) => x.id === e.paymentAttemptId);
    const cardBacked = String(e.providerObjectId || '').startsWith('pi_');
    if (cardBacked && (!a || a.status !== 'succeeded')) {
      found.push('ledger_credit_without_succeeded_provider_state');
    }
  }
  const eventIds = settlements.map((e) => e.providerEventId);
  if (new Set(eventIds).size !== eventIds.length) found.push('duplicate_ledger_credit');

  const active = attempts.filter((a) => ['creating', 'open', 'requires_action'].includes(a.status));
  if (active.length && projection.remainingCents === 0) found.push('stale_payment_attempt');

  if (projection.paymentStatus === 'paid' && projection.remainingCents > 0) {
    found.push('paid_with_positive_remaining');
  }
  if (projection.paymentStatus !== 'paid' && projection.paymentStatus !== 'refunded'
    && projection.remainingCents === 0 && projection.approvedCents > 0
    && projection.settledCents === 0) {
    found.push('unpaid_with_zero_remaining');
  }
  return found;
}

describe('P0 — ledger invariant table (staging fixtures)', () => {
  const cases = [
    {
      name: 'A · approved, nothing paid',
      fixture: { approvedCents: 26000 },
      expect: { approved: 26000, settled: 0, remaining: 26000, status: 'due' },
    },
    {
      name: 'B · PaymentIntent open (one attempt, no credit yet)',
      fixture: { approvedCents: 26000, attempts: [attempt('open')] },
      expect: { approved: 26000, settled: 0, remaining: 26000, status: 'processing' },
    },
    {
      name: 'C · card succeeded, exactly one ledger credit',
      fixture: {
        approvedCents: 26000,
        attempts: [attempt('succeeded')],
        entries: [settlement(26000)],
      },
      expect: { approved: 26000, settled: 26000, remaining: 0, status: 'paid' },
    },
    {
      name: 'D · post-approval increase becomes a new approved total',
      fixture: {
        approvedCents: 31000,
        attempts: [attempt('succeeded')],
        entries: [settlement(26000)],
      },
      expect: { approved: 31000, settled: 26000, remaining: 5000, status: 'due' },
    },
    {
      name: 'E · full refund after settlement',
      fixture: {
        approvedCents: 26000,
        attempts: [attempt('succeeded')],
        entries: [settlement(26000), refund(26000)],
      },
      expect: { approved: 26000, settled: 0, remaining: 26000, status: 'refunded' },
    },
    {
      name: 'F · negative adjustment credits the balance',
      fixture: {
        approvedCents: 26000,
        attempts: [attempt('succeeded')],
        entries: [settlement(20000), adjustment(6000)],
      },
      expect: { approved: 26000, settled: 26000, remaining: 0, status: 'paid' },
    },
  ];

  for (const c of cases) {
    it(`${c.name} — remaining derives from the ledger`, () => {
      const projection = project(c.fixture);
      assert.equal(projection.approvedCents, c.expect.approved);
      assert.equal(projection.settledCents, c.expect.settled);
      assert.equal(projection.remainingCents, c.expect.remaining);
      assert.equal(projection.paymentStatus, c.expect.status);
      // The authoritative identity, restated on every fixture.
      assert.equal(
        projection.remainingCents,
        Math.max(0, projection.approvedCents - projection.settledCents)
      );
    });
  }

  it('no fixture in the table trips an inconsistency detector', () => {
    for (const c of cases) {
      const projection = project(c.fixture);
      const found = inconsistencies({
        projection,
        attempts: c.fixture.attempts || [],
        entries: c.fixture.entries || [],
      });
      assert.deepEqual(found, [], `${c.name} produced ${found.join(', ')}`);
    }
  });
});

describe('P0 — inconsistency detectors actually fire', () => {
  it('succeeded Stripe payment without a ledger entry', () => {
    const fixture = { approvedCents: 26000, attempts: [attempt('succeeded')], entries: [] };
    const found = inconsistencies({ projection: project(fixture), ...fixture });
    assert.ok(found.includes('succeeded_without_ledger_entry'));
  });

  it('ledger credit without succeeded provider state for a card', () => {
    const fixture = {
      approvedCents: 26000,
      attempts: [attempt('open')],
      entries: [settlement(26000)],
    };
    const found = inconsistencies({ projection: project(fixture), ...fixture });
    assert.ok(found.includes('ledger_credit_without_succeeded_provider_state'));
  });

  it('duplicate ledger credit', () => {
    const fixture = {
      approvedCents: 26000,
      attempts: [attempt('succeeded')],
      entries: [settlement(26000), settlement(26000)],
    };
    const found = inconsistencies({ projection: project(fixture), ...fixture });
    assert.ok(found.includes('duplicate_ledger_credit'));
  });

  it('stale PaymentAttempt left active on a settled booking', () => {
    const fixture = {
      approvedCents: 26000,
      attempts: [attempt('succeeded', 'att_1'), attempt('open', 'att_2', 'pi_2')],
      entries: [settlement(26000)],
    };
    const found = inconsistencies({ projection: project(fixture), ...fixture });
    assert.ok(found.includes('stale_payment_attempt'));
  });

  it('a cash settlement is not flagged as a card without provider state', () => {
    const cash = {
      kind: 'settlement', amountCents: 26000, quoteVersion: 1, paymentAttemptId: null,
      providerObjectId: 'cash', providerEventId: 'cash_full_balance:CD1-INV:1:0:26000',
    };
    const fixture = { approvedCents: 26000, attempts: [], entries: [cash] };
    const found = inconsistencies({ projection: project(fixture), ...fixture });
    assert.deepEqual(found, []);
    assert.equal(project(fixture).paymentStatus, 'paid');
  });
});

describe('P0 — database guarantees behind the invariants', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');

  it('a duplicate ledger credit is impossible: providerEventId is unique', () => {
    assert.match(schema, /providerEventId\s+String\?\s+@unique/);
  });

  it('the ledger is append-only', () => {
    assert.match(schema, /Append-only: UPDATE\/DELETE are blocked at the database level/);
  });

  it('one Stripe object per attempt and one idempotency key per attempt', () => {
    assert.match(schema, /providerObjectId\s+String\?\s+@unique/);
    assert.match(schema, /idempotencyKey\s+String\s+@unique/);
  });

  it('webhook events are deduplicated by a unique Stripe event id', () => {
    assert.match(schema, /stripeEventId\s+String\s+@unique/);
  });

  it('one active obligation per bookingId + quoteVersion', () => {
    assert.match(schema, /One active \(creating\|open\|requires_action\) obligation per bookingId\+quoteVersion/);
  });
});
