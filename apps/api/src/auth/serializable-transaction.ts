import { Prisma } from '@benhouse/database';

export const SERIALIZABLE_MAX_ATTEMPTS = 3;

const RETRY_DELAYS_MS = [5, 10] as const;

export async function withSerializableRetry<T>(
  operation: () => Promise<T>,
  isAdditionalRetryable: (error: unknown) => boolean = () => false,
): Promise<T> {
  for (let attempt = 1; attempt <= SERIALIZABLE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        (!isSerializationFailure(error) && !isAdditionalRetryable(error)) ||
        attempt === SERIALIZABLE_MAX_ATTEMPTS
      ) {
        throw error;
      }
      await delay(RETRY_DELAYS_MS[attempt - 1] ?? 10);
    }
  }
  throw new Error('Número de intentos Serializable agotado.');
}

export function isSerializationFailure(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<object>();
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    if (visited.has(current)) return false;
    visited.add(current);
    const candidate = current as {
      code?: unknown;
      meta?: { code?: unknown } | null;
      cause?: unknown;
    };
    if (
      (current instanceof Prisma.PrismaClientKnownRequestError && current.code === 'P2034') ||
      candidate.code === 'P2034' ||
      candidate.code === '40001' ||
      candidate.meta?.code === '40001'
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
