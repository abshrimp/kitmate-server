import { Hono } from 'hono';
import { getCancellationFeed } from '../lib/cancelFeed.js';

// GET /api/cancellations → CancellationFeed
// https://ebii.net/cancel.json を 10 分キャッシュ(メモリ + meta テーブル)で中継し正規化。
// 取得失敗時はキャッシュを返し、キャッシュも無ければ空 feed。
export const cancellationsRoutes = new Hono();

cancellationsRoutes.get('/', async (c) => {
  const feed = await getCancellationFeed();
  return c.json(feed);
});
