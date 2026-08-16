package com.clustersprj.msal;

import com.clustersprj.msal.api.BackendApiClient;
import com.clustersprj.msal.command.RadioCommand;
import com.clustersprj.msal.command.VCCommand;
import com.clustersprj.msal.task.PlayerBroadcastTask;
import org.bukkit.plugin.java.JavaPlugin;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.JedisPoolConfig;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public final class MSALPlugin extends JavaPlugin {

    /** プレイヤーごとの無線チャンネル（0 = 未使用）。ログアウトでリセットされる揮発的な状態。 */
    private final Map<UUID, Integer> radioChannels = new HashMap<>();

    private JedisPool jedisPool;
    private BackendApiClient backendApiClient;
    private PlayerBroadcastTask broadcastTask;

    @Override
    public void onEnable() {
        saveDefaultConfig();

        JedisPoolConfig poolConfig = new JedisPoolConfig();
        poolConfig.setMaxTotal(8);

        String host = getConfig().getString("redis.host", "127.0.0.1");
        int port = getConfig().getInt("redis.port", 6379);
        String password = getConfig().getString("redis.password", "");
        int database = getConfig().getInt("redis.database", 0);

        jedisPool = (password == null || password.isEmpty())
                ? new JedisPool(poolConfig, host, port, 2000, null, database)
                : new JedisPool(poolConfig, host, port, 2000, password, database);

        backendApiClient = new BackendApiClient(
                getConfig().getString("backend.base-url", "http://127.0.0.1:8010"));

        getCommand("vc").setExecutor(new VCCommand(this, backendApiClient,
                getConfig().getString("backend.login-url", "https://vc.clusters-prj.com/login/")));
        getCommand("radio").setExecutor(new RadioCommand(this));

        long intervalTicks = getConfig().getLong("broadcast.interval-ticks", 5);
        int ttlSeconds = getConfig().getInt("broadcast.ttl-seconds", 5);
        broadcastTask = new PlayerBroadcastTask(this, jedisPool, ttlSeconds);
        broadcastTask.runTaskTimerAsynchronously(this, 0L, intervalTicks);

        getLogger().info("MSALPlugin enabled.");
    }

    @Override
    public void onDisable() {
        if (broadcastTask != null) {
            broadcastTask.cancel();
        }
        if (backendApiClient != null) {
            backendApiClient.close();
        }
        if (jedisPool != null) {
            jedisPool.close();
        }
        getLogger().info("MSALPlugin disabled.");
    }

    public int getRadioChannel(UUID uuid) {
        return radioChannels.getOrDefault(uuid, 0);
    }

    public void setRadioChannel(UUID uuid, int channel) {
        radioChannels.put(uuid, channel);
    }
}
