'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapAddonLifecycleError } = require('../netlify/lib/customer-lifecycle/addon-error-map');
const { evaluateAddonCompatibility } = require('../netlify/lib/customer-lifecycle/addon-compatibility');
const { evaluateMaintenanceEligibility } = require('../netlify/lib/customer-lifecycle/maintenance-eligibility');
const {
  PRIORITY_MEMBERSHIP_PLAN,
  assertNoLiveMembershipBilling,
  simulateMembershipRevenue,
} = require('../netlify/lib/customer-lifecycle/membership-foundation');
const {
  projectAppointmentDates,
  ensureAppointmentDateFoundation,
  appointmentInstantFromLocalParts,
  assertValidTimeZone,
} = require('../netlify/lib/customer-lifecycle/appointment-dates');
const {
  buildTimelineEvent,
  EVENT_TYPES,
  CUSTOMER_VISIBLE_EVENT_TYPES,
  projectTimelineForCustomer,
  appendEventLogEntry,
} = require('../netlify/lib/customer-lifecycle/appointment-timeline');
const {
  getCompletedServiceHistory,
  isCompletedBookingStatus,
  appendCompletedServiceRecord,
} = require('../netlify/lib/customer-lifecycle/completed-service-history');
const { validateAddonIdsAgainstCatalog } = require('../netlify/lib/addon-financial-mutation');
const fs = require('fs');
const path = require('path');

describe('customer lifecycle addon error map', () => {
  it('maps version_conflict to stale_appointment_version', () => {
    const r = mapAddonLifecycleError('version_conflict');
    assert.equal(r.error, 'stale_appointment_version');
    assert.equal(r.statusCode, 409);
  });
  it('maps unknown_addon to addon_not_found', () => {
    const r = mapAddonLifecycleError('unknown_addon');
    assert.equal(r.error, 'addon_not_found');
  });
  it('maps authentication_failed to unauthorized_appointment', () => {
    const r = mapAddonLifecycleError('authentication_failed');
    assert.equal(r.error, 'unauthorized_appointment');
  });
  it('passes through addon_not_compatible', () => {
    const r = mapAddonLifecycleError('addon_not_compatible');
    assert.equal(r.error, 'addon_not_compatible');
  });
});

describe('addon compatibility', () => {
  it('allows add-on with no rules', () => {
    const r = evaluateAddonCompatibility({ addonId: 'rainx', packageId: 'maint', category: 'cars' });
    assert.equal(r.ok, true);
  });
  it('rejects engine on maint package', () => {
    const r = evaluateAddonCompatibility({ addonId: 'engine', packageId: 'maint', category: 'cars' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'addon_not_compatible');
  });
  it('rejects babyseat outside interior packages', () => {
    const r = evaluateAddonCompatibility({ addonId: 'babyseat', packageId: 'maint', category: 'cars' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'addon_not_compatible');
  });
  it('allows babyseat on interior', () => {
    const r = evaluateAddonCompatibility({ addonId: 'babyseat', packageId: 'interior', category: 'cars' });
    assert.equal(r.ok, true);
  });
  it('validateAddonIdsAgainstCatalog emits addon_not_compatible', () => {
    const service = {
      vehicles: [{ vehicleId: 'v1', category: 'cars', packageId: 'maint', addOns: [] }],
    };
    const r = validateAddonIdsAgainstCatalog(service, { vehicleId: 'v1' }, ['engine']);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'addon_not_compatible');
  });
  it('unknown addon remains addon not found path', () => {
    const service = {
      vehicles: [{ vehicleId: 'v1', category: 'cars', packageId: 'full', addOns: [] }],
    };
    const r = validateAddonIdsAgainstCatalog(service, { vehicleId: 'v1' }, ['not_a_real_addon_xyz']);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'unknown_addon_id');
  });
});

