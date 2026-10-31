import { z } from 'zod';
import type { ActionTool } from './define.ts';
import type { XResult } from '../x/client.ts';
import { normalizeUser, normalizeUserList, normalizeUserSingle } from '../x/normalize.ts';
import { maxResults, paginationToken, userRef, userId, username } from './schemas.ts';
import { resolveTargetUserId, resolveUserId } from './resolve.ts';
import { userQuery } from './query.ts';

type Json = Record<string, unknown>;

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function userList(res: XResult<Json[]>) {
  return normalizeUserList({ data: res.data, includes: res.includes, meta: res.meta, errors: res.errors });
}

function relationship(action: string) {
  return { action, at: new Date().toISOString() };
}

async function targetUserId(ctx: Parameters<typeof resolveUserId>[0], args: { target_user_id?: string; target_username?: string }, extra: Parameters<typeof resolveUserId>[2]): Promise<string> {
  return resolveTargetUserId(ctx, { user_id: args.target_user_id, username: args.target_username }, extra);
}

const targetRef = {
  target_user_id: userId.optional().describe('Numeric id of the target account.'),
  target_username: username.optional().describe('Handle of the target account (without @).'),
};

export const userTools: ActionTool[] = [
  {
    action: 'me',
    name: 'x_get_me',
    title: 'Authenticated account',
    description: 'Profile of the authenticated account: id, handle, bio, follower counts and pinned post. Requires user auth.',
    toolset: 'users',
    annotations: readAnnotations,
    inputSchema: {},
    async handler(_args, ctx, extra) {
      const res = await ctx.x.request<Json>({ method: 'GET', path: '/2/users/me', auth: 'user', query: userQuery(), cache: { ttlMs: 60_000 }, signal: extra.signal });
      const user = normalizeUserSingle({ data: res.data });
      if (!user) throw new Error('X did not return the authenticated account.');
      return user;
    },
  },
  {
    action: 'get',
    name: 'x_get_user',
    title: 'Get a user profile',
    description: 'Look up one account by handle or numeric id. Returns bio, location, verification, follower/following/post counts and pinned post id.',
    toolset: 'users',
    annotations: readAnnotations,
    inputSchema: { ...userRef },
    async handler(args, ctx, extra) {
      if (args.user_id) {
        const res = await ctx.x.request<Json>({ method: 'GET', path: `/2/users/${args.user_id}`, auth: 'auto', query: userQuery(), signal: extra.signal });
        const user = normalizeUserSingle({ data: res.data });
        if (!user) throw new Error(`User ${args.user_id} was not found.`);
        return user;
      }
      if (!args.username) throw new Error('Provide either user_id or username.');
      const res = await ctx.x.request<Json>({
        method: 'GET',
        path: `/2/users/by/username/${encodeURIComponent(args.username)}`,
        auth: 'auto',
        query: userQuery(),
        cache: { ttlMs: 300_000 },
        signal: extra.signal,
      });
      const user = normalizeUserSingle({ data: res.data });
      if (!user) throw new Error(`@${args.username} was not found.`);
      return user;
    },
  },
  {
    action: 'get_many',
    name: 'x_get_users',
    title: 'Get multiple user profiles',
    description: 'Batch lookup of up to 100 accounts by handle or id in a single request. Cheaper and faster than repeated x_get_user calls.',
    toolset: 'users',
    annotations: readAnnotations,
    inputSchema: {
      usernames: z.array(username).min(1).max(100).optional().describe('Handles to look up (no @).'),
      user_ids: z.array(userId).min(1).max(100).optional().describe('Numeric ids to look up.'),
    },
    async handler(args, ctx, extra) {
      if (!args.usernames && !args.user_ids) throw new Error('Provide usernames or user_ids.');
      if (args.usernames && args.user_ids) throw new Error('Provide either usernames or user_ids, not both.');
      if (args.usernames && args.usernames.length > 0) {
        const res = await ctx.x.request<Json[]>({
          method: 'GET',
          path: '/2/users/by',
          auth: 'auto',
          query: { usernames: args.usernames.join(','), ...userQuery() },
          cache: { ttlMs: 300_000 },
          signal: extra.signal,
        });
        return userList(res);
      }
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: '/2/users',
        auth: 'auto',
        query: { ids: (args.user_ids ?? []).join(','), ...userQuery() },
        cache: { ttlMs: 300_000 },
        signal: extra.signal,
      });
      return userList(res);
    },
  },
  {
    action: 'search',
    name: 'x_search_users',
    title: 'Search users',
    description: 'Search accounts by keyword (name, handle, bio) with 1-100 results per page. Useful for discovering accounts in a niche before fetching their timelines.',
    toolset: 'users',
    annotations: readAnnotations,
    inputSchema: {
      query: z.string().min(1).max(512).describe('Keyword or phrase, e.g. "rust developer" or "climate tech".'),
      max_results: maxResults(1, 100, 20),
      next_token: paginationToken,
    },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: '/2/users/search',
        auth: 'auto',
        query: { query: args.query, max_results: args.max_results, next_token: args.next_token, ...userQuery() },
        cache: { ttlMs: 60_000 },
        signal: extra.signal,
      });
      return { query: args.query, ...userList(res) };
    },
  },
  {
    action: 'followers',
    name: 'x_get_followers',
    title: 'List followers',
    description: 'Accounts following a user, 1-1000 per page (X caps at 1000). Requires user auth for protected accounts; public lists work with app-only auth.',
    toolset: 'users',
    annotations: readAnnotations,
    inputSchema: { ...userRef, max_results: maxResults(1, 1_000, 100), next_token: paginationToken },
    async handler(args, ctx, extra) {
      const id = await resolveUserId(ctx, args, extra);
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/users/${id}/followers`,
        auth: 'auto',
        query: { max_results: args.max_results, pagination_token: args.next_token, ...userQuery() },
        cache: { ttlMs: 120_000 },
        signal: extra.signal,
      });
      return { user_id: id, ...userList(res) };
    },
  },
  {
    action: 'following',
    name: 'x_get_following',
    title: 'List following',
    description: 'Accounts a user follows, 1-1000 per page. Requires user auth for protected accounts.',
    toolset: 'users',
    annotations: readAnnotations,
    inputSchema: { ...userRef, max_results: maxResults(1, 1_000, 100), next_token: paginationToken },
    async handler(args, ctx, extra) {
      const id = await resolveUserId(ctx, args, extra);
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/users/${id}/following`,
        auth: 'auto',
        query: { max_results: args.max_results, pagination_token: args.next_token, ...userQuery() },
        cache: { ttlMs: 120_000 },
        signal: extra.signal,
      });
      return { user_id: id, ...userList(res) };
    },
  },
  {
    action: 'follow',
    name: 'x_follow_user',
    title: 'Follow a user',
    description: 'Follow an account as the authenticated user. Requires user auth with follows.write. Idempotent: following an already-followed account succeeds.',
    toolset: 'users',
    annotations: writeAnnotations,
    inputSchema: { ...targetRef },
    async handler(args, ctx, extra) {
      const me = await resolveUserId(ctx, {}, extra);
      const target = await targetUserId(ctx, args, extra);
      const res = await ctx.x.request<{ following?: boolean; pending_follow?: boolean }>({
        method: 'POST',
        path: `/2/users/${me}/following`,
        auth: 'user',
        body: { target_user_id: target },
        signal: extra.signal,
      });
      return { ...relationship('follow'), user_id: me, target_user_id: target, following: res.data.following === true, pending_follow: res.data.pending_follow === true };
    },
  },
  {
    action: 'unfollow',
    name: 'x_unfollow_user',
    title: 'Unfollow a user',
    description: 'Unfollow an account as the authenticated user. Requires user auth with follows.write.',
    toolset: 'users',
    annotations: { ...writeAnnotations, destructiveHint: true },
    inputSchema: { ...targetRef },
    async handler(args, ctx, extra) {
      const me = await resolveUserId(ctx, {}, extra);
      const target = await targetUserId(ctx, args, extra);
      const res = await ctx.x.request<{ following?: boolean }>({
        method: 'DELETE',
        path: `/2/users/${me}/following/${target}`,
        auth: 'user',
        signal: extra.signal,
      });
      return { ...relationship('unfollow'), user_id: me, target_user_id: target, following: res.data.following === true };
    },
  },
  {
    action: 'mute',
    name: 'x_mute_user',
    title: 'Mute a user',
    description: 'Mute an account for the authenticated user. Requires user auth with mute.write.',
    toolset: 'users',
    annotations: writeAnnotations,
    inputSchema: { ...targetRef },
    async handler(args, ctx, extra) {
      const me = await resolveUserId(ctx, {}, extra);
      const target = await targetUserId(ctx, args, extra);
      const res = await ctx.x.request<{ muting?: boolean }>({
        method: 'POST',
        path: `/2/users/${me}/muting`,
        auth: 'user',
        body: { target_user_id: target },
        signal: extra.signal,
      });
      return { ...relationship('mute'), user_id: me, target_user_id: target, muting: res.data.muting === true };
    },
  },
  {
    action: 'unmute',
    name: 'x_unmute_user',
    title: 'Unmute a user',
    description: 'Unmute an account for the authenticated user. Requires user auth with mute.write.',
    toolset: 'users',
    annotations: writeAnnotations,
    inputSchema: { ...targetRef },
    async handler(args, ctx, extra) {
      const me = await resolveUserId(ctx, {}, extra);
      const target = await targetUserId(ctx, args, extra);
      const res = await ctx.x.request<{ muting?: boolean }>({
        method: 'DELETE',
        path: `/2/users/${me}/muting/${target}`,
        auth: 'user',
        signal: extra.signal,
      });
      return { ...relationship('unmute'), user_id: me, target_user_id: target, muting: res.data.muting === true };
    },
  },
  {
    action: 'block',
    name: 'x_block_user',
    title: 'Block a user',
    description:
      'Block an account on behalf of the authenticated user. X documents this endpoint as Enterprise-plan only; self-serve apps may receive 403. Requires user auth with block.write.',
    toolset: 'users',
    annotations: { ...writeAnnotations, destructiveHint: true },
    inputSchema: { ...targetRef },
    async handler(args, ctx, extra) {
      const me = await resolveUserId(ctx, {}, extra);
      const target = await targetUserId(ctx, args, extra);
      const res = await ctx.x.request<{ blocking?: boolean }>({
        method: 'POST',
        path: `/2/users/${me}/blocking`,
        auth: 'user',
        body: { target_user_id: target },
        signal: extra.signal,
      });
      return { ...relationship('block'), user_id: me, target_user_id: target, blocking: res.data.blocking === true };
    },
  },
  {
    action: 'unblock',
    name: 'x_unblock_user',
    title: 'Unblock a user',
    description: 'Unblock an account. X documents this endpoint as Enterprise-plan only. Requires user auth with block.write.',
    toolset: 'users',
    annotations: writeAnnotations,
    inputSchema: { ...targetRef },
    async handler(args, ctx, extra) {
      const me = await resolveUserId(ctx, {}, extra);
      const target = await targetUserId(ctx, args, extra);
      const res = await ctx.x.request<{ blocking?: boolean }>({
        method: 'DELETE',
        path: `/2/users/${me}/blocking/${target}`,
        auth: 'user',
        signal: extra.signal,
      });
      return { ...relationship('unblock'), user_id: me, target_user_id: target, blocking: res.data.blocking === true };
    },
  },
  {
    action: 'muted',
    name: 'x_get_muted_users',
    title: 'List muted users',
    description: 'Accounts muted by the authenticated user (1-100 per page). Requires user auth.',
    toolset: 'users',
    annotations: readAnnotations,
    inputSchema: { max_results: maxResults(1, 100, 50), next_token: paginationToken },
    async handler(args, ctx, extra) {
      const me = await resolveUserId(ctx, {}, extra);
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/users/${me}/muting`,
        auth: 'user',
        query: { max_results: args.max_results, pagination_token: args.next_token, ...userQuery() },
        signal: extra.signal,
      });
      return { user_id: me, ...userList(res) };
    },
  },
  {
    action: 'blocked',
    name: 'x_get_blocked_users',
    title: 'List blocked users',
    description:
      'Accounts blocked by the authenticated user (1-1000 per page). Requires user auth with block.read. Pair with x_unblock_user to audit and clean up a block list.',
    toolset: 'users',
    annotations: readAnnotations,
    inputSchema: { max_results: maxResults(1, 1_000, 100), next_token: paginationToken },
    async handler(args, ctx, extra) {
      const me = await resolveUserId(ctx, {}, extra);
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/users/${me}/blocking`,
        auth: 'user',
        query: { max_results: args.max_results, pagination_token: args.next_token, ...userQuery() },
        signal: extra.signal,
      });
      return { user_id: me, ...userList(res) };
    },
  },
];
