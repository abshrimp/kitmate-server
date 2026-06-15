import { db } from '../db.js';

// 運営からのお知らせ。管理 API キーで投稿し、全 push 購読者へ配信 + 履歴を保存する。

export interface Announcement {
  id: number;
  title: string;
  body: string;
  createdAt: number; // unix ms
}

interface Row {
  id: number;
  title: string;
  body: string;
  created_at: number;
}

function toAnnouncement(r: Row): Announcement {
  return { id: r.id, title: r.title, body: r.body, createdAt: r.created_at };
}

/** お知らせを保存して作成したレコードを返す。 */
export function createAnnouncement(title: string, body: string): Announcement {
  const createdAt = Date.now();
  const info = db
    .prepare('INSERT INTO announcements (title, body, created_at) VALUES (?, ?, ?)')
    .run(title, body, createdAt);
  return { id: Number(info.lastInsertRowid), title, body, createdAt };
}

/** 最近のお知らせ (新しい順, 最大 limit 件) を返す。 */
export function listAnnouncements(limit = 50): Announcement[] {
  const rows = db
    .prepare('SELECT id, title, body, created_at FROM announcements ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Row[];
  return rows.map(toAnnouncement);
}
