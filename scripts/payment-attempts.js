/**
 * Inspect and unstick payment attempts.
 *
 * A PaymentAttempt in creating / open / requires_action blocks every amount
 * change on its booking — add-on approvals, package changes. It leaves those
 * states only when a Stripe webhook terminalises it, so a webhook that never
 * arrived leaves the booking locked. createAdjustment now retires these on its
 * own, but that only works where the Stripe keys match the account the payment
 * intent lives in. This is the manual path for everything else.
 *
 *   node scripts/payment-attempts.js                     # list every active attempt
 *   node scripts/payment-attempts.js --booking CD1-XXXX  # just this booking
 *   node scripts/payment-attempts.js --close <attemptId> # cancel at Stripe, then retire
 *
 * MODE MATTERS. Run it with the same Stripe keys the payment was created with:
 * a test key cannot see a live payment intent, and vice versa. The script
 * prints the mode it is using and refuses to guess.
 *
 * --close is the only write. Without it nothing is modified.
 */

require('dotenv').config();

const { tryGetPrisma } = require('../netlify/lib/prisma');

const ACTIVE = ['creating', 'open', 'requires_action'];
const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const bookingFilter = argOf('--booking');
const closeId = argOf('--close');

const SECRET = process.env.STRIPE_SECRET_KEY || '';
const MODE = SECRET.startsWith('sk_live_') ? 'live' : SECRET.startsWith('sk_test_') ? 'test' : 'none';

function ageMinutes(row) {
  const at = Date.parse(row.updatedAt || row.createdAt || '');
  return Number.isFinite(at) ? Math.round((Date.now() - at) / 60000) : null;
}

async function stripeGet(id) {
  const res = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const body = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, status: body.status } : { ok: false, error: body?.error?.message || `http_${res.status}` };
}

async function stripeCancel(id) {
  const res = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const body = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, status: body.status } : { ok: false, error: body?.error?.message || `http_${res.status}` };
}

async function main() {
  console.log(`Stripe mode: ${MODE}${MODE === 'none' ? ' (STRIPE_SECRET_KEY not set — Stripe checks skipped)' : ''}`);
  const prisma = tryGetPrisma();
  if (!prisma) throw new Error('No Prisma client — set DATABASE_URL.');

  const rows = await prisma.paymentAttempt.findMany({
    where: {
      status: { in: ACTIVE },
      ...(bookingFilter ? { bookingId: bookingFilter } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });

  if (!rows.length) {
    console.log('No active payment attempts. Nothing is blocking an amount change.');
    await prisma.$disconnect();
    return;
  }

  for (const row of rows) {
    const stripe = MODE !== 'none' && String(row.providerObjectId || '').startsWith('pi_')
      ? await stripeGet(row.providerObjectId)
      : { ok: false, error: 'no payment intent' };
    console.log(JSON.stringify({
      attemptId: row.id,
      bookingId: row.bookingId,
      status: row.status,
      quoteVersion: row.quoteVersion,
      amountCents: row.amountCents,
      ageMinutes: ageMinutes(row),
      paymentIntent: row.providerObjectId || null,
      stripe: stripe.ok ? stripe.status : `unavailable: ${stripe.error}`,
    }));
  }

  if (!closeId) {
    console.log('\nRead-only. Re-run with --close <attemptId> to cancel at Stripe and retire one.');
    await prisma.$disconnect();
    return;
  }

  const target = rows.find((r) => r.id === closeId);
  if (!target) throw new Error(`Attempt ${closeId} is not in the active list above.`);

  const pi = String(target.providerObjectId || '');
  if (pi.startsWith('pi_')) {
    if (MODE === 'none') throw new Error('This attempt has a payment intent but STRIPE_SECRET_KEY is not set.');
    const current = await stripeGet(pi);
    if (current.ok && current.status === 'succeeded') {
      throw new Error('Stripe reports this payment as succeeded — it is a settlement, not something to void.');
    }
    if (current.ok && ['processing', 'requires_capture'].includes(current.status)) {
      throw new Error(`Stripe reports "${current.status}" — money is in flight and must not be voided.`);
    }
    if (!current.ok) {
      throw new Error(
        `Stripe (${MODE} mode) cannot see ${pi}: ${current.error}. `
        + 'Re-run with the keys of the account this payment belongs to.'
      );
    }
    if (current.status !== 'canceled') {
      const canceled = await stripeCancel(pi);
      if (!canceled.ok) throw new Error(`Stripe refused the cancel: ${canceled.error}`);
      console.log(`Canceled ${pi} at Stripe.`);
    }
  }

  await prisma.paymentAttempt.update({
    where: { id: target.id },
    data: { status: 'superseded', failureCode: 'manually_retired' },
  });
  console.log(`Attempt ${target.id} retired. Amount changes on ${target.bookingId} are unblocked.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
