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

function buildForwardedSmsBody({ from, body } = {}) {
  const sender = normalizeE164(from) || 'unknown number';
  const text = clean(body);
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
 */
function inboundSmsTwiml(params = {}, env = process.env) {
  const target = smsForwardTarget(env);
  if (!target) return { forwarded: false, reason: 'no_target', body: EMPTY_TWIML };
  if (isControlKeyword(params.Body)) {
    return { forwarded: false, reason: 'control_keyword', body: EMPTY_TWIML };
  }
  const message = buildForwardedSmsBody({ from: params.From, body: params.Body });
  const inner = `<Message to="${escapeXml(target)}">${escapeXml(message)}</Message>`;
  return { forwarded: true, target, body: twimlResponse(inner) };
}

/**
 * TwiML for an inbound voice webhook. Bridges the caller to the configured
 * personal number via <Dial> when set; otherwise plays a short unavailable
 * message and hangs up.
 */
function inboundCallTwiml(params = {}, env = process.env) {
  const target = callForwardTarget(env);
  if (!target) {
    const inner = '<Say voice="alice">Thank you for calling Cardetail1. '
      + 'We are unable to take your call right now. Please try again later or leave a text message.</Say>'
      + '<Hangup/>';
    return { forwarded: false, reason: 'no_target', body: twimlResponse(inner) };
  }
  // callerId must be a number owned by (or verified on) the Twilio account, so
  // use the dialed business number rather than spoofing the caller. The owner
  // still recognizes the business line and can call back through it.
  const callerId = normalizeE164(params.To) || target;
  const dialAttrs = `callerId="${escapeXml(callerId)}" answerOnBridge="true" timeout="20"`;
  const inner = `<Dial ${dialAttrs}><Number>${escapeXml(target)}</Number></Dial>`;
  return { forwarded: true, target, callerId, body: twimlResponse(inner) };
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
  twimlResponse,
  EMPTY_TWIML,
  buildForwardedSmsBody,
  inboundSmsTwiml,
  inboundCallTwiml,
};
