import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { PassThrough, Readable } from 'stream';
import pLimit from 'p-limit';
import { uploadFromStream, getB2UploadUrl } from '../lib/b2.js';
import { createPresignedPutUrl } from '../lib/s3.js';
import { upsertFolder, getFolderByPrefix, upsertFile } from '../lib/storageCatalogDb.js';
import { setProgress, getProgress } from '../utils/uploadProgress.js';
import { upsertJob, updateJobThrottled, getJobById, getJobByPrefix, listJobs, deleteJobById } from '../lib/uploadJobsDb.js';

const g = typeof globalThis !== 'undefined' ? globalThis : global;
if (!g.__uploadJobCancelRegistry) {
  g.__uploadJobCancelRegistry = new Map();
}
const cancelRegistry = g.__uploadJobCancelRegistry;

if (!g.__directUploadLinkRegistry) {
  g.__directUploadLinkRegistry = new Map();
}
const directUploadRegistry = g.__directUploadLinkRegistry;

if (!g.__uploadJobCleanupRegistry) {
  g.__uploadJobCleanupRegistry = new Map();
}
const cleanupRegistry = g.__uploadJobCleanupRegistry;

function getCancelState(jobId) {
  if (!jobId) return null;
  if (!cancelRegistry.has(jobId)) {
    cancelRegistry.set(jobId, { cancelled: false, kills: new Set() });
  }
  return cancelRegistry.get(jobId);
}

function isCancelled(jobId) {
  const st = getCancelState(jobId);
  return st?.cancelled === true;
}

function registerKill(jobId, fn) {
  const st = getCancelState(jobId);
  if (!st || typeof fn !== 'function') return () => {};
  st.kills.add(fn);
  return () => {
    try {
      st.kills.delete(fn);
    } catch {
    }
  };
}

function cancelJob(jobId) {
  const st = getCancelState(jobId);
  if (!st) return;
  st.cancelled = true;
  const kills = Array.from(st.kills || []);
  for (const k of kills) {
    try {
      k();
    } catch {
    }
  }
}

function clearCancelState(jobId) {
  if (!jobId) return;
  try {
    cancelRegistry.delete(jobId);
  } catch {
  }
  try {
    cleanupRegistry.delete(jobId);
  } catch {
  }
}

function registerJobCleanup(jobId, fn) {
  if (!jobId || typeof fn !== 'function') return () => {};
  if (!cleanupRegistry.has(jobId)) {
    cleanupRegistry.set(jobId, new Set());
  }
  const set = cleanupRegistry.get(jobId);
  set.add(fn);
  return () => {
    try {
      set.delete(fn);
      if (set.size === 0) {
        cleanupRegistry.delete(jobId);
      }
    } catch {
    }
  };
}

function runJobCleanup(jobId) {
  if (!jobId) return;
  const set = cleanupRegistry.get(jobId);
  if (!set || set.size === 0) return;
  for (const fn of Array.from(set)) {
    try {
      fn();
    } catch {
    }
  }
}

function removeDirSafe(dirPath) {
  if (!dirPath) return;
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
  }
}

function checkBinary(binPath, args = ['-version'], timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      const p = spawn(binPath, args);
      const to = setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve(false);
      }, timeoutMs);

      p.on('close', () => {
        clearTimeout(to);
        resolve(true);
      });

      p.on('error', () => {
        clearTimeout(to);
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

function makeJobId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRequestedJobId(value) {
  const cleaned = String(value || '').trim();
  if (!cleaned) return null;
  if (!/^[A-Za-z0-9_-]{6,120}$/.test(cleaned)) return null;
  return cleaned;
}

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function getTempRoot() {
  const env = process.env.ENCODE_TEMP_DIR;
  const dir = env
    ? (path.isAbsolute(env) ? env : path.resolve(PROJECT_ROOT, env))
    : os.tmpdir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function resolveRequestedJobId(...values) {
  for (const value of values) {
    const normalized = normalizeRequestedJobId(value);
    if (normalized) return normalized;
  }
  return makeJobId();
}

function buildUploadJobSsePath(jobId) {
  if (!jobId) return null;
  return `/b2/upload-job-sse/${encodeURIComponent(jobId)}`;
}

function parseFfmpegProgressSec(input) {
  const m = /time=([0-9:.]+)/.exec(String(input || ''));
  if (!m || !m[1]) return NaN;
  return parseDurationToSec(m[1]);
}

async function updateEncodeJobProgress(jobId, { current, seconds, duration, pctMin = 1, pctMax = 49 } = {}) {
  if (!jobId) return null;
  const prev = await getJobById(jobId);
  const prevPercent = Number(prev?.percent);
  let percent = Number.isFinite(prevPercent) ? prevPercent : 0;

  if (Number.isFinite(duration) && duration > 0 && Number.isFinite(seconds) && seconds >= 0) {
    const frac = Math.max(0, Math.min(1, seconds / duration));
    percent = pctMin + Math.round(frac * (pctMax - pctMin));
  } else if (Number.isFinite(seconds) && seconds >= 0) {
    const stepped = pctMin + Math.floor(seconds / 6);
    percent = Math.max(percent, stepped);
  } else {
    percent = Math.max(percent, pctMin);
  }

  percent = Math.max(pctMin, Math.min(pctMax, percent));
  return updateJobThrottled(
    jobId,
    { status: 'encoding', current: current ?? prev?.current ?? null, percent },
    { minIntervalMs: 800, minPercentDelta: 1 },
  );
}

export async function streamUploadJobsSseController(request, reply) {
  const active = request.query?.active;
  const limit = request.query?.limit;
  const activeOnly = active === '1' || active === 'true' || active === 'yes';

  const origin = request.headers?.origin || '*';

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  });

  reply.hijack();

  const writeEvent = (event, data) => {
    try {
      if (event) reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data ?? null)}\n\n`);
    } catch {
      // ignore
    }
  };

  writeEvent('hello', { ok: true, activeOnly, limit: limit ?? null });

  const getJobs = () => listJobs({ activeOnly, limit }).then((jobs) => (Array.isArray(jobs) ? jobs : []));

  const jobsNow = await getJobs();
  writeEvent('update', { jobs: jobsNow });

  let lastUpdatedAt = jobsNow.length ? (jobsNow[0]?.updated_at_ms ?? null) : null;
  let lastCount = jobsNow.length;

  const intervalMs = (() => {
    const n = Number(process.env.SSE_POLL_INTERVAL_MS || 1000);
    if (!Number.isFinite(n) || n < 250) return 1000;
    return Math.min(Math.trunc(n), 5000);
  })();

  const timer = setInterval(async () => {
    try {
      const jobs = await getJobs();
      const updated = jobs.length ? (jobs[0]?.updated_at_ms ?? null) : null;
      const count = jobs.length;
      if (updated === lastUpdatedAt && count === lastCount) return;
      lastUpdatedAt = updated;
      lastCount = count;
      writeEvent('update', { jobs });
    } catch (e) {
      writeEvent('error', { error: e?.message || 'SSE error' });
    }
  }, intervalMs);

  const onClose = () => {
    try {
      clearInterval(timer);
    } catch {
      // ignore
    }
  };

  try {
    request.raw.on('close', onClose);
  } catch {
    // ignore
  }
}

function parseEncodeFlag(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'no' || s === 'off');
}

function buildSafeHlsName(value, fallback = 'video') {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_ .-]+|[_ .-]+$/g, '');
  return normalized || fallback;
}

function buildHlsOutputPrefix({ objectKey }) {
  const cleaned = String(objectKey || '').replace(/^\/+/, '');
  if (!cleaned) return '';
  const ext = path.extname(cleaned);
  const baseNoExt = ext ? cleaned.slice(0, -ext.length) : cleaned;
  const parentDir = path.posix.dirname(baseNoExt);
  const rawLeaf = path.posix.basename(baseNoExt);
  const safeLeaf = buildSafeHlsName(rawLeaf);
  return parentDir && parentDir !== '.' ? `${parentDir}/${safeLeaf}/` : `${safeLeaf}/`;
}

function getHlsThreadsNumber() {
  const n = Number(process.env.HLS_THREADS || 4);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 8) : 4;
}

function getHlsUploadConcurrency() {
  const n = Number(process.env.HLS_UPLOAD_CONCURRENCY || 6);
  if (!Number.isFinite(n) || n <= 0) return 6;
  return Math.min(Math.trunc(n), 16);
}

function getFolderUploadConcurrency() {
  const n = Number(process.env.FOLDER_UPLOAD_CONCURRENCY || process.env.HLS_UPLOAD_CONCURRENCY || 6);
  if (!Number.isFinite(n) || n <= 0) return 6;
  return Math.min(Math.trunc(n), 16);
}

function buildHlsPackageConfig({ outDir, baseName }) {
  const playlistName = 'index.m3u8';
  const playlistPath = path.join(outDir, playlistName);
  const stem = String(baseName || '').replace(/\.[^/.]+$/, '') || 'video';
  const safeBaseName = buildSafeHlsName(stem, 'video');
  const initFileName = `${safeBaseName}_init.mp4`;
  const segmentPattern = path.join(outDir, `${safeBaseName}_%05d.m4s`);
  return { playlistName, playlistPath, initFileName, segmentPattern };
}

function buildHlsFfmpegArgs({ inputPath, outDir, baseName, threads = 4, usePipeInput = false }) {
  const { playlistPath, initFileName, segmentPattern } = buildHlsPackageConfig({ outDir, baseName });
  return [
    '-y',
    '-i',
    usePipeInput ? 'pipe:0' : inputPath,
    '-map',
    '0:v:0?',
    '-map',
    '0:a:0?',
    '-sn',
    '-dn',
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    '6',
    '-hls_list_size',
    '0',
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    initFileName,
    '-hls_segment_filename',
    segmentPattern,
    '-threads',
    String(threads),
    playlistPath,
  ];
}

function getHlsOutputContentType(fileName) {
  if (fileName.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (fileName.endsWith('.m4s')) return 'video/iso.segment';
  if (fileName.endsWith('.mp4')) return 'video/mp4';
  return 'application/octet-stream';
}

function sortHlsOutputFiles(files) {
  return [...files].sort((a, b) => {
    const aPlaylist = a === 'index.m3u8' ? 1 : 0;
    const bPlaylist = b === 'index.m3u8' ? 1 : 0;
    if (aPlaylist !== bPlaylist) return aPlaylist - bPlaylist;
    return a.localeCompare(b);
  });
}

function resolveHlsArtifactPath({ dirPath, uri }) {
  const raw = String(uri || '').trim();
  if (!raw) return null;

  const candidates = [];
  if (path.isAbsolute(raw)) {
    candidates.push(raw);
  } else {
    candidates.push(path.join(dirPath, raw));
    candidates.push(path.join(process.cwd(), raw));
    candidates.push(path.join(process.cwd(), path.basename(raw)));
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
    }
  }
  return null;
}

function prepareHlsArtifacts({ dirPath, playlistName = 'index.m3u8' }) {
  const playlistPath = path.join(dirPath, playlistName);
  const playlistText = fs.readFileSync(playlistPath, 'utf8');
  const lines = playlistText.split(/\r?\n/);
  const refs = [];
  const seen = new Set();

  const addRef = (uri) => {
    const raw = String(uri || '').trim();
    if (!raw || /^https?:\/\//i.test(raw)) return;
    if (seen.has(raw)) return;
    seen.add(raw);
    refs.push(raw);
  };

  for (const line of lines) {
    const mapMatch = /^#EXT-X-MAP:.*URI="([^"]+)"/i.exec(line.trim());
    if (mapMatch?.[1]) addRef(mapMatch[1]);
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    addRef(trimmed);
  }

  const replacements = new Map();
  const artifacts = [];
  for (const ref of refs) {
    const sourcePath = resolveHlsArtifactPath({ dirPath, uri: ref });
    const fileName = path.basename(ref);
    replacements.set(ref, fileName);
    artifacts.push({ ref, fileName, sourcePath });
  }

  const rewrittenLines = lines.map((line) => {
    const trimmed = line.trim();
    const mapMatch = /^#EXT-X-MAP:(.*)URI="([^"]+)"(.*)$/i.exec(line);
    if (mapMatch?.[2]) {
      const nextUri = replacements.get(mapMatch[2]) || path.basename(mapMatch[2]);
      return `${line.slice(0, mapMatch.index)}#EXT-X-MAP:${mapMatch[1]}URI="${nextUri}"${mapMatch[3]}`;
    }
    if (!trimmed || trimmed.startsWith('#')) return line;
    return replacements.get(trimmed) || path.basename(trimmed);
  });

  fs.writeFileSync(playlistPath, rewrittenLines.join('\n'));

  return {
    playlistPath,
    playlistTextBeforeRewrite: playlistText,
    artifacts,
  };
}

