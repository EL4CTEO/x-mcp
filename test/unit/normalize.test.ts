import { describe, expect, it } from 'vitest';
import {
  normalizeDmEvents,
  normalizeTrend,
  normalizeTweet,
  normalizeTweetList,
  normalizeUser,
  normalizeUserList,
  contextFrom,
} from '../../src/x/normalize.ts';
import { normalizeMedia } from '../../src/x/normalize.ts';

const payload = {
  data: [
    {
      id: '100',
      text: 'truncated…',
      author_id: '7',
      created_at: '2026-01-02T03:04:05.000Z',
      lang: 'en',
      conversation_id: '90',
      possibly_sensitive: false,
      reply_settings: 'everyone',
      public_metrics: {
        like_count: 12,
        retweet_count: 3,
        reply_count: 4,
        quote_count: 1,
        bookmark_count: 2,
        impression_count: 1_000,
      },
      entities: {
        hashtags: [{ tag: 'ai' }, { tag: 'mcp' }],
        mentions: [{ username: 'alice' }],
        urls: [{ url: 'https://t.co/x', expanded_url: 'https://example.com', display_url: 'example.com' }],
      },
      attachments: { media_keys: ['3_1'] },
      referenced_tweets: [{ type: 'quoted', id: '200' }],
      note_tweet: { text: 'the full long form text' },
    },
  ],
  includes: {
    users: [
      {
        id: '7',
        username: 'bob',
        name: 'Bob',
        description: 'builds things',
        verified: true,
        public_metrics: { followers_count: 10, following_count: 5, tweet_count: 3, listed_count: 1 },
      },
    ],
    media: [
      {
        media_key: '3_1',
        type: 'photo',
        url: 'https://pbs.twimg.com/media/x.jpg',
        alt_text: 'a diagram',
        width: 800,
        height: 600,
      },
    ],
    tweets: [
      {
        id: '200',
        text: 'quoted post',
        author_id: '7',
        public_metrics: { like_count: 1 },
      },
    ],
  },
  meta: { next_token: 'next-1', result_count: 1 },
};

describe('normalisation', () => {
  it('flattens posts, resolves authors/media and preserves long-form text', () => {
    const result = normalizeTweetList(payload);
    expect(result.next_token).toBe('next-1');
    const post = result.data[0] as Record<string, any>;
    expect(post.id).toBe('100');
    expect(post.url).toBe('https://x.com/bob/status/100');
    expect(post.text).toBe('the full long form text');
    expect(post.author).toMatchObject({ id: '7', username: 'bob', name: 'Bob', verified: true });
    expect(post.metrics).toMatchObject({ likes: 12, reposts: 3, replies: 4, quotes: 1, bookmarks: 2, impressions: 1_000 });
    expect(post.media[0]).toMatchObject({ media_key: '3_1', type: 'photo', alt_text: 'a diagram', width: 800 });
    expect(post.hashtags).toEqual(['ai', 'mcp']);
    expect(post.mentions).toEqual(['alice']);
    expect(post.urls[0].expanded_url).toBe('https://example.com');
    expect(post.quoted_tweet_id).toBe('200');
    expect(post.referenced_post).toMatchObject({ id: '200', text: 'quoted post' });
    expect(post.possibly_sensitive).toBeUndefined();
  });

  it('uses the best mp4 variant for videos', () => {
    const context = contextFrom({
      media: [
        {
          media_key: '7_1',
          type: 'video',
          preview_image_url: 'https://pbs.twimg.com/p.jpg',
          variants: [
            { content_type: 'video/mp4', url: 'https://video/low.mp4', bit_rate: 100 },
            { content_type: 'video/mp4', url: 'https://video/high.mp4', bit_rate: 900 },
            { content_type: 'application/x-mpegURL', url: 'https://video/playlist.m3u8' },
          ],
        },
      ],
    });
    const media = normalizeMedia(context.media.get('7_1') as Record<string, unknown>);
    expect(media.url).toBe('https://video/high.mp4');
    expect(media.preview_image_url).toBe('https://pbs.twimg.com/p.jpg');
  });

  it('normalises user profiles', () => {
    const user = normalizeUser({
      id: '7',
      username: 'bob',
      name: 'Bob',
      location: 'Rome',
      public_metrics: { followers_count: 10, following_count: 5, tweet_count: 3, listed_count: 1 },
    });
    expect(user).toMatchObject({
      id: '7',
      username: 'bob',
      url: 'https://x.com/bob',
      followers: 10,
      following: 5,
      posts: 3,
      listed: 1,
    });
  });

  it('handles list envelopes with included tweets', () => {
    const result = normalizeUserList({
      data: [{ id: '7', username: 'bob', name: 'Bob' }],
      includes: { tweets: [{ id: '200', text: 'pinned post', author_id: '7' }] },
      meta: { result_count: 1 },
    } as Record<string, unknown>);
    expect(result.data[0]).toMatchObject({ username: 'bob' });
    expect(result.included?.tweets?.[0]).toMatchObject({ id: '200', text: 'pinned post' });
  });

  it('does not recurse infinitely on self-referencing posts', () => {
    const context = contextFrom({
      users: [{ id: '1', username: 'self' }],
      tweets: [{ id: '5', text: 'quoted', referenced_tweets: [{ type: 'quoted', id: '5' }] }],
    });
    const post = normalizeTweet(
      { id: '5', text: 'root', referenced_tweets: [{ type: 'quoted', id: '5' }] },
      context,
    );
    expect((post.referenced_post as Record<string, unknown>).text).toBe('quoted');
    expect((post.referenced_post as Record<string, unknown>).referenced_post).toBeUndefined();
  });

  it('normalises DM events and trends', () => {
    const events = normalizeDmEvents({
      data: [
        {
          id: '9',
          event_type: 'MessageCreate',
          dm_conversation_id: 'c1',
          sender_id: '7',
          text: 'hello',
          created_at: '2026-01-01T00:00:00Z',
          attachments: { media_keys: ['3_1'] },
        },
      ],
      includes: { media: [{ media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/dm.jpg', alt_text: 'dm image' }] },
      meta: { next_token: 'n' },
    });
    expect(events.data[0]).toMatchObject({ id: '9', text: 'hello', conversation_id: 'c1', sender_id: '7' });
    expect((events.data[0] as Record<string, unknown>).attachments).toEqual([
      expect.objectContaining({ media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/dm.jpg' }),
    ]);
    expect(events.next_token).toBe('n');

    expect(normalizeTrend({ trend_name: '#AI', tweet_count: 12_000 })).toMatchObject({
      name: '#AI',
      posts: 12_000,
      url: 'https://x.com/search?q=%23AI',
    });
    expect(normalizeTrend({ trend_name: '#Agents', post_count: 777, category: 'Technology', trending_since: '2026-01-01T00:00:00Z' })).toMatchObject({
      name: '#Agents',
      posts: 777,
      category: 'Technology',
    });
  });
});
