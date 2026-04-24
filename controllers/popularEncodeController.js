import { startPopularEncodeJob, stopPopularEncodeJob, getPopularEncodeStatus } from '../lib/popularEncodeJob.js';

export async function startPopularEncodeController(request, reply) {
  const enabled = String(process.env.ENABLE_POPULAR_ENCODE_JOB || 'false').toLowerCase() === 'true';
  if (!enabled) {
    return reply.code(403).send({
      error: 'Popular encode job disabled. Set ENABLE_POPULAR_ENCODE_JOB=true in env.',
      envEnabled: false,
    });
  }

  startPopularEncodeJob();
  const status = await getPopularEncodeStatus();
  return reply.send({
    success: true,
    message: 'Popular encode job started',
    status,
  });
}

export async function stopPopularEncodeController(request, reply) {
  stopPopularEncodeJob();
  const status = await getPopularEncodeStatus();
  return reply.send({
    success: true,
    message: 'Popular encode job stopped',
    status,
  });
}

export async function statusPopularEncodeController(request, reply) {
  const status = await getPopularEncodeStatus();
  return reply.send({ status });
}
