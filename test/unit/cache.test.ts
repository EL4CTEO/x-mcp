import { describe, expect, it } from 'vitest';
import { TtlCache } from '../../src/x/cache.ts';

describe('TtlCache', () => {
  it('expires entries and reports stats', () => {
    let now = 1_000;
    const cache = new TtlCache<string>(10, () => now);
    cache.set('a', 'value', 100);
    expect(cache.get('a')).toBe('value');
    now = 1_100;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(1);
  });

  it('evicts the least recently used entry', () => {
    let now = 0;
    const cache = new TtlCache<number>(2, () => now);
    cache.set('a', 1, 1_000);
    now = 1;
    cache.set('b', 2, 1_000);
    now = 2;
    expect(cache.get('a')).toBe(1); // touch a
    now = 3;
    cache.set('c', 3, 1_000); // evicts b
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.stats().evictions).toBe(1);
  });

  it('coalesces concurrent loads for the same key', async () => {
    const cache = new TtlCache<string>(10);
    let loads = 0;
    const loader = async () => {
      loads++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'loaded';
    };
    const [first, second, third] = await Promise.all([
      cache.getOrLoad('key', 1_000, loader),
      cache.getOrLoad('key', 1_000, loader),
      cache.getOrLoad('key', 1_000, loader),
    ]);
    expect(loads).toBe(1);
    expect(first.value).toBe('loaded');
    expect(second.cached).toBe(true);
    expect(third.cached).toBe(true);
    const fourth = await cache.getOrLoad('key', 1_000, loader);
    expect(fourth.cached).toBe(true);
    expect(loads).toBe(1);
  });

  it('does not cache rejected loads', async () => {
    const cache = new TtlCache<string>(10);
    let attempts = 0;
    const failing = async () => {
      attempts++;
      throw new Error('boom');
    };
    await expect(cache.getOrLoad('key', 1_000, failing)).rejects.toThrow('boom');
    await expect(cache.getOrLoad('key', 1_000, failing)).rejects.toThrow('boom');
    expect(attempts).toBe(2);
    expect(cache.size).toBe(0);
  });

  it('skips caching when ttl is zero and can be cleared', async () => {
    const cache = new TtlCache<string>(10);
    await cache.getOrLoad('key', 0, async () => 'value');
    expect(cache.size).toBe(0);
    cache.set('key', 'value', 1_000);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
