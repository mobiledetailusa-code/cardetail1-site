'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapAddonLifecycleError } = require('../netlify/lib/customer-lifecycle/addon-error-map');
const { evaluateMaintenanceEligibility } = require('../netlify/lib/customer-lifecycle/maintenance-eligibility');
const {
  PRIORITY_MEMBERSHIP_PLAN,
  assertNoLiveMembershipBilling,
  simulateMembershipRevenue,
} = require('../netlify/lib/customer-lifecycle/membership-foundation');
const { projectAppointmentDates, ensureAppointmentDateFoundation } = require('../netlify/lib/customer-lifecycle/appointment-dates');
const { buildTimelineEvent, EVENT_TYPES } = require('../netlify/lib/customer-lifecycle/appointment-timeline');

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

describe('appointment dates + timeline', () => {
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
});
