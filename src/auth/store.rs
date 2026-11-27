//! Tokens live outside the repository in a 0600 JSON file. Environment
//! variables always win; the file lets `x-mcp auth` hand a refreshed,
//! long-lived session to the server.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredOAuth2 {
    pub client_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    pub access_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scopes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redirect_uri: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredFile {
    version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    oauth2: Option<StoredOAuth2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
}

pub struct CredentialStore {
    pub file: PathBuf,
    cached: Mutex<Option<Option<StoredOAuth2>>>,
}

impl CredentialStore {
    pub fn new(file: &Path) -> Self {
        CredentialStore {
            file: file.to_path_buf(),
            cached: Mutex::new(None),
        }
    }

    pub fn oauth2(&self) -> Option<StoredOAuth2> {
        let mut cached = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(value) = cached.as_ref() {
            return value.clone();
        }
        let value = self.read();
        *cached = Some(value.clone());
        value
    }

    fn read(&self) -> Option<StoredOAuth2> {
        let raw = match std::fs::read_to_string(&self.file) {
            Ok(raw) => raw,
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound {
                    crate::warn!("could not read credential file", "file" => self.file.display().to_string(), "err" => error.to_string());
                }
                return None;
            }
        };
        match serde_json::from_str::<StoredFile>(&raw) {
            Ok(parsed) if parsed.version == 1 => parsed.oauth2,
            _ => {
                let backup = format!("{}.corrupt-{}", self.file.display(), crate::util::now_ms());
                match std::fs::rename(&self.file, &backup) {
                    Ok(()) => {
                        crate::warn!("corrupt credential file moved aside", "file" => self.file.display().to_string(), "backup" => backup)
                    }
                    Err(_) => {
                        crate::warn!("corrupt credential file ignored", "file" => self.file.display().to_string())
                    }
                }
                None
            }
        }
    }

    pub fn save(&self, value: StoredOAuth2) -> std::io::Result<()> {
        let file = StoredFile {
            version: 1,
            oauth2: Some(value.clone()),
            updated_at: Some(crate::util::iso_now()),
        };
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self
            .file
            .with_extension(format!("json.{}.tmp", std::process::id()));
        let mut text = serde_json::to_string_pretty(&file).unwrap_or_default();
        text.push('\n');
        write_private(&tmp, text.as_bytes())?;
        std::fs::rename(&tmp, &self.file)?;
        *self.cached.lock().unwrap_or_else(|e| e.into_inner()) = Some(Some(value));
        Ok(())
    }

    pub fn clear(&self) {
        if let Err(error) = std::fs::remove_file(&self.file)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            crate::warn!("could not remove credential file", "file" => self.file.display().to_string(), "err" => error.to_string());
        }
        *self.cached.lock().unwrap_or_else(|e| e.into_inner()) = Some(None);
    }
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_moves_corrupt_files_aside() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("credentials.json");
        let store = CredentialStore::new(&file);
        assert!(store.oauth2().is_none());
        let value = StoredOAuth2 {
            client_id: "c".into(),
            access_token: "a".into(),
            refresh_token: Some("r".into()),
            ..Default::default()
        };
        store.save(value.clone()).unwrap();
        assert_eq!(CredentialStore::new(&file).oauth2(), Some(value));

        std::fs::write(&file, "{not json").unwrap();
        assert!(CredentialStore::new(&file).oauth2().is_none());
        assert!(!file.exists());
    }
}
