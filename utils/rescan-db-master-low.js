import fs from 'fs';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';

const MB = 1024 * 1024;
const QUALITY_SCORE = {
  '360p': 1,
  '480p': 2,
  '720p': 3,
  '1080p': 4,
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.split('=', 2);
      const key = k.slice(2);
      if (typeof v === 'string') {
        args[key] = v;
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          args[key] = next;
          i++;
        } else {
          args[key] = true;
        }
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function inferResolutionBySize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 50 * MB) return '360p';
  if (n <= 90 * MB) return '480p';
  if (n <= 150 * MB) return '720p';
  return '1080p';
}

function detectQualityFromPath(filePath) {
  const s = String(filePath || '').toLowerCase();

  const has1080 = /(^|[^0-9])1080(p|[^0-9]|$)/i.test(s) || /\bfhd\b|\bfull\s*hd\b|\bfullhd\b/i.test(s);
  if (has1080) return '1080p';

  const has720 = /(^|[^0-9])720(p|[^0-9]|$)/i.test(s) || /(^|[^0-9])720([^0-9]|$)/i.test(s) || /\bhd\b/i.test(s);
  if (has720) return '720p';

  const has480 = /(^|[^0-9])480(p|[^0-9]|$)/i.test(s) || /(^|[^0-9])480([^0-9]|$)/i.test(s) || /\bsd\b/i.test(s);
  if (has480) return '480p';

  const has360 = /(^|[^0-9])360(p|[^0-9]|$)/i.test(s) || /(^|[^0-9])360([^0-9]|$)/i.test(s);
  if (has360) return '360p';

  return null;
}

function resolveQuality({ filePath, size }) {
  const byPath = detectQualityFromPath(filePath);
  if (byPath) return { quality: byPath, source: 'path' };
  return { quality: inferResolutionBySize(size), source: 'size' };
}

function extractEpisodeKey(filePath) {
  const s = String(filePath || '');
  const base = path.posix.basename(s);
  const lower = base.toLowerCase();

  const mSxxEyy = lower.match(/\bs(\d{1,2})\s*e(\d{1,3})\b/);
  if (mSxxEyy) return `s${mSxxEyy[1].padStart(2, '0')}e${mSxxEyy[2].padStart(2, '0')}`;

  const mEpisodeWord = lower.match(/\bepisode\s*(\d{1,3})\b/);
  if (mEpisodeWord) return `ep${String(mEpisodeWord[1]).padStart(2, '0')}`;

  const mEps = lower.match(/\beps\s*[-_ ]?(\d{1,3})\b/);
  if (mEps) return `ep${String(mEps[1]).padStart(2, '0')}`;

  const mEP = lower.match(/\bep\s*[-_ ]?(\d{1,3})(?:\.(\d{1,2}))?\b/);
  if (mEP) {
    const main = `ep${String(mEP[1]).padStart(2, '0')}`;
    if (mEP[2]) return `${main}.${mEP[2]}`;
    return main;
  }

  if (/\bova\b/.test(lower)) return 'ova';

  return 'unknown';
}

function pickMaster(items) {
  if (!Array.isArray(items) || items.length === 0) return null;

  let best = null;
  for (const it of items) {
    const score = QUALITY_SCORE[it.quality || ''] || 0;
    const bestScore = best ? QUALITY_SCORE[best.quality || ''] || 0 : -1;
    if (!best || score > bestScore || (score === bestScore && it.size > best.size)) {
      best = it;
    }
  }

  let best1080p = null;
  let largestAny = null;
  for (const it of items) {
    if (!largestAny || it.size > largestAny.size) largestAny = it;
    if (it.quality === '1080p') {
      if (!best1080p || it.size > best1080p.size) best1080p = it;
    }
  }

  if (best1080p) {
    if (largestAny && largestAny.size > best1080p.size) return largestAny;
    return best1080p;
  }

  return best;
}

function pickLow(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  let best = null;
  for (const it of items) {
    const score = QUALITY_SCORE[it.quality || ''] || 0;
    const bestScore = best ? QUALITY_SCORE[best.quality || ''] || 0 : Infinity;
    if (!best || score < bestScore || (score === bestScore && it.size > best.size)) {
      best = it;
    }
  }
  return best;
}

function ensureColumns(db) {
  const cols = db.prepare(`PRAGMA table_info(files);`).all();
  const names = new Set(cols.map((c) => String(c.name)));
  if (!names.has('is_master')) db.exec(`ALTER TABLE files ADD COLUMN is_master INTEGER DEFAULT 0;`);
  if (!names.has('is_low')) db.exec(`ALTER TABLE files ADD COLUMN is_low INTEGER DEFAULT 0;`);
}

