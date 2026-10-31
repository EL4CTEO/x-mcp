/**
 * Response normalisation.
 *
 * Raw X payloads are verbose, spread related objects across `includes`, and
 * change shape between endpoints. Agents do better with flat, stable objects
 * that already contain URLs and resolved authors, so every read tool returns
 * these projections. `raw: true` on a tool bypasses this layer.
 */
import type { Includes } from './types.ts';

type Json = Record<string, unknown>;

export function compact<T extends Json>(value: T): T {
  const out: Json = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    out[key] = entry;
  }
  return out as T;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function indexedIncludes(includes?: Includes): {
  users: Map<string, Json>;
  media: Map<string, Json>;
  tweets: Map<string, Json>;
  polls: Map<string, Json>;
} {
  const users = new Map<string, Json>();
  const media = new Map<string, Json>();
  const tweets = new Map<string, Json>();
  const polls = new Map<string, Json>();
  for (const user of includes?.users ?? []) {
    const id = str((user as Json).id);
    if (id) users.set(id, user as Json);
  }
  for (const item of includes?.media ?? []) {
    const key = str((item as Json).media_key);
    if (key) media.set(key, item as Json);
  }
  for (const tweet of includes?.tweets ?? []) {
    const id = str((tweet as Json).id);
    if (id) tweets.set(id, tweet as Json);
  }
  for (const poll of includes?.polls ?? []) {
    const id = str((poll as Json).id);
    if (id) polls.set(id, poll as Json);
  }
  return { users, media, tweets, polls };
}

export interface NormalizeContext {
  users: Map<string, Json>;
  media: Map<string, Json>;
  tweets: Map<string, Json>;
  polls: Map<string, Json>;
}

export function contextFrom(includes?: Includes): NormalizeContext {
  return indexedIncludes(includes);
}

function bestVideoUrl(variants: unknown): string | undefined {
  if (!Array.isArray(variants)) return undefined;
  const mp4 = variants
    .map((variant) => variant as Json)
    .filter((variant) => variant.content_type === 'video/mp4' && typeof variant.url === 'string')
    .sort((a, b) => (num(b.bit_rate) ?? 0) - (num(a.bit_rate) ?? 0));
  return str(mp4[0]?.url);
}

export function normalizeMedia(raw: Json): Json {
  const type = str(raw.type);
  const metrics = (raw.public_metrics as Json | undefined) ?? {};
  return compact({
    media_key: str(raw.media_key),
    type,
    url: str(raw.url) ?? bestVideoUrl(raw.variants),
    preview_image_url: str(raw.preview_image_url),
    alt_text: str(raw.alt_text),
    width: num(raw.width),
    height: num(raw.height),
    duration_ms: num(raw.duration_ms),
    views: num(metrics.playback_count) ?? num(metrics.view_count),
  });
}

export function normalizeUser(raw: Json): Json {
  const metrics = (raw.public_metrics as Json | undefined) ?? {};
  const username = str(raw.username);
  return compact({
    id: str(raw.id),
    username,
    name: str(raw.name),
    url: username ? `https://x.com/${username}` : undefined,
    bio: str(raw.description),
    location: str(raw.location),
    created_at: str(raw.created_at),
    verified: raw.verified === true,
    verified_type: str(raw.verified_type),
    protected: raw.protected === true,
    profile_image_url: str(raw.profile_image_url),
    followers: num(metrics.followers_count),
    following: num(metrics.following_count),
    posts: num(metrics.tweet_count),
    listed: num(metrics.listed_count),
    pinned_tweet_id: str(raw.pinned_tweet_id),
  });
}

export function normalizeAuthor(raw: Json | undefined): Json | undefined {
  if (!raw) return undefined;
  const user = normalizeUser(raw);
  return compact({
    id: user.id,
    username: user.username,
    name: user.name,
    verified: user.verified,
  });
}

