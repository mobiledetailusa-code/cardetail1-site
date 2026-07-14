/**
 * Restore six-step booking panel navigation on index.html
 * while preserving welcome-offer / analytics / backend-compatible payload.
 *
 * Reference UI: 117484e (Category → Package → Vehicle → Info → Secure → Confirm)
 * Current master is authoritative for Stripe/offer/Ops.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'index.html');
let html = fs.readFileSync(file, 'utf8');

const progressSix = `    <div class="bprog" id="bprog" aria-label="Booking progress — 6 steps">
      <div class="bpt active" id="bpt1"><div class="bpn">1</div><span>Category</span></div>
      <div class="bpt" id="bpt2"><div class="bpn">2</div><span>Package</span></div>
      <div class="bpt" id="bpt3"><div class="bpn">3</div><span>Vehicle</span></div>
      <div class="bpt" id="bpt4"><div class="bpn">4</div><span>Info</span></div>
      <div class="bpt" id="bpt5"><div class="bpn">5</div><span>Secure Your Booking</span></div>
      <div class="bpt" id="bpt6"><div class="bpn">6</div><span>Confirm</span></div>
    </div>`;

html = html.replace(
  /<div class="bprog" id="bprog" aria-label="Booking progress — 4 steps">[\s\S]*?<\/div>\s*\n\s*\n\s*<div class="bcontent">/,
  `${progressSix}\n\n    <div class="bcontent">`
);

html = html.replace(/Book in four steps/gi, 'Book in six steps');
html = html.replace(
  /Request your appointment in four clear steps/gi,
  'Request your appointment in six clear steps'
);

html = html.replace(
  /<div class="beye">Step 1 of 4 — Service<\/div>/,
  '<div class="beye">Step 01 — Category</div>'
);
html = html.replace(
  /<!-- STEP 1 \(cont\.\): PACKAGES — same visible step as category -->/,
  '<!-- STEP 2: PACKAGES -->'
);
html = html.replace(
  /<div class="beye">Step 1 of 4 — Package<\/div>/,
  '<div class="beye">Step 02 — Package</div>'
);
html = html.replace(
  /onclick="bkContinueFromPackage\(\)">Continue to vehicle →<\/button>/,
  'onclick="bkGoTo(3)">Continue to vehicle →</button>'
);
html = html.replace(
  /<!-- STEP 3: VEHICLE -->/,
  '<!-- STEP 3: VEHICLE -->'
);
html = html.replace(
  /<div class="beye">Step 2 of 4 — Vehicle &amp; Add-ons<\/div>/,
  '<div class="beye">Step 03 — Vehicle</div>'
);
html = html.replace(
  /<button type="button" class="btn-b" onclick="bkGoTo\(1\)">← Back<\/button>\s*<button type="button" class="btn-n" id="next3"/,
  '<button type="button" class="btn-b" onclick="bkGoTo(2)">← Back</button>\n          <button type="button" class="btn-n" id="next3"'
);
html = html.replace(
  /Continue to contact →/,
  'Continue to Info →'
);
html = html.replace(
  /<div class="beye">Step 3 of 4 — Contact &amp; Schedule<\/div>/,
  '<div class="beye">Step 04 — Info</div>'
);
html = html.replace(
  /<button type="button" class="btn-b" onclick="bkGoTo\(2\)">← Back<\/button>\s*<button type="button" class="btn-n" onclick="bkContinueFromContact\(\)">Continue to secure booking →<\/button>/,
  '<button type="button" class="btn-b" onclick="bkGoTo(3)">← Back</button>\n          <button type="button" class="btn-n" onclick="goToPayment()">Review Terms →</button>'
);
html = html.replace(
  /<div class="beye">Step 4 of 4 — Secure &amp; Submit<\/div>/,
  '<div class="beye">Step 05 — Secure Your Booking</div>'
);
html = html.replace(
  /<!-- STEP 4 \(cont\.\): REVIEW & SUBMIT -->/,
  '<!-- STEP 6: CONFIRM -->'
);
html = html.replace(
  /<div class="beye">Step 4 of 4 — Review<\/div>/,
  '<div class="beye">Step 06 — Confirm</div>'
);
html = html.replace(
  /<button type="button" class="btn-b" onclick="bkGoTo\(3\)">← Back<\/button>\s*<button type="button" class="btn-n" onclick="bkScrollToConfirm\(\)">Review &amp; Submit →<\/button>/,
  '<button type="button" class="btn-b" onclick="bkGoTo(4)">← Back</button>\n          <button type="button" class="btn-n" onclick="goToConfirmFromTerms()">Review &amp; Submit →</button>'
);
html = html.replace(
  /<button type="button" class="btn-b" onclick="bkScrollToPayment\(\)">← Back<\/button>/,
  '<button type="button" class="btn-b" onclick="bkGoTo(5)">← Back</button>'
);

const navBlock = `// ── BOOKING NAVIGATION (6 visible steps — restored from proven 117484e UX) ────
const BK_VISIBLE_STEPS = 6;
let currentBkStep = 1;
let _bkPrevStep = 1;

function bkPanelsForStep(n) {
  return ['bs' + n];
}

function bkGoTo(n, opts = {}) {
  n = Math.max(1, Math.min(BK_VISIBLE_STEPS, Number(n) || 1));
  _bkPrevStep = currentBkStep;
  currentBkStep = n;
  const panels = bkPanelsForStep(n);
  document.querySelectorAll('.bsec').forEach(s => {
    s.classList.toggle('on', panels.includes(s.id));
  });
  document.querySelectorAll('.bpt').forEach((t, i) => {
    t.classList.remove('active', 'done');
    if (i + 1 < n) t.classList.add('done');
    else if (i + 1 === n) t.classList.add('active');
  });
  const activeTab = document.getElementById('bpt' + n);
  if (activeTab && activeTab.scrollIntoView) activeTab.scrollIntoView({ inline: 'center', block: 'nearest' });
  if (n === 3) renderVehicleCart();
  if (n === 4) fillStrip5();
  if (n === 5) {
    ensureStep5Defaults();
    if (window.Cardetail1WelcomeOffer) Cardetail1WelcomeOffer.fetchPreview('step5');
  }
  if (n === 6) fillConfirm();
  if (!opts.noScroll) {
    ['.bcontent', '.booking-modal', '.booking-modal-ov'].forEach(s => {
      const el = document.querySelector(s);
      if (el) el.scrollTop = 0;
    });
  }
  try {
    const heading = document.querySelector('#bs' + n + ' .btitle');
    if (heading && heading.focus) { heading.setAttribute('tabindex','-1'); heading.focus({preventScroll:true}); }
  } catch (e) {}
  if (window.Cardetail1CheckoutAnalytics && _bkPrevStep > n) {
    Cardetail1CheckoutAnalytics.onStepBack(_bkPrevStep, n);
  }
}

function bkContinueFromPackage() {
  if (!ST.pkg) {
    if (window.Cardetail1CheckoutAnalytics) Cardetail1CheckoutAnalytics.onValidationError(2, 'package_required');
    alert('Please select a package to continue.');
    return;
  }
  if (window.Cardetail1CheckoutAnalytics) Cardetail1CheckoutAnalytics.onStepCompleted(2);
  bkGoTo(3);
}

function bkContinueFromContact() {
  const req = ['f-first', 'f-last', 'f-phone', 'f-email', 'f-addr', 'f-date', 'f-time'];
  const missing = req.find(id => !document.getElementById(id)?.value?.trim());
  if (missing) {
    if (window.Cardetail1CheckoutAnalytics) Cardetail1CheckoutAnalytics.onValidationError(4, 'required_fields');
    const el = document.getElementById(missing);
    if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
    alert('Please fill in all required fields marked with *');
    return;
  }
  const phone = bkValidateContactPhone();
  if (!phone.ok) {
    if (window.Cardetail1CheckoutAnalytics) Cardetail1CheckoutAnalytics.onValidationError(4, 'invalid_phone');
    alert(phone.message);
    return;
  }
  const sched = bkValidateScheduleSelection();
  if (!sched.ok) {
    if (window.Cardetail1CheckoutAnalytics) Cardetail1CheckoutAnalytics.onValidationError(4, 'invalid_schedule');
    bkShowScheduleMsg(sched.message);
    return;
  }
  bkShowScheduleMsg('');
  if (window.Cardetail1CheckoutAnalytics) Cardetail1CheckoutAnalytics.onStepCompleted(4);
  bkGoTo(5);
}

function goToPayment() { bkContinueFromContact(); }

function goToConfirmFromTerms() {
  if (!ST.payMethod) {
    alert('Please select a payment preference before continuing.');
    return;
  }
  if (!document.getElementById('cof-policy-ok')?.checked) {
    alert('Please accept the card-on-file policy before continuing.');
    return;
  }
  if (!ST.cardOnFileSaved) {
    alert('Please securely save a card with Stripe before continuing.');
    return;
  }
  if (window.Cardetail1CheckoutAnalytics) Cardetail1CheckoutAnalytics.onStepCompleted(5);
  bkGoTo(6);
}

function bkScrollToConfirm() { goToConfirmFromTerms(); }
function bkScrollToPayment() { bkGoTo(5); }
`;

html = html.replace(
  /\/\/ ── BOOKING NAVIGATION \(4 visible steps\) ─+[\s\S]*?function goToConfirmFromTerms\(\) \{ bkScrollToConfirm\(\); \}\n/,
  navBlock + '\n'
);

// selectCategory should advance to package step (2)
html = html.replace(
  /renderPackages\(cat\);\s*\n\s*renderTierChips\(cat\);\s*\n\s*bkGoTo\(1\);/,
  'renderPackages(cat);\n  renderTierChips(cat);\n  bkGoTo(2);'
);

// selectPkg: keep user on package until Continue, matching clear six-step UX
html = html.replace(
  /if\(ST\.pkg && currentBkStep < 2\) \{ \/\* stay on step 1 until Continue \*\/ \}/,
  'if(ST.pkg && currentBkStep < 3) { /* stay on package step until Continue */ }'
);

