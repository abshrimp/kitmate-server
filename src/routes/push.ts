import { Hono } from 'hono';
import { db } from '../db.js';
import { getVapidPublicKey } from '../lib/push.js';
import { pushRegisterSchema, pushUnregisterSchema } from '../lib/schemas.js';

// POST /api/push/register   body: PushRegisterBody → 購読登録 (upsert)
// POST /api/push/unregister body: PushUnregisterBody → 解除
// GET  /api/push/vapid-public-key → { publicKey }
export const pushRoutes = new Hono();

pushRoutes.post('/register', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const parsed = pushRegisterSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  }
  const { platform, token, subscription, cancellationNotifications, lectureInfoNotifications } = parsed.data;
  const cancellation = cancellationNotifications ? 1 : 0;
  // 授業関連連絡フラグは省略時は休講と同値(旧クライアント互換)
  const notice = (lectureInfoNotifications ?? cancellationNotifications) ? 1 : 0;
  const now = Date.now();

  if (platform === 'expo') {
    const updated = db
      .prepare("UPDATE push_subscriptions SET cancellation = ?, notice = ? WHERE platform = 'expo' AND token = ?")
      .run(cancellation, notice, token);
    if (updated.changes === 0) {
      db.prepare(
        "INSERT INTO push_subscriptions (platform, token, endpoint, subscription, cancellation, notice, created_at) VALUES ('expo', ?, NULL, NULL, ?, ?, ?)",
      ).run(token, cancellation, notice, now);
    }
  } else {
    const endpoint = subscription?.endpoint ?? '';
    const subscriptionJson = JSON.stringify(subscription);
    const updated = db
      .prepare("UPDATE push_subscriptions SET subscription = ?, cancellation = ?, notice = ? WHERE platform = 'web' AND endpoint = ?")
      .run(subscriptionJson, cancellation, notice, endpoint);
    if (updated.changes === 0) {
      db.prepare(
        "INSERT INTO push_subscriptions (platform, token, endpoint, subscription, cancellation, notice, created_at) VALUES ('web', NULL, ?, ?, ?, ?, ?)",
      ).run(endpoint, subscriptionJson, cancellation, notice, now);
    }
  }
  return c.json({ ok: true });
});

pushRoutes.post('/unregister', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const parsed = pushUnregisterSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  }
  const { platform, token, endpoint } = parsed.data;

  if (platform === 'expo') {
    db.prepare("DELETE FROM push_subscriptions WHERE platform = 'expo' AND token = ?").run(token);
  } else {
    db.prepare("DELETE FROM push_subscriptions WHERE platform = 'web' AND endpoint = ?").run(endpoint);
  }
  return c.json({ ok: true });
});

pushRoutes.get('/vapid-public-key', (c) => c.json({ publicKey: getVapidPublicKey() }));
