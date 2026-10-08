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
import java.util.UUID;

/** /vc join, /vc broadcast <message...|stop>, /vc mute|unmute <channel> */
public class VCCommand implements TabExecutor {

    private static final List<String> SUBCOMMANDS = List.of("join", "broadcast", "mute", "unmute");
    private static final String USAGE = "使い方: /vc <join|broadcast|mute|unmute>";

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
            case "mute" -> handleMute(sender, args, true);
            case "unmute" -> handleMute(sender, args, false);
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
                .filter(s -> !(s.equals("mute") || s.equals("unmute")) || sender.hasPermission("msal.mute.*"))
                .toList();
    }

    private void sendUsage(CommandSender sender) {
        sender.sendMessage(Component.text(USAGE, NamedTextColor.YELLOW));
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
            sender.sendMessage(Component.text("使い方: /vc broadcast <message...> | /vc broadcast stop", NamedTextColor.YELLOW));
            return;
        }

        // 「stop」単独は放送終了。メッセージとして「stop」だけを送ることはできない
        if (args.length == 2 && args[1].equalsIgnoreCase("stop")) {
            UUID target = sender instanceof Player p ? p.getUniqueId() : null; // コンソールは全放送を停止
            backendApiClient.stopBroadcast(target,
                    () -> reply(sender, Component.text("放送を終了しました。", NamedTextColor.GRAY)),
                    error -> replyError(sender, "放送の終了に失敗しました", error));
            return;
        }

        String message = String.join(" ", Arrays.copyOfRange(args, 1, args.length));
        Title title = Title.title(Component.text(message, NamedTextColor.AQUA), Component.empty());
        for (Player player : Bukkit.getOnlinePlayers()) {
            player.showTitle(title);
        }

        if (!(sender instanceof Player player)) {
            sender.sendMessage(Component.text("タイトルのみ表示しました（音声放送はゲーム内から実行してください）。", NamedTextColor.GRAY));
            return;
        }

        // あなたの声が全員に届く。停止は /vc broadcast stop（最大継続時間で自動終了）
        backendApiClient.startBroadcast(player.getUniqueId(), player.getName(), message,
                () -> reply(sender, Component.text(
                        "全体放送を開始しました。VC に接続して話してください。終了は /vc broadcast stop", NamedTextColor.GREEN)),
                error -> replyError(sender, "放送の開始に失敗しました", error));
    }

    private void handleMute(CommandSender sender, String[] args, boolean mute) {
        if (args.length != 2) {
            sender.sendMessage(Component.text("使い方: /vc " + (mute ? "mute" : "unmute") + " <channel>", NamedTextColor.YELLOW));
            return;
        }
        int channel;
        try {
            channel = Integer.parseInt(args[1]);
        } catch (NumberFormatException e) {
            sender.sendMessage(Component.text("チャンネルは数値で指定してください。", NamedTextColor.RED));
            return;
        }
        if (channel < 1) {
            sender.sendMessage(Component.text("チャンネルは 1 以上で指定してください。", NamedTextColor.RED));
            return;
        }
        // 担当チャンネルの判定は LuckPerms 等の権限ノードに任せる: msal.mute.* または msal.mute.<channel>
        if (!sender.hasPermission("msal.mute.*") && !sender.hasPermission("msal.mute." + channel)) {
            sender.sendMessage(Component.text("このチャンネルを操作する権限がありません。", NamedTextColor.RED));
            return;
        }

        backendApiClient.setChannelMuted(channel, mute,
                () -> reply(sender, Component.text(
                        "チャンネル " + channel + " を" + (mute ? "ミュートしました。" : "ミュート解除しました。"), NamedTextColor.GRAY)),
                error -> replyError(sender, "ミュート操作に失敗しました", error));
    }

    /** HTTP コールバック（ワーカースレッド）からメインスレッドに戻して返信する。 */
    private void reply(CommandSender sender, Component message) {
        Bukkit.getScheduler().runTask(plugin, () -> sender.sendMessage(message));
    }

    private void replyError(CommandSender sender, String summary, String detail) {
        plugin.getLogger().warning(summary + " (" + sender.getName() + "): " + detail);
        reply(sender, Component.text(summary + "。時間をおいて再度お試しください。", NamedTextColor.RED));
    }
}
