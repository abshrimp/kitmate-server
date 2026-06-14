import { Hono } from 'hono';
import { getCancellationFeed } from '../lib/cancelFeed.js';

// GET /api/cancellations → CancellationFeed
// KIT ポータルを直接スクレイプ(1 分キャッシュ: メモリ + meta テーブル)して正規化。
// 取得失敗時はキャッシュを返し、キャッシュも無ければ 502 を返す(フォールバックなし)。
export const cancellationsRoutes = new Hono();

cancellationsRoutes.get('/', async (c) => {
  try {
    const feed = await getCancellationFeed();
    return c.json(feed);
  } catch (e) {
    console.error('[cancellations] route failed:', e);
    return c.json({ error: 'cancellations_unavailable' }, 502);
  }
});
