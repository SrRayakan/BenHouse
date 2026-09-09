import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthConfig } from '@benhouse/config';
import { Inject } from '@nestjs/common';
import { AUTH_CONFIG } from './auth.config';
import { AuthService } from './auth.service';
import { OriginGuard } from './origin.guard';
import { canonicalizeIp } from './ip';
import { readCookie } from './session-token';
import { securityDependencyUnavailable } from './auth.errors';

interface HttpRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
}

interface HttpResponse {
  cookie(name: string, value: string, options: Record<string, unknown>): void;
  clearCookie(name: string, options: Record<string, unknown>): void;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  @Post('register')
  @UseGuards(OriginGuard)
  @HttpCode(202)
  async register(
    @Body() input: unknown,
    @Req() request: HttpRequest,
    @Headers('x-request-id') requestId?: string,
  ): Promise<{ status: 'verification_required' }> {
    const body = this.auth.parseRegisterBody(input);
    await this.auth.register(body, requestIp(request), safeRequestId(requestId));
    return { status: 'verification_required' };
  }

  @Post('verify-email')
  @UseGuards(OriginGuard)
  @HttpCode(204)
  async verifyEmail(
    @Body() input: unknown,
    @Req() request: HttpRequest,
    @Headers('x-request-id') requestId?: string,
  ): Promise<void> {
    await this.auth.verifyEmail(
      this.auth.parseVerifyBody(input),
      requestIp(request),
      safeRequestId(requestId),
    );
  }

  @Post('login')
  @UseGuards(OriginGuard)
  @HttpCode(200)
  async login(
    @Body() input: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
    @Headers('x-request-id') requestId?: string,
  ) {
    const result = await this.auth.login(
      this.auth.parseLoginBody(input),
      requestIp(request),
      safeRequestId(requestId),
    );
    response.cookie(this.config.sessionCookieName, result.cookie, cookieOptions(this.config));
    return result.view;
  }

  @Get('session')
  @HttpCode(200)
  async session(
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
    @Headers('cookie') cookieHeader?: string,
  ) {
    const result = await this.auth.getSession(
      readCookie(cookieHeader, this.config.sessionCookieName),
      requestIp(request),
    );
    if (result.clearCookie)
      response.clearCookie(this.config.sessionCookieName, clearCookieOptions(this.config));
    return result.view;
  }
}

function requestIp(request: HttpRequest): string {
  const value = canonicalizeIp(request.ip ?? request.socket?.remoteAddress ?? '');
  if (!value) throw securityDependencyUnavailable();
  return value;
}

function safeRequestId(value: string | undefined): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : randomUUID();
}

export function cookieOptions(config: AuthConfig): Record<string, unknown> {
  return {
    httpOnly: true,
    secure: config.sessionCookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: config.sessionAbsoluteTtlSeconds * 1000,
  };
}

function clearCookieOptions(config: AuthConfig): Record<string, unknown> {
  return {
    httpOnly: true,
    secure: config.sessionCookieSecure,
    sameSite: 'lax',
    path: '/',
  };
}
