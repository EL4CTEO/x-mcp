import { describe, expect, it } from 'vitest';
import { bucketKey, RateLimiter, sleep } from '../../src/x/rate-limit.ts';
import { XApiError } from '../../src/x/errors.ts';

describe('rate limiting', () => {
  it('normalises numeric ids into a single bucket', () => {
    expect(bucketKey('GET', '/2/tweets/1234567890123456789')).toBe('GET /2/tweets/:id');
    expect(bucketKey('GET', '/2/users/1234567890123456789/tweets')).toBe('GET /2/users/:id/tweets');
    expect(bucketKey('get', '/2/tweets/search/recent')).toBe('GET /2/tweets/search/recent');
  });

  it('fails fast when the bucket is exhausted and mode is fail', async () => {
    const limiter = new RateLimiter({ mode: 'fail', maxWaitMs: 1_000 });
    limiter.observe('GET /x', { remaining: 0, limit: 15, resetAt: Date.now() + 5_000 });
    await expect(limiter.acquire('GET /x')).rejects.toBeInstanceOf(XApiError);
  });

  it('waits for the reset and then clears the bucket in wait mode', async () => {
    const limiter = new RateLimiter({ mode: 'wait', maxWaitMs: 2_000 });
    limiter.observe('GET /x', { remaining: 0, limit: 15, resetAt: Date.now() + 50 });
    const startedAt = Date.now();
    const waited = await limiter.acquire('GET /x');
    expect(waited).toBeGreaterThanOrEqual(50);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
    expect(limiter.snapshot()['GET /x']).toBeUndefined();
    await expect(limiter.acquire('GET /x')).resolves.toBe(0);
  });

  it('refuses to wait past the configured maximum', async () => {
    const limiter = new RateLimiter({ mode: 'wait', maxWaitMs: 100 });
    limiter.observe('GET /x', { remaining: 0, resetAt: Date.now() + 60_000 });
    await expect(limiter.acquire('GET /x')).rejects.toThrow(/longer than X_MCP_MAX_WAIT_MS/);
  });

  it('allows requests when remaining is above zero or the window passed', async () => {
    const limiter = new RateLimiter({ mode: 'fail', maxWaitMs: 1_000 });
    limiter.observe('GET /x', { remaining: 3, resetAt: Date.now() + 1_000 });
    await expect(limiter.acquire('GET /x')).resolves.toBe(0);
    limiter.observe('GET /x', { remaining: 0, resetAt: Date.now() - 1 });
    await expect(limiter.acquire('GET /x')).resolves.toBe(0);
  });

  it('aborts a pending wait', async () => {
    const controller = new AbortController();
    const limiter = new RateLimiter({ mode: 'wait', maxWaitMs: 5_000 });
    limiter.observe('GET /x', { remaining: 0, resetAt: Date.now() + 2_000 });
    const pending = limiter.acquire('GET /x', controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('sleep resolves and rejects with an abort reason', async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1_000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
