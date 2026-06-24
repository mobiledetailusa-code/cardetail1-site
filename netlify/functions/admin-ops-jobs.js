// Admin-only jobs feed + admin ops actions for Admin Ops dashboard.
const { blobsStore, listAllBlobs, fetchBlobRecords, jsonCors, verifyAdminKey, sanitizeText } = require('../lib/tech-security');
const {
  projectJobForAdmin, normalizeJobStatus, normalizePaymentWorkflowStatus, appendEventLog,
} = require('../lib/ops-workflow');
const { getOpsSettings } = require('../lib/ops-config');
const { createAuctionForBooking, assignAuctionWinnerToBooking } = require('../lib/auction-ops');

const TEST_SIGNALS = [
  b => b.isTest === true,
  b => /^test/i.test(String(b.firstName || '')),
  b => /^test/i.test(String(b.lastName || '')),
  b => /test/i.test(String(b.email || '')),
  b => /test/i.test(String(b.id || '')),
  b => /smoke|prodtest|pendtest|cashtest|validationtest/i.test(
    [b.firstName, b.lastName, b.email, b.id, b.notes, b.customerNote].join(' ')
  ),
  b => String(b.vehicle || b.vehicleCategory || '').toLowerCase().includes('test'),
  b => String(b.notes || b.customerNote || '').toLowerCase().includes('test booking'),
];

function isLikelyTestBooking(b) {
  return TEST_SIGNALS.some(fn => { try { return fn(b); } catch { return false; } });
}

function archiveBookingRecord(booking, reason) {
  const now = new Date().toISOString();
  return {
    ...booking,
    isTest: true,
    archived: true,
    archivedReason: sanitizeText(reason, 200) || 'admin_archive',
    archivedAt: now,
    archivedBy: 'admin',
    previousStatus: booking.status || '',
    status: 'archived_test',
    jobStatus: 'archived_test',
    updatedAt: now,
    eventLog: appendEventLog(booking, { action: 'archived_test', by: 'admin', reason }),
  };
}

async function listJobs(q) {
  const showTest = String(q.showTest || '') === '1';
  const statusFilter = sanitizeText(q.jobStatus || q.status, 64);
  const search = sanitizeText(q.search, 120).toLowerCase();
  let store;
  try {
    store = await blobsStore('cd1-bookings');
  } catch (e) {
    console.error('[admin-ops-jobs] blobsStore(cd1-bookings) failed:', e.message);
    return [];
  }
  const blobs = await listAllBlobs(store, 'cd1-bookings');
  let jobs = (await fetchBlobRecords(store, blobs)).filter(b => b && !b.isDraft);

  if (!showTest) jobs = jobs.filter(b => !b.isTest && !b.archived && b.jobStatus !== 'archived_test');
  if (statusFilter) jobs = jobs.filter(b => normalizeJobStatus(b) === statusFilter);
  if (search) {
    jobs = jobs.filter(b => {
      const hay = [
        b.id, b.firstName, b.lastName, b.phone, b.email, b.vehicle, b.vehicleLabel,
        b.package, b.assignedTechName, b.assignedTechId,
      ].join(' ').toLowerCase();
      return hay.includes(search);
    });
  }
  jobs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return jobs.map(b => {
    try {
      const j = projectJobForAdmin(b);
      j.jobStatus = normalizeJobStatus(b);
      j.paymentWorkflowStatus = normalizePaymentWorkflowStatus(b);
      delete j.stripeCustomerId;
      delete j.stripePaymentMethodId;
      delete j.setupIntentId;
      delete j.paymentIntentId;
      delete j.amountAuthorizedCents;
      delete j.amountCapturedCents;
      delete j.cardOnFileStatus;
      return j;
    } catch (_) {
      // Never let one malformed record blank the entire admin feed.
      return {
        id: (b && b.id) || 'unknown',
        firstName: (b && b.firstName) || '',
        lastName: (b && b.lastName) || '',
        jobStatus: 'pending_review',
        paymentWorkflowStatus: 'no_payment_required_yet',
        _malformed: true,
      };
    }
  });
}

