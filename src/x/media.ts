import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import type { Logger } from '../logger.ts';
import type { XClient } from './client.ts';
import { XApiError } from './errors.ts';

export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const REMOTE_FETCH_LIMIT = 100 * 1024 * 1024;

export type MediaCategory =
  | 'tweet_image'
  | 'tweet_gif'
  | 'tweet_video'
  | 'amplify_video'
  | 'dm_image'
  | 'dm_gif'
  | 'dm_video'
  | 'subtitles';

export interface MediaSource {
  kind: 'path' | 'buffer' | 'url';
  path?: string;
  data?: Buffer;
  url?: string;
  filename?: string;
}

export interface MediaUploadOptions {
  source: MediaSource;
  mediaType?: string;
  category?: MediaCategory;
  altText?: string;
  waitForProcessing?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: { segment: number; totalSegments: number; bytesSent: number; totalBytes: number }) => void;
}

export interface MediaUploadResult {
  media_id: string;
  media_key?: string;
  media_type: string;
  category: MediaCategory;
  bytes: number;
  segments: number;
  processing_state: 'succeeded' | 'pending' | 'in_progress' | 'failed' | 'not_required';
  auth: 'oauth2' | 'oauth1';
  duration_ms: number;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.srt': 'text/plain',
  '.vtt': 'text/vtt',
};

export function inferMediaType(filename: string | undefined, provided?: string): string {
  if (provided) return provided;
  const ext = filename ? path.extname(filename).toLowerCase() : '';
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

export function inferCategory(mediaType: string, provided?: MediaCategory): MediaCategory {
  if (provided) return provided;
  if (mediaType === 'image/gif') return 'tweet_gif';
  if (mediaType.startsWith('image/')) return 'tweet_image';
  if (mediaType.startsWith('video/')) return 'tweet_video';
  return 'tweet_image';
}

const SUPPORTED_EXTENSIONS = Object.keys(MIME_BY_EXTENSION).sort();

/**
 * Uploading arbitrary local files would turn the agent into an exfiltration
 * channel (a prompt injection could ask it to upload ~/.ssh/id_rsa). Only
 * extensions that map to real media types are allowed.
 */
export function assertSupportedMediaPath(filePath: string): void {
  const extension = path.extname(filePath).toLowerCase();
  if (!extension || !(extension in MIME_BY_EXTENSION)) {
    throw new Error(
      `Refusing to upload "${filePath}": ${extension || 'files without an extension'} are not supported media. Allowed: ${SUPPORTED_EXTENSIONS.join(', ')}.`,
    );
  }
}

const PRIVATE_RANGES = new net.BlockList();
PRIVATE_RANGES.addSubnet('0.0.0.0', 8, 'ipv4');
PRIVATE_RANGES.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_RANGES.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE_RANGES.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE_RANGES.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE_RANGES.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_RANGES.addSubnet('192.0.0.0', 24, 'ipv4');
PRIVATE_RANGES.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE_RANGES.addSubnet('198.18.0.0', 15, 'ipv4');
PRIVATE_RANGES.addSubnet('224.0.0.0', 4, 'ipv4');
PRIVATE_RANGES.addAddress('::1', 'ipv6');
PRIVATE_RANGES.addAddress('::', 'ipv6');
PRIVATE_RANGES.addSubnet('fc00::', 7, 'ipv6');
PRIVATE_RANGES.addSubnet('fe80::', 10, 'ipv6');

export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1]) return PRIVATE_RANGES.check(mapped[1], 'ipv4');
  const family = net.isIP(address);
  if (family === 4) return PRIVATE_RANGES.check(address, 'ipv4');
  if (family === 6) return PRIVATE_RANGES.check(address, 'ipv6');
  return true;
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

export interface MediaUrlPolicy {
  /** Test-only escape hatch: allows http:// and private hosts. */
  allowPrivateHosts?: boolean;
}

/**
 * URL media is downloaded by the server, so it is an SSRF surface. Require
 * HTTPS, reject loopback/private hosts by name and by resolved address, and
 * re-validate every redirect.
 */
