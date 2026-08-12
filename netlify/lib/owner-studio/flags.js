'use strict';

function flag(name, defaultValue = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return defaultValue;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function getOwnerStudioFlags() {
  const enabled = flag('OWNER_STUDIO_ENABLED', false);
  const sourceRaw = String(process.env.PUBLIC_CONTENT_SOURCE || '').trim().toLowerCase();
  let publicContentSource = 'legacy';
  if (sourceRaw === 'owner-studio' || sourceRaw === 'owner_studio') {
    publicContentSource = 'owner-studio';
  } else if (!sourceRaw || sourceRaw === 'legacy') {
    publicContentSource = 'legacy';
  } else {
    // Unknown → safe legacy fallback
    publicContentSource = 'legacy';
  }

  // Never serve owner-studio publicly unless explicitly enabled
  if (publicContentSource === 'owner-studio' && !enabled) {
    publicContentSource = 'legacy';
  }

  const role = String(process.env.OWNER_STUDIO_ROLE || 'owner').trim().toLowerCase();
  return {
    enabled,
    publicContentSource,
    role: role === 'admin' ? 'admin' : 'owner',
    adminCanPublish: flag('OWNER_STUDIO_ADMIN_CAN_PUBLISH', false),
    // Dedicated kill switch for the release path, independent of OWNER_STUDIO_ENABLED.
    // Being the owner on an enabled site is not by itself consent to publish: the
    // roadmap names "accidental production publish" as a migration risk, and this is
    // the switch that has to be thrown deliberately, per environment, to allow it.
    // Publish is also refused outright whenever publicContentSource is owner-studio
    // without this flag, so enabling the read path can never imply the write path.
    publishEnabled: flag('OWNER_STUDIO_PUBLISH_ENABLED', false),
  };
}

function useLegacyPublicContent() {
  return getOwnerStudioFlags().publicContentSource === 'legacy';
}

module.exports = {
  flag,
  getOwnerStudioFlags,
  useLegacyPublicContent,
};
