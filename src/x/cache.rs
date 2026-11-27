//! TTL + LRU response cache with single-flight coalescing: concurrent
//! identical reads share one upstream request.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use serde_json::Value;

use crate::obj;

struct Entry<V> {
    value: V,
    expires: Instant,
    seq: u64,
}

struct State<V, E> {
    entries: HashMap<String, Entry<V>>,
    order: BTreeMap<u64, String>,
    inflight: HashMap<String, Shared<BoxFuture<'static, Result<V, E>>>>,
    seq: u64,
    hits: u64,
    misses: u64,
    coalesced: u64,
    evictions: u64,
}

pub struct TtlCache<V, E> {
    max: usize,
    state: Mutex<State<V, E>>,
}

impl<V: Clone + Send + Sync + 'static, E: Clone + Send + Sync + 'static> TtlCache<V, E> {
    pub fn new(max: usize) -> Self {
        TtlCache {
            max,
            state: Mutex::new(State {
                entries: HashMap::new(),
                order: BTreeMap::new(),
                inflight: HashMap::new(),
                seq: 0,
                hits: 0,
                misses: 0,
                coalesced: 0,
                evictions: 0,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State<V, E>> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get(&self, key: &str) -> Option<V> {
        let mut s = self.lock();
        let now = Instant::now();
        let Some(entry) = s.entries.get(key) else {
            s.misses += 1;
            return None;
        };
        let (expired, old_seq) = (entry.expires <= now, entry.seq);
        if expired {
            s.entries.remove(key);
            s.order.remove(&old_seq);
            s.misses += 1;
            return None;
        }
        s.seq += 1;
        let seq = s.seq;
        s.order.remove(&old_seq);
        s.order.insert(seq, key.to_owned());
        let entry = s.entries.get_mut(key).expect("present");
        entry.seq = seq;
        let value = entry.value.clone();
        s.hits += 1;
        Some(value)
    }

    pub fn set(&self, key: &str, value: V, ttl_ms: u64) {
        if ttl_ms == 0 {
            return;
        }
        let mut s = self.lock();
        if let Some(old) = s.entries.remove(key) {
            s.order.remove(&old.seq);
        }
        s.seq += 1;
        let seq = s.seq;
        s.order.insert(seq, key.to_owned());
        s.entries.insert(
            key.to_owned(),
            Entry {
                value,
                expires: Instant::now() + Duration::from_millis(ttl_ms),
                seq,
            },
        );
        while s.entries.len() > self.max {
            let Some((&oldest, _)) = s.order.iter().next() else {
                break;
            };
            if let Some(k) = s.order.remove(&oldest) {
                s.entries.remove(&k);
                s.evictions += 1;
            }
        }
    }

    pub fn clear(&self) {
        let mut s = self.lock();
        s.entries.clear();
        s.order.clear();
    }

    pub fn stats(&self) -> serde_json::Map<String, Value> {
        let s = self.lock();
        obj! {
            "hits" => s.hits,
            "misses" => s.misses,
            "coalesced" => s.coalesced,
            "size" => s.entries.len(),
            "evictions" => s.evictions,
        }
    }

    /// Returns the cached value, joins an identical in-flight load, or runs
    /// `load`. The bool says whether the value came from cache (or a join).
    pub async fn get_or_load(
        self: &Arc<Self>,
        key: &str,
        ttl_ms: u64,
        load: BoxFuture<'static, Result<V, E>>,
    ) -> (Result<V, E>, bool) {
        if let Some(value) = self.get(key) {
            return (Ok(value), true);
        }
        let shared = {
            let mut s = self.lock();
            let pending = s.inflight.get(key).cloned();
            if pending.is_some() {
                s.coalesced += 1;
            }
            pending
        };
        if let Some(pending) = shared {
            return (pending.await, true);
        }
        let future = load.shared();
        self.lock().inflight.insert(key.to_owned(), future.clone());
        let result = future.await;
        self.lock().inflight.remove(key);
        if let Ok(value) = &result {
            self.set(key, value.clone(), ttl_ms);
        }
        (result, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lru_evicts_oldest_and_refreshes_on_get() {
        let cache: TtlCache<u32, ()> = TtlCache::new(2);
        cache.set("a", 1, 10_000);
        cache.set("b", 2, 10_000);
        assert_eq!(cache.get("a"), Some(1));
        cache.set("c", 3, 10_000);
        assert_eq!(cache.get("b"), None);
        assert_eq!(cache.get("a"), Some(1));
        assert_eq!(cache.stats()["evictions"], 1);
    }

    #[tokio::test]
    async fn concurrent_loads_coalesce() {
        let cache: Arc<TtlCache<u32, ()>> = Arc::new(TtlCache::new(8));
        let slow = || {
            async {
                tokio::time::sleep(Duration::from_millis(30)).await;
                Ok(7)
            }
            .boxed()
        };
        let (a, b) = tokio::join!(
            cache.get_or_load("k", 1000, slow()),
            cache.get_or_load("k", 1000, slow())
        );
        assert_eq!(a.0, Ok(7));
        assert_eq!(b.0, Ok(7));
        assert_eq!(cache.stats()["coalesced"], 1);
    }
}
