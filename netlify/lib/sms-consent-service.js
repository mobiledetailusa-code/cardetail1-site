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
const {
  BOOKING_CONSENT_TEXT_VERSION,
  BOOKING_CONSENT_SOURCE,
  bookingSmsConsentGranted,
} = require('./sms-program');

const CHANNEL = 'sms_transactional';
const CONSENT_TEXT_VERSION = 'sms-transactional-v1-2026-08-05';

function prismaClient(override) {
  return override || tryGetPrisma();
}

function phoneHash(phone) {
  return crypto.createHash('sha256').update(String(phone || '')).digest('hex').slice(0, 16);
}

async function assertCustomerSmsConsent({ customerAccountId, toE164, booking } = {}, opts = {}) {
  const dest = normalizeUsPhoneE164(toE164);
  if (!dest) return { ok: false, reason: 'invalid_sms_recipient' };

  const bookingPhone = normalizeUsPhoneE164(booking?.phone || booking?.customerPhone || '');
  const bookingConsentApplies = bookingSmsConsentGranted(booking) && !!bookingPhone && bookingPhone === dest;

  const prisma = prismaClient(opts.prisma);
  let account = null;
  let consent = null;
  let verifiedPhone = '';

  // Account hydration is observational for the booking-checkbox path. A missing
  // CustomerAccount must not delay the booking-time SMS decision until My Garage
  // or /a?t= creates the row.
  if (prisma && customerAccountId) {
    try {
      account = await prisma.customerAccount.findUnique({
        where: { id: customerAccountId },
        include: { profile: true, consents: true },
      });
    } catch {
      account = null;
    }
    if (account) {
      const gate = assertCustomerPortalAccountActive(account);
      if (gate.ok) {
        consent = (account.consents || []).find((row) => row.channel === CHANNEL);
        verifiedPhone = normalizeUsPhoneE164(account.profile?.normalizedPhone || account.profile?.phone || '');
      } else if (!bookingConsentApplies) {
        return { ok: false, reason: 'customer_not_active' };
      }
    }
  }

  // Public booking checkbox: allow transactional SMS to the booking phone even when
  // the account profile verified phone differs (email-linked account reuse). Keep
  // STOP/revocation newer than this booking consent as the winner. Do not use this
  // path to rewrite account-level consent for a mismatched portal phone.
  // accessAuthorized is separate: only verified-phone match may include /a?t=.
  if (bookingConsentApplies) {
    const revokedAtMs = consent?.revokedAt ? new Date(consent.revokedAt).getTime() : Number.NaN;
    const consentAtMs = Date.parse(booking.transactionalSmsConsent?.recordedAt || '');
    if (
      consent?.status === 'revoked'
      && Number.isFinite(revokedAtMs)
      && Number.isFinite(consentAtMs)
      && revokedAtMs >= consentAtMs
    ) {
      return { ok: false, reason: 'sms_consent_required' };
    }
    return {
      ok: true,
      consentTextVersion: BOOKING_CONSENT_TEXT_VERSION,
      source: BOOKING_CONSENT_SOURCE,
      accessAuthorized: !!(verifiedPhone && verifiedPhone === dest),
    };
  }

  if (!prisma) return { ok: false, reason: 'consent_store_unavailable' };
  if (!customerAccountId) return { ok: false, reason: 'customer_account_required' };
  if (!account) return { ok: false, reason: 'customer_not_active' };

  if (!verifiedPhone || verifiedPhone !== dest) {
    return { ok: false, reason: 'verified_phone_mismatch' };
  }
  if (!consent || consent.status !== 'granted') return { ok: false, reason: 'sms_consent_required' };
  return {
    ok: true,
    consentTextVersion: consent.consentTextVersion || null,
    accessAuthorized: true,
  };
}

async function loadAccountVerifiedPhoneE164(customerAccountId, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma || !customerAccountId) return null;
  try {
    const account = await prisma.customerAccount.findUnique({
      where: { id: customerAccountId },
      include: { profile: true },
    });
    const gate = assertCustomerPortalAccountActive(account);
    if (!gate.ok) return null;
    return normalizeUsPhoneE164(account.profile?.normalizedPhone || account.profile?.phone || '');
  } catch {
    return null;
  }
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

