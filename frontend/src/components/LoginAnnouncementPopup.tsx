import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

type Announcement = {
  id: string;
  title?: string;
  message: string;
  priority?: "normale" | "importante" | "urgente" | string;
};

type Props = {
  userId: string;
  onDone: () => void;
};

export function LoginAnnouncementPopup({ userId, onDone }: Props) {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [completed, setCompleted] = useState(false);
  const doneRef = useRef(false);
  const requestRef = useRef(0);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    setCompleted(true);
    onDoneRef.current();
  }, []);

  const loadAnnouncements = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(false);
    try {
      const result = await api.get<Announcement[]>("/announcements");
      if (requestRef.current !== requestId) return;
      if (!Array.isArray(result)) {
        throw new Error("La liste des annonces reçue est invalide.");
      }
      setAnnouncements(result);
      setCurrentIndex(0);
      if (result.length === 0) finish();
    } catch {
      if (requestRef.current === requestId) setError(true);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [finish]);

  useEffect(() => {
    void loadAnnouncements();
    return () => {
      requestRef.current += 1;
    };
  }, [userId, loadAnnouncements]);

  const acknowledge = () => {
    if (currentIndex + 1 < announcements.length) {
      setCurrentIndex((index) => index + 1);
      return;
    }
    finish();
  };

  const announcement = announcements[currentIndex];
  const visible = !completed;
  const priority = announcement?.priority || "normale";
  const priorityBadgeStyle =
    priority === "urgente" ? styles.urgentBadge :
    priority === "importante" ? styles.importantBadge :
    styles.normalBadge;
  const priorityTextStyle =
    priority === "urgente" ? styles.urgentText :
    priority === "importante" ? styles.importantText :
    styles.normalText;
  const priorityLabel =
    priority === "urgente" ? "Urgente" :
    priority === "importante" ? "Important" :
    "Information";

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={() => {}}
      statusBarTranslucent
    >
      <View style={styles.backdrop} accessibilityViewIsModal>
        <View style={styles.card} testID="login-announcement-popup">
          {loading ? (
            <View style={styles.loadingState} testID="login-announcement-loading">
              <ActivityIndicator size="large" color={theme.colors.primary} />
              <Text style={styles.loadingText}>Chargement des annonces…</Text>
            </View>
          ) : error ? (
            <View style={styles.errorState} testID="login-announcement-error">
              <View style={styles.errorIcon}>
                <Ionicons name="cloud-offline-outline" size={26} color={theme.colors.danger} />
              </View>
              <Text style={styles.title}>Annonce indisponible</Text>
              <Text style={styles.errorText}>
                Impossible de charger les annonces pour le moment. Réessayez ou continuez et elles seront vérifiées à votre prochaine connexion.
              </Text>
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={loadAnnouncements}
                activeOpacity={0.85}
                testID="login-announcement-retry"
                accessibilityRole="button"
              >
                <Ionicons name="refresh" size={18} color={theme.colors.textInverse} />
                <Text style={styles.primaryButtonText}>Réessayer</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.continueButton}
                onPress={finish}
                activeOpacity={0.75}
                testID="login-announcement-continue"
                accessibilityRole="button"
              >
                <Text style={styles.continueButtonText}>Continuer</Text>
              </TouchableOpacity>
            </View>
          ) : announcement ? (
            <>
              <View style={styles.header}>
                <View style={styles.headerIcon}>
                  <Ionicons name="megaphone-outline" size={22} color={theme.colors.primary} />
                </View>
                <Text style={styles.headerLabel}>Annonce SPILOVEURE</Text>
                {announcements.length > 1 ? (
                  <Text style={styles.counter} testID="login-announcement-counter">
                    {currentIndex + 1} / {announcements.length}
                  </Text>
                ) : null}
              </View>

              <View style={styles.heading}>
                <View style={[styles.priorityBadge, priorityBadgeStyle]}>
                  <Text style={[styles.priorityText, priorityTextStyle]}>{priorityLabel}</Text>
                </View>
                <Text style={styles.title} testID="login-announcement-title">
                  {announcement.title?.trim() || "Annonce"}
                </Text>
              </View>

              <ScrollView
                style={styles.messageScroll}
                contentContainerStyle={styles.messageContent}
                showsVerticalScrollIndicator
                persistentScrollbar
                testID="login-announcement-message-scroll"
              >
                <Text style={styles.message} testID="login-announcement-message">
                  {announcement.message}
                </Text>
              </ScrollView>

              <View style={styles.footer}>
                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={acknowledge}
                  activeOpacity={0.85}
                  testID="login-announcement-thanks"
                  accessibilityRole="button"
                  accessibilityLabel="Merci"
                >
                  <Text style={styles.primaryButtonText}>Merci</Text>
                  <Ionicons name="checkmark" size={19} color={theme.colors.textInverse} />
                </TouchableOpacity>
              </View>
            </>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(8, 13, 36, 0.68)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
    paddingVertical: 24,
  },
  card: {
    width: "100%",
    maxWidth: 480,
    minHeight: 380,
    maxHeight: "84%",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...theme.shadow.lifted,
  },
  header: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerIcon: {
    width: 38,
    height: 38,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primaryBg,
    alignItems: "center",
    justifyContent: "center",
  },
  headerLabel: {
    flex: 1,
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: "700",
  },
  counter: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
  },
  heading: {
    paddingHorizontal: 22,
    paddingTop: 20,
    paddingBottom: 8,
  },
  priorityBadge: {
    alignSelf: "flex-start",
    borderRadius: theme.radius.round,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 10,
  },
  urgentBadge: { backgroundColor: theme.colors.dangerBg },
  importantBadge: { backgroundColor: theme.colors.warningBg },
  normalBadge: { backgroundColor: theme.colors.infoBg },
  urgentText: { color: theme.colors.danger },
  importantText: { color: theme.colors.warning },
  normalText: { color: theme.colors.primary },
  priorityText: { fontSize: 11, fontWeight: "700" },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 21,
    lineHeight: 28,
    fontWeight: "800",
    letterSpacing: theme.font.tightTitle,
  },
  messageScroll: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 88,
    maxHeight: 440,
    marginHorizontal: 22,
    marginBottom: 14,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceMuted,
  },
  messageContent: {
    padding: 16,
  },
  message: {
    color: theme.colors.textSecondary,
    fontSize: 15,
    lineHeight: 23,
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 18,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  primaryButton: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 20,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
    ...theme.shadow.button,
  },
  primaryButtonText: {
    color: theme.colors.textInverse,
    fontSize: 16,
    fontWeight: "800",
  },
  loadingState: {
    minHeight: 210,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    padding: 24,
  },
  loadingText: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    fontWeight: "600",
  },
  errorState: {
    alignItems: "center",
    padding: 22,
    gap: 12,
  },
  errorIcon: {
    width: 54,
    height: 54,
    borderRadius: theme.radius.round,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.dangerBg,
  },
  errorText: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
    marginBottom: 4,
  },
  continueButton: {
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  continueButtonText: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    fontWeight: "700",
  },
});
