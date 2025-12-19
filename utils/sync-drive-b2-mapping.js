import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import dotenv from 'dotenv';

import { db as catalogDb } from '../lib/storageCatalogDb.js';
import { getDriveB2MappingByB2ObjectKey, upsertDriveB2Mapping } from '../lib/fileMappingDb.js';
import { getDrive } from '../lib/drive.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq !== -1) {
      const k = a.slice(2, eq);
      const v = a.slice(eq + 1);
      args[k] = v;
      continue;
    }
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      args[k] = next;
      i++;
    } else {
      args[k] = true;
    }
  }
  return args;
}

function normalizePath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/');
}

function splitParts(p) {
  const n = normalizePath(p);
  return n ? n.split('/').filter(Boolean) : [];
}

function suffixKey(parts, k) {
  if (!Array.isArray(parts) || parts.length < k) return '';
  return parts.slice(parts.length - k).join('/');
}

function buildSuffixIndex(b2Paths) {
  const maxK = 8;
  const maps = new Array(maxK + 1).fill(null).map(() => new Map());
  for (const p of b2Paths) {
    const parts = splitParts(p);
    for (let k = 1; k <= maxK; k++) {
      if (parts.length < k) break;
      const key = suffixKey(parts, k);
      if (!key) continue;
      const list = maps[k].get(key);
      if (list) list.push(p);
      else maps[k].set(key, [p]);
    }
  }
  return { maps, maxK };
}

function bestMatchBySuffix(drivePath, suffixIndex) {
  const parts = splitParts(drivePath);
  if (!parts.length) return null;

  const { maps, maxK } = suffixIndex;

  // Prefer longest unique suffix match.
  const upper = Math.min(maxK, parts.length);
  for (let k = upper; k >= 1; k--) {
    const key = suffixKey(parts, k);
    const list = maps[k].get(key);
    if (!list || list.length === 0) continue;
    if (list.length === 1) {
      return { b2ObjectKey: list[0], mode: 'suffix_unique', k };
    }
  }

  // Fallback: exact match
  const exact = normalizePath(drivePath);
  if (!exact) return null;
  for (let k = Math.min(maxK, parts.length); k >= 1; k--) {
    const key = suffixKey(parts, k);
    const list = maps[k].get(key);
    if (!list) continue;
    const found = list.find((x) => normalizePath(x) === exact);
    if (found) return { b2ObjectKey: found, mode: 'exact', k };
  }

  // Last fallback: shortest suffix first match.
  for (let k = 1; k <= Math.min(maxK, parts.length); k++) {
    const key = suffixKey(parts, k);
    const list = maps[k].get(key);
    if (list && list.length) {
      return { b2ObjectKey: list[0], mode: list.length === 1 ? 'suffix' : 'suffix_ambiguous_first', k };
    }
  }

  return null;
}

function loadDriveList(jsonPath) {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(raw);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.files)) return data.files;
  throw new Error('Invalid drive json format. Expect array or {files:[...]}');
}

