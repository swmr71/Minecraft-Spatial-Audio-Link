package com.clustersprj.msal.command;

import com.clustersprj.msal.MSALPlugin;
import com.clustersprj.msal.api.BackendApiClient;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.title.Title;
import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabExecutor;
import org.bukkit.entity.Player;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/** /vc join, /vc broadcast <message...> */
public class VCCommand implements TabExecutor {

    private static final List<String> SUBCOMMANDS = List.of("join", "broadcast");

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
            sendUsage(sender);
            return true;
        }

        switch (args[0].toLowerCase(Locale.ROOT)) {
            case "join", "link" -> handleJoin(sender);
            case "broadcast" -> handleBroadcast(sender, args);
            default -> sendUsage(sender);
        }
        return true;
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        if (args.length != 1) {
            return List.of();
        }
        String prefix = args[0].toLowerCase(Locale.ROOT);
        return SUBCOMMANDS.stream()
                .filter(s -> s.startsWith(prefix))
                .filter(s -> !s.equals("broadcast") || sender.hasPermission("msal.broadcast"))
                .toList();
    }

    private void sendUsage(CommandSender sender) {
        sender.sendMessage(Component.text("使い方: /vc <join|broadcast>", NamedTextColor.YELLOW));
    }

    private void handleJoin(CommandSender sender) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage(Component.text("このコマンドはゲーム内から実行してください。", NamedTextColor.RED));
            return;
        }
        if (!player.hasPermission("msal.use")) {
            player.sendMessage(Component.text("権限がありません。", NamedTextColor.RED));
            return;
        }

        player.sendMessage(Component.text("VC接続用のコードを発行しています...", NamedTextColor.GRAY));

        backendApiClient.generateLoginToken(
                player.getUniqueId(),
                player.getName(),
                token -> Bukkit.getScheduler().runTask(plugin, () -> {
                    Component message = Component.text(
                                    "[VC接続] ここをクリックしてログイン（コード: " + token + " / 5分間有効）",
                                    NamedTextColor.GREEN)
                            .clickEvent(ClickEvent.openUrl(buildLoginUrl(player.getName())));
                    player.sendMessage(message);
                }),
                error -> {
                    // 内部URL・例外内容をプレイヤーに見せず、詳細はコンソールにだけ出す
                    plugin.getLogger().warning("ログインコード発行に失敗 (" + player.getName() + "): " + error);
                    Bukkit.getScheduler().runTask(plugin, () -> player.sendMessage(Component.text(
                            "コードの発行に失敗しました。時間をおいて再度お試しください。", NamedTextColor.RED)));
                }
        );
    }

    /** ログイン画面で Minecraft ID を自動入力させる。 */
    private String buildLoginUrl(String mcName) {
        String separator = loginUrl.contains("?") ? "&" : "?";
        return loginUrl + separator + "mc_name=" + URLEncoder.encode(mcName, StandardCharsets.UTF_8);
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

        String message = String.join(" ", Arrays.copyOfRange(args, 1, args.length));
        Title title = Title.title(Component.text(message, NamedTextColor.AQUA), Component.empty());
        for (Player player : Bukkit.getOnlinePlayers()) {
            player.showTitle(title);
        }
        sender.sendMessage(Component.text("放送しました: " + message, NamedTextColor.GRAY));
    }
}
