import crypto from 'node:crypto';
import { Hono } from 'hono';
import { db } from '../db.js';
import { sharedTimetableSchema } from '../lib/schemas.js';
import type { SharedTimetable } from '../types.js';

// POST /api/share body: SharedTimetable → { id } (8文字英数, 衝突時再生成)
// GET  /api/share/:id → SharedTimetable
// GET  /share/:id → 人間向け簡易 HTML (deep link kitmate://share/:id と JSON リンク)

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 8;
const MAX_ID_ATTEMPTS = 20;

function generateShareId(): string {
  const bytes = crypto.randomBytes(ID_LENGTH);
  let id = '';
  for (const b of bytes) id += ID_CHARS[b % ID_CHARS.length];
  return id;
}

function findShare(id: string): SharedTimetable | null {
  const row = db.prepare('SELECT payload FROM shares WHERE id = ?').get(id) as { payload: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as SharedTimetable;
  } catch {
    return null;
  }
}

export const shareRoutes = new Hono();

shareRoutes.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const parsed = sharedTimetableSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  }

  const payload = JSON.stringify(parsed.data);
  const insert = db.prepare('INSERT OR IGNORE INTO shares (id, payload, created_at) VALUES (?, ?, ?)');
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = generateShareId();
    const info = insert.run(id, payload, Date.now());
    if (info.changes === 1) return c.json({ id });
  }
  return c.json({ error: 'id_generation_failed' }, 500);
});

shareRoutes.get('/:id', (c) => {
  const shared = findShare(c.req.param('id'));
  if (!shared) return c.json({ error: 'not_found' }, 404);
  return c.json(shared);
});

// ---- 人間向け HTML ----

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PAGE_CSS = `
:root {
  --bg: #F4F6FA; --card: #FFFFFF; --text: #0F172A; --sub: #64748B;
  --primary: #1D4ED8; --on-primary: #FFFFFF; --border: #E2E8F0;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0B1220; --card: #151E2E; --text: #E5EAF3; --sub: #94A3B8;
    --primary: #60A5FA; --on-primary: #0B1220; --border: #273349;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Segoe UI", sans-serif;
}
main {
  background: var(--card); border: 1px solid var(--border); border-radius: 16px;
  padding: 32px 28px; margin: 24px; max-width: 420px; width: 100%; text-align: center;
}
.app { color: var(--primary); font-weight: 700; letter-spacing: 0.06em; font-size: 14px; margin: 0 0 8px; }
h1 { font-size: 22px; margin: 0 0 12px; word-break: break-word; }
.meta { color: var(--sub); font-size: 14px; margin: 4px 0; }
.open {
  display: inline-block; margin: 20px 0 12px; padding: 14px 28px; border-radius: 12px;
  background: var(--primary); color: var(--on-primary); text-decoration: none; font-weight: 600; font-size: 16px;
}
.json a { color: var(--sub); font-size: 13px; }
`;

function renderSharePage(id: string, shared: SharedTimetable): string {
  const title = shared.title && shared.title.trim().length > 0 ? shared.title : '共有時間割 / Shared Timetable';
  const termJa = shared.term === 'first' ? '前期' : '後期';
  const termEn = shared.term === 'first' ? 'Spring' : 'Fall';
  const count = shared.entries.length;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | KITmate</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main>
  <p class="app">KITmate</p>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">${shared.year}年度 ${termJa} / AY ${shared.year} ${termEn}</p>
  <p class="meta">講義数: ${count} / ${count} course(s)</p>
  <a class="open" href="kitmate://share/${encodeURIComponent(id)}">アプリで開く / Open in app</a>
  <p class="json"><a href="/api/share/${encodeURIComponent(id)}">JSON データ / JSON data</a></p>
</main>
</body>
</html>`;
}

export const sharePageRoutes = new Hono();

sharePageRoutes.get('/:id', (c) => {
  const id = c.req.param('id');
  const shared = findShare(id);
  if (!shared) {
    return c.html(
      `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not Found | KITmate</title><style>${PAGE_CSS}</style></head><body><main><p class="app">KITmate</p><h1>共有が見つかりません / Share not found</h1><p class="meta">URL をご確認ください / Please check the URL.</p></main></body></html>`,
      404,
    );
  }
  return c.html(renderSharePage(id, shared));
});
