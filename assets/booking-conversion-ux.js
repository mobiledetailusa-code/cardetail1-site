/**
 * Booking conversion UX — compact details step, arrival preference selector,
 * alternate-date preference, slot-unavailable recovery, funnel events.
 * Progressive enhancement — does not clear customer progress on recoverable errors.
 *
 * Customer preferredArrivalWindow != internal preferredTime (operational slot)
 * != confirmedTimeWindow.
 */
(function (root) {
  const ARRIVAL_WINDOWS = [
    '08:00-11:00', '09:00-12:00', '10:00-13:00', '11:00-14:00', '12:00-15:00',
    '13:00-16:00', '14:00-17:00', '15:00-18:00', '16:00-19:00', 'anytime',
  ];

  const SPECIFIC_WINDOWS = ARRIVAL_WINDOWS.filter((w) => w !== 'anytime');

  const WINDOW_BOUNDS = {
    '08:00-11:00': [480, 660],
    '09:00-12:00': [540, 720],
    '10:00-13:00': [600, 780],
    '11:00-14:00': [660, 840],
    '12:00-15:00': [720, 900],
    '13:00-16:00': [780, 960],
    '14:00-17:00': [840, 1020],
    '15:00-18:00': [900, 1080],
    '16:00-19:00': [960, 1140],
  };

  const SLOT_MINUTES = {
    '8:00 AM': 480,
    '10:00 AM': 600,
    '12:00 PM': 720,
    '2:00 PM': 840,
    '4:00 PM': 960,
  };

  const SLOT_TO_WINDOW = {
    '8:00 AM': '08:00-11:00',
    '10:00 AM': '10:00-13:00',
    '12:00 PM': '12:00-15:00',
    '2:00 PM': '14:00-17:00',
    '4:00 PM': '16:00-19:00',
  };

  const ARRIVAL_LABELS = {
    '08:00-11:00': '8:00 AM – 11:00 AM',
    '09:00-12:00': '9:00 AM – 12:00 PM',
    '10:00-13:00': '10:00 AM – 1:00 PM',
    '11:00-14:00': '11:00 AM – 2:00 PM',
    '12:00-15:00': '12:00 PM – 3:00 PM',
    '13:00-16:00': '1:00 PM – 4:00 PM',
    '14:00-17:00': '2:00 PM – 5:00 PM',
    '15:00-18:00': '3:00 PM – 6:00 PM',
    '16:00-19:00': '4:00 PM – 7:00 PM',
    anytime: 'Any time that day',
  };

  const COMPAT_MSG = 'That arrival window isn’t available on the new date. Please choose another.';
  const CLOSED_MSG = 'No arrival windows are available on this date. Please choose another date.';

  function isKnownWindow(v) {
    return ARRIVAL_WINDOWS.includes(v);
  }

  function eligibleSlotsForWindow(windowVal, allowed) {
    const slots = Array.isArray(allowed) ? allowed : [];
    if (windowVal === 'anytime') return slots.slice();
    const bounds = WINDOW_BOUNDS[windowVal];
    if (!bounds) return [];
    return slots.filter((s) => {
      const m = SLOT_MINUTES[s];
      return m != null && m >= bounds[0] && m <= bounds[1];
    });
  }

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
    const cssText = [
      '.bk-details-compact{gap:10px 14px}',
      '.bk-details-compact .fg{margin:0}',
      '.bk-details-compact .fl{margin-bottom:4px;font-size:12.5px}',
      '.bk-details-compact .fi,.bk-details-compact .fsel,.bk-details-compact .fta{min-height:44px}',
      '.bk-details-compact .fta{min-height:72px;resize:vertical}',
      '.bk-field-help{margin:4px 0 0;font-size:12px;line-height:1.45;color:var(--mu,#666)}',
      '.bk-alt-section{display:flex;flex-direction:column;gap:8px;padding-top:2px}',
      '.bk-alt-check{display:flex;align-items:center;gap:10px;font-size:13.5px;font-weight:600;cursor:pointer;min-height:44px}',
      '.bk-alt-check input{width:18px;height:18px;flex:0 0 auto}',
      '.bk-alt-fields{display:flex;flex-direction:column;gap:8px}',
      '.bk-alt-fields[hidden]{display:none!important}',
      '.bk-alt-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px}',
      '.bk-arrival-pref{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.bk-arrival-choices{display:grid;grid-template-columns:1fr 1fr;gap:8px;min-width:0}',
      '.bk-arrival-choice{display:flex;align-items:flex-start;gap:10px;min-height:44px;padding:10px 12px;border:1px solid rgba(0,0,0,.14);border-radius:10px;cursor:pointer;min-width:0;box-sizing:border-box;background:#fff}',
      '.bk-arrival-choice:focus-within{outline:2px solid #111;outline-offset:2px}',
      '.bk-arrival-choice input{width:18px;height:18px;margin-top:2px;flex:0 0 auto}',
      '.bk-arrival-choice-inner{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.bk-arrival-choice-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
      '.bk-arrival-choice-label{font-size:13.5px;font-weight:600;line-height:1.3}',
      '.bk-arrival-choice-sub{font-size:12px;line-height:1.4;color:var(--mu,#666)}',
      '.bk-arrival-badge{font-size:10.5px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;padding:2px 6px;border-radius:4px;background:#f0f0f0;color:#333;border:1px solid rgba(0,0,0,.1)}',
      '.bk-arrival-specific{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.bk-arrival-specific[hidden]{display:none!important}',
      '@media (max-width:720px){.bk-arrival-choices{grid-template-columns:1fr}.bk-alt-grid{grid-template-columns:1fr}.bk-details-compact{overflow-x:hidden}}',
      '.bk-weekend-label{font-size:12px;color:var(--mu,#666);margin-top:2px}',
      '.bk-recovery{display:none;border:1px solid rgba(180,100,0,.35);background:#fff8ef;border-radius:12px;padding:14px;margin:8px 0;flex-direction:column;gap:10px}',
      '.bk-recovery.open{display:flex}',
      '.bk-recovery h4{margin:0;font-size:15px}',
      '.bk-recovery p{margin:0;font-size:13px;line-height:1.5;color:#444}',
      '.bk-recovery-actions{display:flex;flex-wrap:wrap;gap:8px}',
      '.bk-recovery-actions button{font:inherit;font-size:13px;padding:10px 14px;border-radius:999px;border:1px solid rgba(0,0,0,.2);background:#fff;cursor:pointer;min-height:44px}',
      '.bk-recovery-actions button.primary{background:#111;color:#fff;border-color:#111}',
      '.bk-nearby-list{display:flex;flex-direction:column;gap:6px}',
      '.bk-nearby-list button{text-align:left;padding:10px 12px;border-radius:10px;border:1px solid rgba(0,0,0,.12);background:#fff;cursor:pointer;font:inherit;font-size:13px;min-height:44px}',
      '.bk-site-summary{font-size:13px;line-height:1.55;color:#333}',
      '.bk-rush-note{font-size:12.5px;line-height:1.45;color:var(--mu,#666);margin:0}',
    ].join('');
    let css = document.getElementById('bk-conversion-styles');
    if (!css) {
      css = document.createElement('style');
      css.id = 'bk-conversion-styles';
      document.head.appendChild(css);
    }
    css.textContent = cssText;
  }

  function resolveOperational(iso, windowVal) {
    const slotsFn = typeof window.bkSlotsFor === 'function' ? window.bkSlotsFor : null;
    const allowed = slotsFn ? slotsFn(iso) : [];
    if (!allowed.length) return { ok: false };
    const eligible = eligibleSlotsForWindow(windowVal, allowed);
    if (!eligible.length) return { ok: false };
    return { ok: true, preferredTime: eligible[0], eligible };
  }

  function slotsForIso(iso) {
    const slotsFn = typeof window.bkSlotsFor === 'function' ? window.bkSlotsFor : null;
    return iso && slotsFn ? (slotsFn(iso) || []) : [];
  }

  /**
   * Shared arrival-preference controller for primary + alternate.
   * Mode radios + optional specific select write to a hidden canonical field.
   */
  function createArrivalPreferenceController(cfg) {
    const rootEl = document.querySelector(cfg.rootSelector);
    if (!rootEl || rootEl.dataset.bkArrivalWired) return null;
    rootEl.dataset.bkArrivalWired = '1';

    const anytimeRadio = document.getElementById(cfg.anytimeId);
    const specificRadio = document.getElementById(cfg.specificId);
    const selectEl = document.getElementById(cfg.selectId);
    const hiddenEl = document.getElementById(cfg.hiddenId);
    const specificWrap = document.getElementById(cfg.specificWrapId);
    const anytimeHelp = document.getElementById(cfg.anytimeHelpId);
    const specificHelp = document.getElementById(cfg.specificHelpId);
    const compatMsg = document.getElementById(cfg.compatMsgId);
    const closedMsg = document.getElementById(cfg.closedMsgId);
    const errorEl = document.getElementById(cfg.errorId);
    const dateEl = document.getElementById(cfg.dateId);

    if (!anytimeRadio || !specificRadio || !selectEl || !hiddenEl) return null;

    function mode() {
      if (anytimeRadio.checked) return 'anytime';
      if (specificRadio.checked) return 'specific';
      return '';
    }

    function setHidden(val, emit) {
      const next = val || '';
      if (hiddenEl.value === next && !emit) return;
      hiddenEl.value = next;
      if (emit) {
        hiddenEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    function setMsg(el, show, text) {
      if (!el) return;
      if (text) el.textContent = text;
      el.hidden = !show;
    }

    function clearError() {
      setMsg(errorEl, false, '');
      if (errorEl) errorEl.textContent = '';
    }

    function showError(message) {
      setMsg(errorEl, !!message, message || '');
    }

    function updateDisclosure() {
      const m = mode();
      const isAnytime = m === 'anytime';
      const isSpecific = m === 'specific';
      if (specificWrap) specificWrap.hidden = !isSpecific;
      setMsg(anytimeHelp, isAnytime);
      if (specificHelp) specificHelp.hidden = !(isSpecific && !!selectEl.value);
      if (!isSpecific) {
        setMsg(compatMsg, false);
        setMsg(closedMsg, false);
      }
    }

    function refreshSelectOptions(opts) {
      const options = opts || {};
      const iso = dateEl?.value || '';
      const allowed = slotsForIso(iso);
      const closed = !iso || !allowed.length;
      const prevSpecific = selectEl.value;
      let keep = '';

      [...selectEl.options].forEach((opt) => {
        if (!opt.value) return;
        if (!SPECIFIC_WINDOWS.includes(opt.value)) {
          opt.disabled = true;
          opt.hidden = true;
          return;
        }
        const ok = !closed && eligibleSlotsForWindow(opt.value, allowed).length > 0;
        opt.disabled = !ok;
        opt.hidden = !ok;
        if (ok && opt.value === prevSpecific) keep = prevSpecific;
      });

      selectEl.disabled = closed || mode() !== 'specific';

      if (closed) {
        if (prevSpecific) selectEl.value = '';
        setMsg(compatMsg, false);
        setMsg(closedMsg, mode() === 'specific', CLOSED_MSG);
        if (mode() === 'specific') setHidden('', !!options.emit);
        else if (mode() === 'anytime') setHidden('', !!options.emit);
        updateDisclosure();
        return { closed: true, cleared: !!prevSpecific, preserved: false };
      }

      setMsg(closedMsg, false);

      if (mode() === 'specific') {
        if (prevSpecific && !keep) {
          selectEl.value = '';
          setHidden('', !!options.emit);
          setMsg(compatMsg, true, COMPAT_MSG);
          updateDisclosure();
          return { closed: false, cleared: true, preserved: false };
        }
        if (keep) {
          selectEl.value = keep;
          setHidden(keep, !!options.emit);
          if (!options.keepCompatVisible) setMsg(compatMsg, false);
          updateDisclosure();
          return { closed: false, cleared: false, preserved: true };
        }
        setHidden(selectEl.value || '', !!options.emit);
        updateDisclosure();
        return { closed: false, cleared: false, preserved: false };
      }

      if (mode() === 'anytime') {
        const anytimeOk = eligibleSlotsForWindow('anytime', allowed).length > 0;
        setHidden(anytimeOk ? 'anytime' : '', !!options.emit);
        setMsg(compatMsg, false);
      }

      updateDisclosure();
      return { closed: false, cleared: false, preserved: false };
    }

    function applyMode(nextMode, opts) {
      const options = opts || {};
      if (nextMode === 'anytime') {
        anytimeRadio.checked = true;
        specificRadio.checked = false;
        selectEl.value = '';
        setHidden('anytime', options.emit !== false);
        setMsg(compatMsg, false);
        setMsg(closedMsg, false);
        clearError();
      } else if (nextMode === 'specific') {
        anytimeRadio.checked = false;
        specificRadio.checked = true;
        if (!options.preserveSelect) {
          selectEl.value = '';
          setHidden('', options.emit !== false);
        } else {
          setHidden(selectEl.value || '', options.emit !== false);
        }
        clearError();
        refreshSelectOptions({ emit: false });
      } else {
        anytimeRadio.checked = false;
        specificRadio.checked = false;
        selectEl.value = '';
        setHidden('', options.emit !== false);
        setMsg(compatMsg, false);
        setMsg(closedMsg, false);
      }
      updateDisclosure();
      if (typeof cfg.onChange === 'function') cfg.onChange();
    }

    function setValue(windowVal, opts) {
      const options = opts || {};
      if (!windowVal) {
        applyMode('', options);
        return;
      }
      if (windowVal === 'anytime') {
        applyMode('anytime', options);
        refreshSelectOptions({ emit: false });
        return;
      }
      if (!isKnownWindow(windowVal) || windowVal === 'anytime') return;
      anytimeRadio.checked = false;
      specificRadio.checked = true;
      refreshSelectOptions({ emit: false });
      const allowed = slotsForIso(dateEl?.value || '');
      if (eligibleSlotsForWindow(windowVal, allowed).length) {
        selectEl.value = windowVal;
        setHidden(windowVal, options.emit !== false);
        setMsg(compatMsg, false);
      } else {
        selectEl.value = '';
        setHidden('', options.emit !== false);
        setMsg(compatMsg, true, COMPAT_MSG);
      }
      updateDisclosure();
      if (typeof cfg.onChange === 'function') cfg.onChange();
    }

    function clear() {
      applyMode('', { emit: false });
      clearError();
      setMsg(compatMsg, false);
      setMsg(closedMsg, false);
    }

    anytimeRadio.addEventListener('change', () => {
      if (!anytimeRadio.checked) return;
      applyMode('anytime');
      track('arrival_window_selected', {
        funnel_step: 'info',
        device_type: deviceType(),
      });
    });

    specificRadio.addEventListener('change', () => {
      if (!specificRadio.checked) return;
      applyMode('specific');
      track('arrival_window_selected', {
        funnel_step: 'info',
        device_type: deviceType(),
      });
    });

    selectEl.addEventListener('change', () => {
      const val = selectEl.value || '';
      setHidden(val, true);
      setMsg(compatMsg, false);
      clearError();
      updateDisclosure();
      if (typeof cfg.onChange === 'function') cfg.onChange();
      if (val) {
        track('arrival_window_selected', {
          funnel_step: 'info',
          device_type: deviceType(),
        });
      }
    });

    // Initial: nothing selected
    anytimeRadio.checked = false;
    specificRadio.checked = false;
    selectEl.value = '';
    hiddenEl.value = '';
    updateDisclosure();

    return {
      mode,
      refresh: refreshSelectOptions,
      setValue,
      clear,
      showError,
      clearError,
      getValue: () => hiddenEl.value || '',
      root: rootEl,
    };
  }

  let primaryArrival = null;
  let altArrival = null;

  function syncOperationalSlot() {
    const dateEl = document.getElementById('f-date');
    const timeEl = document.getElementById('f-time');
    const winEl = document.getElementById('f-arrival-window');
    if (!dateEl || !timeEl) return;
    const iso = dateEl.value;
    const win = winEl?.value || '';
    if (!iso || !win) {
      timeEl.value = '';
      return;
    }
    const r = resolveOperational(iso, win);
    if (!r.ok) {
      timeEl.value = '';
      return;
    }
    if (timeEl.tagName === 'SELECT') {
      let opt = [...timeEl.options].find((o) => o.value === r.preferredTime);
      if (!opt) {
        opt = document.createElement('option');
        opt.value = r.preferredTime;
        opt.textContent = r.preferredTime;
        opt.dataset.slot = '1';
        timeEl.appendChild(opt);
      }
      timeEl.value = r.preferredTime;
    } else {
      timeEl.value = r.preferredTime;
    }
  }

  function refreshArrivalWindowsForDates(opts) {
    const options = opts || {};
    if (primaryArrival) primaryArrival.refresh({ emit: !!options.emit, keepCompatVisible: false });
    if (altArrival) altArrival.refresh({ emit: false, keepCompatVisible: false });
    syncOperationalSlot();
  }

  function wireArrivalPreferences() {
    if (!primaryArrival) {
      primaryArrival = createArrivalPreferenceController({
        rootSelector: '[data-arrival-pref="primary"]',
        anytimeId: 'f-arrival-mode-anytime',
        specificId: 'f-arrival-mode-specific',
        selectId: 'f-arrival-window-select',
        hiddenId: 'f-arrival-window',
        specificWrapId: 'bk-arrival-specific',
        anytimeHelpId: 'f-arrival-anytime-help',
        specificHelpId: 'f-arrival-specific-help',
        compatMsgId: 'f-arrival-compat-msg',
        closedMsgId: 'f-arrival-closed-msg',
        errorId: 'f-arrival-error',
        dateId: 'f-date',
        onChange: () => {
          if (typeof window.bkShowScheduleMsg === 'function') window.bkShowScheduleMsg('');
          syncOperationalSlot();
        },
      });
    }

    if (!altArrival) {
      altArrival = createArrivalPreferenceController({
        rootSelector: '[data-arrival-pref="alt"]',
        anytimeId: 'f-alt-arrival-mode-anytime',
        specificId: 'f-alt-arrival-mode-specific',
        selectId: 'f-alt-arrival-window-select',
        hiddenId: 'f-alt-arrival-window',
        specificWrapId: 'bk-alt-arrival-specific',
        anytimeHelpId: 'f-alt-arrival-anytime-help',
        specificHelpId: 'f-alt-arrival-specific-help',
        compatMsgId: 'f-alt-arrival-compat-msg',
        closedMsgId: 'f-alt-arrival-closed-msg',
        errorId: 'f-alt-arrival-error',
        dateId: 'f-alt-date',
        onChange: () => {},
      });
    }
  }

  function setPrimaryArrivalWindow(windowVal) {
    if (primaryArrival) primaryArrival.setValue(windowVal);
  }

  function wireAlternateDate() {
    const check = document.getElementById('f-has-alternate');
    const fields = document.getElementById('bk-alt-fields');
    const flex = document.getElementById('f-flexibility');
    const altDate = document.getElementById('f-alt-date');
    if (!check || !fields || check.dataset.bkWired) return;
    check.dataset.bkWired = '1';

    function setFlex() {
      if (flex) flex.value = check.checked ? 'alternate_date' : 'exact';
    }

    function clearAlt() {
      if (altDate) altDate.value = '';
      if (altArrival) altArrival.clear();
      else {
        const altWin = document.getElementById('f-alt-arrival-window');
        if (altWin) altWin.value = '';
      }
    }

    check.addEventListener('change', () => {
      if (check.checked) {
        fields.hidden = false;
        setFlex();
        if (altArrival) altArrival.refresh({ emit: false });
        track('flexibility_selected', {
          flexibility_mode: 'alternate_date',
          funnel_step: 'info',
          device_type: deviceType(),
        });
        return;
      }
      const altWinVal = document.getElementById('f-alt-arrival-window')?.value || '';
      const hadValues = !!(altDate?.value || altWinVal);
      if (hadValues) {
        const ok = window.confirm('Remove your alternate date and arrival window?');
        if (!ok) {
          check.checked = true;
          return;
        }
      }
      fields.hidden = true;
      clearAlt();
      setFlex();
      track('flexibility_selected', {
        flexibility_mode: 'exact',
        funnel_step: 'info',
        device_type: deviceType(),
      });
    });

    if (typeof window.bkEarliestBookable === 'function' && altDate) {
      altDate.min = window.bkEarliestBookable();
    }
    if (altDate && !altDate.dataset.bkAltWinRefresh) {
      altDate.dataset.bkAltWinRefresh = '1';
      altDate.addEventListener('change', () => {
        if (altArrival) altArrival.refresh({ emit: false });
      });
    }
    setFlex();
  }

  function wireUtilitiesTrack() {
    ['f-water', 'f-electric'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el || el.dataset.bkUtilTrack) return;
      el.dataset.bkUtilTrack = '1';
      el.addEventListener('change', () => {
        track('utilities_completed', { funnel_step: 'info', device_type: deviceType() });
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
      refreshArrivalWindowsForDates();
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
      '<p>Your vehicle, services, address, notes, and preferences will remain selected.</p>',
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
      track('nearby_slots_opened', {
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
        list.innerHTML = '<p class="bk-field-help">No nearby openings found in the next few weeks. Call or text 551-373-5668 and we will help.</p>';
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
          const slot = b.getAttribute('data-time') || '';
          if (dateEl) {
            dateEl.value = b.getAttribute('data-date');
            dateEl.dispatchEvent(new Event('change', { bubbles: true }));
          }
          setTimeout(() => {
            setPrimaryArrivalWindow(SLOT_TO_WINDOW[slot] || 'anytime');
            if (timeEl) timeEl.value = slot;
            syncOperationalSlot();
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
    try {
      if (typeof window.bkGoTo === 'function') window.bkGoTo(4);
    } catch (_) { /* */ }
  }

  function customerArrivalSummary(win) {
    if (!win) return '';
    if (win === 'anytime') return { label: 'Arrival preference', value: 'Any time that day' };
    return { label: 'Preferred arrival window', value: ARRIVAL_LABELS[win] || win };
  }

  function patchScheduleFns() {
    if (typeof window.bkSlotsFor === 'function') {
      const original = window.bkSlotsFor;
      window.bkSlotsFor = function (iso) {
        if (window.BkAvailability && window.BkAvailability.loaded) {
          const fromAvail = window.BkAvailability.slotsForDate(iso);
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
    }

    if (typeof window.bkEarliestBookable === 'function' && window.BkAvailability) {
      const origEarliest = window.bkEarliestBookable;
      window.bkEarliestBookable = function () {
        if (window.BkAvailability.loaded) return window.BkAvailability.earliestBookable();
        return origEarliest();
      };
    }

    window.bkSyncOperationalSlot = syncOperationalSlot;

    window.bkRefreshTimeSlots = function () {
      const dateEl = document.getElementById('f-date');
      const timeEl = document.getElementById('f-time');
      if (!dateEl || !timeEl) return;
      const iso = dateEl.value;
      if (typeof window.bkShowScheduleMsg === 'function') window.bkShowScheduleMsg('');
      if (timeEl.tagName === 'SELECT') {
        timeEl.querySelectorAll('option[data-slot]').forEach((o) => o.remove());
      }
      if (!iso) { timeEl.value = ''; return; }
      const p = typeof window.bkIsoParts === 'function' ? window.bkIsoParts(iso) : null;
      if (!p) return;
      if (p.day === 0) {
        if (typeof window.bkShowScheduleMsg === 'function') window.bkShowScheduleMsg('Unavailable — please choose another date.');
        timeEl.value = '';
        return;
      }
      if (typeof window.bkHolidays === 'function' && window.bkHolidays(+p.iso.slice(0, 4)).has(p.iso)) {
        if (typeof window.bkShowScheduleMsg === 'function') window.bkShowScheduleMsg('Closed for the holiday. Please choose another date.');
        timeEl.value = '';
        return;
      }
      const minIso = typeof window.bkEarliestBookable === 'function' ? window.bkEarliestBookable() : '';
      if (minIso && p.iso < minIso) {
        if (typeof window.bkShowScheduleMsg === 'function') {
          window.bkShowScheduleMsg('Due to route planning, please choose a date at least 3 days out. Need sooner? Call or text us.');
        }
        timeEl.value = '';
        return;
      }
      if (timeEl.tagName === 'SELECT' && typeof window.bkSlotsFor === 'function') {
        for (const slot of window.bkSlotsFor(iso)) {
          const opt = document.createElement('option');
          opt.value = slot;
          opt.textContent = slot;
          opt.dataset.slot = '1';
          timeEl.appendChild(opt);
        }
      }
      syncOperationalSlot();
      refreshArrivalWindowsForDates();
    };

    if (document.getElementById('f-arrival-window')) {
      window.bkValidateScheduleSelection = function () {
        const iso = document.getElementById('f-date')?.value || '';
        const win = document.getElementById('f-arrival-window')?.value || '';
        if (!iso) return { ok: false, message: 'Please select a preferred date.' };
        const p = typeof window.bkIsoParts === 'function' ? window.bkIsoParts(iso) : null;
        if (!p) return { ok: false, message: 'Please select a valid date.' };
        if (p.day === 0) return { ok: false, message: 'Unavailable — please choose another date.' };
        if (typeof window.bkHolidays === 'function' && window.bkHolidays(+p.iso.slice(0, 4)).has(p.iso)) {
          return { ok: false, message: 'Closed for the holiday. Please choose another date.' };
        }
        const minIso = typeof window.bkEarliestBookable === 'function' ? window.bkEarliestBookable() : '';
        if (minIso && p.iso < minIso) {
          return { ok: false, message: 'Due to route planning, please choose a date at least 3 days out. Need sooner? Call or text us.' };
        }
        const mode = primaryArrival ? primaryArrival.mode() : '';
        if (!mode) {
          if (primaryArrival) primaryArrival.showError('Please select a preferred arrival window.');
          return { ok: false, message: 'Please select a preferred arrival window.' };
        }
        if (mode === 'specific' && !win) {
          if (primaryArrival) primaryArrival.showError('Please select an available arrival window.');
          return { ok: false, message: 'Please select an available arrival window.' };
        }
        if (!win) return { ok: false, message: 'Please select a preferred arrival window.' };
        if (!isKnownWindow(win)) return { ok: false, message: 'Please select a valid arrival window.' };
        if (typeof window.bkRefreshTimeSlots === 'function') window.bkRefreshTimeSlots();
        const time = document.getElementById('f-time')?.value || '';
        const allowed = typeof window.bkSlotsFor === 'function' ? window.bkSlotsFor(iso) : [];
        const eligible = eligibleSlotsForWindow(win, allowed);
        if (!eligible.length || !time || !eligible.includes(time)) {
          return { ok: false, message: 'That arrival window is unavailable on the selected date. Please choose another window.' };
        }
        if (primaryArrival) primaryArrival.clearError();
        const hasAlt = !!document.getElementById('f-has-alternate')?.checked;
        if (hasAlt) {
          const altDate = document.getElementById('f-alt-date')?.value || '';
          const altWin = document.getElementById('f-alt-arrival-window')?.value || '';
          if (!altDate) return { ok: false, message: 'Please enter an alternate date, or uncheck the alternate date option.' };
          if (altDate === iso) return { ok: false, message: 'Alternate date must be different from your preferred date.' };
          const ap = typeof window.bkIsoParts === 'function' ? window.bkIsoParts(altDate) : null;
          if (!ap) return { ok: false, message: 'Please select a valid alternate date.' };
          if (ap.day === 0) return { ok: false, message: 'Alternate date is unavailable — please choose another day.' };
          if (typeof window.bkHolidays === 'function' && window.bkHolidays(+ap.iso.slice(0, 4)).has(ap.iso)) {
            return { ok: false, message: 'Alternate date is closed for the holiday.' };
          }
          if (minIso && ap.iso < minIso) {
            return { ok: false, message: 'Alternate date must also be at least 3 days out.' };
          }
          const altAllowed = typeof window.bkSlotsFor === 'function' ? window.bkSlotsFor(altDate) : [];
          if (!altAllowed.length) {
            return { ok: false, message: 'Alternate date is unavailable. Please choose another day.' };
          }
          const altMode = altArrival ? altArrival.mode() : '';
          if (!altMode || !altWin || !isKnownWindow(altWin)) {
            if (altArrival) altArrival.showError('Please select an alternate arrival preference.');
            return { ok: false, message: 'Please select an alternate arrival window.' };
          }
          if (altMode === 'specific' && !altWin) {
            return { ok: false, message: 'Please select an alternate arrival window.' };
          }
          if (!eligibleSlotsForWindow(altWin, altAllowed).length) {
            return { ok: false, message: 'That alternate arrival window is unavailable on the alternate date.' };
          }
          if (altArrival) altArrival.clearError();
        }
        return { ok: true };
      };

      const origContinue = window.bkContinueFromContact;
      if (typeof origContinue === 'function' && !origContinue._bkCompact) {
        window.bkContinueFromContact = function () {
          const req = ['f-first', 'f-last', 'f-phone', 'f-email', 'f-addr', 'f-date', 'f-arrival-window'];
          const missing = req.find((id) => !document.getElementById(id)?.value?.trim());
          if (missing) {
            if (window.Cardetail1CheckoutAnalytics) Cardetail1CheckoutAnalytics.onValidationError(4, 'required_fields');
            if (missing === 'f-arrival-window' && primaryArrival) {
              primaryArrival.showError('Please select a preferred arrival window.');
              const focusEl = document.getElementById('f-arrival-mode-anytime')
                || document.getElementById('f-arrival-window-select');
              if (focusEl) { focusEl.focus(); focusEl.scrollIntoView({ block: 'center' }); }
            } else {
              const el = document.getElementById(missing);
              if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
            }
            alert('Please fill in all required fields marked with *');
            return;
          }
          const phone = typeof window.bkValidateContactPhone === 'function'
            ? window.bkValidateContactPhone()
            : { ok: true };
          if (!phone.ok) {
            if (window.Cardetail1CheckoutAnalytics) Cardetail1CheckoutAnalytics.onValidationError(4, 'invalid_phone');
            alert(phone.message);
            return;
          }
          if (typeof window.bkRefreshTimeSlots === 'function') window.bkRefreshTimeSlots();
          const sched = window.bkValidateScheduleSelection();
          if (!sched.ok) {
            if (window.Cardetail1CheckoutAnalytics) Cardetail1CheckoutAnalytics.onValidationError(4, 'invalid_schedule');
            if (typeof window.bkShowScheduleMsg === 'function') window.bkShowScheduleMsg(sched.message);
            return;
          }
          if (typeof window.bkShowScheduleMsg === 'function') window.bkShowScheduleMsg('');
          if (window.Cardetail1CheckoutAnalytics) Cardetail1CheckoutAnalytics.onStepCompleted(4);
          if (typeof window.bkGoTo === 'function') window.bkGoTo(5);
        };
        window.bkContinueFromContact._bkCompact = true;
      }

      const dateEl = document.getElementById('f-date');
      if (dateEl && !dateEl.dataset.bkCompactBound) {
        dateEl.dataset.bkCompactBound = '1';
        dateEl.addEventListener('change', () => {
          if (typeof window.bkRefreshTimeSlots === 'function') window.bkRefreshTimeSlots();
          refreshArrivalWindowsForDates();
        });
      }
    }
  }

  function patchPayloadAndConfirm() {
    const origBuild = window.buildBookingPayload;
    if (typeof origBuild === 'function') {
      window.buildBookingPayload = function () {
        syncOperationalSlot();
        const payload = origBuild.apply(this, arguments);
        const hasAlt = !!document.getElementById('f-has-alternate')?.checked;
        payload.preferredArrivalWindow = document.getElementById('f-arrival-window')?.value || payload.preferredArrivalWindow || '';
        payload.scheduleFlexibility = hasAlt
          ? 'alternate_date'
          : (document.getElementById('f-flexibility')?.value || 'exact');
        payload.alternatePreferredDate = hasAlt
          ? (document.getElementById('f-alt-date')?.value || null)
          : null;
        payload.alternateArrivalWindow = hasAlt
          ? (document.getElementById('f-alt-arrival-window')?.value || null)
          : null;
        payload.accessNotes = '';
        return payload;
      };
    }

    const origFill = window.fillConfirm;
    if (typeof origFill === 'function') {
      window.fillConfirm = function () {
        origFill.apply(this, arguments);
        const win = document.getElementById('f-arrival-window')?.value || '';
        const dateIso = document.getElementById('f-date')?.value || '';
        const summary = customerArrivalSummary(win);
        const cDate = document.getElementById('c-date');
        if (cDate && dateIso) {
          cDate.textContent = summary
            ? (dateIso + ' · ' + summary.value)
            : dateIso;
        }

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
        const hasAlt = !!document.getElementById('f-has-alternate')?.checked;
        const waterLabel = { yes: 'Yes — outdoor faucet or hose connection', no: 'No', unsure: 'Not sure' };
        const electricLabel = { yes: 'Yes — standard outlet nearby', no: 'No', unsure: 'Not sure' };
        const lines = [];
        if (summary) lines.push(summary.label + ': ' + summary.value);
        if (hasAlt) {
          const ad = document.getElementById('f-alt-date')?.value || '';
          const aw = document.getElementById('f-alt-arrival-window')?.value || '';
          const altSum = customerArrivalSummary(aw);
          if (ad) {
            lines.push('Alternate: ' + ad + (altSum ? ' · ' + altSum.value : ''));
          }
        }
        if (water) lines.push('Water: ' + (waterLabel[water] || water));
        if (electric) lines.push('Electricity: ' + (electricLabel[electric] || electric));
        box.textContent = lines.join(' · ');
        box.hidden = !lines.length;

        // Ensure internal preferredTime is not left visible as the only schedule cue.
        const timeVal = document.getElementById('f-time')?.value || '';
        if (cDate && timeVal && cDate.textContent.indexOf(timeVal) !== -1 && summary) {
          cDate.textContent = dateIso + ' · ' + summary.value;
        }
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
          return await origSubmit.apply(this, arguments);
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
    if (btn) {
      btn.setAttribute('data-bk-cta', 'continue-appointment');
      if (/Review Terms/i.test(btn.textContent || '')) {
        btn.textContent = 'Review details →';
      }
    }
  }

  /** Apply compact form markup when a mirrored page still has the legacy Step-4 block. */
  function ensureCompactFormMarkers() {
    return !!(document.getElementById('f-arrival-window') && document.getElementById('f-has-alternate'));
  }

  async function init() {
    ensureStyles();
    if (!ensureCompactFormMarkers()) {
      console.warn('[BkConversion] Compact details form markers missing; sync booking pages.');
    }
    wireArrivalPreferences();
    wireAlternateDate();
    wireUtilitiesTrack();
    wireWeekendLabel();
    ensureRecoveryPanel();
    patchScheduleFns();
    patchPayloadAndConfirm();
    patchSlotErrorAlerts();
    patchSetupIntentTracking();
    patchCtaCopy();
    refreshArrivalWindowsForDates();

    if (window.BkAvailability) {
      await window.BkAvailability.load();
      patchScheduleFns();
      try {
        const dateEl = document.getElementById('f-date');
        const altDate = document.getElementById('f-alt-date');
        if (dateEl && typeof window.bkEarliestBookable === 'function') {
          dateEl.min = window.bkEarliestBookable();
        }
        if (altDate && typeof window.bkEarliestBookable === 'function') {
          altDate.min = window.bkEarliestBookable();
        }
      } catch (_) { /* */ }
      refreshArrivalWindowsForDates();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  root.BkConversion = {
    openRecovery,
    track,
    init,
    syncOperationalSlot,
    refreshArrivalWindowsForDates,
    eligibleSlotsForWindow,
    setPrimaryArrivalWindow,
    customerArrivalSummary,
    ARRIVAL_WINDOWS,
    SPECIFIC_WINDOWS,
    ARRIVAL_LABELS,
    get primaryArrival() { return primaryArrival; },
    get altArrival() { return altArrival; },
  };
})(typeof window !== 'undefined' ? window : globalThis);
