# KITmate Server 構築手順 (GCP 無料枠)

KITmate サーバを **Google Cloud Compute Engine の Always Free 枠**で常時稼働させる手順。

このサーバは **SQLite(ローカルファイル) + 常駐 node-cron(1 分毎の休講ポーリング)** という
構成のため、常駐ワーカー型の VM が最適。Cloud Run は不向き(理由は末尾の付録参照)。

---

## 0. 前提

- GCP プロジェクト作成 + 課金有効化(無料枠でも課金アカウントの紐付けは必要)
- ローカルに [gcloud CLI](https://cloud.google.com/sdk/docs/install) を導入

```bash
gcloud auth login
gcloud config set project <YOUR_PROJECT_ID>
```

---

## 1. 無料枠(Always Free)の条件

以下を **1 つでも外すと課金**されるので厳守する。

| 項目 | 無料の条件 |
|---|---|
| インスタンス | **e2-micro 1 台**のみ / 月 |
| リージョン | **`us-west1`(オレゴン) / `us-central1`(アイオワ) / `us-east1`(サウスカロライナ) のみ** |
| ディスク | **標準永続ディスク(pd-standard) 30GB まで** / 月 |
| 下り通信 | 北米発 **1GB/月**まで(中国・豪州向けは対象外) |

> ⚠️ **外部 IPv4 だけは無料枠外**で約 $3/月 かかる(2024 年以降の仕様)。完全 $0 にしたい場合は
> §6 の IPv6 構成。安定性重視なら IPv4 を使い、月数百円を許容するのが現実的。

---

## 2. VM を作成

```bash
gcloud compute instances create kitmate-server \
  --zone=us-west1-b \
  --machine-type=e2-micro \
  --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud \
  --boot-disk-type=pd-standard \
  --boot-disk-size=30GB \
  --tags=http-server,https-server
```

- 京都 → オレゴンは往復 120〜150ms 程度。休講 API は低頻度なので体感問題はほぼ無し。
- 日本リージョン(`asia-northeast1`)を選ぶと **無料枠から外れる**ので注意。

ポート 8787 を直接公開する場合のファイアウォール(HTTPS 化するなら不要、§5 参照):

```bash
gcloud compute firewall-rules create allow-kitmate \
  --allow=tcp:8787 --target-tags=http-server --source-ranges=0.0.0.0/0
```

---

## 3. VM の初期設定(SSH 後)

```bash
gcloud compute ssh kitmate-server --zone=us-west1-b
```

### 3-1. swap を作成(★ e2-micro は RAM 1GB のため必須)

`better-sqlite3` のネイティブビルド(Docker ビルド時の g++)がメモリ不足で失敗するのを防ぐ。

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab   # 再起動後も有効
```

### 3-2. Docker を導入

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
exit                      # 一度ログアウトしてグループを反映
```

再 SSH して `docker ps` が動けば OK。

---

## 4. デプロイ

### 4-1. コードを配置

git で管理しているなら VM 上で clone(推奨):

```bash
git clone <このリポジトリの URL> ~/kitmate3
cd ~/kitmate3/server
```

または手元から `server/` を転送(ローカルのターミナルで実行):

```bash
gcloud compute scp --recurse --zone=us-west1-b \
  ./server kitmate-server:~/server
# node_modules / data/kitmate.db は転送不要
```

### 4-2. 認証情報を設定

```bash
cp .env.example .env
nano .env        # KIT_USER_ID / KIT_PASSWORD を入力(他は任意)
```

| 変数 | 説明 |
|---|---|
| `KIT_USER_ID` | 休講取得用の学籍番号(未設定なら ebii.net フォールバック) |
| `KIT_PASSWORD` | そのパスワード |
| `VAPID_SUBJECT` | web-push の VAPID subject(任意, 既定 `mailto:tools@kitmate.jp`) |
| `PUSH_DISABLED` | `1` で休講 push(1 分毎ウォッチャ)を無効化 |

### 4-3. 起動

```bash
docker compose up -d --build
docker compose logs -f
```

- ログに `cancellation watcher scheduled (every minute)` → 初回 `initial snapshot saved` が出れば成功。
- `http://<VM の外部 IP>:8787/api/health` が `{ "ok": true }` を返せば疎通 OK。

SQLite と VAPID 鍵は `./data`(= VM ディスク)に残るため、再起動・再デプロイでも消えない。
`restart: unless-stopped` により VM 再起動後も自動復帰する。

---

## 5. (推奨) HTTPS 化 — Caddy で自動 TLS

ドメイン(例 `api.kitmate.jp`)の A レコードを VM の外部 IP に向けてから、`server/Caddyfile` を作成:

```
api.kitmate.jp {
    reverse_proxy kitmate-server:8787
}
```

`docker-compose.yml` に caddy サービスを追加(80/443 公開)すれば Let's Encrypt 証明書が
自動取得・更新される。HTTPS にする場合は §2 の 8787 ファイアウォールは不要。

> アプリ側は `app/app.json` の `expo.extra.apiBaseUrl` を `https://api.kitmate.jp` に変更する。

---

## 6. (任意) 外部 IPv4 課金を避けて完全 $0 にする

VM を外部 IPv4 無しで作成し、IPv6 のみで公開する:

```bash
gcloud compute instances create kitmate-server \
  --zone=us-west1-b --machine-type=e2-micro \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-type=pd-standard --boot-disk-size=30GB \
  --no-address \
  --stack-type=IPV4_IPV6 --ipv6-network-tier=PREMIUM
```

ただし **利用者の回線が IPv6 非対応だと接続できない**(モバイル/学内 Wi-Fi で不安定)。
到達性リスクを許容できる場合のみ。通常は §2 の IPv4 構成を推奨。

---

## 付録: なぜ Cloud Run ではないのか

- **ディスクが揮発性**: SQLite ファイルがコンテナ再起動で消える。
- **スケール 0 で cron が止まる**: リクエストが無いと CPU が停止し、1 分毎ウォッチャが動かない。
- **スケールアウトで DB 分裂**: 複数インスタンスが各自の SQLite を持ってしまう。

常駐ワーカー + ローカル DB という本サーバの構成には VM(Compute Engine)が合う。
