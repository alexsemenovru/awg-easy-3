'use strict';
const { normalizeGeoPolicy } = require('./GeoIpPolicy');
function normalizeGeoExit(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'countries,exitNodeId,mode'
    || !['include', 'exclude'].includes(value.mode)
    || typeof value.exitNodeId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.exitNodeId)) {
    throw new TypeError('Invalid GeoIP exit selection');
  }
  const policy = normalizeGeoPolicy({ mode: 'block', countries: value.countries });
  return Object.freeze({ mode: value.mode, countries: policy.countries, exitNodeId: value.exitNodeId });
}
module.exports = { normalizeGeoExit };
