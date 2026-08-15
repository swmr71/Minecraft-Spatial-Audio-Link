import json
import math
import asyncio
from channels.generic.websocket import AsyncWebsocketConsumer
from django_redis import get_redis_connection

class MinecraftVCConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        await self.accept()
        # 10.2.1.5 の Redis (DB 0) に接続
        self.redis = get_redis_connection("default")
        self.last_sent_uuids = set()
        
        # 接続と同時に、バックグラウンドでループ処理を開始させる
        self.keep_running = True
        self.update_task = asyncio.create_task(self.broadcast_loop())

    async def disconnect(self, close_code):
        # 接続が切れたらループを停止させる
        self.keep_running = False
        if hasattr(self, 'update_task'):
            self.update_task.cancel()

    async def broadcast_loop(self):
        """1秒ごとに座標を計算して送信する無限ループ"""
        while self.keep_running:
            try:
                await self.broadcast_positions()
                await asyncio.sleep(1) # 更新間隔 (1秒)
            except Exception as e:
                print(f"Error in broadcast_loop: {e}")
                await asyncio.sleep(1)

    def is_nearby(self, p1, p2):
        """2点間の距離が200ブロック以内か判定"""
        dist = math.sqrt(sum((a - b) ** 2 for a, b in zip(p1, p2)))
        return dist <= 200

    async def broadcast_positions(self):
        """Redisから全プレイヤーの座標を取得し、自分と周辺プレイヤーの情報を送信"""
        # 1. セッションから自分のUUIDを取得
        my_uuid = self.scope['session'].get('uuid')
        
        if not my_uuid:
            # セッションにUUIDがない場合は処理をスキップ
            return

        # 2. Redisからプレイヤーデータ一覧を取得
        keys = self.redis.keys("vchat:player:*")
        
        all_data = {}
        for k in keys:
            d = self.redis.get(k)
            if d:
                try:
                    decoded = json.loads(d.decode('utf-8'))
                    all_data[decoded['u']] = decoded
                except Exception as e:
                    print(f"[Debug] JSON Parse Error: {e}")

        # 3. 自分のデータがRedisに存在するか確認
        me = all_data.get(my_uuid)
        if not me:
            # 自分のデータがなければ、まだMinecraft側から座標が送られていないため終了
            return

        # 4. 送信対象（自分 + 周辺プレイヤー）のリストを作成
        current_targets = []
        for u, data in all_data.items():
            # 自分自身は必ずリストに含める
            if u == my_uuid:
                current_targets.append(data)
                continue
            
            # 他プレイヤーの場合は「距離」または「無線チャンネル」で判定
            # 近い、または同じチャンネル(0以外)にいる場合にリストに追加
            if self.is_nearby(me['p'], data['p']) or (me['c'] != 0 and me['c'] == data['c']):
                current_targets.append(data)

        # 5. クライアント（ブラウザ）へ送信
        print(f"[Debug] Sending {len(current_targets)} players (including me) to client.")
        await self.send(text_data=json.dumps({
            "t": "pos",
            "d": current_targets
        }))
