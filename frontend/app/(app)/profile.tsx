import React from "react";
import { ScrollView, StyleSheet, Text, View, TouchableOpacity, Share } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";

import { Card } from "@/src/components/Card";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";
import { formatFCFA } from "@/src/utils/format";
import { setupWebPush, canUseWebPush, currentPermission } from "@/src/lib/firebase";
import { api } from "@/src/api";
import { BottomNav } from "@/src/components/BottomNav";
import { ProfileHeaderCard } from "@/src/components/profile/ProfileHeaderCard";
import { SupportGroupCard } from "@/src/components/profile/SupportGroupCard";

type Country = { code: string; name: string; flag?: string };

export default function Profile() {
  const router = useRouter();
  const { user } = useAuth();
  const link = `https://spiloveure.com/u/${user?.username || "admin"}`;
  const [notifState, setNotifState] = React.useState<"unknown" | "granted" | "default" | "denied" | "unsupported">("unknown");
  const [copied, setCopied] = React.useState(false);
  const [countries, setCountries] = React.useState<Country[]>([]);

  React.useEffect(() => {
    (async () => {
      if (!(await canUseWebPush())) { setNotifState("unsupported"); return; }
      const p = currentPermission();
      setNotifState(p as any);
    })();
    api.get<{ countries: Country[] }>("/config", { auth: false }).then((c) => setCountries(c?.countries || [])).catch(() => {});
  }, []);

  const country = countries.find((c) => c.code === user?.country);
  const countryLabel = country ? `${country.flag ? country.flag + " " : ""}${country.name}` : (user?.country || "—");

  const enableNotifications = async () => {
    const token = await setupWebPush((title, body) => {
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification(title, { body, icon: "/icon-192.png" });
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
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const share = async () => {
    try {
      await Share.share({ message: `Rejoignez Spiloveure : ${link}` });
    } catch {
      await copy();
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <SafeAreaView edges={["top"]}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.headBtn} testID="profile-back">
              <Ionicons name="arrow-back" size={22} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Profil</Text>
            <TouchableOpacity onPress={() => router.push("/(app)/settings")} style={styles.headBtn} testID="profile-settings">
              <Ionicons name="settings" size={21} color="#fff" />
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </LinearGradient>

      <ScrollView style={{ marginTop: -36 }} contentContainerStyle={{ padding: 16, paddingTop: 0, paddingBottom: 140 }}>
        <ProfileHeaderCard user={user} />

        <Card testID="profile-invite-card" style={{ marginTop: 12 }}>
          <View style={styles.cardHead}>
            <View style={styles.headIcon}><Ionicons name="link" size={19} color={theme.colors.primary} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.section}>Lien d'inscription</Text>
              <Text style={styles.hint}>Partagez ce lien pour inviter de nouveaux membres et développer votre réseau.</Text>
            </View>
          </View>
          <View style={styles.linkBox}>
            <Text style={styles.linkText} numberOfLines={2} testID="profile-invite-link">{link}</Text>
          </View>
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            <TouchableOpacity style={[styles.copyBtn, { flex: 1 }]} onPress={copy} testID="profile-copy">
              <Ionicons name={copied ? "checkmark" : "copy"} size={16} color="#fff" />
              <Text style={styles.copyBtnT}>{copied ? "Copié" : "Copier"}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.copyBtn, { flex: 1, backgroundColor: theme.colors.primary }]}
              onPress={share}
              testID="profile-share"
            >
              <Ionicons name="share-social" size={16} color="#fff" />
              <Text style={styles.copyBtnT}>Partager</Text>
            </TouchableOpacity>
          </View>
        </Card>

        <SupportGroupCard />

        <Card style={{ marginTop: 12 }} testID="profile-info-card">
          <View style={[styles.cardHead, { alignItems: "center" }]}>
            <View style={styles.headIcon}><Ionicons name="person" size={19} color={theme.colors.primary} /></View>
            <Text style={styles.section}>Informations personnelles</Text>
          </View>
          <Item icon="person" label="Nom d'utilisateur" value={user?.username || "—"} />
          <Item icon="mail" label="E-mail" value={user?.email || "—"} />
          <Item icon="call" label="Téléphone" value={user?.phone || "—"} />
          <Item icon="globe" label="Pays" value={countryLabel} />
          <Item icon="stats-chart" label="Niveau actuel" value={`Niveau ${user?.max_level ?? 0}`} last />
        </Card>

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>Statistiques</Text>
          <Item icon="cash" label="Solde profit" value={formatFCFA(user?.balance_profit)} />
          <Item icon="lock-closed" label="Réserve mise à niveau" value={formatFCFA(user?.balance_upgrade)} />
          <Item icon="trending-up" label="Total gagné" value={formatFCFA(user?.total_earned)} />
          <Item icon="arrow-down-circle" label="Total retiré" value={formatFCFA(user?.total_withdrawn)} last />
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
                  paddingVertical: 12, borderRadius: 12, alignItems: "center",
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
      </ScrollView>

      <BottomNav />
    </View>
  );
}

function Item({ icon, label, value, last }: { icon: any; label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.itemRow, !last && styles.itemDivider]}>
      <View style={styles.itemIcon}><Ionicons name={icon} size={15} color={theme.colors.primary} /></View>
      <Text style={styles.itemLbl}>{label}</Text>
      <Text style={styles.itemVal} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 52 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  headBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, color: "#fff", fontSize: 22, fontWeight: "800", letterSpacing: -0.3 },
  section: { fontWeight: "800", color: theme.colors.textPrimary, fontSize: 15.5, letterSpacing: -0.2 },
  cardHead: { flexDirection: "row", gap: 12, marginBottom: 12 },
  headIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: theme.colors.primaryBg, alignItems: "center", justifyContent: "center" },
  hint: { color: theme.colors.textSecondary, fontSize: 12.5, marginTop: 3, lineHeight: 17 },
  itemRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: 10 },
  itemDivider: { borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  itemIcon: { width: 28, height: 28, borderRadius: 10, backgroundColor: "#DBEAFE", alignItems: "center", justifyContent: "center" },
  itemLbl: { flex: 1, color: theme.colors.textSecondary, fontSize: 13 },
  itemVal: { color: theme.colors.textPrimary, fontWeight: "700", flexShrink: 1, maxWidth: "60%", textAlign: "right" },
  linkBox: { backgroundColor: theme.colors.surfaceSecondary, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.border },
  linkText: { color: theme.colors.textPrimary, fontSize: 13, fontWeight: "600" },
  copyBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12, borderRadius: 14, backgroundColor: theme.colors.secondary },
  copyBtnT: { color: "#fff", fontWeight: "800" },
});
