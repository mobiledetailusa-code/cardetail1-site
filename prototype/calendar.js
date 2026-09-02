/**
 * Reusable horizontal calendar strip + lightweight map (no iframe — CSP-safe, fast).
 */
(function (global) {
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function renderCalendar(container, opts) {
    if (!container) return;
    const { selectedDate, onSelect, anchorDate } = opts;
    const days = global.CD1Proto.weekDays(anchorDate || global.CD1Proto.TODAY);
    const sel = selectedDate || global.CD1Proto.fmtDate(global.CD1Proto.TODAY);

    container.innerHTML = days.map((d) => {
      const classes = ['cal-day'];
      if (d.isToday) classes.push('today');
      if (d.date === sel) classes.push('sel');
      const label = d.jobCount === 1 ? '1 job' : d.jobCount + ' jobs';
      return `<button type="button" class="${classes.join(' ')}" data-date="${d.date}" aria-pressed="${d.date === sel}">
        <div class="dn">${d.dayName}</div>
        <div class="dd">${d.dayNum}</div>
        <div class="dm">${d.month}</div>
        <div class="jc">${label}</div>
      </button>`;
    }).join('');

    container.querySelectorAll('.cal-day').forEach((btn) => {
      btn.addEventListener('click', () => { if (onSelect) onSelect(btn.dataset.date); });
    });
  }

  function renderBanner(container, dateStr) {
    if (!container) return;
    const d = new Date(dateStr + 'T12:00:00');
    const isToday = dateStr === global.CD1Proto.fmtDate(global.CD1Proto.TODAY);
    const label = isToday ? 'TODAY' : d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
    container.innerHTML = `Schedule for <strong>${label}</strong> ${d.toLocaleDateString('en-US', { weekday: 'long', month: 'numeric', day: 'numeric', year: '2-digit' })}`;
  }

  /** Lightweight map card — link only, no iframe (fast + works with site CSP). */
  function mapHtml(job, pinLabel) {
    const addr = (job && job.address) ? String(job.address).trim() : '';
    if (!addr) return '';
    const q = encodeURIComponent(addr);
    const pin = esc(pinLabel || (job.id || ''));
    return `<div class="map-card">
      <a class="map-link" href="https://maps.google.com/?q=${q}" target="_blank" rel="noopener noreferrer" aria-label="Open ${esc(addr)} in Maps">
        <div class="map-placeholder" aria-hidden="true">
          <span class="map-pin-icon">📍</span>
          <span class="map-addr">${esc(addr)}</span>
          <span class="map-cta">Open in Maps →</span>
        </div>
        ${pin ? `<span class="map-pin mono">${pin}</span>` : ''}
      </a>
    </div>`;
  }

  /** @deprecated use mapHtml — kept for compat */
  function mapEmbed(job) {
    return mapHtml(job);
  }

  global.CD1Calendar = { renderCalendar, renderBanner, mapHtml, mapEmbed };
})(window);
