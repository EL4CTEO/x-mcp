import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Config, Toolset } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { XClient } from '../x/client.ts';
import type { MediaUploader } from '../x/media.ts';
import type { MediaViewer } from '../x/viewer.ts';
import { XApiError, XNetworkError } from '../x/errors.ts';
import { AuthError } from '../auth/errors.ts';

export interface ToolContext {
  config: Config;
  x: XClient;
  media: MediaUploader;
  viewer: MediaViewer;
  logger: Logger;
}

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Tool arguments are validated against each action's Zod schema before the
 * handler runs. Grouped tools expose one `action` plus a union of every field
 * used by their actions; the adapter re-parses with the exact action schema, so
 * defaults, ranges and enums stay precise.
 */
export type ToolArgs = Record<string, any>;

export interface ActionTool {
  /** Verb used inside the group, e.g. "create" for x_posts. */
  action: string;
  /** Internal unique operation name, e.g. x_post (used in docs/tests). */
  name: string;
  title: string;
  description: string;
  toolset: Toolset;
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
  handler: (args: ToolArgs, ctx: ToolContext, extra: ToolExtra) => Promise<unknown>;
}

export interface ToolGroup {
  name: string;
  title: string;
  description: string;
  toolset: Toolset;
  actions: ActionTool[];
  inputSchema: z.ZodRawShape;
  annotations: ToolAnnotations;
}

export interface RegisteredToolDefinition {
  name: string;
  toolset: Toolset;
  title: string;
  readOnly: boolean;
  actionCount: number;
}

/**
 * A tool action can return rich MCP content (images, links) alongside its
 * structured JSON. The adapter prepends a text summary so text-only clients
 * still receive the metadata.
 */
export interface RichToolOutput {
  content: CallToolResult['content'];
  structuredContent?: Record<string, unknown>;
}

export function isRichOutput(value: unknown): value is RichToolOutput {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as RichToolOutput).content) &&
    'content' in (value as object)
  );
}

const TRUNCATION_NOTICE = (omitted: number) => `\n\n… [output truncated: ${omitted} more characters]`;

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + TRUNCATION_NOTICE(text.length - maxChars);
}

export function structuredContent(output: unknown): Record<string, unknown> {
  if (Array.isArray(output)) return { items: output };
  if (output !== null && typeof output === 'object') return output as Record<string, unknown>;
  return { result: output };
}

