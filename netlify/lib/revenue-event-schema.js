// Revenue event dictionary, allowlists, GA4 mapping, and payload validation.

const APPROVED_EVENTS = Object.freeze([
  'page_view', 'service_page_view', 'city_page_view', 'hub_page_view',
  'offer_viewed', 'promotion_selected', 'package_view', 'package_selected',
  'zip_check_started', 'zip_check_valid', 'zip_check_rejected',
  'booking_started', 'booking_step_viewed', 'booking_step_completed',
  'contact_captured', 'vehicle_added', 'multi_vehicle_detected',
  'garage_plan_started', 'garage_plan_completed',
  'schedule_selected', 'payment_step_viewed', 'payment_method_saved',
  'booking_submitted', 'booking_confirmed', 'booking_error', 'booking_closed',
  'booking_resumed', 'quote_requested', 'fleet_quote_requested',
  'click_call', 'click_text', 'chat_opened', 'chat_pricing_question',
  'lead_created', 'lead_qualified', 'lead_contacted', 'lead_lost',
  'service_completed', 'maintenance_interest', 'rebooking_started',
  'rebooking_completed', 'referral_interest', 'gift_card_interest',
  'flexible_payment_interest',
  // Booking conversion funnel (non-PII)
  'utilities_completed', 'date_selected', 'flexibility_selected',
  'weekend_date_selected', 'selected_slot_unavailable', 'nearby_slots_opened',
  'booking_review_reached', 'setup_intent_started',
  'booking_submit_attempted', 'booking_submit_succeeded', 'booking_submit_failed',
  'arrival_window_selected',
]);

const APPROVED_PROPERTIES = Object.freeze([
  'event_id', 'anonymous_session_id', 'timestamp', 'source_page', 'landing_page',
  'page_type', 'category', 'package_id', 'estimated_value', 'currency',
  'vehicle_count_band', 'asset_category_count', 'zip_zone', 'booking_step',
  'vehicle_type', 'device_type', 'utm_source', 'utm_medium', 'utm_campaign',
  'utm_content', 'referrer_domain', 'lead_temperature', 'household_segment',
  'error_code', 'offer_id', 'multi_vehicle_band',
  'flexibility_mode', 'weekend_selected', 'funnel_step', 'failure_code',
  'service_category',
]);

const PII_PROPERTY_KEYS = Object.freeze([
  'name', 'email', 'phone', 'address', 'zip', 'zip_code', 'full_zip',
  'customer_notes', 'notes', 'chat_transcript', 'vin', 'license_plate',
  'card_data', 'stripe_token', 'access_token', 'resume_token', 'token',
  'photo', 'photos', 'message', 'first_name', 'last_name', 'street',
  'gclid', 'gbraid', 'wbraid', 'msclkid', 'fbclid', 'utm_term',
]);

const GA4_EVENT_MAP = Object.freeze({
  lead_created: 'generate_lead',
  lead_qualified: 'qualify_lead',
  lead_lost: 'close_unconvert_lead',
  lead_contacted: 'working_lead',
  booking_confirmed: 'close_convert_lead',
  service_completed: 'close_convert_lead',
  package_view: 'view_item',
  package_selected: 'select_item',
  offer_viewed: 'view_promotion',
  promotion_selected: 'select_promotion',
  booking_started: 'begin_checkout',
  payment_method_saved: 'add_payment_info',
  booking_submitted: 'purchase',
});

const PRIMARY_CONVERSION_EVENTS = Object.freeze([
  'lead_created', 'booking_submitted', 'booking_confirmed', 'service_completed',
]);

const MAX_PAYLOAD_BYTES = 8192;
const MAX_PROPERTY_VALUE_LEN = 256;

function sanitizePropertyValue(key, value) {
  if (value == null) return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return value;
  }
  if (typeof value === 'boolean') return value;
  const str = String(value).trim().slice(0, MAX_PROPERTY_VALUE_LEN);
  return str || undefined;
}

function sanitizeProperties(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    const k = String(key).trim();
    if (!k || PII_PROPERTY_KEYS.includes(k)) continue;
    if (!APPROVED_PROPERTIES.includes(k)) continue;
    const v = sanitizePropertyValue(k, value);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function validateEventPayload(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'invalid_payload' };
  }
  const eventName = String(body.event || body.eventName || '').trim();
  if (!eventName || !APPROVED_EVENTS.includes(eventName)) {
    return { ok: false, error: 'unknown_event' };
  }
  const eventId = String(body.event_id || body.eventId || '').trim();
  if (!eventId || eventId.length > 128) {
    return { ok: false, error: 'invalid_event_id' };
  }
  const sessionId = String(body.anonymous_session_id || body.sessionId || '').trim();
  if (!sessionId || sessionId.length > 128) {
    return { ok: false, error: 'invalid_session_id' };
  }
  const properties = sanitizeProperties(body.properties || body);
  properties.event_id = eventId;
  properties.anonymous_session_id = sessionId;
  if (!properties.timestamp) {
    properties.timestamp = new Date().toISOString();
  }
  const serialized = JSON.stringify({ event: eventName, properties });
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    return { ok: false, error: 'payload_too_large' };
  }
  return { ok: true, event: eventName, eventId, sessionId, properties };
}

function mapToGa4(eventName, properties) {
  const ga4Event = GA4_EVENT_MAP[eventName];
  if (!ga4Event) return null;
  return { name: ga4Event, params: { ...properties, cardetail1_event: eventName } };
}

module.exports = {
  APPROVED_EVENTS,
  APPROVED_PROPERTIES,
  PII_PROPERTY_KEYS,
  GA4_EVENT_MAP,
  PRIMARY_CONVERSION_EVENTS,
  MAX_PAYLOAD_BYTES,
  sanitizeProperties,
  validateEventPayload,
  mapToGa4,
};
