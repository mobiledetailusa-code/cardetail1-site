// Admin-only jobs feed + admin ops actions for Admin Ops dashboard.
const { blobsStore, listAllBlobs, jsonCors, verifyAdminKey, sanitizeText } = require('../lib/tech-security');
const {
  projectJobForAdmin, normalizeJobStatus, appendEventLog,
} = require('../lib/ops-workflow');
const { getOpsSettings } = require('../lib/ops-config');
const { createAuctionForBooking, assignAuctionWinnerToBooking } = require('../lib/auction-ops');
const { applyServerTravelAndTotal } = require('../lib/travel-fee');
const {
  applyServerOffersToBooking,
  evaluateBookingOfferPreview,
} = require('../lib/booking-offers');
const { auditEntry, appendAudit, listAuditForBooking } = require('../lib/operations-audit');
const { getBooking } = require('../lib/ops-db');
const { guardStripeOrReject } = require('../lib/stripe-mode');
const {
  setBookingStoreOverride,
  commitBooking,
  getBookingRecord,
} = require('../lib/booking-repository');
const {
  buildNextAggregate,
  normalizeAggregate,
} = require('../lib/booking-aggregate');
const {
  supersedeOpenAttempts,
  expireSupersededAttempts,
} = require('../lib/payment-service');
const { dollarsToCents, centsToDollars } = require('../lib/historical-adapter');
const {
  createAdminAppointment,
  updateCustomerContact,
  mutateVehicles,
  updateServicePackage,
  adminTechStatus,
  approveAdjustment,
  rejectAdjustment,
  setApprovedFinalAmount,
  markCashReceived,
  markRefunded,
  markCardOnSite,
  generateCustomerLinks,
  reopenAppointment,
} = require('../lib/admin-booking-mutations');

const MONEY_MUTATION_ACTIONS = new Set([
  'update_service',
  'update_vehicles',
  'approve_adjustment',
  'reject_adjustment',
  'set_approved_final_amount',
  'mark_cash_received',
  'mark_card_on_site',
  'mark_refunded',
  'apply_welcome_offer',
  'remove_welcome_offer',
  'record_job_balance',
]);

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
  const { isVisibleSubmittedBooking } = require('../lib/booking-visibility');
  const { normalizeBookingKey } = require('../lib/ops-db');
  // Keep Blob key on each record so Customer lookup can resolve when key ≠ payload.id
  const keyed = [];
  for (let i = 0; i < blobs.length; i += 30) {
    const chunk = blobs.slice(i, i + 30);
    const rows = await Promise.all(chunk.map(async (blob) => {
      let raw = null;
      if (typeof store.getWithMetadata === 'function') {
        const result = await store.getWithMetadata(blob.key, {
          type: 'json',
          consistency: 'strong',
        }).catch(() => null);
        raw = result && result.data;
      }
      if (!raw) raw = await store.get(blob.key, { type: 'json' }).catch(() => null);
      if (!raw) return null;
      if (!raw.id && !raw.bookingId) raw.id = blob.key;
      raw.__blobKey = blob.key;
      return raw;
    }));
    for (const row of rows) if (row) keyed.push(row);
  }
  let jobs = keyed.filter((b) =>
    b && isVisibleSubmittedBooking(b, { includeArchivedTest: !!showTest })
  );

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
      // Prefer payload id; if missing, use Blob key so Admin copy/paste matches Customer lookup.
      j.id = normalizeBookingKey(j.id || j.bookingId || b.__blobKey) || j.id;
      j.jobStatus = normalizeJobStatus(b);
      // paymentWorkflowStatus / remainingCents come from financialProjection via projectJobForAdmin.
      // Do not overwrite with normalizePaymentWorkflowStatus(raw) — that reintroduces stale Pending.
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

/**
 * Persist Admin mutations through CAS + ledger sync.
 * Unconditional store.setJSON is not acceptable conflict protection.
 */
