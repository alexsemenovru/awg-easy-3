'use strict';
// Independent NTP-synchronized hosts still differ by milliseconds. Bound future
// timestamps, never extend the maximum age of an already old request.
const MAX_CLOCK_SKEW_MS = 30 * 1000;
module.exports = { MAX_CLOCK_SKEW_MS };
