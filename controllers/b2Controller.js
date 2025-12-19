import path from 'path';
import { listFiles, getSignedDownloadUrl, deleteFile, deleteFileByName, copyFileWithinBucket } from '../lib/b2.js';
import {
  listFoldersByParent,
  listFilesByFolder,
  getFolderByPrefix,
  upsertFolder,
  deleteFileByPath,
  deleteFilesByPrefix,
  deleteFoldersByPrefix,
  updateFilePathAndName,
} from '../lib/storageCatalogDb.js';

function inferContentTypeFromPath(p) {
  const ext = String(path.extname(String(p || '')).toLowerCase());
  if (!ext) return null;
  const map = {
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.wav': 'audio/wav',
    '.vtt': 'text/vtt',
    '.srt': 'text/plain',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
  };
  return map[ext] || null;
}

const signedUrlCache = new Map();
const proxySignedUrlCache = new Map();

function debugSignedUrlLog(request, payload, msg) {
  if (process.env.DEBUG_SIGNED_URL !== 'true') return;
  try {
    request?.log?.info(payload, msg);
  } catch {
    // ignore
  }
}

async function getProxySignedUrl({ fileName, request }) {
  // Valid 24h, refresh at 23h (1h before expiry)
  const ttlSeconds = 24 * 3600;
  const refreshWindowMs = 3600 * 1000;
  const now = Date.now();
  const cached = proxySignedUrlCache.get(fileName);
  if (cached && cached.expiresAtMs - now > refreshWindowMs) {
    return cached.url;
  }
  const url = await getSignedDownloadUrl({ fileName, validDurationInSeconds: ttlSeconds });
  const expiresAtMs = now + ttlSeconds * 1000;
  proxySignedUrlCache.set(fileName, { url, expiresAtMs });
  debugSignedUrlLog(request, { id: fileName, ttlSeconds, expiresAt: new Date(expiresAtMs).toISOString() }, 'B2 proxy signed URL refreshed');
  return url;
}

function clampInt(n, min, max) {
  if (n == null) return null;
  if (typeof n === 'string' && n.trim() === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.min(Math.max(Math.trunc(v), min), max);
}

async function getCachedSignedUrl({ fileName, ttlSeconds }) {
  const now = Date.now();
  const cached = signedUrlCache.get(fileName);
  const reuseWindowMs = ttlSeconds && ttlSeconds < 120 ? 1_000 : 60_000;
  if (cached && cached.ttlSeconds === ttlSeconds && cached.expiresAtMs - now > reuseWindowMs) {
    return { entry: cached, fromCache: true };
  }

  const url = await getSignedDownloadUrl({ fileName, validDurationInSeconds: ttlSeconds });
  const expiresAtMs = now + ttlSeconds * 1000;
  const entry = { url, expiresAtMs, ttlSeconds };
  signedUrlCache.set(fileName, entry);
  return { entry, fromCache: false };
}

export async function getB2StreamUrlController(request, reply) {
  const url = new URL(`${request.protocol}://${request.headers.host}${request.raw.url}`);
  const fromQuery = request.query?.id || url.searchParams.get('id');
  const id = String(fromQuery || '').trim();

  if (!id) {
    return reply.code(400).send({ error: 'Missing file id' });
  }

  const allowShort = process.env.ALLOW_SHORT_TTL === 'true' || process.env.NODE_ENV !== 'production';
  const minSeconds = allowShort ? 10 : 300;
  const minMinutes = allowShort ? 1 : 5;

  const ttlMinutes = clampInt(request.query?.ttlMinutes ?? url.searchParams.get('ttlMinutes'), minMinutes, 60 * 24 * 7);
  const ttlSeconds = clampInt(request.query?.ttlSeconds ?? url.searchParams.get('ttlSeconds'), minSeconds, 7 * 24 * 3600);
  const ttl = ttlSeconds ?? (ttlMinutes != null ? ttlMinutes * 60 : 5 * 3600);

  try {
    const { entry, fromCache } = await getCachedSignedUrl({ fileName: id, ttlSeconds: ttl });
    const remainingSeconds = Math.max(0, Math.floor((entry.expiresAtMs - Date.now()) / 1000));
    debugSignedUrlLog(request, { id, ttlSeconds: ttl, remainingSeconds, fromCache }, 'B2 signed URL issued');
    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ url: entry.url, expiresInSeconds: remainingSeconds });
  } catch (err) {
    request.log.error(
      {
        id,
        message: err?.message,
        stack: err?.stack,
      },
      'B2 get stream url error',
    );
    return reply.code(500).send({ error: 'Failed to create stream url' });
  }
}

