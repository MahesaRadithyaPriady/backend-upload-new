import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simpan file SQLite di root project
const dbPath = path.join(__dirname, '..', 'file_mapping.db');

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS file_mapping (
    driveFileId TEXT PRIMARY KEY,
    b2ObjectKey TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

const upsertStmt = db.prepare(`
  INSERT INTO file_mapping (driveFileId, b2ObjectKey, status, createdAt, updatedAt)
  VALUES (@driveFileId, @b2ObjectKey, @status, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT(driveFileId) DO UPDATE SET
    b2ObjectKey = excluded.b2ObjectKey,
    status = excluded.status,
    updatedAt = CURRENT_TIMESTAMP;
`);

const getByDriveIdStmt = db.prepare(`
  SELECT * FROM file_mapping WHERE driveFileId = ?;
`);

export function upsertFileMapping(driveFileId, b2ObjectKey, status = 'migrated') {
  upsertStmt.run({ driveFileId, b2ObjectKey, status });
}

export function getFileMapping(driveFileId) {
  return getByDriveIdStmt.get(driveFileId);
}

export { db, dbPath };
