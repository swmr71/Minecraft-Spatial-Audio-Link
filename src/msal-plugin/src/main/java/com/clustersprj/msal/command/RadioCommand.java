package com.clustersprj.msal.command;

import com.clustersprj.msal.MSALPlugin;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Sound;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;

/** /radio <channel> - 無線チャンネルの切り替え。0 はチャンネル未使用（距離ベースのみ）。 */
public class RadioCommand implements CommandExecutor {

    private final MSALPlugin plugin;

    public RadioCommand(MSALPlugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage(Component.text("このコマンドはゲーム内から実行してください。", NamedTextColor.RED));
            return true;
        }

        if (args.length != 1) {
            sender.sendMessage(Component.text("使い方: /radio <channel>（0で解除）", NamedTextColor.YELLOW));
            return true;
        }

        int channel;
        try {
            channel = Integer.parseInt(args[0]);
        } catch (NumberFormatException e) {
            sender.sendMessage(Component.text("チャンネルは数値で指定してください。", NamedTextColor.RED));
            return true;
        }

        plugin.setRadioChannel(player.getUniqueId(), channel);
        player.playSound(player.getLocation(), Sound.BLOCK_NOTE_BLOCK_IRON_XYLOPHONE, 1.0f, 1.0f);

        if (channel == 0) {
            player.sendMessage(Component.text("無線チャンネルを解除しました。", NamedTextColor.GRAY));
        } else {
            player.sendMessage(Component.text("無線チャンネル " + channel + " に切り替えました。", NamedTextColor.AQUA));
        }
        return true;
    }
}
