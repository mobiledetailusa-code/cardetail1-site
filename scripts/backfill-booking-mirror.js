/**
 * One-time backfill of BookingRecord from the authoritative Blobs store.
 *
 * Offer eligibility now answers "has this customer booked before?" from the
 * Prisma mirror (netlify/lib/booking-history.js) instead of hydrating every
 * blob on each checkout. The mirror only carries bookings submitted since
 * dual-write shipped, so run this once to backfill the older ones — otherwise a
 * pre-mirror customer can look new and receive the first-booking discount again.
 *
 * Reads Blobs, writes only BookingRecord rows. Nothing else is touched.
 *
 *   node scripts/backfill-booking-mirror.js            # dry run, reports gap
 *   node scripts/backfill-booking-mirror.js --apply    # upsert missing rows
 *
 * Needs DATABASE_URL plus Blobs access (NETLIFY_SITE_ID + NETLIFY_AUTH_TOKEN,
 * or run through `netlify dev:exec`).
 */

require('dotenv').config();

const { listRawBookings } = require('../netlify/lib/ops-db');
const {
  mirrorEnabled,
  isDraftBooking,
  upsertBookingMirror,
} = require('../netlify/lib/booking-prisma-mirror');
const { tryGetPrisma } = require('../netlify/lib/prisma');

const APPLY = process.argv.includes('--apply');
const CONCURRENCY = 10;

async function main() {
  if (!mirrorEnabled()) {
    throw new Error('Prisma mirror disabled — set DATABASE_URL and leave PRISMA_BOOKING_MIRROR unset.');
  }
  const prisma = tryGetPrisma();
  if (!prisma) throw new Error('Prisma client unavailable.');

  const bookings = (await listRawBookings()).filter((b) => !isDraftBooking(b));
  if (!bookings.length) {
    throw new Error('Blobs returned no submitted bookings — check Blobs credentials before trusting this.');
  }

  const ids = bookings.map((b) => String(b.id || b.bookingId || '').trim()).filter(Boolean);
  const known = new Set(
    (await prisma.bookingRecord.findMany({ where: { id: { in: ids } }, select: { id: true } }))
      .map((row) => row.id)
  );
  const missing = bookings.filter((b) => !known.has(String(b.id || b.bookingId || '').trim()));

  console.log(JSON.stringify({
    blobBookings: bookings.length,
    alreadyMirrored: known.size,
    missing: missing.length,
    mode: APPLY ? 'apply' : 'dry-run',
  }));

  if (!APPLY || !missing.length) {
    if (!APPLY && missing.length) console.log('Re-run with --apply to upsert the missing rows.');
    await prisma.$disconnect();
    return;
  }

  let written = 0;
  const failures = [];
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const chunk = missing.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map((b) => upsertBookingMirror(b)));
    results.forEach((res, idx) => {
      if (res.ok) written += 1;
      // upsertBookingMirror never throws; surface what it swallowed.
      else failures.push({ id: chunk[idx].id, reason: res.error || res.reason });
    });
    console.log(`  ${Math.min(i + CONCURRENCY, missing.length)}/${missing.length}`);
  }

  console.log(JSON.stringify({ written, failed: failures.length, failures: failures.slice(0, 20) }));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
