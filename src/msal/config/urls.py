from django.contrib import admin
from django.urls import path, include
from chat.views import web_login_view, dashboard_view

urlpatterns = [
    path('admin/', admin.site.urls),
    
    # ルート直下のURL
    path('login/', web_login_view, name='login'),
    path('dashboard/', dashboard_view, name='dashboard'),
    
    # それ以外（API関係）はアプリの urls.py に丸投げ
    path('api/vc/', include('chat.urls')), 
]