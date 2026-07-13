/**
 * SRV-06 / #79 — shared /api body size limit.
 */
import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import {
  apiBodyLimit,
  JSON_BODY_MAX_BYTES,
  MULTIPART_BODY_MAX_BYTES,
} from '../server/lib/api-body-limit';

function appWithLimit(): Hono {
  const app = new Hono();
  app.use('/api/*', apiBodyLimit());
  app.post('/api/echo', async (c) => c.json({ ok: true, n: (await c.req.text()).length }));
  app.get('/api/health', (c) => c.json({ ok: true }));
  return app;
}

describe('apiBodyLimit (SRV-06 / #79)', () => {
  test('constants match acceptance (1MB JSON / 5MB multipart)', () => {
    expect(JSON_BODY_MAX_BYTES).toBe(1 * 1024 * 1024);
    expect(MULTIPART_BODY_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  test('GET /api/health is unaffected', async () => {
    const app = appWithLimit();
    const r = await app.request('http://x/api/health');
    expect(r.status).toBe(200);
  });

  test('JSON under 1MB is accepted', async () => {
    const app = appWithLimit();
    const body = JSON.stringify({ text: 'hi' });
    const r = await app.request('http://x/api/echo', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    });
    expect(r.status).toBe(200);
  });

  test('JSON over 1MB returns 413 payload too large', async () => {
    const app = appWithLimit();
    const body = 'x'.repeat(JSON_BODY_MAX_BYTES + 1);
    const r = await app.request('http://x/api/echo', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    });
    expect(r.status).toBe(413);
    const j = (await r.json()) as { error: string };
    expect(j.error).toBe('payload too large');
  });

  test('multipart over 5MB returns 413', async () => {
    const app = appWithLimit();
    const body = 'y'.repeat(MULTIPART_BODY_MAX_BYTES + 1);
    const r = await app.request('http://x/api/echo', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'multipart/form-data; boundary=----x',
        'content-length': String(body.length),
      },
    });
    expect(r.status).toBe(413);
  });

  test('multipart under 5MB is not rejected by the 1MB JSON cap', async () => {
    const app = appWithLimit();
    // 1.5MB is over JSON cap but under multipart cap
    const body = 'z'.repeat(JSON_BODY_MAX_BYTES + 100_000);
    const r = await app.request('http://x/api/echo', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'multipart/form-data; boundary=----x',
        'content-length': String(body.length),
      },
    });
    expect(r.status).toBe(200);
  });
});
