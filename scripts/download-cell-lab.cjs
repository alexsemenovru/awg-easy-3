'use strict';

// Downloads public OCI layers only; never runs a daemon or alters host networking.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const repository = 'alexsemenovru/awg-easy-3';
const destination = path.resolve(process.argv[2]);
async function main() {
  await fs.mkdir(destination, { recursive: true });
  const tokenResponse = await fetch(`https://ghcr.io/token?scope=repository:${repository}:pull`);
  if (!tokenResponse.ok) throw new Error(`Token HTTP ${tokenResponse.status}`);
  const { token } = await tokenResponse.json();
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' };
  async function manifest(ref) {
    const response = await fetch(`https://ghcr.io/v2/${repository}/manifests/${ref}`, { headers });
    if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
    const raw = Buffer.from(await response.arrayBuffer());
    const digest = `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
    if (ref.startsWith('sha256:') && digest !== ref) throw new Error('Manifest digest mismatch');
    return { body: JSON.parse(raw), digest };
  }
  let result = await manifest('0.1.6');
  if (result.body.manifests) {
    const selected = result.body.manifests.find(item => item.platform?.os === 'linux' && item.platform.architecture === 'amd64');
    if (!selected) throw new Error('No linux amd64 image');
    result = await manifest(selected.digest);
  }
  const layers = [];
  for (const layer of result.body.layers) {
    if (!/^sha256:[a-f0-9]{64}$/.test(layer.digest) || layer.size > 512 * 1024 * 1024) throw new Error('Invalid layer');
    const name = layer.digest.slice(7) + '.tar.gz';
    const file = path.join(destination, name);
    let data;
    try { data = await fs.readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!data || crypto.createHash('sha256').update(data).digest('hex') !== layer.digest.slice(7)) {
      const response = await fetch(`https://ghcr.io/v2/${repository}/blobs/${layer.digest}`, { headers });
      if (!response.ok) throw new Error(`Layer HTTP ${response.status}`);
      data = Buffer.from(await response.arrayBuffer());
      if (data.length !== layer.size || crypto.createHash('sha256').update(data).digest('hex') !== layer.digest.slice(7)) throw new Error('Layer checksum mismatch');
      await fs.writeFile(file, data);
    }
    layers.push(name);
    console.log(`Verified ${name.slice(0, 12)} (${data.length} bytes)`);
  }
  await fs.writeFile(path.join(destination, 'layers.json'), JSON.stringify({ digest: result.digest, layers }, null, 2));
  console.log(`Image pinned: ${result.digest}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
