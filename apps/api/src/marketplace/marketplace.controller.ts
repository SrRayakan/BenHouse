import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthConfig } from '@benhouse/config';
import { AUTH_CONFIG } from '../auth/auth.config';
import { OriginGuard } from '../auth/origin.guard';
import { readCookie } from '../auth/session-token';
import {
  parseAuthorizationGrant,
  parseEmptyBody,
  parseListingCreate,
  parseListingPatch,
  parseNoQuery,
  parsePagination,
  parsePropertyCreate,
  parsePropertyPatch,
  parseUuid,
} from './marketplace.input';
import { MarketplaceService } from './marketplace.service';

@Controller('properties')
export class PropertiesController {
  constructor(
    private readonly marketplace: MarketplaceService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  @Post()
  @UseGuards(OriginGuard)
  @HttpCode(201)
  create(
    @Query() query: unknown,
    @Body() body: unknown,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrf: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ) {
    parseNoQuery(query);
    return this.marketplace.createProperty(
      parsePropertyCreate(body),
      readCookie(cookie, this.config.sessionCookieName),
      csrf,
      safeRequestId(requestId),
    );
  }

  @Get()
  @HttpCode(200)
  list(@Query() query: unknown, @Headers('cookie') cookie: string | undefined) {
    return this.marketplace.listProperties(
      readCookie(cookie, this.config.sessionCookieName),
      parsePagination(query),
    );
  }

  @Get(':id/authorizations')
  @HttpCode(200)
  authorizations(
    @Param('id') id: string,
    @Query() query: unknown,
    @Headers('cookie') cookie: string | undefined,
  ) {
    parseNoQuery(query);
    return this.marketplace.listAuthorizations(
      parseUuid(id),
      readCookie(cookie, this.config.sessionCookieName),
    );
  }

  @Post(':id/authorizations')
  @UseGuards(OriginGuard)
  @HttpCode(201)
  grant(
    @Param('id') id: string,
    @Query() query: unknown,
    @Body() body: unknown,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrf: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ) {
    parseNoQuery(query);
    return this.marketplace.grantAuthorization(
      parseUuid(id),
      parseAuthorizationGrant(body),
      readCookie(cookie, this.config.sessionCookieName),
      csrf,
      safeRequestId(requestId),
    );
  }

  @Get(':id')
  @HttpCode(200)
  get(
    @Param('id') id: string,
    @Query() query: unknown,
    @Headers('cookie') cookie: string | undefined,
  ) {
    parseNoQuery(query);
    return this.marketplace.getProperty(
      readCookie(cookie, this.config.sessionCookieName),
      parseUuid(id),
    );
  }

  @Patch(':id')
  @UseGuards(OriginGuard)
  @HttpCode(200)
  update(
    @Param('id') id: string,
    @Query() query: unknown,
    @Body() body: unknown,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrf: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ) {
    parseNoQuery(query);
    return this.marketplace.updateProperty(
      parseUuid(id),
      parsePropertyPatch(body),
      readCookie(cookie, this.config.sessionCookieName),
      csrf,
      safeRequestId(requestId),
    );
  }
}

@Controller('property-authorizations')
export class PropertyAuthorizationsController {
  constructor(
    private readonly marketplace: MarketplaceService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  @Post(':id/revoke')
  @UseGuards(OriginGuard)
  @HttpCode(204)
  revoke(
    @Param('id') id: string,
    @Query() query: unknown,
    @Body() body: unknown,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrf: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ): Promise<void> {
    parseNoQuery(query);
    parseEmptyBody(body);
    return this.marketplace.revokeAuthorization(
      parseUuid(id),
      readCookie(cookie, this.config.sessionCookieName),
      csrf,
      safeRequestId(requestId),
    );
  }
}

@Controller('listings')
export class ListingsController {
  constructor(
    private readonly marketplace: MarketplaceService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  @Post()
  @UseGuards(OriginGuard)
  @HttpCode(201)
  create(
    @Query() query: unknown,
    @Body() body: unknown,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrf: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ) {
    parseNoQuery(query);
    return this.marketplace.createListing(
      parseListingCreate(body),
      readCookie(cookie, this.config.sessionCookieName),
      csrf,
      safeRequestId(requestId),
    );
  }

  @Get()
  @HttpCode(200)
  list(@Query() query: unknown, @Headers('cookie') cookie: string | undefined) {
    return this.marketplace.listListings(
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
  ) {
    parseNoQuery(query);
    return this.marketplace.getListing(
      readCookie(cookie, this.config.sessionCookieName),
      parseUuid(id),
    );
  }

  @Patch(':id')
  @UseGuards(OriginGuard)
  @HttpCode(200)
  update(
    @Param('id') id: string,
    @Query() query: unknown,
    @Body() body: unknown,
    @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrf: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ) {
    parseNoQuery(query);
    return this.marketplace.updateListing(
      parseUuid(id),
      parseListingPatch(body),
      readCookie(cookie, this.config.sessionCookieName),
      csrf,
      safeRequestId(requestId),
    );
  }
}

function safeRequestId(value: string | undefined): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : randomUUID();
}