async function handleAdminAction(body) {
  const action = sanitizeText(body.action, 40);
  const bookingId = sanitizeText(body.bookingId, 48);
  if (!bookingId) return jsonCors(400, { ok: false, error: 'bookingId_required' });

  const store = await blobsStore('cd1-bookings');
  const booking = await store.get(bookingId, { type: 'json' }).catch(() => null);
  if (!booking) return jsonCors(404, { ok: false, error: 'booking_not_found' });

  const now = new Date().toISOString();

  if (action === 'admin_note') {
    const note = sanitizeText(body.note, 1000);
    if (!note) return jsonCors(400, { ok: false, error: 'note_required' });
    await store.setJSON(bookingId, {
      ...booking,
      adminNotes: ((booking.adminNotes || '') + '\n[' + now.slice(0, 16) + '] ' + note).trim(),
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'admin_note', by: 'admin', note }),
    });
    return jsonCors(200, { ok: true, bookingId });
  }

  if (action === 'approve_completion') {
    if (booking.jobStatus !== 'completed_pending_admin_review') {
      return jsonCors(409, { ok: false, error: 'not_pending_admin_review' });
    }
    const patched = {
      ...booking,
      adminReviewRequired: false,
      adminReviewedAt: now,
      adminReviewed: true,
      jobStatus: 'completed_pending_payment',
      paymentWorkflowStatus: 'payment_action_required',
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'completion_approved', by: 'admin' }),
    };
    await store.setJSON(bookingId, patched);
    return jsonCors(200, { ok: true, bookingId, jobStatus: patched.jobStatus });
  }

  if (action === 'reopen_job') {
    await store.setJSON(bookingId, {
      ...booking,
      jobStatus: 'reopened',
      completionSubmitted: false,
      adminReviewRequired: true,
      reopenedAt: now,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'job_reopened', by: 'admin', reason: sanitizeText(body.reason, 500) }),
    });
    return jsonCors(200, { ok: true, bookingId, jobStatus: 'reopened' });
  }

  if (action === 'request_correction') {
    const msg = sanitizeText(body.message, 500);
    await store.setJSON(bookingId, {
      ...booking,
      jobStatus: 'in_progress',
      adminReviewRequired: true,
      correctionRequestedAt: now,
      correctionRequestNote: msg,
      completionSubmitted: false,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'correction_requested', by: 'admin', message: msg }),
    });
    return jsonCors(200, { ok: true, bookingId });
  }

  if (action === 'confirm_booking') {
    const patched = {
      ...booking,
      jobStatus: 'confirmed',
      appointmentStatus: 'confirmed',
      status: 'Confirmed',
      adminReviewed: true,
      adminReviewedAt: now,
      confirmedAt: booking.confirmedAt || now,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'booking_confirmed', by: 'admin' }),
    };
    await store.setJSON(bookingId, patched);

    const settings = await getOpsSettings();
    let auctionResult = null;
    if (settings.autoPostToAuctionOnConfirm || settings.dispatchMode === 'auction') {
      auctionResult = await createAuctionForBooking(patched, { notifySms: true, notifyEmail: true });
    }
    return jsonCors(200, {
      ok: true, bookingId, jobStatus: patched.jobStatus,
      auction: auctionResult && auctionResult.ok ? { posted: true, bidMax: auctionResult.bidMax, closesAt: auctionResult.closesAt } : null,
    });
  }

  if (action === 'post_to_auction') {
    const result = await createAuctionForBooking(booking, { notifySms: body.notifySms !== false, notifyEmail: body.notifyEmail !== false });
    if (!result.ok) return jsonCors(503, { ok: false, error: result.error || 'auction_failed' });
    await store.setJSON(bookingId, {
      ...booking,
      auctionPostedAt: now,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'posted_to_auction', by: 'admin', bidMax: result.bidMax }),
    });
    return jsonCors(200, { ok: true, bookingId, bidMax: result.bidMax, closesAt: result.closesAt, notifiedSms: result.notifiedSms });
  }

  if (action === 'assign_auction_winner') {
    const result = await assignAuctionWinnerToBooking(bookingId, sanitizeText(body.note, 300));
    if (!result.ok) return jsonCors(409, { ok: false, error: result.error });
    return jsonCors(200, { ok: true, ...result });
  }

  if (action === 'update_payment_preference') {
    const pref = sanitizeText(body.paymentMethodPreference, 64);
    const ALLOWED_PREF = ['cash_on_site', 'card_on_site', 'online_after_service', 'card_on_file'];
    if (!ALLOWED_PREF.includes(pref)) return jsonCors(400, { ok: false, error: 'invalid_preference' });
    await store.setJSON(bookingId, {
      ...booking,
      paymentMethodPreference: pref,
      paymentPreferenceUpdatedAt: now,
      paymentPreferenceUpdatedBy: 'admin',
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'payment_preference_updated', by: 'admin', preference: pref }),
    });
    return jsonCors(200, { ok: true, bookingId });
  }

  if (action === 'set_payment_link') {
    const payLink = sanitizeText(body.payLink, 500);
    if (!payLink.startsWith('http')) return jsonCors(400, { ok: false, error: 'invalid_pay_link' });
    await store.setJSON(bookingId, {
      ...booking,
      payLink,
      paymentWorkflowStatus: 'awaiting_customer_payment',
      payLinkSentAt: now,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'payment_link_set', by: 'admin' }),
    });
    return jsonCors(200, { ok: true, bookingId });
  }

  if (action === 'generate_stripe_pay_link') {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return jsonCors(503, { ok: false, error: 'stripe_not_configured' });
    const amountDollars = body.amount != null
      ? Math.round(Number(body.amount) * 100) / 100
      : Math.round(Number(booking.totalPrice || booking.finalAmount || 0) * 100) / 100;
    const amountCents = Math.round(amountDollars * 100);
    if (amountCents < 50) return jsonCors(400, { ok: false, error: 'amount_too_low' });
    const base = process.env.SITE_URL || 'https://cardetail1.netlify.app';
    const form = new URLSearchParams({
      mode: 'payment',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': `Cardetail1 · ${bookingId}`,
      'line_items[0][price_data][unit_amount]': String(amountCents),
      'line_items[0][quantity]': '1',
      success_url: `${base}/customer.html?paid=1`,
      cancel_url: `${base}/customer.html?canceled=1`,
    });
    if (booking.email) form.append('customer_email', booking.email);
    form.append('metadata[booking_id]', bookingId);
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const sess = await res.json().catch(() => ({}));
    if (!res.ok) {
      return jsonCors(res.status, { ok: false, error: (sess.error && sess.error.message) || 'stripe_error' });
    }
    await store.setJSON(bookingId, {
      ...booking,
      payLink: sess.url,
      paymentWorkflowStatus: 'awaiting_customer_payment',
      payLinkSentAt: now,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'stripe_pay_link_generated', by: 'admin', amount: amountDollars }),
    });
    return jsonCors(200, { ok: true, bookingId, url: sess.url, id: sess.id });
  }

  if (action === 'charge_policy_fee') {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return jsonCors(503, { ok: false, error: 'stripe_not_configured' });
    const feeType = sanitizeText(body.feeType, 32);
    const preset = { no_show: 75, late_cancel: 50 };
    const amountDollars = body.amount != null
      ? Math.round(Number(body.amount) * 100) / 100
      : (preset[feeType] || 50);
    const amountCents = Math.round(amountDollars * 100);
    const customerId = booking.stripeCustomerId;
    const pmId = booking.stripePaymentMethodId;
    if (!customerId || !pmId) {
      return jsonCors(409, { ok: false, error: 'no_card_on_file', message: 'Booking has no saved Stripe customer/payment method.' });
    }
    const form = new URLSearchParams({
      amount: String(amountCents),
      currency: 'usd',
      customer: customerId,
      payment_method: pmId,
      off_session: 'true',
      confirm: 'true',
      description: `Cardetail1 policy fee · ${bookingId} · ${feeType || 'policy'}`,
      'metadata[booking_id]': bookingId,
      'metadata[fee_type]': feeType || 'policy',
    });
    const res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const pi = await res.json().catch(() => ({}));
    if (!res.ok) {
      return jsonCors(res.status, { ok: false, error: (pi.error && pi.error.message) || 'stripe_charge_failed' });
    }
    const succeeded = pi.status === 'succeeded';
    await store.setJSON(bookingId, {
      ...booking,
      policyChargeStatus: succeeded ? 'charged' : pi.status,
      policyChargeAmount: amountDollars,
      policyChargeType: feeType || 'policy',
      policyChargeAt: now,
      policyPaymentIntentId: pi.id,
      updatedAt: now,
      eventLog: appendEventLog(booking, {
        action: 'policy_fee_charged', by: 'admin', feeType, amount: amountDollars, status: pi.status,
      }),
    });
    return jsonCors(200, { ok: true, bookingId, paymentIntentId: pi.id, status: pi.status, amount: amountDollars });
  }

  if (action === 'record_refund_request') {
    const reason = sanitizeText(body.reason, 500);
    const amount = body.amount != null ? Math.round(Number(body.amount) * 100) / 100 : null;
    await store.setJSON(bookingId, {
      ...booking,
      refundRequestedAt: now,
      refundRequestReason: reason,
      refundRequestAmount: amount,
      refundStatus: 'pending_admin',
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'refund_requested', by: 'admin', reason, amount }),
    });
    return jsonCors(200, { ok: true, bookingId, note: 'Refund logged — process manually in Stripe until automated in next PR.' });
  }

  if (action === 'record_job_balance') {
    const techPayout = body.techPayoutAmount != null ? Math.round(Number(body.techPayoutAmount) * 100) / 100 : booking.techPayoutAmount;
    const finalAmount = body.finalAmount != null ? Math.round(Number(body.finalAmount) * 100) / 100 : booking.finalAmount;
    const platformFee = (finalAmount != null && techPayout != null)
      ? Math.round((finalAmount - techPayout) * 100) / 100 : null;
    await store.setJSON(bookingId, {
      ...booking,
      finalAmount: finalAmount != null ? finalAmount : booking.finalAmount,
      techPayoutAmount: techPayout != null ? techPayout : booking.techPayoutAmount,
      platformFeeAmount: platformFee,
      balanceRecordedAt: now,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'job_balance_recorded', by: 'admin', finalAmount, techPayout, platformFee }),
    });
    return jsonCors(200, { ok: true, bookingId, platformFee });
  }

  if (action === 'reschedule') {
    const confirmedDate = sanitizeText(body.confirmedDate || body.date, 32);
    const confirmedTime = sanitizeText(body.confirmedTime || body.time, 32);
    const confirmedTimeWindow = sanitizeText(body.confirmedTimeWindow || body.timeWindow, 64);
    if (!confirmedDate) return jsonCors(400, { ok: false, error: 'date_required' });
    const patched = {
      ...booking,
      confirmedDate,
      preferredDate: confirmedDate,
      ...(confirmedTime ? { confirmedTime, preferredTime: confirmedTime } : {}),
      ...(confirmedTimeWindow ? { confirmedTimeWindow } : {}),
      jobStatus: ['cancelled', 'archived_test', 'completed_paid'].includes(booking.jobStatus) ? booking.jobStatus : 'confirmed',
      appointmentStatus: 'confirmed',
      status: 'Rescheduled',
      rescheduledByAdmin: true,
      rescheduledByAdminAt: now,
      rescheduledByClient: false,
      updatedAt: now,
      eventLog: appendEventLog(booking, {
        action: 'admin_reschedule', by: 'admin', confirmedDate, confirmedTime, confirmedTimeWindow,
      }),
    };
    await store.setJSON(bookingId, patched);
    return jsonCors(200, { ok: true, bookingId, confirmedDate });
  }

  if (action === 'update_address') {
    const address = sanitizeText(body.address, 300);
    const zipCode = sanitizeText(body.zipCode || body.zip, 16);
    if (!address) return jsonCors(400, { ok: false, error: 'address_required' });
    const patched = {
      ...booking,
      address,
      ...(zipCode ? { zipCode } : {}),
      addressChangedByClient: false,
      addressUpdatedByAdmin: true,
      addressUpdatedAt: now,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'admin_address_update', by: 'admin', address, zipCode }),
    };
    await store.setJSON(bookingId, patched);
    return jsonCors(200, { ok: true, bookingId });
  }

  if (action === 'cancel_booking') {
    const reason = sanitizeText(body.reason, 500);
    const patched = {
      ...booking,
      jobStatus: 'cancelled',
      appointmentStatus: 'canceled',
      status: 'Cancelled',
      canceledAt: now,
      cancellationReason: reason || booking.cancellationReason || 'admin_cancelled',
      cancellationRequestStatus: booking.cancellationRequestStatus === 'requested' ? 'resolved_approved' : booking.cancellationRequestStatus,
      cancellationResolvedAt: now,
      cancellationResolvedNote: reason || 'Cancelled by admin',
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'booking_cancelled', by: 'admin', reason }),
    };
    await store.setJSON(bookingId, patched);
    return jsonCors(200, { ok: true, bookingId, jobStatus: 'cancelled' });
  }

  if (action === 'resolve_cancellation') {
    const decision = sanitizeText(body.decision, 24);
    if (!['approved', 'denied'].includes(decision)) {
      return jsonCors(400, { ok: false, error: 'decision_must_be_approved_or_denied' });
    }
    const note = sanitizeText(body.note, 500);
    if (decision === 'approved') {
      const patched = {
        ...booking,
        jobStatus: 'cancelled',
        appointmentStatus: 'canceled',
        status: 'Cancelled',
        canceledAt: now,
        cancellationRequestStatus: 'resolved_approved',
        cancellationResolvedAt: now,
        cancellationResolvedNote: note,
        updatedAt: now,
        eventLog: appendEventLog(booking, { action: 'cancellation_approved', by: 'admin', note }),
      };
      await store.setJSON(bookingId, patched);
      return jsonCors(200, { ok: true, bookingId, jobStatus: 'cancelled' });
    }
    await store.setJSON(bookingId, {
      ...booking,
      cancellationRequestStatus: 'resolved_denied',
      cancellationResolvedAt: now,
      cancellationResolvedNote: note,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'cancellation_denied', by: 'admin', note }),
    });
    return jsonCors(200, { ok: true, bookingId });
  }

  if (action === 'apply_customer_request') {
    const requestType = sanitizeText(body.requestType, 32);
    if (requestType === 'reschedule' && booking.rescheduledByClient) {
      const confirmedDate = sanitizeText(booking.rescheduleRequestedDate || body.confirmedDate, 32);
      const confirmedTime = sanitizeText(booking.rescheduleRequestedTime || body.confirmedTime, 32);
      if (!confirmedDate) return jsonCors(400, { ok: false, error: 'no_reschedule_request' });
      const patched = {
        ...booking,
        confirmedDate,
        preferredDate: confirmedDate,
        ...(confirmedTime ? { confirmedTime, preferredTime: confirmedTime } : {}),
        jobStatus: 'confirmed',
        appointmentStatus: 'confirmed',
        status: 'Rescheduled',
        rescheduledByClient: false,
        rescheduleRequestAppliedAt: now,
        updatedAt: now,
        eventLog: appendEventLog(booking, { action: 'customer_reschedule_applied', by: 'admin' }),
      };
      await store.setJSON(bookingId, patched);
      return jsonCors(200, { ok: true, bookingId });
    }
    if (requestType === 'address' && (booking.addressChangedByClient || booking.requestedAddress)) {
      const address = sanitizeText(booking.requestedAddress || body.address, 300);
      if (!address) return jsonCors(400, { ok: false, error: 'no_address_request' });
      const patched = {
        ...booking,
        address,
        addressChangedByClient: false,
        addressRequestAppliedAt: now,
        updatedAt: now,
        eventLog: appendEventLog(booking, { action: 'customer_address_applied', by: 'admin' }),
      };
      await store.setJSON(bookingId, patched);
      return jsonCors(200, { ok: true, bookingId });
    }
    return jsonCors(400, { ok: false, error: 'no_pending_customer_request' });
  }

  if (action === 'archive_test') {
    const reason = sanitizeText(body.reason, 200) || 'admin_archive_test';
    await store.setJSON(bookingId, archiveBookingRecord(booking, reason));
    return jsonCors(200, { ok: true, bookingId, archived: true });
  }

  return jsonCors(400, { ok: false, error: 'unknown_action' });
}

