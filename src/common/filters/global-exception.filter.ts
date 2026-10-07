import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { UserFacingError } from '../errors';
import { currentCorrelationId } from '../context/request-context';

/**
 * Global exception filter.
 * - Returns safe error messages to users (no internal details)
 * - Logs detailed errors for operators
 * - Never leaks secrets or sensitive data in responses (SEC-03)
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    let status: number;
    let message: string;
    let code: string;

    if (exception instanceof UserFacingError) {
      status = exception.code === 'NOT_FOUND' ? 404 : /FORBIDDEN$/.test(exception.code) ? 403 : /CONFLICT$/.test(exception.code) ? 409 : 422;
      message = exception.message;
      code = exception.code;
    } else if (exception instanceof ZodError) {
      status = HttpStatus.BAD_REQUEST;
      message = `Invalid request: ${exception.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
      code = 'VALIDATION_ERROR';
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const errorResponse = exception.getResponse();
      message = typeof errorResponse === 'string'
        ? errorResponse
        : (errorResponse as any).message || exception.message;
      code = `HTTP_${status}`;
    } else if (exception instanceof Error) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'An internal error occurred. Please try again or contact support.';
      code = 'INTERNAL_ERROR';

      // Log the actual error for operators — never expose to users
      this.logger.error(
        {
          error: exception.message,
          stack: exception.stack,
          url: request.url,
          method: request.method,
          correlationId: currentCorrelationId(),
        },
        'Unhandled exception',
      );
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'An unexpected error occurred.';
      code = 'UNKNOWN_ERROR';

      this.logger.error({ exception, url: request.url }, 'Unknown exception type');
    }

    response.status(status).send({
      statusCode: status,
      code,
      message,
      timestamp: new Date().toISOString(),
      correlationId: currentCorrelationId(),
    });
  }
}
