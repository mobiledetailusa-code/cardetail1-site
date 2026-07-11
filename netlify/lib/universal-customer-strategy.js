// Universal Customer Strategy — backend authoritative (loads shared config).

const { createUniversalStrategy } = require('./universal-customer-strategy-logic');
const { classifySegment } = require('./revenue-segments');

const config = require('./universal-customer-strategy-config.json');
const strategy = createUniversalStrategy(config, { classifySegment });

module.exports = strategy;
