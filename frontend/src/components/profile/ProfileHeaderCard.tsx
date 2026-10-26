import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Image } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";
import ProfilePhotoManager from "@/src/components/ProfilePhotoManager";

export function formatLongDate(s?: string) {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  } catch {
    return s;
  }
}

export const ProfileHeaderCard: React.FC<{ user: any }> = ({ user }) => {
  const [photoOpen, setPhotoOpen] = React.useState(false);
  return (
    <View style={styles.card} testID="profile-header-card">
      <TouchableOpacity onPress={() => setPhotoOpen(true)} activeOpacity={0.85} testID="profile-avatar-button">
        <View style={styles.avatarRing}>
          {user?.profile_photo ? (
            <Image source={{ uri: user.profile_photo }} style={styles.avatarImg} testID="profile-avatar-image" />
          ) : (
            <View style={[styles.avatarImg, styles.avatarEmpty]}>
              <Ionicons name="person" size={40} color="#fff" />
            </View>
          )}
        </View>
        <View style={styles.camBadge}>
          <Ionicons name="camera" size={14} color="#fff" />
        </View>
      </TouchableOpacity>
      <View style={styles.info}>
        <Text style={styles.username} numberOfLines={1} testID="profile-username">{user?.username || "—"}</Text>
        <View style={styles.levelPill} testID="profile-level-badge">
          <Ionicons name="trophy" size={13} color={theme.colors.primary} />
          <Text style={styles.levelTxt}>Niveau {user?.max_level ?? 0}</Text>
        </View>
        <View style={styles.dateRow}>
          <Ionicons name="calendar-outline" size={14} color={theme.colors.textSecondary} />
          <Text style={styles.dateTxt} numberOfLines={1} testID="profile-joined-date">
            Inscrit le {formatLongDate(user?.created_at)}
          </Text>
        </View>
      </View>
      <ProfilePhotoManager visible={photoOpen} onClose={() => setPhotoOpen(false)} />
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    flexDirection: "row", alignItems: "center", gap: 16, backgroundColor: "#fff",
    borderRadius: 22, padding: 16, borderWidth: 1, borderColor: theme.colors.border,
    shadowColor: "#0B2D6F", shadowOpacity: 0.08, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 4,
  },
  avatarRing: { width: 88, height: 88, borderRadius: 44, padding: 3, backgroundColor: "#DBE6FF" },
  avatarImg: { width: 82, height: 82, borderRadius: 41 },
  avatarEmpty: { backgroundColor: theme.colors.secondary, alignItems: "center", justifyContent: "center" },
  camBadge: {
    position: "absolute", right: -2, bottom: 2, width: 30, height: 30, borderRadius: 15,
    backgroundColor: theme.colors.primary, borderWidth: 2, borderColor: "#fff", alignItems: "center", justifyContent: "center",
  },
  info: { flex: 1, minWidth: 0, gap: 7 },
  username: { fontSize: 20, fontWeight: "800", color: theme.colors.textPrimary, letterSpacing: -0.3 },
  levelPill: {
    alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 5,
    backgroundColor: theme.colors.primaryBg, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
  },
  levelTxt: { color: theme.colors.primary, fontWeight: "800", fontSize: 13 },
  dateRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  dateTxt: { color: theme.colors.textSecondary, fontSize: 12.5, flexShrink: 1 },
});
