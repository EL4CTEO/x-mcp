import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FakeXApi } from '../helpers/fake-x.ts';
import { createHarness, cleanupTempHomes, testConfig, type Harness } from '../helpers/harness.ts';

const FFMPEG_AVAILABLE = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true, timeout: 4_000 }).status === 0;
  } catch {
    return false;
  }
})();

function createSampleVideo(): Buffer | undefined {
  if (!FFMPEG_AVAILABLE) return undefined;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'x-mcp-video-'));
  const file = path.join(directory, 'sample.mp4');
  try {
    const result = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=320x240:rate=10',
        '-pix_fmt',
        'yuv420p',
        '-y',
        file,
      ],
      { stdio: 'ignore', timeout: 30_000, windowsHide: true },
    );
    if (result.status !== 0) return undefined;
    return fs.readFileSync(file);
  } catch {
    return undefined;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const sampleVideo = createSampleVideo();

const user = {
  id: '7',
  username: 'bob',
  name: 'Bob',
  description: 'builds tools',
  created_at: '2020-01-01T00:00:00.000Z',
  verified: true,
  public_metrics: { followers_count: 120, following_count: 40, tweet_count: 300, listed_count: 3 },
};

const post = {
  id: '100',
  text: 'hello world',
  author_id: '7',
  created_at: '2026-01-02T03:04:05.000Z',
  lang: 'en',
  conversation_id: '100',
  public_metrics: { like_count: 5, retweet_count: 2, reply_count: 1, quote_count: 0, bookmark_count: 1, impression_count: 500 },
  entities: { hashtags: [{ tag: 'mcp' }] },
  attachments: { media_keys: ['3_1'] },
};

const includes = {
  users: [user],
  media: [{ media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/media/pixel.png', alt_text: 'a pixel' }],
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

const videoPost = {
  id: '101',
  text: 'video post',
  author_id: '7',
  created_at: '2026-01-02T03:04:05.000Z',
  attachments: { media_keys: ['7_1'] },
};

const videoIncludes = {
  users: [user],
  media: [
    {
      media_key: '7_1',
      type: 'video',
      url: 'https://video.twimg.com/clip.mp4',
      preview_image_url: 'https://pbs.twimg.com/preview.jpg',
      duration_ms: 4_000,
      alt_text: 'a clip',
    },
  ],
};

const sampleVideoPost = {
  id: '102',
  text: 'real video',
  author_id: '7',
  created_at: '2026-01-02T03:04:05.000Z',
  attachments: { media_keys: ['9_1'] },
};

const sampleVideoIncludes = {
  users: [user],
  media: [
    {
      media_key: '9_1',
      type: 'video',
      url: 'https://video.twimg.com/sample.mp4',
      preview_image_url: 'https://pbs.twimg.com/preview.jpg',
      duration_ms: 2_000,
      alt_text: 'test pattern',
    },
  ],
};

let fake: FakeXApi;
let harness: Harness | undefined;

function tweetList(data: unknown[], nextToken?: string) {
  return { data, includes, meta: { result_count: data.length, ...(nextToken ? { next_token: nextToken } : {}) } };
}

beforeAll(async () => {
  fake = await new FakeXApi().start();
  includes.media[0]!.url = `${fake.baseUrl}/media/pixel.png`;
  videoIncludes.media[0]!.url = `${fake.baseUrl}/media/clip.mp4`;
  videoIncludes.media[0]!.preview_image_url = `${fake.baseUrl}/media/preview.jpg`;
  sampleVideoIncludes.media[0]!.url = `${fake.baseUrl}/media/sample.mp4`;
  sampleVideoIncludes.media[0]!.preview_image_url = `${fake.baseUrl}/media/preview.jpg`;
  fake
    .on('GET', '/media/pixel.png', () => ({ binary: PNG, headers: { 'content-type': 'image/png' } }))
    .on('GET', '/media/preview.jpg', () => ({ binary: JPEG, headers: { 'content-type': 'image/jpeg' } }))
    .on('GET', '/media/clip.mp4', () => ({ binary: Buffer.alloc(0), headers: { 'content-type': 'video/mp4' } }))
    .on('GET', '/media/sample.mp4', () => ({ binary: sampleVideo ?? Buffer.alloc(0), headers: { 'content-type': 'video/mp4' } }))
    .json('GET', '/2/tweets/101', { data: videoPost, includes: videoIncludes })
    .json('GET', '/2/tweets/102', { data: sampleVideoPost, includes: sampleVideoIncludes })
    .json('GET', '/2/tweets/100', { data: post, includes })
    .json('GET', '/2/tweets/404', { title: 'Not Found', detail: 'Could not find tweet with id: [404].', status: 404, type: 'about:blank' }, 404)
    .on('GET', '/2/tweets', () => {
      const ids = (fake.requests.at(-1)?.query.ids ?? '').split(',');
      return { body: tweetList(ids.map((id) => ({ ...post, id }))) };
    })
    .on('POST', '/2/tweets', () => ({ status: 201, body: { data: { id: '999', text: 'created' } } }))
    .json('DELETE', '/2/tweets/999', { data: { deleted: true } })
    .on('GET', '/2/tweets/search/recent', () => ({
      body: tweetList([post], 'next-page-token'),
    }))
    .json('PUT', '/2/tweets/100/hidden', { data: { hidden: true } })
    .json('GET', '/2/users/me', { data: user })
    .json('GET', '/2/users/by/username/bob', { data: user })
    .json('GET', '/2/users/7', { data: user })
    .on('GET', '/2/users/7/tweets', () => ({ body: tweetList([post]) }))
    .on('GET', '/2/users/7/timelines/reverse_chronological', () => ({ body: tweetList([post]) }))
    .on('GET', '/2/users/7/followers', () => ({
      body: {
        data: [user],
        meta: { result_count: 1, next_token: 'followers-next' },
      },
    }))
    .json('GET', '/2/users/7/blocking', {
      data: [user],
      meta: { result_count: 1 },
    })
    .json('POST', '/2/users/7/following', { data: { following: true } })
    .json('POST', '/2/users/7/likes', { data: { liked: true } })
    .json('DELETE', '/2/users/7/likes/100', { data: { liked: false } })
    .json('POST', '/2/users/7/retweets', { data: { retweeted: true } })
    .json('POST', '/2/users/7/bookmarks', { data: { bookmarked: true } })
    .on('GET', '/2/lists/42/tweets', () => ({ body: tweetList([post]) }))
    .json('GET', '/2/trends/by/woeid/1', {
      data: [
        { trend_name: '#MCP', tweet_count: 12_345 },
        { trend_name: '#AI', tweet_count: 9_000 },
      ],
    })
    .json('GET', '/2/users/personalized_trends', {
      data: [
        { trend_name: '#Agents', post_count: 777, category: 'Technology', trending_since: '2026-01-01T00:00:00.000Z' },
      ],
    })
    .on('GET', '/2/tweets/100/liking_users', () => ({
      body: { data: [user], meta: { result_count: 1, next_token: 'likers-next' } },
    }))
    .on('GET', '/2/dm_events', () => ({
      body: {
        data: [
          {
            id: '9',
            event_type: 'MessageCreate',
            dm_conversation_id: 'c-1',
            sender_id: '7',
            text: 'hello from a DM',
            created_at: '2026-01-02T00:00:00.000Z',
          },
        ],
        meta: { result_count: 1 },
      },
    }))
    .json('POST', '/2/dm_conversations/with/7/messages', { data: { dm_conversation_id: 'c-1', dm_event_id: '10' } })
    .json('GET', '/2/usage/tweets', { data: { cap: 10_000, project_usage: 42, daily_project_usage: { project_id: '1', usage: [] } } })
    // v2 media upload
    .json('POST', '/2/media/upload/initialize', { data: { id: '111', media_key: '3_111', expires_after_secs: 86_400 } }, 202)
    .json('POST', '/2/media/upload/111/append', { data: {} }, 204)
    .json('POST', '/2/media/upload/111/finalize', { data: { id: '111', processing_info: undefined } })
    .json('POST', '/2/media/metadata', { data: { id: '111' } });
});

afterAll(async () => {
  await fake.stop();
  cleanupTempHomes();
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  fake.reset();
});

describe('MCP protocol surface', () => {
  it('lists tools, resources and prompts with valid schemas', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    const tools = await harness.client.listTools();
    expect(tools.tools.length).toBe(harness.tools.length);
    expect(tools.tools.length).toBe(10);
    for (const tool of tools.tools) {
      expect(tool.name).toMatch(/^x_(posts|timelines|users|engagement|lists|spaces|trends|dms|media|meta)$/);
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
      expect(properties?.action).toBeTruthy();
      expect(tool.annotations?.readOnlyHint).toBeTypeOf('boolean');
    }

    const resources = await harness.client.listResources();
    expect(resources.resources.some((resource) => resource.uri === 'x://me')).toBe(true);
    const templates = await harness.client.listResourceTemplates();
    expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toEqual(
      expect.arrayContaining(['x://users/{username}', 'x://posts/{id}', 'x://lists/{id}']),
    );

    const prompts = await harness.client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(
      expect.arrayContaining(['draft_thread', 'reply_triage', 'account_report', 'summarize_conversation']),
    );
  });

  it('returns resource content and prompt messages', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    const textOf = (content: unknown): string => String((content as { text?: string }).text ?? '');
    const me = await harness.client.readResource({ uri: 'x://me' });
    const mePayload = JSON.parse(textOf(me.contents[0]));
    expect(mePayload).toMatchObject({ id: '7', username: 'bob' });

    const profile = await harness.client.readResource({ uri: 'x://users/bob' });
    expect(JSON.parse(textOf(profile.contents[0]))).toMatchObject({ username: 'bob' });

    const prompt = await harness.client.getPrompt({ name: 'draft_thread', arguments: { topic: 'MCP servers' } });
    expect(prompt.messages[0]?.content.type).toBe('text');
    expect(textOf(prompt.messages[0]?.content)).toContain('x_posts');
    expect(textOf(prompt.messages[0]?.content)).toContain('"search"');
    expect(textOf(prompt.messages[0]?.content)).toContain('MCP servers');
  });
});

describe('reads', () => {
  it('fetches and normalises a post with author and media', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    const result = await harness.call('x_posts', { action: 'get', tweet_id: '100' });
    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({
      id: '100',
      url: 'https://x.com/bob/status/100',
      text: 'hello world',
      author: { username: 'bob', verified: true },
      metrics: { likes: 5, reposts: 2 },
      hashtags: ['mcp'],
    });
    expect(result.json.media[0]).toMatchObject({ alt_text: 'a pixel', type: 'photo' });

    const request = fake.calls('GET', '/2/tweets/100')[0];
    expect(request?.headers.authorization).toBe('Bearer test-bearer-token');
    expect(request?.query['tweet.fields']).toContain('public_metrics');
    expect(request?.query.expansions).toContain('author_id');
  });

  it('batches post lookups and preserves requested ids', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    const result = await harness.call('x_posts', { action: 'get_many', tweet_ids: ['100', '101'] });
    expect(result.isError).toBe(false);
    expect(result.json.data).toHaveLength(2);
    expect(fake.calls('GET', '/2/tweets')[0]?.query.ids).toBe('100,101');
  });

  it('resolves usernames and returns profile metrics', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    const result = await harness.call('x_users', { action: 'get', username: 'bob' });
    expect(result.json).toMatchObject({ id: '7', username: 'bob', followers: 120, posts: 300 });
    expect(fake.calls('GET', '/2/users/by/username/bob')).toHaveLength(1);
  });

  it('searches posts with operators and returns a cursor', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    const result = await harness.call('x_posts', { action: 'search',
      query: 'mcp -is:retweet',
      max_results: 25,
      sort_order: 'relevancy',
    });
    expect(result.isError).toBe(false);
    expect(result.json.next_token).toBe('next-page-token');
    const request = fake.calls('GET', '/2/tweets/search/recent')[0];
    expect(request?.query.query).toBe('mcp -is:retweet');
    expect(request?.query.max_results).toBe('25');
    expect(request?.query.sort_order).toBe('relevancy');
  });

  it('exposes trends, timelines and followers', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    const trends = await harness.call('x_trends', { action: 'by_location', woeid: 1, max_trends: 10 });
    expect(trends.json.data[0]).toMatchObject({ name: '#MCP', posts: 12_345 });

    const personalized = await harness.call('x_trends', { action: 'personalized' });
    expect(personalized.json.data[0]).toMatchObject({ name: '#Agents', posts: 777, category: 'Technology' });
    expect(fake.calls('GET', '/2/users/personalized_trends')[0]?.query['personalized_trend.fields']).toContain('post_count');

    const timeline = await harness.call('x_timelines', { action: 'user', username: 'bob', max_results: 5 });
    expect(timeline.json.data[0].id).toBe('100');
    expect(fake.calls('GET', '/2/users/7/tweets')[0]?.query.max_results).toBe('5');

    const followers = await harness.call('x_users', { action: 'followers', username: 'bob', max_results: 100 });
    expect(followers.json.next_token).toBe('followers-next');
    expect(followers.json.data[0].username).toBe('bob');
  });

  it('uses pagination_token (not next_token) for likers', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    const result = await harness.call('x_posts', { action: 'likers', tweet_id: '100', max_results: 100, next_token: 'cursor-1' });
    expect(result.isError).toBe(false);
    expect(result.json.next_token).toBe('likers-next');
    const request = fake.calls('GET', '/2/tweets/100/liking_users')[0];
    expect(request?.query.pagination_token).toBe('cursor-1');
    expect(request?.query.next_token).toBeUndefined();
  });

  it('surfaces structured API errors with hints', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    const result = await harness.call('x_posts', { action: 'get', tweet_id: '404' });
    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({ status: 404 });
    expect(String(result.json.hint)).toMatch(/does not exist/);
  });

  it('reports authentication capabilities and blocked users', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    const status = await harness.call('x_meta', { action: 'auth_status' });
    expect(status.json.credentials).toMatchObject({ appOnlyBearer: true, oauth2: true });
    expect(status.json.capabilities).toMatchObject({ writes: true, directMessages: true, publicReads: true });

    const blocked = await harness.call('x_users', { action: 'blocked', max_results: 100 });
    expect(blocked.isError).toBe(false);
    expect(blocked.json.data[0].username).toBe('bob');
    expect(fake.calls('GET', '/2/users/7/blocking')).toHaveLength(1);
  });
});

