import { z } from 'zod';

/** Shared input fragments keep tool schemas consistent and small. */

export const userId = z
  .string()
  .regex(/^\d{1,19}$/, 'User id must be a numeric snowflake')
  .describe('Numeric X user id.');

export const username = z
  .string()
  .regex(/^[A-Za-z0-9_]{1,15}$/, 'Username must be 1-15 letters, digits or underscores')
  .describe('X handle without the @ prefix.');

export const tweetId = z.string().regex(/^\d{1,19}$/, 'Post id must be numeric').describe('Numeric post id.');

export const listId = z.string().regex(/^\d{1,19}$/, 'List id must be numeric').describe('Numeric List id.');

export const spaceId = z.string().regex(/^[A-Za-z0-9]{1,40}$/, 'Space id is alphanumeric').describe('Space id.');

export const paginationToken = z
  .string()
  .max(2_000)
  .optional()
  .describe('Cursor from a previous response (meta.next_token).');

export const maxResults = (min: number, max: number, fallback: number) =>
  z
    .number()
    .int()
    .min(min)
    .max(max)
    .default(fallback)
    .describe(`Number of results to return (${min}-${max}).`);

export const userRef = {
  user_id: userId.optional(),
  username: username.optional(),
};

export const timeRange = {
  start_time: z
    .string()
    .optional()
    .describe('ISO 8601 timestamp (e.g. 2026-01-31T12:00:00Z). Inclusive lower bound.'),
  end_time: z.string().optional().describe('ISO 8601 timestamp. Exclusive upper bound.'),
};

export const rawFlag = z
  .boolean()
  .default(false)
  .describe('Return the unmodified X API payload instead of the normalised projection.');

export const replySettings = z
  .enum(['following', 'mentionedUsers', 'subscribers', 'verified'])
  .optional()
  .describe('Who may reply: following, mentionedUsers, subscribers or verified.');

export const expansionsParam = z
  .string()
  .optional()
  .describe('Comma-separated X expansions to add to the default set (advanced).');

export const fieldsParam = z
  .string()
  .optional()
  .describe('Comma-separated X fields to add to the default set (advanced).');

export type UserRef = { user_id?: string; username?: string };
