import { prisma } from './prisma.js';

export async function upsertFileMapping(driveFileId, b2ObjectKey, status = 'migrated') {
  await prisma.fileMapping.upsert({
    where: { driveFileId },
    update: { b2ObjectKey, status },
    create: { driveFileId, b2ObjectKey, status },
  });
}

export async function getFileMapping(driveFileId) {
  return prisma.fileMapping.findUnique({ where: { driveFileId } });
}

export async function upsertDriveB2Mapping({
  driveFileId,
  drivePath = null,
  driveFolderId = null,
  driveDriveId = null,
  b2ObjectKey,
  b2Prefix = null,
  b2CatalogFolderId = null,
  status = 'linked',
} = {}) {
  if (!driveFileId || !b2ObjectKey) {
    throw new Error('driveFileId and b2ObjectKey are required for upsertDriveB2Mapping');
  }
  await prisma.driveB2Mapping.upsert({
    where: { driveFileId },
    update: { drivePath, driveFolderId, driveDriveId, b2ObjectKey, b2Prefix, b2CatalogFolderId, status },
    create: { driveFileId, drivePath, driveFolderId, driveDriveId, b2ObjectKey, b2Prefix, b2CatalogFolderId, status },
  });
}

export async function getDriveB2MappingByDriveId(driveFileId) {
  if (!driveFileId) throw new Error('driveFileId is required for getDriveB2MappingByDriveId');
  return prisma.driveB2Mapping.findUnique({ where: { driveFileId } });
}

export async function getDriveB2MappingByDrivePath(drivePath) {
  if (!drivePath) throw new Error('drivePath is required for getDriveB2MappingByDrivePath');
  return prisma.driveB2Mapping.findFirst({ where: { drivePath } });
}

export async function getDriveB2MappingByB2ObjectKey(b2ObjectKey) {
  if (!b2ObjectKey) throw new Error('b2ObjectKey is required for getDriveB2MappingByB2ObjectKey');
  return prisma.driveB2Mapping.findUnique({ where: { b2ObjectKey } });
}

export { prisma };
