import { createHash } from 'node:crypto';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { AuthManager } from '../auth/manager.ts';
import { AuthError } from '../auth/errors.ts';
import { signOAuth1 } from '../auth/oauth1.ts';
import { HttpTransport } from './http.ts';
import { TtlCache } from './cache.ts';
import { RateLimiter, bucketKey } from './rate-limit.ts';
import { XApiError, parseXApiError, rateLimitFromHeaders, type RateLimitInfo } from './errors.ts';
import type { Includes } from './types.ts';

export type AuthKind = 'auto' | 'app' | 'user' | 'oauth2' | 'oauth1';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type QueryValue = string | number | boolean | Array<string | number> | undefined | null;
export type Query = Record<string, QueryValue>;

export interface XRequest {
  method: HttpMethod;
  path: string;
  query?: Query | undefined;
  /** JSON body for v2 endpoints. */
  body?: unknown;
  /** Multipart body, used only by media uploads. */
  form?: FormData | undefined;
  auth?: AuthKind | undefined;
  signal?: AbortSignal | undefined;
  /** `false` disables caching; an object overrides the TTL for this call. */
  cache?: false | { ttlMs?: number } | undefined;
  /** Set for requests whose duplication is harmless (media append, etc.). */
  idempotent?: boolean | undefined;
  headers?: Record<string, string> | undefined;
}

export interface XResult<T = unknown> {
  data: T;
  includes?: Includes | undefined;
  meta?: Record<string, unknown> | undefined;
  status: number;
  headers: Headers;
  cached: boolean;
  attempts: number;
  durationMs: number;
  requestId?: string | undefined;
  rateLimit: RateLimitInfo;
  dryRun?: boolean | undefined;
}

export interface AuditedRequest {
  method: string;
  url: string;
  auth: string;
  body?: unknown;
}

interface ResolvedAuth {
  headers: Record<string, string>;
  kind: 'app' | 'oauth2' | 'oauth1';
}

const CACHEABLE_METHODS = new Set(['GET']);

/**
 * The single gateway to api.x.com.
 *
 * Responsibilities, in order: URL assembly, auth selection, rate-limit
 * pre-flight, caching/coalescing, one-shot 401 recovery, error normalisation
 * and mutation-driven cache invalidation.
 */
export class XClient {
  readonly config: Config;
  readonly auth: AuthManager;
  readonly http: HttpTransport;
  readonly limiter: RateLimiter;
  private readonly logger: Logger;
  private readonly cache: TtlCache<unknown>;
  private readonly audit: AuditedRequest[] = [];

  constructor(config: Config, logger: Logger, auth?: AuthManager, http?: HttpTransport) {
    this.config = config;
    this.logger = logger;
    this.auth = auth ?? new AuthManager(config, logger);
    this.http =
      http ??
      new HttpTransport({
        timeoutMs: config.http.timeoutMs,
        maxRetries: config.http.maxRetries,
        retryBaseMs: config.http.retryBaseMs,
        proxy: config.http.proxy,
        logger,
      });
    this.limiter = new RateLimiter({ mode: config.rateLimit.mode, maxWaitMs: config.rateLimit.maxWaitMs });
    this.cache = new TtlCache<unknown>(config.cache.maxEntries);
  }

  get baseUrl(): string {
    return this.config.apiBase;
  }

