import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import { uploadFromStream } from '../lib/b2.js';
import { upsertFolder, getFolderByPrefix, upsertFile } from '../lib/storageCatalogDb.js';
import { setProgress, getProgress } from '../utils/uploadProgress.js';

function checkBinary(binPath, args = ['-version'], timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      const p = spawn(binPath, args);
      const to = setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {}
        resolve(false);
      }, timeoutMs);
      p.on('close', () => {
        clearTimeout(to);
        resolve(true);
      });
      p.on('error', () => {
        clearTimeout(to);
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

function startUploadProgressLogger({ request, label, totalBytes }) {
  const log = request?.log;
  const total = Number(totalBytes);
  const hasTotal = Number.isFinite(total) && total > 0;

  let uploaded = 0;
  let lastLogAt = 0;
  let lastPct = -1;
  const startedAt = Date.now();
  const intervalMs = 3000;

  const passthrough = new PassThrough();
  passthrough.on('data', (chunk) => {
    uploaded += chunk?.length || 0;
    const now = Date.now();
    const pct = hasTotal ? Math.floor((uploaded / total) * 100) : null;
    const shouldLog = now - lastLogAt >= intervalMs || (pct != null && pct !== lastPct && pct % 5 === 0);
    if (!shouldLog) return;
    lastLogAt = now;
    if (pct != null) lastPct = pct;
    const elapsedSec = Math.max(1, Math.round((now - startedAt) / 1000));
    const rate = Math.round(uploaded / elapsedSec);
    try {
      log?.info(
        {
          label,
          uploadedBytes: uploaded,
          totalBytes: hasTotal ? total : null,
          percent: pct,
          bytesPerSec: rate,
          elapsedSec,
        },
        'Upload progress',
      );
    } catch {
      // ignore
    }
  });

  let finished = false;
  const onAborted = () => {
    if (finished) return;
    // Node sets req.aborted=true only when the client aborts before request is fully received.
    const aborted = request?.raw?.aborted === true;
    if (!aborted) return;
    try {
      log?.warn({ label, uploadedBytes: uploaded }, 'Upload aborted by client');
    } catch {
      // ignore
    }
    try {
      passthrough.destroy(new Error('Client aborted upload'));
    } catch {
      // ignore
    }
  };
  request?.raw?.on('aborted', onAborted);

  const cleanup = () => {
    finished = true;
    try {
      request?.raw?.off('aborted', onAborted);
    } catch {
      // ignore
    }
  };

  return { passthrough, getUploadedBytes: () => uploaded, cleanup };
}

async function ensureFolderHierarchy(prefix) {
  const cleaned = String(prefix || '')
    .replace(/^\/+|\/+$/g, '')
    .trim();
  if (!cleaned) {
    return null;
  }

  const parts = cleaned
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);

  let currentPrefix = '';
  let parentId = null;

  for (const part of parts) {
    currentPrefix = currentPrefix ? `${currentPrefix}${part}/` : `${part}/`;

    let existing = getFolderByPrefix(currentPrefix);
    if (!existing) {
      upsertFolder({
        name: part,
        prefix: currentPrefix,
        parentId,
        fileCount: null,
      });
      existing = getFolderByPrefix(currentPrefix);
    }

    parentId = existing?.id ?? parentId;
  }

  return parentId;
}

async function getFfprobePath() {
  const envPath = process.env.FFPROBE_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  try {
    const mod = await import('ffprobe-static');
    const p = mod?.path || mod?.default?.path || mod?.default;
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return 'ffprobe';
}

function parseDurationToSec(str) {
  const m = /([0-9]{1,3}):([0-9]{1,2}):([0-9]{1,2}(?:\.[0-9]+)?)/.exec(String(str) || '');
  if (!m) return NaN;
  const hh = parseInt(m[1], 10) || 0;
  const mm = parseInt(m[2], 10) || 0;
  const ss = parseFloat(m[3] || '0');
  return hh * 3600 + mm * 60 + ss;
}

async function probeDurationSec(inputPath, ffmpegPath, ffprobePath) {
  if (ffprobePath) {
    const val = await new Promise((resolve) => {
      const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath];
      const p = spawn(ffprobePath, args);
      let out = '';
      p.stdout.on('data', (d) => {
        out += d.toString();
      });
      p.on('close', () => {
        const num = parseFloat((out || '').trim());
        if (Number.isFinite(num) && num > 0) resolve(num);
        else resolve(NaN);
      });
      p.on('error', () => resolve(NaN));
    });
    if (Number.isFinite(val) && val > 0) return val;
  }
  return await new Promise((resolve) => {
    try {
      const p = spawn(ffmpegPath, ['-hide_banner', '-i', inputPath, '-f', 'null', '-']);
      let err = '';
      p.stderr.on('data', (d) => {
        err += d.toString();
      });
      p.on('close', () => {
        const dm = /Duration:\s*([0-9:.]+)\s*,/.exec(err);
        const sec = dm ? parseDurationToSec(dm[1]) : NaN;
        resolve(Number.isFinite(sec) && sec > 0 ? sec : NaN);
      });
      p.on('error', () => resolve(NaN));
    } catch {
      resolve(NaN);
    }
  });
}

async function getFfmpegPath() {
  const envPath = process.env.FFMPEG_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  try {
    const mod = await import('ffmpeg-static');
    const p = mod?.default;
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return 'ffmpeg';
}

function runFfmpeg(ffmpegPath, args, onTime) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let stderr = '';
    p.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onTime) {
        const m = s.match(/time=([0-9:.]+)/);
        if (m && m[1]) {
          const t = m[1];
          const parts = t.split(':');
          let sec = 0;
          if (parts.length === 3) {
            const [hh, mm, ss] = parts;
            sec = (parseInt(hh, 10) || 0) * 3600 + (parseInt(mm, 10) || 0) * 60 + parseFloat(ss || '0');
          } else if (parts.length === 2) {
            const [mm, ss] = parts;
            sec = (parseInt(mm, 10) || 0) * 60 + parseFloat(ss || '0');
          } else if (parts.length === 1) {
            sec = parseFloat(parts[0] || '0');
          }
          if (!Number.isNaN(sec)) onTime(sec);
        }
      }
    });
    p.on('close', (code) => {
      if (code === 0) return resolve();
      const err = new Error(`ffmpeg exited with code ${code}: ${stderr.slice(0, 4000)}`);
      reject(err);
    });
    p.on('error', (e) => reject(e));
  });
}

