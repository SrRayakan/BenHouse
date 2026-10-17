import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  S3Client,
  HeadBucketCommand,
  GetBucketPolicyCommand,
  GetBucketPolicyStatusCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { InvalidImage, MAX_IMAGE_BYTES } from './image';
export * from './image';

export class ObjectConflict extends Error {}
export class StorageUnavailable extends Error {
  constructor() {
    super('Almacenamiento privado no disponible.');
  }
}
// No hay implementación de filesystem ni URLs públicas. El dominio autoriza.
export abstract class StorageProvider {
  abstract initialize(): Promise<void>;
  abstract put(key: string, bytes: Buffer): Promise<void>;
  abstract read(key: string): Promise<Buffer | null>;
  abstract removeIncomplete(key: string): Promise<void>;
  close(): void {}
  onModuleDestroy(): void {
    this.close();
  }
}
type S3Options = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };
export class S3StorageProvider extends StorageProvider {
  private readonly client: S3Client;
  private initialized = false;
  constructor(private readonly options: S3Options) {
    super();
    const url = new URL(options.endpoint);
    // C1.2 admite el servicio local Windows; no degrada TLS en redes remotas ni
    // hereda credenciales AWS del entorno o del servicio de metadata de nube.
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket) ||
      options.accessKeyId.length < 16 ||
      options.secretAccessKey.length < 32
    )
      throw new Error('Configuración de objetos locales inválida.');
    this.client = new S3Client({
      endpoint: url.origin,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 2000, requestTimeout: 10_000 },
    });
  }
  async initialize(): Promise<void> {
    try {
      const Bucket = this.options.bucket;
      await this.client.send(new HeadBucketCommand({ Bucket }));
      // RustFS autoriza mediante políticas IAM/bucket, no ACL S3 (su GetBucketAcl
      // es una respuesta de compatibilidad). No aceptamos políticas de bucket.
      try {
        await this.client.send(new GetBucketPolicyCommand({ Bucket }));
        throw new StorageUnavailable();
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'NoSuchBucketPolicy') throw error;
      }
      const policy = await this.client.send(new GetBucketPolicyStatusCommand({ Bucket }));
      if (policy.PolicyStatus?.IsPublic !== false) throw new StorageUnavailable();
      this.initialized = true;
    } catch {
      this.close();
      throw new StorageUnavailable();
    }
  }
  private object(key: string) {
    if (!this.initialized || !/^[a-f0-9]{64}$/.test(key)) throw new StorageUnavailable();
    return { Bucket: this.options.bucket, Key: key };
  }
  async read(key: string): Promise<Buffer | null> {
    const target = this.object(key);
    let stream: Readable | undefined;
    try {
      const result = await this.client.send(new GetObjectCommand(target), {
        abortSignal: AbortSignal.timeout(15_000),
      });
      stream = result.Body as Readable | undefined;
      if (!stream || !result.ContentLength || result.ContentLength > MAX_IMAGE_BYTES)
        throw new InvalidImage();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > MAX_IMAGE_BYTES) throw new InvalidImage();
        chunks.push(bytes);
      }
      if (size !== result.ContentLength) throw new InvalidImage();
      return Buffer.concat(chunks, size);
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchKey') return null;
      if (error instanceof InvalidImage) throw error;
      throw new StorageUnavailable();
    } finally {
      stream?.destroy();
    }
  }
  async put(key: string, bytes: Buffer): Promise<void> {
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new InvalidImage();
    const target = this.object(key);
    try {
      await this.client.send(
        new PutObjectCommand({
          ...target,
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: 'application/octet-stream',
          IfNoneMatch: '*',
          ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
        }),
        { abortSignal: AbortSignal.timeout(15_000) },
      );
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        '$metadata' in error &&
        [409, 412].includes((error.$metadata as { httpStatusCode: number }).httpStatusCode)
      ) {
        const existing = await this.read(key);
        if (!existing?.equals(bytes)) throw new ObjectConflict();
        return;
      }
      throw new StorageUnavailable();
    }
  }
  async removeIncomplete(key: string): Promise<void> {
    const target = this.object(key);
    try {
      await this.client.send(new DeleteObjectCommand(target), {
        abortSignal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new StorageUnavailable();
    }
  }
  override close(): void {
    this.initialized = false;
    this.client.destroy();
  }
}
export async function configuredStorage(environment = process.env): Promise<StorageProvider> {
  if (
    environment.STORAGE_PROVIDER !== 's3-local' ||
    !environment.STORAGE_S3_ENDPOINT ||
    !environment.STORAGE_S3_BUCKET ||
    !environment.STORAGE_S3_ACCESS_KEY ||
    !environment.STORAGE_S3_SECRET_KEY
  )
    throw new Error('Se requiere configuración completa de objetos S3 locales privados.');
  const storage = new S3StorageProvider({
    endpoint: environment.STORAGE_S3_ENDPOINT,
    bucket: environment.STORAGE_S3_BUCKET,
    accessKeyId: environment.STORAGE_S3_ACCESS_KEY,
    secretAccessKey: environment.STORAGE_S3_SECRET_KEY,
  });
  await storage.initialize();
  return storage;
}
