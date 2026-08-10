'use strict';

/**
 * Changing the tip must never make money unclaimable.
 *
 * cancelActiveAttemptsForTipChange asks Stripe to cancel the previous
 * PaymentIntent, but that call is best-effort (`catch (_) {}`) and it runs
 * inside the advisory-lock transaction, so it can fail or time out. When it
 * does, the Intent stays live on Stripe while the local row is retired — and
 * the customer can still pay it from a Payment Element mounted before the tip
 * changed.
 *
 * Retiring the row as 'canceled' made the webhook refuse that payment:
 *
 *   terminalWouldRegress = … || (attempt.status === 'canceled'
 *                                && paymentIntent.status !== 'canceled')
 *
 * Stripe captures, the ledger never credits, the invoice still shows due.
 * 'superseded' keeps the replacement reservation legal while leaving the
 * retired Intent creditable.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const service = fs.readFileSync(path.join(ROOT, 'netlify/lib/db/payment-authority-service.js'), 'utf8');
const schema = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');

/** Body of a top-level function, up to the next top-level declaration. */
function fn(name) {
  const start = service.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `${name} not found`);
  const rest = service.slice(start + 10);
  const next = rest.search(/\n(?:async function|function|module\.exports)\b/);
  return service.slice(start, next < 0 ? undefined : start + 10 + next);
}

describe('tip change retires the old attempt without orphaning its money', () => {
  it('retires as superseded, never as canceled', () => {
    const body = fn('cancelActiveAttemptsForTipChange');
    assert.match(body, /data:\s*\{\s*status:\s*'superseded'\s*\}/);
    assert.doesNotMatch(body, /data:\s*\{\s*status:\s*'canceled'\s*\}/,
      "a canceled row makes the webhook refuse money Stripe already captured");
  });

  it('superseded is a real enum value, not a string the database will reject', () => {
    const enumBlock = schema.match(/enum PaymentAttemptStatus \{[\s\S]*?\}/)[0];
    assert.match(enumBlock, /\bsuperseded\b/);
    // It must also exist in the applied SQL, not only in schema.prisma.
    const migrations = path.join(ROOT, 'prisma/migrations');
    const sql = fs.readdirSync(migrations)
      .filter((d) => fs.statSync(path.join(migrations, d)).isDirectory())
      .map((d) => {
        const file = path.join(migrations, d, 'migration.sql');
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      })
      .join('\n');
    const created = sql.match(/CREATE TYPE "PaymentAttemptStatus" AS ENUM \(([^)]*)\)/);
    assert.ok(created, 'PaymentAttemptStatus enum is never created in SQL');
    assert.match(created[1], /'superseded'/,
      'superseded is in schema.prisma but was never applied to the database');
  });

  it('the webhook still protects a genuine cancellation', () => {
    // A real cancel must not be settleable — only the tip-change retirement is.
    assert.match(service, /attempt\.status === 'canceled' && paymentIntent\.status !== 'canceled'/);
    const guard = service.slice(service.indexOf('const terminalWouldRegress'));
    const block = guard.slice(0, guard.indexOf(');') + 2);
    assert.doesNotMatch(block, /superseded/,
      'superseded must stay creditable, or the money hole reopens');
  });

  it('superseded is outside the active set, so the replacement still reserves', () => {
    // The partial unique index allows one active obligation per
    // bookingId+quoteVersion over creating|open|requires_action.
    const body = fn('cancelActiveAttemptsForTipChange');
    assert.match(body, /status:\s*\{\s*in:\s*\['creating',\s*'open',\s*'requires_action'\]\s*\}/);
    assert.doesNotMatch(body, /'superseded'.*in:/s);
  });

  it('an attempt already at the desired amount is left alone', () => {
    const body = fn('cancelActiveAttemptsForTipChange');
    assert.match(body, /=== desiredAmountCents\) continue;/,
      're-opening the same amount must not churn a live Intent');
  });
});
