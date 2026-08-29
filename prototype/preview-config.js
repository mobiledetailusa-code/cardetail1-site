/**
 * Preview environment detection — mock vs live data on Netlify deploy previews.
 */
(function (global) {
  const PARAM = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

  function host() {
    return (typeof location !== 'undefined' && location.hostname) || '';
  }

  function isPreviewHost() {
    const h = host();
    if (!h) return false;
    if (h === 'localhost' || h === '127.0.0.1') return true;
    if (h.includes('deploy-preview')) return true;
    if (h.includes('netlify.app') && !h.startsWith('www.')) return true;
    return false;
  }

  function forcedMode() {
    const m = (PARAM.get('mode') || '').toLowerCase();
    if (m === 'mock' || m === 'live') return m;
    return null;
  }

  function canUseLive() {
    if (forcedMode() === 'mock') return false;
    if (forcedMode() === 'live') return isPreviewHost() || host() === 'localhost';
    return isPreviewHost();
  }

  function loginUrls() {
    const root = typeof location !== 'undefined' ? location.origin : '';
    return {
      admin: root + '/admin',
      technician: root + '/technician',
      customer: root + '/my-garage',
    };
  }

  function previewBase() {
    const p = typeof location !== 'undefined' ? location.pathname : '';
    if (p.includes('/prototype/')) return p.replace(/\/[^/]*$/, '/');
    return '/prototype/';
  }

  global.CD1PreviewConfig = {
    isPreviewHost,
    canUseLive,
    forcedMode,
    loginUrls,
    previewBase,
    isMockForced: () => forcedMode() === 'mock',
    isLiveForced: () => forcedMode() === 'live',
  };
})(window);
