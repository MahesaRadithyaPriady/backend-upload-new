import B2 from 'backblaze-b2';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

let b2Client = null;
let b2BucketId = null;
let b2DownloadUrl = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isB2TransientUploadError(err) {
  const status = err?.status || err?.response?.status || err?.response?.data?.status;
  const code = err?.code || err?.response?.data?.code;
  const msg = String(err?.message || err?.response?.data?.message || '');
  return (
    status === 429 ||
    status === 503 ||
    code === 'service_unavailable' ||
    /no tomes available|service_unavailable|too many requests|rate limit/i.test(msg)
  );
}

async function withB2TransientRetry(fn, { retries = 3, baseDelayMs = 600 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isB2TransientUploadError(err) || attempt >= retries) throw err;
      const jitter = Math.floor(Math.random() * 200);
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + jitter;
      if (process.env.DEBUG_SIGNED_URL === 'true') {
        console.log('[b2] transient upload error, retrying', {
          attempt,
          retries,
          delayMs: delay,
          status: err?.status || err?.response?.status,
          code: err?.code || err?.response?.data?.code,
          message: err?.message || err?.response?.data?.message,
        });
      }
      await sleep(delay);
    }
  }
  throw lastErr;
}

function isB2AuthError(err) {
  const status = err?.status || err?.response?.status || err?.response?.data?.status || err?.response?.data?.code;
  const code = err?.code || err?.response?.data?.code;
  const message = String(err?.message || '');
  return (
    status === 401 ||
    status === 403 ||
    code === 'bad_auth_token' ||
    code === 'expired_auth_token' ||
    /bad_auth_token|expired_auth_token|unauthorized|forbidden|authorization/i.test(message)
  );
}

async function reauthorizeB2() {
  if (!b2Client) return null;
  const auth = await b2Client.authorize();
  b2DownloadUrl = auth?.data?.downloadUrl || b2DownloadUrl;
  return auth;
}

async function withB2AuthRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isB2AuthError(err) || !b2Client) throw err;
    if (process.env.DEBUG_SIGNED_URL === 'true') {
      console.log('[b2] auth expired/invalid, re-authorizing and retrying once', {
        message: err?.message,
        code: err?.code || err?.response?.data?.code,
        status: err?.status || err?.response?.status,
      });
    }
    await reauthorizeB2();
    return fn();
  }
}

function ensureEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export async function getB2() {
  if (b2Client && b2BucketId && b2DownloadUrl) return { b2: b2Client, bucketId: b2BucketId, downloadUrl: b2DownloadUrl };

  const applicationKeyId = ensureEnv('B2_APPLICATION_KEY_ID');
  const applicationKey = ensureEnv('B2_APPLICATION_KEY');
  const bucketIdFromEnv = process.env.B2_BUCKET_ID || '';
  const bucketName = process.env.B2_BUCKET_NAME || '';

  const b2 = new B2({ applicationKeyId, applicationKey });
  const auth = await b2.authorize();
  const downloadUrl = auth?.data?.downloadUrl;

  let bucketId = bucketIdFromEnv;
  if (!bucketId) {
    if (!bucketName) {
      throw new Error('Missing B2_BUCKET_ID or B2_BUCKET_NAME env var');
    }
    const { data } = await b2.listBuckets({});
    const bucket = (data.buckets || []).find((b) => b.bucketName === bucketName);
    if (!bucket) {
      throw new Error(`Bucket with name ${bucketName} not found in B2`);
    }
    bucketId = bucket.bucketId;
  }

  b2Client = b2;
  b2BucketId = bucketId;
  b2DownloadUrl = downloadUrl;
  return { b2, bucketId, downloadUrl };
}

export async function getB2UploadUrl() {
  const { b2, bucketId } = await getB2();
  const res = await withB2AuthRetry(() => b2.getUploadUrl({ bucketId }));
  return {
    uploadUrl: res?.data?.uploadUrl,
    authorizationToken: res?.data?.authorizationToken,
    bucketId,
  };
}

