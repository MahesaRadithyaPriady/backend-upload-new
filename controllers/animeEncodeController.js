import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  encodeMultiRendition,
  RENDITIONS,
  SEGMENT_DURATION,
  runWithConcurrency,
} from '../lib/encodeMultiRendition.js';
import { uploadFromStream, deleteFile } from '../lib/b2.js';
import {
  upsertFolder,
  getFolderByPrefix,
  upsertFile,
  incrementFolderFileCount,
  prisma as catalogPrisma,
} from '../lib/storageCatalogDb.js';
import { upsertJob, updateJobThrottled, getJobById, listJobs, deleteJobById } from '../lib/uploadJobsDb.js';
import { upsertHlsEncodeRecord } from '../lib/hlsEncodeDb.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');

const g = typeof globalThis !== 'undefined' ? globalThis : global;
if (!g.__animeEncodeAbortRegistry) g.__animeEncodeAbortRegistry = new Map();
const abortRegistry = g.__animeEncodeAbortRegistry;

function makeJobId() {
  return `aenc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getTempRoot() {
  const env = process.env.ENCODE_TEMP_DIR;
  if (env) return path.isAbsolute(env) ? env : path.resolve(PROJECT_ROOT, env);
  return path.join(PROJECT_ROOT, 'temp');
}

function getAdminApiBase() {
  return String(process.env.ADMIN_API_BASE || '').replace(/\/+$/, '');
}

async function deleteSourceFileFromB2(objectKey) {
  const { listFiles, deleteFile, getB2 } = await import('../lib/b2.js');
  const { b2, bucketId } = await getB2();

  // Get all versions of the file
  let allVersions = [];
  let startFileName = undefined;
  let startFileId = undefined;

  while (true) {
    const res = await b2.listFileVersions({
      bucketId,
      maxFileCount: 1000,
      prefix: objectKey,
      startFileName,
      startFileId,
    });
    const { files = [], nextFileName, nextFileId } = res.data;
    const exactMatches = files.filter((f) => f.fileName === objectKey);
    allVersions.push(...exactMatches);
    if (!nextFileName || files.length < 1000) break;
    startFileName = nextFileName;
    startFileId = nextFileId;
  }

  if (!allVersions.length) {
    console.log(`[deleteSource] File not found in B2: ${objectKey}`);
    return { deleted: false, reason: 'not_found' };
  }

  // Delete all versions
  for (const file of allVersions) {
    await deleteFile({ fileId: file.fileId, fileName: file.fileName });
  }

  // Delete from catalog
  await catalogPrisma.file.deleteMany({ where: { filePath: objectKey } }).catch(() => {});

  console.log(`[deleteSource] Deleted ${allVersions.length} version(s) of ${objectKey}`);
  return { deleted: true, versionsDeleted: allVersions.length };
}


function getUploadConcurrency() {
  const n = parseInt(process.env.ENCODE_UPLOAD_CONCURRENCY || process.env.HLS_UPLOAD_CONCURRENCY || '6', 10);
  return Number.isFinite(n) && n > 0 ? n : 6;
}


async function ensureFolderHierarchy(prefix) {
  const cleaned = String(prefix || '').replace(/^\/+|\/+$/g, '').trim();
  if (!cleaned) return null;
  const parts = cleaned.split('/').map((p) => p.trim()).filter(Boolean);
  let currentPrefix = '';
  let parentId = null;
  for (const part of parts) {
    currentPrefix = currentPrefix ? `${currentPrefix}${part}/` : `${part}/`;
    let existing = await getFolderByPrefix(currentPrefix);
    if (!existing) {
      await upsertFolder({ name: part, prefix: currentPrefix, parentId, fileCount: null });
      existing = await getFolderByPrefix(currentPrefix);
    }
    parentId = existing?.id ?? parentId;
  }
  return parentId;
}

async function sendAdminCallback({ episodeId, jobId, results, adminToken }) {
  const base = getAdminApiBase();
  if (!base) {
    console.warn('[animeEncode] ADMIN_API_BASE not set, skipping callback');
    return;
  }
  const token = adminToken || getAdminApiToken();
  const payload = { episode_id: episodeId, results };
  console.log(`[animeEncode] Sending callback to ${base}/admin/hls/callback/bulk`);
  console.log(`[animeEncode] Callback payload: ${JSON.stringify(payload)}`);
  try {
    const res = await fetch(`${base}/admin/hls/callback/bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    console.log(`[animeEncode] Admin callback status: ${res.status}`);
    console.log(`[animeEncode] Admin callback response: ${text}`);
  } catch (err) {
    console.error(`[animeEncode] Admin callback failed: ${err.message}`);
  }
}

