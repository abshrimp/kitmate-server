import cron from 'node-cron';
import { getMeta, setMeta } from './db.js';
import { fetchFreshFeed } from './lib/cancelFeed.js';
import { broadcastToChannel, type PushMessage } from './lib/push.js';
import type { CancellationFeed, CancellationNotice, LectureNotice } from './types.js';

// 休講ウォッチャ: 1 分毎に休講フィードを取得し、前回スナップショットとの差分を
// 休講通知 → cancellation 購読者 / 授業関連連絡 → notice 購読者 へ別々に push 通知する。
// env PUSH_DISABLED=1 で無効化。「学部」以外(大学院等)は対象外。
//
// 差分キーは行番号 No に依存しない(新着挿入で No がずれても誤通知しない)。内容ベース:
//   休講通知   = 科目名 + 休講年月日 + 曜日 + 時限 + 掲示年月日
//   授業関連連絡 = 科目名 + 曜日 + 時限 + 分類 + 最終更新日

const SNAPSHOT_KEY = 'cancellations.snapshot';
const TARGET_FACULTY = '学部'; // 通知対象は学部のみ

function isUndergrad(facultyLabel: string): boolean {
  return facultyLabel.trim() === TARGET_FACULTY;
}

function cancellationKey(n: CancellationNotice): string {
  return `c:${n.courseName}|${n.cancelledOn}|${n.dayLabel}|${n.periodLabel}|${n.postedAt}`;
}

function noticeKey(n: LectureNotice): string {
  return `n:${n.courseName}|${n.dayLabel}|${n.periodLabel ?? ''}|${n.category}|${n.updatedAt}`;
}

function buildCancellationMessage(n: CancellationNotice): PushMessage {
  const parts: string[] = [];
  if (n.cancelledOn) parts.push(n.cancelledOn);
  if (n.dayLabel) parts.push(n.dayLabel);
  if (n.periodLabel) parts.push(`${n.periodLabel}限`);
  return {
    title: `休講: ${n.courseName}`,
    body: parts.join(' ') || n.remarks,
  };
}

function buildNoticeMessage(n: LectureNotice): PushMessage {
  const parts: string[] = [];
  if (n.category) parts.push(`[${n.category}]`);
  if (n.dayLabel) parts.push(n.dayLabel);
  if (n.periodLabel) parts.push(`${n.periodLabel}限`);
  return {
    title: `授業連絡: ${n.courseName}`,
    body: parts.join(' ') || n.message.slice(0, 100),
  };
}

function loadSnapshot(): Set<string> | null {
  const raw = getMeta(SNAPSHOT_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((k): k is string => typeof k === 'string'));
  } catch (e) {
    console.error('[watcher] broken snapshot:', e);
  }
  return new Set();
}

function saveSnapshot(cancellations: CancellationNotice[], notices: LectureNotice[]): void {
  const keys = [...cancellations.map(cancellationKey), ...notices.map(noticeKey)];
  setMeta(SNAPSHOT_KEY, JSON.stringify(keys));
}

export async function runWatcherTick(): Promise<void> {
  let feed: CancellationFeed;
  try {
    feed = await fetchFreshFeed();
  } catch (e) {
    console.error('[watcher] fetch failed, skipping tick:', e);
    return;
  }

  // 学部のみを対象に絞る(大学院等は通知しない)
  const cancellations = feed.cancellations.filter((n) => isUndergrad(n.facultyLabel));
  const notices = feed.notices.filter((n) => isUndergrad(n.facultyLabel));

  const previous = loadSnapshot();
  saveSnapshot(cancellations, notices);
  if (previous === null) {
    // 初回はベースラインのみ記録(過去分を一斉通知しない)
    console.log('[watcher] initial snapshot saved');
    return;
  }

  const newCancellations = cancellations.filter((n) => !previous.has(cancellationKey(n)));
  const newNotices = notices.filter((n) => !previous.has(noticeKey(n)));
  if (newCancellations.length === 0 && newNotices.length === 0) return;

  console.log(`[watcher] ${newCancellations.length} new cancellation(s), ${newNotices.length} new notice(s)`);
  // 休講通知と授業関連連絡を別チャンネルへ配信
  await broadcastToChannel('cancellation', newCancellations.map(buildCancellationMessage));
  await broadcastToChannel('notice', newNotices.map(buildNoticeMessage));
}

export function startCancellationWatcher(): void {
  if (process.env.PUSH_DISABLED === '1') {
    console.log('[watcher] disabled via PUSH_DISABLED=1');
    return;
  }
  let running = false; // 前回の tick が長引いた場合の重複実行を防ぐ
  cron.schedule('* * * * *', () => {
    if (running) {
      console.log('[watcher] previous tick still running, skipping');
      return;
    }
    running = true;
    runWatcherTick()
      .catch((e) => console.error('[watcher] tick error:', e))
      .finally(() => {
        running = false;
      });
  });
  console.log('[watcher] cancellation watcher scheduled (every minute)');
}
