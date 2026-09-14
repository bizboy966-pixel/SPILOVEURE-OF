import React, { useEffect, useState } from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View, Platform, Linking } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, usePathname } from "expo-router";
import { theme } from "../theme";
import { api } from "../api";
import { useActivationGuard } from "./ActivationGuard";

/**
 * Floating bottom navigation (v14 — mockup-driven refresh).
 * 5 items with the centre "Tâches" pill elevated above the bar:
 *   [ Accueil ] [ IA SPV ] ( Tâches ) [ Trading ] [ Profil ]
 *
 * The wrapper floats with rounded pill shape + shadow to match the
 * user's mockup. All secondary destinations (Marketplace, Emploi,
 * Ads, Services, Coupons, Support, etc.) are reachable from the
 * "Nos services" section on the dashboard, from the ⋮ menu, or from
 * their dedicated screens — keeping the bottom nav clean.
 */
type Item = {
  key: string;
  icon: any;
  label: string;
  route: string;
  matchers?: string[];   // pathname substrings that light up this tab
};

const LEFT: Item[] = [
  { key: "home", icon: "home", label: "Accueil", route: "/(app)/dashboard", matchers: ["/dashboard", "/(app)"] },
  { key: "spvia", icon: "sparkles", label: "IA SPV", route: "/(app)/spvia", matchers: ["/spvia"] },
];

const RIGHT: Item[] = [
  { key: "trading", icon: "trending-up", label: "Trading", route: "/(app)/trading", matchers: ["/trading"] },
  { key: "profile", icon: "person", label: "Profil", route: "/(app)/profile", matchers: ["/profile"] },
];

const PLUS_MENU: { key: string; icon: any; label: string; route?: string }[] = [
  { key: "marketplace", icon: "cart", label: "Marketplace", route: "/(app)/marketplace" },
  { key: "emploi", icon: "briefcase", label: "Emploi", route: "/(app)/emploi" },
  { key: "ads", icon: "megaphone", label: "Publicité", route: "/(app)/ads" },
  { key: "services", icon: "laptop", label: "Services", route: "/(app)/services" },
  { key: "formations", icon: "school", label: "Formations", route: "/(app)/formations" },
  { key: "ebooks", icon: "book", label: "E-books", route: "/(app)/ebooks" },
  { key: "lottery", icon: "gift", label: "Jackpot", route: "/(app)/lottery" },
  { key: "matrices", icon: "grid", label: "Matrices", route: "/(app)/matrices" },
  { key: "team", icon: "people", label: "Équipe", route: "/(app)/equipe" },
  { key: "support", icon: "headset", label: "Support" },
];

function isActive(pathname: string, matchers: string[] | undefined): boolean {
  if (!matchers || !matchers.length) return false;
  return matchers.some((m) => pathname.includes(m));
}

