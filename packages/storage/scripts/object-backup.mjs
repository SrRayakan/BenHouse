import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { docker, OBJECT_IMAGE, withLocalObjectService } from './local-object-service.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const maxObject = 10 * 1024 * 1024,
  maxBackup = 64 * 1024 * 1024;

// Copia lógica acotada para el entorno local, tomada con escritores detenidos.
// No almacena credenciales. Restaurar siempre en bucket nuevo y vacío.
export async function exportObjects(client, Bucket) {
  const objects = [];
  let ContinuationToken,
    total = 0;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket, ContinuationToken }));
    for (const row of page.Contents ?? []) {
      if (!/^[a-f0-9]{64}$/.test(row.Key ?? '') || !row.Size || row.Size > maxObject)
        throw new Error('Objeto no válido para copia C1.2.');
      total += row.Size;
      if (total > maxBackup)
        throw new Error('Copia local supera 64 MiB; no se exporta parcialmente.');
      const response = await client.send(new GetObjectCommand({ Bucket, Key: row.Key }));
      const bytes = Buffer.from(await response.Body.transformToByteArray());
      assert.equal(bytes.length, row.Size);
      objects.push({
        key: row.Key,
        size: bytes.length,
        sha256: sha(bytes),
        base64: bytes.toString('base64'),
      });
    }
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);
  return JSON.stringify({
    version: 1,
    objects: objects.sort((a, b) => a.key.localeCompare(b.key)),
  });
}
export async function restoreObjects(client, Bucket, snapshot) {
  if (Buffer.byteLength(snapshot) > maxBackup * 1.4) throw new Error('Copia demasiado grande.');
  const manifest = JSON.parse(snapshot),
    keys = new Set();
  let total = 0;
  if (manifest.version !== 1 || !Array.isArray(manifest.objects))
    throw new Error('Formato de copia inválido.');
  // Verificar TODA la copia antes de la primera escritura.
  const objects = manifest.objects.map((row) => {
    if (
      !/^[a-f0-9]{64}$/.test(row.key ?? '') ||
      keys.has(row.key) ||
      typeof row.base64 !== 'string'
    )
      throw new Error('Clave de copia inválida.');
    keys.add(row.key);
    const bytes = Buffer.from(row.base64, 'base64');
    total += bytes.length;
    if (
      !bytes.length ||
      bytes.length > maxObject ||
      bytes.length !== row.size ||
      sha(bytes) !== row.sha256 ||
      total > maxBackup
    )
      throw new Error('Integridad de copia inválida.');
    return { key: row.key, bytes };
  });
  const listing = await client.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1 }));
  if (listing.Contents?.length) throw new Error('La restauración exige un bucket vacío.');
  for (const { key, bytes } of objects) {
    await client.send(
      new PutObjectCommand({
        Bucket,
        Key: key,
        Body: bytes,
        IfNoneMatch: '*',
        ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
      }),
    );
    const response = await client.send(new GetObjectCommand({ Bucket, Key: key }));
    assert.equal(sha(Buffer.from(await response.Body.transformToByteArray())), sha(bytes));
  }
  return objects.length;
}
export async function verifyBackupRestore(env, context) {
  const backup = `benhouse-c12-backup-${randomUUID()}`,
    owner = context.owner;
  let identity;
  try {
    docker(['volume', 'create', '--label', `benhouse.c12.owner=${owner}`, backup]);
    identity = JSON.parse(docker(['volume', 'inspect', backup]))[0];
    const snapshot = await exportObjects(context.client, env.STORAGE_S3_BUCKET);
    const args = [
      'run',
      '--rm',
      '--label',
      `benhouse.c12.owner=${owner}`,
      '--network',
      'none',
      '--read-only',
      '--cap-drop=ALL',
      '--mount',
      `type=volume,src=${backup},dst=/data`,
      '--entrypoint',
      'sh',
    ];
    docker([...args, '-i', OBJECT_IMAGE, '-c', 'cat > /data/objects.json'], { input: snapshot });
    const persisted = docker([...args, OBJECT_IMAGE, '-c', 'cat /data/objects.json'], {
      maxBuffer: Math.ceil(maxBackup * 1.4),
    });
    assert.equal(sha(Buffer.from(persisted)), sha(Buffer.from(snapshot)));
    await withLocalObjectService(async (target, { client }) => {
      assert.notEqual(target.STORAGE_S3_ENDPOINT, env.STORAGE_S3_ENDPOINT);
      const corrupted = JSON.parse(persisted);
      corrupted.objects[0].sha256 = '0'.repeat(64);
      await assert.rejects(
        restoreObjects(client, target.STORAGE_S3_BUCKET, JSON.stringify(corrupted)),
        /Integridad/,
      );
      assert.equal(
        (await client.send(new ListObjectsV2Command({ Bucket: target.STORAGE_S3_BUCKET })))
          .KeyCount,
        0,
      );
      const count = await restoreObjects(client, target.STORAGE_S3_BUCKET, persisted);
      assert.equal(await exportObjects(client, target.STORAGE_S3_BUCKET), snapshot);
      console.log(
        `storage: copia persistida en volumen exclusivo y restauración en otro servicio: ${count} objetos, bytes/SHA-256 idénticos; copia corrupta rechazada antes de escribir.`,
      );
    });
  } finally {
    if (identity) {
      const current = JSON.parse(docker(['volume', 'inspect', backup]))[0];
      assert.equal(current.Labels?.['benhouse.c12.owner'], owner);
      assert.equal(current.CreatedAt, identity.CreatedAt);
      docker(['volume', 'rm', backup]);
    }
  }
}
