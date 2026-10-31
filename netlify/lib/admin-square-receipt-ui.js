// Drawer helpers for the two manual Square admin actions.
// Payment observation is not a ledger receipt.
// A Dashboard receipt is an administrator attestation. It is not a Square API call.
// This file does not decide the outstanding balance, the ledger kind, or payment status.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CD1AdminSquareReceipt = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function clean(value) {
    return String(value || '').trim();
  }

  function amountTextToCents(amountText) {
    const raw = clean(amountText).replace(/^\$/, '').replace(/,/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
    const parts = raw.split('.');
    const dollars = Number(parts[0]);
    const fraction = Number(((parts[1] || '') + '00').slice(0, 2));
    const cents = (dollars * 100) + fraction;
    if (!Number.isInteger(cents) || cents <= 0) return null;
    return cents;
  }

  function buildPaymentReportedRequest(input) {
    const bookingId = clean(input && input.bookingId);
    const operationId = clean(input && input.operationId);
    const reason = clean(input && input.reason).slice(0, 500);
    const evidence = clean(input && input.evidence).slice(0, 500);
    if (!bookingId) return { ok: false, message: 'A booking is required.' };
    if (!operationId) return { ok: false, message: 'There is no manual collection reservation.' };
    if (!reason) return { ok: false, message: 'A reason is required.' };
    return {
      ok: true,
      body: {
        action: 'close_manual_collection',
        bookingId,
        operationId,
        outcome: 'payment_reported',
        reason,
        evidence,
        confirmation: { inspected: true, paymentReported: true },
      },
    };
  }

  function buildDashboardReceiptRequest(input) {
    const bookingId = clean(input && input.bookingId);
    const operationId = clean(input && input.operationId);
    const squareTransactionRef = clean(input && input.squareTransactionRef);
    const currency = clean(input && input.currency).toLowerCase();
    const amountCents = amountTextToCents(input && input.amountText);
    if (!bookingId) return { ok: false, message: 'A booking is required. The booking was not marked paid.' };
    if (!operationId) return { ok: false, message: 'There is no manual collection reservation. The booking was not marked paid.' };
    if (!squareTransactionRef) return { ok: false, message: 'A Square transaction reference is required. The booking was not marked paid.' };
    if (amountCents == null) return { ok: false, message: 'Enter the completed Square amount in dollars, such as 150.00. The booking was not marked paid.' };
    if (!/^[a-z]{3}$/.test(currency)) return { ok: false, message: 'Enter the currency you saw in Square, such as usd. The booking was not marked paid.' };
    if (input.dashboardObserved !== true) {
      return { ok: false, message: 'Confirm that you saw the completed payment in the Square Dashboard. Cardetail1 will not call Square. The booking was not marked paid.' };
    }
    return {
      ok: true,
      body: {
        action: 'record_square_dashboard_receipt',
        bookingId,
        operationId,
        squareTransactionRef,
        amountCents,
        currency,
        dashboardObserved: true,
      },
    };
  }

  function receiptResultMessage(result) {
    if (!result || result.ok !== true) return receiptFailureMessage({ data: result || {} });
    if (result.paid === true) return 'The server reports this booking paid.';
    if (result.idempotent) {
      return 'This Square reference is already recorded for this booking. No second settlement was added. Cardetail1 did not call Square and has not marked the booking paid.';
    }
    return 'Dashboard receipt recorded as an administrator attestation. Cardetail1 did not call Square and has not marked the booking paid.';
  }

  function receiptFailureMessage(error) {
    const data = error && error.data ? error.data : null;
    const code = clean((data && data.error) || (error && error.message) || 'receipt_failed');
    const messages = {
      square_transaction_reference_required: 'A Square transaction reference is required. Nothing was credited. The booking was not marked paid.',
      square_receipt_amount_mismatch: 'The amount does not match the booking balance. Nothing was credited. The booking was not marked paid.',
      square_receipt_currency_mismatch: 'The currency does not match the booking. Nothing was credited. The booking was not marked paid.',
      square_reference_conflict: 'That Square reference cannot be credited to this booking. Nothing was credited. The booking was not marked paid.',
      square_receipt_review_required: 'An unresolved financial conflict or an existing settlement blocks this receipt. Nothing was credited. The booking was not marked paid.',
      manual_collection_url_required: 'Record the Square URL on this collection before a receipt. The booking was not marked paid.',
      manual_collection_operation_mismatch: 'The collection operation does not match. Refresh the booking before trying again. The booking was not marked paid.',
      manual_collection_reservation_required: 'There is no manual collection reservation. The booking was not marked paid.',
      payment_attempt_in_progress: 'A payment attempt is still open. Nothing was credited. The booking was not marked paid.',
      square_dashboard_observation_required: 'Dashboard observation was not confirmed. Nothing was credited. The booking was not marked paid.',
      square_receipt_outcome_unknown: 'The receipt outcome is unknown. Refresh the booking and read it before trying again. Do not assume the receipt was stored. The booking was not marked paid.',
      square_receipt_failed: 'The receipt could not be stored. The booking was not marked paid.',
      database_not_configured: 'PostgreSQL is unavailable. The booking was not marked paid.',
      timeout: 'The receipt outcome is unknown. Refresh the booking and read it before trying again. Do not assume the receipt was stored. The booking was not marked paid.',
      aborted: 'The receipt outcome is unknown. Refresh the booking and read it before trying again. Do not assume the receipt was stored. The booking was not marked paid.',
      unauthorized: 'Session expired — log in again at admin.html',
      'Session expired — log in again at admin.html': 'Session expired — log in again at admin.html',
    };
    return messages[code] || 'The receipt was not recorded. The booking was not marked paid.';
  }

  function isUncertainReceiptOutcome(error) {
    const data = error && error.data ? error.data : null;
    const code = clean((data && data.error) || (error && error.message) || '');
    const status = Number(error && (error.status || error.statusCode));
    if (code === 'unauthorized' || status === 401) return false;
    if (code === 'square_receipt_outcome_unknown' || code === 'timeout' || code === 'aborted') return true;
    if (code === 'square_receipt_failed' || code === 'database_not_configured') return false;
    if (!Number.isFinite(status) || status === 0 || status >= 500) return true;
    return false;
  }

  function collectionStatusText(collection) {
    if (!collection || typeof collection !== 'object') return '';
    const parts = [];
    if (collection.url) parts.push('Square URL recorded for this collection: ' + collection.url);
    const conflicts = Array.isArray(collection.externalFinancialConflicts) ? collection.externalFinancialConflicts : [];
    if (conflicts.length > 0) {
      parts.push('Unresolved financial conflict. Review is required before another receipt. Square has not verified the payment.');
    }
    const receipt = collection.squareDashboardReceipt;
    if (receipt && receipt.providerEventId) {
      const reference = receipt.squareTransactionRef ? String(receipt.squareTransactionRef) : 'stored';
      parts.push('Dashboard receipt ' + reference + ' is stored as an administrator attestation. Square has not verified it.');
    }
    return parts.join(' ');
  }

  return {
    amountTextToCents,
    buildPaymentReportedRequest,
    buildDashboardReceiptRequest,
    receiptResultMessage,
    receiptFailureMessage,
    isUncertainReceiptOutcome,
    collectionStatusText,
  };
});
