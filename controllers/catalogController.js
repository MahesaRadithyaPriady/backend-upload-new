import { listFoldersByParent, listFilesByFolder, getFolderByPrefix } from '../lib/storageCatalogDb.js';

export async function listCatalogController(request, reply) {
  try {
    const query = request.query || {};
    const prefixRaw = query.prefix || '';
    const type = String(query.type || 'all').toLowerCase(); // folder | file | all
    const page = Number(query.page || 1);
    const pageSize = Number(query.pageSize || 50);

    const limit = Math.min(Math.max(pageSize, 1), 500);
    const offset = (Math.max(page, 1) - 1) * limit;

    const basePrefix = String(prefixRaw)
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean)
      .join('/');

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
          .send({ folders: [], files: [], page, pageSize: limit, hasMore: false });
      }
      parentFolderId = folder.id;
    }

    let folders = [];
    let files = [];

    if (type === 'folder' || type === 'all') {
      folders = listFoldersByParent({ parentId: parentFolderId, limit, offset });
    }

    if (type === 'file' || type === 'all') {
      // Files are always tied to the current folder (not parent of current prefix)
      const folderIdForFiles = normalizedPrefix ? parentFolderId : null;
      files = listFilesByFolder({ folderId: folderIdForFiles, limit, offset });
    }

    const hasMore = folders.length + files.length === limit;

    return reply
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ folders, files, page, pageSize: limit, hasMore });
  } catch (err) {
    request.log?.error?.(
      {
        message: err?.message,
        stack: err?.stack,
      },
      'Catalog list error',
    );
    return reply
      .code(500)
      .headers({
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
      .send({ error: 'Failed to list catalog', details: err?.message });
  }
}
