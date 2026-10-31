import type { ActionTool } from './define.ts';

type Json = Record<string, unknown>;

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export const metaTools: ActionTool[] = [
  {
    action: 'auth_status',
    name: 'x_auth_status',
    title: 'Authentication status',
    description:
      'Diagnose credentials: which auth modes are configured, whether a user session can post/DM, token expiry and scopes, plus the effective server flags (read-only, dry-run, cache, API base). Never returns secrets. Call this first when a tool fails with 401/403.',
    toolset: 'meta',
    annotations: readAnnotations,
    inputSchema: {},
    async handler(_args, ctx) {
      const status = ctx.x.auth.status();
      const userAuth = ctx.x.auth.hasOAuth2 || ctx.x.auth.hasOAuth1;
      return {
        credentials: {
          appOnlyBearer: status.bearer,
          oauth2: status.oauth2,
          oauth1: status.oauth1,
          oauth2Source: status.oauth2Source,
          oauth2ExpiresAt: status.oauth2ExpiresAt ? new Date(status.oauth2ExpiresAt).toISOString() : undefined,
          oauth2Scopes: status.oauth2Scopes,
          modes: [
            status.bearer ? 'app-only bearer' : undefined,
            status.oauth2 ? 'OAuth 2.0 user' : undefined,
            status.oauth1 ? 'OAuth 1.0a user' : undefined,
          ].filter((mode): mode is string => Boolean(mode)),
        },
        capabilities: {
          publicReads: status.bearer || userAuth,
          userReads: userAuth,
          writes: userAuth,
          mediaUpload: userAuth,
          directMessages: userAuth,
        },
        config: {
          apiBase: ctx.config.apiBase,
          readOnly: ctx.config.readOnly,
          dryRun: ctx.config.dryRun,
          cache: ctx.config.cache.enabled ? { ttlMs: ctx.config.cache.ttlMs, maxEntries: ctx.config.cache.maxEntries } : 'disabled',
          rateLimitMode: ctx.config.rateLimit.mode,
          credentialFile: ctx.config.credentialFile,
          toolsets: { include: ctx.config.toolsets.include, exclude: ctx.config.toolsets.exclude },
        },
        missing: status.missing,
        hint: status.missing.length > 0 ? 'Some tools will fail until these credentials are configured.' : undefined,
      };
    },
  },
  {
    action: 'rate_limits',
    name: 'x_rate_limits',
    title: 'Observed rate limits and cache stats',
    description:
      'Shows the last rate-limit window X reported for each endpoint (remaining requests and reset time), the in-memory cache hit/miss counters, and whether the server waits or fails when a bucket is exhausted. Use this before planning a large batch of calls.',
    toolset: 'meta',
    annotations: readAnnotations,
    inputSchema: {},
    async handler(_args, ctx) {
      return {
        mode: ctx.config.rateLimit.mode,
        maxWaitMs: ctx.config.rateLimit.maxWaitMs,
        buckets: ctx.x.rateLimitSnapshot(),
        cache: ctx.config.cache.enabled
          ? { ...ctx.x.cacheStats(), ttlMs: ctx.config.cache.ttlMs, maxEntries: ctx.config.cache.maxEntries }
          : { enabled: false },
      };
    },
  },
  {
    action: 'usage',
    name: 'x_usage',
    title: 'API usage and post cap',
    description:
      'Current billing-period post consumption for the X project: the cap, how many posts have been consumed, and daily usage. Requires an app-only bearer token. Check this before large read/search jobs, since X bills per returned post.',
    toolset: 'meta',
    annotations: readAnnotations,
    inputSchema: {},
    async handler(_args, ctx, extra) {
      const res = await ctx.x.request<Json>({
        method: 'GET',
        path: '/2/usage/tweets',
        auth: 'app',
        cache: { ttlMs: 60_000 },
        signal: extra.signal,
      });
      return res.data;
    },
  },
];
