import { Readable } from 'stream';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { getDrive } from '../lib/drive.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let saAuthClient = null;

async function getServiceAccountAccessToken() {
  if (!saAuthClient) {
    const keyFile = path.join(__dirname, '..', 'config', 'nanimeid-2f819a5dcf5f.json');
    const auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    saAuthClient = await auth.getClient();
  }
  const token = await saAuthClient.getAccessToken();
  return typeof token === 'string' ? token : token?.token;
}

export async function listDriveController(request, reply) {
  try {
    const searchParams = request.query || {};
    const folderId = searchParams.folderId || 'root';
    const search = searchParams.search || '';
    let pageToken = searchParams.pageToken || undefined;
    const pageSize = Number(searchParams.pageSize || 50);
    const order = String(searchParams.order || 'name_asc').toLowerCase(); // name_asc | name_desc
    const type = String(searchParams.type || 'all').toLowerCase(); // all | folder | file

    const drive = getDrive();

    let q = `'${folderId}' in parents and trashed = false`;
    if (search) {
      const escaped = search.replace(/['\\]/g, '\\$&');
      q += ` and name contains '${escaped}'`;
    }
    if (type === 'folder') {
      q += " and mimeType = 'application/vnd.google-apps.folder'";
    } else if (type === 'file') {
      q += " and mimeType != 'application/vnd.google-apps.folder'";
    }

    const orderBy = order === 'name_desc' ? 'folder desc, name desc' : 'folder, name';

    if (search) pageToken = undefined;

    async function listWithToken(token) {
      return drive.files.list({
        q,
        pageSize: Math.min(Math.max(pageSize, 1), 100),
        pageToken: token,
        fields:
          'nextPageToken, files(id, name, mimeType, size, modifiedTime, iconLink, webViewLink, capabilities(canTrash, canDelete))',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: 'allDrives',
        orderBy,
      });
    }

    let res;
    try {
      res = await listWithToken(pageToken);
    } catch (e) {
      if (pageToken) {
        res = await listWithToken(undefined);
      } else {
        throw e;
      }
    }

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ files: res.data.files || [], nextPageToken: res.data.nextPageToken || null });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
        response: err?.response?.data,
        errors: err?.errors,
        code: err?.code,
      },
      'Drive list error',
    );
    const details = err?.response?.data || err?.errors || err?.message;
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Failed to list files', details });
  }
}

export async function copyDriveController(request, reply) {
  try {
    const body = request.body || {};
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    const destinationId = body?.destinationId;
    if (!ids.length || !destinationId) {
      return reply.code(400).send({ error: 'Missing ids or destinationId' });
    }

    const drive = getDrive();
    const results = [];
    for (const id of ids) {
      try {
        const meta = await drive.files.get({
          fileId: id,
          fields: 'id, name, mimeType',
          supportsAllDrives: true,
        });
        if (meta.data.mimeType === 'application/vnd.google-apps.folder') {
          results.push({ id, error: 'Folder copy is not supported' });
          continue;
        }
        const copied = await drive.files.copy({
          fileId: id,
          requestBody: { parents: [destinationId] },
          fields: 'id, name',
          supportsAllDrives: true,
        });
        results.push({ id, file: copied.data });
      } catch (e) {
        results.push({ id, error: e?.message || 'Copy failed' });
      }
    }

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ results });
  } catch (err) {
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: err?.message || 'Failed to copy' });
  }
}

export async function createFolderDriveController(request, reply) {
  try {
    const body = request.body || {};
    const name = body?.name;
    const parentId = body?.parentId || 'root';
    if (!name) {
      return reply.code(400).send({ error: 'Missing name' });
    }

    const drive = getDrive();
    const res = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id, name',
      supportsAllDrives: true,
    });

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ folder: res.data });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
        response: err?.response?.data,
        errors: err?.errors,
      },
      'Drive create-folder error',
    );
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Failed to create folder', details: err?.response?.data || err?.message });
  }
}

export async function deleteDriveController(request, reply) {
  try {
    const id = request.query?.id;
    const permanent = request.query?.permanent === 'true';
    if (!id) {
      return reply
        .code(400)
        .headers({
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        })
        .send({ error: 'Missing id' });
    }

    const drive = getDrive();
    if (permanent) {
      try {
        await drive.files.delete({ fileId: id, supportsAllDrives: true });
      } catch (err) {
        if (err?.code === 403) {
          await drive.files.update({
            fileId: id,
            supportsAllDrives: true,
            requestBody: { trashed: true },
          });
        } else {
          throw err;
        }
      }
    } else {
      await drive.files.update({
        fileId: id,
        supportsAllDrives: true,
        requestBody: { trashed: true },
      });
    }

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ ok: true });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
        response: err?.response?.data,
        errors: err?.errors,
      },
      'Drive delete error',
    );
    const status = Number.isInteger(err?.code) ? err.code : 500;
    const msg = err?.errors?.[0]?.message || 'Failed to delete file';
    return reply
      .code(status)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: msg });
  }
}

