//! Credentials: OAuth 1.0a signing, OAuth 2.0 PKCE + refresh, the token
//! file and the interactive `x-mcp auth` login.

pub mod login;
pub mod manager;
pub mod oauth1;
pub mod oauth2;
pub mod store;
