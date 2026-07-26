/**
 * Prisma Client singleton — optional. Missing DATABASE_URL must never break checkout/ops.
 * Do not auto-load dotenv here (would override test env from local .env).
 * Netlify injects DATABASE_URL; local scripts/prisma-smoke.js loads dotenv explicitly.
 *
 * Prisma 7 requires either:
 * - accelerateUrl for prisma+postgres / Accelerate URLs (production pooled runtime), or
 * - a driver adapter for direct postgres:// URLs (staging / TCP).
 */

let _prisma = null;
let _initFailed = false;

function prismaConfigured() {
  return !!(process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim());
}

function isAccelerateUrl(url) {
  return url.startsWith('prisma+postgres://')
    || url.startsWith('prisma://')
    || url.includes('accelerate.prisma-data.net');
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
    if (isAccelerateUrl(url)) {
      _prisma = new PrismaClient({ accelerateUrl: url });
    } else if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
      // Direct TCP — Prisma 7 client engine requires a driver adapter.
      const { PrismaPg } = require('@prisma/adapter-pg');
      const adapter = new PrismaPg({ connectionString: url });
      _prisma = new PrismaClient({ adapter });
    } else {
      throw new Error('unsupported_database_url_scheme');
    }
    return _prisma;
  } catch (err) {
    _initFailed = true;
    // Never log the URL — message only.
    const msg = err && err.message ? String(err.message) : String(err);
    console.warn('[prisma] init_failed', msg.split('\n')[0].slice(0, 160));
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
  isAccelerateUrl,
};
