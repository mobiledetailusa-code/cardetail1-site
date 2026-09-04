// Public endpoint IP rate limiting — unit tests with mocked Blobs + time.
const { test, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const RATE_LIMIT_PATH = require.resolve('../netlify/lib/public-rate-limit');

function loadRateLimit() {
  delete require.cache[RATE_LIMIT_PATH];
  delete require.cache[require.resolve('../netlify/lib/admin-security')];
  return require('../netlify/lib/public-rate-limit');
}

function getRateLimit() {
  const rl = loadRateLimit();
  rl.setPublicRateLimitStoreFactory(() => memoryStore);
  return rl;
}

function makeEvent(ip, method = 'POST', body = '{}') {
  const headers = {};
  if (ip !== null && ip !== undefined) {
    headers['x-forwarded-for'] = ip;
  }
  return { httpMethod: method, headers, body };
}

function createConditionalMemoryStore() {
  const data = new Map();
  let etagCounter = 0;

  return {
    data,
    async getWithMetadata(key, { type, consistency } = {}) {
      if (!data.has(key)) return null;
      const entry = data.get(key);
      const parsed = type === 'json' ? JSON.parse(entry.value) : entry.value;
      return { data: parsed, etag: entry.etag, metadata: {}, consistency };
    },
    async setJSON(key, value, options = {}) {
      const exists = data.has(key);
      if (options.onlyIfNew) {
        if (exists) return { modified: false };
      }
      if (options.onlyIfMatch) {
        if (!exists || data.get(key).etag !== options.onlyIfMatch) {
          return { modified: false };
        }
      }
      const etag = `etag-${++etagCounter}`;
      data.set(key, { value: JSON.stringify(value), etag });
      return { modified: true, etag };
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

function createAlwaysConflictStore() {
  const inner = createConditionalMemoryStore();
  return {
    async getWithMetadata(key, opts) {
      return inner.getWithMetadata(key, opts);
    },
    async setJSON(key, value, options = {}) {
      if (options.onlyIfNew || options.onlyIfMatch) {
        return { modified: false };
      }
      return inner.setJSON(key, value, options);
    },
  };
}

function createNaiveMemoryStore() {
  const data = new Map();
  return {
    data,
    async getWithMetadata(key, { type } = {}) {
      if (!data.has(key)) return null;
      const value = data.get(key);
      return {
        data: type === 'json' ? JSON.parse(value) : value,
        etag: 'static-etag',
        metadata: {},
      };
    },
    async setJSON(key, value) {
      data.set(key, JSON.stringify(value));
      return { modified: true, etag: 'static-etag' };
    },
  };
}

let memoryStore;
const ENV_PREFIX = 'PUBLIC_RATE_LIMIT_';
let envSnap = {};

beforeEach(() => {
  envSnap = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(ENV_PREFIX)) envSnap[key] = process.env[key];
  }
  for (const key of Object.keys(envSnap)) delete process.env[key];

  memoryStore = createConditionalMemoryStore();
  getRateLimit();
});

afterEach(() => {
  const rl = loadRateLimit();
  rl.resetPublicRateLimitStoreFactory();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(ENV_PREFIX)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(envSnap)) {
    process.env[key] = value;
  }
  delete require.cache[RATE_LIMIT_PATH];
});

test('requests below the limit are allowed', async () => {
  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_MAX = '3';
  const rl = getRateLimit();
  const event = makeEvent('203.0.113.10');

  const first = await rl.checkPublicRateLimit(event, { endpoint: 'lookup-booking', now: 1_000_000 });
  const second = await rl.checkPublicRateLimit(event, { endpoint: 'lookup-booking', now: 1_000_100 });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 1);
});

test('the threshold request is handled consistently', async () => {
  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_MAX = '2';
  const rl = getRateLimit();
  const event = makeEvent('203.0.113.11');
  const now = 2_000_000;

  const r1 = await rl.checkPublicRateLimit(event, { endpoint: 'lookup-booking', now });
  const r2 = await rl.checkPublicRateLimit(event, { endpoint: 'lookup-booking', now: now + 1 });
  const r3 = await rl.checkPublicRateLimit(event, { endpoint: 'lookup-booking', now: now + 2 });

  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
  assert.equal(r2.remaining, 0);
  assert.equal(r3.allowed, false);
});

