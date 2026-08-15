from django.db import models
from django.contrib.auth.models import User

class LoginToken(models.Model):
    uuid = models.UUIDField()
    mc_name = models.CharField(max_length=16)  # ← これを追加！
    token = models.CharField(max_length=6)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.mc_name} ({self.token})"