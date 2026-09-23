import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthConfig } from '@benhouse/config';
import { AUTH_CONFIG } from '../auth/auth.config';
import { securityDependencyUnavailable } from '../auth/auth.errors';
import { canonicalizeIp } from '../auth/ip';
import { OriginGuard } from '../auth/origin.guard';
import { readCookie } from '../auth/session-token';
import {
  parseEmptyBody,
  parseInvitationBody,
  parseRoleBody,
  parseTokenBody,
  parseTransferBody,
} from './organization-administration.input';
import { OrganizationAdministrationService } from './organization-administration.service';
import { parseNoQuery, parseOrganizationId } from './organization-input';

interface HttpRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
}

@Controller('organizations')
export class OrganizationAdministrationController {
  constructor(
    private readonly administration: OrganizationAdministrationService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  @Post(':id/invitations')
  @UseGuards(OriginGuard)
  @HttpCode(201)
  invite(
    @Param('id') id: string,
    @Query() query: unknown,
    @Body() input: unknown,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrf: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ): Promise<{ id: string; status: 'PENDING' }> {
    parseNoQuery(query);
    return this.administration.invite(
      parseOrganizationId(id),
      parseInvitationBody(input),
      readCookie(cookie, this.config.sessionCookieName),
      csrf,
      safeRequestId(requestId),
    );
  }

  @Patch(':id/members/:memberId/role')
  @UseGuards(OriginGuard)
  @HttpCode(204)
  changeRole(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Query() query: unknown,
    @Body() input: unknown,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrf: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ): Promise<void> {
    parseNoQuery(query);
    return this.administration.changeRole(
      parseOrganizationId(id),
      parseOrganizationId(memberId),
      parseRoleBody(input).role,
      readCookie(cookie, this.config.sessionCookieName),
      csrf,
      safeRequestId(requestId),
    );
  }

  @Post(':id/members/:memberId/revoke')
  @UseGuards(OriginGuard)
  @HttpCode(204)
  revokeMember(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Query() query: unknown,
    @Body() input: unknown,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrf: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ): Promise<void> {
    parseNoQuery(query);
    parseEmptyBody(input);
    return this.administration.revokeMember(
      parseOrganizationId(id),
      parseOrganizationId(memberId),
      readCookie(cookie, this.config.sessionCookieName),
      csrf,
      safeRequestId(requestId),
    );
  }

  @Post(':id/leave')
  @UseGuards(OriginGuard)
  @HttpCode(204)
  leave(
    @Param('id') id: string,
    @Query() query: unknown,
    @Body() input: unknown,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrf: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ): Promise<void> {
    parseNoQuery(query);
    parseEmptyBody(input);
    return this.administration.leave(
      parseOrganizationId(id),
      readCookie(cookie, this.config.sessionCookieName),
      csrf,
      safeRequestId(requestId),
    );
  }

  @Post(':id/transfer-administration')
  @UseGuards(OriginGuard)
  @HttpCode(204)
  transfer(
    @Param('id') id: string,
    @Query() query: unknown,
    @Body() input: unknown,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrf: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ): Promise<void> {
    parseNoQuery(query);
    return this.administration.transfer(
      parseOrganizationId(id),
      parseTransferBody(input),
      readCookie(cookie, this.config.sessionCookieName),
      csrf,
      safeRequestId(requestId),
    );
  }
}

@Controller('organization-invitations')
export class OrganizationInvitationController {
  constructor(
    private readonly administration: OrganizationAdministrationService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  @Post(':id/resend')
  @UseGuards(OriginGuard)
  @HttpCode(204)
  resend(
    @Param('id') id: string,
    @Query() query: unknown,
    @Body() input: unknown,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrf: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ): Promise<void> {
    parseNoQuery(query);
    parseEmptyBody(input);
    return this.administration.resend(
      parseOrganizationId(id),
      readCookie(cookie, this.config.sessionCookieName),
      csrf,
      safeRequestId(requestId),
    );
  }

  @Post(':id/revoke')
  @UseGuards(OriginGuard)
  @HttpCode(204)
  revoke(
    @Param('id') id: string,
    @Query() query: unknown,
    @Body() input: unknown,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrf: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ): Promise<void> {
    parseNoQuery(query);
    parseEmptyBody(input);
    return this.administration.revokeInvitation(
      parseOrganizationId(id),
      readCookie(cookie, this.config.sessionCookieName),
      csrf,
      safeRequestId(requestId),
    );
  }

  @Post(':id/accept')
  @UseGuards(OriginGuard)
  @HttpCode(204)
  accept(
    @Param('id') id: string,
    @Query() query: unknown,
    @Body() input: unknown,
    @Req() request: HttpRequest,
    @Headers('x-request-id') requestId: string | undefined,
  ): Promise<void> {
    parseNoQuery(query);
    return this.administration.respond(
      'ACCEPTED',
      parseOrganizationId(id),
      parseTokenBody(input).token,
      requestIp(request),
      safeRequestId(requestId),
    );
  }

  @Post(':id/reject')
  @UseGuards(OriginGuard)
  @HttpCode(204)
  reject(
    @Param('id') id: string,
    @Query() query: unknown,
    @Body() input: unknown,
    @Req() request: HttpRequest,
    @Headers('x-request-id') requestId: string | undefined,
  ): Promise<void> {
    parseNoQuery(query);
    return this.administration.respond(
      'REJECTED',
      parseOrganizationId(id),
      parseTokenBody(input).token,
      requestIp(request),
      safeRequestId(requestId),
    );
  }
}

function requestIp(request: HttpRequest): string {
  const ip = canonicalizeIp(request.ip ?? request.socket?.remoteAddress ?? '');
  if (!ip) throw securityDependencyUnavailable();
  return ip;
}

function safeRequestId(value: string | undefined): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : randomUUID();
}
