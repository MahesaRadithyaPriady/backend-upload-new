import { listB2Controller, listB2VideosController, streamB2Controller, listB2FoldersController, createB2FolderController, deleteB2FileController, renameB2FileController, getB2StreamUrlController } from '../controllers/b2Controller.js';
import {
  uploadB2AndCatalogController,
  uploadB2FolderMultipartController,
  getB2UploadUrlController,
  commitB2UploadController,
  getB2S3PresignPutController,
  getB2S3PresignPutBatchController,
  importB2ByUrlController,
  createDirectUploadLinkController,
  directUploadPutController,
  deleteUploadJobController,
  getUploadJobController,
  getUploadJobByPrefixController,
  listUploadJobsController,
  streamUploadJobsSseController,
  streamUploadJobSseController,
} from '../controllers/uploadController.js';

export function registerB2Routes(fastify) {
  fastify.get('/b2/list', listB2Controller);
  fastify.get('/b2/folders', listB2FoldersController);
  fastify.post('/b2/folder', createB2FolderController);
  fastify.get('/b2/videos', listB2VideosController);
  fastify.get('/b2/stream-url', { cors: { credentials: false } }, getB2StreamUrlController);
  fastify.get('/b2/stream/:id', { cors: { credentials: false } }, streamB2Controller);
  fastify.delete('/b2/file', deleteB2FileController);
  fastify.post('/b2/rename', renameB2FileController);
  fastify.get('/b2/upload-url', getB2UploadUrlController);
  fastify.get('/b2/s3-presign', getB2S3PresignPutController);
  fastify.post('/b2/s3-presign-batch', getB2S3PresignPutBatchController);
  fastify.post('/b2/upload', commitB2UploadController);
  fastify.post('/b2/upload-multipart', uploadB2AndCatalogController);
  fastify.post('/b2/upload-folder-multipart', uploadB2FolderMultipartController);
  fastify.post('/b2/import-by-url', importB2ByUrlController);
  fastify.post('/b2/direct-upload-link', createDirectUploadLinkController);
  fastify.put('/b2/direct-upload/:token', directUploadPutController);
  fastify.get('/b2/upload-job/:id', getUploadJobController);
  fastify.get('/b2/upload-job', getUploadJobController);
  fastify.get('/b2/upload-job-by-prefix', getUploadJobByPrefixController);
  fastify.delete('/b2/upload-job/:id', deleteUploadJobController);
  fastify.delete('/b2/upload-job', deleteUploadJobController);
  fastify.get('/b2/upload-jobs', listUploadJobsController);
  fastify.get('/b2/upload-jobs-sse', { cors: { credentials: false } }, streamUploadJobsSseController);
  fastify.get('/b2/upload-job-sse/:id', { cors: { credentials: false } }, streamUploadJobSseController);
  fastify.get('/b2/upload-job-sse', { cors: { credentials: false } }, streamUploadJobSseController);
}
