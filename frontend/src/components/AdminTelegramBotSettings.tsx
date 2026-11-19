import React, { useCallback, useEffect, useState } from "react";
import { Text, TextInput, TouchableOpacity, View } from "react-native";
import { Card } from "@/src/components/Card";
import { Button } from "@/src/components/Button";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

type BotStatus = {
  token_configured?: boolean;
  token_source?: "admin" | "environment" | "";
  bot_verified?: boolean;
  bot_username?: string;
  bot_name?: string;
  group_chat_id?: string;
  group_title?: string;
  group_link_code?: string;
  group_link_code_expires_at?: string;
  webhook_configured?: boolean;
  webhook_url?: string;
  public_url_configured?: boolean;
};

export default function AdminTelegramBotSettings() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.get<BotStatus>("/admin/telegram-bot"));
      setError("");
    } catch (e: any) {
      setError(e?.detail || e?.message || "Impossible de lire la configuration Telegram.");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveToken = async () => {
    if (!token.trim()) {
      setError("Saisissez le nouveau jeton avant de l’enregistrer.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.post("/admin/telegram-bot/token", { token: token.trim() });
      setToken("");
      setNotice("Jeton enregistré de façon chiffrée. Vérifiez ensuite le bot auprès de Telegram.");
      await refresh();
    } catch (e: any) {
      setError(e?.detail || e?.message || "Impossible d’enregistrer le jeton.");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.post<Partial<BotStatus> & { ok: boolean }>("/admin/telegram-bot/verify", {});
      setStatus((current) => ({ ...current, ...result }));
      setNotice(
        result.bot_username
          ? `Bot vérifié : @${result.bot_username}${result.webhook_configured ? " • webhook connecté" : " • webhook à connecter"}`
          : "Connexion au bot vérifiée.",
      );
      await refresh();
    } catch (e: any) {
      setError(e?.detail || e?.message || "La vérification du bot a échoué.");
    } finally {
      setBusy(false);
    }
  };

  const configure = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.post("/admin/telegram-bot/configure", {});
      setNotice("Webhook connecté. Ajoute le bot au groupe puis envoie /link CODE dans le groupe depuis un compte administrateur.");
      await refresh();
    } catch (e: any) {
      setError(e?.detail || e?.message || "La connexion du webhook a échoué.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ marginBottom: 12 }} testID="admin-telegram-bot-settings">
      <Text style={{ fontSize: 16, fontWeight: "900", color: theme.colors.textPrimary }}>
        Bot Telegram — modération
      </Text>
      <Text style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 6 }}>
        Enregistrez le jeton du bot ici. Il est masqué dans ce formulaire et chiffré sur le serveur.
        Les annonces, publicités payées et tâches spéciales payées continueront d’utiliser le groupe lié.
      </Text>

      <Text style={{ color: theme.colors.textPrimary, fontSize: 13, fontWeight: "700", marginTop: 12, marginBottom: 5 }}>
        Jeton du bot
      </Text>
      <TextInput
        value={token}
        onChangeText={setToken}
        placeholder={status?.token_configured ? "Laisser vide pour conserver le jeton actuel" : "Coller le jeton Telegram"}
        placeholderTextColor={theme.colors.textSecondary}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType="none"
        accessibilityLabel="Nouveau jeton Telegram"
        testID="input-telegram-bot-token"
        style={{
          borderWidth: 1,
          borderColor: theme.colors.borderStrong,
          borderRadius: 10,
          backgroundColor: theme.colors.surface,
          color: theme.colors.textPrimary,
          paddingHorizontal: 12,
          paddingVertical: 12,
          fontSize: 14,
        }}
      />
      <View style={{ marginTop: 8 }}>
        <Button
          title={busy ? "Enregistrement…" : "Enregistrer le jeton"}
          onPress={saveToken}
          disabled={busy || !token.trim()}
          testID="button-save-telegram-token"
        />
      </View>

      <View style={{ marginTop: 10, padding: 10, backgroundColor: theme.colors.background, borderRadius: 10 }}>
        {status ? (
          <>
            <Text testID="status-telegram-token" style={{ color: theme.colors.textPrimary, fontSize: 13 }}>
              Jeton : {status.token_configured
                ? `configuré${status.token_source === "environment" ? " (solution de compatibilité)" : " dans Réglages"}`
                : "à configurer"}
            </Text>
            <Text testID="status-telegram-bot" style={{ color: theme.colors.textPrimary, fontSize: 13, marginTop: 4 }}>
              Bot : {status.bot_verified
                ? `${status.bot_name || "vérifié"}${status.bot_username ? ` (@${status.bot_username})` : ""}`
                : "non vérifié"}
            </Text>
            <Text style={{ color: theme.colors.textPrimary, fontSize: 13, marginTop: 4 }}>
              Adresse HTTPS publique : {status.public_url_configured ? "configurée" : "à configurer dans TELEGRAM_PUBLIC_URL"}
            </Text>
            <Text testID="status-telegram-webhook" style={{ color: theme.colors.textPrimary, fontSize: 13, marginTop: 4 }}>
              Webhook : {status.webhook_configured ? "connecté" : "non connecté"}
            </Text>
            <Text testID="status-telegram-group" style={{ color: theme.colors.textPrimary, fontSize: 13, marginTop: 4 }}>
              Groupe : {status.group_title ? `${status.group_title} (${status.group_chat_id})` : "pas encore relié"}
            </Text>
            {!status.group_chat_id && status.group_link_code ? (
              <Text selectable style={{ color: theme.colors.primary, fontSize: 15, fontWeight: "900", marginTop: 8 }}>
                Code de liaison temporaire : {status.group_link_code}
              </Text>
            ) : null}
            {!status.group_chat_id && status.group_link_code_expires_at ? (
              <Text style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 3 }}>
                Expire : {new Date(status.group_link_code_expires_at).toLocaleTimeString()}
              </Text>
            ) : null}
          </>
        ) : null}
      </View>
      {status?.webhook_url ? (
        <Text selectable style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 6 }}>
          Webhook : {status.webhook_url}
        </Text>
      ) : null}
      {error ? <Text testID="error-telegram-settings" style={{ color: theme.colors.danger, marginTop: 8, fontSize: 12 }}>{error}</Text> : null}
      {notice ? <Text testID="notice-telegram-settings" style={{ color: theme.colors.success, marginTop: 8, fontSize: 12 }}>{notice}</Text> : null}
      <View style={{ marginTop: 10, gap: 8 }}>
        <Button
          title={busy ? "Vérification…" : "Vérifier la connexion du bot"}
          onPress={verify}
          disabled={busy || !status?.token_configured}
          variant="outline"
          testID="button-verify-telegram-bot"
        />
        <Button
          title={busy ? "Connexion…" : "Connecter le webhook Telegram"}
          onPress={configure}
          disabled={busy || !status?.token_configured || !status?.public_url_configured}
          testID="button-configure-telegram-webhook"
        />
      </View>
      <TouchableOpacity
        onPress={() => void refresh()}
        style={{ alignSelf: "flex-start", paddingVertical: 8 }}
        testID="button-refresh-telegram-status"
      >
        <Text style={{ color: theme.colors.primary, fontWeight: "700", fontSize: 12 }}>Actualiser l’état</Text>
      </TouchableOpacity>
    </Card>
  );
}
