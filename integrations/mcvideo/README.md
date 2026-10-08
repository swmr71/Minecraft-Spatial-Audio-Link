# VideoMap の音声を VC で流す

[clusters-prj/clusters-MCVideo](https://github.com/clusters-prj/clusters-MCVideo)（VideoMap）は映像のみで音が出ない。
このパッチを当てると、`/videomap play` / `live` の動画の音が、**スクリーンの位置から**ボイスチャットの空間音響で聞こえる。

## 適用

```bash
cd clusters-MCVideo
git apply /path/to/Minecraft-Spatial-Audio-Link/integrations/mcvideo/0001-vc-audio.patch
gradle build
```
（`git apply --check` で VideoMap の初期コミット `9c01b6b` にそのまま当たることを確認済み）

## 設定（`plugins/VideoMap/config.yml`）

```yaml
vc-audio:
  enabled: true
  base-url: "http://10.2.1.5:8010"      # msal-node（Paper サーバーから届く内部アドレス）
  api-key: "<msal-node の PLUGIN_API_KEY>"
  range: 32                              # スクリーン中心から何ブロックまで聞こえるか
  volume: 1.0
  video-delay-ms: 400                    # 映像を遅らせて音とのズレを抑える
```
msal-node 側は追加設定不要（`.env` に `PLUGIN_API_KEY` があれば動く）。

## 何が変わるか

| 場所 | 変更 |
| :--- | :--- |
| `VcAudio`（新規） | msal-node の音源 API を呼ぶクライアントと、ffmpeg に足す音声出力の引数 |
| `VideoMapPlugin` | 再生前に音源を作成 → 音声出力付きで ffmpeg 起動。stop / remove / 終了で音源も撤去。スクリーン中心座標を `screens.yml` に保存 |
| `FramePlayer` | 音声ストリームの無い入力で ffmpeg が失敗したら**自動で映像のみに切り替え**。映像表示を `video-delay-ms` だけ遅らせる |
| `Screen` | 中心座標、再生要求の世代番号（作成中に stop された要求を捨てる） |

ffmpeg には出力が 1 つ増えるだけ（映像は今まで通り `pipe:1`、音声は msal-node へ HTTP チャンク POST）。音声は同じ入力から同時に出るので、`-re` も共有され映像と同じペースで流れる。

## 動作確認済みのこと

実際の ffmpeg と msal-node（実 LiveKit サーバー）に対して、パッチ適用後のプラグイン（Bukkit API はスタブ）で確認した:

- 音声あり動画 → msal に `videomap-<名前>` の音源が作られて push 中になり、映像も流れる。停止で音源が消える
- 音声なし動画 → 自動で映像のみに切り替わり、音源は撤去される
- 動画が自然に終わると、再生も音源も片付く
- 音源の作成中に `stop` されたら、再生は始まらず作りかけの音源も残らない
- msal に繋がらないときは、映像のみで再生される

実機（Paper 26.2）でのビルド・動作確認はしていない。

## 注意

- 既存のスクリーンは中心座標が保存されていない。額縁がロードされていれば自動で求めるが、出ないときは作り直す。
- RTMP 待ち受け（`live <名前> <キー>`）で配信に音声が無いと、音声出力付きの ffmpeg が起動に失敗して映像のみで再接続する。OBS が自動再接続する前提。
- ffmpeg のコマンドラインに `X-MSAL-Key` が含まれるため、Paper サーバーにログインできるユーザーには見える。内部ネットワーク前提。
