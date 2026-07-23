import React from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { theme } from "../../src/theme";

// Espace publicitaire — 3 options, all "Bientôt disponible" for now.
export default function AdvertisingScreen() {
  const router = useRouter();
  const options: { key: string; icon: any; title: string; sub: string }[] = [
    {
      key: "video",
      icon: "videocam",
      title: "🎥 Ajouter une vidéo publicitaire",
      sub: "Promouvez vos produits, services ou activités auprès de la communauté SPILOVEURE.",
    },
    {
      key: "poster",
      icon: "image",
      title: "🖼 Ajouter une affiche publicitaire",
      sub: "Mettez en avant vos produits, services ou évènements avec une affiche visuelle.",
    },
    {
      key: "special-task",
      icon: "flash",
      title: "🎯 Créer une tâche spéciale",
      sub: "Créez une campagne rémunérée pour promouvoir vos contenus auprès de la communauté.",
    },
  ];

  const soon = () => {
    if (typeof window !== "undefined") window.alert("🚧 Bientôt disponible");
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="adv-back">
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>📣 Espace publicitaire</Text>
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        <Text style={styles.intro}>
          Boostez votre visibilité : publiez du contenu publicitaire ou lancez une campagne rémunérée à destination de nos membres.
        </Text>
        {options.map((o) => (
          <TouchableOpacity
            key={o.key}
            style={styles.card}
            onPress={soon}
            testID={`adv-option-${o.key}`}
          >
            <View style={styles.iconBox}>
              <Ionicons name={o.icon} size={22} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>{o.title}</Text>
              <Text style={styles.cardSub}>{o.sub}</Text>
            </View>
            <View style={styles.soonBadge}>
              <Text style={styles.soonText}>Bientôt</Text>
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingTop: 16, paddingBottom: 14,
    backgroundColor: theme.colors.primary,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center", justifyContent: "center",
  },
  title: { color: "#fff", fontWeight: "900", fontSize: 18 },
  list: { padding: 16, gap: 12 },
  intro: { color: theme.colors.textSecondary, fontSize: 13, marginBottom: 4 },
  card: {
    flexDirection: "row", alignItems: "center", gap: 12,
    padding: 14, borderRadius: 14,
    backgroundColor: theme.colors.surface,
    borderWidth: 1, borderColor: theme.colors.border,
  },
  iconBox: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: theme.colors.primary,
    alignItems: "center", justifyContent: "center",
  },
  cardTitle: { color: theme.colors.textPrimary, fontWeight: "800", fontSize: 14 },
  cardSub: { color: theme.colors.textSecondary, fontSize: 12, marginTop: 2 },
  soonBadge: {
    backgroundColor: theme.colors.warning,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
  },
  soonText: { color: "#fff", fontWeight: "800", fontSize: 10 },
});
