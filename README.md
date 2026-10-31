<p align="center">
  <img src="assets/logo.png" alt="x-mcp logo" width="140">
</p>

<h1 align="center">x-mcp</h1>

<p align="center">MCP server for X (Twitter) — 10 tools, 69 actions.</p>

Give AI agents access to X: read and search posts, publish threads, upload media, manage Lists, send DMs, and see images and video frames.

## Install

Requires Node.js 22.18+.

```bash
npm install
npm run build
```

Add it to your MCP client (Claude Desktop, Cursor, Codex, custom agents):

```json
{
  "mcpServers": {
    "x": {
      "command": "node",
      "args": ["/absolute/path/to/x-mcp/dist/index.mjs"],
      "env": { "X_BEARER_TOKEN": "..." }
    }
  }
}
```

Once published to npm: `{ "command": "npx", "args": ["-y", "x-mcp"] }`.

## Sign in

- **Public reads** — set `X_BEARER_TOKEN`.
- **Posting, DMs, bookmarks** — run:

```bash
node dist/index.mjs auth --client-id YOUR_OAUTH2_CLIENT_ID
```

Set the X app callback to `http://127.0.0.1:8787/callback`. Tokens are stored in `~/.config/x-mcp/credentials.json` and refreshed automatically. OAuth 1.0a keys (`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`) also work.

## Tools

Ten tools. Each call takes an `action` plus that action's parameters:

```json
{ "action": "search", "query": "mcp -is:retweet", "max_results": 20 }
```

| Tool | Actions |
| --- | --- |
| `x_posts` | create, create_thread, delete, get, get_many, search, count, thread, likers, reposters, quotes, hide_reply |
| `x_timelines` | home, user, mentions, liked, bookmarks |
| `x_users` | me, get, get_many, search, followers, following, follow, unfollow, mute, unmute, block, unblock, muted, blocked |
| `x_engagement` | like, unlike, repost, unrepost, bookmark, unbookmark |
| `x_lists` | create, update, delete, get, owned, memberships, pinned, add_member, remove_member, posts, members, followers, follow, unfollow |
| `x_spaces` | search, get, get_many, posts |
| `x_trends` | by_location, personalized |
| `x_dms` | send, send_to_conversation, events, conversation, with_user, delete |
| `x_media` | upload, status, view |
| `x_meta` | auth_status, rate_limits, usage |

Run `node dist/index.mjs tools` for descriptions.

## See images and video

`x_media` action `view` returns the post's media as MCP image content.

- Photos come back directly; carousels use `media_index` (0–3).
- Videos and GIFs are sampled into 1–6 frames when **ffmpeg** is installed.
- Without ffmpeg you get the preview frame plus the video URL.

Install ffmpeg: `winget install Gyan.FFmpeg` (Windows), `brew install ffmpeg` (macOS), `sudo apt install ffmpeg` (Linux). Or set `X_MCP_FFMPEG`.

Limit: 15 MB per image, 200 MB per video; raise with `X_MCP_MAX_IMAGE_MB` / `X_MCP_MAX_VIDEO_MB`.

## Commands

```bash
node dist/index.mjs                 # stdio
node dist/index.mjs serve --http    # http://127.0.0.1:3333/mcp
node dist/index.mjs doctor          # credentials + connection check
node dist/index.mjs auth --logout   # remove tokens
```

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `X_BEARER_TOKEN` | — | App-only token for public reads |
| `X_MCP_READ_ONLY` | `false` | Block all writes |
| `X_MCP_DRY_RUN` | `false` | Preview writes without sending |
| `X_MCP_TOOLSETS` | all | Expose only some tools, e.g. `posts,users` |
| `X_MCP_MEDIA_ROOTS` | cwd | Directories allowed for uploads |
| `X_MCP_HTTP_TOKEN` | — | Bearer token for HTTP mode |

Full list in [`.env.example`](./.env.example).

## Safety

- `--read-only` for research-only agents, `--dry-run` to preview writes.
- Media downloads reject private addresses; uploads are restricted to media files in allowed roots.
- HTTP mode binds to loopback by default and requires a token off-loopback.
- Posts and DMs are public or permanent — agents are instructed to confirm first.

## Development

```bash
npm run typecheck
npm test     # 85 tests, no X credentials needed
npm run build
```

MIT — see [LICENSE](./LICENSE).
