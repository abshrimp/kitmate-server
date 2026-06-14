import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import './db.js'; // DB 初期化 (テーブル作成)
import { initVapid } from './lib/push.js';
import { startCancellationWatcher } from './watcher.js';
import { healthRoutes } from './routes/health.js';
import { coursesRoutes } from './routes/courses.js';
import { requirementsRoutes } from './routes/requirements.js';
import { cancellationsRoutes } from './routes/cancellations.js';
import { shareRoutes, sharePageRoutes } from './routes/share.js';
import { syncRoutes } from './routes/sync.js';
import { pushRoutes } from './routes/push.js';

initVapid(); // VAPID 鍵: 初回起動時に生成し meta テーブルへ保存・再利用

const app = new Hono();

app.use('*', cors());

app.route('/api/health', healthRoutes);
app.route('/api/courses', coursesRoutes);
app.route('/api/requirements', requirementsRoutes);
app.route('/api/cancellations', cancellationsRoutes);
app.route('/api/share', shareRoutes);
app.route('/share', sharePageRoutes);
app.route('/api/sync', syncRoutes);
app.route('/api/push', pushRoutes);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

app.onError((err, c) => {
  console.error('[server] unhandled error:', err);
  return c.json({ error: 'internal_error' }, 500);
});

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`KITmate server listening on http://localhost:${info.port}`);
});

startCancellationWatcher(); // 休講ウォッチャ (10分毎, PUSH_DISABLED=1 で無効化)

export default app;
