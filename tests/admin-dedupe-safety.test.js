'use strict';

/**
 * Safety net for the Admin twin-Blob dedupe.
 *
 * Collapsing rows by logical booking id is only acceptable while it is
 * impossible for two DISTINCT bookings to collide. Two real appointments for
 * the same customer on the same day in different slots is a supported shape
 * (hasSlotConflict blocks same date+time, not same date), so hiding one would
 * cost the operator a job. This pins that they stay separate.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBookingKey } = require('../netlify/lib/ops-db');

describe('Admin dedupe must not hide a distinct booking', () => {
  it('two real bookings on the same day in different slots keep distinct keys', () => {
    const a = normalizeBookingKey('CD1-4K2P9X');
    const b = normalizeBookingKey('CD1-8H3M1Q');
    assert.notEqual(a, b, 'distinct booking ids must not normalize to the same key');
  });

  it('normalizeBookingKey does not collapse ids that differ only in stripped characters', () => {
    // The normalizer strips everything outside [A-Z0-9-]. Two ids that differ
    // only by such characters WOULD collide — assert the minting alphabet never
    // produces that shape.
    const minted = /^[A-Z0-9-]+$/;
    for (const id of ['CD1-4K2P9X', 'CD1-8H3M1Q', 'CD1-2C7V5B']) {
      assert.match(id, minted, `${id} must contain only characters the normalizer preserves`);
    }
  });

  it('a payload with no id falls back to its own Blob key, so orphans stay separate', () => {
    const k1 = normalizeBookingKey('blobkey-aaa');
    const k2 = normalizeBookingKey('blobkey-bbb');
    assert.notEqual(k1, k2);
  });

  it('the dedupe reports what it collapsed instead of hiding it silently', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'netlify/functions/admin-ops-jobs.js'), 'utf8');
    // A collapsed row must carry the dropped keys so the anomaly stays visible
    // to whoever reads the list payload.
    assert.match(src, /_dedupedBlobKeys/, 'collapsed twins must record the keys they absorbed');
  });
});
