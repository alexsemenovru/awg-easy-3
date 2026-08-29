'use strict';

const fs = require('node:fs');
const path = require('node:path');

let sharp;
try {
  sharp = require('sharp');
} catch {
  throw new Error('This development helper requires the optional "sharp" package. The generated assets are already committed and the runtime does not depend on sharp.');
}

const root = path.resolve(__dirname, '..');
const logoSource = path.join(root, 'assets', 'awg-easy-3-logo.svg');
const faviconSource = path.join(root, 'src', 'www', 'img', 'favicon.svg');
const webImages = path.join(root, 'src', 'www', 'img');

const writePng = async (source, output, width) => {
  await sharp(source).resize(width, width, { fit: 'contain' }).png().toFile(output);
};

const writeAppIcon = async (output, size) => {
  const markSize = Math.round(size * 0.82);
  const mark = await sharp(logoSource).resize(markSize, markSize, { fit: 'contain' }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: '#0d1b2c' } })
    .composite([{ input: mark, left: Math.floor((size - markSize) / 2), top: Math.floor((size - markSize) / 2) }])
    .png()
    .toFile(output);
};

const makeIco = (frames) => {
  const header = Buffer.alloc(6 + (16 * frames.length));
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, data }, index) => {
    const entry = 6 + (index * 16);
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header[entry + 2] = 0;
    header[entry + 3] = 0;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...frames.map(({ data }) => data)]);
};

const main = async () => {
  await writePng(logoSource, path.join(root, 'assets', 'awg-easy-3-logo.png'), 1024);
  await writePng(logoSource, path.join(webImages, 'logo.png'), 256);
  await writeAppIcon(path.join(webImages, 'apple-touch-icon.png'), 180);
  await writeAppIcon(path.join(webImages, 'icon-192.png'), 192);
  await writeAppIcon(path.join(webImages, 'icon-512.png'), 512);

  const frames = [];
  for (const size of [16, 32, 48]) {
    frames.push({ size, data: await sharp(faviconSource).resize(size, size).png().toBuffer() });
  }
  fs.writeFileSync(path.join(webImages, 'favicon.ico'), makeIco(frames));
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