describe('writes and guardrails', () => {
  it('posts with user auth and builds the request body', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    const result = await harness.call('x_posts', { action: 'create',
      text: 'hello from the test',
      reply_to: '100',
      media_ids: ['111'],
      reply_settings: 'following',
    });
    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({ id: '999', url: 'https://x.com/i/status/999' });
    const request = fake.calls('POST', '/2/tweets')[0];
    expect(request?.headers.authorization).toBe('Bearer test-user-token');
    expect(request?.json).toMatchObject({
      text: 'hello from the test',
      reply: { in_reply_to_tweet_id: '100' },
      media: { media_ids: ['111'] },
      reply_settings: 'following',
    });
  });

  it('publishes threads in order and chains replies', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    const result = await harness.call('x_posts', { action: 'create_thread',
      posts: [{ text: 'one' }, { text: 'two' }, { text: 'three' }],
    });
    expect(result.json).toMatchObject({ complete: true, posted_count: 3 });
    expect(result.json.published.map((entry: { id: string }) => entry.id)).toEqual(['999', '999', '999']);
    const bodies = fake.calls('POST', '/2/tweets').map((request) => request.json);
    expect(bodies[0]).toMatchObject({ text: 'one' });
    expect(bodies[1]).toMatchObject({ text: 'two', reply: { in_reply_to_tweet_id: '999' } });
    expect(bodies[2]).toMatchObject({ text: 'three', reply: { in_reply_to_tweet_id: '999' } });
  });

  it('likes, reposts and bookmarks as the authenticated account', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    expect((await harness.call('x_engagement', { action: 'like', tweet_id: '100' })).json).toMatchObject({ liked: true });
    expect((await harness.call('x_engagement', { action: 'repost', tweet_id: '100' })).json).toMatchObject({ reposted: true });
    expect((await harness.call('x_engagement', { action: 'bookmark', tweet_id: '100' })).json).toMatchObject({ bookmarked: true });
    expect(fake.calls('POST', '/2/users/7/likes')[0]?.json).toEqual({ tweet_id: '100' });
  });

  it('blocks every mutation in read-only mode', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl, readOnly: true }));
    const result = await harness.call('x_posts', { action: 'create', text: 'should not send' });
    expect(result.isError).toBe(true);
    expect(result.json.code).toBe('read_only');
    expect(fake.calls('POST', '/2/tweets')).toHaveLength(0);
    const read = await harness.call('x_posts', { action: 'get', tweet_id: '100' });
    expect(read.isError).toBe(false);
  });

  it('previews mutations in dry-run mode without sending them', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl, dryRun: true }));
    const result = await harness.call('x_posts', { action: 'create', text: 'dry run post', media_ids: ['111'] });
    expect(result.json).toMatchObject({ dry_run: true, tool: 'x_posts#create' });
    expect(result.json.requests[0]).toMatchObject({ method: 'POST' });
    expect(result.json.requests[0].url).toContain('/2/tweets');
    expect(result.json.requests[0].body).toMatchObject({ text: 'dry run post' });
    expect(fake.calls('POST', '/2/tweets')).toHaveLength(0);
  });

  it('explains missing user credentials instead of failing obscurely', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl, bearer: null, oauth2: false }));
    const result = await harness.call('x_users', { action: 'me' });
    expect(result.isError).toBe(true);
    expect(result.json.code).toBe('missing_user_auth');
    expect(String(result.json.hint)).toMatch(/x-mcp auth/);
  });

  it('signs requests with OAuth 1.0a when only classic credentials exist', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl, bearer: null, oauth2: false, oauth1: true }));
    const result = await harness.call('x_posts', { action: 'get', tweet_id: '100' });
    expect(result.isError).toBe(false);
    const authorization = String(fake.calls('GET', '/2/tweets/100')[0]?.headers.authorization);
    expect(authorization.startsWith('OAuth ')).toBe(true);
    expect(authorization).toContain('oauth_signature=');
    expect(authorization).toContain('oauth_consumer_key="consumer-key"');
  });
});

