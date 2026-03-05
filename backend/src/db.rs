/// SQLite persistence layer for completed traces.

use std::path::Path;
use std::sync::Mutex;

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::state::{SpanEvent, TraceComplete};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceBounds {
    pub min_started_at: i64,
    pub max_started_at: i64,
    pub count: i64,
}

pub struct Db {
    conn: Mutex<Connection>,
}

// rusqlite::Connection is Send, so Db is Send + Sync via Mutex.
unsafe impl Send for Db {}
unsafe impl Sync for Db {}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS traces (
                 trace_id       TEXT PRIMARY KEY,
                 root_span_name TEXT NOT NULL,
                 duration_ms    REAL NOT NULL,
                 started_at     INTEGER NOT NULL,
                 spans_json     TEXT NOT NULL,
                 service_name   TEXT NOT NULL DEFAULT '',
                 instance_id    TEXT NOT NULL DEFAULT ''
             );
             CREATE INDEX IF NOT EXISTS idx_started_at ON traces(started_at);
             CREATE INDEX IF NOT EXISTS idx_service_name ON traces(service_name);",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn insert_trace(
        &self,
        trace: &TraceComplete,
        service_name: &str,
        instance_id: &str,
    ) -> Result<()> {
        let spans_json = serde_json::to_string(&trace.spans)?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO traces \
             (trace_id, root_span_name, duration_ms, started_at, spans_json, service_name, instance_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                trace.trace_id,
                trace.root_span_name,
                trace.duration_ms,
                trace.started_at as i64,
                spans_json,
                service_name,
                instance_id,
            ],
        )?;
        Ok(())
    }

    pub fn query_traces(
        &self,
        from_ns: i64,
        to_ns: i64,
        limit: usize,
        service: Option<&str>,
        min_duration_ms: Option<f64>,
        max_duration_ms: Option<f64>,
    ) -> Result<Vec<TraceComplete>> {
        let conn = self.conn.lock().unwrap();

        // Build the query dynamically based on which optional filters are set.
        let mut sql = String::from(
            "SELECT trace_id, root_span_name, duration_ms, started_at, spans_json, instance_id \
             FROM traces \
             WHERE started_at >= ?1 AND started_at <= ?2",
        );
        if service.is_some() {
            sql.push_str(" AND service_name LIKE ?4");
        }
        if min_duration_ms.is_some() {
            let pos = if service.is_some() { 5 } else { 4 };
            sql.push_str(&format!(" AND duration_ms >= ?{pos}"));
        }
        if max_duration_ms.is_some() {
            let pos = match (service.is_some(), min_duration_ms.is_some()) {
                (true,  true)  => 6,
                (true,  false) => 5,
                (false, true)  => 5,
                (false, false) => 4,
            };
            sql.push_str(&format!(" AND duration_ms <= ?{pos}"));
        }
        sql.push_str(" ORDER BY started_at ASC LIMIT ?3");

        let mut stmt = conn.prepare(&sql)?;

        // Bind positional params. rusqlite requires known-at-compile-time slice
        // lengths, so we build a Vec<Box<dyn rusqlite::ToSql>>.
        let service_pattern = service.map(|s| format!("%{s}%"));
        let mut extra: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(ref pat) = service_pattern { extra.push(Box::new(pat.clone())); }
        if let Some(v) = min_duration_ms      { extra.push(Box::new(v)); }
        if let Some(v) = max_duration_ms      { extra.push(Box::new(v)); }

        let base: [&dyn rusqlite::ToSql; 3] = [&from_ns, &to_ns, &(limit as i64)];
        let extra_refs: Vec<&dyn rusqlite::ToSql> = extra.iter().map(|b| b.as_ref()).collect();
        let all_params: Vec<&dyn rusqlite::ToSql> =
            base.iter().copied().chain(extra_refs).collect();

        let rows = stmt.query_map(all_params.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;
        let mut traces = Vec::new();
        for row in rows {
            let (trace_id, root_span_name, duration_ms, started_at, spans_json, instance_id) = row?;
            let spans: Vec<SpanEvent> =
                serde_json::from_str(&spans_json).unwrap_or_default();
            traces.push(TraceComplete {
                trace_id,
                spans,
                root_span_name,
                duration_ms,
                started_at: started_at as u64,
                instance_id,
            });
        }
        Ok(traces)
    }

    pub fn get_bounds(&self) -> Result<Option<TraceBounds>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT MIN(started_at), MAX(started_at), COUNT(*) FROM traces")?;
        let (min, max, count): (Option<i64>, Option<i64>, i64) =
            stmt.query_row([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        match (min, max) {
            (Some(min), Some(max)) => Ok(Some(TraceBounds {
                min_started_at: min,
                max_started_at: max,
                count,
            })),
            _ => Ok(None),
        }
    }

    /// Delete all traces whose `started_at` is older than `older_than_ns` (nanoseconds).
    /// Returns the number of rows deleted.
    pub fn prune(&self, older_than_ns: i64) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "DELETE FROM traces WHERE started_at < ?1",
            params![older_than_ns],
        )?;
        Ok(n)
    }
}