describe('maintenance eligibility', () => {
  it('denies with no completed service', () => {
    const r = evaluateMaintenanceEligibility({ completedServiceHistory: [] });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, 'no_completed_service');
  });
  it('eligible within 45 days same vehicle', () => {
    const completedAtUtc = new Date(Date.now() - 10 * 86400000).toISOString();
    const r = evaluateMaintenanceEligibility({
      vehicleId: 'v1',
      completedServiceHistory: [{ completedAtUtc, vehicleId: 'v1', packageId: 'pkg_a', status: 'completed' }],
    });
    assert.equal(r.eligible, true);
    assert.equal(r.reason, 'eligible_recent_completed_service');
  });
  it('exact 45-day boundary eligible', () => {
    const completedAtUtc = new Date(Date.now() - 45 * 86400000).toISOString();
    const r = evaluateMaintenanceEligibility({
      vehicleId: 'v1',
      requestedAtUtc: new Date().toISOString(),
      completedServiceHistory: [{ completedAtUtc, vehicleId: 'v1', packageId: 'pkg_a', status: 'completed' }],
    });
    assert.equal(r.eligible, true);
  });
  it('46-day moves to recurring tier still eligible', () => {
    const completedAtUtc = new Date(Date.now() - 46 * 86400000).toISOString();
    const r = evaluateMaintenanceEligibility({
      vehicleId: 'v1',
      completedServiceHistory: [{ completedAtUtc, vehicleId: 'v1', packageId: 'pkg_a', status: 'completed' }],
    });
    assert.equal(r.eligible, true);
    assert.equal(r.pricingTier, 'recurring_maintenance');
  });
  it('exact 90-day recurring eligible', () => {
    const completedAtUtc = new Date(Date.now() - 90 * 86400000).toISOString();
    const r = evaluateMaintenanceEligibility({
      vehicleId: 'v1',
      completedServiceHistory: [{ completedAtUtc, vehicleId: 'v1', packageId: 'pkg_a', status: 'completed' }],
    });
    assert.equal(r.eligible, true);
  });
  it('91-day enters grace', () => {
    const completedAtUtc = new Date(Date.now() - 91 * 86400000).toISOString();
    const r = evaluateMaintenanceEligibility({
      vehicleId: 'v1',
      completedServiceHistory: [{ completedAtUtc, vehicleId: 'v1', packageId: 'pkg_a', status: 'completed' }],
    });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, 'grace_period_manual_review');
  });
  it('exact 120-day grace', () => {
    const completedAtUtc = new Date(Date.now() - 120 * 86400000).toISOString();
    const r = evaluateMaintenanceEligibility({
      vehicleId: 'v1',
      completedServiceHistory: [{ completedAtUtc, vehicleId: 'v1', packageId: 'pkg_a', status: 'completed' }],
    });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, 'grace_period_manual_review');
  });
  it('121-day outside window', () => {
    const completedAtUtc = new Date(Date.now() - 121 * 86400000).toISOString();
    const r = evaluateMaintenanceEligibility({
      vehicleId: 'v1',
      completedServiceHistory: [{ completedAtUtc, vehicleId: 'v1', packageId: 'pkg_a', status: 'completed' }],
    });
    assert.equal(r.eligible, false);
    assert.ok(r.requalificationRequired || r.reason === 'outside_maintenance_window');
  });
  it('different vehicle is not eligible when required', () => {
    const completedAtUtc = new Date(Date.now() - 10 * 86400000).toISOString();
    const r = evaluateMaintenanceEligibility({
      vehicleId: 'v2',
      completedServiceHistory: [{ completedAtUtc, vehicleId: 'v1', packageId: 'pkg_a', status: 'completed' }],
    });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, 'different_vehicle');
  });
  it('membership does not auto-grant outside window', () => {
    const completedAtUtc = new Date(Date.now() - 200 * 86400000).toISOString();
    const r = evaluateMaintenanceEligibility({
      vehicleId: 'v1',
      membershipStatus: 'active',
      completedServiceHistory: [{ completedAtUtc, vehicleId: 'v1', packageId: 'pkg_a', status: 'completed' }],
    });
    assert.equal(r.eligible, false);
    assert.ok(r.requalificationRequired || r.reason === 'outside_maintenance_window');
  });
});

