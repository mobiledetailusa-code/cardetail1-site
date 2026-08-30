(function () {
  const search = document.getElementById('guide-search');
  const cards = Array.from(document.querySelectorAll('[data-guide-card]'));
  const faqs = Array.from(document.querySelectorAll('[data-guide-faq] details'));
  const empty = document.getElementById('guide-empty');
  const chips = Array.from(document.querySelectorAll('[data-guide-filter]'));

  function norm(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function applyFilter(query, chipTag) {
    const q = norm(query);
    const tag = chipTag && chipTag !== 'all' ? norm(chipTag) : '';
    let visible = 0;

    cards.forEach((card) => {
      const hay = norm((card.getAttribute('data-tags') || '') + ' ' + card.textContent);
      const matchesQuery = !q || hay.indexOf(q) !== -1;
      const matchesTag = !tag || hay.indexOf(tag) !== -1;
      const show = matchesQuery && matchesTag;
      card.hidden = !show;
      if (show) visible += 1;
    });

    faqs.forEach((item) => {
      const hay = norm(item.textContent);
      const show = (!q || hay.indexOf(q) !== -1) && (!tag || hay.indexOf(tag) !== -1);
      item.hidden = !show;
    });

    if (empty) {
      const anyFaq = faqs.some((item) => !item.hidden);
      empty.hidden = visible > 0 || anyFaq || (!q && !tag);
    }
  }

  function currentChip() {
    const pressed = chips.find((chip) => chip.getAttribute('aria-pressed') === 'true');
    return pressed ? pressed.getAttribute('data-guide-filter') : 'all';
  }

  if (search) {
    search.addEventListener('input', () => applyFilter(search.value, currentChip()));
  }

  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      chips.forEach((other) => other.setAttribute('aria-pressed', String(other === chip)));
      applyFilter(search ? search.value : '', chip.getAttribute('data-guide-filter'));
    });
  });

  const hash = window.location.hash.replace('#', '');
  if (hash) {
    const target = document.getElementById(hash);
    if (target && target.tagName === 'DETAILS') target.open = true;
  }
})();
