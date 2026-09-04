import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';

interface HttpResponse {
  status(status: number): { json(body: unknown): void };
}

@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const message =
      typeof exceptionResponse === 'object' &&
      exceptionResponse !== null &&
      'message' in exceptionResponse
        ? (exceptionResponse as { message: string | string[] }).message
        : status === HttpStatus.INTERNAL_SERVER_ERROR
          ? 'Error interno del servidor.'
          : 'La solicitud no se ha podido completar.';

    response.status(status).json({
      statusCode: status,
      error: {
        code: HttpStatus[status] ?? 'ERROR',
        message,
      },
    });
  }
}
