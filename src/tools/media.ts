import { z } from 'zod';
import type { RichToolOutput, ActionTool } from './define.ts';
import { progressReporter } from './define.ts';
import { normalizeTweetSingle } from '../x/normalize.ts';
import { postQuery } from './query.ts';
import { tweetId } from './schemas.ts';

const mediaIdSchema = z.string().regex(/^\d{1,19}$/, 'Media id must be numeric').describe('Media id returned by an upload.');

type Json = Record<string, unknown>;

const categoryEnum = z.enum([
  'tweet_image',
  'tweet_gif',
  'tweet_video',
  'amplify_video',
  'dm_image',
  'dm_gif',
  'dm_video',
  'subtitles',
]);

export const mediaTools: ActionTool[] = [
  {
    action: 'upload',
    name: 'x_upload_media',
    title: 'Upload media',
    description:
      'Upload an image, GIF, video or subtitle file and get a media_id to attach to x_post or x_send_dm. Provide exactly one of path (local file, streamed in 4 MB chunks), base64, or url (downloaded, max 100 MB). Alt text is strongly recommended for accessibility. Videos are processed asynchronously; when wait_for_processing is true (default) the tool polls until X reports success. Requires user auth (OAuth 2.0 media.write, or OAuth 1.0a which uses the legacy upload flow).',
    toolset: 'media',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      path: z.string().min(1).optional().describe('Absolute or workspace-relative path to a local media file.'),
      base64: z.string().min(1).optional().describe('Base64-encoded file contents (no data: prefix).'),
      url: z.string().url().optional().describe('Public https URL to download media from.'),
      media_type: z.string().optional().describe('MIME type, e.g. image/png or video/mp4. Inferred when omitted.'),
      category: categoryEnum.optional().describe('X media category. Inferred from the MIME type when omitted.'),
      filename: z.string().optional().describe('Filename used to infer the MIME type for base64 uploads.'),
      alt_text: z.string().max(1_000).optional().describe('Accessibility description (max 1000 chars).'),
      wait_for_processing: z.boolean().default(true).describe('Poll until video processing finishes.'),
    },
    async handler(args, ctx, extra) {
      const sources = [args.path, args.base64, args.url].filter((value) => value !== undefined);
      if (sources.length !== 1) throw new Error('Provide exactly one of path, base64 or url.');
      const onProgress = progressReporter(extra);
      const result = await ctx.media.upload({
        source: args.path
          ? { kind: 'path', path: args.path }
          : args.base64
            ? { kind: 'buffer', data: Buffer.from(args.base64, 'base64'), filename: args.filename }
            : { kind: 'url', url: args.url as string },
        mediaType: args.media_type,
        category: args.category,
        altText: args.alt_text,
        waitForProcessing: args.wait_for_processing,
        signal: extra.signal,
        onProgress: onProgress
          ? (progress) => onProgress(progress.segment, progress.totalSegments, `Uploaded segment ${progress.segment}/${progress.totalSegments}`)
          : undefined,
      });
      return {
        ...result,
        attach_with: 'Pass media_ids: [media_id] to x_post, or media_id to x_send_dm.',
      };
    },
  },
  {
    action: 'status',
    name: 'x_get_media_status',
    title: 'Check media processing status',
    description:
      'Poll the processing state of an uploaded video or GIF. Requires user auth. Returns pending/in_progress/succeeded/failed plus an error message when processing failed.',
    toolset: 'media',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { media_id: mediaIdSchema },
    async handler(args, ctx, extra) {
      const res = await ctx.x.request<{ processing_info?: Record<string, unknown>; id?: string; media_key?: string }>({
        method: 'GET',
        path: '/2/media/upload',
        query: { command: 'STATUS', media_id: args.media_id },
        auth: 'user',
        cache: false,
        signal: extra.signal,
      });
      return { media_id: args.media_id, ...res.data };
    },
  },
  {
    action: 'view',
    name: 'x_get_media',
    title: 'See images and video frames',
    description:
      'Downloads media attached to a post and returns it as MCP image content, so vision-capable models can actually see pictures instead of only reading URLs. Photos come back directly (up to 4 per post via media_index). Videos and animated GIFs are sampled into evenly spaced JPEG frames when ffmpeg is available (install it, or point X_MCP_FFMPEG at the binary); without ffmpeg the preview frame and the video URL are returned instead, for clients with native video support. Using tweet_id costs one post read; fetching the media itself is not billed by X.',
    toolset: 'media',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      tweet_id: tweetId.optional().describe('Post whose media should be viewed.'),
      url: z.string().url().optional().describe('Direct media URL (image or video) when you already have one.'),
      media_index: z.number().int().min(0).max(3).default(0).describe('Which attachment to view for multi-image posts (0-3).'),
      frames: z.number().int().min(1).max(6).default(3).describe('How many video frames to extract when ffmpeg is available.'),
    },
    async handler(args, ctx, extra): Promise<RichToolOutput> {
      if (!args.tweet_id && !args.url) throw new Error('Provide either tweet_id or url.');

      let sourceUrl: string | undefined = args.url;
      let previewUrl: string | undefined;
      let kind: 'photo' | 'video' | 'animated_gif' | 'auto' = 'auto';
      let durationMs: number | undefined;
      let altText: string | undefined;

      if (args.tweet_id) {
        const res = await ctx.x.request<Json>({
          method: 'GET',
          path: `/2/tweets/${args.tweet_id}`,
          auth: 'auto',
          query: postQuery(),
          signal: extra.signal,
        });
        const tweet = normalizeTweetSingle({ data: res.data, includes: res.includes });
        const media = Array.isArray(tweet?.media) ? (tweet.media as Json[]) : [];
        if (media.length === 0) throw new Error(`Post ${args.tweet_id} has no media attachments.`);
        const item = media[args.media_index];
        if (!item) {
          throw new Error(
            `media_index ${args.media_index} is out of range: post ${args.tweet_id} has ${media.length} attachment(s).`,
          );
        }
        sourceUrl = (item.url as string | undefined) ?? (item.preview_image_url as string | undefined);
        previewUrl = item.preview_image_url as string | undefined;
        const type = item.type;
        kind = type === 'photo' || type === 'video' || type === 'animated_gif' ? type : 'auto';
        durationMs = typeof item.duration_ms === 'number' ? item.duration_ms : undefined;
        altText = item.alt_text as string | undefined;
        if (!sourceUrl) throw new Error('The post media has no downloadable URL.');
      }

      if (!sourceUrl) throw new Error('Provide either tweet_id or url.');

      const view = await ctx.viewer.view({
        url: sourceUrl,
        kind,
        previewUrl,
        durationMs,
        altText,
        frames: args.frames,
        signal: extra.signal,
      });

      const content: RichToolOutput['content'] = view.images.map((image) => ({
        type: 'image',
        data: image.data,
        mimeType: image.mimeType,
      }));

      return {
        content,
        structuredContent: {
          ...(args.tweet_id ? { tweet_id: args.tweet_id, media_index: args.media_index } : {}),
          media: {
            kind: view.kind,
            url: view.source_url,
            alt_text: view.alt_text,
            duration_ms: view.duration_ms,
            preview_url: view.preview_url,
          },
          images: view.images.map((image) => ({ label: image.label, mimeType: image.mimeType, bytes: image.bytes })),
          ffmpeg: view.ffmpeg,
          notes: view.notes,
          hint:
            view.images.length === 0 && !view.ffmpeg
              ? 'Install ffmpeg to extract video frames, or pass a photo URL instead.'
              : undefined,
        },
      };
    },
  },
];
