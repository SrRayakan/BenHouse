import { IMAGE_MIMES, MAX_IMAGE_BYTES, type ImageMime } from '@benhouse/storage';
import { invalidRequest } from '../auth/auth.errors';
import { exactObject } from '../auth/input-validation';
import { parseUuid } from '../marketplace/marketplace.input';

export function parseIntent(body: unknown) {
  const x = exactObject(body, ['propertyId', 'mime', 'size', 'sha256', 'intentKey', 'uploadToken']);
  if (
    typeof x.propertyId !== 'string' ||
    typeof x.intentKey !== 'string' ||
    !IMAGE_MIMES.includes(x.mime as ImageMime) ||
    !Number.isSafeInteger(x.size) ||
    Number(x.size) < 1 ||
    Number(x.size) > MAX_IMAGE_BYTES ||
    typeof x.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(x.sha256) ||
    typeof x.uploadToken !== 'string' ||
    !/^[a-f0-9]{64}$/.test(x.uploadToken)
  )
    throw invalidRequest();
  return {
    propertyId: parseUuid(x.propertyId),
    intentKey: parseUuid(x.intentKey),
    mime: x.mime as ImageMime,
    size: Number(x.size),
    sha256: x.sha256,
    uploadToken: x.uploadToken,
  };
}
export function parseOrder(body: unknown) {
  const x = exactObject(body, ['version', 'ids']);
  if (
    !Number.isSafeInteger(x.version) ||
    Number(x.version) < 0 ||
    !Array.isArray(x.ids) ||
    x.ids.length > 100 ||
    x.ids.some((id) => typeof id !== 'string') ||
    new Set(x.ids).size !== x.ids.length
  )
    throw invalidRequest();
  return { version: Number(x.version), ids: x.ids.map((id) => parseUuid(id as string)) };
}
