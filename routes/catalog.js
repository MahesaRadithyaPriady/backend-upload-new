import { listCatalogController } from '../controllers/catalogController.js';

export function registerCatalogRoutes(fastify) {
  fastify.get('/catalog/list', listCatalogController);
}
