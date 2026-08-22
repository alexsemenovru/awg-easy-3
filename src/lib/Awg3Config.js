'use strict';

const crypto = require('node:crypto');

const UINT16_MAX = 65_535;
const UINT32_MAX = 4_294_967_295;

const INTERFACE_FIELD_ORDER = [
  ['jc', 'Jc'],
  ['jmin', 'Jmin'],
  ['jmax', 'Jmax'],
  ['s1', 'S1'],
  ['s2', 'S2'],
  ['s3', 'S3'],
  ['s4', 'S4'],
  ['h1', 'H1'],
  ['h2', 'H2'],
  ['h3', 'H3'],
  ['h4', 'H4'],
  ['i1', 'I1'],
  ['i2', 'I2'],
  ['i3', 'I3'],
  ['i4', 'I4'],
  ['i5', 'I5'],
  ['headerProtectionKey', 'HeaderProtectionKey'],
  ['contentPaddingAddition', 'ContentPaddingAddition'],
  ['rekeyAfterTime', 'RekeyAfterTime'],
  ['rekeyTimeout', 'RekeyTimeout'],
  ['rejectAfterTime', 'RejectAfterTime'],
  ['keepaliveTimeout', 'KeepaliveTimeout'],
  ['maxHandshakeAttempts', 'MaxHandshakeAttempts'],
  ['randomTrailers', 'RandomTrailers'],
  ['disableCookies', 'DisableCookies'],
];

const REQUIRED_FIELDS = [
  'jc', 'jmin', 'jmax',
  's1', 's2', 's3', 's4',
  'h1', 'h2', 'h3', 'h4',
  'headerProtectionKey',
];

const RANGE_FIELDS_UINT16 = [
  'contentPaddingAddition',
  'rekeyAfterTime',
  'rekeyTimeout',
  'rejectAfterTime',
  'keepaliveTimeout',
  'maxHandshakeAttempts',
];

const HEADER_FIELDS = ['h1', 'h2', 'h3', 'h4'];
const PADDING_FIELDS = ['s1', 's2', 's3', 's4'];

const OFFICIAL_DEFAULTS = Object.freeze({
  jmin: 10,
  jmax: 50,
  h1: '1',
  h2: '2',
  h3: '3',
  h4: '4',
  i1: '<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>',
  contentPaddingAddition: '10-100',
  rekeyAfterTime: '100-120',
  rekeyTimeout: '3-7',
  rejectAfterTime: '150-180',
  keepaliveTimeout: '5-15',
  maxHandshakeAttempts: '15-20',
  randomTrailers: true,
  disableCookies: true,
});

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const parseInteger = (value, field, max) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new TypeError(`${field} must be an integer between 0 and ${max}`);
  }
  return parsed;
};

const parseRange = (value, field, max) => {
  if (typeof value === 'number') {
    const parsed = parseInteger(value, field, max);
    return { min: parsed, max: parsed, text: String(parsed) };
  }

  if (typeof value !== 'string' || !/^\d+(?:-\d+)?$/.test(value)) {
    throw new TypeError(`${field} must be an integer or min-max range`);
  }

  const [rawMin, rawMax = rawMin] = value.split('-');
  const min = parseInteger(Number(rawMin), field, max);
  const rangeMax = parseInteger(Number(rawMax), field, max);
  if (min > rangeMax) {
    throw new RangeError(`${field} range minimum must not exceed its maximum`);
  }
  return { min, max: rangeMax, text: min === rangeMax ? String(min) : `${min}-${rangeMax}` };
};

const parseBoolean = (value, field) => {
  if (value === true || value === 'on' || value === 'true' || value === 1) return true;
  if (value === false || value === 'off' || value === 'false' || value === 0) return false;
  throw new TypeError(`${field} must be a boolean`);
};

const validateHeaderProtectionKey = (value) => {
  if (typeof value !== 'string') {
    throw new TypeError('headerProtectionKey must be a base64 string');
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    throw new TypeError('headerProtectionKey must encode exactly 32 bytes');
  }
  return value;
};

