import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import DHT from 'bittorrent-dht'
import locator from '../../../src/lib/CellDhtLocator.js'
import exchangeModule from '../../../src/lib/CellDhtContactExchange.js'
import cursorModule from '../../../src/lib/CellDhtCursorStore.js'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
const wait = (emitter, event) => new Promise(resolve => emitter.once(event, resolve))
const put = (dht, opts) => new Promise((resolve, reject) => {
  dht.put(opts, (error, hash, accepted) => error ? reject(error) : resolve({ hash, accepted }))
})
const get = (dht, hash, salt) => new Promise((resolve, reject) => {
  dht.get(hash, { salt, cache: false }, (error, item) => error ? reject(error) : resolve(item))
})
const close = dht => new Promise(resolve => dht.destroy(resolve))

test('pinned Node DHT publishes and updates a signed BEP 44 record on loopback',
  { timeout: 15000 }, async t => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const rawPublic = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
    const salt = Buffer.from('awg-easy-loopback-test')
    const target = createHash('sha1').update(rawPublic).update(salt).digest()
    const verifyRecord = (signature, message, key) => {
      if (!Buffer.isBuffer(key) || !key.equals(rawPublic)) return false
      const edPublic = createPublicKey({ key: Buffer.concat([spkiPrefix, key]),
        format: 'der', type: 'spki' })
      return verify(null, message, edPublic, signature)
    }
    const storage = new DHT({ bootstrap: false, verify: verifyRecord })
    const writer = new DHT({ bootstrap: false, verify: verifyRecord })
    const reader = new DHT({ bootstrap: false, verify: verifyRecord })
    t.after(async () => { await Promise.all([close(storage), close(writer), close(reader)]) })
    for (const dht of [storage, writer, reader]) {
      const listening = wait(dht, 'listening')
      dht.listen(0, '127.0.0.1')
      await listening
    }
    const contact = { host: '127.0.0.1', port: storage.address().port }
    const writerReady = wait(writer, 'node')
    const readerReady = wait(reader, 'node')
    writer.addNode(contact)
    reader.addNode(contact)
    await Promise.all([writerReady, readerReady])
    const value = (revision, endpoint = null) => Buffer.from(JSON.stringify({ probe: 1, revision, endpoint }))
    const options = (revision, signRecord = data => sign(null, data, privateKey), endpoint = null) => ({
      k: rawPublic, salt, seq: revision, v: value(revision, endpoint), sign: signRecord,
    })
    const first = await put(writer, options(1))
    assert.deepEqual(first.hash, target)
    assert.ok(first.accepted > 0)
    assert.equal(JSON.parse((await get(reader, target, salt)).v).revision, 1)
    const second = await put(writer, options(2))
    assert.ok(second.accepted > 0)
    const updated = await get(reader, target, salt)
    assert.equal(updated.seq, 2)
    assert.equal(JSON.parse(updated.v).revision, 2)
    assert.equal(verifyRecord(updated.sig, Buffer.from('wrong'), updated.k), false)
    assert.equal(verifyRecord(updated.sig, Buffer.from('wrong'), Buffer.alloc(32)), false)
    // A different process/UDP port can update the same signed locator without
    // a pre-existing torrent or a new DHT identity. This is not a public-IP test.
    const moved = new DHT({ bootstrap: false, verify: verifyRecord })
    t.after(() => close(moved))
    const listening = wait(moved, 'listening')
    moved.listen(0, '127.0.0.1')
    await listening
    const movedReady = wait(moved, 'node')
    moved.addNode(contact)
    await movedReady
    const endpoint = `127.0.0.1:${moved.address().port}`
    assert.ok((await put(moved, options(3, undefined, endpoint))).accepted > 0)
    const relocated = await get(reader, target, salt)
    assert.equal(relocated.seq, 3)
    assert.equal(JSON.parse(relocated.v).endpoint, endpoint)
    await assert.rejects(put(moved, options(2)), /sequence number less than current/)
    await assert.rejects(put(moved, options(4, () => Buffer.alloc(64))))
    assert.equal((await get(reader, target, salt)).seq, 3)
  })

test('product Cell locator survives a BEP 44 put/get on loopback',
  { timeout: 15000 }, async t => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const cellKey = publicKey.export({ format: 'jwk' }).x
    const now = Date.now()
    const rawPublic = Buffer.from(cellKey, 'base64url')
    const verifyItem = (signature, message, key) => key.equals(rawPublic) &&
      verify(null, message, publicKey, signature)
    const storage = new DHT({ bootstrap: false, verify: verifyItem })
    const writer = new DHT({ bootstrap: false, verify: verifyItem })
    const reader = new DHT({ bootstrap: false, verify: verifyItem })
    t.after(async () => { await Promise.all([close(storage), close(writer), close(reader)]) })
    for (const dht of [storage, writer, reader]) {
      const listening = wait(dht, 'listening')
      dht.listen(0, '127.0.0.1')
      await listening
    }
    const contact = { host: '127.0.0.1', port: storage.address().port }
    const writerReady = wait(writer, 'node')
    const readerReady = wait(reader, 'node')
    writer.addNode(contact)
    reader.addNode(contact)
    await Promise.all([writerReady, readerReady])
    const dir = await mkdtemp(path.join(os.tmpdir(), 'awg-dht-loopback-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const { CellDhtCursorStore } = cursorModule
    const { CellDhtContactExchange } = exchangeModule
    const sender = new CellDhtContactExchange({ dht: writer, cellKey,
      cursor: new CellDhtCursorStore(path.join(dir, 'sender', 'cursor'), cellKey) })
    const receiver = new CellDhtContactExchange({ dht: reader, cellKey,
      cursor: new CellDhtCursorStore(path.join(dir, 'receiver', 'cursor'), cellKey) })
    const published = await sender.publish({
      privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
      host: '198.51.100.7', port: 49123, now })
    assert.ok(published.accepted > 0)
    const result = await receiver.lookup(now)
    assert.equal(result.host, '198.51.100.7')
    assert.equal(result.port, 49123)
    assert.equal(result.seq, published.seq)
    assert.deepEqual(result.target, locator.targetFor(cellKey))
  })