  resolveUrl(request: Pick<XRequest, 'path' | 'query'>): string {
    const url = new URL(request.path.startsWith('http') ? request.path : `${this.config.apiBase}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        url.searchParams.set(key, value.join(','));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async request<T = unknown>(request: XRequest): Promise<XResult<T>> {
    const url = this.resolveUrl(request);
    const bucket = bucketKey(request.method, new URL(url).pathname);

    if (this.config.dryRun && request.method !== 'GET') {
      const preview = this.preview(request, url);
      return this.fakeResult<T>(preview);
    }

    const cacheable =
      CACHEABLE_METHODS.has(request.method) &&
      this.config.cache.enabled &&
      request.cache !== false &&
      !this.config.dryRun;

    if (!cacheable) {
      const result = await this.execute<T>(request, url, bucket);
      if (!CACHEABLE_METHODS.has(request.method)) this.cache.clear();
      return result;
    }

    const ttlMs = (request.cache as { ttlMs?: number } | undefined)?.ttlMs ?? this.config.cache.ttlMs;
    if (ttlMs <= 0) return this.execute<T>(request, url, bucket);

    const fingerprint = this.authFingerprint(request.auth ?? 'auto');
    const key = `${request.method} ${url} ${fingerprint}`;
    const { value, cached } = await this.cache.getOrLoad(key, ttlMs, () =>
      this.execute<T>(request, url, bucket),
    );
    return { ...(value as XResult<T>), cached };
  }

  private async execute<T>(request: XRequest, url: string, bucket: string): Promise<XResult<T>> {
    await this.limiter.acquire(bucket, request.signal);

    let refreshed401 = false;
    for (;;) {
      const auth = await this.resolveAuth(request, url);
      const headers: Record<string, string> = {
        accept: 'application/json',
        'user-agent': this.config.http.userAgent,
        ...auth.headers,
        ...request.headers,
      };

      let body: string | Uint8Array | FormData | undefined;
      if (request.form) {
        body = request.form;
      } else if (request.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(request.body);
      }

      const response = await this.http.request({
        method: request.method,
        url,
        headers,
        body,
        signal: request.signal,
        idempotent: request.method !== 'POST' || Boolean(request.idempotent),
        retryOn429: this.config.rateLimit.mode === 'wait',
        maxRetryDelayMs: this.config.rateLimit.maxWaitMs,
      });

      const info = rateLimitFromHeaders(response.headers);
      this.limiter.observe(bucket, info);
      const requestId = response.headers.get('x-request-id') ?? undefined;

      if (response.status === 401 && auth.kind === 'oauth2' && !refreshed401) {
        refreshed401 = true;
        this.logger.debug({ url }, '401 from X, forcing token refresh and retrying once');
        try {
          await this.auth.getOAuth2AccessToken({ forceRefresh: true, signal: request.signal });
          continue;
        } catch {
          // Fall through to the normal error below with the original response.
        }
      }

      if (response.status < 200 || response.status >= 300) {
        throw parseXApiError(response.status, response.headers, response.text, { url, requestId });
      }

      const payload = parsePayload(response.text, response.status);
      if (isProblemPayload(payload)) {
        throw new XApiError({
          status: response.status,
          message: `X reported an error: ${JSON.stringify(payload.errors)}`,
          rateLimit: info,
          requestId,
          url,
        });
      }

      const record = payload as Record<string, unknown> | undefined;
      return {
        data: (record?.data ?? record) as T,
        includes: record?.includes as Includes | undefined,
        meta: record?.meta as Record<string, unknown> | undefined,
        status: response.status,
        headers: response.headers,
        cached: false,
        attempts: response.attempts,
        durationMs: response.durationMs,
        requestId,
        rateLimit: info,
      };
    }
  }

  /**
   * Chooses and materialises credentials.
   *
   * - `auto`: app-only bearer when available (cheapest, separate quota), user
   *   credentials otherwise.
   * - `user`: OAuth 2.0 when present, OAuth 1.0a otherwise.
   * - `app`: bearer, or the user token as a fallback.
   */
  private async resolveAuth(request: XRequest, url: string): Promise<ResolvedAuth> {
    const requested = request.auth ?? 'auto';
    const wantsUser = requested === 'user' || requested === 'oauth2' || requested === 'oauth1';
    const wantsApp = requested === 'app';

    if (requested === 'oauth2') return this.oauth2Headers();
    if (requested === 'oauth1') return this.oauth1Headers(request, url);

    if (wantsUser) {
      if (this.auth.hasOAuth2) return this.oauth2Headers();
      if (this.auth.hasOAuth1) return this.oauth1Headers(request, url);
      throw new AuthError(
        'This tool needs a user-context credential (OAuth 2.0 or OAuth 1.0a), but none is configured.',
        'missing_user_auth',
        'Run `npx x-mcp auth`, set X_OAUTH2_ACCESS_TOKEN, or provide OAuth 1.0a keys.',
      );
    }

    if (wantsApp) {
      if (this.auth.hasBearer) {
        return { kind: 'app', headers: { authorization: `Bearer ${this.auth.bearerToken as string}` } };
      }
      if (this.auth.hasUserAuth) return this.auth.userAuthKind === 'oauth2' ? this.oauth2Headers() : this.oauth1Headers(request, url);
      throw new AuthError(
        'This tool needs an app-only bearer token (X_BEARER_TOKEN) or a user session.',
        'missing_app_auth',
        'Set X_BEARER_TOKEN for app-only access, or run `npx x-mcp auth` for user context.',
      );
    }

    // auto
    if (this.auth.hasBearer) {
      return { kind: 'app', headers: { authorization: `Bearer ${this.auth.bearerToken as string}` } };
    }
    if (this.auth.hasOAuth2) return this.oauth2Headers();
    if (this.auth.hasOAuth1) return this.oauth1Headers(request, url);
    throw new AuthError('No X credentials are configured.', 'missing_app_auth', 'Set X_BEARER_TOKEN or run `npx x-mcp auth`.');
  }

  private async oauth2Headers(): Promise<ResolvedAuth> {
    const token = await this.auth.getOAuth2AccessToken();
    return { kind: 'oauth2', headers: { authorization: `Bearer ${token}` } };
  }

  private async oauth1Headers(request: XRequest, url: string): Promise<ResolvedAuth> {
    const credentials = this.auth.oauth1Credentials();
    const signed = signOAuth1(credentials, {
      method: request.method,
      url,
      query: request.query as Record<string, string | number | boolean | undefined | null> | undefined,
    });
    return { kind: 'oauth1', headers: { authorization: signed.header } };
  }

  private authFingerprint(kind: AuthKind): string {
    const secret =
      this.config.auth.bearerToken ??
      this.config.auth.oauth2?.accessToken ??
      this.config.auth.oauth1?.accessToken ??
      'anonymous';
    return `${kind}:${createHash('sha256').update(secret).digest('hex').slice(0, 12)}`;
  }

  private preview(request: XRequest, url: string): AuditedRequest {
    const userKind = this.auth.userAuthKind;
    const auth = userKind ?? (this.auth.hasBearer ? 'app' : 'none');
    const entry: AuditedRequest = {
      method: request.method,
      url,
      auth: auth === 'none' ? 'none (would fail: no credentials)' : `would use ${auth}`,
      ...(request.body !== undefined ? { body: request.body } : {}),
    };
    this.audit.push(entry);
    if (this.audit.length > 20) this.audit.shift();
    this.logger.info({ method: request.method, url }, 'dry-run: write not sent');
    return entry;
  }

  private fakeResult<T>(preview: AuditedRequest): XResult<T> {
    return {
      data: { dry_run: true, request: preview } as T,
      status: 0,
      headers: new Headers(),
      cached: false,
      attempts: 0,
      durationMs: 0,
      rateLimit: {},
      dryRun: true,
    };
  }

  auditSince(index: number): AuditedRequest[] {
    return this.audit.slice(index);
  }

  auditLength(): number {
    return this.audit.length;
  }

  cacheStats(): ReturnType<TtlCache<unknown>['stats']> {
    return this.cache.stats();
  }

  rateLimitSnapshot(): Record<string, { limit?: number; remaining?: number; resetAt?: string }> {
    return this.limiter.snapshot();
  }

  clearCache(): void {
    this.cache.clear();
  }

  async close(): Promise<void> {
    await this.http.close();
  }
}

function parsePayload(text: string, status: number): unknown {
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { data: { raw: text }, status };
  }
}

function isProblemPayload(payload: unknown): payload is { errors: unknown[] } {
  if (typeof payload !== 'object' || payload === null) return false;
  const candidate = payload as { errors?: unknown; data?: unknown };
  return Array.isArray(candidate.errors) && candidate.errors.length > 0 && candidate.data === undefined;
}

export type { Includes };
