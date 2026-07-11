// Branch-only My Garage QA fixture helpers — never enabled in production.

const { blobsStore } = require('./tech-security');
const { bookingStore, getBooking } = require('./ops-db');
const { BOOKINGS_STORE } = require('./ops-schema');
const { VEHICLE_STORE } = require('./customer-vehicles');
const { REQUEST_STORE } = require('./customer-change-requests');

const SESSION_STORE = 'cd1-customer-sessions';
const TOKEN_STORE = 'cd1-customer-auth-tokens';

const QA_BRANCH = 'customer-my-garage-portal';
const QA_PREFIX = 'QA-MYGARAGE-';
const BOOKING_A_ID = 'QA-MYGARAGE-A';
const BOOKING_B_ID = 'QA-MYGARAGE-B';
const MANIFEST_KEY = 'qa-manifest-customer-my-garage-portal';
const MANIFEST_STORE = 'cd1-qa-my-garage-fixtures';
const QA_TTL_MS = 24 * 60 * 60 * 1000;
const INERT_PAY_BASE = 'https://qa-inert.cardetail1-branch.local/pay/';

const PHONE_A = '2025550101';
const PHONE_B = '2025550102';

function stripeMode() {
  const secret = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (secret.startsWith('sk_test_')) return 'test';
  if (secret.startsWith('sk_live_')) return 'live';
  return 'none';
}

function resolveQaBranch() {
  const branch = String(process.env.BRANCH || process.env.HEAD || '').trim();
  if (branch === QA_BRANCH) return true;
  const prime = String(process.env.DEPLOY_PRIME_URL || process.env.URL || '').toLowerCase();
  return prime.includes('customer-my-garage-portal--');
}

function isHarnessEnabled() {
  const ctx = String(process.env.CONTEXT || '').toLowerCase();
  if (ctx === 'production') return false;
  if (!resolveQaBranch()) return false;
  const flag = String(process.env.MY_GARAGE_QA_ENABLED || '').trim();
  if (flag === 'true') return true;
  const prime = String(process.env.DEPLOY_PRIME_URL || process.env.URL || '').toLowerCase();
  return prime.includes('customer-my-garage-portal--');
}

function isAllowedQaBookingId(id) {
  const s = String(id || '').trim().toUpperCase();
  return s.startsWith(QA_PREFIX);
}

function isAllowedQaBooking(record) {
  if (!record || typeof record !== 'object') return false;
  const id = String(record.id || record.bookingId || '').trim().toUpperCase();
  return (
    record.qaFixture === true &&
    record.qaBranch === QA_BRANCH &&
    isAllowedQaBookingId(id)
  );
}

function qaEmailsFromEnv() {
  const a = String(process.env.MY_GARAGE_QA_EMAIL_A || '').trim().toLowerCase();
  const b = String(process.env.MY_GARAGE_QA_EMAIL_B || '').trim().toLowerCase();
  return { emailA: a, emailB: b };
}

function buildBookingA(emailA, now, expiresAt) {
  return {
    id: BOOKING_A_ID,
    bookingId: BOOKING_A_ID,
    isDraft: false,
    isTest: true,
    qaFixture: true,
    qaBranch: QA_BRANCH,
    qaCreatedAt: now,
    qaExpiresAt: expiresAt,
    excludeFromReporting: true,
    suppressRecovery: true,
    suppressHubspot: true,
    suppressMarketing: true,
    firstName: 'QA',
    lastName: 'Customer Alpha',
    email: emailA,
    phone: PHONE_A,
    customerPhone: PHONE_A,
    status: 'Confirmed',
    jobStatus: 'confirmed',
    appointmentStatus: 'confirmed',
    package: 'Interior Detail',
    service: 'Interior Detail',
    packageId: 'interior',
    vehicle: 'QA Sedan',
    vehicleLabel: '2024 QA Sedan',
    vehicles: [{ vehicleLabel: '2024 QA Sedan', pkgName: 'Interior Detail', subtotal: 225 }],
    preferredDate: '2026-08-15',
    preferredTime: '10:00 AM',
    confirmedDate: '2026-08-15',
    confirmedTime: '10:00 AM',
    address: '100 QA Fixture Lane, Testville, NJ 07650',
    zipCode: '07650',
    zone: 'bergen',
    totalPrice: 225,
    cardOnFileStatus: 'saved',
    customerChangePending: false,
    createdAt: now,
    updatedAt: now,
    eventLog: [{ action: 'qa_fixture_seed', at: now, by: 'qa-harness' }],
  };
}

