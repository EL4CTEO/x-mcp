/** Minimal structural types for X API v2 payloads (only what we read). */
export interface Includes {
  users?: unknown[];
  tweets?: unknown[];
  media?: unknown[];
  polls?: unknown[];
  places?: unknown[];
}

export interface XMeta {
  next_token?: string;
  previous_token?: string;
  result_count?: number;
  newest_id?: string;
  oldest_id?: string;
}

export interface XListResponse<T = unknown> {
  data?: T[];
  includes?: Includes;
  meta?: XMeta;
  errors?: unknown[];
}

export interface XSingleResponse<T = unknown> {
  data?: T;
  includes?: Includes;
  errors?: unknown[];
}

export interface XWriteResponse {
  data?: { id: string; text?: string; [key: string]: unknown };
  errors?: unknown[];
}

export interface TweetMetrics {
  like_count?: number;
  retweet_count?: number;
  reply_count?: number;
  quote_count?: number;
  bookmark_count?: number;
  impression_count?: number;
}

export interface RawTweet {
  id?: string;
  text?: string;
  author_id?: string;
  conversation_id?: string;
  created_at?: string;
  lang?: string;
  possibly_sensitive?: boolean;
  reply_settings?: string;
  source?: string;
  public_metrics?: TweetMetrics;
  entities?: {
    hashtags?: Array<{ tag?: string }>;
    mentions?: Array<{ username?: string }>;
    urls?: Array<{ url?: string; expanded_url?: string; display_url?: string }>;
  };
  note_tweet?: { text?: string };
  attachments?: { media_keys?: string[]; poll_ids?: string[] };
  referenced_tweets?: Array<{ type?: string; id?: string }>;
  edit_history_tweet_ids?: string[];
}

export interface RawUser {
  id?: string;
  username?: string;
  name?: string;
  description?: string;
  location?: string;
  created_at?: string;
  verified?: boolean;
  verified_type?: string;
  protected?: boolean;
  profile_image_url?: string;
  pinned_tweet_id?: string;
  public_metrics?: {
    followers_count?: number;
    following_count?: number;
    tweet_count?: number;
    listed_count?: number;
  };
}

export interface RawMedia {
  media_key?: string;
  type?: string;
  url?: string;
  preview_image_url?: string;
  alt_text?: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  variants?: Array<{ content_type?: string; url?: string; bit_rate?: number }>;
  public_metrics?: { playback_count?: number; view_count?: number };
}

export interface RawTweetEntity {
  id?: string;
  text?: string;
  author_id?: string;
  created_at?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: Array<{ type?: string; id?: string }>;
  attachments?: { media_keys?: string[] };
}
