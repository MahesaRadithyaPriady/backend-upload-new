import fetch from 'node-fetch';
import { getJobById } from './uploadJobsDb.js';
import { getHlsEncodeRecordsByEpisode, upsertHlsEncodeRecord } from './hlsEncodeDb.js';
import {
  getDailyProgress,
  incrementAnimeCount,
  incrementErrorCount,
  markCompleted,
  canEncodeMoreToday,
  shouldResumeFrom,
  updateResumePoint,
} from './popularEncodeProgressDb.js';

const g = typeof globalThis !== 'undefined' ? globalThis : global;
if (!g.__popularEncodeInterval) g.__popularEncodeInterval = null;
if (!g.__popularEncodeRunning) g.__popularEncodeRunning = false;

function getAdminApiBase() {
  return String(process.env.ADMIN_API_BASE || '').replace(/\/+$/, '');
}

function getAdminApiToken() {
  return String(process.env.ADMIN_API_TOKEN || '').trim();
}

function makeJobId() {
  return `popenc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function fetchPopularAnime({ limit = 20, hlsStatus = 'PENDING', fetchAll = true } = {}) {
  const base = getAdminApiBase();
  const token = getAdminApiToken();
  if (!base || !token) {
    throw new Error('ADMIN_API_BASE or ADMIN_API_TOKEN not configured');
  }

  const allAnime = [];
  let offset = 0;
  const batchSize = limit;
  let page = 0;
  const maxPages = 100; // Safety limit

  while (page < maxPages) {
    page++;
    const url = new URL(`${base}/admin/hls/popular`);
    url.searchParams.set('limit', String(batchSize));
    url.searchParams.set('offset', String(offset));
    if (hlsStatus) url.searchParams.set('hlsStatus', hlsStatus);

    console.log(`[popularEncode] Fetching page ${page}: ${url.toString()}`);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000, // 30s timeout
    });

    console.log(`[popularEncode] Response status: ${res.status}`);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Admin API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const json = await res.json();
    console.log(`[popularEncode] Response JSON keys: ${Object.keys(json).join(', ')}`);

    const data = json?.data ?? json;
    const animeList = data?.anime_list ?? [];

    console.log(`[popularEncode] Page ${page}: got ${animeList.length} anime`);

    if (!animeList.length) break;

    allAnime.push(...animeList);

    if (!fetchAll || animeList.length < batchSize) break;
    offset += batchSize;
  }

  if (page >= maxPages) {
    console.warn(`[popularEncode] Hit max page limit (${maxPages}), stopping pagination`);
  }

  console.log(`[popularEncode] Total fetched: ${allAnime.length} anime from ${page} pages`);
  return { anime_list: allAnime, total_anime: allAnime.length };
}

async function triggerEncodeEpisode(episodeId, adminToken) {
  const base = getAdminApiBase();
  const jobId = makeJobId();

  const res = await fetch(`${base}/admin/hls/episodes/${episodeId}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch episode ${episodeId}: ${res.status}`);
  }

  const json = await res.json();
  const episodeData = json?.data ?? json;
  const qualities = episodeData?.qualities ?? [];

  const QUALITY_PRIORITY = ['1080p', '720p', '480p', '360p'];
  const sourceQuality = QUALITY_PRIORITY
    .map((label) => qualities.find((q) => q.nama_quality === label && q.source_quality))
    .find(Boolean);

  if (!sourceQuality) {
    throw new Error(`No source quality available for episode ${episodeId}`);
  }

  return {
    jobId,
    episodeId,
    sourceUrl: sourceQuality.source_quality,
    adminToken,
  };
}

async function runPopularEncodeCycle() {
  if (g.__popularEncodeRunning) {
    console.log('[popularEncode] Previous cycle still running, skipping...');
    return;
  }

  const enabled = String(process.env.ENABLE_POPULAR_ENCODE_JOB || 'false').toLowerCase() === 'true';
  if (!enabled) {
    console.log('[popularEncode] Job disabled (ENABLE_POPULAR_ENCODE_JOB !== true)');
    return;
  }

  g.__popularEncodeRunning = true;
  console.log('[popularEncode] Starting cycle...');

  try {
    const dailyLimit = parseInt(process.env.POPULAR_ENCODE_DAILY_LIMIT || '20', 10);
    const { canEncode, remaining, encodedToday } = await canEncodeMoreToday(dailyLimit);

    if (!canEncode) {
      console.log(`[popularEncode] Daily limit reached: ${encodedToday}/${dailyLimit} anime encoded today. Stopping.`);
      return;
    }

    console.log(`[popularEncode] Daily progress: ${encodedToday}/${dailyLimit} encoded, ${remaining} remaining`);

    const resumePoint = shouldResumeFrom(await getDailyProgress());
    if (resumePoint) {
      console.log(`[popularEncode] Resuming from last: animeId=${resumePoint.animeId}, episodeId=${resumePoint.episodeId}`);
    }

    // Fetch lebih banyak untuk bisa skip anime yang sudah di-process
    const batchSize = 50;
    const fetchAll = false;

    console.log(`[popularEncode] Fetching ${batchSize} anime per cycle (sequential mode)`);

    let data;
    try {
      data = await fetchPopularAnime({ limit: batchSize, hlsStatus: 'PENDING', fetchAll });
    } catch (fetchErr) {
      console.error(`[popularEncode] Fetch failed: ${fetchErr.message}`);
      throw fetchErr;
    }

    let animeList = data?.anime_list ?? [];
    console.log(`[popularEncode] Fetched ${animeList.length} anime from Admin API`);

    // Filter anime yang sudah di-process (skip anime dengan lastAnimeId)
    if (resumePoint && resumePoint.animeId) {
      const originalCount = animeList.length;
      animeList = animeList.filter(a => a.id !== resumePoint.animeId);
      if (animeList.length < originalCount) {
        console.log(`[popularEncode] Filtered out already-processed anime ${resumePoint.animeId}, ${animeList.length} remaining`);
      }
    }

    let encodedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // Kalau fetch 0 anime tapi masih bisa encode, coba lagi cepat
    if (animeList.length === 0 && status.canEncode) {
      console.log('[popularEncode] No anime returned from API, retrying in 5 seconds...');
      setTimeout(() => {
        runPopularEncodeCycle();
      }, 5000);
      return;
    }

    // Proses HANYA 1 anime per cycle
    for (const anime of animeList.slice(0, 1)) {
      // Skip kalau anime ini sudah di-process sebelumnya (resume point match)
      if (resumePoint && anime.id === resumePoint.animeId) {
        console.log(`[popularEncode] Anime ${anime.id} already processed in previous cycle, skipping`);
        skippedCount++;
        // Trigger next cycle cepat untuk cari anime lain
        setTimeout(() => {
          runPopularEncodeCycle();
        }, 5000);
        break;
      }

      const { canEncode: canEncodeMore } = await canEncodeMoreToday(dailyLimit);
      if (!canEncodeMore) {
        console.log(`[popularEncode] Daily limit ${dailyLimit} reached. Stopping.`);
        break;
      }

      const episodes = anime?.episodes ?? [];

      // Proses HANYA 1 episode per anime per cycle
      for (const ep of episodes.slice(0, 1)) {
        const episodeId = ep.id;
        const qualities = ep?.qualities ?? [];

        const pendingQualities = qualities.filter(
          (q) => q.hls_status === 'PENDING' || q.hls_status === 'FAILED'
        );

        if (!pendingQualities.length) {
          skippedCount++;
          continue;
        }

        // Check apakah ada source quality sebelum membuat job
        const QUALITY_PRIORITY = ['1080p', '720p', '480p', '360p'];
        const sourceQuality = QUALITY_PRIORITY
          .map((label) => qualities.find((q) => q.nama_quality === label && q.source_quality))
          .find(Boolean);

        if (!sourceQuality) {
          console.log(`[popularEncode] Episode ${episodeId} has NO source quality, skipping anime`);
          // Record sebagai error/skip ke DB
          await upsertHlsEncodeRecord({
            episodeId,
            jobId: makeJobId(),
            namaQuality: 'unknown',
            status: 'error',
            errorMessage: 'No source quality available on episode',
            encodedAt: new Date(),
          }).catch(() => {});
          skippedCount++;
          // Update resume point biar next cycle lanjut ke anime berikutnya (TANPA increment daily count)
          await updateResumePoint({
            animeId: anime.id,
            episodeId: ep.id,
            episodeNumber: String(ep.nomor_episode ?? ''),
          }).catch(() => {});
          // Skip ke anime berikutnya (bukan break ke episode berikutnya)
          break;
        }

        const existingRecords = await getHlsEncodeRecordsByEpisode(episodeId);
        const hasRunningJob = existingRecords.some((r) => r.status === 'processing');

        if (hasRunningJob) {
          console.log(`[popularEncode] Episode ${episodeId} already has running job, skipping`);
          skippedCount++;
          continue;
        }

        const token = getAdminApiToken();
        try {
          console.log(`[popularEncode] >>> STARTING encode: ${anime.nama_anime} Ep.${ep.nomor_episode} (ID: ${episodeId})`);
          console.log(`[popularEncode] Downloading 1 by 1...`);

          const localBase = `http://localhost:${process.env.PORT || 4000}`;
          const res = await fetch(`${localBase}/encode/anime`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ episodeId, adminToken: token }),
          });

          if (!res.ok) {
            const err = await res.text();
            throw new Error(`Encode API error: ${res.status} ${err.slice(0, 100)}`);
          }

          const result = await res.json();
          if (result.skipped) {
            console.log(`[popularEncode] Episode ${episodeId} skipped: ${result.reason}`);
            skippedCount++;
            // Kalau skipped karena HLS sudah ada, tetap count sebagai completed
            await incrementAnimeCount({
              animeId: anime.id,
              episodeId: ep.id,
              episodeNumber: String(ep.nomor_episode ?? ''),
            });
          } else {
            console.log(`[popularEncode] Episode ${episodeId} encode started: jobId=${result.jobId}`);
            encodedCount++;
            // Hanya count daily limit kalau encode BERHASIL
            await incrementAnimeCount({
              animeId: anime.id,
              episodeId: ep.id,
              episodeNumber: String(ep.nomor_episode ?? ''),
            });
          }
        } catch (err) {
          console.error(`[popularEncode] Failed to encode episode ${episodeId}: ${err.message}`);
          await incrementErrorCount();
          errorCount++;
          // KALAU GAGAL: jangan increment daily count, lanjut ke anime berikutnya
          console.log(`[popularEncode] Skipping anime ${anime.id} due to error (not counted)`);
          break;
        }

        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    const finalStatus = await canEncodeMoreToday(dailyLimit);
    if (!finalStatus.canEncode) {
      await markCompleted();
      console.log(`[popularEncode] Daily limit reached. Marked as completed.`);
    }

    console.log(`[popularEncode] Cycle complete: encoded=${encodedCount}, skipped=${skippedCount}, errors=${errorCount}, progress=${finalStatus.encodedToday}/${dailyLimit} (1 per 1 mode)`);

    // Kalau cuma skip (tidak ada yang encoded) dan masih bisa encode, lanjut cycle berikutnya cepat (5 detik)
    if (encodedCount === 0 && skippedCount > 0 && finalStatus.canEncode) {
      console.log('[popularEncode] Only skipped this cycle, triggering next cycle in 5 seconds...');
      setTimeout(() => {
        runPopularEncodeCycle();
      }, 5000);
    }
  } catch (err) {
    console.error(`[popularEncode] Cycle failed: ${err.message}`);
  } finally {
    g.__popularEncodeRunning = false;
  }
}

