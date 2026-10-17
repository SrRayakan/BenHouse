import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AuthConfig } from '@benhouse/config';
import { MAX_IMAGE_BYTES } from '@benhouse/storage';
import { AUTH_CONFIG } from '../auth/auth.config';
import { OriginGuard } from '../auth/origin.guard';
import { ApiError, invalidRequest } from '../auth/auth.errors';
import { readCookie } from '../auth/session-token';
import { parseEmptyBody, parseNoQuery, parseUuid } from '../marketplace/marketplace.input';
import { MediaService, type MediaContext } from './media.service';
import { parseIntent, parseOrder } from './media.input';

@Controller()
export class MediaController {
  private activeUploads = 0;
  constructor(
    private readonly media: MediaService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}
  private context(headers: Record<string, string | undefined>): MediaContext {
    const requestId = headers['x-request-id'];
    return {
      cookie: readCookie(headers.cookie, this.config.sessionCookieName),
      csrf: headers['x-csrf-token'],
      requestId: requestId && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? requestId : randomUUID(),
    };
  }
  @Post('media/upload-intent')
  @Header('Cache-Control', 'no-store')
  @UseGuards(OriginGuard)
  intent(
    @Body() body: unknown,
    @Query() query: unknown,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    parseNoQuery(query);
    return this.media.intent(parseIntent(body), this.context(headers));
  }
  @Put('media/:id/object')
  @Header('Cache-Control', 'no-store')
  @UseGuards(OriginGuard)
  async upload(
    @Param('id') id: string,
    @Query() query: unknown,
    @Headers() headers: Record<string, string | undefined>,
    @Req() req: IncomingMessage,
  ) {
    parseNoQuery(query);
    parseUuid(id);
    const size = Number(headers['content-length']);
    if (
      headers['content-encoding'] ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > MAX_IMAGE_BYTES
    )
      throw invalidRequest();
    if (this.activeUploads >= 4)
      throw new ApiError(429, 'MEDIA_UPLOAD_BUSY', 'Inténtalo de nuevo más tarde.');
    this.activeUploads++;
    req.on('error', () => undefined);
    try {
      const ctx = this.context(headers);
      await this.media.preflight(id, headers['x-upload-token'], headers['content-type'], size, ctx);
      const bytes = await receiveBytes(req, size);
      return await this.media.upload(
        id,
        headers['x-upload-token'],
        headers['content-type'],
        bytes,
        ctx,
      );
    } finally {
      this.activeUploads--;
    }
  }
  @Post('media/:id/complete-upload')
  @Header('Cache-Control', 'no-store')
  @UseGuards(OriginGuard)
  @HttpCode(200)
  complete(
    @Param('id') id: string,
    @Body() body: unknown,
    @Query() query: unknown,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    parseNoQuery(query);
    parseEmptyBody(body);
    return this.media.complete(parseUuid(id), this.context(headers));
  }
  @Delete('media/:id')
  @Header('Cache-Control', 'no-store')
  @UseGuards(OriginGuard)
  @HttpCode(204)
  archive(
    @Param('id') id: string,
    @Body() body: unknown,
    @Query() query: unknown,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    parseNoQuery(query);
    parseEmptyBody(body);
    return this.media.archive(parseUuid(id), this.context(headers));
  }
  @Get('properties/:id/media')
  @Header('Cache-Control', 'no-store')
  list(
    @Param('id') id: string,
    @Query() query: unknown,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    parseNoQuery(query);
    return this.media.list(parseUuid(id), this.context(headers));
  }
  @Put('properties/:id/media/order')
  @Header('Cache-Control', 'no-store')
  @UseGuards(OriginGuard)
  order(
    @Param('id') id: string,
    @Body() body: unknown,
    @Query() query: unknown,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    parseNoQuery(query);
    return this.media.reorder(parseUuid(id), parseOrder(body), this.context(headers));
  }
  @Get('media/:id/content')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Content-Security-Policy', "default-src 'none'; sandbox")
  async content(
    @Param('id') id: string,
    @Query() query: unknown,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    parseNoQuery(query);
    const result = await this.media.read(parseUuid(id), this.context(headers));
    return new StreamableFile(result.bytes, {
      type: result.mime,
      disposition: 'attachment',
      length: result.bytes.length,
    });
  }
}

export function receiveBytes(req: IncomingMessage, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (req.aborted || req.destroyed) {
      reject(invalidRequest());
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', data);
      req.off('end', end);
      req.off('error', failed);
      req.off('aborted', failed);
      if (error) {
        // Un aborto puede emitir después ECONNRESET: no dejar un error sin listener.
        req.once('error', () => undefined);
        req.resume();
        reject(error);
      } else resolve(Buffer.concat(chunks, received));
    };
    const data = (chunk: Buffer) => {
      received += chunk.length;
      if (received > size) done(invalidRequest());
      else chunks.push(chunk);
    };
    const end = () => done(received === size ? undefined : invalidRequest());
    const failed = () => done(invalidRequest());
    const timer = setTimeout(
      () => done(new ApiError(408, 'MEDIA_UPLOAD_TIMEOUT', 'La carga ha caducado.')),
      15_000,
    );
    req.on('data', data);
    req.once('end', end);
    req.once('error', failed);
    req.once('aborted', failed);
  });
}
