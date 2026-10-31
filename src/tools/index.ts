import { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { TOOLSETS, toolsetEnabled, type Config, type Toolset } from '../config.ts';
import type { ActionTool, ToolGroup } from './define.ts';
import { postTools } from './posts.ts';
import { timelineTools } from './timelines.ts';
import { userTools } from './users.ts';
import { engagementTools } from './engagement.ts';
import { listTools } from './lists.ts';
import { spaceTools } from './spaces.ts';
import { trendTools } from './trends.ts';
import { dmTools } from './dms.ts';
import { mediaTools } from './media.ts';
import { metaTools } from './meta.ts';

interface GroupMeta {
  name: string;
  title: string;
  description: string;
}

const GROUP_META: Record<Toolset, GroupMeta> = {
  posts: {
    name: 'x_posts',
    title: 'X posts',
    description:
      'Create, read, search and moderate posts: publish posts and threads, fetch one or many by id, search recent or full-archive, count volume, reconstruct a conversation, list likers/reposters/quotes, hide replies, delete.',
  },
  timelines: {
    name: 'x_timelines',
    title: 'X timelines',
    description: 'Read home and user timelines, mentions, liked posts and your bookmarks.',
  },
  users: {
    name: 'x_users',
    title: 'X users',
    description:
      'Profiles and relationships: look up me/one/many, search users, followers, following, follow/unfollow, mute/unmute, block/unblock, muted and blocked lists.',
  },
  engagement: {
    name: 'x_engagement',
    title: 'X engagement',
    description: 'Like, repost and bookmark posts, and undo those actions, as the authenticated account.',
  },
  lists: {
    name: 'x_lists',
    title: 'X Lists',
    description:
      'Manage Lists and read their timelines: create, update, delete, look up, owned/memberships/pinned Lists, add/remove members, list members/followers/posts, follow/unfollow.',
  },
  spaces: {
    name: 'x_spaces',
    title: 'X Spaces',
    description: 'Search live or scheduled audio Spaces and read the posts shared in them.',
  },
  trends: {
    name: 'x_trends',
    title: 'X trends',
    description: 'Trending topics by location (WOEID) and personalised trends for the authenticated account.',
  },
  dms: {
    name: 'x_dms',
    title: 'X Direct Messages',
    description:
      'Send and read Direct Messages: send to a user or an existing conversation, read events, read a conversation, and delete an event.',
  },
  media: {
    name: 'x_media',
    title: 'X media',
    description:
      'Upload media, check video/GIF processing, and view attached media — photos are returned as images, videos are sampled into frames when ffmpeg is installed.',
  },
  meta: {
    name: 'x_meta',
    title: 'X diagnostics',
    description: 'Check credentials, observed rate limits and billed API usage.',
  },
};

export const ALL_ACTIONS: readonly ActionTool[] = [
  ...postTools,
  ...timelineTools,
  ...userTools,
  ...engagementTools,
  ...listTools,
  ...spaceTools,
  ...trendTools,
  ...dmTools,
  ...mediaTools,
  ...metaTools,
];

function firstSentence(text: string): string {
  const match = text.match(/^(.+?[.!?])(?:\s|$)/);
  const sentence = match?.[1] ?? text;
  return sentence.length > 190 ? `${sentence.slice(0, 187)}…` : sentence;
}

/**
 * The group schema is a union of every action's parameter schema. The SDK
 * validates the outer shape; the action adapter re-parses with the exact
 * schema, so ranges, enums and defaults stay per-action while all actions share
 * one MCP tool.
 */
function mergeActionSchemas(actions: ActionTool[]): z.ZodRawShape {
  const byKey = new Map<string, z.ZodTypeAny[]>();
  for (const action of actions) {
    for (const [key, schema] of Object.entries(action.inputSchema)) {
      if (key === 'action') throw new Error(`Action ${action.name} defines a reserved "action" parameter.`);
      const schemas = byKey.get(key) ?? [];
      const candidate = schema as unknown as z.ZodTypeAny;
      if (!schemas.includes(candidate)) schemas.push(candidate);
      byKey.set(key, schemas);
    }
  }

  const actionNames = actions.map((action) => action.action);
  const merged: Record<string, z.ZodTypeAny> = {
    action: z
      .enum(actionNames as [string, ...string[]])
      .describe(`Action to perform. One of: ${actionNames.join(', ')}.`),
  };

  for (const [key, schemas] of byKey) {
    if (schemas.length === 1) {
      merged[key] = (schemas[0] as z.ZodTypeAny).optional();
    } else {
      merged[key] = z.union(schemas as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]).optional();
    }
  }
  return merged;
}

function buildGroup(toolset: Toolset): ToolGroup {
  const meta = GROUP_META[toolset];
  const actions = ALL_ACTIONS.filter((action) => action.toolset === toolset);
  if (actions.length === 0) throw new Error(`No actions registered for toolset ${toolset}.`);

  const seen = new Set<string>();
  for (const action of actions) {
    if (seen.has(action.action)) throw new Error(`Duplicate action "${action.action}" in ${meta.name}.`);
    seen.add(action.action);
  }

  const list = actions
    .map((action) => {
      const required = Object.entries(action.inputSchema)
        .filter(([, schema]) => !(schema as unknown as z.ZodTypeAny).safeParse(undefined).success)
        .map(([key]) => key);
      const needs = required.length > 0 ? ` [requires: ${required.join(', ')}]` : '';
      return `- ${action.action}: ${firstSentence(action.description)}${needs}`;
    })
    .join('\n');
  const description = `${meta.description}\n\nActions (pass "action" plus that action's parameters):\n${list}`;

  const annotations: ToolAnnotations = {
    readOnlyHint: actions.every((action) => action.annotations.readOnlyHint === true),
    destructiveHint: actions.some((action) => action.annotations.destructiveHint === true),
    openWorldHint: true,
    idempotentHint: actions.every((action) => action.annotations.idempotentHint !== false),
  };

  return {
    ...meta,
    toolset,
    actions,
    inputSchema: mergeActionSchemas(actions),
    annotations,
    description,
  };
}

export const ALL_TOOLS: readonly ToolGroup[] = TOOLSETS.map(buildGroup);

export function toolsFor(config: Config): ToolGroup[] {
  return ALL_TOOLS.filter((group) => toolsetEnabled(config, group.toolset));
}

export { registerToolGroups as registerTools } from './define.ts';
export type { ToolContext, RegisteredToolDefinition, ToolGroup, ActionTool } from './define.ts';
