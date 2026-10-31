export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  /** Epoch milliseconds at which the window resets. */
  resetAt?: number;
}

export interface XApiErrorInit {
  status: number;
  message: string;
  code?: number | string;
  type?: string;
  title?: string;
  detail?: string;
  requestId?: string;
  rateLimit?: RateLimitInfo;
  retryAfterMs?: number;
  url?: string;
  body?: string;
}

/** A structured, agent-readable failure from the X API (or our own guardrails). */
export class XApiError extends Error {
  override name = 'XApiError';
  readonly status: number;
  readonly code?: number | string;
  readonly type?: string;
  readonly title?: string;
  readonly detail?: string;
  readonly requestId?: string;
  readonly rateLimit?: RateLimitInfo;
  readonly retryAfterMs?: number;
  readonly url?: string;
  readonly body?: string;

  constructor(init: XApiErrorInit) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.type = init.type;
    this.title = init.title;
    this.detail = init.detail;
    this.requestId = init.requestId;
    this.rateLimit = init.rateLimit;
    this.retryAfterMs = init.retryAfterMs;
    this.url = init.url;
    this.body = init.body;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isRetryable(): boolean {
    return this.status === 429 || this.status === 408 || this.status >= 500;
  }

  get hint(): string | undefined {
    if (this.isRateLimited) {
      const when = this.rateLimit?.resetAt
        ? new Date(this.rateLimit.resetAt).toISOString()
        : undefined;
      return when
        ? `X rate limit exhausted for this endpoint. The window resets at ${when}. Retry later or wait for it.`
        : 'X rate limit exhausted for this endpoint. Retry later.';
    }
    if (this.status === 401) {
      return 'Credentials are missing, expired or revoked. Re-authenticate with `npx x-mcp auth`, or check X_BEARER_TOKEN / OAuth 1.0a keys.';
    }
    if (this.status === 403) {
      return 'The token lacks the required scope, the account is not allowed to perform this action, or the endpoint requires a higher X API plan. Check the detail field and your app permissions.';
    }
    if (this.status === 404) {
      return 'The resource does not exist, was deleted, or is not visible to the authenticated account.';
    }
    if (this.status >= 500) {
      return 'X returned a server error. It is usually transient; retry with backoff.';
    }
    if (this.status === 400) {
      return 'The request was rejected. Read the detail field and adjust the parameters.';
    }
    return undefined;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.message,
      status: this.status,
      ...(this.code !== undefined ? { code: this.code } : {}),
      ...(this.type ? { type: this.type } : {}),
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.requestId ? { request_id: this.requestId } : {}),
      ...(this.rateLimit ? { rate_limit: this.rateLimit } : {}),
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }
}

export class XNetworkError extends Error {
  override name = 'XNetworkError';
  override readonly cause: unknown;
  readonly retryable: boolean;

  constructor(message: string, cause: unknown, retryable = true) {
    super(message);
    this.cause = cause;
    this.retryable = retryable;
  }
}

export function rateLimitFromHeaders(headers: Headers): RateLimitInfo {
  const limit = numberHeader(headers, 'x-rate-limit-limit');
  const remaining = numberHeader(headers, 'x-rate-limit-remaining');
  const resetSeconds = numberHeader(headers, 'x-rate-limit-reset');
  return {
    limit,
    remaining,
    resetAt: resetSeconds !== undefined ? resetSeconds * 1000 : undefined,
  };
}

export function numberHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
export function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

interface XErrorBody {
  title?: string;
  detail?: string;
  type?: string;
  status?: number;
  error?: string;
  errors?: Array<{ code?: number; message?: string }>;
  message?: string;
}

/**
 * Builds an XApiError from an HTTP response. X returns at least four different
 * error envelopes across v2 and legacy media endpoints; all are handled here.
 */
export function parseXApiError(
  status: number,
  headers: Headers,
  bodyText: string,
  context: { url: string; requestId?: string },
): XApiError {
  let parsed: XErrorBody | undefined;
  try {
    parsed = bodyText ? (JSON.parse(bodyText) as XErrorBody) : undefined;
  } catch {
    parsed = undefined;
  }

  const firstError = parsed?.errors?.[0];
  const message =
    parsed?.detail ??
    firstError?.message ??
    parsed?.message ??
    parsed?.error ??
    parsed?.title ??
    (bodyText ? bodyText.slice(0, 300) : `HTTP ${status}`);

  return new XApiError({
    status,
    message: `${status} ${parsed?.title ?? 'X API error'}: ${message}`,
    code: firstError?.code,
    type: parsed?.type,
    title: parsed?.title,
    detail: parsed?.detail ?? firstError?.message,
    requestId: context.requestId,
    rateLimit: rateLimitFromHeaders(headers),
    retryAfterMs: retryAfterMs(headers),
    url: context.url,
    body: bodyText.length > 2_000 ? `${bodyText.slice(0, 2_000)}…` : bodyText,
  });
}
