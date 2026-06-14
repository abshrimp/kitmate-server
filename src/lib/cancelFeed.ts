import { getMeta, setMeta } from '../db.js';
import { fetchFeedFromPortal, hasPortalCredentials } from './kitPortal.js';
import type { CancellationFeed, CancellationNotice, LectureNotice } from '../types.js';

// 休講通知・授業関連連絡を CancellationFeed として提供する。
// - 取得元: KIT_USER_ID / KIT_PASSWORD があれば KIT ポータルを直接スクレイプ (kitPortal.ts)、
//   無い or 失敗時は https://ebii.net/cancel.json (事前スクレイプ済 JSON) にフォールバック。
// - 10 分メモリキャッシュ + DB (meta テーブル) キャッシュ
// - すべて失敗した場合はキャッシュ(メモリ → DB)を返し、どちらも無ければ空 feed

const SOURCE_URL = 'https://ebii.net/cancel.json';
const CACHE_TTL_MS = 10 * 60 * 1000;
const META_CACHE_KEY = 'cancellations.cache';

let memoryCache: { feed: CancellationFeed; at: number } | null = null;

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function strArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter((x) => x.length > 0);
  if (typeof v === 'string' && v.length > 0) return [v];
  return [];
}

function normalizeNotice(raw: Record<string, unknown>): LectureNotice {
  return {
    no: num(raw['No']),
    facultyLabel: str(raw['学部名など']),
    termLabel: str(raw['学期']),
    courseName: str(raw['授業科目名']),
    instructors: strArray(raw['担当教員名']),
    dayLabel: str(raw['曜日']),
    periodLabel: raw['時限'] == null ? null : str(raw['時限']),
    category: str(raw['分類']),
    message: str(raw['連絡事項']),
    firstPostedAt: str(raw['初回掲示日']),
    updatedAt: str(raw['最終更新日']),
  };
}

function normalizeCancellation(raw: Record<string, unknown>): CancellationNotice {
  return {
    no: num(raw['No']),
    facultyLabel: str(raw['学部名など']),
    courseName: str(raw['授業科目名']),
    instructors: strArray(raw['担当教員名']),
    cancelledOn: str(raw['休講年月日']),
    dayLabel: str(raw['曜日']),
    periodLabel: str(raw['時限']),
    remarks: str(raw['備考']),
    postedAt: str(raw['掲示年月日']),
  };
}

function normalizeFeed(raw: unknown): CancellationFeed {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const noticesRaw = Array.isArray(obj['授業関連連絡']) ? (obj['授業関連連絡'] as unknown[]) : [];
  const cancellationsRaw = Array.isArray(obj['休講通知']) ? (obj['休講通知'] as unknown[]) : [];
  return {
    notices: noticesRaw
      .filter((n): n is Record<string, unknown> => n != null && typeof n === 'object')
      .map(normalizeNotice),
    cancellations: cancellationsRaw
      .filter((n): n is Record<string, unknown> => n != null && typeof n === 'object')
      .map(normalizeCancellation),
    fetchedAt: new Date().toISOString(),
  };
}

export function emptyFeed(): CancellationFeed {
  return { notices: [], cancellations: [], fetchedAt: new Date().toISOString() };
}

async function fetchFromEbii(): Promise<CancellationFeed> {
  const res = await fetch(SOURCE_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`cancel.json fetch failed: HTTP ${res.status}`);
  const raw: unknown = await res.json();
  return normalizeFeed(raw);
}

/**
 * ソースから必ず取りに行く。失敗時は throw(成功時はキャッシュ更新)。
 * 認証情報があれば KIT ポータルを直接スクレイプし、失敗時は ebii.net にフォールバック。
 */
export async function fetchFreshFeed(): Promise<CancellationFeed> {
  let feed: CancellationFeed;
  if (hasPortalCredentials()) {
    try {
      feed = await fetchFeedFromPortal();
    } catch (e) {
      console.error('[cancellations] portal scrape failed, falling back to ebii.net:', e);
      feed = await fetchFromEbii();
    }
  } else {
    feed = await fetchFromEbii();
  }

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

/** 10 分キャッシュ付き取得。失敗時はキャッシュ → 空 feed の順でフォールバック。 */
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
    return emptyFeed();
  }
}