function buildBookingB(emailB, now, expiresAt, payLink) {
  return {
    id: BOOKING_B_ID,
    bookingId: BOOKING_B_ID,
    isDraft: false,
    isTest: true,
    qaFixture: true,
    qaBranch: QA_BRANCH,
    qaCreatedAt: now,
    qaExpiresAt: expiresAt,
    excludeFromReporting: true,
    suppressRecovery: true,
    suppressHubspot: true,
    suppressMarketing: true,
    firstName: 'QA',
    lastName: 'Customer Beta',
    email: emailB,
    phone: PHONE_B,
    customerPhone: PHONE_B,
    status: 'Completed',
    jobStatus: 'completed_pending_payment',
    appointmentStatus: 'payment due',
    paymentWorkflowStatus: 'awaiting_customer_payment',
    package: 'Premium Detail',
    service: 'Premium Detail',
    packageId: 'full',
    vehicle: 'QA SUV',
    vehicleLabel: '2023 QA SUV',
    vehicles: [{ vehicleLabel: '2023 QA SUV', pkgName: 'Premium Detail', subtotal: 300 }],
    preferredDate: '2026-07-01',
    preferredTime: '2:00 PM',
    confirmedDate: '2026-07-01',
    confirmedTime: '2:00 PM',
    address: '200 QA Branch Street, Sampletown, NJ 07660',
    zipCode: '07660',
    zone: 'bergen',
    totalPrice: 300,
    amountDueApproved: 75,
    balanceDue: 75,
    payLink,
    qaInertPayLink: true,
    cardOnFileStatus: 'saved',
    customerChangePending: false,
    createdAt: now,
    updatedAt: now,
    eventLog: [{ action: 'qa_fixture_seed', at: now, by: 'qa-harness' }],
  };
}

function buildVehiclesA(now) {
  return [{
    id: 'cv_qa_a_primary',
    label: '2024 QA Sedan',
    category: 'sedan',
    make: 'QA',
    model: 'Sedan',
    year: '2024',
    archived: false,
    qaFixture: true,
    createdAt: now,
    updatedAt: now,
  }];
}

function buildVehiclesB(now) {
  return [
    {
      id: 'cv_qa_b_one',
      label: '2023 QA SUV',
      category: 'suv',
      make: 'QA',
      model: 'SUV',
      year: '2023',
      archived: false,
      qaFixture: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'cv_qa_b_two',
      label: '2022 QA Truck',
      category: 'truck',
      make: 'QA',
      model: 'Truck',
      year: '2022',
      archived: false,
      qaFixture: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

async function manifestStore() {
  return blobsStore(MANIFEST_STORE);
}

async function readManifest() {
  const store = await manifestStore();
  return store.get(MANIFEST_KEY, { type: 'json' }).catch(() => null);
}

async function writeManifest(manifest) {
  const store = await manifestStore();
  await store.setJSON(MANIFEST_KEY, manifest);
}

async function seedFixtures() {
  const { emailA, emailB } = qaEmailsFromEnv();
  if (!emailA || !emailB || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailA) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailB)) {
    return { ok: false, error: 'validation_error', message: 'Branch QA emails are not configured.' };
  }
  if (emailA === emailB) {
    return { ok: false, error: 'validation_error', message: 'QA emails must be distinct.' };
  }

  const mode = stripeMode();
  const payLink = `${INERT_PAY_BASE}${BOOKING_B_ID}?mode=${mode === 'test' ? 'test' : 'inert'}&qa=1`;

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + QA_TTL_MS).toISOString();
  const bookingA = buildBookingA(emailA, now, expiresAt);
  const bookingB = buildBookingB(emailB, now, expiresAt, payLink);

  const bStore = await bookingStore();
  await bStore.setJSON(BOOKING_A_ID, bookingA);
  await bStore.setJSON(BOOKING_B_ID, bookingB);

  const vStore = await blobsStore(VEHICLE_STORE);
  await vStore.setJSON(`owner_${PHONE_A}`, {
    phoneDigits: PHONE_A,
    vehicles: buildVehiclesA(now),
    qaFixture: true,
    qaBranch: QA_BRANCH,
    updatedAt: now,
  });
  await vStore.setJSON(`owner_${PHONE_B}`, {
    phoneDigits: PHONE_B,
    vehicles: buildVehiclesB(now),
    qaFixture: true,
    qaBranch: QA_BRANCH,
    updatedAt: now,
  });

  const manifest = {
    qaFixture: true,
    qaBranch: QA_BRANCH,
    bookingIds: [BOOKING_A_ID, BOOKING_B_ID],
    phoneDigits: [PHONE_A, PHONE_B],
    qaCreatedAt: now,
    qaExpiresAt: expiresAt,
    stripeModeObserved: mode,
    stripeCheckoutExercised: false,
    emailsConfigured: true,
  };
  await writeManifest(manifest);

  return {
    ok: true,
    seeded: 2,
    bookingIds: [BOOKING_A_ID, BOOKING_B_ID],
    qaExpiresAt: expiresAt,
    stripeMode: mode,
    stripeCheckoutExercised: false,
    recoveryJobsCreated: 0,
    marketingJobsCreated: 0,
    hubspotSyncTriggered: false,
  };
}

