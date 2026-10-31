<p align="center">
  <img src="assets/logo.png" alt="x-mcp logo" width="150">
</p>

<h1 align="center">x-mcp</h1>

<p align="center">MCP server for X (Twitter) — 10 tools, 69 actions.</p>

An MCP server that gives AI agents real access to X: read and search posts, publish threads, upload media, manage Lists, send DMs — and actually **see images and video frames**.

Works with any MCP client (Claude Desktop, Cursor, Codex, custom agents) over stdio or HTTP.

## What you can do

- **Research** — search posts, read timelines and threads, look up users, trends and engagement.
- **Publish** — post, reply, quote, publish threads, upload photos/videos with alt text.
- **Engage** — like, repost, bookmark, follow, mute, and manage Lists.
- **Message** — read and send Direct Messages.
- **See media** — return actual image bytes to vision models, or extract video frames.
- **Stay safe** — read-only and dry-run modes, plus confirmation prompts for public actions.

## Install

Requires **Node.js 22.18+**.

```bash
npm install
npm run build
```

Add the server to your MCP client. For Claude Desktop / Cursor:

```json
{
  "mcpServers": {
    "x": {
      "command": "node",
      "args": ["/absolute/path/to/x-mcp-server/dist/index.mjs"],
      "env": {
        "X_BEARER_TOKEN": "your-app-only-bearer-token"
      }
    }
  }
}
```

Restart the client. The `x_*` tools should appear.

## Sign in

**Read-only (public data)** — put your app-only bearer token in `X_BEARER_TOKEN`. That's it.

**Full access (posting, DMs, bookmarks)** — authorize once:

```bash
node dist/index.mjs auth --client-id YOUR_OAUTH2_CLIENT_ID
```

In the X developer portal, set the callback URL to `http://127.0.0.1:8787/callback` and enable OAuth 2.0. The wizard opens a browser, stores tokens in `~/.config/x-mcp/credentials.json` (owner-only permissions), and refreshes them automatically.

Add extra scopes when you need DMs, Lists or follows:

```bash
node dist/index.mjs auth --client-id YOUR_ID \
  --scopes "tweet.read tweet.write users.read dm.read dm.write list.read list.write offline.access"
```

Classic OAuth 1.0a keys (`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`) are also supported.

## How the tools are grouped

Instead of 69 separate tools, there are **10 tools with 69 actions**. Every call takes an `action` plus that action's parameters:

```json
{ "action": "search", "query": "mcp -is:retweet", "max_results": 20 }
```

The tool description lists its actions, and the input schema completes the parameters. This keeps the agent's tool list short and the choice obvious.

| Tool | Actions |
| --- | --- |
| **x_posts** | `create` `create_thread` `delete` `get` `get_many` `search` `count` `thread` `likers` `reposters` `quotes` `hide_reply` |
| **x_timelines** | `home` `user` `mentions` `liked` `bookmarks` |
| **x_users** | `me` `get` `get_many` `search` `followers` `following` `follow` `unfollow` `mute` `unmute` `block` `unblock` `muted` `blocked` |
| **x_engagement** | `like` `unlike` `repost` `unrepost` `bookmark` `unbookmark` |
| **x_lists** | `create` `update` `delete` `get` `owned` `memberships` `pinned` `add_member` `remove_member` `posts` `members` `followers` `follow` `unfollow` |
| **x_spaces** | `search` `get` `get_many` `posts` |
| **x_trends** | `by_location` `personalized` |
| **x_dms** | `send` `send_to_conversation` `events` `conversation` `with_user` `delete` |
| **x_media** | `upload` `status` `view` |
| **x_meta** | `auth_status` `rate_limits` `usage` |

Run `node dist/index.mjs tools` to list them with descriptions.

## Images and video frames

Text alone can't see a picture. `x_media` with action `view` downloads the post's media and returns it as **MCP image content**, so any vision-capable model can look at it.

