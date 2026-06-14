import { Hono } from 'hono';
import { db } from '../db.js';
import { verifyMoodleToken } from '../lib/moodle.js';
import { syncPutBodySchema } from '../lib/schemas.js';
import type { TimetableEntry } from '../types.js';

// GET/PUT /api/sync/timetable (ヘッダ X-Moodle-Token)
// Moodle core_webservice_get_site_info でトークン検証(10分メモリキャッシュ)し、
// username をキーに { entries: TimetableEntry[], updatedAt } を保存/取得する。
export const syncRoutes = new Hono();

interface TimetableRow {
  payload: string;
  updated_at: number | null;
}

async function authenticate(token: string | undefined): Promise<
  | { ok: true; username: string }
  | { ok: false; status: 401 | 502 | 503; error: string }
> {
  if (!token) return { ok: false, status: 401, error: 'missing_token' };
  return verifyMoodleToken(token);
}

syncRoutes.get('/timetable', async (c) => {
  const auth = await authenticate(c.req.header('X-Moodle-Token'));
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  const row = db
    .prepare('SELECT payload, updated_at FROM timetables WHERE username = ?')
    .get(auth.username) as TimetableRow | undefined;
  if (!row) return c.json({ entries: [], updatedAt: null });

  let entries: TimetableEntry[] = [];
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (Array.isArray(parsed)) entries = parsed as TimetableEntry[];
  } catch (e) {
    console.error('[sync] broken payload for user:', e);
  }
  return c.json({ entries, updatedAt: row.updated_at ?? null });
});

syncRoutes.put('/timetable', async (c) => {
  const auth = await authenticate(c.req.header('X-Moodle-Token'));
  if (!auth.ok) return c.json({ error: auth.error }, auth.status);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const parsed = syncPutBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  }

  const updatedAt = Date.now();
  db.prepare(
    `INSERT INTO timetables (username, payload, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  ).run(auth.username, JSON.stringify(parsed.data.entries), updatedAt);

  return c.json({ ok: true, updatedAt });
});
