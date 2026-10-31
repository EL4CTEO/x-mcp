import pino from 'pino';
import type { Config, LogLevel } from './config.ts';

export interface Logger {
  trace(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * MCP uses stdout for JSON-RPC frames, so every log line must go to stderr.
 * pino is synchronous-safe here: an async destination buffered on stderr keeps
 * the hot path cheap without ever contaminating the protocol stream.
 */
export function createLogger(level: LogLevel = 'info'): Logger {
  const destination = pino.destination({ dest: 2, sync: false, mkdir: false });
  const base = pino(
    {
      level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
      redact: {
        paths: [
          'headers.authorization',
          'headers.Authorization',
          'headers.cookie',
          'req.headers.authorization',
          'accessToken',
          'refreshToken',
          'clientSecret',
          'tokenSecret',
          'consumerSecret',
          'authorization',
        ],
        censor: '[redacted]',
      },
    },
    destination,
  );
  return base as unknown as Logger;
}

export function loggerFor(config: Config): Logger {
  return createLogger(config.logLevel);
}