export const BottomNav: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname() || "";
  const [plusOpen, setPlusOpen] = useState(false);
  const [unreadTasks, setUnreadTasks] = useState<number>(0);
  const { guardedNavigate, showModal } = useActivationGuard();

  useEffect(() => {
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const t = await api.get<{ unread: number }>("/special-tasks/unread-count").catch(() => ({ unread: 0 }));
        if (!cancelled) setUnreadTasks(t.unread || 0);
      } catch {
        if (!cancelled) setUnreadTasks(0);
      }
    };
    fetchCount();
    const iv = setInterval(fetchCount, 60_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [pathname]);

  const openSupport = async () => {
    try {
      const sup = await api.get<any>("/settings/support", { auth: false } as any);
      const url = sup?.whatsapp_url || sup?.telegram_url;
      if (url) {
        if (Platform.OS === "web" && typeof window !== "undefined") window.open(url, "_blank");
        else Linking.openURL(url).catch(() => {});
        return;
      }
    } catch {}
    if (typeof window !== "undefined") window.alert("Service client indisponible pour le moment.");
  };

  const goto = (route: string) => guardedNavigate(route);
  const tasksActive = pathname.includes("/tasks");

  const renderItem = (it: Item, side: "L" | "R") => {
    const active = isActive(pathname, it.matchers);
    return (
      <TouchableOpacity
        key={`${side}-${it.key}`}
        style={styles.item}
        onPress={() => goto(it.route)}
        testID={`bottom-nav-${it.key}`}
      >
        <Ionicons
          name={it.icon}
          size={22}
          color={active ? theme.colors.primary : "#8FA6C4"}
        />
        <Text style={[styles.label, active && styles.labelActive]}>
          {it.label}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <>
      <View style={styles.floater} pointerEvents="box-none">
        <View style={styles.bar} testID="bottom-nav">
          {LEFT.map((it) => renderItem(it, "L"))}

          {/* Centre — elevated Tâches pill */}
          <View style={styles.centreSlot}>
            <TouchableOpacity
              style={[styles.centreBtn, tasksActive && styles.centreBtnActive]}
              onPress={() => router.push("/(app)/tasks" as any)}
              onLongPress={() => showModal()}
              testID="bottom-nav-tasks"
              activeOpacity={0.88}
            >
              <Ionicons name="clipboard" size={26} color="#fff" />
              {unreadTasks > 0 ? (
                <View style={styles.centreDot} testID="bottom-nav-tasks-badge">
                  <Text style={styles.centreDotTxt}>{unreadTasks > 9 ? "9+" : unreadTasks}</Text>
                </View>
              ) : null}
            </TouchableOpacity>
            <Text style={styles.centreLabel}>Tâches</Text>
          </View>

          {RIGHT.map((it) => renderItem(it, "R"))}
        </View>
      </View>

      {/* Long-press on the central pill opens the extra services sheet */}
      <Modal
        visible={plusOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setPlusOpen(false)}
      >
        <TouchableOpacity
          style={styles.sheetBackdrop}
          activeOpacity={1}
          onPress={() => setPlusOpen(false)}
        />
        <View style={styles.sheet} testID="bottom-nav-plus-menu">
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>Nos services</Text>
          <View style={styles.grid}>
            {PLUS_MENU.map((it) => (
              <TouchableOpacity
                key={it.key}
                style={styles.gridItem}
                onPress={() => {
                  setPlusOpen(false);
                  if (it.key === "support") { openSupport(); return; }
                  if (it.route) router.push(it.route as any);
                }}
                testID={`bottom-nav-plus-${it.key}`}
              >
                <View style={styles.gridIcon}>
                  <Ionicons name={it.icon} size={22} color={theme.colors.primary} />
                </View>
                <Text style={styles.gridLabel}>{it.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity
            style={styles.sheetClose}
            onPress={() => setPlusOpen(false)}
            testID="bottom-nav-plus-close"
          >
            <Text style={styles.sheetCloseText}>Fermer</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  floater: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    padding: 12,
    zIndex: 100,
  },
  bar: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-around",
    backgroundColor: theme.colors.surface,
    borderRadius: 26,
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    shadowColor: "#0B2D6F",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.16,
    shadowRadius: 20,
    elevation: 12,
  },
  item: {
    flex: 1,
    alignItems: "center",
    gap: 2,
    paddingVertical: 4,
  },
  label: {
    fontSize: 10,
    color: "#8FA6C4",
    fontWeight: "700",
  },
  labelActive: {
    color: theme.colors.primary,
    fontWeight: "900",
  },
  centreSlot: {
    alignItems: "center",
    marginTop: -34,
    marginHorizontal: 4,
    width: 64,
  },
  centreBtn: {
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: theme.colors.primary,
    alignItems: "center", justifyContent: "center",
    borderWidth: 5, borderColor: theme.colors.surface,
    shadowColor: "#1B5BFF",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
    elevation: 14,
  },
  centreBtnActive: { backgroundColor: theme.colors.primaryDark },
  centreLabel: {
    fontSize: 10, fontWeight: "900",
    color: theme.colors.primary, marginTop: 4,
  },
  centreDot: {
    position: "absolute", top: -4, right: -4,
    minWidth: 20, height: 20, borderRadius: 12,
    backgroundColor: "#EF4444",
    alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: theme.colors.surface,
    paddingHorizontal: 4,
  },
  centreDotTxt: { color: "#fff", fontWeight: "900", fontSize: 10 },

  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  sheet: {
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 16,
    paddingBottom: 24,
  },
  sheetHandle: {
    width: 40, height: 4, backgroundColor: theme.colors.border,
    borderRadius: 2, alignSelf: "center", marginBottom: 12,
  },
  sheetTitle: {
    fontSize: 16, fontWeight: "900",
    color: theme.colors.textPrimary,
    marginBottom: 16,
    textAlign: "center",
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    justifyContent: "flex-start",
  },
  gridItem: {
    width: "31%",
    padding: 12,
    borderRadius: 14,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  gridIcon: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: theme.colors.primaryBg,
    alignItems: "center", justifyContent: "center",
    marginBottom: 6,
  },
  gridLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: theme.colors.textPrimary,
    textAlign: "center",
  },
  sheetClose: {
    marginTop: 16,
    backgroundColor: theme.colors.primary,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: "center",
  },
  sheetCloseText: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 13,
  },
});
