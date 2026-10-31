import { z } from 'zod';
import type { ActionTool } from './define.ts';
import type { XResult } from '../x/client.ts';
import { normalizeSpace, normalizeTweetList } from '../x/normalize.ts';
import { maxResults, paginationToken, spaceId } from './schemas.ts';
import { postQuery, spaceQuery } from './query.ts';

type Json = Record<string, unknown>;

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export const spaceTools: ActionTool[] = [
  {
    action: 'search',
    name: 'x_search_spaces',
    title: 'Search Spaces',
    description:
      'Find live or scheduled audio Spaces by keyword (up to 100 results). X does not paginate this endpoint. Useful for discovering conversations an agent can summarize or join.',
    toolset: 'spaces',
    annotations: readAnnotations,
    inputSchema: {
      query: z.string().min(1).max(512),
      state: z.enum(['live', 'scheduled', 'all']).default('all').describe('Filter by Space state.'),
      max_results: maxResults(1, 100, 20),
    },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: '/2/spaces/search',
        auth: 'auto',
        query: {
          query: args.query,
          state: args.state === 'all' ? undefined : args.state,
          max_results: args.max_results,
          ...spaceQuery(),
        },
        cache: { ttlMs: 30_000 },
        signal: extra.signal,
      });
      const spaces = (res.data ?? []).map(normalizeSpace);
      return {
        query: args.query,
        state: args.state,
        data: spaces,
        result_count: (res.meta as Json | undefined)?.result_count ?? spaces.length,
      };
    },
  },
  {
    action: 'get',
    name: 'x_get_space',
    title: 'Get a Space',
    description: 'Fetch one Space by id: title, state, hosts, participant count and schedule.',
    toolset: 'spaces',
    annotations: readAnnotations,
    inputSchema: { space_id: spaceId },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json>({
        method: 'GET',
        path: `/2/spaces/${args.space_id}`,
        auth: 'auto',
        query: spaceQuery(),
        cache: { ttlMs: 30_000 },
        signal: extra.signal,
      });
      return normalizeSpace(res.data);
    },
  },
  {
    action: 'get_many',
    name: 'x_get_spaces',
    title: 'Get multiple Spaces',
    description: 'Batch lookup of up to 100 Spaces by id.',
    toolset: 'spaces',
    annotations: readAnnotations,
    inputSchema: { space_ids: z.array(spaceId).min(1).max(100) },
    async handler(args, ctx, extra) {
      const res: XResult<Json[]> = await ctx.x.request<Json[]>({
        method: 'GET',
        path: '/2/spaces',
        auth: 'auto',
        query: { ids: args.space_ids.join(','), ...spaceQuery() },
        cache: { ttlMs: 30_000 },
        signal: extra.signal,
      });
      return { data: (res.data ?? []).map(normalizeSpace) };
    },
  },
  {
    action: 'posts',
    name: 'x_get_space_posts',
    title: 'Posts shared in a Space',
    description: 'Posts attached to a Space, 1-100 per page.',
    toolset: 'spaces',
    annotations: readAnnotations,
    inputSchema: { space_id: spaceId, max_results: maxResults(1, 100, 20), next_token: paginationToken },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/spaces/${args.space_id}/tweets`,
        auth: 'auto',
        query: { max_results: args.max_results, pagination_token: args.next_token, ...postQuery() },
        cache: { ttlMs: 30_000 },
        signal: extra.signal,
      });
      return { space_id: args.space_id, ...normalizeTweetList({ data: res.data, includes: res.includes, meta: res.meta }) };
    },
  },
];