function splitPrefixParts(prefix) {
  return String(prefix || '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
}

function ensureFolderHierarchySync(prefix) {
  const cleaned = String(prefix || '')
    .replace(/^\/+|\/+$/g, '')
    .trim();
  if (!cleaned) {
    return null;
  }

  const parts = splitPrefixParts(cleaned);
  let currentPrefix = '';
  let parentId = null;
  let lastFolder = null;

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
    lastFolder = existing || lastFolder;
  }

  return lastFolder;
}

export async function listB2Controller(request, reply) {
  try {
    const query = request.query || {};
    const prefixRaw = query.prefix || '';
    const pageParam = query.pageToken ?? query.page ?? '1';
    const page = Math.max(Number(pageParam) || 1, 1);
    const pageSize = Number(query.pageSize ?? 1000);
    const type = String(query.type || 'all').toLowerCase(); // all | file

    const basePrefix = String(prefixRaw)
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean)
      .join('/');
    const limit = Math.min(Math.max(pageSize, 1), 1000);
    const offset = (page - 1) * limit;

    const normalizedPrefix = basePrefix ? `${basePrefix.replace(/^\/+|\/+$/g, '')}/` : '';

    // Tentukan folder saat ini di katalog (jika ada)
    let currentFolderId = null;
    if (normalizedPrefix) {
      const folder = getFolderByPrefix(normalizedPrefix);
      if (!folder) {
        return reply
          .headers({
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            Pragma: 'no-cache',
          })
          .send({ files: [], nextPageToken: null });
      }
      currentFolderId = folder.id;
    }

    const items = [];

    if (type !== 'file') {
      // Ambil subfolder sebagai items folder
      const parentIdForFolders = currentFolderId;
      const foldersRows = listFoldersByParent({ parentId: parentIdForFolders, limit, offset });
      for (const f of foldersRows) {
        items.push({
          id: f.prefix,
          name: f.name,
          mimeType: 'application/vnd.google-apps.folder',
        });
      }
    }

    if (type === 'file' || type === 'all') {
      // Ambil file langsung di bawah folder saat ini
      const folderIdForFiles = normalizedPrefix ? currentFolderId : null;
      const filesRows = listFilesByFolder({ folderId: folderIdForFiles, limit, offset });
      for (const f of filesRows) {
        items.push({
          id: f.file_path,
          name: f.file_name,
          mimeType: f.content_type || 'application/octet-stream',
          size: Number(f.size) || 0,
          modifiedTime: f.uploaded_at || null,
        });
      }
    }

    const hasMore = items.length === limit;
    const nextPageToken = hasMore ? String(page + 1) : null;

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ files: items, nextPageToken });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
      },
      'B2 list error',
    );
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Failed to list B2 files', details: err?.message });
  }
}

export async function createB2FolderController(request, reply) {
  try {
    const body = request.body || {};
    const rawPrefix = body.prefix;

    const cleaned = String(rawPrefix || '')
      .replace(/^\/+|\/+$/g, '')
      .trim();

    if (!cleaned) {
      return reply
        .code(400)
        .headers({
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        })
        .send({ error: 'Missing prefix' });
    }

    const folder = ensureFolderHierarchySync(cleaned);

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({
        folder: folder
          ? { id: folder.id, name: folder.name, prefix: folder.prefix }
          : null,
      });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
      },
      'B2 create-folder (DB only) error',
    );
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Failed to create folder in catalog', details: err?.message });
  }
}

