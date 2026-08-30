import React from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "@/src/theme";

/**
 * Transfert — new wallet dashboard preview.
 *
 * Interface prepared per the product brief : balance card + action grid.
 * All actions currently open a "Bientôt disponible" alert — the real
 * money-movement flows will be wired later. Nothing else on the platform
 * is affected by this file.
 */

type ActionKey = "envoyer" | "deposer" | "convertir" | "retirer"
               | "mobile-money" | "banque" | "lien-paiement" | "scanner";

const ACTIONS: { key: ActionKey; icon: any; label: string; color: string }[] = [
  { key: "envoyer",       icon: "arrow-up-outline",       label: "Envoyer",         color: "#3B82F6" },
  { key: "deposer",       icon: "arrow-down-outline",     label: "Déposer",         color: "#22C55E" },
  { key: "convertir",     icon: "sync-outline",           label: "Convertir",       color: "#8B5CF6" },
  { key: "retirer",       icon: "arrow-up-outline",       label: "Retirer",         color: "#F97316" },
  { key: "mobile-money",  icon: "phone-portrait-outline", label: "Mobile Money",    color: "#10B981" },
  { key: "banque",        icon: "business-outline",       label: "Vers Banque",     color: "#2563EB" },
  { key: "lien-paiement", icon: "link-outline",           label: "Lien de paiement", color: "#EC4899" },
  { key: "scanner",       icon: "qr-code-outline",        label: "Scanner",         color: "#F59E0B" },
];

export default function Transfert() {
  const router = useRouter();
  const soon = () => {
    if (typeof window !== "undefined") window.alert("🚧 Bientôt disponible");
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="transfert-back">
          <Ionicons name="menu" size={22} color={theme.colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Wallet</Text>
        <TouchableOpacity onPress={soon} style={styles.iconBtn} testID="transfert-notif">
          <Ionicons name="notifications-outline" size={22} color={theme.colors.textPrimary} />
          <View style={styles.notifDot} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 120 }}>
        {/* Balance card */}
        <View style={styles.balanceCard} testID="transfert-balance-card">
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={styles.balanceLabel}>Solde disponible</Text>
            <TouchableOpacity onPress={soon}>
              <Ionicons name="eye-outline" size={22} color="#fff" />
            </TouchableOpacity>
          </View>
          <Text style={styles.balanceAmount}>0 FCFA</Text>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Ionicons name="wallet-outline" size={16} color="rgba(255,255,255,0.9)" />
              <Text style={styles.balanceSub}>Compte principal</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.9)" />
          </View>
        </View>

        {/* Action grid */}
        <View style={styles.grid}>
          {ACTIONS.map((a) => (
            <TouchableOpacity
              key={a.key}
              style={styles.actionCard}
              onPress={soon}
              testID={`transfert-action-${a.key}`}
              activeOpacity={0.85}
            >
              <View style={[styles.actionIconWrap, { backgroundColor: a.color }]}>
                <Ionicons name={a.icon} size={22} color="#fff" />
              </View>
              <Text style={styles.actionLabel} numberOfLines={2}>{a.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Trust banner */}
        <View style={styles.trustCard}>
          <View style={styles.trustIcon}>
            <Ionicons name="shield-checkmark" size={22} color={theme.colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.trustTitle}>Transactions 100% sécurisées</Text>
            <Text style={styles.trustSub}>Vos fonds sont protégés</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
        </View>

        {/* Activity placeholder */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 18, marginBottom: 8 }}>
          <Text style={styles.sectionTitle}>Activités récentes</Text>
          <TouchableOpacity onPress={soon}><Text style={styles.linkTxt}>Voir tout</Text></TouchableOpacity>
        </View>
        <View style={styles.emptyBox} testID="transfert-empty-activity">
          <Ionicons name="time-outline" size={28} color={theme.colors.textSecondary} />
          <Text style={styles.emptyTitle}>Aucune activité pour l'instant</Text>
          <Text style={styles.emptySub}>Les fonctionnalités de transfert seront bientôt activées.</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10,
    backgroundColor: theme.colors.background,
  },
  headerTitle: { fontSize: 22, fontWeight: "900", color: theme.colors.textPrimary, letterSpacing: -0.5 },
  iconBtn: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: "center", justifyContent: "center",
    backgroundColor: theme.colors.surfaceMuted,
    position: "relative",
  },
  notifDot: {
    position: "absolute", top: 10, right: 10,
    width: 8, height: 8, borderRadius: 4, backgroundColor: "#EF4444",
  },
  balanceCard: {
    backgroundColor: theme.colors.primary,
    padding: 18, borderRadius: 20,
    gap: 8,
    shadowColor: theme.colors.primary, shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 6 },
  },
  balanceLabel: { color: "rgba(255,255,255,0.9)", fontWeight: "700", fontSize: 13 },
  balanceAmount: { color: "#fff", fontSize: 36, fontWeight: "900", letterSpacing: -1 },
  balanceSub: { color: "rgba(255,255,255,0.9)", fontWeight: "700", fontSize: 12 },
  grid: {
    flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 16,
  },
  actionCard: {
    width: "23%", minWidth: 78,
    padding: 10, borderRadius: 14,
    backgroundColor: theme.colors.surface,
    borderWidth: 1, borderColor: theme.colors.border,
    alignItems: "center", gap: 6,
  },
  actionIconWrap: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: "center", justifyContent: "center",
  },
  actionLabel: {
    fontSize: 10.5, fontWeight: "800",
    color: theme.colors.textPrimary, textAlign: "center",
  },
  trustCard: {
    marginTop: 16, padding: 12, borderRadius: 14,
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: theme.colors.surface,
    borderWidth: 1, borderColor: theme.colors.border,
  },
  trustIcon: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: theme.colors.primary + "18",
    alignItems: "center", justifyContent: "center",
  },
  trustTitle: { color: theme.colors.primary, fontWeight: "900", fontSize: 13 },
  trustSub: { color: theme.colors.textSecondary, fontSize: 11 },
  sectionTitle: { fontSize: 14, fontWeight: "900", color: theme.colors.textPrimary },
  linkTxt: { color: theme.colors.primary, fontWeight: "800", fontSize: 12 },
  emptyBox: {
    padding: 24, borderRadius: 14,
    backgroundColor: theme.colors.surface,
    borderWidth: 1, borderColor: theme.colors.border,
    borderStyle: "dashed",
    alignItems: "center", gap: 6,
  },
  emptyTitle: { color: theme.colors.textPrimary, fontWeight: "900", fontSize: 13 },
  emptySub: { color: theme.colors.textSecondary, fontSize: 11, textAlign: "center" },
});
