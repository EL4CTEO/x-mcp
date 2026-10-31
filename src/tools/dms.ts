import { z } from 'zod';
import type { ActionTool } from './define.ts';
import type { XResult } from '../x/client.ts';
import { normalizeDmEvents } from '../x/normalize.ts';
import { DM_EVENT_EXPANSIONS, DM_EVENT_FIELDS } from '../x/fields.ts';
import { maxResults, paginationToken, userRef } from './schemas.ts';
import { resolveUserId } from './resolve.ts';

type Json = Record<string, unknown>;

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const sendAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

function dmQuery(extra: Record<string, string | number | undefined> = {}): Record<string, string | number | undefined> {
  return {
    'dm_event.fields': DM_EVENT_FIELDS,
    expansions: DM_EVENT_EXPANSIONS,
    ...extra,
  };
}

function dmEvents(res: XResult<Json[]>) {
  return normalizeDmEvents({ data: res.data, includes: res.includes, meta: res.meta });
}

const messageInput = {
  text: z.string().min(1).max(10_000).describe('Message text.'),
  media_id: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional()
    .describe('Optional media id uploaded with category dm_image or dm_video.'),
};

export const dmTools: ActionTool[] = [
  {
    action: 'send',
    name: 'x_send_dm',
    title: 'Send a Direct Message',
    description:
      'Send a DM to a user, creating the 1:1 conversation if needed. Requires user auth with dm.write and the users.read scope. DMs are private: confirm the recipient and content before sending. Media must be uploaded first with x_upload_media using category dm_image/dm_video.',
    toolset: 'dms',
    annotations: sendAnnotations,
    inputSchema: {
      ...userRef,
      ...messageInput,
    },
    async handler(args, ctx, extra) {
      const participantId = await resolveUserId(ctx, args, extra);
      const body: Record<string, unknown> = { text: args.text };
      if (args.media_id) body.attachments = [{ media_id: args.media_id }];
      const res = await ctx.x.request<{ dm_conversation_id?: string; dm_event_id?: string }>({
        method: 'POST',
        path: `/2/dm_conversations/with/${participantId}/messages`,
        auth: 'user',
        body,
        signal: extra.signal,
      });
      return {
        sent: true,
        participant_id: participantId,
        conversation_id: res.data.dm_conversation_id,
        event_id: res.data.dm_event_id,
        text: args.text,
      };
    },
  },
  {
    action: 'send_to_conversation',
    name: 'x_send_dm_to_conversation',
    title: 'Send a DM to a conversation',
    description:
      'Send a message to an existing DM conversation by conversation id. Requires user auth with dm.write. Use x_get_dm_events to discover conversation ids.',
    toolset: 'dms',
    annotations: sendAnnotations,
    inputSchema: {
      conversation_id: z.string().min(1).max(64).describe('Conversation id from a DM event (dm_conversation_id).'),
      ...messageInput,
    },
    async handler(args, ctx, extra) {
      const body: Record<string, unknown> = { text: args.text };
      if (args.media_id) body.attachments = [{ media_id: args.media_id }];
      const res = await ctx.x.request<{ dm_conversation_id?: string; dm_event_id?: string }>({
        method: 'POST',
        path: `/2/dm_conversations/${encodeURIComponent(args.conversation_id)}/messages`,
        auth: 'user',
        body,
        signal: extra.signal,
      });
      return {
        sent: true,
        conversation_id: res.data.dm_conversation_id ?? args.conversation_id,
        event_id: res.data.dm_event_id,
        text: args.text,
      };
    },
  },
  {
    action: 'events',
    name: 'x_get_dm_events',
    title: 'List DM events',
    description:
      'Recent Direct Message events across all conversations, newest first (1-100 per page). Requires user auth with dm.read. Use event_types to filter (e.g. MessageCreate, ParticipantsJoin).',
    toolset: 'dms',
    annotations: readAnnotations,
    inputSchema: {
      max_results: maxResults(1, 100, 50),
      next_token: paginationToken,
      event_types: z
        .array(z.string().min(1))
        .optional()
        .describe('Filter by event type, e.g. MessageCreate, ParticipantsJoin, ParticipantsLeave.'),
    },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: '/2/dm_events',
        auth: 'user',
        query: dmQuery({
          max_results: args.max_results,
          pagination_token: args.next_token,
          event_types: args.event_types?.join(','),
        }),
        cache: false,
        signal: extra.signal,
      });
      return dmEvents(res);
    },
  },
  {
    action: 'conversation',
    name: 'x_get_dm_conversation',
    title: 'Read a DM conversation',
    description:
      'Messages in one DM conversation, newest first (1-100 per page). Requires user auth with dm.read.',
    toolset: 'dms',
    annotations: readAnnotations,
    inputSchema: {
      conversation_id: z.string().min(1).max(64),
      max_results: maxResults(1, 100, 50),
      next_token: paginationToken,
    },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/dm_conversations/${encodeURIComponent(args.conversation_id)}/dm_events`,
        auth: 'user',
        query: dmQuery({ max_results: args.max_results, pagination_token: args.next_token }),
        cache: false,
        signal: extra.signal,
      });
      return { conversation_id: args.conversation_id, ...dmEvents(res) };
    },
  },
  {
    action: 'with_user',
    name: 'x_get_dm_with_user',
    title: 'Read the DM conversation with a user',
    description:
      'Messages exchanged with one user, newest first (1-100 per page). Resolves a username to the participant id automatically. Requires user auth with dm.read.',
    toolset: 'dms',
    annotations: readAnnotations,
    inputSchema: {
      ...userRef,
      max_results: maxResults(1, 100, 50),
      next_token: paginationToken,
    },
    async handler(args, ctx, extra) {
      const participantId = await resolveUserId(ctx, args, extra);
      const res = await ctx.x.request<Json[]>({
        method: 'GET',
        path: `/2/dm_conversations/with/${participantId}/dm_events`,
        auth: 'user',
        query: dmQuery({ max_results: args.max_results, pagination_token: args.next_token }),
        cache: false,
        signal: extra.signal,
      });
      return { participant_id: participantId, ...dmEvents(res) };
    },
  },
  {
    action: 'delete',
    name: 'x_delete_dm',
    title: 'Delete a DM event',
    description:
      'Delete a Direct Message event sent by the authenticated account. Requires user auth with dm.write. The message is removed from the conversation for both parties.',
    toolset: 'dms',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: { event_id: z.string().regex(/^\d{1,19}$/).describe('Numeric DM event id.') },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<{ deleted?: boolean }>({
        method: 'DELETE',
        path: `/2/dm_events/${args.event_id}`,
        auth: 'user',
        signal: extra.signal,
      });
      return { deleted: res.data.deleted === true, event_id: args.event_id };
    },
  },
];