export async function listB2FoldersController(request, reply) {
  try {
    const query = request.query || {};
    const prefixRaw = query.prefix || '';
    const pageParam = query.pageToken ?? query.page ?? '1';
    const page = Math.max(Number(pageParam) || 1, 1);
    const pageSize = Number(query.pageSize ?? 50);

    const basePrefix = String(prefixRaw)
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean)
      .join('/');

    const limit = Math.min(Math.max(pageSize, 1), 200);
    const offset = (page - 1) * limit;

    const normalizedPrefix = basePrefix ? `${basePrefix.replace(/^\/+|\/+$/g, '')}/` : '';

    let parentFolderId = null;
    if (normalizedPrefix) {
      const folder = getFolderByPrefix(normalizedPrefix);
      if (!folder) {
        return reply
          .headers({
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            Pragma: 'no-cache',
          })
          .send({ folders: [], nextPageToken: null });
      }
      parentFolderId = folder.id;
    }

    const folderRows = listFoldersByParent({ parentId: parentFolderId, limit, offset });
    const folders = folderRows.map((f) => ({
      id: f.prefix,
      name: f.name,
      mimeType: 'application/vnd.google-apps.folder',
    }));

    const hasMore = folders.length === limit;
    const nextPageToken = hasMore ? String(page + 1) : null;

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ folders, nextPageToken });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
      },
      'B2 folders list error',
    );
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Failed to list B2 folders', details: err?.message });
  }
}

export async function listB2VideosController(request, reply) {
  try {
    const query = request.query || {};
    const prefixRaw = query.prefix || '';
    const pageToken = query.pageToken || undefined;
    const pageSize = Number(query.pageSize ?? 1000);

    const basePrefix = String(prefixRaw)
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean)
      .join('/');

    const { files = [], nextFileName = null } = await listFiles({
      prefix: basePrefix ? `${basePrefix.replace(/^\/+|\/+$/g, '')}/` : '',
      maxFileCount: Math.min(Math.max(pageSize, 1), 1000),
      startFileName: pageToken,
    });

    const videoExt = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'];

    const items = [];
    for (const f of files || []) {
      const fullName = f.fileName || '';
      if (!fullName) continue;

      const ext = path.extname(fullName).toLowerCase();
      const mime = (f.contentType || '').toLowerCase();
      const isVideo = mime.startsWith('video/') || videoExt.includes(ext);
      if (!isVideo) continue;

      items.push({
        id: fullName,
        name: path.basename(fullName),
        mimeType: f.contentType || 'application/octet-stream',
        size: Number(f.contentLength) || 0,
        modifiedTime: f.uploadTimestamp ? new Date(f.uploadTimestamp).toISOString() : null,
      });
    }

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ files: items, nextPageToken: nextFileName || null });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
      },
      'B2 videos list error',
    );
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Failed to list B2 videos', details: err?.message });
  }
}

