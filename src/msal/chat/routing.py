# chat/routing.py
from django.urls import path # re_path から path に変更
from . import consumers

websocket_urlpatterns = [
    # path を使うことでスラッシュの有無などのミスを減らせます
    path('ws/vchat/', consumers.MinecraftVCConsumer.as_asgi()),
    path('ws/vchat/spatial/', consumers.MinecraftVCConsumer.as_asgi()),
]
