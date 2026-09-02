'use strict';

const { validateTwilioWebhook } = require('../lib/twilio-webhook');
const { inboundCallTwiml } = require('../lib/twilio-forwarding');

// Inbound voice webhook. Bridges callers to the configured personal number via
// TwiML <Dial>. Fail-closed: signature validation runs behind the production
// runtime policy, so previews/unsigned requests never forward a call.
exports.handler = async (event = {}) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };
  const verified = validateTwilioWebhook(event, 'voice');
  if (!verified.ok) return { statusCode: verified.statusCode || 403, body: '' };
  const relay = inboundCallTwiml(verified.params);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' },
    body: relay.body,
  };
};
