/**
 * My Garage access for Admin-pending / finalized bookings (not stuck on draft gate).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

describe('portal access for pending submitted bookings', () => {
  const {
    isDraftRecord,
    isVisibleSubmittedBooking,
    hasSubmissionMarkers,
  } = require('../netlify/lib/booking-visibility');

  it('true checkout drafts stay hidden', () => {
    const draft = {
      id: 'CD1-DRAFT',
      isDraft: true,
      appointmentStatus: 'pending_review',
      jobStatus: 'not_started',
      phone: '5513132956',
    };
    assert.equal(hasSubmissionMarkers(draft), false);
    assert.equal(isDraftRecord(draft), true);
    assert.equal(isVisibleSubmittedBooking(draft), false);
  });

  it('finalized Pending Review is portal-visible even with sticky isDraft', () => {
    const sticky = {
      id: 'CD1-STICKY',
      isDraft: true,
      kind: 'draft',
      status: 'Pending Review',
      appointmentStatus: 'pending_review',
      jobStatus: 'pending_review',
      bookingVersion: 1,
      finalizedAt: '2026-07-18T12:00:00.000Z',
      phone: '5513132956',
    };
    assert.equal(hasSubmissionMarkers(sticky), true);
    assert.equal(isDraftRecord(sticky), false);
    assert.equal(isVisibleSubmittedBooking(sticky), true);
  });

  it('admin-created pending review is portal-visible', () => {
    const adminJob = {
      id: 'CD1-ADMIN',
      isDraft: false,
      kind: 'booking',
      status: 'Pending Review',
      jobStatus: 'pending_review',
      adminCreated: true,
      bookingVersion: 1,
      phone: '5513132956',
    };
    assert.equal(isVisibleSubmittedBooking(adminJob), true);
  });

  it('confirm_booking releases portal flags', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/admin-ops-jobs.js'), 'utf8');
    const idx = src.indexOf("action === 'confirm_booking'");
    assert.ok(idx > 0);
    const slice = src.slice(idx, idx + 700);
    assert.match(slice, /portalReleasePatch/);
    assert.match(slice, /isDraft:\s*false|portalReleasePatch/);
    assert.match(slice, /finalizedAt/);
  });

  it('submit-booking finalize sets pending_review + portalReleasedAt', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/submit-booking.js'), 'utf8');
    assert.match(src, /jobStatus:\s*'pending_review'/);
    assert.match(src, /portalReleasedAt/);
  });

  it('customer-portal-data uses visibility gate with clearer message', () => {
    const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/customer-portal-data.js'), 'utf8');
    assert.match(src, /isVisibleCustomerBooking|isVisibleSubmittedBooking/);
    assert.match(src, /Confirm booking/);
  });
});
