import type { Config, OAuth2Credentials } from '../config.ts';
import type { Logger } from '../logger.ts';
import { AuthError, AUTH_HINTS } from './errors.ts';
import { refreshAccessToken, type TokenSet } from './oauth2.ts';
import { CredentialStore, type StoredOAuth2 } from './store.ts';
import type { OAuth1Credentials } from './oauth1.ts';

const REFRESH_MARGIN_MS = 60_000;

export interface OAuth2State {
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. `undefined` means "no known expiry". */
  expiresAt?: number;
  scopes?: string[];
  fromEnv: boolean;
  fromFile: boolean;
}

export interface AuthStatus {
  bearer: boolean;
  oauth2: boolean;
  oauth1: boolean;
  oauth2ExpiresAt?: number;
  oauth2Scopes?: string[];
  oauth2Source?: 'env' | 'file' | 'refreshed';
  missing: string[];
}

/**
 * Resolves the credential to use for every request, refreshing OAuth 2.0
 * tokens exactly once across concurrent calls, and persisting rotated refresh
 * tokens back to the credential file.
 */
export class AuthManager {
  private readonly store: CredentialStore;
  private readonly config: Config;
  private readonly logger: Logger;
  private runtimeAccessToken?: string;
  private runtimeExpiresAt?: number;
  private runtimeRefreshToken?: string;
  private runtimeScopes?: string[];
  private runtimeFromRefresh = false;
  private refreshInFlight?: Promise<string>;

  constructor(config: Config, logger: Logger, store?: CredentialStore) {
    this.config = config;
    this.logger = logger;
    this.store = store ?? new CredentialStore(config.credentialFile, logger);
  }

  get bearerToken(): string | undefined {
    return this.config.auth.bearerToken;
  }

  get hasBearer(): boolean {
    return Boolean(this.config.auth.bearerToken);
  }

  get hasOAuth1(): boolean {
    const oauth1 = this.config.auth.oauth1;
    return Boolean(oauth1?.consumerKey && oauth1.consumerSecret && oauth1.accessToken && oauth1.accessTokenSecret);
  }

  get hasOAuth2(): boolean {
    return Boolean(this.clientConfig?.accessToken || this.clientConfig?.refreshToken);
  }

  get hasUserAuth(): boolean {
    return this.hasOAuth2 || this.hasOAuth1;
  }

  /** Which user-context mechanism a request should use. OAuth 2.0 wins. */
  get userAuthKind(): 'oauth2' | 'oauth1' | undefined {
    if (this.hasOAuth2) return 'oauth2';
    if (this.hasOAuth1) return 'oauth1';
    return undefined;
  }

  oauth1Credentials(): OAuth1Credentials {
    const oauth1 = this.config.auth.oauth1;
    if (!oauth1?.consumerKey || !oauth1.consumerSecret || !oauth1.accessToken || !oauth1.accessTokenSecret) {
      throw new AuthError('OAuth 1.0a user credentials are incomplete.', 'missing_user_auth', AUTH_HINTS.user);
    }
    return {
      consumerKey: oauth1.consumerKey,
      consumerSecret: oauth1.consumerSecret,
      accessToken: oauth1.accessToken,
      accessTokenSecret: oauth1.accessTokenSecret,
    };
  }

  /** Merges environment configuration over the persisted credential file. */
  get clientConfig(): (OAuth2Credentials & { expiresAt?: number; fromEnvToken: boolean }) | undefined {
    const env = this.config.auth.oauth2;
    const stored = this.store.oauth2;
    const clientId = env?.clientId ?? stored?.clientId;
    if (!clientId) return undefined;
    const accessToken = env?.accessToken ?? stored?.accessToken;
    return {
      clientId,
      clientSecret: env?.clientSecret,
      redirectUri: env?.redirectUri,
      scopes: env?.scopes ?? stored?.scopes,
      accessToken,
      refreshToken: env?.refreshToken ?? stored?.refreshToken,
      expiresAt: env?.accessToken ? undefined : stored?.expiresAt,
      fromEnvToken: Boolean(env?.accessToken),
    };
  }

  private currentState(): OAuth2State | undefined {
    const client = this.clientConfig;
    if (!client) return undefined;

    if (this.runtimeAccessToken) {
      return {
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        accessToken: this.runtimeAccessToken,
        refreshToken: this.runtimeRefreshToken ?? client.refreshToken,
        expiresAt: this.runtimeExpiresAt,
        scopes: this.runtimeScopes ?? client.scopes,
        fromEnv: false,
        fromFile: this.runtimeFromRefresh,
      };
    }

    if (!client.accessToken) return undefined;
    return {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      accessToken: client.accessToken,
      refreshToken: client.refreshToken,
      expiresAt: client.expiresAt,
      scopes: client.scopes,
      fromEnv: client.fromEnvToken,
      fromFile: !client.fromEnvToken,
    };
  }

