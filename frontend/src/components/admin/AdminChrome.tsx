import React from "react";
import { Modal, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { theme } from "@/src/theme";

export type AdminTabItem = { key: string; label: string; icon: any };

/** Compact admin header: back + title block (shrinks/truncates) + action cluster. */
export function AdminHeader({
  username, activeLabel, refreshing, onBack, onRefresh, onOpenMenu, onLogout,
}: {
  username?: string; activeLabel: string; refreshing: boolean;
  onBack: () => void; onRefresh: () => void; onOpenMenu: () => void; onLogout: () => void;
}) {
  const { width } = useWindowDimensions();
  const narrow = width < 380;
  return (
    <LinearGradient colors={theme.colors.primaryGradient} style={s.header} testID="admin-header">
      <View style={[s.row, width >= 900 && s.rowWide]}>
        <TouchableOpacity onPress={onBack} style={s.iconBtn} testID="admin-back-btn" accessibilityRole="button" accessibilityLabel="Retour">
          <Ionicons name="chevron-back" size={20} color="#fff" />
        </TouchableOpacity>
        <View style={s.titleBlock}>
          <View style={s.titleLine}>
            {!narrow && <Ionicons name="shield-checkmark" size={16} color="#C7D9FF" />}
            <Text style={s.title} numberOfLines={1}>{narrow ? "Admin" : "Panel Admin Spiloveure"}</Text>
          </View>
          <Text style={s.sub} numberOfLines={1}>
            {activeLabel}{username ? ` · ${username}` : ""}
          </Text>
        </View>
        <View style={s.actions}>
          <TouchableOpacity onPress={onRefresh} disabled={refreshing} style={s.iconBtn} testID="admin-refresh" accessibilityRole="button" accessibilityLabel="Actualiser">
            <Ionicons name={refreshing ? "hourglass-outline" : "refresh"} size={18} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity onPress={onOpenMenu} style={s.iconBtn} testID="admin-tabs-menu" accessibilityRole="button" accessibilityLabel="Ouvrir le menu d'administration">
            <Ionicons name="ellipsis-vertical" size={18} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity onPress={onLogout} style={s.iconBtn} testID="admin-logout" accessibilityRole="button" accessibilityLabel="Se déconnecter">
            <Ionicons name="log-out-outline" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>
    </LinearGradient>
  );
}

/** Full-screen admin navigation menu (Android back closes via onRequestClose). */
export function AdminMenuModal({
  visible, tabs, active, onSelect, onClose,
}: {
  visible: boolean; tabs: AdminTabItem[]; active: string;
  onSelect: (key: string) => void; onClose: () => void;
}) {
  return (
    <Modal visible={visible} animationType={Platform.OS === "web" ? "fade" : "slide"} onRequestClose={onClose} presentationStyle="fullScreen" statusBarTranslucent={false}>
      <SafeAreaView style={s.modal} testID="admin-menu-modal">
        <View style={s.modalHead}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.modalKicker}>Administration</Text>
            <Text style={s.modalTitle} numberOfLines={1}>Sections</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={s.closeBtn} testID="admin-menu-close" accessibilityRole="button" accessibilityLabel="Fermer le menu">
            <Ionicons name="close" size={22} color={theme.colors.textPrimary} />
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={s.list} testID="admin-menu-list">
          {tabs.map((t) => {
            const on = t.key === active;
            return (
              <TouchableOpacity
                key={t.key}
                onPress={() => onSelect(t.key)}
                style={[s.item, on && s.itemOn]}
                testID={`admin-menu-tab-${t.key}`}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={t.label}
              >
                <View style={[s.itemIcon, on && s.itemIconOn]}>
                  <Ionicons name={t.icon} size={17} color={on ? "#fff" : theme.colors.primary} />
                </View>
                <Text style={[s.itemTxt, on && s.itemTxtOn]} numberOfLines={1}>{t.label}</Text>
                <Ionicons name={on ? "checkmark" : "chevron-forward"} size={16} color={on ? theme.colors.primary : theme.colors.textMuted} />
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const s = StyleSheet.create({
  header: { paddingHorizontal: 12, paddingVertical: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, width: "100%", maxWidth: 1200, alignSelf: "center" },
  rowWide: { paddingHorizontal: 8 },
  iconBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.14)", borderWidth: 1, borderColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  titleBlock: { flex: 1, minWidth: 0, flexShrink: 1 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  title: { color: "#fff", fontSize: 15, fontWeight: "600", letterSpacing: -0.2, flexShrink: 1 },
  sub: { color: "#C7D9FF", fontSize: 11.5, fontWeight: "500", marginTop: 1 },
  actions: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 },
  modal: { flex: 1, backgroundColor: theme.colors.background },
  modalHead: { flexDirection: "row", alignItems: "center", paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: theme.colors.borderStrong, backgroundColor: theme.colors.surface },
  modalKicker: { fontSize: 11, fontWeight: "600", color: theme.colors.textSecondary, letterSpacing: 0.6, textTransform: "uppercase" },
  modalTitle: { fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary, letterSpacing: -0.3, marginTop: 2 },
  closeBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surfaceSecondary },
  list: { padding: 14, paddingBottom: 40, gap: 6, width: "100%", maxWidth: 640, alignSelf: "center" },
  item: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 12, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.border },
  itemOn: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryBg },
  itemIcon: { width: 32, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.primaryBg },
  itemIconOn: { backgroundColor: theme.colors.primary },
  itemTxt: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: "500", color: theme.colors.textPrimary },
  itemTxtOn: { fontWeight: "600", color: theme.colors.primaryDark },
});
