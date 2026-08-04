/**
 * Admin alert for a customer-reported service issue.
 *
 * Best-effort by design. The issue record is already committed to the booking
 * before this runs, so a mail failure delays the alert but never loses the
 * report — Admin still sees it in the job's Customer Requests section.
 */

const ISSUE_CATEGORY_LABELS = Object.freeze({
  quality: 'Quality of work',
  damage: 'Damage',
  missed_area: 'Missed area',
  timeliness: 'Timeliness',
  billing: 'Billing',
  conduct: 'Conduct',
  other: 'Other',
});

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildAdminIssueEmail(booking, issue) {
  const reference = String((booking && (booking.id || booking.bookingId)) || '');
  const customer = [booking && booking.firstName, booking && booking.lastName]
    .filter(Boolean).join(' ').trim() || 'Customer';
  const label = ISSUE_CATEGORY_LABELS[issue.category] || 'Other';
  const subject = `Service issue reported — ${reference}`;
  const text = [
    'A customer reported a service issue.',
    '',
    `Booking: ${reference}`,
    `Customer: ${customer}`,
    `Category: ${label}`,
    `Reported at: ${issue.createdAt}`,
    `Service completed at: ${issue.completedAt || 'unknown'}`,
    '',
    'Description:',
    issue.description,
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
<p><strong>A customer reported a service issue.</strong></p>
<ul>
<li>Booking: ${escapeHtml(reference)}</li>
<li>Customer: ${escapeHtml(customer)}</li>
<li>Category: ${escapeHtml(label)}</li>
<li>Reported at: ${escapeHtml(issue.createdAt)}</li>
<li>Service completed at: ${escapeHtml(issue.completedAt || 'unknown')}</li>
</ul>
<p><strong>Description</strong><br>${escapeHtml(issue.description)}</p>
</body></html>`;
  return { subject, text, html };
}

async function notifyAdminOfServiceIssue(booking, issue, opts = {}) {
  const env = opts.env || process.env;
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const to = String(env.ADMIN_EMAIL || '').trim();
  const from = String(env.RESEND_FROM || '').trim();
  if (!apiKey) return { sent: false, skipped: true, reason: 'email_not_configured' };
  if (!to) return { sent: false, skipped: true, reason: 'no_admin_email' };

  const content = buildAdminIssueEmail(booking, issue);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: from || 'Detailing Zone <onboarding@resend.dev>',
        to: [to],
        subject: content.subject,
        text: content.text,
        html: content.html,
      }),
    });
    if (!res.ok) {
      // Provider bodies can carry account detail — record the status, not the body.
      return { sent: false, reason: `provider_${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: 'network_error' };
  }
}

module.exports = {
  ISSUE_CATEGORY_LABELS,
  buildAdminIssueEmail,
  notifyAdminOfServiceIssue,
};