export function normalizeTweet(raw: Json, context: NormalizeContext, depth = 0): Json {
  const authorId = str(raw.author_id);
  const author = normalizeAuthor(authorId ? context.users.get(authorId) : undefined);
  const metrics = (raw.public_metrics as Json | undefined) ?? {};
  const entities = (raw.entities as Json | undefined) ?? {};
  const note = raw.note_tweet as Json | undefined;
  const noteText = note ? str((note.text as unknown)) : undefined;

  const attachments = (raw.attachments as Json | undefined) ?? {};
  const mediaKeys = Array.isArray(attachments.media_keys) ? (attachments.media_keys as string[]) : [];
  const media = mediaKeys
    .map((key) => context.media.get(key))
    .filter((item): item is Json => Boolean(item))
    .map(normalizeMedia);

  const referenced = Array.isArray(raw.referenced_tweets) ? (raw.referenced_tweets as Json[]) : [];
  const repliedTo = referenced.find((ref) => ref.type === 'replied_to');
  const quoted = referenced.find((ref) => ref.type === 'quoted');
  const retweeted = referenced.find((ref) => ref.type === 'retweeted');

  const hashtags = Array.isArray(entities.hashtags)
    ? (entities.hashtags as Json[]).map((tag) => str(tag.tag)).filter((tag): tag is string => Boolean(tag))
    : undefined;
  const mentions = Array.isArray(entities.mentions)
    ? (entities.mentions as Json[])
        .map((mention) => str(mention.username))
        .filter((name): name is string => Boolean(name))
    : undefined;
  const urls = Array.isArray(entities.urls)
    ? (entities.urls as Json[]).map((entry) =>
        compact({
          url: str(entry.url),
          expanded_url: str(entry.expanded_url),
          display_url: str(entry.display_url),
        }),
      )
    : undefined;

  const metricsValue = compact({
    likes: num(metrics.like_count),
    reposts: num(metrics.retweet_count),
    replies: num(metrics.reply_count),
    quotes: num(metrics.quote_count),
    bookmarks: num(metrics.bookmark_count),
    impressions: num(metrics.impression_count),
  });
  const editHistory = Array.isArray(raw.edit_history_tweet_ids)
    ? (raw.edit_history_tweet_ids as string[])
    : undefined;
  const id = str(raw.id);

  const tweet: Json = compact({
    id,
    url: author?.username
      ? `https://x.com/${author.username}/status/${id}`
      : str(raw.url) ?? (id ? `https://x.com/i/web/status/${id}` : undefined),
    text: noteText ?? str(raw.text),
    created_at: str(raw.created_at),
    lang: str(raw.lang),
    author,
    metrics: Object.keys(metricsValue).length > 0 ? metricsValue : undefined,
    conversation_id: str(raw.conversation_id),
    in_reply_to_tweet_id: str(repliedTo?.id),
    quoted_tweet_id: str(quoted?.id),
    retweeted_tweet_id: str(retweeted?.id),
    media: media.length > 0 ? media : undefined,
    hashtags: hashtags && hashtags.length > 0 ? hashtags : undefined,
    mentions: mentions && mentions.length > 0 ? mentions : undefined,
    urls: urls && urls.length > 0 ? urls : undefined,
    possibly_sensitive: raw.possibly_sensitive === true ? true : undefined,
    edited: editHistory && editHistory.length > 1 ? true : undefined,
    reply_settings: str(raw.reply_settings),
    source: str(raw.source),
  });

  // One level of context for the post this one refers to: enough for agents to
  // understand a conversation without exploding the payload.
  if (depth === 0 && (quoted || retweeted)) {
    const refId = str(quoted?.id ?? retweeted?.id);
    const included = refId ? context.tweets.get(refId) : undefined;
    if (included) {
      tweet.referenced_post = normalizeTweet(included, context, 1);
    }
  }
  return tweet;
}

export interface NormalizedList {
  data: Json[];
  next_token?: string;
  previous_token?: string;
  result_count?: number;
  errors?: unknown[];
  included?: { users?: Json[]; tweets?: Json[]; media?: Json[] };
}

function metaOf(payload: Json): { next_token?: string; previous_token?: string; result_count?: number } {
  const meta = (payload.meta as Json | undefined) ?? {};
  return compact({
    next_token: str(meta.next_token),
    previous_token: str(meta.previous_token),
    result_count: num(meta.result_count),
  });
}

export function normalizeTweetList(payload: Json): NormalizedList {
  const includes = payload.includes as Includes | undefined;
  const context = contextFrom(includes);
  const data = Array.isArray(payload.data) ? (payload.data as Json[]) : [];
  return {
    data: data.map((tweet) => normalizeTweet(tweet, context)),
    ...metaOf(payload),
    ...(Array.isArray(payload.errors) && payload.errors.length > 0 ? { errors: payload.errors } : {}),
  };
}

