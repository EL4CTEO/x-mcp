import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FakeXApi } from '../helpers/fake-x.ts';
import { cleanupTempHomes, testConfig } from '../helpers/harness.ts';
import { createLogger } from '../../src/logger.ts';
import { createRuntime } from '../../src/server.ts';
import { startHttpServer, type RunningHttpServer } from '../../src/http.ts';

const user = { id: '7', username: 'bob', name: 'Bob' };
const post = {
  id: '100',
  text: 'over http',
  author_id: '7',
  created_at: '2026-01-02T03:04:05.000Z',
  public_metrics: { like_count: 1 },
};

let fake: FakeXApi;
let running: RunningHttpServer;
let runtime: ReturnType<typeof createRuntime>;
let client: Client;

beforeAll(async () => {
  fake = await new FakeXApi().start();
  fake.json('GET', '/2/tweets/100', { data: post, includes: { users: [user] } });
  fake.json('GET', '/2/users/me', { data: user });

  runtime = createRuntime(testConfig({ apiBase: fake.baseUrl }), createLogger('silent'));
  running = await startHttpServer(runtime, { host: '127.0.0.1', port: 0 });

  client = new Client({ name: 'http-test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(running.url)));
});

afterAll(async () => {
  await client.close().catch(() => undefined);
  await running.close().catch(() => undefined);
  await runtime.x.close().catch(() => undefined);
  await fake.stop();
  cleanupTempHomes();
});

describe('Streamable HTTP transport', () => {
  it('serves a health endpoint', async () => {
    const response = await fetch(running.url.replace(/\/mcp$/, '/health'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'ok', name: 'x-mcp', endpoint: '/mcp' });
  });

  it('initializes a session and lists tools', async () => {
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(10);
    expect(tools.tools.some((tool) => tool.name === 'x_posts')).toBe(true);
  });

  it('executes tools over HTTP end to end', async () => {
    const result = (await client.callTool({ name: 'x_posts', arguments: { action: 'get', tweet_id: '100' } })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    expect(result.isError).not.toBe(true);
    const text = result.content?.find((item) => item.type === 'text')?.text ?? '';
    expect(JSON.parse(text)).toMatchObject({
      id: '100',
      text: 'over http',
      author: { username: 'bob' },
    });
  });

  it('rejects unknown routes with a clear error', async () => {
    const response = await fetch(running.url.replace(/\/mcp$/, '/nope'));
    expect(response.status).toBe(404);
  });

  it('requires the configured bearer token on /mcp', async () => {
    const securedRuntime = createRuntime(
      testConfig({ apiBase: fake.baseUrl, httpToken: '0123456789abcdef' }),
      createLogger('silent'),
    );
    const secured = await startHttpServer(securedRuntime, { host: '127.0.0.1', port: 0 });
    try {
      const unauthorized = await fetch(secured.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(unauthorized.status).toBe(401);

      const authorized = await fetch(secured.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer 0123456789abcdef' },
        body: '{}',
      });
      expect(authorized.status).not.toBe(401);
    } finally {
      await secured.close();
      await securedRuntime.x.close();
    }
  });
});
