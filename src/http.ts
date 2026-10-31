import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Runtime } from './server.ts';
import { createServer } from './server.ts';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 100;
const SESSION_IDLE_MS = 30 * 60_000;

interface Session {
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
  lastUsed: number;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
      (error as Error & { status?: number }).status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  if (total === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('Request body must be valid JSON.');
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export interface HttpOptions {
  host: string;
  port: number;
}

export interface RunningHttpServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Streamable HTTP transport (MCP 2025-06-18), one server instance per session
 * but a single shared runtime, so the response cache and rate-limit windows are
 * consistent across clients.
 */
export async function startHttpServer(runtime: Runtime, options: HttpOptions): Promise<RunningHttpServer> {
  const sessions = new Map<string, Session>();
  const loopback = isLoopback(options.host);
  const token = runtime.config.httpServer.token;
  const allowedOrigins = runtime.config.httpServer.corsOrigins;
  if (!loopback && !token) {
    throw new Error(
      'Refusing to bind the MCP HTTP transport to a non-loopback address without X_MCP_HTTP_TOKEN. Set a bearer token or bind to 127.0.0.1.',
    );
  }
  if (token && token.length < 16) {
    throw new Error('X_MCP_HTTP_TOKEN must be at least 16 characters.');
  }
  let actualPort = options.port;

  const http = createHttpServer(async (req, res) => {
    const origin = req.headers.origin;
    // Only configured origins receive CORS headers. Never reflect arbitrary
    // origins: a random web page must not be able to drive the MCP endpoint.
    if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
      res.setHeader('access-control-allow-origin', allowedOrigins.includes('*') ? '*' : origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type, mcp-session-id, mcp-protocol-version, authorization');
      res.setHeader('access-control-expose-headers', 'mcp-session-id, mcp-protocol-version');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/health' || url.pathname === '/') {
      jsonResponse(res, 200, {
        status: 'ok',
        name: 'x-mcp',
        version: runtime.config.version,
        transport: 'streamable-http',
        endpoint: '/mcp',
        sessions: sessions.size,
      });
      return;
    }
    if (url.pathname !== '/mcp') {
      jsonResponse(res, 404, { error: 'Not found. The MCP endpoint is /mcp.' });
      return;
    }

    if (token) {
      const provided = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        jsonResponse(res, 401, {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized: send Authorization: Bearer <X_MCP_HTTP_TOKEN>.' },
          id: null,
        });
        return;
      }
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

    try {
      if (existing) {
        existing.lastUsed = Date.now();
        const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
        await existing.transport.handleRequest(req, res, body);
        return;
      }

      if (typeof sessionId === 'string' && sessionId.length > 0) {
        jsonResponse(res, 404, {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found or expired. Re-initialize the MCP connection.' },
          id: null,
        });
        return;
      }

      if (req.method !== 'POST') {
        jsonResponse(res, 400, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'A POST with an initialize request is required to start a session.' },
          id: null,
        });
        return;
      }

      if (sessions.size >= MAX_SESSIONS) {
        jsonResponse(res, 503, {
          jsonrpc: '2.0',
          error: { code: -32000, message: `Too many active sessions (${MAX_SESSIONS}). Close idle clients or restart the server.` },
          id: null,
        });
        return;
      }

      const body = await readJsonBody(req);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, close: async () => transport.close(), lastUsed: Date.now() });
          runtime.logger.debug({ sessionId: id, sessions: sessions.size }, 'http session initialized');
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          runtime.logger.debug({ sessionId: id }, 'http session closed');
        },
        enableDnsRebindingProtection: loopback,
        ...(loopback
          ? {
              allowedHosts: [
                `127.0.0.1:${actualPort}`,
                `localhost:${actualPort}`,
                `[::1]:${actualPort}`,
                '127.0.0.1',
                'localhost',
              ],
            }
          : {}),
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
      };

      const instance = createServer(runtime);
      try {
        await instance.server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        // A failed initialize must not leak a connected server/transport.
        await instance.server.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      const status = (error as Error & { status?: number }).status ?? 500;
      runtime.logger.warn(
        { err: error instanceof Error ? error.message : String(error), path: url.pathname, method: req.method },
        'http request failed',
      );
      if (!res.headersSent) {
        jsonResponse(res, status, {
          jsonrpc: '2.0',
          error: { code: -32603, message: error instanceof Error ? error.message : 'Internal error' },
          id: null,
        });
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host, () => {
      http.off('error', reject);
      resolve();
    });
  });

  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  actualPort = port;
  const displayHost = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;
  const shown = displayHost.includes(':') ? `[${displayHost}]` : displayHost;

  const cleanup = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, session] of sessions) {
      if (session.lastUsed >= cutoff) continue;
      sessions.delete(id);
      runtime.logger.debug({ sessionId: id }, 'closing idle http session');
      void session.close().catch(() => undefined);
    }
  }, 60_000);
  cleanup.unref();

  return {
    url: `http://${shown}:${port}/mcp`,
    async close() {
      clearInterval(cleanup);
      for (const session of sessions.values()) {
        await session.close().catch(() => undefined);
      }
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
