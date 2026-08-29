'use strict';

const { validateTwilioWebhook } = require('../lib/twilio-webhook');
const { revokeSmsConsentByPhone } = require('../lib/sms-consent-service');
const { inboundSmsTwiml } = require('../lib/twilio-forwarding');

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const HELP_WORDS = new Set(['HELP', 'INFO']);

// Advanced Opt-Out sends the configured STOP/HELP response, so the app must
// not add a duplicate reply for control keywords (or when relay is
// unconfigured): return empty TwiML in those cases.
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function keyword(params = {}) {
  const advanced = String(params.OptOutType || '').trim().toUpperCase();
  if (['STOP', 'HELP', 'START'].includes(advanced)) return advanced;
  const body = String(params.Body || '').trim().toUpperCase();
  if (STOP_WORDS.has(body)) return 'STOP';
  if (HELP_WORDS.has(body)) return 'HELP';
  return '';
}

exports.handler = async (event = {}) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };
  const verified = validateTwilioWebhook(event, 'inbound');
  if (!verified.ok) return { statusCode: verified.statusCode || 403, body: '' };
  const type = keyword(verified.params);
  if (type === 'STOP') {
    const result = await revokeSmsConsentByPhone(verified.params.From);
    if (!result.ok) return { statusCode: 503, body: '' };
  }
  // Control keywords (STOP/HELP/…) get the empty opt-out reply. Any other
  // inbound message is relayed to the configured personal number when
  // forwarding is set up; otherwise the response is also empty.
  const relay = inboundSmsTwiml(verified.params);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' },
    body: relay.forwarded ? relay.body : EMPTY_TWIML,
  };
};

exports.keyword = keyword;
