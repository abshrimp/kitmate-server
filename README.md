# KITmate Server

京都工芸繊維大学 学生支援アプリ「KITmate」のデータ・共有・push 配信サーバ。
Node 22 + TypeScript + Hono + better-sqlite3。

## 起動

### 開発

```bash
cd server
npm install
npm run dev          # tsx watch src/index.ts (http://localhost:8787)
```

### ビルド / 本番

```bash
npm run build        # tsc → dist/
npm start            # node dist/index.js
npm run typecheck    # tsc --noEmit
```

### Docker

```bash
cd server
docker compose up -d --build
```

- ポート: `8787`
- volume: `./data:/app/data`(SQLite DB と `courses.json` / `requirements.json` をホスト側で管理)
- 環境変数(`KIT_USER_ID` 等)は `.env`(`.env.example` をコピー)に記述

### 本番デプロイ

GCP 無料枠 VM への構築手順は [DEPLOY.md](DEPLOY.md) を参照。

## 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `8787` | リッスンポート |
| `PUSH_DISABLED` | (未設定) | `1` で休講ウォッチャ(1分毎の push 配信)を無効化 |
| `VAPID_SUBJECT` | `mailto:tools@kitmate.jp` | web-push の VAPID subject(`mailto:` または URL) |
| `KIT_USER_ID` | (必須) | 休講取得用の学籍番号。KIT ポータルを直接スクレイプ |
| `KIT_PASSWORD` | (必須) | `KIT_USER_ID` のパスワード(両方無いと休講取得はエラー) |
| `KIT_VPN_HOST` | `vpns.cis.kit.ac.jp` | KIT SSL-VPN のホスト |

VAPID 鍵ペアは初回起動時に自動生成され、SQLite の `meta` テーブルに保存・再利用されます。

### 休講・授業連絡の取得元

KIT の SSL-VPN(`KIT_VPN_HOST`)のプロキシ経由で Shibboleth ログインし、ポータル
(`portal.student.kit.ac.jp`)の `c=lecture_cancellation`(休講通知)と
`c=lecture_information`(授業関連連絡)の表を直接スクレイプします(`src/lib/kitPortal.ts`)。
**`KIT_USER_ID` / `KIT_PASSWORD` の両方が必須**で、未設定・取得失敗時はフォールバックせず
エラーになります(直近のキャッシュがあればそれを返す)。セッション切れ時は 1 度だけ再ログインします。

## データファイル

- `data/courses.json` — `Course[]`。起動時(および更新時)にロード。無ければ空配列。
- `data/requirements.json` — `RequirementSet[]`。
- `data/kitmate.db` — SQLite(shares / timetables / push_subscriptions / meta)。自動生成。

## エンドポイント一覧

| Method/Path | 説明 |
|---|---|
| GET `/api/health` | `{ ok: true }` |
| GET `/api/courses` | `Course[]`。クエリ: `year`(無視) / `q`(科目名・教員名・科目番号の部分一致、大文字小文字無視) / `day`(`mon`..`fri`) / `period`(1..5) / `intensive`(`true`/`false`) / `grade`(`targetGrade <= grade`) / `term`(完全一致 or `full_year` を含む) |
| GET `/api/courses/:id` | `Course`。無ければ 404 |
| GET `/api/requirements/:admissionYear/:variantKey` | `{ graduation, research_start }`。該当年度が無い場合は最も近い年度で代替し `fallback: true` を付与。variantKey 自体が無ければ 404 |
| GET `/api/cancellations` | `CancellationFeed`。KIT ポータルを直接スクレイプし中継(1分メモリ+DBキャッシュ。取得失敗時はキャッシュ → 無ければ 502。フォールバックなし) |
| POST `/api/share` | body: `SharedTimetable`(zod 検証)→ `{ id }`(8文字英数) |
| GET `/api/share/:id` | `SharedTimetable`(JSON)。無ければ 404 |
| GET `/share/:id` | 人間向け簡易 HTML。`kitmate://share/:id` への「アプリで開く」リンクと JSON リンク。ダークモード対応 |
| GET `/api/sync/timetable` | ヘッダ `X-Moodle-Token` 必須。`{ entries, updatedAt }`(未保存なら `entries: []`) |
| PUT `/api/sync/timetable` | ヘッダ `X-Moodle-Token` 必須。body: `{ entries: TimetableEntry[] }` → upsert、`{ ok: true, updatedAt }` |
| POST `/api/push/register` | body: `{ platform: 'expo'\|'web', token?, subscription?, cancellationNotifications, lectureInfoNotifications? }` → upsert(`lectureInfoNotifications` 省略時は休講と同値) |
| POST `/api/push/unregister` | body: `{ platform, token?, endpoint? }` → 削除 |
| GET `/api/push/vapid-public-key` | `{ publicKey }` |

### 認証 (sync)

`X-Moodle-Token` を Moodle (`moodle.cis.kit.ac.jp`) の `core_webservice_get_site_info` で検証し、
得られた `username` をキーに保存します。検証結果は 10 分メモリキャッシュ。
`invalidtoken` は 401、Moodle 側エラーは 502、到達不能は 503 を返します。

### 休講 push 通知

node-cron で 1 分毎(`* * * * *`)に休講フィード(KIT ポータル直取得)を取得し、前回スナップショット
との差分を検出。ポータル直取得時は VPN セッション(`fgt_sslvpn_sid` + Cookie)をキャッシュ再利用し、
切れたら再ログインするため、毎分のフルログインは発生しない。前 tick が長引いた場合は重複実行をスキップする。差分は **行番号 No に依存しない内容ベースのキー**で判定する(新着挿入で No が
ずれても誤通知しない):

- 休講通知: `科目名 + 休講年月日 + 曜日 + 時限 + 掲示年月日`
- 授業関連連絡: `科目名 + 曜日 + 時限 + 分類 + 最終更新日`

通知対象は **「学部」のみ**(大学院等は除外)。新規分を以下の**2チャンネルに分けて**配信する:

- 休講通知 → `cancellationNotifications=true` の購読者
- 授業関連連絡 → `lectureInfoNotifications=true` の購読者(register で省略時は休講と同値)

配信経路:

- Expo: `https://exp.host/--/api/v2/push/send` へ `{ to, title, body }` を最大 100 件ずつ
- Web: `web-push`(送信失敗 410/404 で購読を自動削除)
- タイトル例: `休講: <科目名>` / `授業連絡: <科目名>`、本文に日付・曜日・時限
- 初回実行はベースライン記録のみ(過去分を一斉通知しない)