describe('completed service history repository', () => {
  it('returns empty when no completed bookings', async () => {
    const rows = await getCompletedServiceHistory({
      customerId: 'cust_1',
      bookings: [{ id: 'b1', status: 'Confirmed', customerId: 'cust_1' }],
    });
    assert.equal(rows.length, 0);
  });
  it('scopes by customer and vehicle with completion timestamp', async () => {
    const rows = await getCompletedServiceHistory({
      customerId: 'cust_1',
      vehicleId: 'v1',
      beforeUtc: '2026-07-28T00:00:00.000Z',
      bookings: [
        {
          bookingId: 'b_done',
          customerId: 'cust_1',
          vehicleId: 'v1',
          packageId: 'full',
          jobStatus: 'completed_paid',
          completedAtUtc: '2026-07-01T15:00:00.000Z',
        },
        {
          bookingId: 'b_other_vehicle',
          customerId: 'cust_1',
          vehicleId: 'v2',
          jobStatus: 'completed_paid',
          completedAtUtc: '2026-07-02T15:00:00.000Z',
        },
        {
          bookingId: 'b_other_cust',
          customerId: 'cust_x',
          vehicleId: 'v1',
          jobStatus: 'completed_paid',
          completedAtUtc: '2026-07-03T15:00:00.000Z',
        },
      ],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].bookingId, 'b_done');
    assert.equal(rows[0].status, 'completed');
  });
  it('isCompletedBookingStatus recognizes completed_paid', () => {
    assert.equal(isCompletedBookingStatus({ jobStatus: 'completed_paid' }), true);
    assert.equal(isCompletedBookingStatus({ status: 'Cancelled' }), false);
  });
  it('appendCompletedServiceRecord is idempotent by bookingId', () => {
    const a = appendCompletedServiceRecord({}, {
      bookingId: 'b1',
      completedAtUtc: '2026-07-01T00:00:00.000Z',
      vehicleId: 'v1',
      packageId: 'full',
      status: 'completed',
    });
    const b = appendCompletedServiceRecord(a, {
      bookingId: 'b1',
      completedAtUtc: '2026-07-01T00:00:00.000Z',
      vehicleId: 'v1',
      packageId: 'full',
      status: 'completed',
    });
    assert.equal(b.completedServiceHistory.length, 1);
  });
});

describe('membership foundation', () => {
  it('seeds priority membership at 999 cents access fee', () => {
    assert.equal(PRIORITY_MEMBERSHIP_PLAN.priceCents, 999);
    assert.equal(PRIORITY_MEMBERSHIP_PLAN.billingModel, 'access_fee');
    assert.equal(PRIORITY_MEMBERSHIP_PLAN.automaticMaintenancePricing, false);
  });
  it('hard-denies live billing by default', () => {
    const gate = assertNoLiveMembershipBilling({ appEnv: 'staging', allowLiveBilling: false });
    assert.equal(gate.ok, false);
    assert.equal(gate.error, 'membership_live_billing_denied');
  });
  it('simulates membership revenue with disclaimer', () => {
    const sim = simulateMembershipRevenue({ membersAt25: 25 });
    assert.equal(sim.scenarios[0].members, 25);
    assert.equal(sim.scenarios[0].monthlyGrossCents, 25 * 999);
    assert.match(sim.scenarios[0].disclaimer, /Assumption-based/);
  });
});

