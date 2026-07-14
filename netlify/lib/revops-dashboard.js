// Revenue Operations dashboard aggregation — bounded, fault-tolerant.

const crypto = require('crypto');
const revenueStore = require('./revenue-store');
const { getRevenueStore, blobListKeys, blobGetJson } = revenueStore;
const { PIPELINE_STAGES, LOST_REASONS } = require('./revenue-household');
const { hubspotEnabled } = require('./hubspot-adapter');
const { SEGMENTS } = require('./revenue-segments');

const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 90;
const MAX_EVENTS = 500;
const MAX_OPPORTUNITIES = 200;
const MAX_PRIORITY = 50;

const FUNNEL_STEPS = [
  { key: 'page_view', label: 'Page view' },
  { key: 'package_selected', label: 'Package selected' },
  { key: 'booking_started', label: 'Booking started' },
  { key: 'contact_captured', label: 'Contact captured' },
  { key: 'schedule_selected', label: 'Schedule selected' },
  { key: 'payment_step_reached', label: 'Payment step' },
  { key: 'booking_submitted', label: 'Booking submitted' },
  { key: 'booking_confirmed', label: 'Confirmed' },
  { key: 'service_completed', label: 'Completed' },
];

const EVENT_ALIASES = {
  page_view: ['page_view'],
  package_selected: ['package_selected', 'package_viewed'],
  booking_started: ['booking_started'],
  contact_captured: ['contact_captured', 'lead_created'],
  schedule_selected: ['schedule_selected', 'date_selected'],
  payment_step_reached: ['payment_step_reached', 'payment_step_viewed'],
  booking_submitted: ['booking_submitted'],
  booking_confirmed: ['booking_confirmed'],
  service_completed: ['service_completed'],
  garage_plan_started: ['garage_plan_started'],
  garage_plan_completed: ['garage_plan_completed'],
};

const GARAGE_PLAN_STATUSES = Object.freeze([
  'new', 'contacted', 'photos_requested', 'quote_preparing', 'quote_sent',
  'converted_to_booking', 'won', 'lost',
]);

function parseDateRange(query = {}) {
  const now = new Date();
  let to = query.to ? new Date(query.to) : now;
  if (Number.isNaN(to.getTime())) to = now;

  let from = query.from ? new Date(query.from) : new Date(to.getTime() - DEFAULT_RANGE_DAYS * 86400000);
  if (Number.isNaN(from.getTime())) {
    from = new Date(to.getTime() - DEFAULT_RANGE_DAYS * 86400000);
  }

  const maxSpan = MAX_RANGE_DAYS * 86400000;
  if (to.getTime() - from.getTime() > maxSpan) {
    from = new Date(to.getTime() - maxSpan);
  }
  if (from > to) {
    const swap = from;
    from = to;
    to = swap;
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    fromDay: from.toISOString().slice(0, 10),
    toDay: to.toISOString().slice(0, 10),
  };
}

