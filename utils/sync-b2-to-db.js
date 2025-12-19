import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Jalankan script ini dengan Deno (mode Node compat) atau Node >= 20 (ESM).
// Contoh Deno:
//   deno run --allow-env --allow-read --allow-write --allow-net utils/sync-b2-to-db.js
//
// Script ini akan:
// - Scan semua file di B2 via listFiles()
// - Bangun hirarki folders/files di SQLite (storage_catalog.db)

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const b2ModulePath = path.join(__dirname, '..', 'lib', 'b2.js');
const catalogModulePath = path.join(__dirname, '..', 'lib', 'storageCatalogDb.js');

const { listFiles } = await import(b2ModulePath);
const { upsertFolder, getFolderByPrefix, upsertFile } = await import(catalogModulePath);

function splitPathParts(fullPath) {
  return String(fullPath)
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
}

async function ensureFolderHierarchy(prefix) {
  // prefix: "A/", "A/sub/", "B/" atau ''
  const cleaned = String(prefix || '')
    .replace(/^\/+|\/+$/g, '')
    .trim();
  if (!cleaned) {
    // Root (tanpa folder) tidak disimpan sebagai row khusus
    return null;
  }

  const parts = splitPathParts(cleaned);
  let currentPrefix = '';
  let parentId = null;

  for (const part of parts) {
    currentPrefix = currentPrefix ? `${currentPrefix}${part}/` : `${part}/`;

    let existing = getFolderByPrefix(currentPrefix);
    if (!existing) {
      upsertFolder({
        name: part,
        prefix: currentPrefix,
        parentId,
        fileCount: null,
      });
      existing = getFolderByPrefix(currentPrefix);
    }

    parentId = existing?.id ?? parentId;
  }

  return parentId;
}

async function syncAllFiles() {
  console.log('[sync-b2-to-db] Start sync from B2 to SQLite catalog');

  let pageToken = undefined;
  let totalFiles = 0;
  let iterations = 0;

  while (true) {
    iterations += 1;
    console.log(`[sync-b2-to-db] Listing page ${iterations}, startFileName=${pageToken || 'null'}`);

    const { files = [], nextFileName = null } = await listFiles({
      prefix: '',
      maxFileCount: 1000,
      startFileName: pageToken,
    });

    if (!files.length) {
      console.log('[sync-b2-to-db] No more files from B2');
      break;
    }

    for (const f of files) {
      const fullName = f.fileName || '';
      if (!fullName) continue;

      const parts = splitPathParts(fullName);
      if (!parts.length) continue;

      const fileName = parts[parts.length - 1];
      const folderPrefix = parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '';

      const folderId = await ensureFolderHierarchy(folderPrefix);

      upsertFile({
        folderId,
        fileName,
        filePath: fullName,
        size: Number(f.contentLength) || 0,
        contentType: f.contentType || 'application/octet-stream',
        uploadedAt: f.uploadTimestamp ? new Date(f.uploadTimestamp).toISOString() : undefined,
      });

      totalFiles += 1;
      if (totalFiles % 500 === 0) {
        console.log(`[sync-b2-to-db] Processed ${totalFiles} files...`);
      }
    }

    if (!nextFileName) {
      console.log('[sync-b2-to-db] Reached end of listing');
      break;
    }

    pageToken = nextFileName;
  }

  console.log(`[sync-b2-to-db] Done. Total files processed: ${totalFiles}`);
}

syncAllFiles()
  .then(() => {
    console.log('[sync-b2-to-db] Sync finished successfully');
  })
  .catch((err) => {
    console.error('[sync-b2-to-db] Sync failed', {
      message: err?.message,
      stack: err?.stack,
    });
    Deno?.exit?.(1);
  });
