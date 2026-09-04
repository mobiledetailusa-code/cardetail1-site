/**
 * Booking Step 4 — ZIP-locked street suggestions + city mismatch hint.
 * Progressive enhancement on #f-addr. Does not change travel-fee ZIP.
 */
(function (root) {
  const ENDPOINT = '/.netlify/functions/address-suggest';
  const DEBOUNCE_MS = 280;
  const MIN_STREET = /^\d{1,6}\s+[A-Za-z]/;

  let debounceTimer = null;
  let inflight = null;
  let activeIndex = -1;
  let lastSuggestions = [];

  function $(id) {
    return document.getElementById(id);
  }

  function ensureStyles() {
    if ($('bk-addr-suggest-styles')) return;
    const css = document.createElement('style');
    css.id = 'bk-addr-suggest-styles';
    css.textContent = [
      '.bk-addr-wrap{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.bk-addr-zip-chip{display:none;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:12.5px;line-height:1.4;color:var(--tx,#334155);background:var(--bdim,rgba(37,99,235,.08));border:1px solid var(--bbr,rgba(37,99,235,.22));border-radius:10px;padding:8px 12px}',
      '.bk-addr-zip-chip.show{display:flex}',
      '.bk-addr-zip-chip strong{font-weight:700;letter-spacing:.04em}',
      '.bk-addr-zip-change{font:inherit;font-size:12px;color:var(--blue,#2563eb);background:none;border:0;padding:0;min-height:44px;cursor:pointer;text-decoration:underline;text-underline-offset:3px}',
      '.bk-addr-field{position:relative;min-width:0}',
      '.bk-addr-dd{position:absolute;left:0;right:0;top:100%;z-index:40;margin-top:4px;background:#fff;border:1px solid rgba(15,23,42,.14);border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.12);overflow:hidden;max-height:240px;overflow-y:auto}',
      '.bk-addr-dd[hidden]{display:none!important}',
      '.bk-addr-opt{display:block;width:100%;text-align:left;font:inherit;font-size:13.5px;line-height:1.35;padding:11px 14px;border:0;background:#fff;cursor:pointer;min-height:44px}',
      '.bk-addr-opt[aria-selected="true"],.bk-addr-opt:hover{background:rgba(37,99,235,.08)}',
      '.bk-addr-hint{margin:0;font-size:12.5px;line-height:1.45;color:#9a3412;background:#fff7ed;border:1px solid rgba(154,52,18,.2);border-radius:10px;padding:8px 12px}',
      '.bk-addr-hint[hidden]{display:none!important}',
      '.bk-addr-hint button{font:inherit;font-size:12.5px;font-weight:600;color:var(--blue,#2563eb);background:none;border:0;padding:6px 0;min-height:44px;cursor:pointer;text-decoration:underline;text-underline-offset:3px}',
    ].join('');
    document.head.appendChild(css);
  }

  function knownZip() {
    if (typeof root.getKnownZip5 === 'function') {
      const z = root.getKnownZip5();
      if (z) return String(z).replace(/\D/g, '').slice(0, 5);
    }
    const el = $('bk-zip');
    const z = String((el && el.value) || '').replace(/\D/g, '').slice(0, 5);
    if (z.length === 5) return z;
    try {
      const stored = sessionStorage.getItem('cd1_zip');
      const s = String(stored || '').replace(/\D/g, '').slice(0, 5);
      if (s.length === 5) return s;
    } catch (_) { /* */ }
    return '';
  }

  function cityLabelForZip(zip) {
    if (typeof root.getCityByZip === 'function') {
      return String(root.getCityByZip(zip) || '').trim();
    }
    return '';
  }

  function hideDropdown() {
    const dd = $('bk-addr-dd');
    if (dd) {
      dd.hidden = true;
      dd.innerHTML = '';
    }
    activeIndex = -1;
    const input = $('f-addr');
    if (input) input.setAttribute('aria-expanded', 'false');
  }

  function renderDropdown(items) {
    const dd = $('bk-addr-dd');
    const input = $('f-addr');
    if (!dd || !input) return;
    lastSuggestions = items || [];
    if (!lastSuggestions.length) {
      hideDropdown();
      return;
    }
    dd.innerHTML = lastSuggestions.map((row, i) => (
      '<button type="button" class="bk-addr-opt" role="option" id="bk-addr-opt-' + i +
      '" data-idx="' + i + '" aria-selected="' + (i === activeIndex ? 'true' : 'false') + '">' +
      escapeHtml(row.label) + '</button>'
    )).join('');
    dd.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    dd.querySelectorAll('.bk-addr-opt').forEach((btn) => {
      btn.addEventListener('mousedown', (ev) => ev.preventDefault());
      btn.addEventListener('click', () => applySuggestion(Number(btn.getAttribute('data-idx'))));
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function detectConflict(address, zip, cityLabel) {
    const text = String(address || '');
    const foundZip = ((text.match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1] || '');
    if (zip && foundZip && foundZip !== zip) {
      return { type: 'zip', foundZip, expectedZip: zip, expectedCity: cityLabel };
    }
    const expectedCity = String(cityLabel || '').split(',')[0].trim();
    if (!expectedCity || expectedCity.length < 3) return null;
    const cityRe = new RegExp('\\b' + expectedCity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    const looksComplete = /,\s*[A-Za-z].+\b[A-Z]{2}\b/.test(text) || Boolean(foundZip);
    if (looksComplete && !cityRe.test(text)) {
      return { type: 'city', foundZip, expectedZip: zip, expectedCity: cityLabel };
    }
    return null;
  }

  function applyExpectedPlace(address, cityLabel, zip) {
    const street = String(address || '').split(',')[0].trim() || String(address || '').trim();
    const city = String(cityLabel || '').split(',')[0].trim();
    const stMatch = String(cityLabel || '').match(/,\s*([A-Za-z]{2})\s*$/);
    const state = stMatch ? stMatch[1].toUpperCase() : 'NJ';
    if (!street) return '';
    const locality = [city, state].filter(Boolean).join(', ');
    return [street, [locality, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  }

  function updateHint() {
    const hint = $('bk-addr-hint');
    const input = $('f-addr');
    if (!hint || !input) return;
    const zip = knownZip();
    const cityLabel = cityLabelForZip(zip);
    const conflict = detectConflict(input.value, zip, cityLabel);
    if (!conflict || !cityLabel) {
      hint.hidden = true;
      hint.innerHTML = '';
      return;
    }
    hideDropdown();
    const place = cityLabel + (zip ? ' ' + zip : '');
    if (conflict.type === 'zip') {
      hint.innerHTML = 'That street is in ZIP ' + escapeHtml(conflict.foundZip) +
        '. This booking used <strong>' + escapeHtml(place) +
        '</strong>. Use the ZIP city, or change ZIP on step 1 if the job is actually there.' +
        ' <button type="button" id="bk-addr-fix">Use ' + escapeHtml(cityLabel) + '</button>';
    } else {
      hint.innerHTML = 'This ZIP is <strong>' + escapeHtml(place) +
        '</strong>. The city in the address does not match.' +
        ' <button type="button" id="bk-addr-fix">Use ' + escapeHtml(cityLabel) + '</button>';
    }
    hint.hidden = false;
    const fix = $('bk-addr-fix');
    if (fix) {
      fix.onclick = () => {
        input.value = applyExpectedPlace(input.value, cityLabel, zip);
        updateHint();
        hideDropdown();
      };
    }
  }

  function syncZipChip() {
    const chip = $('bk-addr-zip-chip');
    const zipEl = $('bk-addr-zip-val');
    const cityEl = $('bk-addr-zip-city');
    const input = $('f-addr');
    const zip = knownZip();
    const cityLabel = cityLabelForZip(zip);
    if (chip) {
      if (zip) {
        if (zipEl) zipEl.textContent = zip;
        if (cityEl) cityEl.textContent = cityLabel || 'service area';
        chip.classList.add('show');
        chip.hidden = false;
      } else {
        chip.classList.remove('show');
        chip.hidden = true;
      }
    }
    if (input && cityLabel) {
      input.placeholder = 'Start with house number — e.g. 168 Oak, ' + cityLabel;
    }
    updateHint();
  }

  function applySuggestion(idx) {
    const row = lastSuggestions[idx];
    const input = $('f-addr');
    if (!row || !input) return;
    input.value = row.label;
    hideDropdown();
    updateHint();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }

  function highlight(next) {
    if (!lastSuggestions.length) return;
    activeIndex = (next + lastSuggestions.length) % lastSuggestions.length;
    const dd = $('bk-addr-dd');
    if (!dd) return;
    dd.querySelectorAll('.bk-addr-opt').forEach((el, i) => {
      el.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
    });
  }

  async function lookup(q) {
    const zip = knownZip();
    if (!zip || !MIN_STREET.test(q)) {
      hideDropdown();
      return;
    }
    if (inflight && typeof inflight.abort === 'function') {
      try { inflight.abort(); } catch (_) { /* */ }
    }
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    inflight = ctrl;
    const params = new URLSearchParams({ q, zip });
    const city = cityLabelForZip(zip);
    if (city) params.set('city', city);
    try {
      const res = await fetch(ENDPOINT + '?' + params.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
      if (ctrl && inflight !== ctrl) return;
      if (!res.ok) {
        hideDropdown();
        return;
      }
      const data = await res.json().catch(() => null);
      const items = data && Array.isArray(data.suggestions) ? data.suggestions : [];
      renderDropdown(items);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      hideDropdown();
    }
  }

  function onAddrInput() {
    updateHint();
    const q = String(($('f-addr') && $('f-addr').value) || '').trim();
    clearTimeout(debounceTimer);
    if (!MIN_STREET.test(q)) {
      hideDropdown();
      return;
    }
    if (/,\s*[A-Za-z].+\b[A-Z]{2}\b/.test(q) || /\b\d{5}(?:-\d{4})?\b/.test(q)) {
      hideDropdown();
      return;
    }
    debounceTimer = setTimeout(() => lookup(q), DEBOUNCE_MS);
  }

  function onAddrKeydown(ev) {
    const dd = $('bk-addr-dd');
    const open = dd && !dd.hidden && lastSuggestions.length;
    if (ev.key === 'ArrowDown' && open) {
      ev.preventDefault();
      highlight(activeIndex + 1);
    } else if (ev.key === 'ArrowUp' && open) {
      ev.preventDefault();
      highlight(activeIndex - 1);
    } else if (ev.key === 'Enter' && open && activeIndex >= 0) {
      ev.preventDefault();
      applySuggestion(activeIndex);
    } else if (ev.key === 'Escape') {
      hideDropdown();
    }
  }

  function goChangeZip() {
    if (typeof root.bkGoTo === 'function') root.bkGoTo(1);
    const zip = $('bk-zip');
    if (zip) {
      try { zip.focus(); } catch (_) { /* */ }
    }
  }

  function patchBkGoTo() {
    const orig = root.bkGoTo;
    if (typeof orig !== 'function' || orig._bkAddrPatched) return;
    const wrapped = function (n, opts) {
      const result = orig.apply(this, arguments);
      if (Number(n) === 4) syncZipChip();
      return result;
    };
    wrapped._bkAddrPatched = true;
    root.bkGoTo = wrapped;
  }

  function init() {
    ensureStyles();
    const input = $('f-addr');
    if (!input) return;
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', 'bk-addr-dd');
    input.setAttribute('aria-expanded', 'false');
    input.addEventListener('input', onAddrInput);
    input.addEventListener('keydown', onAddrKeydown);
    input.addEventListener('blur', () => {
      setTimeout(hideDropdown, 180);
      updateHint();
    });
    const change = $('bk-addr-zip-change');
    if (change) change.addEventListener('click', goChangeZip);
    const zip = $('bk-zip');
    if (zip) zip.addEventListener('input', syncZipChip);
    patchBkGoTo();
    syncZipChip();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  root.BkAddressSuggest = {
    syncZipChip,
    detectConflict,
    applyExpectedPlace,
    init,
  };
})(typeof window !== 'undefined' ? window : globalThis);
