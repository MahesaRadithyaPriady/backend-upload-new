import { prisma } from './prisma.js';

const g = typeof globalThis !== 'undefined' ? globalThis : global;
if (!g.__uploadJobsLastWrite) g.__uploadJobsLastWrite = new Map();
const lastWrite = g.__uploadJobsLastWrite;

function rowToJob(row) {
  if (!row) return null;
  const resultFiles = Array.isArray(row.resultFiles) ? row.resultFiles : null;
  return {
    ...row,
    resultFiles,
    createdAtMs: row.createdAtMs != null ? Number(row.createdAtMs) : null,
    updatedAtMs: row.updatedAtMs != null ? Number(row.updatedAtMs) : null,
    created_at_ms: row.createdAtMs != null ? Number(row.createdAtMs) : null,
    updated_at_ms: row.updatedAtMs != null ? Number(row.updatedAtMs) : null,
  };
}

export async function upsertJob(job) {
  const now = Date.now();
  const payload = {
    id: job?.id,
    prefix: job?.prefix ?? null,
    status: job?.status ?? null,
    current: job?.current ?? null,
    done: Number.isFinite(Number(job?.done)) ? Number(job.done) : null,
    total: Number.isFinite(Number(job?.total)) ? Number(job.total) : null,
    percent: Number.isFinite(Number(job?.percent)) ? Number(job.percent) : null,
    error: job?.error ?? null,
    resultFiles: job?.resultFiles != null ? job.resultFiles : undefined,
    createdAtMs: Number.isFinite(Number(job?.created_at_ms ?? job?.createdAtMs)) ? BigInt(job.created_at_ms ?? job.createdAtMs) : BigInt(now),
    updatedAtMs: BigInt(now),
  };
  if (!payload.id) throw new Error('id is required for upsertJob');
  await prisma.uploadJob.upsert({
    where: { id: payload.id },
    update: {
      prefix: payload.prefix ?? undefined,
      status: payload.status ?? undefined,
      current: payload.current ?? undefined,
      done: payload.done ?? undefined,
      total: payload.total ?? undefined,
      percent: payload.percent ?? undefined,
      error: payload.error ?? undefined,
      resultFiles: payload.resultFiles ?? undefined,
      updatedAtMs: payload.updatedAtMs,
    },
    create: payload,
  });
  lastWrite.set(payload.id, { at: now, percent: payload.percent });
  return getJobById(payload.id);
}

export async function getJobById(id) {
  if (!id) return null;
  const row = await prisma.uploadJob.findUnique({ where: { id } });
  return rowToJob(row);
}

export async function getJobByPrefix(prefix) {
  if (!prefix) return null;
  const row = await prisma.uploadJob.findFirst({
    where: { prefix },
    orderBy: { updatedAtMs: 'desc' },
  });
  return rowToJob(row);
}

export async function deleteJobById(id) {
  if (!id) return;
  await prisma.uploadJob.deleteMany({ where: { id } });
  try { lastWrite.delete(id); } catch {}
}

export async function clearAllJobs() {
  await prisma.uploadJob.deleteMany({});
  try { lastWrite.clear(); } catch {}
}

export async function updateJobThrottled(id, patch, { minIntervalMs = 1500, minPercentDelta = 1 } = {}) {
  if (!id) return null;
  const now = Date.now();
  const prev = lastWrite.get(id);
  const newPercent = patch && patch.percent != null ? Number(patch.percent) : null;
  const prevPercent = prev && prev.percent != null ? Number(prev.percent) : null;
  const pctDelta = newPercent != null && prevPercent != null ? Math.abs(newPercent - prevPercent) : null;

  const tooSoon = prev?.at != null && now - prev.at < minIntervalMs;
  const tooSmall = pctDelta != null && pctDelta < minPercentDelta;

  if (tooSoon && tooSmall) {
    return getJobById(id);
  }

  const existing = await getJobById(id);
  return upsertJob({ id, ...patch, created_at_ms: existing?.created_at_ms ?? now });
}

export async function listJobs({ activeOnly = false, limit = 50 } = {}) {
  const lim = (() => {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return 50;
    return Math.min(Math.trunc(n), 200);
  })();
  const rows = await prisma.uploadJob.findMany({
    where: activeOnly ? { status: { notIn: ['done', 'error', 'partial'] } } : undefined,
    orderBy: { updatedAtMs: 'desc' },
    take: lim,
  });
  return rows.map(rowToJob);
}

export { prisma };
