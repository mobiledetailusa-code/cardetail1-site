/**
 * Authenticated Customer Identity Production smoke harness.
 *
 * DISABLED BY DEFAULT: returns 404 unless CUSTOMER_IDENTITY_SMOKE_SECRET is set
 * (32+ chars) AND the request header x-cd1-smoke-secret matches via timing-safe
 * compare.
 *
 * This is not an authorization bypass for arbitrary accounts. It creates an
 * ephemeral tagged QA CustomerAccount, opens a normal createAccountSession
 * (same helper used after magic-link verify), exercises profile/address
 * services, then deletes all QA rows and revokes the session.
 *
 * Never logs or returns email, phone, address, cookies, tokens, or secrets.
 */

const crypto = require('crypto');
const { jsonCors } = require('../lib/tech-security');
const { tryGetPrisma } = require('../lib/prisma');
const {
  createAccountSession,
  revokeCustomerSession,
  clearSessionCookieHeader,
  COOKIE_NAME,
} = require('../lib/customer-session');
const {
  resolveOrCreateCustomerAccount,
  emitIdentityAudit,
} = require('../lib/customer-account-service');
const profileService = require('../lib/customer-profile-service');
const addressService = require('../lib/customer-address-service');

const SMOKE_HEADER = 'x-cd1-smoke-secret';
const MIN_SECRET_LEN = 32;

function header(event, name) {
  const h = event?.headers || {};
  const want = String(name).toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (String(k).toLowerCase() === want) return String(v || '');
  }
  return '';
}

function configuredSmokeSecret() {
  return String(process.env.CUSTOMER_IDENTITY_SMOKE_SECRET || '').trim();
}

function smokeDisabled() {
  return jsonCors(404, { ok: false, error: 'not_found' });
}

function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

