/**
 * Drift check: compare cd1-slot-index against the authoritative booking store.
 *
 * The index is derived state maintained by every booking write. This is how you
 * find out it stopped agreeing with reality — run it after the backfill, then
 * on a schedule. Read-only unless --repair is passed.
 *
 *   node scripts/verify-slot-index.js            # report drift, exit 1 if any
 *   node scripts/verify-slot-index.js --repair   # add missing, drop orphaned
 *
 * missing  — an active hold with no index entry (a slot that reads as free and
 *            can be double-booked). Always the serious one.
 * orphaned — an index entry with no matching active hold (a slot that reads as
 *            busy). Fail-closed, but it costs real availability.
 */

require('dotenv').config();

const { listBookingsForSlotLock } = require('../netlify/lib/ops-db');
const {
  slotHoldForBooking,
  slotIndexKey,
  parseSlotIndexKey,
  slotIndexStore,
  entryIsActive,
} = require('../netlify/lib/slot-index');

const REPAIR = process.argv.includes('--repair');

async function listEveryIndexEntry(store) {
  const entries = [];
  const paged = store.list({ paginate: true });
  if (paged && typeof paged[Symbol.asyncIterator] === 'function') {
    for await (const page of paged) {
      for (const blob of (page && page.blobs) || []) entries.push(blob.key);
    }
  } else {
    const listing = await paged;
    for (const blob of (listing && listing.blobs) || []) entries.push(blob.key);
  }
  return entries;
}

async function main() {
  const nowMs = Date.now();
  const store = await slotIndexStore();

  const expected = new Map();
  for (const booking of await listBookingsForSlotLock()) {
    const id = String(booking.id || booking.bookingId || '').trim();
    if (!id) continue;
    const hold = slotHoldForBooking(booking);
    if (!hold.active) continue;
    expected.set(slotIndexKey({ ...hold, bookingId: id }), id);
  }

  const indexKeys = await listEveryIndexEntry(store);
  const present = new Set(indexKeys);

  const missing = [...expected.keys()].filter((key) => !present.has(key));
  // Expired draft entries are not drift — they are how the hold releases.
  const orphaned = indexKeys.filter((key) => {
    if (expected.has(key)) return false;
    const entry = parseSlotIndexKey(key);
    return entry && entryIsActive(entry, nowMs);
  });

  console.log(JSON.stringify({
    activeHolds: expected.size,
    indexEntries: indexKeys.length,
    missing: missing.length,
    orphaned: orphaned.length,
  }, null, 2));
  if (missing.length) console.log('MISSING (double-booking risk):\n' + missing.join('\n'));
  if (orphaned.length) console.log('ORPHANED (lost availability):\n' + orphaned.join('\n'));

  if (REPAIR && (missing.length || orphaned.length)) {
    for (const key of missing) await store.setJSON(key, 1);
    for (const key of orphaned) await store.delete(key);
    console.log(JSON.stringify({ repaired: { added: missing.length, removed: orphaned.length } }));
    return;
  }
  if (missing.length || orphaned.length) process.exit(1);
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
