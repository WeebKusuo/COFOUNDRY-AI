import express, { type Express, type RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { API_PREFIX, LIMITS } from '@cofoundry/shared';
import type { AppConfig } from '../config/env.js';
import type { Logger } from '../lib/logger.js';
import { noStore, requestContext } from './middleware/request-context.js';
import { requireJsonBody, requireSameOrigin, securityHeaders } from './middleware/security.js';
import { generalApiLimiter } from './middleware/rate-limit.js';
import { apiNotFound, errorHandler } from './middleware/error-handler.js';
import { createV1Router } from './routes/v1.js';
import { createStaticWebRouter } from './static-web.js';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  /** Override the general API limiter (tests use a tiny window). */
  apiRateLimiter?: RequestHandler;
  /** Extra routers mounted under /api/v1 before the 404 handler (tests only in Phase 1). */
  extraV1Routes?: (router: express.Router) => void;
}

function pathOnly(url: string | undefined): string {
  if (!url) return '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Builds the Express application without opening sockets or database connections, so tests
 * can exercise the full middleware stack with supertest.
 */
export function createApp(deps: AppDependencies): Express {
  const { config, logger } = deps;
  const app = express();

  app.disable('x-powered-by');
  // Trust only the explicitly configured number of reverse-proxy hops (Section 22).
  app.set('trust proxy', config.trustProxyHops);

  app.use(requestContext);
  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => (res as express.Response).locals.requestId as string,
      autoLogging: { ignore: (req) => pathOnly(req.url) === `${API_PREFIX}/health` },
      serializers: {
        // Paths only: query strings may carry sensitive values (Section 25).
        req: (req: { method?: string; url?: string; id?: unknown }) => ({
          id: req.id,
          method: req.method,
          path: pathOnly(req.url),
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(securityHeaders({ hsts: config.isProduction }));

  const api = express.Router();
  api.use(noStore);
  api.use(deps.apiRateLimiter ?? generalApiLimiter());
  api.use(requireSameOrigin(config.appOrigin));
  api.use(requireJsonBody);
  api.use(express.json({ limit: LIMITS.jsonBodyBytes, strict: true, type: 'application/json' }));

  const v1 = createV1Router();
  deps.extraV1Routes?.(v1);
  api.use('/v1', v1);
  api.use(apiNotFound);

  app.use('/api', api);

  if (config.serveWeb) {
    const web = createStaticWebRouter(config.webDistDir);
    if (web) {
      app.use(web);
    } else {
      logger.warn({ webDistDir: config.webDistDir }, 'web build not found; SPA is not served');
    }
  }

  app.use(errorHandler);
  return app;
}
