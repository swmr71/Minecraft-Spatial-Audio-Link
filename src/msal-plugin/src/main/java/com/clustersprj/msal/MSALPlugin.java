package com.clustersprj.msal;

import com.clustersprj.msal.api.BackendApiClient;
import com.clustersprj.msal.command.RadioCommand;
import com.clustersprj.msal.command.VCCommand;
import com.clustersprj.msal.listener.PlayerQuitListener;
import com.clustersprj.msal.task.PlayerBroadcastTask;
import org.bukkit.command.PluginCommand;
import org.bukkit.plugin.java.JavaPlugin;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.JedisPoolConfig;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public final class MSALPlugin extends JavaPlugin {

    /** プレイヤーごとの無線チャンネル（0 = 未使用）。ログアウトでリセットされる揮発的な状態。 */
    private final Map<UUID, Integer> radioChannels = new ConcurrentHashMap<>();

    private JedisPool jedisPool;
    private PlayerBroadcastTask broadcastTask;

    @Override
    public void onEnable() {
        saveDefaultConfig();

        String apiKey = getConfig().getString("backend.api-key", "");
        if (apiKey == null || apiKey.isBlank()) {
            getLogger().severe("backend.api-key が未設定です。msal-node の PLUGIN_API_KEY と同じ値を config.yml に設定してください。");
            getServer().getPluginManager().disablePlugin(this);
            return;
        }

        JedisPoolConfig poolConfig = new JedisPoolConfig();
        poolConfig.setMaxTotal(4);
        // Redis が遠い（トンネル越しなど）・止まっているとき、非同期スレッドが接続待ちで溜まらないようにする
        poolConfig.setMaxWait(java.time.Duration.ofMillis(300));
        // トンネルの再起動などで死んだ接続を、アイドル中に掃除する
        poolConfig.setTestWhileIdle(true);
        poolConfig.setTimeBetweenEvictionRuns(java.time.Duration.ofSeconds(30));

        String host = getConfig().getString("redis.host", "127.0.0.1");
        int port = getConfig().getInt("redis.port", 6379);
        String password = getConfig().getString("redis.password", "");
        int database = getConfig().getInt("redis.database", 0);
        int timeoutMs = Math.max(200, getConfig().getInt("redis.timeout-ms", 1000));

        jedisPool = (password == null || password.isEmpty())
                ? new JedisPool(poolConfig, host, port, timeoutMs, null, database)
                : new JedisPool(poolConfig, host, port, timeoutMs, password, database);

        BackendApiClient backendApiClient = new BackendApiClient(
                getConfig().getString("backend.base-url", "http://127.0.0.1:8010"), apiKey);

        registerCommand("vc", new VCCommand(this, backendApiClient,
                getConfig().getString("backend.login-url", "https://vc.clusters-prj.com/login/")));
        registerCommand("radio", new RadioCommand(this, getConfig().getInt("radio.max-channel", 999)));
        getServer().getPluginManager().registerEvents(new PlayerQuitListener(this), this);

        long intervalTicks = Math.max(1, getConfig().getLong("broadcast.interval-ticks", 5));
        int ttlSeconds = Math.max(1, getConfig().getInt("broadcast.ttl-seconds", 5));
        broadcastTask = new PlayerBroadcastTask(this, jedisPool, ttlSeconds);
        // Bukkit API に触るためメインスレッドで実行し、Redis 書き込みだけを非同期へ逃がす
        broadcastTask.runTaskTimer(this, 0L, intervalTicks);

        getLogger().info("MSALPlugin enabled.");
    }

    @Override
    public void onDisable() {
        if (broadcastTask != null) {
            broadcastTask.cancel();
        }
        if (jedisPool != null) {
            jedisPool.close();
        }
        getLogger().info("MSALPlugin disabled.");
    }

    private void registerCommand(String name, org.bukkit.command.TabExecutor executor) {
        PluginCommand command = getCommand(name);
        if (command == null) {
            throw new IllegalStateException("plugin.yml にコマンド '" + name + "' が定義されていません");
        }
        command.setExecutor(executor);
        command.setTabCompleter(executor);
    }

    public int getRadioChannel(UUID uuid) {
        return radioChannels.getOrDefault(uuid, 0);
    }

    public void setRadioChannel(UUID uuid, int channel) {
        if (channel == 0) {
            radioChannels.remove(uuid);
        } else {
            radioChannels.put(uuid, channel);
        }
    }

    public void clearRadioChannel(UUID uuid) {
        radioChannels.remove(uuid);
    }
}