function validateHlsOutputs({ dirPath, playlistName = 'index.m3u8' }) {
  const playlistPath = path.join(dirPath, playlistName);
  const text = fs.readFileSync(playlistPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const mediaLines = lines.map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const targetMatch = /#EXT-X-TARGETDURATION:(\d+)/i.exec(text);
  const targetDuration = Number(targetMatch?.[1] || NaN);
  const extInfMatches = Array.from(text.matchAll(/#EXTINF:([0-9.]+)/gi));
  const durations = extInfMatches.map((m) => Number(m?.[1] || NaN)).filter((n) => Number.isFinite(n));
  const mapMatch = /#EXT-X-MAP:.*URI="([^"]+)"/i.exec(text);
  const mapUri = mapMatch?.[1] || null;

  if (!mediaLines.length) {
    throw new Error('Generated HLS playlist has no media segments');
  }
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) {
    throw new Error(`Generated HLS playlist has invalid TARGETDURATION: ${targetMatch?.[1] || 'missing'}`);
  }
  if (durations.length && durations.every((n) => n <= 0)) {
    throw new Error('Generated HLS playlist has only zero-duration segments');
  }
  if (!mapUri) {
    throw new Error('Generated fMP4 HLS playlist is missing EXT-X-MAP');
  }
  const initPath = resolveHlsArtifactPath({ dirPath, uri: mapUri });
  if (!initPath) {
    throw new Error(`Generated HLS init segment not found: ${mapUri}`);
  }
}

async function streamToTempInputFile({ inputStream, outputPath, jobId, request, label, totalBytes }) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outputPath);
    const total = Number(totalBytes);
    const hasTotal = Number.isFinite(total) && total > 0;
    let written = 0;
    let lastLogAt = 0;
    let settled = false;
    const log = request?.log;
    const unregister = registerKill(jobId, () => {
      try {
        inputStream.destroy(new Error('Job cancelled'));
      } catch {
      }
      try {
        ws.destroy(new Error('Job cancelled'));
      } catch {
      }
    });

    const cleanup = () => {
      try {
        unregister();
      } catch {
      }
      try {
        inputStream.off('data', onData);
        inputStream.off('error', onError);
      } catch {
      }
      try {
        ws.off('error', onError);
        ws.off('finish', onFinish);
      } catch {
      }
    };

    const finish = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) return reject(err);
      return resolve({ outputPath, size: written });
    };

    const onData = (chunk) => {
      written += chunk?.length || 0;
      const now = Date.now();
      if (now - lastLogAt < 3000) return;
      lastLogAt = now;
      try {
        log?.info(
          {
            label,
            tempInputPath: outputPath,
            bufferedBytes: written,
            totalBytes: hasTotal ? total : null,
            percent: hasTotal ? Math.floor((written / total) * 100) : null,
          },
          'Buffering input for HLS',
        );
      } catch {
      }
    };

    const onError = (err) => finish(err);
    const onFinish = () => finish();

    inputStream.on('data', onData);
    inputStream.on('error', onError);
    ws.on('error', onError);
    ws.on('finish', onFinish);
    inputStream.pipe(ws);
  });
}

async function uploadHlsOutputsToB2({ request, dirPath, hlsPrefix, folderId, jobId, objectKey }) {
  const prepared = prepareHlsArtifacts({ dirPath, playlistName: 'index.m3u8' });
  const artifactFiles = prepared.artifacts.filter((item) => item?.fileName);
  const outFiles = sortHlsOutputFiles([...artifactFiles.map((item) => item.fileName), 'index.m3u8']);
  const artifactMap = new Map(artifactFiles.map((item) => [item.fileName, item.sourcePath]));
  const totalOut = outFiles.length;
  const concurrency = getHlsUploadConcurrency();
  const limit = pLimit(concurrency);
  let doneOut = 0;

  try {
    request?.log?.info(
      {
        jobId,
        objectKey,
        hlsPrefix,
        totalOut,
        concurrency,
        outFiles,
        playlistPreview: prepared.playlistTextBeforeRewrite.slice(0, 1200),
      },
      'HLS output ready, start upload',
    );
  } catch {
  }

  const uploadOne = async (f) => {
    if (isCancelled(jobId)) throw new Error('Job cancelled');
    const full = f === 'index.m3u8' ? prepared.playlistPath : artifactMap.get(f);
    if (!full || !fs.existsSync(full)) {
      throw new Error(`Missing HLS artifact file: ${f}`);
    }
    const fileSize = (() => {
      try {
        return fs.statSync(full)?.size || 0;
      } catch {
        return 0;
      }
    })();
    const key = `${hlsPrefix}${f}`;
    const ct = getHlsOutputContentType(f);
    const startedAt = Date.now();

    try {
      request?.log?.info(
        { jobId, objectKey, outKey: key, outFile: f, outSize: fileSize, outContentType: ct, outIndex: doneOut + 1, outTotal: totalOut },
        'HLS upload start',
      );
    } catch {
    }

    const stream = fs.createReadStream(full);
    await uploadFromStream({ fileName: key, stream, contentType: ct, expectedSizeBytes: fileSize });

    try {
      request?.log?.info(
        { jobId, objectKey, outKey: key, outFile: f, outSize: fileSize, durationMs: Date.now() - startedAt, outIndex: doneOut + 1, outTotal: totalOut },
        'HLS upload finished',
      );
    } catch {
    }

    try {
      fs.rmSync(full, { force: true });
    } catch {
    }

    doneOut += 1;
    const pct = 50 + Math.round((doneOut / Math.max(1, totalOut)) * 50);
    await updateJobThrottled(jobId, { status: 'uploading', current: key, percent: Math.min(99, pct) });

    await upsertFile({
      folderId,
      fileName: f,
      filePath: key,
      size: fileSize,
      contentType: ct,
      uploadedAt: new Date().toISOString(),
    });
  };

  const mediaFiles = outFiles.filter((f) => f !== 'index.m3u8');
  const playlistFile = outFiles.find((f) => f === 'index.m3u8');

  await Promise.all(mediaFiles.map((f) => limit(() => uploadOne(f))));
  if (playlistFile) {
    await uploadOne(playlistFile);
  }

  return { totalOut };
}

async function packageToHls({ inputPath, outDir, baseName, ffmpegPath, threads = 4, onProgress }) {
  fs.mkdirSync(outDir, { recursive: true });
  const { playlistName, playlistPath } = buildHlsPackageConfig({ outDir, baseName });
  const args = buildHlsFfmpegArgs({ inputPath, outDir, baseName, threads, usePipeInput: false });

  await runFfmpeg(ffmpegPath, args, (sec) => {
    try {
      onProgress?.(sec);
    } catch {
    }
  });

  return { playlistPath, playlistName, outDir };
}

function startUploadProgressLogger({ request, label, totalBytes }) {
  const log = request?.log;
  const total = Number(totalBytes);
  const hasTotal = Number.isFinite(total) && total > 0;

  let uploaded = 0;
  let lastLogAt = 0;
  let lastPct = -1;
  const startedAt = Date.now();
  const intervalMs = 3000;

  const passthrough = new PassThrough();
  passthrough.on('data', (chunk) => {
    uploaded += chunk?.length || 0;
    const now = Date.now();
    const pct = hasTotal ? Math.floor((uploaded / total) * 100) : null;
    const shouldLog = now - lastLogAt >= intervalMs || (pct != null && pct !== lastPct && pct % 5 === 0);
    if (!shouldLog) return;
    lastLogAt = now;
    if (pct != null) lastPct = pct;
    const elapsedSec = Math.max(1, Math.round((now - startedAt) / 1000));
    const rate = Math.round(uploaded / elapsedSec);
    try {
      log?.info(
        {
          label,
          uploadedBytes: uploaded,
          totalBytes: hasTotal ? total : null,
          percent: pct,
          bytesPerSec: rate,
          elapsedSec,
        },
        'Upload progress',
      );
    } catch {
      // ignore
    }
  });

  let finished = false;
  const onAborted = () => {
    if (finished) return;
    // Node sets req.aborted=true only when the client aborts before request is fully received.
    const aborted = request?.raw?.aborted === true;
    if (!aborted) return;
    try {
      log?.warn({ label, uploadedBytes: uploaded }, 'Upload aborted by client');
    } catch {
      // ignore
    }
    try {
      passthrough.destroy(new Error('Client aborted upload'));
    } catch {
      // ignore
    }
  };
  request?.raw?.on('aborted', onAborted);

  const cleanup = () => {
    finished = true;
    try {
      request?.raw?.off('aborted', onAborted);
    } catch {
      // ignore
    }
  };

  return { passthrough, getUploadedBytes: () => uploaded, cleanup };
}

