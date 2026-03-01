import fs from 'fs';
import path from 'path';
import process from 'process';
import dotenv from 'dotenv';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@aws-sdk/node-http-handler';

dotenv.config();

const RESOLUTIONS = ['1080p', '720p', '480p', '360p'];

const MB = 1024 * 1024;
const UNKNOWN_SIZE_RULES = [
  { maxBytes: 50 * MB, resolution: '360p' },
  { maxBytes: 90 * MB, resolution: '480p' },
  { maxBytes: 150 * MB, resolution: '720p' },
  { maxBytes: Infinity, resolution: '1080p' },
];

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

function detectResolution(str) {
  const s = String(str || '').toLowerCase();
  if (/\bfhd\b|\bfull\s*hd\b|\bfullhd\b/.test(s)) return '1080p';
  if (/(^|[^0-9])1080(p|[^0-9]|$)/.test(s) || /(^|[^0-9])1080([^0-9]|$)/.test(s)) return '1080p';
  if (/(^|[^0-9])720(p|[^0-9]|$)/.test(s) || /(^|[^0-9])720([^0-9]|$)/.test(s)) return '720p';
  if (/(^|[^0-9])480(p|[^0-9]|$)/.test(s) || /(^|[^0-9])480([^0-9]|$)/.test(s)) return '480p';
  if (/(^|[^0-9])360(p|[^0-9]|$)/.test(s) || /(^|[^0-9])360([^0-9]|$)/.test(s)) return '360p';
  return null;
}

function inferResolutionBySize(bytes) {
  const n = Number(bytes) || 0;
  for (const rule of UNKNOWN_SIZE_RULES) {
    if (n <= rule.maxBytes) return rule.resolution;
  }
  return '1080p';
}

function resolveQuality({ nameOrKey, size, inferUnknownBySize }) {
  const byName = detectResolution(nameOrKey);
  if (byName) return byName;
  if (inferUnknownBySize) return inferResolutionBySize(size);
  return null;
}

function getParentFolder(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  if (i >= 0) return s.slice(0, i) || '/';
  const j = s.lastIndexOf(path.sep);
  if (j >= 0) return s.slice(0, j) || path.sep;
  return '.';
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

function createStats() {
  const stats = {};
  for (const r of RESOLUTIONS) {
    stats[r] = { bytes: 0, files: 0 };
  }
  stats.unknown = { bytes: 0, files: 0 };
  stats.total = { bytes: 0, files: 0 };
  return stats;
}

function parseLimit(v) {
  if (v === undefined || v === null || v === '' || v === true) return Infinity;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return Infinity;
  return Math.floor(n);
}

function parseIntOrInfinity(v) {
  if (v === undefined || v === null || v === '' || v === true) return Infinity;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return Infinity;
  return Math.floor(n);
}

function maybeCollectUnknown({ unknownItems, unknownLimit }, line) {
  if (!unknownItems) return;
  if (unknownItems.length >= unknownLimit) return;
  unknownItems.push(String(line));
}

function add(stats, resolution, bytes) {
  const r = resolution || 'unknown';
  if (!stats[r]) stats[r] = { bytes: 0, files: 0 };
  stats[r].bytes += bytes;
  stats[r].files += 1;
  stats.total.bytes += bytes;
  stats.total.files += 1;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

async function walkLocal(rootDir, onFile) {
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        let st;
        try {
          st = await fs.promises.stat(full);
        } catch {
          continue;
        }
        await onFile(full, st.size);
      }
    }
  }
}

async function scanLocal({ rootDir, inferUnknownBySize = false, unknownItems, unknownLimit = Infinity, unknownDetailOut = false }) {
  const stats = createStats();
  await walkLocal(rootDir, async (filePath, size) => {
    const relOrAbs = filePath;
    let res = detectResolution(relOrAbs);
    if (!res && inferUnknownBySize) {
      const inferred = inferResolutionBySize(size);
      if (unknownDetailOut) {
        maybeCollectUnknown({ unknownItems, unknownLimit }, `${relOrAbs}\t${size}\t${inferred}`);
      } else {
        maybeCollectUnknown({ unknownItems, unknownLimit }, relOrAbs);
      }
      res = inferred;
    } else if (!res) {
      maybeCollectUnknown({ unknownItems, unknownLimit }, relOrAbs);
    }
    add(stats, res, size);
  });
  return stats;
}

function ensureEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function retry(fn, times = 3) {
  let lastErr;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

function createB2S3Client() {
  const endpoint = ensureEnv('B2_S3_ENDPOINT');
  const region = ensureEnv('B2_S3_REGION');
  const accessKeyId = ensureEnv('B2_S3_ACCESS_KEY_ID');
  const secretAccessKey = ensureEnv('B2_S3_SECRET_ACCESS_KEY');

  return new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 15_000,
      requestTimeout: 120_000,
    }),
    maxAttempts: 3,
  });
}

