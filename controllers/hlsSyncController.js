import {
  upsertHlsEncodeRecord,
  getHlsEncodeRecordsByEpisode,
  getHlsEncodeRecord,
  listHlsEncodeRecords,
} from '../lib/hlsEncodeDb.js';
import { prisma as catalogPrisma } from '../lib/storageCatalogDb.js';
import { RENDITIONS } from '../lib/encodeMultiRendition.js';

function getAdminApiBase() {
  return String(process.env.ADMIN_API_BASE || '').replace(/\/+$/, '');
}

function getCdnBase() {
  return String(process.env.B2_CDN_BASE || `https://cdn-stable.nanimeid.xyz/file/${process.env.B2_BUCKET_NAME || 'NanimeID'}`).replace(/\/+$/, '');
}

function deriveMasterUrl(hlsUrl) {
  if (!hlsUrl) return null;
  try {
    const url = new URL(hlsUrl);
    const parts = url.pathname.split('/');
    const qualityIdx = parts.length - 2;
    if (qualityIdx < 1) return null;
    parts.splice(qualityIdx, 2, 'master.m3u8');
    url.pathname = parts.join('/');
    return url.toString();
  } catch {
    return null;
  }
}

function getRenditionSpec(namaQuality) {
  return RENDITIONS.find((r) => r.label === namaQuality) ?? null;
}

async function getQualityInfoFromCatalog(hlsUrl, namaQuality) {
  const result = { masterSize: null, resolution: null, bitrate: null, segments: null };
  if (!hlsUrl) return result;
  try {
    const cdnBase = getCdnBase();
    const filePath = hlsUrl.replace(cdnBase + '/', '').replace(/^\/+/, '');
    const folderPrefix = filePath.substring(0, filePath.lastIndexOf('/') + 1);
    console.log(`[hlsSync] catalog lookup prefix=${folderPrefix}`);
    const rows = await catalogPrisma.file.findMany({
      where: { filePath: { startsWith: folderPrefix } },
      select: { size: true, fileName: true },
    });
    console.log(`[hlsSync] catalog found ${rows.length} files under prefix`);
    result.masterSize = rows.reduce((sum, r) => sum + Number(r.size), 0) || null;
    result.segments = rows.filter((r) => r.fileName.endsWith('.m4s')).length || null;
    const spec = getRenditionSpec(namaQuality);
    if (spec) {
      result.resolution = `${spec.width}x${spec.height}`;
      result.bitrate = spec.videoBitrate;
    }
  } catch {}
  return result;
}


