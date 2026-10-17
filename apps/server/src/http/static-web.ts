import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';

/**
 * Serves the built SPA from the same origin as /api (Section 22). Hashed assets are cached
 * immutably; index.html is never cached. The SPA fallback never applies to /api paths.
 * Returns null when no build is present.
 */
export function createStaticWebRouter(webDistDir: string): Router | null {
  const indexFile = path.join(webDistDir, 'index.html');
  if (!fs.existsSync(indexFile)) return null;

  const router = express.Router();
  router.use(
    '/assets',
    express.static(path.join(webDistDir, 'assets'), {
      immutable: true,
      maxAge: '365d',
      index: false,
    }),
  );
  // A missing hashed asset is a plain 404, never the SPA shell (which would break MIME checks).
  router.use('/assets', (_req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
  router.use(
    express.static(webDistDir, {
      index: false,
      maxAge: 0,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    }),
  );
  router.get(/^\/(?!api(?:\/|$)).*/, (req, res, next) => {
    if (!req.accepts('html')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexFile);
  });
  return router;
}
