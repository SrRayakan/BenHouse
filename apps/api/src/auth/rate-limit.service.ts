import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { AuthConfig, AuthRateLimitPolicyName, RateLimitPolicy } from '@benhouse/config';
import { Prisma } from '@benhouse/database';
import { DatabaseService } from '../infrastructure/database/database.service';
import { AUTH_CONFIG } from './auth.config';
import { hmacSha256 } from './crypto-encoding';
import { ApiError, securityDependencyUnavailable } from './auth.errors';
import type { Clock } from './clock';
import { SystemClock } from './clock';

type Action = 'REGISTER' | 'LOGIN' | 'VERIFY_EMAIL' | 'SESSION_READ';
type Dimension = 'EMAIL' | 'IP' | 'EMAIL_IP' | 'TOKEN' | 'TOKEN_IP';
type RateSubject = {
  action: Action;
  dimension: Dimension;
  value: string;
  policy: AuthRateLimitPolicyName;
};

type UpsertResult = { blockedUntil: Date | null };

@Injectable()
export class AuthRateLimitService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthRateLimitService.name);
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly database: DatabaseService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    private readonly clock: SystemClock,
  ) {}

  onModuleInit(): void {
    this.cleanupTimer = setInterval(() => {
      void this.runScheduledCleanup();
    }, this.config.rateLimitCleanupIntervalSeconds * 1_000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  async cleanupExpiredBuckets(): Promise<number> {
    const now = this.clock.now();
    const deleted = await this.database.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "auth_rate_limit"
        WHERE "expires_at" < ${now}
        ORDER BY "expires_at", "id"
        FOR UPDATE SKIP LOCKED
        LIMIT ${this.config.rateLimitCleanupBatchSize}
      )
      DELETE FROM "auth_rate_limit" AS bucket
      USING candidates
      WHERE bucket."id" = candidates."id"
      RETURNING bucket."id"
    `);
    return deleted.length;
  }

  private async runScheduledCleanup(): Promise<void> {
    try {
      const deleted = await this.cleanupExpiredBuckets();
      if (deleted > 0) this.logger.log({ event: 'auth_rate_limit.cleanup', deleted });
    } catch {
      this.logger.warn({ event: 'auth_rate_limit.cleanup_failed' });
    }
  }

  async consume(subjects: readonly RateSubject[]): Promise<void> {
    const now = this.clock.now();
    let retryAfterSeconds = 0;
    try {
      await this.database.prisma.$transaction(
        async (tx) => {
          for (const subject of subjects) {
            const policy = this.config.rateLimits[subject.policy];
            for (const [pepperVersion, pepper] of this.config.rateLimitPepperKeys.keys) {
              const digest = hmacSha256(
                pepper,
                'benhouse/auth-rate-limit/v1',
                subject.action,
                subject.dimension,
                subject.value,
                pepperVersion,
              );
              const [result] = await tx.$queryRaw<UpsertResult[]>(Prisma.sql`
              INSERT INTO "auth_rate_limit" (
                "id", "action", "dimension", "subject_digest", "pepper_version",
                "window_started_at", "window_ends_at", "attempt_count", "blocked_until",
                "expires_at", "updated_at"
              ) VALUES (
                gen_random_uuid(), ${subject.action}::"AuthRateLimitAction",
                ${subject.dimension}::"AuthRateLimitDimension", ${digest}, ${pepperVersion},
                ${now}, ${addSeconds(now, policy.windowSeconds)}, 1,
                NULL,
                ${addSeconds(now, policy.windowSeconds)},
                ${now}
              )
              ON CONFLICT ("action", "dimension", "subject_digest", "pepper_version")
              DO UPDATE SET
                "window_started_at" = CASE
                  WHEN "auth_rate_limit"."window_ends_at" <= ${now} THEN ${now}
                  ELSE "auth_rate_limit"."window_started_at"
                END,
                "window_ends_at" = CASE
                  WHEN "auth_rate_limit"."window_ends_at" <= ${now} THEN ${addSeconds(now, policy.windowSeconds)}
                  ELSE "auth_rate_limit"."window_ends_at"
                END,
                "attempt_count" = CASE
                  WHEN "auth_rate_limit"."window_ends_at" <= ${now} THEN 1
                  ELSE "auth_rate_limit"."attempt_count" + 1
                END,
                "blocked_until" = GREATEST(
                  "auth_rate_limit"."blocked_until",
                  CASE WHEN (
                    CASE WHEN "auth_rate_limit"."window_ends_at" <= ${now}
                      THEN 1 ELSE "auth_rate_limit"."attempt_count" + 1 END
                  ) > ${policy.limit} THEN ${addSeconds(now, policy.blockSeconds)} ELSE NULL END
                ),
                "expires_at" = GREATEST(
                  "auth_rate_limit"."expires_at",
                  ${addSeconds(now, policy.windowSeconds)},
                  CASE WHEN (
                    CASE WHEN "auth_rate_limit"."window_ends_at" <= ${now}
                      THEN 1 ELSE "auth_rate_limit"."attempt_count" + 1 END
                  ) > ${policy.limit} THEN ${addSeconds(now, policy.blockSeconds)} ELSE ${now} END
                ),
                "updated_at" = ${now}
              RETURNING "blocked_until" AS "blockedUntil"
            `);
              if (result?.blockedUntil && result.blockedUntil > now) {
                retryAfterSeconds = Math.max(
                  retryAfterSeconds,
                  Math.ceil((result.blockedUntil.getTime() - now.getTime()) / 1000),
                );
              }
            }
          }
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw securityDependencyUnavailable();
    }
    if (retryAfterSeconds > 0) {
      throw new ApiError(429, 'RATE_LIMITED', 'Demasiadas solicitudes.', retryAfterSeconds);
    }
  }

  static malformedTokenSubject(rawToken: string): string {
    return `malformed:${createHash('sha256').update(rawToken, 'utf8').digest('base64url')}`;
  }
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export type { RateSubject, RateLimitPolicy, Clock };
