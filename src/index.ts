#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig, loadDotEnv, VERSION, type Config } from './config.ts';
import { createLogger, type Logger } from './logger.ts';
import { createRuntime, createServer } from './server.ts';
import { startHttpServer } from './http.ts';
import { runAuthCommand } from './auth/cli.ts';
import { toolsFor } from './tools/index.ts';

const HELP = `x-mcp ${VERSION} — MCP server for the X (Twitter) API v2

USAGE
  x-mcp [serve] [options]        Start the MCP server on stdio (default)
  x-mcp serve --http [port]      Start the Streamable HTTP transport instead
  x-mcp auth --client-id <id>    Authorize with OAuth 2.0 (PKCE) and store tokens
  x-mcp auth --logout            Remove stored tokens
  x-mcp doctor [--json]          Check credentials, connectivity and configuration
  x-mcp tools [--json]           List the tools this configuration exposes
  x-mcp version | help

OPTIONS
  --http [port]         Serve over Streamable HTTP at /mcp (default port 3333)
  --host <host>         HTTP bind address (default 127.0.0.1)
  --read-only           Refuse every mutation, even if credentials allow it
  --dry-run             Show the HTTP request a mutation would send, without sending it
  --log-level <level>   trace | debug | info | warn | error | silent
  --client-id <id>      OAuth 2.0 client id for \`auth\`
  --client-secret <s>   OAuth 2.0 client secret (confidential clients only)
  --scopes <list>       Space/comma separated OAuth 2.0 scopes
  --redirect-uri <uri>  OAuth 2.0 callback (default http://127.0.0.1:8787/callback)
  --manual              Paste the callback URL instead of opening a browser
  --no-browser          Print the authorize URL without opening a browser
  --json                Machine-readable output (doctor, tools, auth)
  --help, -h            Show this help
  --version, -v         Print the version

ENVIRONMENT
  Credentials: X_BEARER_TOKEN, X_OAUTH2_CLIENT_ID, X_OAUTH2_CLIENT_SECRET,
  X_OAUTH2_ACCESS_TOKEN, X_OAUTH2_REFRESH_TOKEN, X_API_KEY, X_API_SECRET,
  X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
  Behaviour: X_MCP_READ_ONLY, X_MCP_DRY_RUN, X_MCP_CACHE, X_MCP_CACHE_TTL_MS,
  X_MCP_RATE_LIMIT_MODE, X_MCP_MAX_WAIT_MS, X_MCP_TOOLSETS,
  X_MCP_DISABLE_TOOLSETS, X_MCP_LOG_LEVEL, X_MCP_HTTP_PORT, X_MCP_HTTP_HOST
  See .env.example for the full list.

MCP CLIENT CONFIG (stdio)
  {
    "mcpServers": {
      "x": { "command": "npx", "args": ["-y", "x-mcp-server"], "env": { "X_BEARER_TOKEN": "..." } }
    }
  }
`;

