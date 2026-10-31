import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { AuthManager } from './manager.ts';
import { CredentialStore } from './store.ts';
import { DEFAULT_SCOPES, KNOWN_SCOPES } from './oauth2.ts';
import { login } from './flow.ts';
import { XClient } from '../x/client.ts';

export interface AuthCliOptions {
  config: Config;
  logger: Logger;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  scopes?: string[] | undefined;
  redirectUri?: string | undefined;
  manual?: boolean | undefined;
  openBrowser?: boolean | undefined;
  logout?: boolean | undefined;
  json?: boolean | undefined;
}

function resolveScopes(provided: string[] | undefined, config: Config): string[] {
  const raw = provided ?? config.auth.oauth2?.scopes ?? [...DEFAULT_SCOPES];
  const unknown = raw.filter((scope) => !(KNOWN_SCOPES as readonly string[]).includes(scope));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown OAuth 2.0 scope(s): ${unknown.join(', ')}. Valid scopes: ${KNOWN_SCOPES.join(', ')}`,
    );
  }
  const scopes = new Set(raw);
  // Without offline.access X issues a 2-hour token and no refresh token.
  scopes.add('offline.access');
  return [...scopes];
}

function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * `x-mcp auth`: interactive OAuth 2.0 login, credential persistence and a
 * live verification call. Also supports `--logout`.
 */
export async function runAuthCommand(options: AuthCliOptions): Promise<number> {
  const { config, logger } = options;
  const store = new CredentialStore(config.credentialFile, logger);

  if (options.logout) {
    store.clear();
    if (options.json) {
      print(JSON.stringify({ loggedOut: true, credentialFile: config.credentialFile }, null, 2));
    } else {
      print(`Removed stored credentials from ${config.credentialFile}.`);
      print('Environment tokens (X_OAUTH2_ACCESS_TOKEN, X_BEARER_TOKEN, OAuth 1.0a keys) are unaffected.');
    }
    return 0;
  }

  const clientId = options.clientId ?? config.auth.oauth2?.clientId ?? store.oauth2?.clientId;
  if (!clientId) {
    process.stderr.write(
      [
        'Missing OAuth 2.0 client id.',
        '',
        'Pass it explicitly:  x-mcp auth --client-id <client-id>',
        'or set it:          X_OAUTH2_CLIENT_ID=<client-id>  (e.g. in .env)',
        '',
        'Create an OAuth 2.0 client in the X developer portal:',
        '  User authentication settings → OAuth 2.0 → App type "Web App, Automated App or Bot"',
        '  Callback URI: http://127.0.0.1:8787/callback',
        '  Scopes: tweet.read tweet.write users.read offline.access (add dm.*, list.*, bookmark.* as needed)',
      ].join('\n') + '\n',
    );
    return 1;
  }

  const scopes = resolveScopes(options.scopes, config);
  const redirectUri =
    options.redirectUri ??
    config.auth.oauth2?.redirectUri ??
    store.oauth2?.redirectUri ??
    'http://127.0.0.1:8787/callback';
  const clientSecret = options.clientSecret ?? config.auth.oauth2?.clientSecret;

  if (!options.json) {
    print(`Authorizing x-mcp against X`);
    print(`  client:   ${clientId}`);
    print(`  scopes:   ${scopes.join(' ')}`);
    print(`  callback: ${redirectUri}`);
    print('');
  }

  const result = await login({
    clientId,
    clientSecret,
    scopes,
    redirectUri,
    openBrowser: options.openBrowser,
    manual: options.manual,
    logger,
  });

  const expiresAt = result.tokens.expiresIn ? Date.now() + result.tokens.expiresIn * 1000 : undefined;
  store.saveOAuth2({
    clientId,
    clientSecret,
    accessToken: result.tokens.accessToken,
    refreshToken: result.tokens.refreshToken,
    expiresAt,
    scopes: result.tokens.scope ?? scopes,
    tokenType: result.tokens.tokenType,
    redirectUri,
  });

  const verifyConfig: Config = {
    ...config,
    auth: {
      ...config.auth,
      oauth2: {
        clientId,
        clientSecret,
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        scopes,
        redirectUri,
      },
    },
  };
  const auth = new AuthManager(verifyConfig, logger, store);
  const client = new XClient(verifyConfig, logger, auth);
  let account: { id?: string; username?: string } | undefined;
  let warning: string | undefined;
  try {
    const me = await client.request<{ id?: string; username?: string }>({
      method: 'GET',
      path: '/2/users/me',
      auth: 'user',
      query: { 'user.fields': 'id,username,name' },
      cache: false,
    });
    account = me.data;
  } catch (error) {
    warning = error instanceof Error ? error.message : String(error);
  } finally {
    await client.close().catch(() => undefined);
  }

  if (warning && !options.json) {
    print('');
    print(`Tokens saved, but the verification call failed: ${warning}`);
    print('This usually means a required scope was not granted or the X app is misconfigured.');
  }

  if (options.json) {
    print(
      JSON.stringify(
        {
          authorized: true,
          clientId,
          scopes: result.tokens.scope ?? scopes,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
          refreshToken: Boolean(result.tokens.refreshToken),
          credentialFile: config.credentialFile,
          account,
          ...(warning ? { warning } : {}),
        },
        null,
        2,
      ),
    );
  } else {
    print('');
    print(account?.username ? `Signed in as @${account.username} (id ${account.id}).` : 'Authorization complete.');
    print(`Tokens saved to ${config.credentialFile} (mode 0600).`);
    print(
      result.tokens.refreshToken
        ? 'A refresh token is stored; access tokens renew automatically.'
        : 'No refresh token was issued. Add the offline.access scope to enable automatic renewal.',
    );
    print('');
    print('Start the server with:  npx x-mcp');
  }

  return account || !warning ? 0 : 2;
}
