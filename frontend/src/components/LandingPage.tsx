import React from "react";
import {
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { theme } from "@/src/theme";
import { useI18n } from "@/src/i18n";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

const SERVICES: { icon: IconName; color: string; bg: string; key: string }[] = [
  { key: "training_ecom",   icon: "cart-outline",              color: "#1B5BFF", bg: "#E0EAFF" },
  { key: "training_cm",     icon: "phone-portrait-outline",    color: "#7B61FF", bg: "#EFEAFF" },
  { key: "ebooks",          icon: "book-outline",              color: "#10B981", bg: "#D1FAE5" },
  { key: "coaching",        icon: "people-outline",            color: "#F59E0B", bg: "#FEF3C7" },
  { key: "training_entrep", icon: "rocket-outline",            color: "#EC4899", bg: "#FCE7F3" },
  { key: "trading_signals", icon: "trending-up-outline",       color: "#0EA5E9", bg: "#DBEAFE" },
  { key: "premium_apps",    icon: "diamond-outline",           color: "#8B5CF6", bg: "#EDE9FE" },
  { key: "ads",             icon: "megaphone-outline",         color: "#7B61FF", bg: "#EFEAFF" },
  { key: "tasks",           icon: "checkmark-done-circle-outline", color: "#10B981", bg: "#D1FAE5" },
  { key: "marketplace",     icon: "storefront-outline",        color: "#F59E0B", bg: "#FEF3C7" },
  { key: "lottery",         icon: "sparkles-outline",          color: "#EC4899", bg: "#FCE7F3" },
  { key: "missions",        icon: "trophy-outline",            color: "#0EA5E9", bg: "#DBEAFE" },
];

const STATS: { key: string; value: string }[] = [
  { key: "landing.stats.members", value: "12 500+" },
  { key: "landing.stats.paid", value: "180M+" },
  { key: "landing.stats.countries", value: "59+" },
  { key: "landing.stats.uptime", value: "99,9%" },
];

const STEPS: { icon: IconName; key: string }[] = [
  { key: "step1", icon: "person-add-outline" },
  { key: "step2", icon: "flash-outline" },
  { key: "step3", icon: "cash-outline" },
];

export default function LandingPage() {
  const router = useRouter();
  const { t, lang, setLang } = useI18n();
  const { width } = useWindowDimensions();

  const isTablet = width >= 720;
  const isDesktop = width >= 1080;

  const goRegister = () => router.push("/(auth)/register");
  const goLogin = () => router.push("/(auth)/login");
  const toggleLang = () => setLang(lang === "fr" ? "en" : "fr");

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* ─── HEADER ─────────────────────────────────────────── */}
        <View style={[styles.header, isDesktop && styles.headerDesktop]}>
          <View style={styles.brandRow}>
            <Image
              source={require("@/assets/images/spiloveure-logo.png")}
              style={styles.brandLogo}
              resizeMode="contain"
            />
            <Text style={styles.brandName}>SPILOVEURE</Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              onPress={toggleLang}
              style={styles.langBtn}
              testID="landing-lang-toggle"
            >
              <Ionicons name="globe-outline" size={16} color={theme.colors.textPrimary} />
              <Text style={styles.langText}>{lang.toUpperCase()}</Text>
            </Pressable>
            <Pressable
              onPress={goLogin}
              style={styles.loginBtn}
              testID="landing-login-btn"
            >
              <Text style={styles.loginText}>{t("landing.nav.login")}</Text>
            </Pressable>
          </View>
        </View>

        {/* ─── HERO ───────────────────────────────────────────── */}
        <LinearGradient
          colors={["#0B2D6F", "#1B5BFF", "#7B61FF"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.hero}
        >
          {/* Decorative glow blobs */}
          <View style={[styles.blob, styles.blobTop]} />
          <View style={[styles.blob, styles.blobBottom]} />

          <View
            style={[
              styles.heroInner,
              isDesktop && styles.heroInnerDesktop,
            ]}
          >
            <View style={[styles.heroLeft, isDesktop && { flex: 1.1 }]}>
              <View style={styles.badge}>
                <View style={styles.badgeDot} />
                <Text style={styles.badgeText}>{t("landing.hero.badge")}</Text>
              </View>
              <Text
                style={[
                  styles.heroTitle,
                  isTablet && styles.heroTitleTablet,
                  isDesktop && styles.heroTitleDesktop,
                ]}
              >
                {t("landing.hero.title")}
              </Text>
              <Text
                style={[
                  styles.heroTagline,
                  isTablet && { fontSize: 24 },
                ]}
              >
                {t("landing.hero.tagline")}
              </Text>
              <Text style={styles.heroSubtitle}>{t("landing.hero.subtitle")}</Text>

              <View style={[styles.heroCtas, isTablet && { flexDirection: "row" }]}>
                <Pressable
                  onPress={goRegister}
                  style={({ pressed }) => [
                    styles.ctaPrimary,
                    pressed && { transform: [{ scale: 0.98 }] },
                  ]}
                  testID="landing-register-btn"
                >
                  <Text style={styles.ctaPrimaryText}>
                    {t("landing.hero.cta_primary")}
                  </Text>
                  <Ionicons name="arrow-forward" size={18} color={theme.colors.primary} />
                </Pressable>
                <Pressable
                  onPress={goLogin}
                  style={styles.ctaGhost}
                  testID="landing-login-cta"
                >
                  <Text style={styles.ctaGhostText}>
                    {t("landing.hero.cta_secondary")}
                  </Text>
                </Pressable>
              </View>

              <View style={styles.trustRow}>
                <Ionicons name="shield-checkmark" size={16} color="#C7D9FF" />
                <Text style={styles.trustText}>{t("landing.hero.trust")}</Text>
              </View>
            </View>

            {isDesktop && (
              <View style={styles.heroRight}>
                <HeroPreview t={t} />
              </View>
            )}
          </View>

          {/* Stats strip */}
          <View style={[styles.statsWrap, isTablet && styles.statsWrapTablet]}>
            {STATS.map((s) => (
              <View key={s.key} style={styles.statCard}>
                <Text style={styles.statValue}>{s.value}</Text>
                <Text style={styles.statLabel}>{t(s.key)}</Text>
              </View>
            ))}
          </View>
        </LinearGradient>

        {/* ─── SERVICES ───────────────────────────────────────── */}
        <View style={[styles.section, isDesktop && styles.sectionDesktop]}>
          <Text style={styles.eyebrow}>{t("landing.services.eyebrow")}</Text>
          <Text style={styles.sectionTitle}>{t("landing.services.title")}</Text>
          <Text style={styles.sectionSubtitle}>{t("landing.services.subtitle")}</Text>

          <View style={[styles.grid, isTablet && styles.grid2, isDesktop && styles.grid3]}>
            {SERVICES.map((s) => (
              <View
                key={s.key}
                style={[
                  styles.serviceCard,
                  isTablet && styles.serviceCardHalf,
                  isDesktop && styles.serviceCardThird,
                ]}
                testID={`landing-service-${s.key}`}
              >
                <View style={[styles.serviceIcon, { backgroundColor: s.bg }]}>
                  <Ionicons name={s.icon} size={26} color={s.color} />
                </View>
                <Text style={styles.serviceTitle}>
                  {t(`landing.services.${s.key}.title`)}
                </Text>
                <Text style={styles.serviceDesc}>
                  {t(`landing.services.${s.key}.desc`)}
                </Text>
              </View>
            ))}
          </View>
        </View>

        {/* ─── HOW IT WORKS ───────────────────────────────────── */}
        <View style={[styles.section, styles.howSection, isDesktop && styles.sectionDesktop]}>
          <Text style={styles.eyebrow}>{t("landing.how.eyebrow")}</Text>
          <Text style={styles.sectionTitle}>{t("landing.how.title")}</Text>

          <View style={[styles.steps, isTablet && styles.stepsRow]}>
            {STEPS.map((step, idx) => (
              <View
                key={step.key}
                style={[styles.stepCard, isTablet && styles.stepCardThird]}
                testID={`landing-step-${step.key}`}
              >
                <View style={styles.stepNumber}>
                  <Text style={styles.stepNumberText}>{idx + 1}</Text>
                </View>
                <View style={styles.stepIcon}>
                  <Ionicons name={step.icon} size={28} color={theme.colors.primary} />
                </View>
                <Text style={styles.stepTitle}>
                  {t(`landing.how.${step.key}.title`)}
                </Text>
                <Text style={styles.stepDesc}>
                  {t(`landing.how.${step.key}.desc`)}
                </Text>
              </View>
            ))}
          </View>
        </View>

        {/* ─── FINAL CTA ──────────────────────────────────────── */}
        <View style={[styles.section, isDesktop && styles.sectionDesktop]}>
          <LinearGradient
            colors={["#0B2D6F", "#1B5BFF"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.finalCta}
          >
            <Ionicons name="rocket" size={40} color="#fff" />
            <Text style={styles.finalCtaTitle}>{t("landing.cta.title")}</Text>
            <Text style={styles.finalCtaSubtitle}>{t("landing.cta.subtitle")}</Text>
            <Pressable
              onPress={goRegister}
              style={styles.ctaPrimary}
              testID="landing-final-cta"
            >
              <Text style={styles.ctaPrimaryText}>{t("landing.cta.button")}</Text>
              <Ionicons name="arrow-forward" size={18} color={theme.colors.primary} />
            </Pressable>
          </LinearGradient>
        </View>

        {/* ─── FOOTER ─────────────────────────────────────────── */}
        <View style={styles.footer}>
          <View style={styles.brandRow}>
            <Image
              source={require("@/assets/images/spiloveure-logo.png")}
              style={styles.brandLogoSmall}
              resizeMode="contain"
            />
            <Text style={styles.footerBrand}>SPILOVEURE</Text>
          </View>
          <Text style={styles.footerTagline}>{t("landing.footer.tagline")}</Text>
          <Text style={styles.footerCopy}>{t("landing.footer.copy")}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Small preview card shown on desktop next to the hero — a "product screenshot"
 * built entirely with primitives so it looks polished without stock imagery.
 */
function HeroPreview({ t }: { t: (k: string) => string }) {
  return (
    <View style={previewStyles.wrap}>
      <View style={previewStyles.card}>
        <View style={previewStyles.header}>
          <View style={[previewStyles.dot, { backgroundColor: "#EF4444" }]} />
          <View style={[previewStyles.dot, { backgroundColor: "#F59E0B" }]} />
          <View style={[previewStyles.dot, { backgroundColor: "#10B981" }]} />
        </View>
        <View style={previewStyles.body}>
          <Text style={previewStyles.label}>{t("dashboard.balance_withdrawable")}</Text>
          <Text style={previewStyles.balance}>245 780 FCFA</Text>
          <View style={previewStyles.bars}>
            <View style={[previewStyles.bar, { height: 40, backgroundColor: "#1B5BFF" }]} />
            <View style={[previewStyles.bar, { height: 65, backgroundColor: "#7B61FF" }]} />
            <View style={[previewStyles.bar, { height: 32, backgroundColor: "#1B5BFF" }]} />
            <View style={[previewStyles.bar, { height: 78, backgroundColor: "#7B61FF" }]} />
            <View style={[previewStyles.bar, { height: 55, backgroundColor: "#1B5BFF" }]} />
            <View style={[previewStyles.bar, { height: 88, backgroundColor: "#10B981" }]} />
          </View>
          <View style={previewStyles.row}>
            <View style={previewStyles.chip}>
              <Ionicons name="people" size={14} color="#1B5BFF" />
              <Text style={previewStyles.chipText}>+126 filleuls</Text>
            </View>
            <View style={[previewStyles.chip, { backgroundColor: "#D1FAE5" }]}>
              <Ionicons name="trending-up" size={14} color="#10B981" />
              <Text style={[previewStyles.chipText, { color: "#065F46" }]}>+18%</Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  scroll: { paddingBottom: 40 },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerDesktop: {
    paddingHorizontal: 64,
    paddingVertical: 20,
    maxWidth: 1280,
    width: "100%",
    alignSelf: "center",
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  brandLogo: { width: 40, height: 40 },
  brandLogoSmall: { width: 28, height: 28 },
  brandName: {
    fontSize: 20,
    fontWeight: "800",
    color: theme.colors.textPrimary,
    letterSpacing: 1,
  },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  langBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: "#fff",
  },
  langText: { fontSize: 12, fontWeight: "700", color: theme.colors.textPrimary },
  loginBtn: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: theme.colors.textPrimary,
  },
  loginText: { color: "#fff", fontWeight: "700", fontSize: 13 },

  // Hero
  hero: {
    paddingHorizontal: 20,
    paddingTop: 40,
    paddingBottom: 80,
    overflow: "hidden",
    position: "relative",
  },
  blob: {
    position: "absolute",
    width: 320,
    height: 320,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  blobTop: { top: -120, right: -80 },
  blobBottom: { bottom: -160, left: -100 },
  heroInner: { maxWidth: 1200, width: "100%", alignSelf: "center" },
  heroInnerDesktop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 48,
    paddingHorizontal: 44,
    paddingTop: 24,
  },
  heroLeft: { flex: 1 },
  heroRight: { flex: 1, alignItems: "center" },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.25)",
    marginBottom: 20,
  },
  badgeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#10B981",
  },
  badgeText: { color: "#E0EAFF", fontSize: 12, fontWeight: "600" },
  heroTitle: {
    color: "#fff",
    fontSize: 48,
    fontWeight: "900",
    letterSpacing: 1,
    lineHeight: 52,
  },
  heroTitleTablet: { fontSize: 64, lineHeight: 68 },
  heroTitleDesktop: { fontSize: 80, lineHeight: 84 },
  heroTagline: {
    color: "#C7D9FF",
    fontSize: 20,
    fontWeight: "600",
    marginTop: 4,
    fontStyle: "italic",
  },
  heroSubtitle: {
    color: "#E0EAFF",
    fontSize: 16,
    lineHeight: 24,
    marginTop: 20,
    maxWidth: 560,
  },
  heroCtas: { marginTop: 28, gap: 12 },
  ctaPrimary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#fff",
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderRadius: 999,
    ...Platform.select({
      web: { boxShadow: "0 10px 30px rgba(11,45,111,0.35)" },
      default: {
        shadowColor: "#0B2D6F",
        shadowOpacity: 0.35,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 8 },
        elevation: 8,
      },
    }),
  },
  ctaPrimaryText: {
    color: theme.colors.primary,
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  ctaGhost: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.4)",
  },
  ctaGhostText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  trustRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 24,
  },
  trustText: { color: "#C7D9FF", fontSize: 13 },

  // Stats strip
  statsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 44,
    maxWidth: 1200,
    width: "100%",
    alignSelf: "center",
    paddingHorizontal: 4,
  },
  statsWrapTablet: { paddingHorizontal: 44 },
  statCard: {
    flexGrow: 1,
    flexBasis: "40%",
    minWidth: 140,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderColor: "rgba(255,255,255,0.2)",
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 20,
    paddingHorizontal: 16,
    alignItems: "center",
    ...Platform.select({
      web: { backdropFilter: "blur(12px)" } as any,
      default: {},
    }),
  },
  statValue: { color: "#fff", fontSize: 26, fontWeight: "900", letterSpacing: 0.5 },
  statLabel: {
    color: "#C7D9FF",
    fontSize: 12,
    fontWeight: "600",
    marginTop: 4,
    textAlign: "center",
  },

  // Sections
  section: {
    paddingHorizontal: 20,
    paddingVertical: 56,
  },
  sectionDesktop: {
    paddingHorizontal: 64,
    maxWidth: 1280,
    width: "100%",
    alignSelf: "center",
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 2,
    color: theme.colors.primary,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 30,
    fontWeight: "900",
    color: theme.colors.textPrimary,
    lineHeight: 36,
    maxWidth: 720,
  },
  sectionSubtitle: {
    fontSize: 15,
    color: theme.colors.textSecondary,
    marginTop: 10,
    maxWidth: 640,
    lineHeight: 22,
  },

  // Services grid
  grid: { marginTop: 32, gap: 16 },
  grid2: { flexDirection: "row", flexWrap: "wrap" },
  grid3: { flexDirection: "row", flexWrap: "wrap" },
  serviceCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...Platform.select({
      web: { boxShadow: "0 4px 20px rgba(11,45,111,0.06)" },
      default: theme.shadow.card,
    }),
  },
  serviceCardHalf: { flexBasis: "48%", flexGrow: 1 },
  serviceCardThird: { flexBasis: "31%", flexGrow: 1 },
  serviceIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  serviceTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: theme.colors.textPrimary,
    marginBottom: 6,
  },
  serviceDesc: {
    fontSize: 14,
    lineHeight: 21,
    color: theme.colors.textSecondary,
  },

  // How it works
  howSection: { backgroundColor: "#F1F5F9" },
  steps: { marginTop: 32, gap: 20 },
  stepsRow: { flexDirection: "row", flexWrap: "wrap" },
  stepCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: theme.colors.border,
    position: "relative",
  },
  stepCardThird: { flexBasis: "31%", flexGrow: 1 },
  stepNumber: {
    position: "absolute",
    top: -12,
    left: 24,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  stepNumberText: { color: "#fff", fontWeight: "900", fontSize: 13 },
  stepIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: "#E0EAFF",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
    marginTop: 8,
  },
  stepTitle: {
    fontSize: 17,
    fontWeight: "800",
    color: theme.colors.textPrimary,
    marginBottom: 6,
  },
  stepDesc: { fontSize: 14, lineHeight: 21, color: theme.colors.textSecondary },

  // Final CTA
  finalCta: {
    borderRadius: 28,
    padding: 40,
    alignItems: "center",
  },
  finalCtaTitle: {
    fontSize: 26,
    fontWeight: "900",
    color: "#fff",
    marginTop: 16,
    textAlign: "center",
  },
  finalCtaSubtitle: {
    fontSize: 15,
    color: "#C7D9FF",
    marginTop: 8,
    marginBottom: 24,
    textAlign: "center",
    maxWidth: 480,
    lineHeight: 22,
  },

  // Footer
  footer: {
    paddingHorizontal: 20,
    paddingVertical: 32,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    gap: 8,
  },
  footerBrand: {
    fontSize: 16,
    fontWeight: "800",
    color: theme.colors.textPrimary,
    letterSpacing: 1,
  },
  footerTagline: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    fontStyle: "italic",
  },
  footerCopy: { fontSize: 12, color: theme.colors.textSecondary, marginTop: 4 },
});

const previewStyles = StyleSheet.create({
  wrap: { width: "100%", alignItems: "center" },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#fff",
    borderRadius: 22,
    ...Platform.select({
      web: { boxShadow: "0 30px 60px rgba(11,45,111,0.35)" },
      default: {
        shadowColor: "#000",
        shadowOpacity: 0.3,
        shadowRadius: 20,
        shadowOffset: { width: 0, height: 20 },
        elevation: 12,
      },
    }),
    overflow: "hidden",
    transform: [{ rotate: "-2deg" }],
  },
  header: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#F1F5F9",
    borderBottomWidth: 1,
    borderColor: "#E2E8F0",
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  body: { padding: 20 },
  label: {
    fontSize: 12,
    color: "#64748B",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  balance: {
    fontSize: 28,
    fontWeight: "900",
    color: "#0B2D6F",
    marginTop: 4,
  },
  bars: {
    marginTop: 20,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    height: 100,
  },
  bar: { flex: 1, borderRadius: 6 },
  row: { flexDirection: "row", gap: 8, marginTop: 20 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "#E0EAFF",
  },
  chipText: { color: "#1B5BFF", fontSize: 12, fontWeight: "700" },
});
