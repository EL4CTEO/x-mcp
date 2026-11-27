# Changelog

## 2.0.0

- Rewritten in Rust: one native binary, 9 ms start-up (was 451 ms) and 7 MB RAM (was 82 MB); no Node.js runtime needed.
- Same 10 tools and 69 actions; 123 recorded cases from 1.0.0 replay identically (rust-anything).
- Fixed: actions sharing a parameter used the first action's default (`quotes` asked for 10 instead of 20, `muted` for 20 instead of 50, empty `lists update` sent `private:false`).
- Fixed: `x-mcp auth` opened the wrong authorize URL; it now uses `x.com/i/oauth2/authorize`.
- Fixed: `X_UPLOAD_BASE` was ignored; uploads now honour it.
- Cleaner tool schemas: one property per parameter with per-action ranges, instead of duplicated `anyOf` lists.
- Invalid arguments return a structured `invalid_params` error from the action; `null` counts as "not set".
- HTTP transport: JSON or SSE replies, progress streaming for uploads, DNS-rebinding check.
- Published as prebuilt binaries on npm (`@el4cteo/x-mcp`), crates.io (`x-twitter-mcp`) and GitHub Releases.
- New logo.

## 1.0.0

- First release (TypeScript).
