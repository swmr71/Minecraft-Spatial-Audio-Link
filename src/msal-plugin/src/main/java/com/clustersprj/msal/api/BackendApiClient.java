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

/** msal-node バックエンドへのHTTPクライアント（JDK 標準の HttpClient を使用）。 */
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

    /**
     * /api/vc/token/generate/ を呼び出し、6桁のワンタイムトークンを取得する。
     * 呼び出しは非同期。コールバックは HTTP クライアントのワーカースレッドから呼ばれるため、
     * Bukkit API に触れる場合は呼び出し側でメインスレッドに戻すこと。
     */
    public void generateLoginToken(UUID uuid, String mcName, Consumer<String> onSuccess, Consumer<String> onError) {
        JsonObject body = new JsonObject();
        body.addProperty("uuid", uuid.toString());
        body.addProperty("mc_name", mcName);

        HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/api/vc/token/generate/"))
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
                        JsonObject json = JsonParser.parseString(response.body()).getAsJsonObject();
                        if (json.has("token")) {
                            onSuccess.accept(json.get("token").getAsString());
                        } else {
                            onError.accept("unexpected response");
                        }
                    } catch (RuntimeException e) {
                        onError.accept("invalid response: " + e.getMessage());
                    }
                });
    }
}
