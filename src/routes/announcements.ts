import { Hono } from 'hono';
import { z } from 'zod';
import { createAnnouncement, listAnnouncements } from '../lib/announcements.js';
import { broadcastToAll } from '../lib/push.js';

// GET  /api/announcements        → 最近のお知らせ一覧 (公開)
// POST /api/announcements        → お知らせ投稿 (管理 API キー必須) → 保存 + 全購読者へ push
export const announcementsRoutes = new Hono();

const bodySchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
});

announcementsRoutes.get('/', (c) => {
  return c.json({ announcements: listAnnouncements() });
});

announcementsRoutes.post('/', async (c) => {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return c.json({ error: 'admin_not_configured' }, 503);
  if (c.req.header('x-admin-key') !== adminKey) return c.json({ error: 'unauthorized' }, 401);

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);

  const announcement = createAnnouncement(parsed.data.title, parsed.data.body);
  // 全購読者へ push (失敗してもお知らせ自体は保存済み)
  broadcastToAll([{ title: parsed.data.title, body: parsed.data.body }]).catch((e) =>
    console.error('[announcements] push failed:', e),
  );
  return c.json({ id: announcement.id });
});
