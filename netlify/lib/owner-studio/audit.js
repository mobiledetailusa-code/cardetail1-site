'use strict';

const { getStore } = require('./store');
const { newId, assertSiteId } = require('./ids');

function appendAuditEvent(event) {
  const siteId = assertSiteId(event.siteId);
  const row = {
    id: newId('aud'),
    siteId,
    actor: String(event.actor || 'unknown'),
    action: String(event.action || 'unknown'),
    entityType: event.entityType || null,
    entityId: event.entityId || null,
    releaseId: event.releaseId || null,
    detail: event.detail || null,
    at: event.at || new Date().toISOString(),
  };
  getStore().audit.push(row);
  return row;
}

function listAuditEvents(siteId, limit = 100) {
  const id = assertSiteId(siteId);
  return getStore().audit.filter((a) => a.siteId === id).slice(-limit);
}

module.exports = {
  appendAuditEvent,
  listAuditEvents,
};
