import pino, { type Logger } from 'pino';
import { currentContext } from '../common/context/request-context';

/**
 * Structured logging (Section 11 / SEC-01 / SEC-03).
 * Correlation and tenant IDs are attached to every line from the async context.
 * Redaction removes credentials and raw content; business payloads are never logged
 * by callers — only IDs, states, durations and error codes.
 */
const REDACT_PATHS = [
  'authorization', 'headers.authorization', 'req.headers.authorization', '*.authorization',
  'token', '*.token', 'accessToken', '*.accessToken', 'apiKey', '*.apiKey', 'password', '*.password',
  'secret', '*.secret', 'appSecret', '*.appSecret', 'x-api-key', 'headers["x-api-key"]',
  'transcript', '*.transcript', 'rawEmail', '*.rawEmail', 'body', '*.body', 'image', '*.image', 'audio', '*.audio',
  'text', '*.text', 'phone', '*.phone', 'email', '*.email',
];

let root: Logger = pino({ level: 'info', redact: { paths: REDACT_PATHS, censor: '[redacted]' } });

export function configureLogging(level: string, pretty = false): Logger {
  root = pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    mixin() {
      const ctx = currentContext();
      return ctx ? { correlationId: ctx.correlationId, tenantId: ctx.tenantId, userId: ctx.userId } : {};
    },
    ...(pretty ? { transport: { target: 'pino-pretty' } } : {}),
  });
  return root;
}

export function getLogger(name: string): Logger {
  // Resolve lazily so loggers created before configureLogging() pick up the final config.
  return new Proxy({} as Logger, {
    get(_t, prop) {
      const child = root.child({ component: name });
      const value = (child as any)[prop];
      return typeof value === 'function' ? value.bind(child) : value;
    },
  });
}
