#!/usr/bin/env node
// Read only a disposable BEP 44 record. No torrents, client data or AWG integration.
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import DHT from 'bittorrent-dht'

const publicHex = process.argv[2]
const saltText = process.argv[3] || 'awg-easy-test'
const duration = Number(process.argv[4] || 120)
const directNode = process.argv[5]
const marker = process.argv[6] || 'legacy'
if (!/^[a-fA-F0-9]{64}$/.test(publicHex || '') ||
    !Number.isInteger(duration) || duration < 10 || duration > 300 ||
    !/^[\x20-\x7e]{1,64}$/.test(saltText)) {
  process.stderr.write('usage: node get.mjs PUBLIC_KEY_HEX [SALT] [SECONDS<=300] [HOST:PORT]\n')
  process.exit(2)
}
if (directNode && !/^[^:]+:[1-9][0-9]{0,4}$/.test(directNode)) {
  process.stderr.write('invalid HOST:PORT\n')
  process.exit(2)
}
if (!['legacy', 'field'].includes(marker)) {
  process.stderr.write('invalid marker\n')
  process.exit(2)
}

const expectedKey = Buffer.from(publicHex, 'hex')
const salt = Buffer.from(saltText)
const target = createHash('sha1').update(expectedKey).update(salt).digest()
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
const emit = (event, fields = {}) => console.log(JSON.stringify({ event, time: Date.now(), ...fields }))
let verifyCount = 0
let discoveredNodes = 0
const dht = new DHT({
  bootstrap: process.env.DHT_FIELD_NO_PUBLIC_BOOTSTRAP === '1' ? false
    : ['dht.libtorrent.org:25401', 'dht.transmissionbt.com:6881',
      'router.bittorrent.com:6881'],
  verify: (signature, message, key) => {
    verifyCount++
    if (!Buffer.isBuffer(key) || key.length !== 32 || !key.equals(expectedKey)) {
      emit('verify_rejected_key')
      return false
    }
    try {
      const publicKey = createPublicKey({ key: Buffer.concat([spkiPrefix, key]),
        format: 'der', type: 'spki' })
      const valid = verifySignature(null, message, publicKey, signature)
      emit('verify_signature', { valid })
      return valid
    } catch {
      emit('verify_error')
      return false
    }
  }
})

let complete = false
let attempt = 0
let lookupTimer
const deadline = setTimeout(() => stop(false), duration * 1000)
function stop (success) {
  if (complete) return
  complete = true
  clearTimeout(deadline)
  clearInterval(lookupTimer)
  dht.destroy(() => process.exit(success ? 0 : 3))
}

dht.on('error', error => emit('error', { message: error.message }))
dht.on('warning', error => emit('warning', { message: error.message }))
dht.on('listening', () => emit('listening', { port: dht.address().port }))
dht.on('node', () => { discoveredNodes++ })
dht.on('ready', () => {
  emit('ready', { target: target.toString('hex'), nodes: dht.nodes.count() })
  lookupTimer = setInterval(lookup, 15000)
  lookup()
})
dht.listen(0)
if (directNode) {
  const [host, port] = directNode.split(':')
  dht.addNode({ host, port: Number(port) })
}

function lookup () {
  if (complete) return
  attempt++
  emit('get_requested', { attempt })
  dht.get(target, { salt, cache: false }, (error, item) => {
    if (complete) return
    if (error) return emit('get_error', { message: error.message })
    if (!item) return emit('get_missing', { verifyCount, discoveredNodes,
      nodes: dht.nodes.count() })
    if (!Buffer.isBuffer(item.k) || !item.k.equals(expectedKey) ||
        !Buffer.isBuffer(item.v) || !Number.isSafeInteger(item.seq)) {
      return emit('get_invalid_shape')
    }
    let record
    try { record = JSON.parse(item.v.toString('utf8')) } catch { return emit('get_invalid_json') }
    if (!record || !(marker === 'legacy' ? record.awg_easy_mutable_probe === 1
      : record.probe === 'awg-easy-disposable')) return emit('get_wrong_record')
    emit('get_verified', { seq: item.seq, record })
    stop(true)
  })
}