async function persistMutation(store, bookingId, booking, previous, action, reason) {
  setBookingStoreOverride(store);
  const expected = Math.max(0, Math.round(Number(previous?.bookingVersion) || 0));
  const { ok: prevOk, aggregate: prevAgg } = normalizeAggregate(previous, { allowDraft: true });
  const base = prevOk ? prevAgg : previous;

  const { ok: nextOk, aggregate: mutatedAgg } = normalizeAggregate(booking, { allowDraft: true });
  const mutated = nextOk ? mutatedAgg : booking;

  const patches = { ...mutated };
  delete patches.bookingVersion;
  delete patches.__etag;
  delete patches._etag;

  let expireResult = null;
  if (MONEY_MUTATION_ACTIONS.has(action)) {
    const approvedCents = dollarsToCents(
      mutated.approvedFinalAmount != null ? mutated.approvedFinalAmount : mutated.totalPrice
    );
    let settledCents = Math.max(0, Math.round(Number(base.ledger?.settledCents) || 0));
    let creditedCents = Math.max(0, Math.round(Number(base.ledger?.creditedCents) || 0));
    const entries = Array.isArray(base.ledger?.entries) ? [...base.ledger.entries] : [];

    if (action === 'mark_cash_received' || action === 'mark_card_on_site') {
      const cashCents = dollarsToCents(
        mutated.cashReceivedAmount != null
          ? mutated.cashReceivedAmount
          : (mutated.cardOnSiteAmount != null ? mutated.cardOnSiteAmount : centsToDollars(approvedCents))
      );
      const remaining = Math.max(0, approvedCents - settledCents - creditedCents);
      const credit = Math.min(Math.max(0, cashCents), remaining);
      if (credit > 0) {
        settledCents += credit;
        entries.push({
          entryId: `le_admin_${action}_${Date.now()}`,
          kind: 'settlement',
          amountCents: credit,
          currency: 'usd',
          quoteVersion: Math.round(Number(base.quoteVersion) || 0),
          bookingVersion: expected,
          occurredAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          actor: `admin_${action}`,
        });
      }
    }

    if (action === 'mark_refunded') {
      // Never a bare status flip: clamp to what is actually settled and
      // record a real ledger debit + audit entry, same as a cash credit
      // but in reverse. Never allow refunding more than was paid.
      const requestedCents = dollarsToCents(mutated.refundRequestAmount);
      const netSettled = Math.max(0, settledCents - creditedCents);
      const refundCents = Math.min(Math.max(0, requestedCents), netSettled);
      if (refundCents > 0) {
        settledCents = Math.max(0, settledCents - refundCents);
        entries.push({
          entryId: `le_admin_${action}_${Date.now()}`,
          kind: 'refund',
          amountCents: refundCents,
          currency: 'usd',
          quoteVersion: Math.round(Number(base.quoteVersion) || 0),
          bookingVersion: expected,
          occurredAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          actor: 'admin_mark_refunded',
        });
      }
    }

    const priorApproved = Math.max(0, Math.round(Number(base.ledger?.approvedCents) || 0));
    const quoteChanged = approvedCents !== priorApproved
      || action === 'update_service'
      || action === 'update_vehicles'
      || action === 'approve_adjustment'
      || action === 'reject_adjustment'
      || action === 'set_approved_final_amount'
      || action === 'apply_welcome_offer'
      || action === 'remove_welcome_offer'
      || action === 'record_job_balance';

    let paymentAttempts = Array.isArray(base.paymentAttempts) ? base.paymentAttempts : [];
    let nextQuoteVersion = Math.round(Number(base.quoteVersion || base.quote?.quoteVersion) || 0);
    if (quoteChanged) {
      nextQuoteVersion += 1;
      paymentAttempts = supersedeOpenAttempts(paymentAttempts, { quoteVersion: nextQuoteVersion });
      patches.payLink = '';
      patches.stripeCheckoutSessionId = '';
      patches.payLinkAmount = null;
      patches.payLinkInvalidatedAt = new Date().toISOString();
      patches.quoteVersion = nextQuoteVersion;
      patches.quote = {
        ...(base.quote || {}),
        quoteVersion: nextQuoteVersion,
        basedOnBookingVersion: expected,
        approvedCents,
        currency: 'usd',
        createdAt: new Date().toISOString(),
        source: `admin_${action}`,
      };
    }

    patches.ledger = {
      currency: 'usd',
      approvedCents,
      settledCents,
      creditedCents,
      pendingCents: 0,
      lastReconciledAt: base.ledger?.lastReconciledAt || null,
      entries,
    };
    patches.paymentAttempts = paymentAttempts;
    patches.approvedFinalAmount = centsToDollars(approvedCents);
    patches.totalPrice = centsToDollars(approvedCents);
    patches.amountPaid = centsToDollars(settledCents);
    patches.paidAmount = centsToDollars(settledCents);
    const dueCents = Math.max(0, approvedCents - settledCents - creditedCents);
    patches.amountDueApproved = centsToDollars(dueCents);
    patches.balanceDue = centsToDollars(dueCents);

    expireResult = await expireSupersededAttempts(paymentAttempts, process.env).catch(() => null);
  }

  const next = buildNextAggregate(base, patches);
  const committed = await commitBooking({
    bookingId,
    expectedBookingVersion: expected,
    nextAggregate: next,
  });
  if (!committed.ok) {
    return committed;
  }

  await appendAudit(auditEntry({
    bookingId,
    actorType: 'admin',
    actorId: 'admin',
    action,
    previousState: previous,
    resultingState: committed.booking,
    reason: reason || '',
    sourcePortal: 'admin_ops',
  })).catch(() => null);

  return { ok: true, booking: committed.booking, bookingVersion: committed.bookingVersion, expireResult };
}