async function sendAdminCallback({ episodeId, results, adminToken }) {
  const base = getAdminApiBase();
  if (!base) {
    console.warn('[hlsSync] ADMIN_API_BASE not set, skipping callback');
    return;
  }
  const payload = { episode_id: episodeId, results };
  const safePayload = JSON.parse(JSON.stringify(payload, (_, v) => typeof v === 'bigint' ? Number(v) : v));
  console.log(`[hlsSync] Sending callback episodeId=${episodeId} to ${base}/admin/hls/callback/bulk`);
  console.log(`[hlsSync] Callback payload: ${JSON.stringify(safePayload)}`);
  try {
    const res = await fetch(`${base}/admin/hls/callback/bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
      },
      body: JSON.stringify(safePayload),
    });
    const text = await res.text();
    console.log(`[hlsSync] Admin callback status: ${res.status}`);
    console.log(`[hlsSync] Admin callback response: ${text}`);
  } catch (err) {
    console.error(`[hlsSync] Admin callback failed: ${err.message}`);
  }
}

async function fetchEpisodeDoneQualities(episodeId, adminToken) {
  const base = getAdminApiBase();
  if (!base) throw new Error('ADMIN_API_BASE not configured');
  const res = await fetch(`${base}/admin/hls/episodes/${episodeId}`, {
    headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {},
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Admin API ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  const episode = json?.data ?? json;
  const qualities = (episode?.qualities ?? []).filter((q) => q.hls_status === 'DONE' && q.hls_url);
  return { episode, qualities };
}

export async function syncHlsEpisodeController(request, reply) {
  const episodeId = Number(request.params?.episodeId ?? request.body?.episodeId ?? request.query?.episodeId);
  console.log(`[hlsSync] syncEpisode called episodeId=${episodeId} body=${JSON.stringify(request.body)} headers.auth=${request.headers?.authorization?.slice(0, 30)}`);
  if (!Number.isInteger(episodeId) || episodeId <= 0) {
    return reply.code(400).send({ error: 'episodeId wajib diisi (integer > 0)' });
  }

  const adminToken = String(
    request.headers?.authorization?.replace(/^Bearer\s+/i, '') ||
    request.body?.adminToken || request.body?.admin_token ||
    request.query?.adminToken || ''
  ).trim();
  console.log(`[hlsSync] adminToken=${adminToken ? adminToken.slice(0, 10) + '...' : 'EMPTY'} ADMIN_API_BASE=${getAdminApiBase() || 'NOT SET'}`);
  if (!adminToken) {
    return reply.code(400).send({ error: 'adminToken wajib dikirim (header Authorization atau body adminToken)' });
  }

  let episode, qualities;
  try {
    ({ episode, qualities } = await fetchEpisodeDoneQualities(episodeId, adminToken));
  } catch (err) {
    console.error(`[hlsSync] fetchEpisodeDoneQualities error: ${err.message}`);
    return reply.code(502).send({ error: err.message });
  }

  if (!qualities.length) {
    return reply.send({
      episodeId,
      synced: 0,
      message: 'Tidak ada quality dengan status DONE pada episode ini',
      records: [],
    });
  }

  const masterUrl = episode?.hls_master_url || deriveMasterUrl(qualities[0]?.hls_url);
  console.log(`[hlsSync] episodeId=${episodeId} masterUrl=${masterUrl}`);

  const synced = [];
  for (const q of qualities) {
    const catalogInfo = (q.hls_size == null || !q.hls_metadata)
      ? await getQualityInfoFromCatalog(q.hls_url, q.nama_quality)
      : { masterSize: Number(q.hls_size), resolution: q.hls_metadata?.resolution, bitrate: q.hls_metadata?.bitrate, segments: q.hls_metadata?.segments };

    const masterSize = q.hls_size != null ? Number(q.hls_size) : catalogInfo.masterSize;
    const resolution = q.hls_metadata?.resolution ?? catalogInfo.resolution;
    const bitrate    = q.hls_metadata?.bitrate    ?? catalogInfo.bitrate;
    const segments   = q.hls_metadata?.segments   ?? catalogInfo.segments;
    const duration   = q.hls_metadata?.duration   ?? null;
    console.log(`[hlsSync] quality=${q.nama_quality} masterSize=${masterSize} resolution=${resolution} bitrate=${bitrate} segments=${segments}`);

    await upsertHlsEncodeRecord({
      episodeId,
      jobId: q.hls_job_id ?? `sync_${episodeId}_${q.nama_quality}`,
      namaQuality: q.nama_quality,
      status: 'done',
      hlsUrl: q.hls_url,
      masterUrl,
      masterSize,
      resolution,
      bitrate,
      segments,
      duration,
      encodedAt: q.hls_encoded_at ? new Date(q.hls_encoded_at) : null,
      syncedAt: new Date(),
    });

    synced.push({
      namaQuality: q.nama_quality,
      hlsUrl: q.hls_url,
      masterUrl,
      masterSize,
      resolution,
      bitrate,
      segments,
    });
  }

  const records = await getHlsEncodeRecordsByEpisode(episodeId);

  if (synced.length) {
    const callbackResults = synced.map((s) => ({
      nama_quality: s.namaQuality,
      success: true,
      hls_url: s.hlsUrl,
      hls_master_url: s.masterUrl,
      hls_size: s.masterSize,
      metadata: {
        resolution: s.resolution,
        bitrate: s.bitrate,
        segments: s.segments,
      },
    }));
    await sendAdminCallback({ episodeId, results: callbackResults, adminToken });
  }

  return reply.send({
    episodeId,
    synced: synced.length,
    message: `Berhasil sinkronisasi ${synced.length} quality`,
    results: synced,
    records,
  });
}

export async function syncHlsBulkController(request, reply) {
  const body = request.body || {};

  const adminToken = String(
    request.headers?.authorization?.replace(/^Bearer\s+/i, '') ||
    body.adminToken || body.admin_token || ''
  ).trim();
  if (!adminToken) {
    return reply.code(400).send({ error: 'adminToken wajib dikirim' });
  }

  const episodeIds = Array.isArray(body.episodeIds) ? body.episodeIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!episodeIds.length) {
    return reply.code(400).send({ error: 'episodeIds wajib diisi (array of integer)' });
  }

  const results = [];
  for (const episodeId of episodeIds) {
    try {
      let { episode, qualities } = await fetchEpisodeDoneQualities(episodeId, adminToken);
      let syncedCount = 0;
      const masterUrl = episode?.hls_master_url || deriveMasterUrl(qualities[0]?.hls_url);
      for (const q of qualities) {
        const catalogInfo = (q.hls_size == null || !q.hls_metadata)
          ? await getQualityInfoFromCatalog(q.hls_url, q.nama_quality)
          : { masterSize: Number(q.hls_size), resolution: q.hls_metadata?.resolution, bitrate: q.hls_metadata?.bitrate, segments: q.hls_metadata?.segments };

        const masterSize = q.hls_size != null ? Number(q.hls_size) : catalogInfo.masterSize;
        await upsertHlsEncodeRecord({
          episodeId,
          jobId: q.hls_job_id ?? `sync_${episodeId}_${q.nama_quality}`,
          namaQuality: q.nama_quality,
          status: 'done',
          hlsUrl: q.hls_url,
          masterUrl,
          masterSize,
          resolution: q.hls_metadata?.resolution ?? catalogInfo.resolution,
          bitrate: q.hls_metadata?.bitrate ?? catalogInfo.bitrate,
          segments: q.hls_metadata?.segments ?? catalogInfo.segments,
          duration: q.hls_metadata?.duration ?? null,
          encodedAt: q.hls_encoded_at ? new Date(q.hls_encoded_at) : null,
          syncedAt: new Date(),
        });
        syncedCount += 1;
      }
      if (syncedCount > 0) {
        const callbackResults = qualities
          .filter((q) => q.hls_url)
          .map((q) => {
            const spec = getRenditionSpec(q.nama_quality);
            return {
              nama_quality: q.nama_quality,
              success: true,
              hls_url: q.hls_url,
              hls_master_url: masterUrl,
              hls_size: q.hls_size != null ? Number(q.hls_size) : null,
              metadata: {
                resolution: q.hls_metadata?.resolution ?? (spec ? `${spec.width}x${spec.height}` : null),
                bitrate: q.hls_metadata?.bitrate ?? (spec ? spec.videoBitrate : null),
                segments: q.hls_metadata?.segments ?? null,
              },
            };
          });
        await sendAdminCallback({ episodeId, results: callbackResults, adminToken });
      }
      results.push({ episodeId, ok: true, synced: syncedCount });
    } catch (err) {
      results.push({ episodeId, ok: false, error: err.message });
    }
  }

  return reply.send({ results });
}

export async function getHlsRecordsController(request, reply) {
  const episodeId = Number(request.params?.episodeId ?? request.query?.episodeId);
  if (Number.isInteger(episodeId) && episodeId > 0) {
    const records = await getHlsEncodeRecordsByEpisode(episodeId);
    return reply.send({ episodeId, records });
  }

  const { status, page, limit } = request.query || {};
  const result = await listHlsEncodeRecords({ status, page: Number(page) || 1, limit: Number(limit) || 50 });
  return reply.send(result);
}

export async function refreshMasterSizeController(request, reply) {
  const episodeId = Number(request.params?.episodeId);
  if (!Number.isInteger(episodeId) || episodeId <= 0) {
    return reply.code(400).send({ error: 'episodeId tidak valid' });
  }

  const adminToken = String(
    request.headers?.authorization?.replace(/^Bearer\s+/i, '') ||
    request.body?.adminToken || request.body?.admin_token ||
    request.query?.adminToken || ''
  ).trim();
  if (!adminToken) {
    return reply.code(400).send({ error: 'adminToken wajib dikirim' });
  }

  let episode, qualities;
  try {
    ({ episode, qualities } = await fetchEpisodeDoneQualities(episodeId, adminToken));
  } catch (err) {
    return reply.code(502).send({ error: err.message });
  }

  const masterUrl = episode?.hls_master_url || deriveMasterUrl(qualities[0]?.hls_url);
  const updated = [];

  for (const q of qualities) {
    const catalogInfo = (q.hls_size == null || !q.hls_metadata)
      ? await getQualityInfoFromCatalog(q.hls_url, q.nama_quality)
      : { masterSize: Number(q.hls_size), resolution: q.hls_metadata?.resolution, bitrate: q.hls_metadata?.bitrate, segments: q.hls_metadata?.segments };

    const masterSize = q.hls_size != null ? Number(q.hls_size) : catalogInfo.masterSize;
    await upsertHlsEncodeRecord({
      episodeId,
      jobId: q.hls_job_id ?? `sync_${episodeId}_${q.nama_quality}`,
      namaQuality: q.nama_quality,
      status: 'done',
      hlsUrl: q.hls_url,
      masterUrl,
      masterSize,
      resolution: q.hls_metadata?.resolution ?? catalogInfo.resolution,
      bitrate: q.hls_metadata?.bitrate ?? catalogInfo.bitrate,
      segments: q.hls_metadata?.segments ?? catalogInfo.segments,
      duration: q.hls_metadata?.duration ?? null,
      encodedAt: q.hls_encoded_at ? new Date(q.hls_encoded_at) : null,
      syncedAt: new Date(),
    });
    updated.push({ namaQuality: q.nama_quality, masterSize, resolution: q.hls_metadata?.resolution ?? catalogInfo.resolution, bitrate: q.hls_metadata?.bitrate ?? catalogInfo.bitrate, segments: q.hls_metadata?.segments ?? catalogInfo.segments });
  }

  return reply.send({ episodeId, masterUrl, updated });
}
