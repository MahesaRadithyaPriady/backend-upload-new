import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { prisma } from '../lib/prisma.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

function openSqlite(file) {
  const p = path.isAbsolute(file) ? file : path.join(ROOT, file);
  return new Database(p, { readonly: true });
}

async function migrateFileMappings(db) {
  let rows;
  try {
    rows = db.prepare('SELECT * FROM file_mapping').all();
  } catch {
    console.log('[migrate] file_mapping table not found, skipping.');
    return;
  }
  console.log(`[migrate] Migrating ${rows.length} rows from file_mapping...`);
  let done = 0;
  for (const r of rows) {
    await prisma.fileMapping.upsert({
      where: { driveFileId: r.driveFileId },
      update: { b2ObjectKey: r.b2ObjectKey, status: r.status ?? 'migrated' },
      create: {
        driveFileId: r.driveFileId,
        b2ObjectKey: r.b2ObjectKey,
        status: r.status ?? 'migrated',
        createdAt: r.createdAt ? new Date(r.createdAt) : new Date(),
        updatedAt: r.updatedAt ? new Date(r.updatedAt) : new Date(),
      },
    });
    done++;
    if (done % 500 === 0) console.log(`  [file_mapping] ${done}/${rows.length}`);
  }
  console.log(`[migrate] file_mapping done: ${done} rows`);
}

async function migrateDriveB2Mappings(db) {
  let rows;
  try {
    rows = db.prepare('SELECT * FROM drive_b2_mapping').all();
  } catch {
    console.log('[migrate] drive_b2_mapping table not found, skipping.');
    return;
  }
  console.log(`[migrate] Migrating ${rows.length} rows from drive_b2_mapping...`);
  let done = 0;
  for (const r of rows) {
    await prisma.driveB2Mapping.upsert({
      where: { driveFileId: r.driveFileId },
      update: {
        drivePath: r.drivePath ?? null,
        driveFolderId: r.driveFolderId ?? null,
        driveDriveId: r.driveDriveId ?? null,
        b2ObjectKey: r.b2ObjectKey,
        b2Prefix: r.b2Prefix ?? null,
        b2CatalogFolderId: r.b2CatalogFolderId ?? null,
        status: r.status ?? 'linked',
      },
      create: {
        driveFileId: r.driveFileId,
        drivePath: r.drivePath ?? null,
        driveFolderId: r.driveFolderId ?? null,
        driveDriveId: r.driveDriveId ?? null,
        b2ObjectKey: r.b2ObjectKey,
        b2Prefix: r.b2Prefix ?? null,
        b2CatalogFolderId: r.b2CatalogFolderId ?? null,
        status: r.status ?? 'linked',
        createdAt: r.createdAt ? new Date(r.createdAt) : new Date(),
        updatedAt: r.updatedAt ? new Date(r.updatedAt) : new Date(),
      },
    });
    done++;
    if (done % 500 === 0) console.log(`  [drive_b2_mapping] ${done}/${rows.length}`);
  }
  console.log(`[migrate] drive_b2_mapping done: ${done} rows`);
}

async function migrateFolders(db) {
  let rows;
  try {
    rows = db.prepare('SELECT * FROM folders ORDER BY id ASC').all();
  } catch {
    console.log('[migrate] folders table not found, skipping.');
    return {};
  }
  console.log(`[migrate] Migrating ${rows.length} rows from folders...`);
  const oldIdToNew = {};
  let done = 0;
  for (const r of rows) {
    const newParentId = r.parent_id != null ? (oldIdToNew[r.parent_id] ?? null) : null;
    const created = await prisma.folder.upsert({
      where: { prefix: r.prefix },
      update: { name: r.name, parentId: newParentId, fileCount: r.file_count ?? 0 },
      create: {
        name: r.name,
        prefix: r.prefix,
        parentId: newParentId,
        fileCount: r.file_count ?? 0,
        createdAt: r.created_at ? new Date(r.created_at) : new Date(),
        updatedAt: r.updated_at ? new Date(r.updated_at) : new Date(),
      },
    });
    oldIdToNew[r.id] = created.id;
    done++;
    if (done % 200 === 0) console.log(`  [folders] ${done}/${rows.length}`);
  }
  console.log(`[migrate] folders done: ${done} rows`);
  return oldIdToNew;
}