async function ensureFolderHierarchy(prefix) {
  const cleaned = String(prefix || '')
    .replace(/^\/+|\/+$/g, '')
    .trim();
  if (!cleaned) {
    return null;
  }

  const parts = cleaned
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);

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

function normalizeFilePathAndName({ filePath, fileName, prefix }) {
  const cleanedPrefix = String(prefix || '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .join('/');

  const cleanedPath = String(filePath || '')
    .replace(/^\/+/, '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .join('/');

  if (cleanedPath) {
    const objectKey = (() => {
      if (!cleanedPrefix) return cleanedPath;
      const pref = `${cleanedPrefix}/`;
      if (cleanedPath === cleanedPrefix) return cleanedPath;
      if (cleanedPath.startsWith(pref)) return cleanedPath;
      return `${cleanedPrefix}/${cleanedPath}`;
    })();

    const keyParts = objectKey.split('/').filter(Boolean);
    const parts = cleanedPath.split('/').filter(Boolean);
    const base = parts[parts.length - 1] || '';
    const folderPrefix = keyParts.length > 1 ? `${keyParts.slice(0, -1).join('/')}/` : '';
    return {
      objectKey,
      baseName: base,
      folderPrefix,
    };
  }

  const name = String(fileName || '').trim();
  const objectKey = cleanedPrefix ? `${cleanedPrefix}/${name}` : name;
  const folderPrefix = cleanedPrefix ? `${cleanedPrefix}/` : '';
  return {
    objectKey,
    baseName: name,
    folderPrefix,
  };
}

function cleanRelativePath(input) {
  const cleaned = String(input || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => Boolean(p) && p !== '.' && p !== '..')
    .join('/');
  return cleaned;
}

function makeDirectUploadToken() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function getRequestContentLength(request) {
  const raw = request?.headers?.['content-length'];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function safeUrl(input) {
  try {
    const u = new URL(String(input || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

function getCdnBase() {
  return String(process.env.B2_CDN_BASE || `https://cdn-stable.nanimeid.xyz/file/${process.env.B2_BUCKET_NAME || 'NanimeID'}`).replace(/\/+$/, '');
}

function buildStreamUrl(objectKey) {
  const cdnBase = getCdnBase();
  const cleaned = String(objectKey || '').replace(/^\/+/, '');
  if (!cleaned) return null;
  const encoded = cleaned.split('/').map(encodeURIComponent).join('/');
  return `${cdnBase}/${encoded}`;
}

function detectFileType(fileName) {
  const lower = String(fileName || '').toLowerCase();
  if (lower.endsWith('.m3u8')) return 'hls';
  if (lower.endsWith('.mp4')) return 'mp4';
  return null;
}

function buildResultFiles(files) {
  if (!Array.isArray(files)) return [];
  return files
    .map((f) => {
      const objectKey = f?.id || f?.path || f?.filePath || '';
      if (!objectKey) return null;
      const name = f?.name || path.posix.basename(objectKey) || '';
      const type = f?.type || detectFileType(name) || 'mp4';
      return {
        path: objectKey,
        name,
        type,
        streamUrl: buildStreamUrl(objectKey),
      };
    })
    .filter(Boolean);
}

function enrichFileWithTypeAndUrl(file) {
  if (!file) return file;
  const objectKey = file?.id || file?.path || file?.filePath || '';
  const name = file?.name || '';
  return {
    ...file,
    type: file?.type || detectFileType(name) || 'mp4',
    streamUrl: file?.streamUrl || (objectKey ? buildStreamUrl(objectKey) : null),
  };
}

export async function importB2ByUrlController(request, reply) {
  let jobId = null;
  let unregisterAbort = null;
  try {
    const body = request.body || {};
    const sourceUrlRaw = body?.sourceUrl ?? body?.url;
    const url = safeUrl(sourceUrlRaw);
    if (!url) {
      return reply.code(400).send({ error: 'Invalid sourceUrl' });
    }

    const prefixCleaned = cleanRelativePath(body?.prefix ?? request.query?.prefix);
    const relativePathCleaned = cleanRelativePath(body?.relativePath ?? body?.filePath ?? body?.path ?? request.query?.relativePath);
    const encode = parseEncodeFlag(body?.encode ?? request.query?.encode);

    const fileNameFromUrl = (() => {
      try {
        const p = decodeURIComponent(url.pathname || '');
        const base = path.basename(p);
        return base || '';
      } catch {
        return '';
      }
    })();
    const fileName = String(body?.fileName || body?.filename || fileNameFromUrl || 'video.mp4').trim();
    const contentTypeOverride = String(body?.contentType || body?.mimeType || '').trim();

    const norm = normalizeFilePathAndName({
      filePath: relativePathCleaned,
      fileName,
      prefix: prefixCleaned,
    });

    const objectKey = norm.objectKey;
    const baseName = norm.baseName;
    const folderPrefix = norm.folderPrefix;

    const videoExt = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'];
    const ext = (baseName.lastIndexOf('.') !== -1 ? baseName.slice(baseName.lastIndexOf('.')) : '').toLowerCase();
    const isVideoByExt = videoExt.includes(ext);
    const isVideoByOverrideMime = (() => {
      const lower = String(contentTypeOverride || '').toLowerCase();
      return lower ? lower.startsWith('video/') : false;
    })();

    jobId = resolveRequestedJobId(body?.jobId, body?.job_id, request.query?.jobId, request.query?.job_id, request.headers?.['x-upload-job-id']);
    await upsertJob({ id: jobId, prefix: prefixCleaned || null, status: 'downloading', current: objectKey, done: 0, total: 0, percent: 0 });
    getCancelState(jobId);

    const ac = new AbortController();
    unregisterAbort = registerKill(jobId, () => {
      try {
        ac.abort();
      } catch {
      }
    });

    let res;
    res = await fetch(url.toString(), { method: 'GET', signal: ac.signal, redirect: 'follow' });

    if (!res?.ok) {
      const err = new Error(`Failed to fetch sourceUrl: ${res?.status || 'unknown'}`);
      err.status = res?.status;
      throw err;
    }

    const remoteContentType = String(res.headers?.get('content-type') || '').trim();
    const contentType = contentTypeOverride || remoteContentType || 'application/octet-stream';
    const isVideoByRemoteMime = (() => {
      const lower = String(remoteContentType || '').toLowerCase();
      return lower ? lower.startsWith('video/') : false;
    })();

    if (!encode && !isVideoByExt && !isVideoByOverrideMime && !isVideoByRemoteMime) {
      return reply.code(400).send({ error: 'Only video files are allowed for this endpoint' });
    }
    const declaredSize = (() => {
      const n = Number(res.headers?.get('content-length'));
      return Number.isFinite(n) && n > 0 ? n : NaN;
    })();

    const inputStream = (() => {
      const body = res.body;
      if (!body) return null;
      if (typeof body.pipe === 'function') return body;
      try {
        if (typeof Readable?.fromWeb === 'function') {
          return Readable.fromWeb(body);
        }
      } catch {
      }
      return null;
    })();
    if (!inputStream || typeof inputStream.pipe !== 'function') {
      throw new Error('Remote response body is not a stream');
    }

    const files = [];

    if (isCancelled(jobId)) {
      await updateJobThrottled(jobId, { status: 'cancelled', error: 'Cancelled', percent: 100 });
      return reply.code(409).send({ error: 'Job cancelled', jobId });
    }

    if (encode) {
      await updateJobThrottled(jobId, { status: 'buffering', current: objectKey, percent: 0 });

      const tmpDir = fs.mkdtempSync(path.join(getTempRoot(), 'hls-'));
      const unregisterTmpCleanup = registerJobCleanup(jobId, () => {
        removeDirSafe(tmpDir);
      });
      try {
        const ffmpegPath = await getFfmpegPath();
        const ffmpegOk = await checkBinary(ffmpegPath);
        if (!ffmpegOk) {
          throw new Error(
            `ffmpeg not found or not executable at ${ffmpegPath}. Install system ffmpeg or set FFMPEG_PATH/.env, or install ffmpeg-static.`,
          );
        }

        const hlsOutDir = path.join(tmpDir, 'out');
        const hlsPrefix = buildHlsOutputPrefix({ objectKey });
        const tempInputPath = path.join(tmpDir, `input${path.extname(baseName) || '.bin'}`);

        try {
          request.log.info({ jobId, objectKey, hlsPrefix, sourceUrl: url.toString() }, 'HLS encode start (import-by-url)');
        } catch {
        }

        await streamToTempInputFile({
          inputStream,
          outputPath: tempInputPath,
          jobId,
          request,
          label: `hls-buffer:${objectKey}`,
          totalBytes: declaredSize,
        });

        await updateJobThrottled(jobId, { status: 'encoding', current: objectKey, percent: 5 });
        await packageToHls({
          inputPath: tempInputPath,
          outDir: hlsOutDir,
          baseName,
          ffmpegPath,
          threads: getHlsThreadsNumber(),
          onProgress: (sec) => updateEncodeJobProgress(jobId, { current: objectKey, seconds: sec, pctMin: 5, pctMax: 49 }),
        });
        validateHlsOutputs({ dirPath: hlsOutDir, playlistName: 'index.m3u8' });

        await updateJobThrottled(jobId, { status: 'uploading', current: objectKey, percent: 50 });

        const folderId = await ensureFolderHierarchy(hlsPrefix);
        await uploadHlsOutputsToB2({ request, dirPath: hlsOutDir, hlsPrefix, folderId, jobId, objectKey });

        files.push({
          id: `${hlsPrefix}index.m3u8`,
          name: 'index.m3u8',
          mimeType: 'application/vnd.apple.mpegurl',
          size: 0,
          modifiedTime: new Date().toISOString(),
        });
      } finally {
        unregisterTmpCleanup();
        removeDirSafe(tmpDir);
      }
    } else {
      await updateJobThrottled(jobId, { status: 'uploading', current: objectKey, percent: 0 });

      const logger = startUploadProgressLogger({ request, label: `b2-import:${objectKey}`, totalBytes: declaredSize });
      inputStream.pipe(logger.passthrough);

      let uploadRes;
      try {
        uploadRes = await uploadFromStream({ fileName: objectKey, stream: logger.passthrough, contentType, expectedSizeBytes: declaredSize });
      } finally {
        logger.cleanup();
      }

      const folderId = await ensureFolderHierarchy(folderPrefix);
      const size = Number(uploadRes?.contentLength) || (Number.isFinite(declaredSize) ? declaredSize : 0);
      const uploadedAt = uploadRes?.uploadTimestamp ? new Date(uploadRes.uploadTimestamp).toISOString() : undefined;
      const ct = uploadRes?.contentType || contentType || 'application/octet-stream';
      await upsertFile({ folderId, fileName: baseName, filePath: objectKey, size, contentType: ct, uploadedAt });
      files.push({ id: objectKey, name: baseName, mimeType: ct, size, modifiedTime: uploadedAt || null });
    }

    const resultFiles = buildResultFiles(files);
    if (isCancelled(jobId)) {
      await updateJobThrottled(jobId, { status: 'cancelled', error: 'Cancelled', done: files.length, total: files.length, percent: 100, resultFiles });
    } else {
      await updateJobThrottled(jobId, { status: 'done', done: files.length, total: files.length, percent: 100, resultFiles });
    }

    return reply
      .headers({ 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' })
      .send({ jobId, ssePath: buildUploadJobSsePath(jobId), files: files.map(enrichFileWithTypeAndUrl), resultFiles });
  } catch (err) {
    request.log.error({ message: err?.message, stack: err?.stack }, 'Import by URL error');
    if (jobId) {
      if (isCancelled(jobId)) {
        await updateJobThrottled(jobId, { status: 'cancelled', error: 'Cancelled', percent: 100 });
      } else {
        await updateJobThrottled(jobId, { status: 'error', error: err?.message || 'Import failed', percent: 100 });
      }
    }
    return reply.code(500).send({ error: 'Failed to import by URL', details: err?.message, jobId, ssePath: buildUploadJobSsePath(jobId) });
  } finally {
    try {
      unregisterAbort?.();
    } catch {
    }
    try {
      clearCancelState(jobId);
    } catch {
    }
  }
}

export async function createDirectUploadLinkController(request, reply) {
  try {
    const body = request.body || {};

    const prefix = cleanRelativePath(body?.prefix ?? request.query?.prefix);
    const relativePath = cleanRelativePath(body?.relativePath ?? body?.filePath ?? body?.path ?? request.query?.relativePath);
    const fileName = String(body?.fileName || body?.filename || '').trim();
    const contentType = String(body?.contentType || body?.mimeType || 'application/octet-stream').trim() || 'application/octet-stream';
    const encode = parseEncodeFlag(body?.encode ?? request.query?.encode);
    const size = (() => {
      const n = Number(body?.size ?? body?.fileSize);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();

    if (!relativePath && !fileName) {
      return reply.code(400).send({ error: 'Missing relativePath (or fileName)' });
    }

    const ttlSeconds = (() => {
      const n = Number(body?.expiresInSeconds ?? body?.expires ?? body?.ttl);
      if (!Number.isFinite(n) || n <= 0) return 1800;
      return Math.min(Math.max(Math.trunc(n), 60), 6 * 3600);
    })();
    const expiresAtMs = Date.now() + ttlSeconds * 1000;

    const jobId = resolveRequestedJobId(body?.jobId, body?.job_id, request.query?.jobId, request.query?.job_id, request.headers?.['x-upload-job-id']);
    await upsertJob({ id: jobId, prefix: prefix || null, status: 'waiting_upload', current: null, done: 0, total: 0, percent: 0 });
    getCancelState(jobId);

    const token = makeDirectUploadToken();
    directUploadRegistry.set(token, {
      token,
      jobId,
      prefix,
      relativePath,
      fileName,
      contentType,
      encode,
      size,
      createdAtMs: Date.now(),
      expiresAtMs,
      used: false,
    });

    const uploadPath = `/b2/direct-upload/${encodeURIComponent(token)}`;

    return reply
      .headers({ 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' })
      .send({
        jobId,
        ssePath: buildUploadJobSsePath(jobId),
        method: 'PUT',
        uploadUrl: uploadPath,
        expiresInSeconds: ttlSeconds,
        expiresAt: new Date(expiresAtMs).toISOString(),
        encode: encode ? 1 : 0,
      });
  } catch (err) {
    request.log.error({ message: err?.message, stack: err?.stack }, 'Create direct upload link error');
    return reply.code(500).send({ error: 'Failed to create direct upload link', details: err?.message });
  }
}

export async function directUploadPutController(request, reply) {
  const token = request.params?.token;
  if (!token) return reply.code(400).send({ error: 'Missing token' });
  const entry = directUploadRegistry.get(token);
  if (!entry) return reply.code(404).send({ error: 'Upload link not found' });

  const inputStream = (() => {
    const b = request.body;
    if (b && typeof b.pipe === 'function') return b;
    return request.raw;
  })();

  const now = Date.now();
  if (entry.expiresAtMs && now > entry.expiresAtMs) {
    try {
      directUploadRegistry.delete(token);
    } catch {
    }
    return reply.code(410).send({ error: 'Upload link expired' });
  }
  if (entry.used) {
    return reply.code(409).send({ error: 'Upload link already used' });
  }

  entry.used = true;

  const jobId = entry.jobId;

  const prefixCleaned = cleanRelativePath(entry.prefix);
  const relativePathCleaned = cleanRelativePath(entry.relativePath);
  const norm = normalizeFilePathAndName({
    filePath: relativePathCleaned,
    fileName: entry.fileName || (relativePathCleaned ? path.basename(relativePathCleaned) : ''),
    prefix: prefixCleaned,
  });
  const objectKey = norm.objectKey;
  const baseName = norm.baseName;
  const folderPrefix = norm.folderPrefix;

  await updateJobThrottled(jobId, { status: entry.encode ? 'encoding' : 'uploading', current: objectKey, percent: 0, prefix: prefixCleaned || null });

  if (isCancelled(jobId)) {
    await updateJobThrottled(jobId, { status: 'cancelled', error: 'Cancelled', percent: 100 });
    return reply.code(409).send({ error: 'Job cancelled' });
  }

  const contentType = String(request.headers?.['content-type'] || entry.contentType || 'application/octet-stream');
  const declaredSize = (() => {
    const fromHeader = getRequestContentLength(request);
    if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader;
    const n = Number(entry.size);
    if (Number.isFinite(n) && n > 0) return n;
    return NaN;
  })();

  const files = [];

  try {
    if (entry.encode) {
      const tmpDir = fs.mkdtempSync(path.join(getTempRoot(), 'hls-'));
      const unregisterTmpCleanup = registerJobCleanup(jobId, () => {
        removeDirSafe(tmpDir);
      });
      try {
        const ffmpegPath = await getFfmpegPath();
        const ffmpegOk = await checkBinary(ffmpegPath);
        if (!ffmpegOk) {
          throw new Error(
            `ffmpeg not found or not executable at ${ffmpegPath}. Install system ffmpeg or set FFMPEG_PATH/.env, or install ffmpeg-static.`,
          );
        }

        const hlsOutDir = path.join(tmpDir, 'out');
        const hlsPrefix = buildHlsOutputPrefix({ objectKey });
        const tempInputPath = path.join(tmpDir, `input${path.extname(baseName) || '.bin'}`);

        try {
          request.log.info({ jobId, objectKey, hlsPrefix }, 'HLS encode start (direct)');
        } catch {
        }

        await updateJobThrottled(jobId, { status: 'buffering', current: objectKey, percent: 0 });
        await streamToTempInputFile({
          inputStream,
          outputPath: tempInputPath,
          jobId,
          request,
          label: `hls-buffer:${objectKey}`,
          totalBytes: declaredSize,
        });

        await updateJobThrottled(jobId, { status: 'encoding', current: objectKey, percent: 5 });
        await packageToHls({
          inputPath: tempInputPath,
          outDir: hlsOutDir,
          baseName,
          ffmpegPath,
          threads: getHlsThreadsNumber(),
          onProgress: (sec) => updateEncodeJobProgress(jobId, { current: objectKey, seconds: sec, pctMin: 5, pctMax: 49 }),
        });
        validateHlsOutputs({ dirPath: hlsOutDir, playlistName: 'index.m3u8' });

        await updateJobThrottled(jobId, { status: 'uploading', current: objectKey, percent: 50 });

        const folderId = await ensureFolderHierarchy(hlsPrefix);
        await uploadHlsOutputsToB2({ request, dirPath: hlsOutDir, hlsPrefix, folderId, jobId, objectKey });

        files.push({
          id: `${hlsPrefix}index.m3u8`,
          name: 'index.m3u8',
          mimeType: 'application/vnd.apple.mpegurl',
          size: 0,
          modifiedTime: new Date().toISOString(),
        });
      } finally {
        unregisterTmpCleanup();
        removeDirSafe(tmpDir);
      }
    } else {
      const logger = startUploadProgressLogger({ request, label: `b2-direct:${objectKey}`, totalBytes: declaredSize });
      inputStream.pipe(logger.passthrough);
      let uploadRes;
      try {
        uploadRes = await uploadFromStream({ fileName: objectKey, stream: logger.passthrough, contentType, expectedSizeBytes: declaredSize });
      } finally {
        logger.cleanup();
      }

      const folderId = await ensureFolderHierarchy(folderPrefix);
      const size = Number(uploadRes?.contentLength) || (Number.isFinite(declaredSize) ? declaredSize : 0);
      const uploadedAt = uploadRes?.uploadTimestamp ? new Date(uploadRes.uploadTimestamp).toISOString() : undefined;
      const ct = uploadRes?.contentType || contentType || 'application/octet-stream';

      await upsertFile({ folderId, fileName: baseName, filePath: objectKey, size, contentType: ct, uploadedAt });
      files.push({ id: objectKey, name: baseName, mimeType: ct, size, modifiedTime: uploadedAt || null });
    }

    const resultFiles = buildResultFiles(files);
    if (isCancelled(jobId)) {
      await updateJobThrottled(jobId, { status: 'cancelled', error: 'Cancelled', done: files.length, total: files.length, percent: 100, resultFiles });
    } else {
      await updateJobThrottled(jobId, { status: 'done', done: files.length, total: files.length, percent: 100, resultFiles });
    }

    return reply
      .headers({ 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' })
      .send({ jobId, ssePath: buildUploadJobSsePath(jobId), files: files.map(enrichFileWithTypeAndUrl), resultFiles });
  } catch (err) {
    request.log.error({ message: err?.message, stack: err?.stack }, 'Direct upload error');
    if (jobId) {
      if (isCancelled(jobId)) {
        await updateJobThrottled(jobId, { status: 'cancelled', error: 'Cancelled', percent: 100 });
      } else {
        await updateJobThrottled(jobId, { status: 'error', error: err?.message || 'Upload failed', percent: 100 });
      }
    }
    return reply.code(500).send({ error: 'Failed to upload', details: err?.message, jobId, ssePath: buildUploadJobSsePath(jobId) });
  } finally {
    try {
      directUploadRegistry.delete(token);
    } catch {
    }
    try {
      clearCancelState(jobId);
    } catch {
    }
  }
}

export async function getB2UploadUrlController(request, reply) {
  try {
    const res = await getB2UploadUrl();
    if (!res?.uploadUrl || !res?.authorizationToken) {
      return reply.code(500).send({ error: 'Failed to get B2 upload URL' });
    }
    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send(res);
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
      },
      'B2 get upload url error',
    );
    return reply.code(500).send({ error: 'Failed to get B2 upload URL', details: err?.message });
  }
}

export async function commitB2UploadController(request, reply) {
  try {
    const body = request.body || {};
    const jobId = body.jobId || body.job_id || null;
    const inputFiles = Array.isArray(body.files) ? body.files : [body];

    const files = [];
    const errors = [];

    for (const f of inputFiles) {
      const ff = f || {};
      const filePath = ff.filePath ?? ff.path ?? ff.relativePath ?? ff.id;
      const fileName = ff.fileName ?? ff.filename ?? ff.name;
      const prefix = ff.prefix;
      const size = ff.size ?? ff.fileSize;
      const contentType = ff.contentType ?? ff.mimeType;
      const uploadedAt = ff.uploadedAt ?? ff.modifiedTime;

      const norm = normalizeFilePathAndName({ filePath, fileName, prefix });
      const objectKey = norm.objectKey;
      const baseName = norm.baseName;
      const folderPrefix = norm.folderPrefix;

      if (!objectKey || !baseName) {
        errors.push({
          filePath: filePath || null,
          fileName: fileName || null,
          error: 'Missing filePath or (prefix + fileName)',
        });
        continue;
      }

      let folderId;
      try {
        folderId = await ensureFolderHierarchy(folderPrefix);
      } catch (e) {
        errors.push({
          fileName: baseName,
          objectKey,
          stage: 'ensureFolderHierarchy',
          error: e?.message || 'Commit failed',
          code: e?.code || null,
          name: e?.name || null,
        });
        continue;
      }

      try {
        await upsertFile({
          folderId,
          fileName: baseName,
          filePath: objectKey,
          size: Number(size) || 0,
          contentType: contentType || 'application/octet-stream',
          uploadedAt: uploadedAt || null,
        });
      } catch (e) {
        errors.push({
          fileName: baseName,
          objectKey,
          stage: 'upsertFile',
          error: e?.message || 'Commit failed',
          code: e?.code || null,
          name: e?.name || null,
        });
        continue;
      }

      files.push({
        id: objectKey,
        name: baseName,
        mimeType: contentType || 'application/octet-stream',
        size: Number(size) || 0,
        modifiedTime: uploadedAt || null,
      });
    }

    const resultFiles = buildResultFiles(files);
    if (jobId) {
      if (isCancelled(jobId)) {
        await updateJobThrottled(jobId, { status: 'cancelled', error: 'Cancelled', done: files.length, total: files.length + errors.length, percent: 100, resultFiles });
      } else {
        await updateJobThrottled(jobId, { status: errors.length ? 'partial' : 'done', done: files.length, total: files.length + errors.length, percent: 100, resultFiles });
      }
    }

    if (files.length === 0 && errors.length) {
      return reply.code(400).send({ error: 'No files committed', errors });
    }

    const statusCode = errors.length ? 207 : 200;
    return reply
      .code(statusCode)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ jobId: jobId || undefined, files: files.map(enrichFileWithTypeAndUrl), resultFiles, errors: errors.length ? errors : undefined });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
        code: err?.code,
        name: err?.name,
      },
      'B2 upload commit error',
    );
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Failed to commit upload', details: err?.message });
  }
}

export async function getB2S3PresignPutController(request, reply) {
  try {
    const q = request.query || {};
    const body = request.body || {};
    const input = Object.keys(body).length ? body : q;

    const encode = input?.encode;
    if (parseEncodeFlag(encode)) {
      return reply.code(400).send({
        error: 'Encode requires backend upload',
        details: 'If encode is enabled, upload the file(s) to /b2/upload-folder-multipart with encode=1 so the backend can process HLS.',
      });
    }

    const { filePath, fileName, prefix, contentType } = input || {};
    const jobId = input?.jobId || input?.job_id || null;

    const norm = normalizeFilePathAndName({ filePath, fileName, prefix });
    const objectKey = norm.objectKey;

    if (!objectKey) {
      return reply.code(400).send({ error: 'Missing filePath or (prefix + fileName)' });
    }

    const bucket = process.env.B2_S3_BUCKET_NAME || process.env.B2_BUCKET_NAME;
    if (!bucket) {
      return reply.code(500).send({ error: 'Missing B2_S3_BUCKET_NAME (or B2_BUCKET_NAME) env var' });
    }

    if (jobId) {
      await upsertJob({
        id: jobId,
        prefix: norm.folderPrefix || null,
        status: 'waiting_upload',
        current: objectKey,
        done: 0,
        total: 1,
        percent: 0,
      });
    }

    const expiresInSeconds = (() => {
      const raw = input?.expiresInSeconds ?? input?.expires ?? input?.ttl;
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return 600;
      return Math.min(Math.max(Math.trunc(n), 60), 3600);
    })();

    const signed = await createPresignedPutUrl({
      bucket,
      key: objectKey,
      contentType: contentType || 'application/octet-stream',
      expiresInSeconds,
    });

    if (jobId) {
      await updateJobThrottled(jobId, { status: 'uploading', current: objectKey, percent: 5 });
    }

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({
        jobId: jobId || undefined,
        ssePath: jobId ? buildUploadJobSsePath(jobId) : undefined,
        filePath: objectKey,
        bucket,
        method: signed.method,
        url: signed.url,
        expiresInSeconds,
      });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
      },
      'B2 S3 presign error',
    );
    return reply.code(500).send({ error: 'Failed to presign upload', details: err?.message });
  }
}

export async function getB2S3PresignPutBatchController(request, reply) {
  try {
    const body = request.body || {};
    const inputFiles = Array.isArray(body.files) ? body.files : [];
    const jobId = body.jobId || body.job_id || null;

    if (parseEncodeFlag(body?.encode)) {
      return reply.code(400).send({
        error: 'Encode requires backend upload',
        details: 'If encode is enabled, upload the file(s) to /b2/upload-folder-multipart with encode=1 so the backend can process HLS.',
      });
    }

    if (!inputFiles.length) {
      return reply.code(400).send({ error: 'Missing files array' });
    }

    const bucket = process.env.B2_S3_BUCKET_NAME || process.env.B2_BUCKET_NAME;
    if (!bucket) {
      return reply.code(500).send({ error: 'Missing B2_S3_BUCKET_NAME (or B2_BUCKET_NAME) env var' });
    }

    if (jobId) {
      await upsertJob({
        id: jobId,
        status: 'waiting_upload',
        done: 0,
        total: inputFiles.length,
        percent: 0,
      });
    }

    const files = [];
    const errors = [];

    for (const f of inputFiles) {
      const { filePath, fileName, prefix, contentType } = f || {};

      if (parseEncodeFlag(f?.encode)) {
        errors.push({ filePath: filePath || null, fileName: fileName || null, error: 'Encode requires backend upload (/b2/upload-folder-multipart)' });
        continue;
      }

      const norm = normalizeFilePathAndName({ filePath, fileName, prefix });
      const objectKey = norm.objectKey;

      if (!objectKey) {
        errors.push({ filePath: filePath || null, fileName: fileName || null, error: 'Missing filePath or (prefix + fileName)' });
        continue;
      }

      const expiresInSeconds = (() => {
        const raw = f?.expiresInSeconds ?? f?.expires ?? f?.ttl;
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return 600;
        return Math.min(Math.max(Math.trunc(n), 60), 3600);
      })();

      try {
        const signed = await createPresignedPutUrl({
          bucket,
          key: objectKey,
          contentType: contentType || 'application/octet-stream',
          expiresInSeconds,
        });

        files.push({
          filePath: objectKey,
          bucket,
          method: signed.method,
          url: signed.url,
          expiresInSeconds,
        });
      } catch (e) {
        errors.push({ filePath: objectKey, error: e?.message || 'Failed to presign upload' });
      }
    }

    if (files.length === 0 && errors.length) {
      return reply.code(400).send({ error: 'No files presigned', errors });
    }

    const statusCode = errors.length ? 207 : 200;
    return reply
      .code(statusCode)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ files, errors: errors.length ? errors : undefined });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
      },
      'B2 S3 presign batch error',
    );
    return reply.code(500).send({ error: 'Failed to presign upload batch', details: err?.message });
  }
}

async function getFfprobePath() {
  const envPath = process.env.FFPROBE_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  try {
    const mod = await import('ffprobe-static');
    const p = mod?.path || mod?.default?.path || mod?.default;
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return 'ffprobe';
}

function parseDurationToSec(str) {
  const m = /([0-9]{1,3}):([0-9]{1,2}):([0-9]{1,2}(?:\.[0-9]+)?)/.exec(String(str) || '');
  if (!m) return NaN;
  const hh = parseInt(m[1], 10) || 0;
  const mm = parseInt(m[2], 10) || 0;
  const ss = parseFloat(m[3] || '0');
  return hh * 3600 + mm * 60 + ss;
}

async function probeDurationSec(inputPath, ffmpegPath, ffprobePath) {
  if (ffprobePath) {
    const val = await new Promise((resolve) => {
      const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath];
      const p = spawn(ffprobePath, args);
      let out = '';
      p.stdout.on('data', (d) => {
        out += d.toString();
      });
      p.on('close', () => {
        const num = parseFloat((out || '').trim());
        if (Number.isFinite(num) && num > 0) resolve(num);
        else resolve(NaN);
      });
      p.on('error', () => resolve(NaN));
    });
    if (Number.isFinite(val) && val > 0) return val;
  }
  return await new Promise((resolve) => {
    try {
      const p = spawn(ffmpegPath, ['-hide_banner', '-i', inputPath, '-f', 'null', '-']);
      let err = '';
      p.stderr.on('data', (d) => {
        err += d.toString();
      });
      p.on('close', () => {
        const dm = /Duration:\s*([0-9:.]+)\s*,/.exec(err);
        const sec = dm ? parseDurationToSec(dm[1]) : NaN;
        resolve(Number.isFinite(sec) && sec > 0 ? sec : NaN);
      });
      p.on('error', () => resolve(NaN));
    } catch {
      resolve(NaN);
    }
  });
}

async function getFfmpegPath() {
  const envPath = process.env.FFMPEG_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  try {
    const mod = await import('ffmpeg-static');
    const p = mod?.default;
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return 'ffmpeg';
}

function runFfmpeg(ffmpegPath, args, onTime, options = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, options?.cwd ? { cwd: options.cwd } : undefined);
    let stderr = '';
    const unregister = registerKill(options?.jobId, () => {
      try {
        p.kill('SIGKILL');
      } catch {
      }
    });
    p.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onTime) {
        const m = s.match(/time=([0-9:.]+)/);
        if (m && m[1]) {
          const t = m[1];
          const parts = t.split(':');
          let sec = 0;
          if (parts.length === 3) {
            const [hh, mm, ss] = parts;
            sec = (parseInt(hh, 10) || 0) * 3600 + (parseInt(mm, 10) || 0) * 60 + parseFloat(ss || '0');
          } else if (parts.length === 2) {
            const [mm, ss] = parts;
            sec = (parseInt(mm, 10) || 0) * 60 + parseFloat(ss || '0');
          } else if (parts.length === 1) {
            sec = parseFloat(parts[0] || '0');
          }
          if (!Number.isNaN(sec)) onTime(sec);
        }
      }
    });
    p.on('close', (code) => {
      try {
        unregister();
      } catch {
      }
      if (code === 0) return resolve();
      const err = new Error(`ffmpeg exited with code ${code}: ${stderr.slice(0, 4000)}`);
      reject(err);
    });
    p.on('error', (e) => {
      try {
        unregister();
      } catch {
      }
      reject(e);
    });
  });
}