async function inspectFixtures() {
  const manifest = await readManifest();
  const out = {
    ok: true,
    manifestPresent: !!manifest,
    bookingIds: [],
    expired: [],
    stripeMode: stripeMode(),
  };

  for (const id of [BOOKING_A_ID, BOOKING_B_ID]) {
    const booking = await getBooking(id);
    if (!isAllowedQaBooking(booking)) continue;
    out.bookingIds.push({
      id,
      status: booking.status,
      qaExpiresAt: booking.qaExpiresAt,
      hasPayLink: !!booking.payLink,
      qaInertPayLink: !!booking.qaInertPayLink,
    });
    if (booking.qaExpiresAt && Date.parse(booking.qaExpiresAt) < Date.now()) {
      out.expired.push(id);
    }
  }

  const reqStore = await blobsStore(REQUEST_STORE);
  const { blobs: reqBlobs } = await reqStore.list({ prefix: 'cr_' });
  let qaRequestCount = 0;
  for (const b of (reqBlobs || []).slice(0, 200)) {
    const rec = await reqStore.get(b.key, { type: 'json' }).catch(() => null);
    if (rec && isAllowedQaBookingId(rec.bookingId)) qaRequestCount += 1;
  }
  out.changeRequestCount = qaRequestCount;

  return out;
}

async function cleanupFixtures() {
  const manifest = await readManifest();
  const ids = manifest?.bookingIds || [BOOKING_A_ID, BOOKING_B_ID];
  const phones = manifest?.phoneDigits || [PHONE_A, PHONE_B];

  let deletedBookings = 0;
  const bStore = await bookingStore();
  for (const id of ids) {
    if (!isAllowedQaBookingId(id)) continue;
    const booking = await getBooking(id);
    if (!isAllowedQaBooking(booking)) continue;
    await bStore.delete(id);
    deletedBookings += 1;
  }

  const vStore = await blobsStore(VEHICLE_STORE);
  for (const phone of phones) {
    const key = `owner_${phone}`;
    const data = await vStore.get(key, { type: 'json' }).catch(() => null);
    if (data?.qaFixture === true && data?.qaBranch === QA_BRANCH) {
      await vStore.delete(key);
    }
  }

  const reqStore = await blobsStore(REQUEST_STORE);
  const { blobs: reqBlobs } = await reqStore.list({ prefix: 'cr_' });
  let deletedRequests = 0;
  for (const b of (reqBlobs || [])) {
    const rec = await reqStore.get(b.key, { type: 'json' }).catch(() => null);
    if (rec && isAllowedQaBookingId(rec.bookingId)) {
      await reqStore.delete(b.key);
      deletedRequests += 1;
    }
  }

  const sessStore = await blobsStore(SESSION_STORE);
  const { blobs: sessBlobs } = await sessStore.list({ prefix: 'cs_' });
  let deletedSessions = 0;
  for (const b of (sessBlobs || [])) {
    const rec = await sessStore.get(b.key, { type: 'json' }).catch(() => null);
    if (rec?.bookingIds?.some((x) => isAllowedQaBookingId(x))) {
      await sessStore.delete(b.key);
      deletedSessions += 1;
    }
  }

  const tokStore = await blobsStore(TOKEN_STORE);
  const { blobs: tokBlobs } = await tokStore.list({ prefix: 'auth_' });
  let deletedTokens = 0;
  const { emailA, emailB } = qaEmailsFromEnv();
  for (const b of (tokBlobs || [])) {
    const rec = await tokStore.get(b.key, { type: 'json' }).catch(() => null);
    if (rec?.email && (rec.email === emailA || rec.email === emailB)) {
      await tokStore.delete(b.key);
      deletedTokens += 1;
    }
  }

  const mStore = await manifestStore();
  await mStore.delete(MANIFEST_KEY).catch(() => {});

  return {
    ok: true,
    deletedBookings,
    deletedRequests,
    deletedSessions,
    deletedTokens,
    stripeCheckoutExercised: false,
  };
}

module.exports = {
  QA_BRANCH,
  QA_PREFIX,
  BOOKING_A_ID,
  BOOKING_B_ID,
  QA_TTL_MS,
  PHONE_A,
  PHONE_B,
  stripeMode,
  isHarnessEnabled,
  isAllowedQaBookingId,
  isAllowedQaBooking,
  qaEmailsFromEnv,
  seedFixtures,
  inspectFixtures,
  cleanupFixtures,
  buildBookingA,
  buildBookingB,
  MANIFEST_STORE,
  BOOKINGS_STORE,
};
