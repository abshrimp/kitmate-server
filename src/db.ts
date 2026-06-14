import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

// server/src/db.ts → server/data, server/dist/db.js → server/data のどちらでも同じ場所を指す
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(moduleDir, '..', 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db: Database.Database = new Database(path.join(DATA_DIR, 'kitmate.db'));

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS timetables (
  username TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  token TEXT,
  endpoint TEXT,
  subscription TEXT,
  cancellation INTEGER NOT NULL DEFAULT 0,
  notice INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// マイグレーション: 既存 DB に notice 列(授業関連連絡チャンネル)を追加。
// 旧仕様では cancellation=1 の購読者が休講・授業連絡の両方を受け取っていたため、
// 列追加時は notice に cancellation の値を引き継いで挙動を維持する。
{
  const cols = db.prepare('PRAGMA table_info(push_subscriptions)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'notice')) {
    db.exec('ALTER TABLE push_subscriptions ADD COLUMN notice INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE push_subscriptions SET notice = cancellation');
  }
}

export function getMeta(key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