describe('caching and rate limits', () => {
  it('serves repeated reads from cache and invalidates after a write', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    const first = await harness.call('x_posts', { action: 'get', tweet_id: '100' });
    expect(first.isError).toBe(false);
    expect(first.structured?.text).toBe('hello world');
    const second = await harness.call('x_posts', { action: 'get', tweet_id: '100' });
    expect(second.isError).toBe(false);
    expect(fake.calls('GET', '/2/tweets/100')).toHaveLength(1);

    await harness.call('x_posts', { action: 'create', text: 'cache busting post' });
    await harness.call('x_posts', { action: 'get', tweet_id: '100' });
    expect(fake.calls('GET', '/2/tweets/100')).toHaveLength(2);
  });

  it('reports rate-limit windows and cache stats', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    await harness.call('x_posts', { action: 'get', tweet_id: '100' });
    const stats = await harness.call('x_meta', { action: 'rate_limits' });
    expect(stats.json.cache.hits + stats.json.cache.misses).toBeGreaterThan(0);
    expect(stats.json.mode).toBe('fail');
  });
});

describe('media and DMs', () => {
  it('uploads media through the v2 chunked flow and sets alt text', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    const pixel = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const result = await harness.call('x_media', { action: 'upload',
      base64: pixel.toString('base64'),
      filename: 'pixel.png',
      alt_text: 'a single pixel',
    });
    expect(result.isError).toBe(false);
    expect(result.json).toMatchObject({
      media_id: '111',
      media_type: 'image/png',
      category: 'tweet_image',
      auth: 'oauth2',
      processing_state: 'not_required',
    });
    const init = fake.calls('POST', '/2/media/upload/initialize')[0];
    expect(init?.json).toMatchObject({ media_type: 'image/png', total_bytes: pixel.length, media_category: 'tweet_image' });
    const append = fake.calls('POST', '/2/media/upload/111/append')[0];
    expect(append?.contentType).toContain('multipart/form-data');
    expect(append?.rawBody).toContain('segment_index');
    expect(fake.calls('POST', '/2/media/metadata')[0]?.json).toEqual({
      id: '111',
      metadata: { alt_text: { text: 'a single pixel' } },
    });
  });

  it('reads and sends DMs with user auth', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    const events = await harness.call('x_dms', { action: 'events', max_results: 10 });
    expect(events.json.data[0]).toMatchObject({ text: 'hello from a DM', conversation_id: 'c-1' });
    expect(fake.calls('GET', '/2/dm_events')[0]?.headers.authorization).toBe('Bearer test-user-token');

    const sent = await harness.call('x_dms', { action: 'send', username: 'bob', text: 'hi bob' });
    expect(sent.json).toMatchObject({ sent: true, conversation_id: 'c-1', event_id: '10' });
    expect(fake.calls('POST', '/2/dm_conversations/with/7/messages')[0]?.json).toEqual({ text: 'hi bob' });
  });

  it('reports API usage through the app-only endpoint', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl }));
    const usage = await harness.call('x_meta', { action: 'usage' });
    expect(usage.json).toMatchObject({ cap: 10_000, project_usage: 42 });
    expect(fake.calls('GET', '/2/usage/tweets')[0]?.headers.authorization).toBe('Bearer test-bearer-token');
  });

  it('returns photos as MCP image content that vision models can read', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl, allowPrivateMedia: true }));
    const result = await harness.call('x_media', { action: 'view', tweet_id: '100' });
    expect(result.isError).toBe(false);
    expect(result.structured).toMatchObject({
      tweet_id: '100',
      media: { kind: 'photo', alt_text: 'a pixel' },
    });

    const content = (result.raw as { content: Array<{ type: string; data?: string; mimeType?: string }> }).content;
    const images = content.filter((item) => item.type === 'image');
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe('image/png');
    const bytes = Buffer.from(images[0]?.data ?? '', 'base64');
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(result.structured?.images).toEqual([
      expect.objectContaining({ label: 'image', mimeType: 'image/png', bytes: PNG.byteLength }),
    ]);

    // Direct URL input follows the same path.
    const direct = await harness.call('x_media', { action: 'view', url: `${fake.baseUrl}/media/pixel.png` });
    expect(direct.isError).toBe(false);
    expect(direct.structured?.media).toMatchObject({ kind: 'photo' });
  });

  it('falls back to the preview frame for video when ffmpeg is unavailable', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl, allowPrivateMedia: true }));
    const result = await harness.call('x_media', { action: 'view', tweet_id: '101', frames: 2 });
    expect(result.isError).toBe(false);
    expect(result.structured?.media).toMatchObject({ kind: 'video', alt_text: 'a clip' });
    expect(result.structured?.media).toHaveProperty('duration_ms', 4_000);

    const content = (result.raw as { content: Array<{ type: string; data?: string; mimeType?: string }> }).content;
    const images = content.filter((item) => item.type === 'image');
    expect(images.length).toBeGreaterThanOrEqual(1);
    expect(images[0]?.mimeType).toMatch(/^image\//);
    if (result.structured?.ffmpeg === false) {
      expect(String(result.structured?.notes)).toMatch(/ffmpeg is not installed/);
    }
  });

  it.skipIf(!sampleVideo)('extracts real video frames with ffmpeg', async () => {
    harness = await createHarness(testConfig({ apiBase: fake.baseUrl, allowPrivateMedia: true }));
    const result = await harness.call('x_media', { action: 'view', tweet_id: '102', frames: 3 });
    expect(result.isError).toBe(false);
    expect(result.structured?.ffmpeg).toBe(true);
    expect(result.structured?.media).toMatchObject({ kind: 'video', duration_ms: 2_000 });

    const content = (result.raw as { content: Array<{ type: string; data?: string; mimeType?: string }> }).content;
    const images = content.filter((item) => item.type === 'image');
    expect(images).toHaveLength(3);
    expect(result.structured?.images).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'frame 1/3', mimeType: 'image/jpeg' }),
        expect.objectContaining({ label: 'frame 3/3' }),
      ]),
    );
    for (const image of images) {
      const bytes = Buffer.from(image.data ?? '', 'base64');
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8);
      expect(bytes.byteLength).toBeGreaterThan(1_000);
    }
  });
});
