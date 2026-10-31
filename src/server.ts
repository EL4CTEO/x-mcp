import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import { XClient } from './x/client.ts';
import { MediaUploader } from './x/media.ts';
import { MediaViewer } from './x/viewer.ts';
import type { AuthManager } from './auth/manager.ts';
import { toolsFor, registerTools, type RegisteredToolDefinition, type ToolContext } from './tools/index.ts';
import { registerResources } from './resources.ts';
import { registerPrompts } from './prompts.ts';

export interface Runtime {
  config: Config;
  logger: Logger;
  x: XClient;
  media: MediaUploader;
  viewer: MediaViewer;
  ctx: ToolContext;
}

export interface ServerInstance {
  server: McpServer;
  tools: RegisteredToolDefinition[];
}

const INSTRUCTIONS = `X (Twitter) API v2 tools for AI agents.

TOOLS ARE GROUPED
- Ten domain tools (x_posts, x_timelines, x_users, x_engagement, x_lists, x_spaces, x_trends, x_dms, x_media, x_meta) each take an "action" field plus that action's parameters.
- Read the tool description for the action list, and the input schema for parameter names. Example: {"action":"search","query":"mcp -is:retweet"} on x_posts.

AUTHENTICATION
- Public reads work with an app-only bearer token. Anything that acts as a person (posting, replying, liking, reposting, bookmarking, following, DMs, private timelines) needs a user session.
- Check x_meta action "auth_status" first when a call fails with 401/403.

COST AND RATE LIMITS
- X bills per post returned, not per request. Prefer batched reads (x_posts "get_many", x_users "get_many") over loops, keep max_results small, and use x_posts "count" when only volume matters.
- Responses are normalised to compact objects with URLs and resolved authors. Paging uses next_token from meta.
- If a rate-limit bucket is exhausted the server either waits for the reset or returns a 429 with the reset time (x_meta "rate_limits" shows the observed windows).

WORKING WITH IDS
- Never invent ids. Resolve handles with x_users action "get", then use the numeric id.
- Read a post with x_posts "get"; reconstruct a conversation with x_posts "thread".

PUBLIC ACTIONS
- Posting, replying, liking, following and DMs are visible to real people. Confirm intent with the user before performing them, never spam or run bulk engagement, and respect X's automation rules.
- Check context before replying with x_posts "thread" or "search".

RESOURCES AND PROMPTS
- x://me, x://users/{username}, x://posts/{id}, x://lists/{id}, x://rate-limits and x://usage are available as MCP resources.
- Prompts draft_thread, reply_triage, account_report and summarize_conversation encode proven workflows.

MEDIA
- Posts carry media URLs, but text alone cannot see them. Call x_media with action "view" and a post id to receive the actual image (or evenly spaced video frames when ffmpeg is installed) as MCP image content.
- Use media_index for carousels; for videos without ffmpeg the tool returns the preview frame and the video URL.`;

/**
 * Creates the shared runtime (client, cache, rate limiter, media uploader) and
 * one MCP server instance. HTTP mode calls this once per session while sharing
 * the runtime, so caching and rate-limit accounting stay global.
 */
export function createRuntime(config: Config, logger: Logger, auth?: AuthManager): Runtime {
  const x = new XClient(config, logger, auth);
  const media = new MediaUploader(x, logger);
  const viewer = new MediaViewer(config, logger);
  return {
    config,
    logger,
    x,
    media,
    viewer,
    ctx: { config, logger, x, media, viewer },
  };
}

export function createServer(runtime: Runtime): ServerInstance {
  const server = new McpServer(
    { name: 'x-mcp', version: runtime.config.version },
    {
      instructions: INSTRUCTIONS,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
        logging: {},
      },
    },
  );

  const tools = registerTools(server, toolsFor(runtime.config), runtime.ctx);
  registerResources(server, runtime.ctx);
  registerPrompts(server);
  return { server, tools };
}
