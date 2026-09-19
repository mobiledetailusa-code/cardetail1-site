'use strict';

const {
  chrome,
  escapeHtml,
  field,
  amountChangeMarkup,
  amountChangeClientScript,
  neutralExpiredPage,
} = require('./quick-ops-html');

function techQuickOpsPage(view, csrfToken) {
  const a = view.actions || {};
  const money = view.money || {};
  const paidLine = money.remainingCents > 0
    ? field('Remaining', money.remainingLabel)
    : '<div class="row"><span class="k">Balance</span><span class="v">Paid / No balance due</span></div>';
  const methodLine = money.methodLabel ? field('Method', money.methodLabel) : '';
  const fieldButtons = [
    a.accept ? '<button type="button" data-action="accept">Accept job</button>' : '',
    a.en_route ? '<button type="button" data-action="en_route">En route</button>' : '',
    a.arrived ? '<button type="button" class="secondary" data-action="arrived">Arrived</button>' : '',
    a.in_progress ? '<button type="button" data-action="in_progress">Start job</button>' : '',
    a.paused ? '<button type="button" class="secondary" data-action="paused">Pause</button>' : '',
    a.issue_reported ? '<button type="button" class="danger" data-action="issue_reported" data-confirm="Report an issue on this job?">Report issue</button>' : '',
    a.call ? `<a class="btn secondary" href="${escapeHtml(view.telUrl)}">Call customer</a>` : '',
    a.map ? `<a class="btn ghost" href="${escapeHtml(view.mapUrl)}" target="_blank" rel="noopener noreferrer">Open map</a>` : '',
    view.locked
      ? '<p class="sub">Job completed — field actions are locked</p>'
      : '<p class="sub">Photos stay on the technician portal.</p>',
  ].filter(Boolean).join('');

  const closeButtons = [
    amountChangeMarkup(view),
    a.complete ? '<button type="button" data-action="complete" data-confirm="Close this job with the selected amount?">Close job</button>' : '',
    a.payment ? '<button type="button" class="secondary" data-action="copy_pay">Copy payment link</button>' : '',
    a.text ? '<button type="button" class="secondary" data-action="text_pay">Text payment link</button>' : '',
    a.cash ? '<button type="button" class="secondary" data-action="record_cash" data-confirm="Record the remaining balance as cash on the Admin ledger?">Record cash</button>' : '',
    a.card ? '<button type="button" class="secondary" data-action="record_card" data-confirm="Record the remaining balance as card on site on the Admin ledger?">Record card</button>' : '',
    !a.payment && !a.cash && !a.card && !a.complete
      ? '<p class="sub">Paid / No balance due</p>'
      : '',
  ].filter(Boolean).join('');

  return chrome({
    title: 'Tech Quick Ops',
    extraHeaders: { 'X-Tq-Csrf': csrfToken },
    body: `
<section class="card">
  <div class="status">${escapeHtml(view.fieldStatusLabel || view.status)}</div>
  <h1>${escapeHtml(view.customer.name || 'Customer')}</h1>
  ${field('Phone', view.customer.phone)}
  ${field('Assigned', view.assignedTech)}
</section>
<section class="card">
  <h2>Vehicle</h2>
  ${field('Vehicle', [view.vehicle.year, view.vehicle.make, view.vehicle.model].filter(Boolean).join(' ') || view.vehicle.label)}
  ${field('Type', view.vehicle.type)}
</section>
<section class="card">
  <h2>Service</h2>
  ${field('Package', view.service.package)}
  ${field('Approved', money.approvedLabel)}
  ${field('Paid', money.paidLabel)}
  ${methodLine}
  ${paidLine}
  ${field('Date', view.service.date)}
  ${field('Window', view.service.window)}
  ${field('Address', view.service.address)}
  ${view.service.note ? `<p class="note">${escapeHtml(view.service.note)}</p>` : ''}
</section>
<section class="card">
  <h2>Field actions</h2>
  <div class="actions">${fieldButtons}</div>
</section>
<section class="card">
  <h2>Close / payment</h2>
  <p class="sub">Original, add, or reduce the total. Notes are required for a price change. The payment link is the same /pay customer link.</p>
  <div class="actions">${closeButtons}</div>
  <p class="msg" id="tq-msg"></p>
</section>
<script>
(function(){
  var csrf = ${JSON.stringify(csrfToken)};
  var bookingVersion = ${JSON.stringify(view.bookingVersion || 0)};
  var msg = document.getElementById('tq-msg');
  function setMsg(text, ok){ msg.textContent = text || ''; msg.className = 'msg' + (ok ? ' ok' : ''); }
  ${amountChangeClientScript()}
  document.addEventListener('click', async function(ev){
    var btn = ev.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var confirmText = btn.getAttribute('data-confirm');
    if (confirmText && !window.confirm(confirmText)) return;
    btn.disabled = true;
    try {
      var payload = Object.assign({ action: action, bookingVersion: bookingVersion }, amountPayload());
      var res = await fetch('/.netlify/functions/tech-quick-ops', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-tq-csrf': csrf },
        body: JSON.stringify(payload)
      });
      var data = await res.json().catch(function(){ return {}; });
      if (action === 'copy_pay' && data.payUrl) {
        try { await navigator.clipboard.writeText(data.payUrl); setMsg('Payment link copied', true); }
        catch (e) { setMsg(data.payUrl, true); }
        if (data.reload) location.reload();
        return;
      }
      if (!res.ok || data.ok === false) { setMsg(data.message || data.error || 'Could not complete'); return; }
      setMsg(data.message || 'Done', true);
      if (data.reload) location.reload();
    } catch (e) { setMsg('Network error'); }
    finally { btn.disabled = false; }
  });
})();
</script>`,
  });
}

module.exports = {
  techQuickOpsPage,
  neutralExpiredPage,
};
