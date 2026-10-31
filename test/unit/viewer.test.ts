import { describe, expect, it } from 'vitest';
import { frameTimestamps, kindFromUrl } from '../../src/x/viewer.ts';

describe('media viewer helpers', () => {
  it('spreads video frames evenly and never samples the edges', () => {
    expect(frameTimestamps(10_000, 3)).toEqual([2.5, 5, 7.5]);
    expect(frameTimestamps(4_000, 2)).toEqual([1.333, 2.667]);
    expect(frameTimestamps(undefined, 3)).toEqual([0]);
    expect(frameTimestamps(0, 3)).toEqual([0]);
    expect(frameTimestamps(1_000, 99)).toHaveLength(6);
    expect(frameTimestamps(1_000, 0)).toHaveLength(1);
    const frames = frameTimestamps(10_000, 6);
    expect(frames[0]).toBeGreaterThan(0);
    expect(frames.at(-1)).toBeLessThan(10);
  });

  it('infers media kind from a URL when X metadata is not available', () => {
    expect(kindFromUrl('https://pbs.twimg.com/media/x.jpg?name=large')).toBe('photo');
    expect(kindFromUrl('https://pbs.twimg.com/tweet_video/x.mp4')).toBe('video');
    expect(kindFromUrl('https://example.com/cat.gif')).toBe('animated_gif');
    expect(kindFromUrl('https://example.com/asset')).toBe('auto');
    expect(kindFromUrl('not a url')).toBe('auto');
  });
});
