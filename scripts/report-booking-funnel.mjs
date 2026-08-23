#!/usr/bin/env node

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildBookingFunnelReport } = require('../netlify/lib/booking-funnel-report');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const releaseAt = argument('--release-at');
if (!releaseAt) {
  console.error('Usage: node scripts/report-booking-funnel.mjs --release-at <ISO> [--input events.json]');
  process.exitCode = 2;
} else {
  const inputPath = argument('--input');
  const raw = inputPath ? fs.readFileSync(inputPath, 'utf8') : fs.readFileSync(0, 'utf8');
  const parsed = JSON.parse(raw);
  const events = Array.isArray(parsed) ? parsed : parsed.events;
  const report = buildBookingFunnelReport(events, { releaseAt });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