async function downloadToTemp(sourceUrl, abortSignal) {
  const tempDir = fs.mkdtempSync(path.join(getTempRoot(), 'dl-'));
  const ext = path.extname(new URL(sourceUrl).pathname) || '.mkv';
  const tempPath = path.join(tempDir, `input${ext}`);
  const res = await fetch(sourceUrl, { signal: abortSignal });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} — ${sourceUrl}`);
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tempPath);
    const reader = res.body.getReader();
    const pump = () => reader.read().then(({ done, value }) => {
      if (done) { ws.end(); return; }
      ws.write(Buffer.from(value));
      pump();
    }).catch(reject);
    ws.on('finish', resolve);
    ws.on('error', reject);
    pump();
  });
  return { tempPath, tempDir };
}

async function _runAnimeEncodeJob({ jobId, episodeId, sourceUrl, objectKey, adminToken, request, sourceSpec }) {
  const ac = new AbortController();
  abortRegistry.set(jobId, ac);
  let tempDir = null;

  try {
    await updateJobThrottled(jobId, { status: 'preparing', percent: 0 }, { minIntervalMs: 0, minPercentDelta: 0 });

    await updateJobThrottled(jobId, { status: 'downloading', current: sourceUrl, percent: 0 }, { minIntervalMs: 0, minPercentDelta: 0 });
    const { tempPath, tempDir: td } = await downloadToTemp(sourceUrl, ac.signal);
    tempDir = td;
    await updateJobThrottled(jobId, { status: 'downloaded', percent: 2 }, { minIntervalMs: 0, minPercentDelta: 0 });

    const sourceHeight = sourceSpec?.height ?? Infinity;
    const rList = RENDITIONS.filter((r) => r.height <= sourceHeight);
    const totalRenditions = rList.length;
    let completedRenditions = 0;
    const segmentDuration = (() => {
      const n = Number(process.env.ENCODE_SEGMENT_DURATION ?? SEGMENT_DURATION);
      return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : SEGMENT_DURATION;
    })();

    await updateJobThrottled(jobId, { status: 'encoding', percent: 2 }, { minIntervalMs: 0, minPercentDelta: 0 });

    const result = await encodeMultiRendition({
      inputPath: tempPath,
      objectKey,
      tempRoot: getTempRoot(),
      renditions: rList,
      segmentDuration,
      abortSignal: ac.signal,

      onRenditionStart: async ({ label, useNvenc }) => {
        const pct = Math.round((completedRenditions / totalRenditions) * 45) + 2;
        await updateJobThrottled(jobId, {
          status: 'encoding',
          current: `${label} (${useNvenc ? 'NVENC' : 'CPU'})`,
          done: completedRenditions,
          total: totalRenditions,
          percent: pct,
        });
      },

      onRenditionProgress: async ({ label, pct: rendPct }) => {
        const base = Math.round((completedRenditions / totalRenditions) * 45) + 2;
        const slice = Math.round((45 / totalRenditions) * ((rendPct ?? 0) / 100));
        await updateJobThrottled(jobId, {
          status: 'encoding',
          current: label,
          done: completedRenditions,
          total: totalRenditions,
          percent: Math.min(46, base + slice),
        });
      },

      onRenditionDone: async ({ label, success }) => {
        completedRenditions += 1;
        const pct = Math.round((completedRenditions / totalRenditions) * 45) + 2;
        await updateJobThrottled(jobId, {
          status: 'encoding',
          current: label,
          done: completedRenditions,
          total: totalRenditions,
          percent: Math.min(47, pct),
        });
      },
    });

    await updateJobThrottled(jobId, { status: 'uploading', percent: 48 }, { minIntervalMs: 0, minPercentDelta: 0 });

    const plan = result.b2UploadPlan.filter((item) => fs.existsSync(item.localPath));
    let uploadedCount = 0;

    const uploadTasks = plan.map((item) => async () => {
      const size = fs.statSync(item.localPath).size;
      const stream = fs.createReadStream(item.localPath);
      await uploadFromStream({
        fileName: item.b2Key,
        stream,
        contentType: item.contentType,
        expectedSizeBytes: size,
      });

      const b2KeyParts = item.b2Key.split('/');
      const fileName = b2KeyParts[b2KeyParts.length - 1];
      const folderPrefix = b2KeyParts.length > 1 ? `${b2KeyParts.slice(0, -1).join('/')}/` : '';
      const folderId = await ensureFolderHierarchy(folderPrefix);
      const existingFile = await catalogPrisma.file.findUnique({ where: { filePath: item.b2Key } });
      await upsertFile({ folderId, fileName, filePath: item.b2Key, size, contentType: item.contentType, uploadedAt: new Date().toISOString() });
      if (!existingFile) await incrementFolderFileCount(folderId);

      uploadedCount += 1;
      const pct = 48 + Math.round((uploadedCount / plan.length) * 49);
      await updateJobThrottled(jobId, {
        status: 'uploading',
        current: item.b2Key,
        done: uploadedCount,
        total: plan.length,
        percent: Math.min(97, pct),
      });
    });

    await runWithConcurrency(uploadTasks, getUploadConcurrency());

    const cdnBase = String(process.env.B2_CDN_BASE || `https://cdn-stable.nanimeid.xyz/file/${process.env.B2_BUCKET_NAME || 'NanimeID'}`).replace(/\/+$/, '');
    const b2Base = (() => {
      const cleaned = String(objectKey || '').replace(/^\/+/, '');
      const ext = path.extname(cleaned);
      const baseNoExt = ext ? cleaned.slice(0, -ext.length) : cleaned;
      const parentDir = baseNoExt.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      return parentDir ? `${parentDir}/` : '';
    })();

    const masterUrl = `${cdnBase}/${b2Base}master.m3u8`;

    const callbackResults = await Promise.all(rList.map(async (r) => {
      const info = result.outputStructure[r.label];
      if (!info?.success) {
        const errObj = result.errors.find((e) => e.label === r.label);
        return { nama_quality: r.label, success: false, error_message: errObj?.error || 'Encode failed', job_id: jobId };
      }
      const hlsUrl = `${cdnBase}/${b2Base}${r.label}/${r.label}.m3u8`;
      const qualityFilePath = hlsUrl.replace(`${cdnBase}/`, '').replace(/^\/+/, '');
      const folderPrefix = qualityFilePath.substring(0, qualityFilePath.lastIndexOf('/') + 1);
      const qualityFiles = await catalogPrisma.file.findMany({
        where: { filePath: { startsWith: folderPrefix } },
        select: { size: true },
      }).catch(() => []);
      const qualitySize = qualityFiles.reduce((sum, f) => sum + Number(f.size), 0) || null;
      const deleteSource = String(process.env.DELETE_SOURCE_AFTER_ENCODE || 'false').toLowerCase() === 'true';
      return {
        nama_quality: r.label,
        success: true,
        hls_url: hlsUrl,
        hls_master_url: masterUrl,
        hls_size: qualitySize,
        source_quality: deleteSource ? null : sourceUrl,
        job_id: jobId,
        metadata: {
          resolution: `${r.width}x${r.height}`,
          bitrate: r.videoBitrate,
          segments: info.segmentCount,
          duration: result.duration,
        },
      };
    }));

    const successLabels = rList.filter((r) => result.outputStructure[r.label]?.success).map((r) => r.label);
    const failedLabels = result.errors.map((e) => e.label);
    const finalStatus = failedLabels.length && !successLabels.length ? 'error' : failedLabels.length ? 'partial' : 'done';

    await updateJobThrottled(jobId, {
      status: finalStatus,
      done: successLabels.length,
      total: totalRenditions,
      percent: 100,
      current: masterUrl,
      error: failedLabels.length ? `Failed renditions: ${failedLabels.join(', ')}` : undefined,
    }, { minIntervalMs: 0, minPercentDelta: 0 });

    try { fs.rmSync(result.outBase, { recursive: true, force: true }); } catch {}

    for (const r of callbackResults) {
      await upsertHlsEncodeRecord({
        episodeId,
        jobId,
        namaQuality: r.nama_quality,
        status: r.success ? 'done' : 'error',
        hlsUrl: r.hls_url ?? null,
        masterUrl: r.success ? masterUrl : null,
        masterSize: r.success ? (r.hls_size ?? null) : null,
        errorMessage: r.error_message ?? null,
        resolution: r.metadata?.resolution ?? null,
        bitrate: r.metadata?.bitrate ?? null,
        segments: r.metadata?.segments ?? null,
        duration: r.metadata?.duration ?? null,
        encodedAt: new Date(),
      }).catch(() => {});
    }

    await sendAdminCallback({ episodeId, jobId, results: callbackResults, adminToken });

    // Hapus file source dari B2 jika env enabled dan encode sukses
    const shouldDeleteSource = String(process.env.DELETE_SOURCE_AFTER_ENCODE || 'false').toLowerCase() === 'true';
    if (shouldDeleteSource && finalStatus === 'done') {
      try {
        await deleteSourceFileFromB2(objectKey);
        console.log(`[animeEncode] Source file deleted from B2: ${objectKey}`);
      } catch (delErr) {
        console.error(`[animeEncode] Failed to delete source file: ${delErr.message}`);
      }
    }

    try {
      request?.log?.info({ jobId, episodeId, successLabels, failedLabels, masterUrl, sourceDeleted: shouldDeleteSource && finalStatus === 'done' }, 'Anime encode job done');
    } catch {}

  } catch (err) {
    const cancelled = ac.signal.aborted;
    try { request?.log?.error({ jobId, episodeId, message: err?.message, stack: err?.stack }, 'Anime encode job error'); } catch {}
    await updateJobThrottled(jobId, {
      status: cancelled ? 'cancelled' : 'error',
      error: cancelled ? 'Cancelled by user' : (err?.message || 'Encode failed'),
      percent: 100,
    }, { minIntervalMs: 0, minPercentDelta: 0 });

    if (!cancelled) {
      const errorCallbackResults = RENDITIONS.map((r) => ({
        nama_quality: r.label,
        success: false,
        error_message: err?.message || 'Encode failed',
        job_id: jobId,
      }));
      await sendAdminCallback({ episodeId, jobId, results: errorCallbackResults, adminToken });
    }
  } finally {
    abortRegistry.delete(jobId);
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  }
}

