import { z } from 'zod';
import type { ActionTool } from './define.ts';
import type { XResult } from '../x/client.ts';
import { normalizeTweetList } from '../x/normalize.ts';
import { maxResults, paginationToken, timeRange, userRef } from './schemas.ts';
import { resolveUserId } from './resolve.ts';
import { postQuery } from './query.ts';

type Json = Record<string, unknown>;

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function lists(res: XResult<Json[]>) {
  return normalizeTweetList({ data: res.data, includes: res.includes, meta: res.meta });
}

const excludeParam = z
  .array(z.enum(['retweets', 'replies']))
  .optional()
  .describe('Drop retweets and/or replies from the timeline.');

export const timelineTools: ActionTool[] = [
  {
    action: 'home',
    name: 'x_home_timeline',
    title: 'Home timeline',
    description:
      'Reverse-chronological home timeline for the authenticated account. Requires user auth. Paginate with next_token; 1-100 posts per page. This is the best starting point for "what is happening in my feed".',
    toolset: 'timelines',
    annotations: readAnnotations,
    inputSchema: {
      max_results: maxResults(1, 100, 20),
      next_token: paginationToken,
      exclude: excludeParam,
      ...timeRange,
    },
    async handler(args, ctx, extra) {
      const userId = await resolveUserId(ctx, {}, extra);
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/users/${userId}/timelines/reverse_chronological`,
        auth: 'user',
        query: {
          max_results: args.max_results,
          pagination_token: args.next_token,
          exclude: args.exclude?.join(','),
          start_time: args.start_time,
          end_time: args.end_time,
          ...postQuery(),
        },
        cache: { ttlMs: 15_000 },
        signal: extra.signal,
      });
      return { user_id: userId, ...lists(res) };
    },
  },
  {
    action: 'user',
    name: 'x_user_posts',
    title: 'Posts by a user',
    description:
      'Timeline of posts authored by a user (1-100 per page). Works with public app-only auth for public accounts; user auth needed for protected accounts. Use exclude to filter retweets/replies.',
    toolset: 'timelines',
    annotations: readAnnotations,
    inputSchema: {
      ...userRef,
      max_results: maxResults(1, 100, 20),
      next_token: paginationToken,
      exclude: excludeParam,
      ...timeRange,
    },
    async handler(args, ctx, extra) {
      const userId = await resolveUserId(ctx, args, extra);
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/users/${userId}/tweets`,
        auth: 'auto',
        query: {
          max_results: args.max_results,
          pagination_token: args.next_token,
          exclude: args.exclude?.join(','),
          start_time: args.start_time,
          end_time: args.end_time,
          ...postQuery(),
        },
        cache: { ttlMs: 30_000 },
        signal: extra.signal,
      });
      return { user_id: userId, ...lists(res) };
    },
  },
  {
    action: 'mentions',
    name: 'x_user_mentions',
    title: 'Mentions of a user',
    description:
      'Posts that mention a user (1-100 per page). Ideal for reply triage and reputation monitoring. Requires user auth for private accounts; public mentions work with app-only auth.',
    toolset: 'timelines',
    annotations: readAnnotations,
    inputSchema: {
      ...userRef,
      max_results: maxResults(1, 100, 20),
      next_token: paginationToken,
      ...timeRange,
    },
    async handler(args, ctx, extra) {
      const userId = await resolveUserId(ctx, args, extra);
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/users/${userId}/mentions`,
        auth: 'auto',
        query: {
          max_results: args.max_results,
          pagination_token: args.next_token,
          start_time: args.start_time,
          end_time: args.end_time,
          ...postQuery(),
        },
        cache: { ttlMs: 15_000 },
        signal: extra.signal,
      });
      return { user_id: userId, ...lists(res) };
    },
  },
  {
    action: 'liked',
    name: 'x_user_liked_posts',
    title: 'Posts liked by a user',
    description: 'Posts liked by a user, newest first (1-100 per page). Requires user auth.',
    toolset: 'timelines',
    annotations: readAnnotations,
    inputSchema: {
      ...userRef,
      max_results: maxResults(1, 100, 20),
      next_token: paginationToken,
    },
    async handler(args, ctx, extra) {
      const userId = await resolveUserId(ctx, args, extra);
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/users/${userId}/liked_tweets`,
        auth: 'user',
        query: { max_results: args.max_results, pagination_token: args.next_token, ...postQuery() },
        cache: { ttlMs: 30_000 },
        signal: extra.signal,
      });
      return { user_id: userId, ...lists(res) };
    },
  },
  {
    action: 'bookmarks',
    name: 'x_bookmarks',
    title: 'Bookmarked posts',
    description:
      'The authenticated account\'s bookmarks (1-100 per page). Requires user auth with bookmark.read. Bookmark folders are not included; use only the default bookmark timeline.',
    toolset: 'timelines',
    annotations: readAnnotations,
    inputSchema: {
      max_results: maxResults(1, 100, 20),
      next_token: paginationToken,
    },
    async handler(args, ctx, extra) {
      const userId = await resolveUserId(ctx, {}, extra);
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/users/${userId}/bookmarks`,
        auth: 'user',
        query: { max_results: args.max_results, pagination_token: args.next_token, ...postQuery() },
        cache: { ttlMs: 15_000 },
        signal: extra.signal,
      });
      return { user_id: userId, ...lists(res) };
    },
  },
];
