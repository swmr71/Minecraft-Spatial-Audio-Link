from django.urls import path
from .views import TokenGenerateView, LiveKitTokenView

urlpatterns = [
    # ここは 'api/vc/' の後ろに続く部分だけを書く
    path('token/generate/', TokenGenerateView.as_view(), name='token_generate'),
    path('livekit/token/', LiveKitTokenView.as_view(), name='livekit_token'),
    
    # 【注意】ここに login や dashboard を含めると config と重複するので消す！
]