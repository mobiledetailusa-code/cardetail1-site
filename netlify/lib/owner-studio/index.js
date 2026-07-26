'use strict';

const ids = require('./ids');
const money = require('./money');
const flags = require('./flags');
const schemas = require('./schemas');
const store = require('./store');
const audit = require('./audit');
const authorization = require('./authorization');
const draftService = require('./draft-service');
const releaseService = require('./release-service');
const catalogRead = require('./catalog-read');
const contentRead = require('./content-read');
const snapshot = require('./snapshot');
const bookingSnapshot = require('./booking-snapshot');
const catalogRepository = require('./catalog-repository');
const catalogSchemaHealth = require('./catalog-schema-health');
const importer = require('./importer');

module.exports = {
  ...ids,
  ...money,
  ...flags,
  ...schemas,
  ...store,
  ...audit,
  ...authorization,
  ...draftService,
  ...releaseService,
  ...catalogRead,
  ...contentRead,
  ...snapshot,
  ...bookingSnapshot,
  ...catalogRepository,
  ...catalogSchemaHealth,
  ...importer,
};
