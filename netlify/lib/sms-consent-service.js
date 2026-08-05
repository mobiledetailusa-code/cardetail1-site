'use strict';

const crypto = require('crypto');
const { tryGetPrisma } = require('./prisma');
const { normalizeUsPhoneE164 } = require('./phone-auth');
const {
  emitIdentityAudit,
  loadCustomerAccountGraph,
  assertCustomerPortalAccountActive,
} = require('./customer-account-service');
const { projectCustomerIdentity, assertSafeCustomerProjection } = require('./customer-identity-projection');

const CHANNEL = 'sms_transactional';
const CONSENT_TEXT_VERSION = 'sms-transactional-v1-2026-08-05';

function prismaClient(override) {
  return override || tryGetPrisma();
}

function phoneHash(phone) {
  return crypto.createHash('sha256').update(String(phone || '')).digest('hex').slice(0, 16);
}

async function assertCustomerSmsConsent({ customerAccountId, toE164 }, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma) return { ok: false, reason: 'consent_store_unavailable' };
  if (!customerAccountId) return { ok: false, reason: 'customer_account_required' };
  const account = await prisma.customerAccount.findUnique({
    where: { id: customerAccountId },
    include: { profile: true, consents: true },
  });
  const gate = assertCustomerPortalAccountActive(account);
  if (!gate.ok) return { ok: false, reason: 'customer_not_active' };
  const verifiedPhone = normalizeUsPhoneE164(account.profile?.normalizedPhone || account.profile?.phone || '');
  if (!verifiedPhone || verifiedPhone !== normalizeUsPhoneE164(toE164)) {
    return { ok: false, reason: 'verified_phone_mismatch' };
  }
  const consent = (account.consents || []).find((row) => row.channel === CHANNEL);
  if (!consent || consent.status !== 'granted') return { ok: false, reason: 'sms_consent_required' };
  return { ok: true, consentTextVersion: consent.consentTextVersion || null };
}

async function updateSmsConsent(input = {}, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma || typeof prisma.$transaction !== 'function') {
    return { ok: false, error: 'unavailable' };
  }
  const customerAccountId = String(input.customerAccountId || '').trim();
  const expectedVersion = Number(input.expectedVersion);
  if (!customerAccountId || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return { ok: false, error: 'validation_error', message: 'expectedVersion is required.' };
  }
  const granted = input.granted === true;
  const source = String(input.source || 'customer_portal').slice(0, 64);
  try {
    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.customerAccount.findUnique({
        where: { id: customerAccountId },
        include: { profile: true, consents: true },
      });
      const gate = assertCustomerPortalAccountActive(account);
      if (!gate.ok) return gate;
      if (account.version !== expectedVersion) {
        return { ok: false, error: 'version_conflict', actualVersion: account.version };
      }
      const phone = normalizeUsPhoneE164(account.profile?.normalizedPhone || account.profile?.phone || '');
      if (granted && !phone) {
        return { ok: false, error: 'validation_error', message: 'A verified phone is required.' };
      }
      const current = (account.consents || []).find((row) => row.channel === CHANNEL);
      const targetStatus = granted ? 'granted' : 'revoked';
      if (current?.status === targetStatus) {
        return { ok: true, unchanged: true, accountVersion: account.version };
      }
      const now = new Date();
      const nextVersion = account.version + 1;
      const bumped = await tx.customerAccount.updateMany({
        where: { id: customerAccountId, version: account.version },
        data: { version: nextVersion, updatedAt: now },
      });
      // Perform the CAS before any consent write. Returning a conflict must not
      // commit a consent mutation from the losing transaction.
      if (!bumped || bumped.count !== 1) return { ok: false, error: 'version_conflict' };
      await tx.customerConsent.upsert({
        where: { customerAccountId_channel: { customerAccountId, channel: CHANNEL } },
        create: {
          customerAccountId,
          channel: CHANNEL,
          status: targetStatus,
          grantedAt: granted ? now : null,
          revokedAt: granted ? null : now,
          source,
          consentTextVersion: CONSENT_TEXT_VERSION,
        },
        update: {
          status: targetStatus,
          grantedAt: granted ? now : current?.grantedAt || null,
          revokedAt: granted ? null : now,
          source,
          consentTextVersion: CONSENT_TEXT_VERSION,
        },
      });
      await emitIdentityAudit(tx, {
        actor: 'customer:portal',
        action: granted ? 'sms_consent_granted' : 'sms_consent_revoked',
        detail: {
          customerAccountId,
          requestId: String(input.requestId || '').slice(0, 80) || null,
          consentTextVersion: CONSENT_TEXT_VERSION,
          fromVersion: account.version,
          toVersion: nextVersion,
        },
      });
      return { ok: true, accountVersion: nextVersion };
    });
    if (!result.ok) return result;
    const graph = await loadCustomerAccountGraph(customerAccountId, { prisma });
    return {
      ...result,
      customer: assertSafeCustomerProjection(projectCustomerIdentity(graph)),
    };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}

async function revokeSmsConsentByPhone(rawPhone, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  const phone = normalizeUsPhoneE164(rawPhone);
  if (!prisma || !phone) return { ok: false, error: 'invalid_phone' };
  const digits = phone.replace(/^\+1/, '');
  try {
    const revoked = await prisma.$transaction(async (tx) => {
      const profiles = await tx.customerProfile.findMany({
        where: { OR: [{ normalizedPhone: digits }, { normalizedPhone: phone }, { phone }] },
      });
      let changed = 0;
      for (const profile of profiles) {
        const current = await tx.customerConsent.findUnique({
          where: {
            customerAccountId_channel: {
              customerAccountId: profile.customerAccountId,
              channel: CHANNEL,
            },
          },
        });
        if (current?.status === 'revoked') continue;
        const now = new Date();
        await tx.customerConsent.upsert({
          where: {
            customerAccountId_channel: {
              customerAccountId: profile.customerAccountId,
              channel: CHANNEL,
            },
          },
          create: {
            customerAccountId: profile.customerAccountId,
            channel: CHANNEL,
            status: 'revoked',
            revokedAt: now,
            source: 'twilio_stop',
            consentTextVersion: CONSENT_TEXT_VERSION,
          },
          update: {
            status: 'revoked',
            revokedAt: now,
            source: 'twilio_stop',
          },
        });
        await tx.customerAccount.update({
          where: { id: profile.customerAccountId },
          data: { version: { increment: 1 }, updatedAt: now },
        });
        await emitIdentityAudit(tx, {
          actor: 'twilio:webhook',
          action: 'sms_consent_revoked',
          detail: {
            customerAccountId: profile.customerAccountId,
            source: 'twilio_stop',
            phoneHash: phoneHash(phone),
          },
        });
        changed += 1;
      }
      return changed;
    });
    return { ok: true, revoked };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}

module.exports = {
  CHANNEL,
  CONSENT_TEXT_VERSION,
  assertCustomerSmsConsent,
  updateSmsConsent,
  revokeSmsConsentByPhone,
};
