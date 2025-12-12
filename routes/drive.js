import {
  listDriveController,
  copyDriveController,
  createFolderDriveController,
  deleteDriveController,
  renameDriveController,
  metaDriveController,
  moveDriveController,
  resolveDriveController,
  streamDriveController,
  uploadFromLinkDriveController,
} from '../controllers/driveController.js';
import { uploadDriveController, uploadProgressDriveController } from '../controllers/uploadController.js';

export function registerDriveRoutes(fastify) {
  fastify.get('/drive/list', listDriveController);
  fastify.post('/drive/copy', copyDriveController);
  fastify.post('/drive/create-folder', createFolderDriveController);
  fastify.delete('/drive/delete', deleteDriveController);
  fastify.post('/drive/rename', renameDriveController);
  // Support both /drive/meta?id=... and /drive/meta/:id
  fastify.get('/drive/meta', metaDriveController);
  fastify.get('/drive/meta/:id', metaDriveController);
  fastify.post('/drive/move', moveDriveController);
  fastify.get('/drive/resolve', resolveDriveController);
  fastify.get('/drive/stream/:id', streamDriveController);
  fastify.post('/drive/upload-from-link', uploadFromLinkDriveController);
  fastify.post('/drive/upload', uploadDriveController);
  fastify.get('/drive/upload/progress', uploadProgressDriveController);
}
