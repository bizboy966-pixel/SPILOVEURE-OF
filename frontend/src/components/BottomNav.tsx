import React, { useEffect, useState } from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View, Platform, Linking } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, usePathname } from "expo-router";
import { theme } from "../theme";
import { api } from "../api";
import { useFeatures, FeatureKey } from "../features";

/**
 * Bottom navigation bar rendered on the dashboard for activated users.
 * Layout: 3 items on the left | central bigger "Tâches" | 3 items on the right.
 * Items with no live target show a "Bientôt disponible" alert.
 * The "☰ Plus" button opens a modern bottom-sheet with the full menu.
 * Items linked to a disabled feature flag are hidden.
 */
type Item = {
  key: string;
  icon: any;
  label: string;
  route?: string;
  feature?: FeatureKey;
};

const LEFT: Item[] = [
  { key: "marketplace", icon: "cart", label: "Marketplace", route: "/(app)/marketplace", feature: "marketplace" },
  { key: "emploi", icon: "briefcase", label: "Emploi", route: "/(app)/emploi" },
  { key: "coupons", icon: "ticket", label: "Coupons" },
];

const RIGHT: Item[] = [
  { key: "ads", icon: "megaphone", label: "Publicité", route: "/(app)/ads", feature: "ads" },
  { key: "services", icon: "laptop", label: "Services", route: "/(app)/services" },
  { key: "more", icon: "menu", label: "Plus" },
];

const PLUS_MENU: Item[] = [
  { key: "jackpot", icon: "gift", label: "Jackpot 🎁", route: "/(app)/lottery" },
  { key: "support", icon: "headset", label: "Service client" },
  { key: "adv", icon: "megaphone", label: "Espace publicitaire", route: "/(app)/advertising", feature: "ads" },
  { key: "publish", icon: "create", label: "📝 Publier un article", route: "/(app)/marketplace-create", feature: "marketplace_publish" },
  { key: "marketplace", icon: "cart", label: "🛒 Marketplace", route: "/(app)/marketplace", feature: "marketplace" },
  { key: "emploi", icon: "briefcase", label: "💼 Emploi", route: "/(app)/emploi" },
  { key: "coupons", icon: "ticket", label: "Coupons & Promotions" },
];

