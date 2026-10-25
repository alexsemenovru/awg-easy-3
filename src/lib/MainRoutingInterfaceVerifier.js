'use strict';

// A routing transaction can recover a committed subset while adding another
// Cell. Verify only owned interfaces in that subset; the next apply verifies
// the entire desired set before releasing the common guard.
async function verifyMainRoutingInterfaceSet({ names, userInterface, links, verifyUser }) {
  if (!Array.isArray(names) || !names.includes(userInterface)
    || names.length !== new Set(names).size || !Array.isArray(links)
    || typeof verifyUser !== 'function') return false;
  const owned = new Map(links.map(link => [link.path.interfaceName, link.path]));
  if (owned.size !== links.length
    || names.some(name => name !== userInterface && !owned.has(name))) return false;
  if (!await verifyUser()) return false;
  return (await Promise.all(names.filter(name => name !== userInterface)
    .map(name => owned.get(name).verifyOwned()))).every(Boolean);
}

module.exports = { verifyMainRoutingInterfaceSet };
