import { prisma } from './prisma.js';

export async function upsertHlsEncodeRecord({
  episodeId,
  jobId,
  namaQuality,
  status,
  hlsUrl = null,
  masterUrl = null,
  masterSize = null,
  errorMessage = null,
  resolution = null,
  bitrate = null,
  segments = null,
  duration = null,
  encodedAt = null,
  syncedAt = null,
}) {
  const data = {
    jobId,
    status,
    hlsUrl,
    masterUrl,
    errorMessage,
    resolution,
    bitrate,
    segments: segments != null ? Number(segments) : null,
    duration: duration != null ? Number(duration) : null,
    encodedAt: (() => { const d = encodedAt ? new Date(encodedAt) : null; return d && !isNaN(d) ? d : null; })(),
    syncedAt: syncedAt ? new Date(syncedAt) : null,
    ...(masterSize != null ? { masterSize: BigInt(masterSize) } : {}),
  };

  const row = await prisma.hlsEncodeRecord.upsert({
    where: { episodeId_namaQuality: { episodeId: Number(episodeId), namaQuality } },
    update: data,
    create: { episodeId: Number(episodeId), namaQuality, ...data },
  });
  return serializeRecord(row);
}

export async function getHlsEncodeRecordsByEpisode(episodeId) {
  const rows = await prisma.hlsEncodeRecord.findMany({
    where: { episodeId: Number(episodeId) },
    orderBy: { namaQuality: 'asc' },
  });
  return rows.map(serializeRecord);
}

export async function getHlsEncodeRecord(episodeId, namaQuality) {
  const row = await prisma.hlsEncodeRecord.findUnique({
    where: { episodeId_namaQuality: { episodeId: Number(episodeId), namaQuality } },
  });
  return row ? serializeRecord(row) : null;
}

export async function listHlsEncodeRecords({ status, page = 1, limit = 50 } = {}) {
  const where = status ? { status } : {};
  const [rows, total] = await Promise.all([
    prisma.hlsEncodeRecord.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: Math.min(Number(limit), 200),
      skip: (Math.max(Number(page), 1) - 1) * Math.min(Number(limit), 200),
    }),
    prisma.hlsEncodeRecord.count({ where }),
  ]);
  return { total, rows: rows.map(serializeRecord) };
}

export async function updateHlsMasterSize(episodeId, namaQuality, masterSize) {
  const row = await prisma.hlsEncodeRecord.update({
    where: { episodeId_namaQuality: { episodeId: Number(episodeId), namaQuality } },
    data: { masterSize: BigInt(masterSize), syncedAt: new Date() },
  });
  return serializeRecord(row);
}

function formatBytes(bytes) {
  if (bytes == null) return null;
  const n = Number(bytes);
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${n} B`;
}

function serializeRecord(r) {
  const masterSize = r.masterSize != null ? Number(r.masterSize) : null;
  return {
    ...r,
    masterSize,
    masterSizeFormatted: formatBytes(masterSize),
  };
}

export { prisma };
