import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

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

const { listFiles } = await import(pathToFileURL(b2ModulePath).href);
const { upsertFolder, getFolderByPrefix, upsertFile } = await import(
  pathToFileURL(catalogModulePath).href,
);

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

    let existing = await getFolderByPrefix(currentPrefix);
    if (!existing) {
      await upsertFolder({
        name: part,
        prefix: currentPrefix,
        parentId,
        fileCount: null,
      });
      existing = await getFolderByPrefix(currentPrefix);
    }

    parentId = existing?.id ?? parentId;
  }

  return parentId;
}

async function syncAllFiles() {
  console.log('[sync-b2-to-db] Start sync from B2 to PostgreSQL catalog');

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

    // Debug: log first file structure once
    if (iterations === 1 && files[0]) {
      console.log('[sync-b2-to-db] First file structure:', JSON.stringify(files[0], null, 2));
    }

    for (const f of files) {
      // B2 API bisa return fileName atau fileId
      const fullName = f.fileName || f.fileId || '';
      if (!fullName) {
        console.log('[sync-b2-to-db] Skip file without name:', JSON.stringify(f));
        continue;
      }

      const parts = splitPathParts(fullName);
      if (!parts.length) continue;

      const fileName = parts[parts.length - 1];
      const folderPrefix = parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '';

      // Detect HLS files and extract better name
      const isHLS = fileName.endsWith('.m3u8') || fileName.endsWith('.ts');
      let displayName = fileName;
      let fileType = 'video';

      if (isHLS) {
        // Try to extract episode info from path
        // Pattern: anime_xxx/Eps.yy/... or similar
        const animeMatch = folderPrefix.match(/anime[_-]?(\d+)/i);
        const epsMatch = folderPrefix.match(/eps[._-]?(\d+)/i) || folderPrefix.match(/episode[_-]?(\d+)/i);
        
        if (animeMatch && epsMatch) {
          const animeId = animeMatch[1];
          const epsNum = epsMatch[1];
          
          if (fileName === 'master.m3u8') {
            displayName = `[Anime ${animeId}] Ep.${epsNum} - Master Playlist`;
          } else if (fileName.endsWith('.m3u8')) {
            displayName = `[Anime ${animeId}] Ep.${epsNum} - ${fileName}`;
          } else if (fileName.endsWith('.ts')) {
            // For .ts segments, show shorter name
            displayName = `[Anime ${animeId}] Ep.${epsNum} - Segment`;
            fileType = 'segment';
          }
        }
      }

      const folderId = await ensureFolderHierarchy(folderPrefix);

      // Get file size from various possible field names
      const fileSize = Number(f.contentLength || f.size || f.contentLength || 0);
      
      // Get timestamp from various possible field names
      const uploadTimestamp = f.uploadTimestamp || f.uploadTime || f.modifiedTime;
      
      await upsertFile({
        folderId,
        fileName: displayName,
        originalName: fileName,
        filePath: fullName,
        size: fileSize,
        contentType: f.contentType || (fileName.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/MP2T'),
        fileType,
        isHLS,
        uploadedAt: uploadTimestamp ? new Date(uploadTimestamp).toISOString() : undefined,
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
    if (typeof Deno !== 'undefined' && typeof Deno.exit === 'function') {
      Deno.exit(1);
    } else if (typeof process !== 'undefined' && typeof process.exit === 'function') {
      process.exit(1);
    }
  });
