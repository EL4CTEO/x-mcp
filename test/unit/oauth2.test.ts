import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  refreshAccessToken,
} from '../../src/auth/oauth2.ts';

async function withTokenServer(
  response: { status?: number; body: unknown },
  run: (url: string, captured: { body?: string; authorization?: string }) => Promise<void>,
): Promise<void> {
  const captured: { body?: string; authorization?: string } = {};
  const server: Server = createServer((request, reply) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('end', () => {
      captured.body = Buffer.concat(chunks).toString('utf8');
      captured.authorization = request.headers.authorization;
      reply.writeHead(response.status ?? 200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const port = (server.address() as AddressInfo).port;
    await run(`http://127.0.0.1:${port}/token`, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('OAuth 2.0 PKCE', () => {
  it('derives the RFC 7636 challenge', () => {
    const pair = createPkcePair('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(pair.challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(pair.method).toBe('S256');
    expect(createPkcePair().verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('builds an authorize URL with all required parameters', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:8787/callback',
        scopes: ['tweet.read', 'tweet.write', 'offline.access'],
        state: 'state-1',
        challenge: 'challenge-1',
      }),
    );
    expect(url.origin).toBe('https://api.x.com');
    expect(url.pathname).toBe('/2/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('scope')).toBe('tweet.read tweet.write offline.access');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-1');
  });

  it('exchanges a code using HTTP Basic auth for confidential clients', async () => {
    await withTokenServer(
      { body: { access_token: 'new-token', token_type: 'bearer', expires_in: 7200, refresh_token: 'refresh-1', scope: 'tweet.read offline.access' } },
      async (tokenUrl, captured) => {
        const tokens = await exchangeAuthorizationCode({
          clientId: 'client-1',
          clientSecret: 'secret-1',
          code: 'code-1',
          verifier: 'verifier-1',
          redirectUri: 'http://127.0.0.1:8787/callback',
          tokenUrl,
        });
        expect(tokens.accessToken).toBe('new-token');
        expect(tokens.refreshToken).toBe('refresh-1');
        expect(tokens.expiresIn).toBe(7200);
        expect(tokens.scope).toEqual(['tweet.read', 'offline.access']);
        const body = new URLSearchParams(captured.body);
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('code')).toBe('code-1');
        expect(body.get('code_verifier')).toBe('verifier-1');
        expect(captured.authorization).toBe(`Basic ${Buffer.from('client-1:secret-1').toString('base64')}`);
      },
    );
  });

  it('uses client_id in the body for public clients and refreshes tokens', async () => {
    await withTokenServer({ body: { access_token: 'refreshed', expires_in: 7200 } }, async (tokenUrl, captured) => {
      const tokens = await refreshAccessToken({ clientId: 'public-client', refreshToken: 'refresh-1', tokenUrl });
      expect(tokens.accessToken).toBe('refreshed');
      const body = new URLSearchParams(captured.body);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('client_id')).toBe('public-client');
      expect(captured.authorization).toBeUndefined();
    });
  });

  it('surfaces token endpoint failures with status and body', async () => {
    await withTokenServer({ status: 400, body: { error: 'invalid_grant' } }, async (tokenUrl) => {
      await expect(
        refreshAccessToken({ clientId: 'public-client', refreshToken: 'nope', tokenUrl }),
      ).rejects.toMatchObject({ name: 'OAuth2Error', status: 400 });
    });
  });
});
