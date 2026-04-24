import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  encodeMultiRendition,
  buildOutputDir,
  buildB2UploadPlan,
  RENDITIONS,
  SEGMENT_DURATION,
  checkNvenc,
  getFfmpegPath,
  getFfprobePath,
  runWithConcurrency,
} from '../lib/encodeMultiRendition.js';
import { uploadFromStream } from '../lib/b2.js';
import { upsertFolder, getFolderByPrefix, upsertFile, incrementFolderFileCount, prisma as catalogPrisma } from '../lib/storageCatalogDb.js';
import { upsertJob, updateJobThrottled, getJobById, listJobs, deleteJobById } from '../lib/uploadJobsDb.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');

const g = typeof globalThis !== 'undefined' ? globalThis : global;
if (!g.__encodeAbortRegistry) g.__encodeAbortRegistry = new Map();
const abortRegistry = g.__encodeAbortRegistry;

function makeJobId() {
  return `enc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getJobSsePath(jobId) {
  return `/encode/job-sse/${encodeURIComponent(jobId)}`;
}

function getTempRoot() {
  const env = process.env.ENCODE_TEMP_DIR;
  if (env) {
    return path.isAbsolute(env) ? env : path.resolve(PROJECT_ROOT, env);
  }
  return path.join(PROJECT_ROOT, 'temp');
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

export async function encodeJobStatusController(request, reply) {
  const id = request.params?.id || request.query?.id;
  if (!id) return reply.code(400).send({ error: 'Missing id' });
  const job = await getJobById(id);
  if (!job) return reply.code(404).send({ error: 'Job not found' });
  return reply.headers({ 'Cache-Control': 'no-store' }).send(job);
}

export async function listEncodeJobsController(request, reply) {
  const jobs = await listJobs({ activeOnly: false, limit: 50 });
  return reply.headers({ 'Cache-Control': 'no-store' }).send({ jobs });
}

export async function cancelEncodeJobController(request, reply) {
  const id = request.params?.id || request.query?.id;
  if (!id) return reply.code(400).send({ error: 'Missing id' });
  const ac = abortRegistry.get(id);
  if (ac) {
    try { ac.abort(); } catch {}
    abortRegistry.delete(id);
  }
  await updateJobThrottled(id, { status: 'cancelled', error: 'Cancelled by user', percent: 100 });
  return reply.headers({ 'Cache-Control': 'no-store' }).send({ ok: true });
}

export async function encodeInfoController(request, reply) {
  try {
    const ffmpegPath = await getFfmpegPath();
    const nvenc = await checkNvenc(ffmpegPath);
    return reply.send({
      nvenc,
      renditions: RENDITIONS.map((r) => ({ label: r.label, width: r.width, height: r.height, videoBitrate: r.videoBitrate })),
      segmentDuration: SEGMENT_DURATION,
      tempRoot: getTempRoot(),
    });
  } catch (err) {
    return reply.code(500).send({ error: err?.message });
  }
}

export async function startEncodeController(request, reply) {
  const body = request.body || {};

  const objectKey = String(body.objectKey || body.filePath || '').replace(/^\/+/, '').trim();
  if (!objectKey) {
    return reply.code(400).send({ error: 'Missing objectKey (or filePath) — the B2 object key of the source file' });
  }

  const localInputPath = String(body.localInputPath || body.inputPath || '').trim();
  const sourceUrl = String(body.sourceUrl || body.url || '').trim();

  if (!localInputPath && !sourceUrl) {
    return reply.code(400).send({
      error: 'Provide either localInputPath (absolute path on server) or sourceUrl (HTTP URL to download source)',
    });
  }

  const customRenditions = (() => {
    if (!Array.isArray(body.renditions) || !body.renditions.length) return null;
    return body.renditions
      .map((r) => RENDITIONS.find((d) => d.label === r))
      .filter(Boolean);
  })();

  const segmentDuration = (() => {
    const n = Number(body.segmentDuration ?? body.segDuration ?? SEGMENT_DURATION);
    if (!Number.isFinite(n) || n < 1) return SEGMENT_DURATION;
    return Math.min(Math.max(Math.trunc(n), 1), 10);
  })();

  const jobId = String(body.jobId || body.job_id || '').trim() || makeJobId();

  await upsertJob({
    id: jobId,
    prefix: objectKey,
    status: 'queued',
    current: objectKey,
    done: 0,
    total: (customRenditions || RENDITIONS).length,
    percent: 0,
  });

  reply
    .headers({ 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' })
    .send({
      jobId,
      ssePath: getJobSsePath(jobId),
      status: 'queued',
      upload_b2: false,
      objectKey,
      renditions: (customRenditions || RENDITIONS).map((r) => r.label),
      segmentDuration,
    });

  setImmediate(() => _runEncodeJob({ jobId, objectKey, localInputPath, sourceUrl, customRenditions, segmentDuration, request }).catch((err) => {
    try { request?.log?.error({ jobId, message: err?.message, stack: err?.stack }, 'Encode job fatal error'); } catch {}
  }));
}

async function _runEncodeJob({ jobId, objectKey, localInputPath, sourceUrl, customRenditions, segmentDuration, request }) {
  const ac = new AbortController();
  abortRegistry.set(jobId, ac);

  let tempDownloadPath = null;

  try {
    await updateJobThrottled(jobId, { status: 'preparing', percent: 0 });

    let inputPath = localInputPath;

    if (!inputPath && sourceUrl) {
      await updateJobThrottled(jobId, { status: 'downloading', current: sourceUrl, percent: 0 });
      const tmpDir = fs.mkdtempSync(path.join(getTempRoot(), 'dl-'));
      const ext = path.extname(new URL(sourceUrl).pathname) || '.mkv';
      tempDownloadPath = path.join(tmpDir, `input${ext}`);

      const res = await fetch(sourceUrl, { signal: ac.signal });
      if (!res.ok) throw new Error(`Failed to download source: HTTP ${res.status}`);

      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tempDownloadPath);
        const body = res.body;
        if (!body) return reject(new Error('No response body'));
        const reader = body.getReader();
        const pump = () => reader.read().then(({ done, value }) => {
          if (done) { ws.end(); return; }
          ws.write(Buffer.from(value));
          pump();
        }).catch(reject);
        ws.on('finish', resolve);
        ws.on('error', reject);
        pump();
      });

      inputPath = tempDownloadPath;
      await updateJobThrottled(jobId, { status: 'downloaded', percent: 2 }, { minIntervalMs: 0, minPercentDelta: 0 });
    }

    if (!inputPath || !fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`);
    }

    const rList = customRenditions || RENDITIONS;
    const totalRenditions = rList.length;
    let completedRenditions = 0;

    await updateJobThrottled(jobId, { status: 'encoding', percent: 2 }, { minIntervalMs: 0, minPercentDelta: 0 });

    const result = await encodeMultiRendition({
      inputPath,
      objectKey,
      tempRoot: getTempRoot(),
      renditions: rList,
      segmentDuration,
      abortSignal: ac.signal,

      onRenditionStart: async ({ label, useNvenc }) => {
        const pct = Math.round((completedRenditions / totalRenditions) * 95) + 2;
        await updateJobThrottled(jobId, {
          status: 'encoding',
          current: `${label} (${useNvenc ? 'NVENC' : 'CPU'})`,
          done: completedRenditions,
          total: totalRenditions,
          percent: pct,
        });
      },

      onRenditionProgress: async ({ label, pct: rendPct, sec }) => {
        const basePct = Math.round((completedRenditions / totalRenditions) * 95) + 2;
        const rendSlice = Math.round((95 / totalRenditions) * ((rendPct ?? 0) / 100));
        await updateJobThrottled(jobId, {
          status: 'encoding',
          current: `${label}`,
          done: completedRenditions,
          total: totalRenditions,
          percent: Math.min(97, basePct + rendSlice),
        });
      },

      onRenditionDone: async ({ label, success, error }) => {
        completedRenditions += 1;
        const pct = Math.round((completedRenditions / totalRenditions) * 95) + 2;
        await updateJobThrottled(jobId, {
          status: success ? 'encoding' : 'partial',
          current: label,
          done: completedRenditions,
          total: totalRenditions,
          percent: Math.min(97, pct),
          error: error ? `${label}: ${error}` : undefined,
        });
      },

      onMasterDone: async ({ masterPlaylistPath }) => {
        await updateJobThrottled(jobId, { status: 'encoding', percent: 98 });
      },
    });

    const successLabels = rList.filter((r) => result.outputStructure[r.label]?.success).map((r) => r.label);
    const failedLabels = result.errors.map((e) => e.label);

    const finalStatus = failedLabels.length && !successLabels.length
      ? 'error'
      : failedLabels.length
        ? 'partial_encode_only'
        : 'done_encode_only';

    await updateJobThrottled(jobId, {
      status: finalStatus,
      done: successLabels.length,
      total: totalRenditions,
      percent: 100,
      current: result.masterPlaylistPath,
      error: failedLabels.length ? `Failed renditions: ${failedLabels.join(', ')}` : undefined,
    });

    try {
      request?.log?.info({
        jobId,
        objectKey,
        outBase: result.outBase,
        useNvenc: result.useNvenc,
        duration: result.duration,
        successLabels,
        failedLabels,
        b2UploadPlanCount: result.b2UploadPlan.length,
      }, 'Encode job done');
    } catch {}

  } catch (err) {
    const cancelled = ac.signal.aborted;
    try { request?.log?.error({ jobId, message: err?.message, stack: err?.stack }, 'Encode job error'); } catch {}
    await updateJobThrottled(jobId, {
      status: cancelled ? 'cancelled' : 'error',
      error: cancelled ? 'Cancelled by user' : (err?.message || 'Encode failed'),
      percent: 100,
    }, { minIntervalMs: 0, minPercentDelta: 0 });
  } finally {
    abortRegistry.delete(jobId);
    if (tempDownloadPath) {
      try { fs.rmSync(path.dirname(tempDownloadPath), { recursive: true, force: true }); } catch {}
    }
  }
}

