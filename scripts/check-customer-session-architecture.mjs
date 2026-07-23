#!/usr/bin/env node
/**
 * Read-only Customer session architecture check against Netlify env metadata.
 * Never prints secret values — only presence / context / length / masked flags.
 *
 * Usage:
 *   NETLIFY_AUTH_TOKEN=... node scripts/check-customer-session-architecture.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function loadDotEnv() {
  const p = path.join(root, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}

function summarize(val) {
  const s = String(val || '');
  if (!s) return { present: false, readable: false, length: 0, masked: false };
  const masked = s.startsWith('*') || (s.includes('*') && s.length <= 40);
  return { present: true, readable: !masked && s.length >= 8, length: s.length, masked };
}

async function main() {
  loadDotEnv();
  const token = String(process.env.NETLIFY_AUTH_TOKEN || '').trim();
  const site = String(process.env.NETLIFY_SITE_ID || 'd7e5f77c-1f0b-4209-a9df-3d6aae380dd0').trim();
  if (!token) {
    console.log(JSON.stringify({ ok: false, error: 'missing_netlify_token' }));
    process.exit(1);
  }

  const res = await fetch(
    `https://api.netlify.com/api/v1/accounts/6a2802ed5070702e9f45913b/env?site_id=${site}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
  );
  if (!res.ok) {
    console.log(JSON.stringify({ ok: false, error: `env_fetch_${res.status}` }));
    process.exit(1);
  }
  const list = await res.json();
  const byKey = Object.fromEntries((Array.isArray(list) ? list : []).map((e) => [e.key, e]));

  const customer = byKey.CUSTOMER_SESSION_SECRET;
  const admin = byKey.ADMIN_SESSION_SECRET;
  const customerProd = (customer?.values || []).find((v) => v.context === 'production');
  const adminProd = (admin?.values || []).find((v) => v.context === 'production');

  const customerProdSummary = summarize(customerProd?.value);
  const adminProdSummary = summarize(adminProd?.value);

  const productionUsesAdminFallback = !customerProdSummary.present && adminProdSummary.present;
  const separated = customerProdSummary.present && adminProdSummary.present;

  const report = {
    ok: true,
    site_id: site,
    CUSTOMER_SESSION_SECRET: {
      exists: !!customer,
      production: customerProdSummary,
      otherContexts: (customer?.values || []).map((v) => ({ context: v.context, ...summarize(v.value) })),
    },
    ADMIN_SESSION_SECRET: {
      exists: !!admin,
      production: adminProdSummary,
      otherContexts: (admin?.values || []).map((v) => ({ context: v.context, ...summarize(v.value) })),
    },
    fallbackBehavior: {
      codePath: 'CUSTOMER_SESSION_SECRET || ADMIN_SESSION_SECRET',
      productionUsesAdminFallback,
      cryptographicallySeparated: separated,
    },
    blocking: productionUsesAdminFallback,
    recommendation: productionUsesAdminFallback
      ? 'Set a dedicated CUSTOMER_SESSION_SECRET in Netlify Production (32+ chars), distinct from ADMIN_SESSION_SECRET. Expect existing customer cookies to re-auth once.'
      : 'Customer and admin session secrets are both present in Production.',
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(productionUsesAdminFallback ? 2 : 0);
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
