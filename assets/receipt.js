/**
 * Receipt page controller.
 *
 * The static HTML carries no receipt data. Everything rendered here comes from
 * the authenticated customer-receipt Function, which enforces booking ownership
 * server-side. The browser performs no money arithmetic — every figure is
 * displayed exactly as the server derived it.
 */
(function () {
  'use strict';

  var root = document.getElementById('receipt-root');
  if (!root) return;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function param(name) {
    try { return new URLSearchParams(window.location.search).get(name) || ''; }
    catch (e) { return ''; }
  }

  function message(text, hint) {
    root.innerHTML = '<p class="msg">' + esc(text) +
      (hint ? '<br><span class="msg-hint">' + esc(hint) + '</span>' : '') + '</p>';
  }

  /**
   * My Garage authenticates in three ways: an account cookie session, a
   * booking-scoped lookup (Booking ID + phone) and a single-use email action
   * link. Only the first of those travels on a plain link to this page, so a
   * receipt opened from the other two used to fail with the portal's raw
   * "valid US mobile number" validation error. My Garage stores the lookup
   * credentials it verified in sessionStorage; replay them here so the receipt
   * is authorized the same way the portal that offered it was.
   *
   * The server still re-verifies ownership on every request — this only decides
   * which credential to present, never whether access is granted.
   */
  function storedPhoneFor(bookingId) {
    var storedId = '';
    var storedPhone = '';
    try {
      storedId = sessionStorage.getItem('cd1_garage_id') || '';
      storedPhone = sessionStorage.getItem('cd1_garage_phone') || '';
    } catch (e) { return ''; }
    if (!storedId || !storedPhone) return '';
    if (String(storedId).trim().toUpperCase() !== String(bookingId).trim().toUpperCase()) return '';
    return String(storedPhone).replace(/\D/g, '').slice(-10);
  }

  var RETURN_HINT = 'Open it again from My Garage — the button there signs the request for you.';

  /**
   * Denials raised by the shared booking authorization are phrased for the My
   * Garage login form, which has a phone field on screen ("A valid US mobile
   * number is required (10 digits)."). There is no such field here, so that
   * wording is restated as something the customer can act on from this page.
   */
  var AUTH_ERRORS = {
    validation_error: 'This receipt link is missing the sign-in details it needs.',
    authentication_failed: 'This receipt could not be verified for your account.',
    phone_not_on_file: 'This booking has no phone number on file.',
  };

  var CODE_ERRORS = {
    booking_not_found: 'We could not find that booking.',
    booking_not_ready: 'This booking is not available in My Garage yet.',
    invalid_receipt_type: 'That receipt type does not exist.',
    financial_authority_unavailable: 'Receipt records are temporarily unavailable.',
    rate_limited: 'Too many requests. Wait a moment and try again.',
  };

  function describeFailure(data, status) {
    var code = String((data && data.error) || '').toLowerCase();
    var serverMessage = String((data && data.message) || '').trim();

    if (AUTH_ERRORS[code]) return { text: AUTH_ERRORS[code], hint: RETURN_HINT };

    // A 200 with ok:false is the server's deliberate business answer — most
    // usefully "a payment receipt is available once a payment has been
    // received." Its own wording beats anything generic written here.
    if (status === 200 && serverMessage) return { text: serverMessage, hint: '' };

    if (code === 'receipt_unavailable') {
      return { text: 'This receipt could not be generated.', hint: 'Please try again in a moment.' };
    }
    if (CODE_ERRORS[code]) return { text: CODE_ERRORS[code], hint: RETURN_HINT };
    if (status === 429) return { text: CODE_ERRORS.rate_limited, hint: '' };
    if (status === 0 || status === 408 || status >= 500) {
      return { text: 'This receipt could not be loaded right now.', hint: 'Please try again in a moment.' };
    }
    return { text: 'This receipt is not available.', hint: RETURN_HINT };
  }

  function vehicleHtml(v) {
    var hasMoney = !!(v.subtotal || (v.package && v.package.price)
      || (v.addons || []).some(function (a) { return !!a.price; }));
    if (!hasMoney) {
      var names = (v.addons || []).map(function (a) {
        return '<li>' + esc(a.name) + (a.qty > 1 ? ' × ' + esc(a.qty) : '') + '</li>';
      }).join('');
      return '<section class="veh"><h3>' + esc(v.label || 'Vehicle') + '</h3>' +
        '<p>' + esc(v.package && v.package.name ? v.package.name : 'Package') + '</p>' +
        (names ? '<ul>' + names + '</ul>' : '') + '</section>';
    }
    var rows = '';
    rows += '<tr><td>' + esc(v.package && v.package.name ? v.package.name : 'Package') +
      '</td><td class="amt">' + esc(v.package && v.package.price ? v.package.price.display : '') + '</td></tr>';
    (v.addons || []).forEach(function (a) {
      rows += '<tr><td>' + esc(a.name) + (a.qty > 1 ? ' × ' + esc(a.qty) : '') +
        '</td><td class="amt">' + esc(a.price ? a.price.display : '') + '</td></tr>';
    });
    return '<section class="veh">' +
      '<h3>' + esc(v.label || 'Vehicle') + '</h3>' +
      '<div class="tblwrap"><table><tbody>' + rows +
      '<tr><td><strong>Vehicle subtotal</strong></td><td class="amt"><strong>' +
      esc(v.subtotal ? v.subtotal.display : '') + '</strong></td></tr>' +
      '</tbody></table></div></section>';
  }

  function paymentsHtml(payments) {
    if (!payments || !payments.length) return '';
    var rows = payments.map(function (p) {
      return '<tr><td>' + esc(p.date || '') + '</td><td>' + esc(p.method || '') +
        '</td><td>' + esc(p.reference || '—') + '</td><td class="amt">' +
        esc(p.amount ? p.amount.display : '') + '</td></tr>';
    }).join('');
    return '<h2>Payments received</h2><div class="tblwrap"><table>' +
      '<thead><tr><th scope="col">Date</th><th scope="col">Method</th><th scope="col">Reference</th><th scope="col" class="amt">Amount</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  function refundsHtml(refunds) {
    if (!refunds || !refunds.length) return '';
    var rows = refunds.map(function (refund) {
      return '<tr><td>' + esc(refund.date || '') + '</td><td>' + esc(refund.method || '') +
        '</td><td>' + esc(refund.reference || '—') + '</td><td class="amt">' +
        esc(refund.amount ? refund.amount.display : '') + '</td></tr>';
    }).join('');
    return '<h2>Refunds confirmed</h2><div class="tblwrap"><table>' +
      '<thead><tr><th scope="col">Date</th><th scope="col">Method</th><th scope="col">Reference</th><th scope="col" class="amt">Amount</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  function quoteItemsHtml(receipt) {
    var items = receipt.lineItems || [];
    if (!items.length) return '';
    var rows = items.map(function (item) {
      return '<tr><td>' + esc(item.name || 'Service') + '</td><td>' +
        esc(String(item.kind || 'service').replace(/_/g, ' ')) + '</td><td class="amt">' +
        esc(item.amount ? item.amount.display : '') + '</td></tr>';
    }).join('');
    return '<h2>Approved quote' + (receipt.quoteVersion ? ' · Version ' + esc(receipt.quoteVersion) : '') +
      '</h2><div class="tblwrap"><table><thead><tr><th scope="col">Item</th>' +
      '<th scope="col">Type</th><th scope="col" class="amt">Amount</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>';
  }

  function render(r) {
    var isFinal = r.receiptType === 'final';
    document.title = (isFinal ? 'Final receipt ' : 'Payment receipt ') + (r.receiptNumber || '') +
      ' | ' + (r.business ? r.business.name : '');

    var meta = '';
    meta += '<div><dt>Booking reference</dt><dd>' + esc(r.bookingReference) + '</dd></div>';
    meta += '<div><dt>Customer</dt><dd>' + esc(r.customer ? r.customer.name : '') + '</dd></div>';
    if (r.issuedAt) meta += '<div><dt>Issue date</dt><dd>' + esc(r.issuedAt) + '</dd></div>';
    if (r.quoteVersion) meta += '<div><dt>Approved quote version</dt><dd>' + esc(r.quoteVersion) + '</dd></div>';
    if (r.serviceDate) meta += '<div><dt>Service date</dt><dd>' + esc(r.serviceDate) + '</dd></div>';
    if (isFinal && r.completionDate) meta += '<div><dt>Completion date</dt><dd>' + esc(r.completionDate) + '</dd></div>';
    if (isFinal && r.serviceAddress) meta += '<div><dt>Service address</dt><dd>' + esc(r.serviceAddress) + '</dd></div>';
    if (r.paymentMethod) meta += '<div><dt>Payment method</dt><dd>' + esc(r.paymentMethod) + '</dd></div>';

    var vehicles = (r.vehicles || []).map(vehicleHtml).join('');
    var adjustments = (r.adjustments || []).map(function (a) {
      return '<tr><td>' + esc(a.name) + '</td><td class="amt">' + esc(a.amount ? a.amount.display : '') + '</td></tr>';
    }).join('');

    var fs = r.financialSummary || {};
    var totals = '<div class="totals"><div class="tblwrap"><table><tbody>' +
      (fs.serviceLinesTotal ? '<tr><td>Services subtotal</td><td class="amt">' + esc(fs.serviceLinesTotal.display) + '</td></tr>' : '') +
      ((r.lineItems || []).length ? '' : adjustments) +
      '<tr class="grand"><td>Approved total</td><td class="amt">' + esc(fs.approvedTotal ? fs.approvedTotal.display : '') + '</td></tr>' +
      '<tr><td>Gross amount paid</td><td class="amt">' + esc(fs.amountPaid ? fs.amountPaid.display : '') + '</td></tr>' +
      (fs.amountRefunded && fs.amountRefunded.cents > 0
        ? '<tr><td>Refunded</td><td class="amt">−' + esc(fs.amountRefunded.display) + '</td></tr>' : '') +
      (fs.netPaid ? '<tr><td>Net paid</td><td class="amt">' + esc(fs.netPaid.display) + '</td></tr>' : '') +
      (fs.refundPending && fs.refundPending.cents > 0
        ? '<tr><td>Refund pending</td><td class="amt">' + esc(fs.refundPending.display) + '</td></tr>' : '') +
      (fs.creditDue && fs.creditDue.cents > 0
        ? '<tr><td>Credit/refund due</td><td class="amt">' + esc(fs.creditDue.display) + '</td></tr>' : '') +
      '<tr><td>Remaining balance</td><td class="amt">' + esc(fs.remainingBalance ? fs.remainingBalance.display : '') + '</td></tr>' +
      '</tbody></table></div></div>';

    root.innerHTML =
      '<article class="doc">' +
      '<header class="brand">' +
      '<div><h1>' + esc(r.business ? r.business.name : '') + '</h1>' +
      '<p class="sub">' + esc(r.business ? r.business.phone : '') + ' · ' + esc(r.business ? r.business.site : '') + '</p></div>' +
      '<div class="num">' + (isFinal ? 'Final service receipt' : 'Payment receipt') +
      '<strong>' + esc(r.receiptNumber) + '</strong></div>' +
      '</header>' +
      '<p class="status">' + esc(r.status) + '</p>' +
      '<h2>Details</h2><dl class="meta">' + meta + '</dl>' +
      (vehicles ? '<h2>Vehicles and packages</h2>' + vehicles : '') +
      quoteItemsHtml(r) +
      totals +
      paymentsHtml(r.payments) +
      refundsHtml(r.refunds) +
      '<p class="foot">Issued by ' + esc(r.business ? r.business.name : '') +
      '. Questions about this receipt? Call or text ' + esc(r.business ? r.business.phone : '') +
      '. ' + esc(r.terms || '') + '</p>' +
      '</article>';
  }

  function showActions(on) {
    var btn = document.getElementById('btn-print');
    if (btn) btn.hidden = !on;
  }

  async function requestReceipt(bookingId, type, phone) {
    var body = { bookingId: bookingId, receiptType: type };
    if (phone) body.phone = phone;
    var res = await fetch('/.netlify/functions/customer-receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return null; });
    return { status: res.status, data: data };
  }

  function isTransient(status) {
    return status === 0 || status === 408 || status >= 500;
  }

  async function load() {
    var bookingId = param('bookingId');
    var type = param('type') === 'final' ? 'final' : 'payment';
    if (!bookingId) {
      message('No booking was specified.', 'Open your receipt from My Garage.');
      return;
    }

    // The account cookie, when present, always wins server-side; the stored phone
    // is only consulted when there is no account session to check.
    var phone = storedPhoneFor(bookingId);

    var attempt;
    try {
      attempt = await requestReceipt(bookingId, type, phone);
    } catch (e) {
      attempt = { status: 0, data: null };
    }

    // One quiet retry for a transient failure — a cold Function or a brief
    // ledger hiccup should not read to the customer as "no receipt exists".
    if (isTransient(attempt.status)) {
      await new Promise(function (r) { setTimeout(r, 1200); });
      try {
        attempt = await requestReceipt(bookingId, type, phone);
      } catch (e) { /* keep the first outcome */ }
    }

    var data = attempt.data;
    if (!data || !data.ok || !data.receipt) {
      var failure = describeFailure(data, attempt.status);
      message(failure.text, failure.hint);
      return;
    }
    render(data.receipt);
    showActions(true);
  }

  var printBtn = document.getElementById('btn-print');
  if (printBtn) printBtn.addEventListener('click', function () { window.print(); });

  load();
}());
