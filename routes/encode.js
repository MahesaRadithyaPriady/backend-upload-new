import {
  encodeInfoController,
  startEncodeController,
  encodeAndUploadController,
  encodeJobStatusController,
  listEncodeJobsController,
  cancelEncodeJobController,
  encodeJobSseController,
} from '../controllers/encodeController.js';

export function registerEncodeRoutes(fastify) {
  fastify.get('/encode/info', encodeInfoController);
  fastify.post('/encode/start', startEncodeController);
  fastify.post('/encode/start-and-upload', encodeAndUploadController);
  fastify.get('/encode/job/:id', encodeJobStatusController);
  fastify.get('/encode/job', encodeJobStatusController);
  fastify.get('/encode/jobs', listEncodeJobsController);
  fastify.delete('/encode/job/:id', cancelEncodeJobController);
  fastify.delete('/encode/job', cancelEncodeJobController);
  fastify.get('/encode/job-sse/:id', { cors: { credentials: false } }, encodeJobSseController);
  fastify.get('/encode/job-sse', { cors: { credentials: false } }, encodeJobSseController);
}
