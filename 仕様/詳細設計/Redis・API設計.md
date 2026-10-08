## 1. Redis データ構造定義（リアルタイム座標）

座標データは 250ms ごとに Redis の `SETEX` で上書き保存します。キー名は UUID を用いて一意に特定します。

### キー形式
`vchat:player:{UUID}`（TTL 5 秒）

### JSON スキーマ
```json
{
  "u": "String (UUID)",       // プレイヤーの UUID
  "n": "String",              // プレイヤー名
  "p": [x, y, z],             // 座標（小数点以下 2 桁まで）
  "y": Float,                 // Yaw (0.0 - 360.0)。0 = 南(+z), 90 = 西(-x)
  "w": "String",              // ワールド名 (world, world_nether, etc.)
  "c": Integer,               // ラジオチャンネル (0 = OFF)
  "m": "String",              // 現在のモード (spatial | radio)。放送は Redis ではなく msal-node が管理し、k:"global" で伝える
  "t": Long,                  // 送信時刻 (epoch ms)
  "is_sneaking": Boolean,     // 演出用フラグ
  "is_in_water": Boolean      // 演出用フラグ
}
```
> **最適化メモ:** 通信量を削るため、主要キーは 1 文字に短縮しています。

### セッション
Web ログインのセッションは同じ Redis の `sess:{sid}`（connect-redis）。WebSocket もこのセッション Cookie で認証します。

---

## 2. Plugin ➔ Redis 送信仕様

* **送信トリガー:** `runTaskTimer`（メインスレッド）を用いて **5 Ticks（250ms）毎**に実行。
    * *理由:* 20 Ticks（毎秒）だとブラウザ側での補間が厳しく、1 Tick（50ms）だと Redis への書き込み負荷が高すぎるため。
* **スレッド分離:** Bukkit API（座標・状態の取得）は**必ずメインスレッド**で行い、JSON 化したスナップショットを `runTaskAsynchronously` で Redis へ書き込む。
* **生存確認 (TTL):** Redis のキーに **5 秒の有効期限** を設定。プラグインやサーバーがクラッシュした際、古い座標で声が聞こえ続けるのを防ぎます。

---

## 3. msal-node ➔ ブラウザへの通知（WebSocket）

エンドポイント: `wss://{host}/ws/vchat/spatial/`（Cookie 認証 / 同一オリジンのみ許可 / 未認証は close code `4401`）

msal-node は **250ms 周期**で 1 回だけ Redis から全プレイヤーを取得（`SCAN` + `MGET`）し、接続中の各クライアントについて「聞くべき相手」を算出して送ります。

| メッセージ | 内容 |
| :--- | :--- |
| `{"t":"pos","d":[…]}` | 毎周期。自分（`k:"self"`）と聞くべき相手の状態。各要素は §1 のスキーマ + `k`（`self` / `global` / `prox` / `radio`）, `dist`（距離 m）, `ng`（ラジオのノイズ利得 0..1、`radio` のみ）, `msg`（`global` のみ）。`global`（放送者）は位置を持たない |
| `k:"src"` | 音源（動画の音など）。`p`, `dist`, `range`, `vol` を持つ。`src` は同一ワールドで `range` 以内のみ |
| `{"t":"bc","d":[{u,n,msg}…],"duck":30}` | 放送中のユーザー一覧とダッキング量（他の音声が残る %）。接続直後と**変化したときだけ**送る |
| `{"t":"sub","add":[uuid…],"remove":[uuid…]}` | 購読リストに**変化があったときだけ**送る差分。クライアントはこれに従って LiveKit のトラックを購読 / 解除する |

クライアント → サーバー: `{"t":"eavesdrop","ch":null|"all"|<1-999>}`（**Super Admin のみ有効**、他は無視）。

### 「聞くべき相手」の判定（優先順位: 放送 > ラジオ > 近接）
1. **放送:** 放送中のユーザーは全員に `k:"global"`。ゲーム内にいなくてもよい。距離・ワールド無関係。
2. **ラジオ:** 自分の `c` が 0 でなく相手と同一（かつそのチャンネルがミュートされていない）→ 距離に関係なく対象。別ワールドなら `d = 2000` 固定。`ng = G_noise(d)`（要件定義 §5.2）。
3. **近接:** 同一ワールドかつ `d <= 100m` → 購読対象。実際に聞こえるのは **50m 以内**（クライアントが距離減衰で 50m で無音にする）。
4. **傍受（Super Admin のみ）:** 上記に当たらない `c > 0` の発話者を `k:"radio", ng:0` で追加（`all` = 全チャンネル、数値 = そのチャンネルのみ）。ミュートは無視。
5. Super Admin はゲーム外でも参加でき、その場合は位置 (0,0,0)・ワールド無しの仮想プレイヤーとして扱う（近接は成立せず、放送・傍受のみ）。

---

## 4. 認証 API の詳細

| エンドポイント | メソッド | 認証 | 説明 |
| :--- | :--- | :--- | :--- |
| `/api/vc/token/generate/` | POST | `X-MSAL-Key`（共有シークレット） | プラグインが `{uuid, mc_name}` を送り、6 桁のワンタイムコードを取得。有効期限 5 分（`LOGIN_TOKEN_TTL_SEC`）。再発行すると旧コードは無効 |
| `/login/` | GET / POST | なし | ブラウザで MCID とコードを入力。成功するとコードは即破棄され、セッションが発行される。失敗は IP / MCID 単位で制限（既定 5 回 / 5 分）し、MCID 側が上限に達するとコードを失効させる |
| `/api/vc/livekit/token/` | POST | セッション | LiveKit 接続用 JWT（TTL 2 時間、room は `minecraft-vc` 固定） |
| `/logout/` | POST | セッション | セッション破棄 |
| `/api/vc/plugin/broadcast/start` | POST | `X-MSAL-Key` | `{uuid, mc_name, message}`。権限（`msal.broadcast`）はプラグイン側で判定済みとして扱う |
| `/api/vc/plugin/broadcast/stop` | POST | `X-MSAL-Key` | `{uuid}` でその放送者のみ、省略で全放送を停止 |
| `/api/vc/plugin/channel/mute` | POST | `X-MSAL-Key` | `{channel: 1-999, muted: boolean}`。権限（`msal.mute.*` / `msal.mute.<ch>`）はプラグイン側で判定 |
| `/api/vc/admin/broadcast/start` `/stop` | POST | セッション（Super Admin） | 自分自身が放送者になる / 自分の放送を止める |
| `/api/vc/admin/channel/mute` | POST | セッション（Super Admin） | プラグイン版と同じ |
| `/api/vc/admin/settings` | POST | セッション（Super Admin） | `{duck: 0-100}` ダッキング量 |
| `/api/vc/admin/state` | GET | セッション（Super Admin） | オンライン一覧 / 放送中 / ミュート中 / ダッキング量 |
| `/healthz` | GET | なし | 死活監視用 |

> 音源（動画の音など）の API は [音源API.md](音源API.md) を参照。

> WebSocket 以外の `Upgrade` ヘッダ（JDK `HttpClient` 既定の h2c アップグレードなど）には `426` を返す。HTTP クライアントは HTTP/1.1 を使うこと。

> 変更系 API は `Content-Type: application/json` のみ受け付ける（それ以外は 415）。放送の最大継続時間は `BROADCAST_MAX_SECONDS`（既定 300 秒）で自動終了。ミュート中チャンネルとダッキング量は Redis の `vchat:settings` に永続化。

> 旧設計の `/api/vc/token/verify/` は廃止（Web ログインフォームの `POST /login/` に統合）。