export async function uploadDriveController(request, reply) {
  try {
    const filePart = await request.file();
    if (!filePart) {
      return reply.code(400).send({ error: 'No file provided' });
    }

    const fields = filePart.fields || {};
    const folderId = (fields.folderId && fields.folderId.value) || 'root';
    const relativePath = (fields.relativePath && fields.relativePath.value) || '';
    const encodeField = fields.encode && fields.encode.value;
    const wantEncode = (() => {
      const v = (encodeField == null ? '1' : String(encodeField)).toLowerCase();
      return !(v === '0' || v === 'false' || v === 'no');
    })();

    const fileName = filePart.filename;
    const fileType = filePart.mimetype || 'application/octet-stream';
    const fileStream = filePart.file; // Node.js Readable
    const declaredSize = Number(filePart?.fields?.fileSize?.value ?? filePart?.fields?.size?.value ?? NaN);

    const isVideo = (() => {
      const t = (fileType || '').toLowerCase();
      if (t.startsWith('video/')) return true;
      const n = (fileName || '').toLowerCase();
      return /\.(mp4|mkv|mov|webm|avi|m4v)$/i.test(n);
    })();

    const prefixParts = [];
    if (folderId && folderId !== 'root') prefixParts.push(String(folderId));
    if (relativePath) prefixParts.push(String(relativePath));
    const basePrefix = prefixParts
      .join('/')
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean)
      .join('/');
    const buildKey = (name) => (basePrefix ? `${basePrefix}/${name}` : name);

    if (!isVideo || !wantEncode) {
      const objectKey = buildKey(fileName);
      const logger = startUploadProgressLogger({ request, label: `drive-upload:${objectKey}`, totalBytes: declaredSize });
      fileStream.pipe(logger.passthrough);
      try {
        await uploadFromStream({ fileName: objectKey, stream: logger.passthrough, contentType: fileType, expectedSizeBytes: declaredSize });
        try {
          request.log.info({ objectKey, uploadedBytes: logger.getUploadedBytes() }, 'Drive upload finished');
        } catch {
          // ignore
        }
      } finally {
        logger.cleanup();
      }
      const fileData = { id: objectKey, name: fileName };
      return reply
        .headers({
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        })
        .send({ files: [fileData] });
    }

    const jobId = resolveRequestedJobId(
      fields?.jobId?.value,
      fields?.job_id?.value,
      request.query?.jobId,
      request.query?.job_id,
      request.headers?.['x-upload-job-id'],
    );
    setProgress(jobId, { status: 'preparing', current: null, done: 0, total: 4, percent: 0 });

    (async () => {
      const created = [];
      // tmpDir dideklarasikan di sini agar bisa dibersihkan di blok finally
      const tmpDir = fs.mkdtempSync(path.join(getTempRoot(), 'upload-'));
      try {
        const inputExt = path.extname(fileName || '') || '.dat';
        const inputPath = path.join(tmpDir, `input${inputExt}`);

        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(inputPath);
          fileStream.pipe(ws);
          ws.on('finish', resolve);
          ws.on('error', reject);
          fileStream.on('error', reject);
        });

        const baseName = (() => {
          const n = fileName || 'video';
          const ext = path.extname(n);
          return ext ? n.slice(0, -ext.length) : n;
        })();

        const ffmpegPath = await getFfmpegPath();
        const ffmpegOk = await checkBinary(ffmpegPath);
        if (!ffmpegOk) {
          setProgress(jobId, {
            status: 'error',
            error: `ffmpeg not found or not executable at ${ffmpegPath}. Install system ffmpeg or set FFMPEG_PATH/.env, or install ffmpeg-static.`,
          });
          return;
        }

        const ffprobePath = await getFfprobePath();
        const ffprobeOk = await checkBinary(ffprobePath);
        const renditions = [
          { width: 1920, height: 1080 },
          { width: 1280, height: 720 },
          { width: 854, height: 480 },
          { width: 640, height: 360 },
        ];
        const outputs = renditions.map((r) => ({
          width: r.width,
          height: r.height,
          outPath: path.join(tmpDir, `${baseName}_${r.height}p.mp4`),
          outName: `${baseName}_${r.height}p.mp4`,
        }));

        const total = outputs.length;
        setProgress(jobId, { status: 'encoding', current: `${outputs[0].height}p`, done: 0, total, percent: 0 });
        const duration = await probeDurationSec(inputPath, ffmpegPath, ffprobeOk ? ffprobePath : null);

        for (let i = 0; i < outputs.length; i++) {
          const t = outputs[i];
          setProgress(jobId, {
            status: 'encoding',
            current: `${t.height}p`,
            done: i,
            total,
            percent: Math.round((i / total) * 100),
          });
          const vf = [
            `scale=${t.width}:${t.height}:force_original_aspect_ratio=decrease`,
            `pad=${t.width}:${t.height}:(ow-iw)/2:(oh-ih)/2:black`,
          ].join(',');
          const args = [
            '-y',
            '-i',
            inputPath,
            '-vf',
            vf,
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '23',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-movflags',
            '+faststart',
            t.outPath,
          ];
          let lastTime = 0;
          await runFfmpeg(ffmpegPath, args, (sec) => {
            lastTime = sec;
            if (Number.isFinite(duration) && duration > 0) {
              const frac = Math.max(0, Math.min(1, sec / duration));
              const overall = ((i + frac) / total) * 100;
              const pct = Math.max(0, Math.min(99, Math.round(overall)));
              setProgress(jobId, {
                status: 'encoding',
                current: `${t.height}p`,
                done: i,
                total,
                percent: pct,
              });
            }
          });

          const frac = Number.isFinite(duration) && duration > 0 ? Math.min(1, lastTime / duration) : 1;
          const pct = Math.round(((i + frac) / total) * 100);
          setProgress(jobId, {
            status: 'uploading',
            current: `${t.height}p`,
            done: i,
            total,
            percent: pct,
          });

          const stream = fs.createReadStream(t.outPath);
          const objectKey = buildKey(t.outName);
          await uploadFromStream({ fileName: objectKey, stream, contentType: 'video/mp4' });
          created.push({ id: objectKey, name: t.outName });
          const afterPct = Math.round(((i + 1) / total) * 100);
          setProgress(jobId, {
            status: 'progress',
            current: `${t.height}p`,
            done: i + 1,
            total,
            percent: afterPct,
          });
        }

        setProgress(jobId, { status: 'done', done: total, total, files: created, percent: 100 });
      } catch (e) {
        setProgress(jobId, { status: 'error', error: e?.message || 'Encoding failed' });
      } finally {
        try {
          if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        } catch {
          // abaikan error cleanup
        }
      }
    })();

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ jobId, ssePath: buildUploadJobSsePath(jobId), status: 'started' });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
        code: err?.code,
        name: err?.name,
        response: err?.response?.data,
        status: err?.response?.status,
      },
      'Drive upload error',
    );
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Failed to upload file', details: err?.message });
  }
}

