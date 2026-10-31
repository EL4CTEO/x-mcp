import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './tools/define.ts';
import { normalizeTweetSingle, normalizeUserSingle } from './x/normalize.ts';
import { userQuery } from './tools/query.ts';
import { postQuery } from './tools/query.ts';

type Json = Record<string, unknown>;

function json(uri: URL, value: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

/**
 * MCP resources give clients cheap, addressable access to common X objects
 * without spending a tool call. Resource reads use the same cached client, so
 * reading x://users/me twice within the TTL costs one request.
 */
export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    'me',
    'x://me',
    {
      title: 'Authenticated X account',
      description: 'Profile of the account the server is authenticated as.',
      mimeType: 'application/json',
    },
    async (uri, extra) => {
      const res = await ctx.x.request<Json>({ method: 'GET', path: '/2/users/me', auth: 'user', query: userQuery(), signal: extra.signal });
      return json(uri, normalizeUserSingle({ data: res.data }) ?? res.data);
    },
  );

  server.registerResource(
    'rate-limits',
    'x://rate-limits',
    {
      title: 'Observed rate limits',
      description: 'Per-endpoint rate-limit windows observed during this session, plus cache statistics.',
      mimeType: 'application/json',
    },
    async (uri) => json(uri, { buckets: ctx.x.rateLimitSnapshot(), cache: ctx.x.cacheStats() }),
  );

  server.registerResource(
    'usage',
    'x://usage',
    {
      title: 'X API usage',
      description: 'Post consumption for the current billing period (requires an app-only bearer token).',
      mimeType: 'application/json',
    },
    async (uri, extra) => {
      const res = await ctx.x.request<Json>({ method: 'GET', path: '/2/usage/tweets', auth: 'app', signal: extra.signal });
      return json(uri, res.data);
    },
  );

  server.registerResource(
    'user',
    new ResourceTemplate('x://users/{username}', { list: undefined }),
    {
      title: 'X user profile',
      description: 'Fetch a public profile by handle, e.g. x://users/jack.',
      mimeType: 'application/json',
    },
    async (uri, variables, extra) => {
      const username = String(variables.username ?? '');
      const res = await ctx.x.request<Json>({
        method: 'GET',
        path: `/2/users/by/username/${encodeURIComponent(username)}`,
        auth: 'auto',
        query: userQuery(),
        signal: extra.signal,
      });
      return json(uri, normalizeUserSingle({ data: res.data }) ?? res.data);
    },
  );

  server.registerResource(
    'post',
    new ResourceTemplate('x://posts/{id}', { list: undefined }),
    {
      title: 'X post',
      description: 'Fetch a post by id, e.g. x://posts/20.',
      mimeType: 'application/json',
    },
    async (uri, variables, extra) => {
      const id = String(variables.id ?? '');
      const res = await ctx.x.request<Json>({
        method: 'GET',
        path: `/2/tweets/${encodeURIComponent(id)}`,
        auth: 'auto',
        query: postQuery(),
        signal: extra.signal,
      });
      return json(uri, normalizeTweetSingle({ data: res.data, includes: res.includes }) ?? res.data);
    },
  );

  server.registerResource(
    'list',
    new ResourceTemplate('x://lists/{id}', { list: undefined }),
    {
      title: 'X List',
      description: 'Fetch a List by id, e.g. x://lists/1234.',
      mimeType: 'application/json',
    },
    async (uri, variables, extra) => {
      const id = String(variables.id ?? '');
      const res = await ctx.x.request<Json>({
        method: 'GET',
        path: `/2/lists/${encodeURIComponent(id)}`,
        auth: 'auto',
        query: { 'list.fields': 'created_at,description,follower_count,id,member_count,name,owner_id,private' },
        signal: extra.signal,
      });
      return json(uri, res.data);
    },
  );
}
