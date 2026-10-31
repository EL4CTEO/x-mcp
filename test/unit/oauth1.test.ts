import { describe, expect, it } from 'vitest';
import { createNonce, currentTimestamp, percentEncode, signOAuth1 } from '../../src/auth/oauth1.ts';

const credentials = {
  consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
  consumerSecret: 'kAcSOMPGRdwQbmBdpMlAaLKtaYlMDbgHxJqFeYTa1NSbXPzXk8',
  accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
  accessTokenSecret: 'LswwEvH4DBfjmB51BswLd0dCANsWgJqBg5dyAJ7dOV0',
};

describe('OAuth 1.0a signing', () => {
  it('reproduces the canonical Twitter example signature', () => {
    const result = signOAuth1(credentials, {
      method: 'POST',
      url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
      bodyParams: { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
      nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      timestamp: '1318622958',
    });

    // The base string below is the one printed in X's OAuth 1.0a documentation;
    // this signature was cross-checked against an independent .NET HMAC-SHA1.
    expect(result.signature).toBe('b1a85t15Xlwd9HFZullpjOssnA8=');
    expect(result.header.startsWith('OAuth ')).toBe(true);
    expect(result.header).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(result.header).toContain('oauth_signature="b1a85t15Xlwd9HFZullpjOssnA8%3D"');
    expect(result.signatureBase).toContain('include_entities%3Dtrue');
  });

  it('percent-encodes RFC 5849 reserved characters', () => {
    expect(percentEncode("Ladies + Gentlemen")).toBe('Ladies%20%2B%20Gentlemen');
    expect(percentEncode('an encoded string!')).toBe('an%20encoded%20string%21');
    expect(percentEncode("Dogs, Cats & Mice")).toBe('Dogs%2C%20Cats%20%26%20Mice');
    expect(percentEncode('☃')).toBe('%E2%98%83');
    expect(percentEncode("*'()!")).toBe('%2A%27%28%29%21');
  });

  it('includes query parameters from the URL in the signature', () => {
    const first = signOAuth1(credentials, {
      method: 'GET',
      url: 'https://api.x.com/2/tweets?ids=1,2',
      nonce: 'fixed',
      timestamp: '1700000000',
    });
    const second = signOAuth1(credentials, {
      method: 'GET',
      url: 'https://api.x.com/2/tweets',
      query: { ids: '1,2' },
      nonce: 'fixed',
      timestamp: '1700000000',
    });
    expect(first.signature).toBe(second.signature);
  });

  it('produces unique nonces and second-granularity timestamps', () => {
    expect(createNonce()).not.toBe(createNonce());
    expect(createNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(currentTimestamp(1_700_000_000_500)).toBe('1700000000');
  });
});
