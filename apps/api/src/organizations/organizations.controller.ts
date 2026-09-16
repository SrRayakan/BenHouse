import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Inject } from '@nestjs/common';
import type { AuthConfig } from '@benhouse/config';
import { AUTH_CONFIG } from '../auth/auth.config';
import { OriginGuard } from '../auth/origin.guard';
import { readCookie } from '../auth/session-token';
import type { MemberDto, OrganizationDto } from './organization.dto';
import {
  parseOrganizationId,
  parseOrganizationNameBody,
  parseNoQuery,
  parsePagination,
} from './organization-input';
import { OrganizationsService } from './organizations.service';

@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  @Post()
  @UseGuards(OriginGuard)
  @HttpCode(201)
  create(
    @Query() query: unknown,
    @Body() input: unknown,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfToken: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ): Promise<OrganizationDto> {
    parseNoQuery(query);
    const body = parseOrganizationNameBody(input);
    return this.organizations.create(
      body.name,
      readCookie(cookie, this.config.sessionCookieName),
      csrfToken,
      safeRequestId(requestId),
    );
  }

  @Get()
  @HttpCode(200)
  list(
    @Query() query: unknown,
    @Headers('cookie') cookie: string | undefined,
  ): Promise<OrganizationDto[]> {
    return this.organizations.list(
      readCookie(cookie, this.config.sessionCookieName),
      parsePagination(query),
    );
  }

  @Get(':id')
  @HttpCode(200)
  get(
    @Param('id') id: string,
    @Query() query: unknown,
    @Headers('cookie') cookie: string | undefined,
  ): Promise<OrganizationDto> {
    parseNoQuery(query);
    return this.organizations.get(
      readCookie(cookie, this.config.sessionCookieName),
      parseOrganizationId(id),
    );
  }

  @Patch(':id')
  @UseGuards(OriginGuard)
  @HttpCode(200)
  updateName(
    @Param('id') id: string,
    @Query() query: unknown,
    @Body() input: unknown,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrfToken: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ): Promise<OrganizationDto> {
    parseNoQuery(query);
    const body = parseOrganizationNameBody(input);
    return this.organizations.updateName(
      readCookie(cookie, this.config.sessionCookieName),
      csrfToken,
      parseOrganizationId(id),
      body.name,
      safeRequestId(requestId),
    );
  }

  @Get(':id/members')
  @HttpCode(200)
  members(
    @Param('id') id: string,
    @Query() query: unknown,
    @Headers('cookie') cookie: string | undefined,
  ): Promise<MemberDto[]> {
    return this.organizations.members(
      readCookie(cookie, this.config.sessionCookieName),
      parseOrganizationId(id),
      parsePagination(query),
    );
  }
}

function safeRequestId(value: string | undefined): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : randomUUID();
}
