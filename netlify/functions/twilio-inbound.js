'use strict';

const { validateTwilioWebhook } = require('../lib/twilio-webhook');
const { complianceKeyword, handleInboundSms } = require('../lib/twilio-inbound-handler');

exports.handler = async (event = {}) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };
  const verified = validateTwilioWebhook(event, 'inbound');
  if (!verified.ok) return { statusCode: verified.statusCode || 403, body: '' };
  const result = await handleInboundSms(verified.params);
  if (!result.twiml) return { statusCode: result.statusCode || 503, body: '' };
  return {
    statusCode: result.statusCode || 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' },
    body: result.twiml,
  };
};

exports.keyword = complianceKeyword;
