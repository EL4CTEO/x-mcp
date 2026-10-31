import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, summarizeAuth, toolsetEnabled } from '../../src/config.ts';
import { tempHome } from '../helpers/harness.ts';

describe('configuration', () => {
  it('applies safe defaults', () => {
    const config = loadConfig({ X_MCP_HOME: tempHome() } as NodeJS.ProcessEnv);
    expect(config.apiBase).toBe('https://api.x.com');
    expect(config.readOnly).toBe(false);
    expect(config.dryRun).toBe(false);
    expect(config.cache.enabled).toBe(true);
    expect(config.cache.ttlMs).toBe(30_000);
    expect(config.rateLimit.mode).toBe('wait');
    expect(config.http.timeoutMs).toBe(20_000);
    expect(config.logLevel).toBe('info');
    expect(config.media.allowPrivateHosts).toBe(false);
    expect(config.media.maxVideoBytes).toBe(200 * 1024 * 1024);
    expect(config.media.maxImageBytes).toBe(15 * 1024 * 1024);
    expect(config.media.frameWidth).toBe(1_280);
    expect(config.media.roots.length).toBeGreaterThan(0);
    expect(config.credentialFile.endsWith('credentials.json')).toBe(true);
  });

  it('parses booleans, numbers, bases and credentials', () => {
    const config = loadConfig({
      X_MCP_HOME: tempHome(),
      X_MCP_READ_ONLY: '1',
      X_MCP_DRY_RUN: 'yes',
      X_MCP_CACHE: 'off',
      X_MCP_CACHE_TTL_MS: '5000',
      X_MCP_MAX_RETRIES: '3',
      X_MCP_RATE_LIMIT_MODE: 'fail',
      X_API_BASE: 'https://api.example.com/',
      X_BEARER_TOKEN: ' bearer ',
      X_OAUTH2_CLIENT_ID: 'client',
      X_OAUTH2_ACCESS_TOKEN: 'token',
      X_OAUTH2_SCOPE: 'tweet.read, tweet.write',
      X_API_KEY: 'key',
      X_API_SECRET: 'secret',
      X_ACCESS_TOKEN: 'access',
      X_ACCESS_TOKEN_SECRET: 'access-secret',
    } as NodeJS.ProcessEnv);
    expect(config.readOnly).toBe(true);
    expect(config.dryRun).toBe(true);
    expect(config.cache.enabled).toBe(false);
    expect(config.cache.ttlMs).toBe(5_000);
    expect(config.http.maxRetries).toBe(3);
    expect(config.rateLimit.mode).toBe('fail');
    expect(config.apiBase).toBe('https://api.example.com');
    expect(config.auth.bearerToken).toBe('bearer');
    expect(config.auth.oauth2?.scopes).toEqual(['tweet.read', 'tweet.write']);
    expect(summarizeAuth(config)).toMatchObject({
      appOnly: true,
      userOAuth2: true,
      userOAuth1: true,
      canWrite: true,
      canUploadMedia: true,
    });
  });

  it('rejects invalid values with actionable errors', () => {
    expect(() => loadConfig({ X_MCP_READ_ONLY: 'maybe' } as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => loadConfig({ X_MCP_LOG_LEVEL: 'loud' } as NodeJS.ProcessEnv)).toThrow(/X_MCP_LOG_LEVEL/);
    expect(() => loadConfig({ X_MCP_RATE_LIMIT_MODE: 'block' } as NodeJS.ProcessEnv)).toThrow(/wait/);
    expect(() => loadConfig({ X_API_BASE: 'not a url' } as NodeJS.ProcessEnv)).toThrow(/valid URL/);
    expect(() => loadConfig({ X_MCP_CACHE_MAX: '0' } as NodeJS.ProcessEnv)).toThrow(/between 1 and 100000/);
    expect(() => loadConfig({ X_MCP_TOOLSETS: 'posts,nope' } as NodeJS.ProcessEnv)).toThrow(/unknown toolset/);
  });

  it('filters toolsets by include and exclude lists', () => {
    const include = loadConfig({ X_MCP_TOOLSETS: 'posts, meta' } as NodeJS.ProcessEnv);
    expect(toolsetEnabled(include, 'posts')).toBe(true);
    expect(toolsetEnabled(include, 'meta')).toBe(true);
    expect(toolsetEnabled(include, 'dms')).toBe(false);

    const exclude = loadConfig({ X_MCP_DISABLE_TOOLSETS: 'dms,media' } as NodeJS.ProcessEnv);
    expect(toolsetEnabled(exclude, 'dms')).toBe(false);
    expect(toolsetEnabled(exclude, 'media')).toBe(false);
    expect(toolsetEnabled(exclude, 'posts')).toBe(true);
  });

  it('reports missing credentials without failing to load', () => {
    const config = loadConfig({ X_MCP_HOME: tempHome() } as NodeJS.ProcessEnv);
    const summary = summarizeAuth(config);
    expect(summary.modes).toEqual([]);
    expect(summary.canWrite).toBe(false);
  });
});
