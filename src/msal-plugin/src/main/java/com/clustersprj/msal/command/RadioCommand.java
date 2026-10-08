package com.clustersprj.msal.command;

import com.clustersprj.msal.MSALPlugin;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Sound;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabExecutor;
import org.bukkit.entity.Player;

import java.util.List;

/** /radio <channel> - 無線チャンネルの切り替え。0 はチャンネル未使用（距離ベースのみ）。 */
public class RadioCommand implements TabExecutor {

    private final MSALPlugin plugin;
    private final int maxChannel;

    public RadioCommand(MSALPlugin plugin, int maxChannel) {
        this.plugin = plugin;
        this.maxChannel = maxChannel;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage(Component.text("このコマンドはゲーム内から実行してください。", NamedTextColor.RED));
            return true;
        }
        if (!player.hasPermission("msal.use")) {
            player.sendMessage(Component.text("権限がありません。", NamedTextColor.RED));
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
        if (channel < 0 || channel > maxChannel) {
            sender.sendMessage(Component.text("チャンネルは 0〜" + maxChannel + " の範囲で指定してください。", NamedTextColor.RED));
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

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        return args.length == 1 ? List.of("0") : List.of();
    }
}
