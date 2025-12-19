import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simpan file SQLite di root project
const dbPath = path.join(__dirname, '..', 'file_mapping.db');

const db = new Database(dbPath);

db.pragma('foreign_keys = ON');

db.exec(`

  CREATE TABLE IF NOT EXISTS file_mapping (
    driveFileId TEXT PRIMARY KEY,
    b2ObjectKey TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS drive_b2_mapping (
    driveFileId TEXT PRIMARY KEY,
    drivePath TEXT,
    driveFolderId TEXT,
    driveDriveId TEXT,
    b2ObjectKey TEXT NOT NULL,
    b2Prefix TEXT,
    b2CatalogFolderId INTEGER,
    status TEXT DEFAULT 'linked',
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_drive_b2_mapping_b2ObjectKey ON drive_b2_mapping(b2ObjectKey);
  CREATE INDEX IF NOT EXISTS idx_drive_b2_mapping_drivePath ON drive_b2_mapping(drivePath);
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

const upsertDriveB2Stmt = db.prepare(`
  INSERT INTO drive_b2_mapping (
    driveFileId,
    drivePath,
    driveFolderId,
    driveDriveId,
    b2ObjectKey,
    b2Prefix,
    b2CatalogFolderId,
    status,
    createdAt,
    updatedAt
  )
  VALUES (
    @driveFileId,
    @drivePath,
    @driveFolderId,
    @driveDriveId,
    @b2ObjectKey,
    @b2Prefix,
    @b2CatalogFolderId,
    @status,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT(driveFileId) DO UPDATE SET
    drivePath = excluded.drivePath,
    driveFolderId = excluded.driveFolderId,
    driveDriveId = excluded.driveDriveId,
    b2ObjectKey = excluded.b2ObjectKey,
    b2Prefix = excluded.b2Prefix,
    b2CatalogFolderId = excluded.b2CatalogFolderId,
    status = excluded.status,
    updatedAt = CURRENT_TIMESTAMP;
`);

const getDriveB2ByDriveIdStmt = db.prepare(`
  SELECT * FROM drive_b2_mapping WHERE driveFileId = ?;
`);

const getDriveB2ByDrivePathStmt = db.prepare(`
  SELECT * FROM drive_b2_mapping WHERE drivePath = ?;
`);

const getDriveB2ByB2KeyStmt = db.prepare(`
  SELECT * FROM drive_b2_mapping WHERE b2ObjectKey = ?;
`);

export function upsertDriveB2Mapping({
  driveFileId,
  drivePath = null,
  driveFolderId = null,
  driveDriveId = null,
  b2ObjectKey,
  b2Prefix = null,
  b2CatalogFolderId = null,
  status = 'linked',
} = {}) {
  if (!driveFileId || !b2ObjectKey) {
    throw new Error('driveFileId and b2ObjectKey are required for upsertDriveB2Mapping');
  }
  upsertDriveB2Stmt.run({
    driveFileId,
    drivePath,
    driveFolderId,
    driveDriveId,
    b2ObjectKey,
    b2Prefix,
    b2CatalogFolderId,
    status,
  });
}

export function getDriveB2MappingByDriveId(driveFileId) {
  if (!driveFileId) throw new Error('driveFileId is required for getDriveB2MappingByDriveId');
  return getDriveB2ByDriveIdStmt.get(driveFileId);
}

export function getDriveB2MappingByDrivePath(drivePath) {
  if (!drivePath) throw new Error('drivePath is required for getDriveB2MappingByDrivePath');
  return getDriveB2ByDrivePathStmt.get(drivePath);
}

export function getDriveB2MappingByB2ObjectKey(b2ObjectKey) {
  if (!b2ObjectKey) throw new Error('b2ObjectKey is required for getDriveB2MappingByB2ObjectKey');
  return getDriveB2ByB2KeyStmt.get(b2ObjectKey);
}

export { db, dbPath };
