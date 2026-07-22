/**
 * Dry-run diagnostic for Customer Identity Foundation.
 * Reads only — never mutates Production or any database rows.
 *
 * Usage:
 *   node scripts/customer-identity-dry-run.js
 */
require('dotenv/config');
const { tryGetPrisma, prismaConfigured } = require('../netlify/lib/prisma');

async function main() {
  console.log('[customer-identity-dry-run] read-only diagnostic');
  if (!prismaConfigured()) {
    console.log(JSON.stringify({
      ok: false,
      reason: 'DATABASE_URL not configured',
      mutates: false,
    }, null, 2));
    process.exit(0);
  }
  const prisma = tryGetPrisma();
  if (!prisma) {
    console.log(JSON.stringify({ ok: false, reason: 'prisma_unavailable', mutates: false }, null, 2));
    process.exit(0);
  }

  const [
    accountCount,
    profileCount,
    addressCount,
    consentCount,
    linkedBookings,
    nullLinkedBookings,
  ] = await Promise.all([
    prisma.customerAccount.count().catch(() => null),
    prisma.customerProfile.count().catch(() => null),
    prisma.customerAddress.count().catch(() => null),
    prisma.customerConsent.count().catch(() => null),
    prisma.booking.count({ where: { customerAccountId: { not: null } } }).catch(() => null),
    prisma.booking.count({ where: { customerAccountId: null } }).catch(() => null),
  ]);

  console.log(JSON.stringify({
    ok: true,
    mutates: false,
    counts: {
      customerAccounts: accountCount,
      customerProfiles: profileCount,
      customerAddresses: addressCount,
      customerConsents: consentCount,
      bookingsLinked: linkedBookings,
      bookingsUnlinked: nullLinkedBookings,
    },
    notes: [
      'This script never creates, updates, or deletes rows.',
      'Existing Prisma Customer remains a non-identity payment placeholder.',
      'Stage 1 uses backfill-on-login only — no Production-wide batch migration.',
    ],
  }, null, 2));
}

main().catch((err) => {
  console.error('[customer-identity-dry-run] failed', err && err.message ? err.message : err);
  process.exit(1);
});
