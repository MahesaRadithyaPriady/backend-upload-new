import 'dotenv/config';
import { google } from 'googleapis';
import B2 from 'backblaze-b2';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { upsertFileMapping, getFileMapping } from '../lib/fileMappingDb.js';

// --- Konfigurasi dasar ---
const SERVICE_ACCOUNT_KEY_FILE = new URL('../config/nanimeid-2f819a5dcf5f.json', import.meta.url).pathname;

const B2_APPLICATION_KEY_ID = process.env.B2_APPLICATION_KEY_ID;
const B2_APPLICATION_KEY = process.env.B2_APPLICATION_KEY;
const B2_BUCKET_ID = process.env.B2_BUCKET_ID;
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME; // opsional kalau kamu lebih suka pakai nama

if (!B2_APPLICATION_KEY_ID || !B2_APPLICATION_KEY || (!B2_BUCKET_ID && !B2_BUCKET_NAME)) {
  console.error('[MIGRATE] Missing B2 env vars. Need B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY and B2_BUCKET_ID or B2_BUCKET_NAME');
  process.exit(1);
}

// --- Helper untuk parse argumen CLI sederhana ---
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (const a of args) {
    const [k, v] = a.split('=');
    if (!k || v === undefined) continue;
    const key = k.replace(/^--?/, '');
    out[key] = v;
  }
  return out;
}

// --- Inisialisasi Google Drive dengan service account ---
async function createDriveClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const authClient = await auth.getClient();
  return google.drive({ version: 'v3', auth: authClient });
}

// --- Inisialisasi Backblaze B2 ---
async function createB2Client() {
  const b2 = new B2({
    applicationKeyId: B2_APPLICATION_KEY_ID,
    applicationKey: B2_APPLICATION_KEY,
  });
  await b2.authorize();

  let bucketId = B2_BUCKET_ID;
  if (!bucketId && B2_BUCKET_NAME) {
    const { data } = await b2.listBuckets({});
    const bucket = (data.buckets || []).find((b) => b.bucketName === B2_BUCKET_NAME);
    if (!bucket) {
      throw new Error(`Bucket with name ${B2_BUCKET_NAME} not found in B2`);
    }
    bucketId = bucket.bucketId;
  }

  if (!bucketId) {
    throw new Error('No B2 bucketId available');
  }

  return { b2, bucketId };
}

// --- Upload satu file besar ke B2 dengan multipart (streaming + temp file + parallel parts) ---
const PART_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_CONCURRENT_PARTS = 3; // parallel upload parts

async function uploadMultipartFromDriveStream({
  b2,
  bucketId,
  fileNameInB2,
  driveStream,
  contentType,
  totalBytes,
}) {
  const startLarge = await b2.startLargeFile({
    bucketId,
    fileName: fileNameInB2,
    contentType: contentType || 'application/octet-stream',
  });
  const fileId = startLarge.data.fileId;

  // Pre-fetch upload part URLs (pool)
  const partUrlPool = [];
  for (let i = 0; i < MAX_CONCURRENT_PARTS; i++) {
    const { data: up } = await b2.getUploadPartUrl({ fileId });
    partUrlPool.push(up);
  }

  // Stream dari Drive ke file temp di disk (untuk menghindari Buffer.concat mahal)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-'));
  const tempFilePath = path.join(tmpDir, path.basename(fileNameInB2));
  const writeStream = fs.createWriteStream(tempFilePath);
  for await (const chunk of driveStream) {
    writeStream.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  writeStream.end();

  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  // Baca file temp per chunk dan upload part secara paralel
  const fd = fs.openSync(tempFilePath, 'r');
  const stat = fs.statSync(tempFilePath);
  const fileSize = stat.size;
  const sha1Map = new Map(); // partNumber -> sha1
  let partNumber = 1;
  const concurrencyLimit = MAX_CONCURRENT_PARTS;
  const activeUploads = [];

  const uploadPart = async (partBuffer, partNum, uploadUrlInfo) => {
    const sha1 = crypto.createHash('sha1').update(partBuffer).digest('hex');
    const upStart = Date.now();
    await b2.uploadPart({
      uploadUrl: uploadUrlInfo.uploadUrl,
      uploadAuthToken: uploadUrlInfo.authorizationToken,
      partNumber: partNum,
      data: partBuffer,
      hash: sha1,
    });
    const upElapsed = (Date.now() - upStart) / 1000 || 1;
    const mb = partBuffer.length / (1024 * 1024);
    const speed = mb / upElapsed;
    console.log(
      `[MIGRATE] Uploaded part ${partNum} for ${fileNameInB2} (${mb.toFixed(2)} MB, ${speed.toFixed(2)} MB/s)`,
    );
    return { partNum, sha1 };
  };

  let offset = 0;
  while (offset < fileSize) {
    const buffer = Buffer.allocUnsafe(PART_SIZE);
    const { bytesRead } = fs.readSync(fd, buffer, 0, PART_SIZE, offset);
    if (bytesRead === 0) break;
    const partBuffer = bytesRead < PART_SIZE ? buffer.subarray(0, bytesRead) : buffer;

    // Debug log (opsional, bisa dihapus nanti)
    console.log(`[DEBUG] offset=${offset}, bytesRead=${bytesRead}, partNumber=${partNumber}`);

    // Tunggu slot kosong di pool
    if (activeUploads.length >= concurrencyLimit) {
      await Promise.race(activeUploads);
      // Hapus yang sudah selesai
      for (let i = 0; i < activeUploads.length; i++) {
        if (activeUploads[i].status === 'fulfilled') {
          const { partNum, sha1 } = activeUploads[i].value;
          sha1Map.set(partNum, sha1);
          activeUploads.splice(i, 1);
          break;
        }
      }
    }

    // Ambil URL dari pool (round-robin sederhana)
    const urlInfo = partUrlPool[(partNumber - 1) % partUrlPool.length];
    const uploadPromise = uploadPart(partBuffer, partNumber, urlInfo);
    activeUploads.push(uploadPromise);
    partNumber++;
    offset += bytesRead;
  }

  // Tunggu semua part selesai
  const results = await Promise.allSettled(activeUploads);
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { partNum, sha1 } = r.value;
      sha1Map.set(partNum, sha1);
    } else {
      console.error(`[MIGRATE] Part upload failed:`, r.reason);
      throw r.reason;
    }
  }

  // Build ordered partSha1Array dari Map
  const partSha1Array = [];
  for (let i = 1; i <= partNumber - 1; i++) {
    const sha1 = sha1Map.get(i);
    if (!sha1) throw new Error(`Missing SHA1 for part ${i}`);
    partSha1Array.push(sha1);
  }

  fs.closeSync(fd);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  await b2.finishLargeFile({
    fileId,
    partSha1Array,
  });

  const totalMb = (totalBytes || 0) / (1024 * 1024);
  console.log(
    `[MIGRATE] Finished large file ${fileNameInB2} (${totalMb ? totalMb.toFixed(2) : 'unknown'} MB)`,
  );
}

