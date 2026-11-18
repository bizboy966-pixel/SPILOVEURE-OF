import React, { useEffect, useState } from "react";
import { FlatList, StyleSheet, Text, View, TouchableOpacity, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";

import { Card } from "@/src/components/Card";
import { Button } from "@/src/components/Button";
import { PasswordConfirmModal } from "@/src/components/PasswordConfirmModal";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";
import { formatFCFA } from "@/src/utils/format";

export default function Matrices() {
  const router = useRouter();
  const { user, refresh } = useAuth();
  const [levels, setLevels] = useState<any[]>([]);
  const [pendingLevel, setPendingLevel] = useState<number | null>(null);
  const [showPwd, setShowPwd] = useState(false);

  useEffect(() => {
    (async () => {
      const cfg = await api.get<{ levels: any[] }>("/config", { auth: false });
      setLevels(cfg.levels);
    })();
  }, []);

  const activate = async (token: string) => {
    if (!pendingLevel) return;
    try {
      await api.post("/activations/request", {
        level: pendingLevel,
        payment_method: "internal",
      }, { pwdConfirm: token });
      Alert.alert("Activation réussie ✅", `Niveau ${pendingLevel} activé !`);
      await refresh();
    } catch (e: any) {
      Alert.alert("Erreur", e?.detail || "Activation impossible.");
    } finally {
      setPendingLevel(null);
    }
  };

  const onActivate = (lvl: number) => {
    if (lvl === 1) {
      // Route to the new 4-step activation flow (/(app)/pay), not the
      // legacy /(app)/activation page which was retired in v2.
      router.push("/(app)/pay");
      return;
    }
    setPendingLevel(lvl);
    setShowPwd(true);
  };

  const maxLevel = user?.max_level ?? 0;
  const upgradeBalance = user?.balance_upgrade ?? 0;

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back} testID="matrices-back">
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Les Matrices</Text>
        <Text style={styles.sub}>12 niveaux pour développer votre revenu.</Text>
      </LinearGradient>

      <FlatList
        data={levels}
        keyExtractor={(it) => String(it.level)}
        contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
        renderItem={({ item }) => {
          const isActive = item.level <= maxLevel;
          const isNext = item.level === maxLevel + 1;
          const status = isActive ? "active" : isNext ? "available" : "locked";
          return (
            <Card style={{ marginBottom: 12 }}>
              <View style={styles.cardHead}>
                <View style={styles.lvlNum}><Text style={styles.lvlNumT}>{item.level}</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.lvlName}>{item.name}</Text>
                  <Text style={styles.lvlPrice}>{formatFCFA(item.price)}</Text>
                </View>
                <StatusPill status={status} />
              </View>
              <View style={styles.stats}>
                <Stat label="Invités" value={String(item.invites_required)} icon="people" />
                <Stat label="Commission" value={formatFCFA(item.commission_per_invite)} icon="cash" />
                <Stat label="Profit" value={formatFCFA(item.profit)} icon="trending-up" />
              </View>
              {isActive ? (
                <View style={[styles.btnActivated]}>
                  <Ionicons name="checkmark-circle" size={18} color={theme.colors.success} />
                  <Text style={styles.btnActivatedT}>Activé</Text>
                </View>
              ) : isNext ? (
                <Button
                  title={item.level === 1 ? "Activer Niveau 1" : `Activer (${formatFCFA(item.price)})`}
                  onPress={() => onActivate(item.level)}
                  testID={`activate-level-${item.level}`}
                  variant={upgradeBalance >= item.price || item.level === 1 ? "primary" : "outline"}
                />
              ) : (
                <View style={styles.btnLocked}>
                  <Ionicons name="lock-closed" size={16} color={theme.colors.textSecondary} />
                  <Text style={styles.btnLockedT}>Activez les niveaux précédents</Text>
                </View>
              )}
            </Card>
          );
        }}
      />

      <PasswordConfirmModal
        visible={showPwd}
        onClose={() => { setShowPwd(false); setPendingLevel(null); }}
        onConfirm={activate}
        title={`Activer le Niveau ${pendingLevel ?? ""}`}
      />
    </SafeAreaView>
  );
}

function StatusPill({ status }: { status: "active" | "available" | "locked" }) {
  const cfg = {
    active: { bg: theme.colors.successBg, color: theme.colors.success, label: "Activé", icon: "checkmark-circle" as const },
    available: { bg: theme.colors.warningBg, color: theme.colors.warning, label: "Disponible", icon: "time" as const },
    locked: { bg: theme.colors.dangerBg, color: theme.colors.danger, label: "Verrouillé", icon: "lock-closed" as const },
  }[status];
  return (
    <View style={[styles.pill, { backgroundColor: cfg.bg }]}>
      <Ionicons name={cfg.icon} size={12} color={cfg.color} />
      <Text style={[styles.pillT, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
}

function Stat({ label, value, icon }: { label: string; value: string; icon: any }) {
  return (
    <View style={styles.stat}>
      <Ionicons name={icon} size={14} color={theme.colors.primary} />
      <Text style={styles.statLbl}>{label}</Text>
      <Text style={styles.statVal}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 16, paddingTop: 24, paddingBottom: 20 },
  back: { width: 36, height: 36, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", marginBottom: 8 },
  title: { color: "#fff", fontSize: 24, fontWeight: "800" },
  sub: { color: "#C7D9FF" },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  lvlNum: { width: 48, height: 48, borderRadius: 28, backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center" },
  lvlNumT: { color: "#fff", fontWeight: "800", fontSize: 18 },
  lvlName: { fontWeight: "800", fontSize: 18, color: theme.colors.textPrimary },
  lvlPrice: { color: theme.colors.primary, fontWeight: "700" },
  pill: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 14 },
  pillT: { fontWeight: "700", fontSize: 11 },
  stats: { flexDirection: "row", marginVertical: 12, gap: 8 },
  stat: { flex: 1, backgroundColor: theme.colors.surfaceSecondary, padding: 10, borderRadius: 12, alignItems: "center", gap: 2 },
  statLbl: { color: theme.colors.textSecondary, fontSize: 11 },
  statVal: { fontWeight: "700", color: theme.colors.textPrimary, fontSize: 12 },
  btnActivated: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, paddingVertical: 12, borderRadius: 14, backgroundColor: theme.colors.successBg },
  btnActivatedT: { color: theme.colors.success, fontWeight: "800" },
  btnLocked: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, paddingVertical: 12, borderRadius: 14, backgroundColor: theme.colors.surfaceSecondary },
  btnLockedT: { color: theme.colors.textSecondary, fontWeight: "600" },
});
