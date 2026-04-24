import { prisma } from './prisma.js';

export async function upsertFolder({ name, prefix, parentId = null, fileCount = null }) {
  if (!name || !prefix) throw new Error('name and prefix are required for upsertFolder');
  await prisma.folder.upsert({
    where: { prefix },
    update: {
      name,
      parentId,
      ...(fileCount != null ? { fileCount } : {}),
    },
    create: { name, prefix, parentId, fileCount },
  });
}

export async function getFolderByPrefix(prefix) {
  if (!prefix) throw new Error('prefix is required for getFolderByPrefix');
  return prisma.folder.findUnique({ where: { prefix } });
}

export async function listFoldersByParent({ parentId = null, limit = 50, offset = 0 } = {}) {
  return prisma.folder.findMany({
    where: { parentId: parentId ?? null },
    orderBy: { name: 'asc' },
    take: limit,
    skip: offset,
  });
}

export async function upsertFile({ folderId, fileName, filePath, size = 0, contentType = 'application/octet-stream', uploadedAt = null }) {
  if (!fileName || !filePath) {
    throw new Error('fileName and filePath are required for upsertFile');
  }
  const uploadedAtDate = uploadedAt ? new Date(uploadedAt) : new Date();
  await prisma.file.upsert({
    where: { filePath },
    update: { folderId: folderId ?? null, fileName, size: BigInt(size), contentType, uploadedAt: uploadedAtDate },
    create: { folderId: folderId ?? null, fileName, filePath, size: BigInt(size), contentType, uploadedAt: uploadedAtDate },
  });
}

export async function listFilesByFolder({ folderId, limit = 50, offset = 0 } = {}) {
  const rows = await prisma.file.findMany({
    where: { folderId: folderId ?? null },
    orderBy: { fileName: 'asc' },
    take: limit,
    skip: offset,
  });
  return rows.map((r) => ({ ...r, size: Number(r.size) }));
}

export async function deleteFileByPath(filePath) {
  if (!filePath) throw new Error('filePath is required for deleteFileByPath');
  await prisma.file.deleteMany({ where: { filePath } });
}

export async function deleteFilesByPrefix(prefix) {
  const cleaned = String(prefix || '')
    .replace(/^\/+|\/+$/g, '')
    .trim();
  if (!cleaned) return;
  const normalized = `${cleaned}/`;
  await prisma.file.deleteMany({ where: { filePath: { startsWith: normalized } } });
}

export async function deleteFoldersByPrefix(prefix) {
  const cleaned = String(prefix || '')
    .replace(/^\/+|\/+$/g, '')
    .trim();
  if (!cleaned) return;
  const normalized = `${cleaned}/`;
  await prisma.folder.deleteMany({
    where: {
      OR: [
        { prefix: normalized },
        { prefix: { startsWith: normalized } },
      ],
    },
  });
}

export async function incrementFolderFileCount(folderId) {
  if (folderId == null) return;
  await prisma.folder.update({
    where: { id: folderId },
    data: { fileCount: { increment: 1 } },
  });
}

export async function updateFilePathAndName({ oldPath, newPath, newName }) {
  if (!oldPath || !newPath || !newName) {
    throw new Error('oldPath, newPath, and newName are required for updateFilePathAndName');
  }
  await prisma.file.updateMany({
    where: { filePath: oldPath },
    data: { filePath: newPath, fileName: newName },
  });
}

export { prisma };