export async function uploadDriveController(request, reply) {
  try {
    const filePart = await request.file();
    if (!filePart) {
      return reply.code(400).send({ error: 'No file provided' });
    }

    const fields = filePart.fields || {};
    const folderId = (fields.folderId && fields.folderId.value) || 'root';
    const relativePath = (fields.relativePath && fields.relativePath.value) || '';
    const encodeField = fields.encode && fields.encode.value;
    const wantEncode = (() => {
      const v = (encodeField == null ? '1' : String(encodeField)).toLowerCase();
      return !(v === '0' || v === 'false' || v === 'no');
    })();

    const fileName = filePart.filename;
    const fileType = filePart.mimetype || 'application/octet-stream';
    const fileStream = filePart.file; // Node.js Readable
    const declaredSize = Number(filePart?.fields?.fileSize?.value ?? filePart?.fields?.size?.value ?? NaN);

    const isVideo = (() => {
      const t = (fileType || '').toLowerCase();
      if (t.startsWith('video/')) return true;
      const n = (fileName || '').toLowerCase();
      return /\.(mp4|mkv|mov|webm|avi|m4v)$/i.test(n);
    })();

    const prefixParts = [];
    if (folderId && folderId !== 'root') prefixParts.push(String(folderId));
    if (relativePath) prefixParts.push(String(relativePath));
    const basePrefix = prefixParts
      .join('/')
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean)
      .join('/');
    const buildKey = (name) => (basePrefix ? `${basePrefix}/${name}` : name);

    if (!isVideo || !wantEncode) {
      const objectKey = buildKey(fileName);
      const logger = startUploadProgressLogger({ request, label: `drive-upload:${objectKey}`, totalBytes: declaredSize });
      fileStream.pipe(logger.passthrough);
      try {
        await uploadFromStream({ fileName: objectKey, stream: logger.passthrough, contentType: fileType, expectedSizeBytes: declaredSize });
        try {
          request.log.info({ objectKey, uploadedBytes: logger.getUploadedBytes() }, 'Drive upload finished');
        } catch {
          // ignore
        }
      } finally {
        logger.cleanup();
      }
      const fileData = { id: objectKey, name: fileName };
      return reply
        .headers({
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        })
        .send({ files: [fileData] });
    }

    const jobId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    setProgress(jobId, { status: 'preparing', current: null, done: 0, total: 4, percent: 0 });

    (async () => {
      const created = [];
      // tmpDir dideklarasikan di sini agar bisa dibersihkan di blok finally
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-'));
      try {
        const inputExt = path.extname(fileName || '') || '.dat';
        const inputPath = path.join(tmpDir, `input${inputExt}`);

        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(inputPath);
          fileStream.pipe(ws);
          ws.on('finish', resolve);
          ws.on('error', reject);
          fileStream.on('error', reject);
        });

        const baseName = (() => {
          const n = fileName || 'video';
          const ext = path.extname(n);
          return ext ? n.slice(0, -ext.length) : n;
        })();

        const ffmpegPath = await getFfmpegPath();
        const ffmpegOk = await checkBinary(ffmpegPath);
        if (!ffmpegOk) {
          setProgress(jobId, {
            status: 'error',
            error: `ffmpeg not found or not executable at ${ffmpegPath}. Install system ffmpeg or set FFMPEG_PATH/.env, or install ffmpeg-static.`,
          });
          return;
        }

        const ffprobePath = await getFfprobePath();
        const ffprobeOk = await checkBinary(ffprobePath);
        const renditions = [
          { width: 1920, height: 1080 },
          { width: 1280, height: 720 },
          { width: 854, height: 480 },
          { width: 640, height: 360 },
        ];
        const outputs = renditions.map((r) => ({
          width: r.width,
          height: r.height,
          outPath: path.join(tmpDir, `${baseName}_${r.height}p.mp4`),
          outName: `${baseName}_${r.height}p.mp4`,
        }));

        const total = outputs.length;
        setProgress(jobId, { status: 'encoding', current: `${outputs[0].height}p`, done: 0, total, percent: 0 });
        const duration = await probeDurationSec(inputPath, ffmpegPath, ffprobeOk ? ffprobePath : null);

        for (let i = 0; i < outputs.length; i++) {
          const t = outputs[i];
          setProgress(jobId, {
            status: 'encoding',
            current: `${t.height}p`,
            done: i,
            total,
            percent: Math.round((i / total) * 100),
          });
          const vf = [
            `scale=${t.width}:${t.height}:force_original_aspect_ratio=decrease`,
            `pad=${t.width}:${t.height}:(ow-iw)/2:(oh-ih)/2:black`,
          ].join(',');
          const args = [
            '-y',
            '-i',
            inputPath,
            '-vf',
            vf,
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '23',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-movflags',
            '+faststart',
            t.outPath,
          ];
          let lastTime = 0;
          await runFfmpeg(ffmpegPath, args, (sec) => {
            lastTime = sec;
            if (Number.isFinite(duration) && duration > 0) {
              const frac = Math.max(0, Math.min(1, sec / duration));
              const overall = ((i + frac) / total) * 100;
              const pct = Math.max(0, Math.min(99, Math.round(overall)));
              setProgress(jobId, {
                status: 'encoding',
                current: `${t.height}p`,
                done: i,
                total,
                percent: pct,
              });
            }
          });

          const frac = Number.isFinite(duration) && duration > 0 ? Math.min(1, lastTime / duration) : 1;
          const pct = Math.round(((i + frac) / total) * 100);
          setProgress(jobId, {
            status: 'uploading',
            current: `${t.height}p`,
            done: i,
            total,
            percent: pct,
          });

          const stream = fs.createReadStream(t.outPath);
          const objectKey = buildKey(t.outName);
          await uploadFromStream({ fileName: objectKey, stream, contentType: 'video/mp4' });
          created.push({ id: objectKey, name: t.outName });
          const afterPct = Math.round(((i + 1) / total) * 100);
          setProgress(jobId, {
            status: 'progress',
            current: `${t.height}p`,
            done: i + 1,
            total,
            percent: afterPct,
          });
        }

        setProgress(jobId, { status: 'done', done: total, total, files: created, percent: 100 });
      } catch (e) {
        setProgress(jobId, { status: 'error', error: e?.message || 'Encoding failed' });
      } finally {
        try {
          if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        } catch {
          // abaikan error cleanup
        }
      }
    })();

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ jobId, status: 'started' });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
        code: err?.code,
        name: err?.name,
        response: err?.response?.data,
        status: err?.response?.status,
      },
      'Drive upload error',
    );
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Failed to upload file', details: err?.message });
  }
}

