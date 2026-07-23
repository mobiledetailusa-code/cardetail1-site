/**
 * Safe Customer + Admin projections over the same CustomerAccount authority.
 * Never exposes Stripe IDs, session records, raw AuditEvent rows, merge
 * candidates, internal notes, or authentication metadata.
 */

const {
  loadCustomerAccountGraph,
  listBookingIdsForAccount,
  EXISTING_CUSTOMER_ROLE,
} = require('./customer-account-service');

function projectProfile(profile) {
  if (!profile) {
    return {
      firstName: null,
      lastName: null,
      displayName: null,
      email: null,
      phone: null,
      preferredContactChannel: null,
      timezone: null,
      updatedAt: null,
      // Stage 2A: email/phone are verified contact surfaces — read-only in portal.
      emailReadOnly: true,
      phoneReadOnly: true,
    };
  }
  return {
    firstName: profile.firstName || null,
    lastName: profile.lastName || null,
    displayName: profile.displayName || null,
    email: profile.email || null,
    phone: profile.phone || null,
    preferredContactChannel: profile.preferredContactChannel || null,
    timezone: profile.timezone || null,
    updatedAt: profile.updatedAt || null,
    emailReadOnly: true,
    phoneReadOnly: true,
  };
}

function projectAddresses(addresses) {
  if (!Array.isArray(addresses)) return [];
  return addresses
    .filter((a) => !a.archivedAt)
    .map((a) => ({
      id: a.id,
      label: a.label || null,
      line1: a.line1,
      line2: a.line2 || null,
      city: a.city || null,
      state: a.state || null,
      postalCode: a.postalCode || null,
      country: a.country || 'US',
      isDefault: !!a.isDefault,
    }));
}

function projectVehicles(vehicles) {
  if (!Array.isArray(vehicles)) return [];
  return vehicles
    .filter((v) => !v.archivedAt)
    .map((v) => ({
      id: v.id,
      label: v.label || null,
      category: v.category || null,
      year: v.year || null,
      make: v.make || null,
      model: v.model || null,
      color: v.color || null,
      notes: v.notes || null,
      isDefault: !!v.isDefault,
    }));
}

function projectConsents(consents) {
  const channels = [
    'email_transactional',
    'sms_transactional',
    'email_marketing',
    'sms_marketing',
  ];
  const byChannel = new Map(
    (Array.isArray(consents) ? consents : []).map((c) => [c.channel, c])
  );
  return channels.map((channel) => {
    const row = byChannel.get(channel);
    return {
      channel,
      status: row?.status || 'pending',
      grantedAt: row?.grantedAt || null,
      revokedAt: row?.revokedAt || null,
    };
  });
}

/**
 * Customer-safe projection for portal responses.
 */
function projectCustomerIdentity(graph, {
  linkStatus = 'linked',
  linkedBookingCount = null,
} = {}) {
  if (!graph) return null;
  const bookingCount = linkedBookingCount != null
    ? linkedBookingCount
    : (Array.isArray(graph.bookings) ? graph.bookings.length : 0);

  const addresses = projectAddresses(graph.addresses);
  const defaultAddressId = addresses.find((a) => a.isDefault)?.id || null;
  const vehicles = projectVehicles(graph.vehicles);
  const defaultVehicleId = vehicles.find((v) => v.isDefault)?.id || null;

  return {
    customerAccountId: graph.id,
    profile: projectProfile(graph.profile),
    addresses,
    defaultAddressId,
    vehicles,
    defaultVehicleId,
    consents: projectConsents(graph.consents),
    accountVersion: graph.version,
    accountStatus: graph.status,
    updatedAt: graph.updatedAt || null,
    migration: {
      linkStatus,
      linkedBookingCount: bookingCount,
      vehiclesImported: !!graph.vehiclesImportedAt,
    },
  };
}

function defaultAddressSummary(addresses) {
  const active = (addresses || []).filter((a) => !a.archivedAt);
  const preferred = active.find((a) => a.isDefault) || null;
  if (!preferred) return null;
  const parts = [
    preferred.line1,
    preferred.city,
    preferred.state,
    preferred.postalCode,
  ].filter(Boolean);
  return {
    label: preferred.label || null,
    summary: parts.join(', '),
    city: preferred.city || null,
    state: preferred.state || null,
    postalCode: preferred.postalCode || null,
    isDefault: true,
  };
}

function defaultVehicleSummary(vehicles) {
  const active = (vehicles || []).filter((v) => !v.archivedAt);
  const preferred = active.find((v) => v.isDefault) || null;
  if (!preferred) return null;
  const label = preferred.label
    || [preferred.year, preferred.make, preferred.model].filter(Boolean).join(' ')
    || null;
  return {
    id: preferred.id,
    label,
    category: preferred.category || null,
    isDefault: true,
  };
}

