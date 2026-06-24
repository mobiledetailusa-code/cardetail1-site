// netlify/functions/chat-insights.js
// Admin-only endpoint to retrieve chat interaction logs from Netlify Blobs.
// Protected by x-admin-key header. Returns aggregated insights for the admin panel.
// Logs contain ONLY safe fields: timestamp, question snippet, detected intent,
// response type, and whether fallback was used. No PII, no payment data, no secrets.

async function getStore() {
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID || '';
  const token = process.env.NETLIFY_TOKEN || process.env.BLOB_TOKEN || '';
  const { getStore } = await import('@netlify/blobs');
  return (siteID && token)
    ? getStore({ name: 'cd1-chat-logs', siteID, token })
    : getStore('cd1-chat-logs');
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'method_not_allowed' }) };

  const adminKey = event.headers['x-admin-key'] || '';
  const storedKey = process.env.ADMIN_KEY || '';
  if (!storedKey || adminKey !== storedKey) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  try {
    const store = await getStore();
    const days = parseInt(event.queryStringParameters?.days || '7', 10);
    const maxDays = Math.min(Math.max(days, 1), 30);

    const allLogs = [];
    const now = new Date();
    for (let i = 0; i < maxDays; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = `log-${d.toISOString().slice(0, 10)}`;
      try {
        const dayLogs = await store.get(key, { type: 'json' });
        if (Array.isArray(dayLogs)) allLogs.push(...dayLogs);
      } catch (_) { /* no logs for this day */ }
    }

    const total = allLogs.length;
    const fallbackCount = allLogs.filter(l => l.fallback).length;
    const injectionCount = allLogs.filter(l => l.intent === 'injection_blocked').length;
    const aiAnswered = allLogs.filter(l => l.responseType === 'ai').length;

    // Unanswered / fallback questions (most useful for improving FAQ)
    const unanswered = allLogs
      .filter(l => l.fallback && l.intent !== 'no_ai_key')
      .map(l => ({ ts: l.ts, question: l.question, reason: l.responseType }))
      .slice(-50);

    // Intent frequency
    const intentCounts = {};
    allLogs.forEach(l => {
      const k = l.intent || 'unknown';
      intentCounts[k] = (intentCounts[k] || 0) + 1;
    });

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        ok: true,
        period: `${maxDays} days`,
        total,
        aiAnswered,
        fallbackCount,
        injectionCount,
        intentCounts,
        unanswered
      })
    };
  } catch (e) {
    console.error('chat-insights error', e);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'internal' }) };
  }
};
