(function () {
  'use strict';

  function initServiceAreaAccordions() {
    document.querySelectorAll('[data-single-open]').forEach(function (group) {
      var items = group.querySelectorAll('.service-area-accordion');
      items.forEach(function (item) {
        item.addEventListener('toggle', function () {
          if (!item.open) return;
          items.forEach(function (other) {
            if (other !== item && other.open) other.open = false;
          });
        });
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initServiceAreaAccordions);
  } else {
    initServiceAreaAccordions();
  }
})();