export async function streamB2Controller(request, reply) {
  const url = new URL(`${request.protocol}://${request.headers.host}${request.raw.url}`);
  const fromParams = request.params?.id;
  const fromQuery = url.searchParams.get('id');
  const id = fromParams || fromQuery;

  if (!id) {
    return reply.code(400).send({ error: 'Missing file id' });
  }

  try {
    // IMPORTANT: avoid caching HEAD responses (e.g. from `curl -I`) because they have no body and can poison CDN cache.
    if (String(request.method || '').toUpperCase() === 'HEAD') {
      const inferred = inferContentTypeFromPath(id) || 'application/octet-stream';
      return reply
        .code(200)
        .header('Content-Type', inferred)
        .header('Cache-Control', 'no-store')
        .send();
    }

    const range = request.headers['range'] || request.headers['Range'];
    const ifNoneMatch = request.headers['if-none-match'] || request.headers['If-None-Match'];
    const ifModifiedSince = request.headers['if-modified-since'] || request.headers['If-Modified-Since'];
    const baseHeaders = {
      ...(range ? { Range: range } : {}),
      ...(!range && ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {}),
      ...(!range && ifModifiedSince ? { 'If-Modified-Since': ifModifiedSince } : {}),
    };
    let signedUrl = await getProxySignedUrl({ fileName: id, request });

    const controller = new AbortController();
    const onClose = () => {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    };
    request.raw.on('close', onClose);
    reply.raw.on('close', onClose);
    reply.raw.on('error', onClose);

    let res = await fetch(signedUrl, {
      method: 'GET',
      headers: baseHeaders,
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      request.log.warn({ id, status: res.status }, 'B2 signed URL unauthorized/expired, retrying once');
      debugSignedUrlLog(request, { id, status: res.status }, 'B2 signed URL unauthorized/expired (proxy stream)');
      try {
        await res.body?.cancel?.();
      } catch {
        // ignore
      }
      proxySignedUrlCache.delete(id);
      signedUrl = await getProxySignedUrl({ fileName: id, request });
      debugSignedUrlLog(request, { id }, 'B2 signed URL regenerated (proxy stream)');
      res = await fetch(signedUrl, {
        method: 'GET',
        headers: baseHeaders,
        signal: controller.signal,
      });
    }

    if (res.status === 304) {
      reply
        .code(304)
        .header('ETag', res.headers.get('etag') || '')
        .header('Last-Modified', res.headers.get('last-modified') || '');
      return reply.send();
    }

    if (!res.ok && res.status !== 206) {
      const text = await res.text().catch(() => '');
      return reply.code(res.status || 502).send({ error: 'Failed to stream from B2', status: res.status, details: text?.slice(0, 500) });
    }

    const status = res.status || (range ? 206 : 200);
    const cacheControl = 'public, s-maxage=82800, max-age=0';
    const upstreamType = res.headers.get('content-type') || '';
    let contentType = upstreamType || 'application/octet-stream';
    if (!upstreamType || /^application\/octet-stream\b/i.test(upstreamType)) {
      const inferred = inferContentTypeFromPath(id);
      if (inferred) contentType = inferred;
    }
    reply.code(status).header('Content-Type', contentType);
    if (range) reply.header('Vary', 'Range');
    reply.header('Cache-Control', cacheControl);

    const srcLen = res.headers.get('content-length');
    const srcAccept = res.headers.get('accept-ranges');
    const srcRange = res.headers.get('content-range');
    const srcEtag = res.headers.get('etag');
    const srcLM = res.headers.get('last-modified');
    if (srcLen) reply.header('Content-Length', srcLen);
    if (srcAccept) reply.header('Accept-Ranges', srcAccept);
    if (!srcAccept) reply.header('Accept-Ranges', 'bytes');
    if (srcRange) reply.header('Content-Range', srcRange);
    if (srcEtag) reply.header('ETag', srcEtag);
    if (srcLM) reply.header('Last-Modified', srcLM);

    if (!res.body) {
      return reply.code(502).send({ error: 'Empty body from B2' });
    }

    return reply.send(res.body);
  } catch (err) {
    const msg = String(err?.message || '');
    if (/operation canceled|aborted|premature|socket hang up|ECONNRESET/i.test(msg)) {
      request.log.info({ id, message: msg }, 'B2 proxy stream aborted');
      return reply;
    }
    request.log.error(
      {
        id,
        message: err?.message,
        stack: err?.stack,
      },
      'B2 stream error',
    );
    return reply.code(500).send({ error: 'Failed to stream file' });
  }
}

export async function deleteB2FileController(request, reply) {
  try {
    const id = request.query?.id;
    if (!id) {
      return reply
        .code(400)
        .headers({
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        })
        .send({ error: 'Missing id' });
    }

    const target = String(id).trim();
    if (!target) {
      return reply
        .code(400)
        .headers({
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        })
        .send({ error: 'Missing id' });
    }

    // Coba hapus sebagai satu file spesifik terlebih dahulu
    try {
      await deleteFileByName(target);
      deleteFileByPath(target);

      return reply
        .headers({
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        })
        .send({ ok: true, mode: 'file', id: target });
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        // Error lain selain "file tidak ditemukan" dianggap fatal
        request.log.error(
          {
            id: target,
            message: err?.message,
            stack: err?.stack,
          },
          'B2 delete file error',
        );
        return reply
          .code(500)
          .headers({
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            Pragma: 'no-cache',
          })
          .send({ error: 'Failed to delete file', details: err?.message });
      }
    }

    // Jika tidak ada file persis dengan nama tersebut, perlakukan sebagai prefix/folder
    const cleaned = String(target)
      .replace(/^\/+|\/+$/g, '')
      .trim();
    if (!cleaned) {
      return reply
        .code(404)
        .headers({
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        })
        .send({ error: 'File or prefix not found' });
    }

    const prefix = `${cleaned.replace(/^\/+|\/+$/g, '')}/`;
    let deletedCount = 0;
    let startFileName;

    // Hard delete semua file di bawah prefix ini
    // Loop pagination sampai tidak ada lagi file
    // (gunakan listFiles langsung ke B2, lalu deleteFile per item)
    // Perhatikan bahwa ini bisa mahal untuk prefix dengan sangat banyak file.
    // Gunakan dengan hati-hati di sisi client.
    //
    // Di sisi katalog, kita akan menghapus semua files & folders dengan prefix tersebut.

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { files = [], nextFileName = null } = await listFiles({
        prefix,
        maxFileCount: 1000,
        startFileName,
      });

      if (!files.length) break;

      for (const f of files) {
        try {
          await deleteFile({ fileId: f.fileId, fileName: f.fileName });
          deletedCount += 1;
        } catch (err) {
          request.log.error(
            {
              id: f.fileName,
              message: err?.message,
              stack: err?.stack,
            },
            'B2 delete file in prefix error',
          );
        }
      }

      if (!nextFileName) break;
      startFileName = nextFileName;
    }

    // Hapus dari katalog lokal
    deleteFilesByPrefix(cleaned);
    deleteFoldersByPrefix(cleaned);

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ ok: true, mode: 'prefix', prefix, deletedCount });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
      },
      'B2 delete (file/prefix) error',
    );
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Failed to delete B2 file or prefix', details: err?.message });
  }
}