async function migrateFiles(db, folderIdMap) {
  let rows;
  try {
    rows = db.prepare('SELECT * FROM files ORDER BY id ASC').all();
  } catch {
    console.log('[migrate] files table not found, skipping.');
    return;
  }
  console.log(`[migrate] Migrating ${rows.length} rows from files...`);
  let done = 0;
  for (const r of rows) {
    const folderId = r.folder_id != null ? (folderIdMap[r.folder_id] ?? null) : null;
    await prisma.file.upsert({
      where: { filePath: r.file_path },
      update: {
        folderId,
        fileName: r.file_name,
        size: BigInt(r.size || 0),
        contentType: r.content_type || 'application/octet-stream',
        uploadedAt: r.uploaded_at ? new Date(r.uploaded_at) : new Date(),
        isMaster: r.is_master ?? 0,
        isLow: r.is_low ?? 0,
      },
      create: {
        folderId,
        fileName: r.file_name,
        filePath: r.file_path,
        size: BigInt(r.size || 0),
        contentType: r.content_type || 'application/octet-stream',
        uploadedAt: r.uploaded_at ? new Date(r.uploaded_at) : new Date(),
        isMaster: r.is_master ?? 0,
        isLow: r.is_low ?? 0,
      },
    });
    done++;
    if (done % 500 === 0) console.log(`  [files] ${done}/${rows.length}`);
  }
  console.log(`[migrate] files done: ${done} rows`);
}

async function migrateUploadJobs(db) {
  let rows;
  try {
    rows = db.prepare('SELECT * FROM upload_jobs').all();
  } catch {
    console.log('[migrate] upload_jobs table not found, skipping.');
    return;
  }
  console.log(`[migrate] Migrating ${rows.length} rows from upload_jobs...`);
  let done = 0;
  for (const r of rows) {
    await prisma.uploadJob.upsert({
      where: { id: r.id },
      update: {
        prefix: r.prefix ?? null,
        status: r.status ?? null,
        current: r.current ?? null,
        done: r.done ?? null,
        total: r.total ?? null,
        percent: r.percent ?? null,
        error: r.error ?? null,
        updatedAtMs: r.updated_at_ms != null ? BigInt(r.updated_at_ms) : null,
      },
      create: {
        id: r.id,
        prefix: r.prefix ?? null,
        status: r.status ?? null,
        current: r.current ?? null,
        done: r.done ?? null,
        total: r.total ?? null,
        percent: r.percent ?? null,
        error: r.error ?? null,
        createdAtMs: r.created_at_ms != null ? BigInt(r.created_at_ms) : null,
        updatedAtMs: r.updated_at_ms != null ? BigInt(r.updated_at_ms) : null,
      },
    });
    done++;
  }
  console.log(`[migrate] upload_jobs done: ${done} rows`);
}

async function main() {
  const args = process.argv.slice(2);
  const catalogDb = args.find((a) => !a.startsWith('--')) || 'storage_catalog.db';
  const fileMappingDb = args.find((a) => a.startsWith('--fileMapping='))?.split('=')[1] || 'file_mapping.db';
  const uploadJobsDb = args.find((a) => a.startsWith('--uploadJobs='))?.split('=')[1] || 'upload_jobs.db';

  console.log('[migrate] Starting SQLite → PostgreSQL migration');
  console.log(`[migrate] Catalog DB: ${catalogDb}`);
  console.log(`[migrate] FileMapping DB: ${fileMappingDb}`);
  console.log(`[migrate] UploadJobs DB: ${uploadJobsDb}`);

  let catalogSqlite, fileMappingSqlite, uploadJobsSqlite;

  try {
    catalogSqlite = openSqlite(catalogDb);
  } catch (e) {
    console.warn(`[migrate] Could not open catalog DB (${catalogDb}): ${e.message}`);
  }

  try {
    fileMappingSqlite = openSqlite(fileMappingDb);
  } catch (e) {
    console.warn(`[migrate] Could not open file_mapping DB (${fileMappingDb}): ${e.message}`);
  }

  try {
    uploadJobsSqlite = openSqlite(uploadJobsDb);
  } catch (e) {
    console.warn(`[migrate] Could not open upload_jobs DB (${uploadJobsDb}): ${e.message}`);
  }

  if (fileMappingSqlite) {
    await migrateFileMappings(fileMappingSqlite);
    await migrateDriveB2Mappings(fileMappingSqlite);
    fileMappingSqlite.close();
  }

  let folderIdMap = {};
  if (catalogSqlite) {
    folderIdMap = await migrateFolders(catalogSqlite);
    await migrateFiles(catalogSqlite, folderIdMap);
    catalogSqlite.close();
  }

  if (uploadJobsSqlite) {
    await migrateUploadJobs(uploadJobsSqlite);
    uploadJobsSqlite.close();
  }

  await prisma.$disconnect();
  console.log('[migrate] Migration complete!');
}

main().catch((err) => {
  console.error('[migrate] Fatal error:', err?.message, err?.stack);
  process.exitCode = 1;
});