async function handleAdminAction(body) {
  const action = sanitizeText(body.action, 40);

  if (action === 'create_appointment') {
    const store = await blobsStore('cd1-bookings');
    const result = await createAdminAppointment(store, body);
    if (!result.ok) return jsonCors(400, { ok: false, error: result.error });
    await appendAudit(auditEntry({
      bookingId: result.bookingId,
      actorType: 'admin',
      actorId: 'admin',
      action: 'create_appointment',
      previousState: null,
      resultingState: result.booking,
      reason: sanitizeText(body.reason, 300) || 'admin_create',
      sourcePortal: 'admin_ops',
    })).catch(() => null);
    return jsonCors(200, { ok: true, bookingId: result.bookingId, booking: projectJobForAdmin(result.booking) });
  }

  if (action === 'list_audit') {
    const bookingId = sanitizeText(body.bookingId, 48);
    if (!bookingId) return jsonCors(400, { ok: false, error: 'bookingId_required' });
    const rows = await listAuditForBooking(bookingId, Number(body.limit) || 100);
    return jsonCors(200, { ok: true, bookingId, audit: rows });
  }

  const bookingId = sanitizeText(body.bookingId, 48);
  if (!bookingId) return jsonCors(400, { ok: false, error: 'bookingId_required' });

  const store = await blobsStore('cd1-bookings');
  setBookingStoreOverride(store);
  const bookingRec = await getBookingRecord(bookingId);
  let booking = bookingRec.booking || await store.get(bookingId, { type: 'json' }).catch(() => null);
  if (!booking) return jsonCors(404, { ok: false, error: 'booking_not_found' });

  const now = new Date().toISOString();

  if (action === 'get_job') {
    const {
      reconcileOpenCheckoutFromProvider,
      financialProjection,
    } = require('../lib/payment-service');
    const {
      postgresPaymentEnabled,
      getSharedFinancialProjection,
      adminReconcileWithStripe,
    } = require('../lib/db/operational-payment');

    let reconciled = { ok: true, skipped: true, reason: 'not_run' };
    let projection = null;
    let authority = 'blob';

    if (postgresPaymentEnabled()) {
      const pgReconcile = await adminReconcileWithStripe({ booking });
      const shared = await getSharedFinancialProjection(booking, { reconcileUncertain: false });
      if (shared.ok && shared.projection) {
        projection = shared.projection;
        authority = 'postgres';
        reconciled = {
          ok: !!pgReconcile.ok,
          skipped: !!pgReconcile.skipped,
          reason: pgReconcile.reason || pgReconcile.error || null,
        };
        // Refresh blob booking after compatibility sync
        const refreshed = await getBookingRecord(bookingId);
        if (refreshed.exists) booking = refreshed.booking;
      }
    }

    if (!projection) {
      reconciled = await reconcileOpenCheckoutFromProvider({
        booking,
        bookingId,
        getBookingRecord,
        commitBooking,
      });
      booking = reconciled.booking || booking;
      projection = reconciled.projection || financialProjection(booking);
      authority = 'blob';
    }

    const job = projectJobForAdmin(booking);
    return jsonCors(200, {
      ok: true,
      job,
      projection,
      authority,
      reconciled: !reconciled.skipped && !!reconciled.ok,
      reconcileSkipped: !!reconciled.skipped,
      reconcileReason: reconciled.reason || reconciled.error || null,
    });
  }

  if (action === 'reconcile_with_stripe') {
    const {
      postgresPaymentEnabled,
      adminReconcileWithStripe,
      getSharedFinancialProjection,
    } = require('../lib/db/operational-payment');
    const {
      reconcileOpenCheckoutFromProvider,
      financialProjection,
    } = require('../lib/payment-service');

    if (postgresPaymentEnabled()) {
      const result = await adminReconcileWithStripe({ booking });
      const shared = await getSharedFinancialProjection(booking, { reconcileUncertain: false });
      const refreshed = await getBookingRecord(bookingId);
      if (refreshed.exists) booking = refreshed.booking;
      return jsonCors(200, {
        ok: !!result.ok,
        action: 'reconcile_with_stripe',
        authority: 'postgres',
        projection: shared.projection || result.projection || null,
        skipped: !!result.skipped,
        reason: result.reason || result.error || null,
        job: projectJobForAdmin(booking),
      });
    }

    const reconciled = await reconcileOpenCheckoutFromProvider({
      booking,
      bookingId,
      getBookingRecord,
      commitBooking,
    });
    booking = reconciled.booking || booking;
    return jsonCors(200, {
      ok: !!reconciled.ok,
      action: 'reconcile_with_stripe',
      authority: 'blob',
      projection: reconciled.projection || financialProjection(booking),
      skipped: !!reconciled.skipped,
      reason: reconciled.reason || reconciled.error || null,
      job: projectJobForAdmin(booking),
    });
  }

  if (action === 'apply_welcome_offer') {
    const reason = sanitizeText(body.reason, 300);
    const forceEligible = body.forceEligible === true;
    if (forceEligible && !reason) {
      return jsonCors(400, { ok: false, error: 'reason_required_for_override' });
    }
    const travel = applyServerTravelAndTotal({ ...booking }, { skipMismatchCheck: true });
    if (!travel.ok) return jsonCors(400, { ok: false, error: travel.error || 'invalid_booking' });
    const preview = await evaluateBookingOfferPreview(booking, { sourceTrigger: 'admin_apply' });
    if (preview.offer.eligibility_status !== 'eligible' && !forceEligible) {
      return jsonCors(409, {
        ok: false,
        error: 'offer_ineligible',
        reason: preview.offer.eligibility_reason,
        offer: preview.offer,
      });
    }
    const working = { ...booking };
    if (forceEligible && preview.offer.eligibility_status !== 'eligible') {
      working.welcomeOfferSource = 'admin_override';
    }
    const applied = await applyServerOffersToBooking(working, {
      serviceSubtotal: travel.serviceSubtotal,
      travelFee: working.travelFeeAmount || 0,
      sourceTrigger: forceEligible ? 'admin_override' : 'admin_apply',
    });
    const updated = {
      ...working,
      offerAudit: [
        ...(Array.isArray(booking.offerAudit) ? booking.offerAudit : []),
        {
          at: now,
          by: 'admin',
          action: 'apply_welcome_offer',
          reason: reason || null,
          forceEligible,
          discount: applied.discountDollars,
        },
      ],
      updatedAt: now,
      eventLog: appendEventLog(booking, {
        action: 'welcome_offer_applied',
        by: 'admin',
        discount: applied.discountDollars,
        reason: reason || null,
      }),
    };
    const persisted = await persistMutation(
      store,
      bookingId,
      updated,
      booking,
      'apply_welcome_offer',
      reason || 'admin_apply'
    );
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      offer: persisted.booking.offer,
      totalPrice: persisted.booking.totalPrice,
      bookingVersion: persisted.bookingVersion,
      quoteVersion: persisted.booking.quoteVersion,
    });
  }

  if (action === 'remove_welcome_offer') {
    const reason = sanitizeText(body.reason, 300);
    if (!reason) return jsonCors(400, { ok: false, error: 'reason_required' });
    const travel = applyServerTravelAndTotal({ ...booking }, { skipMismatchCheck: true });
    if (!travel.ok) return jsonCors(400, { ok: false, error: travel.error || 'invalid_booking' });
    const preDiscount = Math.round((travel.serviceSubtotal + (booking.travelFeeAmount || 0)) * 100) / 100;
    const updated = {
      ...booking,
      offer: null,
      welcomeOffer: null,
      discountAmount: 0,
      approvedDiscount: 0,
      totalPrice: preDiscount,
      approvedFinalAmount: preDiscount,
      finalAmount: preDiscount,
      offerAudit: [
        ...(Array.isArray(booking.offerAudit) ? booking.offerAudit : []),
        { at: now, by: 'admin', action: 'remove_welcome_offer', reason },
      ],
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'welcome_offer_removed', by: 'admin', reason }),
    };
    const persisted = await persistMutation(store, bookingId, updated, booking, 'remove_welcome_offer', reason);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      totalPrice: persisted.booking.totalPrice,
      bookingVersion: persisted.bookingVersion,
      quoteVersion: persisted.booking.quoteVersion,
    });
  }

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
    const { portalReleasePatch } = require('../lib/booking-visibility');
    const patched = {
      ...booking,
      ...portalReleasePatch(now),
      jobStatus: 'confirmed',
      appointmentStatus: 'confirmed',
      status: 'Confirmed',
      adminReviewed: true,
      adminReviewedAt: now,
      confirmedAt: booking.confirmedAt || now,
      finalizedAt: booking.finalizedAt || now,
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
    const { moneyConflict } = require('../lib/payment-service');
    const money = moneyConflict(booking);
    if (money.conflict || !money.payable || !(money.remainingCents > 0)) {
      return jsonCors(409, {
        ok: false,
        error: 'not_payable',
        reason: money.reason || 'zero_balance',
        message: 'Booking is already paid or has no remaining balance. Manual pay links are blocked.',
      });
    }
    // Manual external reference only — not an authoritative Stripe payment attempt.
    // Do NOT set payLink/awaiting_customer_payment (those drive Pay Balance CTAs).
    const patched = {
      ...booking,
      manualPayLink: payLink,
      manualPayLinkAt: now,
      updatedAt: now,
      eventLog: appendEventLog(booking, {
        action: 'manual_payment_link_set',
        by: 'admin',
        note: 'external_manual_reference_not_authoritative',
      }),
    };
    const persisted = await persistMutation(store, bookingId, patched, booking, 'set_payment_link', 'manual_link');
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      bookingVersion: persisted.bookingVersion,
      authoritative: false,
      note: 'Manual link stored as external reference only; Generate Stripe link remains the authoritative path.',
    });
  }

  if (action === 'generate_stripe_pay_link') {
    const stripeGuard = guardStripeOrReject(process.env, { purpose: 'admin_pay_link' });
    if (stripeGuard.blocked) {
      return jsonCors(stripeGuard.statusCode, stripeGuard.body);
    }
    const { prepareBalanceCheckout, buildPaymentAttempt } = require('../lib/payment-service');
    const { getBookingRecord, commitBooking } = require('../lib/booking-repository');
    const { buildNextAggregate, normalizeAggregate } = require('../lib/booking-aggregate');
    const { applyPayLinkMoney } = require('../lib/portal-money-sync');
    const { centsToDollars } = require('../lib/historical-adapter');

    const freshRec = await getBookingRecord(bookingId);
    const freshBooking = freshRec.booking || (await getBooking(bookingId)) || booking;
    // Reject operator amount override — derive remaining only
    if (body.amount != null || body.amountCents != null) {
      return jsonCors(400, { ok: false, error: 'amount_override_rejected' });
    }
    const prepared = prepareBalanceCheckout(freshBooking, {
      expectedBookingVersion: body.expectedBookingVersion,
      expectedQuoteVersion: body.expectedQuoteVersion,
    }, process.env);
    if (!prepared.ok) {
      return jsonCors(prepared.statusCode || 400, {
        ok: false,
        error: prepared.error,
        reason: prepared.reason,
        message: prepared.error === 'not_payable' || prepared.error === 'zero_balance'
          ? 'Booking is already paid or has no remaining balance. A new Stripe link was not created.'
          : undefined,
      });
    }
    const amountDollars = centsToDollars(prepared.amountCents);
    if (prepared.amountCents < 50) return jsonCors(400, { ok: false, error: 'amount_too_low' });

    const { ok: nOk, aggregate: nAgg } = normalizeAggregate(freshBooking);
    const baseAgg = nOk ? nAgg : freshBooking;
    // Reuse matching open Checkout — never mint a second payable session for the same balance.
    const open = (Array.isArray(baseAgg.paymentAttempts) ? baseAgg.paymentAttempts : [])
      .find((a) => a
        && a.status === 'open'
        && a.amountCents === prepared.amountCents
        && a.quoteVersion === prepared.quoteVersion
        && a.providerObjectId
        && baseAgg.payLink);
    if (open && baseAgg.payLink) {
      return jsonCors(200, {
        ok: true,
        bookingId,
        url: baseAgg.payLink,
        id: open.providerObjectId,
        amountDueApproved: amountDollars,
        remainingCents: prepared.amountCents,
        bookingVersion: prepared.bookingVersion,
        quoteVersion: prepared.quoteVersion,
        reused: true,
      });
    }

    // Expire any other open sessions before creating a new one (prevents dual Checkout windows).
    const superseded = supersedeOpenAttempts(baseAgg.paymentAttempts, {
      quoteVersion: prepared.quoteVersion,
      forceAll: true,
    });
    await expireSupersededAttempts(superseded, process.env);

    const base = process.env.SITE_URL || 'https://cardetail1.netlify.app';
    const form = new URLSearchParams({
      mode: 'payment',
      'payment_method_types[0]': 'card',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': `Cardetail1 · ${bookingId}`,
      'line_items[0][price_data][unit_amount]': String(prepared.amountCents),
      'line_items[0][quantity]': '1',
      success_url: `${base}/my-garage.html?paid=1&bookingId=${encodeURIComponent(bookingId)}`,
      cancel_url: `${base}/my-garage.html?canceled=1&bookingId=${encodeURIComponent(bookingId)}`,
    });
    if (freshBooking.email) form.append('customer_email', freshBooking.email);
    form.append('metadata[booking_id]', bookingId);
    form.append('metadata[purpose]', 'customer_balance');
    form.append('metadata[amount_due]', String(amountDollars));
    form.append('metadata[bookingVersion]', String(prepared.bookingVersion));
    form.append('metadata[quoteVersion]', String(prepared.quoteVersion));
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${prepared.secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': prepared.idempotencyKey,
      },
      body: form,
    });
    const sess = await res.json().catch(() => ({}));
    if (!res.ok) {
      return jsonCors(res.status, { ok: false, error: (sess.error && sess.error.message) || 'stripe_error' });
    }
    const attempt = buildPaymentAttempt({
      bookingId,
      bookingVersion: prepared.bookingVersion,
      quoteVersion: prepared.quoteVersion,
      amountCents: prepared.amountCents,
      providerObjectId: sess.id,
      type: 'customer_balance',
      idempotencyKey: prepared.idempotencyKey,
    });
    attempt.status = 'open';
    const next = buildNextAggregate(baseAgg, {
      ...applyPayLinkMoney(baseAgg, amountDollars, sess.url, sess.id),
      paymentAttempts: [...superseded, attempt],
      payLinkSentAt: now,
      eventLog: appendEventLog(baseAgg, { action: 'stripe_pay_link_generated', by: 'admin', amount: amountDollars }),
    });
    const committed = await commitBooking({
      bookingId,
      expectedBookingVersion: baseAgg.bookingVersion || 0,
      nextAggregate: next,
    });
    if (!committed.ok) {
      try {
        await fetch(`https://api.stripe.com/v1/checkout/sessions/${sess.id}/expire`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${prepared.secret}` },
        });
      } catch { /* ignore */ }
      return jsonCors(409, { ok: false, error: 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      url: sess.url,
      id: sess.id,
      amountDueApproved: amountDollars,
      remainingCents: prepared.amountCents,
      bookingVersion: committed.bookingVersion,
      quoteVersion: prepared.quoteVersion,
    });
  }

  if (action === 'charge_policy_fee') {
    const stripeGuard = guardStripeOrReject(process.env, { purpose: 'policy_charge' });
    if (stripeGuard.blocked) {
      return jsonCors(stripeGuard.statusCode, stripeGuard.body);
    }
    const js = normalizeJobStatus(booking);
    const cancelled = js === 'cancelled'
      || String(booking.appointmentStatus || '').toLowerCase() === 'canceled'
      || String(booking.appointmentStatus || '').toLowerCase() === 'cancelled'
      || String(booking.cancellationRequestStatus || '').toLowerCase() === 'approved'
      || String(booking.status || '').toLowerCase() === 'cancelled'
      || String(booking.status || '').toLowerCase() === 'canceled';
    const completed = [
      'completed_paid',
      'completed_pending_admin_review',
      'completed_pending_payment',
    ].includes(js);
    if (cancelled || completed) {
      return jsonCors(409, {
        ok: false,
        error: 'policy_charge_blocked',
        message: cancelled
          ? 'Policy fee blocked — appointment is cancelled within terms / already cancelled.'
          : 'Policy fee blocked — job is already completed.',
      });
    }
    const secret = stripeGuard.secret;
    const feeType = sanitizeText(body.feeType, 32);
    const preset = { no_show: 75, late_cancel: 50 };
    const cap = preset[feeType] || 50;
    if (booking.policyChargeStatus === 'charged' && body.forceRetry !== true) {
      return jsonCors(409, { ok: false, error: 'policy_already_charged' });
    }
    let amountDollars;
    if (body.amount != null) {
      amountDollars = Math.round(Number(body.amount) * 100) / 100;
      if (amountDollars > cap) {
        return jsonCors(400, { ok: false, error: 'amount_exceeds_policy_cap', max: cap });
      }
    } else {
      amountDollars = cap;
    }
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
    // Logging only — never a status-only "mark refunded" shortcut. Marking
    // an invoice as actually refunded must go through the mark_refunded
    // action below, which records a real ledger debit, not just this note.
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
    return jsonCors(200, {
      ok: true,
      bookingId,
      refundStatus: 'pending_admin',
      note: 'Refund logged — use Mark refunded once the money has actually moved (Stripe or cash) to record it against the ledger.',
    });
  }

  if (action === 'mark_refunded') {
    const result = markRefunded(booking, body);
    const persisted = await persistMutation(store, bookingId, result.booking, booking, 'mark_refunded', body.reason);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      refundStatus: persisted.booking.refundStatus,
      amountDueApproved: persisted.booking.amountDueApproved,
      bookingVersion: persisted.bookingVersion,
    });
  }

  if (action === 'record_job_balance') {
    const techPayout = body.techPayoutAmount != null ? Math.round(Number(body.techPayoutAmount) * 100) / 100 : booking.techPayoutAmount;
    const finalAmount = body.finalAmount != null ? Math.round(Number(body.finalAmount) * 100) / 100 : booking.finalAmount;
    const platformFee = (finalAmount != null && techPayout != null)
      ? Math.round((finalAmount - techPayout) * 100) / 100 : null;
    const patched = {
      ...booking,
      finalAmount: finalAmount != null ? finalAmount : booking.finalAmount,
      techPayoutAmount: techPayout != null ? techPayout : booking.techPayoutAmount,
      platformFeeAmount: platformFee,
      balanceRecordedAt: now,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'job_balance_recorded', by: 'admin', finalAmount, techPayout, platformFee }),
    };
    if (finalAmount != null) {
      patched.approvedFinalAmount = finalAmount;
      patched.totalPrice = finalAmount;
    }
    const persisted = await persistMutation(store, bookingId, patched, booking, 'record_job_balance', 'admin_balance');
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, { ok: true, bookingId, platformFee, bookingVersion: persisted.bookingVersion });
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
      const service = {
        ...(booking.service && typeof booking.service === 'object' ? booking.service : {}),
        serviceAddress: address,
        vehicles: (booking.service && Array.isArray(booking.service.vehicles))
          ? booking.service.vehicles
          : (booking.vehicles || []),
      };
      const changeRequests = (Array.isArray(booking.changeRequests) ? booking.changeRequests : []).map((r) => {
        const type = r.requestType || r.type;
        const open = ['pending', 'pending_approval'].includes(String(r.status || '').toLowerCase());
        if (type === 'address_update' && open) {
          return {
            ...r,
            status: 'applied',
            decision: 'approve',
            decidedAt: now,
            customerVisibleResult: 'Address updated.',
          };
        }
        return r;
      });
      const patched = {
        ...booking,
        address,
        service,
        requestedAddress: '',
        addressChangedByClient: false,
        addressRequestAppliedAt: now,
        changeRequests,
        customerChangePending: changeRequests.some((r) => ['pending', 'pending_approval', 'needs_clarification'].includes(String(r.status || '').toLowerCase())),
        updatedAt: now,
        eventLog: appendEventLog(booking, { action: 'customer_address_applied', by: 'admin' }),
      };
      const persisted = await persistMutation(store, bookingId, patched, booking, 'customer_address_applied', 'admin_apply');
      if (!persisted.ok) {
        return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
      }
      try {
        const { rebuildRequestIndex } = require('../lib/booking-commands');
        await Promise.all(changeRequests
          .filter((r) => (r.requestType || r.type) === 'address_update' && r.status === 'applied')
          .map((r) => rebuildRequestIndex({
            ...r,
            id: r.requestId || r.id,
            bookingId,
            status: 'applied',
            adminDecision: 'approve',
            decidedAt: now,
          })));
      } catch { /* fail-open */ }
      return jsonCors(200, { ok: true, bookingId, bookingVersion: persisted.bookingVersion });
    }
    return jsonCors(400, { ok: false, error: 'no_pending_customer_request' });
  }

  if (action === 'archive_test') {
    const reason = sanitizeText(body.reason, 200) || 'admin_archive_test';
    await store.setJSON(bookingId, archiveBookingRecord(booking, reason));
    return jsonCors(200, { ok: true, bookingId, archived: true });
  }

  if (action === 'update_customer') {
    const result = updateCustomerContact(booking, body);
    if (!result.ok) return jsonCors(400, { ok: false, error: result.error });
    const persisted = await persistMutation(store, bookingId, result.booking, booking, 'update_customer', body.reason);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, { ok: true, bookingId, bookingVersion: persisted.bookingVersion });
  }

  if (action === 'update_vehicles') {
    const result = mutateVehicles(booking, body);
    if (!result.ok) return jsonCors(400, { ok: false, error: result.error });
    const persisted = await persistMutation(store, bookingId, result.booking, booking, 'update_vehicles', body.reason);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      totalPrice: persisted.booking.totalPrice,
      bookingVersion: persisted.bookingVersion,
      quoteVersion: persisted.booking.quoteVersion,
    });
  }

  if (action === 'update_service') {
    const result = await updateServicePackage(booking, body);
    if (!result.ok) return jsonCors(400, { ok: false, error: result.error });
    const persisted = await persistMutation(store, bookingId, result.booking, booking, 'update_service', body.reason);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      totalPrice: persisted.booking.totalPrice,
      bookingVersion: persisted.bookingVersion,
      quoteVersion: persisted.booking.quoteVersion,
    });
  }

  if (action === 'admin_tech_status') {
    const result = adminTechStatus(booking, body);
    if (!result.ok) return jsonCors(400, { ok: false, error: result.error });
    const persisted = await persistMutation(store, bookingId, result.booking, booking, 'admin_tech_status', body.statusAction);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, { ok: true, bookingId, jobStatus: persisted.booking.jobStatus, bookingVersion: persisted.bookingVersion });
  }

  if (action === 'approve_adjustment') {
    const result = approveAdjustment(booking, body);
    if (!result.ok) return jsonCors(400, { ok: false, error: result.error });
    const persisted = await persistMutation(store, bookingId, result.booking, booking, 'approve_adjustment', body.reason);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      approvedFinalAmount: persisted.booking.approvedFinalAmount,
      bookingVersion: persisted.bookingVersion,
      quoteVersion: persisted.booking.quoteVersion,
    });
  }

  if (action === 'reject_adjustment') {
    const reason = sanitizeText(body.reason, 500);
    if (!reason) return jsonCors(400, { ok: false, error: 'reason_required' });
    const result = rejectAdjustment(booking, body);
    const persisted = await persistMutation(store, bookingId, result.booking, booking, 'reject_adjustment', reason);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, { ok: true, bookingId, bookingVersion: persisted.bookingVersion });
  }

  if (action === 'set_approved_final_amount') {
    const result = setApprovedFinalAmount(booking, body);
    if (!result.ok) return jsonCors(400, { ok: false, error: result.error });
    const persisted = await persistMutation(store, bookingId, result.booking, booking, 'set_approved_final_amount', body.reason);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      approvedFinalAmount: persisted.booking.approvedFinalAmount,
      bookingVersion: persisted.bookingVersion,
      quoteVersion: persisted.booking.quoteVersion,
    });
  }

  if (action === 'mark_cash_received') {
    const result = markCashReceived(booking, body);
    const persisted = await persistMutation(store, bookingId, result.booking, booking, 'mark_cash_received', body.reference);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, { ok: true, bookingId, paymentStatus: persisted.booking.paymentStatus, bookingVersion: persisted.bookingVersion });
  }

  if (action === 'mark_card_on_site') {
    const reference = sanitizeText(body.reference, 120);
    if (!reference) return jsonCors(400, { ok: false, error: 'reference_required' });
    const result = markCardOnSite(booking, body);
    const persisted = await persistMutation(store, bookingId, result.booking, booking, 'mark_card_on_site', reference);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, { ok: true, bookingId, paymentStatus: persisted.booking.paymentStatus, bookingVersion: persisted.bookingVersion });
  }

  if (action === 'generate_customer_link') {
    const siteUrl = process.env.DEPLOY_PRIME_URL || process.env.URL || '';
    const result = await generateCustomerLinks(booking, body, siteUrl);
    if (!result.ok) return jsonCors(400, { ok: false, error: result.error });
    const patch = {
      ...booking,
      updatedAt: now,
      eventLog: appendEventLog(booking, { action: 'customer_link_generated', by: 'admin', linkType: result.linkType }),
    };
    if (result.linkType === 'completion') {
      patch.completionLinkUrl = result.url;
      patch.completionLinkExpiresAt = result.expiresAt;
    } else {
      patch.myGarageLinkUrl = result.url;
    }
    const persisted = await persistMutation(store, bookingId, patch, booking, 'generate_customer_link', result.linkType);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, { ok: true, bookingId, url: result.url, linkType: result.linkType, expiresAt: result.expiresAt || null, bookingVersion: persisted.bookingVersion });
  }

  if (action === 'reopen_appointment') {
    const reason = sanitizeText(body.reason, 500);
    if (!reason) return jsonCors(400, { ok: false, error: 'reason_required' });
    const result = reopenAppointment(booking, body);
    if (!result.ok) return jsonCors(400, { ok: false, error: result.error });
    const persisted = await persistMutation(store, bookingId, result.booking, booking, 'reopen_appointment', reason);
    if (!persisted.ok) {
      return jsonCors(persisted.statusCode || 409, { ok: false, error: persisted.error || 'version_conflict' });
    }
    return jsonCors(200, {
      ok: true,
      bookingId,
      jobStatus: persisted.booking.jobStatus,
      bookingVersion: persisted.bookingVersion,
    });
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