export async function renameB2FileController(request, reply) {
  try {
    const body = request.body || {};
    const oldPathRaw = body.oldPath || body.id || body.path;
    const newNameRaw = body.newName || body.name;

    const oldPath = String(oldPathRaw || '').trim();
    const newName = String(newNameRaw || '').trim();

    if (!oldPath || !newName) {
      return reply
        .code(400)
        .headers({
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        })
        .send({ error: 'Missing oldPath or newName' });
    }

    const parts = oldPath.split('/').filter(Boolean);
    const folderPrefix = parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '';
    const newPath = folderPrefix ? `${folderPrefix}${newName}` : newName;

    // Cari file di B2 berdasarkan oldPath
    const { files = [] } = await listFiles({ prefix: oldPath, maxFileCount: 1 });
    const file = files.find((f) => f.fileName === oldPath);
    if (!file) {
      return reply
        .code(404)
        .headers({
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        })
        .send({ error: 'File not found' });
    }

    // Copy ke nama baru lalu hapus yang lama (rename via copy+delete)
    await copyFileWithinBucket({ sourceFileId: file.fileId, newFileName: newPath });
    await deleteFile({ fileId: file.fileId, fileName: oldPath });

    // Update katalog lokal
    updateFilePathAndName({ oldPath, newPath, newName });

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({
        file: {
          oldPath,
          newPath,
          name: newName,
        },
      });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
      },
      'B2 rename file error',
    );
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Failed to rename file', details: err?.message });
  }
}
