/**
 * Default field/expansion sets.
 *
 * X bills per post returned, so we ask for the fields an agent actually needs
 * and skip the expensive extras (context annotations, organic metrics, withheld
 * content). Callers can always request the raw payload when they need more.
 */
export const TWEET_FIELDS = [
  'attachments',
  'author_id',
  'conversation_id',
  'created_at',
  'edit_history_tweet_ids',
  'entities',
  'id',
  'in_reply_to_user_id',
  'lang',
  'note_tweet',
  'possibly_sensitive',
  'public_metrics',
  'referenced_tweets',
  'reply_settings',
  'source',
  'text',
].join(',');

export const TWEET_EXPANSIONS = [
  'author_id',
  'referenced_tweets.id',
  'referenced_tweets.id.author_id',
  'attachments.media_keys',
  'attachments.poll_ids',
].join(',');

export const USER_FIELDS = [
  'created_at',
  'description',
  'entities',
  'id',
  'location',
  'name',
  'pinned_tweet_id',
  'profile_image_url',
  'protected',
  'public_metrics',
  'url',
  'username',
  'verified',
  'verified_type',
].join(',');

export const USER_EXPANSIONS = ['pinned_tweet_id'].join(',');

export const MEDIA_FIELDS = [
  'alt_text',
  'duration_ms',
  'height',
  'media_key',
  'preview_image_url',
  'public_metrics',
  'type',
  'url',
  'variants',
  'width',
].join(',');

export const POLL_FIELDS = ['duration_minutes', 'end_datetime', 'id', 'options', 'voting_status'].join(',');

export const LIST_FIELDS = ['created_at', 'description', 'follower_count', 'id', 'member_count', 'name', 'owner_id', 'private'].join(',');

export const SPACE_FIELDS = [
  'created_at',
  'creator_id',
  'ended_at',
  'host_ids',
  'id',
  'is_ticketed',
  'lang',
  'participant_count',
  'scheduled_start',
  'started_at',
  'state',
  'title',
  'updated_at',
].join(',');

export const SPACE_EXPANSIONS = ['creator_id', 'host_ids', 'speaker_ids'].join(',');

export const TREND_FIELDS = ['trend_name', 'tweet_count'].join(',');

export const DM_EVENT_FIELDS = ['attachments', 'created_at', 'dm_conversation_id', 'id', 'sender_id', 'text'].join(',');

export const DM_EVENT_EXPANSIONS = ['attachments.media_keys', 'sender_id'].join(',');

/** Fields shared by every timeline/lookup call. */
export interface BaseQuery {
  [key: string]: string | number | boolean | undefined | null;
}

export function tweetQuery(): BaseQuery {
  return {
    'tweet.fields': TWEET_FIELDS,
    expansions: TWEET_EXPANSIONS,
    'user.fields': USER_FIELDS,
    'media.fields': MEDIA_FIELDS,
    'poll.fields': POLL_FIELDS,
  };
}

export function userQuery(): BaseQuery {
  return { 'user.fields': USER_FIELDS, expansions: USER_EXPANSIONS, 'tweet.fields': TWEET_FIELDS };
}
