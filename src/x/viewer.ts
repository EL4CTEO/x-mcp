import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { assertMediaUrl } from './media.ts';

export type MediaKind = 'photo' | 'video' | 'animated_gif' | 'auto';

export interface ViewMediaOptions {
  url: string;
  kind?: MediaKind | undefined;
  previewUrl?: string | undefined;
  durationMs?: number | undefined;
  altText?: string | undefined;
  frames?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface RenderedImage {
  data: string;
  mimeType: string;
  label: string;
  bytes: number;
}

export interface MediaView {
  kind: 'photo' | 'video' | 'animated_gif' | 'unknown';
  source_url: string;
  preview_url?: string;
  alt_text?: string;
  duration_ms?: number;
  ffmpeg: boolean;
  frames_requested: number;
  images: RenderedImage[];
  notes: string[];
  downloaded_bytes: number;
}

class MediaDownloadError extends Error {
  override name = 'MediaDownloadError';
}

/**
 * Evenly spaced frame timestamps for a video of known duration.
 * Frames never land on the first or last frame, which are usually black.
 */
export function frameTimestamps(durationMs: number | undefined, count: number): number[] {
  const frames = Math.max(1, Math.min(6, Math.floor(count)));
  if (!durationMs || durationMs <= 0) return [0];
  const durationSeconds = durationMs / 1000;
  return Array.from({ length: frames }, (_, index) => {
    const timestamp = (durationSeconds * (index + 1)) / (frames + 1);
    return Number(Math.max(0, Math.min(durationSeconds - 0.05, timestamp)).toFixed(3));
  });
}

export function kindFromUrl(url: string): MediaKind {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return 'auto';
  }
  if (/\.(mp4|m4v|mov|webm)$/.test(pathname)) return 'video';
  if (/\.gif$/.test(pathname)) return 'animated_gif';
  if (/\.(jpg|jpeg|png|webp|bmp)$/.test(pathname)) return 'photo';
  return 'auto';
}

class FfmpegLocator {
  private resolved: string | null | undefined;
  private readonly configured: string | undefined;
  private readonly logger: Logger;

  constructor(configured: string | undefined, logger: Logger) {
    this.configured = configured;
    this.logger = logger;
  }

  async find(): Promise<string | undefined> {
    if (this.resolved !== undefined) return this.resolved ?? undefined;
    const candidates = [...new Set([this.configured, process.env.X_MCP_FFMPEG, 'ffmpeg'].filter((value): value is string => Boolean(value)))];
    for (const candidate of candidates) {
      try {
        const result = spawnSync(candidate, ['-version'], { stdio: 'ignore', timeout: 4_000, windowsHide: true });
        if (!result.error && result.status === 0) {
          this.resolved = candidate;
          return candidate;
        }
      } catch {
        // Sandboxes may block process creation; treat as unavailable.
      }
    }
    this.resolved = null;
    this.logger.info({}, 'ffmpeg not found: video media falls back to preview frames');
    return undefined;
  }
}

function runProcess(bin: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish(false);
    }, timeoutMs);
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
  });
}

/**
 * Fetches post media and turns it into MCP image content.
 *
 * Photos are returned as-is. Videos and animated GIFs (which are MP4s under
 * the hood) are sampled into evenly spaced JPEG frames when ffmpeg is
 * available; otherwise the preview frame is returned with a note and the
 * video URL so a video-capable client can fetch it directly.
 */
