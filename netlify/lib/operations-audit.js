// Immutable operational audit stream — no secrets or card data.
const crypto = require('crypto');

const AUDIT_STORE = 'cd1-operations-audit';

const REDACT_KEYS = new Set([
  'stripeCustomerId', 'stripePaymentMethodId', 'setupIntentId', 'paymentIntentId',
  'customerSignature', 'technicianSignature', 'passwordHash', 'inviteToken',
  'sessionToken', 'magicLinkToken', 'completionToken',
]);

function redactState(booking) {
  if (!booking || typeof booking !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(booking)) {
    if (REDACT_KEYS.has(k)) continue;
    if (k === 'email' || k === 'phone') {
      out[k] = v ? '[redacted]' : '';
      continue;
    }
    if (typeof v === 'string' && v.length > 500) {
      out[k] = '[truncated]';
      continue;
    }
    out[k] = v;
  }
  return {
    serviceStatus: out.serviceStatus,
    paymentStatus: out.paymentStatus,
    customerApprovalStatus: out.customerApprovalStatus,
    jobStatus: out.jobStatus,
    paymentWorkflowStatus: out.paymentWorkflowStatus,
    approvedFinalAmount: out.approvedFinalAmount,
    totalPrice: out.totalPrice,
    assignedTechId: out.assignedTechId,
    adjustmentStatus: out.adjustmentStatus,
  };
}

async function blobsStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  return (siteID && token) ? getStore({ name, siteID, token }) : getStore(name);
}

function auditEntry({
  bookingId,
  actorType,
  actorId,
  action,
  requestId,
  previousState,
  resultingState,
  reason,
  approvalStatus,
  sourcePortal,
}) {
  return {
    audit_id: 'aud_' + crypto.randomBytes(10).toString('hex'),
    booking_id: bookingId,
    actor_type: actorType,
    actor_id: String(actorId || 'system').slice(0, 80),
    action: String(action || '').slice(0, 80),
    request_id: requestId || crypto.randomBytes(8).toString('hex'),
    previous_state: redactState(previousState),
    resulting_state: redactState(resultingState),
    reason: String(reason || '').slice(0, 500),
    timestamp: new Date().toISOString(),
    approval_status: approvalStatus || '',
    source_portal: sourcePortal || '',
  };
}

async function appendAudit(entry) {
  const store = await blobsStore(AUDIT_STORE);
  const key = `${entry.booking_id}/${entry.timestamp}_${entry.audit_id}`;
  await store.setJSON(key, entry);
  return entry;
}

async function listAuditForBooking(bookingId, limit = 100) {
  const store = await blobsStore(AUDIT_STORE);
  const listing = await store.list({ prefix: `${bookingId}/` });
  const blobs = (listing && listing.blobs) || [];
  const rows = await Promise.all(
    blobs.slice(-limit).map((b) => store.get(b.key, { type: 'json' }).catch(() => null))
  );
  return rows.filter(Boolean).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

module.exports = {
  AUDIT_STORE,
  auditEntry,
  appendAudit,
  listAuditForBooking,
  redactState,
};
