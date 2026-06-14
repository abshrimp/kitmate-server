import { Hono } from 'hono';

// GET /api/health → { ok: true }
export const healthRoutes = new Hono();

healthRoutes.get('/', (c) => c.json({ ok: true }));
