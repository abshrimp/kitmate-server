import webpush from 'web-push';
import { db, getMeta, setMeta } from '../db.js';

// VAPID 鍵管理 + push 送信ヘルパ。
// VAPID 鍵は初回起動時に生成し meta テーブルへ保存して再利用する。

const META_PUBLIC_KEY = 'vapid.publicKey';
const META_PRIVATE_KEY = 'vapid.privateKey';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH_SIZE = 100;

let vapidPublicKey = '';

export function initVapid(): void {
  let publicKey = getMeta(META_PUBLIC_KEY);
  let privateKey = getMeta(META_PRIVATE_KEY);
  if (!publicKey || !privateKey) {
    const keys = webpush.generateVAPIDKeys();
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    setMeta(META_PUBLIC_KEY, publicKey);
    setMeta(META_PRIVATE_KEY, privateKey);
    console.log('[push] generated new VAPID key pair');
  }
  const subject = process.env.VAPID_SUBJECT ?? 'mailto:tools@kitmate.jp';
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidPublicKey = publicKey;
}

export function getVapidPublicKey(): string {
  return vapidPublicKey;
}

export interface PushMessage {
  title: string;
  body: string;
}

export interface PushSubscriptionRow {
  id: number;
  platform: string;
  token: string | null;
  endpoint: string | null;
  subscription: string | null;
}

// 通知チャンネル: 休講通知 / 授業関連連絡。それぞれ別の購読フラグ列に対応する。
export type NotificationChannel = 'cancellation' | 'notice';

export function listSubscribers(channel: NotificationChannel): PushSubscriptionRow[] {
  // channel はリテラル 2 値のみ。列名は固定文字列で組み立てる(SQL インジェクション不可)
  const column = channel === 'cancellation' ? 'cancellation' : 'notice';
  return db
    .prepare(`SELECT id, platform, token, endpoint, subscription FROM push_subscriptions WHERE ${column} = 1`)
    .all() as PushSubscriptionRow[];
}

/** Expo Push API へ最大 100 件ずつ送信 */
export async function sendExpoMessages(messages: Array<{ to: string; title: string; body: string }>): Promise<void> {
  for (let i = 0; i < messages.length; i += EXPO_BATCH_SIZE) {
    const chunk = messages.slice(i, i + EXPO_BATCH_SIZE);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.error(`[push] expo push HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      }
    } catch (e) {
      console.error('[push] expo push failed:', e);
    }
  }
}

/** web-push 送信。購読が無効 (410/404) なら DB から削除する。 */
export async function sendWebPushTo(row: PushSubscriptionRow, message: PushMessage): Promise<void> {
  if (!row.subscription) return;
  let subscription: webpush.PushSubscription;
  try {
    subscription = JSON.parse(row.subscription) as webpush.PushSubscription;
  } catch {
    db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
    return;
  }
  try {
    await webpush.sendNotification(subscription, JSON.stringify(message));
  } catch (e) {
    const statusCode = (e as { statusCode?: number }).statusCode;
    if (statusCode === 410 || statusCode === 404) {
      db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
      console.log(`[push] removed stale web subscription #${row.id}`);
    } else {
      console.error('[push] web push failed:', e);
    }
  }
}

/** 指定チャンネルの購読者へメッセージ群を配信 */
export async function broadcastToChannel(channel: NotificationChannel, messages: PushMessage[]): Promise<void> {
  if (messages.length === 0) return;
  const rows = listSubscribers(channel);
  if (rows.length === 0) return;

  const expoTokens = rows
    .filter((r) => r.platform === 'expo' && r.token)
    .map((r) => r.token as string);
  const expoMessages: Array<{ to: string; title: string; body: string }> = [];
  for (const message of messages) {
    for (const to of expoTokens) {
      expoMessages.push({ to, title: message.title, body: message.body });
    }
  }
  await sendExpoMessages(expoMessages);

  const webRows = rows.filter((r) => r.platform === 'web' && r.subscription);
  for (const row of webRows) {
    for (const message of messages) {
      await sendWebPushTo(row, message);
    }
  }
}