async function listDriveChildren({ parentId, pageSize = 1000 } = {}) {
  const drive = getDrive();
  let pageToken;
  const out = [];

  while (true) {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and trashed = false`,
      pageSize: Math.min(Math.max(Number(pageSize) || 1000, 1), 1000),
      pageToken,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, parents, driveId)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
      orderBy: 'folder, name',
    });

    const files = res?.data?.files || [];
    out.push(...files);
    pageToken = res?.data?.nextPageToken || null;
    if (!pageToken) break;
  }

  return out;
}

async function getDriveFileMeta(id) {
  const drive = getDrive();
  const res = await drive.files.get({
    fileId: id,
    fields: 'id, name, mimeType, parents, driveId',
    supportsAllDrives: true,
  });
  return res?.data;
}

async function crawlDriveTree({ rootId, maxFiles = 0 } = {}) {
  const rootMeta = await getDriveFileMeta(rootId);
  const rootName = rootMeta?.name || 'root';

  const items = [];
  const stack = [{ folderId: rootId, relParts: [] }];

  let foldersProcessed = 0;
  let filesFound = 0;

  while (stack.length) {
    const { folderId, relParts } = stack.pop();
    foldersProcessed++;
    if (foldersProcessed === 1 || foldersProcessed % 20 === 0) {
      console.log('[sync-drive-b2-mapping] Crawling Drive...', {
        foldersProcessed,
        stackRemaining: stack.length,
        filesFound,
        currentFolderId: folderId,
        currentRelative: relParts.join('/'),
      });
    }
    const children = await listDriveChildren({ parentId: folderId });
    for (const f of children) {
      const isFolder = f?.mimeType === 'application/vnd.google-apps.folder';
      if (isFolder) {
        stack.push({ folderId: f.id, relParts: [...relParts, f.name] });
        continue;
      }
      const driveRelPath = [...relParts, f.name].join('/');
      const driveFullPath = `${rootName}/${driveRelPath}`;
      items.push({
        driveFileId: f.id,
        drivePath: driveFullPath,
        driveRelativePath: driveRelPath,
        driveFolderId: folderId,
        driveDriveId: f.driveId || null,
        size: f.size ? Number(f.size) : null,
        modifiedTime: f.modifiedTime || null,
      });

      filesFound++;
      if (filesFound === 1 || filesFound % 250 === 0) {
        console.log('[sync-drive-b2-mapping] Drive files discovered...', { filesFound, foldersProcessed });
      }

      if (Number.isFinite(maxFiles) && maxFiles > 0 && filesFound >= maxFiles) {
        console.log('[sync-drive-b2-mapping] Drive crawl reached maxFiles', { maxFiles, foldersProcessed, filesFound });
        stack.length = 0;
        break;
      }
    }
  }

  console.log('[sync-drive-b2-mapping] Drive crawl finished', { rootName, foldersProcessed, filesFound });

  return { rootName, items };
}

function getAllB2FilesFromCatalog({ b2Prefix = null } = {}) {
  if (b2Prefix) {
    const pref = normalizePath(b2Prefix);
    const like = pref ? `${pref}/%` : '%';
    return catalogDb
      .prepare('SELECT file_path as filePath, folder_id as folderId FROM files WHERE file_path LIKE ? ORDER BY file_path')
      .all(like);
  }
  return catalogDb
    .prepare('SELECT file_path as filePath, folder_id as folderId FROM files ORDER BY file_path')
    .all();
}

function usageAndExit(code = 1) {
  const msg = [
    'Usage:',
    '  node utils/sync-drive-b2-mapping.js --driveRootId <folderId> [--b2Prefix <prefix>] [--dryRun 1]',
    '  node utils/sync-drive-b2-mapping.js --driveJson <path> [--b2Prefix <prefix>] [--dryRun 1]',
    '',
    'driveRootId mode:',
    '  - Script will crawl Drive folder recursively and build relative paths under that root.',
    '',
    'driveJson format example:',
    '  [',
    '    { "driveFileId": "...", "drivePath": "Mahesa/Anime A/Eps.1/video.mp4", "driveFolderId": "..." }',
    '  ]',
    '',
    'Notes:',
    '  - b2Prefix optional to limit B2 candidates.',
    '  - Script reads B2 paths from storage_catalog.db (local catalog). Run: node utils/sync-b2-to-db.js first if needed.',
    '  - Drive auth uses env vars: CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN (same as API server).',
  ].join('\n');
  console.error(msg);
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const driveJson = args.driveJson || args.drive || args.input;
  const driveRootId = args.driveRootId || args.driveFolderId || args.rootId || null;
  const b2Prefix = args.b2Prefix || args.prefix || null;
  const dryRun = (() => {
    const v = args.dryRun ?? args['dry-run'];
    if (v === true) return true;
    const s = String(v ?? '').toLowerCase();
    return s === '1' || s === 'true' || s === 'yes';
  })();

  if (!driveJson && !driveRootId) usageAndExit(1);

  let driveItems;
  if (driveRootId) {
    const sampleLimitForDry = Number(args.sample ?? 5);
    const maxDriveFiles = Number(
      args.maxDriveFiles ?? (dryRun ? Math.max(50, sampleLimitForDry * 200) : 0),
    );
    const { items } = await crawlDriveTree({ rootId: driveRootId, maxFiles: maxDriveFiles });
    driveItems = items;
  } else {
    const driveListPath = path.isAbsolute(driveJson) ? driveJson : path.join(process.cwd(), driveJson);
    if (!fs.existsSync(driveListPath)) {
      throw new Error(`driveJson file not found: ${driveListPath}`);
    }
    driveItems = loadDriveList(driveListPath);
  }

  const b2Rows = getAllB2FilesFromCatalog({ b2Prefix });

  const b2Paths = b2Rows.map((r) => r.filePath);
  const b2FolderIdByPath = new Map(b2Rows.map((r) => [r.filePath, r.folderId ?? null]));

  console.log('[sync-drive-b2-mapping] Loaded', {
    driveCount: driveItems.length,
    b2Count: b2Paths.length,
    b2Prefix: b2Prefix || null,
    dryRun,
  });

  const suffixIndex = buildSuffixIndex(b2Paths);

  let linked = 0;
  let missing = 0;
  let ambiguous = 0;
  let alreadyLinked = 0;

  const sampleLimit = Number(args.sample ?? 5);
  const sampleLinked = [];
  const sampleMissing = [];
  const sampleAmbiguous = [];

  const stopAfterLinkedSamples = (() => {
    const v = args.stopAfterSamples ?? args.stopAfterSample;
    if (v === false) return false;
    if (v === true) return true;
    const s = String(v ?? '').toLowerCase();
    if (s === '0' || s === 'false' || s === 'no') return false;
    // default: enable for dry-run
    return dryRun;
  })();

  const shouldCollectSamples = (() => {
    // In dryRun: always collect (for verification)
    if (dryRun) return true;
    // In real run: only collect if user explicitly asks (via --sample)
    return args.sample != null;
  })();

  const progressEvery = Number(args.progressEvery ?? 250);
  let processed = 0;

  for (const item of driveItems) {
    processed++;
    if (processed === 1 || (Number.isFinite(progressEvery) && progressEvery > 0 && processed % progressEvery === 0)) {
      console.log('[sync-drive-b2-mapping] Matching progress', {
        processed,
        driveTotal: driveItems.length,
        linked,
        missing,
        ambiguous,
      });
    }
    const driveFileId = item.driveFileId || item.id || item.fileId;
    const drivePath = item.drivePath || item.path;
    const driveRelativePath = item.driveRelativePath || (() => {
      const parts = splitParts(drivePath);
      // If input contains root folder name as first segment, treat the rest as relative.
      if (parts.length >= 2) return parts.slice(1).join('/');
      return normalizePath(drivePath);
    })();
    const driveFolderId = item.driveFolderId || item.folderId || null;
    const driveDriveId = item.driveDriveId || item.driveId || null;

    if (!driveFileId || !drivePath) {
      continue;
    }

    // Match using relative path so B2 root differences do not matter.
    const match = bestMatchBySuffix(driveRelativePath, suffixIndex);
    if (!match) {
      missing++;
      if (dryRun && sampleMissing.length < sampleLimit) {
        sampleMissing.push({
          driveFileId,
          driveFolderId,
          drivePath: normalizePath(drivePath),
          driveRelativePath: normalizePath(driveRelativePath),
        });
      }
      continue;
    }

    const b2ObjectKey = match.b2ObjectKey;
    const b2CatalogFolderId = b2FolderIdByPath.get(b2ObjectKey) ?? null;
    const parts = splitParts(b2ObjectKey);
    const b2PrefixResolved = parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '';

    const status = match.mode === 'suffix_ambiguous_first' ? 'ambiguous' : 'linked';
    if (status === 'ambiguous') ambiguous++;

    if (shouldCollectSamples) {
      const row = {
        driveFileId,
        driveFolderId,
        drivePath: normalizePath(drivePath),
        driveRelativePath: normalizePath(driveRelativePath),
        b2ObjectKey,
        b2Prefix: b2PrefixResolved,
        mode: match.mode,
        k: match.k,
      };
      if (status === 'ambiguous') {
        if (sampleAmbiguous.length < sampleLimit) sampleAmbiguous.push(row);
      } else {
        if (sampleLinked.length < sampleLimit) sampleLinked.push(row);
      }
    }

    if (!dryRun) {
      const existing = getDriveB2MappingByB2ObjectKey(b2ObjectKey);
      if (existing?.driveFileId && String(existing.driveFileId) !== String(driveFileId)) {
        alreadyLinked++;
        if (alreadyLinked <= 5) {
          console.log('[sync-drive-b2-mapping] Skip (b2ObjectKey already linked)', {
            b2ObjectKey,
            existingDriveFileId: existing.driveFileId,
            driveFileId,
          });
        }
        continue;
      }
      upsertDriveB2Mapping({
        driveFileId,
        drivePath: normalizePath(drivePath),
        driveFolderId,
        driveDriveId,
        b2ObjectKey,
        b2Prefix: b2PrefixResolved,
        b2CatalogFolderId,
        status,
      });
    }

    linked++;

    if (stopAfterLinkedSamples && sampleLinked.length >= sampleLimit) {
      break;
    }
  }

  console.log('[sync-drive-b2-mapping] Done', { linked, missing, ambiguous, alreadyLinked, dryRun });

  if (shouldCollectSamples) {
    console.log(dryRun ? '[sync-drive-b2-mapping] Dry-run samples' : '[sync-drive-b2-mapping] Samples', {
      sampleLimit,
      linked: sampleLinked,
      missing: sampleMissing,
      ambiguous: sampleAmbiguous,
    });
  }
}

main().catch((err) => {
  console.error('[sync-drive-b2-mapping] Failed', {
    message: err?.message,
    stack: err?.stack,
  });
  process.exit(1);
});
