# msal/asgi.py (プロジェクト名のフォルダ内にあるはずです)
import os
from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack
import chat.routing # chatアプリのroutingをインポート

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'msal.settings')

application = ProtocolTypeRouter({
    "http": get_asgi_application(),
    "websocket": AuthMiddlewareStack(
        URLRouter(
            chat.routing.websocket_urlpatterns # ここでアプリ側の設定を連結
        )
    ),
})
