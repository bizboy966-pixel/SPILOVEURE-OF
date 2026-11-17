import React from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useI18n } from "@/src/i18n";
import { chatVisual } from "./chatVisualTokens";

type ProfileSettingsHomeProps = {
  username: string;
  photo?: string;
  onOpen: (section: string) => void;
  onPhotoPress?: () => void;
  dark?: boolean;
};

const settingsSections = [
  {
    name: "Appareils connectés",
    description: "Gérer les appareils connectés à votre compte",
    icon: "phone-portrait-outline",
    slug: "appareils-connectes",
  },
  {
    name: "Compte",
    description: "Sécurité, informations et préférences de compte",
    icon: "person-circle-outline",
    slug: "compte",
  },
  {
    name: "Confidentialité",
    description: "Choisir qui peut voir vos informations",
    icon: "lock-closed-outline",
    slug: "confidentialite",
  },
  {
    name: "Listes",
    description: "Gérer vos listes et vos contacts",
    icon: "list-outline",
    slug: "listes",
  },
  {
    name: "Discussions",
    description: "Personnaliser vos discussions et leur historique",
    icon: "chatbubbles-outline",
    slug: "discussions",
  },
  {
    name: "Apparence",
    description: "Personnaliser l’apparence de l’application",
    icon: "color-palette-outline",
    slug: "apparence",
  },
  {
    name: "Diffusions",
    description: "Créer et gérer vos listes de diffusion",
    icon: "megaphone-outline",
    slug: "diffusions",
  },
  {
    name: "Accessibilité",
    description: "Adapter l’affichage à vos besoins",
    icon: "accessibility-outline",
    slug: "accessibilite",
  },
  {
    name: "Langue de l’application",
    description: "Choisir la langue de SPILOVEURE Chat",
    icon: "language-outline",
    slug: "langue-de-l-application",
  },
  {
    name: "Notifications",
    description: "Sons et alertes des messages et appels",
    icon: "notifications-outline",
    slug: "notifications",
  },
  {
    name: "Stockage et données",
    description: "Utilisation du réseau et de l’espace de stockage",
    icon: "pie-chart-outline",
    slug: "stockage-et-donnees",
  },
] as const;

export default function ProfileSettingsHome({
  username,
  photo,
  onOpen,
  onPhotoPress,
  dark = false,
}: ProfileSettingsHomeProps) {
  const { width } = useWindowDimensions();
  const { t } = useI18n();
  const compact = width < 420;
  const initials = username.trim().slice(0, 1).toLocaleUpperCase() || "?";
  const sectionKeys: Record<string, string> = {
    "appareils-connectes": "connected_devices", compte: "account", confidentialite: "privacy",
    listes: "lists", discussions: "chats", apparence: "appearance", diffusions: "broadcasts",
    accessibilite: "accessibility", "langue-de-l-application": "language",
    notifications: "notifications", "stockage-et-donnees": "storage",
  };

  return (
    <ScrollView
      style={[styles.screen, dark && styles.screenDark]}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
      contentInsetAdjustmentBehavior="automatic"
    >
      <View style={[styles.content, compact && styles.contentCompact]}>
        <View style={styles.headingBlock}>
          <Text style={[styles.eyebrow, dark && styles.textBright]}>SPILOVEURE CHAT</Text>
          <Text style={[styles.title, dark && styles.textBright]}>{t("chat.profile.settings")}</Text>
        </View>

        <View style={[styles.identityCard, dark && styles.cardDark]}>
          <Pressable
            onPress={onPhotoPress}
            disabled={!onPhotoPress}
            accessibilityRole={onPhotoPress ? "button" : undefined}
            accessibilityLabel={onPhotoPress ? "Modifier la photo de profil" : `Photo de profil de ${username}`}
            style={({ pressed }) => [
              styles.avatarButton,
              pressed && onPhotoPress ? styles.avatarPressed : null,
            ]}
          >
            {photo ? (
              <Image source={{ uri: photo }} style={styles.avatarImage} />
            ) : (
              <View style={styles.avatarFallback}>
                <Text style={styles.avatarInitial}>{initials}</Text>
              </View>
            )}
            {onPhotoPress ? (
              <View style={styles.cameraBadge}>
                <Ionicons name="camera-outline" size={14} color={colors.paper} />
              </View>
            ) : null}
          </Pressable>
          <View style={styles.identityCopy}>
            <Text style={[styles.identityLabel, dark && styles.textMutedDark]}>{t("chat.profile.your_profile")}</Text>
            <Text style={[styles.username, dark && styles.textBright]} numberOfLines={1}>{username}</Text>
          </View>
          <View style={styles.identityMark}>
            <Ionicons name="sparkles" size={15} color={colors.gold} />
          </View>
        </View>

        <View style={[styles.menuCard, dark && styles.cardDark]}>
          {settingsSections.map((section, index) => (
            <Pressable
              key={section.slug}
              testID={`profile-settings-row-${section.slug}`}
              onPress={() => onOpen(section.name)}
              accessibilityRole="button"
              accessibilityLabel={`${t(`chat.profile.${sectionKeys[section.slug]}`)}. ${t(`chat.profile.${sectionKeys[section.slug]}_desc`)}`}
              style={({ pressed }) => [
                styles.row,
                dark && styles.rowDark,
                index === settingsSections.length - 1 && styles.lastRow,
                pressed && styles.rowPressed,
              ]}
            >
              <View style={styles.rowIcon}>
                <Ionicons name={section.icon} size={20} color={colors.blue} />
              </View>
              <View style={styles.rowCopy}>
                <Text style={[styles.rowTitle, dark && styles.textBright]} numberOfLines={1}>{t(`chat.profile.${sectionKeys[section.slug]}`)}</Text>
                <Text style={[styles.rowDescription, dark && styles.textMutedDark]} numberOfLines={2}>{t(`chat.profile.${sectionKeys[section.slug]}_desc`)}</Text>
              </View>
              <Ionicons name="chevron-forward" size={17} color={colors.chevron} />
            </Pressable>
          ))}
        </View>
        <View style={styles.footerAccent} />
      </View>
    </ScrollView>
  );
}

