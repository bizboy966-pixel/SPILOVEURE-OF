import React, { useEffect, useState } from "react";
import {
  AccessibilityInfo,
  Image,
  Pressable,
  Platform,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";

import { useI18n } from "@/src/i18n";
import { ChatMockup, DashboardMockup, PhoneFloat } from "./PhoneMockups";
import { PromoVisuals } from "./PromoVisuals";
import { styles } from "./landingStyles";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

type NewLandingPageProps = {
  refCode?: string;
  showPreview: boolean;
  onPreview: () => void;
  onLogin: () => void;
  onRegister: () => void;
};

const SERVICES: { icon: IconName; key: string; tint: string }[] = [
  { icon: "megaphone-outline", key: "ads", tint: "#FFE064" },
  { icon: "storefront-outline", key: "market", tint: "#76D7FF" },
  { icon: "school-outline", key: "training", tint: "#FF9CE0" },
  { icon: "book-outline", key: "ebooks", tint: "#A3F0C4" },
];

const BENEFITS: { icon: IconName; key: string }[] = [
  { icon: "people-outline", key: "affiliate" },
  { icon: "chatbubbles-outline", key: "chat" },
  { icon: "bag-handle-outline", key: "sell" },
  { icon: "megaphone-outline", key: "ads" },
  { icon: "school-outline", key: "training" },
  { icon: "book-outline", key: "books" },
];

export default function NewLandingPage({
  showPreview,
  onPreview,
  onLogin,
  onRegister,
}: NewLandingPageProps) {
  const { t, lang, setLang } = useI18n();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const medium = width >= 620;
  const compactHeader = width < 460;
  const tinyHeader = width < 360;
  const footerActionsRow = width >= 760;
  const benefitsFourColumns = width >= 520;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;

    const html = document.documentElement;
    const body = document.body;
    const previousHtmlBackground = html.style.backgroundColor;
    const previousBodyBackground = body.style.backgroundColor;
    html.style.backgroundColor = "#022BA3";
    body.style.backgroundColor = "#022BA3";

    return () => {
      html.style.backgroundColor = previousHtmlBackground;
      body.style.backgroundColor = previousBodyBackground;
    };
  }, []);

  const toggleLanguage = () => {
    void setLang(lang === "fr" ? "en" : "fr");
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} bounces={false}>
        <LinearGradient
          colors={["#022BA3", "#0755E4", "#0336D0", "#1995FA"]}
          locations={[0, 0.42, 0.75, 1]}
          start={{ x: 0.04, y: 0.03 }}
          end={{ x: 0.95, y: 0.96 }}
          style={styles.hero}
        >
          <View pointerEvents="none" style={styles.orbA} />
          <View pointerEvents="none" style={styles.orbB} />
          <View pointerEvents="none" style={styles.halo} />
          <View pointerEvents="none" style={styles.goldArcTop} />
          <View pointerEvents="none" style={styles.goldArcBottom} />

          <View style={[styles.header, wide && styles.headerWide]}>
            <View style={[styles.brand, compactHeader && styles.brandCompact]}>
              <View style={[styles.logoFrame, compactHeader && styles.logoFrameCompact]}>
                <Image
                  source={require("@/assets/images/spiloveure-logo.png")}
                  style={[styles.logo, compactHeader && styles.logoCompact]}
                  resizeMode="cover"
                  accessibilityLabel="SPILOVEURE"
                />
              </View>
              <Text style={[styles.wordmark, compactHeader && styles.wordmarkCompact]}>SPILOVEURE</Text>
            </View>
            <View style={[styles.navActions, compactHeader && styles.navActionsCompact]}>
              <Pressable
                onPress={toggleLanguage}
                style={({ pressed }) => [
                  styles.languageButton,
                  compactHeader && styles.languageButtonCompact,
                  pressed && styles.pressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={lang === "fr" ? "Switch language to English" : "Passer en français"}
                testID="landing-redesign-language"
              >
                {!tinyHeader ? <Ionicons name="globe-outline" size={compactHeader ? 14 : 17} color="#FFFFFF" /> : null}
                <Text style={styles.languageText}>{lang.toUpperCase()}</Text>
                {!tinyHeader ? <Ionicons name="chevron-down" size={compactHeader ? 12 : 13} color="#D5E8FF" /> : null}
              </Pressable>
              <Pressable
                onPress={onLogin}
                style={({ pressed }) => [
                  styles.headerLogin,
                  compactHeader && styles.headerLoginCompact,
                  pressed && styles.pressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={t("landingRedesign.header.login")}
                testID="landing-redesign-header-login"
              >
                <Text style={[styles.headerLoginText, compactHeader && styles.headerLoginTextCompact]}>
                  {t("landingRedesign.header.login")}
                </Text>
                <Ionicons name="arrow-forward" size={compactHeader ? 14 : 16} color="#062EAE" />
              </Pressable>
            </View>
          </View>

          <View style={[styles.heroContent, wide && styles.heroContentWide]}>
            <View style={[styles.copyColumn, wide && styles.copyColumnWide]}>
              <Text style={[styles.headline, medium && styles.headlineMedium, wide && styles.headlineWide]}>
                {t("landingRedesign.hero.titleBefore")}
                <Text style={styles.headlineGold}>{t("landingRedesign.hero.titleGold")}</Text>
                {t("landingRedesign.hero.titleAfter")}
              </Text>
              <Text style={[styles.description, wide && styles.descriptionWide]}>
                {t("landingRedesign.hero.subtitle")}
              </Text>
            </View>

            <View style={[styles.previewColumn, wide && styles.previewColumnWide]}>
              <View style={styles.previewLabelWrap}>
                <View style={styles.liveDot} />
                <Text style={styles.previewLabel}>{t("landingRedesign.mockupLabel")}</Text>
              </View>
              <View style={[styles.phoneStage, wide && styles.phoneStageWide, medium && !wide && styles.phoneStageMedium]}>
                <PhoneFloat
                  delay={1700}
                  reduced={reduceMotion}
                  style={[
                    styles.centerPhone,
                    compactHeader && styles.centerPhoneCompact,
                    medium && !wide && styles.centerPhoneMedium,
                    wide && styles.centerPhoneWide,
                  ]}
                >
                  <DashboardMockup t={t} compact={!wide} />
                </PhoneFloat>
                <PhoneFloat
                  delay={900}
                  reduced={reduceMotion}
                  style={[
                    styles.rightPhone,
                    compactHeader && styles.rightPhoneCompact,
                    medium && !wide && styles.rightPhoneMedium,
                    wide && styles.rightPhoneWide,
                  ]}
                >
                  <ChatMockup t={t} variation="conversation" small={!wide} />
                </PhoneFloat>
                <View pointerEvents="none" style={styles.stageGlow} />
              </View>
            </View>
          </View>

          <PromoVisuals t={t} />

          <View style={[styles.serviceGrid, medium && styles.serviceGridMedium]}>
            {SERVICES.map((service) => (
              <View
                key={service.key}
                style={[styles.serviceTile, medium && styles.serviceTileMedium]}
                testID={`landing-redesign-service-${service.key}`}
              >
                <View style={[styles.serviceIcon, { borderColor: `${service.tint}55` }]}>
                  <Ionicons name={service.icon} size={19} color={service.tint} />
                </View>
                <View style={styles.serviceCopy}>
                  <Text style={styles.serviceTitle}>{t(`landingRedesign.service.${service.key}`)}</Text>
                  <Text style={styles.serviceDetail}>{t(`landingRedesign.service.${service.key}Detail`)}</Text>
                </View>
                <Ionicons name="chevron-forward" size={15} color="#BFDFFF" />
              </View>
            ))}
          </View>

          <View style={[styles.benefits, wide && styles.benefitsWide]}>
            {BENEFITS.map((benefit, index) => (
              <View
                key={benefit.key}
                style={[styles.benefitItem, benefitsFourColumns && styles.benefitItemFour]}
              >
                <View style={styles.checkMark}>
                  <Ionicons name="checkmark" size={14} color="#FFFFFF" />
                </View>
                <Text style={styles.benefitText}>{t(`landingRedesign.benefit.${benefit.key}`)}</Text>
                {index < BENEFITS.length - 1 ? <View style={styles.benefitDivider} /> : null}
              </View>
            ))}
          </View>

          <View style={styles.actionFooter} testID="landing-redesign-action-footer">
          <View style={[styles.footerActions, footerActionsRow && styles.footerActionsRow]}>
            {showPreview ? <Pressable
              onPress={onPreview}
              style={({ pressed }) => [
                styles.previewButton,
                styles.footerActionButton,
                footerActionsRow && styles.footerActionButtonRow,
                pressed && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t("landingRedesign.actions.preview")}
              testID="landing-redesign-preview"
            >
              <Ionicons name="eye-outline" size={21} color="#FFFFFF" />
              <Text style={styles.previewButtonText}>{t("landingRedesign.actions.preview")}</Text>
            </Pressable> : null}
            <Pressable
              onPress={onLogin}
              style={({ pressed }) => [
                styles.loginAction,
                styles.footerActionButton,
                footerActionsRow && styles.footerActionButtonRow,
                pressed && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t("landingRedesign.actions.login")}
              testID="landing-redesign-login"
            >
              <Ionicons name="person-outline" size={21} color="#072D9E" />
              <Text style={styles.loginActionText}>{t("landingRedesign.actions.login")}</Text>
            </Pressable>
            <Pressable
              onPress={onRegister}
              style={({ pressed }) => [
                styles.registerAction,
                styles.footerActionButton,
                footerActionsRow && styles.footerActionButtonRow,
                pressed && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={t("landingRedesign.actions.register")}
              testID="landing-redesign-register"
            >
              <Ionicons name="rocket-outline" size={21} color="#192346" />
              <Text style={styles.registerActionText}>{t("landingRedesign.actions.register")}</Text>
              <Ionicons name="arrow-forward" size={17} color="#192346" />
            </Pressable>
          </View>
          </View>
        </LinearGradient>
      </ScrollView>
    </SafeAreaView>
  );
}
