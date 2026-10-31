import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { createLogger } from '../../src/logger.ts';
import { AuthManager } from '../../src/auth/manager.ts';
import { AuthError } from '../../src/auth/errors.ts';
import { tempHome } from '../helpers/harness.ts';

const logger = createLogger('silent');

function writeCredentials(home: string, oauth2: Record<string, unknown>): string {
  const file = path.join(home, 'credentials.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, oauth2 }));
  return file;
}

describe('AuthManager token lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refreshes an expired token once, persists the rotated tokens and reuses them', async () => {
    const home = tempHome();
    const file = writeCredentials(home, {
      clientId: 'stored-client',
      accessToken: 'expired-token',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() - 1_000,
      scopes: ['tweet.read'],
    });
    const config = loadConfig({ X_MCP_HOME: home } as NodeJS.ProcessEnv);
    const manager = new AuthManager(config, logger);

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: 'fresh-token',
          token_type: 'bearer',
          expires_in: 7_200,
          refresh_token: 'refresh-2',
          scope: 'tweet.read offline.access',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(manager.getOAuth2AccessToken()).resolves.toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(stored.oauth2.accessToken).toBe('fresh-token');
    expect(stored.oauth2.refreshToken).toBe('refresh-2');
    expect(stored.oauth2.expiresAt).toBeGreaterThan(Date.now());

    // Second call uses the in-memory token: no further refresh.
    await expect(manager.getOAuth2AccessToken()).resolves.toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('persists rotated refresh tokens for environment-only sessions', async () => {
    const home = tempHome();
    const config = loadConfig({
      X_MCP_HOME: home,
      X_OAUTH2_CLIENT_ID: 'client',
      X_OAUTH2_ACCESS_TOKEN: 'env-access',
      X_OAUTH2_REFRESH_TOKEN: 'env-refresh',
    } as NodeJS.ProcessEnv);
    const manager = new AuthManager(config, logger);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ access_token: 'rotated', refresh_token: 'rotated-refresh', expires_in: 7_200 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await expect(manager.getOAuth2AccessToken({ forceRefresh: true })).resolves.toBe('rotated');
    const stored = JSON.parse(fs.readFileSync(config.credentialFile, 'utf8'));
    expect(stored.oauth2.accessToken).toBe('rotated');
    expect(stored.oauth2.refreshToken).toBe('rotated-refresh');
  });

  it('shares one refresh across concurrent callers', async () => {
    const home = tempHome();
    writeCredentials(home, {
      clientId: 'stored-client',
      accessToken: 'expired',
      refreshToken: 'refresh-1',
      expiresAt: Date.now() - 1_000,
    });
    const manager = new AuthManager(loadConfig({ X_MCP_HOME: home } as NodeJS.ProcessEnv), logger);
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return new Response(JSON.stringify({ access_token: 'shared', expires_in: 7_200 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const tokens = await Promise.all([
      manager.getOAuth2AccessToken(),
      manager.getOAuth2AccessToken(),
      manager.getOAuth2AccessToken(),
    ]);
    expect(tokens).toEqual(['shared', 'shared', 'shared']);
    expect(calls).toBe(1);
  });

  it('maps refresh failures to an AuthError with a recovery hint', async () => {
    const home = tempHome();
    writeCredentials(home, {
      clientId: 'stored-client',
      accessToken: 'expired',
      refreshToken: 'revoked',
      expiresAt: Date.now() - 1_000,
    });
    const manager = new AuthManager(loadConfig({ X_MCP_HOME: home } as NodeJS.ProcessEnv), logger);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })),
    );
    const error = await manager.getOAuth2AccessToken().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe('refresh_failed');
    expect((error as AuthError).hint).toContain('refresh token');
  });

  it('mints an access token when only a refresh token is configured', async () => {
    const home = tempHome();
    const manager = new AuthManager(
      loadConfig({
        X_MCP_HOME: home,
        X_OAUTH2_CLIENT_ID: 'client',
        X_OAUTH2_REFRESH_TOKEN: 'refresh-only',
      } as NodeJS.ProcessEnv),
      logger,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ access_token: 'minted', expires_in: 7_200 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await expect(manager.getOAuth2AccessToken()).resolves.toBe('minted');
  });

  it('refuses user-context requests without user credentials', () => {
    const manager = new AuthManager(loadConfig({ X_MCP_HOME: tempHome() } as NodeJS.ProcessEnv), logger);
    expect(manager.hasUserAuth).toBe(false);
    expect(() => manager.assertUserAuth()).toThrow(AuthError);
    expect(() => manager.oauth1Credentials()).toThrow(/incomplete/);
  });

  it('prefers environment tokens over stored ones', () => {
    const home = tempHome();
    writeCredentials(home, { clientId: 'stored-client', accessToken: 'stored-token', refreshToken: 'r' });
    const manager = new AuthManager(
      loadConfig({ X_MCP_HOME: home, X_OAUTH2_ACCESS_TOKEN: 'env-token', X_OAUTH2_CLIENT_ID: 'env-client' } as NodeJS.ProcessEnv),
      logger,
    );
    expect(manager.status().oauth2Source).toBe('env');
  });
});