export async function renameDriveController(request, reply) {
  try {
    const body = request.body || {};
    const id = body?.id;
    const name = (body?.name || '').toString().trim();
    if (!id || !name) {
      return reply
        .code(400)
        .headers({
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
        })
        .send({ error: 'Missing id or name' });
    }

    const drive = getDrive();
    const res = await drive.files.update({
      fileId: id,
      requestBody: { name },
      fields: 'id, name',
      supportsAllDrives: true,
    });

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ file: res.data });
  } catch (err) {
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: err?.message || 'Failed to rename' });
  }
}

export async function metaDriveController(request, reply) {
  const id = request.params?.id || request.query?.id;
  const resourceKey = request.query?.resourceKey || request.query?.resourcekey || undefined;

  if (!id) {
    return reply
      .code(400)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Missing file id' });
  }

  try {
    const drive = getDrive();
    const res = await drive.files.get({
      fileId: id,
      supportsAllDrives: true,
      resourceKey,
      fields:
        'id, name, mimeType, size, modifiedTime, fileExtension, iconLink, thumbnailLink, webViewLink, driveId',
    });

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ file: res.data });
  } catch (err) {
    request.log.error(
      {
        id,
        message: err?.message,
        stack: err?.stack,
        response: err?.response?.data,
        headers: err?.response?.headers,
      },
      'Drive meta error',
    );
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Failed to fetch metadata' });
  }
}

export async function moveDriveController(request, reply) {
  try {
    const body = request.body || {};
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    const destinationId = body?.destinationId;
    if (!ids.length || !destinationId) {
      return reply.code(400).send({ error: 'Missing ids or destinationId' });
    }

    const drive = getDrive();
    const results = [];
    for (const id of ids) {
      try {
        const meta = await drive.files.get({
          fileId: id,
          fields: 'id, name, parents',
          supportsAllDrives: true,
        });
        const currentParents = (meta.data.parents || []).join(',');
        const updated = await drive.files.update({
          fileId: id,
          addParents: destinationId,
          removeParents: currentParents,
          fields: 'id, name, parents',
          supportsAllDrives: true,
        });
        results.push({ id, file: updated.data });
      } catch (e) {
        results.push({ id, error: e?.message || 'Move failed' });
      }
    }

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ results });
  } catch (err) {
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: err?.message || 'Failed to move' });
  }
}

function extractId(input) {
  if (!input) return null;
  try {
    if (/^[A-Za-z0-9_-]{20,}$/.test(input)) return input;

    const u = new URL(input);
    const pathParts = u.pathname.split('/').filter(Boolean);
    const fileIndex = pathParts.findIndex((p) => p === 'file');
    if (fileIndex !== -1 && pathParts[fileIndex + 1] === 'd' && pathParts[fileIndex + 2]) {
      return pathParts[fileIndex + 2];
    }
    const qid = u.searchParams.get('id');
    if (qid) return qid;
  } catch {
    // ignore
  }
  return null;
}

export async function resolveDriveController(request, reply) {
  const url = request.query?.url || request.query?.u || '';
  const name = request.query?.name || '';
  const id = extractId(url);
  if (!id) {
    return reply.code(400).send({ error: 'Invalid Google Drive URL or ID' });
  }
  const to = `/watch/${encodeURIComponent(id)}${name ? `?name=${encodeURIComponent(name)}` : ''}`;
  reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
  reply.header('Pragma', 'no-cache');
  return reply.redirect(302, to);
}

