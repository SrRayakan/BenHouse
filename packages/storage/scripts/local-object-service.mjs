import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

export const OBJECT_IMAGE =
  'rustfs/rustfs:1.0.1@sha256:1803faef57627e2d9c2e7d89d655d712ddded5389040054987163043fecb6a3c';
const label = 'benhouse.c12.owner';
export function docker(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000, ...options });
  if (result.error || result.status !== 0)
    throw new Error(`Docker falló en ${args[0]}; código ${result.status ?? 'sin código'}.`);
  return result.stdout.trim();
}
function inspect(kind, name) {
  return JSON.parse(docker([kind, 'inspect', name]))[0];
}
function assertResourceOwner(kind, current, owner, expected) {
  const labels = kind === 'container' ? current.Config.Labels : current.Labels;
  if (
    labels?.[label] !== owner ||
    (kind === 'volume' ? current.CreatedAt : current.Id) !== expected
  )
    throw new Error('Propiedad del recurso no verificable.');
}
export function objectClient(environment) {
  return new S3Client({
    endpoint: environment.STORAGE_S3_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: environment.STORAGE_S3_ACCESS_KEY,
      secretAccessKey: environment.STORAGE_S3_SECRET_KEY,
    },
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 10_000 },
  });
}

// Nunca adopta recursos existentes. Cada llamada es un servicio/volumen/red propio.
export async function withLocalObjectService(callback) {
  const owner = randomUUID(),
    name = `benhouse-c12-${owner}`;
  const volume = `${name}-data`,
    network = `${name}-net`;
  const bucket = 'property-media';
  const credentials = {
    RUSTFS_ACCESS_KEY: randomBytes(16).toString('hex'),
    RUSTFS_SECRET_KEY: randomBytes(32).toString('hex'),
  };
  let volumeIdentity, networkId, containerId, client;
  const errors = [];
  try {
    if (docker(['volume', 'ls', '--format', '{{.Name}}']).split('\n').includes(volume))
      throw new Error('Colisión de volumen: no se adopta.');
    docker(['volume', 'create', '--label', `${label}=${owner}`, volume]);
    volumeIdentity = inspect('volume', volume);
    if (volumeIdentity.Labels?.[label] !== owner) throw new Error('Identidad de volumen inválida.');
    // Docker 29 no publica puertos en redes --internal; bridge exclusivo con ICC
    // deshabilitado y publicación exclusivamente loopback para procesos Windows.
    networkId = docker([
      'network',
      'create',
      '--opt',
      'com.docker.network.bridge.enable_icc=false',
      '--label',
      `${label}=${owner}`,
      network,
    ]);
    containerId = docker(
      [
        'create',
        '--name',
        name,
        '--label',
        `${label}=${owner}`,
        '--network',
        network,
        '--mount',
        `type=volume,src=${volume},dst=/data`,
        '--read-only',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=64m',
        '--tmpfs',
        '/logs:rw,noexec,nosuid,size=32m,uid=10001,gid=10001',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user',
        '10001:10001',
        '--publish',
        '127.0.0.1::9000',
        '--env',
        'RUSTFS_ACCESS_KEY',
        '--env',
        'RUSTFS_SECRET_KEY',
        '--env',
        'RUSTFS_CONSOLE_ENABLE=false',
        '--env',
        'RUSTFS_REGION=us-east-1',
        '--env',
        'RUSTFS_OBS_LOGGER_LEVEL=error',
        OBJECT_IMAGE,
      ],
      { env: { ...process.env, ...credentials } },
    );
    docker(['start', containerId]);
    const detail = inspect('container', containerId);
    const bindings = detail.NetworkSettings.Ports['9000/tcp'];
    const volumes = detail.Mounts.filter((m) => m.Type === 'volume');
    if (
      detail.Id !== containerId ||
      detail.Config.Labels?.[label] !== owner ||
      detail.Mounts.some((m) => !['volume', 'tmpfs'].includes(m.Type)) ||
      volumes.length !== 1 ||
      volumes[0].Name !== volume ||
      volumes[0].Destination !== '/data' ||
      bindings?.length !== 1 ||
      bindings[0].HostIp !== '127.0.0.1' ||
      Object.keys(detail.NetworkSettings.Ports).some(
        (p) => p !== '9000/tcp' && detail.NetworkSettings.Ports[p],
      )
    )
      throw new Error(
        `Aislamiento del servicio de objetos incorrecto: ${JSON.stringify({ mounts: detail.Mounts.map((m) => ({ type: m.Type, destination: m.Destination })), ports: detail.NetworkSettings.Ports, running: detail.State.Running })}`,
      );
    const environment = {
      STORAGE_PROVIDER: 's3-local',
      STORAGE_S3_ENDPOINT: `http://127.0.0.1:${bindings[0].HostPort}`,
      STORAGE_S3_BUCKET: bucket,
      STORAGE_S3_ACCESS_KEY: credentials.RUSTFS_ACCESS_KEY,
      STORAGE_S3_SECRET_KEY: credentials.RUSTFS_SECRET_KEY,
      STORAGE_TEST_OWNER: owner,
    };
    client = objectClient(environment);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        ready = true;
        break;
      } catch (error) {
        if (error.name === 'BucketAlreadyOwnedByYou') {
          ready = true;
          break;
        }
        await delay(500);
      }
    }
    if (!ready) throw new Error('El servicio de objetos no arrancó con autenticación.');
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    const topology = {
      owner,
      containerId,
      volume,
      network,
      networkId,
      endpoint: environment.STORAGE_S3_ENDPOINT,
    };
    console.log(
      `storage: servicio exclusivo verificado ${name}, volumen ${volume}, loopback autenticado.`,
    );
    await callback(environment, { ...topology, client });
  } catch (error) {
    errors.push(error);
  } finally {
    client?.destroy();
    // Sin prune, sin compose down, sin acceso al volumen PostgreSQL.
    for (const [kind, resource, expected] of [
      ['container', containerId, containerId],
      ['network', networkId, networkId],
      ['volume', volumeIdentity?.Name, volumeIdentity?.CreatedAt],
    ]) {
      if (!resource) continue;
      try {
        const current = inspect(kind, resource);
        assertResourceOwner(kind, current, owner, expected);
        docker(
          kind === 'container' ? ['container', 'rm', '--force', resource] : [kind, 'rm', resource],
        );
      } catch {
        errors.push(
          new Error(`Limpieza no verificada: ${kind} ${resource}. No se borra otro recurso.`),
        );
      }
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Servicio de objetos: ejecución o limpieza fallida.');
  console.log(`storage: recursos propios eliminados ${name}.`);
}