export function startPopularEncodeJob() {
  const enabled = String(process.env.ENABLE_POPULAR_ENCODE_JOB || 'false').toLowerCase() === 'true';
  const intervalMs = parseInt(process.env.POPULAR_ENCODE_INTERVAL_MS || '300000', 10);

  if (!enabled) {
    console.log('[popularEncode] Job not started (ENABLE_POPULAR_ENCODE_JOB !== true)');
    return;
  }

  if (g.__popularEncodeInterval) {
    console.log('[popularEncode] Job already running');
    return;
  }

  console.log(`[popularEncode] Starting job (interval: ${intervalMs}ms)`);

  // Reset flag jika cycle sebelumnya stuck (misal crash)
  if (g.__popularEncodeRunning) {
    console.log('[popularEncode] Resetting stuck cycle flag from previous run');
    g.__popularEncodeRunning = false;
  }

  runPopularEncodeCycle();

  g.__popularEncodeInterval = setInterval(runPopularEncodeCycle, intervalMs);
}

export function stopPopularEncodeJob() {
  if (g.__popularEncodeInterval) {
    clearInterval(g.__popularEncodeInterval);
    g.__popularEncodeInterval = null;
    console.log('[popularEncode] Job stopped');
  }
  // Reset cycle flag saat stop
  if (g.__popularEncodeRunning) {
    g.__popularEncodeRunning = false;
    console.log('[popularEncode] Reset cycle flag');
  }
}

export async function getPopularEncodeStatus() {
  const dailyLimit = parseInt(process.env.POPULAR_ENCODE_DAILY_LIMIT || '20', 10);
  const dailyStatus = await canEncodeMoreToday(dailyLimit);

  return {
    running: !!g.__popularEncodeInterval,
    cycleRunning: g.__popularEncodeRunning,
    enabled: String(process.env.ENABLE_POPULAR_ENCODE_JOB || 'false').toLowerCase() === 'true',
    intervalMs: parseInt(process.env.POPULAR_ENCODE_INTERVAL_MS || '300000', 10),
    fetchAll: String(process.env.POPULAR_ENCODE_FETCH_ALL || 'true').toLowerCase() === 'true',
    limit: parseInt(process.env.POPULAR_ENCODE_LIMIT || '20', 10),
    dailyLimit,
    dailyProgress: {
      encodedToday: dailyStatus.encodedToday,
      remaining: dailyStatus.remaining,
      completed: dailyStatus.completed,
    },
  };
}
