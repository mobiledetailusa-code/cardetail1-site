/**
 * Accessible tablist for RV package groups (Outside / Inside / Inside & Out).
 * Inactive panels use [hidden] — all package cards remain in the DOM for SEO/a11y.
 */
(function () {
  'use strict';

  var TAB_IDS = ['outside', 'inside', 'both'];
  var DEFAULT_TAB = 'both';

  function initRvPackageTabs() {
    var tablist = document.querySelector('[data-rv-tablist]');
    if (!tablist) return;

    var tabs = TAB_IDS.map(function (id) {
      return tablist.querySelector('[data-rv-tab="' + id + '"]');
    }).filter(Boolean);

    var panels = TAB_IDS.map(function (id) {
      return document.getElementById('rv-panel-' + id);
    }).filter(Boolean);

    if (!tabs.length || !panels.length) return;

    function activate(tabId, focusTab) {
      tabs.forEach(function (tab) {
        var on = tab.getAttribute('data-rv-tab') === tabId;
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.tabIndex = on ? 0 : -1;
      });
      panels.forEach(function (panel) {
        var on = panel.id === 'rv-panel-' + tabId;
        if (on) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
        panel.setAttribute('aria-hidden', on ? 'false' : 'true');
      });
      if (focusTab) {
        var active = tabs.find(function (t) { return t.getAttribute('data-rv-tab') === tabId; });
        if (active) active.focus();
      }
    }

    tablist.setAttribute('role', 'tablist');
    tabs.forEach(function (tab, i) {
      tab.setAttribute('role', 'tab');
      var pid = tab.getAttribute('data-rv-tab');
      tab.setAttribute('aria-controls', 'rv-panel-' + pid);
      tab.id = 'rv-tab-' + pid;
      tab.type = 'button';
      var panel = document.getElementById('rv-panel-' + pid);
      if (panel) {
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', tab.id);
      }
      tab.addEventListener('click', function () { activate(pid, false); });
      tab.addEventListener('keydown', function (ev) {
        var idx = tabs.indexOf(tab);
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
          ev.preventDefault();
          var next = ev.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
          activate(tabs[next].getAttribute('data-rv-tab'), true);
        }
        if (ev.key === 'Home') { ev.preventDefault(); activate(tabs[0].getAttribute('data-rv-tab'), true); }
        if (ev.key === 'End') { ev.preventDefault(); activate(tabs[tabs.length - 1].getAttribute('data-rv-tab'), true); }
      });
    });

    activate(DEFAULT_TAB, false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRvPackageTabs);
  } else {
    initRvPackageTabs();
  }
})();
