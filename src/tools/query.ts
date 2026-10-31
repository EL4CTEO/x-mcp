import { LIST_FIELDS, MEDIA_FIELDS, POLL_FIELDS, SPACE_FIELDS, TWEET_EXPANSIONS, TWEET_FIELDS, USER_EXPANSIONS, USER_FIELDS } from '../x/fields.ts';

/** Reusable query fragments, kept in one place so every tool asks for the same fields. */
export function postQuery(extra: Record<string, string | number | undefined> = {}): Record<string, string | number | undefined> {
  return {
    'tweet.fields': TWEET_FIELDS,
    expansions: TWEET_EXPANSIONS,
    'user.fields': USER_FIELDS,
    'media.fields': MEDIA_FIELDS,
    'poll.fields': POLL_FIELDS,
    ...extra,
  };
}

export function userQuery(extra: Record<string, string | number | undefined> = {}): Record<string, string | number | undefined> {
  return {
    'user.fields': USER_FIELDS,
    expansions: USER_EXPANSIONS,
    ...extra,
  };
}

export function listQuery(extra: Record<string, string | number | undefined> = {}): Record<string, string | number | undefined> {
  return {
    'list.fields': LIST_FIELDS,
    'user.fields': USER_FIELDS,
    ...extra,
  };
}

export function spaceQuery(extra: Record<string, string | number | undefined> = {}): Record<string, string | number | undefined> {
  return {
    'space.fields': SPACE_FIELDS,
    'user.fields': USER_FIELDS,
    ...extra,
  };
}
