'use strict';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function chrome({ title, body, statusCode = 200, extraHeaders = {}, jsonLd = '' }) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      ...extraHeaders,
    },
    body: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="referrer" content="no-referrer"/>
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light; }
body{margin:0;font-family:Georgia,serif;background:#f6f3ee;color:#14201c}
.wrap{max-width:430px;margin:0 auto;padding:20px 16px 40px}
.card{background:#fff;border:1px solid #d7d0c4;border-radius:14px;padding:18px 16px;margin:0 0 14px}
h1{font-size:1.35rem;margin:0 0 8px}
h2{font-size:0.78rem;letter-spacing:.08em;text-transform:uppercase;color:#5b6b64;margin:0 0 8px}
p,dt,dd{margin:0}
.row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #eee}
.row:last-child{border-bottom:0}
.k{color:#5b6b64}
.v{font-weight:600;text-align:right}
.note{margin-top:8px;color:#3b4a44;font-size:.95rem}
.status{display:inline-block;background:#e8efe9;color:#0b3d2e;border-radius:999px;padding:4px 10px;font-size:.8rem;margin-bottom:10px}
.actions{display:flex;flex-direction:column;gap:10px;margin-top:8px}
button,.btn{appearance:none;display:block;width:100%;box-sizing:border-box;border:0;border-radius:12px;padding:16px 14px;font:600 1.05rem/1.2 system-ui,sans-serif;text-align:center;text-decoration:none;color:#fff;background:#0b3d2e}
button.secondary,.btn.secondary{background:#2f4a43}
button.danger,.btn.danger{background:#7a1f1f}
button:disabled{opacity:.45}
.ghost{background:#efe8dc;color:#14201c}
.msg{min-height:1.2em;margin:8px 0 0;color:#7a1f1f}
.ok{color:#0b3d2e}
.sub{color:#5b6b64;font-size:.9rem}
label{display:block;font-size:.85rem;color:#5b6b64;margin:10px 0 4px}
input,select,textarea{width:100%;box-sizing:border-box;border:1px solid #d7d0c4;border-radius:10px;padding:12px;font:1rem/1.3 system-ui,sans-serif;background:#fff;color:#14201c}
textarea{min-height:76px;resize:vertical}
.warn{background:#fff6e8;border:1px solid #e6d3a8;border-radius:10px;padding:10px 12px;color:#6a4b12;font-size:.92rem;margin:8px 0}
</style>
</head>
<body>
<main class="wrap">${body}</main>
${jsonLd}
</body>
</html>`,
  };
}

function neutralExpiredPage(kind = 'ops') {
  const title = kind === 'pay' ? 'Payment link expired or invalid' : 'Link expired or invalid';
  return chrome({
    title,
    statusCode: 400,
    body: `<section class="card"><h1>${escapeHtml(title)}</h1><p class="sub">This secure link is no longer valid.</p></section>`,
  });
}

function field(label, value) {
  if (!value) return '';
  return `<div class="row"><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(value)}</span></div>`;
}

function ceramicStaffCard(view) {
  const ceramic = view && view.ceramic;
  const internal = ceramic && ceramic.internal;
  if (!internal) return '';
  const audit = Array.isArray(internal.auditHistory) ? internal.auditHistory : [];
  const latest = audit.length ? audit[audit.length - 1] : null;
  return `<section class="card">
  <h2>Assigned coating</h2>
  <p class="sub">${escapeHtml(internal.staffDisclosure || '')}</p>
  ${(ceramic.serviceLineItems || []).map((line) => field(line.name || line.serviceId, `${line.completionStatus || 'pending'} · $${Number(line.price || 0).toFixed(2)}`)).join('')}
  ${ceramic.sequencingNote ? `<p class="note">${escapeHtml(ceramic.sequencingNote)}</p>` : ''}
  ${(ceramic.serviceLineItems || []).filter((line) => line.completionStatus !== 'completed').map((line) => (
    `<button type="button" class="secondary" data-action="complete_service_line" data-service-id="${escapeHtml(line.serviceId || '')}">Mark ${escapeHtml(line.name || 'service')} complete</button>`
  )).join('')}
  ${field('Public package', ceramic.packageName)}
  ${field('Manufacturer', internal.coatingManufacturer)}
  ${field('Product', internal.coatingProduct)}
  ${field('SKU', internal.internalSku)}
  ${field('Documented durability', internal.durabilityMonths ? `up to ${internal.durabilityMonths} months` : '')}
  ${field('Batch / lot', internal.batchOrLotNumber)}
  ${field('Bottle opened', internal.bottleOpenedAt)}
  ${field('Expiration', internal.expirationDate)}
  ${field('Application date', internal.applicationDate)}
  ${field('Installer', internal.installer)}
  ${internal.internalNotes ? `<p class="note">${escapeHtml(internal.internalNotes)}</p>` : ''}
  ${(internal.cureRequirements || []).map((line) => `<p class="note">${escapeHtml(line)}</p>`).join('')}
  ${latest ? `<p class="sub">Last audit: ${escapeHtml(latest.action || '')} ${escapeHtml(latest.at || '')}</p>` : ''}
</section>`;
}

function quickOpsPage(view, csrfToken) {
  const a = view.actions || {};
  const money = view.money || {};
  const paidLine = money.remainingCents > 0
    ? field('Remaining', money.remainingLabel)
    : `<div class="row"><span class="k">Balance</span><span class="v">Paid / No balance due</span></div>`;
  const methodLine = money.methodLabel ? field('Method', money.methodLabel) : '';
  const lockedNote = view.locked
    ? '<p class="sub">Paid / completed — details are locked</p>'
    : '';
  const request = view.request
    ? `<section class="card"><h2>Request</h2><p>${escapeHtml(view.request.summary)}</p></section>`
    : (view.cancelRequested
      ? '<section class="card"><h2>Request</h2><p>Cancellation requested — appointment still scheduled.</p></section>'
      : '');
  const buttons = [
    a.confirm ? '<button type="button" data-action="confirm">Confirm appointment</button>' : '',
    a.cancel ? '<button type="button" class="danger" data-action="cancel" data-confirm="Cancel this appointment?">Cancel appointment</button>' : '',
    a.approve ? '<button type="button" data-action="approve">Approve request</button>' : '',
    a.reject ? '<button type="button" class="danger" data-action="reject">Reject request</button>' : '',
    a.call ? `<a class="btn secondary" href="${escapeHtml(view.telUrl)}">Call customer</a>` : '',
    a.text ? '<button type="button" class="secondary" data-action="text">Text customer</button>' : '',
    a.map ? `<a class="btn ghost" href="${escapeHtml(view.mapUrl)}" target="_blank" rel="noopener noreferrer">Open map</a>` : '',
    a.payment ? '<button type="button" class="secondary" data-action="copy_pay">Copy payment link</button>' : '',
    a.payment ? '<button type="button" class="secondary" data-action="text_pay">Text payment link</button>' : '',
    a.cash ? '<button type="button" class="secondary" data-action="record_cash" data-confirm="Record the remaining balance as cash? This uses the same Admin payment ledger.">Record cash</button>' : '',
    a.card ? '<button type="button" class="secondary" data-action="record_card" data-confirm="Record the remaining balance as card on site? This uses the same Admin payment ledger.">Record card</button>' : '',
    !a.payment && !a.cash && !a.card ? '<p class="sub">Paid / No balance due</p>' : '',
    lockedNote,
  ].filter(Boolean).join('');
  return chrome({
    title: 'Quick Ops',
    extraHeaders: { 'X-Qo-Csrf': csrfToken },
    body: `
<section class="card">
  <div class="status">${escapeHtml(view.status)}</div>
  <h1>${escapeHtml(view.customer.name || 'Customer')}</h1>
  ${field('Phone', view.customer.phone)}
</section>
<section class="card">
  <h2>Vehicle</h2>
  ${field('Vehicle', [view.vehicle.year, view.vehicle.make, view.vehicle.model].filter(Boolean).join(' ') || view.vehicle.label)}
  ${field('Type', view.vehicle.type)}
</section>
<section class="card">
  <h2>Service</h2>
  ${field('Package', (view.ceramic && view.ceramic.packageName) || view.service.package)}
  ${field('Approved', money.approvedLabel)}
  ${field('Paid', money.paidLabel)}
  ${methodLine}
  ${paidLine}
  ${field('Date', view.service.date)}
  ${field('Window', view.service.window)}
  ${field('Address', view.service.address)}
  <div class="row"><span class="k">Technician</span><span class="v" id="qo-tech-label">${escapeHtml((view.assignment && view.assignment.label) || '—')}</span></div>
  ${field('Tech payout', money.payoutLabel)}
  ${view.service.note ? `<p class="note">${escapeHtml(view.service.note)}</p>` : ''}
</section>
${a.assign ? `<section class="card">
  <h2>Assign technician</h2>
  <p id="qo-assigned" class="status">${view.assignment && view.assignment.assigned ? `Assigned to ${escapeHtml(view.assignment.label)}` : 'No technician is assigned.'}</p>
  <div class="actions">
    <button type="button" class="secondary" id="qo-unassign" data-action="unassign_tech" data-confirm="Remove this job from the assigned technician? You can assign it to someone else after." ${view.assignment && view.assignment.assigned ? '' : 'hidden'}>Remove assignment</button>
  </div>
  <p class="sub">Send this job to someone already on the roster, or type a mobile number. Assigning sends a text right away: a saved technician gets the portal link on the phone in their account, and a new number gets a one-time job link. The job total stays hidden. They send the customer a payment link, and any amount they add is included in that link. The job closes when the customer pays.</p>
  <label for="qo-tech">Registered technician</label>
  <select id="qo-tech"><option value="">Load the roster, or leave blank</option></select>
  <div class="actions"><button type="button" class="secondary" data-action="list_techs">Load roster</button></div>
  <label for="qo-phone">Freelance phone</label>
  <input id="qo-phone" inputmode="tel" autocomplete="tel" placeholder="(201) 555-0100">
  <p class="sub">If this number already belongs to a technician, the job goes to that account instead of a one-off link.</p>
  <label for="qo-tech-pay">Technician pay ($)</label>
  <input id="qo-tech-pay" inputmode="decimal" placeholder="80.00" value="">
  <p class="sub">This is the only amount the technician sees. The customer price stays on this page.</p>
  <div class="actions">
    <button type="button" data-action="set_tech_pay">Save technician pay</button>
    <button type="button" data-action="assign_tech">Assign job</button>
  </div>
</section>` : ''}
${a.adjust ? `<section class="card">
  <h2>Change price</h2>
  <p class="warn">A decrease lowers the technician payout by the same share. A $200 job with a $120 payout, lowered by $20, pays $108.</p>
  <label for="qo-adj-type">Change</label>
  <select id="qo-adj-type"><option value="increase">Increase</option><option value="decrease">Decrease</option></select>
  <label for="qo-adj-amount">Amount ($)</label>
  <input id="qo-adj-amount" inputmode="decimal" placeholder="20.00">
  <label for="qo-adj-note">Note (required)</label>
  <textarea id="qo-adj-note" maxlength="500" placeholder="Why the price is changing"></textarea>
  <p class="sub" id="qo-adj-preview"></p>
  <div class="actions"><button type="button" data-action="adjust_price">Apply price change</button></div>
</section>` : ''}
${request}
${ceramicStaffCard(view)}
<section class="card">
  <h2>Actions</h2>
  <div class="actions">${buttons}</div>
  <p class="msg" id="qo-msg"></p>
</section>
<script>
(function(){
  var csrf = ${JSON.stringify(csrfToken)};
  var bookingVersion = ${JSON.stringify(view.bookingVersion || 0)};
  var approvedCents = ${JSON.stringify(money.approvedCents || 0)};
  var payoutCents = ${JSON.stringify(money.payoutCents)};
  var msg = document.getElementById('qo-msg');
  function setMsg(text, ok){ msg.textContent = text || ''; msg.className = 'msg' + (ok ? ' ok' : ''); }
  function dollars(cents){ return '$' + (Math.max(0, Math.round(cents)) / 100).toFixed(2); }
  function previewAdjust(){
    var el = document.getElementById('qo-adj-preview');
    var amountEl = document.getElementById('qo-adj-amount');
    var typeEl = document.getElementById('qo-adj-type');
    if (!el || !amountEl || !typeEl) return;
    var raw = String(amountEl.value || '').replace(/[^0-9.]/g, '');
    var cents = Math.round(Number(raw) * 100);
    if (!cents) { el.textContent = payoutCents == null ? 'Technician payout is not set yet.' : ('Current payout ' + dollars(payoutCents) + '.'); return; }
    var next = typeEl.value === 'decrease' ? approvedCents - cents : approvedCents + cents;
    if (next < 0) { el.textContent = 'That decrease is larger than the balance.'; return; }
    var line = 'New total ' + dollars(next) + '.';
    if (payoutCents != null && approvedCents > 0) {
      var nextPay = Math.round(payoutCents * next / approvedCents);
      line += ' Technician payout becomes ' + dollars(nextPay) + '.';
      if (typeEl.value === 'decrease') line += ' Lowering the price lowers the payout.';
    }
    el.textContent = line;
  }
  var amountEl = document.getElementById('qo-adj-amount');
  var typeEl = document.getElementById('qo-adj-type');
  if (amountEl) amountEl.addEventListener('input', previewAdjust);
  if (typeEl) typeEl.addEventListener('change', previewAdjust);
  previewAdjust();
  document.addEventListener('click', async function(ev){
    var btn = ev.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var confirmText = btn.getAttribute('data-confirm');
    if (confirmText && !window.confirm(confirmText)) return;
    var payload = { action: action, bookingVersion: bookingVersion, serviceId: btn.getAttribute('data-service-id') || '' };
    if (action === 'assign_tech') {
      payload.techId = (document.getElementById('qo-tech') || {}).value || '';
      payload.phone = (document.getElementById('qo-phone') || {}).value || '';
      if (!payload.techId && !String(payload.phone).trim()) { setMsg('Choose a technician or enter a phone'); return; }
    }
    if (action === 'set_tech_pay') {
      payload.amountDollars = (document.getElementById('qo-tech-pay') || {}).value || '';
      if (!String(payload.amountDollars).trim()) { setMsg('Enter the technician pay'); return; }
    }
    if (action === 'adjust_price') {
      payload.type = (document.getElementById('qo-adj-type') || {}).value || '';
      payload.amountDollars = (document.getElementById('qo-adj-amount') || {}).value || '';
      payload.reason = (document.getElementById('qo-adj-note') || {}).value || '';
      if (String(payload.reason).trim().length < 8) { setMsg('Add a note of at least 8 characters'); return; }
      if (payload.type === 'decrease' && !window.confirm('Lowering the price also lowers the technician payout by the same share. Continue?')) return;
    }
    btn.disabled = true;
    try {
      var res = await fetch('/.netlify/functions/admin-quick-ops', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-qo-csrf': csrf },
        body: JSON.stringify(payload)
      });
      var data = await res.json().catch(function(){ return {}; });
      if (action === 'copy_pay' && data.payUrl) {
        try { await navigator.clipboard.writeText(data.payUrl); setMsg('Payment link copied', true); }
        catch (e) { setMsg(data.payUrl, true); }
        return;
      }
      if (action === 'list_techs' && data.ok) {
        var sel = document.getElementById('qo-tech');
        var techs = data.technicians || [];
        function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]); }); }
        sel.innerHTML = '<option value="">Leave blank to use the phone</option>' + techs.map(function(t){
          return '<option value="' + esc(t.techId) + '">' + esc(t.fullName) + '</option>';
        }).join('');
        setMsg(techs.length ? 'Roster loaded' : 'No active technicians', true);
        return;
      }
      if (!res.ok || data.ok === false) { setMsg(data.message || data.error || 'Could not complete'); return; }
      if (typeof data.bookingVersion === 'number') bookingVersion = data.bookingVersion;
      if (data.assignment) {
        var assignedText = data.assignment.label ? ('Assigned to ' + data.assignment.label) : 'No technician is assigned.';
        var assignedEl = document.getElementById('qo-assigned');
        var techLabel = document.getElementById('qo-tech-label');
        var unassignBtn = document.getElementById('qo-unassign');
        if (assignedEl) assignedEl.textContent = assignedText;
        if (techLabel) techLabel.textContent = data.assignment.label || '—';
        if (unassignBtn) unassignBtn.hidden = !data.assignment.label;
      }
      if (data.techUrl) {
        try { await navigator.clipboard.writeText(data.techUrl); } catch (e) {}
        setMsg((data.message || 'Link ready') + ' ' + data.techUrl, true);
        return;
      }
      setMsg(data.message || 'Done', true);
      if (data.reload) location.reload();
    } catch (e) { setMsg('Network error'); }
    finally { btn.disabled = false; }
  });
})();
</script>`,
  });
}

function techQuickOpsPage(view, csrfToken) {
  const a = view.actions || {};
  const buttons = [
    a.call ? `<a class="btn secondary" href="${escapeHtml(view.telUrl)}">Call customer</a>` : '',
    a.map ? `<a class="btn ghost" href="${escapeHtml(view.mapUrl)}" target="_blank" rel="noopener noreferrer">Open map</a>` : '',
    a.payment ? '<button type="button" class="secondary" data-action="text_pay">Text payment link to customer</button>' : '',
    a.payment ? '<button type="button" class="ghost" data-action="copy_pay">Copy payment link</button>' : '',
    !a.payment ? '<p class="sub">No payment link to send.</p>' : '',
  ].filter(Boolean).join('');
  const vehicle = [view.vehicle.year, view.vehicle.make, view.vehicle.model].filter(Boolean).join(' ') || view.vehicle.label;
  return chrome({
    title: 'Technician job',
    extraHeaders: { 'X-Tq-Csrf': csrfToken },
    body: `
<section class="card">
  <div class="status">${escapeHtml(view.status)}</div>
  <h1>${escapeHtml(view.customer.name || 'Customer')}</h1>
  <p class="sub">Your pay is the amount the office entered. The customer price stays off this page. Send them a payment link. The job closes when they pay.</p>
</section>
<section class="card">
  <h2>Your pay</h2>
  <p id="tq-pay" style="font-size:1.8rem;font-weight:700;margin:4px 0">${view.yourPay && view.yourPay.set ? escapeHtml(view.yourPay.label) : 'Not set yet'}</p>
  <p class="sub">This is what you receive for this job.</p>
</section>
<section class="card">
  <h2>Job</h2>
  ${field('Address', view.service.address)}
  ${field('Vehicle', vehicle)}
  ${field('Package', view.service.package)}
  ${field('Date', view.service.date)}
  ${field('Window', view.service.window)}
  ${view.service.note ? `<p class="note">${escapeHtml(view.service.note)}</p>` : ''}
</section>
${a.increase ? `<section class="card">
  <h2>Add to the payment</h2>
  <p class="sub">Type only the extra. It is added to your pay and to the customer payment link. You still do not see the original price.</p>
  <label for="tq-adj-amount">Extra amount ($)</label>
  <input id="tq-adj-amount" inputmode="decimal" placeholder="20.00">
  <label for="tq-adj-note">Note (required)</label>
  <textarea id="tq-adj-note" maxlength="500" placeholder="What the extra charge is for"></textarea>
  <div class="actions"><button type="button" data-action="adjust_price">Add and send updated link</button></div>
</section>` : ''}
<section class="card">
  <h2>Customer payment</h2>
  <div class="actions">${buttons}</div>
  <p class="msg" id="tq-msg"></p>
</section>
<script>
(function(){
  var csrf = ${JSON.stringify(csrfToken)};
  var bookingVersion = ${JSON.stringify(view.bookingVersion || 0)};
  var msg = document.getElementById('tq-msg');
  function setMsg(text, ok){ msg.textContent = text || ''; msg.className = 'msg' + (ok ? ' ok' : ''); }
  document.addEventListener('click', async function(ev){
    var btn = ev.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var payload = { action: action, bookingVersion: bookingVersion };
    if (action === 'adjust_price') {
      payload.type = 'increase';
      payload.amountDollars = (document.getElementById('tq-adj-amount') || {}).value || '';
      payload.reason = (document.getElementById('tq-adj-note') || {}).value || '';
      if (!String(payload.amountDollars).trim()) { setMsg('Enter the extra amount'); return; }
      if (String(payload.reason).trim().length < 8) { setMsg('Add a note of at least 8 characters'); return; }
      if (!window.confirm('Add this amount and send the customer an updated payment link?')) return;
    }
    btn.disabled = true;
    try {
      var res = await fetch('/.netlify/functions/tech-quick-ops', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-tq-csrf': csrf },
        body: JSON.stringify(payload)
      });
      var data = await res.json().catch(function(){ return {}; });
      if (typeof data.bookingVersion === 'number') bookingVersion = data.bookingVersion;
      if (data.yourPayLabel) {
        var payEl = document.getElementById('tq-pay');
        if (payEl) payEl.textContent = data.yourPayLabel;
      }
      if ((action === 'copy_pay' || action === 'adjust_price') && data.payUrl && !data.queued) {
        try { await navigator.clipboard.writeText(data.payUrl); setMsg(data.message || 'Payment link copied', true); }
        catch (e) { setMsg(data.message || 'Payment link ready', true); }
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

function paymentPage({ amountLabel, clientConfigUrl, csrf }) {
  return chrome({
    title: 'Pay Cardetail1',
    body: `
<section class="card">
  <h1>Cardetail1</h1>
  <p class="sub">Secure payment for your mobile detailing appointment.</p>
  <div class="row"><span class="k">Amount due</span><span class="v">${escapeHtml(amountLabel)}</span></div>
</section>
<section class="card">
  <div id="payment-element"></div>
  <div class="actions" style="margin-top:14px">
    <button type="button" id="pay-btn">Pay now</button>
  </div>
  <p class="msg" id="pay-msg"></p>
</section>
<script src="https://js.stripe.com/v3/"></script>
<script>
(function(){
  var msg = document.getElementById('pay-msg');
  var btn = document.getElementById('pay-btn');
  var stripe, elements;
  function setMsg(text, ok){ msg.textContent = text || ''; msg.className = 'msg' + (ok ? ' ok' : ''); }
  async function boot(){
    var token = location.pathname.split('/').filter(Boolean).pop() || '';
    var cfg = await fetch('/.netlify/functions/stripe-config').then(function(r){ return r.json(); });
    var intent = await fetch('/.netlify/functions/payment-resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'intent', token: token })
    }).then(function(r){ return r.json(); });
    if (!intent.ok) { setMsg(intent.message || intent.error || 'Payment unavailable'); btn.disabled = true; return; }
    stripe = Stripe(cfg.publishableKey);
    elements = stripe.elements({ clientSecret: intent.clientSecret, customerSessionClientSecret: intent.customerSessionClientSecret || undefined });
    elements.create('payment', { layout: 'tabs' }).mount('#payment-element');
  }
  btn.addEventListener('click', async function(){
    if (!stripe || !elements) return;
    btn.disabled = true;
    var result = await stripe.confirmPayment({
      elements: elements,
      redirect: 'if_required',
      confirmParams: { return_url: location.href }
    });
    if (result.error) { setMsg(result.error.message || 'Payment failed'); btn.disabled = false; return; }
    setMsg('Payment submitted. Waiting for confirmation…', true);
  });
  boot().catch(function(){ setMsg('Could not load payment'); });
})();
</script>`,
  });
}

module.exports = {
  escapeHtml,
  chrome,
  neutralExpiredPage,
  quickOpsPage,
  techQuickOpsPage,
  paymentPage,
};
