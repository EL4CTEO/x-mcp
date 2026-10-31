/**
 * OAuth 1.0a request signing (HMAC-SHA1).
 *
 * Used for user-context calls when the app only has classic OAuth 1.0a
 * credentials, and for the legacy v1.1 media upload fallback.
 */
import { createHmac, randomBytes } from 'node:crypto';

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken?: string;
  accessTokenSecret?: string;
}

export interface OAuth1SignOptions {
  method: string;
  url: string;
  /** Query parameters that belong to the request URL. */
  query?: Record<string, string | number | boolean | undefined | null> | undefined;
  /** Form-encoded body parameters (never JSON: JSON bodies are not signed). */
  bodyParams?: Record<string, string> | undefined;
  nonce?: string;
  timestamp?: string;
}

export interface OAuth1Signature {
  header: string;
  signature: string;
  signatureBase: string;
  parameters: Record<string, string>;
}

/** RFC 5849 §3.6 percent-encoding. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function createNonce(): string {
  return randomBytes(16).toString('hex');
}

export function currentTimestamp(now: number = Date.now()): string {
  return Math.floor(now / 1000).toString();
}

/**
 * Produces the `Authorization: OAuth ...` header for a request.
 *
 * Note: parameters are signed after percent-encoding, sorted by encoded key and
 * then encoded value, and the base URL excludes query params and fragment.
 */
export function signOAuth1(credentials: OAuth1Credentials, options: OAuth1SignOptions): OAuth1Signature {
  const url = new URL(options.url);
  const baseUrl = `${url.origin}${url.pathname}`;

  const queryParams = new Map<string, string>();
  for (const [key, value] of url.searchParams.entries()) queryParams.set(key, value);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null) continue;
    queryParams.set(key, String(value));
  }

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: options.nonce ?? createNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: options.timestamp ?? currentTimestamp(),
    oauth_version: '1.0',
  };
  if (credentials.accessToken) oauthParams.oauth_token = credentials.accessToken;

  const signingParams = new Map<string, string>(queryParams);
  for (const [key, value] of Object.entries(options.bodyParams ?? {})) signingParams.set(key, value);
  for (const [key, value] of Object.entries(oauthParams)) signingParams.set(key, value);

  const encodedEntries = [...signingParams.entries()]
    .map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
    .sort(([keyA, valueA], [keyB, valueB]) =>
      keyA === keyB ? (valueA < valueB ? -1 : valueA > valueB ? 1 : 0) : keyA < keyB ? -1 : 1,
    );

  const parameterString = encodedEntries.map(([key, value]) => `${key}=${value}`).join('&');
  const signatureBase = [
    options.method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(parameterString),
  ].join('&');

  const signingKey = `${percentEncode(credentials.consumerSecret)}&${percentEncode(
    credentials.accessTokenSecret ?? '',
  )}`;
  const signature = createHmac('sha1', signingKey).update(signatureBase).digest('base64');

  const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  const header = `OAuth ${Object.keys(headerParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(headerParams[key] ?? '')}"`)
    .join(', ')}`;

  return { header, signature, signatureBase, parameters: headerParams };
}
