import { z } from 'zod';
import type { ActionTool } from './define.ts';
import type { XResult } from '../x/client.ts';
import { normalizeTweetList, normalizeTweetSingle, normalizeUser, type NormalizedList } from '../x/normalize.ts';
import { XApiError } from '../x/errors.ts';
import { maxResults, paginationToken, replySettings, timeRange, tweetId } from './schemas.ts';
import { postQuery as tweetFields, userQuery } from './query.ts';

type Json = Record<string, unknown>;

function listFrom<T>(res: XResult<T[]>): NormalizedList {
  return normalizeTweetList({ data: res.data, includes: res.includes, meta: res.meta, errors: res.errors });
}

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

export const postTools: ActionTool[] = [
  {
    action: 'create',
    name: 'x_post',
    title: 'Create a post',
    description:
      'Publish a post (tweet), reply or quote on X as the authenticated account. Use media_ids from x_upload_media to attach up to 4 images, 1 GIF or 1 video. Polls take 2-4 options of at most 25 characters. Requires OAuth 2.0/1.0a user auth. Check the text carefully before sending: this is publicly visible and cannot be undone except by deleting.',
    toolset: 'posts',
    annotations: writeAnnotations,
    inputSchema: {
      text: z.string().min(1).max(25_000).describe('Post text. Standard accounts are limited to 280 characters; X enforces it.'),
      reply_to: tweetId.optional().describe('Post id to reply to.'),
      quote_of: tweetId.optional().describe('Post id to quote. Note: X currently limits quote posting to Enterprise plans.'),
      media_ids: z.array(z.string().regex(/^\d{1,19}$/)).min(1).max(4).optional().describe('Media ids from x_upload_media.'),
      poll: z
        .object({
          options: z.array(z.string().min(1).max(25)).min(2).max(4),
          duration_minutes: z.number().int().min(5).max(10_080),
        })
        .optional()
        .describe('Poll configuration: 2-4 options, duration 5-10080 minutes.'),
      reply_settings: replySettings,
      community_id: z.string().regex(/^\d{1,19}$/).optional().describe('Community id to post into.'),
      made_with_ai: z.boolean().optional().describe('Disclose that the post contains AI-generated media.'),
      paid_partnership: z.boolean().optional().describe('Disclose a paid partnership.'),
    },
    async handler(args, ctx, extra) {
      const body: Record<string, unknown> = { text: args.text };
      if (args.reply_to) body.reply = { in_reply_to_tweet_id: args.reply_to };
      if (args.quote_of) body.quote_tweet_id = args.quote_of;
      if (args.media_ids?.length) body.media = { media_ids: args.media_ids };
      if (args.poll) body.poll = args.poll;
      if (args.reply_settings) body.reply_settings = args.reply_settings;
      if (args.community_id) body.community_id = args.community_id;
      if (args.made_with_ai) body.made_with_ai = true;
      if (args.paid_partnership) body.paid_partnership = true;

      const res = await ctx.x.request<{ id?: string; text?: string }>({
        method: 'POST',
        path: '/2/tweets',
        auth: 'user',
        body,
        signal: extra.signal,
      });
      const id = res.data.id;
      if (!id) throw new Error('X accepted the request but did not return a post id.');
      return {
        id,
        url: `https://x.com/i/status/${id}`,
        text: res.data.text ?? args.text,
        reply_to: args.reply_to,
        quoted: args.quote_of,
        media_ids: args.media_ids,
      };
    },
  },
  {
    action: 'create_thread',
    name: 'x_post_thread',
    title: 'Publish a thread',
    description:
      'Publish a multi-post thread by chaining replies. Posts are sent sequentially; if one fails, the response reports which posts were already published (and their ids) so the agent can recover without duplicating content. All posts are validated up-front. Requires user auth.',
    toolset: 'posts',
    annotations: writeAnnotations,
    inputSchema: {
      posts: z
        .array(
          z.object({
            text: z.string().min(1).max(25_000),
            media_ids: z.array(z.string().regex(/^\d{1,19}$/)).min(1).max(4).optional(),
          }),
        )
        .min(2)
        .max(25)
        .describe('Thread posts in order (2-25).'),
      reply_settings: replySettings,
    },
    async handler(args, ctx, extra) {
      const published: Array<{ id: string; url: string; text: string }> = [];
      let replyTo: string | undefined;
      for (let index = 0; index < args.posts.length; index++) {
        const post = args.posts[index] as { text: string; media_ids?: string[] };
        try {
          const body: Record<string, unknown> = { text: post.text };
          if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };
          if (post.media_ids?.length) body.media = { media_ids: post.media_ids };
          if (args.reply_settings) body.reply_settings = args.reply_settings;
          const res = await ctx.x.request<{ id?: string; text?: string }>({
            method: 'POST',
            path: '/2/tweets',
            auth: 'user',
            body,
            signal: extra.signal,
          });
          const id = res.data.id;
          if (!id) throw new Error('X did not return a post id.');
          published.push({ id, url: `https://x.com/i/status/${id}`, text: res.data.text ?? post.text });
          replyTo = id;
        } catch (error) {
          if (extra.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
          const failure = error instanceof XApiError ? error.toJSON() : { error: error instanceof Error ? error.message : String(error) };
          return {
            complete: false,
            partial: published.length > 0,
            posted_count: published.length,
            failed_at: index,
            error: failure,
            published,
            hint:
              published.length > 0
                ? 'Some posts were already published. Continue by replying to the last published id, or delete them with x_posts action "delete".'
                : 'Nothing was published.',
          };
        }
      }
      return {
        complete: true,
        posted_count: published.length,
        thread_id: published[0]?.id,
        url: published[0]?.url,
        published,
      };
    },
  },
  {
    action: 'delete',
    name: 'x_delete_post',
    title: 'Delete a post',
    description: 'Delete a post you authored. Requires user auth with tweet.write. This cannot be undone.',
    toolset: 'posts',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: { tweet_id: tweetId },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<{ deleted?: boolean }>({
        method: 'DELETE',
        path: `/2/tweets/${args.tweet_id}`,
        auth: 'user',
        signal: extra.signal,
      });
      return { deleted: res.data.deleted === true, id: args.tweet_id };
    },
  },
  {
    action: 'get',
    name: 'x_get_post',
    title: 'Get a post by id',
    description:
      'Fetch one post with its author, metrics, media, entities and (when present) the quoted or reposted post. This returns media URLs only; to actually see an image or video frame, pass the id to x_get_media. Billed as one post read.',
    toolset: 'posts',
    annotations: readAnnotations,
    inputSchema: {
      tweet_id: tweetId,
    },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json>({
        method: 'GET',
        path: `/2/tweets/${args.tweet_id}`,
        auth: 'auto',
        query: tweetFields(),
        signal: extra.signal,
      });
      const tweet = normalizeTweetSingle({ data: res.data, includes: res.includes });
      if (!tweet) throw new Error(`Post ${args.tweet_id} was not found or is not visible.`);
      return tweet;
    },
  },
  {
    action: 'get_many',
    name: 'x_get_posts',
    title: 'Get multiple posts by id',
    description:
      'Fetch up to 100 posts in one request. Far cheaper than calling x_get_post in a loop: X counts once per returned post, but you save round trips and rate-limit budget.',
    toolset: 'posts',
    annotations: readAnnotations,
    inputSchema: {
      tweet_ids: z.array(tweetId).min(1).max(100).describe('1-100 post ids.'),
    },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: '/2/tweets',
        auth: 'auto',
        query: { ids: args.tweet_ids.join(','), ...tweetFields() },
        signal: extra.signal,
      });
      return listFrom(res);
    },
  },
  {
    action: 'search',
    name: 'x_search_posts',
    title: 'Search posts',
    description:
      'Search X posts with the v2 search operators. Use `archive: true` for the full archive (requires an elevated plan); otherwise the recent index covers the last 7 days. Operators: from:, to:, @mention, #hashtag, "exact phrase", OR, -, is:retweet, is:reply, is:verified, has:media, has:links, lang:en, -is:retweet, conversation_id:, url:, place_country:. Recent search supports 10-100 results per page.',
    toolset: 'posts',
    annotations: readAnnotations,
    inputSchema: {
      query: z.string().min(1).max(4_096).describe('Search query using X search operators.'),
      max_results: maxResults(10, 100, 10),
      next_token: paginationToken,
      sort_order: z.enum(['recency', 'relevancy']).default('recency').describe('Result ordering (recent search only).'),
      archive: z.boolean().default(false).describe('Use full-archive search instead of the 7-day recent index.'),
      ...timeRange,
    },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: args.archive ? '/2/tweets/search/all' : '/2/tweets/search/recent',
        auth: 'auto',
        query: {
          query: args.query,
          max_results: args.max_results,
          next_token: args.next_token,
          ...(args.archive ? {} : { sort_order: args.sort_order }),
          start_time: args.start_time,
          end_time: args.end_time,
          ...tweetFields(),
        },
        cache: { ttlMs: 15_000 },
        signal: extra.signal,
      });
      return { query: args.query, archive: args.archive, ...listFrom(res) };
    },
  },
  {
    action: 'count',
    name: 'x_count_posts',
    title: 'Count posts over time',
    description:
      'Get post volume for a query without retrieving the posts themselves. Much cheaper than searching when you only need trend/volume data. Granularity is minute, hour or day. Recent counts cover up to 7 days; archive: true uses full-archive counts.',
    toolset: 'posts',
    annotations: readAnnotations,
    inputSchema: {
      query: z.string().min(1).max(4_096),
      granularity: z.enum(['minute', 'hour', 'day']).default('hour'),
      archive: z.boolean().default(false),
      next_token: paginationToken,
      ...timeRange,
    },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: args.archive ? '/2/tweets/counts/all' : '/2/tweets/counts/recent',
        auth: 'auto',
        query: {
          query: args.query,
          granularity: args.granularity,
          next_token: args.next_token,
          start_time: args.start_time,
          end_time: args.end_time,
        },
        cache: { ttlMs: 30_000 },
        signal: extra.signal,
      });
      const meta = res.meta as { total_tweet_count?: number; next_token?: string } | undefined;
      return {
        query: args.query,
        total: meta?.total_tweet_count,
        next_token: meta?.next_token,
        buckets: res.data,
      };
    },
  },
  {
    action: 'thread',
    name: 'x_get_thread',
    title: 'Read a conversation thread',
    description:
      'Reconstruct a conversation: fetches the root post and finds replies via conversation_id search. Recent search only covers the last 7 days, so older conversations may return only the root. Results are ordered oldest-first.',
    toolset: 'posts',
    annotations: readAnnotations,
    inputSchema: {
      tweet_id: tweetId.describe('Any post in the conversation (root or reply).'),
      max_replies: maxResults(10, 100, 50),
    },
    async handler(args, ctx, extra) {
      const rootRes = await ctx.x.request<Json>({
        method: 'GET',
        path: `/2/tweets/${args.tweet_id}`,
        auth: 'auto',
        query: tweetFields(),
        signal: extra.signal,
      });
      const root = normalizeTweetSingle({ data: rootRes.data, includes: rootRes.includes });
      const conversationId =
        (root?.conversation_id as string | undefined) ?? args.tweet_id;
      const repliesRes = await ctx.x.request<Json[]>({
        method: 'GET',
        path: '/2/tweets/search/recent',
        auth: 'auto',
        query: {
          query: `conversation_id:${conversationId} -is:retweet`,
          max_results: args.max_replies,
          ...tweetFields(),
        },
        cache: { ttlMs: 15_000 },
        signal: extra.signal,
      }).catch((error: unknown) => {
        if (extra.signal?.aborted) throw error;
        return undefined;
      });
      const page = repliesRes ? listFrom(repliesRes) : undefined;
      const replies = page?.data ?? [];
      const warning = repliesRes
        ? undefined
        : 'The recent-search index could not be queried (older than 7 days or no access); only the root post is returned.';
      const seen = new Set<string>([String(root?.id ?? args.tweet_id)]);
      const merged = [root, ...replies].filter((post): post is Json => Boolean(post)).filter((post) => {
        const id = String(post.id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      merged.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
      return {
        conversation_id: conversationId,
        root,
        replies: merged.filter((post) => String(post.id) !== String(root?.id)),
        count: merged.length,
        truncated: Boolean(page?.next_token) || replies.length >= args.max_replies,
        ...(warning ? { warning } : {}),
      };
    },
  },
  {
    action: 'likers',
    name: 'x_get_likers',
    title: 'List users who liked a post',
    description: 'Returns up to 100 users per page who liked the post. Requires user auth (OAuth 2.0 like.read or OAuth 1.0a).',
    toolset: 'posts',
    annotations: readAnnotations,
    inputSchema: { tweet_id: tweetId, max_results: maxResults(1, 100, 100), next_token: paginationToken },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/tweets/${args.tweet_id}/liking_users`,
        auth: 'user',
        query: { max_results: args.max_results, pagination_token: args.next_token, ...userQuery() },
        cache: { ttlMs: 60_000 },
        signal: extra.signal,
      });
      const users = (res.data ?? []).map((user) => normalizeUser(user));
      return { tweet_id: args.tweet_id, users, next_token: (res.meta as Json | undefined)?.next_token, result_count: users.length };
    },
  },
  {
    action: 'reposters',
    name: 'x_get_reposters',
    title: 'List users who reposted a post',
    description: 'Returns up to 100 users per page who reposted the post. Requires user auth.',
    toolset: 'posts',
    annotations: readAnnotations,
    inputSchema: { tweet_id: tweetId, max_results: maxResults(1, 100, 100), next_token: paginationToken },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/tweets/${args.tweet_id}/retweeted_by`,
        auth: 'user',
        query: { max_results: args.max_results, pagination_token: args.next_token, ...userQuery() },
        cache: { ttlMs: 60_000 },
        signal: extra.signal,
      });
      const users = (res.data ?? []).map((user) => normalizeUser(user));
      return { tweet_id: args.tweet_id, users, next_token: (res.meta as Json | undefined)?.next_token, result_count: users.length };
    },
  },
  {
    action: 'quotes',
    name: 'x_get_quotes',
    title: 'List quote posts',
    description: 'Returns up to 100 posts that quote the given post, with authors and metrics.',
    toolset: 'posts',
    annotations: readAnnotations,
    inputSchema: { tweet_id: tweetId, max_results: maxResults(10, 100, 20), next_token: paginationToken },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/tweets/${args.tweet_id}/quote_tweets`,
        auth: 'auto',
        query: { max_results: args.max_results, next_token: args.next_token, ...tweetFields() },
        cache: { ttlMs: 30_000 },
        signal: extra.signal,
      });
      return { tweet_id: args.tweet_id, ...listFrom(res) };
    },
  },
  {
    action: 'hide_reply',
    name: 'x_hide_reply',
    title: 'Hide or unhide a reply',
    description:
      'Hide a reply to one of your posts, or unhide it. Requires user auth with tweet.moderate.write. Hiding is preferable to deleting because the author keeps their post visible in their own timeline.',
    toolset: 'posts',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      tweet_id: tweetId.describe('The reply to hide/unhide. You must have authored the parent post.'),
      hidden: z.boolean().default(true),
    },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<{ hidden?: boolean }>({
        method: 'PUT',
        path: `/2/tweets/${args.tweet_id}/hidden`,
        auth: 'user',
        body: { hidden: args.hidden },
        signal: extra.signal,
      });
      return { id: args.tweet_id, hidden: res.data.hidden === true };
    },
  },
];

