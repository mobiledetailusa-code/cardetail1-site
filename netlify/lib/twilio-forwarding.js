'use strict';

/**
 * Inbound relay to a personal number, expressed entirely as TwiML responses.
 *
 * Fail-closed by construction:
 * - The webhook handlers only reach this module after signature validation
 *   behind the production runtime policy (see twilio-runtime-policy.js).
 * - Relaying happens only when an operator has configured a destination number.
 * - No outbound Twilio REST call is made here; forwarding is the TwiML the
 *   provider executes on the inbound message/call. That keeps `messages.create`
 *   confined to lib/twilio-provider.js (enforced by twilio-readiness tests).
 */

const E164 = /^\+[1-9]\d{7,14}$/;

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeE164(value) {
  const candidate = clean(value);
  return E164.test(candidate) ? candidate : '';
}

// STOP/HELP/START and their aliases are compliance-managed opt-out keywords.
// They are handled by the consent webhook and must never be relayed to a
// personal phone (relaying them would also break the empty-reply contract).
const CONTROL_KEYWORDS = new Set([
  'STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT',
  'HELP', 'INFO',
  'START', 'YES', 'UNSTOP',
]);

function isControlKeyword(body) {
  return CONTROL_KEYWORDS.has(clean(body).toUpperCase());
}

function smsForwardTarget(env = process.env) {
  return normalizeE164(env.TWILIO_FORWARD_SMS_TO || env.TWILIO_PERSONAL_NUMBER);
}

function callForwardTarget(env = process.env) {
  return normalizeE164(env.TWILIO_FORWARD_CALLS_TO || env.TWILIO_PERSONAL_NUMBER);
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twimlResponse(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

const EMPTY_TWIML = twimlResponse('');

// A single inbound SMS must never fan out into an expensive multi-segment
// relay. Twilio concatenates up to 1600 chars; keep the relay well under.
const MAX_FORWARD_BODY = 1200;

// Strip anything that looks like a booking appointment-access token so an
// access-granting link a customer quotes back is never relayed onward. Covers
// the opaque token (aat_…) and the ?t=/&t= access-URL query parameter.
function redactAccessTokens(text) {
  return String(text == null ? '' : text)
    .replace(/aat_[A-Za-z0-9_-]+/g, '[redacted-token]')
    .replace(/([?&]t=)[^\s&]+/g, '$1[redacted]');
}

function buildForwardedSmsBody({ from, body } = {}) {
  const sender = normalizeE164(from) || 'unknown number';
  const text = redactAccessTokens(clean(body));
  const trimmed = text.length > MAX_FORWARD_BODY
    ? `${text.slice(0, MAX_FORWARD_BODY)}…`
    : text;
  const suffix = trimmed ? `: ${trimmed}` : ' (no text content)';
  return `Cardetail1 fwd from ${sender}${suffix}`;
}

/**
 * TwiML for an inbound SMS webhook. Relays the message to the configured
 * personal number via <Message to="…"> when a destination is set and the body
 * is not a control keyword; otherwise returns an empty <Response/>.
 *
 * Relay-loop guard: never relay a message whose sender is the destination
 * itself (e.g. the owner replying to a forwarded text, which arrives back at
 * the business number). That would ping-pong business ↔ owner indefinitely.
 */
function inboundSmsTwiml(params = {}, env = process.env) {
  const target = smsForwardTarget(env);
  if (!target) return { forwarded: false, reason: 'no_target', body: EMPTY_TWIML };
  if (isControlKeyword(params.Body)) {
    return { forwarded: false, reason: 'control_keyword', body: EMPTY_TWIML };
  }
  if (normalizeE164(params.From) === target) {
    return { forwarded: false, reason: 'loop_guard', body: EMPTY_TWIML };
  }
  const message = buildForwardedSmsBody({ from: params.From, body: params.Body });
  const inner = `<Message to="${escapeXml(target)}">${escapeXml(message)}</Message>`;
  return { forwarded: true, target, body: twimlResponse(inner) };
}

function unavailableCallTwiml(reason) {
  const inner = '<Say voice="alice">Thank you for calling Cardetail1. '
    + 'We are unable to take your call right now. Please try again later or leave a text message.</Say>'
    + '<Hangup/>';
  return { forwarded: false, reason, body: twimlResponse(inner) };
}

/**
 * TwiML for an inbound voice webhook. Bridges the caller to the configured
 * personal number via <Dial> when set; otherwise plays a short unavailable
 * message and hangs up (bounded fallback — no dial).
 *
 * Caller ID is ALWAYS the dialed business number (params.To). Twilio only
 * allows an owned/verified number as callerId, so we never spoof the customer
 * and never fall back to the personal number as callerId. If the business
 * number is not a valid E.164 the call fails closed to the unavailable
 * message. Relay-loop guard: never dial when the caller is the destination.
 */
function inboundCallTwiml(params = {}, env = process.env) {
  const target = callForwardTarget(env);
  if (!target) return unavailableCallTwiml('no_target');
  if (normalizeE164(params.From) === target) return unavailableCallTwiml('loop_guard');
  const businessCallerId = normalizeE164(params.To);
  if (!businessCallerId) return unavailableCallTwiml('no_business_caller_id');
  const dialAttrs = `callerId="${escapeXml(businessCallerId)}" answerOnBridge="true" timeout="20"`;
  const inner = `<Dial ${dialAttrs}><Number>${escapeXml(target)}</Number></Dial>`;
  return { forwarded: true, target, callerId: businessCallerId, body: twimlResponse(inner) };
}

module.exports = {
  E164,
  MAX_FORWARD_BODY,
  clean,
  normalizeE164,
  isControlKeyword,
  smsForwardTarget,
  callForwardTarget,
  escapeXml,
  redactAccessTokens,
  twimlResponse,
  EMPTY_TWIML,
  buildForwardedSmsBody,
  inboundSmsTwiml,
  inboundCallTwiml,
};