export async function uploadB2AndCatalogController(request, reply) {
  try {
    const files = [];
    const errors = [];

    let sawAnyFilePart = false;

    let prefixCleaned = '';
    let sizeFromField = NaN;

    const parts = request.parts();
    for await (const part of parts) {
      if (part?.type === 'field') {
        if (part.fieldname === 'prefix') {
          prefixCleaned = String(part.value || '')
            .split('/')
            .map((p) => p.trim())
            .filter(Boolean)
            .join('/');
        }
        if (part.fieldname === 'fileSize' || part.fieldname === 'size') {
          const n = Number(part.value);
          if (Number.isFinite(n) && n > 0) sizeFromField = n;
        }
        continue;
      }

      sawAnyFilePart = true;
      const fileName = part.filename;
      const fileType = part.mimetype || 'application/octet-stream';
      const fileStream = part.file;

      if (!fileName || !fileStream) {
        errors.push({ fileName: fileName || null, error: 'Malformed file part (missing filename or stream)' });
        continue;
      }

      // Hanya izinkan upload video (berdasarkan mimetype dan ekstensi file)
      const lowerMime = String(fileType).toLowerCase();
      const videoExt = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'];
      const ext = (fileName.lastIndexOf('.') !== -1 ? fileName.slice(fileName.lastIndexOf('.')) : '').toLowerCase();
      const isVideo = lowerMime.startsWith('video/') || videoExt.includes(ext);

      if (!isVideo) {
        errors.push({ fileName, error: 'Only video files are allowed for this endpoint' });
        continue;
      }

      const objectKey = prefixCleaned ? `${prefixCleaned}/${fileName}` : fileName;
      const declaredSize = Number(part?.fields?.fileSize?.value ?? part?.fields?.size?.value ?? sizeFromField ?? NaN);

      try {
        const logger = startUploadProgressLogger({ request, label: `b2-upload:${objectKey}`, totalBytes: declaredSize });
        fileStream.pipe(logger.passthrough);
        let uploadRes;
        try {
          uploadRes = await uploadFromStream({ fileName: objectKey, stream: logger.passthrough, contentType: fileType, expectedSizeBytes: declaredSize });
          try {
            request.log.info({ objectKey, uploadedBytes: logger.getUploadedBytes() }, 'B2 upload finished');
          } catch {
            // ignore
          }
        } finally {
          logger.cleanup();
        }

        const keyParts = String(objectKey)
          .split('/')
          .map((p) => p.trim())
          .filter(Boolean);

        const baseName = keyParts[keyParts.length - 1];
        const folderPrefix = keyParts.length > 1 ? `${keyParts.slice(0, -1).join('/')}/` : '';
        const folderId = await ensureFolderHierarchy(folderPrefix);

        const size = Number(uploadRes?.contentLength) || 0;
        const uploadedAt = uploadRes?.uploadTimestamp ? new Date(uploadRes.uploadTimestamp).toISOString() : undefined;
        const contentType = uploadRes?.contentType || fileType || 'application/octet-stream';

        await upsertFile({
          folderId,
          fileName: baseName,
          filePath: objectKey,
          size,
          contentType,
          uploadedAt,
        });

        files.push(enrichFileWithTypeAndUrl({
          id: objectKey,
          name: baseName,
          mimeType: contentType,
          size,
          modifiedTime: uploadedAt || null,
        }));
      } catch (e) {
        const status = e?.status || e?.response?.status || e?.response?.data?.status;
        const code = e?.code || e?.response?.data?.code;
        const message = e?.response?.data?.message || e?.message || 'Upload failed';
        errors.push({ fileName: effectiveFileName, objectKey, error: message, status: status ?? null, code: code ?? null });
      }
    }

    if (!sawAnyFilePart) {
      try {
        request.log.warn(
          {
            contentType: request?.headers?.['content-type'],
            contentLength: request?.headers?.['content-length'],
          },
          'No file parts detected in multipart request',
        );
      } catch {
        // ignore
      }
      return reply.code(400).send({
        error: 'No files uploaded',
        details: 'Request did not contain any file parts. Ensure you send multipart/form-data with at least one file field.',
      });
    }

    if (files.length === 0 && errors.length) {
      return reply.code(400).send({ error: 'No valid files uploaded', errors });
    }

    if (files.length === 0) {
      return reply.code(400).send({ error: 'No files uploaded' });
    }

    const resultFiles = buildResultFiles(files);
    const statusCode = errors.length ? 207 : 200;
    return reply
      .code(statusCode)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ files, resultFiles, errors: errors.length ? errors : undefined });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
        code: err?.code,
        name: err?.name,
        response: err?.response?.data,
        status: err?.response?.status,
      },
      'B2 upload error',
    );
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Failed to upload file to B2', details: err?.message });
  }
}