async function scanB2({
  bucket,
  prefix = '',
  inferUnknownBySize = false,
  unknownItems,
  unknownLimit = Infinity,
  unknownDetailOut = false,
  maxFiles = Infinity,
  maxPages = Infinity,
}) {
  const stats = createStats();
  const client = createB2S3Client();

  let token;
  let page = 0;
  let processed = 0;
  do {
    page += 1;
    if (page > maxPages) break;
    const res = await retry(() =>
      client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
          MaxKeys: 1000,
        }),
      ),
    );

    const contents = res.Contents || [];
    console.log(`[B2] page=${token ? 'next' : 'first'} files=${contents.length}`);
    for (const obj of contents) {
      if (processed >= maxFiles) break;
      const key = obj.Key || '';
      const size = Number(obj.Size) || 0;
      let r = detectResolution(key);
      if (!r && inferUnknownBySize) {
        const inferred = inferResolutionBySize(size);
        if (unknownDetailOut) {
          maybeCollectUnknown({ unknownItems, unknownLimit }, `${key}\t${size}\t${inferred}`);
        } else {
          maybeCollectUnknown({ unknownItems, unknownLimit }, key);
        }
        r = inferred;
      } else if (!r) {
        maybeCollectUnknown({ unknownItems, unknownLimit }, key);
      }
      add(stats, r, size);
      processed += 1;
    }

    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token && processed < maxFiles);

  return stats;
}

async function writeUnknownList({ outPath, unknownItems }) {
  if (!outPath) return;
  if (!unknownItems || unknownItems.length === 0) {
    await fs.promises.writeFile(outPath, '', 'utf8');
    return;
  }
  const content = unknownItems.join('\n') + '\n';
  await fs.promises.writeFile(outPath, content, 'utf8');
}

async function writeList({ outPath, lines }) {
  if (!outPath) return;
  const arr = Array.isArray(lines) ? lines : [];
  const content = arr.length ? arr.join('\n') + '\n' : '';
  await fs.promises.writeFile(outPath, content, 'utf8');
}

function printMasterSummary({ folders, keepBytes, deleteBytes, totalBytes, keepCount, deleteCount }) {
  console.log(`FOLDERS\t${folders}`);
  console.log(`KEEP\t${keepCount}\t${formatBytes(keepBytes)}\t(${keepBytes} bytes)`);
  console.log(`DELETE\t${deleteCount}\t${formatBytes(deleteBytes)}\t(${deleteBytes} bytes)`);
  console.log(`TOTAL\t${keepCount + deleteCount}\t${formatBytes(totalBytes)}\t(${totalBytes} bytes)`);
  console.log(`SAVED\t-\t${formatBytes(deleteBytes)}\t(${deleteBytes} bytes)`);
}

function printMasterResolutionStats({ totalStats, keepStats, deleteStats }) {
  console.log('');
  console.log('== RESOLUTION (TOTAL) ==');
  printStats(totalStats);
  console.log('');
  console.log('== RESOLUTION (KEEP / MASTER) ==');
  printStats(keepStats);
  console.log('');
  console.log('== RESOLUTION (DELETE) ==');
  printStats(deleteStats);
}

