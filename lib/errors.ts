/** Stable identifiers for failures that program logic depends on. The message
 * stays human-readable (and is localized by its text); behaviour such as retry
 * classification must use the code, so rewording a message cannot change it. */
export type ErrorCode =
  | 'provider-timeout'
  | 'provider-connect'
  | 'provider-disconnected'
  | 'provider-rate-limit'
  | 'provider-error'
  | 'provider-incomplete'
  | 'provider-model-mismatch'
  | 'provider-voice-clone'
  | 'session-expired'
  | 'forbidden';

const RETRYABLE = new Set<ErrorCode>([
  'provider-timeout',
  'provider-connect',
  'provider-disconnected',
  'provider-rate-limit',
]);

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorCode(error: unknown): ErrorCode | undefined {
  return error instanceof AppError ? error.code : undefined;
}

/** Transient provider failures that may succeed when the window is resent. */
export function isRetryableProviderError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && RETRYABLE.has(code);
}
