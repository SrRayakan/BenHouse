import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';

interface HttpResponse {
  setHeader(name: string, value: string): void;
  status(status: number): { json(body: unknown): void };
}

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : safeParserStatus(exception);
    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const structured =
      typeof exceptionResponse === 'object' &&
      exceptionResponse !== null &&
      'message' in exceptionResponse;
    const message = structured
      ? (exceptionResponse as { message: string | string[] }).message
      : status === HttpStatus.INTERNAL_SERVER_ERROR
        ? 'Error interno del servidor.'
        : 'La solicitud no se ha podido completar.';
    const code =
      structured && 'code' in exceptionResponse && typeof exceptionResponse.code === 'string'
        ? exceptionResponse.code
        : (HttpStatus[status] ?? 'ERROR');
    if (
      exception instanceof HttpException &&
      'retryAfterSeconds' in exception &&
      typeof exception.retryAfterSeconds === 'number'
    ) {
      response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    }

    response.status(status).json({
      statusCode: status,
      error: {
        code,
        message,
      },
    });
  }
}

function safeParserStatus(exception: unknown): number {
  if (!exception || typeof exception !== 'object') return HttpStatus.INTERNAL_SERVER_ERROR;
  const candidate = exception as { status?: unknown; type?: unknown };
  if (candidate.status === 413 && candidate.type === 'entity.too.large') {
    return HttpStatus.PAYLOAD_TOO_LARGE;
  }
  if (candidate.status === 400 && candidate.type === 'entity.parse.failed') {
    return HttpStatus.BAD_REQUEST;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}
