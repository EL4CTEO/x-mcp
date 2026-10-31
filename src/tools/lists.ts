import { z } from 'zod';
import type { ActionTool } from './define.ts';
import type { XResult } from '../x/client.ts';
import { normalizeList, normalizeTweetList, normalizeUserList } from '../x/normalize.ts';
import { listId, maxResults, paginationToken, userRef, userId } from './schemas.ts';
import { resolveUserId } from './resolve.ts';
import { listQuery, postQuery, userQuery } from './query.ts';

type Json = Record<string, unknown>;

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function listsOf(res: XResult<Json[]>) {
  return {
    data: (res.data ?? []).map(normalizeList),
    next_token: (res.meta as Json | undefined)?.next_token,
    result_count: (res.meta as Json | undefined)?.result_count,
  };
}

export const listTools: ActionTool[] = [
  {
    action: 'create',
    name: 'x_create_list',
    title: 'Create a List',
    description: 'Create a curated List. Requires user auth with list.write. Lists are the cheapest way to build a topic feed: one List timeline call replaces dozens of per-account calls.',
    toolset: 'lists',
    annotations: writeAnnotations,
    inputSchema: {
      name: z.string().min(1).max(25).describe('List name (max 25 chars).'),
      description: z.string().max(100).optional(),
      private: z.boolean().default(false).describe('Private Lists are visible only to you.'),
    },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<{ id?: string; name?: string }>({
        method: 'POST',
        path: '/2/lists',
        auth: 'user',
        body: { name: args.name, ...(args.description ? { description: args.description } : {}), private: args.private },
        signal: extra.signal,
      });
      if (!res.data.id) throw new Error('X did not return the new List id.');
      return { id: res.data.id, name: res.data.name ?? args.name, private: args.private, url: `https://x.com/i/lists/${res.data.id}` };
    },
  },
  {
    action: 'update',
    name: 'x_update_list',
    title: 'Update a List',
    description: 'Rename, re-describe or change the visibility of a List you own. Requires user auth with list.write.',
    toolset: 'lists',
    annotations: writeAnnotations,
    inputSchema: {
      list_id: listId,
      name: z.string().min(1).max(25).optional(),
      description: z.string().max(100).optional(),
      private: z.boolean().optional(),
    },
    async handler(args, ctx, extra) {
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.description !== undefined) body.description = args.description;
      if (args.private !== undefined) body.private = args.private;
      if (Object.keys(body).length === 0) throw new Error('Provide at least one field to update.');
      const res = await ctx.x.request<{ updated?: boolean }>({
        method: 'PUT',
        path: `/2/lists/${args.list_id}`,
        auth: 'user',
        body,
        signal: extra.signal,
      });
      return { list_id: args.list_id, updated: res.data.updated === true, ...body };
    },
  },
  {
    action: 'delete',
    name: 'x_delete_list',
    title: 'Delete a List',
    description: 'Delete a List you own. Requires user auth with list.write. This cannot be undone.',
    toolset: 'lists',
    annotations: { ...writeAnnotations, destructiveHint: true, idempotentHint: true },
    inputSchema: { list_id: listId },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<{ deleted?: boolean }>({
        method: 'DELETE',
        path: `/2/lists/${args.list_id}`,
        auth: 'user',
        signal: extra.signal,
      });
      return { list_id: args.list_id, deleted: res.data.deleted === true };
    },
  },
  {
    action: 'get',
    name: 'x_get_list',
    title: 'Get a List',
    description: 'Fetch a List by id: name, description, owner, member/follower counts and visibility.',
    toolset: 'lists',
    annotations: readAnnotations,
    inputSchema: { list_id: listId },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json>({
        method: 'GET',
        path: `/2/lists/${args.list_id}`,
        auth: 'auto',
        query: listQuery({ expansions: 'owner_id' }),
        cache: { ttlMs: 60_000 },
        signal: extra.signal,
      });
      return normalizeList(res.data);
    },
  },
  {
    action: 'owned',
    name: 'x_get_owned_lists',
    title: 'Lists owned by a user',
    description: 'Lists created by a user (defaults to the authenticated account), 1-100 per page.',
    toolset: 'lists',
    annotations: readAnnotations,
    inputSchema: { ...userRef, max_results: maxResults(1, 100, 100), next_token: paginationToken },
    async handler(args, ctx, extra) {
      const id = await resolveUserId(ctx, args, extra);
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/users/${id}/owned_lists`,
        auth: 'auto',
        query: { max_results: args.max_results, pagination_token: args.next_token, ...listQuery() },
        signal: extra.signal,
      });
      return { user_id: id, ...listsOf(res) };
    },
  },
  {
    action: 'memberships',
    name: 'x_get_list_memberships',
    title: 'Lists a user belongs to',
    description: 'Lists a user is a member of (defaults to the authenticated account), 1-100 per page.',
    toolset: 'lists',
    annotations: readAnnotations,
    inputSchema: { ...userRef, max_results: maxResults(1, 100, 100), next_token: paginationToken },
    async handler(args, ctx, extra) {
      const id = await resolveUserId(ctx, args, extra);
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/users/${id}/list_memberships`,
        auth: 'auto',
        query: { max_results: args.max_results, pagination_token: args.next_token, ...listQuery() },
        signal: extra.signal,
      });
      return { user_id: id, ...listsOf(res) };
    },
  },
  {
    action: 'pinned',
    name: 'x_get_pinned_lists',
    title: 'Pinned Lists of a user',
    description: 'Lists pinned to a user profile (defaults to the authenticated account).',
    toolset: 'lists',
    annotations: readAnnotations,
    inputSchema: { ...userRef },
    async handler(args, ctx, extra) {
      const id = await resolveUserId(ctx, args, extra);
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/users/${id}/pinned_lists`,
        auth: 'auto',
        query: listQuery(),
        signal: extra.signal,
      });
      return { user_id: id, data: (res.data ?? []).map(normalizeList) };
    },
  },
  {
    action: 'add_member',
    name: 'x_add_list_member',
    title: 'Add a member to a List',
    description: 'Add a user to a List you manage. Requires user auth with list.write.',
    toolset: 'lists',
    annotations: writeAnnotations,
    inputSchema: { list_id: listId, user_id: userId },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<{ is_member?: boolean }>({
        method: 'POST',
        path: `/2/lists/${args.list_id}/members`,
        auth: 'user',
        body: { user_id: args.user_id },
        signal: extra.signal,
      });
      return { list_id: args.list_id, user_id: args.user_id, is_member: res.data.is_member === true };
    },
  },
  {
    action: 'remove_member',
    name: 'x_remove_list_member',
    title: 'Remove a member from a List',
    description: 'Remove a user from a List you manage. Requires user auth with list.write.',
    toolset: 'lists',
    annotations: { ...writeAnnotations, destructiveHint: true },
    inputSchema: { list_id: listId, user_id: userId },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<{ is_member?: boolean }>({
        method: 'DELETE',
        path: `/2/lists/${args.list_id}/members/${args.user_id}`,
        auth: 'user',
        signal: extra.signal,
      });
      return { list_id: args.list_id, user_id: args.user_id, is_member: res.data.is_member === true };
    },
  },
  {
    action: 'posts',
    name: 'x_get_list_posts',
    title: 'Posts in a List timeline',
    description:
      'The timeline of a List, newest first (1-100 per page). Efficient for monitoring a topic: one call covers every account in the List.',
    toolset: 'lists',
    annotations: readAnnotations,
    inputSchema: { list_id: listId, max_results: maxResults(1, 100, 20), next_token: paginationToken },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/lists/${args.list_id}/tweets`,
        auth: 'auto',
        query: { max_results: args.max_results, pagination_token: args.next_token, ...postQuery() },
        cache: { ttlMs: 15_000 },
        signal: extra.signal,
      });
      return { list_id: args.list_id, ...normalizeTweetList({ data: res.data, includes: res.includes, meta: res.meta }) };
    },
  },
  {
    action: 'members',
    name: 'x_get_list_members',
    title: 'Members of a List',
    description: 'Users who belong to a List, 1-100 per page.',
    toolset: 'lists',
    annotations: readAnnotations,
    inputSchema: { list_id: listId, max_results: maxResults(1, 100, 100), next_token: paginationToken },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/lists/${args.list_id}/members`,
        auth: 'auto',
        query: { max_results: args.max_results, pagination_token: args.next_token, ...userQuery() },
        signal: extra.signal,
      });
      return { list_id: args.list_id, ...normalizeUserList({ data: res.data, includes: res.includes, meta: res.meta }) };
    },
  },
  {
    action: 'followers',
    name: 'x_get_list_followers',
    title: 'Followers of a List',
    description: 'Users who follow a List, 1-100 per page.',
    toolset: 'lists',
    annotations: readAnnotations,
    inputSchema: { list_id: listId, max_results: maxResults(1, 100, 100), next_token: paginationToken },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/lists/${args.list_id}/followers`,
        auth: 'auto',
        query: { max_results: args.max_results, pagination_token: args.next_token, ...userQuery() },
        signal: extra.signal,
      });
      return { list_id: args.list_id, ...normalizeUserList({ data: res.data, includes: res.includes, meta: res.meta }) };
    },
  },
  {
    action: 'follow',
    name: 'x_follow_list',
    title: 'Follow a List',
    description: 'Follow a List so its timeline appears in your Lists tab. Requires user auth with list.write.',
    toolset: 'lists',
    annotations: writeAnnotations,
    inputSchema: { list_id: listId },
    async handler(args, ctx, extra) {
      const me = await resolveUserId(ctx, {}, extra);
      const res = await ctx.x.request<{ following?: boolean }>({
        method: 'POST',
        path: `/2/users/${me}/followed_lists`,
        auth: 'user',
        body: { list_id: args.list_id },
        signal: extra.signal,
      });
      return { list_id: args.list_id, following: res.data.following === true };
    },
  },
  {
    action: 'unfollow',
    name: 'x_unfollow_list',
    title: 'Unfollow a List',
    description: 'Stop following a List. Requires user auth with list.write.',
    toolset: 'lists',
    annotations: writeAnnotations,
    inputSchema: { list_id: listId },
    async handler(args, ctx, extra) {
      const me = await resolveUserId(ctx, {}, extra);
      const res = await ctx.x.request<{ following?: boolean }>({
        method: 'DELETE',
        path: `/2/users/${me}/followed_lists/${args.list_id}`,
        auth: 'user',
        signal: extra.signal,
      });
      return { list_id: args.list_id, following: res.data.following === true };
    },
  },
];
