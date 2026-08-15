# /root/msal/chat/views.py
import os
import random
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from .models import LoginToken
from livekit import api 
from django.shortcuts import render, redirect
from django.contrib.auth import login
from django.contrib.auth.models import User
from django.contrib.auth.decorators import login_required

# 1. トークン生成（プラグイン用）
class TokenGenerateView(APIView):
    def post(self, request):
        uuid = request.data.get("uuid")
        mc_name = request.data.get("mc_name")  # プラグインから新しく送ってもらう
        
        if not uuid or not mc_name:
            return Response({"error": "UUID and MCID are required"}, status=400)
        
        token_code = f"{random.randint(100000, 999999)}"
        
        # 既存のトークンがあれば削除して新しく作成
        LoginToken.objects.filter(uuid=uuid).delete()
        LoginToken.objects.create(
            uuid=uuid, 
            mc_name=mc_name,  # モデルにもフィールドを追加しておく
            token=token_code
        )
        return Response({"token": token_code})

# 2. LiveKitトークン発行（←これが足りていないはず！）
# chat/views.py

class LiveKitTokenView(APIView):
    permission_classes = [] 

    def post(self, request): # get から post に変更
        mc_name = request.session.get('mc_name')
        uuid = request.session.get('uuid')
        
        if not mc_name or not uuid:
            return Response({"error": "Unauthorized"}, status=401)
        
        lk_api_key = os.environ.get("LIVEKIT_API_KEY", "devkey")
        lk_api_secret = os.environ.get("LIVEKIT_API_SECRET")
        
        token = api.AccessToken(lk_api_key, lk_api_secret) \
            .with_identity(str(uuid)) \
            .with_name(mc_name) \
            .with_grants(api.VideoGrants(
                room_join=True, 
                room="minecraft-vc",
                can_publish=True,
                can_subscribe=True
            ))
        
        return Response({"token": token.to_jwt()})

# 3. ログイン画面   
def web_login_view(request):
    if request.method == "POST":
        mc_name = request.POST.get("mc_name")
        code = request.POST.get("code")

        login_token = LoginToken.objects.filter(
            mc_name=mc_name, 
            token=code, 
            # is_used=False
        ).first()

        if login_token:
            # --- ここから追加 ---
            # セッションに「このブラウザは今、この人だよ！」とメモする
            request.session['mc_name'] = login_token.mc_name
            request.session['uuid'] = str(login_token.uuid)
            # --- ここまで ---

            #login_token.is_used = True # コードを1回きりにする
            login_token.save()
            return redirect("dashboard")
        else:
            return render(request, "chat/login.html", {"error": "名前かコードが違うで"})
    
    return render(request, "chat/login.html")

#4. ダッシュボード
# chat/views.py

def dashboard_view(request):
    mc_name = request.session.get('mc_name')
    uuid = request.session.get('uuid') # セッションからUUIDを取得[cite: 4]
    
    if not mc_name or not uuid:
        return redirect('login')
    
    # context に 'uuid' を追加して渡す
    return render(request, 'chat/dashboard.html', {
        'mc_name': mc_name,
        'uuid': uuid
    })
