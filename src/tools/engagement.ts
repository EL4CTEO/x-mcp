import type { ActionTool } from './define.ts';
import { resolveUserId } from './resolve.ts';
import { tweetId } from './schemas.ts';

const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function engagement(verb: string, extra: Record<string, unknown> = {}) {
  return { action: verb, at: new Date().toISOString(), ...extra };
}

export const engagementTools: ActionTool[] = [
  {
    action: 'like',
    name: 'x_like_post',
    title: 'Like a post',
    description: 'Like a post as the authenticated account. Requires user auth with like.write. Idempotent: liking an already-liked post is a no-op.',
    toolset: 'engagement',
    annotations: writeAnnotations,
    inputSchema: { tweet_id: tweetId },
    async handler(args, ctx, extra) {
      const me = await resolveUserId(ctx, {}, extra);
      const res = await ctx.x.request<{ liked?: boolean }>({
        method: 'POST',
        path: `/2/users/${me}/likes`,
        auth: 'user',
        body: { tweet_id: args.tweet_id },
        signal: extra.signal,
      });
      return engagement('like', { user_id: me, tweet_id: args.tweet_id, liked: res.data.liked === true });
    },
  },
  {
    action: 'unlike',
    name: 'x_unlike_post',
    title: 'Unlike a post',
    description: 'Remove a like from a post. Requires user auth with like.write.',
    toolset: 'engagement',
    annotations: writeAnnotations,
    inputSchema: { tweet_id: tweetId },
    async handler(args, ctx, extra) {
      const me = await resolveUserId(ctx, {}, extra);
      const res = await ctx.x.request<{ liked?: boolean }>({
        method: 'DELETE',
        path: `/2/users/${me}/likes/${args.tweet_id}`,
        auth: 'user',
        signal: extra.signal,
      });
      return engagement('unlike', { user_id: me, tweet_id: args.tweet_id, liked: res.data.liked === true });
    },
  },
  {
    action: 'repost',
    name: 'x_repost',
    title: 'Repost (retweet) a post',
    description: 'Repost a post to your followers. Requires user auth with tweet.write. Idempotent.',
    toolset: 'engagement',
    annotations: writeAnnotations,
    inputSchema: { tweet_id: tweetId },
    async handler(args, ctx, extra) {
      const me = await resolveUserId(ctx, {}, extra);
      const res = await ctx.x.request<{ retweeted?: boolean }>({
        method: 'POST',
        path: `/2/users/${me}/retweets`,
        auth: 'user',
        body: { tweet_id: args.tweet_id },
        signal: extra.signal,
      });
      return engagement('repost', { user_id: me, tweet_id: args.tweet_id, reposted: res.data.retweeted === true });
    },
  },
  {
    action: 'unrepost',
    name: 'x_unrepost',
    title: 'Undo a repost',
    description: 'Remove one of your reposts. Requires user auth with tweet.write.',
    toolset: 'engagement',
    annotations: writeAnnotations,
    inputSchema: { tweet_id: tweetId },
    async handler(args, ctx, extra) {
      const me = await resolveUserId(ctx, {}, extra);
      const res = await ctx.x.request<{ retweeted?: boolean }>({
        method: 'DELETE',
        path: `/2/users/${me}/retweets/${args.tweet_id}`,
        auth: 'user',
        signal: extra.signal,
      });
      return engagement('unrepost', { user_id: me, tweet_id: args.tweet_id, reposted: res.data.retweeted === true });
    },
  },
  {
    action: 'bookmark',
    name: 'x_bookmark_post',
    title: 'Bookmark a post',
    description: 'Save a post to your bookmarks. Requires user auth with bookmark.write. Useful for building a research queue the agent can revisit with x_bookmarks.',
    toolset: 'engagement',
    annotations: writeAnnotations,
    inputSchema: { tweet_id: tweetId },
    async handler(args, ctx, extra) {
      const me = await resolveUserId(ctx, {}, extra);
      const res = await ctx.x.request<{ bookmarked?: boolean }>({
        method: 'POST',
        path: `/2/users/${me}/bookmarks`,
        auth: 'user',
        body: { tweet_id: args.tweet_id },
        signal: extra.signal,
      });
      return engagement('bookmark', { user_id: me, tweet_id: args.tweet_id, bookmarked: res.data.bookmarked === true });
    },
  },
  {
    action: 'unbookmark',
    name: 'x_unbookmark_post',
    title: 'Remove a bookmark',
    description: 'Remove a post from your bookmarks. Requires user auth with bookmark.write.',
    toolset: 'engagement',
    annotations: writeAnnotations,
    inputSchema: { tweet_id: tweetId },
    async handler(args, ctx, extra) {
      const me = await resolveUserId(ctx, {}, extra);
      const res = await ctx.x.request<{ bookmarked?: boolean }>({
        method: 'DELETE',
        path: `/2/users/${me}/bookmarks/${args.tweet_id}`,
        auth: 'user',
        signal: extra.signal,
      });
      return engagement('unbookmark', { user_id: me, tweet_id: args.tweet_id, bookmarked: res.data.bookmarked === true });
    },
  },
];
