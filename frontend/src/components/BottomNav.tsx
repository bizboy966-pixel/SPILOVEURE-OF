import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, usePathname } from "expo-router";
import { theme } from "../theme";

/**
 * Bottom navigation — 5 tabs, single source of truth for the whole (app) space.
 *
 *   💸 Transfert | 🌐 Réseau | 🏠 Accueil | 🤖 SPVIA | 🛠️ Services
 *
 * "Accueil" is the elevated central button and points at the existing
 * dashboard (the entire current platform lives underneath it — MLM,
 * marketplace, missions, adverts, services, jackpot, coupons, tasks,
 * settings, "Plus" sheet, etc. — nothing was removed).
 *
 * The other four tabs currently open lightweight placeholder pages under
 * `/(app)/transfert`, `/(app)/reseau`, `/(app)/spvia`,
 * `/(app)/services-hub` — see those files for the "Bientôt disponible"
 * screens. They will be progressively wired to the real features later.
 */

type Tab = { key: string; icon: any; label: string; route: string; big?: boolean };

const TABS: Tab[] = [
  { key: "transfert", icon: "swap-horizontal", label: "Transfert",  route: "/(app)/transfert" },
  { key: "reseau",    icon: "people",          label: "Réseau",     route: "/(app)/reseau" },
  { key: "home",      icon: "home",            label: "Accueil",    route: "/(app)/dashboard", big: true },
  { key: "spvia",     icon: "sparkles",        label: "SPVIA",      route: "/(app)/spvia" },
  { key: "services",  icon: "apps",            label: "Services",   route: "/(app)/services-hub" },
];

export const BottomNav: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname() || "";

  const isActive = (t: Tab) => {
    // Accueil is active on the raw dashboard AND any deeper route that isn't
    // one of the four sibling tabs — so opening Marketplace, Missions, etc.
    // still highlights the Accueil pill.
    if (t.key === "home") {
      const others = ["/transfert", "/reseau", "/spvia", "/services-hub"];
      return !others.some((p) => pathname.includes(p));
    }
    return pathname.includes(`/${t.key}`) || pathname.endsWith(t.route);
  };

  return (
    <View style={styles.wrapper} testID="bottom-nav">
      {TABS.map((t) => {
        const active = isActive(t);
        if (t.big) {
          return (
            <View key={t.key} style={styles.centerWrap}>
              <TouchableOpacity
                style={[styles.centerBtn, active && styles.centerBtnActive]}
                onPress={() => router.push(t.route as any)}
                testID={`bottom-nav-${t.key}`}
              >
                <Ionicons name={t.icon} size={24} color="#fff" />
              </TouchableOpacity>
              <Text style={[styles.label, styles.centerLabel, active && styles.labelActive]}>
                {t.label}
              </Text>
            </View>
          );
        }
        return (
          <TouchableOpacity
            key={t.key}
            style={styles.item}
            onPress={() => router.push(t.route as any)}
            testID={`bottom-nav-${t.key}`}
          >
            <Ionicons
              name={t.icon}
              size={22}
              color={active ? theme.colors.primary : theme.colors.textSecondary}
            />
            <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
              {t.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
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
    color: theme.colors.textSecondary,
    fontWeight: "700",
  },
  labelActive: { color: theme.colors.primary },
  centerWrap: {
    flex: 1,
    alignItems: "center",
    marginTop: -22,
  },
  centerBtn: {
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: theme.colors.primary,
    alignItems: "center", justifyContent: "center",
    borderWidth: 4, borderColor: theme.colors.surface,
    shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
    elevation: 12,
  },
  centerBtnActive: { backgroundColor: theme.colors.primaryDark },
  centerLabel: { fontWeight: "900", color: theme.colors.primary, marginTop: 2 },
});
