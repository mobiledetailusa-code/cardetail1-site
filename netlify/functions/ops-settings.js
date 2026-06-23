// Admin platform settings — dispatch rules, bid max, auto-confirm.
const { jsonCors, verifyAdminKey } = require('../lib/tech-security');
const {
  getOpsSettings, saveOpsSettings, DEFAULT_SETTINGS, MAINTENANCE_PLAN_TEMPLATES,
} = require('../lib/ops-config');
const { syncTechRosterFromAccounts } = require('../lib/auction-ops');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return jsonCors(204, {});
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return jsonCors(405, { ok: false, error: 'method_not_allowed' });
  }

  const auth = verifyAdminKey(event.headers || {});
  if (!auth.ok) return jsonCors(auth.error === 'missing_admin_password_config' ? 503 : 401, { ok: false, error: auth.error });

  if (event.httpMethod === 'GET') {
    const settings = await getOpsSettings();
    return jsonCors(200, {
      ok: true,
      settings,
      defaults: DEFAULT_SETTINGS,
      maintenancePlanTemplates: MAINTENANCE_PLAN_TEMPLATES,
    });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonCors(400, { ok: false, error: 'invalid_json' }); }

  const action = String(body.action || 'update');

  if (action === 'sync_tech_roster') {
    const result = await syncTechRosterFromAccounts();
    return jsonCors(200, { ok: true, ...result });
  }

  const ALLOWED = [
    'autoConfirmAppointments', 'autoPostToAuctionOnConfirm', 'dispatchMode',
    'bidMaxPercent', 'bidMaxOverride', 'bidWindowMinutes', 'bidWindowMinutesBoatRv',
    'requireCompoundExperience', 'minTechRatingToBid', 'maintenancePlansEnabled',
  ];
  const patches = {};
  for (const k of ALLOWED) {
    if (body[k] !== undefined) patches[k] = body[k];
  }
  if (patches.bidMaxPercent != null) {
    patches.bidMaxPercent = Math.min(100, Math.max(1, Number(patches.bidMaxPercent) || 85));
  }
  if (patches.bidMaxOverride === '' || patches.bidMaxOverride === null) patches.bidMaxOverride = null;
  if (patches.minTechRatingToBid != null) {
    patches.minTechRatingToBid = Math.min(5, Math.max(0, Number(patches.minTechRatingToBid) || 0));
  }

  const settings = await saveOpsSettings(patches);
  return jsonCors(200, { ok: true, settings });
};
