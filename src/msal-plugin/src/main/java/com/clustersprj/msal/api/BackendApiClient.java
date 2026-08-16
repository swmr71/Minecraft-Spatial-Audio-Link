package com.clustersprj.msal.api;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

import java.io.IOException;
import java.util.UUID;
import java.util.function.Consumer;

/** msal-node バックエンドへのHTTPクライアント。 */
public class BackendApiClient {

    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");

    private final OkHttpClient client = new OkHttpClient();
    private final String baseUrl;

    public BackendApiClient(String baseUrl) {
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
    }

    /**
     * /api/vc/token/generate/ を呼び出し、6桁のワンタイムトークンを取得する。
     * 呼び出しは非同期。onResult はワーカースレッドから呼ばれるため、
     * Bukkit APIに触れる場合は呼び出し側でメインスレッドに戻すこと。
     */
    public void generateLoginToken(UUID uuid, String mcName, Consumer<String> onSuccess, Consumer<String> onError) {
        JsonObject body = new JsonObject();
        body.addProperty("uuid", uuid.toString());
        body.addProperty("mc_name", mcName);

        Request request = new Request.Builder()
                .url(baseUrl + "/api/vc/token/generate/")
                .post(RequestBody.create(body.toString(), JSON))
                .build();

        client.newCall(request).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                onError.accept(e.getMessage());
            }

            @Override
            public void onResponse(Call call, Response response) throws IOException {
                try (Response r = response) {
                    if (!r.isSuccessful() || r.body() == null) {
                        onError.accept("HTTP " + r.code());
                        return;
                    }
                    JsonObject json = JsonParser.parseString(r.body().string()).getAsJsonObject();
                    if (json.has("token")) {
                        onSuccess.accept(json.get("token").getAsString());
                    } else {
                        onError.accept("unexpected response: " + json);
                    }
                }
            }
        });
    }

    public void close() {
        client.dispatcher().executorService().shutdown();
        client.connectionPool().evictAll();
    }
}
