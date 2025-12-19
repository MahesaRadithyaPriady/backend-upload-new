import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simpan katalog folder & file di SQLite terpisah
const dbPath = path.join(__dirname, '..', 'storage_catalog.db');

const db = new Database(dbPath);

db.pragma('foreign_keys = ON');

// Tabel folders
// - id         : INTEGER PRIMARY KEY AUTOINCREMENT
// - name       : nama folder (segmen terakhir)
// - prefix     : path prefix B2 (contoh: 'A/', 'A/sub/', 'B/')
// - parent_id  : id folder parent (NULL jika root)
// - file_count : jumlah file langsung di folder ini (opsional)
// - created_at : timestamp
// - updated_at : timestamp

// Tabel files
// - id          : INTEGER PRIMARY KEY AUTOINCREMENT
// - folder_id   : FOREIGN KEY ke folders.id
// - file_name   : nama file untuk UI (basename)
// - file_path   : full path di B2 (fileName)
// - size        : ukuran byte
// - content_type: MIME type
// - uploaded_at : timestamp

db.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL UNIQUE,
    parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    file_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    size INTEGER DEFAULT 0,
    content_type TEXT DEFAULT 'application/octet-stream',
    uploaded_at TEXT DEFAULT (datetime('now'))
  );
`);

const upsertFolderStmt = db.prepare(`
  INSERT INTO folders (name, prefix, parent_id, file_count, created_at, updated_at)
  VALUES (@name, @prefix, @parent_id, @file_count, datetime('now'), datetime('now'))
  ON CONFLICT(prefix) DO UPDATE SET
    name = excluded.name,
    parent_id = excluded.parent_id,
    file_count = COALESCE(excluded.file_count, folders.file_count),
    updated_at = datetime('now');
`);

const getFolderByPrefixStmt = db.prepare(`
  SELECT * FROM folders WHERE prefix = ?;
`);

const listFoldersByParentStmt = db.prepare(`
  SELECT * FROM folders
  WHERE (parent_id IS NULL AND @parent_id IS NULL)
     OR (parent_id = @parent_id)
  ORDER BY name COLLATE NOCASE ASC
  LIMIT @limit OFFSET @offset;
`);

const upsertFileStmt = db.prepare(`
  INSERT INTO files (folder_id, file_name, file_path, size, content_type, uploaded_at)
  VALUES (@folder_id, @file_name, @file_path, @size, @content_type, @uploaded_at)
  ON CONFLICT(file_path) DO UPDATE SET
    folder_id = excluded.folder_id,
    file_name = excluded.file_name,
    size = excluded.size,
    content_type = excluded.content_type,
    uploaded_at = excluded.uploaded_at;
`);

const listFilesByFolderStmt = db.prepare(`
  SELECT * FROM files
  WHERE (@folder_id IS NULL AND folder_id IS NULL)
     OR (folder_id = @folder_id)
  ORDER BY file_name COLLATE NOCASE ASC
  LIMIT @limit OFFSET @offset;
`);

const deleteFileByPathStmt = db.prepare(`
  DELETE FROM files WHERE file_path = ?;
`);

const deleteFilesByPrefixStmt = db.prepare(`
  DELETE FROM files WHERE file_path LIKE ?;
`);

const deleteFoldersByPrefixStmt = db.prepare(`
  DELETE FROM folders
  WHERE prefix = @prefix
     OR prefix LIKE @prefix_like;
`);

const updateFilePathAndNameStmt = db.prepare(`
  UPDATE files
  SET file_path = @new_path,
      file_name = @new_name
  WHERE file_path = @old_path;
`);

export function upsertFolder({ name, prefix, parentId = null, fileCount = null }) {
  if (!name || !prefix) throw new Error('name and prefix are required for upsertFolder');
  upsertFolderStmt.run({
    name,
    prefix,
    parent_id: parentId,
    file_count: fileCount,
  });
}

export function getFolderByPrefix(prefix) {
  if (!prefix) throw new Error('prefix is required for getFolderByPrefix');
  return getFolderByPrefixStmt.get(prefix);
}

export function listFoldersByParent({ parentId = null, limit = 50, offset = 0 } = {}) {
  return listFoldersByParentStmt.all({ parent_id: parentId, limit, offset });
}

export function upsertFile({ folderId, fileName, filePath, size = 0, contentType = 'application/octet-stream', uploadedAt = null }) {
  if (!fileName || !filePath) {
    throw new Error('fileName and filePath are required for upsertFile');
  }
  upsertFileStmt.run({
    folder_id: folderId ?? null,
    file_name: fileName,
    file_path: filePath,
    size,
    content_type: contentType,
    uploaded_at: uploadedAt || new Date().toISOString(),
  });
}

export function listFilesByFolder({ folderId, limit = 50, offset = 0 } = {}) {
  return listFilesByFolderStmt.all({ folder_id: folderId ?? null, limit, offset });
}

export function deleteFileByPath(filePath) {
  if (!filePath) throw new Error('filePath is required for deleteFileByPath');
  deleteFileByPathStmt.run(filePath);
}

export function deleteFilesByPrefix(prefix) {
  const cleaned = String(prefix || '')
    .replace(/^\/+|\/+$/g, '')
    .trim();
  if (!cleaned) return;
  const normalized = `${cleaned}/`;
  deleteFilesByPrefixStmt.run(`${normalized}%`);
}

export function deleteFoldersByPrefix(prefix) {
  const cleaned = String(prefix || '')
    .replace(/^\/+|\/+$/g, '')
    .trim();
  if (!cleaned) return;
  const normalized = `${cleaned}/`;
  deleteFoldersByPrefixStmt.run({ prefix: normalized, prefix_like: `${normalized}%` });
}

export function updateFilePathAndName({ oldPath, newPath, newName }) {
  if (!oldPath || !newPath || !newName) {
    throw new Error('oldPath, newPath, and newName are required for updateFilePathAndName');
  }
  updateFilePathAndNameStmt.run({ old_path: oldPath, new_path: newPath, new_name: newName });
}

export { db, dbPath };
