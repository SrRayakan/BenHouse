import { argon2, randomBytes } from 'node:crypto';
import type { Argon2Config } from '@benhouse/config';
import { constantTimeEqual } from './crypto-encoding';
import { invalidRequest, securityDependencyUnavailable } from './auth.errors';

export const PASSWORD_BLOCKLIST_VERSION = 1;
const PASSWORD_BLOCKLIST = new Set([
  '123456789012345',
  'passwordpassword',
  'contraseñacontraseña',
  'qwertyuiopasdfg',
  'benhousebenhouse',
]);
const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=([1-9]\d{0,9}),t=([1-9]\d{0,9}),p=([1-9]\d{0,9})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
export const PHC_LIMITS = Object.freeze({
  minimumMemoryKiB: 8_192,
  maximumMemoryKiB: 262_144,
  minimumPasses: 2,
  maximumPasses: 10,
  minimumParallelism: 2,
  maximumParallelism: 16,
  saltBytes: 16,
  tagBytes: 32,
});
const DUMMY_PASSWORD = 'BenHouse dummy password — no es una credencial';
const DUMMY_SALT = Buffer.from('YmVuaG91c2UtZHVtbXktc2FsdA', 'base64url').subarray(0, 16);

type ParsedPhc = {
  memoryKiB: number;
  passes: number;
  parallelism: number;
  salt: Buffer;
  tag: Buffer;
};

export function validatePassword(input: unknown): string {
  if (typeof input !== 'string') throw invalidRequest('La contraseña no cumple la política.');
  const characters = [...input].length;
  const bytes = Buffer.byteLength(input, 'utf8');
  if (
    characters < 15 ||
    characters > 128 ||
    bytes > 512 ||
    /^\s+$/u.test(input) ||
    PASSWORD_BLOCKLIST.has(input.toLocaleLowerCase('und'))
  ) {
    throw invalidRequest('La contraseña no cumple la política.');
  }
  return input;
}

function derive(password: string, salt: Buffer, config: Argon2Config): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        parallelism: config.parallelism,
        tagLength: 32,
        memory: config.memoryKiB,
        passes: config.passes,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

function serialize(config: Argon2Config, salt: Buffer, tag: Buffer): string {
  return `$argon2id$v=19$m=${config.memoryKiB},t=${config.passes},p=${config.parallelism}$${toPhcBase64(salt)}$${toPhcBase64(tag)}`;
}

function parsePhc(value: string): ParsedPhc | undefined {
  const match = PHC_PATTERN.exec(value);
  if (!match) return undefined;
  const memoryKiB = Number(match[1]);
  const passes = Number(match[2]);
  const parallelism = Number(match[3]);
  const salt = parsePhcBase64(match[4] ?? '', PHC_LIMITS.saltBytes);
  const tag = parsePhcBase64(match[5] ?? '', PHC_LIMITS.tagBytes);
  if (
    !salt ||
    !tag ||
    !Number.isSafeInteger(memoryKiB) ||
    !Number.isSafeInteger(passes) ||
    !Number.isSafeInteger(parallelism) ||
    memoryKiB < PHC_LIMITS.minimumMemoryKiB ||
    memoryKiB > PHC_LIMITS.maximumMemoryKiB ||
    passes < PHC_LIMITS.minimumPasses ||
    passes > PHC_LIMITS.maximumPasses ||
    parallelism < PHC_LIMITS.minimumParallelism ||
    parallelism > PHC_LIMITS.maximumParallelism
  )
    return undefined;
  return { memoryKiB, passes, parallelism, salt, tag };
}

function toPhcBase64(value: Buffer): string {
  return value.toString('base64').replace(/=+$/u, '');
}

function parsePhcBase64(value: string, expectedBytes: number): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+$/u.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === expectedBytes && toPhcBase64(decoded) === value ? decoded : undefined;
}

export async function hashPassword(password: string, config: Argon2Config): Promise<string> {
  const salt = randomBytes(16);
  return serialize(config, salt, await derive(password, salt, config));
}

export async function createDummyPasswordHash(config: Argon2Config): Promise<string> {
  return serialize(config, DUMMY_SALT, await derive(DUMMY_PASSWORD, DUMMY_SALT, config));
}

export async function verifyPassword(
  password: string,
  phc: string,
): Promise<{ valid: boolean; parsed?: ParsedPhc }> {
  const parsed = parsePhc(phc);
  if (!parsed) return { valid: false };
  const actual = await derive(password, parsed.salt, parsed);
  return { valid: constantTimeEqual(actual, parsed.tag), parsed };
}

export function passwordNeedsRehash(phc: string, config: Argon2Config): boolean {
  const parsed = parsePhc(phc);
  return (
    !parsed ||
    parsed.memoryKiB !== config.memoryKiB ||
    parsed.passes !== config.passes ||
    parsed.parallelism !== config.parallelism
  );
}

export const PASSWORD_ENGINE = Symbol('PASSWORD_ENGINE');

export class PasswordEngine {
  private readonly dummyHash: Promise<string>;

  constructor(
    private readonly config: Argon2Config,
    private readonly verifier: typeof verifyPassword = verifyPassword,
  ) {
    this.dummyHash = createDummyPasswordHash(config);
  }

  validate(input: unknown): string {
    return validatePassword(input);
  }

  hash(password: string): Promise<string> {
    return hashPassword(password, this.config);
  }

  async verifyForLogin(
    password: string,
    credentialHash: string | undefined,
  ): Promise<{ valid: boolean; candidateHash: string; needsRehash: boolean }> {
    let dummy: string;
    try {
      dummy = await this.dummyHash;
    } catch {
      throw securityDependencyUnavailable();
    }
    const candidateHash = credentialHash ?? dummy;
    let result: Awaited<ReturnType<typeof verifyPassword>>;
    try {
      result = await this.verifier(password, candidateHash);
    } catch {
      try {
        await this.verifier(password, dummy);
      } catch {
        throw securityDependencyUnavailable();
      }
      return { valid: false, candidateHash, needsRehash: false };
    }
    if (!result.parsed) {
      try {
        await this.verifier(password, dummy);
      } catch {
        throw securityDependencyUnavailable();
      }
    }
    return {
      valid: Boolean(credentialHash && result.valid),
      candidateHash,
      needsRehash: Boolean(
        credentialHash && result.valid && passwordNeedsRehash(candidateHash, this.config),
      ),
    };
  }
}
