//! stdio transport: newline-delimited JSON-RPC on stdin/stdout.

use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use super::server::{Server, error};

pub async fn serve(server: Arc<Server>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = rx.recv().await {
            let mut line = serde_json::to_string(&message).unwrap_or_default();
            line.push('\n');
            if stdout.write_all(line.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut pending = vec![];
    loop {
        let line = tokio::select! {
            line = lines.next_line() => line,
            _ = shutdown_signal() => break,
        };
        let Ok(Some(line)) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(Value::Array(batch)) => {
                for message in batch {
                    pending.extend(server.dispatch(message, tx.clone()));
                }
            }
            Ok(message) => pending.extend(server.dispatch(message, tx.clone())),
            Err(_) => {
                let _ = tx.send(error(Value::Null, -32700, "Parse error"));
            }
        }
        pending.retain(|h: &tokio::task::JoinHandle<()>| !h.is_finished());
    }
    // stdin closed: finish what is in flight, then flush and exit.
    for handle in pending {
        let _ = handle.await;
    }
    drop(tx);
    let _ = writer.await;
}

pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("sigterm");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