async function processBufferedFolderUploadEntry({ entry, request, jobId }) {
  const { objectKey, baseName, folderPrefix, declaredSize, wantEncode, fileType, tempInputPath } = entry;

  try {
    await updateJobThrottled(jobId, { status: wantEncode ? 'encoding' : 'uploading', current: objectKey });

    if (isCancelled(jobId)) {
      throw new Error('Job cancelled');
    }

    if (wantEncode) {
      const tmpDir = fs.mkdtempSync(path.join(getTempRoot(), 'hls-'));
      const unregisterTmpCleanup = registerJobCleanup(jobId, () => {
        removeDirSafe(tmpDir);
      });
      try {
        const ffmpegPath = await getFfmpegPath();
        const ffmpegOk = await checkBinary(ffmpegPath);
        if (!ffmpegOk) {
          throw new Error(
            `ffmpeg not found or not executable at ${ffmpegPath}. Install system ffmpeg or set FFMPEG_PATH/.env, or install ffmpeg-static.`,
          );
        }

        const hlsOutDir = path.join(tmpDir, 'out');
        const hlsPrefix = buildHlsOutputPrefix({ objectKey });

        try {
          request.log.info({ jobId, objectKey, hlsPrefix }, 'HLS encode start');
        } catch {
        }

        await updateJobThrottled(jobId, { status: 'encoding', current: objectKey, percent: 5 });
        await packageToHls({
          inputPath: tempInputPath,
          outDir: hlsOutDir,
          baseName,
          ffmpegPath,
          threads: getHlsThreadsNumber(),
          onProgress: (sec) => updateEncodeJobProgress(jobId, { current: objectKey, seconds: sec, pctMin: 5, pctMax: 49 }),
        });
        validateHlsOutputs({ dirPath: hlsOutDir, playlistName: 'index.m3u8' });

        await updateJobThrottled(jobId, { status: 'uploading', current: objectKey, percent: 50 });

        const folderId = await ensureFolderHierarchy(hlsPrefix);
        await uploadHlsOutputsToB2({ request, dirPath: hlsOutDir, hlsPrefix, folderId, jobId, objectKey });

        return enrichFileWithTypeAndUrl({
          id: `${hlsPrefix}index.m3u8`,
          name: 'index.m3u8',
          mimeType: 'application/vnd.apple.mpegurl',
          size: 0,
          modifiedTime: new Date().toISOString(),
        });
      } finally {
        unregisterTmpCleanup();
        removeDirSafe(tmpDir);
      }
    }

    const logger = startUploadProgressLogger({ request, label: `b2-upload-folder:${objectKey}`, totalBytes: declaredSize });
    const readStream = fs.createReadStream(tempInputPath);
    readStream.pipe(logger.passthrough);
    let uploadRes;
    try {
      uploadRes = await uploadFromStream({
        fileName: objectKey,
        stream: logger.passthrough,
        contentType: fileType,
        expectedSizeBytes: declaredSize,
      });
      try {
        request.log.info({ objectKey, uploadedBytes: logger.getUploadedBytes() }, 'B2 folder upload finished');
      } catch {
      }
    } finally {
      logger.cleanup();
    }

    const folderId = await ensureFolderHierarchy(folderPrefix);

    const size = Number(uploadRes?.contentLength) || 0;
    const uploadedAt = uploadRes?.uploadTimestamp ? new Date(uploadRes.uploadTimestamp).toISOString() : undefined;
    const contentType = uploadRes?.contentType || fileType || 'application/octet-stream';

    await upsertFile({
      folderId,
      fileName: baseName,
      filePath: objectKey,
      size,
      contentType,
      uploadedAt,
    });

    return enrichFileWithTypeAndUrl({
      id: objectKey,
      name: baseName,
      mimeType: contentType,
      size,
      modifiedTime: uploadedAt || null,
    });
  } finally {
    try {
      fs.rmSync(tempInputPath, { force: true });
    } catch {
    }
  }
}

