import { HttpStatus } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { GlobalHttpExceptionFilter } from './global-http-exception.filter';
import { ApiError } from '../../auth/auth.errors';

describe('GlobalHttpExceptionFilter', () => {
  it('oculta detalles internos de errores inesperados', () => {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    };

    new GlobalHttpExceptionFilter().catch(
      new Error('postgresql://user:secret@host/db'),
      host as never,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Error interno del servidor.' },
    });
  });

  it('devuelve código neutral y Retry-After para rate limit', () => {
    const json = vi.fn();
    const setHeader = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const host = { switchToHttp: () => ({ getResponse: () => ({ status, setHeader }) }) };

    new GlobalHttpExceptionFilter().catch(
      new ApiError(429, 'RATE_LIMITED', 'Demasiadas solicitudes.', 7),
      host as never,
    );

    expect(setHeader).toHaveBeenCalledWith('Retry-After', '7');
    expect(json).toHaveBeenCalledWith({
      statusCode: 429,
      error: { code: 'RATE_LIMITED', message: 'Demasiadas solicitudes.' },
    });
  });

  it('neutraliza errores del parser y conserva 413', () => {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status, setHeader: vi.fn() }) }),
    };
    new GlobalHttpExceptionFilter().catch(
      { status: 413, type: 'entity.too.large', body: 'secreto' },
      host as never,
    );
    expect(status).toHaveBeenCalledWith(413);
    expect(JSON.stringify(json.mock.calls)).not.toContain('secreto');
  });
});
