const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
process.env.ADMIN_DASH_PASSWORD = 'admin-test-password';
global.__CD1_TEST_STORES = {};

const accounts = require('../netlify/functions/tech-accounts').handler;
const auth = require('../netlify/functions/tech-auth').handler;
const assignment = require('../netlify/functions/tech-assignment').handler;
const jobs = require('../netlify/functions/tech-jobs').handler;
const adminAuth = require('../netlify/functions/admin-auth').handler;

const adminHeaders = { 'x-admin-key': process.env.ADMIN_DASH_PASSWORD };
const event = (method, body, headers = {}) => ({
  httpMethod: method,
  headers,
  body: body === undefined ? undefined : JSON.stringify(body),
  queryStringParameters: {},
});
const parse = response => ({ ...response, json: JSON.parse(response.body || '{}') });

let tech;
let invite;
let token;

test('admin login works', async () => {
  const response = parse(await adminAuth(event('POST', { password: process.env.ADMIN_DASH_PASSWORD })));
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.ok, true);
});

test('admin creates technician and receives a 72-hour invite without passwordHash exposure', async () => {
  const response = parse(await accounts(event('POST', {
    action: 'create', fullName: 'Taylor Operator', email: 'taylor@example.com',
    phone: '2015550101', serviceArea: 'Bergen County', capabilities: ['Auto', 'RV'],
  }, adminHeaders)));
  assert.equal(response.statusCode, 201);
  tech = response.json.technician;
  invite = response.json.inviteToken;
  assert.ok(tech.techId);
  assert.ok(invite);
  assert.ok(Date.parse(tech.inviteExpiresAt) - Date.now() > 71 * 60 * 60 * 1000);
  assert.equal('passwordHash' in tech, false);
  const listed = parse(await accounts(event('GET', undefined, adminHeaders)));
  assert.equal(listed.json.technicians.length, 1);
  assert.equal('passwordHash' in listed.json.technicians[0], false);
});

test('technician sets password; invite is single-use', async () => {
  const first = parse(await auth(event('POST', { action: 'set_password', inviteToken: invite, password: 'secure-password-123' })));
  assert.equal(first.statusCode, 200);
  const second = parse(await auth(event('POST', { action: 'set_password', inviteToken: invite, password: 'another-secure-password' })));
  assert.equal(second.statusCode, 400);
  assert.equal(second.json.error, 'invalid_or_used_invite');
});

test('expired invite fails', async () => {
  const created = parse(await accounts(event('POST', {
    action: 'create', fullName: 'Expired Invite', email: 'expired@example.com',
  }, adminHeaders)));
  const store = global.__CD1_TEST_STORES['cd1-tech-accounts'];
  const record = store.get(created.json.technician.techId);
  record.inviteExpiresAt = new Date(Date.now() - 1000).toISOString();
  store.set(record.techId, record);
  const response = parse(await auth(event('POST', {
    action: 'set_password', inviteToken: created.json.inviteToken, password: 'secure-password-123',
  })));
  assert.equal(response.statusCode, 400);
  assert.equal(response.json.error, 'invite_expired');
});

test('technician logs in and sees no jobs before assignment', async () => {
  const response = parse(await auth(event('POST', {
    action: 'login', email: 'taylor@example.com', password: 'secure-password-123',
  })));
  assert.equal(response.statusCode, 200);
  token = response.json.token;
  const list = parse(await jobs(event('GET', undefined, { authorization: `Bearer ${token}` })));
  assert.deepEqual(list.json.jobs, []);
});

test('admin deactivates/reactivates technician and inactive login is rejected', async () => {
  const off = parse(await accounts(event('POST', { action: 'deactivate', techId: tech.techId }, adminHeaders)));
  assert.equal(off.json.technician.active, false);
  const rejected = parse(await auth(event('POST', {
    action: 'login', email: 'taylor@example.com', password: 'secure-password-123',
  })));
  assert.equal(rejected.statusCode, 403);
  const on = parse(await accounts(event('POST', { action: 'reactivate', techId: tech.techId }, adminHeaders)));
  assert.equal(on.json.technician.active, true);
  const login = parse(await auth(event('POST', {
    action: 'login', email: 'taylor@example.com', password: 'secure-password-123',
  })));
  token = login.json.token;
});

