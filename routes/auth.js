import { loginController } from '../controllers/authController.js';

export function registerAuthRoutes(fastify) {
  fastify.post('/auth/login', loginController);
}
