import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";
import { formatFCFA } from "@/src/utils/format";

export type CurrentChallenge = {
  challenge: null | {
    id: string; name: string; target: number; reward_amount: number;
    reward_currency?: string; start_at: string; end_at: string;
  };
  progress: number;
  completed: boolean;
};

const fmt = (s: string) => new Date(s).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

export const ChallengeCard: React.FC<{ data: CurrentChallenge }> = ({ data }) => {
  const c = data.challenge!;
  const pct = Math.min(100, Math.round((data.progress / Math.max(1, c.target)) * 100));
  const reward = c.reward_currency && c.reward_currency !== "FCFA"
    ? `${c.reward_amount} ${c.reward_currency}` : formatFCFA(c.reward_amount);
  return (
    <View style={styles.card} testID={`challenge-card-${c.id}`}>
      <View style={styles.head}>
        <View style={styles.icon}><Ionicons name="trophy" size={22} color="#F59E0B" /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} testID="challenge-name">{c.name}</Text>
          <View style={[styles.badge, data.completed ? styles.badgeDone : styles.badgeLive]}>
            <Text style={[styles.badgeTxt, { color: data.completed ? "#047857" : "#B45309" }]} testID="challenge-status">
              {data.completed ? "Objectif atteint" : "En cours"}
            </Text>
          </View>
        </View>
      </View>
      <Text style={styles.desc}>
        Invitez {c.target} filleuls directs qui activent leur compte entre le {fmt(c.start_at)} et le {fmt(c.end_at)}.
      </Text>
      <Text style={styles.cond}>Seules les activations réalisées pendant la période du challenge sont comptabilisées.</Text>
      <View style={styles.row}>
        <Text style={styles.lbl}>Récompense</Text>
        <Text style={styles.reward} testID="challenge-reward">{reward}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.lbl}>Date limite</Text>
        <Text style={styles.val} testID="challenge-deadline">{fmt(c.end_at)}</Text>
      </View>
      <View style={styles.track}><View style={[styles.fill, { width: `${pct}%` }]} /></View>
      <Text style={styles.progress} testID="challenge-progress">{data.progress} / {c.target} filleuls activés</Text>
      {data.completed ? (
        <Text style={styles.note}>Bravo ! Contactez le service client pour recevoir votre récompense.</Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    padding: 14, borderRadius: 18, marginBottom: 12, backgroundColor: theme.colors.surface,
    borderWidth: 1, borderColor: "#FDE68A", ...theme.shadow.card,
  },
  head: { flexDirection: "row", gap: 12, alignItems: "center", marginBottom: 8 },
  icon: { width: 44, height: 44, borderRadius: 16, backgroundColor: "#FEF3C7", alignItems: "center", justifyContent: "center" },
  title: { fontSize: 14, fontWeight: "900", color: theme.colors.textPrimary },
  badge: { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, marginTop: 4 },
  badgeLive: { backgroundColor: "#FEF3C7" },
  badgeDone: { backgroundColor: "#D1FAE5" },
  badgeTxt: { fontSize: 10, fontWeight: "900" },
  desc: { fontSize: 12.5, color: theme.colors.textPrimary, lineHeight: 18 },
  cond: { fontSize: 11.5, color: theme.colors.textSecondary, marginTop: 4, lineHeight: 16 },
  row: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  lbl: { fontSize: 12, color: theme.colors.textSecondary },
  val: { fontSize: 12, fontWeight: "800", color: theme.colors.textPrimary },
  reward: { fontSize: 12.5, fontWeight: "900", color: theme.colors.success },
  track: { height: 8, borderRadius: 4, backgroundColor: theme.colors.surfaceSecondary, marginTop: 12, overflow: "hidden" },
  fill: { height: 8, borderRadius: 4, backgroundColor: "#F59E0B" },
  progress: { fontSize: 11.5, color: theme.colors.textSecondary, marginTop: 6, fontWeight: "700" },
  note: { fontSize: 12, color: "#047857", fontWeight: "700", marginTop: 8 },
});