export async function uploadB2FolderMultipartController(request, reply) {
  let jobId = null;
  let stagedRootDir = null;
  let unregisterStageCleanup = null;
  try {
    const files = [];
    const errors = [];
    const stagedEntries = [];

    let sawAnyFilePart = false;
    let prefixCleaned = cleanRelativePath(request.query?.prefix ?? request.query?.pathPrefix ?? request.query?.basePrefix);
    const relativePathQueue = [];
    const sizeQueue = [];
    const relativePathCursor = { i: 0 };
    const sizeCursor = { i: 0 };
    let encodeGlobal = parseEncodeFlag(request.query?.encode);

    const consumeFromPartFields = (part, names, cursor) => {
      const fields = part?.fields;
      if (!fields || typeof fields !== 'object') return undefined;

      const normalize = (v) => {
        if (!v) return [];
        return Array.isArray(v) ? v : [v];
      };

      const candidates = [];
      for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(fields, name)) {
          candidates.push(...normalize(fields[name]));
        }
      }

      if (!candidates.length) return undefined;
      const idx = Number(cursor?.i || 0);
      if (idx > 0 && candidates.length === 1) {
        cursor.i = idx + 1;
        return undefined;
      }
      const chosen = candidates[Math.min(idx, candidates.length - 1)];
      cursor.i = idx + 1;
      return chosen?.value;
    };

    jobId = resolveRequestedJobId(request.query?.jobId, request.query?.job_id, request.headers?.['x-upload-job-id']);
    await upsertJob({ id: jobId, prefix: null, status: 'receiving', current: null, done: 0, total: 0, percent: 0 });
    getCancelState(jobId);
    stagedRootDir = fs.mkdtempSync(path.join(getTempRoot(), 'folder-upload-'));
    unregisterStageCleanup = registerJobCleanup(jobId, () => {
      removeDirSafe(stagedRootDir);
    });

    if (prefixCleaned) {
      await updateJobThrottled(jobId, { prefix: prefixCleaned || null });
    }

    const parts = request.parts();
    let stagedIndex = 0;
    for await (const part of parts) {
      if (part?.type === 'field') {
        const fieldname = String(part.fieldname || '');

        if (fieldname === 'prefix') {
          prefixCleaned = cleanRelativePath(part.value);
          await updateJobThrottled(jobId, { prefix: prefixCleaned || null });
        }
        if (fieldname === 'encode') {
          encodeGlobal = parseEncodeFlag(part.value);
        }

        if (/^(relativePath|filePath|path)(\[[0-9]*\])?$/.test(fieldname)) {
          const cleaned = cleanRelativePath(part.value);
          if (cleaned) relativePathQueue.push(cleaned);
        }

        if (/^(fileSize|size)(\[[0-9]*\])?$/.test(fieldname)) {
          const n = Number(part.value);
          if (Number.isFinite(n) && n > 0) sizeQueue.push(n);
        }
        continue;
      }

      sawAnyFilePart = true;

      const fileNameRaw = part.filename;
      const fileType = part.mimetype || 'application/octet-stream';
      const fileStream = part.file;

      if (!fileNameRaw || !fileStream) {
        try {
          fileStream?.resume?.();
        } catch {
        }
        errors.push({ fileName: fileNameRaw || null, error: 'Malformed file part (missing filename or stream)' });
        continue;
      }

      const fileNameFromPath = (() => {
        const cleaned = cleanRelativePath(fileNameRaw);
        if (!cleaned) return String(fileNameRaw);
        const parts = cleaned.split('/').filter(Boolean);
        return parts[parts.length - 1] || String(fileNameRaw);
      })();

      const lowerMime = String(fileType).toLowerCase();
      const videoExt = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'];
      const ext = (fileNameFromPath.lastIndexOf('.') !== -1 ? fileNameFromPath.slice(fileNameFromPath.lastIndexOf('.')) : '').toLowerCase();
      const isVideo = lowerMime.startsWith('video/') || videoExt.includes(ext);

      if (!isVideo) {
        try {
          fileStream.resume();
        } catch {
        }
        errors.push({ fileName: fileNameFromPath, error: 'Only video files are allowed for this endpoint' });
        continue;
      }

      const queuedRelativePath = relativePathQueue.length ? relativePathQueue.shift() : undefined;
      const relativePathField =
        queuedRelativePath ??
        part?.fields?.relativePath?.value ??
        part?.fields?.filePath?.value ??
        part?.fields?.path?.value ??
        consumeFromPartFields(part, ['relativePath', 'filePath', 'path'], relativePathCursor);
      const relativePathCleaned = (() => {
        const fromField = cleanRelativePath(relativePathField);
        if (fromField) return fromField;
        const fromFilename = cleanRelativePath(fileNameRaw);
        if (fromFilename.includes('/')) return fromFilename;
        return '';
      })();

      const relativePathNoDupPrefix = (() => {
        if (!relativePathCleaned) return '';
        const firstSeg = relativePathCleaned.split('/').filter(Boolean)[0] || '';
        if (!firstSeg) return relativePathCleaned;
        if (prefixCleaned === firstSeg || prefixCleaned.endsWith(`/${firstSeg}`)) {
          const rest = relativePathCleaned.split('/').filter(Boolean).slice(1).join('/');
          return rest || '';
        }
        return relativePathCleaned;
      })();

      const encodePerFile = parseEncodeFlag(part?.fields?.encode?.value);
      const wantEncode = encodePerFile || encodeGlobal;

      const effectiveFileName = relativePathCleaned ? fileNameFromPath : fileNameFromPath;

      const norm = normalizeFilePathAndName({
        filePath: relativePathNoDupPrefix,
        fileName: effectiveFileName,
        prefix: prefixCleaned,
      });

      const objectKey = norm.objectKey;
      const baseName = norm.baseName;
      const folderPrefix = norm.folderPrefix;
      const queuedSize = sizeQueue.length ? sizeQueue.shift() : undefined;
      const declaredSize = Number(
        queuedSize ??
          part?.fields?.fileSize?.value ??
          part?.fields?.size?.value ??
          consumeFromPartFields(part, ['fileSize', 'size'], sizeCursor) ??
          NaN,
      );

      if (!objectKey || !baseName) {
        try {
          fileStream.resume();
        } catch {
        }
        errors.push({ fileName: effectiveFileName, relativePath: relativePathCleaned || null, error: 'Missing objectKey after normalization' });
        continue;
      }

      try {
        if (isCancelled(jobId)) {
          throw new Error('Job cancelled');
        }
        await updateJobThrottled(jobId, { status: 'receiving', current: objectKey });

        const tempInputPath = path.join(
          stagedRootDir,
          `${String(stagedIndex).padStart(5, '0')}_${Date.now()}${path.extname(baseName) || '.bin'}`,
        );
        stagedIndex += 1;

        await streamToTempInputFile({
          inputStream: fileStream,
          outputPath: tempInputPath,
          jobId,
          request,
          label: `folder-stage:${objectKey}`,
          totalBytes: declaredSize,
        });

        stagedEntries.push({
          objectKey,
          baseName,
          folderPrefix,
          declaredSize,
          wantEncode,
          fileType,
          tempInputPath,
          sourceName: fileNameFromPath || fileNameRaw || null,
        });
      } catch (e) {
        const status = e?.status || e?.response?.status || e?.response?.data?.status;
        const code = e?.code || e?.response?.data?.code;
        const message = e?.response?.data?.message || e?.message || 'Upload failed';
        errors.push({ fileName: fileNameFromPath || fileNameRaw || null, objectKey, error: message, status: status ?? null, code: code ?? null });
      }
    }

    if (!sawAnyFilePart) {
      return reply.code(400).send({
        error: 'No files uploaded',
        details: 'Request did not contain any file parts. Ensure you send multipart/form-data with at least one file field.',
      });
    }

    if (stagedEntries.length === 0 && errors.length) {
      return reply.code(400).send({ error: 'No valid files uploaded', errors });
    }

    if (stagedEntries.length === 0) {
      return reply.code(400).send({ error: 'No files uploaded' });
    }

    const concurrency = stagedEntries.length > 1 ? getFolderUploadConcurrency() : 1;
    const limit = pLimit(concurrency);
    let completedEntries = 0;

    try {
      request.log.info({ jobId, totalEntries: stagedEntries.length, concurrency }, 'Start buffered folder processing');
    } catch {
    }

    await updateJobThrottled(jobId, {
      status: 'processing',
      current: stagedEntries[0]?.objectKey || null,
      done: 0,
      total: stagedEntries.length + errors.length,
      percent: 0,
    });

    const processed = await Promise.all(
      stagedEntries.map((entry) =>
        limit(async () => {
          try {
            const file = await processBufferedFolderUploadEntry({ entry, request, jobId });
            return { file };
          } catch (e) {
            if (isCancelled(jobId) || e?.message === 'Job cancelled') {
              throw e;
            }
            const status = e?.status || e?.response?.status || e?.response?.data?.status;
            const code = e?.code || e?.response?.data?.code;
            const message = e?.response?.data?.message || e?.message || 'Upload failed';
            return {
              error: {
                fileName: entry.sourceName,
                objectKey: entry.objectKey,
                error: message,
                status: status ?? null,
                code: code ?? null,
              },
            };
          } finally {
            completedEntries += 1;
            const pct = Math.min(99, Math.round((completedEntries / Math.max(1, stagedEntries.length)) * 100));
            await updateJobThrottled(jobId, {
              status: isCancelled(jobId) ? 'cancelled' : 'uploading',
              current: entry.objectKey,
              done: completedEntries,
              total: stagedEntries.length + errors.length,
              percent: pct,
            });
          }
        }),
      ),
    );

    for (const item of processed) {
      if (item?.file) files.push(item.file);
      if (item?.error) errors.push(item.error);
    }

    unregisterStageCleanup?.();
    unregisterStageCleanup = null;
    removeDirSafe(stagedRootDir);
    stagedRootDir = null;

    const resultFiles = buildResultFiles(files);
    if (isCancelled(jobId)) {
      await updateJobThrottled(jobId, { status: 'cancelled', error: 'Cancelled', done: files.length, total: files.length + errors.length, percent: 100, resultFiles });
    } else {
      await updateJobThrottled(jobId, { status: errors.length ? 'partial' : 'done', done: files.length, total: files.length + errors.length, percent: 100, resultFiles });
    }

    const statusCode = errors.length ? 207 : 200;
    return reply
      .code(statusCode)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ jobId, ssePath: buildUploadJobSsePath(jobId), files, resultFiles, errors: errors.length ? errors : undefined });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
        code: err?.code,
        name: err?.name,
        response: err?.response?.data,
        status: err?.response?.status,
      },
      'B2 upload folder error',
    );

    if (jobId) {
      if (isCancelled(jobId)) {
        await updateJobThrottled(jobId, { status: 'cancelled', error: 'Cancelled', percent: 100 });
      } else {
        await updateJobThrottled(jobId, { status: 'error', error: err?.message || 'Upload failed', percent: 100 });
      }
    }
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Failed to upload folder to B2', details: err?.message, jobId, ssePath: buildUploadJobSsePath(jobId) });
  } finally {
    try {
      clearCancelState(jobId);
    } catch {
    }
    try {
      unregisterStageCleanup?.();
    } catch {
    }
    try {
      removeDirSafe(stagedRootDir);
    } catch {
    }
  }
}

