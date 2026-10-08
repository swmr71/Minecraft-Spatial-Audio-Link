package com.clustersprj.msal.api;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.UUID;
import java.util.function.Consumer;

/**
 * msal-node バックエンドへのHTTPクライアント（JDK 標準の HttpClient を使用）。
 * すべて非同期。コールバックは HTTP クライアントのワーカースレッドから呼ばれるため、
 * Bukkit API に触れる場合は呼び出し側でメインスレッドに戻すこと。
 */
public class BackendApiClient {

    private final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .build();
    private final String baseUrl;
    private final String apiKey;

    public BackendApiClient(String baseUrl, String apiKey) {
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        this.apiKey = apiKey;
    }

    /** /api/vc/token/generate/ を呼び出し、6桁のワンタイムトークンを取得する。 */
    public void generateLoginToken(UUID uuid, String mcName, Consumer<String> onSuccess, Consumer<String> onError) {
        JsonObject body = new JsonObject();
        body.addProperty("uuid", uuid.toString());
        body.addProperty("mc_name", mcName);

        postJson("/api/vc/token/generate/", body, json -> {
            if (json.has("token")) {
                onSuccess.accept(json.get("token").getAsString());
            } else {
                onError.accept("unexpected response");
            }
        }, onError);
    }

    /** 全体放送を開始する（放送者の声が全員に届く）。 */
    public void startBroadcast(UUID uuid, String mcName, String message, Runnable onSuccess, Consumer<String> onError) {
        JsonObject body = new JsonObject();
        body.addProperty("uuid", uuid.toString());
        body.addProperty("mc_name", mcName);
        body.addProperty("message", message);
        postJson("/api/vc/plugin/broadcast/start", body, json -> onSuccess.run(), onError);
    }

    /** 放送を終了する。uuid が null なら全放送を停止する。 */
    public void stopBroadcast(UUID uuid, Runnable onSuccess, Consumer<String> onError) {
        JsonObject body = new JsonObject();
        if (uuid != null) {
            body.addProperty("uuid", uuid.toString());
        }
        postJson("/api/vc/plugin/broadcast/stop", body, json -> onSuccess.run(), onError);
    }

    /** ラジオチャンネルのミュート / 解除。 */
    public void setChannelMuted(int channel, boolean muted, Runnable onSuccess, Consumer<String> onError) {
        JsonObject body = new JsonObject();
        body.addProperty("channel", channel);
        body.addProperty("muted", muted);
        postJson("/api/vc/plugin/channel/mute", body, json -> onSuccess.run(), onError);
    }

    private void postJson(String path, JsonObject body, Consumer<JsonObject> onSuccess, Consumer<String> onError) {
        HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + path))
                .timeout(Duration.ofSeconds(5))
                .header("Content-Type", "application/json; charset=utf-8")
                .header("X-MSAL-Key", apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
                .build();

        client.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .whenComplete((response, throwable) -> {
                    try {
                        if (throwable != null) {
                            onError.accept(throwable.getClass().getSimpleName() + ": " + throwable.getMessage());
                            return;
                        }
                        if (response.statusCode() / 100 != 2) {
                            onError.accept("HTTP " + response.statusCode());
                            return;
                        }
                        onSuccess.accept(JsonParser.parseString(response.body()).getAsJsonObject());
                    } catch (RuntimeException e) {
                        onError.accept("invalid response: " + e.getMessage());
                    }
                });
    }
}