// addCurrentVehicleAndContinue → step 4 (Info)
html = html.replace(
  /if \(window\.Cardetail1CheckoutAnalytics\) Cardetail1CheckoutAnalytics\.onStepCompleted\(2\);\s*\n\s*bkGoTo\(3\);/,
  'if (window.Cardetail1CheckoutAnalytics) Cardetail1CheckoutAnalytics.onStepCompleted(3);\n  bkGoTo(4);'
);

// Ensure booking modal is not artificially compressed
if (!html.includes('/* six-step booking modal sizing */')) {
  html = html.replace(
    /\.booking-modal\{background:var\(--bg1\);border:1px solid var\(--bbr\);border-radius:var\(--rx\);width:100%;max-width:900px;/,
    `/* six-step booking modal sizing */\n.booking-modal{background:var(--bg1);border:1px solid var(--bbr);border-radius:var(--rx);width:100%;max-width:920px;min-height:min(78vh,720px);`
  );
}

// Canonical launcher alias
if (!html.includes('function launchBooking(')) {
  html = html.replace(
    /function openBooking\(cat\)\{/,
    `function launchBooking(opts){
  opts = opts || {};
  var cat = typeof opts === 'string' ? opts : (opts.category || opts.cat || null);
  return openBooking(cat);
}
window.launchBooking = launchBooking;
function openBooking(cat){`
  );
}

fs.writeFileSync(file, html);
console.log('Restored six-step booking navigation in index.html');
