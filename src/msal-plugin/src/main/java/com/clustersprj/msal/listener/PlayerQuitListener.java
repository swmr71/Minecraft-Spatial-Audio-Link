package com.clustersprj.msal.listener;

import com.clustersprj.msal.MSALPlugin;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerQuitEvent;

/** ログアウトで無線チャンネルをリセットする（揮発状態の取りこぼしとメモリリーク防止）。 */
public class PlayerQuitListener implements Listener {

    private final MSALPlugin plugin;

    public PlayerQuitListener(MSALPlugin plugin) {
        this.plugin = plugin;
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        plugin.clearRadioChannel(event.getPlayer().getUniqueId());
    }
}