interface ParsedArgs {
  command: string;
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;
    if (argument === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (argument.startsWith('--')) {
      const body = argument.slice(2);
      const equals = body.indexOf('=');
      if (equals >= 0) {
        flags.set(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags.set(body, next);
        index++;
      } else {
        flags.set(body, true);
      }
      continue;
    }
    if (argument.startsWith('-') && argument.length > 1) {
      const short = argument.slice(1);
      if (short === 'h') flags.set('help', true);
      else if (short === 'v') flags.set('version', true);
      else if (short === 'r') flags.set('read-only', true);
      else if (short === 'n') flags.set('dry-run', true);
      else flags.set(short, true);
      continue;
    }
    positional.push(argument);
  }

  return { command: positional[0] ?? 'serve', flags };
}

function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function hasFlag(flags: Map<string, string | true>, name: string): boolean {
  return flags.has(name);
}

function applyFlagOverrides(flags: Map<string, string | true>): void {
  if (hasFlag(flags, 'read-only')) process.env.X_MCP_READ_ONLY = 'true';
  if (hasFlag(flags, 'dry-run')) process.env.X_MCP_DRY_RUN = 'true';
  const logLevel = flagString(flags, 'log-level');
  if (logLevel) process.env.X_MCP_LOG_LEVEL = logLevel;
  const host = flagString(flags, 'host');
  if (host) process.env.X_MCP_HTTP_HOST = host;
  const port = flagString(flags, 'http') ?? flagString(flags, 'port');
  if (port) process.env.X_MCP_HTTP_PORT = port;
}

function output(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

async function serveStdio(config: Config, logger: Logger): Promise<void> {
  const runtime = createRuntime(config, logger);
  const { server, tools } = createServer(runtime);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info(
    {
      transport: 'stdio',
      tools: tools.length,
      readOnly: config.readOnly,
      dryRun: config.dryRun,
      auth: runtime.x.auth.status(),
    },
    'x-mcp ready',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    await server.close().catch(() => undefined);
    await runtime.x.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function serveHttp(config: Config, logger: Logger): Promise<void> {
  const runtime = createRuntime(config, logger);
  const running = await startHttpServer(runtime, {
    host: config.httpServer.host,
    port: config.httpServer.port,
  });
  const toolCount = toolsFor(config).length;
  logger.info({ transport: 'http', url: running.url, tools: toolCount }, 'x-mcp ready');
  output(`x-mcp ${VERSION} listening on ${running.url} (${toolCount} tools)`);
  output(`health check: ${running.url.replace(/\/mcp$/, '/health')}`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.httpServer.host)) {
    output('warning: binding to a non-loopback address exposes the server to the network');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    await running.close().catch(() => undefined);
    await runtime.x.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function doctor(config: Config, logger: Logger, json: boolean): Promise<number> {
  const checks: Check[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0] ?? '0');
  checks.push({
    name: 'node',
    ok: nodeMajor >= 22,
    detail: `${process.version}${nodeMajor >= 22 ? '' : ' — Node 22.18+ is required'}`,
  });

  const runtime = createRuntime(
    { ...config, http: { ...config.http, timeoutMs: 8_000, maxRetries: 0 } },
    logger,
  );
  const status = runtime.x.auth.status();
  const tools = toolsFor(config);

  checks.push({
    name: 'credentials',
    ok: status.bearer || status.oauth2 || status.oauth1,
    detail:
      [
        status.bearer ? 'app-only bearer' : undefined,
        status.oauth2 ? 'OAuth 2.0 user' : undefined,
        status.oauth1 ? 'OAuth 1.0a user' : undefined,
      ]
        .filter(Boolean)
        .join(', ') || 'none configured',
  });

  let credentialFile: Check;
  try {
    const stat = fs.statSync(config.credentialFile);
    const mode = process.platform === 'win32' ? undefined : (stat.mode & 0o777).toString(8).padStart(3, '0');
    credentialFile = {
      name: 'credential-file',
      ok: process.platform === 'win32' || mode === '600',
      detail: `${config.credentialFile}${mode ? ` (mode ${mode}${mode === '600' ? '' : ', expected 600'})` : ''}`,
    };
  } catch {
    credentialFile = {
      name: 'credential-file',
      ok: true,
      detail: `not present at ${config.credentialFile} — using environment variables only`,
    };
  }
  checks.push(credentialFile);

  checks.push({
    name: 'tools',
    ok: tools.length > 0,
    detail: `${tools.length} tools across ${new Set(tools.map((tool) => tool.toolset)).size} toolsets`,
  });

  let ffmpegDetail = 'not found — video frames fall back to preview images';
  try {
    const probe = spawnSync(config.media.ffmpegPath ?? 'ffmpeg', ['-version'], {
      stdio: 'ignore',
      timeout: 4_000,
      windowsHide: true,
    });
    if (!probe.error && probe.status === 0) {
      ffmpegDetail = `found (${config.media.ffmpegPath ?? 'ffmpeg'}) — video frame extraction enabled`;
    }
  } catch {
    // Optional dependency: probe failures are reported, not fatal.
  }
  checks.push({ name: 'ffmpeg', ok: true, detail: ffmpegDetail });

  let networkCheck: Check = { name: 'network', ok: true, detail: 'skipped (no credentials to test)' };
  if (status.oauth2 || status.oauth1 || status.bearer) {
    const startedAt = Date.now();
    try {
      if (status.oauth2 || status.oauth1) {
        await runtime.x.request({ method: 'GET', path: '/2/users/me', auth: 'user', query: { 'user.fields': 'id,username' }, cache: false });
        networkCheck = { name: 'network', ok: true, detail: `api.x.com reachable; user auth verified in ${Date.now() - startedAt}ms` };
      } else {
        await runtime.x.request({ method: 'GET', path: '/2/usage/tweets', auth: 'app', cache: false });
        networkCheck = { name: 'network', ok: true, detail: `api.x.com reachable; app-only auth verified in ${Date.now() - startedAt}ms` };
      }
    } catch (error) {
      networkCheck = {
        name: 'network',
        ok: false,
        detail: `API check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  checks.push(networkCheck);

  await runtime.x.close().catch(() => undefined);

  const ok = checks.every((check) => check.ok);
  const summary = {
    ok,
    version: VERSION,
    ...(json ? { checks, credentials: status } : {}),
  };

  if (json) {
    output(JSON.stringify(summary, null, 2));
  } else {
    output(`x-mcp ${VERSION} doctor`);
    output('');
    for (const check of checks) {
      output(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(16)} ${check.detail}`);
    }
    output('');
    output(`state: read_only=${config.readOnly} dry_run=${config.dryRun} cache=${config.cache.enabled} rate_limit=${config.rateLimit.mode}`);
    output(`api:   ${config.apiBase}`);
    const hints = runtime.x.auth.status().missing;
    if (hints.length > 0) {
      output('');
      output('next steps:');
      output('  - set X_BEARER_TOKEN for public reads');
      output('  - run `x-mcp auth --client-id <id>` for user context (posting, DMs, bookmarks)');
    }
  }
  return ok ? 0 : 1;
}

function listTools(config: Config, json: boolean): number {
  const tools = toolsFor(config);
  if (json) {
    output(
      JSON.stringify(
        tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          toolset: tool.toolset,
          readOnly: tool.annotations.readOnlyHint === true,
          destructive: tool.annotations.destructiveHint === true,
          description: tool.description,
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  output(`${tools.length} tools (${new Set(tools.map((tool) => tool.toolset)).size} toolsets)`);
  let currentToolset = '';
  for (const tool of tools) {
    if (tool.toolset !== currentToolset) {
      currentToolset = tool.toolset;
      output(`\n${currentToolset.toUpperCase()}`);
    }
    const mode = tool.annotations.readOnlyHint === true ? 'read ' : 'write';
    output(`  ${mode}  ${tool.name.padEnd(32)} ${tool.title}`);
  }
  return 0;
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (hasFlag(flags, 'help') || command === 'help') {
    output(HELP);
    return 0;
  }
  if (hasFlag(flags, 'version') || command === 'version') {
    output(VERSION);
    return 0;
  }

  loadDotEnv();
  applyFlagOverrides(flags);

  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`x-mcp: ${error instanceof ConfigError ? error.message : String(error)}\n`);
    return 1;
  }

  const logger = createLogger(config.logLevel);
  process.on('uncaughtException', (error) => {
    logger.error({ err: error.stack ?? error.message }, 'uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason instanceof Error ? reason.stack ?? reason.message : String(reason) }, 'unhandled rejection');
    process.exit(1);
  });

  switch (command) {
    case 'serve': {
      if (hasFlag(flags, 'http') || flagString(flags, 'port')) {
        await serveHttp(config, logger);
      } else {
        await serveStdio(config, logger);
      }
      return 0;
    }
    case 'doctor':
      return doctor(config, logger, hasFlag(flags, 'json'));
    case 'tools':
      return listTools(config, hasFlag(flags, 'json'));
    case 'auth': {
      return runAuthCommand({
        config,
        logger,
        clientId: flagString(flags, 'client-id'),
        clientSecret: flagString(flags, 'client-secret'),
        scopes: flagString(flags, 'scopes')?.split(/[,\s]+/).filter(Boolean),
        redirectUri: flagString(flags, 'redirect-uri'),
        manual: hasFlag(flags, 'manual'),
        openBrowser: !hasFlag(flags, 'no-browser'),
        logout: hasFlag(flags, 'logout'),
        json: hasFlag(flags, 'json'),
      });
    }
    default:
      process.stderr.write(`x-mcp: unknown command "${command}". Run \`x-mcp help\`.\n`);
      return 1;
  }
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`x-mcp: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
