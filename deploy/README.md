# Docker でまとめて起動する（LiveKit + Redis + msal-node）

3 つをまとめて起動する。**IP などの環境依存の値は `.env` から流し込む**だけ。

```bash
cd deploy
cp .env.example .env      # 値を埋める（下の表）
docker compose up -d --build
docker compose ps         # 3 つとも Up（msal-node / redis は healthy）
curl http://localhost:8010/healthz   # {"ok":true}
```

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
| `INSTALL_FFMPEG` | 音源 API の「URL 方式」用の ffmpeg を入れるか。push 方式（VideoMap 連携）だけなら `0` でイメージが小さくなる |

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
docker compose up -d --build          # msal-node を更新
docker compose down                   # 停止（ボリューム = Redis/SQLite のデータは残る）
docker compose down -v                # データも消す
```

- データ: `redis-data`（セッション・ミュート設定・ダッキング量）と `msal-data`（ログインコードの SQLite）。どちらも消えても再ログインが必要になるだけ。
- LiveKit のバージョンは `docker-compose.yml` のタグで固定している（`livekit-client` の SDK とのバージョン差に注意。古いサーバーだと接続がタイムアウトすることがある）。