test('requests above the limit return 429 via enforcePublicRateLimit', async () => {
  process.env.PUBLIC_RATE_LIMIT_SUBMIT_INQUIRY_MAX = '1';
  const rl = getRateLimit();
  const event = makeEvent('203.0.113.12');
  const now = 3_000_000;

  await rl.enforcePublicRateLimit(event, { endpoint: 'submit-inquiry', now });
  const blocked = await rl.enforcePublicRateLimit(event, { endpoint: 'submit-inquiry', now: now + 1 });

  assert.equal(blocked.blocked, true);
  assert.equal(blocked.response.statusCode, 429);
  const body = JSON.parse(blocked.response.body);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'rate_limited');
});

test('retryAfterSec is positive and reasonable', async () => {
  process.env.PUBLIC_RATE_LIMIT_CREATE_SETUP_INTENT_MAX = '1';
  const rl = getRateLimit();
  const event = makeEvent('203.0.113.13');
  const now = 4_000_000;
  const windowMs = rl.getLimitConfig('create-setup-intent').windowMs;

  await rl.checkPublicRateLimit(event, { endpoint: 'create-setup-intent', now });
  const blocked = await rl.checkPublicRateLimit(event, { endpoint: 'create-setup-intent', now: now + 5 });

  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec > 0);
  assert.ok(blocked.retryAfterSec <= Math.ceil(windowMs / 1000));
});

test('Retry-After header is present on 429 response', async () => {
  process.env.PUBLIC_RATE_LIMIT_AI_CHAT_MAX = '1';
  const rl = getRateLimit();
  const event = makeEvent('203.0.113.14');
  const now = 5_000_000;

  await rl.enforcePublicRateLimit(event, { endpoint: 'ai-chat', now });
  const blocked = await rl.enforcePublicRateLimit(event, { endpoint: 'ai-chat', now: now + 1 });

  assert.match(blocked.response.headers['Retry-After'], /^\d+$/);
  assert.equal(blocked.response.headers['Cache-Control'], 'no-store');
});

test('window expiration resets the counter', async () => {
  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_MAX = '1';
  const rl = getRateLimit();
  const event = makeEvent('203.0.113.15');
  const now = 6_000_000;
  const windowMs = rl.getLimitConfig('lookup-booking').windowMs;

  await rl.checkPublicRateLimit(event, { endpoint: 'lookup-booking', now });
  const blocked = await rl.checkPublicRateLimit(event, { endpoint: 'lookup-booking', now: now + 1 });
  assert.equal(blocked.allowed, false);

  const afterWindow = await rl.checkPublicRateLimit(event, {
    endpoint: 'lookup-booking',
    now: now + windowMs + 1,
  });
  assert.equal(afterWindow.allowed, true);
  assert.equal(afterWindow.remaining, 0);
});

test('different IPs have independent limits', async () => {
  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_MAX = '1';
  const rl = getRateLimit();
  const now = 7_000_000;

  await rl.checkPublicRateLimit(makeEvent('203.0.113.20'), { endpoint: 'lookup-booking', now });
  const blockedSame = await rl.checkPublicRateLimit(makeEvent('203.0.113.20'), { endpoint: 'lookup-booking', now: now + 1 });
  const allowedOther = await rl.checkPublicRateLimit(makeEvent('203.0.113.21'), { endpoint: 'lookup-booking', now: now + 1 });

  assert.equal(blockedSame.allowed, false);
  assert.equal(allowedOther.allowed, true);
});

test('different endpoints have independent buckets', async () => {
  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_MAX = '1';
  process.env.PUBLIC_RATE_LIMIT_SUBMIT_INQUIRY_MAX = '1';
  const rl = getRateLimit();
  const event = makeEvent('203.0.113.22');
  const now = 8_000_000;

  await rl.checkPublicRateLimit(event, { endpoint: 'lookup-booking', now });
  const blockedLookup = await rl.checkPublicRateLimit(event, { endpoint: 'lookup-booking', now: now + 1 });
  const allowedInquiry = await rl.checkPublicRateLimit(event, { endpoint: 'submit-inquiry', now: now + 1 });

  assert.equal(blockedLookup.allowed, false);
  assert.equal(allowedInquiry.allowed, true);
});

