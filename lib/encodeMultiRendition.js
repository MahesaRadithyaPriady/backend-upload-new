import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');

export const RENDITIONS = [
  { label: '1080p', height: 1080, width: 1920, videoBitrate: '3000k', audioBitrate: '192k', maxrate: '3500k', bufsize: '6000k' },
  { label: '720p',  height: 720,  width: 1280, videoBitrate: '1800k', audioBitrate: '128k', maxrate: '2200k', bufsize: '3600k' },
  { label: '480p',  height: 480,  width: 854,  videoBitrate: '1000k', audioBitrate: '128k', maxrate: '1300k', bufsize: '2000k' },
  { label: '360p',  height: 360,  width: 640,  videoBitrate: '500k',  audioBitrate: '96k',  maxrate: '700k',  bufsize: '1000k' },
];

export const SEGMENT_DURATION = 6;

function getTempRoot() {
  const env = process.env.ENCODE_TEMP_DIR;
  if (env) return env;
  return path.join(PROJECT_ROOT, 'temp');
}

export async function getFfmpegPath() {
  const envPath = process.env.FFMPEG_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  try {
    const mod = await import('ffmpeg-static');
    const p = mod?.default;
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return 'ffmpeg';
}

export async function getFfprobePath() {
  const envPath = process.env.FFPROBE_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  try {
    const mod = await import('ffprobe-static');
    const p = mod?.path || mod?.default?.path || mod?.default;
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return 'ffprobe';
}

export async function checkNvenc(ffmpegPath) {
  return new Promise((resolve) => {
    try {
      const p = spawn(ffmpegPath, ['-hide_banner', '-encoders']);
      let out = '';
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.stderr.on('data', (d) => { out += d.toString(); });
      p.on('close', () => resolve(out.includes('h264_nvenc')));
      p.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

export async function probeDuration(inputPath, ffmpegPath, ffprobePath) {
  if (ffprobePath) {
    const val = await new Promise((resolve) => {
      const args = [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        inputPath,
      ];
      const p = spawn(ffprobePath, args);
      let out = '';
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.on('close', () => {
        const n = parseFloat((out || '').trim());
        resolve(Number.isFinite(n) && n > 0 ? n : NaN);
      });
      p.on('error', () => resolve(NaN));
    });
    if (Number.isFinite(val) && val > 0) return val;
  }
  return new Promise((resolve) => {
    try {
      const p = spawn(ffmpegPath, ['-hide_banner', '-i', inputPath, '-f', 'null', '-']);
      let err = '';
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('close', () => {
        const m = /Duration:\s*([0-9:.]+)/i.exec(err);
        if (!m) return resolve(NaN);
        const parts = m[1].split(':');
        const sec = (parseInt(parts[0]) * 3600) + (parseInt(parts[1]) * 60) + parseFloat(parts[2]);
        resolve(Number.isFinite(sec) && sec > 0 ? sec : NaN);
      });
      p.on('error', () => resolve(NaN));
    } catch {
      resolve(NaN);
    }
  });
}

function parseFfmpegTime(line) {
  const m = /time=([0-9]{1,3}:[0-9]{1,2}:[0-9]{1,2}(?:\.[0-9]+)?)/i.exec(line);
  if (!m) return NaN;
  const parts = m[1].split(':');
  return (parseInt(parts[0]) * 3600) + (parseInt(parts[1]) * 60) + parseFloat(parts[2]);
}

function toFfmpegPath(p) {
  return p.replace(/\\/g, '/');
}

function buildNvencArgs({ inputPath, outDir, rendition, segmentDuration, useNvenc, jobId }) {
  const { label, height, width, videoBitrate, audioBitrate, maxrate, bufsize } = rendition;

  const stem = `${label}`;
  const initFile = `${stem}_init.mp4`;
  const segPattern = toFfmpegPath(path.join(outDir, `${stem}_%05d.m4s`));
  const playlistPath = toFfmpegPath(path.join(outDir, `${label}.m3u8`));
  const inputPathFwd = toFfmpegPath(inputPath);

  const vf = `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;

  const videoCodecArgs = useNvenc
    ? [
        '-c:v', 'h264_nvenc',
        '-preset', 'p4',
        '-tune', 'hq',
        '-rc', 'vbr_hq',
        '-cq', '19',
        '-b:v', videoBitrate,
        '-maxrate', maxrate,
        '-bufsize', bufsize,
        '-profile:v', 'high',
        '-level', '4.2',
        '-spatial_aq', '1',
        '-temporal_aq', '1',
        '-gpu', '0',
      ]
    : [
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-b:v', videoBitrate,
        '-maxrate', maxrate,
        '-bufsize', bufsize,
        '-profile:v', 'high',
        '-level', '4.2',
      ];

  const gopSize = segmentDuration * 30;

  const gopArgs = [
    '-g', String(gopSize),
    '-keyint_min', String(gopSize),
    '-sc_threshold', '0',
  ];

  return {
    args: [
      '-y',
      '-i', inputPathFwd,
      '-vf', vf,
      ...videoCodecArgs,
      ...gopArgs,
      '-vsync', '1',
      '-c:a', 'aac',
      '-b:a', audioBitrate,
      '-ar', '48000',
      '-ac', '2',
      '-async', '1',
      '-af', 'aresample=async=1',
      '-f', 'hls',
      '-hls_time', String(segmentDuration),
      '-hls_list_size', '0',
      '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', initFile,
      '-hls_segment_filename', segPattern,
      '-hls_flags', 'independent_segments',
      '-hls_playlist_type', 'vod',
      playlistPath,
    ],
    playlistPath: path.join(outDir, `${label}.m3u8`),
    initFile,
    segPattern,
    label,
    stem,
  };
}

function runFfmpegProcess(ffmpegPath, args, { jobId, abortSignal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn(ffmpegPath, args);
    } catch (e) {
      return reject(e);
    }

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        try { p.kill('SIGKILL'); } catch {}
      });
    }

    let stderr = '';
    p.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (typeof onProgress === 'function') {
        const sec = parseFfmpegTime(s);
        if (Number.isFinite(sec) && sec > 0) {
          try { onProgress(sec); } catch {}
        }
      }
    });

    p.on('close', (code) => {
      if (code === 0 || code == null) return resolve();
      return reject(new Error(`ffmpeg exited with code ${code}.\n${stderr.slice(-2000)}`));
    });

    p.on('error', (e) => reject(new Error(`ffmpeg spawn error: ${e.message}`)));
  });
}

function toBasename(filePath) {
  return filePath.replace(/\\/g, '/').split('/').pop();
}

function rewriteRenditionPlaylist(playlistPath, label) {
  const text = fs.readFileSync(playlistPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    const mapMatch = /^#EXT-X-MAP:(.*)URI="([^"]+)"(.*)$/i.exec(trimmed);
    if (mapMatch) {
      const base = toBasename(mapMatch[2]);
      return `#EXT-X-MAP:${mapMatch[1]}URI="${base}"${mapMatch[3]}`;
    }
    if (trimmed.startsWith('#')) return line;
    return toBasename(trimmed);
  });
  fs.writeFileSync(playlistPath, rewritten.join('\n'));
}

function buildMasterPlaylist({ renditions, outputStructure }) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', ''];
  for (const r of renditions) {
    if (!outputStructure[r.label]?.success) continue;
    const bw = parseInt(r.videoBitrate) * 1000;
    const abw = parseInt(r.audioBitrate) * 1000;
    const totalBw = bw + abw;
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${totalBw},RESOLUTION=${r.width}x${r.height},CODECS="avc1.640028,mp4a.40.2",NAME="${r.label}"`);
    lines.push(`${r.label}/${r.label}.m3u8`);
    lines.push('');
  }
  return lines.join('\n');
}

export function buildOutputDir({ objectKey, tempRoot }) {
  const root = tempRoot || getTempRoot();
  const cleaned = String(objectKey || '').replace(/^\/+/, '');
  const ext = path.extname(cleaned);
  const baseNoExt = ext ? cleaned.slice(0, -ext.length) : cleaned;
  const parentDir = path.posix.dirname(baseNoExt);
  const leafName = path.posix.basename(baseNoExt);

  const outBase = parentDir && parentDir !== '.' ? path.join(root, parentDir, leafName) : path.join(root, leafName);
  return { outBase, parentDir, leafName };
}

export async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function encodeMultiRendition({
  inputPath,
  objectKey,
  tempRoot,
  renditions: customRenditions,
  segmentDuration = SEGMENT_DURATION,
  concurrency,
  abortSignal,
  onRenditionStart,
  onRenditionProgress,
  onRenditionDone,
  onMasterDone,
}) {
  const rList = customRenditions || RENDITIONS;

  const ffmpegPath = await getFfmpegPath();
  const ffprobePath = await getFfprobePath();
  const useNvenc = await checkNvenc(ffmpegPath);

  const encodeConcurrency = concurrency ?? (() => {
    const n = parseInt(process.env.ENCODE_CONCURRENCY || '2', 10);
    return Number.isFinite(n) && n > 0 ? n : 2;
  })();

  const { outBase } = buildOutputDir({ objectKey, tempRoot });

  const outputStructure = {};
  const errors = [];

  fs.mkdirSync(outBase, { recursive: true });

  const duration = await probeDuration(inputPath, ffmpegPath, ffprobePath);

  const encodeTasks = rList.map((rendition) => async () => {
    const { label } = rendition;
    const rendOutDir = path.join(outBase, label);
    fs.mkdirSync(rendOutDir, { recursive: true });

    const { args, playlistPath, initFile } = buildNvencArgs({
      inputPath,
      outDir: rendOutDir,
      rendition,
      segmentDuration,
      useNvenc,
    });

    try {
      onRenditionStart?.({ label, outDir: rendOutDir, useNvenc });

      console.log(`[encode:${label}] ffmpeg args:`, [ffmpegPath, ...args].join(' '));

      await runFfmpegProcess(ffmpegPath, args, {
        abortSignal,
        onProgress: (sec) => {
          const pct = Number.isFinite(duration) && duration > 0
            ? Math.min(99, Math.round((sec / duration) * 100))
            : null;
          onRenditionProgress?.({ label, sec, pct, duration });
        },
      });

      rewriteRenditionPlaylist(playlistPath, label);

      const allFiles = fs.readdirSync(rendOutDir);
      const segments = allFiles.filter((f) => f.endsWith('.m4s'));
      const initFilePath = path.join(rendOutDir, initFile);
      const initExists = fs.existsSync(initFilePath);

      console.log(`[encode:${label}] outDir=${rendOutDir}`);
      console.log(`[encode:${label}] files after encode:`, allFiles);
      console.log(`[encode:${label}] initFile expected: ${initFile}, exists: ${initExists}`);
      console.log(`[encode:${label}] segments: ${segments.length}`);

      if (!initExists) {
        throw new Error(`Init segment missing: ${initFile}. Files found: [${allFiles.join(', ')}]`);
      }
      if (segments.length === 0) {
        throw new Error(`No .m4s segments produced for ${label}. Files found: [${allFiles.join(', ')}]`);
      }

      outputStructure[label] = {
        success: true,
        dir: rendOutDir,
        playlistPath,
        initFile: initFilePath,
        segments: segments.map((s) => path.join(rendOutDir, s)),
        segmentCount: segments.length,
      };

      onRenditionDone?.({ label, success: true, segmentCount: segments.length });
    } catch (err) {
      outputStructure[label] = { success: false, error: err.message };
      errors.push({ label, error: err.message });
      onRenditionDone?.({ label, success: false, error: err.message });
    }
  });

  await runWithConcurrency(encodeTasks, encodeConcurrency);

  const masterPlaylistPath = path.join(outBase, 'master.m3u8');
  const masterContent = buildMasterPlaylist({ renditions: rList, outputStructure });
  fs.writeFileSync(masterPlaylistPath, masterContent);
  onMasterDone?.({ masterPlaylistPath });

  return {
    outBase,
    masterPlaylistPath,
    outputStructure,
    errors,
    useNvenc,
    duration: Number.isFinite(duration) ? duration : null,
    b2UploadPlan: buildB2UploadPlan({ objectKey, outBase, rList, outputStructure }),
  };
}

export function buildB2UploadPlan({ objectKey, outBase, rList, outputStructure }) {
  const cleaned = String(objectKey || '').replace(/^\/+/, '');
  const ext = path.extname(cleaned);
  const baseNoExt = ext ? cleaned.slice(0, -ext.length) : cleaned;
  const parentDir = path.posix.dirname(baseNoExt);
  const b2Base = parentDir && parentDir !== '.' ? `${parentDir}/` : '';

  const plan = [];

  plan.push({
    localPath: path.join(outBase, 'master.m3u8'),
    b2Key: `${b2Base}master.m3u8`,
    contentType: 'application/vnd.apple.mpegurl',
    role: 'master_playlist',
  });

  for (const [label, info] of Object.entries(outputStructure)) {
    if (!info.success) continue;
    const rendDir = info.dir;
    const files = fs.readdirSync(rendDir);
    for (const f of files) {
      const localPath = path.join(rendDir, f);
      const b2Key = `${b2Base}${label}/${f}`;
      const contentType = f.endsWith('.m3u8')
        ? 'application/vnd.apple.mpegurl'
        : f.endsWith('.m4s')
          ? 'video/iso.segment'
          : f.endsWith('.mp4')
            ? 'video/mp4'
            : 'application/octet-stream';
      plan.push({ localPath, b2Key, contentType, role: f.endsWith('.m3u8') ? 'rendition_playlist' : 'segment' });
    }
  }

  return plan;
}
