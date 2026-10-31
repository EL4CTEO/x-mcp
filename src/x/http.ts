import { Agent, EnvHttpProxyAgent, type Dispatcher } from 'undici';
import type { Logger } from '../logger.ts';
import { XNetworkError } from './errors.ts';
import { sleep } from './rate-limit.ts';

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array | FormData | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Whether the request may be retried after a network failure. Never true for
   * POST /2/tweets: a timeout does not prove the mutation did not happen.
   */
  idempotent: boolean;
  /** Retry 429 responses (only when the caller is willing to wait). */
  retryOn429?: boolean;
  maxRetryDelayMs?: number;
  acceptEncoding?: string;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
  attempts: number;
  durationMs: number;
}

export interface HttpTransportOptions {
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  proxy?: string | undefined;
  logger: Logger;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpTransport {
  private readonly dispatcher: Dispatcher;
  private readonly options: HttpTransportOptions;
  private readonly maxRetryDelayMs = 30_000;

  constructor(options: HttpTransportOptions) {
    this.options = options;
    this.dispatcher = options.proxy
      ? new EnvHttpProxyAgent({ httpProxy: options.proxy, httpsProxy: options.proxy })
      : new Agent({
          keepAliveTimeout: 30_000,
          keepAliveMaxTimeout: 120_000,
          connections: 32,
          pipelining: 1,
          connect: { timeout: Math.min(options.timeoutMs, 10_000) },
        });
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    const startedAt = Date.now();
    const maxRetries = this.options.maxRetries;
    const retryOn429 = request.retryOn429 ?? false;

    for (let attempt = 1; ; attempt++) {
      const signal = combineSignals(request.signal, this.options.timeoutMs);
      let response: Response;
      try {
        response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body as RequestInit['body'],
          signal,
          redirect: 'follow',
          dispatcher: this.dispatcher,
        });
      } catch (error) {
        if (request.signal?.aborted) throw request.signal.reason ?? error;
        const timedOut = isTimeout(error);
        const retryable = request.idempotent && attempt <= maxRetries;
        if (retryable) {
          const delay = backoff(attempt, this.options.retryBaseMs);
          this.options.logger.debug({ attempt, delay, url: request.url }, 'network error, retrying');
          await sleep(delay, request.signal);
          continue;
        }
        throw new XNetworkError(
          timedOut
            ? `Request to X timed out after ${this.options.timeoutMs}ms: ${request.method} ${request.url}`
            : `Network error calling X (${request.method} ${request.url}): ${errorMessage(error)}`,
          error,
          request.idempotent,
        );
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (request.signal?.aborted) throw request.signal.reason ?? error;
        throw new XNetworkError(`Failed reading the X response body: ${errorMessage(error)}`, error, request.idempotent);
      }

      const retryableStatus =
        RETRYABLE_STATUS.has(response.status) &&
        (response.status !== 429 || retryOn429) &&
        attempt <= maxRetries;

      if (response.ok || !retryableStatus) {
        const durationMs = Date.now() - startedAt;
        this.options.logger.debug(
          {
            method: request.method,
            url: request.url,
            status: response.status,
            attempts: attempt,
            durationMs,
            bytes: text.length,
          },
          'x api request',
        );
        return { status: response.status, headers: response.headers, text, attempts: attempt, durationMs };
      }

      const delay = retryDelay(response.headers, attempt, this.options.retryBaseMs);
      if (delay > (request.maxRetryDelayMs ?? this.maxRetryDelayMs)) {
        return {
          status: response.status,
          headers: response.headers,
          text,
          attempts: attempt,
          durationMs: Date.now() - startedAt,
        };
      }
      this.options.logger.debug(
        { method: request.method, url: request.url, status: response.status, delay, attempt },
        'retrying X request',
      );
      await sleep(delay, request.signal);
    }
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'TimeoutError'
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
  }
  return String(error);
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function retryDelay(headers: Headers, attempt: number, baseMs: number): number {
  const after = parseRetryAfter(headers);
  if (after !== undefined) return Math.min(after, 15 * 60_000);

  const reset = Number(headers.get('x-rate-limit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    const untilReset = reset * 1000 - Date.now();
    if (untilReset > 0) return Math.min(untilReset + 250, 15 * 60_000);
  }
  return backoff(attempt, baseMs);
}

function backoff(attempt: number, baseMs: number): number {
  const exponential = baseMs * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.random() * Math.min(exponential, 1_000);
  return Math.round(exponential + jitter);
}
