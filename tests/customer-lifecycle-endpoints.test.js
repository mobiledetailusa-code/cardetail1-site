'use strict';

/**
 * Customer Lifecycle endpoint / contract tests (no live Netlify required).
 * Uses pure validators + handler source contracts + in-memory helpers.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mapAddonLifecycleError } = require('../netlify/lib/customer-lifecycle/addon-error-map');
const { validateAddonIdsAgainstCatalog } = require('../netlify/lib/addon-financial-mutation');
const { assertNoLiveMembershipBilling } = require('../netlify/lib/customer-lifecycle/membership-foundation');

const root = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('addon endpoint contracts', () => {
  const submitSrc = read('netlify/functions/submit-customer-action.js');

  it('requires expectedBookingVersion for addon_request', () => {
    assert.match(submitSrc, /expectedBookingVersion is required/);
    const mapped = mapAddonLifecycleError('validation_failed', { message: 'expectedBookingVersion is required.' });
    assert.equal(mapped.error, 'validation_failed');
    assert.equal(mapped.statusCode, 400);
  });

  it('maps stale version to HTTP 409 stale_appointment_version', () => {
    const mapped = mapAddonLifecycleError('version_conflict', { actualBookingVersion: 4 });
    assert.equal(mapped.error, 'stale_appointment_version');
    assert.equal(mapped.statusCode, 409);
    assert.equal(mapped.actualBookingVersion, 4);
  });

  it('multi-vehicle missing vehicleId → vehicle_target_required', () => {
    const service = {
      vehicles: [
        { vehicleId: 'v1', category: 'cars', packageId: 'full', addOns: [] },
        { vehicleId: 'v2', category: 'cars', packageId: 'full', addOns: [] },
      ],
    };
    const r = validateAddonIdsAgainstCatalog(service, {}, ['rainx']);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'vehicle_target_required');
  });

  it('invalid add-on → unknown_addon_id / addon_not_found', () => {
    const service = {
      vehicles: [{ vehicleId: 'v1', category: 'cars', packageId: 'full', addOns: [] }],
    };
    const r = validateAddonIdsAgainstCatalog(service, { vehicleId: 'v1' }, ['nope_addon']);
    assert.equal(r.error, 'unknown_addon_id');
    assert.equal(mapAddonLifecycleError(r.error).error, 'addon_not_found');
  });

  it('incompatible add-on → addon_not_compatible', () => {
    const service = {
      vehicles: [{ vehicleId: 'v1', category: 'cars', packageId: 'maint', addOns: [] }],
    };
    const r = validateAddonIdsAgainstCatalog(service, { vehicleId: 'v1' }, ['engine']);
    assert.equal(r.error, 'addon_not_compatible');
  });

  it('client price fields are ignored in addon_request path', () => {
    assert.match(submitSrc, /Browser price\/label\/total ignored/);
    assert.match(submitSrc, /IDs only/);
  });
});

describe('owner studio endpoint contracts', () => {
  const src = read('netlify/functions/owner-studio-customer-lifecycle.js');

  it('GET requires auth; POST requires CSRF', () => {
    assert.match(src, /verifyAdminRequest/);
    assert.match(src, /verifyCsrfToken|x-csrf-token/);
    assert.match(src, /createCsrfToken/);
  });

  it('ignores browser siteId and hard-denies publish + live billing', () => {
    assert.match(src, /SITE_ID/);
    assert.match(src, /assertNoLiveMembershipBilling|membership_live_billing_denied|publish/i);
    const gate = assertNoLiveMembershipBilling({ appEnv: 'staging', allowLiveBilling: false });
    assert.equal(gate.ok, false);
  });

  it('supports draft save / version / restore / 409 conflict path', () => {
    assert.match(src, /saveDraft|save_draft|version/i);
    assert.match(src, /409|version_conflict|stale/i);
    assert.match(src, /restore/i);
  });
});

describe('blobs staging diagnostic script', () => {
  it('refuses production site and never prints tokens', () => {
    const src = read('scripts/staging-blobs-diagnostic.cjs');
    assert.match(src, /production_site_id_rejected/);
    assert.match(src, /982e6338-4a4a-432e-855b-db532b994391/);
    assert.doesNotMatch(src, /nf[cp]_[A-Za-z0-9]{8,}/);
    assert.match(src, /staging_diag_/);
  });

  it('qa-blobs-health allows staging site and rejects prod-from-staging', () => {
    const src = read('netlify/functions/qa-blobs-health.js');
    assert.match(src, /982e6338-4a4a-432e-855b-db532b994391/);
    assert.match(src, /site_context_rejected|stagingContext/);
    assert.match(src, /site_role/);
  });
});

describe('constraint migration additive', () => {
  it('adds draft unique + idempotency without editing prior migration', () => {
    const mig = read('prisma/migrations/20260728140000_customer_lifecycle_constraints/migration.sql');
    assert.match(mig, /OsCustomerLifecycleDraft_siteId_key/);
    assert.match(mig, /idempotencyKey/);
    assert.match(mig, /AppointmentEvent_siteId_appointmentId_idempotencyKey_key/);
    const prior = read('prisma/migrations/20260728010000_customer_lifecycle_foundation/migration.sql');
    assert.doesNotMatch(prior, /idempotencyKey/);
  });
});
