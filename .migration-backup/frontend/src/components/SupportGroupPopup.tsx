import React from "react";
import { Modal, View, Text, StyleSheet, TouchableOpacity, Linking, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/src/theme";
import { api } from "@/src/api";

type Invite = { show: boolean; url?: string; version?: string; leader_username?: string };

export const SupportGroupPopup: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const [inv, setInv] = React.useState<Invite | null>(null);
  const checked = React.useRef(false);

  React.useEffect(() => {
    if (!enabled || checked.current) return;
    checked.current = true;
    api.get<Invite>("/me/support-group/invite").then((r) => { if (r?.show && r.url) setInv(r); }).catch(() => {});
  }, [enabled]);

  if (!inv) return null;

  const join = () => {
    const { url, version } = inv;
    if (Platform.OS === "web" && typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
    else Linking.openURL(url!).catch(() => {});
    api.post("/me/support-group/invite/opened", { version }).catch(() => {});
    setInv(null);
  };

  const later = () => {
    api.post("/me/support-group/invite/later", { version: inv.version }).catch(() => {});
    setInv(null);
  };

  return (
    <Modal transparent animationType="fade" visible onRequestClose={later}>
      <View style={styles.backdrop}>
        <View style={styles.card} testID="support-group-popup">
          <View style={styles.iconWrap}><Ionicons name="people" size={30} color="#16A34A" /></View>
          <Text style={styles.title}>Groupe d'accompagnement</Text>
          {inv.leader_username ? (
            <Text style={styles.leader} testID="support-group-popup-leader">Proposé par votre parrain {inv.leader_username}</Text>
          ) : null}
          <Text style={styles.desc}>
            Rejoignez le groupe de votre parrain pour recevoir conseils, accompagnement et informations utiles pour développer votre réseau.
          </Text>
          <TouchableOpacity style={styles.join} onPress={join} testID="support-group-popup-join">
            <Ionicons name="enter-outline" size={18} color="#fff" />
            <Text style={styles.joinTxt}>Rejoindre maintenant</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.later} onPress={later} testID="support-group-popup-later">
            <Text style={styles.laterTxt}>Plus tard</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(8,13,36,0.72)", alignItems: "center", justifyContent: "center", padding: 20 },
  card: { width: "100%", maxWidth: 400, backgroundColor: "#fff", borderRadius: 24, padding: 22, alignItems: "center", gap: 8 },
  iconWrap: { width: 64, height: 64, borderRadius: 32, backgroundColor: "#DCFCE7", alignItems: "center", justifyContent: "center", marginBottom: 4 },
  title: { fontSize: 18, fontWeight: "800", color: theme.colors.textPrimary, textAlign: "center" },
  leader: { fontSize: 13, fontWeight: "700", color: theme.colors.primary, textAlign: "center" },
  desc: { fontSize: 13, color: theme.colors.textSecondary, textAlign: "center", lineHeight: 19, marginBottom: 6 },
  join: {
    alignSelf: "stretch", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: "#16A34A", paddingVertical: 13, borderRadius: 14,
  },
  joinTxt: { color: "#fff", fontWeight: "800", fontSize: 14.5 },
  later: { alignSelf: "stretch", paddingVertical: 11, alignItems: "center" },
  laterTxt: { color: theme.colors.textSecondary, fontWeight: "700", fontSize: 13.5 },
});