async function uploadDriveFileToB2WithRetry({
  drive,
  b2,
  bucketId,
  fileMeta,
  fileNameInB2,
  maxRetries = 2,
}) {
  let attempt = 0;
  const totalBytes = fileMeta.size ? Number(fileMeta.size) || undefined : undefined;
  const contentType = fileMeta.mimeType || 'application/octet-stream';

  while (true) {
    attempt += 1;
    try {
      console.log(`[MIGRATE] Upload attempt ${attempt} for ${fileNameInB2}`);
      const driveRes = await drive.files.get(
        {
          fileId: fileMeta.id,
          alt: 'media',
          supportsAllDrives: true,
        },
        { responseType: 'stream' },
      );

      const stream = driveRes.data;
      await uploadMultipartFromDriveStream({
        b2,
        bucketId,
        fileNameInB2,
        driveStream: stream,
        contentType,
        totalBytes,
      });
      return;
    } catch (e) {
      console.error(`[MIGRATE] Upload error attempt ${attempt} for ${fileNameInB2}:`, e?.message || e);
      if (attempt >= maxRetries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

// --- Rekursif list & upload dari Google Drive ---
async function migrateFolder({ drive, b2, bucketId, driveFolderId, currentPath, prefix = '' }) {
  const fullPrefix = prefix ? prefix.replace(/\/+$/, '') + '/' : '';

  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${driveFolderId}' in parents and trashed = false`,
      pageSize: 1000,
      pageToken,
      fields: 'nextPageToken, files(id, name, mimeType, size)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
    });

    pageToken = res.data.nextPageToken || undefined;
    const files = res.data.files || [];

    for (const f of files) {
      const isFolder = f.mimeType === 'application/vnd.google-apps.folder';
      const safeName = f.name.replace(/[\\]/g, '_');
      const newPath = currentPath ? `${currentPath}/${safeName}` : safeName;

      if (isFolder) {
        console.log(`[MIGRATE] Enter folder: ${newPath}`);
        await migrateFolder({
          drive,
          b2,
          bucketId,
          driveFolderId: f.id,
          currentPath: newPath,
          prefix,
        });
      } else {
        // Cek apakah file ini sudah pernah dimigrasi
        const existing = getFileMapping(f.id);
        if (existing && existing.status === 'migrated' && existing.b2ObjectKey) {
          console.log(`[MIGRATE] Skip already-migrated file: ${newPath} -> ${existing.b2ObjectKey}`);
          continue;
        }

        const fileNameInB2 = `${fullPrefix}${newPath}`;
        console.log(`[MIGRATE] Upload file: ${newPath} -> ${fileNameInB2}`);

        try {
          await uploadDriveFileToB2WithRetry({
            drive,
            b2,
            bucketId,
            fileMeta: f,
            fileNameInB2,
          });
          // Simpan mapping driveFileId -> b2ObjectKey di SQLite
          upsertFileMapping(f.id, fileNameInB2, 'migrated');
        } catch (e) {
          console.error(`[MIGRATE] Failed upload for ${newPath}:`, e?.message || e);
          // Tandai di DB kalau mau dilihat status error-nya nanti
          try {
            upsertFileMapping(f.id, fileNameInB2, 'error');
          } catch {}
        }
      }
    }
  } while (pageToken);
}

async function main() {
  const args = parseArgs();
  const driveFolderId = args.folderId || 'root';
  const prefix = args.prefix || '';

  console.log('[MIGRATE] Starting migration from Google Drive to Backblaze B2');
  console.log(`[MIGRATE] Drive root folderId: ${driveFolderId}`);
  console.log(`[MIGRATE] B2 prefix: ${prefix || '(none)'}`);

  try {
    const drive = await createDriveClient();
    const { b2, bucketId } = await createB2Client();

    await migrateFolder({
      drive,
      b2,
      bucketId,
      driveFolderId,
      currentPath: '',
      prefix,
    });

    console.log('[MIGRATE] Migration completed');
  } catch (e) {
    console.error('[MIGRATE] Fatal error:', e?.message || e);
    process.exitCode = 1;
  }
}

main();