function dayKeysBetween(fromDay, toDay) {
  const keys = [];
  const start = new Date(`${fromDay}T12:00:00Z`);
  const end = new Date(`${toDay}T12:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys.reverse();
}

function safeRecord(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function isQaFixtureRecord(rec) {
  return !!(rec && (rec.qaFixture === true || rec.qaTag === 'QA-REVOPS'));
}

function normalizeEvent(rec, key) {
  if (!rec || typeof rec !== 'object') return null;
  const event = String(rec.event || '').trim();
  if (!event) return null;
  return {
    event,
    properties: rec.properties && typeof rec.properties === 'object' ? rec.properties : {},
    receivedAt: rec.receivedAt || rec.at || null,
    key: key || null,
  };
}

async function loadEventsInRange(range, { limit = MAX_EVENTS } = {}) {
  const store = await revenueStore.getRevenueStore('events');
  const days = dayKeysBetween(range.fromDay, range.toDay);
  const events = [];
  const warnings = [];
  let malformed = 0;

  for (const day of days) {
    if (events.length >= limit) break;
    let keys = [];
    try {
      keys = await revenueStore.blobListKeys(store, { prefix: `${day}/`, limit: limit - events.length });
    } catch (e) {
      warnings.push(`events_list_failed:${day}`);
      continue;
    }
    for (const key of keys) {
      if (events.length >= limit) break;
      const raw = await revenueStore.blobGetJson(store, key);
      if (isQaFixtureRecord(raw)) continue;
      const norm = normalizeEvent(raw, key);
      if (!norm) {
        malformed++;
        continue;
      }
      events.push(norm);
    }
  }

  if (malformed) warnings.push(`skipped_malformed_events:${malformed}`);
  return { events, warnings };
}

function sanitizeOpportunityForAdmin(opp) {
  if (!opp || typeof opp !== 'object') return null;
  const isGaragePlan = opp.isGaragePlan === true
    || String(opp.source || '').includes('garage')
    || opp.stage === 'Multi-Vehicle Opportunity'
    || opp.segment === SEGMENTS.MULTI_VEHICLE_HOUSEHOLD;

  return {
    opportunityId: opp.opportunityId,
    householdId: opp.householdId,
    leadId: opp.leadId,
    segment: opp.segment,
    vehicleCountBand: opp.vehicleCountBand,
    assetCategories: opp.assetCategories || [],
    selectedCategory: opp.selectedCategory,
    selectedPackage: opp.selectedPackage,
    estimatedValue: Number(opp.estimatedValue) || 0,
    source: opp.source,
    campaign: opp.campaign,
    lastBookingStep: opp.lastBookingStep,
    intentScore: Number(opp.intentScore) || 0,
    householdValueScore: Number(opp.householdValueScore) || 0,
    commercialPriority: opp.commercialPriority,
    leadTemperature: opp.leadTemperature,
    consentStatus: opp.consentStatus,
    nextAction: opp.nextAction,
    assignedStatus: opp.assignedStatus || opp.garagePlanStatus || 'unassigned',
    garagePlanStatus: opp.garagePlanStatus || (isGaragePlan ? 'new' : null),
    isGaragePlan,
    notificationStatus: opp.notificationStatus || null,
    customerName: opp.customerName || null,
    customerPhone: opp.customerPhone || null,
    customerEmail: opp.customerEmail || null,
    zip: opp.zip || null,
    vehicleCount: opp.vehicleCount || null,
    sameLocationSameVisit: opp.sameLocationSameVisit === true,
    maintenanceFrequency: opp.maintenanceFrequency || null,
    gpReference: opp.opportunityId
      ? ('GP-' + String(opp.opportunityId).replace(/^opp_?/i, '').slice(-10).toUpperCase())
      : null,
    lostReason: opp.lostReason,
    stage: opp.stage,
    updatedAt: opp.updatedAt,
    createdAt: opp.createdAt,
  };
}

async function loadOpportunities({ limit = MAX_OPPORTUNITIES, segment, priority } = {}) {
  const store = await revenueStore.getRevenueStore('opportunities');
  const warnings = [];
  let keys = [];
  try {
    keys = (await revenueStore.blobListKeys(store, { limit: Math.min(limit * 3, 600) }))
      .filter((k) => k.startsWith('opp_'));
  } catch (e) {
    return { items: [], warnings: ['opportunities_list_failed'] };
  }

  const out = [];
  let malformed = 0;
  for (const key of keys) {
    const opp = await revenueStore.blobGetJson(store, key);
    if (isQaFixtureRecord(opp)) continue;
    const safe = sanitizeOpportunityForAdmin(opp);
    if (!safe || !safe.opportunityId) {
      malformed++;
      continue;
    }
    if (segment && safe.segment !== segment) continue;
    if (priority && safe.commercialPriority !== priority) continue;
    out.push(safe);
    if (out.length >= limit) break;
  }

  if (malformed) warnings.push(`skipped_malformed_opportunities:${malformed}`);
  out.sort((a, b) => (b.intentScore || 0) - (a.intentScore || 0));
  return { items: out, warnings };
}

function countEventsByName(events) {
  const counts = {};
  for (const ev of events) {
    counts[ev.event] = (counts[ev.event] || 0) + 1;
  }
  return counts;
}

function buildFunnel(eventCounts) {
  return FUNNEL_STEPS.map((step) => {
    const aliases = EVENT_ALIASES[step.key] || [step.key];
    const count = aliases.reduce((sum, name) => sum + (eventCounts[name] || 0), 0);
    return { step: step.key, label: step.label, count };
  });
}

function buildBreakdowns(events) {
  const sources = {};
  const categories = {};
  const pages = {};

  for (const ev of events) {
    const p = ev.properties || {};
    const src = p.source || p.utm_source || 'direct';
    sources[src] = (sources[src] || 0) + 1;
    const cat = p.category || p.vehicle_category || 'unknown';
    categories[cat] = (categories[cat] || 0) + 1;
    const page = p.page_type || p.page || 'unknown';
    pages[page] = (pages[page] || 0) + 1;
  }

  const toSorted = (map) => Object.entries(map)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  return {
    sources: toSorted(sources),
    categories: toSorted(categories),
    pages: toSorted(pages),
  };
}

function buildSummary(eventCounts, opportunities) {
  const pipelineValue = opportunities.reduce((s, o) => s + (Number(o.estimatedValue) || 0), 0);
  const ticketCount = opportunities.filter((o) => o.estimatedValue > 0).length;
  const avgTicket = ticketCount ? Math.round((pipelineValue / ticketCount) * 100) / 100 : 0;

  return {
    sessions: eventCounts.session_started || eventCounts.page_view || 0,
    servicePageViews: eventCounts.service_page_view || eventCounts.page_view || 0,
    packageSelections: (eventCounts.package_selected || 0) + (eventCounts.package_viewed || 0),
    bookingStarts: eventCounts.booking_started || 0,
    contactCaptures: (eventCounts.contact_captured || 0) + (eventCounts.lead_created || 0),
    paymentStepReaches: eventCounts.payment_step_reached || eventCounts.payment_step_viewed || 0,
    bookingSubmissions: eventCounts.booking_submitted || 0,
    garagePlanRequests: (eventCounts.garage_plan_completed || 0) + (eventCounts.garage_plan_started || 0),
    confirmedBookings: eventCounts.booking_confirmed || 0,
    completedServices: eventCounts.service_completed || 0,
    estimatedPipelineValue: pipelineValue,
    averageEstimatedTicket: avgTicket,
    opportunityCount: opportunities.length,
    hubspotEnabled: hubspotEnabled(),
    stages: PIPELINE_STAGES,
    lostReasons: LOST_REASONS,
    eventCounts,
  };
}

function buildPriorityQueue(opportunities) {
  const items = opportunities.filter((o) => {
    if (o.stage === 'Lost' || o.stage === 'Confirmed' || o.garagePlanStatus === 'won' || o.garagePlanStatus === 'lost') {
      return false;
    }
    if (o.garagePlanStatus === 'converted_to_booking') return false;
    return (
      o.commercialPriority === 'immediate_follow_up'
      || o.commercialPriority === 'priority'
      || o.commercialPriority === 'scheduled'
      || o.commercialPriority === 'high_value'
      || (o.intentScore >= 40)
      || o.leadTemperature === 'hot'
      || o.segment === SEGMENTS.SPECIALTY_ASSET_OWNER
      || o.segment === SEGMENTS.RETURNING_CUSTOMER
      || o.segment === SEGMENTS.RECURRING_MAINTENANCE_PROSPECT
      || o.segment === SEGMENTS.MULTI_VEHICLE_HOUSEHOLD
      || o.isGaragePlan
      || o.notificationStatus === 'failed'
      || ['2', '3-4', '5-6'].includes(o.vehicleCountBand)
      || (o.lastBookingStep && Number(o.lastBookingStep) >= 4 && o.stage !== 'Booking Requested')
    );
  });

  return items
    .sort((a, b) => (b.intentScore || 0) - (a.intentScore || 0))
    .slice(0, MAX_PRIORITY)
    .map((o) => ({
      ...o,
      attentionReason: o.notificationStatus === 'failed' ? 'failed_customer_notification'
        : o.isGaragePlan ? 'garage_plan_request'
        : (o.lastBookingStep && Number(o.lastBookingStep) >= 4 ? 'payment_step_abandonment' : 'high_intent_lead'),
    }));
}

function garagePlanOpportunities(opportunities) {
  return opportunities
    .filter((o) => o.isGaragePlan && o.garagePlanStatus !== 'converted_to_booking' && o.garagePlanStatus !== 'won')
    .slice(0, MAX_PRIORITY);
}

async function buildRevopsDashboard(query = {}) {
  const range = parseDateRange(query);
  const warnings = [];

  let eventResult = { events: [], warnings: [] };
  let oppResult = { items: [], warnings: [] };

  try {
    eventResult = await loadEventsInRange(range);
  } catch (e) {
    warnings.push('events_unavailable');
  }

  try {
    oppResult = await loadOpportunities({
      limit: MAX_OPPORTUNITIES,
      segment: query.segment,
      priority: query.priority,
    });
  } catch (e) {
    warnings.push('opportunities_unavailable');
  }

  warnings.push(...(eventResult.warnings || []), ...(oppResult.warnings || []));

  const eventCounts = countEventsByName(eventResult.events);
  const opportunities = oppResult.items;
  const summary = buildSummary(eventCounts, opportunities);
  const funnel = buildFunnel(eventCounts);
  const breakdowns = buildBreakdowns(eventResult.events);
  const priorityQueue = buildPriorityQueue(opportunities);
  const garagePlans = garagePlanOpportunities(opportunities);

  return safeRecord({
    ok: true,
    generatedAt: new Date().toISOString(),
    range: { from: range.from, to: range.to },
    summary,
    funnel,
    sources: breakdowns.sources,
    categories: breakdowns.categories,
    pages: breakdowns.pages,
    priorityQueue,
    garagePlanOpportunities: garagePlans,
    opportunities: opportunities.slice(0, Number(query.limit) || 50),
    warnings,
    // Legacy fields for existing UI paths
    eventCounts: summary.eventCounts,
    estimatedPipelineValue: summary.estimatedPipelineValue,
    opportunityCount: summary.opportunityCount,
    hubspotEnabled: summary.hubspotEnabled,
    stages: summary.stages,
    lostReasons: summary.lostReasons,
  });
}

function newRequestId() {
  return `revops_${crypto.randomBytes(6).toString('hex')}`;
}

module.exports = {
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  GARAGE_PLAN_STATUSES,
  parseDateRange,
  blobListKeys,
  loadEventsInRange,
  loadOpportunities,
  buildRevopsDashboard,
  sanitizeOpportunityForAdmin,
  buildPriorityQueue,
  newRequestId,
};
