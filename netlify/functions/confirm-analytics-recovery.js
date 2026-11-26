// Scheduled drain for confirmation analytics that the booking commit already
// recorded. The request body cannot choose a booking. Preview deploys do not
// write the shared store. This function does not confirm, charge, or text.

'use strict';

const { recoverPendingConfirmations } = require('../lib/revenue-authoritative-confirm');
const { sharedPreviewContext } = require('../lib/preview-write-guard');

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
  };
}

exports.handler = async () => {
  if (sharedPreviewContext()) {
    return json(200, { ok: true, skipped: true, reason: 'preview', recovered: 0 });
  }
  try {
    const result = await recoverPendingConfirmations({ limit: 20 });
    return json(result.ok ? 200 : 503, result);
  } catch (err) {
    console.warn('[confirm-analytics-recovery]', String(err && err.message || err).slice(0, 120));
    return json(503, { ok: false, recovered: 0, reason: 'recovery_failed' });
  }
};

exports.config = { schedule: '*/15 * * * *' };
