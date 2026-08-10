/**
 * One-time backfill of the cd1-slot-index store from the authoritative bookings.
 *
 * Rollout order matters:
 *   1. deploy the write path (index is maintained from then on, reads still scan)
 *   2. run this backfill               → historical holds enter the index
 *   3. set SLOT_INDEX_READS=1          → checkout stops scanning the store
 *
 * Reading with SLOT_INDEX_READS unset is safe at every step: an unbackfilled
 * index is never consulted.
 *
 *   node scripts/backfill-slot-index.js           # dry run
 *   node scripts/backfill-slot-index.js --apply   # write index entries
 *
 * Needs Blobs access (NETLIFY_SITE_ID + NETLIFY_AUTH_TOKEN, or netlify dev:exec).
 * Writes only to cd1-slot-index — booking records are never modified.
 */

require('dotenv').config();

const { listBookingsForSlotLock } = require('../netlify/lib/ops-db');
const { slotHoldForBooking, slotIndexKey, slotIndexStore } = require('../netlify/lib/slot-index');

const APPLY = process.argv.includes('--apply');
const CONCURRENCY = 10;

async function main() {
  const bookings = await listBookingsForSlotLock();
  const holds = [];
  for (const booking of bookings) {
    const id = String(booking.id || booking.bookingId || '').trim();
    if (!id) continue;
    const hold = slotHoldForBooking(booking);
    if (!hold.active) continue;
    holds.push({ id, key: slotIndexKey({ ...hold, bookingId: id }) });
  }

  console.log(JSON.stringify({
    activeBookings: bookings.length,
    holdsToIndex: holds.length,
    mode: APPLY ? 'apply' : 'dry-run',
  }));
  if (!APPLY) {
    console.log(holds.slice(0, 20).map((h) => h.key).join('\n'));
    console.log('Re-run with --apply to write these entries.');
    return;
  }

  const store = await slotIndexStore();
  let written = 0;
  const failures = [];
  for (let i = 0; i < holds.length; i += CONCURRENCY) {
    const chunk = holds.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (hold) => {
      try {
        await store.setJSON(hold.key, 1);
        written += 1;
      } catch (err) {
        failures.push({ id: hold.id, error: err && err.message ? err.message : String(err) });
      }
    }));
    console.log(`  ${Math.min(i + CONCURRENCY, holds.length)}/${holds.length}`);
  }
  console.log(JSON.stringify({ written, failed: failures.length, failures: failures.slice(0, 20) }));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