const validateProfile = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('AWG profile must be an object');
  }

  for (const field of REQUIRED_FIELDS) {
    if (!hasOwn(input, field)) throw new TypeError(`Missing required AWG field: ${field}`);
  }

  const profile = {
    jc: parseInteger(input.jc, 'jc', UINT32_MAX),
    jmin: parseInteger(input.jmin, 'jmin', UINT32_MAX),
    jmax: parseInteger(input.jmax, 'jmax', UINT32_MAX),
  };

  if (profile.jmin > profile.jmax) {
    throw new RangeError('jmin must not exceed jmax');
  }

  for (const field of PADDING_FIELDS) {
    profile[field] = parseInteger(input[field], field, UINT16_MAX);
    if (profile[field] < 8) {
      throw new RangeError(`${field} must be at least 8 when header protection is enabled`);
    }
  }

  const headerRanges = HEADER_FIELDS.map((field) => {
    const range = parseRange(input[field], field, UINT32_MAX);
    profile[field] = range.text;
    return { field, ...range };
  });

  for (let left = 0; left < headerRanges.length; left++) {
    for (let right = left + 1; right < headerRanges.length; right++) {
      const a = headerRanges[left];
      const b = headerRanges[right];
      if (a.min <= b.max && b.min <= a.max) {
        throw new RangeError(`${a.field} and ${b.field} ranges must not overlap`);
      }
    }
  }

  for (const field of ['i1', 'i2', 'i3', 'i4', 'i5']) {
    if (hasOwn(input, field) && input[field] !== '') {
      if (typeof input[field] !== 'string') throw new TypeError(`${field} must be a string`);
      profile[field] = input[field];
    }
  }

  profile.headerProtectionKey = validateHeaderProtectionKey(input.headerProtectionKey);

  for (const field of RANGE_FIELDS_UINT16) {
    if (hasOwn(input, field) && input[field] !== '') {
      profile[field] = parseRange(input[field], field, UINT16_MAX).text;
    }
  }

  for (const field of ['randomTrailers', 'disableCookies']) {
    if (hasOwn(input, field)) profile[field] = parseBoolean(input[field], field);
  }

  return Object.freeze(profile);
};

const generateHeaderProtectionKey = () => crypto.randomBytes(32).toString('base64');

const generateOfficialProfile = ({
  randomInt = crypto.randomInt,
  generateKey = generateHeaderProtectionKey,
} = {}) => {
  const packetSizes = [148, 92, 64, 32];
  const maxima = [150, 150, 64];
  const paddings = [];
  const transportPadding = 12;

  for (let index = 0; index < maxima.length; index++) {
    let value;
    let attempts = 0;
    do {
      value = randomInt(12, maxima[index]);
      attempts++;
      if (attempts > 1_000) throw new Error('Unable to generate distinct AWG padding values');
    } while (
      value === transportPadding
      || paddings.includes(value)
      || paddings.some((padding, previous) => (
        packetSizes[previous] + padding === packetSizes[index] + value
      ))
      || packetSizes[3] + transportPadding === packetSizes[index] + value
    );
    paddings.push(value);
  }

  return validateProfile({
    jc: randomInt(4, 7),
    ...OFFICIAL_DEFAULTS,
    s1: paddings[0],
    s2: paddings[1],
    s3: paddings[2],
    s4: transportPadding,
    headerProtectionKey: generateKey(),
  });
};

const renderInterfaceFields = (input) => {
  const profile = validateProfile(input);
  return INTERFACE_FIELD_ORDER
    .filter(([property]) => hasOwn(profile, property))
    .map(([property, configName]) => {
      const value = typeof profile[property] === 'boolean'
        ? (profile[property] ? 'on' : 'off')
        : profile[property];
      return `${configName} = ${value}`;
    })
    .join('\n');
};

const renderPeerSecurity = ({ advancedSecurity = true } = {}) => {
  return `AdvancedSecurity = ${parseBoolean(advancedSecurity, 'advancedSecurity') ? 'on' : 'off'}`;
};

module.exports = {
  OFFICIAL_DEFAULTS,
  generateHeaderProtectionKey,
  generateOfficialProfile,
  renderInterfaceFields,
  renderPeerSecurity,
  validateProfile,
};
