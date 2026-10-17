import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];
export type ImageMetadata = {
  mime: ImageMime;
  size: number;
  sha256: string;
  width: number;
  height: number;
};
export class InvalidImage extends Error {}

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Solo lee posiciones fijas (hasta 33 bytes). Es una puerta de entrada, no una
// certificación de contenido: ningún formato ajeno se entrega al autodetector.
function admittedHeader(bytes: Buffer): 'jpeg' | 'png' | 'webp' {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg';
  if (
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(pngSignature) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.subarray(12, 16).equals(Buffer.from('IHDR'))
  )
    return 'png';
  if (
    bytes.length >= 20 &&
    bytes.subarray(0, 4).equals(Buffer.from('RIFF')) &&
    bytes.subarray(8, 12).equals(Buffer.from('WEBP')) &&
    ['VP8 ', 'VP8L', 'VP8X'].some((type) => bytes.subarray(12, 16).equals(Buffer.from(type)))
  )
    return 'webp';
  throw new InvalidImage();
}

// libvips no expone pages para APNG. Inspeccionamos chunks, no cadenas que
// podrían aparecer legítimamente en metadatos o píxeles.
function assertStaticContainer(bytes: Buffer, format: string) {
  if (format === 'png') {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new InvalidImage();
    let offset = 8,
      ended = false;
    while (offset < bytes.length) {
      if (bytes.length - offset < 12) throw new InvalidImage();
      const size = bytes.readUInt32BE(offset),
        type = bytes.toString('ascii', offset + 4, offset + 8);
      if (size > bytes.length - offset - 12 || ['acTL', 'fcTL', 'fdAT'].includes(type))
        throw new InvalidImage();
      offset += size + 12;
      if (type === 'IEND') {
        if (size !== 0 || offset !== bytes.length) throw new InvalidImage();
        ended = true;
        break;
      }
    }
    if (!ended) throw new InvalidImage();
  } else if (format === 'webp') {
    if (
      bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WEBP' ||
      bytes.readUInt32LE(4) + 8 !== bytes.length
    )
      throw new InvalidImage();
    let offset = 12;
    while (offset < bytes.length) {
      if (bytes.length - offset < 8) throw new InvalidImage();
      const type = bytes.toString('ascii', offset, offset + 4),
        size = bytes.readUInt32LE(offset + 4);
      if (size > bytes.length - offset - 8 || ['ANIM', 'ANMF'].includes(type))
        throw new InvalidImage();
      if (type === 'VP8X' && (size !== 10 || (bytes[offset + 8]! & 2) !== 0))
        throw new InvalidImage();
      offset += 8 + size + (size % 2);
    }
    if (offset !== bytes.length) throw new InvalidImage();
  }
}
export async function inspectImage(bytes: Buffer): Promise<ImageMetadata> {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new InvalidImage();
  try {
    const format = admittedHeader(bytes);
    assertStaticContainer(bytes, format);
    const options = { limitInputPixels: 40_000_000, failOn: 'warning' as const, animated: true };
    const metadata = await sharp(bytes, options).metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1) throw new InvalidImage();
    await sharp(bytes, options).raw().toBuffer();
    if (!metadata.width || !metadata.height) throw new InvalidImage();
    return {
      mime: `image/${metadata.format}` as ImageMime,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      width: metadata.width,
      height: metadata.height,
    };
  } catch {
    throw new InvalidImage();
  }
}
