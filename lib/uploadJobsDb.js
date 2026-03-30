import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, '..', 'upload_jobs.db');
const db = new Database(dbPath);

db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS upload_jobs (
    id TEXT PRIMARY KEY,
    prefix TEXT,
    status TEXT,
    current TEXT,
    done INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    percent INTEGER DEFAULT 0,
    error TEXT,
    created_at_ms INTEGER,
    updated_at_ms INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_upload_jobs_prefix ON upload_jobs(prefix);
  CREATE INDEX IF NOT EXISTS idx_upload_jobs_updated ON upload_jobs(updated_at_ms);
`);

const upsertJobStmt = db.prepare(`
  INSERT INTO upload_jobs (
    id, prefix, status, current, done, total, percent, error, created_at_ms, updated_at_ms
  ) VALUES (
    @id, @prefix, @status, @current, @done, @total, @percent, @error, @created_at_ms, @updated_at_ms
  )
  ON CONFLICT(id) DO UPDATE SET
    prefix = COALESCE(excluded.prefix, upload_jobs.prefix),
    status = COALESCE(excluded.status, upload_jobs.status),
    current = COALESCE(excluded.current, upload_jobs.current),
    done = COALESCE(excluded.done, upload_jobs.done),
    total = COALESCE(excluded.total, upload_jobs.total),
    percent = COALESCE(excluded.percent, upload_jobs.percent),
    error = COALESCE(excluded.error, upload_jobs.error),
    updated_at_ms = excluded.updated_at_ms;
`);

const getJobByIdStmt = db.prepare(`SELECT * FROM upload_jobs WHERE id = ?;`);
const getJobByPrefixStmt = db.prepare(`SELECT * FROM upload_jobs WHERE prefix = ? ORDER BY updated_at_ms DESC LIMIT 1;`);

const deleteJobByIdStmt = db.prepare(`DELETE FROM upload_jobs WHERE id = ?;`);
const clearAllJobsStmt = db.prepare(`DELETE FROM upload_jobs;`);

const listJobsAllStmt = db.prepare(`
  SELECT *
  FROM upload_jobs
  ORDER BY updated_at_ms DESC
  LIMIT ?;
`);

const listJobsActiveStmt = db.prepare(`
  SELECT *
  FROM upload_jobs
  WHERE status NOT IN ('done', 'error', 'partial')
  ORDER BY updated_at_ms DESC
  LIMIT ?;
`);

const g = typeof globalThis !== 'undefined' ? globalThis : global;
if (!g.__uploadJobsLastWrite) g.__uploadJobsLastWrite = new Map();
const lastWrite = g.__uploadJobsLastWrite;

export function upsertJob(job) {
  const now = Date.now();
  const payload = {
    id: job?.id,
    prefix: job?.prefix ?? null,
    status: job?.status ?? null,
    current: job?.current ?? null,
    done: Number.isFinite(Number(job?.done)) ? Number(job.done) : null,
    total: Number.isFinite(Number(job?.total)) ? Number(job.total) : null,
    percent: Number.isFinite(Number(job?.percent)) ? Number(job.percent) : null,
    error: job?.error ?? null,
    created_at_ms: Number.isFinite(Number(job?.created_at_ms)) ? Number(job.created_at_ms) : now,
    updated_at_ms: now,
  };
  if (!payload.id) throw new Error('id is required for upsertJob');
  upsertJobStmt.run(payload);
  lastWrite.set(payload.id, { at: now, percent: payload.percent });
  return getJobById(payload.id);
}

export function getJobById(id) {
  if (!id) return null;
  return getJobByIdStmt.get(id) || null;
}

export function getJobByPrefix(prefix) {
  if (!prefix) return null;
  return getJobByPrefixStmt.get(prefix) || null;
}

export function deleteJobById(id) {
  if (!id) return;
  deleteJobByIdStmt.run(id);
  try {
    lastWrite.delete(id);
  } catch {
  }
}

export function clearAllJobs() {
  clearAllJobsStmt.run();
  try {
    lastWrite.clear();
  } catch {
  }
}

export function updateJobThrottled(id, patch, { minIntervalMs = 1500, minPercentDelta = 1 } = {}) {
  if (!id) return null;
  const now = Date.now();
  const prev = lastWrite.get(id);
  const newPercent = patch && patch.percent != null ? Number(patch.percent) : null;
  const prevPercent = prev && prev.percent != null ? Number(prev.percent) : null;
  const pctDelta = newPercent != null && prevPercent != null ? Math.abs(newPercent - prevPercent) : null;

  const tooSoon = prev?.at != null && now - prev.at < minIntervalMs;
  const tooSmall = pctDelta != null && pctDelta < minPercentDelta;

  if (tooSoon && tooSmall) {
    return getJobById(id);
  }

  return upsertJob({ id, ...patch, created_at_ms: getJobById(id)?.created_at_ms ?? now });
}

export function listJobs({ activeOnly = false, limit = 50 } = {}) {
  const lim = (() => {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return 50;
    return Math.min(Math.trunc(n), 200);
  })();
  if (activeOnly) return listJobsActiveStmt.all(lim);
  return listJobsAllStmt.all(lim);
}

export { db, dbPath };
