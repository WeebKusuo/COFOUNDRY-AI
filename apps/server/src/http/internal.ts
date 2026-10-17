import express, { type Express } from 'express';
import type { Connection } from 'mongoose';
import { computeReadiness } from '../db/readiness.js';
import { requestContext } from './middleware/request-context.js';
import { sendData, sendError } from './respond.js';

/**
 * Internal readiness app. It listens on 127.0.0.1 on a separate port, so the reverse proxy never
 * exposes it publicly (a loopback check on the public port would be unsafe behind a local proxy).
 */
export function createInternalApp(getConnection: () => Connection | null): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext);
  app.get('/ready', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const conn = getConnection();
    if (!conn) {
      sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Database not connected.');
      return;
    }
    const report = await computeReadiness(conn);
    sendData(res, report, report.status === 'ready' ? 200 : 503);
  });
  app.use((_req, res) => sendError(res, 404, 'NOT_FOUND', 'Not found.'));
  return app;
}
