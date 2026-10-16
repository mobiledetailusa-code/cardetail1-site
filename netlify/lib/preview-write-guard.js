'use strict';

// deploy-preview and branch-deploy share the production blob store.
// Writes fail closed unless the caller is not in one of those contexts.
// A browser host, query parameter, or JSON field cannot clear the block.

const { deployContext, loadBakedDeployEnv } = require('./trusted-site-origin');

const SHARED_CONTEXTS = new Set(['deploy-preview', 'branch-deploy']);

const PREVIEW_MESSAGE = 'This is a preview. Nothing will be booked, charged, or sent.';

function contextOf(value) {
  return String(value || '').trim().toLowerCase();
}

function sharedPreviewContext() {
  let bakedCtx = '';
  try {
    const baked = loadBakedDeployEnv();
    bakedCtx = contextOf(baked && baked.CONTEXT);
  } catch {
    bakedCtx = '';
  }
  const liveCtx = contextOf(process.env.CONTEXT || process.env.NETLIFY_CONTEXT);
  if (SHARED_CONTEXTS.has(bakedCtx)) return bakedCtx;
  if (bakedCtx === 'production' && SHARED_CONTEXTS.has(liveCtx)) return liveCtx;
  if (!bakedCtx && SHARED_CONTEXTS.has(liveCtx)) return liveCtx;
  if (!bakedCtx && !liveCtx) {
    const inferred = deployContext();
    return SHARED_CONTEXTS.has(inferred) ? inferred : '';
  }
  return '';
}

function previewWriteBody(scope) {
  return {
    ok: false,
    error: 'preview_writes_disabled',
    scope: scope || 'write',
    stored: false,
    sent: false,
    message: PREVIEW_MESSAGE,
  };
}

function previewWriteResponse(scope, headers) {
  return {
    statusCode: 403,
    headers: Object.assign({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    }, headers || {}),
    body: JSON.stringify(previewWriteBody(scope)),
  };
}

function refuseSharedWrite(scope, headers) {
  if (!sharedPreviewContext()) return null;
  return previewWriteResponse(scope, headers);
}

module.exports = {
  PREVIEW_MESSAGE,
  sharedPreviewContext,
  previewWriteBody,
  previewWriteResponse,
  refuseSharedWrite,
};
