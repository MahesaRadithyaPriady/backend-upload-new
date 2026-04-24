import { listFiles, deleteFile, getB2 } from '../lib/b2.js';
import { prisma as catalogPrisma } from '../lib/storageCatalogDb.js';
import { upsertHlsEncodeRecord, getHlsEncodeRecordsByEpisode } from '../lib/hlsEncodeDb.js';
import { prisma as mainPrisma } from '../lib/prisma.js';

function getCdnBase() {
  return String(process.env.B2_CDN_BASE || `https://cdn-stable.nanimeid.xyz/file/${process.env.B2_BUCKET_NAME || 'NanimeID'}`).replace(/\/+$/, '');
}

function urlToFilePath(url) {
  const cdnBase = getCdnBase();
  return url.replace(cdnBase + '/', '').replace(/^\/+/, '');
}

async function listAllFileVersionsUnderPrefix(prefix) {
  const { b2, bucketId } = await getB2();
  const allVersions = [];
  let startFileName = undefined;
  let startFileId = undefined;

  while (true) {
    const res = await b2.listFileVersions({
      bucketId,
      maxFileCount: 1000,
      prefix,
      startFileName,
      startFileId,
    });
    const { files = [], nextFileName, nextFileId } = res.data;
    allVersions.push(...files);
    if (!nextFileName) break;
    startFileName = nextFileName;
    startFileId = nextFileId;
  }

  return allVersions;
}

async function deleteFilesUnderPrefix(prefix) {
  const deleted = [];
  const failed = [];

  const versions = await listAllFileVersionsUnderPrefix(prefix);
  console.log(`[hlsDelete] Found ${versions.length} file versions under prefix=${prefix}`);

  for (const f of versions) {
    try {
      await deleteFile({ fileId: f.fileId, fileName: f.fileName });
      await catalogPrisma.file.deleteMany({ where: { filePath: f.fileName } }).catch(() => {});
      deleted.push(f.fileName);
    } catch (err) {
      failed.push({ fileName: f.fileName, error: err.message });
    }
  }

  return { deleted, failed };
}

export async function deleteHlsByUrlController(request, reply) {
  const { url } = request.body || {};
  if (!url || typeof url !== 'string') {
    return reply.code(400).send({ error: 'url wajib diisi (string CDN URL)' });
  }

  const filePath = urlToFilePath(url);
  if (!filePath) {
    return reply.code(400).send({ error: 'URL tidak valid atau tidak sesuai CDN base' });
  }

  console.log(`[hlsDelete] Delete by url filePath=${filePath}`);

  try {
    const versions = await listAllFileVersionsUnderPrefix(filePath);
    const exact = versions.filter((f) => f.fileName === filePath);
    if (!exact.length) {
      return reply.code(404).send({ error: 'File tidak ditemukan di B2', filePath });
    }
    for (const f of exact) {
      await deleteFile({ fileId: f.fileId, fileName: f.fileName });
    }
    await catalogPrisma.file.deleteMany({ where: { filePath } }).catch(() => {});
    console.log(`[hlsDelete] Deleted ${exact.length} version(s) of ${filePath}`);
    return reply.send({ success: true, deleted: filePath, versionsDeleted: exact.length });
  } catch (err) {
    console.error(`[hlsDelete] Failed to delete ${filePath}: ${err.message}`);
    return reply.code(500).send({ error: err.message, filePath });
  }
}

export async function deleteHlsByPrefixController(request, reply) {
  const { prefix, url } = request.body || {};

  let resolvedPrefix = prefix;
  if (!resolvedPrefix && url) {
    resolvedPrefix = urlToFilePath(url);
    if (resolvedPrefix && !resolvedPrefix.endsWith('/')) {
      resolvedPrefix = resolvedPrefix.substring(0, resolvedPrefix.lastIndexOf('/') + 1);
    }
  }

  if (!resolvedPrefix) {
    return reply.code(400).send({ error: 'prefix atau url wajib diisi' });
  }

  if (!resolvedPrefix.endsWith('/')) resolvedPrefix += '/';

  console.log(`[hlsDelete] Delete by prefix=${resolvedPrefix}`);

  try {
    const result = await deleteFilesUnderPrefix(resolvedPrefix);
    console.log(`[hlsDelete] Deleted ${result.deleted.length} files, failed ${result.failed.length}`);
    return reply.send({
      success: true,
      prefix: resolvedPrefix,
      deletedCount: result.deleted.length,
      failedCount: result.failed.length,
      deleted: result.deleted,
      failed: result.failed,
    });
  } catch (err) {
    return reply.code(500).send({ error: err.message });
  }
}

export async function deleteHlsEpisodeController(request, reply) {
  const episodeId = Number(request.params?.episodeId ?? request.body?.episodeId);
  if (!Number.isInteger(episodeId) || episodeId <= 0) {
    return reply.code(400).send({ error: 'episodeId wajib diisi (integer > 0)' });
  }

  const { qualities: qualityFilter } = request.body || {};

  console.log(`[hlsDelete] Delete HLS episode ${episodeId} qualities=${JSON.stringify(qualityFilter ?? 'all')}`);

  const records = await getHlsEncodeRecordsByEpisode(episodeId);
  if (!records.length) {
    return reply.code(404).send({ error: 'Tidak ada HLS record untuk episode ini', episodeId });
  }

  const toDelete = qualityFilter?.length
    ? records.filter((r) => qualityFilter.includes(r.namaQuality))
    : records;

  const results = [];

  for (const rec of toDelete) {
    if (!rec.hlsUrl) {
      results.push({ namaQuality: rec.namaQuality, skipped: true, reason: 'hlsUrl kosong' });
      continue;
    }

    const filePath = urlToFilePath(rec.hlsUrl);
    const folderPrefix = filePath.substring(0, filePath.lastIndexOf('/') + 1);

    try {
      const { deleted, failed } = await deleteFilesUnderPrefix(folderPrefix);
      await mainPrisma.hlsEncodeRecord.deleteMany({
        where: { episodeId, namaQuality: rec.namaQuality },
      }).catch(() => {});
      console.log(`[hlsDelete] Episode ${episodeId} quality=${rec.namaQuality} deleted ${deleted.length} files`);
      results.push({ namaQuality: rec.namaQuality, deletedCount: deleted.length, failedCount: failed.length, failed });
    } catch (err) {
      results.push({ namaQuality: rec.namaQuality, error: err.message });
    }
  }

  return reply.send({ episodeId, results });
}