export function okResult(output: unknown, config: Config): CallToolResult {
  const text = truncate(JSON.stringify(output, null, 2), config.maxOutputChars);
  return {
    content: [{ type: 'text', text }],
    structuredContent: structuredContent(output),
  };
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof AuthError) return error.toJSON();
  if (error instanceof XApiError) return error.toJSON();
  if (error instanceof XNetworkError) {
    return {
      error: error.message,
      retryable: error.retryable,
      hint: 'Check network connectivity and the X API base URL. Transient failures can be retried.',
    };
  }
  if (error instanceof z.ZodError) {
    return {
      error: error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; '),
      code: 'invalid_params',
      hint: 'Check the action documentation and parameter types.',
    };
  }
  if (typeof error === 'object' && error !== null && !(error instanceof Error)) {
    return error as Record<string, unknown>;
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

export function errorResult(error: unknown, config: Config): CallToolResult {
  const payload = errorPayload(error);
  return {
    isError: true,
    content: [{ type: 'text', text: truncate(JSON.stringify(payload, null, 2), config.maxOutputChars) }],
    structuredContent: payload,
  };
}

function isAbort(error: unknown, extra: ToolExtra): boolean {
  if (extra.signal?.aborted) return true;
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function renderOutput(output: unknown, config: Config): CallToolResult {
  if (isRichOutput(output)) {
    const structured = output.structuredContent ?? {};
    return {
      content: [
        { type: 'text', text: truncate(JSON.stringify(structured, null, 2), config.maxOutputChars) },
        ...output.content,
      ],
      structuredContent: structured,
    };
  }
  return okResult(output, config);
}

/**
 * Executes one action of a group: per-action guardrails, validation, dispatch,
 * dry-run previews and consistent error mapping.
 */
export async function runAction(
  group: ToolGroup,
  action: ActionTool,
  args: ToolArgs,
  ctx: ToolContext,
  extra: ToolExtra,
): Promise<CallToolResult> {
  const startedAt = Date.now();
  const isWrite = action.annotations.readOnlyHint !== true;

  if (isWrite && ctx.config.readOnly) {
    return errorResult(
      {
        error: 'Server is in read-only mode (X_MCP_READ_ONLY=true).',
        code: 'read_only',
        hint: 'Restart without X_MCP_READ_ONLY to allow mutations.',
      },
      ctx.config,
    );
  }

  let parsed: ToolArgs;
  try {
    parsed = z.object(action.inputSchema).parse(args) as ToolArgs;
  } catch (error) {
    return errorResult(
      {
        error: `Invalid parameters for action "${action.action}": ${error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; ') : String(error)}`,
        code: 'invalid_params',
        hint: `Call ${group.name} with action "${action.action}" and its documented parameters.`,
      },
      ctx.config,
    );
  }

  if (isWrite && ctx.config.dryRun) {
    const start = ctx.x.auditLength();
    try {
      await action.handler(parsed, ctx, extra);
    } catch (error) {
      if (isAbort(error, extra)) return errorResult(error, ctx.config);
      ctx.logger.debug(
        { tool: group.name, action: action.action, err: String(error) },
        'dry-run action stopped early',
      );
    }
    return okResult(
      {
        dry_run: true,
        tool: `${group.name}#${action.action}`,
        note: 'No request was sent. These are the HTTP calls the action would make.',
        requests: ctx.x.auditSince(start),
      },
      ctx.config,
    );
  }

  try {
    const output = await action.handler(parsed, ctx, extra);
    ctx.logger.debug(
      { tool: group.name, action: action.action, durationMs: Date.now() - startedAt },
      'action completed',
    );
    return renderOutput(output, ctx.config);
  } catch (error) {
    if (isAbort(error, extra)) {
      return errorResult({ error: 'Request cancelled.', code: 'cancelled' }, ctx.config);
    }
    ctx.logger.warn(
      {
        tool: group.name,
        action: action.action,
        err: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      },
      'action failed',
    );
    return errorResult(error, ctx.config);
  }
}

export function registerToolGroup(server: McpServer, group: ToolGroup, ctx: ToolContext): void {
  const byAction = new Map(group.actions.map((action) => [action.action, action]));

  server.registerTool(
    group.name,
    {
      title: group.title,
      description: group.description,
      inputSchema: group.inputSchema,
      annotations: group.annotations,
      _meta: {
        'x-mcp/actions': Object.fromEntries(
          group.actions.map((action) => [
            action.action,
            {
              readOnly: action.annotations.readOnlyHint === true,
              destructive: action.annotations.destructiveHint === true,
              idempotent: action.annotations.idempotentHint === true,
            },
          ]),
        ),
      },
    },
    async (args, extra): Promise<CallToolResult> => {
      const requested = typeof args.action === 'string' ? args.action : '';
      const action = byAction.get(requested);
      if (!action) {
        return errorResult(
          {
            error: `Unknown action "${requested}" for ${group.name}.`,
            code: 'invalid_action',
            hint: `Valid actions: ${[...byAction.keys()].join(', ')}.`,
          },
          ctx.config,
        );
      }
      return runAction(group, action, args, ctx, extra);
    },
  );
}

export function registerToolGroups(
  server: McpServer,
  groups: ToolGroup[],
  ctx: ToolContext,
): RegisteredToolDefinition[] {
  const registered: RegisteredToolDefinition[] = [];
  for (const group of groups) {
    registerToolGroup(server, group, ctx);
    registered.push({
      name: group.name,
      toolset: group.toolset,
      title: group.title,
      readOnly: group.annotations.readOnlyHint === true,
      actionCount: group.actions.length,
    });
  }
  return registered;
}

/** Bridges action execution to MCP progress notifications when the client asked. */
export function progressReporter(extra: ToolExtra): ((progress: number, total?: number, message?: string) => void) | undefined {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  return (progress, total, message) => {
    void extra
      .sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress,
          ...(total !== undefined ? { total } : {}),
          ...(message ? { message } : {}),
        },
      })
      .catch(() => undefined);
  };
}
