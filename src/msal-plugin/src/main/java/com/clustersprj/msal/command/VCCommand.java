package com.clustersprj.msal.command;

import com.clustersprj.msal.MSALPlugin;
import com.clustersprj.msal.api.BackendApiClient;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;

/** /vc join, /vc broadcast <message...> */
public class VCCommand implements CommandExecutor {

    private final MSALPlugin plugin;
    private final BackendApiClient backendApiClient;
    private final String loginUrl;

    public VCCommand(MSALPlugin plugin, BackendApiClient backendApiClient, String loginUrl) {
        this.plugin = plugin;
        this.backendApiClient = backendApiClient;
        this.loginUrl = loginUrl;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length == 0) {
            sender.sendMessage(Component.text("使い方: /vc <join|broadcast>", NamedTextColor.YELLOW));
            return true;
        }

        switch (args[0].toLowerCase()) {
            case "join", "link" -> handleJoin(sender);
            case "broadcast" -> handleBroadcast(sender, args);
            default -> sender.sendMessage(Component.text("使い方: /vc <join|broadcast>", NamedTextColor.YELLOW));
        }
        return true;
    }

    private void handleJoin(CommandSender sender) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage(Component.text("このコマンドはゲーム内から実行してください。", NamedTextColor.RED));
            return;
        }

        sender.sendMessage(Component.text("VC接続用のコードを発行しています...", NamedTextColor.GRAY));

        backendApiClient.generateLoginToken(
                player.getUniqueId(),
                player.getName(),
                token -> Bukkit.getScheduler().runTask(plugin, () -> {
                    Component message = Component.text("[VC接続] ここをクリックしてログイン（コード: " + token + "）", NamedTextColor.GREEN)
                            .clickEvent(ClickEvent.openUrl(loginUrl));
                    player.sendMessage(message);
                }),
                error -> Bukkit.getScheduler().runTask(plugin, () ->
                        player.sendMessage(Component.text("トークン発行に失敗しました: " + error, NamedTextColor.RED)))
        );
    }

    private void handleBroadcast(CommandSender sender, String[] args) {
        if (!sender.hasPermission("msal.broadcast")) {
            sender.sendMessage(Component.text("権限がありません。", NamedTextColor.RED));
            return;
        }
        if (args.length < 2) {
            sender.sendMessage(Component.text("使い方: /vc broadcast <message...>", NamedTextColor.YELLOW));
            return;
        }

        String message = String.join(" ", java.util.Arrays.copyOfRange(args, 1, args.length));
        Component title = Component.text(message, NamedTextColor.AQUA);
        for (Player player : Bukkit.getOnlinePlayers()) {
            player.showTitle(net.kyori.adventure.title.Title.title(title, Component.empty()));
        }
        sender.sendMessage(Component.text("放送しました: " + message, NamedTextColor.GRAY));
    }
}
