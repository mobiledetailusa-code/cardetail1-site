/**
 * Booking conversion UX: utilities copy, flexible-date preference,
 * slot-unavailable recovery, confirm summary extras, funnel events.
 * Progressive enhancement — does not clear customer progress on recoverable errors.
 */
(function (root) {
  function track(name, props) {
    try {
      if (window.Cardetail1Revenue && typeof window.Cardetail1Revenue.track === 'function') {
        window.Cardetail1Revenue.track(name, props || {});
      } else if (window.CheckoutAnalytics && typeof window.CheckoutAnalytics.track === 'function') {
        window.CheckoutAnalytics.track(name, props || {});
      }
    } catch (_) { /* non-blocking */ }
  }

  function deviceType() {
    try {
      const w = window.innerWidth || 0;
      if (w && w < 768) return 'mobile';
      if (w && w < 1024) return 'tablet';
      return 'desktop';
    } catch (_) {
      return 'unknown';
    }
  }

  function ensureStyles() {
    if (document.getElementById('bk-conversion-styles')) return;
    const css = document.createElement('style');
    css.id = 'bk-conversion-styles';
    css.textContent = [
      '.bk-util-section{display:flex;flex-direction:column;gap:12px;margin:4px 0 8px}',
      '.bk-util-title{font-size:14px;font-weight:700;letter-spacing:.02em;color:var(--ink,#111)}',
      '.bk-util-help{font-size:12.5px;line-height:1.5;color:var(--mu,#666);margin:0}',
      '.bk-seg{display:flex;flex-direction:column;gap:8px}',
      '.bk-seg-label{font-size:12.5px;font-weight:600;color:var(--ink,#111)}',
      '.bk-seg-opts{display:flex;flex-direction:column;gap:6px}',
      '.bk-seg-opt{display:flex;align-items:flex-start;gap:8px;border:1px solid rgba(0,0,0,.12);border-radius:10px;padding:10px 12px;cursor:pointer;background:#fff}',
      '.bk-seg-opt:has(input:checked){border-color:rgba(0,0,0,.45);background:rgba(0,0,0,.03)}',
      '.bk-seg-opt input{margin-top:2px}',
      '.bk-flex-section{display:flex;flex-direction:column;gap:8px;margin:6px 0 4px}',
      '.bk-flex-title{font-size:14px;font-weight:700}',
      '.bk-flex-help{font-size:12.5px;line-height:1.5;color:var(--mu,#666);margin:0}',
      '.bk-weekend-label{font-size:12px;color:var(--mu,#666);margin-top:2px}',
      '.bk-recovery{display:none;border:1px solid rgba(180,100,0,.35);background:#fff8ef;border-radius:12px;padding:14px;margin:8px 0;flex-direction:column;gap:10px}',
      '.bk-recovery.open{display:flex}',
      '.bk-recovery h4{margin:0;font-size:15px}',
      '.bk-recovery p{margin:0;font-size:13px;line-height:1.5;color:#444}',
      '.bk-recovery-actions{display:flex;flex-wrap:wrap;gap:8px}',
      '.bk-recovery-actions button{font:inherit;font-size:13px;padding:10px 14px;border-radius:999px;border:1px solid rgba(0,0,0,.2);background:#fff;cursor:pointer}',
      '.bk-recovery-actions button.primary{background:#111;color:#fff;border-color:#111}',
      '.bk-nearby-list{display:flex;flex-direction:column;gap:6px}',
      '.bk-nearby-list button{text-align:left;padding:10px 12px;border-radius:10px;border:1px solid rgba(0,0,0,.12);background:#fff;cursor:pointer;font:inherit;font-size:13px}',
      '.bk-site-summary{font-size:13px;line-height:1.55;color:#333}',
    ].join('');
    document.head.appendChild(css);
  }

  function wireUtilityRadios() {
    const waterSel = document.getElementById('f-water');
    const electricSel = document.getElementById('f-electric');
    if (!waterSel || !electricSel) return;
    if (document.getElementById('bk-util-section')) return;

    const host = document.createElement('div');
    host.className = 'bk-util-section fg full';
    host.id = 'bk-util-section';
    host.innerHTML = [
      '<div class="bk-util-title">Help us arrive prepared</div>',
      '<p class="bk-util-help">This information helps us bring the correct mobile setup. You can continue even if one or both utilities are unavailable.</p>',
      '<div class="bk-seg" data-util="water">',
      '  <div class="bk-seg-label">Water access at the service location <span style="font-weight:500;color:#777">(optional)</span></div>',
      '  <div class="bk-seg-opts">',
      '    <label class="bk-seg-opt"><input type="radio" name="bk-water" value="yes"> <span>Available — outdoor faucet or hose connection</span></label>',
      '    <label class="bk-seg-opt"><input type="radio" name="bk-water" value="no"> <span>Not available</span></label>',
      '    <label class="bk-seg-opt"><input type="radio" name="bk-water" value="unsure"> <span>Not sure</span></label>',
      '  </div>',
      '</div>',
      '<div class="bk-seg" data-util="electric">',
      '  <div class="bk-seg-label">Electricity access at the service location <span style="font-weight:500;color:#777">(optional)</span></div>',
      '  <div class="bk-seg-opts">',
      '    <label class="bk-seg-opt"><input type="radio" name="bk-electric" value="yes"> <span>Available — standard outlet nearby</span></label>',
      '    <label class="bk-seg-opt"><input type="radio" name="bk-electric" value="no"> <span>Not available</span></label>',
      '    <label class="bk-seg-opt"><input type="radio" name="bk-electric" value="unsure"> <span>Not sure</span></label>',
      '  </div>',
      '</div>',
    ].join('');

    // Hide native selects but keep them as the authoritative form values.
    waterSel.closest('.fg')?.classList.add('bk-native-util');
    electricSel.closest('.fg')?.classList.add('bk-native-util');
    waterSel.closest('.fg') && (waterSel.closest('.fg').style.display = 'none');
    electricSel.closest('.fg') && (electricSel.closest('.fg').style.display = 'none');

    const insertBefore = waterSel.closest('.fg') || waterSel;
    insertBefore.parentNode.insertBefore(host, insertBefore);

    function syncFromSelect(sel, name) {
      const v = sel.value;
      host.querySelectorAll('input[name="' + name + '"]').forEach((inp) => {
        inp.checked = inp.value === v;
      });
    }
    function bind(name, sel) {
      host.querySelectorAll('input[name="' + name + '"]').forEach((inp) => {
        inp.addEventListener('change', () => {
          if (!inp.checked) return;
          sel.value = inp.value;
          track('utilities_completed', {
            funnel_step: 'info',
            device_type: deviceType(),
          });
        });
      });
      syncFromSelect(sel, name);
      sel.addEventListener('change', () => syncFromSelect(sel, name));
    }
    bind('bk-water', waterSel);
    bind('bk-electric', electricSel);
  }

  function wireFlexibility() {
    if (document.getElementById('bk-flex-section')) return;
    const timeFg = document.getElementById('f-time')?.closest('.fg');
    const scheduleMsg = document.getElementById('f-schedule-msg');
    const anchor = scheduleMsg || timeFg;
    if (!anchor || !anchor.parentNode) return;

    const wrap = document.createElement('div');
    wrap.className = 'bk-flex-section fg full';
    wrap.id = 'bk-flex-section';
    wrap.innerHTML = [
      '<div class="bk-flex-title">Get the best available appointment</div>',
      '<div class="fl">Are you flexible if your preferred date fills up? <span style="font-weight:500;color:#777">(optional)</span></div>',
      '<div class="bk-seg-opts">',
      '  <label class="bk-seg-opt"><input type="radio" name="bk-flex" value="exact"> <span>Exact date only</span></label>',
      '  <label class="bk-seg-opt"><input type="radio" name="bk-flex" value="within_3_days"> <span>Flexible within 3 days — Recommended</span></label>',
      '  <label class="bk-seg-opt"><input type="radio" name="bk-flex" value="earliest_after_date"> <span>First available on or after my selected date</span></label>',
      '</div>',
      '<p class="bk-flex-help">You stay in control. We’ll confirm any alternative date with you before scheduling.</p>',
      '<input type="hidden" id="f-flexibility" value="">',
    ].join('');
    anchor.parentNode.insertBefore(wrap, anchor.nextSibling);

    const hidden = document.getElementById('f-flexibility');
    wrap.querySelectorAll('input[name="bk-flex"]').forEach((inp) => {
      inp.addEventListener('change', () => {
        if (!inp.checked) return;
        hidden.value = inp.value;
        track('flexibility_selected', {
          flexibility_mode: inp.value,
          funnel_step: 'info',
          device_type: deviceType(),
        });
      });
    });
  }

  function wireWeekendLabel() {
    const dateEl = document.getElementById('f-date');
    if (!dateEl || document.getElementById('bk-weekend-label')) return;
    const label = document.createElement('div');
    label.id = 'bk-weekend-label';
    label.className = 'bk-weekend-label';
    label.hidden = true;
    dateEl.closest('.fg')?.appendChild(label);

    function refresh() {
      const iso = dateEl.value;
      if (!iso || !window.BkAvailability) {
        label.hidden = true;
        return;
      }
      const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
      if (!p) { label.hidden = true; return; }
      const day = new Date(+p[1], +p[2] - 1, +p[3]).getDay();
      const isWeekend = day === 0 || day === 6;
      const text = window.BkAvailability.customerWeekendLabel();
      if (isWeekend && text) {
        label.textContent = text;
        label.hidden = false;
        track('weekend_date_selected', {
          weekend_selected: 'yes',
          funnel_step: 'info',
          device_type: deviceType(),
        });
      } else {
        label.hidden = true;
      }
    }
    dateEl.addEventListener('change', () => {
      track('date_selected', {
        funnel_step: 'info',
        weekend_selected: (() => {
          const iso = dateEl.value;
          const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
          if (!m) return 'no';
          const day = new Date(+m[1], +m[2] - 1, +m[3]).getDay();
          return (day === 0 || day === 6) ? 'yes' : 'no';
        })(),
        device_type: deviceType(),
      });
      refresh();
    });
  }

  function ensureRecoveryPanel() {
    if (document.getElementById('bk-slot-recovery')) return document.getElementById('bk-slot-recovery');
    const panel = document.createElement('div');
    panel.id = 'bk-slot-recovery';
    panel.className = 'bk-recovery';
    panel.setAttribute('role', 'status');
    panel.innerHTML = [
      '<h4>That time is no longer available, but you don’t need to start over.</h4>',
      '<p>Your vehicle, services, address, and add-ons will remain selected.</p>',
      '<div class="bk-recovery-actions">',
      '  <button type="button" class="primary" data-act="nearby">See nearby appointments</button>',
      '  <button type="button" data-act="earliest">Find the earliest opening</button>',
      '  <button type="button" data-act="keep">Keep my request active</button>',
      '</div>',
      '<div class="bk-nearby-list" id="bk-nearby-list" hidden></div>',
    ].join('');
    const scheduleMsg = document.getElementById('f-schedule-msg');
    const parent = scheduleMsg?.parentNode || document.getElementById('bs4');
    if (parent) parent.insertBefore(panel, scheduleMsg ? scheduleMsg.nextSibling : parent.firstChild);

    panel.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'keep') {
        panel.classList.remove('open');
        return;
      }
      track(act === 'nearby' ? 'nearby_slots_opened' : 'nearby_slots_opened', {
        funnel_step: 'recovery',
        device_type: deviceType(),
      });
      const from = document.getElementById('f-date')?.value || '';
      const data = window.BkAvailability
        ? await window.BkAvailability.nearby(from, act === 'earliest' ? 3 : 6)
        : { openings: [] };
      const list = document.getElementById('bk-nearby-list');
      const openings = (data && data.openings) || [];
      if (!list) return;
      if (!openings.length) {
        list.hidden = false;
        list.innerHTML = '<p class="bk-flex-help">No nearby openings found in the next few weeks. Call or text 551-313-2956 and we will help.</p>';
        return;
      }
      list.hidden = false;
      list.innerHTML = openings.map((o) => (
        '<button type="button" data-date="' + o.preferredDate + '" data-time="' + o.preferredTime + '">' +
        o.preferredDate + ' · ' + o.preferredTime +
        (o.isWeekend ? ' · weekend' : '') +
        '</button>'
      )).join('');
      list.querySelectorAll('button[data-date]').forEach((b) => {
        b.addEventListener('click', () => {
          const dateEl = document.getElementById('f-date');
          const timeEl = document.getElementById('f-time');
          if (dateEl) {
            dateEl.value = b.getAttribute('data-date');
            dateEl.dispatchEvent(new Event('change', { bubbles: true }));
          }
          // Allow slot refresh then set time
          setTimeout(() => {
            if (timeEl) {
              timeEl.value = b.getAttribute('data-time');
              timeEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
            panel.classList.remove('open');
            list.hidden = true;
            if (typeof window.bkShowScheduleMsg === 'function') {
              window.bkShowScheduleMsg('');
            }
          }, 50);
        });
      });
    });
    return panel;
  }

  function openRecovery(errorCode) {
    track('selected_slot_unavailable', {
      error_code: errorCode || 'booking_slot_unavailable',
      funnel_step: 'recovery',
      device_type: deviceType(),
    });
    const panel = ensureRecoveryPanel();
    if (panel) panel.classList.add('open');
    // Navigate back to schedule step without wiping progress
    try {
      if (typeof window.bkGoTo === 'function') window.bkGoTo(4);
    } catch (_) { /* */ }
  }

  function patchScheduleFns() {
    if (typeof window.bkSlotsFor !== 'function') return;
    const original = window.bkSlotsFor;
    window.bkSlotsFor = function (iso) {
      if (window.BkAvailability && window.BkAvailability.loaded) {
        // Still respect holidays via original path when possible
        const fromAvail = window.BkAvailability.slotsForDate(iso);
        // If availability says closed, trust it; if open, still filter holidays via original empty check
        try {
          if (typeof window.bkHolidays === 'function') {
            const p = String(iso || '');
            const year = +p.slice(0, 4);
            if (year && window.bkHolidays(year).has(p)) return [];
          }
        } catch (_) { /* */ }
        return fromAvail;
      }
      return original(iso);
    };

    if (typeof window.bkEarliestBookable === 'function' && window.BkAvailability) {
      const origEarliest = window.bkEarliestBookable;
      window.bkEarliestBookable = function () {
        if (window.BkAvailability.loaded) return window.BkAvailability.earliestBookable();
        return origEarliest();
      };
    }
  }

  function patchPayloadAndConfirm() {
    const origRead = window.readSiteAccessFields;
    if (typeof origRead === 'function') {
      // keep as-is; values still yes/no/unsure
    }

    const origBuild = window.buildBookingPayload;
    if (typeof origBuild === 'function') {
      window.buildBookingPayload = function () {
        const payload = origBuild.apply(this, arguments);
        const flex = document.getElementById('f-flexibility')?.value || '';
        payload.scheduleFlexibility = flex || 'exact';
        return payload;
      };
    }

    const origFill = window.fillConfirm;
    if (typeof origFill === 'function') {
      window.fillConfirm = function () {
        origFill.apply(this, arguments);
        track('booking_review_reached', {
          funnel_step: 'confirm',
          device_type: deviceType(),
          flexibility_mode: document.getElementById('f-flexibility')?.value || 'exact',
        });
        let box = document.getElementById('c-site-access');
        if (!box) {
          const dateEl = document.getElementById('c-date');
          const host = dateEl?.closest('.bk-confirm-block, .confirm-block, .c-block') || dateEl?.parentNode;
          box = document.createElement('div');
          box.id = 'c-site-access';
          box.className = 'bk-site-summary';
          if (host) host.appendChild(box);
        }
        const water = document.getElementById('f-water')?.value || '';
        const electric = document.getElementById('f-electric')?.value || '';
        const flex = document.getElementById('f-flexibility')?.value || '';
        const waterLabel = { yes: 'Available — outdoor faucet or hose connection', no: 'Not available', unsure: 'Not sure' };
        const electricLabel = { yes: 'Available — standard outlet nearby', no: 'Not available', unsure: 'Not sure' };
        const flexLabel = {
          exact: 'Exact date only',
          within_3_days: 'Flexible within 3 days',
          earliest_after_date: 'First available on or after selected date',
        };
        const lines = [];
        if (water) lines.push('Water: ' + (waterLabel[water] || water));
        if (electric) lines.push('Electricity: ' + (electricLabel[electric] || electric));
        if (flex) lines.push('Date flexibility: ' + (flexLabel[flex] || flex));
        box.textContent = lines.join(' · ');
        box.hidden = !lines.length;
      };
    }

    const origShowSuccess = window.showSuccess;
    if (typeof origShowSuccess === 'function') {
      window.showSuccess = function () {
        track('booking_submit_succeeded', {
          funnel_step: 'success',
          device_type: deviceType(),
          flexibility_mode: document.getElementById('f-flexibility')?.value || 'exact',
        });
        return origShowSuccess.apply(this, arguments);
      };
    }

    const origSubmit = window.submitBooking;
    if (typeof origSubmit === 'function') {
      window.submitBooking = async function () {
        track('booking_submit_attempted', {
          funnel_step: 'submit',
          device_type: deviceType(),
          flexibility_mode: document.getElementById('f-flexibility')?.value || 'exact',
        });
        try {
          const result = await origSubmit.apply(this, arguments);
          return result;
        } catch (err) {
          track('booking_submit_failed', {
            funnel_step: 'submit',
            error_code: 'client_exception',
            device_type: deviceType(),
          });
          throw err;
        }
      };
    }
  }

  function patchSlotErrorAlerts() {
    // Intercept window.alert for known slot messages as a safety net; primary path patches fetch responses via submitBooking body.
    const origAlert = window.alert;
    window.alert = function (msg) {
      const text = String(msg || '');
      if (/no longer available|time slot is already reserved|That time is unavailable|date is unavailable|time is unavailable/i.test(text)) {
        openRecovery('booking_slot_unavailable');
        return;
      }
      return origAlert.apply(this, arguments);
    };
  }

  function patchSetupIntentTracking() {
    const orig = window.confirmSetupIntent || window.initCardOnFile;
    // Hook create-setup-intent fetch via monkeypatch is fragile; emit on stripe auth button click.
    document.addEventListener('click', (ev) => {
      const t = ev.target.closest('#stripe-auth-btn, #cof-save-btn, [data-setup-intent]');
      if (t) {
        track('setup_intent_started', {
          funnel_step: 'secure',
          device_type: deviceType(),
        });
      }
    }, true);
  }

  function patchCtaCopy() {
    const btn = document.querySelector('#bs4 .btn-n, #bs4 button.btn-n');
    if (btn && /Review Terms/i.test(btn.textContent || '')) {
      // Keep existing primary CTA destination; add clarifying secondary label nearby if missing
      btn.setAttribute('data-bk-cta', 'continue-appointment');
    }
  }

  async function init() {
    ensureStyles();
    wireUtilityRadios();
    wireFlexibility();
    wireWeekendLabel();
    ensureRecoveryPanel();
    patchScheduleFns();
    patchPayloadAndConfirm();
    patchSlotErrorAlerts();
    patchSetupIntentTracking();
    patchCtaCopy();

    if (window.BkAvailability) {
      await window.BkAvailability.load();
      patchScheduleFns();
      try {
        const dateEl = document.getElementById('f-date');
        if (dateEl && typeof window.bkEarliestBookable === 'function') {
          dateEl.min = window.bkEarliestBookable();
        }
      } catch (_) { /* */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  root.BkConversion = { openRecovery, track, init };
})(typeof window !== 'undefined' ? window : globalThis);
