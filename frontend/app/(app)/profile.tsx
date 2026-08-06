import React from "react";
import { ScrollView, StyleSheet, Text, View, TouchableOpacity, Alert, Share } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";

import { Card } from "@/src/components/Card";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";
import { formatFCFA, formatDate } from "@/src/utils/format";
import { setupWebPush, canUseWebPush, currentPermission } from "@/src/lib/firebase";
import { api } from "@/src/api";

export default function Profile() {
  const router = useRouter();
  const { user } = useAuth();
  const link = `https://spiloveure.com/u/${user?.username || "admin"}`;
  const [notifState, setNotifState] = React.useState<"unknown" | "granted" | "default" | "denied" | "unsupported">("unknown");

  React.useEffect(() => {
    (async () => {
      if (!(await canUseWebPush())) { setNotifState("unsupported"); return; }
      const p = currentPermission();
      setNotifState(p as any);
    })();
  }, []);

  const enableNotifications = async () => {
    const token = await setupWebPush((title, body) => {
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification(title, { body, icon: "/favicon.ico" });
        }
      } catch {}
    });
    setNotifState(currentPermission() as any);
    if (token && typeof window !== "undefined") {
      window.alert("✅ Notifications activées ! Vous recevrez désormais les alertes en temps réel.");
      try { await api.post("/push/test-self", {}); } catch {}
    } else if (typeof window !== "undefined") {
      const p = currentPermission();
      if (p === "denied") {
        window.alert("❌ Les notifications sont bloquées pour ce site.\n\nActivez-les manuellement :\n• Chrome : icône cadenas → Autorisations → Notifications → Autoriser\n• Firefox : icône bouclier → Autorisations → Notifications\n• Safari : Préférences → Sites Web → Notifications");
      } else {
        window.alert("⚠️ Autorisation refusée ou non accordée. Réessayez et cliquez sur 'Autoriser' dans la fenêtre du navigateur.");
      }
    }
  };

  const copy = async () => {
    await Clipboard.setStringAsync(link);
    Alert.alert("Copié ✅", "Lien d'invitation copié.");
  };

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={styles.avatar}>
          <Ionicons name="person" size={42} color="#fff" />
        </View>
        <Text style={styles.username}>{user?.username}</Text>
        <Text style={styles.email}>{user?.email}</Text>
      </LinearGradient>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Card>
          <Text style={styles.section}>Informations</Text>
          <Item icon="person" label="Nom d'utilisateur" value={user?.username || "—"} />
          <Item icon="mail" label="E-mail" value={user?.email || "—"} />
          <Item icon="call" label="Téléphone" value={user?.phone || "—"} />
          <Item icon="globe" label="Pays" value={user?.country || "—"} />
          <Item icon="ribbon" label="Niveau actuel" value={`Niveau ${user?.max_level ?? 0}`} />
          <Item icon="calendar" label="Date d'inscription" value={formatDate(user?.created_at)} />
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>Statistiques</Text>
          <Item icon="cash" label="Solde profit" value={formatFCFA(user?.balance_profit)} />
          <Item icon="lock-closed" label="Réserve mise à niveau" value={formatFCFA(user?.balance_upgrade)} />
          <Item icon="trending-up" label="Total gagné" value={formatFCFA(user?.total_earned)} />
          <Item icon="arrow-down-circle" label="Total retiré" value={formatFCFA(user?.total_withdrawn)} />
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>Notifications Push</Text>
          <View style={{ paddingVertical: 6 }}>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 12, marginBottom: 8 }}>
              {notifState === "granted" && "✅ Les notifications sont activées."}
              {notifState === "default" && "🔔 Activez les notifications pour recevoir les nouveaux commentaires, publicités et articles."}
              {notifState === "denied" && "❌ Les notifications sont bloquées. Réactivez-les dans les paramètres de votre navigateur."}
              {notifState === "unsupported" && "⚠️ Ce navigateur ne supporte pas les notifications push."}
              {notifState === "unknown" && "…"}
            </Text>
            {(notifState === "default" || notifState === "granted" || notifState === "denied") && (
              <TouchableOpacity
                onPress={enableNotifications}
                testID="profile-enable-notifications"
                style={{
                  backgroundColor: notifState === "granted" ? "#10B981" : theme.colors.primary,
                  paddingVertical: 12, borderRadius: 10, alignItems: "center",
                  flexDirection: "row", justifyContent: "center", gap: 8,
                }}
              >
                <Ionicons name="notifications" size={16} color="#fff" />
                <Text style={{ color: "#fff", fontWeight: "800" }}>
                  {notifState === "granted" ? "Envoyer un test" : "🔔 Activer les notifications"}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>Lien d'invitation</Text>
          <View style={styles.linkBox}><Text style={styles.linkText} numberOfLines={2}>{link}</Text></View>
          <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
            <TouchableOpacity style={[styles.copyBtn, { flex: 1 }]} onPress={copy} testID="profile-copy">
              <Ionicons name="copy" size={16} color="#fff" />
              <Text style={styles.copyBtnT}>Copier</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.copyBtn, { flex: 1, backgroundColor: theme.colors.primary }]}
              onPress={() => Share.share({ message: `Rejoignez Spiloveure : ${link}` })}
              testID="profile-share"
            >
              <Ionicons name="share-social" size={16} color="#fff" />
              <Text style={styles.copyBtnT}>Partager</Text>
            </TouchableOpacity>
          </View>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function Item({ icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <View style={styles.itemRow}>
      <View style={styles.itemIcon}><Ionicons name={icon} size={16} color={theme.colors.primary} /></View>
      <Text style={styles.itemLbl}>{label}</Text>
      <Text style={styles.itemVal}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 16, paddingTop: 24, alignItems: "center" },
  back: { position: "absolute", top: 24, left: 16, width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  avatar: { width: 96, height: 96, borderRadius: 48, backgroundColor: theme.colors.secondary, alignItems: "center", justifyContent: "center", marginTop: 12 },
  username: { color: "#fff", fontSize: 22, fontWeight: "800", marginTop: 12 },
  email: { color: "#C7D9FF" },
  section: { fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 8 },
  itemRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, gap: 10 },
  itemIcon: { width: 28, height: 28, borderRadius: 8, backgroundColor: "#DBEAFE", alignItems: "center", justifyContent: "center" },
  itemLbl: { flex: 1, color: theme.colors.textSecondary, fontSize: 13 },
  itemVal: { color: theme.colors.textPrimary, fontWeight: "700" },
  linkBox: { backgroundColor: theme.colors.surfaceSecondary, padding: 12, borderRadius: 12 },
  linkText: { color: theme.colors.textPrimary, fontSize: 12 },
  copyBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 12, backgroundColor: theme.colors.secondary },
  copyBtnT: { color: "#fff", fontWeight: "700" },
});
