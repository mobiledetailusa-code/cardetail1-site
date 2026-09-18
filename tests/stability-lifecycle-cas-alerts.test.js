'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  classifyStatus,
  canRequestChange,
  normalizeStatus,
} = require('../netlify/lib/appointment-status-policy');
const {
  isTechEligibleBooking,
  canTechTransition,
  TECH_STATUS_UPDATES,
} = require('../netlify/lib/ops-workflow');
const {
  ALERT_KINDS,
  reportOpsStabilityAlert,
  alertSubject,
  alertBody,
} = require('../netlify/lib/ops-stability-alerts');
const { TEMPLATE_KEYS, renderSmsTemplate } = require('../netlify/lib/sms-templates');
const {
  getBookingRecord,
  commitBooking,
  setBookingStoreOverride,
} = require('../netlify/lib/booking-repository');
const { buildNextAggregate, normalizeAggregate } = require('../netlify/lib/booking-aggregate');

function memoryStore(seed = {}) {
  const data = new Map(Object.entries(seed));
  const etags = new Map();
  for (const [k, v] of data) {
    etags.set(k, `v${Number(v.bookingVersion) || 0}:${v.updatedAt || '0'}`);
  }
  return {
    async get(key, opts) {
      const row = data.get(key);
      if (!row) return null;
      return opts && opts.type === 'json' ? structuredClone(row) : row;
    },
    async getWithMetadata(key, opts) {
      const row = data.get(key);
      if (!row) return null;
      return {
        data: opts && opts.type === 'json' ? structuredClone(row) : row,
        etag: etags.get(key) || null,
      };
    },
    async setJSON(key, value, opts = {}) {
      const existing = data.get(key);
      if (opts.onlyIfNew && existing) return { modified: false };
      if (opts.onlyIfMatch != null && etags.get(key) !== opts.onlyIfMatch) {
        return { modified: false };
      }
      data.set(key, structuredClone(value));
      etags.set(key, `v${Number(value.bookingVersion) || 0}:${value.updatedAt || Date.now()}`);
      return { modified: true };
    },
    async list() {
      return { blobs: [...data.keys()].map((key) => ({ key })) };
    },
    _data: data,
  };
}

describe('PDA-11 — jobStatus overrides stale appointmentStatus', () => {
  it('confirmed + in_progress classifies as in_progress', () => {
    const booking = {
      appointmentStatus: 'confirmed',
      jobStatus: 'in_progress',
      status: 'Confirmed',
    };
    assert.equal(normalizeStatus(booking), 'in_progress');
    assert.equal(classifyStatus(booking), 'in_progress');
  });

  it('blocks structural customer changes while technician is in progress', () => {
    const booking = {
      appointmentStatus: 'confirmed',
      jobStatus: 'in_progress',
      status: 'Confirmed',
    };
    const result = canRequestChange(booking, 'package_change');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'action_not_allowed');
    assert.equal(result.phase, 'in_progress');
    assert.equal(result.requiresCall, true);
  });

  it('en_route and arrived also block structural changes', () => {
    for (const jobStatus of ['en_route', 'arrived', 'paused', 'issue_reported']) {
      const booking = { appointmentStatus: 'confirmed', jobStatus };
      assert.equal(classifyStatus(booking), 'in_progress');
      assert.equal(canRequestChange(booking, 'addon').ok, false);
    }
  });

  it('confirmed without field activity still allows auto-apply package change', () => {
    const booking = {
      appointmentStatus: 'confirmed',
      jobStatus: 'confirmed',
      status: 'Confirmed',
    };
    assert.equal(classifyStatus(booking), 'confirmed');
    assert.equal(canRequestChange(booking, 'package_change').ok, true);
    assert.equal(canRequestChange(booking, 'package_change').pendingApproval, false);
  });
});

describe('PDA-10 — technician confirmed-eligible gate', () => {
  it('rejects pending_review even when assigned', () => {
    assert.equal(isTechEligibleBooking({
      jobStatus: 'pending_review',
      appointmentStatus: 'pending_review',
      assignedTechId: 'tech_1',
    }), false);
  });

  it('accepts confirmed / assigned / field statuses', () => {
    for (const jobStatus of ['confirmed', 'assigned', 'accepted', 'en_route', 'in_progress']) {
      assert.equal(isTechEligibleBooking({ jobStatus, appointmentStatus: 'confirmed' }), true);
    }
  });

  it('rejects completed and cancelled', () => {
    assert.equal(isTechEligibleBooking({ jobStatus: 'completed_paid' }), false);
    assert.equal(isTechEligibleBooking({ jobStatus: 'cancelled' }), false);
    assert.equal(isTechEligibleBooking({ jobStatus: 'confirmed', isDraft: true }), false);
  });

  it('enforces status transition matrix', () => {
    assert.equal(canTechTransition('assigned', 'en_route'), true);
    assert.equal(canTechTransition('en_route', 'arrived'), true);
    assert.equal(canTechTransition('arrived', 'in_progress'), true);
    assert.equal(canTechTransition('pending_review', 'in_progress'), false);
    assert.equal(canTechTransition('confirmed', 'in_progress'), false);
    assert.ok(TECH_STATUS_UPDATES.has('in_progress'));
  });
});

