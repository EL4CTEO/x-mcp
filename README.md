<p align="center">
  <img src="https://raw.githubusercontent.com/EL4CTEO/x-mcp/main/assets/logo.svg" alt="x-mcp" width="120">
</p>

<h1 align="center">x-mcp</h1>

<p align="center">MCP server for X (Twitter). 10 tools, 69 actions, one native binary.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@el4cteo/x-mcp"><img src="https://img.shields.io/npm/v/@el4cteo/x-mcp?style=flat&colorA=0e0e10&colorB=f26a1b&label=npm" alt="npm"></a>
  <a href="https://crates.io/crates/x-twitter-mcp"><img src="https://img.shields.io/crates/v/x-twitter-mcp?style=flat&colorA=0e0e10&colorB=f26a1b&label=crates.io" alt="crates.io"></a>
  <a href="https://github.com/EL4CTEO/x-mcp/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/EL4CTEO/x-mcp/ci.yml?style=flat&colorA=0e0e10&label=ci" alt="ci"></a>
</p>

Give AI agents X: read and search posts, publish threads, upload media, manage Lists, send DMs, and actually *see* images and video frames.

Written in Rust. Compared with the previous Node.js version, on the same machine (median of 15 cold starts to a `tools/list` reply):

| | Node.js 1.x | Rust 2.x |
| --- | ---: | ---: |
| Start-up to `tools/list` | 451 ms | **9 ms** |
| Peak memory | 81.7 MB | **7.0 MB** |
| Install size | 112 MB `node_modules` | **4 MB** binary |

Behaviour is checked against the original: [123 recorded cases](tests/parity) replay byte-for-byte, including every request sent to X.

## Install

```json
{
  "mcpServers": {
    "x": {
      "command": "npx",
      "args": ["-y", "@el4cteo/x-mcp"],
      "env": { "X_BEARER_TOKEN": "..." }
    }
  }
}
```

Works in Claude Desktop, Claude Code, Cursor, Codex and any MCP client. Other ways to get the binary:

```bash
npm i -g @el4cteo/x-mcp        # prebuilt binary, no Node runtime needed at run time
cargo install x-twitter-mcp    # build from source; installs `x-mcp`
```

Or download an archive from [Releases](https://github.com/EL4CTEO/x-mcp/releases) (Windows, macOS, Linux; x64 and arm64) and point `command` at `x-mcp`.

## Sign in

- **Public reads**: set `X_BEARER_TOKEN`.
- **Posting, DMs, bookmarks**: run `x-mcp auth --client-id YOUR_OAUTH2_CLIENT_ID` and approve in the browser.

Set the X app callback to `http://127.0.0.1:8787/callback`. Tokens go to `~/.config/x-mcp/credentials.json` (mode 0600) and refresh automatically; rotated refresh tokens are saved. OAuth 1.0a keys (`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`) work too.

## Tools

Each tool takes an `action` plus that action's parameters:

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

Also: resources (`x://me`, `x://users/{username}`, `x://posts/{id}`, `x://lists/{id}`, `x://rate-limits`, `x://usage`) and prompts (`draft_thread`, `reply_triage`, `account_report`, `summarize_conversation`). `x-mcp tools` lists every action.

## See images and video

`x_media` action `view` returns a post's media as MCP image content. Photos come back directly (`media_index` 0–3 for carousels). Videos and GIFs are sampled into 1–6 JPEG frames when [ffmpeg](https://ffmpeg.org) is installed (`winget install Gyan.FFmpeg`, `brew install ffmpeg`, `apt install ffmpeg`, or set `X_MCP_FFMPEG`); without it you get the preview frame and the video URL.

## Commands

```bash
x-mcp                        # stdio (default)
x-mcp serve --http [port]    # Streamable HTTP at http://127.0.0.1:3333/mcp
x-mcp doctor                 # credentials, ffmpeg and connectivity check
x-mcp tools [--json]         # list tools and actions
x-mcp auth --logout          # remove stored tokens
```

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `X_BEARER_TOKEN` | — | App-only token for public reads |
| `X_MCP_READ_ONLY` | `false` | Refuse every write |
| `X_MCP_DRY_RUN` | `false` | Return the requests a write would send, without sending |
| `X_MCP_TOOLSETS` / `X_MCP_DISABLE_TOOLSETS` | all / none | Expose only some tools, e.g. `posts,users` |
| `X_MCP_MEDIA_ROOTS` | cwd | Directories allowed for path uploads |
| `X_MCP_RATE_LIMIT_MODE` | `wait` | `wait` for the window to reset, or `fail` fast |
| `X_MCP_HTTP_TOKEN` | — | Bearer token for HTTP mode (required off-loopback) |

Full list in [`.env.example`](.env.example); a `.env` in the working directory is read too.

## Safety

- `--read-only` for research agents, `--dry-run` to preview writes.
- Uploads only read real media files inside allowed roots; media downloads require https and reject private, loopback and link-local addresses, re-checked on every redirect.
- HTTP mode binds to loopback by default, checks the Host header against DNS rebinding, compares tokens in constant time, and never reflects arbitrary CORS origins.
- Posting and DMs reach real people; the server instructs agents to confirm first.

## How it is built

```
src/
  main.rs            CLI: serve, auth, doctor, tools
  mcp/               JSON-RPC dispatcher, stdio and Streamable HTTP transports, prompts, resources
  tools/             one file per toolset; schema.rs declares each parameter once and derives
                     validation, defaults and the JSON Schema from it
  x/                 X client: auth selection, single-flight TTL/LRU cache, rate-limit windows,
                     retries, normalisation, chunked media upload, ffmpeg frame sampling
  auth/              OAuth 2.0 PKCE + refresh (one refresh across concurrent calls), OAuth 1.0a
                     signing, 0600 credential store
tests/mcp.rs         end-to-end: stdio, HTTP sessions, OAuth refresh after 401, upload and view
tests/parity/        123 cases recorded from the Node.js original, replayed with rust-anything
```

```bash
cargo test                                                        # no X credentials needed
rust-anything app replay tests/parity --build target/release/x-mcp
```

MIT. See [LICENSE](LICENSE).
