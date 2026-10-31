/**
 * Configuration is loaded once at startup from environment variables.
 *
 * Design notes:
 * - Missing credentials never throw: the server must still boot so `doctor`,
 *   `--dry-run` and read-only tool discovery keep working. Tools that need a
 *   credential fail with an actionable message instead.
 * - Invalid values do throw, because silently ignoring a typo in
 *   `X_MCP_READ_ONLY` would be a safety problem.
 */
import os from 'node:os';
import path from 'node:path';

export const VERSION = '1.0.0';

export const TOOLSETS = [
  'posts',
  'timelines',
  'users',
  'engagement',
  'lists',
  'spaces',
  'trends',
  'dms',
  'media',
  'meta',
] as const;
export type Toolset = (typeof TOOLSETS)[number];

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type RateLimitMode = 'wait' | 'fail';

export interface OAuth2Credentials {
  clientId: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  scopes?: string[];
  redirectUri?: string;
}

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken?: string;
  accessTokenSecret?: string;
}

export interface AuthConfig {
  bearerToken?: string;
  oauth2?: OAuth2Credentials;
  oauth1?: OAuth1Credentials;
}

export interface CacheConfig {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
}

export interface HttpConfig {
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  userAgent: string;
  proxy?: string;
}

export interface RateLimitConfig {
  mode: RateLimitMode;
  maxWaitMs: number;
}

export interface MediaConfig {
  ffmpegPath?: string;
  maxVideoBytes: number;
  maxImageBytes: number;
  frameWidth: number;
  /** Test-only: permits http:// and private hosts for media downloads. */
  allowPrivateHosts: boolean;
}

export interface Config {
  version: string;
  homeDir: string;
  credentialFile: string;
  apiBase: string;
  uploadBase: string;
  auth: AuthConfig;
  readOnly: boolean;
  dryRun: boolean;
  cache: CacheConfig;
  http: HttpConfig;
  rateLimit: RateLimitConfig;
  media: MediaConfig;
  toolsets: { include: Toolset[]; exclude: Toolset[] };
  maxOutputChars: number;
  logLevel: LogLevel;
  httpServer: { host: string; port: number };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'silent'];

