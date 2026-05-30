import React, { useEffect, useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, View, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Card } from "@/src/components/Card";
import { api } from "@/src/api";
import { theme } from "@/src/theme";

const PLATFORM_ICONS: any = {
  telegram: { icon: "paper-plane", color: "#26A5E4" },
  whatsapp: { icon: "logo-whatsapp", color: "#25D366" },
  facebook: { icon: "logo-facebook", color: "#1877F2" },
  tiktok: { icon: "musical-notes", color: "#000000" },
  instagram: { icon: "logo-instagram", color: "#E4405F" },
  youtube: { icon: "logo-youtube", color: "#FF0000" },
  x: { icon: "logo-twitter", color: "#1DA1F2" },
};

export default function Community() {
  const router = useRouter();
  const [channels, setChannels] = useState<any[]>([]);
  const [announcements, setAnnouncements] = useState<any[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const a = await api.get<any[]>("/announcements");
        setAnnouncements(a);
      } catch {}
      try {
        const c = await api.get<any[]>("/channels");
        setChannels(c);
      } catch {}
    })();
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient colors={theme.colors.primaryGradient} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Ionicons name="chevron-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Communauté</Text>
        <Text style={styles.sub}>Annonces officielles et canaux Spiloveure.</Text>
      </LinearGradient>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        {announcements.length > 0 && (
          <Card>
            <Text style={styles.section}>📢 Annonces</Text>
            {announcements.map((a) => (
              <View key={a.id} style={styles.annItem}>
                <View style={[styles.priority, { backgroundColor: a.priority === "urgente" ? theme.colors.dangerBg : a.priority === "importante" ? theme.colors.warningBg : "#DBEAFE" }]}>
                  <Text style={{ color: a.priority === "urgente" ? theme.colors.danger : a.priority === "importante" ? theme.colors.warning : theme.colors.primary, fontWeight: "700", fontSize: 10 }}>
                    {a.priority.toUpperCase()}
                  </Text>
                </View>
                <Text style={styles.annTitle}>{a.title}</Text>
                <Text style={styles.annMsg}>{a.message}</Text>
              </View>
            ))}
          </Card>
        )}

        <Card style={{ marginTop: 12 }}>
          <Text style={styles.section}>Rejoignez nos canaux</Text>
          {channels.length === 0 ? (
            <Text style={{ color: theme.colors.textSecondary, textAlign: "center", padding: 24 }}>
              Aucun canal disponible pour le moment.
            </Text>
          ) : (
            channels.map((ch) => {
              const meta = PLATFORM_ICONS[ch.platform] || { icon: "globe", color: theme.colors.primary };
              return (
                <TouchableOpacity key={ch.id} style={styles.chRow} onPress={() => Linking.openURL(ch.url)} testID={`channel-${ch.id}`}>
                  <View style={[styles.chIcon, { backgroundColor: `${meta.color}20` }]}>
                    <Ionicons name={meta.icon} size={22} color={meta.color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.chName}>{ch.name}</Text>
                    {ch.description ? <Text style={styles.chDesc}>{ch.description}</Text> : null}
                  </View>
                  <View style={styles.joinBtn}><Text style={styles.joinT}>Rejoindre</Text></View>
                </TouchableOpacity>
              );
            })
          )}
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  header: { padding: 16, paddingTop: 24, paddingBottom: 20 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", marginBottom: 8 },
  title: { color: "#fff", fontSize: 24, fontWeight: "800" },
  sub: { color: "#C7D9FF" },
  section: { fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 8, fontSize: 16 },
  annItem: { backgroundColor: theme.colors.surfaceSecondary, padding: 12, borderRadius: 12, marginBottom: 8 },
  priority: { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, marginBottom: 6 },
  annTitle: { fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 4 },
  annMsg: { color: theme.colors.textSecondary, fontSize: 13 },
  chRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  chIcon: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  chName: { fontWeight: "700", color: theme.colors.textPrimary },
  chDesc: { color: theme.colors.textSecondary, fontSize: 12 },
  joinBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, backgroundColor: theme.colors.primary },
  joinT: { color: "#fff", fontWeight: "700", fontSize: 12 },
});