  /**
   * Returns a usable OAuth 2.0 access token, refreshing it when it is within
   * 60 seconds of expiry. Pass `forceRefresh` after a 401 to recover from a
   * revoked or prematurely expired token.
   */
  async getOAuth2AccessToken(options: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<string> {
    if (this.refreshInFlight) return this.refreshInFlight;

    const state = this.currentState();
    if (!state) {
      // A session can consist of a refresh token alone (for example when only
      // X_OAUTH2_REFRESH_TOKEN is provided); mint an access token from it.
      const client = this.clientConfig;
      if (client?.refreshToken) {
        return this.refresh(
          {
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            accessToken: '',
            refreshToken: client.refreshToken,
            expiresAt: 0,
            scopes: client.scopes,
            fromEnv: false,
            fromFile: Boolean(this.store.oauth2),
          },
          options.signal,
        );
      }
      throw new AuthError('No OAuth 2.0 session configured.', 'missing_user_auth', AUTH_HINTS.user);
    }

    const expiringSoon =
      state.expiresAt !== undefined && state.expiresAt - Date.now() < REFRESH_MARGIN_MS;
    const needsRefresh = options.forceRefresh === true || expiringSoon;

    if (!needsRefresh) return state.accessToken;

    if (!state.refreshToken) {
      if (options.forceRefresh) {
        throw new AuthError(
          'The access token was rejected and no refresh token is available.',
          'missing_refresh_token',
          AUTH_HINTS.user,
        );
      }
      // Expiry is known but we cannot refresh; let the API decide.
      return state.accessToken;
    }

    return this.refresh(state, options.signal);
  }

  private refresh(state: OAuth2State, signal?: AbortSignal): Promise<string> {
    this.refreshInFlight = (async () => {
      this.logger.debug({ clientId: state.clientId }, 'refreshing OAuth 2.0 access token');
      try {
        const tokens = await refreshAccessToken({
          clientId: state.clientId,
          clientSecret: state.clientSecret,
          refreshToken: state.refreshToken as string,
        });
        this.applyTokens(tokens, state);
        return tokens.accessToken;
      } catch (error) {
        if (signal?.aborted) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn({ err: detail }, 'OAuth 2.0 refresh failed');
        throw new AuthError(
          `Could not refresh the OAuth 2.0 access token: ${detail}`,
          'refresh_failed',
          `${AUTH_HINTS.user} The refresh token may have been revoked or already rotated.`,
        );
      } finally {
        this.refreshInFlight = undefined;
      }
    })();
    return this.refreshInFlight;
  }

  /** Applies a token response (from refresh or a fresh login). */
  applyTokens(tokens: TokenSet, previous?: OAuth2State): void {
    this.runtimeAccessToken = tokens.accessToken;
    this.runtimeRefreshToken = tokens.refreshToken ?? previous?.refreshToken;
    this.runtimeExpiresAt = tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined;
    this.runtimeScopes = tokens.scope ?? previous?.scopes;
    this.runtimeFromRefresh = true;

    const previousFileState = previous?.fromFile ?? false;
    if (previousFileState) {
      const stored: StoredOAuth2 = {
        clientId: previous?.clientId ?? this.clientConfig?.clientId ?? '',
        accessToken: tokens.accessToken,
        refreshToken: this.runtimeRefreshToken,
        expiresAt: this.runtimeExpiresAt,
        scopes: this.runtimeScopes,
        tokenType: tokens.tokenType,
      };
      if (stored.clientId) this.store.saveOAuth2(stored);
    }
  }

  /** Called after a successful interactive login. */
  persistLogin(clientId: string, tokens: TokenSet, redirectUri?: string): StoredOAuth2 {
    const stored: StoredOAuth2 = {
      clientId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined,
      scopes: tokens.scope,
      tokenType: tokens.tokenType,
      redirectUri,
    };
    this.store.saveOAuth2(stored);
    this.runtimeAccessToken = tokens.accessToken;
    this.runtimeRefreshToken = tokens.refreshToken;
    this.runtimeExpiresAt = stored.expiresAt;
    this.runtimeScopes = tokens.scope;
    this.runtimeFromRefresh = true;
    this.logger.info({ file: this.store.file, redirectUri }, 'saved OAuth 2.0 credentials');
    return stored;
  }

  /** Drops in-memory token state (used by logout). */
  clearRuntime(): void {
    this.runtimeAccessToken = undefined;
    this.runtimeExpiresAt = undefined;
    this.runtimeRefreshToken = undefined;
    this.runtimeScopes = undefined;
    this.runtimeFromRefresh = false;
  }

  logout(): void {
    this.clearRuntime();
    this.store.clear();
  }

  status(): AuthStatus {
    const state = this.currentState();
    const missing: string[] = [];
    if (!this.hasBearer) missing.push('app-only bearer token (X_BEARER_TOKEN)');
    if (!this.hasOAuth2) missing.push('OAuth 2.0 user session (run `x-mcp auth`)');
    if (!this.hasOAuth1) missing.push('OAuth 1.0a user credentials');
    return {
      bearer: this.hasBearer,
      oauth2: this.hasOAuth2,
      oauth1: this.hasOAuth1,
      oauth2ExpiresAt: state?.expiresAt,
      oauth2Scopes: state?.scopes,
      oauth2Source: this.runtimeFromRefresh ? 'refreshed' : state?.fromEnv ? 'env' : state?.fromFile ? 'file' : undefined,
      missing,
    };
  }

  /** Throws unless user-context auth exists. */
  assertUserAuth(): void {
    if (!this.hasUserAuth) {
      throw new AuthError(
        'This tool needs a user-context credential, but none is configured.',
        'missing_user_auth',
        AUTH_HINTS.user,
      );
    }
  }
}