export const BottomNav: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const [plusOpen, setPlusOpen] = useState(false);
  const { features } = useFeatures();
  const [unreadTasks, setUnreadTasks] = useState<number>(0);
  const [unreadAds, setUnreadAds] = useState<number>(0);
  const [unreadMarketplace, setUnreadMarketplace] = useState<number>(0);
  const [unreadJobs, setUnreadJobs] = useState<number>(0);

  // Poll the special-tasks unread count every 60 s + refresh on route change
  // so the badge disappears immediately when the user opens /tasks (which
  // itself calls `/special-tasks/mark-seen`).
  useEffect(() => {
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const [tasks, ads, market, jobs] = await Promise.all([
          api.get<{ unread: number }>("/special-tasks/unread-count").catch(() => ({ unread: 0 })),
          api.get<{ unread: number }>("/ads/unread-count").catch(() => ({ unread: 0 })),
          api.get<{ unread: number }>("/marketplace/unread-count").catch(() => ({ unread: 0 })),
          api.get<{ unread: number }>("/jobs/unread-count").catch(() => ({ unread: 0 })),
        ]);
        if (!cancelled) {
          setUnreadTasks(tasks.unread || 0);
          setUnreadAds(ads.unread || 0);
          setUnreadMarketplace(market.unread || 0);
          setUnreadJobs(jobs.unread || 0);
        }
      } catch {
        if (!cancelled) {
          setUnreadTasks(0); setUnreadAds(0);
          setUnreadMarketplace(0); setUnreadJobs(0);
        }
      }
    };
    fetchCount();
    const t = setInterval(fetchCount, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [pathname]);

  // Filter items whose feature flag is disabled — keeps items without a
  // `feature` field always visible.
  const visible = (items: Item[]) =>
    items.filter((it) => !it.feature || features[it.feature]);
  const leftItems = visible(LEFT);
  const rightItems = visible(RIGHT);
  const plusItems = visible(PLUS_MENU);

  const soon = () => {
    if (typeof window !== "undefined") window.alert("🚧 Bientôt disponible");
  };

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
    if (typeof window !== "undefined") {
      window.alert("Service client indisponible pour le moment. Réessayez plus tard.");
    }
  };

  const openItem = (it: Item) => {
    if (it.key === "more") {
      setPlusOpen(true);
      return;
    }
    if (it.route) router.push(it.route as any);
    else soon();
  };

  return (
    <>
      <View style={styles.wrapper} testID="bottom-nav">
        {leftItems.map((it) => (
          <TouchableOpacity
            key={`L-${it.key}`}
            style={styles.item}
            onPress={() => openItem(it)}
            testID={`bottom-nav-${it.key}`}
          >
            <View style={{ position: "relative" }}>
              <Ionicons name={it.icon} size={20} color={theme.colors.textPrimary} />
              {it.key === "marketplace" && unreadMarketplace > 0 ? (
                <View style={styles.badge} testID="bottom-nav-marketplace-badge">
                  <Text style={styles.badgeTxt}>{unreadMarketplace > 9 ? "9+" : unreadMarketplace}</Text>
                </View>
              ) : null}
              {it.key === "emploi" && unreadJobs > 0 ? (
                <View style={styles.badge} testID="bottom-nav-emploi-badge">
                  <Text style={styles.badgeTxt}>{unreadJobs > 9 ? "9+" : unreadJobs}</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.label}>{it.label}</Text>
          </TouchableOpacity>
        ))}

        {/* Central big button — Tâches */}
        <View style={styles.centerWrap}>
          <TouchableOpacity
            style={styles.centerBtn}
            onPress={() => router.push("/(app)/tasks" as any)}
            testID="bottom-nav-tasks"
          >
            <Ionicons name="clipboard" size={26} color="#fff" />
            {unreadTasks > 0 ? (
              <View style={styles.centerDot} testID="bottom-nav-tasks-badge">
                <Text style={styles.centerDotTxt}>{unreadTasks > 9 ? "9+" : unreadTasks}</Text>
              </View>
            ) : null}
          </TouchableOpacity>
          <Text style={styles.centerLabel}>Tâches</Text>
        </View>

        {rightItems.map((it) => (
          <TouchableOpacity
            key={`R-${it.key}`}
            style={styles.item}
            onPress={() => openItem(it)}
            testID={`bottom-nav-${it.key}`}
          >
            <View style={{ position: "relative" }}>
              <Ionicons name={it.icon} size={20} color={theme.colors.textPrimary} />
              {it.key === "ads" && unreadAds > 0 ? (
                <View style={styles.badge} testID="bottom-nav-ads-badge">
                  <Text style={styles.badgeTxt}>{unreadAds > 9 ? "9+" : unreadAds}</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.label}>{it.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ☰ Plus — bottom sheet modal */}
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
          <Text style={styles.sheetTitle}>☰ Plus</Text>
          <View style={styles.grid}>
            {plusItems.map((it) => (
              <TouchableOpacity
                key={it.key}
                style={styles.gridItem}
                onPress={() => {
                  setPlusOpen(false);
                  if (it.key === "support") { openSupport(); return; }
                  if (it.route) router.push(it.route as any);
                  else soon();
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
  wrapper: {
    position: "absolute",
    left: 0, right: 0, bottom: 0,
    flexDirection: "row",
    justifyContent: "space-around",
    alignItems: "flex-end",
    paddingBottom: 6,
    paddingTop: 6,
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: -2 },
    elevation: 10,
    zIndex: 100,
  },
  item: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 6,
    gap: 2,
  },
  label: {
    fontSize: 10,
    color: theme.colors.textPrimary,
    fontWeight: "700",
  },
  centerWrap: {
    alignItems: "center",
    marginTop: -22,
    marginHorizontal: 4,
  },
  centerBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 4,
    borderColor: theme.colors.surface,
    shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
    elevation: 12,
  },
  centerLabel: {
    fontSize: 10,
    fontWeight: "900",
    color: theme.colors.primary,
    marginTop: 2,
  },
  centerDot: {
    position: "absolute", top: -4, right: -4,
    minWidth: 20, height: 20, borderRadius: 10,
    backgroundColor: "#EF4444",
    alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: theme.colors.surface,
    paddingHorizontal: 4,
  },
  centerDotTxt: { color: "#fff", fontWeight: "900", fontSize: 10 },
  badge: {
    position: "absolute", top: -6, right: -8,
    minWidth: 16, height: 16, borderRadius: 8,
    backgroundColor: "#EF4444",
    alignItems: "center", justifyContent: "center",
    borderWidth: 1.5, borderColor: theme.colors.surface,
    paddingHorizontal: 3,
  },
  badgeTxt: { color: "#fff", fontWeight: "900", fontSize: 9 },

  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  sheet: {
    backgroundColor: theme.colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
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
    justifyContent: "space-between",
  },
  gridItem: {
    width: "31%",
    padding: 12,
    borderRadius: 12,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  gridIcon: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: theme.colors.background,
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
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  sheetCloseText: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 13,
  },
});