- **Photos** come back directly, including alt text.
- **Videos and GIFs** are sampled into evenly spaced frames — but only if **ffmpeg** is installed. Without it, the server returns the preview frame plus the video URL.
- Carousels: pass `tweet_id` and `media_index` (0–3).

Install ffmpeg (optional, recommended for video):

| Platform | Command |
| --- | --- |
| Windows | `winget install Gyan.FFmpeg` |
| macOS | `brew install ffmpeg` |
| Linux | `sudo apt install ffmpeg` |

If ffmpeg lives somewhere unusual, set `X_MCP_FFMPEG=/path/to/ffmpeg`.

Limits: 15 MB per image, 200 MB per video by default (`X_MCP_MAX_IMAGE_MB`, `X_MCP_MAX_VIDEO_MB`). Media downloads reject private/local addresses.

## Try asking

- "What did @naval post this week? Show me the three best-performing posts."
- "Summarize this thread and list the open questions: https://x.com/…/status/123…"
- "Look at the image in this post and describe what's in it."
- "Draft a five-post thread about MCP servers. Show me the draft before publishing."
- "Check my mentions from today and draft replies to the questions."

The built-in prompts (`draft_thread`, `reply_triage`, `account_report`, `summarize_conversation`) walk the agent through these workflows.

## Commands

```bash
node dist/index.mjs                 # start on stdio
node dist/index.mjs serve --http    # start on http://127.0.0.1:3333/mcp
node dist/index.mjs doctor          # check credentials, connection and settings
node dist/index.mjs tools           # list tools and actions
node dist/index.mjs auth --logout   # remove saved tokens
```

## Common settings

| Variable | Default | What it does |
| --- | --- | --- |
| `X_BEARER_TOKEN` | — | App-only token for public reads |
| `X_OAUTH2_CLIENT_ID` | — | OAuth 2.0 client id |
| `X_MCP_READ_ONLY` | `false` | Block all posting, liking, DMs, etc. |
| `X_MCP_DRY_RUN` | `false` | Show what would be posted, without posting |
| `X_MCP_FFMPEG` | auto-detected | ffmpeg binary for video frames |
| `X_MCP_TOOLSETS` | all | Only expose some tools, e.g. `posts,users` |
| `X_MCP_CACHE` | `on` | Cache repeated reads for 30 s |
| `X_MCP_HTTP_PORT` | `3333` | Port for HTTP mode |
| `X_MCP_LOG_LEVEL` | `info` | `debug` while troubleshooting |

See [`.env.example`](./.env.example) for the full list, including proxies, timeouts and rate-limit behaviour.

## Safety notes

- Use `--read-only` for research-only agents.
- Use `--dry-run` to preview every write before enabling it.
- Writes and DMs are visible to real people. The server's instructions tell agents to confirm before publishing.
- Local media uploads are restricted to image/video extensions, and remote media downloads reject private network addresses.
- Keep the HTTP server on `127.0.0.1` unless you add authentication in front of it.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `401` / `403` | Call `x_meta` with action `auth_status`. Re-run `auth`, or add the missing scope. |
| `429` | Rate limit; the server waits by default. See `x_meta` action `rate_limits`, or set `X_MCP_RATE_LIMIT_MODE=fail`. |
| “Unknown action” | Read the tool description; actions are case-sensitive. |
| Video returns only a preview | Install ffmpeg, or use the video URL with a video-capable client. |
| Tools missing | Check `X_MCP_TOOLSETS` / `X_MCP_DISABLE_TOOLSETS`. |
| HTTP client says session not found | Sessions expire after 30 idle minutes; reconnect. |

## Development

```bash
npm run typecheck
npm test          # 79 tests, no X credentials or network needed
npm run build
```

Built with TypeScript 7, the official MCP SDK, Zod 4, undici and Vitest. Source lives in `src/`; each domain has an action module in `src/tools/`, and the grouped tools are assembled in `src/tools/index.ts`.

## License

MIT — see [LICENSE](./LICENSE).