export async function deleteUploadJobController(request, reply) {
  const id = request.params?.id || request.query?.id;
  if (!id) return reply.code(400).send({ error: 'Missing id' });

  const existing = await getJobById(id);
  if (!existing) {
    cancelJob(id);
    runJobCleanup(id);
    await deleteJobById(id);
    return reply.headers({ 'Cache-Control': 'no-store' }).send({ ok: true });
  }

  cancelJob(id);
  runJobCleanup(id);
  await updateJobThrottled(id, { status: 'cancelled', error: 'Cancelled', percent: 100 });
  await deleteJobById(id);

  return reply.headers({ 'Cache-Control': 'no-store' }).send({ ok: true });
}

export async function getUploadJobController(request, reply) {
  const id = request.params?.id || request.query?.id;
  if (!id) return reply.code(400).send({ error: 'Missing id' });
  const job = await getJobById(id);
  if (!job) return reply.code(404).send({ error: 'Job not found' });
  return reply.headers({ 'Cache-Control': 'no-store' }).send(job);
}

export async function getUploadJobByPrefixController(request, reply) {
  const prefix = request.query?.prefix;
  if (!prefix) return reply.code(400).send({ error: 'Missing prefix' });
  const cleaned = cleanRelativePath(prefix);
  const job = await getJobByPrefix(cleaned);
  if (!job) return reply.code(404).send({ error: 'Job not found' });
  return reply.headers({ 'Cache-Control': 'no-store' }).send(job);
}

export async function listUploadJobsController(request, reply) {
  const active = request.query?.active;
  const limit = request.query?.limit;
  const activeOnly = active === '1' || active === 'true' || active === 'yes';
  const jobs = await listJobs({ activeOnly, limit });
  return reply.headers({ 'Cache-Control': 'no-store' }).send({ jobs });
}

export async function streamUploadJobSseController(request, reply) {
  const id = request.params?.id || request.query?.id;
  const prefix = request.query?.prefix;

  if (!id && !prefix) {
    return reply.code(400).send({ error: 'Missing id or prefix' });
  }

  const cleanedPrefix = prefix ? cleanRelativePath(prefix) : null;

  const getJob = () => {
    if (id) return getJobById(id);
    if (cleanedPrefix) return getJobByPrefix(cleanedPrefix);
    return Promise.resolve(null);
  };

  const origin = request.headers?.origin || '*';

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  });

  reply.hijack();

  const writeEvent = (event, data) => {
    try {
      if (event) reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data ?? null)}\n\n`);
    } catch {
    }
  };

  writeEvent('hello', { ok: true, id: id || null, prefix: cleanedPrefix || null });

  let lastUpdatedAt = null;
  const firstJob = await getJob();
  if (firstJob) {
    lastUpdatedAt = firstJob.updated_at_ms ?? null;
    writeEvent('update', firstJob);
  } else {
    writeEvent('not_found', { error: 'Job not found yet' });
  }

  const intervalMs = (() => {
    const n = Number(process.env.SSE_POLL_INTERVAL_MS || 1000);
    if (!Number.isFinite(n) || n < 250) return 1000;
    return Math.min(Math.trunc(n), 5000);
  })();

  const timer = setInterval(async () => {
    try {
      const job = await getJob();
      if (!job) {
        writeEvent('not_found', { error: 'Job not found' });
        return;
      }
      const updated = job.updated_at_ms ?? null;
      if (updated == null || updated === lastUpdatedAt) return;
      lastUpdatedAt = updated;
      writeEvent('update', job);
      if (job.status === 'done' || job.status === 'error' || job.status === 'partial') {
        writeEvent('end', { status: job.status });
        try {
          clearInterval(timer);
        } catch {
        }
        try {
          reply.raw.end();
        } catch {
        }
      }
    } catch (e) {
      writeEvent('error', { error: e?.message || 'SSE error' });
    }
  }, intervalMs);

  const onClose = () => {
    try {
      clearInterval(timer);
    } catch {
    }
  };

  try {
    request.raw.on('close', onClose);
    request.raw.on('aborted', onClose);
  } catch {
  }
}

export async function uploadProgressDriveController(request, reply) {
  const id = request.query?.id;
  if (!id) {
    return reply.code(400).send({ error: 'Missing id' });
  }
  const prog = getProgress(id);
  if (!prog) {
    return reply
      .headers({ 'Cache-Control': 'no-store' })
      .send({ status: 'unknown' });
  }
  return reply
    .headers({ 'Cache-Control': 'no-store' })
    .send(prog);
}
