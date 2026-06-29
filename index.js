import dotenv from 'dotenv';
dotenv.config();

console.log('[DEBUG] ADMIN_API_BASE from env:', process.env.ADMIN_API_BASE);

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';


import { clearAllJobs } from './lib/uploadJobsDb.js';

import { registerAuthRoutes } from './routes/auth.js';
import { registerB2Routes } from './routes/b2.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import {registerDriveRoutes} from './routes/drive.js'
import { registerEncodeRoutes } from './routes/encode.js';
import { registerAnimeEncodeRoutes } from './routes/animeEncode.js';
import { startPopularEncodeJob } from './lib/popularEncodeJob.js';

const corsOrigins = String(process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const allowedCorsOrigins = corsOrigins.length ? corsOrigins : ['http://localhost:5173'];

const fastify = Fastify({
  logger: true,
  // ~5GB body limit to support large uploads (actual streaming still handled by multipart)
  bodyLimit: 5 * 1024 * 1024 * 1024,
});

// Treat binary/video request bodies as streams (for direct PUT upload flow)
fastify.addContentTypeParser('application/octet-stream', (req, payload, done) => {
  done(null, payload);
});
fastify.addContentTypeParser(/^video\//, (req, payload, done) => {
  done(null, payload);
});
  
fastify.register(fastifyCors, {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

fastify.register(multipart, {
  limits: {
    // Per-file limit ~5GB
    fileSize: 5 * 1024 * 1024 * 1024,
  },
});

fastify.register(cookie, {
  secret: process.env.COOKIE_SECRET || 'changeme',
});

registerAuthRoutes(fastify);
registerB2Routes(fastify);
registerCatalogRoutes(fastify);
registerDriveRoutes(fastify);
registerEncodeRoutes(fastify);
registerAnimeEncodeRoutes(fastify);

clearAllJobs().then(() => {
  fastify.log.info('Cleared persisted upload jobs on startup');
}).catch((err) => {
  fastify.log.error({ err }, 'Failed to clear upload jobs on startup');
});

const port = Number(process.env.PORT || config.PORT || 4000);
const host = process.env.HOST || '0.0.0.0';

fastify
  .listen({ port, host })
  .then(() => {
    fastify.log.info(`Server listening on http://${host}:${port}`);
    startPopularEncodeJob();
  })
  .catch((err) => {
    fastify.log.error(err);
    process.exit(1);
  });
