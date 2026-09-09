import { HttpException, HttpStatus } from '@nestjs/common';

export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super({ code, message }, status);
  }
}

export const invalidRequest = (message = 'La solicitud no es válida.') =>
  new ApiError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', message);

export const invalidCredentials = () =>
  new ApiError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Las credenciales no son válidas.');

export const invalidOrExpiredToken = () =>
  new ApiError(
    HttpStatus.BAD_REQUEST,
    'INVALID_OR_EXPIRED_TOKEN',
    'El token no es válido o ha expirado.',
  );

export const securityDependencyUnavailable = () =>
  new ApiError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'SECURITY_DEPENDENCY_UNAVAILABLE',
    'La autenticación no está disponible temporalmente.',
  );