export function normalizeTweetSingle(payload: Json): Json | undefined {
  const data = payload.data as Json | Json[] | undefined;
  const includes = payload.includes as Includes | undefined;
  const context = contextFrom(includes);
  if (Array.isArray(data)) return data[0] ? normalizeTweet(data[0], context) : undefined;
  if (data) return normalizeTweet(data, context);
  // Some write endpoints return only ids; keep those.
  return undefined;
}

export function normalizeUserList(payload: Json): NormalizedList {
  const data = Array.isArray(payload.data) ? (payload.data as Json[]) : [];
  const context = contextFrom(payload.includes as Includes | undefined);
  const includedTweets = [...context.tweets.values()];
  return {
    data: data.map((user) => normalizeUser(user)),
    ...metaOf(payload),
    ...(includedTweets.length > 0
      ? { included: { tweets: includedTweets.map((tweet) => normalizeTweet(tweet, context)) } }
      : {}),
    ...(Array.isArray(payload.errors) && payload.errors.length > 0 ? { errors: payload.errors } : {}),
  };
}

export function normalizeUserSingle(payload: Json): Json | undefined {
  const data = payload.data as Json | Json[] | undefined;
  if (Array.isArray(data)) return data[0] ? normalizeUser(data[0]) : undefined;
  return data ? normalizeUser(data) : undefined;
}

export function normalizeList(raw: Json): Json {
  const ownerId = str(raw.owner_id);
  return compact({
    id: str(raw.id),
    name: str(raw.name),
    description: str(raw.description),
    private: raw.private === true,
    members: num(raw.member_count),
    followers: num(raw.follower_count),
    owner_id: ownerId,
    created_at: str(raw.created_at),
    url: str(raw.id) ? `https://x.com/i/lists/${str(raw.id)}` : undefined,
  });
}

export function normalizeSpace(raw: Json): Json {
  const creatorId = str(raw.creator_id);
  const state = str(raw.state);
  return compact({
    id: str(raw.id),
    title: str(raw.title),
    state,
    url: str(raw.id) ? `https://x.com/i/spaces/${str(raw.id)}` : undefined,
    creator_id: creatorId,
    hosts: Array.isArray(raw.host_ids) ? (raw.host_ids as string[]) : undefined,
    participants: num(raw.participant_count),
    scheduled_start: str(raw.scheduled_start),
    started_at: str(raw.started_at),
    ended_at: str(raw.ended_at),
    is_ticketed: raw.is_ticketed === true ? true : undefined,
    lang: str(raw.lang),
  });
}

export function normalizeTrend(raw: Json): Json {
  const name = str(raw.trend_name) ?? str(raw.name) ?? '';
  return compact({
    name,
    posts: num(raw.tweet_count) ?? num(raw.post_count) ?? num(raw.tweet_volume),
    category: str(raw.category),
    trending_since: str(raw.trending_since),
    url: name ? `https://x.com/search?q=${encodeURIComponent(name)}` : undefined,
  });
}

export function normalizeDmEvent(raw: Json, context?: NormalizeContext): Json {
  const attachmentValue = raw.attachments as Json | Json[] | undefined;
  const keys = Array.isArray(attachmentValue)
    ? attachmentValue.map((attachment) => str(attachment.media_key)).filter((key): key is string => Boolean(key))
    : Array.isArray((attachmentValue as Json | undefined)?.media_keys)
      ? ((attachmentValue as Json).media_keys as unknown[]).map((key) => String(key))
      : [];
  const attachments = keys.map((key) => {
    const media = context?.media.get(key);
    return media ? normalizeMedia(media) : { media_key: key };
  });
  return compact({
    id: str(raw.id),
    event_type: str(raw.event_type),
    conversation_id: str(raw.dm_conversation_id),
    text: str(raw.text),
    created_at: str(raw.created_at),
    sender_id: str(raw.sender_id),
    attachments: attachments.length > 0 ? attachments : undefined,
  });
}

export function normalizeDmEvents(payload: Json): NormalizedList {
  const data = Array.isArray(payload.data) ? (payload.data as Json[]) : [];
  const context = contextFrom(payload.includes as Includes | undefined);
  return {
    data: data.map((event) => normalizeDmEvent(event, context)),
    ...metaOf(payload),
    ...(Array.isArray(payload.errors) && payload.errors.length > 0 ? { errors: payload.errors } : {}),
  };
}
