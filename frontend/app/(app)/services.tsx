import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  Image,
  Platform,
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { theme } from "@/src/theme";
import { SideMenu } from "@/src/components/SideMenu";

const ORANGE = "#FF7A00";
const ORANGE_DARK = "#E26A00";

// Stable color palette for initials avatar based on username hash
function avatarColor(name: string) {
  const palette = ["#FF7A00", "#1B5BFF", "#7B61FF", "#10B981", "#EF4444", "#F59E0B", "#0EA5E9"];
  let h = 0;
  for (let i = 0; i < (name || "").length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return palette[Math.abs(h) % palette.length];
}

function getInitials(name: string) {
  const clean = (name || "?").trim();
  // If multi-word (e.g. "John Doe") → first letter of first 2 words
  const parts = clean.split(/[\s_\-.]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  // Single word: take first 2 alphanumeric chars
  const m = clean.match(/[A-Za-zÀ-ÿ0-9]/g) || ["?"];
  return (m[0] + (m[1] || "")).toUpperCase();
}

type ServiceTile = {
  key: "formation" | "ebook" | "premium" | "trading";
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  route: string;
};

const TILES: ServiceTile[] = [
  { key: "formation", label: "FORMATION", icon: "school", route: "/(app)/formations" },
  { key: "ebook", label: "E-BOOK", icon: "book", route: "/(app)/ebooks" },
  { key: "premium", label: "APPLICATION\nPREMIUM", icon: "diamond", route: "/(app)/premium-apps" },
  { key: "trading", label: "TRADING", icon: "trending-up", route: "/(app)/trading" },
];

type Counts = {
  formations: number;
  ebooks: number;
  premium_apps: number;
  trading_enabled: boolean;
};

export default function Services() {
  const { user, refresh } = useAuth();
  const router = useRouter();
  const [counts, setCounts] = useState<Counts>({
    formations: 0,
    ebooks: 0,
    premium_apps: 0,
    trading_enabled: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [f, e, p, t] = await Promise.all([
        api.get<any[]>("/formations").catch(() => []),
        api.get<any[]>("/ebooks").catch(() => []),
        api.get<any[]>("/premium-apps").catch(() => []),
        api.get<any>("/settings/trading").catch(() => ({})),
      ]);
      setCounts({
        formations: Array.isArray(f) ? f.length : 0,
        ebooks: Array.isArray(e) ? e.length : 0,
        premium_apps: Array.isArray(p) ? p.length : 0,
        trading_enabled: !!(t?.enabled && t?.telegram_url),
      });
    } catch {}
  }, []);

  useEffect(() => {
    load();
    refresh();

    // Handle gateway redirect: /services?ref=SPV-… → verify + auto-activate
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const ref = url.searchParams.get("ref");
    if (!ref) return;

    let cancelled = false;
    let attempts = 0;
    const poll = async () => {
      while (!cancelled && attempts < 10) {
        attempts += 1;
        try {
          const r = await api.get<any>(`/payments/${encodeURIComponent(ref)}/status`);
          if (r?.status === "paid") {
            await refresh();
            if (typeof window !== "undefined") {
              if (r.activated_now) {
                window.alert(`✅ Paiement confirmé — niveau ${r.level} activé !`);
              } else if (r.activation_done) {
                window.alert(`✅ Paiement déjà traité — niveau ${r.level} actif`);
              }
              // Clean ?ref= from the URL
              window.history.replaceState({}, "", url.pathname);
            }
            return;
          }
        } catch {
          // 404 / 403 → stop silently
          return;
        }
        // Wait 3s before retry (max 10 attempts ≈ 30s)
        await new Promise((res) => setTimeout(res, 3000));
      }
    };
    poll();
    return () => { cancelled = true; };
  }, [load, refresh]);

  const initials = useMemo(() => getInitials(user?.username || "?"), [user?.username]);
  const tone = useMemo(() => avatarColor(user?.username || ""), [user?.username]);
  const isActive = user?.status === "active" && (user?.max_level || 0) >= 1;

  const goTrading = async () => {
    try {
      const t = await api.get<any>("/settings/trading");
      const url = t?.telegram_url || "";
      if (!t?.enabled || !url) {
        router.push("/(app)/trading");
        return;
      }
      if (Platform.OS === "web" && typeof window !== "undefined") {
        window.open(url, "_blank");
      } else {
        await Linking.openURL(url);
      }
    } catch {
      router.push("/(app)/trading");
    }
  };

  const onTilePress = (t: ServiceTile) => {
    if (t.key === "trading") return goTrading();
    router.push(t.route as any);
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: 60 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      >
        {/* PROFILE CARD */}
        <LinearGradient colors={theme.colors.primaryGradient} style={styles.profileCard}>
          <View style={styles.profileHeader}>
            <View style={styles.profileHeaderLeft}>
              <Ionicons name="person" size={16} color="#fff" />
              <Text style={styles.profileTopLabel}>VOTRE PROFIL</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TouchableOpacity
                style={styles.profileLinkBtn}
                onPress={async () => {
                  setRefreshing(true);
                  await load();
                  await refresh();
                  setRefreshing(false);
                }}
                testID="services-refresh-btn"
              >
                <Ionicons name="refresh" size={18} color={ORANGE} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.profileLinkBtn}
                onPress={() => setMenuOpen(true)}
                testID="services-menu-btn"
              >
                <Ionicons name="ellipsis-vertical" size={18} color={ORANGE} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.profileBody}>
            <View style={styles.avatarWrap}>
              {user?.avatar_url ? (
                <Image source={{ uri: user.avatar_url }} style={styles.avatarImg} />
              ) : (
                <View style={[styles.avatarInitials, { backgroundColor: tone }]}>
                  <Text style={styles.avatarInitialsTxt}>{initials}</Text>
                </View>
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.greeting}>BONJOUR</Text>
              <Text style={styles.userName} numberOfLines={2} adjustsFontSizeToFit>
                {user?.username?.toUpperCase() || "—"}
              </Text>
              <View style={styles.metaRow}>
                <View style={styles.metaItem}>
                  <Ionicons name="star" size={12} color="#fff" />
                  <Text style={styles.metaTxt}>{isActive ? "ABONNÉ" : "INACTIF"}</Text>
                </View>
                <View style={styles.metaItem}>
                  <Ionicons name="people" size={12} color="#fff" />
                  <Text style={styles.metaTxt}>N{user?.max_level || 0}</Text>
                </View>
                <View style={styles.metaItem}>
                  <Ionicons name="sparkles" size={12} color="#fff" />
                  <Text style={styles.metaTxt} numberOfLines={1}>
                    {user?.username || "—"}
                  </Text>
                </View>
              </View>
            </View>
          </View>
        </LinearGradient>

        {/* SERVICES TITLE */}
        <Text style={styles.sectionTitle}>NOS SERVICES</Text>

        {/* 4 SERVICE TILES */}
        <View style={styles.tilesRow}>
          {TILES.map((t) => {
            const count =
              t.key === "formation"
                ? counts.formations
                : t.key === "ebook"
                ? counts.ebooks
                : t.key === "premium"
                ? counts.premium_apps
                : counts.trading_enabled ? 1 : 0;
            return (
              <TouchableOpacity
                key={t.key}
                style={styles.tile}
                onPress={() => onTilePress(t)}
                testID={`service-tile-${t.key}`}
              >
                <View style={styles.tileIconBox}>
                  <Ionicons name={t.icon} size={32} color="#fff" />
                </View>
                <Text style={styles.tileLabel} numberOfLines={2}>{t.label}</Text>
                {count === 0 ? (
                  <Text style={styles.tileBadge}>Bientôt</Text>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* CENTRAL HERO — "Nos services supplémentaires" */}
        <LinearGradient
          colors={theme.colors.primaryGradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.hero}
        >
          <View style={{ flex: 1, paddingRight: 8 }}>
            <View style={styles.heroRocketRow}>
              <Ionicons name="rocket" size={18} color="#fff" />
              <Text style={styles.heroTitle}>NOS SERVICES{"\n"}SUPPLÉMENTAIRES</Text>
            </View>
            <Text style={styles.heroBody}>
              Accédez à nos formations, e-books, applications premium et services
              complémentaires conçus pour accompagner votre progression.
            </Text>
            <TouchableOpacity
              style={styles.heroBtn}
              onPress={() => router.push("/(app)/dashboard")}
              testID="discover-services-btn"
            >
              <Ionicons name="apps" size={18} color={theme.colors.primary} />
              <Text style={styles.heroBtnTxt}>DÉCOUVRIR NOS SERVICES</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.heroIllustration}>
            <View style={styles.heroSparkle}><Ionicons name="sparkles" size={14} color="#FFD566" /></View>
            <Ionicons name="laptop-outline" size={68} color="rgba(255,255,255,0.85)" />
            <Ionicons name="phone-portrait-outline" size={36} color="rgba(255,255,255,0.7)" style={{ marginLeft: -10, marginBottom: -8 }} />
          </View>
        </LinearGradient>

        {/* PRESENTATION SECTION */}
        <Text style={[styles.sectionTitle, { marginTop: 22 }]}>
          PRÉSENTATION DE NOS SERVICES
        </Text>
        <View style={styles.presCard}>
          <PresRow icon="school" title="FORMATION" body="Suivez des formations complètes et pratiques pour développer vos compétences et atteindre vos objectifs." />
          <View style={styles.presDivider} />
          <PresRow icon="book" title="E-BOOK" body="Accédez à des e-books exclusifs pour approfondir vos connaissances et passer à l'action." />
          <View style={styles.presDivider} />
          <PresRow icon="diamond" title="APPLICATION PREMIUM" body="Utilisez des applications puissantes et innovantes pour automatiser, analyser et optimiser vos activités." />
          <View style={styles.presDivider} />
          <PresRow icon="trending-up" title="TRADING" body="Apprenez, analysez et tradez intelligemment pour générer des revenus sur les marchés financiers." />
          <View style={styles.missionBox}>
            <Ionicons name="megaphone" size={16} color={theme.colors.primary} />
            <Text style={styles.missionTxt}>
              NOTRE MISSION : VOUS ACCOMPAGNER, VOUS FORMER ET VOUS DONNER LES MEILLEURS OUTILS POUR RÉUSSIR.
            </Text>
          </View>
        </View>
      </ScrollView>

      <SideMenu visible={menuOpen} onClose={() => setMenuOpen(false)} />
    </SafeAreaView>
  );
}

function PresRow({ icon, title, body }: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }) {
  return (
    <View style={styles.presRow}>
      <View style={styles.presIconCircle}>
        <Ionicons name={icon} size={18} color={ORANGE} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.presTitle}>{title}</Text>
        <Text style={styles.presBody}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },

  profileCard: {
    borderRadius: 18,
    padding: 14,
    paddingTop: 12,
    borderWidth: 4,
    borderColor: "rgba(255,255,255,0.85)",
    ...theme.shadow.card,
  },
  profileHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  profileHeaderLeft: { flexDirection: "row", alignItems: "center", gap: 6 },
  profileTopLabel: { color: "#fff", fontWeight: "800", fontSize: 12, letterSpacing: 0.5 },
  profileLinkBtn: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: "#fff", alignItems: "center", justifyContent: "center",
  },
  profileBody: { flexDirection: "row", gap: 12, marginTop: 6 },
  avatarWrap: {
    width: 92, height: 92, borderRadius: 46,
    borderWidth: 3, borderColor: "#fff",
    overflow: "hidden", backgroundColor: "#fff",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarInitials: { flex: 1, alignItems: "center", justifyContent: "center" },
  avatarInitialsTxt: { color: "#fff", fontWeight: "900", fontSize: 32 },
  greeting: { color: "#fff", fontSize: 12, letterSpacing: 1 },
  userName: { color: ORANGE, fontWeight: "900", fontSize: 22, lineHeight: 24, marginTop: 2 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaTxt: { color: "#fff", fontWeight: "700", fontSize: 11, letterSpacing: 0.5 },

  sectionTitle: {
    color: theme.colors.textPrimary,
    fontWeight: "900",
    fontSize: 20,
    marginTop: 16,
    marginBottom: 10,
    letterSpacing: 0.5,
  },

  tilesRow: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  tile: { flex: 1, alignItems: "center" },
  tileIconBox: {
    width: 72, height: 72, borderRadius: 14,
    backgroundColor: ORANGE,
    alignItems: "center", justifyContent: "center",
    ...theme.shadow.card,
  },
  tileLabel: {
    color: theme.colors.textPrimary, fontWeight: "800",
    fontSize: 12, textAlign: "center", marginTop: 8, lineHeight: 14,
  },
  tileBadge: {
    marginTop: 4, fontSize: 9,
    color: theme.colors.warning, fontWeight: "700",
  },

  hero: {
    borderRadius: 20, marginTop: 14, padding: 16, paddingRight: 8,
    flexDirection: "row", alignItems: "center",
    ...theme.shadow.card,
  },
  heroRocketRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  heroTitle: { color: "#fff", fontWeight: "900", fontSize: 18, lineHeight: 20 },
  heroBody: { color: "#C7D9FF", fontSize: 12, lineHeight: 17, marginTop: 8 },
  heroBtn: {
    marginTop: 14, alignSelf: "flex-start",
    backgroundColor: "#fff", paddingHorizontal: 12, paddingVertical: 9,
    borderRadius: 24,
    flexDirection: "row", alignItems: "center", gap: 6,
  },
  heroBtnTxt: { color: theme.colors.primary, fontWeight: "900", fontSize: 11, letterSpacing: 0.5 },
  heroIllustration: {
    width: 100, alignItems: "center", justifyContent: "center",
    flexDirection: "row",
  },
  heroSparkle: { position: "absolute", top: -10, left: 8 },

  presCard: {
    backgroundColor: "#EEF2FF",
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  presRow: { flexDirection: "row", gap: 12, paddingVertical: 8 },
  presIconCircle: {
    width: 32, height: 32, borderRadius: 16,
    borderWidth: 2, borderColor: ORANGE,
    backgroundColor: "#FFF7ED",
    alignItems: "center", justifyContent: "center",
  },
  presTitle: { fontWeight: "900", color: theme.colors.textPrimary, fontSize: 13, letterSpacing: 0.3 },
  presBody: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 2 },
  presDivider: { height: 1, backgroundColor: "#DBE2FA" },
  missionBox: {
    marginTop: 10, padding: 10, borderRadius: 12,
    backgroundColor: "#DBE2FA",
    flexDirection: "row", alignItems: "center", gap: 8,
    borderWidth: 1, borderColor: "#C2CFF4",
  },
  missionTxt: { flex: 1, color: theme.colors.primary, fontWeight: "800", fontSize: 11, letterSpacing: 0.3 },
});

void ORANGE_DARK; // reserved for hover/pressed states
