/**
 * Prisma Client singleton for Netlify functions.
 * Uses DATABASE_URL (Accelerate prisma+postgres:// or direct postgres://).
 * Ops still use Netlify Blobs — wired for gradual adoption only.
 */
require('dotenv').config();

const { PrismaClient } = require('@prisma/client');

let _prisma = null;

function getPrisma() {
  if (_prisma) return _prisma;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  // Prisma Postgres Accelerate URL
  if (url.startsWith('prisma+postgres://') || url.includes('accelerate.prisma-data.net')) {
    _prisma = new PrismaClient({
      accelerateUrl: url,
    });
  } else {
    _prisma = new PrismaClient({
      datasources: { db: { url } },
    });
  }
  return _prisma;
}

module.exports = { getPrisma };
