// Browser helper for admin + technician portals (mirrors netlify/lib/site-access.js).
(function (root) {
  var WATER = {
    yes: 'Yes, water spigot/hose access available',
    no: 'No water available',
    unsure: 'Not sure',
  };
  var ELECTRIC = {
    yes: 'Yes, outlet available',
    no: 'No electricity available',
    unsure: 'Not sure',
  };
  var LOC = {
    driveway: 'Driveway',
    street: 'Street parking',
    garage: 'Garage / parking deck',
    apartment: 'Apartment / condo',
    marina: 'Marina / dock',
    commercial: 'Commercial lot',
    other: 'Other',
  };

  function lines(job) {
    job = job || {};
    var out = [];
    if (job.waterAvailable) out.push(['Water', WATER[job.waterAvailable] || job.waterAvailable]);
    if (job.electricityAvailable) out.push(['Electricity', ELECTRIC[job.electricityAvailable] || job.electricityAvailable]);
    if (job.serviceLocation) out.push(['Location', LOC[job.serviceLocation] || job.serviceLocation]);
    if (job.accessNotes) out.push(['Access notes', job.accessNotes]);
    return out;
  }

  function hasAny(job) {
    job = job || {};
    return !!(job.waterAvailable || job.electricityAvailable || job.serviceLocation || job.accessNotes);
  }

  function adminSection(job, esc) {
    if (!hasAny(job)) return '';
    var e = esc || function (s) { return String(s == null ? '' : s); };
    return '<div class="sec"><h4>Site access</h4><div class="kv">' +
      lines(job).map(function (pair) {
        return '<div><b>' + e(pair[0]) + ':</b> ' + e(pair[1]) + '</div>';
      }).join('') +
      '</div></div>';
  }

  function techCells(job, esc, fullCell) {
    if (!hasAny(job)) return '';
    var e = esc || function (s) { return String(s == null ? '' : s); };
    var fc = fullCell || function (k, v) {
      return '<div class="ro-full"><div class="jfl">' + e(k) + '</div><div class="jfv">' + e(v) + '</div></div>';
    };
    return lines(job).map(function (pair) { return fc(pair[0], pair[1]); }).join('');
  }

  root.SiteAccess = { lines: lines, hasAny: hasAny, adminSection: adminSection, techCells: techCells };
})(typeof globalThis !== 'undefined' ? globalThis : window);
