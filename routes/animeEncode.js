import {
  startAnimeEncodeController,
  animeEncodeJobStatusController,
  cancelAnimeEncodeJobController,
} from '../controllers/animeEncodeController.js';
import {
  syncHlsEpisodeController,
  syncHlsBulkController,
  getHlsRecordsController,
  refreshMasterSizeController,
} from '../controllers/hlsSyncController.js';
import {
  deleteHlsByUrlController,
  deleteHlsByPrefixController,
  deleteHlsEpisodeController,
} from '../controllers/hlsDeleteController.js';
import {
  startPopularEncodeController,
  stopPopularEncodeController,
  statusPopularEncodeController,
} from '../controllers/popularEncodeController.js';

export function registerAnimeEncodeRoutes(fastify) {
  fastify.post('/encode/anime', startAnimeEncodeController);
  fastify.get('/encode/anime/job/:id', animeEncodeJobStatusController);
  fastify.delete('/encode/anime/job/:id', cancelAnimeEncodeJobController);

  fastify.post('/encode/anime/sync/bulk', syncHlsBulkController);
  fastify.post('/encode/anime/sync/:episodeId', syncHlsEpisodeController);
  fastify.get('/encode/anime/records', getHlsRecordsController);
  fastify.get('/encode/anime/records/:episodeId', getHlsRecordsController);
  fastify.post('/encode/anime/records/:episodeId/refresh-size', refreshMasterSizeController);

  fastify.delete('/encode/anime/hls/file', deleteHlsByUrlController);
  fastify.delete('/encode/anime/hls/prefix', deleteHlsByPrefixController);
  fastify.delete('/encode/anime/hls/episode/:episodeId', deleteHlsEpisodeController);

  // Popular encode routes di encapsulated scope dengan custom parser untuk empty body
  fastify.register(async function popularRoutes(subFastify) {
    // Custom parser untuk JSON yang menerima empty body
    subFastify.addContentTypeParser('application/json', { parseAs: 'string' }, function (req, body, done) {
      try {
        const json = body && body.trim() ? JSON.parse(body) : {};
        done(null, json);
      } catch (err) {
        done(err, {});
      }
    });

    subFastify.post('/encode/anime/popular/start', startPopularEncodeController);
    subFastify.post('/encode/anime/popular/stop', stopPopularEncodeController);
    subFastify.get('/encode/anime/popular/status', statusPopularEncodeController);
  });
}