export async function assertMediaUrl(raw: string, policy: MediaUrlPolicy = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid media URL.');
  }
  const allowPrivate = policy.allowPrivateHosts === true;
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new Error('Remote media URLs must use https.');
  }
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new Error('Media URL is missing a host.');
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error(`Refusing to download media from a local or private host (${host}).`);
  }
  if (net.isIP(host) !== 0) {
    if (isPrivateAddress(host)) throw new Error(`Refusing to download media from a private address (${host}).`);
    return url;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`Could not resolve media host ${host}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (addresses.length === 0) throw new Error(`Could not resolve media host ${host}.`);
  const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
  if (blocked) {
    throw new Error(`Refusing to download media from ${host}: it resolves to the private address ${blocked.address}.`);
  }
  return url;
}

export function assertPublicMediaUrl(raw: string): Promise<URL> {
  return assertMediaUrl(raw);
}

async function fetchRemoteMedia(rawUrl: string, logger: Logger): Promise<{ data: Buffer; contentType?: string }> {
  let current = await assertPublicMediaUrl(rawUrl);
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(current, { redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Media redirect did not include a Location header.');
      current = await assertPublicMediaUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Could not download media from ${current.href}: HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > REMOTE_FETCH_LIMIT) {
      throw new Error(
        `Remote media is ${(declared / 1024 / 1024).toFixed(1)} MB, above the ${REMOTE_FETCH_LIMIT / 1024 / 1024} MB limit for URL sources. Download it and pass a local path instead.`,
      );
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > REMOTE_FETCH_LIMIT) {
      throw new Error(`Remote media exceeded the ${REMOTE_FETCH_LIMIT / 1024 / 1024} MB limit.`);
    }
    logger.debug({ url: current.href, bytes: data.byteLength }, 'downloaded remote media');
    return { data, contentType: response.headers.get('content-type')?.split(';')[0]?.trim() };
  }
  throw new Error('Too many redirects while downloading media.');
}

/**
 * A media source that exposes its size up-front and reads bounded ranges on
 * demand. Paths are streamed segment-by-segment, so a 2 GB video never sits in
 * memory; buffers and URL downloads are capped to keep the process safe.
 */
interface ResolvedSource {
  size: number;
  filename: string;
  mediaTypeHint?: string;
  read(start: number, end: number): Promise<Buffer>;
  close(): Promise<void>;
}

async function resolveSource(source: MediaSource, logger: Logger): Promise<ResolvedSource> {
  if (source.kind === 'path') {
    const filePath = source.path;
    if (!filePath) throw new Error('A file path is required for path media sources.');
    assertSupportedMediaPath(filePath);
    const handle = await fs.open(filePath, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
      if (stat.size === 0) throw new Error(`Media file is empty: ${filePath}`);
      return {
        size: stat.size,
        filename: path.basename(filePath),
        async read(start, end) {
          const length = Math.max(0, end - start);
          const buffer = Buffer.allocUnsafe(length);
          let offset = 0;
          while (offset < length) {
            const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
          }
          return buffer.subarray(0, offset);
        },
        async close() {
          await handle.close();
        },
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  if (source.kind === 'buffer') {
    const data = source.data;
    if (!data || data.byteLength === 0) throw new Error('Base64 media data is empty.');
    return {
      size: data.byteLength,
      filename: source.filename ?? 'upload.bin',
      async read(start, end) {
        return data.subarray(start, end);
      },
      async close() {},
    };
  }

  const url = source.url;
  if (!url) throw new Error('A URL is required for URL media sources.');
  const remote = await fetchRemoteMedia(url, logger);
  const data = remote.data;
  return {
    size: data.byteLength,
    filename: path.basename(new URL(url).pathname) || 'upload.bin',
    mediaTypeHint: remote.contentType,
    async read(start, end) {
      return data.subarray(start, end);
    },
    async close() {},
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface ProcessingInfo {
  state: 'pending' | 'in_progress' | 'succeeded' | 'failed';
  check_after_secs?: number;
  progress_percent?: number;
  error?: { code?: number; name?: string; message?: string };
}

/**
 * Chunked media upload.
 *
 * Uses the v2 flow (initialize → append → finalize → status) when an OAuth 2.0
 * user session exists, and the legacy v1.1 flow for OAuth 1.0a-only setups.
 * A tool handler can forward `onProgress` to MCP progress notifications.
 */
export class MediaUploader {
  private readonly client: XClient;
  private readonly logger: Logger;

  constructor(client: XClient, logger: Logger) {
    this.client = client;
    this.logger = logger;
  }

  get available(): boolean {
    return this.client.auth.hasUserAuth;
  }

  async upload(options: MediaUploadOptions): Promise<MediaUploadResult> {
    const startedAt = Date.now();
    const resolved = await resolveSource(options.source, this.logger);
    try {
      const mediaType = inferMediaType(
        options.source.filename ?? resolved.filename,
        options.mediaType ?? resolved.mediaTypeHint,
      );
      const category = inferCategory(mediaType, options.category);
      const useOAuth2 = this.client.auth.hasOAuth2;
      const totalSegments = Math.max(1, Math.ceil(resolved.size / MAX_CHUNK_BYTES));

      this.logger.info(
        { filename: resolved.filename, bytes: resolved.size, mediaType, category, auth: useOAuth2 ? 'oauth2' : 'oauth1' },
        'uploading media',
      );

      const { mediaId, mediaKey, processing } = useOAuth2
        ? await this.uploadV2(resolved, mediaType, category, totalSegments, options)
        : await this.uploadV1(resolved, mediaType, category, totalSegments, options);

      if (options.altText && options.altText.trim().length > 0) {
        await this.setAltText(mediaId, options.altText.trim(), useOAuth2, options.signal);
      }

      let state: MediaUploadResult['processing_state'] = 'not_required';
      if (processing) {
        state =
          options.waitForProcessing === false
            ? processing.state
            : await this.waitForProcessing(mediaId, useOAuth2, options.signal, processing);
      } else if (category === 'tweet_video' || category === 'dm_video') {
        state = 'succeeded';
      }

      return {
        media_id: mediaId,
        media_key: mediaKey,
        media_type: mediaType,
        category,
        bytes: resolved.size,
        segments: totalSegments,
        processing_state: state,
        auth: useOAuth2 ? 'oauth2' : 'oauth1',
        duration_ms: Date.now() - startedAt,
      };
    } finally {
      await resolved.close();
    }
  }

  private async uploadV2(
    source: ResolvedSource,
    mediaType: string,
    category: MediaCategory,
    totalSegments: number,
    options: MediaUploadOptions,
  ): Promise<{ mediaId: string; mediaKey?: string; processing?: ProcessingInfo }> {
    const init = await this.client.request<{ id?: string; media_key?: string }>({
      method: 'POST',
      path: '/2/media/upload/initialize',
      auth: 'oauth2',
      body: { media_type: mediaType, total_bytes: source.size, media_category: category },
      signal: options.signal,
    });
    const mediaId = init.data.id;
    const mediaKey = init.data.media_key;
    if (!mediaId) throw new XApiError({ status: 500, message: 'X did not return a media id for the upload.' });

    for (let segment = 0; segment < totalSegments; segment++) {
      const start = segment * MAX_CHUNK_BYTES;
      const end = Math.min(start + MAX_CHUNK_BYTES, source.size);
      const chunk = await source.read(start, end);
      const form = new FormData();
      form.append('segment_index', String(segment));
      form.append('media', new Blob([chunk as unknown as ArrayBuffer], { type: mediaType }), `chunk-${segment}.bin`);
      await this.client.request({
        method: 'POST',
        path: `/2/media/upload/${mediaId}/append`,
        auth: 'oauth2',
        form,
        idempotent: true,
        signal: options.signal,
      });
      options.onProgress?.({ segment: segment + 1, totalSegments, bytesSent: end, totalBytes: source.size });
    }

    const finalized = await this.client.request<{ processing_info?: ProcessingInfo }>({
      method: 'POST',
      path: `/2/media/upload/${mediaId}/finalize`,
      auth: 'oauth2',
      signal: options.signal,
    });
    return { mediaId, mediaKey, processing: finalized.data.processing_info };
  }

  private async uploadV1(
    source: ResolvedSource,
    mediaType: string,
    category: MediaCategory,
    totalSegments: number,
    options: MediaUploadOptions,
  ): Promise<{ mediaId: string; mediaKey?: string; processing?: ProcessingInfo }> {
    // Legacy v1.1 chunked upload: still supported by X for OAuth 1.0a setups,
    // but no longer part of the current v2 documentation.
    const initForm = new FormData();
    initForm.append('command', 'INIT');
    initForm.append('total_bytes', String(source.size));
    initForm.append('media_type', mediaType);
    initForm.append('media_category', category);
    const init = await this.client.request<{ media_id_string?: string; media_id?: number | string }>({
      method: 'POST',
      path: '/1.1/media/upload.json',
      auth: 'oauth1',
      form: initForm,
      signal: options.signal,
    });
    const mediaId = init.data.media_id_string ?? (init.data.media_id !== undefined ? String(init.data.media_id) : undefined);
    if (!mediaId) throw new XApiError({ status: 500, message: 'X did not return a media id for the v1.1 upload.' });

    for (let segment = 0; segment < totalSegments; segment++) {
      const start = segment * MAX_CHUNK_BYTES;
      const end = Math.min(start + MAX_CHUNK_BYTES, source.size);
      const chunk = await source.read(start, end);
      const form = new FormData();
      form.append('command', 'APPEND');
      form.append('media_id', mediaId);
      form.append('segment_index', String(segment));
      form.append('media', new Blob([chunk as unknown as ArrayBuffer], { type: mediaType }), `chunk-${segment}.bin`);
      await this.client.request({
        method: 'POST',
        path: '/1.1/media/upload.json',
        auth: 'oauth1',
        form,
        idempotent: true,
        signal: options.signal,
      });
      options.onProgress?.({ segment: segment + 1, totalSegments, bytesSent: end, totalBytes: source.size });
    }

    const finalizeForm = new FormData();
    finalizeForm.append('command', 'FINALIZE');
    finalizeForm.append('media_id', mediaId);
    const finalized = await this.client.request<{ processing_info?: ProcessingInfo }>({
      method: 'POST',
      path: '/1.1/media/upload.json',
      auth: 'oauth1',
      form: finalizeForm,
      signal: options.signal,
    });
    return { mediaId, processing: finalized.data.processing_info };
  }

  private async setAltText(mediaId: string, altText: string, useOAuth2: boolean, signal?: AbortSignal): Promise<void> {
    if (altText.length > 1_000) throw new Error('Alt text must be at most 1000 characters.');
    if (useOAuth2) {
      await this.client.request({
        method: 'POST',
        path: '/2/media/metadata',
        auth: 'oauth2',
        body: { id: mediaId, metadata: { alt_text: { text: altText } } },
        signal,
      });
      return;
    }
    await this.client.request({
      method: 'POST',
      path: '/1.1/media/metadata/create.json',
      auth: 'oauth1',
      body: { media_id: mediaId, alt_text: { text: altText } },
      signal,
    });
  }

  private async waitForProcessing(
    mediaId: string,
    useOAuth2: boolean,
    signal: AbortSignal | undefined,
    initial: ProcessingInfo,
  ): Promise<'succeeded' | 'pending' | 'in_progress'> {
    let info: ProcessingInfo | undefined = initial;
    const deadline = Date.now() + 5 * 60_000;
    while (info) {
      if (info.state === 'succeeded') return 'succeeded';
      if (info.state === 'failed') {
        throw new XApiError({
          status: 400,
          message: `Media processing failed: ${info.error?.message ?? 'unknown error'}`,
          detail: info.error?.message,
        });
      }
      if (Date.now() > deadline) return info.state;
      await sleep(Math.min((info.check_after_secs ?? 1) * 1000, 10_000), signal);
      if (useOAuth2) {
        const status = await this.client.request<{ processing_info?: ProcessingInfo }>({
          method: 'GET',
          path: '/2/media/upload',
          query: { command: 'STATUS', media_id: mediaId },
          auth: 'oauth2',
          cache: false,
          signal,
        });
        info = status.data.processing_info;
      } else {
        const status = await this.client.request<{ processing_info?: ProcessingInfo }>({
          method: 'GET',
          path: '/1.1/media/upload.json',
          query: { command: 'STATUS', media_id: mediaId },
          auth: 'oauth1',
          cache: false,
          signal,
        });
        info = status.data.processing_info;
      }
      if (!info) return 'succeeded';
    }
    return 'succeeded';
  }
}
