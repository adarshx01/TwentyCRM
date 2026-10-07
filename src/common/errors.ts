/** Ask the queue to run this job again later without counting it as a failure. */
export class RetryLaterError extends Error {
  constructor(public readonly delayMs: number, public readonly reason = 'deferred') {
    super(`retry later (${reason}) in ${delayMs}ms`);
    this.name = 'RetryLaterError';
  }
}

/** Never retry: the job cannot succeed (bad data, revoked user, etc.). */
export class PermanentError extends Error {
  constructor(message: string, public readonly code = 'PERMANENT') {
    super(message);
    this.name = 'PermanentError';
  }
}

/** The external system may or may not have applied the request (timeout, reset). */
export class AmbiguousOutcomeError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AmbiguousOutcomeError';
  }
}

/** Error carrying a message that is safe to show to an employee (CAP-08, §9). */
export class UserFacingError extends Error {
  constructor(message: string, public readonly code = 'USER_ERROR') {
    super(message);
    this.name = 'UserFacingError';
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