export class MediaViewer {
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly ffmpeg: FfmpegLocator;

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.ffmpeg = new FfmpegLocator(config.media.ffmpegPath, logger);
  }

  async view(options: ViewMediaOptions): Promise<MediaView> {
    const requested = options.kind ?? 'auto';
    const kind = requested === 'auto' ? kindFromUrl(options.url) : requested;
    const framesRequested = Math.max(1, Math.min(6, Math.floor(options.frames ?? 3)));
    const ffmpegPath = await this.ffmpeg.find();
    const notes: string[] = [];
    const images: RenderedImage[] = [];
    let downloadedBytes = 0;
    let resolvedKind: MediaView['kind'] = kind === 'auto' ? 'unknown' : kind;

    const pushImage = (data: Buffer, mimeType: string, label: string): void => {
      images.push({ data: data.toString('base64'), mimeType, label, bytes: data.byteLength });
    };

    const policy = { allowPrivateHosts: this.config.media.allowPrivateHosts };

    if (kind === 'photo' || kind === 'auto') {
      try {
        const download = await this.downloadBuffer(options.url, this.config.media.maxImageBytes, options.signal, policy);
        downloadedBytes += download.data.byteLength;
        if (download.contentType.startsWith('image/')) {
          pushImage(download.data, download.contentType, 'image');
          resolvedKind = 'photo';
        } else {
          notes.push(`The URL returned ${download.contentType || 'an unknown content type'}, not an image.`);
        }
      } catch (error) {
        if (kind === 'photo') throw error;
        notes.push(`Could not download image: ${errorMessage(error)}`);
      }
    }

    if (kind === 'video' || kind === 'animated_gif') {
      resolvedKind = kind;
      if (ffmpegPath) {
        let directory: string | undefined;
        try {
          directory = await fs.mkdtemp(path.join(os.tmpdir(), 'x-mcp-media-'));
          const videoPath = path.join(directory, 'media.mp4');
          const download = await this.downloadToFile(
            options.url,
            videoPath,
            this.config.media.maxVideoBytes,
            options.signal,
            policy,
          );
          downloadedBytes += download.bytes;

          const timestamps = frameTimestamps(options.durationMs, framesRequested);
          const frames = await extractFrames(ffmpegPath, videoPath, timestamps, this.config.media.frameWidth, directory);
          if (frames.length > 0) {
            frames.forEach((frame, index) => pushImage(frame, 'image/jpeg', `frame ${index + 1}/${frames.length}`));
          } else {
            notes.push('ffmpeg could not decode this video; returning the preview frame instead.');
          }
        } catch (error) {
          notes.push(`Could not process video: ${errorMessage(error)}`);
        } finally {
          if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
        }
      } else {
        notes.push(
          'ffmpeg is not installed, so video frames were not extracted. Install ffmpeg (or set X_MCP_FFMPEG) and retry, or use the video URL directly with a client that supports video.',
        );
      }
    }

    if (images.length === 0 && options.previewUrl && options.previewUrl !== options.url) {
      try {
        const preview = await this.downloadBuffer(options.previewUrl, this.config.media.maxImageBytes, options.signal, policy);
        if (preview.contentType.startsWith('image/')) {
          downloadedBytes += preview.data.byteLength;
          pushImage(preview.data, preview.contentType, 'preview');
        }
      } catch (error) {
        notes.push(`Could not download the preview image: ${errorMessage(error)}`);
      }
    }

    if (images.length === 0 && notes.length === 0) {
      notes.push('No readable media was found at this URL.');
    }

    this.logger.debug(
      { kind: resolvedKind, images: images.length, downloadedBytes, ffmpeg: Boolean(ffmpegPath) },
      'media viewed',
    );

    return {
      kind: resolvedKind,
      source_url: options.url,
      ...(options.previewUrl ? { preview_url: options.previewUrl } : {}),
      ...(options.altText ? { alt_text: options.altText } : {}),
      ...(options.durationMs ? { duration_ms: options.durationMs } : {}),
      ffmpeg: Boolean(ffmpegPath),
      frames_requested: framesRequested,
      images,
      notes,
      downloaded_bytes: downloadedBytes,
    };
  }

  private async open(
    rawUrl: string,
    maxBytes: number,
    signal: AbortSignal | undefined,
    policy: { allowPrivateHosts?: boolean },
    onChunk: (chunk: Buffer) => void | Promise<void>,
  ): Promise<{ contentType: string; bytes: number }> {
    let current = await assertMediaUrl(rawUrl, policy);
    for (let hop = 0; hop < 4; hop++) {
      const response = await fetch(current, { redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new MediaDownloadError('Media redirect did not include a Location header.');
        current = await assertMediaUrl(new URL(location, current).toString(), policy);
        continue;
      }
      if (!response.ok) throw new MediaDownloadError(`Media download failed with HTTP ${response.status}.`);
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > maxBytes) throw new MediaDownloadError(`Media is ${formatMb(declared)}, above the ${formatMb(maxBytes)} limit.`);
      if (!response.body) throw new MediaDownloadError('Media response had no body.');

      let total = 0;
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maxBytes) throw new MediaDownloadError(`Media exceeded the ${formatMb(maxBytes)} limit.`);
        await onChunk(Buffer.from(chunk));
      }
      return {
        contentType: (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]?.trim() ?? '',
        bytes: total,
      };
    }
    throw new MediaDownloadError('Too many redirects while downloading media.');
  }

  private async downloadBuffer(
    url: string,
    maxBytes: number,
    signal: AbortSignal | undefined,
    policy: { allowPrivateHosts?: boolean },
  ): Promise<{ data: Buffer; contentType: string }> {
    const chunks: Buffer[] = [];
    const result = await this.open(url, maxBytes, signal, policy, (chunk) => {
      chunks.push(chunk);
    });
    return { data: Buffer.concat(chunks), contentType: result.contentType };
  }

  private async downloadToFile(
    url: string,
    destination: string,
    maxBytes: number,
    signal: AbortSignal | undefined,
    policy: { allowPrivateHosts?: boolean },
  ): Promise<{ bytes: number; contentType: string }> {
    const handle = await fs.open(destination, 'w');
    try {
      return await this.open(url, maxBytes, signal, policy, async (chunk) => {
        await handle.write(chunk);
      });
    } finally {
      await handle.close();
    }
  }
}

async function extractFrames(
  ffmpegPath: string,
  input: string,
  timestamps: number[],
  width: number,
  directory: string,
): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  for (const [index, timestamp] of timestamps.entries()) {
    const output = path.join(directory, `frame-${index}.jpg`);
    const ok = await runProcess(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(timestamp),
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        `scale=${width}:-2`,
        '-q:v',
        '3',
        '-y',
        output,
      ],
      30_000,
    );
    if (!ok) continue;
    try {
      frames.push(await fs.readFile(output));
    } catch {
      // Missing frame: skip it.
    }
  }
  return frames;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
