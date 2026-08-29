'use strict';

const { validateTwilioWebhook } = require('../lib/twilio-webhook');
const { normalizeUsPhoneE164 } = require('../lib/phone-auth');
const { adminE164, handleMissedCall, EMPTY_TWIML, last4FromE164 } = require('../lib/sms-bridge');

function xmlAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isE164(value) {
  return /^\+[1-9]\d{7,14}$/.test(String(value || ''));
}

function emptyTwiml() {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' },
    body: EMPTY_TWIML,
  };
}

function sayTwiml(message) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' },
    body: `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-US">${xmlAttr(message)}</Say></Response>`,
  };
}

function dialTwiml({ callerId, destination, actionUrl }) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' },
    body: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Response>',
      `<Dial callerId="${xmlAttr(callerId)}" timeout="24" answerOnBridge="true" action="${xmlAttr(actionUrl)}">`,
      `<Number>${xmlAttr(destination)}</Number>`,
      '</Dial>',
      '</Response>',
    ].join(''),
  };
}

function inboundDialResponse(params, voiceUrl, env = process.env) {
  const owner = adminE164(env);
  const callerId = normalizeUsPhoneE164(params.To || params.Called);
  const from = normalizeUsPhoneE164(params.From || params.Caller);
  if (!owner) {
    return sayTwiml('Cardetail1 is unavailable. Please try again later.');
  }
  if (from && from === owner) {
    return sayTwiml('This is Cardetail1.');
  }
  if (!isE164(callerId) || !isE164(owner) || !voiceUrl) {
    return sayTwiml('Cardetail1 is unavailable. Please try again later.');
  }
  return dialTwiml({ callerId, destination: owner, actionUrl: voiceUrl });
}

exports.handler = async (event = {}) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };
  const verified = validateTwilioWebhook(event, 'voice');
  if (!verified.ok) return { statusCode: verified.statusCode || 403, body: '' };
  if (verified.params.DialCallStatus) {
    await handleMissedCall(verified.params);
    return emptyTwiml();
  }
  return inboundDialResponse(verified.params, verified.url);
};

exports.inboundDialResponse = inboundDialResponse;
exports.last4FromE164 = last4FromE164;
exports.dialTwiml = dialTwiml;
