import { XApiError, type RateLimitInfo } from './errors.ts';

interface BucketState {
  limit?: number;
  remaining?: number;
  resetAt?: number;
  updatedAt: number;
}

/** Collapses endpoint ids so all calls to the same route share a bucket. */
export function bucketKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replace(/\/\d{5,}(?=\/|$)/g, '/:id').replace(/\/[0-9]{10,}/g, '/:id')}`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RateLimiterOptions {
  mode: 'wait' | 'fail';
  maxWaitMs: number;
}

/**
 * Tracks the rate-limit window X reports for each endpoint bucket and, in
 * "wait" mode, sleeps just long enough for the window to roll over instead of
 * burning a request on a guaranteed 429.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private readonly options: RateLimiterOptions;

  constructor(options: RateLimiterOptions) {
    this.options = options;
  }

  observe(key: string, info: RateLimitInfo): void {
    if (info.limit === undefined && info.remaining === undefined && info.resetAt === undefined) return;
    this.buckets.set(key, { ...info, updatedAt: Date.now() });
  }

  private exhausted(key: string): { state: BucketState; waitMs: number } | undefined {
    const state = this.buckets.get(key);
    if (!state || state.remaining === undefined || state.remaining > 0) return undefined;
    if (state.resetAt === undefined) return undefined;
    const waitMs = state.resetAt - Date.now();
    if (waitMs <= 0) {
      this.buckets.delete(key);
      return undefined;
    }
    return { state, waitMs };
  }

  /** Waits for the current bucket if needed; returns the time spent waiting. */
  async acquire(key: string, signal?: AbortSignal): Promise<number> {
    const exhausted = this.exhausted(key);
    if (!exhausted) return 0;

    const { state, waitMs } = exhausted;
    if (this.options.mode === 'fail') throw this.tooManyRequests(key, state);

    const padded = waitMs + 250;
    if (padded > this.options.maxWaitMs) {
      throw new XApiError({
        status: 429,
        message: `Rate limit for ${key} resets in ${Math.ceil(waitMs / 1000)}s, longer than X_MCP_MAX_WAIT_MS (${this.options.maxWaitMs}ms).`,
        rateLimit: { limit: state.limit, remaining: state.remaining, resetAt: state.resetAt },
      });
    }
    await sleep(padded, signal);
    this.buckets.delete(key);
    return padded;
  }

  private tooManyRequests(key: string, state: BucketState): XApiError {
    return new XApiError({
      status: 429,
      message: `Rate limit for ${key} is exhausted until ${state.resetAt ? new Date(state.resetAt).toISOString() : 'an unknown time'}.`,
      rateLimit: { limit: state.limit, remaining: state.remaining, resetAt: state.resetAt },
    });
  }

  snapshot(): Record<string, { limit?: number; remaining?: number; resetAt?: string }> {
    const out: Record<string, { limit?: number; remaining?: number; resetAt?: string }> = {};
    for (const [key, state] of this.buckets) {
      out[key] = {
        limit: state.limit,
        remaining: state.remaining,
        resetAt: state.resetAt ? new Date(state.resetAt).toISOString() : undefined,
      };
    }
    return out;
  }
}
