// AI SEARCH PERFORMANCE report for the Revenue Operations dashboard.
//
// Every number is a count of stored records; nothing is estimated or modelled.
// - Visits, booking starts, submissions: rows in the AI index (see
//   ai-attribution-index.js), deduplicated by session or booking reference.
// - Confirmed bookings and value: server confirmation events only
//   (event_origin "server_confirm", written by revenue-authoritative-confirm.js
//   with the server-approved amount). A browser-sent estimated_value is never
//   read. Repeated confirmations of one booking count once (latest wins).
// - A confirmed booking is AI-attributed only if its booking_submitted event was
//   indexed as AI. Bookings submitted before the index existed stay unattributed.

const { AI_ASSISTANTS, labelFor } = require('./ai-attribution');
const { PAGE_VIEW_EVENTS, normalizeBookingReference } = require('./ai-attribution-index');

const MAX_INDEX_ROWS = 5000;
const MAX_CONFIRMATIONS = 1000;
const LIST_CONCURRENCY = 8;

function dayKeys(fromDay, toDay) {
  const out = [];
  const start = new Date(`${fromDay}T12:00:00Z`);
  const end = new Date(`${toDay}T12:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function emptyCounts() {
  return { visits: 0, bookingStarts: 0, bookingSubmissions: 0, confirmedBookings: 0, confirmedValue: 0, confirmedMissingAmount: 0 };
}

function ratio(num, den) {
  return den > 0 ? Math.round((num / den) * 10000) / 10000 : null;
}

function isServerConfirmation(rec) {
  return !!(rec && rec.event === 'booking_confirmed' && rec.properties && rec.properties.event_origin === 'server_confirm'
    && !(rec.qaFixture === true || rec.qaTag === 'QA-REVOPS'));
}

/**
 * range: { from, to, fromDay, toDay } (revops-dashboard parseDateRange output).
 * deps: { getStore(name), listKeys(store, opts), getJson(store, key) }.
 */
async function buildAiSearchReport(range, deps) {
  const warnings = [];
  const aiStore = await deps.getStore('aiIndex');
  const eventStore = await deps.getStore('events');
  const days = dayKeys(range.fromDay, range.toDay);

  const coverage = await deps.getJson(aiStore, 'meta/coverage-start');
  const coverageStart = coverage && typeof coverage.startedAt === 'string' ? coverage.startedAt : null;

  // ── AI index rows in range ──────────────────────────────────────────────
  let truncated = false;
  const keyLists = await mapLimit(days, LIST_CONCURRENCY, async (day) => {
    try { return await deps.listKeys(aiStore, { prefix: `${day}/`, limit: 2000 }); } catch { warnings.push(`ai_index_list_failed:${day}`); return []; }
  });
  let indexKeys = keyLists.flat();
  if (indexKeys.length > MAX_INDEX_ROWS) { truncated = true; indexKeys = indexKeys.slice(0, MAX_INDEX_ROWS); }
  const rows = (await mapLimit(indexKeys, LIST_CONCURRENCY, (k) => deps.getJson(aiStore, k).catch(() => null)))
    .filter((r) => r && r.v === 1 && typeof r.sourceKey === 'string');

  const bySource = {};
  const counts = (key) => (bySource[key] = bySource[key] || { sessions: new Set(), starts: new Set(), refs: new Set(), refless: 0 });
  for (const r of rows) {
    const c = counts(r.sourceKey);
    if (PAGE_VIEW_EVENTS.includes(r.event) && r.sessionId) c.sessions.add(r.sessionId);
    else if (r.event === 'booking_started' && r.sessionId) c.starts.add(r.sessionId);
    else if (r.event === 'booking_submitted') {
      const ref = normalizeBookingReference(r.bookingReference);
      if (ref) c.refs.add(ref); else c.refless += 1;
    }
  }

  // ── Server confirmations in range (found by key, read individually) ─────
  const confirmKeyLists = await mapLimit(days, LIST_CONCURRENCY, async (day) => {
    try { return await deps.listKeys(eventStore, { prefix: `${day}/confirmed:`, limit: 2000 }); } catch { warnings.push(`confirmations_list_failed:${day}`); return []; }
  });
  let confirmKeys = confirmKeyLists.flat();
  if (confirmKeys.length > MAX_CONFIRMATIONS) { truncated = true; confirmKeys = confirmKeys.slice(0, MAX_CONFIRMATIONS); }
  const confirmations = (await mapLimit(confirmKeys, LIST_CONCURRENCY, (k) => deps.getJson(eventStore, k).catch(() => null)))
    .filter(isServerConfirmation);

  const latestByRef = new Map();
  for (const rec of confirmations) {
    const ref = normalizeBookingReference(rec.properties.booking_reference);
    if (!ref) continue;
    const at = String(rec.properties.timestamp || rec.receivedAt || '');
    const prev = latestByRef.get(ref);
    if (!prev || at > prev.at) latestByRef.set(ref, { at, rec });
  }

  let confirmedWithoutAiRecord = 0;
  const bookingRows = await mapLimit([...latestByRef.keys()], LIST_CONCURRENCY,
    (ref) => deps.getJson(aiStore, `booking/${ref}`).catch(() => null));
  [...latestByRef.entries()].forEach(([ref, { rec }], i) => {
    const row = bookingRows[i];
    if (!row || typeof row.sourceKey !== 'string') { confirmedWithoutAiRecord += 1; return; }
    const c = counts(row.sourceKey);
    c.confirmed = (c.confirmed || 0) + 1;
    const value = rec.properties.estimated_value;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) c.cents = (c.cents || 0) + Math.round(value * 100);
    else c.missing = (c.missing || 0) + 1;
  });

  // ── Assemble ────────────────────────────────────────────────────────────
  const totals = emptyCounts();
  const sources = AI_ASSISTANTS.map((a) => {
    const c = bySource[a.key];
    const row = {
      key: a.key,
      label: a.label,
      visits: c ? c.sessions.size : 0,
      bookingStarts: c ? c.starts.size : 0,
      bookingSubmissions: c ? c.refs.size + c.refless : 0,
      confirmedBookings: c ? (c.confirmed || 0) : 0,
      confirmedValue: c ? (c.cents || 0) / 100 : 0,
      confirmedMissingAmount: c ? (c.missing || 0) : 0,
    };
    for (const k of Object.keys(totals)) totals[k] += row[k];
    return row;
  });
  totals.confirmedValue = Math.round(totals.confirmedValue * 100) / 100;
  const pricedConfirmed = totals.confirmedBookings - totals.confirmedMissingAmount;

  const coverageCovers = !!(coverageStart && coverageStart <= range.from);
  return {
    ok: true,
    range: { from: range.from, to: range.to },
    coverageStart,
    complete: coverageCovers && !truncated && warnings.length === 0,
    truncated,
    totals: {
      ...totals,
      averageConfirmedValue: pricedConfirmed > 0 ? Math.round((totals.confirmedValue / pricedConfirmed) * 100) / 100 : null,
      submissionRate: ratio(totals.bookingSubmissions, totals.visits),
      confirmationRate: ratio(totals.confirmedBookings, totals.visits),
    },
    sources: sources.map((s) => ({ ...s, label: labelFor(s.key) || s.label })),
    allConfirmedBookingsInRange: latestByRef.size,
    confirmedWithoutAiRecord,
    basis: {
      visits: 'Distinct sessions with an AI-attributed page view (first or last touch).',
      bookingStarts: 'Distinct sessions with an AI-attributed booking_started event.',
      bookingSubmissions: 'Distinct booking references from AI-attributed booking_submitted events.',
      confirmedBookings: 'Server confirmations (event_origin server_confirm), one per booking, whose booking was submitted with AI attribution.',
      confirmedValue: 'Server-approved amount at confirmation. Not cash received. Browser estimates are never used.',
    },
    warnings,
  };
}

module.exports = { buildAiSearchReport, MAX_INDEX_ROWS, MAX_CONFIRMATIONS };
