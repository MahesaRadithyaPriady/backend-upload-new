import { prisma } from './prisma.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

export async function getDailyProgress() {
  const today = getTodayKey();
  const row = await prisma.popularEncodeProgress.findUnique({
    where: { dateKey: today },
  });
  return row || {
    dateKey: today,
    animeEncoded: 0,
    lastAnimeId: null,
    lastEpisodeId: null,
    lastEpisodeNumber: null,
    completed: false,
    errorCount: 0,
  };
}

export async function incrementAnimeCount({ animeId, episodeId, episodeNumber }) {
  const today = getTodayKey();
  const existing = await prisma.popularEncodeProgress.findUnique({
    where: { dateKey: today },
  });

  if (existing) {
    return await prisma.popularEncodeProgress.update({
      where: { dateKey: today },
      data: {
        animeEncoded: { increment: 1 },
        lastAnimeId: animeId,
        lastEpisodeId: episodeId,
        lastEpisodeNumber: episodeNumber,
        updatedAt: new Date(),
      },
    });
  }

  return await prisma.popularEncodeProgress.create({
    data: {
      dateKey: today,
      animeEncoded: 1,
      lastAnimeId: animeId,
      lastEpisodeId: episodeId,
      lastEpisodeNumber: episodeNumber,
      completed: false,
      errorCount: 0,
      updatedAt: new Date(),
    },
  });
}

export async function markCompleted() {
  const today = getTodayKey();
  return await prisma.popularEncodeProgress.updateMany({
    where: { dateKey: today },
    data: { completed: true, updatedAt: new Date() },
  });
}

export async function incrementErrorCount() {
  const today = getTodayKey();
  const existing = await prisma.popularEncodeProgress.findUnique({
    where: { dateKey: today },
  });

  if (existing) {
    return await prisma.popularEncodeProgress.update({
      where: { dateKey: today },
      data: {
        errorCount: { increment: 1 },
        updatedAt: new Date(),
      },
    });
  }

  return await prisma.popularEncodeProgress.create({
    data: {
      dateKey: today,
      animeEncoded: 0,
      errorCount: 1,
      completed: false,
      updatedAt: new Date(),
    },
  });
}

export async function updateResumePoint({ animeId, episodeId, episodeNumber }) {
  const today = getTodayKey();
  const existing = await prisma.popularEncodeProgress.findUnique({
    where: { dateKey: today },
  });

  if (existing) {
    return await prisma.popularEncodeProgress.update({
      where: { dateKey: today },
      data: {
        lastAnimeId: animeId,
        lastEpisodeId: episodeId,
        lastEpisodeNumber: episodeNumber,
        updatedAt: new Date(),
      },
    });
  }

  // Kalau belum ada record, buat baru dengan semua field null kecuali resume point
  return await prisma.popularEncodeProgress.create({
    data: {
      dateKey: today,
      animeEncoded: 0,
      lastAnimeId: animeId,
      lastEpisodeId: episodeId,
      lastEpisodeNumber: episodeNumber,
      completed: false,
      errorCount: 0,
      updatedAt: new Date(),
    },
  });
}

export async function resetDailyProgress() {
  const today = getTodayKey();
  return await prisma.popularEncodeProgress.deleteMany({
    where: { dateKey: today },
  });
}

export async function getLastProgress() {
  const row = await prisma.popularEncodeProgress.findFirst({
    orderBy: { updatedAt: 'desc' },
  });
  return row;
}

export function shouldResumeFrom(lastProgress) {
  if (!lastProgress) return null;

  const today = getTodayKey();
  if (lastProgress.dateKey !== today) return null;

  if (lastProgress.completed) return null;

  return {
    animeId: lastProgress.lastAnimeId,
    episodeId: lastProgress.lastEpisodeId,
    episodeNumber: lastProgress.lastEpisodeNumber,
  };
}

export async function canEncodeMoreToday(limit = 20) {
  const progress = await getDailyProgress();
  return {
    canEncode: progress.animeEncoded < limit,
    remaining: Math.max(0, limit - progress.animeEncoded),
    encodedToday: progress.animeEncoded,
    limit,
    completed: progress.completed,
  };
}