describe('appointment dates + timezone', () => {
  it('projects request and appointment dates', () => {
    const p = projectAppointmentDates({
      createdAt: '2026-07-01T15:00:00.000Z',
      preferredDate: '2026-07-10',
      preferredTime: '10:00 AM',
      confirmedDate: '2026-07-12',
      bookingVersion: 3,
    });
    assert.equal(p.bookingTimezone, 'America/New_York');
    assert.ok(p.requestSubmittedAtUtc);
    assert.ok(p.currentAppointmentStartUtc);
    assert.equal(p.bookingVersion, 3);
  });
  it('ensure foundation patch is additive', () => {
    const patch = ensureAppointmentDateFoundation({
      createdAt: '2026-07-01T15:00:00.000Z',
      preferredDate: '2026-07-10',
    });
    assert.ok(patch.requestSubmittedAtUtc || patch.bookingTimezone);
  });
  it('winter America/New_York EST offset (-5)', () => {
    // 2026-01-15 10:00 America/New_York = 15:00 UTC
    const iso = appointmentInstantFromLocalParts('2026-01-15', '10:00 AM', 'America/New_York');
    assert.equal(iso, '2026-01-15T15:00:00.000Z');
  });
  it('summer America/New_York EDT offset (-4)', () => {
    // 2026-07-15 10:00 America/New_York = 14:00 UTC
    const iso = appointmentInstantFromLocalParts('2026-07-15', '10:00 AM', 'America/New_York');
    assert.equal(iso, '2026-07-15T14:00:00.000Z');
  });
  it('spring-forward nonexistent local time returns null', () => {
    // US 2026 spring forward: 2026-03-08 02:00–02:59 do not exist in America/New_York
    const iso = appointmentInstantFromLocalParts('2026-03-08', '2:30 AM', 'America/New_York');
    assert.equal(iso, null);
  });
  it('fall-back ambiguous prefers earlier (DST) occurrence', () => {
    // US 2026 fall back: 2026-11-01 01:30 occurs twice; prefer earlier = EDT (UTC-4) → 05:30Z
    const iso = appointmentInstantFromLocalParts('2026-11-01', '1:30 AM', 'America/New_York');
    assert.equal(iso, '2026-11-01T05:30:00.000Z');
  });
  it('midnight local converts correctly', () => {
    const iso = appointmentInstantFromLocalParts('2026-07-15', '12:00 AM', 'America/New_York');
    assert.equal(iso, '2026-07-15T04:00:00.000Z');
  });
  it('date boundary crossing for late evening', () => {
    const iso = appointmentInstantFromLocalParts('2026-07-15', '11:00 PM', 'America/New_York');
    assert.equal(iso, '2026-07-16T03:00:00.000Z');
  });
  it('supports another IANA timezone (America/Chicago)', () => {
    const iso = appointmentInstantFromLocalParts('2026-01-15', '10:00 AM', 'America/Chicago');
    assert.equal(iso, '2026-01-15T16:00:00.000Z');
  });
  it('invalid timezone returns null', () => {
    assert.equal(assertValidTimeZone('Not/AZone'), false);
    assert.equal(appointmentInstantFromLocalParts('2026-01-15', '10:00 AM', 'Not/AZone'), null);
  });
});

describe('appointment timeline audience + append-only', () => {
  it('builds immutable timeline events for known types', () => {
    assert.ok(EVENT_TYPES.includes('addon_requested'));
    const e = buildTimelineEvent({
      eventType: 'addon_requested',
      bookingId: 'b1',
      changeSummary: 'addon_requested: addon_wax',
      actorType: 'customer',
    });
    assert.equal(e.eventType, 'addon_requested');
    assert.ok(e.eventId);
    assert.throws(() => buildTimelineEvent({ eventType: 'not_a_real_event' }));
  });
  it('filters customer-visible events and strips internals', () => {
    const projected = projectTimelineForCustomer([
      {
        eventType: 'addon_requested',
        occurredAtUtc: '2026-07-01T00:00:00.000Z',
        changeSummary: 'ok',
        internalNote: 'secret note',
        metadata: { token: 'abc' },
      },
      {
        eventType: 'email_failed',
        occurredAtUtc: '2026-07-01T01:00:00.000Z',
        changeSummary: 'smtp',
        internalNote: 'provider payload',
      },
      {
        eventType: 'payment_failed',
        occurredAtUtc: '2026-07-01T02:00:00.000Z',
        changeSummary: 'card decline diagnostics',
      },
    ]);
    assert.equal(projected.length, 1);
    assert.equal(projected[0].eventType, 'addon_requested');
    assert.equal(projected[0].internalNote, undefined);
    assert.equal(projected[0].metadata, undefined);
    assert.ok(CUSTOMER_VISIBLE_EVENT_TYPES.includes('payment_succeeded'));
    assert.ok(!CUSTOMER_VISIBLE_EVENT_TYPES.includes('email_failed'));
  });
  it('appendEventLogEntry is append-only and idempotent by eventId', () => {
    const e = buildTimelineEvent({ eventType: 'booking_approved', bookingId: 'b1', actorType: 'owner' });
    const a = appendEventLogEntry({}, e);
    const b = appendEventLogEntry(a, e);
    assert.equal(a.eventLog.length, 1);
    assert.equal(b.eventLog.length, 1);
  });
  it('timeline module exports no update/delete appointment event methods', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'netlify', 'lib', 'customer-lifecycle', 'appointment-timeline.js'),
      'utf8'
    );
    assert.doesNotMatch(src, /appointmentEvent\.update\b/);
    assert.doesNotMatch(src, /appointmentEvent\.delete\b/);
    assert.match(src, /appointmentEvent\.create/);
    assert.match(src, /appointmentEvent\.findMany/);
  });
});