const colors = {
  canvas: "#f3f6fa",
  paper: "#fffdf8",
  white: "#ffffff",
  ink: chatVisual.ink,
  muted: "#78879a",
  blue: chatVisual.brand,
  blueSoft: "#edf4ff",
  gold: chatVisual.gold,
  line: chatVisual.border,
  chevron: "#a4b0bf",
};

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 18,
    paddingTop: 20,
    paddingBottom: 32,
  },
  content: {
    width: "100%",
    maxWidth: 620,
    alignSelf: "center",
  },
  contentCompact: {
    maxWidth: 480,
  },
  headingBlock: {
    marginBottom: 17,
    paddingHorizontal: 3,
  },
  eyebrow: {
    color: colors.blue,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.8,
    marginBottom: 5,
  },
  title: {
    color: colors.ink,
    fontSize: 27,
    fontWeight: "800",
    letterSpacing: -0.6,
  },
  identityCard: {
    minHeight: 98,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.paper,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 15,
    marginBottom: 16,
    shadowColor: "#536987",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.045,
    shadowRadius: 10,
    elevation: 1,
  },
  avatarButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    marginRight: 14,
  },
  avatarPressed: {
    opacity: 0.78,
  },
  avatarImage: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 2,
    borderColor: "#f1e6cf",
  },
  avatarFallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 32,
    borderWidth: 2,
    borderColor: "#f1e6cf",
    backgroundColor: colors.blue,
  },
  avatarInitial: {
    color: colors.white,
    fontSize: 25,
    fontWeight: "800",
  },
  cameraBadge: {
    position: "absolute",
    right: -2,
    bottom: -1,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.gold,
    borderWidth: 2,
    borderColor: colors.paper,
  },
  identityCopy: {
    flex: 1,
    minWidth: 0,
  },
  identityLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 4,
  },
  username: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: "800",
  },
  identityMark: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 10,
    backgroundColor: "#f7f0e2",
  },
  menuCard: {
    overflow: "hidden",
    backgroundColor: colors.white,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 16,
    shadowColor: "#536987",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.055,
    shadowRadius: 16,
    elevation: 2,
  },
  row: {
    minHeight: 74,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingVertical: 10,
  },
  lastRow: {
    borderBottomWidth: 0,
  },
  rowPressed: {
    opacity: 0.68,
  },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
    backgroundColor: colors.blueSoft,
  },
  rowCopy: {
    flex: 1,
    minWidth: 0,
    paddingRight: 8,
  },
  rowTitle: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: "700",
  },
  rowDescription: {
    color: colors.muted,
    fontSize: 11,
    lineHeight: 17,
    marginTop: 3,
  },
  screenDark: { backgroundColor: "#111827" },
  cardDark: { backgroundColor: "#1b2635", borderColor: "#344153" },
  rowDark: { borderBottomColor: "#344153" },
  textBright: { color: "#f4f7fb" },
  textMutedDark: { color: "#b7c2d0" },
  footerAccent: {
    width: 43,
    height: 3,
    borderRadius: 2,
    alignSelf: "center",
    marginTop: 18,
    backgroundColor: colors.gold,
    opacity: 0.68,
  },
});
