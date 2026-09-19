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
label.field{display:flex;flex-direction:column;gap:6px;margin:0 0 10px;color:#5b6b64;font-size:.85rem}
label.field input,label.field select{padding:12px;border:1px solid #d7d0c4;border-radius:10px;font:600 1rem/1.2 system-ui,sans-serif;color:#14201c;background:#fff}
.ok{color:#0b3d2e}
.sub{color:#5b6b64;font-size:.9rem}
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
  const windows = Array.isArray(view.service && view.service.windows) ? view.service.windows : [];
  const selectedWindow = String((view.service && view.service.windowRaw) || '').trim();
  const schedule = a.reschedule ? `<section class="card">
  <h2>Change day / time</h2>
  <label class="field"><span>New date</span><input type="date" id="qo-date" value="${escapeHtml((view.service && view.service.dateIso) || '')}"/></label>
  <label class="field"><span>Window</span><select id="qo-window">${windows.map((slot) => `<option value="${escapeHtml(slot)}"${slot === selectedWindow ? ' selected' : ''}>${escapeHtml(slot)}</option>`).join('')}</select></label>
  <div class="actions"><button type="button" class="secondary" data-action="reschedule" data-confirm="Move this appointment to the new day and window?">Change day / time</button></div>
</section>` : '';
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
${request}
${schedule}
<section class="card">
  <h2>Actions</h2>
  <div class="actions">${buttons}</div>
  <p class="msg" id="qo-msg"></p>
</section>
<script>
(function(){
  var csrf = ${JSON.stringify(csrfToken)};
  var bookingVersion = ${JSON.stringify(view.bookingVersion || 0)};
  var msg = document.getElementById('qo-msg');
  function setMsg(text, ok){ msg.textContent = text || ''; msg.className = 'msg' + (ok ? ' ok' : ''); }
  document.addEventListener('click', async function(ev){
    var btn = ev.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var confirmText = btn.getAttribute('data-confirm');
    if (confirmText && !window.confirm(confirmText)) return;
    btn.disabled = true;
    try {
      var res = await fetch('/.netlify/functions/admin-quick-ops', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-qo-csrf': csrf },
        body: JSON.stringify((function(){
          var payload = { action: action, bookingVersion: bookingVersion };
          if (action === 'reschedule') {
            var dateEl = document.getElementById('qo-date');
            var winEl = document.getElementById('qo-window');
            payload.date = dateEl ? dateEl.value : '';
            payload.time = winEl ? winEl.value : '';
          }
          return payload;
        })())
      });
      var data = await res.json().catch(function(){ return {}; });
      if (action === 'copy_pay' && data.payUrl) {
        try { await navigator.clipboard.writeText(data.payUrl); setMsg('Payment link copied', true); }
        catch (e) { setMsg(data.payUrl, true); }
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
  paymentPage,
};
