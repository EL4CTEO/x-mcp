export type AuthErrorCode =
  | 'missing_app_auth'
  | 'missing_user_auth'
  | 'missing_refresh_token'
  | 'refresh_failed'
  | 'insufficient_scope';

export class AuthError extends Error {
  override name = 'AuthError';
  readonly code: AuthErrorCode;
  readonly hint: string;

  constructor(message: string, code: AuthErrorCode, hint: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }

  toJSON(): Record<string, unknown> {
    return { error: this.message, code: this.code, hint: this.hint };
  }
}

export const AUTH_HINTS = {
  appOnly:
    'Set X_BEARER_TOKEN (app-only) for public reads. Create one in the X developer portal under your app keys.',
  user: 'Run `npx x-mcp auth` to sign in with OAuth 2.0 (PKCE), or set X_OAUTH2_ACCESS_TOKEN / OAuth 1.0a credentials.',
  scope:
    'Your token is missing a scope required by this tool. Re-run `npx x-mcp auth --scopes "<full scope list>"` or update X_OAUTH2_SCOPE, then authorize again.',
} as const;
