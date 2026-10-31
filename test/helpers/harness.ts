import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig, type Config } from '../../src/config.ts';
import { createLogger } from '../../src/logger.ts';
import { createRuntime, createServer, type Runtime } from '../../src/server.ts';
import type { RegisteredToolDefinition } from '../../src/tools/define.ts';

const tempDirs: string[] = [];

export function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-mcp-test-'));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempHomes(): void {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface TestConfigOptions {
  apiBase?: string;
  bearer?: string | null;
  oauth2?: boolean;
  oauth1?: boolean;
  readOnly?: boolean;
  dryRun?: boolean;
  cache?: boolean;
  cacheTtlMs?: number;
  rateLimitMode?: 'wait' | 'fail';
  maxRetries?: number;
  toolsets?: string;
  disableToolsets?: string;
  allowPrivateMedia?: boolean;
}

export function testConfig(options: TestConfigOptions = {}): Config {
  const env: NodeJS.ProcessEnv = {
    X_MCP_HOME: tempHome(),
    X_MCP_LOG_LEVEL: 'silent',
    X_MCP_MAX_RETRIES: String(options.maxRetries ?? 0),
    X_MCP_CACHE: options.cache === false ? 'off' : 'on',
    X_MCP_CACHE_TTL_MS: String(options.cacheTtlMs ?? 30_000),
    X_MCP_RATE_LIMIT_MODE: options.rateLimitMode ?? 'fail',
    X_MCP_TIMEOUT_MS: '5000',
  };
  if (options.apiBase) {
    env.X_API_BASE = options.apiBase;
    env.X_UPLOAD_BASE = options.apiBase;
  }
  if (options.bearer !== null) env.X_BEARER_TOKEN = options.bearer ?? 'test-bearer-token';
  if (options.oauth2 !== false) {
    env.X_OAUTH2_CLIENT_ID = 'test-client-id';
    env.X_OAUTH2_ACCESS_TOKEN = 'test-user-token';
    env.X_OAUTH2_SCOPE = 'tweet.read tweet.write users.read offline.access';
  }
  if (options.oauth1) {
    env.X_API_KEY = 'consumer-key';
    env.X_API_SECRET = 'consumer-secret';
    env.X_ACCESS_TOKEN = 'access-token';
    env.X_ACCESS_TOKEN_SECRET = 'access-token-secret';
  }
  if (options.readOnly) env.X_MCP_READ_ONLY = 'true';
  if (options.dryRun) env.X_MCP_DRY_RUN = 'true';
  if (options.allowPrivateMedia) env.X_MCP_MEDIA_ALLOW_PRIVATE = 'true';
  if (options.toolsets) env.X_MCP_TOOLSETS = options.toolsets;
  if (options.disableToolsets) env.X_MCP_DISABLE_TOOLSETS = options.disableToolsets;
  return loadConfig(env);
}

export interface ToolCall {
  isError: boolean;
  text: string;
  json: any;
  structured: Record<string, unknown> | undefined;
  raw: unknown;
}

export interface Harness {
  client: Client;
  server: ReturnType<typeof createServer>['server'];
  runtime: Runtime;
  tools: RegisteredToolDefinition[];
  call(name: string, args?: Record<string, unknown>): Promise<ToolCall>;
  close(): Promise<void>;
}

/** Connects a real MCP client to the real server over the in-memory transport. */
export async function createHarness(config: Config): Promise<Harness> {
  const logger = createLogger('silent');
  const runtime = createRuntime(config, logger);
  const { server, tools } = createServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'x-mcp-test-client', version: '1.0.0' });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    server,
    runtime,
    tools,
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: Record<string, unknown>;
      };
      const text = (result.content ?? [])
        .map((item) => (item.type === 'text' ? item.text ?? '' : ''))
        .join('\n');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return {
        isError: result.isError === true,
        text,
        json,
        structured: result.structuredContent,
        raw: result,
      };
    },
    async close() {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await runtime.x.close().catch(() => undefined);
    },
  };
}
