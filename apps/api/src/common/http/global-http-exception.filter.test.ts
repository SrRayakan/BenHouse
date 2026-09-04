import { HttpStatus } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { GlobalHttpExceptionFilter } from './global-http-exception.filter';

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
});
