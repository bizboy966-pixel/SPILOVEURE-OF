import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "@/src/theme";
import { useAuth } from "@/src/auth";

export function SideMenu({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { user, signOut } = useAuth();
  const router = useRouter();

  const go = (path: any) => {
    onClose();
    setTimeout(() => router.push(path), 50);
  };

  const refreshPage = () => {
    onClose();
    if (typeof window !== "undefined" && window.location) {
      window.location.reload();
    } else {
      // On native: re-push current route to force a refresh
      setTimeout(() => router.replace("/(app)/services"), 50);
    }
  };

  const items: { icon: keyof typeof Ionicons.glyphMap; label: string; path: string; testID: string; color: string }[] = [
    { icon: "home", label: "Tableau de bord", path: "/(app)/dashboard", testID: "menu-dashboard", color: "#3B82F6" },
    { icon: "git-network", label: "Les matrices", path: "/(app)/matrices", testID: "menu-matrices", color: theme.colors.secondary },
    { icon: "git-branch", label: "🌳 Mon Équipe (arbre)", path: "/(app)/team-direct", testID: "menu-team-direct", color: theme.colors.success },
    { icon: "people", label: "👥 Équipe", path: "/(app)/equipe", testID: "menu-team", color: "#22C55E" },
    { icon: "list", label: "Détails d'équipe", path: "/(app)/team-details", testID: "menu-team-details", color: theme.colors.warning },
    { icon: "person", label: "Mon profil", path: "/(app)/profile", testID: "menu-profile", color: "#0EA5E9" },
    { icon: "wallet", label: "Portefeuille retrait", path: "/(app)/wallet", testID: "menu-wallet", color: "#A855F7" },
    { icon: "cash", label: "Demande de retrait", path: "/(app)/withdrawal", testID: "menu-withdrawal", color: theme.colors.success },
    { icon: "receipt", label: "Historique des transactions", path: "/(app)/transactions", testID: "menu-transactions", color: "#EC4899" },
    { icon: "megaphone", label: "Communauté", path: "/(app)/community", testID: "menu-community", color: "#F97316" },
    { icon: "settings", label: "Paramètres", path: "/(app)/settings", testID: "menu-settings", color: theme.colors.textSecondary },
  ];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.panel} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>Options</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} testID="menu-close">
              <Ionicons name="close" size={24} color={theme.colors.textPrimary} />
            </TouchableOpacity>
          </View>
          <View style={styles.userCard}>
            <View style={styles.avatar}>
              <Ionicons name="person" size={28} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.username}>{user?.username}</Text>
              <View style={styles.levelPill}>
                <Text style={styles.levelPillText}>Niveau {user?.max_level ?? 0}</Text>
              </View>
            </View>
          </View>
          <ScrollView style={{ flex: 1 }}>
            {items.map((it) => (
              <TouchableOpacity
                key={it.path}
                style={styles.item}
                onPress={() => go(it.path)}
                testID={it.testID}
              >
                <View style={[styles.itemIcon, { backgroundColor: `${it.color}22` }]}>
                  <Ionicons name={it.icon} size={20} color={it.color} />
                </View>
                <Text style={styles.itemLabel}>{it.label}</Text>
                <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            ))}
            {user?.role === "admin" && (
              <TouchableOpacity
                style={styles.item}
                onPress={() => go("/(admin)")}
                testID="menu-admin"
              >
                <View style={[styles.itemIcon, { backgroundColor: "#1B5BFF22" }]}>
                  <Ionicons name="shield-checkmark" size={20} color={theme.colors.primary} />
                </View>
                <Text style={styles.itemLabel}>Panel Admin</Text>
                <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.item, { marginTop: 4 }]}
              onPress={refreshPage}
              testID="menu-refresh"
            >
              <View style={[styles.itemIcon, { backgroundColor: "#0EA5E922" }]}>
                <Ionicons name="refresh" size={20} color="#0EA5E9" />
              </View>
              <Text style={styles.itemLabel}>Actualiser la page</Text>
              <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.item, { marginTop: 8 }]}
              onPress={async () => {
                await signOut();
                onClose();
                router.replace("/(auth)/login");
              }}
              testID="menu-signout"
            >
              <View style={[styles.itemIcon, { backgroundColor: theme.colors.dangerBg }]}>
                <Ionicons name="power" size={20} color={theme.colors.danger} />
              </View>
              <Text style={[styles.itemLabel, { color: theme.colors.danger, fontWeight: "700" }]}>Déconnexion</Text>
            </TouchableOpacity>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  panel: {
    position: "absolute",
    top: 0, right: 0, bottom: 0,
    width: "85%",
    maxWidth: 360,
    backgroundColor: "#fff",
    paddingTop: 56,
    paddingHorizontal: 16,
    borderTopLeftRadius: 24,
    borderBottomLeftRadius: 24,
  },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  title: { fontSize: theme.font.h2, fontWeight: theme.font.bold, color: theme.colors.textPrimary },
  userCard: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: theme.colors.surfaceSecondary,
    borderRadius: theme.radius.lg, padding: 12, marginBottom: 16,
  },
  avatar: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: theme.colors.primary, alignItems: "center", justifyContent: "center",
  },
  username: { fontSize: theme.font.bodyLg, fontWeight: theme.font.bold, color: theme.colors.textPrimary },
  levelPill: {
    alignSelf: "flex-start",
    backgroundColor: "#DBEAFE",
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 12, marginTop: 4,
  },
  levelPillText: { color: theme.colors.primary, fontWeight: theme.font.semibold, fontSize: 12 },
  item: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 12, paddingHorizontal: 10,
    borderRadius: theme.radius.md,
    marginBottom: 4,
    gap: 12,
  },
  itemIcon: { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  itemLabel: { flex: 1, fontSize: theme.font.bodyLg, fontWeight: theme.font.semibold, color: theme.colors.textPrimary },
});
