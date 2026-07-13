/**
 * SRV-06 / #79 — shared body-size limit for /api/* routes.
 *
 * JSON / non-multipart: 1 MiB (issue acceptance).
 * multipart/form-data: 5 MiB total (matches per-file MAX_FILE_BYTES on /api/files).
 *
 * Uses hono/body-limit so Content-Length *and* chunked/streaming bodies are
 * enforced (the old judge-only Content-Length check missed chunked).
 */

import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

export const JSON_BODY_MAX_BYTES = 1 * 1024 * 1024;
export const MULTIPART_BODY_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Middleware for app.use('/api/*', apiBodyLimit()).
 * Picks max size from Content-Type so file uploads keep the 5MB envelope.
 */
export function apiBodyLimit(): MiddlewareHandler {
  const jsonLimit = bodyLimit({
    maxSize: JSON_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: 'payload too large' }, 413),
  });
  const multipartLimit = bodyLimit({
    maxSize: MULTIPART_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: 'payload too large' }, 413),
  });

  return async (c, next) => {
    const ct = c.req.header('content-type') ?? '';
    if (ct.toLowerCase().includes('multipart/form-data')) {
      return multipartLimit(c, next);
    }
    return jsonLimit(c, next);
  };
}