function str(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = str(env, name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${name} must be a boolean (true/false), got "${raw}"`);
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function baseUrl(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = str(env, name) ?? fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be a valid URL, got "${raw}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`${name} must use http(s), got "${raw}"`);
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function toolsetList(env: NodeJS.ProcessEnv, name: string): Toolset[] {
  const raw = str(env, name);
  if (raw === undefined) return [];
  const parts = raw
    .split(/[,;\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const unknown = parts.filter((part) => !(TOOLSETS as readonly string[]).includes(part));
  if (unknown.length > 0) {
    throw new ConfigError(
      `${name} contains unknown toolset(s): ${unknown.join(', ')}. Valid: ${TOOLSETS.join(', ')}`,
    );
  }
  return [...new Set(parts)] as Toolset[];
}

function scopes(env: NodeJS.ProcessEnv): string[] | undefined {
  const raw = str(env, 'X_OAUTH2_SCOPE');
  if (raw === undefined) return undefined;
  return [...new Set(raw.split(/[,\s]+/).filter(Boolean))];
}

function credentialFile(env: NodeJS.ProcessEnv): { homeDir: string; file: string } {
  const homeDir = str(env, 'X_MCP_HOME') ?? path.join(os.homedir(), '.config', 'x-mcp');
  return { homeDir, file: path.join(homeDir, 'credentials.json') };
}

/**
 * Reads a local `.env` file when present (Node 20.6+ native support) without
 * pulling in a dotenv dependency. Existing environment variables always win.
 */
export function loadDotEnv(file = '.env'): void {
  if (typeof process.loadEnvFile !== 'function') return;
  try {
    process.loadEnvFile(file);
  } catch {
    // No .env file or unreadable: environment-only configuration is fine.
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const { homeDir, file } = credentialFile(env);

  const bearerToken = str(env, 'X_BEARER_TOKEN');
  const oauth2ClientId = str(env, 'X_OAUTH2_CLIENT_ID');
  const oauth2: OAuth2Credentials | undefined = oauth2ClientId
    ? {
        clientId: oauth2ClientId,
        clientSecret: str(env, 'X_OAUTH2_CLIENT_SECRET'),
        accessToken: str(env, 'X_OAUTH2_ACCESS_TOKEN'),
        refreshToken: str(env, 'X_OAUTH2_REFRESH_TOKEN'),
        scopes: scopes(env),
        redirectUri: str(env, 'X_OAUTH2_REDIRECT_URI'),
      }
    : undefined;

  const consumerKey = str(env, 'X_API_KEY');
  const oauth1: OAuth1Credentials | undefined = consumerKey
    ? {
        consumerKey,
        consumerSecret: str(env, 'X_API_SECRET') ?? '',
        accessToken: str(env, 'X_ACCESS_TOKEN'),
        accessTokenSecret: str(env, 'X_ACCESS_TOKEN_SECRET'),
      }
    : undefined;

  const logLevelRaw = (str(env, 'X_MCP_LOG_LEVEL') ?? 'info').toLowerCase();
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) {
    throw new ConfigError(
      `X_MCP_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${logLevelRaw}"`,
    );
  }
  const logLevel = logLevelRaw as LogLevel;

  const rateLimitModeRaw = (str(env, 'X_MCP_RATE_LIMIT_MODE') ?? 'wait').toLowerCase();
  if (rateLimitModeRaw !== 'wait' && rateLimitModeRaw !== 'fail') {
    throw new ConfigError(`X_MCP_RATE_LIMIT_MODE must be "wait" or "fail", got "${rateLimitModeRaw}"`);
  }

  return {
    version: VERSION,
    homeDir,
    credentialFile: file,
    apiBase: baseUrl(env, 'X_API_BASE', 'https://api.x.com'),
    uploadBase: baseUrl(env, 'X_UPLOAD_BASE', 'https://api.x.com'),
    auth: { bearerToken, oauth2, oauth1 },
    readOnly: bool(env, 'X_MCP_READ_ONLY', false),
    dryRun: bool(env, 'X_MCP_DRY_RUN', false),
    cache: {
      enabled: bool(env, 'X_MCP_CACHE', true),
      ttlMs: int(env, 'X_MCP_CACHE_TTL_MS', 30_000, 0, 3_600_000),
      maxEntries: int(env, 'X_MCP_CACHE_MAX', 512, 1, 100_000),
    },
    http: {
      timeoutMs: int(env, 'X_MCP_TIMEOUT_MS', 20_000, 1_000, 300_000),
      maxRetries: int(env, 'X_MCP_MAX_RETRIES', 2, 0, 10),
      retryBaseMs: int(env, 'X_MCP_RETRY_BASE_MS', 400, 0, 30_000),
      userAgent: `x-mcp-server/${VERSION} (Node.js; +https://github.com/x-mcp-server)`,
      proxy: str(env, 'HTTPS_PROXY') ?? str(env, 'https_proxy') ?? str(env, 'ALL_PROXY') ?? str(env, 'all_proxy'),
    },
    rateLimit: {
      mode: rateLimitModeRaw,
      maxWaitMs: int(env, 'X_MCP_MAX_WAIT_MS', 60_000, 0, 15 * 60_000),
    },
    media: {
      ffmpegPath: str(env, 'X_MCP_FFMPEG'),
      maxVideoBytes: int(env, 'X_MCP_MAX_VIDEO_MB', 200, 1, 8_192) * 1024 * 1024,
      maxImageBytes: int(env, 'X_MCP_MAX_IMAGE_MB', 15, 1, 100) * 1024 * 1024,
      frameWidth: int(env, 'X_MCP_FRAME_WIDTH', 1_280, 160, 4_096),
      allowPrivateHosts: bool(env, 'X_MCP_MEDIA_ALLOW_PRIVATE', false),
    },
    toolsets: {
      include: toolsetList(env, 'X_MCP_TOOLSETS'),
      exclude: toolsetList(env, 'X_MCP_DISABLE_TOOLSETS'),
    },
    maxOutputChars: int(env, 'X_MCP_MAX_OUTPUT_CHARS', 60_000, 2_000, 5_000_000),
    logLevel,
    httpServer: {
      host: str(env, 'X_MCP_HTTP_HOST') ?? '127.0.0.1',
      port: int(env, 'X_MCP_HTTP_PORT', 3333, 0, 65_535),
    },
  };
}

export interface AuthSummary {
  appOnly: boolean;
  userOAuth2: boolean;
  userOAuth1: boolean;
  canWrite: boolean;
  canReadPrivate: boolean;
  canUploadMedia: boolean;
  modes: string[];
}

export function summarizeAuth(config: Config): AuthSummary {
  const appOnly = Boolean(config.auth.bearerToken);
  const oauth2 = Boolean(config.auth.oauth2?.accessToken || config.auth.oauth2?.refreshToken);
  const oauth1 = Boolean(
    config.auth.oauth1?.accessToken &&
      config.auth.oauth1?.accessTokenSecret &&
      config.auth.oauth1.consumerSecret,
  );
  const modes: string[] = [];
  if (appOnly) modes.push('app-only bearer');
  if (oauth2) modes.push('OAuth 2.0 user');
  if (oauth1) modes.push('OAuth 1.0a user');  return {
    appOnly,
    userOAuth2: oauth2,
    userOAuth1: oauth1,
    canWrite: oauth2 || oauth1,
    canReadPrivate: oauth2 || oauth1,
    canUploadMedia: oauth2 || oauth1,
    modes,
  };
}

/** Applies the include/exclude toolset filters to a tool's toolset. */
export function toolsetEnabled(config: Config, toolset: Toolset): boolean {
  if (config.toolsets.exclude.includes(toolset)) return false;
  if (config.toolsets.include.length > 0) return config.toolsets.include.includes(toolset);
  return true;
}
