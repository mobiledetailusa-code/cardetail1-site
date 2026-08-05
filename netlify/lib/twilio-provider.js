'use strict';

const twilio = require('twilio');
const { outboundTwilioPolicy } = require('./twilio-runtime-policy');

function createTwilioProvider(env = process.env, opts = {}) {
  const policy = outboundTwilioPolicy(env);
  if (!policy.ok) return { ok: false, reason: policy.reason };
  const client = opts.client || twilio(policy.apiKey, policy.apiSecret, {
    accountSid: policy.accountSid,
  });
  return {
    ok: true,
    async send({ to, body }) {
      const message = await client.messages.create({
        to,
        body,
        messagingServiceSid: policy.messagingServiceSid,
        statusCallback: policy.statusCallbackUrl,
      });
      return {
        sid: String(message.sid || ''),
        status: String(message.status || 'accepted').toLowerCase(),
      };
    },
  };
}

module.exports = { createTwilioProvider };