async function bulkArchiveTests(store, includeAlreadyArchived) {
  const blobs = await listAllBlobs(store, 'cd1-bookings');
  let archived = 0;
  let skipped = 0;
  const ids = [];
  for (const blob of blobs) {
    const booking = await store.get(blob.key, { type: 'json' }).catch(() => null);
    if (!booking || booking.isDraft) { skipped++; continue; }
    if (!includeAlreadyArchived && (booking.archived || booking.jobStatus === 'archived_test')) { skipped++; continue; }
    if (!isLikelyTestBooking(booking)) { skipped++; continue; }
    await store.setJSON(blob.key, archiveBookingRecord(booking, 'bulk_test_cleanup'));
    archived++;
    ids.push(blob.key);
  }
  return { archived, skipped, ids: ids.slice(0, 50) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return jsonCors(405, { ok: false, error: 'method_not_allowed' });
  }

  const auth = await verifyAdminKey(event.headers || {});
  if (!auth.ok) return jsonCors(auth.error === 'missing_admin_password_config' ? 503 : 401, { ok: false, error: auth.error });

  if (event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }
    if (body.action && body.action !== 'list') {
      if (body.action === 'bulk_archive_tests') {
        try {
          const store = await blobsStore('cd1-bookings');
          const result = await bulkArchiveTests(store, body.includeArchived === true);
          return jsonCors(200, { ok: true, ...result });
        } catch {
          return jsonCors(500, { ok: false, error: 'bulk_archive_failed' });
        }
      }
      if (body.action === 'preview_test_cleanup') {
        try {
          const store = await blobsStore('cd1-bookings');
          const blobs = await listAllBlobs(store, 'cd1-bookings');
          const matches = [];
          for (const blob of blobs) {
            const booking = await store.get(blob.key, { type: 'json' }).catch(() => null);
            if (!booking || booking.isDraft || booking.archived) continue;
            if (isLikelyTestBooking(booking)) {
              matches.push({
                id: booking.id || blob.key,
                customer: [booking.firstName, booking.lastName].filter(Boolean).join(' '),
                email: booking.email || '',
              });
            }
          }
          return jsonCors(200, { ok: true, count: matches.length, matches: matches.slice(0, 100) });
        } catch {
          return jsonCors(500, { ok: false, error: 'preview_failed' });
        }
      }
      return handleAdminAction(body);
    }
    try {
      const jobs = await listJobs(body);
      return jsonCors(200, { ok: true, count: jobs.length, jobs });
    } catch (e) {
      console.error('[admin-ops-jobs] failed_to_load_jobs (POST):', e.message, e.stack);
      return jsonCors(500, { ok: false, error: 'failed_to_load_jobs' });
    }
  }

  try {
    const jobs = await listJobs(event.queryStringParameters || {});
    return jsonCors(200, { ok: true, count: jobs.length, jobs });
  } catch (e) {
    console.error('[admin-ops-jobs] failed_to_load_jobs (GET):', e.message, e.stack);
    return jsonCors(500, { ok: false, error: 'failed_to_load_jobs' });
  }
};