export async function streamDriveController(request, reply) {
  const url = new URL(`${request.protocol}://${request.headers.host}${request.raw.url}`);
  const fromParams = request.params?.id;
  const fromQuery = url.searchParams.get('id');
  const pathParts = url.pathname.split('/').filter(Boolean);
  const streamIndex = pathParts.findIndex((p) => p === 'stream');
  const fromPath = streamIndex !== -1 ? pathParts[streamIndex + 1] : undefined;
  const id = fromParams || fromQuery || fromPath;
  const resourceKey = url.searchParams.get('resourceKey') || url.searchParams.get('resourcekey') || undefined;

  if (!id) {
    return reply.code(400).send({ error: 'Missing file id' });
  }

  try {
    const range = request.headers['range'] || request.headers['Range'];
    const accessToken = await getServiceAccountAccessToken();
    if (!accessToken) throw new Error('No access token available');

    const mediaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media${
      resourceKey ? `&resourceKey=${encodeURIComponent(resourceKey)}` : ''
    }`;

    const controller = new AbortController();
    request.raw.on('close', () => controller.abort());

    let res = await fetch(mediaUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(range ? { Range: range } : {}),
      },
      signal: controller.signal,
    });

    if (!res.ok && res.status !== 206) {
      try {
        const drive = getDrive();
        const driveRes = await drive.files.get(
          { fileId: id, alt: 'media', supportsAllDrives: true, resourceKey },
          { responseType: 'stream', headers: range ? { Range: range } : {} },
        );

        const srcHeaders = driveRes.headers || {};
        const status = range ? 206 : 200;
        reply
          .code(status)
          .header('Content-Type', srcHeaders['content-type'] || 'video/mp4')
          .header('Vary', 'Range')
          .header(
            'Cache-Control',
            'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800',
          );
        if (srcHeaders['content-length']) reply.header('Content-Length', srcHeaders['content-length']);
        if (srcHeaders['accept-ranges']) reply.header('Accept-Ranges', srcHeaders['accept-ranges']);
        if (srcHeaders['content-range']) reply.header('Content-Range', srcHeaders['content-range']);
        if (srcHeaders['etag']) reply.header('ETag', srcHeaders['etag']);
        if (srcHeaders['last-modified']) reply.header('Last-Modified', srcHeaders['last-modified']);

        return reply.send(driveRes.data);
      } catch (sdkErr) {
        request.log.error(
          {
            id,
            range,
            message: sdkErr?.message,
            stack: sdkErr?.stack,
            response: sdkErr?.response?.data,
            headers: sdkErr?.response?.headers,
          },
          'Drive stream fallback SDK error',
        );
        const text = await res.text().catch(() => '');
        return reply
          .code(res.status || 500)
          .send({ error: 'Failed to stream file', status: res.status, details: text?.slice(0, 500) });
      }
    }

    const srcType = res.headers.get('content-type');
    const srcLen = res.headers.get('content-length');
    const srcAccept = res.headers.get('accept-ranges');
    const srcRange = res.headers.get('content-range');
    const srcEtag = res.headers.get('etag');
    const srcLM = res.headers.get('last-modified');

    const status = range || srcRange ? 206 : 200;
    reply
      .code(status)
      .header('Content-Type', srcType || 'video/mp4')
      .header('Vary', 'Range')
      .header('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800');
    if (srcLen) reply.header('Content-Length', srcLen);
    if (srcAccept) reply.header('Accept-Ranges', srcAccept);
    if (srcRange) reply.header('Content-Range', srcRange);
    if (srcEtag) reply.header('ETag', srcEtag);
    if (srcLM) reply.header('Last-Modified', srcLM);

    return reply.send(res.body);
  } catch (err) {
    request.log.error(
      {
        id,
        message: err?.message,
        stack: err?.stack,
        response: err?.response?.data,
        headers: err?.response?.headers,
        code: err?.code,
      },
      'Drive stream error',
    );
    return reply.code(500).send({ error: 'Failed to stream file' });
  }
}

function guessNameFromUrl(u) {
  try {
    const url = new URL(u);
    const pathname = url.pathname || '';
    const last = pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last || 'download');
  } catch {
    return 'download';
  }
}

export async function uploadFromLinkDriveController(request, reply) {
  try {
    const body = request.body || {};
    const urls = Array.isArray(body?.urls)
      ? body.urls
      : typeof body?.url === 'string'
        ? [body.url]
        : [];
    const folderId = body?.folderId || 'root';

    if (!urls || urls.length === 0) {
      return reply.code(400).send({ error: 'No urls provided' });
    }

    const drive = getDrive();
    const results = [];

    for (const u of urls) {
      const url = String(u).trim();
      if (!url) continue;
      try {
        let filename = guessNameFromUrl(url);
        let mimeType = 'application/octet-stream';
        try {
          const head = await fetch(url, { method: 'HEAD' });
          const cd = head.headers.get('content-disposition') || '';
          const ct = head.headers.get('content-type') || '';
          if (ct) mimeType = ct;
          const m = cd.match(/filename\*=UTF-8''([^;\s]+)|filename="?([^";]+)"?/i);
          if (m) {
            filename = decodeURIComponent(m[1] || m[2] || filename);
          }
        } catch {
          // ignore HEAD errors
        }

        const res = await fetch(url);
        if (!res.ok || !res.body) {
          throw new Error(`Failed to download (${res.status})`);
        }

        const bodyStream =
          typeof Readable.fromWeb === 'function' ? Readable.fromWeb(res.body) : Readable.from(res.body);

        const created = await drive.files.create({
          requestBody: {
            name: filename,
            parents: [folderId],
          },
          media: {
            mimeType,
            body: bodyStream,
          },
          fields: 'id, name',
          supportsAllDrives: true,
          uploadType: 'multipart',
        });

        results.push({ url, file: created.data });
      } catch (e) {
        results.push({ url, error: e?.message || 'Upload failed' });
      }
    }

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ results });
  } catch (err) {
    request.log.error(
      {
        message: err?.message,
        stack: err?.stack,
      },
      'Upload from link error',
    );
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Failed to upload from link' });
  }
}
