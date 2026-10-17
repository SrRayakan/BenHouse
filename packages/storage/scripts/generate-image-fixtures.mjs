// Fixtures completamente sintéticos, reproducibles, sin fotografías reales.
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
function crc(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type),
    n = Buffer.alloc(4),
    c = Buffer.alloc(4);
  n.writeUInt32BE(data.length);
  c.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([n, t, data, c]);
}
function fc(seq) {
  const b = Buffer.alloc(26);
  b.writeUInt32BE(seq);
  b.writeUInt32BE(1, 4);
  b.writeUInt32BE(1, 8);
  b.writeUInt16BE(1, 20);
  b.writeUInt16BE(2, 22);
  return b;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(1);
ihdr.writeUInt32BE(1, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const actl = Buffer.alloc(8);
actl.writeUInt32BE(2);
const seq = Buffer.alloc(4);
seq.writeUInt32BE(2);
const apng = (invalid) =>
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('acTL', actl),
    chunk('fcTL', fc(0)),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk('fcTL', fc(1)),
    chunk(
      'fdAT',
      Buffer.concat([
        seq,
        invalid ? Buffer.from('invalid zlib frame') : deflateSync(Buffer.from([0, 0, 255, 0, 255])),
      ]),
    ),
    chunk('IEND', Buffer.alloc(0)),
  ]);
const frames = () =>
  sharp(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]), {
    raw: { width: 1, height: 2, channels: 4, pageHeight: 1 },
  });
const fixtures = {
  apng: { mime: 'image/png', bytes: apng(false) },
  apngInvalidSecondFrame: { mime: 'image/png', bytes: apng(true) },
  animatedWebp: {
    mime: 'image/webp',
    bytes: await frames()
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer(),
  },
  animatedGif: {
    mime: 'image/gif',
    bytes: await frames()
      .gif({ loop: 0, delay: [100, 100] })
      .toBuffer(),
  },
};
for (const name of ['animatedWebp', 'animatedGif']) {
  if ((await sharp(fixtures[name].bytes, { animated: true }).metadata()).pages !== 2)
    throw new Error('Fixture no animado');
}
for (const format of ['jpeg', 'png', 'webp']) {
  fixtures[`static${format}`] = {
    mime: `image/${format}`,
    bytes: await sharp({
      create: { width: 2, height: 2, channels: 3, background: 'green' },
    })
      .toFormat(format)
      .toBuffer(),
  };
}
await mkdir(new URL('../fixtures/', import.meta.url), { recursive: true });
fixtures.svg = {
  mime: 'image/svg+xml',
  bytes: Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="blue"/></svg>',
  ),
};
for (const format of ['gif', 'tiff', 'avif']) {
  fixtures[format] = {
    mime: `image/${format}`,
    bytes: await sharp(fixtures.staticpng.bytes).toFormat(format).toBuffer(),
  };
}
await writeFile(
  new URL('../fixtures/animated.json', import.meta.url),
  JSON.stringify(
    Object.fromEntries(
      Object.entries(fixtures).map(([k, v]) => [
        k,
        { mime: v.mime, base64: v.bytes.toString('base64') },
      ]),
    ),
    null,
    2,
  ) + '\n',
);
