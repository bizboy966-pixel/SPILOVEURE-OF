import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { Card } from "@/src/components/Card";
import { Button } from "@/src/components/Button";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

type BotStatus = {
  token_configured?: boolean;
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.get<BotStatus>("/admin/telegram-bot"));
      setError("");
    } catch (e: any) {
      setError(e?.message || "Impossible de lire la configuration Telegram.");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const configure = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.post("/admin/telegram-bot/configure", {});
      setNotice("Webhook connecté. Ajoute le bot au groupe puis envoie /link dans le groupe depuis un compte administrateur.");
      await refresh();
    } catch (e: any) {
      setError(e?.message || "La connexion du bot a échoué.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ marginBottom: 12 }}>
      <Text style={{ fontSize: 16, fontWeight: "900", color: theme.colors.textPrimary }}>Bot Telegram — modération</Text>
      <Text style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 6 }}>
        Les annonces, publicités payées et tâches spéciales payées seront envoyées au groupe avec les boutons Valider et Rejeter. Tous les membres peuvent voter. Ajoute le bot comme administrateur Telegram du groupe, connecte le webhook, puis un administrateur du groupe envoie /link CODE dans ce groupe.
      </Text>
      <View style={{ marginTop: 10, padding: 10, backgroundColor: theme.colors.background, borderRadius: 10 }}>
        {status ? (
          <>
            <Text style={{ color: theme.colors.textPrimary, fontSize: 13 }}>
              Jeton du bot : {status.token_configured ? "configuré" : "à ajouter dans les Secrets"}
            </Text>
            <Text style={{ color: theme.colors.textPrimary, fontSize: 13, marginTop: 4 }}>
              Adresse HTTPS publique : {status.public_url_configured ? "configurée" : "à configurer dans TELEGRAM_PUBLIC_URL"}
            </Text>
            <Text style={{ color: theme.colors.textPrimary, fontSize: 13, marginTop: 4 }}>
              Webhook : {status.webhook_configured ? "connecté" : "non connecté"}
            </Text>
            <Text style={{ color: theme.colors.textPrimary, fontSize: 13, marginTop: 4 }}>
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
        ) : <ActivityIndicator color={theme.colors.primary} />}
      </View>
      {status?.webhook_url ? (
        <Text selectable style={{ color: theme.colors.textSecondary, fontSize: 11, marginTop: 6 }}>
          Webhook : {status.webhook_url}
        </Text>
      ) : null}
      {error ? <Text style={{ color: theme.colors.danger, marginTop: 8, fontSize: 12 }}>{error}</Text> : null}
      {notice ? <Text style={{ color: theme.colors.success, marginTop: 8, fontSize: 12 }}>{notice}</Text> : null}
      <View style={{ marginTop: 10 }}>
        <Button title={busy ? "Connexion…" : "Connecter le webhook Telegram"} onPress={configure} disabled={busy} />
      </View>
      <TouchableOpacity onPress={() => void refresh()} style={{ alignSelf: "flex-start", paddingVertical: 8 }}>
        <Text style={{ color: theme.colors.primary, fontWeight: "700", fontSize: 12 }}>Actualiser l’état</Text>
      </TouchableOpacity>
    </Card>
  );
}
