import 'dotenv/config';
import { google } from 'googleapis';
import B2 from 'backblaze-b2';
import crypto from 'crypto';
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

// --- Upload satu file besar ke B2 dengan multipart (streaming) ---
const PART_SIZE = 50 * 1024 * 1024; // 50MB

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

  const sha1s = [];
  let partNumber = 1;
  let downloaded = 0;
  let lastLoggedPercent = 0;
  const start = Date.now();

  let buffer = Buffer.alloc(0);

  for await (const chunk of driveStream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, buf]);
    downloaded += buf.length;

    if (totalBytes) {
      const percent = Math.max(1, Math.min(99, Math.round((downloaded / totalBytes) * 100)));
      if (percent !== lastLoggedPercent) {
        const elapsedSec = (Date.now() - start) / 1000 || 1;
        const mb = downloaded / (1024 * 1024);
        const speed = mb / elapsedSec;
        console.log(
          `[MIGRATE] Download progress ${percent}% (${mb.toFixed(2)} MB, ${speed.toFixed(2)} MB/s) for ${fileNameInB2}`,
        );
        lastLoggedPercent = percent;
      }
    }

    while (buffer.length >= PART_SIZE) {
      const part = buffer.subarray(0, PART_SIZE);
      buffer = buffer.subarray(PART_SIZE);

      const sha1 = crypto.createHash('sha1').update(part).digest('hex');
      sha1s.push(sha1);

      const { data: up } = await b2.getUploadPartUrl({ fileId });
      const upStart = Date.now();
      await b2.uploadPart({
        uploadUrl: up.uploadUrl,
        uploadAuthToken: up.authorizationToken,
        partNumber,
        data: part,
        hash: sha1,
      });
      const upElapsed = (Date.now() - upStart) / 1000 || 1;
      const mb = part.length / (1024 * 1024);
      const speed = mb / upElapsed;
      console.log(
        `[MIGRATE] Uploaded part ${partNumber} for ${fileNameInB2} (${mb.toFixed(2)} MB, ${speed.toFixed(2)} MB/s)`,
      );

      partNumber += 1;
    }
  }

  if (buffer.length > 0) {
    const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
    sha1s.push(sha1);

    const { data: up } = await b2.getUploadPartUrl({ fileId });
    const upStart = Date.now();
    await b2.uploadPart({
      uploadUrl: up.uploadUrl,
      uploadAuthToken: up.authorizationToken,
      partNumber,
      data: buffer,
      hash: sha1,
    });
    const upElapsed = (Date.now() - upStart) / 1000 || 1;
    const mb = buffer.length / (1024 * 1024);
    const speed = mb / upElapsed;
    console.log(
      `[MIGRATE] Uploaded final part ${partNumber} for ${fileNameInB2} (${mb.toFixed(2)} MB, ${speed.toFixed(2)} MB/s)`,
    );
  }

  const finishStart = Date.now();
  await b2.finishLargeFile({
    fileId,
    partSha1Array: sha1s,
  });
  const finishElapsed = (Date.now() - finishStart) / 1000 || 1;
  const totalMb = (totalBytes || 0) / (1024 * 1024);
  console.log(
    `[MIGRATE] Finished large file ${fileNameInB2} (${totalMb ? totalMb.toFixed(2) : 'unknown'} MB) in ${finishElapsed.toFixed(2)}s`,
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