function sha12(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function cookieEvent(token) {
  return {
    headers: {
      cookie: token ? `${COOKIE_NAME}=${encodeURIComponent(token)}` : '',
    },
  };
}

async function cleanupQaAccount(prisma, { accountId }) {
  const cleaned = {
    addresses: 0,
    consents: 0,
    profiles: 0,
    audits: 0,
    account: false,
  };
  if (!prisma || !accountId) return cleaned;

  try {
    const addr = await prisma.customerAddress.deleteMany({ where: { customerAccountId: accountId } });
    cleaned.addresses = addr?.count || 0;
  } catch { /* ignore */ }
  try {
    const consents = await prisma.customerConsent.deleteMany({ where: { customerAccountId: accountId } });
    cleaned.consents = consents?.count || 0;
  } catch { /* ignore */ }
  try {
    const profiles = await prisma.customerProfile.deleteMany({ where: { customerAccountId: accountId } });
    cleaned.profiles = profiles?.count || 0;
  } catch { /* ignore */ }
  try {
    const audits = await prisma.auditEvent.findMany({
      where: { actor: 'system:customer-identity-smoke' },
      take: 200,
    });
    for (const row of audits) {
      const detail = row.detail || {};
      if (detail.customerAccountId === accountId || detail.smokeTag || detail.accountHash) {
        await prisma.auditEvent.delete({ where: { id: row.id } }).catch(() => null);
        cleaned.audits += 1;
      }
    }
  } catch { /* ignore */ }
  try {
    await prisma.customerAccount.delete({ where: { id: accountId } });
    cleaned.account = true;
  } catch { /* ignore */ }
  return cleaned;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'POST') return smokeDisabled();

  const expected = configuredSmokeSecret();
  if (!expected || expected.length < MIN_SECRET_LEN) return smokeDisabled();

  const provided = header(event, SMOKE_HEADER);
  if (!secretsMatch(provided, expected)) {
    // Uniform not_found — do not reveal that the harness exists.
    return smokeDisabled();
  }

  const prisma = tryGetPrisma();
  if (!prisma) {
    return jsonCors(503, { ok: false, error: 'service_unavailable' });
  }

  const smokeTag = `qa_smoke_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const email = `${smokeTag}@example.test`;
  const phone = `201555${String(1000 + (Date.now() % 9000))}`;
  const steps = [];
  let accountId = null;
  let sessionToken = null;
  let sid = null;

  const record = (name, ok, detail = '') => {
    steps.push({ name, ok: !!ok, detail: String(detail || '').slice(0, 80) });
  };

  try {
    await emitIdentityAudit(prisma, {
      actor: 'system:customer-identity-smoke',
      action: 'customer_identity_smoke.started',
      detail: { smokeTag: sha12(smokeTag), context: String(process.env.CONTEXT || '') },
    });

    const created = await resolveOrCreateCustomerAccount({
      verifiedEmail: email,
      verifiedPhone: phone,
      firstName: 'Smoke',
      lastName: 'QA',
    }, { prisma });
    accountId = created.customerAccountId || null;
    record('login_account_created', !!accountId, created.status || created.error || '');
    if (!accountId) {
      return jsonCors(500, { ok: false, error: 'smoke_failed', steps });
    }

    const session = await createAccountSession({
      phoneDigits: phone,
      email,
      bookingIds: [],
      customerAccountId: accountId,
    });
    sessionToken = session.token;
    sid = session.session?.sid || null;
    record('login_session_created', !!sessionToken && !!sid, sid ? `sid_hash=${sha12(sid)}` : '');

    // Session validation via profile HTTP surface would require a self-HTTP call;
    // exercise the same services the portal handler uses after session auth.
    const got = await profileService.getProfile(accountId, { prisma });
    record('get_profile', got.ok === true, got.error || 'ok');

    let version = Number(got.customer?.accountVersion || 1);
    const upd = await profileService.updateProfile({
      customerAccountId: accountId,
      expectedVersion: version,
      patch: { firstName: 'SmokeUpdated', timezone: 'America/New_York' },
      actor: 'system:customer-identity-smoke',
      requestId: `${smokeTag}_upd`,
    }, { prisma });
    record('update_profile', upd.ok === true, upd.error || 'ok');
    version = Number(upd.accountVersion || version);

    const createdAddr = await addressService.createAddress({
      customerAccountId: accountId,
      expectedVersion: version,
      address: {
        label: 'Smoke',
        line1: '1 Smoke Way',
        city: 'Hoboken',
        state: 'NJ',
        postalCode: '07030',
        country: 'US',
        isDefault: true,
      },
      actor: 'system:customer-identity-smoke',
      requestId: `${smokeTag}_addr1`,
    }, { prisma });
    const addressId = createdAddr.addressId || null;
    record('create_address', createdAddr.ok === true && !!addressId, createdAddr.error || 'ok');
    version = Number(createdAddr.accountVersion || version);

    const updAddr = addressId
      ? await addressService.updateAddress({
        customerAccountId: accountId,
        addressId,
        expectedVersion: version,
        address: { label: 'SmokeHome' },
        actor: 'system:customer-identity-smoke',
        requestId: `${smokeTag}_addr_upd`,
      }, { prisma })
      : { ok: false, error: 'missing_address' };
    record('update_address', updAddr.ok === true, updAddr.error || 'ok');
    version = Number(updAddr.accountVersion || version);

    const setDef = addressId
      ? await addressService.setDefaultAddress({
        customerAccountId: accountId,
        addressId,
        expectedVersion: version,
        actor: 'system:customer-identity-smoke',
        requestId: `${smokeTag}_def`,
      }, { prisma })
      : { ok: false, error: 'missing_address' };
    record('set_default_address', setDef.ok === true, setDef.error || 'ok');
    version = Number(setDef.accountVersion || version);

    const arch = addressId
      ? await addressService.archiveAddress({
        customerAccountId: accountId,
        addressId,
        expectedVersion: version,
        actor: 'system:customer-identity-smoke',
        requestId: `${smokeTag}_arch`,
      }, { prisma })
      : { ok: false, error: 'missing_address' };
    record('archive_address', arch.ok === true, arch.error || 'ok');

    if (sessionToken) {
      const revoked = await revokeCustomerSession(cookieEvent(sessionToken));
      record('logout', revoked.ok === true, revoked.revoked ? 'revoked' : 'cleared');
    } else {
      record('logout', false, 'no_session');
    }

    await emitIdentityAudit(prisma, {
      actor: 'system:customer-identity-smoke',
      action: 'customer_identity_smoke.completed',
      detail: {
        smokeTag: sha12(smokeTag),
        accountHash: sha12(accountId),
        stepCount: steps.length,
        allOk: steps.every((s) => s.ok),
      },
    });
  } catch (err) {
    record('exception', false, err && err.message ? err.message : 'error');
  }

  const cleaned = await cleanupQaAccount(prisma, { accountId });
  record('cleanup', cleaned.account === true, `addresses=${cleaned.addresses};audits=${cleaned.audits}`);

  const ok = steps.every((s) => s.ok);
  return {
    statusCode: ok ? 200 : 500,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Set-Cookie': clearSessionCookieHeader(),
    },
    body: JSON.stringify({
      ok,
      smoke: true,
      // Non-PII only
      smokeTagHash: sha12(smokeTag),
      accountHash: accountId ? sha12(accountId) : null,
      steps,
      cleanup: cleaned,
    }),
  };
};

// Test seams
exports._test = {
  SMOKE_HEADER,
  configuredSmokeSecret,
  secretsMatch,
  smokeDisabled,
};