/**
 * Convert one server-recorded public booking checkbox into the existing
 * account-level current-state consent row. A STOP/portal revocation recorded
 * at or after this booking consent always wins, so replaying an old booking can
 * never opt the customer back in.
 */
async function grantBookingSmsConsent({ customerAccountId, toE164, booking } = {}, opts = {}) {
  const prisma = prismaClient(opts.prisma);
  if (!prisma || typeof prisma.$transaction !== 'function') {
    return { ok: false, error: 'unavailable' };
  }
  if (!customerAccountId || !bookingSmsConsentGranted(booking)) {
    return { ok: true, granted: false, reason: 'booking_sms_consent_required' };
  }
  const consentAt = new Date(booking.transactionalSmsConsent.recordedAt);
  if (!Number.isFinite(consentAt.getTime())) {
    return { ok: true, granted: false, reason: 'booking_sms_consent_invalid' };
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const account = await tx.customerAccount.findUnique({
        where: { id: customerAccountId },
        include: { profile: true, consents: true },
      });
      const gate = assertCustomerPortalAccountActive(account);
      if (!gate.ok) return { ok: false, error: 'customer_not_active' };
      const verifiedPhone = normalizeUsPhoneE164(account.profile?.normalizedPhone || account.profile?.phone || '');
      if (!verifiedPhone || verifiedPhone !== normalizeUsPhoneE164(toE164)) {
        return { ok: false, error: 'verified_phone_mismatch' };
      }
      const current = (account.consents || []).find((row) => row.channel === CHANNEL);
      const revokedAtMs = current?.revokedAt ? new Date(current.revokedAt).getTime() : Number.NaN;
      if (current?.status === 'revoked' && Number.isFinite(revokedAtMs) && revokedAtMs >= consentAt.getTime()) {
        return { ok: true, granted: false, reason: 'newer_revocation' };
      }
      const grantedAtMs = current?.grantedAt ? new Date(current.grantedAt).getTime() : Number.NaN;
      if (
        current?.status === 'granted'
        && current.consentTextVersion === BOOKING_CONSENT_TEXT_VERSION
        && Number.isFinite(grantedAtMs)
        && grantedAtMs >= consentAt.getTime()
      ) {
        return { ok: true, granted: true, unchanged: true, accountVersion: account.version };
      }
      const nextVersion = account.version + 1;
      const bumped = await tx.customerAccount.updateMany({
        where: { id: customerAccountId, version: account.version },
        data: { version: nextVersion, updatedAt: new Date() },
      });
      if (!bumped || bumped.count !== 1) return { ok: false, error: 'version_conflict' };
      await tx.customerConsent.upsert({
        where: { customerAccountId_channel: { customerAccountId, channel: CHANNEL } },
        create: {
          customerAccountId,
          channel: CHANNEL,
          status: 'granted',
          grantedAt: consentAt,
          revokedAt: null,
          source: BOOKING_CONSENT_SOURCE,
          consentTextVersion: BOOKING_CONSENT_TEXT_VERSION,
        },
        update: {
          status: 'granted',
          grantedAt: consentAt,
          revokedAt: null,
          source: BOOKING_CONSENT_SOURCE,
          consentTextVersion: BOOKING_CONSENT_TEXT_VERSION,
        },
      });
      await emitIdentityAudit(tx, {
        actor: 'customer:booking',
        action: 'sms_consent_granted',
        detail: {
          customerAccountId,
          bookingId: String(booking.id || booking.bookingId || '').slice(0, 80) || null,
          consentTextVersion: BOOKING_CONSENT_TEXT_VERSION,
          source: BOOKING_CONSENT_SOURCE,
          fromVersion: account.version,
          toVersion: nextVersion,
        },
      });
      return { ok: true, granted: true, accountVersion: nextVersion };
    });
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
  loadAccountVerifiedPhoneE164,
  updateSmsConsent,
  grantBookingSmsConsent,
  revokeSmsConsentByPhone,
};
