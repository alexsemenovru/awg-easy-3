'use strict';

// A public relay permits one DHT lookup per five seconds. Failed aliases must
// not monopolize that first lookup on every subsequent bridge attempt.
function relayLocatorOrder(peer, contacts, attempt) {
  const keys = [...new Set(peer.lookupKeys ?? [peer.publicKey])];
  const verified = [...new Set(contacts.map(value => value.lookupKey))].filter(key => keys.includes(key));
  const missing = keys.filter(key => !verified.includes(key));
  const offset = missing.length ? attempt % missing.length : 0;
  return verified.concat(missing.slice(offset), missing.slice(0, offset));
}
module.exports = { relayLocatorOrder };
