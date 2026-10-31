import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  contentType: string;
  json?: unknown;
  rawBody: string;
  buffer: Buffer;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  text?: string;
  binary?: Buffer;
  headers?: Record<string, string>;
}

export type RouteHandler = (request: FakeRequest, params: Record<string, string>) => FakeResponse | Promise<FakeResponse>;

interface Route {
  method: string;
  pattern: string;
  handler: RouteHandler;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function match(pattern: string, path: string): Record<string, string> | undefined {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index++) {
    const expected = patternParts[index] as string;
    const actual = pathParts[index] as string;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return undefined;
    }
  }
  return params;
}

/**
 * Minimal programmable HTTP server that stands in for api.x.com.
 * Routes are matched in registration order; every request is recorded, which
 * lets tests assert on auth headers, query params and bodies.
 */
export class FakeXApi {
  readonly requests: FakeRequest[] = [];
  private readonly routes: Route[] = [];
  private server = createServer((request, response) => {
    void this.handle(request, response);
  });
  private port = 0;

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  on(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({ method: method.toUpperCase(), pattern, handler });
    return this;
  }

  json(method: string, pattern: string, body: unknown, status = 200, headers: Record<string, string> = {}): this {
    return this.on(method, pattern, () => ({ status, body, headers }));
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  reset(): void {
    this.requests.length = 0;
  }

  calls(method: string, pattern?: string): FakeRequest[] {
    return this.requests.filter(
      (request) => request.method === method.toUpperCase() && (pattern === undefined || request.path === pattern),
    );
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const buffer = await readBody(request);
    const url = new URL(request.url ?? '/', 'http://localhost');
    const rawBody = buffer.toString('utf8');
    const contentType = String(request.headers['content-type'] ?? '');
    let json: unknown;
    if (contentType.includes('application/json') && rawBody.length > 0) {
      try {
        json = JSON.parse(rawBody);
      } catch {
        json = undefined;
      }
    }
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) query[key] = value;
    const recorded: FakeRequest = {
      method: request.method ?? 'GET',
      path: url.pathname,
      query,
      headers: request.headers,
      contentType,
      json,
      rawBody,
      buffer,
    };
    this.requests.push(recorded);

    for (const route of this.routes) {
      if (route.method !== recorded.method) continue;
      const params = match(route.pattern, recorded.path);
      if (!params) continue;
      try {
        const result = await route.handler(recorded, params);
        const status = result.status ?? 200;
        const headers = { 'content-type': 'application/json', ...result.headers };
        response.writeHead(status, headers);
        if (result.binary) {
          response.end(result.binary);
        } else {
          response.end(result.text ?? JSON.stringify(result.body ?? {}));
        }
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ title: 'Internal Server Error', detail: String(error) }));
      }
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        title: 'Not Found',
        detail: `No fake route for ${recorded.method} ${recorded.path}`,
        type: 'about:blank',
        status: 404,
      }),
    );
  }
}