export async function encodeAndUploadController(request, reply) {
  const body = request.body || {};

  const objectKey = String(body.objectKey || body.filePath || '').replace(/^\/+/, '').trim();
  if (!objectKey) {
    return reply.code(400).send({ error: 'Missing objectKey' });
  }

  const localInputPath = String(body.localInputPath || body.inputPath || '').trim();
  const sourceUrl = String(body.sourceUrl || body.url || '').trim();

  if (!localInputPath && !sourceUrl) {
    return reply.code(400).send({ error: 'Provide localInputPath or sourceUrl' });
  }

  const segmentDuration = (() => {
    const n = Number(body.segmentDuration ?? SEGMENT_DURATION);
    if (!Number.isFinite(n) || n < 1) return SEGMENT_DURATION;
    return Math.min(Math.max(Math.trunc(n), 1), 10);
  })();

  const customRenditions = (() => {
    if (!Array.isArray(body.renditions) || !body.renditions.length) return null;
    return body.renditions.map((r) => RENDITIONS.find((d) => d.label === r)).filter(Boolean);
  })();

  const jobId = String(body.jobId || '').trim() || makeJobId();

  await upsertJob({
    id: jobId,
    prefix: objectKey,
    status: 'queued',
    current: objectKey,
    done: 0,
    total: (customRenditions || RENDITIONS).length,
    percent: 0,
  });

  reply
    .headers({ 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' })
    .send({ jobId, ssePath: getJobSsePath(jobId), status: 'queued', objectKey });

  setImmediate(() => _runEncodeAndUploadJob({ jobId, objectKey, localInputPath, sourceUrl, customRenditions, segmentDuration, request }).catch((err) => {
    try { request?.log?.error({ jobId, message: err?.message, stack: err?.stack }, 'Encode+upload job fatal error'); } catch {}
  }));
}

async function _runEncodeAndUploadJob({ jobId, objectKey, localInputPath, sourceUrl, customRenditions, segmentDuration, request }) {
  const ac = new AbortController();
  abortRegistry.set(jobId, ac);

  let tempDownloadPath = null;

  try {
    await updateJobThrottled(jobId, { status: 'preparing', percent: 0 }, { minIntervalMs: 0, minPercentDelta: 0 });

    let inputPath = localInputPath;

    if (!inputPath && sourceUrl) {
      await updateJobThrottled(jobId, { status: 'downloading', current: sourceUrl, percent: 0 }, { minIntervalMs: 0, minPercentDelta: 0 });
      const tmpDir = fs.mkdtempSync(path.join(getTempRoot(), 'dl-'));
      const ext = path.extname(new URL(sourceUrl).pathname) || '.mkv';
      tempDownloadPath = path.join(tmpDir, `input${ext}`);

      const res = await fetch(sourceUrl, { signal: ac.signal });
      if (!res.ok) throw new Error(`Failed to download source: HTTP ${res.status}`);

      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tempDownloadPath);
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

      inputPath = tempDownloadPath;
      await updateJobThrottled(jobId, { status: 'downloaded', percent: 3 });
    }

    if (!inputPath || !fs.existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`);

    const rList = customRenditions || RENDITIONS;
    let completedRenditions = 0;

    const result = await encodeMultiRendition({
      inputPath,
      objectKey,
      tempRoot: getTempRoot(),
      renditions: rList,
      segmentDuration,
      abortSignal: ac.signal,

      onRenditionStart: async ({ label, useNvenc }) => {
        const pct = Math.round((completedRenditions / rList.length) * 45) + 3;
        await updateJobThrottled(jobId, { status: 'encoding', current: `${label} (${useNvenc ? 'NVENC' : 'CPU'})`, percent: pct });
      },

      onRenditionProgress: async ({ label, pct: rPct }) => {
        const base = Math.round((completedRenditions / rList.length) * 45) + 3;
        const slice = Math.round((45 / rList.length) * ((rPct ?? 0) / 100));
        await updateJobThrottled(jobId, { status: 'encoding', current: label, percent: Math.min(47, base + slice) });
      },

      onRenditionDone: async ({ label }) => {
        completedRenditions += 1;
      },
    });

    await updateJobThrottled(jobId, { status: 'uploading', percent: 48 }, { minIntervalMs: 0, minPercentDelta: 0 });

    const plan = result.b2UploadPlan.filter((item) => fs.existsSync(item.localPath));
    let uploadedCount = 0;

    const uploadConcurrency = (() => {
      const n = parseInt(process.env.ENCODE_UPLOAD_CONCURRENCY || process.env.HLS_UPLOAD_CONCURRENCY || '6', 10);
      return Number.isFinite(n) && n > 0 ? n : 6;
    })();

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
      await upsertFile({
        folderId,
        fileName,
        filePath: item.b2Key,
        size,
        contentType: item.contentType,
        uploadedAt: new Date().toISOString(),
      });
      if (!existingFile) await incrementFolderFileCount(folderId);

      uploadedCount += 1;
      const pct = 48 + Math.round((uploadedCount / plan.length) * 50);
      await updateJobThrottled(jobId, {
        status: 'uploading',
        current: item.b2Key,
        done: uploadedCount,
        total: plan.length,
        percent: Math.min(98, pct),
      });
    });

    await runWithConcurrency(uploadTasks, uploadConcurrency);

    const successLabels = rList.filter((r) => result.outputStructure[r.label]?.success).map((r) => r.label);
    const failedLabels = result.errors.map((e) => e.label);

    await updateJobThrottled(jobId, {
      status: failedLabels.length && !successLabels.length ? 'error' : failedLabels.length ? 'partial' : 'done',
      done: uploadedCount,
      total: plan.length,
      percent: 100,
      error: failedLabels.length ? `Failed: ${failedLabels.join(', ')}` : undefined,
    }, { minIntervalMs: 0, minPercentDelta: 0 });

    try {
      fs.rmSync(result.outBase, { recursive: true, force: true });
    } catch {}

  } catch (err) {
    const cancelled = ac.signal.aborted;
    try { request?.log?.error({ jobId, message: err?.message, stack: err?.stack }, 'Encode+upload job error'); } catch {}
    await updateJobThrottled(jobId, {
      status: cancelled ? 'cancelled' : 'error',
      error: cancelled ? 'Cancelled' : (err?.message || 'Encode+upload failed'),
      percent: 100,
    }, { minIntervalMs: 0, minPercentDelta: 0 });
  } finally {
    abortRegistry.delete(jobId);
    if (tempDownloadPath) {
      try { fs.rmSync(path.dirname(tempDownloadPath), { recursive: true, force: true }); } catch {}
    }
  }
}

export async function encodeJobSseController(request, reply) {
  const id = request.params?.id || request.query?.id;
  if (!id) return reply.code(400).send({ error: 'Missing id' });

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

  const write = (event, data) => {
    try {
      if (event) reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data ?? null)}\n\n`);
    } catch {}
  };

  write('hello', { id });

  let lastUpdatedAt = null;
  const firstJob = await getJobById(id);
  if (firstJob) {
    lastUpdatedAt = firstJob.updated_at_ms ?? null;
    write('update', firstJob);
  } else {
    write('not_found', { error: 'Job not found yet' });
  }

  const intervalMs = (() => {
    const n = Number(process.env.SSE_POLL_INTERVAL_MS || 1000);
    return (!Number.isFinite(n) || n < 250) ? 1000 : Math.min(n, 5000);
  })();

  const timer = setInterval(async () => {
    try {
      const job = await getJobById(id);
      if (!job) { write('not_found', { error: 'Job not found' }); return; }
      const updated = job.updated_at_ms ?? null;
      if (updated == null || updated === lastUpdatedAt) return;
      lastUpdatedAt = updated;
      write('update', job);
      const terminalStatuses = ['done', 'done_encode_only', 'partial_encode_only', 'error', 'partial', 'cancelled'];
      if (terminalStatuses.includes(job.status)) {
        const isEncodeOnly = job.status === 'done_encode_only' || job.status === 'partial_encode_only';
        write('end', { status: job.status, upload_b2: isEncodeOnly ? false : true });
        try { clearInterval(timer); } catch {}
        try { reply.raw.end(); } catch {}
      }
    } catch (e) {
      write('error', { error: e?.message });
    }
  }, intervalMs);

  const onClose = () => { try { clearInterval(timer); } catch {} };
  try {
    request.raw.on('close', onClose);
    request.raw.on('aborted', onClose);
  } catch {}
}
