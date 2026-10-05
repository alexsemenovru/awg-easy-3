import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import DHT from 'bittorrent-dht'

const event = (emitter, name) => new Promise(resolve => emitter.once(name, resolve))
const close = dht => new Promise(resolve => dht.destroy(resolve))
const announce = (dht, hash, port) => new Promise((resolve, reject) => {
  dht.announce(hash, port, error => error ? reject(error) : resolve())
})
const lookup = (dht, hash) => new Promise((resolve, reject) => {
  dht.lookup(hash, (error, count) => error ? reject(error) : resolve(count))
})

test('BEP 5 finds an unknown peer through an unrelated loopback DHT node',
  { timeout: 15000 }, async t => {
    const hash = randomBytes(20)
    const storage = new DHT({ bootstrap: false })
    const announcer = new DHT({ bootstrap: false })
    const seeker = new DHT({ bootstrap: false })
    t.after(async () => { await Promise.all([close(storage), close(announcer), close(seeker)]) })
    for (const dht of [storage, announcer, seeker]) {
      const listening = event(dht, 'listening')
      dht.listen(0, '127.0.0.1')
      await listening
    }
    const contact = { host: '127.0.0.1', port: storage.address().port }
    const announcerReady = event(announcer, 'node')
    const seekerReady = event(seeker, 'node')
    announcer.addNode(contact)
    seeker.addNode(contact)
    await Promise.all([announcerReady, seekerReady])
    const servicePort = 41987
    await announce(announcer, hash, servicePort)
    const seen = []
    seeker.on('peer', (peer, infoHash) => {
      if (infoHash.equals(hash)) seen.push(peer)
    })
    await lookup(seeker, hash)
    assert.ok(seen.some(peer => peer.host === '127.0.0.1' && peer.port === servicePort))
    const contacts = seeker.toJSON().nodes.map(({ host, port }) => ({ host, port }))
    assert.ok(contacts.some(node => node.host === '127.0.0.1' && node.port === contact.port))
    // Recreate the seeker with only its remembered contacts. Public routers
    // are absent: a reachable prior contact is enough for rendezvous.
    const restored = new DHT({ bootstrap: contacts })
    t.after(() => close(restored))
    const listening = event(restored, 'listening')
    restored.listen(0, '127.0.0.1')
    await listening
    const recovered = []
    restored.on('peer', (peer, infoHash) => {
      if (infoHash.equals(hash)) recovered.push(peer)
    })
    await lookup(restored, hash)
    assert.ok(recovered.some(peer => peer.host === '127.0.0.1' && peer.port === servicePort))
  })
