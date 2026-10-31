/**
 * OAuth 2.0 Authorization Code flow with PKCE, plus token refresh.
 * https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
 */
import { createHash, randomBytes } from 'node:crypto';

export const AUTHORIZE_URL = 'https://api.x.com/2/oauth2/authorize';
export const TOKEN_URL = 'https://api.x.com/2/oauth2/token';

/** Scopes the server knows how to use, in a sensible request order. */
export const KNOWN_SCOPES = [
  'tweet.read',
  'tweet.write',
  'users.read',
  'follows.read',
  'follows.write',
  'like.read',
  'like.write',
  'bookmark.read',
  'bookmark.write',
  'list.read',
  'list.write',
  'mute.read',
  'mute.write',
  'block.read',
  'block.write',
  'media.write',
  'dm.read',
  'dm.write',
  'space.read',
  'tweet.moderate.write',
  'offline.access',
] as const;

export const DEFAULT_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'] as const;

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

export function createPkcePair(verifier?: string): PkcePair {
  const value = verifier ?? randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(value).digest('base64url');
  return { verifier: value, challenge, method: 'S256' };
}

export interface AuthorizeUrlOptions {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  challenge: string;
}

export function buildAuthorizeUrl(options: AuthorizeUrlOptions): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', options.scopes.join(' '));
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export interface TokenSet {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string[];
}

export class OAuth2Error extends Error {
  override name = 'OAuth2Error';
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

async function tokenRequest(
  params: Record<string, string>,
  clientId: string,
  clientSecret: string | undefined,
  tokenUrl: string,
  fetchImpl: typeof fetch,
): Promise<TokenSet> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (clientSecret) {
    headers.authorization = basicAuth(clientId, clientSecret);
  } else {
    body.set('client_id', clientId);
  }

  const response = await fetchImpl(tokenUrl, { method: 'POST', headers, body });
  const text = await response.text();
  if (!response.ok) {
    throw new OAuth2Error(`OAuth 2.0 token request failed (${response.status}): ${text}`, response.status, text);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new OAuth2Error(`OAuth 2.0 token endpoint returned invalid JSON: ${text.slice(0, 300)}`, response.status, text);
  }
  if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
    throw new OAuth2Error(`OAuth 2.0 token response is missing access_token: ${text.slice(0, 300)}`, response.status, text);
  }
  const scope = typeof parsed.scope === 'string' ? parsed.scope.split(/[ ,]+/).filter(Boolean) : undefined;
  return {
    accessToken: parsed.access_token,
    tokenType: typeof parsed.token_type === 'string' ? parsed.token_type : 'bearer',
    refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined,
    expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in : undefined,
    scope,
  };
}

export interface ExchangeOptions {
  clientId: string;
  clientSecret?: string | undefined;
  code: string;
  verifier: string;
  redirectUri: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
}

export function exchangeAuthorizationCode(options: ExchangeOptions): Promise<TokenSet> {
  return tokenRequest(
    {
      grant_type: 'authorization_code',
      code: options.code,
      redirect_uri: options.redirectUri,
      code_verifier: options.verifier,
    },
    options.clientId,
    options.clientSecret,
    options.tokenUrl ?? TOKEN_URL,
    options.fetchImpl ?? fetch,
  );
}

export interface RefreshOptions {
  clientId: string;
  clientSecret?: string | undefined;
  refreshToken: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
}

export function refreshAccessToken(options: RefreshOptions): Promise<TokenSet> {
  return tokenRequest(
    { grant_type: 'refresh_token', refresh_token: options.refreshToken },
    options.clientId,
    options.clientSecret,
    options.tokenUrl ?? TOKEN_URL,
    options.fetchImpl ?? fetch,
  );
}
