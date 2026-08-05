'use strict';

const { validateTwilioWebhook } = require('../lib/twilio-webhook');
const { revokeSmsConsentByPhone } = require('../lib/sms-consent-service');

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const HELP_WORDS = new Set(['HELP', 'INFO']);

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
  // Advanced Opt-Out sends the configured STOP/HELP response. Returning empty
  // TwiML prevents a duplicate application-generated message.
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' },
    body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
  };
};

exports.keyword = keyword;
