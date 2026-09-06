import type { LoggerService } from '@nestjs/common';
import { redactSensitiveValue, type LogLevel } from '@benhouse/config';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function normalizeMessage(message: unknown): unknown {
  return redactSensitiveValue(message);
}

export class StructuredLogger implements LoggerService {
  constructor(private readonly minimumLevel: LogLevel) {}

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.write(
      'error',
      message,
      context,
      trace ? { trace: redactSensitiveValue(trace) } : undefined,
    );
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  private write(
    level: LogLevel,
    message: unknown,
    context?: string,
    extra?: Record<string, unknown>,
  ): void {
    const messageLevel = LEVEL_ORDER[level] ?? Number.POSITIVE_INFINITY;
    const minimumLevel = LEVEL_ORDER[this.minimumLevel] ?? Number.POSITIVE_INFINITY;
    if (messageLevel < minimumLevel) {
      return;
    }

    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      context: context === undefined ? undefined : redactSensitiveValue(context),
      message: normalizeMessage(message),
      ...extra,
    });

    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.info(line);
    }
  }
}
