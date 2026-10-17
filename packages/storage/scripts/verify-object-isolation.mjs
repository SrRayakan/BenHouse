import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { spawnSync } from 'node:child_process';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { docker, OBJECT_IMAGE, objectClient } from './local-object-service.mjs';

export async function verifyObjectIsolation(env, context) {
  const key = randomBytes(32).toString('hex'),
    Bucket = env.STORAGE_S3_BUCKET;
  await context.client.send(
    new PutObjectCommand({ Bucket, Key: key, Body: Buffer.from('synthetic-private') }),
  );
  for (const [method, path] of [
    ['GET', `${Bucket}/${key}`],
    ['PUT', `${Bucket}/${key}`],
    ['DELETE', `${Bucket}/${key}`],
    ['GET', `${Bucket}?list-type=2`],
  ]) {
    const r = await fetch(`${env.STORAGE_S3_ENDPOINT}/${path}`, {
      method,
      body: method === 'PUT' ? 'intruder' : undefined,
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(r.status, 403, `Acceso anónimo ${method}`);
    await r.body?.cancel();
  }
  const bad = objectClient({ ...env, STORAGE_S3_SECRET_KEY: randomBytes(32).toString('hex') });
  try {
    for (const command of [
      new GetObjectCommand({ Bucket, Key: key }),
      new PutObjectCommand({ Bucket, Key: key, Body: Buffer.from('intruder') }),
    ])
      await assert.rejects(bad.send(command), (error) => error.$metadata?.httpStatusCode === 403);
  } finally {
    bad.destroy();
  }
  const detail = JSON.parse(docker(['container', 'inspect', context.containerId]))[0];
  const network = JSON.parse(docker(['network', 'inspect', context.networkId]))[0];
  assert.equal(network.Options['com.docker.network.bridge.enable_icc'], 'false');
  const address = detail.NetworkSettings.Networks[context.network].IPAddress;
  // Docker Desktop permite alcanzar IPs internas desde contenedores creados
  // por su administrador. Verificamos DENEGACIÓN de datos, no prometemos una
  // separación TCP que este daemon no aplica pese a enable_icc=false.
  for (const net of ['bridge', context.network]) {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const result = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--label',
          `benhouse.c12.owner=${context.owner}`,
          '--network',
          net,
          '--cap-drop=ALL',
          '--read-only',
          '--entrypoint',
          'curl',
          OBJECT_IMAGE,
          '--noproxy',
          '*',
          '--silent',
          '--output',
          '/dev/null',
          '--write-out',
          '%{http_code}',
          '--request',
          method,
          ...(method === 'PUT' ? ['--data-binary', 'intruder'] : []),
          '--connect-timeout',
          '2',
          '--max-time',
          '3',
          `http://${address}:9000/${Bucket}/${key}`,
        ],
        { encoding: 'utf8', timeout: 15_000 },
      );
      assert.equal(result.error, undefined);
      if (result.status === 0) assert.equal(result.stdout, '403', `Red no autorizada ${method}`);
      else assert.ok([7, 28].includes(result.status), 'Fallo inesperado de la sonda de red');
    }
  }
  const intact = await context.client.send(new GetObjectCommand({ Bucket, Key: key }));
  assert.equal(
    Buffer.from(await intact.Body.transformToByteArray()).toString(),
    'synthetic-private',
  );
  const port = new URL(env.STORAGE_S3_ENDPOINT).port;
  const addresses = [
    ...new Set(
      Object.values(networkInterfaces())
        .flat()
        .filter((x) => x && x.family === 'IPv4' && !x.internal)
        .map((x) => x.address),
    ),
  ];
  assert.ok(addresses.length, 'No se pudo verificar una interfaz de host no-loopback');
  for (const ip of addresses) {
    await assert.rejects(
      fetch(`http://${ip}:${port}/${Bucket}/${key}`, { signal: AbortSignal.timeout(1500) }),
      'El puerto está accesible fuera de loopback',
    );
  }
  const ids = docker(['ps', '-aq']).split('\n').filter(Boolean);
  const containers = JSON.parse(docker(['inspect', ...ids]));
  const consumers = containers.filter((c) => c.Mounts.some((m) => m.Name === context.volume));
  assert.deepEqual(
    consumers.map((c) => c.Id),
    [context.containerId],
  );
  assert.equal(detail.Config.Env.includes('RUSTFS_CONSOLE_ENABLE=false'), true);
  console.log(
    'storage: anónimo GET/PUT/DELETE/listado=403, firma inválida=403; datos inaccesibles desde otras redes, host no-loopback inaccesible; volumen exclusivo sin web.',
  );
}
