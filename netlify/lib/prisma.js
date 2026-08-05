/**
 * Prisma Client singleton — optional. Missing DATABASE_URL must never break checkout/ops.
 * Do not auto-load dotenv here (would override test env from local .env).
 * Netlify injects DATABASE_URL; local scripts/prisma-smoke.js loads dotenv explicitly.
 */

let _prisma = null;
let _initFailed = false;

function prismaConfigured() {
  return !!(process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim());
}

/**
 * @returns {import('@prisma/client').PrismaClient | null}
 */
function tryGetPrisma() {
  if (_prisma) return _prisma;
  if (_initFailed) return null;
  if (!prismaConfigured()) return null;
  if (process.env.PRISMA_BOOKING_MIRROR === '0' || process.env.PRISMA_BOOKING_MIRROR === 'false') {
    return null;
  }
  try {
    const { PrismaClient } = require('@prisma/client');
    const url = String(process.env.DATABASE_URL).trim();
    if (url.startsWith('prisma+postgres://') || url.includes('accelerate.prisma-data.net')) {
      _prisma = new PrismaClient({ accelerateUrl: url });
    } else {
      // Prisma 7 requires a driver adapter for direct PostgreSQL URLs.
      const { PrismaPg } = require('@prisma/adapter-pg');
      _prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    }
    return _prisma;
  } catch (err) {
    _initFailed = true;
    console.warn('[prisma] init_failed', err && err.message ? err.message : err);
    return null;
  }
}

function getPrisma() {
  const client = tryGetPrisma();
  if (!client) throw new Error('DATABASE_URL is not set or Prisma unavailable');
  return client;
}

/** Test helper */
function _resetPrismaForTests() {
  _prisma = null;
  _initFailed = false;
}

module.exports = {
  prismaConfigured,
  tryGetPrisma,
  getPrisma,
  _resetPrismaForTests,
};