function consentSummary(consents) {
  const projected = projectConsents(consents);
  return {
    emailTransactional: projected.find((c) => c.channel === 'email_transactional')?.status || 'pending',
    smsTransactional: projected.find((c) => c.channel === 'sms_transactional')?.status || 'pending',
    emailMarketing: projected.find((c) => c.channel === 'email_marketing')?.status || 'pending',
    smsMarketing: projected.find((c) => c.channel === 'sms_marketing')?.status || 'pending',
  };
}

/**
 * Minimal Admin-safe account summary — same relational authority as Customer.
 * Read-only for Stage 2A (no Admin profile/address editing).
 */
function projectCustomerAccountForAdmin(graph, {
  linkedBookingIds = [],
  linkedVehicleCount = null,
  lastServiceDate = null,
} = {}) {
  if (!graph) return null;
  const profile = graph.profile || {};
  const name = profile.displayName
    || [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim()
    || null;
  const bookingIds = linkedBookingIds.length
    ? linkedBookingIds
    : (graph.bookings || []).map((b) => b.id);

  let derivedLastService = lastServiceDate;
  if (!derivedLastService && Array.isArray(graph.bookings) && graph.bookings.length) {
    const sorted = [...graph.bookings].sort((a, b) =>
      String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    );
    derivedLastService = sorted[0]?.updatedAt || null;
  }

  const activeAddresses = (graph.addresses || []).filter((a) => !a.archivedAt);
  const activeVehicles = (graph.vehicles || []).filter((v) => !v.archivedAt);
  const derivedVehicleCount = linkedVehicleCount == null
    ? activeVehicles.length
    : Number(linkedVehicleCount);

  return {
    customerAccountId: graph.id,
    name,
    email: profile.email || null,
    phone: profile.phone || null,
    defaultAddress: defaultAddressSummary(graph.addresses),
    activeAddressCount: activeAddresses.length,
    defaultVehicle: defaultVehicleSummary(graph.vehicles),
    activeVehicleCount: activeVehicles.length,
    profileUpdatedAt: profile.updatedAt || null,
    linkedBookingCount: bookingIds.length,
    linkedBookingIds: bookingIds.slice(0, 100),
    linkedVehicleCount: derivedVehicleCount,
    accountStatus: graph.status,
    accountVersion: graph.version,
    consents: consentSummary(graph.consents),
    lastServiceDate: derivedLastService,
  };
}

async function buildCustomerProjection(customerAccountId, opts = {}) {
  const graph = await loadCustomerAccountGraph(customerAccountId, opts);
  if (!graph) return null;
  return projectCustomerIdentity(graph, {
    linkStatus: opts.linkStatus || 'linked',
    linkedBookingCount: opts.linkedBookingCount,
  });
}

async function buildAdminCustomerAccountSummary(customerAccountId, opts = {}) {
  const graph = await loadCustomerAccountGraph(customerAccountId, opts);
  if (!graph) return null;
  const linkedBookingIds = opts.linkedBookingIds
    || await listBookingIdsForAccount(customerAccountId, opts);
  return projectCustomerAccountForAdmin(graph, {
    linkedBookingIds,
    linkedVehicleCount: opts.linkedVehicleCount,
    lastServiceDate: opts.lastServiceDate,
  });
}

/**
 * Strip any accidental internal fields from a projection object.
 */
function assertSafeCustomerProjection(projection) {
  if (!projection || typeof projection !== 'object') return projection;
  const forbidden = [
    'stripeCustomerId',
    'mergedIntoAccountId',
    'session',
    'sessionId',
    'sid',
    'auditEvents',
    'rawAudit',
    'mergeCandidates',
    'internalNotes',
    'adminNotes',
    'auth',
    'token',
    'cookie',
    'emailHash',
    'normalizedEmail',
    'normalizedPhone',
  ];
  const out = { ...projection };
  for (const key of forbidden) delete out[key];
  if (out.profile) {
    delete out.profile.normalizedEmail;
    delete out.profile.normalizedPhone;
  }
  return out;
}

module.exports = {
  EXISTING_CUSTOMER_ROLE,
  projectProfile,
  projectAddresses,
  projectVehicles,
  projectConsents,
  projectCustomerIdentity,
  projectCustomerAccountForAdmin,
  buildCustomerProjection,
  buildAdminCustomerAccountSummary,
  assertSafeCustomerProjection,
};
