import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import dotenv from 'dotenv';

import { registerAuthRoutes } from './routes/auth.js';
import { registerB2Routes } from './routes/b2.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import {registerDriveRoutes} from './routes/drive.js'

dotenv.config();

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
  
fastify.register(fastifyCors, {
  origin: allowedCorsOrigins,
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

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || '0.0.0.0';

fastify
  .listen({ port, host })
  .then(() => {
    fastify.log.info(`Server listening on http://${host}:${port}`);
  })
  .catch((err) => {
    fastify.log.error(err);
    process.exit(1);
  });
