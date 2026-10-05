import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import DHT from 'bittorrent-dht'

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
    const value = revision => Buffer.from(JSON.stringify({ probe: 1, revision }))
    const options = (revision, signRecord = data => sign(null, data, privateKey)) => ({
      k: rawPublic, salt, seq: revision, v: value(revision), sign: signRecord,
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
    await assert.rejects(put(writer, options(3, () => Buffer.alloc(64))))
    assert.equal((await get(reader, target, salt)).seq, 2)
  })