export async function uploadB2AndCatalogController(request, reply) {
  try {
    const files = [];
    const errors = [];

    let sawAnyFilePart = false;

    let prefixCleaned = '';
    let sizeFromField = NaN;

    const parts = request.parts();
    for await (const part of parts) {
      if (part?.type === 'field') {
        if (part.fieldname === 'prefix') {
          prefixCleaned = String(part.value || '')
            .split('/')
            .map((p) => p.trim())
            .filter(Boolean)
            .join('/');
        }
        if (part.fieldname === 'fileSize' || part.fieldname === 'size') {
          const n = Number(part.value);
          if (Number.isFinite(n) && n > 0) sizeFromField = n;
        }
        continue;
      }

      sawAnyFilePart = true;
      const fileName = part.filename;
      const fileType = part.mimetype || 'application/octet-stream';
      const fileStream = part.file;

      if (!fileName || !fileStream) {
        errors.push({ fileName: fileName || null, error: 'Malformed file part (missing filename or stream)' });
        continue;
      }

      // Hanya izinkan upload video (berdasarkan mimetype dan ekstensi file)
      const lowerMime = String(fileType).toLowerCase();
      const videoExt = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'];
      const ext = (fileName.lastIndexOf('.') !== -1 ? fileName.slice(fileName.lastIndexOf('.')) : '').toLowerCase();
      const isVideo = lowerMime.startsWith('video/') || videoExt.includes(ext);

      if (!isVideo) {
        errors.push({ fileName, error: 'Only video files are allowed for this endpoint' });
        continue;
      }

      const objectKey = prefixCleaned ? `${prefixCleaned}/${fileName}` : fileName;
      const declaredSize = Number(part?.fields?.fileSize?.value ?? part?.fields?.size?.value ?? sizeFromField ?? NaN);

      try {
        const logger = startUploadProgressLogger({ request, label: `b2-upload:${objectKey}`, totalBytes: declaredSize });
        fileStream.pipe(logger.passthrough);
        let uploadRes;
        try {
          uploadRes = await uploadFromStream({ fileName: objectKey, stream: logger.passthrough, contentType: fileType, expectedSizeBytes: declaredSize });
          try {
            request.log.info({ objectKey, uploadedBytes: logger.getUploadedBytes() }, 'B2 upload finished');
          } catch {
            // ignore
          }
        } finally {
          logger.cleanup();
        }

        const keyParts = String(objectKey)
          .split('/')
          .map((p) => p.trim())
          .filter(Boolean);

        const baseName = keyParts[keyParts.length - 1];
        const folderPrefix = keyParts.length > 1 ? `${keyParts.slice(0, -1).join('/')}/` : '';
        const folderId = await ensureFolderHierarchy(folderPrefix);

        const size = Number(uploadRes?.contentLength) || 0;
        const uploadedAt = uploadRes?.uploadTimestamp ? new Date(uploadRes.uploadTimestamp).toISOString() : undefined;
        const contentType = uploadRes?.contentType || fileType || 'application/octet-stream';

        upsertFile({
          folderId,
          fileName: baseName,
          filePath: objectKey,
          size,
          contentType,
          uploadedAt,
        });

        files.push({
          id: objectKey,
          name: baseName,
          mimeType: contentType,
          size,
          modifiedTime: uploadedAt || null,
        });
      } catch (e) {
        const status = e?.status || e?.response?.status || e?.response?.data?.status;
        const code = e?.code || e?.response?.data?.code;
        const message = e?.response?.data?.message || e?.message || 'Upload failed';
        errors.push({ fileName, objectKey, error: message, status: status ?? null, code: code ?? null });
      }
    }

    if (!sawAnyFilePart) {
      try {
        request.log.warn(
          {
            contentType: request?.headers?.['content-type'],
            contentLength: request?.headers?.['content-length'],
          },
          'No file parts detected in multipart request',
        );
      } catch {
        // ignore
      }
      return reply.code(400).send({
        error: 'No files uploaded',
        details: 'Request did not contain any file parts. Ensure you send multipart/form-data with at least one file field.',
      });
    }

    if (files.length === 0 && errors.length) {
      return reply.code(400).send({ error: 'No valid files uploaded', errors });
    }

    if (files.length === 0) {
      return reply.code(400).send({ error: 'No files uploaded' });
    }

    const statusCode = errors.length ? 207 : 200;
    return reply
      .code(statusCode)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ files, errors: errors.length ? errors : undefined });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
        code: err?.code,
        name: err?.name,
        response: err?.response?.data,
        status: err?.response?.status,
      },
      'B2 upload error',
    );
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Failed to upload file to B2', details: err?.message });
  }
}

export async function uploadProgressDriveController(request, reply) {
  const id = request.query?.id;
  if (!id) {
    return reply.code(400).send({ error: 'Missing id' });
  }
  const prog = getProgress(id);
  if (!prog) {
    return reply
      .headers({ 'Cache-Control': 'no-store' })
      .send({ status: 'unknown' });
  }
  return reply
    .headers({ 'Cache-Control': 'no-store' })
    .send(prog);
}
