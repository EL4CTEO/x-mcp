import type { ToolContext } from './define.ts';
import type { ToolExtra } from './define.ts';
import { userId, username } from './schemas.ts';

export interface UserRefInput {
  user_id?: string | undefined;
  username?: string | undefined;
}

/**
 * Resolves an optional {user_id | username} pair to a numeric id.
 * With neither, falls back to the authenticated account.
 */
export async function resolveUserId(
  ctx: ToolContext,
  ref: UserRefInput,
  extra: ToolExtra,
): Promise<string> {
  if (ref.user_id) return ref.user_id;
  if (ref.username) {
    const res = await ctx.x.request<{ id?: string }>({
      method: 'GET',
      path: `/2/users/by/username/${encodeURIComponent(ref.username)}`,
      auth: 'auto',
      query: { 'user.fields': 'id' },
      cache: { ttlMs: 300_000 },
      signal: extra.signal,
    });
    if (!res.data.id) throw new Error(`No user found for @${ref.username}.`);
    return res.data.id;
  }
  const me = await ctx.x.request<{ id?: string }>({
    method: 'GET',
    path: '/2/users/me',
    auth: 'user',
    query: { 'user.fields': 'id' },
    cache: { ttlMs: 60_000 },
    signal: extra.signal,
  });
  if (!me.data.id) throw new Error('Could not resolve the authenticated account id.');
  return me.data.id;
}

export { userId, username };