function printStats(stats) {
  const rows = [...RESOLUTIONS, 'unknown', 'total'];
  for (const r of rows) {
    const s = stats[r] || { bytes: 0, files: 0 };
    const label = r === 'total' ? 'TOTAL' : r.toUpperCase();
    console.log(`${label}\t${s.files}\t${formatBytes(s.bytes)}\t(${s.bytes} bytes)`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const mode = String(args.mode || 'local').toLowerCase();
  const unknownOut = args['unknown-out'] ? path.resolve(String(args['unknown-out'])) : '';
  const unknownLimit = parseLimit(args['unknown-limit']);
  const unknownItems = unknownOut ? [] : null;
  const inferUnknownBySize = args['infer-unknown-by-size'] === true || String(args['infer-unknown-by-size'] || '').toLowerCase() === 'true';
  const unknownDetailOut = args['unknown-detail'] === true || String(args['unknown-detail'] || '').toLowerCase() === 'true';
  const masterReport = args['master-report'] === true || String(args['master-report'] || '').toLowerCase() === 'true';
  const masterOut = args['master-out'] ? path.resolve(String(args['master-out'])) : '';
  const deleteOut = args['delete-out'] ? path.resolve(String(args['delete-out'])) : '';
  const maxFiles = parseIntOrInfinity(args['max-files']);
  const maxPages = parseIntOrInfinity(args['max-pages']);

  if (mode === 'local') {
    const rootDir = path.resolve(String(args.root || args._[0] || '.'));

    if (masterReport) {
      const byFolder = new Map();
      await walkLocal(rootDir, async (filePath, size) => {
        const folder = getParentFolder(filePath);
        const quality = resolveQuality({ nameOrKey: filePath, size, inferUnknownBySize: true });
        const item = { name: filePath, size, quality };
        if (!byFolder.has(folder)) byFolder.set(folder, []);
        byFolder.get(folder).push(item);
      });

      let keepBytes = 0;
      let deleteBytes = 0;
      let totalBytes = 0;
      let keepCount = 0;
      let deleteCount = 0;
      const keepLines = [];
      const delLines = [];

      const totalStats = createStats();
      const keepStats = createStats();
      const deleteStats = createStats();

      for (const [folder, items] of byFolder.entries()) {
        if (!items.length) continue;
        const master = pickMaster(items);
        for (const it of items) {
          totalBytes += it.size;
          const q = it.quality || 'unknown';
          add(totalStats, q, it.size);
          if (master && it.name === master.name) {
            keepBytes += it.size;
            keepCount += 1;
            add(keepStats, q, it.size);
            keepLines.push(`${folder}\t${it.name}\t${it.size}\t${q}\tMASTER\t1\t0`);
          } else {
            deleteBytes += it.size;
            deleteCount += 1;
            add(deleteStats, q, it.size);
            delLines.push(`${folder}\t${it.name}\t${it.size}\t${q}\t-\t0\t0`);
          }
        }
      }

      printMasterSummary({
        folders: byFolder.size,
        keepBytes,
        deleteBytes,
        totalBytes,
        keepCount,
        deleteCount,
      });
      printMasterResolutionStats({ totalStats, keepStats, deleteStats });
      await writeList({ outPath: masterOut, lines: keepLines });
      await writeList({ outPath: deleteOut, lines: delLines });
      return;
    }

    const stats = await scanLocal({ rootDir, inferUnknownBySize, unknownItems, unknownLimit, unknownDetailOut });
    printStats(stats);
    await writeUnknownList({ outPath: unknownOut, unknownItems });
    return;
  }

  if (mode === 'b2') {
    const bucket = String(args.bucket || process.env.B2_BUCKET_NAME || '').trim();
    if (!bucket) throw new Error('Missing --bucket or B2_BUCKET_NAME');
    const prefix = String(args.prefix || '').trim();

    if (masterReport) {
      const client = createB2S3Client();
      const byFolder = new Map();
      let token;
      let page = 0;
      let processed = 0;
      do {
        page += 1;
        if (page > maxPages) break;
        const res = await retry(() =>
          client.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: prefix,
              ContinuationToken: token,
              MaxKeys: 1000,
            }),
          ),
        );
        const contents = res.Contents || [];
        console.log(`[B2] page=${token ? 'next' : 'first'} files=${contents.length}`);
        for (const obj of contents) {
          if (processed >= maxFiles) break;
          const key = obj.Key || '';
          const size = Number(obj.Size) || 0;
          const folder = getParentFolder(key);
          const quality = resolveQuality({ nameOrKey: key, size, inferUnknownBySize: true });
          const item = { name: key, size, quality };
          if (!byFolder.has(folder)) byFolder.set(folder, []);
          byFolder.get(folder).push(item);
          processed += 1;
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token && processed < maxFiles);

      let keepBytes = 0;
      let deleteBytes = 0;
      let totalBytes = 0;
      let keepCount = 0;
      let deleteCount = 0;
      const keepLines = [];
      const delLines = [];

      const totalStats = createStats();
      const keepStats = createStats();
      const deleteStats = createStats();

      for (const [folder, items] of byFolder.entries()) {
        if (!items.length) continue;
        const master = pickMaster(items);
        for (const it of items) {
          totalBytes += it.size;
          const q = it.quality || 'unknown';
          add(totalStats, q, it.size);
          if (master && it.name === master.name) {
            keepBytes += it.size;
            keepCount += 1;
            add(keepStats, q, it.size);
            keepLines.push(`${folder}\t${it.name}\t${it.size}\t${q}\tMASTER\t1\t0`);
          } else {
            deleteBytes += it.size;
            deleteCount += 1;
            add(deleteStats, q, it.size);
            delLines.push(`${folder}\t${it.name}\t${it.size}\t${q}\t-\t0\t0`);
          }
        }
      }

      printMasterSummary({
        folders: byFolder.size,
        keepBytes,
        deleteBytes,
        totalBytes,
        keepCount,
        deleteCount,
      });
      printMasterResolutionStats({ totalStats, keepStats, deleteStats });
      await writeList({ outPath: masterOut, lines: keepLines });
      await writeList({ outPath: deleteOut, lines: delLines });
      return;
    }

    const stats = await scanB2({ bucket, prefix, inferUnknownBySize, unknownItems, unknownLimit, unknownDetailOut, maxFiles, maxPages });
    printStats(stats);
    await writeUnknownList({ outPath: unknownOut, unknownItems });
    return;
  }

  throw new Error(`Unknown mode: ${mode}. Use --mode local|b2`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
