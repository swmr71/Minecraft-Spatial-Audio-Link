# Docker でまとめて起動する（LiveKit + Redis + msal-node）

3 つをまとめて起動する。**IP などの環境依存の値は `.env` から流し込む**だけ。

msal-node のイメージは **GHCR のビルド済みイメージ**（`ghcr.io/swmr71/msal-node`）を使う。main に push されるたびに GitHub Actions（`docker-image.yml`）が `:latest` と `:sha-<コミット>` を公開する。

```bash
cd deploy
cp .env.example .env      # 値を埋める（下の表）
docker compose up -d
docker compose ps         # 3 つとも Up（msal-node / redis は healthy）
curl http://localhost:8010/healthz   # {"ok":true}
```

ソースからビルドして試すとき（ローカル開発・イメージ公開前）:
```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Portainer で動かす

イメージ指定なので、**compose ファイルだけ**あれば動く（ビルドもリポジトリの clone も不要）。

1. **Stacks → Add stack → Web editor** に `deploy/docker-compose.yml` の中身を貼る（Repository 方式でも可: Compose path は `deploy/docker-compose.yml`）。
2. **Environment variables** に `.env.example` の変数を入れる（`.env` ファイルは使われない）。必須は `LIVEKIT_NODE_IP` / `REDIS_PASSWORD` / `SESSION_SECRET` / `PLUGIN_API_KEY` / `LIVEKIT_API_SECRET`。
3. **Deploy the stack**。
4. 更新は、Stack の **Pull and redeploy**（「Re-pull image」をオン）。固定したいなら `MSAL_IMAGE=ghcr.io/swmr71/msal-node:sha-xxxxxxx` を指定する。

### GHCR のイメージが private のとき
新しい GHCR パッケージは、既定では private のことがある。次のどちらかにする。
- **パッケージを public にする**: GitHub → プロフィール → Packages → `msal-node` → Package settings → Change visibility。
- **Portainer に GHCR の認証情報を登録する**: Registries → Add registry → Custom（`ghcr.io`、ユーザー名 = GitHub のユーザー名、パスワード = `read:packages` 権限の Personal Access Token）。

> パッケージは、リポジトリに紐付いている（イメージの `org.opencontainers.image.source` ラベル）ので、パッケージの設定から「Manage Actions access」で、このリポジトリの Actions に書き込み権限が付いていることも確認できる。

## `.env` の埋め方

| 変数 | 説明 |
| :--- | :--- |
| `LIVEKIT_NODE_IP` | **LiveKit がクライアントに伝える IP。** ローカル/LAN で試すなら、そのマシンの LAN の IP（例 `192.168.1.10`）。外のネットから使うなら外から見えるグローバル IP |
| `LIVEKIT_USE_EXTERNAL_IP` | `true` で起動時に STUN で外の IP を調べる（IP が変わる環境向け。変わったら `docker compose restart livekit`） |
| `LIVEKIT_PUBLIC_URL` | ブラウザから届く LiveKit のアドレス。空なら `ws://<LIVEKIT_NODE_IP>:7880`。ページが https なら `wss://…` にする |
| `REDIS_PASSWORD` / `SESSION_SECRET` / `PLUGIN_API_KEY` / `LIVEKIT_API_SECRET` | 必須。16 文字以上のランダム値（`openssl rand -hex 32`） |
| `SUPER_ADMIN_UUIDS` | 管理パネルを使える UUID（ハイフン付き・カンマ区切り）。空なら管理パネルは誰にも出ない |
| `REDIS_BIND_IP` | Redis を公開する IP。既定は同じマシンだけ（`127.0.0.1`）。**別マシンの Paper から繋ぐなら LAN の IP にする（パスワード必須）** |
| `TRUST_PROXY` | Cloudflare Tunnel などのリバースプロキシ配下なら `1`、直接アクセスなら `0` |
| `MSAL_IMAGE` | msal-node のイメージ。既定は `ghcr.io/swmr71/msal-node:latest` |
| `INSTALL_FFMPEG` | **ソースからビルドするときだけ**使う（`docker-compose.build.yml`）。音源 API の「URL 方式」用の ffmpeg を入れるか。公開イメージには ffmpeg が入っている |

## ポート

| ポート | 用途 | 外に出すもの |
| :--- | :--- | :--- |
| 8010/tcp | msal-node（ログイン画面・WebSocket・API） | 公開ホスト名（Tunnel など）経由 |
| 7880/tcp | LiveKit のシグナリング（ws） | 公開ホスト名経由で可 |
| 7881/tcp | LiveKit の WebRTC TCP フォールバック | ルーターで開放 |
| **7882/udp** | **LiveKit の音声**（ここが本体） | **ルーターで開放（Tunnel は UDP を通せない）** |
| 6379/tcp | Redis | **外に出さない**（Paper から届く範囲だけ） |

## Paper プラグインの設定

`plugins/MSALPlugin/config.yml`:
```yaml
redis:
  host: <このマシンの IP>      # 同じマシンなら 127.0.0.1
  port: 6379
  password: "<REDIS_PASSWORD>"
  database: 0
backend:
  base-url: "http://<このマシンの IP>:8010"
  login-url: "http://<このマシンの IP>:8010/login/"    # プレイヤーのブラウザが開く URL
  api-key: "<PLUGIN_API_KEY>"
```

## ローカルで試すときの注意

- **マイクは https か localhost でしか使えない**（ブラウザの仕様）。`http://192.168.x.x:8010` でダッシュボードを開くとマイクの許可が出ない。同じマシンのブラウザで `http://localhost:8010` を開くか、https（mkcert + Caddy など）にする。
- ページが https の場合、LiveKit も `wss://` にしないとブラウザにブロックされる（`LIVEKIT_PUBLIC_URL`）。
- 同じ LAN の人は内部 IP の候補で直接つながる。外のネットの人は `LIVEKIT_NODE_IP`（外から見える IP）に UDP が届く必要がある。

## 運用

```bash
docker compose logs -f msal-node      # ログ
docker compose restart livekit        # IP が変わったとき（LIVEKIT_USE_EXTERNAL_IP=true の場合）
docker compose pull && docker compose up -d   # msal-node を最新のイメージに更新
docker compose down                   # 停止（ボリューム = Redis/SQLite のデータは残る）
docker compose down -v                # データも消す
```

- データ: `redis-data`（セッション・ミュート設定・ダッキング量）と `msal-data`（ログインコードの SQLite）。どちらも消えても再ログインが必要になるだけ。
- LiveKit のバージョンは `docker-compose.yml` のタグで固定している（`livekit-client` の SDK とのバージョン差に注意。古いサーバーだと接続がタイムアウトすることがある）。
