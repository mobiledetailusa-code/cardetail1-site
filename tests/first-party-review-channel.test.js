'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const lib = require('../netlify/lib/first-party-reviews');
const publicReviews = require('../netlify/functions/public-reviews');
const adminReviews = require('../netlify/functions/admin-reviews');

function memoryStore(seed = {}) {
  const data = Object.assign({}, seed);
  return {
    async get(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    async setJSON(key, value) {
      data[key] = value;
    },
    _data: data,
  };
}

test('4–5 star comments from completed jobs can publish; short or low ratings stay pending', () => {
  assert.equal(lib.publishStatus({ stars: 5, comment: 'The car looks brand new after the detail.' }), 'approved');
  assert.equal(lib.publishStatus({ stars: 4, comment: 'Very thorough and on time today.' }), 'approved');
  assert.equal(lib.publishStatus({ stars: 5, comment: 'Nice' }), 'pending_moderation');
  assert.equal(lib.publishStatus({ stars: 3, comment: 'The car looks brand new after the detail.' }), 'pending_moderation');
});

test('public cards use first name plus last initial and never include booking identity', () => {
  assert.equal(lib.displayName('Ada', 'Lovelace'), 'Ada L.');
  const card = lib.cardFromBookingReview(
    { id: 'REV-1', stars: 5, comment: 'The interior looks brand new after the visit.', createdAt: '2026-08-24T12:00:00.000Z' },
    { firstName: 'Ada', lastName: 'Lovelace', phone: '5513132956', email: 'ada@example.com', city: 'Palisades Park', vehicles: [{ pkgName: 'Interior Detail' }] },
  );
  assert.equal(card.name, 'Ada L.');
  assert.equal(card.service, 'Interior Detail');
  assert.equal(card.location, 'Palisades Park');
  assert.equal(card.source, 'cardetail1');
  assert.doesNotMatch(JSON.stringify(card), /5513132956|ada@example.com|bookingId/);
});

test('homepage index dedupes the same quote and drops empty bodies', () => {
  const first = lib.toPublicCard({
    id: 'REV-1',
    displayName: 'Ada L.',
    stars: 5,
    comment: 'The interior looks brand new after the visit.',
    createdAt: '2026-08-24T12:00:00.000Z',
  });
  const dup = lib.toPublicCard({
    id: 'REV-2',
    displayName: 'Other P.',
    stars: 5,
    comment: 'The interior looks brand new after the visit.',
    createdAt: '2026-08-25T12:00:00.000Z',
  });
  const merged = lib.mergeHomepageIndex([first], dup);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'REV-2');
  assert.equal(lib.mergeHomepageIndex([first], { id: 'REV-3', name: 'X', rating: 5, text: '' }).length, 1);
});

test('public-reviews returns only homepage index cards and never PII', async () => {
  const store = memoryStore({
    'homepage-index': [{
      id: 'REV-1',
      name: 'Ada L.',
      rating: 5,
      text: 'The interior looks brand new after the visit.',
      location: 'Palisades Park',
      date: 'Aug 2026',
      service: 'Interior Detail',
      source: 'cardetail1',
      createdAt: '2026-08-24T12:00:00.000Z',
    }],
  });
  publicReviews.__test.setStoreOverride(() => store);
  try {
    const res = await publicReviews.handler({ httpMethod: 'GET', headers: {} });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].name, 'Ada L.');
    assert.doesNotMatch(res.body, /phone|email|bookingId/i);
  } finally {
    publicReviews.__test.setStoreOverride(null);
  }
});

test('admin hide removes a card from the public homepage index', async () => {
  const store = memoryStore({
    'REV-1': {
      id: 'REV-1',
      status: 'approved',
      stars: 5,
      comment: 'The interior looks brand new after the visit.',
      displayName: 'Ada L.',
    },
    'homepage-index': [{
      id: 'REV-1',
      name: 'Ada L.',
      rating: 5,
      text: 'The interior looks brand new after the visit.',
      createdAt: '2026-08-24T12:00:00.000Z',
    }],
  });
  adminReviews.__test.setStoreOverride(() => store);
  adminReviews.__test.setVerifyOverride(async () => ({ ok: true }));
  try {
    const res = await adminReviews.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ action: 'hide', id: 'REV-1' }),
    });
    assert.equal(res.statusCode, 200);
    const listed = await lib.readHomepageIndex(store);
    assert.equal(listed.length, 0);
    assert.equal(store._data['REV-1'].status, 'hidden');
  } finally {
    adminReviews.__test.setStoreOverride(null);
    adminReviews.__test.setVerifyOverride(null);
  }
});

test('admin publish moves a pending written review onto the homepage', async () => {
  const store = memoryStore({
    'REV-9': {
      id: 'REV-9',
      status: 'pending_moderation',
      stars: 5,
      comment: 'On time and the paint looks new again.',
      displayName: 'Craig B.',
      location: 'Craryville, NY',
      service: 'Exterior Detail',
      createdAt: '2026-08-24T12:00:00.000Z',
    },
    'moderation-queue': ['REV-9'],
    'homepage-index': [],
  });
  adminReviews.__test.setStoreOverride(() => store);
  adminReviews.__test.setVerifyOverride(async () => ({ ok: true }));
  try {
    const res = await adminReviews.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ action: 'publish', id: 'REV-9' }),
    });
    assert.equal(res.statusCode, 200);
    const listed = await lib.readHomepageIndex(store);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, 'REV-9');
    assert.equal(store._data['REV-9'].status, 'approved');
    assert.deepEqual(store._data['moderation-queue'], []);
  } finally {
    adminReviews.__test.setStoreOverride(null);
    adminReviews.__test.setVerifyOverride(null);
  }
});

test('admin-reviews rejects unauthenticated access', async () => {
  adminReviews.__test.setVerifyOverride(async () => ({ ok: false, error: 'unauthorized' }));
  try {
    const res = await adminReviews.handler({ httpMethod: 'GET', headers: {} });
    assert.equal(res.statusCode, 401);
  } finally {
    adminReviews.__test.setVerifyOverride(null);
  }
});