export async function startAnimeEncodeController(request, reply) {
  const body = request.body || {};

  const episodeId = Number(body.episodeId ?? body.episode_id);
  if (!Number.isInteger(episodeId) || episodeId <= 0) {
    return reply.code(400).send({ error: 'episodeId wajib diisi (integer > 0)' });
  }

  const adminToken = String(body.adminToken || body.admin_token || '').trim();
  if (!adminToken) {
    return reply.code(400).send({ error: 'adminToken wajib dikirim dari FE (Bearer token Admin API)' });
  }

  const jobId = String(body.jobId || body.job_id || '').trim() || makeJobId();

  const adminBase = getAdminApiBase();
  if (!adminBase) {
    return reply.code(500).send({ error: 'ADMIN_API_BASE not configured on server' });
  }

  let episodeData;
  try {
    const headers = adminToken ? { Authorization: `Bearer ${adminToken}` } : {};
    const res = await fetch(`${adminBase}/admin/hls/episodes/${episodeId}`, { headers });
    if (!res.ok) {
      const text = await res.text();
      return reply.code(res.status).send({ error: `Admin API error: ${res.status} — ${text.slice(0, 300)}` });
    }
    const json = await res.json();
    episodeData = json?.data ?? json;
  } catch (err) {
    return reply.code(502).send({ error: `Failed to fetch episode from admin API: ${err.message}` });
  }

  const qualities = episodeData?.qualities ?? [];
  const QUALITY_PRIORITY = ['1080p', '720p', '480p', '360p'];
  const sourceQuality = QUALITY_PRIORITY
    .map((label) => qualities.find((q) => q.nama_quality === label && q.source_quality))
    .find(Boolean);
  if (!sourceQuality) {
    return reply.code(422).send({
      error: 'Tidak ada source_quality yang tersedia pada episode ini',
      available: qualities.map((q) => q.nama_quality),
    });
  }

  const sourceUrl = sourceQuality.source_quality;
  const sourceSpec = RENDITIONS.find((r) => r.label === sourceQuality.nama_quality);
  const animeName = String(episodeData?.anime?.judul_anime || `anime_${episodeData?.anime?.id || 'unknown'}`)
    .replace(/[^a-zA-Z0-9_\- ]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 60);
  const epNum = String(episodeData?.nomor_episode ?? episodeId).padStart(2, '0');
  const objectKey = `DB/${animeName}/Eps.${epNum}/source_${sourceQuality.nama_quality}.mkv`;

  const cdnBase = String(process.env.B2_CDN_BASE || `https://cdn-stable.nanimeid.xyz/file/${process.env.B2_BUCKET_NAME || 'NanimeID'}`).replace(/\/+$/, '');
  const b2FolderBase = `DB/${animeName}/Eps.${epNum}/`;
  const masterFilePath = `${b2FolderBase}master.m3u8`;
  const existingMaster = await catalogPrisma.file.findUnique({ where: { filePath: masterFilePath } }).catch(() => null);

  if (existingMaster) {
    const rList = RENDITIONS.filter((r) => r.height <= (sourceSpec?.height ?? Infinity));
    const existingRenditions = await Promise.all(rList.map(async (r) => {
      const fp = `${b2FolderBase}${r.label}/${r.label}.m3u8`;
      const row = await catalogPrisma.file.findUnique({ where: { filePath: fp } }).catch(() => null);
      return row ? { label: r.label, hlsUrl: `${cdnBase}/${fp}` } : null;
    }));
    const foundRenditions = existingRenditions.filter(Boolean);

    if (foundRenditions.length === rList.length) {
      console.log(`[animeEncode] HLS already exists for episodeId=${episodeId}, skipping encode — running callback`);
      const masterUrl = `${cdnBase}/${masterFilePath}`;

      const callbackResults = await Promise.all(rList.map(async (r) => {
        const fp = `${b2FolderBase}${r.label}/${r.label}.m3u8`;
        const folderPrefix = `${b2FolderBase}${r.label}/`;
        const qualityFiles = await catalogPrisma.file.findMany({
          where: { filePath: { startsWith: folderPrefix } },
          select: { size: true, fileName: true },
        }).catch(() => []);
        const qualitySize = qualityFiles.reduce((sum, f) => sum + Number(f.size), 0) || null;
        const segments = qualityFiles.filter((f) => f.fileName.endsWith('.m4s')).length || null;
        return {
          nama_quality: r.label,
          success: true,
          hls_url: `${cdnBase}/${fp}`,
          hls_master_url: masterUrl,
          hls_size: qualitySize,
          source_quality: String(process.env.DELETE_SOURCE_AFTER_ENCODE || 'false').toLowerCase() === 'true' ? null : sourceUrl,
          job_id: jobId,
          metadata: {
            resolution: `${r.width}x${r.height}`,
            bitrate: r.videoBitrate,
            segments,
            duration: null,
          },
        };
      }));

      for (const r of callbackResults) {
        await upsertHlsEncodeRecord({
          episodeId,
          jobId,
          namaQuality: r.nama_quality,
          status: 'done',
          hlsUrl: r.hls_url,
          masterUrl,
          masterSize: r.hls_size,
          resolution: r.metadata?.resolution ?? null,
          bitrate: r.metadata?.bitrate ?? null,
          segments: r.metadata?.segments ?? null,
          duration: null,
          encodedAt: new Date(),
        }).catch(() => {});
      }

      await sendAdminCallback({ episodeId, jobId, results: callbackResults, adminToken });

      return reply.send({
        skipped: true,
        reason: 'HLS sudah ada di B2, encode dilewati',
        episodeId,
        masterUrl,
        renditions: foundRenditions,
      });
    }
  }

  await upsertJob({
    id: jobId,
    prefix: objectKey,
    status: 'queued',
    current: sourceUrl,
    done: 0,
    total: RENDITIONS.filter((r) => r.height <= (sourceSpec?.height ?? Infinity)).length,
    percent: 0,
  });

  reply.headers({ 'Cache-Control': 'no-store' }).send({
    jobId,
    ssePath: `/encode/job-sse/${encodeURIComponent(jobId)}`,
    status: 'queued',
    upload_b2: true,
    episodeId,
    sourceUrl,
    objectKey,
    renditions: RENDITIONS.map((r) => r.label),
  });

  setImmediate(() => _runAnimeEncodeJob({
    jobId,
    episodeId,
    sourceUrl,
    objectKey,
    adminToken,
    request,
    sourceSpec,
  }).catch((err) => {
    try { request?.log?.error({ jobId, message: err?.message }, 'Anime encode fatal error'); } catch {}
  }));
}

export async function animeEncodeJobStatusController(request, reply) {
  const id = request.params?.id || request.query?.id;
  if (!id) return reply.code(400).send({ error: 'Missing id' });
  const job = await getJobById(id);
  if (!job) return reply.code(404).send({ error: 'Job not found' });
  return reply.send(job);
}

export async function cancelAnimeEncodeJobController(request, reply) {
  const id = request.params?.id || request.query?.id;
  if (!id) return reply.code(400).send({ error: 'Missing id' });
  const ac = abortRegistry.get(id);
  if (ac) {
    try { ac.abort(); } catch {}
    return reply.send({ ok: true, message: 'Abort signal sent' });
  }
  const job = await getJobById(id);
  if (!job) return reply.code(404).send({ error: 'Job not found' });
  return reply.send({ ok: false, message: 'Job not running or already finished' });
}
