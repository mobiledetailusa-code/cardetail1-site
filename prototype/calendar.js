/**
 * Reusable horizontal calendar strip for prototype portals.
 */
(function (global) {
  function renderCalendar(container, opts) {
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
      btn.addEventListener('click', () => {
        if (onSelect) onSelect(btn.dataset.date);
      });
    });
  }

  function renderBanner(container, dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const isToday = dateStr === global.CD1Proto.fmtDate(global.CD1Proto.TODAY);
    const label = isToday ? 'TODAY' : d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
    container.innerHTML = `Schedule for <strong>${label}</strong> ${d.toLocaleDateString('en-US', { weekday: 'long', month: 'numeric', day: 'numeric', year: '2-digit' })}`;
  }

  function mapEmbed(job) {
    const q = encodeURIComponent(job.address);
    return `https://maps.google.com/maps?q=${q}&z=13&output=embed`;
  }

  global.CD1Calendar = { renderCalendar, renderBanner, mapEmbed };
})(window);
