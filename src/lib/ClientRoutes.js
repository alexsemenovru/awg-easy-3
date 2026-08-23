'use strict';

const buildClientRoutes = ({ serverHasIPv6 = false } = {}) => ({
  allowedIps: ['0.0.0.0/0', ...(serverHasIPv6 ? ['::/0'] : [])],
  ipv6Policy: serverHasIPv6 ? 'tunnel' : 'unavailable',
});

module.exports = {
  buildClientRoutes,
};
