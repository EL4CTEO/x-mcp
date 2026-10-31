import { z } from 'zod';
import type { ActionTool } from './define.ts';
import { normalizeTrend } from '../x/normalize.ts';
import { TREND_FIELDS } from '../x/fields.ts';
import { maxResults } from './schemas.ts';

type Json = Record<string, unknown>;

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export const trendTools: ActionTool[] = [
  {
    action: 'by_location',
    name: 'x_get_trends',
    title: 'Trends by location',
    description:
      'Trending topics for a location identified by WOEID. Common WOEIDs: 1 = worldwide, 23424977 = United States, 23424975 = United Kingdom, 23424853 = Italy, 23424950 = Spain, 23424848 = India, 23424856 = Japan, 23424969 = Turkey, 23424775 = Canada, 23424900 = Mexico, 23424768 = Brazil. Returns trend names, post volumes and search URLs.',
    toolset: 'trends',
    annotations: readAnnotations,
    inputSchema: {
      woeid: z.number().int().min(1).default(1).describe('Where On Earth ID of the location. 1 = worldwide.'),
      max_trends: maxResults(1, 50, 20),
    },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/trends/by/woeid/${args.woeid}`,
        auth: 'auto',
        query: { max_trends: args.max_trends, 'trend.fields': TREND_FIELDS },
        cache: { ttlMs: 60_000 },
        signal: extra.signal,
      });
      return { woeid: args.woeid, data: (res.data ?? []).map(normalizeTrend) };
    },
  },
  {
    action: 'personalized',
    name: 'x_get_personalized_trends',
    title: 'Personalized trends',
    description:
      'Trending topics personalised for the authenticated account (based on follows, location and activity). Requires user auth. Complements x_get_trends, which is location-based. Returns trend names, post counts, categories and how long each trend has been trending when X provides them.',
    toolset: 'trends',
    annotations: readAnnotations,
    inputSchema: {},
    async handler(_args, ctx, extra) {
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: '/2/users/personalized_trends',
        auth: 'user',
        query: { 'personalized_trend.fields': 'trend_name,post_count,category,trending_since' },
        cache: { ttlMs: 60_000 },
        signal: extra.signal,
      });
      return { data: (res.data ?? []).map(normalizeTrend) };
    },
  },
];
