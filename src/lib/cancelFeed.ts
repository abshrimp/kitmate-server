import { getMeta, setMeta } from '../db.js';
import { fetchFeedFromPortal, hasPortalCredentials } from './kitPortal.js';
import type { CancellationFeed } from '../types.js';

// 休講通知・授業関連連絡を CancellationFeed として提供する。
// - 取得元は KIT ポータルの直接スクレイプ (kitPortal.ts) のみ。フォールバックは持たない。
//   KIT_USER_ID / KIT_PASSWORD 未設定、または取得失敗時はエラーを伝播する。
// - 1 分メモリキャッシュ + DB (meta テーブル) キャッシュ。
// - 取得失敗時は直近のキャッシュ(メモリ → DB)を返し、キャッシュも無ければエラーを throw。

const CACHE_TTL_MS = 60 * 1000; // 1 分 (watcher と同頻度)
const META_CACHE_KEY = 'cancellations.cache';

let memoryCache: { feed: CancellationFeed; at: number } | null = null;

/**
 * KIT ポータルから必ず取りに行く。成功時はキャッシュを更新。
 * 認証情報が無い場合・取得に失敗した場合は throw する(フォールバックなし)。
 * リトライ(セッション切れ時の再ログイン)は kitPortal 側で実施済み。
 */
export async function fetchFreshFeed(): Promise<CancellationFeed> {
  if (!hasPortalCredentials()) {
    throw new Error('[cancellations] KIT_USER_ID / KIT_PASSWORD not set');
  }
  const feed = await fetchFeedFromPortal();
  memoryCache = { feed, at: Date.now() };
  try {
    setMeta(META_CACHE_KEY, JSON.stringify(feed));
  } catch (e) {
    console.error('[cancellations] failed to persist cache:', e);
  }
  return feed;
}

function readDbCache(): CancellationFeed | null {
  const raw = getMeta(META_CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CancellationFeed;
    if (Array.isArray(parsed.notices) && Array.isArray(parsed.cancellations)) return parsed;
  } catch (e) {
    console.error('[cancellations] broken DB cache:', e);
  }
  return null;
}

/**
 * 1 分キャッシュ付き取得。失敗時は直近のキャッシュ(メモリ → DB)を返す。
 * キャッシュも無い場合はエラーを伝播する(空 feed では返さない)。
 */
export async function getCancellationFeed(): Promise<CancellationFeed> {
  if (memoryCache && Date.now() - memoryCache.at < CACHE_TTL_MS) return memoryCache.feed;
  try {
    return await fetchFreshFeed();
  } catch (e) {
    console.error('[cancellations] fetch failed:', e);
    if (memoryCache) return memoryCache.feed;
    const dbCached = readDbCache();
    if (dbCached) {
      memoryCache = { feed: dbCached, at: 0 }; // 期限切れ扱いで保持(次回も再取得を試みる)
      return dbCached;
    }
    throw e;
  }
}
