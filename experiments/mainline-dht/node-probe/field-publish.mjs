#!/usr/bin/env node
// Disposable public-DHT probe: signed random marker only, never real endpoints.
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import DHT from 'bittorrent-dht'

const sequence = Number(process.argv[2])
const identityPath = process.env.DHT_FIELD_IDENTITY
const port = Number(process.env.DHT_FIELD_PORT || 49033)
const salt = Buffer.from('awg-easy-field-20261008')
if (!Number.isInteger(sequence) || sequence < 1 || sequence > 100 || !identityPath ||
    !Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('Usage: DHT_FIELD_IDENTITY=private-file DHT_FIELD_PORT=49033 node field-publish.mjs SEQ')
}
let privateKey
try { privateKey = await readFile(identityPath, 'utf8') }
catch (error) {
  if (error.code !== 'ENOENT') throw error
  const pair = generateKeyPairSync('ed25519')
  privateKey = pair.privateKey.export({ format: 'pem', type: 'pkcs8' })
  const handle = await open(identityPath, 'wx', 0o600)
  try { await handle.writeFile(privateKey); await handle.sync() }
  finally { await handle.close() }
}
const publicKey = createPublicKey(privateKey)
const rawPublic = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
const target = createHash('sha1').update(rawPublic).update(salt).digest()
const dht = new DHT({
  bootstrap: ['dht.libtorrent.org:25401', 'dht.transmissionbt.com:6881',
    'router.bittorrent.com:6881'],
  verify: (signature, message, key) => Buffer.isBuffer(key) && key.equals(rawPublic) &&
    verify(null, message, publicKey, signature),
})
const report = (event, more = {}) => console.log(JSON.stringify({ event,
  time: Date.now(), nodes: dht.nodes.count(), rssKiB: Math.round(process.memoryUsage().rss / 1024), ...more }))
dht.on('error', error => report('error', { message: error.message }))
dht.on('warning', error => report('warning', { message: error.message }))
const deadline = setTimeout(() => { report('timeout'); dht.destroy(() => process.exit(3)) }, 180000)
const stats = setInterval(() => report('stats'), 15000)
dht.on('ready', () => {
  report('ready', { publicHex: rawPublic.toString('hex'), target: target.toString('hex') })
  const value = Buffer.from(JSON.stringify({ probe: 'awg-easy-disposable', sequence }))
  dht.put({ k: rawPublic, salt, seq: sequence, v: value,
    sign: data => sign(null, data, privateKey) }, (error, hash, accepted) => {
    report('put', { success: !error, accepted: accepted || 0,
      targetMatches: !!hash && hash.equals(target), message: error?.message })
    if (error || !accepted) {
      clearInterval(stats); clearTimeout(deadline)
      dht.destroy(() => process.exit(4))
      return
    }
    // Stay online briefly so another VPS can query the fresh record.
    setTimeout(() => {
      report('done'); clearInterval(stats); clearTimeout(deadline)
      dht.destroy(() => process.exit(0))
    }, 105000)
  })
})
dht.listen(port, '0.0.0.0')