export async function uploadBuffer({ fileName, buffer, contentType }) {
  if (!fileName) throw new Error('fileName is required for uploadBuffer');
  const { b2, bucketId } = await getB2();

  const retries = Math.max(1, Number(process.env.B2_UPLOAD_RETRIES || 3));
  const baseDelayMs = Math.max(100, Number(process.env.B2_UPLOAD_RETRY_BASE_MS || 600));

  const exec = async () => {
    const { data } = await withB2AuthRetry(() => b2.getUploadUrl({ bucketId }));
    const uploadUrl = data.uploadUrl;
    const uploadAuthToken = data.authorizationToken;

    const res = await withB2AuthRetry(() =>
      b2.uploadFile({
        uploadUrl,
        uploadAuthToken,
        fileName,
        data: buffer,
        mime: contentType || 'application/octet-stream',
      }),
    );
    return res.data;
  };

  return withB2TransientRetry(exec, { retries, baseDelayMs });
}

async function streamToTempFileAndSha1(stream) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-upload-'));
  const filePath = path.join(tmpDir, 'upload.bin');

  const hash = crypto.createHash('sha1');
  let size = 0;

  try {
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(filePath);
      stream.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        hash.update(buf);
      });
      stream.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      stream.pipe(ws);
    });

    const sha1 = hash.digest('hex');
    return { tmpDir, filePath, sha1, size };
  } catch (err) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

async function uploadFileFromPath({ fileName, filePath, contentType, sha1, contentLength }) {
  if (!fileName) throw new Error('fileName is required for uploadFileFromPath');
  if (!filePath) throw new Error('filePath is required for uploadFileFromPath');
  if (!sha1) throw new Error('sha1 is required for uploadFileFromPath');

  const { b2, bucketId } = await getB2();
  const retries = Math.max(1, Number(process.env.B2_UPLOAD_RETRIES || 3));
  const baseDelayMs = Math.max(100, Number(process.env.B2_UPLOAD_RETRY_BASE_MS || 600));

  const exec = async () => {
    const { data } = await withB2AuthRetry(() => b2.getUploadUrl({ bucketId }));
    const uploadUrl = data.uploadUrl;
    const uploadAuthToken = data.authorizationToken;

    const len = (() => {
      const n = Number(contentLength);
      if (Number.isFinite(n) && n >= 0) return n;
      try {
        return fs.statSync(filePath).size;
      } catch {
        return undefined;
      }
    })();

    const rs = fs.createReadStream(filePath);
    const res = await withB2AuthRetry(() =>
      b2.uploadFile({
        uploadUrl,
        uploadAuthToken,
        fileName,
        data: rs,
        hash: sha1,
        contentLength: len,
        mime: contentType || 'application/octet-stream',
      }),
    );
    return res.data;
  };

  return withB2TransientRetry(exec, { retries, baseDelayMs });
}

