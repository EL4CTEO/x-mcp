# Parity suite

123 cases recorded from the original TypeScript server (v1.0.0) with
[rust-anything](https://github.com/erkamyaman/rust-anything) `app record`, and replayed against the Rust
binary with `app replay`. Each case is one MCP `tools/call` (or a CLI run) over stdio. A local HTTP sink stands in
for api.x.com, answering with the canned payloads in `fixtures/`; the replay compares stdout, stderr, the exit code
and every request the server sends to X (method, URL with query, body).

```sh
cargo build --release
rust-anything app replay tests/parity --build "$PWD/target/release/x-mcp"
```

## Intentional differences

The recording was edited by hand where the original was wrong:

| Cases | Original (v1.0.0) | Now |
| --- | --- | --- |
| `lists-posts`, `posts-quotes`, `posts-reposters`, `users-following`, `users-muted` | The merged group schema applied the **first** action's default to every action (e.g. `quotes` sent `max_results=10` instead of its documented 20). | Each action uses its own documented default. |
| `lists-update-empty` | The same bug filled `private: false`, so an empty update sent `PUT {"private":false}`. | "Provide at least one field to update." and no request. |
| `posts-create-nouser`, `posts-get-401-user`, `posts-get-nocreds`, `tl-home-nouser` | Hints said `npx x-mcp auth` (wrong package name). | `x-mcp auth`. |

Cases where the original rejected arguments before the action ran (wrong types, unknown action, `null` for an
optional field) are not in the suite: they returned SDK-level `MCP error -32602` text, while the Rust server returns
the action's structured `invalid_params` / `invalid_action` error and accepts `null` as "not set". Unit tests cover them.