test('submit-booking draft and finalize have independent buckets', async () => {
  process.env.PUBLIC_RATE_LIMIT_SUBMIT_BOOKING_DRAFT_MAX = '1';
  process.env.PUBLIC_RATE_LIMIT_SUBMIT_BOOKING_FINALIZE_MAX = '1';
  const rl = getRateLimit();
  const ip = '203.0.113.23';
  const now = 9_000_000;

  await rl.checkPublicRateLimit(makeEvent(ip), {
    endpoint: 'submit-booking',
    action: 'draft',
    now,
  });
  const blockedDraft = await rl.checkPublicRateLimit(makeEvent(ip), {
    endpoint: 'submit-booking',
    action: 'draft',
    now: now + 1,
  });
  const allowedFinalize = await rl.checkPublicRateLimit(makeEvent(ip), {
    endpoint: 'submit-booking',
    action: 'finalize',
    now: now + 1,
  });

  assert.equal(blockedDraft.allowed, false);
  assert.equal(allowedFinalize.allowed, true);
  assert.equal(rl.identifySubmitBookingAction({ isDraft: true }), 'draft');
  assert.equal(rl.identifySubmitBookingAction({ draftBookingId: 'CD1-1' }), 'finalize');
});

test('OPTIONS requests bypass rate limiting', async () => {
  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_MAX = '1';
  const rl = getRateLimit();
  const event = makeEvent('203.0.113.24', 'OPTIONS');

  const decision = await rl.enforcePublicRateLimit(event, { endpoint: 'lookup-booking' });
  assert.equal(decision.bypassed, true);
  assert.equal(decision.blocked, false);
  assert.equal(memoryStore.data.size, 0);
});

test('blob storage failure follows fail-open behavior', async () => {
  const rl = getRateLimit();
  rl.setPublicRateLimitStoreFactory(() => {
    throw new Error('blob_down');
  });
  const event = makeEvent('203.0.113.25');

  const decision = await rl.checkPublicRateLimit(event, { endpoint: 'lookup-booking', now: 10_000_000 });
  assert.equal(decision.allowed, true);
  assert.equal(decision.failOpen, true);
  assert.equal(decision.reason, 'storage_unavailable');
});

test('rate-limited responses do not expose internal details', async () => {
  process.env.PUBLIC_RATE_LIMIT_AI_CHAT_MAX = '1';
  const rl = getRateLimit();
  const event = makeEvent('203.0.113.26');
  const now = 11_000_000;

  await rl.enforcePublicRateLimit(event, { endpoint: 'ai-chat', now });
  const blocked = await rl.enforcePublicRateLimit(event, { endpoint: 'ai-chat', now: now + 1 });
  const body = JSON.parse(blocked.response.body);
  const serialized = JSON.stringify(blocked.response);

  assert.deepEqual(Object.keys(body).sort(), ['error', 'ok', 'retryAfterSec']);
  assert.doesNotMatch(serialized, /203\.0\.113\.26/);
  assert.doesNotMatch(serialized, /rl-[a-f0-9]{8,}/i);
  assert.doesNotMatch(serialized, /blob|stack|secret|missing_client_ip/i);
});

test('blob keys are hashed and do not contain raw IP', () => {
  const rl = getRateLimit();
  const key = rl.deriveRateLimitKey('203.0.113.99', 'lookup-booking');
  assert.match(key, /^rl-[a-f0-9]{40}$/);
  assert.doesNotMatch(key, /203\.0\.113\.99/);
});

test('each tracked in-scope function invokes the shared helper', () => {
  const targets = [
    'netlify/functions/submit-booking.js',
    'netlify/functions/lookup-booking.js',
    'netlify/functions/customer-bookings.js',
    'netlify/functions/submit-inquiry.js',
    'netlify/functions/create-setup-intent.js',
    'netlify/functions/ai-chat.js',
    'netlify/functions/address-suggest.js',
  ];
  for (const file of targets) {
    const src = read(file);
    assert.match(src, /public-rate-limit/, `${file} should use public-rate-limit`);
    assert.match(src, /enforcePublicRateLimit/, `${file} should call enforcePublicRateLimit`);
  }
});

