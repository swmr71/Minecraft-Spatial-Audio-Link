package com.clustersprj.msal.task;

import com.clustersprj.msal.MSALPlugin;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.entity.Player;
import org.bukkit.scheduler.BukkitRunnable;
import redis.clients.jedis.Jedis;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.Pipeline;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 全プレイヤーの座標・向き・状態を収集し、Redis へ送信する。
 * <p>
 * {@link #run()} は<b>メインスレッド</b>で実行すること（{@code runTaskTimer}）。
 * Bukkit API へのアクセスはここで完結させ、Redis への書き込みだけを非同期スレッドへ逃がす。
 * JSON スキーマは 仕様/詳細設計/Redis・API設計.md を参照。
 */
public class PlayerBroadcastTask extends BukkitRunnable {

    private final MSALPlugin plugin;
    private final JedisPool jedisPool;
    private final int ttlSeconds;
    /** 前回の Redis 送信が終わっていない間は新しい送信を積まない（Redis が遅い・止まっているとき用）。 */
    private final AtomicBoolean publishing = new AtomicBoolean();
    private long lastSkipWarnMs;

    public PlayerBroadcastTask(MSALPlugin plugin, JedisPool jedisPool, int ttlSeconds) {
        this.plugin = plugin;
        this.jedisPool = jedisPool;
        this.ttlSeconds = ttlSeconds;
    }

    @Override
    public void run() {
        List<String[]> entries = new ArrayList<>();
        long now = System.currentTimeMillis();

        for (Player player : Bukkit.getOnlinePlayers()) {
            Location loc = player.getLocation();
            int channel = plugin.getRadioChannel(player.getUniqueId());
            String uuid = player.getUniqueId().toString();
            entries.add(new String[]{uuid, toJson(uuid, player, loc, channel, now)});
        }

        if (entries.isEmpty()) {
            return;
        }
        if (!publishing.compareAndSet(false, true)) {
            // 古い座標を積み上げても意味がない（TTL 5 秒）。最新の次回分で送り直す
            if (now - lastSkipWarnMs > 30_000) {
                lastSkipWarnMs = now;
                plugin.getLogger().warning("Redis への送信が前回分でまだ終わっていないためスキップしています（Redis の応答が遅い可能性）");
            }
            return;
        }
        try {
            Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> {
                try {
                    publish(entries);
                } finally {
                    publishing.set(false);
                }
            });
        } catch (RuntimeException e) {
            publishing.set(false); // プラグイン無効化中など
            throw e;
        }
    }

    private void publish(List<String[]> entries) {
        try (Jedis jedis = jedisPool.getResource()) {
            Pipeline pipeline = jedis.pipelined();
            for (String[] entry : entries) {
                pipeline.setex("vchat:player:" + entry[0], ttlSeconds, entry[1]);
            }
            pipeline.sync();
        } catch (Exception e) {
            plugin.getLogger().warning("Redis broadcast failed: " + e.getMessage());
        }
    }

    private static String toJson(String uuid, Player player, Location loc, int channel, long now) {
        JsonObject json = new JsonObject();
        json.addProperty("u", uuid);
        json.addProperty("n", player.getName());

        JsonArray pos = new JsonArray();
        pos.add(round2(loc.getX()));
        pos.add(round2(loc.getY()));
        pos.add(round2(loc.getZ()));
        json.add("p", pos);

        json.addProperty("y", normalizeYaw(loc.getYaw()));
        json.addProperty("w", loc.getWorld() != null ? loc.getWorld().getName() : "");
        json.addProperty("c", channel);
        json.addProperty("m", channel != 0 ? "radio" : "spatial");
        json.addProperty("t", now);
        json.addProperty("is_sneaking", player.isSneaking());
        json.addProperty("is_in_water", player.isInWater());
        return json.toString();
    }

    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    /** Bukkit の yaw（-180..180 など）を 0.0 - 360.0 に正規化する。 */
    private static double normalizeYaw(float yaw) {
        double y = yaw % 360.0;
        if (y < 0) {
            y += 360.0;
        }
        return round2(y);
    }
}
