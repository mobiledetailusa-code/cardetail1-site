'use strict';

const { validateTwilioWebhook } = require('../lib/twilio-webhook');
const { applyStatusCallback } = require('../lib/sms-outbox');

exports.handler = async (event = {}) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: '' };
  }
  const verified = validateTwilioWebhook(event, 'status');
  if (!verified.ok) return { statusCode: verified.statusCode || 403, body: '' };
  const result = await applyStatusCallback({
    providerMessageSid: verified.params.MessageSid || verified.params.SmsSid,
    providerStatus: verified.params.MessageStatus || verified.params.SmsStatus,
    errorCode: verified.params.ErrorCode || null,
  });
  if (!result.ok && result.statusCode === 400) return { statusCode: 400, body: '' };
  if (!result.ok && result.statusCode !== 404) return { statusCode: 503, body: '' };
  return { statusCode: 204, body: '' };
};