test('admin assigns booking and technician sees only own safe job payload', async () => {
  const bookings = global.__CD1_TEST_STORES['cd1-bookings'] = new Map();
  bookings.set('CD1-OWN', {
    id: 'CD1-OWN', firstName: 'Jordan', lastName: 'Customer', phone: '2015550199',
    address: '10 Main St', vehicle: '2024 Honda Odyssey', package: 'Premium Detail',
    addons: [{ name: 'Pet Hair', price: 95 }], notes: 'Gate code 1234',
    totalPrice: 309, packagePrice: 309, paymentStatus: 'no_payment_required_yet',
    cardOnFileStatus: 'saved', stripeCustomerId: 'cus_secret', setupIntentId: 'seti_secret',
    paymentIntentId: 'pi_secret', amountAuthorizedCents: 5000, adminNotes: 'private',
  });
  bookings.set('CD1-OTHER', { id: 'CD1-OTHER', firstName: 'Other', totalPrice: 999 });
  const assigned = parse(await assignment(event('POST', {
    action: 'assign', bookingId: 'CD1-OWN', techId: tech.techId,
  }, adminHeaders)));
  assert.equal(assigned.statusCode, 200);
  assert.equal(assigned.json.booking.jobStatus, 'assigned');
  const list = parse(await jobs(event('GET', undefined, { authorization: `Bearer ${token}` })));
  assert.equal(list.json.jobs.length, 1);
  assert.equal(list.json.jobs[0].id, 'CD1-OWN');
  const serialized = JSON.stringify(list.json.jobs[0]);
  for (const field of [
    'stripeCustomerId', 'paymentMethodId', 'setupIntentId', 'paymentIntentId',
    'amountAuthorizedCents', 'amountCapturedCents', 'cardOnFileStatus',
    'paymentStatus', 'adminNotes', 'totalPrice', 'packagePrice',
  ]) assert.equal(serialized.includes(field), false);
});

test('technician cannot see or update another technician job', async () => {
  const bookings = global.__CD1_TEST_STORES['cd1-bookings'];
  bookings.set('CD1-OTHER', { id: 'CD1-OTHER', assignedTechId: 'TECH-SOMEONE-ELSE', jobStatus: 'assigned' });
  const response = parse(await jobs(event('POST', {
    bookingId: 'CD1-OTHER', jobStatus: 'accepted',
  }, { authorization: `Bearer ${token}` })));
  assert.equal(response.statusCode, 403);
});

test('technician status lifecycle persists and admin can observe it', async () => {
  for (const status of ['accepted', 'en_route', 'completed']) {
    const response = parse(await jobs(event('POST', {
      bookingId: 'CD1-OWN', jobStatus: status,
    }, { authorization: `Bearer ${token}` })));
    assert.equal(response.statusCode, 200);
    assert.equal(response.json.job.jobStatus, status);
  }
  const stored = global.__CD1_TEST_STORES['cd1-bookings'].get('CD1-OWN');
  assert.equal(stored.jobStatus, 'completed');
  assert.equal(stored.technicianId, tech.techId);
  assert.ok(stored.eventLog.some(item => item.jobStatus === 'completed'));
});

test('technician cannot change price, mark paid, self-assign, or access admin endpoints', async () => {
  const headers = { authorization: `Bearer ${token}` };
  const price = parse(await jobs(event('POST', {
    bookingId: 'CD1-OWN', jobStatus: 'accepted', totalPrice: 1,
  }, headers)));
  assert.equal(price.statusCode, 400);
  assert.equal(price.json.error, 'field_not_allowed');
  const paid = parse(await jobs(event('POST', { bookingId: 'CD1-OWN', jobStatus: 'paid' }, headers)));
  assert.equal(paid.statusCode, 400);
  const adminEndpoint = parse(await accounts(event('GET', undefined, { 'x-tech-token': token })));
  assert.equal(adminEndpoint.statusCode, 401);
  const portal = fs.readFileSync(path.join(root, 'technician.html'), 'utf8');
  assert.doesNotMatch(portal, /data-tt="avail">Available Jobs/);
  assert.match(portal, /Only jobs assigned to your secure technician account/);
});

test('invalid technician token fails', async () => {
  const response = parse(await jobs(event('GET', undefined, { authorization: 'Bearer invalid' })));
  assert.equal(response.statusCode, 401);
});

test('scope guard: no payment, Stripe, webhook, homepage, or public design files changed', () => {
  const { execFileSync } = require('node:child_process');
  const changed = execFileSync('git', ['diff', '--name-only'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.equal(changed.some(file => /stripe|payment|webhook|create-setup-intent|index\.html|customer\.html/i.test(file)), false);
});