export async function uploadFromStream({ fileName, stream, contentType, expectedSizeBytes } = {}) {
  if (!stream) throw new Error('stream is required for uploadFromStream');

  const maxInMem = (() => {
    const n = Number(process.env.B2_UPLOAD_MAX_IN_MEMORY_BYTES || 50 * 1024 * 1024);
    return Number.isFinite(n) && n > 0 ? n : 50 * 1024 * 1024;
  })();

  const expected = Number(expectedSizeBytes);
  const shouldUseTempFile = Number.isFinite(expected) ? expected > maxInMem : true;

  if (!shouldUseTempFile) {
    const chunks = [];
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
    }
    const buffer = Buffer.concat(chunks);
    return uploadBuffer({ fileName, buffer, contentType });
  }

  const { tmpDir, filePath, sha1, size } = await streamToTempFileAndSha1(stream);
  try {
    return await uploadFileFromPath({ fileName, filePath, contentType, sha1, contentLength: size });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export async function downloadByName({ fileName, range }) {
  if (!fileName) throw new Error('fileName is required for downloadByName');
  const { b2 } = await getB2();

  const headers = {};
  if (range) headers.Range = range;

  const res = await withB2AuthRetry(() =>
    b2.downloadFileByName({
      bucketName: process.env.B2_BUCKET_NAME,
      fileName,
      headers,
      responseType: 'stream',
    }),
  );
  
  return res;
}

export async function getSignedDownloadUrl({ fileName, validDurationInSeconds } = {}) {
  if (!fileName) throw new Error('fileName is required for getSignedDownloadUrl');
  const { b2, bucketId, downloadUrl } = await getB2();
  const bucketName = process.env.B2_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('B2_BUCKET_NAME env var is required to build signed download URL');
  }

   // TTL default: baca dari env B2_SIGNED_URL_TTL (detik), fallback ke 6 jam.
   const ttlFromEnv = Number(process.env.B2_SIGNED_URL_TTL || '0');
   const ttl = Number.isFinite(ttlFromEnv) && ttlFromEnv > 0 ? ttlFromEnv : 6 * 3600;
   const duration = validDurationInSeconds && validDurationInSeconds > 0 ? validDurationInSeconds : ttl;

  const issuedAtMs = Date.now();

  const { data } = await withB2AuthRetry(() =>
    b2.getDownloadAuthorization({
      bucketId,
      fileNamePrefix: fileName,
      validDurationInSeconds: duration,
    }),
  );

  const token = data.authorizationToken;
  const base = (downloadUrl || '').replace(/\/$/, '');
  const encodedName = encodeURIComponent(fileName).replace(/%2F/g, '/');
  const url = `${base}/file/${bucketName}/${encodedName}?Authorization=${encodeURIComponent(token)}`;

  if (process.env.DEBUG_SIGNED_URL === 'true') {
    console.log('[b2] signed download url issued', {
      fileName,
      validDurationInSeconds: duration,
      expiresAt: new Date(issuedAtMs + duration * 1000).toISOString(),
    });
  }
  return url;
}

export async function listFiles({ prefix = '', maxFileCount = 1000, startFileName } = {}) {
  const { b2, bucketId } = await getB2();

  const res = await withB2AuthRetry(() =>
    b2.listFileNames({
      bucketId,
      maxFileCount,
      prefix,
      startFileName,
    }),
  );

  return res.data;
}

export async function deleteFile({ fileId, fileName }) {
  if (!fileId || !fileName) {
    throw new Error('fileId and fileName are required for deleteFile');
  }
  const { b2 } = await getB2();
  // Library hanya menyediakan deleteFileVersion, bukan deleteFile
  const res = await b2.deleteFileVersion({ fileId, fileName });
  return res.data;
}

export async function deleteFileByName(fileName) {
  if (!fileName) throw new Error('fileName is required for deleteFileByName');
  const { files = [] } = await listFiles({ prefix: fileName, maxFileCount: 1 });
  const file = files.find((f) => f.fileName === fileName);
  if (!file) {
    const err = new Error('File not found');
    err.code = 'ENOENT';
    throw err;
  }
  return deleteFile({ fileId: file.fileId, fileName });
}

export async function copyFileWithinBucket({ sourceFileId, newFileName }) {
  if (!sourceFileId || !newFileName) {
    throw new Error('sourceFileId and newFileName are required for copyFileWithinBucket');
  }

  const { b2, bucketId } = await getB2();
  const apiUrl = b2.apiUrl;
  const authToken = b2.authorizationToken;
  if (!apiUrl || !authToken) {
    throw new Error('B2 client is not authorized (missing apiUrl or authorizationToken)');
  }

  const url = `${apiUrl.replace(/\/$/, '')}/b2api/v2/b2_copy_file`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sourceFileId,
      destinationBucketId: bucketId,
      fileName: newFileName,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`b2_copy_file failed with status ${res.status}`);
    err.status = res.status;
    err.body = text?.slice(0, 500);
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  return data;
}
