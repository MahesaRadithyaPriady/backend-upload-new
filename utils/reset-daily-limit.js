#!/usr/bin/env node
/**
 * Reset Daily Limit Script for Popular Encode Job
 * Run: node utils/reset-daily-limit.js
 */

console.log('[reset-daily-limit] Starting script...');

import { prisma } from '../lib/prisma.js';

console.log('[reset-daily-limit] Prisma imported successfully');

function getTodayKey() {
  const now = new Date();
  return now.toISOString().split('T')[0]; // YYYY-MM-DD
}

async function resetDailyLimit() {
  console.log('[reset-daily-limit] Function started');
  
  const dateKey = getTodayKey();
  
  console.log('='.repeat(60));
  console.log('Reset Daily Limit - Popular Encode Job');
  console.log('='.repeat(60));
  console.log(`Date: ${dateKey}`);
  console.log('');

  try {
    // Find today's record
    const existing = await prisma.popularEncodeProgress.findUnique({
      where: { dateKey },
    });

    if (!existing) {
      console.log('No record found for today. Daily limit is already at 0.');
      console.log('You can start encoding immediately.');
      return;
    }

    console.log('Current record:');
    console.log(`  - Anime encoded: ${existing.animeEncoded}`);
    console.log(`  - Completed: ${existing.completed}`);
    console.log(`  - Error count: ${existing.errorCount}`);
    console.log(`  - Last anime: ${existing.lastAnimeId || 'none'}`);
    console.log(`  - Last episode: ${existing.lastEpisodeId || 'none'}`);
    console.log('');

    // Reset the record
    await prisma.popularEncodeProgress.update({
      where: { dateKey },
      data: {
        animeEncoded: 0,
        completed: false,
        errorCount: 0,
        lastAnimeId: null,
        lastEpisodeId: null,
        lastEpisodeNumber: null,
      },
    });

    console.log('✅ Daily limit RESET successfully!');
    console.log('');
    console.log('New state:');
    console.log('  - Anime encoded: 0');
    console.log('  - Completed: false');
    console.log('  - Error count: 0');
    console.log('');
    console.log('You can now start encoding again.');

  } catch (err) {
    console.error('❌ Error resetting daily limit:', err.message);
    process.exit(1);
  }
}

// Run if called directly
const isMainModule = import.meta.url.startsWith('file://') && process.argv[1] && import.meta.url.includes(process.argv[1].replace(/\\/g, '/'));
if (isMainModule || process.argv[1]?.includes('reset-daily-limit')) {
  console.log('[reset-daily-limit] Running as main module...');
  resetDailyLimit()
    .then(() => {
      console.log('');
      console.log('Done. Exiting...');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Fatal error:', err.message);
      process.exit(1);
    });
} else {
  console.log('[reset-daily-limit] Not main module, skipping execution');
  console.log('  import.meta.url:', import.meta.url);
  console.log('  process.argv[1]:', process.argv[1]);
}

export { resetDailyLimit, getTodayKey };
