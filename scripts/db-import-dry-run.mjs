#!/usr/bin/env node
// Phase 2 — read-only Blob importer + dry-run comparison.
//
// Reads every visible booking from the `cd1-bookings` Netlify Blob store
// (via netlify/lib/ops-db.js#listRawBookings, the same read path Admin/Ops
// uses) and reports what the Phase 2 relational projection (Booking/Quote/
// PaymentAttempt/LedgerEntry) *would* look like for each one, without
// writing anything anywhere.
//
// Safety:
//   - No Blob write, update, or delete call is made (read-only Blob access).
//   - No Postgres write is made — this is strictly a comparison report.
//   - Never prints phone/email/name; only counts and cents-level aggregates.
//
// Usage: node scripts/db-import-dry-run.mjs

import 'dotenv/config';

// Hard runtime guard — this script must never run in write mode, migration
// mode, against a Production-marked context, or with a live Stripe key
// present. It has no write path today; this guard exists so a future edit
// (or a copy/paste of this file) cannot silently turn it into one without
// an explicit, auditable override that itself still refuses production.
function assertSafeToRun() {
  const reasons = [];

  // 1. Write mode: this script is dry-run only. There is no supported way
  //    to opt in — presence of this flag (in any truthy form) is refused,
  //    not honored, so it can't be used to bypass the guard.
  if (process.env.DB_IMPORT_ALLOW_WRITES) {
    reasons.push('DB_IMPORT_ALLOW_WRITES is set — this script has no write mode and never will.');
  }

  // 2. Migration mode: never run alongside a Prisma migrate invocation.
  if (process.env.PRISMA_MIGRATE || process.argv.some((a) => /migrate/i.test(a))) {
    reasons.push('a migration-related flag/argument was detected.');
  }

  // 3. Production database / Production Netlify context markers.
  const context = String(process.env.CONTEXT || '').toLowerCase();
  const nodeEnv = String(process.env.NODE_ENV || '').toLowerCase();
  if (context === 'production') {
    reasons.push(`Netlify CONTEXT=production detected — refusing to run against a Production build context.`);
  }
  if (nodeEnv === 'production') {
    reasons.push(`NODE_ENV=production detected — refusing to run.`);
  }
  for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
    const val = String(process.env[key] || '');
    if (/\bprod(uction)?\b/i.test(val)) {
      reasons.push(`${key} contains a "production" marker in its value.`);
    }
  }

  // 4. Stripe live key present anywhere in env — this script never calls
  //    Stripe, but a live key in the process env is itself a signal this
  //    is not a safe context to run any dry-run/reporting tool in.
  for (const [key, val] of Object.entries(process.env)) {
    if (/STRIPE/i.test(key) && /^(sk|pk)_live_/.test(String(val || ''))) {
      reasons.push(`${key} is a live Stripe key (sk_live_/pk_live_ prefix).`);
    }
  }

  if (reasons.length) {
    console.error('[db-import-dry-run] REFUSING TO RUN — safety guard tripped:');
    for (const r of reasons) console.error('  -', r);
    process.exit(1);
  }
}

async function main() {
  assertSafeToRun();

  const { listRawBookings } = await import('../netlify/lib/ops-db.js');
  const { remainingCents } = await import('../netlify/lib/booking-aggregate.js');

  const bookings = await listRawBookings();

  const report = {
    generatedAt: new Date().toISOString(),
    totalBookingsScanned: bookings.length,
    wouldImport: 0,
    skippedDrafts: 0,
    skippedNoId: 0,
    quoteVersionMismatches: [],
    ledgerVsMaterialMismatches: [],
    paymentAttemptsSeen: 0,
    multipleOpenAttempts: [],
    negativeRemaining: [],
  };

  for (const b of bookings) {
    const id = String(b.id || b.bookingId || '').trim();
    if (!id) { report.skippedNoId += 1; continue; }
    if (b.isDraft) { report.skippedDrafts += 1; continue; }

    report.wouldImport += 1;

    const ledger = b.ledger || {};
    const declaredQuoteVersion = Math.round(Number(b.quoteVersion ?? b.quote?.quoteVersion) || 0);
    const rem = remainingCents(ledger);
    if (rem < 0) report.negativeRemaining.push(id);

    // Every stored payment attempt should carry the same quoteVersion the
    // booking currently declares, unless it's already terminal (superseded
    // by a later quote change) — flag ones that disagree while still "open".
    const attempts = Array.isArray(b.paymentAttempts) ? b.paymentAttempts : [];
    report.paymentAttemptsSeen += attempts.length;
    const openAttempts = attempts.filter((a) => a && (a.status === 'open' || a.status === 'creating'));
    if (openAttempts.length > 1) report.multipleOpenAttempts.push({ id, count: openAttempts.length });
    const staleOpen = openAttempts.find(
      (a) => Math.round(Number(a.quoteVersion) || 0) !== declaredQuoteVersion
    );
    if (staleOpen) {
      report.quoteVersionMismatches.push({
        id,
        bookingQuoteVersion: declaredQuoteVersion,
        openAttemptQuoteVersion: Math.round(Number(staleOpen.quoteVersion) || 0),
      });
    }

    // Cross-check the ledger's own settled/approved math against the
    // approvedCents implied by legacy compatibility fields, when present.
    const approvedFromLedger = Math.round(Number(ledger.approvedCents) || 0);
    const approvedLegacy = Math.round(Number(b.approvedFinalAmount || b.totalPrice || 0) * 100);
    if (approvedFromLedger > 0 && approvedLegacy > 0 && Math.abs(approvedFromLedger - approvedLegacy) > 1) {
      report.ledgerVsMaterialMismatches.push({ id, approvedFromLedger, approvedLegacy });
    }
  }

  console.log(JSON.stringify(report, null, 2));

  const problems = report.quoteVersionMismatches.length
    + report.ledgerVsMaterialMismatches.length
    + report.multipleOpenAttempts.length
    + report.negativeRemaining.length;
  if (problems > 0) {
    console.log(`\n[db-import-dry-run] ${problems} record(s) would need manual review before a real cutover import.`);
  } else {
    console.log('\n[db-import-dry-run] No blocking discrepancies found in the scanned bookings.');
  }
}

main().catch((err) => {
  console.error('[db-import-dry-run] failed:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
