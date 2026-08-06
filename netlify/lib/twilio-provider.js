'use strict';

const { outboundTwilioPolicy } = require('./twilio-runtime-policy');

// The SDK is loaded lazily, behind the runtime policy gate. Requiring it at
// module scope pulled the whole Twilio dependency graph into the cold start of
// every function on the checkout path — including when Twilio is disabled —
// where a load failure surfaces as a non-JSON 500 the browser cannot parse.
function createTwilioProvider(env = process.env, opts = {}) {
  const policy = outboundTwilioPolicy(env);
  if (!policy.ok) return { ok: false, reason: policy.reason };
  let client = opts.client;
  if (!client) {
    let twilio;
    try {
      twilio = require('twilio');
    } catch (e) {
      return { ok: false, reason: 'twilio_sdk_unavailable' };
    }
    client = twilio(policy.apiKey, policy.apiSecret, {
      accountSid: policy.accountSid,
    });
  }
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