test('chat.js is ignored and not part of PR scope', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { execSync } = require('node:child_process');
  const tracked = execSync('git ls-files netlify/functions/chat.js', { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(tracked, '');
  const chatPath = path.join(root, 'netlify', 'functions', 'chat.js');
  // Local leftover copies may exist and must stay ignored; clean worktrees may omit the file entirely.
  if (!fs.existsSync(chatPath)) {
    const ignoreRule = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.match(ignoreRule, /netlify\/functions\/chat\.js/);
    return;
  }
  const ignored = execSync('git check-ignore -v netlify/functions/chat.js', { cwd: root, encoding: 'utf8' }).trim();
  assert.match(ignored, /netlify\/functions\/chat\.js/);
  const src = read('netlify/functions/chat.js');
  assert.doesNotMatch(src, /public-rate-limit/);
});

test('stripe webhook and authenticated admin functions are not rate-limited', () => {
  const untouched = [
    'netlify/functions/stripe-webhook.js',
    'netlify/functions/admin-auth.js',
    'netlify/functions/admin-ops-jobs.js',
    'netlify/functions/tech-auth.js',
    'netlify/functions/tech-jobs.js',
  ];
  for (const file of untouched) {
    const src = read(file);
    assert.doesNotMatch(src, /public-rate-limit/, `${file} must not import public-rate-limit`);
    assert.doesNotMatch(src, /enforcePublicRateLimit/, `${file} must not call enforcePublicRateLimit`);
  }
});

test('default limits match roadmap values', () => {
  const rl = getRateLimit();
  const limits = rl.DEFAULT_LIMITS;
  assert.equal(limits['submit-booking:draft'].max, 15);
  assert.equal(limits['submit-booking:finalize'].max, 8);
  assert.equal(limits['lookup-booking'].max, 20);
  assert.equal(limits['create-setup-intent'].max, 10);
  assert.equal(limits['submit-inquiry'].max, 10);
  assert.equal(limits['ai-chat'].max, 30);
  assert.equal(limits['chat'], undefined);
});

test('normalizeClientIp prefers platform identity over spoofed X-Forwarded-For', () => {
  const rl = getRateLimit();
  const event = {
    headers: {
      'x-forwarded-for': '198.51.100.7, 10.0.0.1',
      'x-nf-client-connection-ip': '10.0.0.1',
      'client-ip': '10.0.0.1',
    },
  };
  assert.equal(rl.normalizeClientIp(event), '10.0.0.1');
});

test('spoofed X-Forwarded-For alone cannot bypass rate limit when platform IP is present', async () => {
  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_MAX = '2';
  const rl = getRateLimit();
  const now = 30_000_000;
  const platformEvent = makeEvent('203.0.113.88');
  platformEvent.headers['x-nf-client-connection-ip'] = '203.0.113.88';
  platformEvent.headers['x-forwarded-for'] = '1.2.3.4';

  await rl.enforcePublicRateLimit(platformEvent, { endpoint: 'lookup-booking', now });
  await rl.enforcePublicRateLimit(platformEvent, { endpoint: 'lookup-booking', now: now + 1 });

  const spoofed = makeEvent('1.2.3.4');
  spoofed.headers['x-forwarded-for'] = '1.2.3.4';
  spoofed.headers['x-nf-client-connection-ip'] = '203.0.113.88';
  const blocked = await rl.enforcePublicRateLimit(spoofed, { endpoint: 'lookup-booking', now: now + 2 });
  assert.equal(blocked.blocked, true);
});

test('missing client IP fails open without using a shared unknown bucket', async () => {
  const rl = getRateLimit();
  const event = makeEvent(null);
  event.headers = {};

  const decision = await rl.checkPublicRateLimit(event, { endpoint: 'lookup-booking', now: 12_000_000 });
  assert.equal(decision.allowed, true);
  assert.equal(decision.failOpen, true);
  assert.equal(decision.reason, 'missing_client_ip');
  assert.equal(memoryStore.data.size, 0);

  const enforced = await rl.enforcePublicRateLimit(event, { endpoint: 'lookup-booking', now: 12_000_000 });
  assert.equal(enforced.blocked, false);
  assert.equal(enforced.reason, 'missing_client_ip');
  assert.equal(enforced.response, undefined);
});

test('environment override validation falls back for invalid values', () => {
  const rl = getRateLimit();
  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_MAX = '0';
  assert.equal(rl.getLimitConfig('lookup-booking').max, 20);

  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_MAX = '-5';
  assert.equal(rl.getLimitConfig('lookup-booking').max, 20);

  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_MAX = 'NaN';
  assert.equal(rl.getLimitConfig('lookup-booking').max, 20);

  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_MAX = '';
  assert.equal(rl.getLimitConfig('lookup-booking').max, 20);

  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_MAX = '999999';
  assert.equal(rl.getLimitConfig('lookup-booking').max, 20);

  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_MAX = '25';
  assert.equal(rl.getLimitConfig('lookup-booking').max, 25);

  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_WINDOW_SEC = '30';
  assert.equal(
    rl.getLimitConfig('lookup-booking').windowMs,
    rl.DEFAULT_LIMITS['lookup-booking'].windowMs
  );

  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_WINDOW_SEC = '999999';
  assert.equal(rl.getLimitConfig('lookup-booking').windowMs, rl.DEFAULT_LIMITS['lookup-booking'].windowMs);

  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_WINDOW_SEC = '120';
  assert.equal(rl.getLimitConfig('lookup-booking').windowMs, 120_000);
});

test('concurrent burst preserves increments and blocks at limit', async () => {
  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_MAX = '5';
  const rl = getRateLimit();
  const event = makeEvent('203.0.113.50');
  const now = 20_000_000;
  const key = rl.deriveRateLimitKey('203.0.113.50', 'lookup-booking');

  const results = await Promise.all(
    Array.from({ length: 12 }, () => rl.checkPublicRateLimit(event, { endpoint: 'lookup-booking', now }))
  );

  const allowed = results.filter((r) => r.allowed && !r.failOpen).length;
  const blocked = results.filter((r) => !r.allowed).length;
  assert.equal(allowed, 5);
  assert.equal(blocked, 7);

  const stored = await memoryStore.getWithMetadata(key, { type: 'json' });
  assert.equal(stored.data.count, 5);
});

test('naive last-write-wins loses increments in a simulated race', async () => {
  const store = createNaiveMemoryStore();
  const key = 'race-key';
  const now = 21_000_000;
  const base = { count: 1, windowStart: now, bucket: 'lookup-booking' };
  await store.setJSON(key, base);

  const snapshot = await store.getWithMetadata(key, { type: 'json' });
  const nextA = { ...snapshot.data, count: snapshot.data.count + 1 };
  const nextB = { ...snapshot.data, count: snapshot.data.count + 1 };
  await store.setJSON(key, nextA);
  await store.setJSON(key, nextB);

  const naiveStored = await store.getWithMetadata(key, { type: 'json' });
  assert.equal(naiveStored.data.count, 2, 'naive LWW should lose one increment');

  const rl = getRateLimit();
  const conditional = createConditionalMemoryStore();
  rl.setPublicRateLimitStoreFactory(() => conditional);
  await conditional.setJSON(key, base, {});

  const first = await rl.incrementCounterAtomically(conditional, key, {
    max: 10,
    windowMs: 15 * 60 * 1000,
    bucket: 'lookup-booking',
    now: now + 1,
  });
  const second = await rl.incrementCounterAtomically(conditional, key, {
    max: 10,
    windowMs: 15 * 60 * 1000,
    bucket: 'lookup-booking',
    now: now + 2,
  });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  const atomicStored = await conditional.getWithMetadata(key, { type: 'json' });
  assert.equal(atomicStored.data.count, 3);
  assert.ok(atomicStored.data.count > naiveStored.data.count);
});

test('ETag conflicts retry and preserve increments', async () => {
  process.env.PUBLIC_RATE_LIMIT_LOOKUP_BOOKING_MAX = '10';
  const rl = getRateLimit();
  const event = makeEvent('203.0.113.52');
  const now = 22_000_000;
  const key = rl.deriveRateLimitKey('203.0.113.52', 'lookup-booking');

  let writeAttempts = 0;
  const base = createConditionalMemoryStore();
  const flaky = {
    async getWithMetadata(key, opts) {
      return base.getWithMetadata(key, opts);
    },
    async setJSON(key, value, options = {}) {
      writeAttempts += 1;
      if (writeAttempts % 2 === 1 && (options.onlyIfNew || options.onlyIfMatch)) {
        return { modified: false };
      }
      return base.setJSON(key, value, options);
    },
  };
  rl.setPublicRateLimitStoreFactory(() => flaky);

  const first = await rl.checkPublicRateLimit(event, { endpoint: 'lookup-booking', now });
  const second = await rl.checkPublicRateLimit(event, { endpoint: 'lookup-booking', now: now + 1 });

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.ok(writeAttempts > 2, 'conflicts should trigger retries');

  const stored = await base.getWithMetadata(key, { type: 'json' });
  assert.equal(stored.data.count, 2);
});

test('bounded retry exhaustion follows fail-open behavior', async () => {
  const rl = getRateLimit();
  rl.setPublicRateLimitStoreFactory(() => createAlwaysConflictStore());
  const event = makeEvent('203.0.113.53');

  const decision = await rl.checkPublicRateLimit(event, { endpoint: 'lookup-booking', now: 23_000_000 });
  assert.equal(decision.allowed, true);
  assert.equal(decision.failOpen, true);
  assert.equal(decision.reason, 'retry_exhausted');
});

test('strong consistency is configured on store reads and creation', () => {
  const src = read('netlify/lib/public-rate-limit.js');
  assert.match(src, /consistency:\s*STRONG_CONSISTENCY|consistency:\s*'strong'/);
  assert.match(src, /getWithMetadata\([\s\S]*consistency:\s*STRONG_CONSISTENCY/);
  assert.match(src, /onlyIfNew:\s*true/);
  assert.match(src, /onlyIfMatch:\s*etag/);
});

test('production and deploy-preview use different rate-limit keys for same IP and endpoint', () => {
  const rl = getRateLimit();
  const ip = '203.0.113.60';
  const prodEnv = { CONTEXT: 'production', DEPLOY_ID: 'prod-deploy-1' };
  const previewEnv = { CONTEXT: 'deploy-preview', DEPLOY_ID: 'preview-deploy-92' };

  const prodKey = rl.deriveRateLimitKey(ip, 'create-setup-intent', '', prodEnv);
  const previewKey = rl.deriveRateLimitKey(ip, 'create-setup-intent', '', previewEnv);

  assert.notEqual(prodKey, previewKey);
});

test('production rate-limit key is stable when DEPLOY_ID changes', () => {
  const rl = getRateLimit();
  const ip = '203.0.113.61';
  const first = rl.deriveRateLimitKey(ip, 'lookup-booking', '', {
    CONTEXT: 'production',
    DEPLOY_ID: 'deploy-a',
  });
  const second = rl.deriveRateLimitKey(ip, 'lookup-booking', '', {
    CONTEXT: 'production',
    DEPLOY_ID: 'deploy-b',
  });

  assert.equal(first, second);
  assert.equal(rl.rateLimitNamespace({ CONTEXT: 'production', DEPLOY_ID: 'deploy-b' }), 'production');
});

test('different deploy-preview deploy IDs use different rate-limit keys', () => {
  const rl = getRateLimit();
  const ip = '203.0.113.62';
  const previewA = rl.deriveRateLimitKey(ip, 'create-setup-intent', '', {
    CONTEXT: 'deploy-preview',
    DEPLOY_ID: '6a4d33288e85c400086e0add',
  });
  const previewB = rl.deriveRateLimitKey(ip, 'create-setup-intent', '', {
    CONTEXT: 'deploy-preview',
    DEPLOY_ID: 'other-preview-deploy-id',
  });

  assert.notEqual(previewA, previewB);
});

test('branch deploy does not share rate-limit keys with production', () => {
  const rl = getRateLimit();
  const ip = '203.0.113.63';
  const prodKey = rl.deriveRateLimitKey(ip, 'submit-inquiry', '', {
    CONTEXT: 'production',
    DEPLOY_ID: 'prod-1',
  });
  const branchKey = rl.deriveRateLimitKey(ip, 'submit-inquiry', '', {
    CONTEXT: 'branch-deploy',
    DEPLOY_ID: 'branch-deploy-1',
    BRANCH: 'security-draft-token-setup-intent',
  });

  assert.notEqual(prodKey, branchKey);
  assert.equal(
    rl.rateLimitNamespace({ CONTEXT: 'branch-deploy', DEPLOY_ID: 'branch-deploy-1' }),
    'branch-deploy:branch-deploy-1'
  );
});

test('missing CONTEXT defaults to a non-production namespace', () => {
  const rl = getRateLimit();
  assert.equal(rl.rateLimitNamespace({}), 'dev:local');
  assert.notEqual(rl.rateLimitNamespace({}), 'production');

  const key = rl.deriveRateLimitKey('203.0.113.64', 'ai-chat', '', {});
  const prodKey = rl.deriveRateLimitKey('203.0.113.64', 'ai-chat', '', { CONTEXT: 'production' });
  assert.notEqual(key, prodKey);
});

test('endpoint and action bucket separation remains intact with namespace', async () => {
  process.env.PUBLIC_RATE_LIMIT_SUBMIT_BOOKING_DRAFT_MAX = '1';
  process.env.PUBLIC_RATE_LIMIT_SUBMIT_BOOKING_FINALIZE_MAX = '1';
  process.env.CONTEXT = 'deploy-preview';
  process.env.DEPLOY_ID = 'preview-test-buckets';
  const rl = getRateLimit();
  const ip = '203.0.113.65';
  const now = 24_000_000;

  await rl.checkPublicRateLimit(makeEvent(ip), {
    endpoint: 'submit-booking',
    action: 'draft',
    now,
  });
  const blockedDraft = await rl.checkPublicRateLimit(makeEvent(ip), {
    endpoint: 'submit-booking',
    action: 'draft',
    now: now + 1,
  });
  const allowedFinalize = await rl.checkPublicRateLimit(makeEvent(ip), {
    endpoint: 'submit-booking',
    action: 'finalize',
    now: now + 1,
  });

  assert.equal(blockedDraft.allowed, false);
  assert.equal(allowedFinalize.allowed, true);

  const draftKey = rl.deriveRateLimitKey(ip, 'submit-booking', 'draft', process.env);
  const finalizeKey = rl.deriveRateLimitKey(ip, 'submit-booking', 'finalize', process.env);
  assert.notEqual(draftKey, finalizeKey);
});

test('deploy-context isolation keeps raw IP out of stored keys', () => {
  const rl = getRateLimit();
  const ip = '203.0.113.66';
  const key = rl.deriveRateLimitKey(ip, 'lookup-booking', '', {
    CONTEXT: 'deploy-preview',
    DEPLOY_ID: 'preview-raw-ip-check',
  });
  assert.match(key, /^rl-[a-f0-9]{40}$/);
  assert.doesNotMatch(key, /203\.0\.113\.66/);
  assert.doesNotMatch(key, /deploy-preview/);
  assert.doesNotMatch(key, /preview-raw-ip-check/);
});

test('production and deploy-preview counters are independent for same IP', async () => {
  process.env.PUBLIC_RATE_LIMIT_CREATE_SETUP_INTENT_MAX = '1';
  const rl = getRateLimit();
  const ip = '203.0.113.67';
  const now = 25_000_000;
  const envSnapContext = process.env.CONTEXT;
  const envSnapDeployId = process.env.DEPLOY_ID;

  try {
    const prodEnv = { CONTEXT: 'production' };
    const previewEnv = { CONTEXT: 'deploy-preview', DEPLOY_ID: 'preview-92' };

    const prodKey = rl.deriveRateLimitKey(ip, 'create-setup-intent', '', prodEnv);
    const previewKey = rl.deriveRateLimitKey(ip, 'create-setup-intent', '', previewEnv);

    process.env.CONTEXT = 'production';
    delete process.env.DEPLOY_ID;
    await rl.checkPublicRateLimit(makeEvent(ip), { endpoint: 'create-setup-intent', now });
    const prodBlocked = await rl.checkPublicRateLimit(makeEvent(ip), { endpoint: 'create-setup-intent', now: now + 1 });

    process.env.CONTEXT = 'deploy-preview';
    process.env.DEPLOY_ID = 'preview-92';
    const previewAllowed = await rl.checkPublicRateLimit(makeEvent(ip), { endpoint: 'create-setup-intent', now: now + 1 });

    assert.equal(prodBlocked.allowed, false);
    assert.equal(previewAllowed.allowed, true);
    assert.notEqual(prodKey, previewKey);

    const prodStored = await memoryStore.getWithMetadata(prodKey, { type: 'json' });
    const previewStored = await memoryStore.getWithMetadata(previewKey, { type: 'json' });
    assert.equal(prodStored.data.count, 1);
    assert.equal(previewStored.data.count, 1);
  } finally {
    if (envSnapContext === undefined) delete process.env.CONTEXT;
    else process.env.CONTEXT = envSnapContext;
    if (envSnapDeployId === undefined) delete process.env.DEPLOY_ID;
    else process.env.DEPLOY_ID = envSnapDeployId;
  }
});
