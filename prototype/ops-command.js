/**
 * Cardetail1 Ops Command — mobile-first prototype (mock only).
 * Inspired by Fieldd-style density; phone stacks Live → Up Next → Later.
 */
(function () {
  'use strict';

  document.documentElement.classList.remove('proto-booting');
  document.documentElement.classList.add('proto-ready');

  var NOW = new Date(2026, 8, 4, 8, 42, 0); // Fri Sep 4, 2026 8:42 AM local mock

  var LIVE = [{
    id: 'CD1-LIVE-1',
    address: '42 Maple Ave, Harrison NY',
    package: 'Premium Detail',
    price: 239,
    window: '8:00 – 10:00 AM',
    remainingMin: 48,
    tech: 'Magno',
    status: 'in_progress',
  }];

  var NEXT = {
    id: 'CD1-NEXT-1',
    address: '18 Lake St, Rye NY',
    package: 'Full Detail',
    price: 189,
    window: '10:30 AM – 12:30 PM',
    startAt: new Date(2026, 8, 4, 10, 30, 0),
    tech: 'Alex',
    status: 'confirmed',
  };

  var LATER = [
    { time: '1:00 PM', address: '9 Clinton St, New Rochelle', package: 'Maintenance Wash', tech: 'Sam', price: 99 },
    { time: '3:00 PM', address: '210 Purchase St, Rye', package: 'Interior Detail', tech: 'Magno', price: 149 },
    { time: '5:00 PM', address: '77 Halstead Ave, Mamaroneck', package: 'Full Detail', tech: 'Alex', price: 189 },
  ];

  var TECHS = [
    { name: 'Magno', jobs: 3, load: 86 },
    { name: 'Alex', jobs: 2, load: 62 },
    { name: 'Sam', jobs: 1, load: 34 },
  ];

  var WEEK = [
    { d: 'Mon', free: 4, jobs: 5 },
    { d: 'Tue', free: 2, jobs: 6 },
    { d: 'Wed', free: 5, jobs: 4 },
    { d: 'Thu', free: 3, jobs: 5 },
    { d: 'Fri', free: 1, jobs: 7 },
  ];

  function money(n) {
    return '$' + Number(n).toFixed(0);
  }

  function greet(d) {
    var h = d.getHours();
    var part = h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
    var day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    return day + ' · ' + part;
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function renderLive() {
    var el = document.getElementById('ocLiveList');
    var meta = document.getElementById('ocLiveMeta');
    var pill = document.getElementById('ocLivePill');
    if (!el) return;
    meta.textContent = LIVE.length ? (LIVE.length + ' active') : 'Clear';
    if (pill) pill.innerHTML = '<i></i> ' + LIVE.length + ' live';
    if (!LIVE.length) {
      el.innerHTML = '<div class="oc-empty">No jobs in progress</div>';
      return;
    }
    el.innerHTML = LIVE.map(function (j) {
      return '<article class="oc-job live">' +
        '<div class="oc-job-top"><div>' +
        '<div class="oc-job-addr">' + j.address + '</div>' +
        '<div class="oc-job-pkg">' + j.package + ' · ' + j.window + '</div></div>' +
        '<div class="oc-job-price">' + money(j.price) + '</div></div>' +
        '<div class="oc-job-meta">' +
        '<span class="oc-tag live">● Live</span>' +
        '<span><strong>' + j.remainingMin + 'm</strong> left</span>' +
        '<span>Tech <strong>' + j.tech + '</strong></span>' +
        '</div></article>';
    }).join('');
  }

  function renderNext() {
    var card = document.getElementById('ocNextCard');
    if (!card || !NEXT) return;
    card.innerHTML = '<article class="oc-job">' +
      '<div class="oc-job-top"><div>' +
      '<div class="oc-job-addr">' + NEXT.address + '</div>' +
      '<div class="oc-job-pkg">' + NEXT.package + ' · ' + NEXT.window + '</div></div>' +
      '<div class="oc-job-price">' + money(NEXT.price) + '</div></div>' +
      '<div class="oc-job-meta">' +
      '<span class="oc-tag">Up next</span>' +
      '<span>Tech <strong>' + NEXT.tech + '</strong></span>' +
      '</div></article>';
  }

  function tickCountdown() {
    var val = document.getElementById('ocCountVal');
    if (!val || !NEXT) return;
    var ms = NEXT.startAt.getTime() - NOW.getTime();
    if (ms < 0) ms = 0;
    var totalSec = Math.floor(ms / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    val.textContent = h > 0 ? (h + ':' + pad(m) + ':' + pad(s)) : (pad(m) + ':' + pad(s));
    // Prototype: advance mock clock so countdown feels alive
    NOW = new Date(NOW.getTime() + 1000);
  }

  function renderLater() {
    var el = document.getElementById('ocLaterList');
    if (!el) return;
    el.innerHTML = LATER.map(function (j) {
      return '<div class="oc-later-row">' +
        '<div class="oc-later-time">' + j.time + '</div>' +
        '<div class="oc-later-body"><strong>' + j.address + '</strong><span>' + j.package + ' · ' + money(j.price) + '</span></div>' +
        '<div class="oc-later-tech">' + j.tech + '</div></div>';
    }).join('');
  }

  function renderSnap() {
    var el = document.getElementById('ocSnap');
    if (!el) return;
    var dayRev = LIVE.concat([NEXT]).concat(LATER).reduce(function (s, j) { return s + (j.price || 0); }, 0);
    var goal = 10000;
    var monthRev = 4820;
    var pct = Math.round((monthRev / goal) * 100);
    el.innerHTML =
      '<div class="oc-snap-item goal">' +
      '<div class="oc-ring" style="--p:' + (pct * 3.6) + 'deg" data-pct="' + pct + '%"></div>' +
      '<div><div class="lbl">Month revenue goal</div><div class="val">' + money(monthRev) + '</div>' +
      '<div class="sub">of ' + money(goal) + ' · ' + pct + '% there</div></div></div>' +
      '<div class="oc-snap-item rev"><div class="lbl">Booked today</div><div class="val">' + money(dayRev) + '</div><div class="sub">' + (LIVE.length + 1 + LATER.length) + ' appointments</div></div>' +
      '<div class="oc-snap-item due"><div class="lbl">Balance due</div><div class="val">$420</div><div class="sub">2 invoices</div></div>' +
      '<div class="oc-snap-item"><div class="lbl">Needs action</div><div class="val">3</div><div class="sub">reviews · assign</div></div>' +
      '<div class="oc-snap-item"><div class="lbl">Reviews</div><div class="val">4.9</div><div class="sub">12 this month</div></div>';
  }

  function renderTech() {
    var el = document.getElementById('ocTechLoad');
    if (!el) return;
    el.innerHTML = TECHS.map(function (t) {
      return '<div class="oc-tech"><div class="oc-tech-head"><strong>' + t.name + '</strong><span>' + t.jobs + ' jobs · ' + t.load + '%</span></div>' +
        '<div class="oc-meter"><i style="width:' + t.load + '%"></i></div></div>';
    }).join('');
    // animate meters after paint
    requestAnimationFrame(function () {
      el.querySelectorAll('.oc-meter > i').forEach(function (bar) {
        var w = bar.style.width;
        bar.style.width = '0';
        requestAnimationFrame(function () { bar.style.width = w; });
      });
    });
  }

  function renderCharts() {
    var avail = document.getElementById('ocAvailBars');
    var jobs = document.getElementById('ocJobsBars');
    if (!avail || !jobs) return;
    var maxFree = Math.max.apply(null, WEEK.map(function (w) { return w.free; }));
    var maxJobs = Math.max.apply(null, WEEK.map(function (w) { return w.jobs; }));
    avail.innerHTML = WEEK.map(function (w) {
      var h = Math.max(8, Math.round((w.free / maxFree) * 100));
      return '<div class="oc-bar-col"><div class="oc-bar" style="height:' + h + '%"></div><em>' + w.d + '</em></div>';
    }).join('');
    jobs.innerHTML = WEEK.map(function (w) {
      var h = Math.max(8, Math.round((w.jobs / maxJobs) * 100));
      return '<div class="oc-bar-col"><div class="oc-bar" style="height:' + h + '%;background:linear-gradient(180deg,var(--teal),rgba(45,212,191,.25))"></div><em>' + w.d + '</em></div>';
    }).join('');
  }

  document.getElementById('ocGreet').textContent = greet(NOW);
  renderLive();
  renderNext();
  renderLater();
  renderSnap();
  renderTech();
  renderCharts();
  tickCountdown();
  setInterval(tickCountdown, 1000);
})();
