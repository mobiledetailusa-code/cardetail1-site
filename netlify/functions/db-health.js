// Deploy Preview database health check — reports only whether Postgres is
// configured and reachable. Never returns hostnames, credentials, connection
// strings, or raw error text (which can itself leak host/user details).
//
// This function is intentionally decoupled from any specific deploy context:
// it just answers "configured / reachable" for whatever environment it runs
// in. Netlify environment-variable *scoping* (Functions scope, Deploy
// Previews context only) is what keeps DATABASE_URL out of Production, not
// logic in this file — see docs/audit/db-env-requirements-2026-07-18.md.

const { prismaConfigured, tryGetPrisma } = require('../lib/prisma');

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Methods': 'GET, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }

  const configured = prismaConfigured();
  if (!configured) {
    // Fails clearly: no DATABASE_URL means no attempt is made, not a silent pass.
    return json(200, { configured: false, reachable: false });
  }

  const prisma = tryGetPrisma();
  if (!prisma) {
    return json(200, { configured: true, reachable: false });
  }

  try {
    // Minimal real query — proves an actual round trip, not just "client constructed".
    await prisma.$queryRawUnsafe('SELECT 1');
    return json(200, { configured: true, reachable: true });
  } catch {
    // Never surface the raw error: Postgres/Accelerate error text can embed
    // hostnames, ports, or partial credentials. Fail clearly, not open.
    return json(200, { configured: true, reachable: false });
  }
};
