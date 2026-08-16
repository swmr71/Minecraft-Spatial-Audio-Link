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

/**
 * 全プレイヤーの座標・向き・状態を収集し、Redis へ非同期publishする。
 * Bukkit API へのアクセスはメインスレッド（run）で行い、
 * Redis への書き込みだけを非同期スレッドへ逃がす。
 */
public class PlayerBroadcastTask extends BukkitRunnable {

    private final MSALPlugin plugin;
    private final JedisPool jedisPool;
    private final int ttlSeconds;

    public PlayerBroadcastTask(MSALPlugin plugin, JedisPool jedisPool, int ttlSeconds) {
        this.plugin = plugin;
        this.jedisPool = jedisPool;
        this.ttlSeconds = ttlSeconds;
    }

    @Override
    public void run() {
        // メインスレッド: Bukkit API から安全にスナップショットを取る
        List<PlayerSnapshot> snapshots = new ArrayList<>();
        for (Player player : Bukkit.getOnlinePlayers()) {
            Location loc = player.getLocation();
            snapshots.add(new PlayerSnapshot(
                    player.getUniqueId().toString(),
                    player.getName(),
                    loc.getX(), loc.getY(), loc.getZ(),
                    loc.getYaw(),
                    plugin.getRadioChannel(player.getUniqueId()),
                    player.isSneaking(),
                    player.isInWater()
            ));
        }

        if (snapshots.isEmpty()) {
            return;
        }

        // 非同期スレッド: Redis への書き込み
        Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> publish(snapshots));
    }

    private void publish(List<PlayerSnapshot> snapshots) {
        try (Jedis jedis = jedisPool.getResource()) {
            Pipeline pipeline = jedis.pipelined();
            for (PlayerSnapshot snapshot : snapshots) {
                pipeline.setex("vchat:player:" + snapshot.uuid(), ttlSeconds, snapshot.toJson());
            }
            pipeline.sync();
        } catch (Exception e) {
            plugin.getLogger().warning("Redis broadcast failed: " + e.getMessage());
        }
    }

    private record PlayerSnapshot(
            String uuid, String name,
            double x, double y, double z,
            float yaw, int radioChannel,
            boolean sneaking, boolean inWater
    ) {
        String toJson() {
            JsonObject json = new JsonObject();
            json.addProperty("u", uuid);
            json.addProperty("n", name);

            JsonArray pos = new JsonArray();
            pos.add(x);
            pos.add(y);
            pos.add(z);
            json.add("p", pos);

            json.addProperty("y", yaw);
            json.addProperty("c", radioChannel);
            json.addProperty("is_sneaking", sneaking);
            json.addProperty("is_in_water", inWater);
            return json.toString();
        }
    }
}