function main() {
  const args = parseArgs(process.argv);
  const dbPath = path.resolve(String(args.db || args._[0] || 'storage_catalog.db'));
  const apply = args.apply === true || String(args.apply || '').toLowerCase() === 'true';
  const outPath = path.resolve(String(args.out || 'warning.txt'));

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  ensureColumns(db);

  const rows = db
    .prepare(`SELECT id, folder_id, file_path, size FROM files WHERE folder_id IS NOT NULL ORDER BY folder_id ASC, id ASC;`)
    .all();

  const byEpisodeGroup = new Map();
  const fallbackSizeItems = [];

  for (const r of rows) {
    const res = resolveQuality({ filePath: r.file_path, size: r.size });
    const episodeKey = extractEpisodeKey(r.file_path);
    const item = {
      id: r.id,
      folderId: r.folder_id,
      episodeKey,
      filePath: r.file_path,
      size: Number(r.size) || 0,
      quality: res.quality,
      source: res.source,
    };
    const groupKey = `${item.folderId}:${item.episodeKey}`;
    if (!byEpisodeGroup.has(groupKey)) byEpisodeGroup.set(groupKey, []);
    byEpisodeGroup.get(groupKey).push(item);
    if (item.source === 'size') fallbackSizeItems.push(item);
  }

  const masterIds = new Set();
  const lowIds = new Set();
  const missingMasterFolders = [];
  const missingLowFolders = [];
  const insufficientQualityFolders = [];

  const groupDetails = new Map();
  const missingMasterGroups = [];
  const missingLowGroups = [];

  for (const [groupKey, items] of byEpisodeGroup.entries()) {
    const [folderIdStr, episodeKey] = String(groupKey).split(':');
    const folderId = Number(folderIdStr) || 0;
    const master = pickMaster(items);
    const low = pickLow(items);

    if (master) masterIds.add(master.id);
    else missingMasterGroups.push({ folderId, episodeKey });

    if (low) lowIds.add(low.id);
    else missingLowGroups.push({ folderId, episodeKey });

    const uniqueQ = new Set(items.map((x) => x.quality).filter(Boolean));
    if (uniqueQ.size < 2) {
      const only = uniqueQ.size === 1 ? [...uniqueQ][0] : '';
      if (only !== '720p' && only !== '1080p') {
        insufficientQualityFolders.push({ folderId, episodeKey, qualities: [...uniqueQ].sort() });
      }
    }

    groupDetails.set(
      groupKey,
      items
        .slice()
        .sort((a, b) => {
          const sa = QUALITY_SCORE[a.quality] || 0;
          const sb = QUALITY_SCORE[b.quality] || 0;
          if (sb !== sa) return sb - sa;
          if (b.size !== a.size) return b.size - a.size;
          return a.id - b.id;
        }),
    );
  }

  if (apply) {
    const tx = db.transaction(() => {
      db.exec(`UPDATE files SET is_master = 0, is_low = 0;`);
      const setMaster = db.prepare(`UPDATE files SET is_master = 1 WHERE id = ?;`);
      const setLow = db.prepare(`UPDATE files SET is_low = 1 WHERE id = ?;`);
      for (const id of masterIds) setMaster.run(id);
      for (const id of lowIds) setLow.run(id);
    });
    tx();
  }

  const lines = [];

  lines.push('== SUMMARY ==');
  lines.push(`db=${dbPath}`);
  lines.push(`episode_groups_scanned=${byEpisodeGroup.size}`);
  lines.push(`files_scanned=${rows.length}`);
  lines.push(`apply=${apply ? 'true' : 'false'}`);
  lines.push(`fallback_size_count=${fallbackSizeItems.length}`);
  lines.push(`missing_master_groups=${missingMasterGroups.length}`);
  lines.push(`missing_low_groups=${missingLowGroups.length}`);
  lines.push(`groups_quality_lt_2=${insufficientQualityFolders.length}`);

  lines.push('');
  lines.push('== MISSING MASTER GROUPS (folder_id\tepisode_key) ==');
  lines.push(
    ...(missingMasterGroups.length ? missingMasterGroups.map((x) => `${x.folderId}\t${x.episodeKey}`) : ['(none)']),
  );

  lines.push('');
  lines.push('== MISSING LOW GROUPS (folder_id\tepisode_key) ==');
  lines.push(...(missingLowGroups.length ? missingLowGroups.map((x) => `${x.folderId}\t${x.episodeKey}`) : ['(none)']));

  lines.push('');
  lines.push('== FOLDERS WITH < 2 QUALITIES ==');
  if (!insufficientQualityFolders.length) {
    lines.push('(none)');
  } else {
    for (const it of insufficientQualityFolders) {
      lines.push(`${it.folderId}\t${it.episodeKey}\t${it.qualities.join(',')}`);
    }
  }

  lines.push('');
  lines.push('== FOLDERS WITH < 2 QUALITIES (DETAIL) ==');
  lines.push('folder_id\tepisode_key\tfile_path\tsize\tquality\tsource\tis_master\tis_low');
  if (!insufficientQualityFolders.length) {
    lines.push('(none)');
  } else {
    const q = db.prepare('SELECT is_master, is_low FROM files WHERE id = ?;');
    for (const it of insufficientQualityFolders) {
      const groupKey = `${it.folderId}:${it.episodeKey}`;
      const items = groupDetails.get(groupKey) || [];
      for (const f of items) {
        const flags = q.get(f.id) || { is_master: 0, is_low: 0 };
        lines.push(`${it.folderId}\t${it.episodeKey}\t${f.filePath}\t${f.size}\t${f.quality}\t${f.source}\t${flags.is_master}\t${flags.is_low}`);
      }
    }
  }

  lines.push('');
  lines.push('== FALLBACK TO SIZE (PATH NOT DETECTED) ==');
  lines.push('folder_id\tepisode_key\tfile_path\tsize\tquality_inferred\tsource');
  if (!fallbackSizeItems.length) {
    lines.push('(none)');
  } else {
    for (const it of fallbackSizeItems) {
      lines.push(`${it.folderId}\t${it.episodeKey}\t${it.filePath}\t${it.size}\t${it.quality}\t${it.source}`);
    }
  }

  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  db.close();

  console.log(`Wrote ${outPath}`);
  if (!apply) {
    console.log('Run with --apply to update is_master/is_low in the DB.');
  }
}

main();
