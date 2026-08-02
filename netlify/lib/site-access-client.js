/**
 * Browser mirror of site-access labels for Admin Ops / Tech portals.
 * Keep enum values yes | no | unsure.
 */
(function (root) {
  const WATER = {
    yes: 'Available — outdoor faucet or hose connection',
    no: 'Not available',
    unsure: 'Not sure',
  };
  const ELECTRIC = {
    yes: 'Available — standard outlet nearby',
    no: 'Not available',
    unsure: 'Not sure',
  };
  const LOC = {
    driveway: 'Driveway',
    street: 'Street parking',
    garage: 'Garage / parking deck',
    apartment: 'Apartment / condo',
    marina: 'Marina / dock',
    commercial: 'Commercial lot',
    other: 'Other',
  };

  function lines(job) {
    const b = job || {};
    const out = [];
    if (b.waterAvailable) out.push('Water: ' + (WATER[b.waterAvailable] || b.waterAvailable));
    if (b.electricityAvailable) out.push('Electricity: ' + (ELECTRIC[b.electricityAvailable] || b.electricityAvailable));
    if (b.serviceLocation) out.push('Location: ' + (LOC[b.serviceLocation] || b.serviceLocation));
    if (b.accessNotes) out.push('Access notes: ' + b.accessNotes);
    return out;
  }

  function hasAny(job) {
    const b = job || {};
    return !!(b.waterAvailable || b.electricityAvailable || b.serviceLocation || b.accessNotes);
  }

  function adminSection(job, esc) {
    if (!hasAny(job)) return '';
    const e = typeof esc === 'function' ? esc : (s) => String(s == null ? '' : s);
    const rows = lines(job).map((line) => {
      const i = line.indexOf(':');
      const k = i >= 0 ? line.slice(0, i) : 'Info';
      const v = i >= 0 ? line.slice(i + 1).trim() : line;
      return '<div class="kv"><span>' + e(k) + '</span><strong>' + e(v) + '</strong></div>';
    }).join('');
    return '<div class="sec-title">Site access</div><div class="kv-grid">' + rows + '</div>';
  }

  function techCells(job, esc, fullCell) {
    if (!hasAny(job)) return '';
    const e = typeof esc === 'function' ? esc : (s) => String(s == null ? '' : s);
    const fc = typeof fullCell === 'function' ? fullCell : (label, val) =>
      '<div class="cell full"><div class="lab">' + e(label) + '</div><div class="val">' + e(val) + '</div></div>';
    return lines(job).map((line) => {
      const i = line.indexOf(':');
      const k = i >= 0 ? line.slice(0, i) : 'Info';
      const v = i >= 0 ? line.slice(i + 1).trim() : line;
      return fc(k, v);
    }).join('');
  }

  root.SiteAccess = { lines, hasAny, adminSection, techCells, WATER, ELECTRIC, LOC };
})(typeof window !== 'undefined' ? window : globalThis);
