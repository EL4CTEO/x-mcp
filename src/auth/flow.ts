import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { buildAuthorizeUrl, createPkcePair, exchangeAuthorizationCode, type TokenSet } from './oauth2.ts';
import type { Logger } from '../logger.ts';

export interface LoginOptions {
  clientId: string;
  clientSecret?: string | undefined;
  scopes: readonly string[];
  redirectUri: string;
  openBrowser?: boolean;
  manual?: boolean;
  timeoutMs?: number;
  logger: Logger;
}

export interface LoginResult {
  tokens: TokenSet;
  redirectUri: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function successPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>x-mcp authorized</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#111}
code{background:#f4f4f4;padding:.15rem .35rem;border-radius:4px}</style></head>
<body><h1>Authorization complete</h1><p>You can close this tab and return to the terminal.</p>
<p>The x-mcp server has stored your tokens and will refresh them automatically.</p></body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>x-mcp authorization failed</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1>Authorization failed</h1><p>${message.replace(/</g, '&lt;')}</p></body></html>`;
}

export function tryOpenBrowser(url: string): boolean {
  try {
    const command =
      process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function parseCodeInput(input: string, expectedState: string | undefined): string {
  const value = input.trim();
  if (!value) throw new Error('No authorization code provided.');
  let code = value;
  let state: string | null = null;
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    code = url.searchParams.get('code') ?? '';
    state = url.searchParams.get('state');
  } else if (value.includes('code=')) {
    const params = new URLSearchParams(value.replace(/^\?/, ''));
    code = params.get('code') ?? '';
    state = params.get('state');
  }
  if (!code) throw new Error('Could not find a code parameter in the pasted value.');
  if (expectedState && state && state !== expectedState) {
    throw new Error('State mismatch — the callback does not belong to this login attempt.');
  }
  return code;
}

async function promptForCode(
  authorizeUrl: string,
  expectedState: string,
  logger: Logger,
): Promise<string> {
  logger.info({}, 'manual mode: open the URL below, authorize the app, then paste the full redirected URL');
  process.stderr.write(`\n${authorizeUrl}\n\n`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question('Redirect URL (or code): ');
    return parseCodeInput(answer, expectedState);
  } finally {
    rl.close();
  }
}

function listen(server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * Runs the OAuth 2.0 Authorization Code + PKCE flow.
 *
 * Default path: loopback HTTPS-free redirect captured by a temporary local
 * server (matching http://127.0.0.1:PORT/callback registered in the X app).
 * Fallback: manual paste, for headless machines or non-loopback redirects.
 */
export async function login(options: LoginOptions): Promise<LoginResult> {
  const redirect = new URL(options.redirectUri);
  const loopback = LOOPBACK_HOSTS.has(redirect.hostname);
  const manual = options.manual === true || !loopback;
  const pkce = createPkcePair();
  const state = randomBytes(16).toString('hex');
  const authorizeUrl = buildAuthorizeUrl({
    clientId: options.clientId,
    redirectUri: options.redirectUri,
    scopes: options.scopes,
    state,
    challenge: pkce.challenge,
  });

  options.logger.info({ redirectUri: options.redirectUri, scopes: options.scopes }, 'starting OAuth 2.0 PKCE login');

  let code: string;
  if (manual) {
    if (!loopback) {
      options.logger.warn(
        { redirectUri: options.redirectUri },
        'redirect URI is not loopback; using manual code entry',
      );
    }
    code = await promptForCode(authorizeUrl, state, options.logger);
  } else {
    code = await captureLoopbackCode(authorizeUrl, options.redirectUri, state, options);
  }

  const tokens = await exchangeAuthorizationCode({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    code,
    verifier: pkce.verifier,
    redirectUri: options.redirectUri,
  });
  return { tokens, redirectUri: options.redirectUri };
}

async function captureLoopbackCode(
  authorizeUrl: string,
  redirectUri: string,
  state: string,
  options: LoginOptions,
): Promise<string> {
  const redirect = new URL(redirectUri);
  const port = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80));
  const host = redirect.hostname === '[::1]' ? '::1' : redirect.hostname;

  let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined;
  const result = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        const description = url.searchParams.get('error_description') ?? error;
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(errorPage(description));
        settle?.reject(new Error(`Authorization denied: ${description}`));
        return;
      }
      const returnedState = url.searchParams.get('state');
      const receivedCode = url.searchParams.get('code');
      if (!receivedCode) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(errorPage('The callback did not include a code.'));
        settle?.reject(new Error('The OAuth callback did not include a code.'));
        return;
      }
      if (returnedState !== state) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(errorPage('State mismatch.'));
        settle?.reject(new Error('OAuth state mismatch; aborting for safety.'));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(successPage());
      settle?.resolve(receivedCode);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Internal error');
      settle?.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

  try {
    await listen(server, port, host);
  } catch (error) {
    server.close();
    const reason = error instanceof Error ? error.message : String(error);
    options.logger.warn({ err: reason, port }, 'could not start the loopback listener; falling back to manual entry');
    return promptForCode(authorizeUrl, state, options.logger);
  }

  options.logger.info({ port }, 'waiting for the OAuth callback');
  process.stderr.write(`\nOpen this URL to authorize x-mcp:\n\n${authorizeUrl}\n\n`);
  if (options.openBrowser !== false) tryOpenBrowser(authorizeUrl);

  const timeout = options.timeoutMs ?? 5 * 60_000;
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<string>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(timeout / 1000)}s waiting for the OAuth callback.`)), timeout);
  });

  try {
    return await Promise.race([result, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
