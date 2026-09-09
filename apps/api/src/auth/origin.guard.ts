import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { AuthConfig } from '@benhouse/config';
import { AUTH_CONFIG } from './auth.config';
import { ApiError } from './auth.errors';

interface OriginRequest {
  headers: Record<string, string | string[] | undefined>;
}

@Injectable()
export class OriginGuard implements CanActivate {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<OriginRequest>();
    const raw = request.headers.origin;
    const origin = Array.isArray(raw) ? undefined : raw;
    if (origin === undefined)
      throw new ApiError(403, 'ORIGIN_REQUIRED', 'El origen es obligatorio.');
    if (origin === 'null' || !this.config.allowedOrigins.includes(origin)) {
      throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'El origen no está permitido.');
    }
    return true;
  }
}