describe('Technician status writes use commitBooking CAS', () => {
  it('tech-jobs source routes through commitBooking and eligibility', () => {
    const src = fs.readFileSync(path.join(__dirname, '../netlify/functions/tech-jobs.js'), 'utf8');
    assert.match(src, /commitBooking/);
    assert.match(src, /isTechEligibleBooking/);
    assert.match(src, /canTechTransition/);
    assert.doesNotMatch(src, /await store\.setJSON\(bookingId/);
  });

  it('tech-complete-job non-cash path also uses commitBooking', () => {
    const src = fs.readFileSync(path.join(__dirname, '../netlify/functions/tech-complete-job.js'), 'utf8');
    assert.match(src, /commitBooking/);
    assert.doesNotMatch(src, /await store\.setJSON\(bookingId/);
  });

  it('concurrent tech CAS loses to admin write cleanly', async () => {
    const bookingId = 'CD1-CAS-TECH-1';
    const store = memoryStore({
      [bookingId]: {
        id: bookingId,
        kind: 'booking',
        schemaVersion: 1,
        bookingVersion: 2,
        jobStatus: 'assigned',
        appointmentStatus: 'confirmed',
        status: 'Assigned',
        service: { vehicles: [] },
        ledger: { currency: 'usd', approvedCents: 10000, settledCents: 0, creditedCents: 0, pendingCents: 0, entries: [] },
        quote: { quoteVersion: 1 },
        quoteVersion: 1,
        changeRequests: [],
        paymentAttempts: [],
        updatedAt: '2026-09-01T00:00:00.000Z',
      },
    });
    setBookingStoreOverride(store);
    try {
      const current = await getBookingRecord(bookingId);
      assert.equal(current.booking.bookingVersion, 2);

      // Admin wins first CAS bump.
      const adminNext = buildNextAggregate(current.booking, {
        adminNotes: 'admin first',
        updatedAt: '2026-09-01T00:01:00.000Z',
      });
      const admin = await commitBooking({
        bookingId,
        expectedBookingVersion: 2,
        nextAggregate: adminNext,
      });
      assert.equal(admin.ok, true);
      assert.equal(admin.bookingVersion, 3);

      // Stale tech write from version 2 must conflict.
      const techNext = buildNextAggregate(current.booking, {
        jobStatus: 'en_route',
        status: 'En Route',
        updatedAt: '2026-09-01T00:02:00.000Z',
      });
      const tech = await commitBooking({
        bookingId,
        expectedBookingVersion: 2,
        nextAggregate: techNext,
      });
      assert.equal(tech.ok, false);
      assert.equal(tech.error, 'version_conflict');

      const final = await getBookingRecord(bookingId);
      assert.equal(final.booking.bookingVersion, 3);
      assert.equal(final.booking.jobStatus, 'assigned');
      assert.match(String(final.booking.adminNotes || ''), /admin first/);
    } finally {
      setBookingStoreOverride(null);
    }
  });
});

describe('Admin critical writes use persistMutation / CAS', () => {
  it('admin_note / update_address / request_correction no longer raw setJSON', () => {
    const src = fs.readFileSync(path.join(__dirname, '../netlify/functions/admin-ops-jobs.js'), 'utf8');
    assert.match(src, /action === 'admin_note'[\s\S]*?persistMutation/);
    assert.match(src, /action === 'update_address'[\s\S]*?persistMutation/);
    assert.match(src, /action === 'request_correction'[\s\S]*?persistMutation/);
    assert.match(src, /action === 'post_to_auction'[\s\S]*?persistMutation/);
    assert.match(src, /action === 'archive_test'[\s\S]*?persistMutation/);
  });
});

describe('Ops stability alerts', () => {
  it('renders admin stability SMS template', () => {
    const rendered = renderSmsTemplate(TEMPLATE_KEYS.ADMIN_STABILITY, {
      alertKind: 'payment_reconcile_quarantined',
      bookingRef: 'CD1-ALERT-1',
      detail: 'amount_mismatch',
    });
    assert.equal(rendered.ok, true);
    assert.match(rendered.body, /Cardetail1 Admin:/);
    assert.match(rendered.body, /payment_reconcile_quarantined/);
    assert.match(rendered.body, /CD1-ALERT-1/);
  });

  it('logs structured alert and skips notify when unset', async () => {
    const warnings = [];
    const orig = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
      const result = await reportOpsStabilityAlert({
        kind: ALERT_KINDS.CHANGE_REQUEST_INDEX_LAG,
        bookingId: 'CD1-IDX-1',
        detail: 'index_write_failed',
      }, { env: {} });
      assert.equal(result.logged, true);
      assert.ok(warnings.some((w) => w.includes('ops-stability-alert')));
      assert.equal(result.email.skipped, true);
      assert.equal(result.sms.skipped, true);
    } finally {
      console.warn = orig;
    }
  });

  it('alert copy identifies booking and kind', () => {
    assert.match(alertSubject(ALERT_KINDS.PAYMENT_RECONCILE_QUARANTINED, 'CD1-X'), /quarantined/);
    assert.match(alertBody(ALERT_KINDS.PAYMENT_RECONCILE_FAILED, 'CD1-X', 'version_conflict'), /version_conflict/);
  });

  it('rebuildRequestIndex failure path references ops-stability-alerts', () => {
    const src = fs.readFileSync(path.join(__dirname, '../netlify/lib/booking-commands.js'), 'utf8');
    assert.match(src, /ops-stability-alerts/);
    assert.match(src, /CHANGE_REQUEST_INDEX_LAG/);
  });

  it('payment reconcile quarantine path references ops-stability-alerts', () => {
    const src = fs.readFileSync(path.join(__dirname, '../netlify/lib/payment-service.js'), 'utf8');
    assert.match(src, /PAYMENT_RECONCILE_QUARANTINED/);
    assert.match(src, /PAYMENT_RECONCILE_FAILED/);
  });
});
