import { describe, expect, it } from 'vitest';
import {
  assertPublicMediaUrl,
  assertSupportedMediaPath,
  inferCategory,
  inferMediaType,
  isPrivateAddress,
} from '../../src/x/media.ts';

describe('media guardrails', () => {
  it('only allows extensions that map to media types', () => {
    expect(() => assertSupportedMediaPath('/tmp/pixel.png')).not.toThrow();
    expect(() => assertSupportedMediaPath('C:\\tmp\\clip.mp4')).not.toThrow();
    expect(() => assertSupportedMediaPath('/tmp/captions.vtt')).not.toThrow();
    expect(() => assertSupportedMediaPath('/home/user/.ssh/id_rsa')).toThrow(/not supported media/);
    expect(() => assertSupportedMediaPath('/tmp/secrets.json')).toThrow(/not supported media/);
    expect(() => assertSupportedMediaPath('/tmp/archive.zip')).toThrow(/Allowed:/);
  });

  it('identifies private, loopback and link-local addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '203.0.114.10', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('rejects non-HTTPS and private media URLs (SSRF protection)', async () => {
    await expect(assertPublicMediaUrl('http://example.com/a.png')).rejects.toThrow(/https/);
    await expect(assertPublicMediaUrl('https://localhost/a.png')).rejects.toThrow(/local or private/);
    await expect(assertPublicMediaUrl('https://printer.local/a.png')).rejects.toThrow(/local or private/);
    await expect(assertPublicMediaUrl('https://127.0.0.1/a.png')).rejects.toThrow(/private address/);
    await expect(assertPublicMediaUrl('https://169.254.169.254/latest/meta-data')).rejects.toThrow(/private address/);
    await expect(assertPublicMediaUrl('https://[::1]/a.png')).rejects.toThrow(/private address/);
    await expect(assertPublicMediaUrl('not a url')).rejects.toThrow(/Invalid media URL/);
    await expect(assertPublicMediaUrl('https://8.8.8.8/a.png')).resolves.toBeInstanceOf(URL);
  });

  it('infers MIME types and categories', () => {
    expect(inferMediaType('/path/clip.MP4')).toBe('video/mp4');
    expect(inferMediaType('photo.webp')).toBe('image/webp');
    expect(inferMediaType('weird.bin')).toBe('application/octet-stream');
    expect(inferMediaType('x', 'image/png')).toBe('image/png');

    expect(inferCategory('image/gif')).toBe('tweet_gif');
    expect(inferCategory('image/jpeg')).toBe('tweet_image');
    expect(inferCategory('video/mp4')).toBe('tweet_video');
    expect(inferCategory('video/mp4', 'dm_video')).toBe('dm_video');
  });
});
