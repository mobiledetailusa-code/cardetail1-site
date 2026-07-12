// Branch-only QA lifecycle harness — operations-core-job-lifecycle deploy only.
const { verifyAdminKey, jsonCors, blobsStore } = require('../lib/tech-security');
const { createAdminAppointment } = require('../lib/admin-booking-mutations');
const { listAuditForBooking } = require('../lib/operations-audit');

const QA_PREFIX = 'QA-OPSCORE';
const OPS_BRANCH = 'operations-core-job-lifecycle';

function isQaBranchDeploy(event) {
  const host = String(
    event.headers?.['x-forwarded-host'] || event.headers?.Host || event.headers?.host || ''
  ).toLowerCase();
  if (host.startsWith(`${OPS_BRANCH}--`)) return true;
  const branch = String(process.env.BRANCH || process.env.COMMIT_REF || '').trim();
  return branch === OPS_BRANCH && String(process.env.CONTEXT || '').toLowerCase() !== 'production';
}

function qaDisabled() {
  return jsonCors(404, { ok: false, error: 'not_found' });
}

async function cleanupQa(store) {
  const { list } = await store.list();
  const blobs = (list && list.blobs) || [];
  let removed = 0;
  for (const b of blobs) {
    if (!String(b.key).startsWith(QA_PREFIX)) continue;
    const rec = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (!rec) continue;
    const created = new Date(rec.createdAt || 0).getTime();
    if (Date.now() - created > 24 * 60 * 60 * 1000) {
      await store.delete(b.key).catch(() => null);
      removed++;
    }
  }
  return removed;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return qaDisabled();
  if (!isQaBranchDeploy(event)) return qaDisabled();

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth.ok) return jsonCors(401, { ok: false, error: 'unauthorized' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const action = String(body.action || '').toLowerCase();
  const store = await blobsStore('cd1-bookings');

  if (action === 'cleanup') {
    const removed = await cleanupQa(store);
    return jsonCors(200, { ok: true, removed });
  }

  if (action === 'seed') {
    const fixtures = [
      {
        id: `${QA_PREFIX}-CUST-A-001`,
        firstName: 'QA Customer A',
        phone: '2015550101',
        email: 'qa-cust-a@example.com',
        zipCode: '07030',
        vehicleCategory: 'cars',
        packageId: 'interior',
        package: 'Interior Detail',
        vehicleTier: 'Small Car',
        vehicles: [{ cat: 'cars', pkgId: 'interior', tierKey: 'small', tierLabel: 'Small Car' }],
        qaFixture: true,
      },
      {
        id: `${QA_PREFIX}-CUST-B-002`,
        firstName: 'QA Customer B',
        phone: '2015550102',
        email: 'invalid-email-format',
        zipCode: '07030',
        vehicleCategory: 'cars',
        packageId: 'full',
        package: 'Premium Full Detail',
        vehicleTier: 'Small Car',
        vehicles: [{ cat: 'cars', pkgId: 'full', tierKey: 'small', tierLabel: 'Small Car' }],
        qaFixture: true,
      },
      {
        id: `${QA_PREFIX}-MULTI-003`,
        firstName: 'QA Multi Vehicle',
        phone: '2015550103',
        email: 'qa-multi@example.com',
        zipCode: '07030',
        vehicleCategory: 'cars',
        packageId: 'interior',
        vehicles: [
          { cat: 'cars', pkgId: 'interior', tierKey: 'small', tierLabel: 'Small Car' },
          { cat: 'cars', pkgId: 'full', tierKey: 'small', tierLabel: 'Small Car' },
        ],
        qaFixture: true,
      },
    ];
    const created = [];
    for (const f of fixtures) {
      const r = await createAdminAppointment(store, f);
      if (r.ok) created.push(r.bookingId);
    }
    return jsonCors(200, { ok: true, created, prefix: QA_PREFIX });
  }

  if (action === 'audit') {
    const bookingId = String(body.bookingId || '');
    if (!bookingId.startsWith(QA_PREFIX)) return jsonCors(400, { ok: false, error: 'invalid_qa_booking' });
    const audit = await listAuditForBooking(bookingId, 50);
    return jsonCors(200, { ok: true, bookingId, audit });
  }

  return jsonCors(400, { ok: false, error: 'unknown_action' });
};

exports.__test = { isQaBranchDeploy, QA_PREFIX };
