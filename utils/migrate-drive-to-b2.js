import 'dotenv/config';
import { google } from 'googleapis';
import B2 from 'backblaze-b2';
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

// --- Upload satu file ke B2 ---
async function uploadFileToB2(b2, bucketId, fileName, dataStream, contentType, totalBytes) {
  // backblaze-b2 expects data sebagai Buffer/string, bukan stream Node langsung
  const chunks = [];
  let downloaded = 0;
  let lastLoggedPercent = 0;
  const start = Date.now();

  for await (const chunk of dataStream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buf);
    downloaded += buf.length;

    if (totalBytes) {
      const percent = Math.max(1, Math.min(99, Math.round((downloaded / totalBytes) * 100)));
      if (percent !== lastLoggedPercent) {
        const elapsedSec = (Date.now() - start) / 1000 || 1;
        const mb = downloaded / (1024 * 1024);
        const speed = mb / elapsedSec;
        console.log(
          `[MIGRATE] Download progress ${percent}% (${mb.toFixed(2)} MB, ${speed.toFixed(2)} MB/s) for ${fileName}`,
        );
        lastLoggedPercent = percent;
      }
    }
  }

  const buffer = Buffer.concat(chunks);

  const { data } = await b2.getUploadUrl({ bucketId });
  const uploadUrl = data.uploadUrl;
  const uploadAuthToken = data.authorizationToken;

  const upStart = Date.now();
  const res = await b2.uploadFile({
    uploadUrl,
    uploadAuthToken,
    fileName,
    data: buffer,
    mime: contentType || 'application/octet-stream',
  });
  const upElapsed = (Date.now() - upStart) / 1000 || 1;
  const upMb = buffer.length / (1024 * 1024);
  const upSpeed = upMb / upElapsed;
  console.log(`[MIGRATE] Upload finished for ${fileName} (${upMb.toFixed(2)} MB, ${upSpeed.toFixed(2)} MB/s)`);

  return res.data;
}

async function uploadFileWithRetry({ b2, bucketId, fileNameInB2, stream, contentType, totalBytes, maxRetries = 3 }) {
  let attempt = 0;
  // Karena stream hanya bisa dibaca sekali, kita biarkan uploadFileToB2 yang membuffer stream jadi Buffer,
  // sehingga retry tidak butuh stream ulang dari Drive.
  while (true) {
    attempt += 1;
    try {
      console.log(`[MIGRATE] Upload attempt ${attempt} for ${fileNameInB2}`);
      return await uploadFileToB2(b2, bucketId, fileNameInB2, stream, contentType, totalBytes);
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

        const driveRes = await drive.files.get(
          {
            fileId: f.id,
            alt: 'media',
            supportsAllDrives: true,
          },
          { responseType: 'stream' },
        );

        const contentType = driveRes.headers['content-type'] || 'application/octet-stream';
        const stream = driveRes.data;
        const totalBytes = f.size ? Number(f.size) || undefined : undefined;

        try {
          await uploadFileWithRetry({
            b2,
            bucketId,
            fileNameInB2,
            stream,
            contentType,
            totalBytes,
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
