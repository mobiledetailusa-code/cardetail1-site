#!/usr/bin/env node
/**
 * Invoke the Production (or target) Customer Identity smoke harness.
 *
 * Usage:
 *   CUSTOMER_IDENTITY_SMOKE_SECRET=... \
 *   SMOKE_BASE_URL=https://cardetail1.com \
 *   node scripts/prod-customer-identity-smoke.mjs
 *
 * Never prints the secret, cookies, emails, phones, or addresses.
 * Disabled remote harness returns HTTP 404 when the secret is unset on the target.
 */
import crypto from 'node:crypto';

const BASE = String(process.env.SMOKE_BASE_URL || 'https://cardetail1.com').replace(/\/$/, '');
const SECRET = String(process.env.CUSTOMER_IDENTITY_SMOKE_SECRET || '').trim();

function fail(msg) {
  console.error(`FAIL ${msg}`);
  process.exit(1);
}

async function main() {
  if (!SECRET || SECRET.length < 32) {
    fail('CUSTOMER_IDENTITY_SMOKE_SECRET missing or shorter than 32 chars (local env only; never commit)');
  }

  const url = `${BASE}/.netlify/functions/qa-customer-identity-smoke`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cd1-smoke-secret': SECRET,
    },
    body: JSON.stringify({ action: 'run' }),
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    fail(`invalid_json status=${res.status}`);
  }

  const steps = Array.isArray(json?.steps) ? json.steps : [];
  for (const step of steps) {
    const mark = step.ok ? 'PASS' : 'FAIL';
    const detail = step.detail ? ` :: ${String(step.detail).slice(0, 80)}` : '';
    console.log(`${mark} ${step.name}${detail}`);
  }

  console.log(
    JSON.stringify({
      ok: !!json?.ok && res.status === 200,
      status: res.status,
      smokeTagHash: json?.smokeTagHash || null,
      accountHash: json?.accountHash || null,
      cleanup: json?.cleanup
        ? {
          account: !!json.cleanup.account,
          addresses: Number(json.cleanup.addresses) || 0,
          audits: Number(json.cleanup.audits) || 0,
        }
        : null,
      secretFingerprint: crypto.createHash('sha256').update(SECRET).digest('hex').slice(0, 12),
    })
  );

  if (!(json?.ok && res.status === 200)) process.exit(2);
}

main().catch((err) => fail(err && err.message ? err.message : 'smoke_exception'));
